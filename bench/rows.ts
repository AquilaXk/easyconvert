import { BYTES_PER_MB, PSNR_CAP_DB, SSIM_DISTANCE_FLOOR } from './config';
import type { BenchRow, Direction, Family, RowKind, SkipKind, Tolerance } from './report';
import { megabytesPerSecond, type InterleavedTiming } from './stats';
import type { ToolPlanSkipped } from './tools';

/** Row construction shared by every family: metric specs with their gate tolerances, and the row builders. */

export interface MetricSpec {
  metric: string;
  unit: string;
  direction: Direction;
  kind: RowKind;
  tolerance: Tolerance;
}

const tol = (abs: number, rel: number): Tolerance => ({ abs, rel });

/** Gate tolerances per metric. Pixel and sample metrics are deterministic for fixed tool versions, so they are tight. */
export const SPEC = {
  ssim: { metric: 'ssim', unit: 'ratio', direction: 'higher', kind: 'quality', tolerance: tol(0.003, 0) },
  psnr: { metric: 'psnr', unit: 'dB', direction: 'higher', kind: 'quality', tolerance: tol(0.3, 0) },
  vmaf: { metric: 'vmaf', unit: 'score', direction: 'higher', kind: 'quality', tolerance: tol(1, 0) },
  ssimulacra2: { metric: 'ssimulacra2', unit: 'score', direction: 'higher', kind: 'quality', tolerance: tol(1, 0) },
  bytes: { metric: 'bytes', unit: 'bytes', direction: 'lower', kind: 'size', tolerance: tol(0, 0.03) },
  bitrate: { metric: 'bitrate', unit: 'kbit/s', direction: 'lower', kind: 'size', tolerance: tol(0, 0.03) },
  bdRatePsnr: { metric: 'bd_rate_psnr', unit: '%', direction: 'lower', kind: 'bdrate', tolerance: tol(1.5, 0) },
  bdRateSsim: { metric: 'bd_rate_ssim', unit: '%', direction: 'lower', kind: 'bdrate', tolerance: tol(1.5, 0) },
  bdRateSnr: { metric: 'bd_rate_snr', unit: '%', direction: 'lower', kind: 'bdrate', tolerance: tol(1.5, 0) },
  snr: { metric: 'snr', unit: 'dB', direction: 'higher', kind: 'quality', tolerance: tol(0.5, 0) },
  loudnessShift: { metric: 'loudness_shift', unit: 'LU', direction: 'lower', kind: 'quality', tolerance: tol(0.3, 0) },
  truePeakShift: { metric: 'true_peak_shift', unit: 'dB', direction: 'lower', kind: 'quality', tolerance: tol(0.3, 0) },
  losslessExact: { metric: 'lossless_exact', unit: 'bool', direction: 'higher', kind: 'exact', tolerance: tol(0, 0) },
  cer: { metric: 'cer', unit: '%', direction: 'lower', kind: 'quality', tolerance: tol(0.75, 0) },
  wordF1: { metric: 'word_f1', unit: 'ratio', direction: 'higher', kind: 'quality', tolerance: tol(0.02, 0) },
  ratio: { metric: 'compression_ratio', unit: 'ratio', direction: 'lower', kind: 'size', tolerance: tol(0, 0.01) },
  throughput: { metric: 'throughput', unit: 'MB/s', direction: 'higher', kind: 'throughput', tolerance: tol(0, 0.35) },
} as const satisfies Record<string, MetricSpec>;

export function measuredRow(
  family: Family,
  caseName: string,
  spec: MetricSpec,
  ours: number,
  reference: number,
  referenceTool: string,
  extra: Partial<Pick<BenchRow, 'ratio' | 'oursCv' | 'referenceCv' | 'runs'>> = {}
): BenchRow {
  return {
    id: `${family}/${caseName}/${spec.metric}`,
    family,
    case: caseName,
    metric: spec.metric,
    unit: spec.unit,
    direction: spec.direction,
    kind: spec.kind,
    status: 'measured',
    ours,
    reference,
    delta: ours - reference,
    ratio: extra.ratio ?? null,
    referenceTool,
    tolerance: spec.tolerance,
    ...(extra.oursCv === undefined ? {} : { oursCv: extra.oursCv }),
    ...(extra.referenceCv === undefined ? {} : { referenceCv: extra.referenceCv }),
    ...(extra.runs === undefined ? {} : { runs: extra.runs }),
  };
}

export function skippedRow(
  family: Family,
  caseName: string,
  spec: MetricSpec,
  referenceTool: string,
  skipKind: SkipKind,
  skipReason: string
): BenchRow {
  return {
    id: `${family}/${caseName}/${spec.metric}`,
    family,
    case: caseName,
    metric: spec.metric,
    unit: spec.unit,
    direction: spec.direction,
    kind: spec.kind,
    status: 'skipped',
    ours: null,
    reference: null,
    delta: null,
    ratio: null,
    referenceTool,
    tolerance: spec.tolerance,
    skipKind,
    skipReason,
  };
}

/** One skipped row per metric of a group whose tools are missing. */
export function skippedGroup(
  family: Family,
  caseName: string,
  specs: readonly MetricSpec[],
  referenceTool: string,
  plan: ToolPlanSkipped
): BenchRow[] {
  const kind: SkipKind = plan.optional ? 'optional-tool' : 'missing-tool';
  return specs.map((spec) => skippedRow(family, caseName, spec, referenceTool, kind, plan.reason));
}

/** PSNR with the infinite value of a lossless result recorded at a finite cap, so the report stays valid JSON. */
export function capPsnr(psnr: number): number {
  return Math.min(psnr, PSNR_CAP_DB);
}

/** SSIM in decibels, -10 log10(1 - SSIM): the scale on which SSIM differences are comparable across the range. */
export function ssimDb(ssim: number): number {
  return -10 * Math.log10(Math.max(1 - ssim, SSIM_DISTANCE_FLOOR));
}

/** Throughput row from an interleaved timing: MB/s of `inputBytes` for each side, and the speed ratio. */
export function throughputRow(
  family: Family,
  caseName: string,
  inputBytes: number,
  timing: InterleavedTiming,
  referenceTool: string
): BenchRow {
  const ours = megabytesPerSecond(inputBytes, timing.oursMedianMs, BYTES_PER_MB);
  const reference = megabytesPerSecond(inputBytes, timing.referenceMedianMs, BYTES_PER_MB);
  return measuredRow(family, caseName, SPEC.throughput, ours, reference, referenceTool, {
    ratio: ours / reference,
    oursCv: timing.oursCv,
    referenceCv: timing.referenceCv,
    runs: timing.runs,
  });
}
