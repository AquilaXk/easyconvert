import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { bdRate, type RdPoint } from '../bd-rate';
import { REPO_ROOT } from '../config';
import { convertWithProject } from '../convert';
import type { FamilyContext, FamilyRunner } from '../context';
import { MissingToolError, OutputIntegrityError } from '../errors';
import { decodeImageToPng, fileSize, pictureQuality, type ImageKind } from '../measure';
import type { BenchRow } from '../report';
import { capPsnr, measuredRow, type MetricSpec, skippedGroup, SPEC, speedRowId, ssimDb, throughputRow } from '../rows';
import { runTool, type ToolPlanSkipped } from '../tools';

/**
 * Camera RAW family: real camera files converted to JPEG, PNG, AVIF and GIF, against LibRaw's `dcraw_emu` (the
 * decoder library behind most open-source RAW developers) followed by ImageMagick or `avifenc`, with the same
 * development settings the product uses (16-bit samples, camera white balance, sRGB output) and the same encoder
 * quality (70, the headline point of the image family). By default `dcraw_emu` encodes with its own curve (gamma
 * 2.222 with a toe slope of 4.5) and tags the TIFF with a profile for it, so a colour-managed pipeline takes the pixels
 * to sRGB with the standard profile (ImageMagick `-profile`, LittleCMS), which the reference and the truth do, as RAW
 * developers do. Asking the decoder for an sRGB curve (`-g 2.4 12.92`) instead was measured to differ from the
 * standard profile by up to 9 dB of PSNR on a 14-bit file, so it is not used as the truth.
 * The samples are the public-domain (CC0) files of tests/fixtures/raw/manifest.json, fetched by `npm run fixtures:raw`
 * and checked here against the SHA-256 of the manifest. The picture a conversion is scored against is what the
 * reference decoder developed from the file (a 16-bit TIFF, taken to a 16-bit PNG), so SSIM and PSNR measure what the
 * encoder step adds on top of the same development. Size and speed are those of the whole pipeline from the RAW file.
 */

const RAW_DIR = path.join(REPO_ROOT, 'tests', 'fixtures', 'raw');
/** The standard sRGB profile (IEC 61966-2-1) that ships unmodified as data with the PDF library. */
const SRGB_PROFILE = path.join(REPO_ROOT, 'node_modules', 'pdfkit', 'js', 'data', 'sRGB_IEC61966_2_1.icc');
const SAMPLE_DIR = path.join(RAW_DIR, '.cache');
const MANIFEST = path.join(RAW_DIR, 'manifest.json');
/** The product's development settings: dcraw_emu writes a 16-bit TIFF (-T -6) with camera white balance (-w) in sRGB primaries (-o 1). */
const DEVELOP_FLAGS = ['-T', '-6', '-w', '-o', '1'] as const;
/** Takes the pixels from the decoder's curve to sRGB and drops the profile so that no encoder re-reads it. */
const TO_SRGB = ['-profile', SRGB_PROFILE, '-strip'] as const;
/** Four quality settings for the BD-rate curve of the lossy targets; the gated per-point rows use the headline one. */
const QUALITY_POINTS = [40, 55, 70, 85] as const;
const QUALITY = 70;
const AVIF_SPEED = '6';
const AVIF_DEPTH = '10';
/** The product's output constraint for photographs: 4:2:0 (its AVIF policy), at the same bit depth as the reference. */
const AVIF_CHROMA = '420';
const SAMPLES = ['dng', 'arw'] as const;
const TARGETS = ['jpg', 'png', 'avif', 'gif'] as const;
type Target = (typeof TARGETS)[number];
const REFERENCE = 'dcraw_emu + ImageMagick/avifenc';
/** AVIF and JPEG take a quality setting, so their points sit on a rate-distortion curve and are judged with its BD-rate. */
const LOSSY_TARGETS: ReadonlySet<Target> = new Set(['jpg', 'avif']);
const CURVE_SPECS: readonly MetricSpec[] = [SPEC.ssim, SPEC.psnr, SPEC.bytes, SPEC.bdRatePsnr, SPEC.bdRateSsim, SPEC.throughput];
const POINT_SPECS: readonly MetricSpec[] = [SPEC.ssim, SPEC.psnr, SPEC.bytes, SPEC.throughput];
/** PNG is lossless on both sides, so the reference's PSNR against the picture it re-encodes is infinite by construction and says nothing about ours. */
const LOSSLESS_SPECS: readonly MetricSpec[] = [SPEC.ssim, SPEC.bytes, SPEC.throughput];
function specsOf(target: Target): readonly MetricSpec[] {
  if (target === 'png') return LOSSLESS_SPECS;
  return LOSSY_TARGETS.has(target) ? CURVE_SPECS : POINT_SPECS;
}

interface Encoded {
  bytes: number;
  ssim: number;
  psnr: number;
}

interface ManifestEntry {
  format: string;
  sha256: string;
  bytes: number;
}

/** The sample file, verified against the manifest; null when it has not been fetched. */
function sampleFile(format: string): string | null {
  const file = path.join(SAMPLE_DIR, `${format}.${format}`);
  if (!fs.existsSync(file)) return null;
  const entry = (JSON.parse(fs.readFileSync(MANIFEST, 'utf8')) as ManifestEntry[]).find((candidate) => candidate.format === format);
  if (!entry) throw new OutputIntegrityError(`${format} is not in the RAW sample manifest`);
  const bytes = fs.readFileSync(file);
  if (bytes.length !== entry.bytes || createHash('sha256').update(bytes).digest('hex') !== entry.sha256) {
    throw new OutputIntegrityError(`${path.basename(file)} does not match the SHA-256 of tests/fixtures/raw/manifest.json; fetch it again with npm run fixtures:raw`);
  }
  return file;
}

function missingSample(format: string): ToolPlanSkipped {
  return { ok: false, missing: [`RAW sample ${format}`], optional: false, reason: `RAW sample ${format} is not fetched (npm run fixtures:raw ${format})` };
}

export const runRaw: FamilyRunner = async (ctx) => {
  const rows: BenchRow[] = [];
  for (const format of SAMPLES) {
    if (!TARGETS.some((target) => ctx.inScope('raw', `${format}->${target}`))) continue;
    const plan = ctx.plan(['dcraw_emu', 'ffmpeg', 'magick', 'avifenc', 'avifdec'], `raw ${format}`);
    const file = plan.ok ? sampleFile(format) : null;
    if (plan.ok && file !== null) {
      rows.push(...(await runSample(ctx, format, file, plan.paths)));
      continue;
    }
    const skipped = plan.ok ? missingSample(format) : plan;
    if (plan.ok && ctx.strict) throw new MissingToolError(skipped.missing, `raw ${format}`);
    for (const target of TARGETS) {
      if (ctx.inScope('raw', `${format}->${target}`)) rows.push(...skippedGroup('raw', `${format}->${target}`, specsOf(target), REFERENCE, skipped));
    }
  }
  return rows;
};

async function runSample(ctx: FamilyContext, format: string, file: string, tools: Readonly<Record<string, string>>): Promise<BenchRow[]> {
  const input = fs.readFileSync(file);
  const developed = (name: string): string => {
    const tiff = ctx.scratch(`${format}-${name}.tiff`);
    runTool(tools.dcraw_emu, [...DEVELOP_FLAGS, '-Z', tiff, file]);
    return tiff;
  };
  /** The reference encode of a developed TIFF: take the pixels to sRGB, then encode with the standard encoder. */
  const referenceEncode = (target: Target, tiff: string, output: string, quality: number, name: string): void => {
    if (target === 'avif') {
      const png = ctx.scratch(`${format}-${name}-intermediate.png`);
      runTool(tools.magick, [tiff, ...TO_SRGB, png]);
      runTool(tools.avifenc, ['-d', AVIF_DEPTH, '-y', AVIF_CHROMA, '-q', String(quality), '-s', AVIF_SPEED, '-j', 'all', png, output]);
    } else if (target === 'jpg') {
      runTool(tools.magick, [tiff, ...TO_SRGB, '-quality', String(quality), output]);
    } else {
      runTool(tools.magick, [tiff, ...TO_SRGB, output]);
    }
  };
  const decoders = { ffmpeg: tools.ffmpeg, dwebp: null, avifdec: tools.avifdec };
  const kindOf = (target: Target): ImageKind => (target === 'avif' ? 'avif' : 'png');
  const rows: BenchRow[] = [];

  const developedOnce = developed('quality');
  let sourcePng: string | null = null;
  const source = (): string => {
    if (sourcePng === null) {
      sourcePng = ctx.scratch(`${format}-source.png`);
      runTool(tools.magick, [developedOnce, ...TO_SRGB, sourcePng]);
    }
    return sourcePng;
  };

  for (const target of TARGETS) {
    const caseName = `${format}->${target}`;
    if (!ctx.inScope('raw', caseName)) continue;
    ctx.log(`raw ${caseName}`);
    const oursAt = async (quality: number): Promise<Buffer> => (await convertWithProject(input, format, target, { quality }, path.basename(file))).buffer;
    if (ctx.quality) {
      const measure = (picture: string): Encoded => {
        const decoded = `${picture}.png`;
        decodeImageToPng(kindOf(target), picture, decoded, decoders);
        const score = pictureQuality(tools.ffmpeg, decoded, source());
        return { ssim: score.ssim, psnr: capPsnr(score.psnr), bytes: fileSize(picture) };
      };
      const points = LOSSY_TARGETS.has(target) ? QUALITY_POINTS : [QUALITY];
      const ours = new Map<number, Encoded>();
      const reference = new Map<number, Encoded>();
      for (const quality of points) {
        const oursFile = ctx.scratch(`${format}-ours-q${quality}.${target}`);
        fs.writeFileSync(oursFile, await oursAt(quality));
        ours.set(quality, measure(oursFile));
        const referenceFile = ctx.scratch(`${format}-reference-q${quality}.${target}`);
        referenceEncode(target, developedOnce, referenceFile, quality, `reference-q${quality}`);
        reference.set(quality, measure(referenceFile));
      }
      const o = ours.get(QUALITY) as Encoded;
      const r = reference.get(QUALITY) as Encoded;
      rows.push(measuredRow('raw', caseName, SPEC.ssim, o.ssim, r.ssim, REFERENCE));
      if (target !== 'png') rows.push(measuredRow('raw', caseName, SPEC.psnr, o.psnr, r.psnr, REFERENCE));
      rows.push(measuredRow('raw', caseName, SPEC.bytes, o.bytes, r.bytes, REFERENCE));
      if (LOSSY_TARGETS.has(target)) {
        const curve = (encoded: Map<number, Encoded>, quality: (e: Encoded) => number): RdPoint[] =>
          QUALITY_POINTS.map((q) => ({ rate: (encoded.get(q) as Encoded).bytes, quality: quality((encoded.get(q) as Encoded)) }));
        rows.push(
          measuredRow('raw', caseName, SPEC.bdRatePsnr, bdRate(curve(reference, (e) => e.psnr), curve(ours, (e) => e.psnr)), 0, REFERENCE),
          measuredRow('raw', caseName, SPEC.bdRateSsim, bdRate(curve(reference, (e) => ssimDb(e.ssim)), curve(ours, (e) => ssimDb(e.ssim))), 0, REFERENCE)
        );
      }
    }
    if (ctx.speed) {
      const timingOut = ctx.scratch(`${format}-timing.${target}`);
      const timing = await ctx.time(
        speedRowId('raw', caseName),
        async () => {
          await oursAt(QUALITY);
        },
        () => referenceEncode(target, developed('timing'), timingOut, QUALITY, 'timing'),
        'heavy'
      );
      rows.push(throughputRow('raw', caseName, input.length, timing, REFERENCE));
    }
  }
  return rows;
}
