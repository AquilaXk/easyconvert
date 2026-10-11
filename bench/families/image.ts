import fs from 'node:fs';
import path from 'node:path';
import { type RdPoint, tryBdRate } from '../bd-rate';
import { ClassRows } from '../class-rows';
import { PUBLIC_SPEED_SAMPLES } from '../config';
import { convertWithProject } from '../convert';
import { type FamilyRunner, INJECTED_WEBP_QUALITY_SHARE } from '../context';
import { type RemoteSample, remoteSamples } from '../corpora';
import { decodeImageToPng, fileSize, flattenOnGrey, measureSsimulacra2, pictureAlpha, pictureQuality, probeFile, type ImageKind } from '../measure';
import { OutputIntegrityError } from '../errors';
import { hasValidChunkChecksums, withMetadataOf } from '../png-metadata';
import { numberRecord, type RefSpec } from '../ref-cache';
import type { BenchRow } from '../report';
import { capPsnr, measuredRow, type MetricSpec, skippedGroup, skippedRow, SPEC, ssimDb, throughputRow, speedRowId, undeterminedBdRows } from '../rows';
import { runTool } from '../tools';

/**
 * Image family: jpg and png sources to webp, avif and jpg, against cwebp, avifenc and ImageMagick at matched quality. The
 * generated corpus (bench/corpus/) is the core; the public sample sets (photographs, screenshots, line art, pictures with
 * transparency and 16-bit pictures, bench/corpus/remote-manifest.json) add a case per sample and target, and a row per
 * content class that averages the BD-rates of its samples (bench/class-rows.ts).
 */

interface ImageCase {
  file: string;
  format: 'jpg' | 'png';
  /** Bits per sample of the source (checked with ffprobe and identify). */
  bitDepth: 8 | 16;
  /** Some pixel of the source is not opaque; it is judged flattened onto grey, and JPEG (no alpha) is not a target. A picture whose alpha channel is fully opaque is an ordinary picture. */
  alpha: boolean;
  /** Content class of a public sample; the generated corpus has none. */
  contentClass: string | null;
  remote: RemoteSample | null;
}

const CORE_CASES: readonly ImageCase[] = [
  { file: 'photo-a.jpg', format: 'jpg', bitDepth: 8, alpha: false, contentClass: null, remote: null },
  { file: 'photo-b.png', format: 'png', bitDepth: 8, alpha: false, contentClass: null, remote: null },
  { file: 'screenshot.png', format: 'png', bitDepth: 16, alpha: false, contentClass: null, remote: null },
  { file: 'lineart.png', format: 'png', bitDepth: 16, alpha: false, contentClass: null, remote: null },
];

function publicCases(): ImageCase[] {
  return remoteSamples('image').map((sample) => ({
    file: sample.id,
    format: /\.jpe?g$/.test(sample.id) ? 'jpg' : 'png',
    bitDepth: sample.meta.bitDepth === 16 ? 16 : 8,
    alpha: sample.meta.transparent === true,
    contentClass: sample.class,
    remote: sample,
  }));
}
const TARGETS = ['webp', 'avif', 'jpg'] as const;
type Target = (typeof TARGETS)[number];

/** Four quality settings for the BD-rate curve; the gated per-point rows use the headline one. */
const QUALITY_POINTS = [40, 55, 70, 85] as const;
const HEADLINE_QUALITY = 70;
/** cwebp -m 4 is the encoder effort the project's WebP path uses; avifenc -s 6 is its AVIF speed. */
const CWEBP_METHOD = '4';
const AVIFENC_SPEED = '6';
/**
 * AVIF output policy (QA decision 2026-10-11: match the reference service): a source deeper than 8 bits is written at 12 bits
 * when it holds 11 or more (every 16-bit sample picture of the benchmark), lossy AVIF is 4:2:0 for every content class and
 * only the lossless quality 100 gives 4:4:4. The reference encoder's own defaults differ (it takes the depth of the source
 * for 8-bit pictures and 4:4:4 for colour), so it is given the same constraints: `-d 12` for deep sources and `-y 420`,
 * except for a grey picture, which both write as monochrome.
 */
const AVIFENC_DEEP_DEPTH = '12';
const AVIFENC_LOSSLESS_QUALITY = 100;

/**
 * The reference encoders get the decoded pixels with the EXIF, XMP and ICC blocks of the source (bench/png-metadata.ts): the tools keep
 * all three by default. The product keeps the first two and applies the profile to the pixels instead of writing it. `avifenc` and ImageMagick keep the
 * metadata of their input by default and `cwebp` does when asked (`-metadata all`). Without the blocks the reference files were
 * smaller than any encoder that keeps the picture's metadata can write: the XMP block alone is 3.5 to 6.9 kB of an 8 to 25 kB file
 * of the 16-bit samples.
 */
const REFERENCE_INPUT_SETTING = 'decoded-with-exif-xmp-icc';

const REFERENCE_TOOL: Record<Target, string> = { webp: 'cwebp', avif: 'avifenc', jpg: 'magick' };
const REFERENCE_NAME: Record<Target, string> = { webp: 'cwebp', avif: 'avifenc', jpg: 'ImageMagick' };
const DECODER_TOOLS: Record<Target, readonly string[]> = { webp: ['dwebp'], avif: ['avifdec'], jpg: [] };

const GROUP_SPECS: readonly MetricSpec[] = [SPEC.ssim, SPEC.psnr, SPEC.bytes, SPEC.bdRatePsnr, SPEC.bdRateSsim, SPEC.throughput];

interface Encoded {
  bytes: number;
  ssim: number;
  psnr: number;
}

const parseEncoded = numberRecord(['bytes', 'ssim', 'psnr']);
const parseScore = numberRecord(['score']);

function referenceEncode(target: Target, binary: string, sourcePng: string, quality: number, output: string, bitDepth: ImageCase['bitDepth'], grey: boolean): void {
  const q = String(quality);
  if (target === 'webp') {
    runTool(binary, ['-quiet', '-q', q, '-m', CWEBP_METHOD, '-metadata', 'all', sourcePng, '-o', output]);
  } else if (target === 'avif') {
    const depthArgs = bitDepth > 8 ? ['-d', AVIFENC_DEEP_DEPTH] : [];
    const chromaArgs = grey ? [] : ['-y', quality >= AVIFENC_LOSSLESS_QUALITY ? '444' : '420'];
    runTool(binary, [...depthArgs, ...chromaArgs, '-q', q, '-s', AVIFENC_SPEED, '-j', 'all', sourcePng, output]);
  } else {
    runTool(binary, [sourcePng, '-quality', q, output]);
  }
}

/** Our side failed to convert a public sample; the sample's rows say so instead of ending the run. */
class OursConversionError extends Error {}

function failedConversionRow(caseName: string, tool: string): BenchRow {
  return measuredRow('image', caseName, SPEC.converts, 0, 1, tool);
}

export const runImage: FamilyRunner = async (ctx) => {
  const rows: BenchRow[] = [];
  const classes = new ClassRows();
  const cases = [...CORE_CASES, ...publicCases()];
  for (const sample of cases) {
    if (sample.contentClass !== null) for (const target of TARGETS) if (!(sample.alpha && target === 'jpg')) classes.expect(sample.contentClass, `->${target}`, [SPEC.bdRatePsnr.metric, SPEC.bdRateSsim.metric]);
  }
  const ssimulacraPlan = ctx.plan(['ssimulacra2'], 'image ssimulacra2 score', { optional: true });
  if (!ssimulacraPlan.ok && ctx.quality) {
    rows.push(skippedRow('image', 'all', SPEC.ssimulacra2, 'ssimulacra2', 'optional-tool', ssimulacraPlan.reason));
  }

  for (const sample of cases) {
    // A speed-only run times a few public samples; the others have only quality rows, which it does not measure.
    if (!ctx.quality && sample.remote !== null && !PUBLIC_SPEED_SAMPLES.image.includes(sample.file)) continue;
    let sourceFile: string | null | undefined;
    const resolveSource = async (): Promise<string | null> => {
      if (sourceFile === undefined) sourceFile = sample.remote ? await ctx.remote(sample.remote) : ctx.corpusPath(sample.file);
      return sourceFile;
    };
    for (const target of TARGETS) {
      if (sample.alpha && target === 'jpg') continue;
      const caseName = `${sample.file}->${target}`;
      if (!ctx.inScope('image', caseName)) continue;
      const refTool = REFERENCE_TOOL[target];
      const plan = ctx.plan(['ffmpeg', ...(sample.remote ? ['ffprobe'] : []), refTool, ...DECODER_TOOLS[target]], caseName);
      if (!plan.ok) {
        rows.push(...skippedGroup('image', caseName, GROUP_SPECS, REFERENCE_NAME[target], plan));
        continue;
      }
      const sourcePath = await resolveSource();
      if (sourcePath === null) {
        rows.push(...GROUP_SPECS.map((spec) => skippedRow('image', caseName, spec, REFERENCE_NAME[target], 'optional-tool', `public sample ${sample.file} could not be fetched`)));
        continue;
      }
      const input = fs.readFileSync(sourcePath);
      ctx.log(`image ${caseName}`);
      const decoders = {
        ffmpeg: plan.paths.ffmpeg,
        dwebp: plan.paths.dwebp ?? null,
        avifdec: plan.paths.avifdec ?? null,
      };
      const decodedSource = ctx.scratch(`${sample.file}.png`);
      decodeImageToPng(sample.format, sourcePath, decodedSource, decoders);
      if (sample.remote) checkDeclaredPicture(plan.paths.ffmpeg, plan.paths.ffprobe, decodedSource, sample);
      /** The picture the metrics read: a picture with transparency is compared flattened onto grey, any other as decoded. */
      const comparable = (png: string): string => {
        if (!sample.alpha) return png;
        const flat = `${png}.flat.png`;
        flattenOnGrey(plan.paths.ffmpeg, plan.paths.ffprobe, png, flat);
        return flat;
      };
      const grey = isGreyPicture(decodedSource);
      const sourcePng = comparable(decodedSource);
      /** What the reference encoders read: the decoded pixels, with the metadata blocks of a PNG source. */
      const referenceInput = sample.format === 'png' ? referenceInputOf(sourcePath, decodedSource, ctx.scratch(`${sample.file}.reference.png`)) : decodedSource;

      const oursQuality = (quality: number): number =>
        ctx.injection === 'webp-quality' && target === 'webp' ? Math.round(quality * INJECTED_WEBP_QUALITY_SHARE) : quality;
      const oursEncode = async (quality: number): Promise<Buffer> => {
        try {
          const out = await convertWithProject(input, sample.format, target, { quality: oursQuality(quality) }, sample.file);
          if (ctx.injection !== 'webp-reencode' || target !== 'webp') return out.buffer;
          return (await convertWithProject(out.buffer, 'webp', 'webp', { quality }, sample.file)).buffer;
        } catch (error) {
          if (sample.remote === null) throw error;
          throw new OursConversionError(error instanceof Error ? error.message : String(error));
        }
      };
      const measure = (buffer: Buffer | null, file: string): Encoded => {
        if (buffer) fs.writeFileSync(file, buffer);
        const png = `${file}.png`;
        decodeImageToPng(target as ImageKind, file, png, decoders);
        const quality = pictureQuality(plan.paths.ffmpeg, comparable(png), sourcePng);
        return { bytes: fileSize(file), ssim: quality.ssim, psnr: capPsnr(quality.psnr) };
      };
      /** What the reference encode at one quality depends on: the encoder and its settings, the decoders and the source picture. */
      const referenceSpec = (kind: string, quality: number): RefSpec => ({
        kind,
        tools: ['ffmpeg', refTool, ...DECODER_TOOLS[target]],
        files: [sample.file],
        settings: { case: caseName, quality, referenceInput: REFERENCE_INPUT_SETTING, cwebpMethod: CWEBP_METHOD, avifencSpeed: AVIFENC_SPEED, avifencDepth: sample.bitDepth > 8 ? AVIFENC_DEEP_DEPTH : 'source', avifencChroma: grey ? 'monochrome' : '420', avifencLosslessQuality: AVIFENC_LOSSLESS_QUALITY },
      });
      const tool = REFERENCE_NAME[target];

      if (ctx.quality) {
        try {
          const ours = new Map<number, Encoded>();
          const reference = new Map<number, Encoded>();
          for (const quality of QUALITY_POINTS) {
            const oursFile = ctx.scratch(`ours-q${quality}.${target}`);
            ours.set(quality, measure(await oursEncode(quality), oursFile));
            reference.set(
              quality,
              await ctx.refCache.value('image', referenceSpec('encode-measure', quality), parseEncoded, () => {
                const refFile = ctx.scratch(`ref-q${quality}.${target}`);
                referenceEncode(target, plan.paths[refTool], referenceInput, quality, refFile, sample.bitDepth, grey);
                return measure(null, refFile);
              })
            );
          }

          const o = ours.get(HEADLINE_QUALITY) as Encoded;
          const r = reference.get(HEADLINE_QUALITY) as Encoded;
          rows.push(measuredRow('image', caseName, SPEC.ssim, o.ssim, r.ssim, tool));
          rows.push(measuredRow('image', caseName, SPEC.psnr, o.psnr, r.psnr, tool));
          rows.push(measuredRow('image', caseName, SPEC.bytes, o.bytes, r.bytes, tool));

          const curve = (points: Map<number, Encoded>, quality: (e: Encoded) => number): RdPoint[] =>
            QUALITY_POINTS.map((q) => ({ rate: (points.get(q) as Encoded).bytes, quality: quality(points.get(q) as Encoded) }));
          const bdPsnr = tryBdRate(curve(reference, (e) => e.psnr), curve(ours, (e) => e.psnr));
          const bdSsim = tryBdRate(curve(reference, (e) => ssimDb(e.ssim)), curve(ours, (e) => ssimDb(e.ssim)));
          for (const [spec, bd] of [[SPEC.bdRatePsnr, bdPsnr], [SPEC.bdRateSsim, bdSsim]] as const) {
            if ('value' in bd) {
              rows.push(measuredRow('image', caseName, spec, bd.value, 0, tool));
              if (sample.contentClass !== null) classes.add(sample.contentClass, `->${target}`, spec, bd.value, 0);
            } else {
              rows.push(...undeterminedBdRows('image', caseName, [spec], tool, bd));
              if (sample.contentClass !== null) classes.exclude(sample.contentClass, `->${target}`, spec.metric);
            }
          }

          if (ssimulacraPlan.ok) {
            const score = (file: string): number => measureSsimulacra2(ssimulacraPlan.paths.ssimulacra2, sourcePng, comparable(`${file}.png`));
            const oursFile = ctx.scratch(`ours-ss2.${target}`);
            measure(await oursEncode(HEADLINE_QUALITY), oursFile);
            const referenceScore = await ctx.refCache.value(
              'image',
              { ...referenceSpec('ssimulacra2', HEADLINE_QUALITY), tools: ['ffmpeg', refTool, ...DECODER_TOOLS[target], 'ssimulacra2'] },
              parseScore,
              () => {
                const refFile = ctx.scratch(`ref-ss2.${target}`);
                referenceEncode(target, plan.paths[refTool], referenceInput, HEADLINE_QUALITY, refFile, sample.bitDepth, grey);
                measure(null, refFile);
                return { score: score(refFile) };
              }
            );
            rows.push(measuredRow('image', caseName, SPEC.ssimulacra2, score(oursFile), referenceScore.score, tool));
          }
        } catch (error) {
          if (!(error instanceof OursConversionError)) throw error;
          ctx.log(`image ${caseName}: the product could not convert the sample: ${error.message.slice(0, 300)}`);
          rows.push(failedConversionRow(caseName, tool));
          continue;
        }
      }

      if (ctx.speed && (sample.remote === null || PUBLIC_SPEED_SAMPLES.image.includes(sample.file))) {
        const timingOut = path.join(ctx.work, `timing-${path.basename(sourcePng)}.${target}`);
        const timing = await ctx.time(
          speedRowId('image', caseName),
          async () => {
            await oursEncode(HEADLINE_QUALITY);
          },
          () => referenceEncode(target, plan.paths[refTool], referenceInput, HEADLINE_QUALITY, timingOut, sample.bitDepth, grey),
          'light'
        );
        rows.push(throughputRow('image', caseName, input.length, timing, tool));
      }
    }
  }
  rows.push(...classes.rows('image', (suffix) => REFERENCE_NAME[suffix.slice(2) as Target]).filter((row) => ctx.inScope('image', row.case)));
  return rows;
};

/** Writes the decoded pixels with the EXIF, XMP and ICC blocks of the original PNG to `output`. */
function referenceInputOf(original: string, decoded: string, output: string): string {
  const withMetadata = withMetadataOf(fs.readFileSync(decoded), fs.readFileSync(original));
  if (!hasValidChunkChecksums(withMetadata)) throw new OutputIntegrityError(`the reference input made from ${path.basename(original)} has a damaged chunk`);
  fs.writeFileSync(output, withMetadata);
  return output;
}

const PNG_COLOUR_TYPE_OFFSET = 25;
const PNG_COLOUR_TYPES_GREY: ReadonlySet<number> = new Set([0, 4]);

/** Whether the decoded picture is a grey one (with or without alpha), by the colour type in its PNG header; the encoders then write a monochrome AVIF and the reference is not given a chroma layout. */
function isGreyPicture(decoded: string): boolean {
  const header = Buffer.alloc(PNG_COLOUR_TYPE_OFFSET + 1);
  const file = fs.openSync(decoded, 'r');
  try {
    fs.readSync(file, header, 0, header.length, 0);
  } finally {
    fs.closeSync(file);
  }
  return PNG_COLOUR_TYPES_GREY.has(header[PNG_COLOUR_TYPE_OFFSET]);
}

/** A public sample's bit depth and transparency are part of the manifest; a file that differs is not the file that was pinned. */
function checkDeclaredPicture(ffmpeg: string, ffprobe: string, decoded: string, sample: ImageCase): void {
  const stream = probeFile(ffprobe, decoded).streams[0];
  const depth = /(16|48|64)/.test(String(stream.pix_fmt)) ? 16 : 8;
  if (depth !== sample.bitDepth) throw new OutputIntegrityError(`${sample.file} decodes as ${String(stream.pix_fmt)}, but the manifest says ${sample.bitDepth} bits`);
  const alpha = pictureAlpha(ffmpeg, ffprobe, decoded);
  const declared = sample.remote?.meta ?? {};
  if (alpha.channel !== declared.alpha || alpha.transparent !== declared.transparent) {
    throw new OutputIntegrityError(`${sample.file} has alpha channel ${alpha.channel} and transparency ${alpha.transparent}, but the manifest says ${String(declared.alpha)} and ${String(declared.transparent)}`);
  }
}
