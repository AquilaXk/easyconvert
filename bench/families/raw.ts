import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { type RdPoint, tryBdRate } from '../bd-rate';
import { REPO_ROOT } from '../config';
import { convertWithProject } from '../convert';
import type { FamilyContext, FamilyRunner } from '../context';
import { MissingToolError, OutputIntegrityError, ToolRunError } from '../errors';
import { decodeImageToPng, fileSize, pictureQuality, type ImageKind } from '../measure';
import type { BenchRow, Family } from '../report';
import { capPsnr, measuredRow, type MetricSpec, skippedGroup, SPEC, speedRowId, ssimDb, throughputRow, undeterminedBdRows } from '../rows';
import { ClassRows } from '../class-rows';
import { remoteSamples, type RemoteSample } from '../corpora';
import { attemptOurs, convertsRow, speedSample } from '../public-support';
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
 *
 * The public samples (bench/corpus/remote-manifest.json) are CC0 files of the open camera sample archive from several makers
 * (Canon, Nikon, Sony, Olympus, Panasonic, Pentax, Fujifilm X-Trans and native or converted DNG), measured the same way. A
 * file the product refuses, or one the reference decoder cannot develop, is a `converts` row instead of a stopped run; the
 * per-class rows average a maker's samples.
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
/** The product's AVIF policy (QA decision 2026-10-11: match the reference service): the 16-bit development is written at 12 bits and every lossy quality is 4:2:0. The reference gets the same constraints. */
const AVIF_DEPTH = '12';
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

/** A file the family measures: a fixture of tests/fixtures/raw (the name is its format) or a public sample (the name is its id). */
interface Subject {
  name: string;
  format: string;
  filename: string;
  sample: RemoteSample | null;
}

const fixtureSubject = (format: string): Subject => ({ name: format, format, filename: `${format}.${format}`, sample: null });
/** The targets measured on a subject. A large public sample is measured on the targets whose encoders are quick (JPEG and PNG): the AVIF encode of a 24-megapixel picture at four quality points would hold the nightly run for an hour, and the small samples cover that path. */
const targetsOf = (subject: Subject): readonly Target[] => {
  const listed = subject.sample?.meta.targets;
  return typeof listed === 'string' ? TARGETS.filter((target) => listed.split(',').includes(target)) : TARGETS;
};
const publicSubject = (sample: RemoteSample): Subject => ({ name: sample.id, format: String(sample.meta.format), filename: sample.id, sample });

function missingSample(format: string): ToolPlanSkipped {
  return { ok: false, missing: [`RAW sample ${format}`], optional: false, reason: `RAW sample ${format} is not fetched (npm run fixtures:raw ${format})` };
}

/**
 * The BD-rate rows of a case, from the reference's curve and ours for each metric. A curve of ours that falls or stays flat as the
 * rate grows is a failing `rd_curve_*` row and not a number of the cubic fit; a curve of the reference that does so is not
 * evaluated (bench/bd-rate.ts tryBdRate, as the image, audio and video families judge it). A sample with no BD-rate leaves the
 * mean of its class (the class pool takes the measured rows of the sample afterwards), and its own rows say why.
 */
export function bdRateRows(
  family: Family,
  caseName: string,
  referenceTool: string,
  curves: ReadonlyArray<readonly [MetricSpec, readonly RdPoint[], readonly RdPoint[]]>,
  classRows: ClassRows,
  className: string | null
): BenchRow[] {
  const rows: BenchRow[] = [];
  const suffix = caseName.slice(caseName.indexOf('->'));
  for (const [spec, reference, ours] of curves) {
    const bd = tryBdRate(reference, ours);
    if ('value' in bd) {
      rows.push(measuredRow(family, caseName, spec, bd.value, 0, referenceTool));
    } else {
      rows.push(...undeterminedBdRows(family, caseName, [spec], referenceTool, bd));
      if (className !== null) classRows.exclude(className, suffix, spec.metric);
    }
  }
  return rows;
}

const TOOLS = ['dcraw_emu', 'ffmpeg', 'magick', 'avifenc', 'avifdec'] as const;
const QUALITY_SPECS = (target: Target): readonly MetricSpec[] => specsOf(target).filter((spec) => spec.kind !== 'throughput');

export const runRaw: FamilyRunner = async (ctx) => {
  const rows: BenchRow[] = [];
  const classRows = new ClassRows();
  const subjects = [...SAMPLES.map(fixtureSubject), ...remoteSamples('raw').map(publicSubject)];
  for (const subject of subjects) {
    const targets = targetsOf(subject).filter((target) => ctx.inScope('raw', `${subject.name}->${target}`));
    if (targets.length === 0) continue;
    // A speed-only run times a few public samples; the others have only quality rows, which it does not measure.
    if (subject.sample && !ctx.quality && !speedSample('raw', subject.sample.id)) continue;
    const plan = ctx.plan([...TOOLS], `raw ${subject.name}`);
    let file: string | null = null;
    let unavailable: ToolPlanSkipped | null = null;
    if (!plan.ok) {
      unavailable = plan;
    } else if (subject.sample === null) {
      file = sampleFile(subject.format);
      if (file === null) unavailable = missingSample(subject.format);
    } else {
      file = await ctx.remote(subject.sample);
      if (file === null) unavailable = { ok: false, missing: [`public sample ${subject.name}`], optional: false, reason: `public sample ${subject.name} is not available` };
    }
    if (plan.ok && file !== null) {
      rows.push(...(await runSample(ctx, subject, file, plan.paths, classRows)));
      continue;
    }
    if (plan.ok && ctx.strict && subject.sample === null) throw new MissingToolError(unavailable?.missing ?? [], `raw ${subject.name}`);
    for (const target of targets) {
      rows.push(...skippedGroup('raw', `${subject.name}->${target}`, specsOf(target), REFERENCE, unavailable as ToolPlanSkipped));
    }
  }
  if (ctx.quality) {
    for (const row of classRows.rows('raw', () => REFERENCE)) {
      if (ctx.inScope('raw', row.case)) rows.push(row);
    }
  }
  return rows;
};

async function runSample(ctx: FamilyContext, subject: Subject, file: string, tools: Readonly<Record<string, string>>, classRows: ClassRows): Promise<BenchRow[]> {
  const { name, format, sample } = subject;
  const input = fs.readFileSync(file);
  const developed = (label: string): string => {
    const tiff = ctx.scratch(`${name}-${label}.tiff`);
    runTool(tools.dcraw_emu, [...DEVELOP_FLAGS, '-Z', tiff, file]);
    return tiff;
  };
  /** The reference encode of a developed TIFF: take the pixels to sRGB, then encode with the standard encoder. */
  const referenceEncode = (target: Target, tiff: string, output: string, quality: number, label: string): void => {
    if (target === 'avif') {
      const png = ctx.scratch(`${name}-${label}-intermediate.png`);
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
  const targets = targetsOf(subject).filter((target) => ctx.inScope('raw', `${name}->${target}`));
  if (sample !== null && ctx.quality) for (const target of targets) classRows.expect(sample.class, `->${target}`, [...QUALITY_SPECS(target), SPEC.converts].map((spec) => spec.metric));

  // A public sample the reference decoder cannot develop is a reference that does not convert it; a fixture must develop.
  let developedOnce: string | null = null;
  try {
    developedOnce = developed('quality');
  } catch (error) {
    if (sample === null || !(error instanceof ToolRunError)) throw error;
    ctx.log(`raw ${name}: the reference decoder cannot develop the file (${error.message.slice(0, 160)})`);
  }
  let sourcePng: string | null = null;
  const source = (): string => {
    if (sourcePng === null) {
      sourcePng = ctx.scratch(`${name}-source.png`);
      runTool(tools.magick, [developedOnce as string, ...TO_SRGB, sourcePng]);
    }
    return sourcePng;
  };

  for (const target of targets) {
    const caseName = `${name}->${target}`;
    ctx.log(`raw ${caseName}`);
    const oursAt = async (quality: number): Promise<Buffer> => (await convertWithProject(input, format, target, { quality }, subject.filename)).buffer;
    const targetRows: BenchRow[] = [];
    let converted = true;
    if (ctx.quality) {
      if (sample !== null) {
        const attempt = await attemptOurs(() => oursAt(QUALITY));
        if (!attempt.ok) {
          ctx.log(`raw ${caseName}: the product does not convert it (${attempt.reason})`);
          converted = false;
        }
        targetRows.push(convertsRow('raw', caseName, attempt.ok, developedOnce !== null, REFERENCE));
      }
      if (converted && developedOnce !== null) {
        const measure = (picture: string): Encoded => {
          const decoded = `${picture}.png`;
          decodeImageToPng(kindOf(target), picture, decoded, decoders);
          const score = pictureQuality(tools.ffmpeg, decoded, source());
          return { ssim: score.ssim, psnr: capPsnr(score.psnr), bytes: fileSize(picture) - (target === 'avif' ? metadataBytes(picture) : 0) };
        };
        /** The camera's EXIF that the product keeps in an AVIF and the reference's stripped output does not carry (180 bytes: 6 percent of a small file), as the decoder reports it; the rows judge the encoder. */
        const metadataBytes = (picture: string): number => {
          const report = runTool(tools.avifdec, ['--info', picture]).stdout.toString('utf8');
          return Number(/Exif Metadata\s*:\s*Present \((\d+) bytes\)/.exec(report)?.[1] ?? 0);
        };
        const points = LOSSY_TARGETS.has(target) ? QUALITY_POINTS : [QUALITY];
        const ours = new Map<number, Encoded>();
        const reference = new Map<number, Encoded>();
        for (const quality of points) {
          const oursFile = ctx.scratch(`${name}-ours-q${quality}.${target}`);
          fs.writeFileSync(oursFile, await oursAt(quality));
          ours.set(quality, measure(oursFile));
          const referenceFile = ctx.scratch(`${name}-reference-q${quality}.${target}`);
          referenceEncode(target, developedOnce, referenceFile, quality, `reference-q${quality}`);
          reference.set(quality, measure(referenceFile));
        }
        const o = ours.get(QUALITY) as Encoded;
        const r = reference.get(QUALITY) as Encoded;
        targetRows.push(measuredRow('raw', caseName, SPEC.ssim, o.ssim, r.ssim, REFERENCE));
        if (target !== 'png') targetRows.push(measuredRow('raw', caseName, SPEC.psnr, o.psnr, r.psnr, REFERENCE));
        targetRows.push(measuredRow('raw', caseName, SPEC.bytes, o.bytes, r.bytes, REFERENCE));
        if (LOSSY_TARGETS.has(target)) {
          const curve = (encoded: Map<number, Encoded>, quality: (e: Encoded) => number): RdPoint[] =>
            QUALITY_POINTS.map((q) => ({ rate: (encoded.get(q) as Encoded).bytes, quality: quality(encoded.get(q) as Encoded) }));
          targetRows.push(
            ...bdRateRows(
              'raw',
              caseName,
              REFERENCE,
              [
                [SPEC.bdRatePsnr, curve(reference, (e) => e.psnr), curve(ours, (e) => e.psnr)],
                [SPEC.bdRateSsim, curve(reference, (e) => ssimDb(e.ssim)), curve(ours, (e) => ssimDb(e.ssim))],
              ],
              classRows,
              sample?.class ?? null
            )
          );
        }
      }
      if (sample !== null) classRows.addCases(sample.class, sample.id, targetRows);
    }
    rows.push(...targetRows);
    const timed = sample === null || (speedSample('raw', sample.id) && converted && developedOnce !== null);
    if (ctx.speed && timed) {
      const timingOut = ctx.scratch(`${name}-timing.${target}`);
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
