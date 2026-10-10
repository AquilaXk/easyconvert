import { BYTES_PER_MB, PSNR_CAP_DB, SSIM_DISTANCE_FLOOR } from './config';
import type { BenchRow, Direction, Family, RowKind, SkipKind, Tolerance } from './report';
import type { AdaptiveTiming } from './speed-parity';
import type { AbTiming } from './ab-speed';
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
  structurePrecision: { metric: 'structure_precision', unit: 'ratio', direction: 'higher', kind: 'quality', tolerance: tol(0.02, 0) },
  structureRecall: { metric: 'structure_recall', unit: 'ratio', direction: 'higher', kind: 'quality', tolerance: tol(0.02, 0) },
  epubcheckErrors: { metric: 'epubcheck_errors', unit: 'count', direction: 'lower', kind: 'quality', tolerance: tol(0, 0) },
  headingF1: { metric: 'heading_f1', unit: 'ratio', direction: 'higher', kind: 'quality', tolerance: tol(0.03, 0) },
  listF1: { metric: 'list_f1', unit: 'ratio', direction: 'higher', kind: 'quality', tolerance: tol(0.03, 0) },
  tableTeds: { metric: 'table_teds', unit: 'ratio', direction: 'higher', kind: 'quality', tolerance: tol(0.03, 0) },
  columnAccuracy: { metric: 'column_accuracy', unit: 'ratio', direction: 'higher', kind: 'quality', tolerance: tol(0.05, 0) },
  paragraphCountError: { metric: 'paragraph_count_error', unit: 'ratio', direction: 'lower', kind: 'quality', tolerance: tol(0.03, 0) },
  readingOrderTau: { metric: 'reading_order_tau', unit: 'ratio', direction: 'higher', kind: 'quality', tolerance: tol(0.02, 0) },
  pdfCheckFailures: { metric: 'pdf_check_failures', unit: 'count', direction: 'lower', kind: 'quality', tolerance: tol(0, 0) },
  pageCountError: { metric: 'page_count_error', unit: 'pages', direction: 'lower', kind: 'quality', tolerance: tol(0, 0) },
  renderMatchesReference: { metric: 'render_matches_reference', unit: 'bool', direction: 'higher', kind: 'exact', tolerance: tol(0, 0) },
  stampInkMatchesReference: { metric: 'stamp_ink_matches_reference', unit: 'bool', direction: 'higher', kind: 'exact', tolerance: tol(0, 0) },
  stampGeometryMatchesSpec: { metric: 'stamp_geometry_matches_spec', unit: 'bool', direction: 'higher', kind: 'exact', tolerance: tol(0, 0) },
  encryptionMatchesReference: { metric: 'encryption_matches_reference', unit: 'bool', direction: 'higher', kind: 'exact', tolerance: tol(0, 0) },
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
  extra: Partial<Pick<BenchRow, 'ratio' | 'oursCv' | 'referenceCv' | 'runs' | 'ratioLow' | 'ratioHigh' | 'ratioMedian' | 'speedVerdict' | 'unstableAtCap' | 'abPairs' | 'abMedian' | 'abUpper' | 'abHeadVsReferenceUpper' | 'abNoise' | 'abBaseVsReferenceMedian' | 'abExtraPairs' | 'abSlowerConfirmed' | 'abLostConfirmed' | 'abFallback'>> = {}
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
    ...(extra.ratioLow === undefined ? {} : { ratioLow: extra.ratioLow }),
    ...(extra.ratioHigh === undefined ? {} : { ratioHigh: extra.ratioHigh }),
    ...(extra.ratioMedian === undefined ? {} : { ratioMedian: extra.ratioMedian }),
    ...(extra.speedVerdict === undefined ? {} : { speedVerdict: extra.speedVerdict }),
    ...(extra.unstableAtCap === undefined ? {} : { unstableAtCap: extra.unstableAtCap }),
    ...(extra.abPairs === undefined ? {} : { abPairs: extra.abPairs }),
    ...(extra.abMedian === undefined ? {} : { abMedian: extra.abMedian }),
    ...(extra.abUpper === undefined ? {} : { abUpper: extra.abUpper }),
    ...(extra.abHeadVsReferenceUpper === undefined ? {} : { abHeadVsReferenceUpper: extra.abHeadVsReferenceUpper }),
    ...(extra.abNoise === undefined ? {} : { abNoise: extra.abNoise }),
    ...(extra.abBaseVsReferenceMedian === undefined ? {} : { abBaseVsReferenceMedian: extra.abBaseVsReferenceMedian }),
    ...(extra.abExtraPairs === undefined ? {} : { abExtraPairs: extra.abExtraPairs }),
    ...(extra.abSlowerConfirmed === undefined ? {} : { abSlowerConfirmed: extra.abSlowerConfirmed }),
    ...(extra.abLostConfirmed === undefined ? {} : { abLostConfirmed: extra.abLostConfirmed }),
    ...(extra.abFallback === undefined ? {} : { abFallback: extra.abFallback }),
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
  timing: InterleavedTiming | AdaptiveTiming | AbTiming,
  referenceTool: string
): BenchRow {
  const ours = megabytesPerSecond(inputBytes, timing.oursMedianMs, BYTES_PER_MB);
  const reference = megabytesPerSecond(inputBytes, timing.referenceMedianMs, BYTES_PER_MB);
  const decided = 'decision' in timing ? timing : null;
  const interval = decided && decided.decision.lower !== null && decided.decision.upper !== null ? { ratioLow: decided.decision.lower, ratioHigh: decided.decision.upper } : {};
  return measuredRow(family, caseName, SPEC.throughput, ours, reference, referenceTool, {
    ratio: ours / reference,
    oursCv: timing.oursCv,
    referenceCv: timing.referenceCv,
    runs: timing.runs,
    ...interval,
    ...(decided
      ? { ratioMedian: decided.decision.median, speedVerdict: decided.decision.verdict === 'pass' ? ('pass' as const) : ('fail' as const), unstableAtCap: decided.unstableAtCap }
      : {}),
    ...abFields(timing),
    ...('abFallback' in timing && timing.abFallback !== undefined ? { abFallback: timing.abFallback } : {}),
  });
}

/** The A/B fields of a row; a bound that cannot exist for want of pairs is left out. */
function abFields(timing: InterleavedTiming | AdaptiveTiming | AbTiming): Partial<BenchRow> {
  if (!('ab' in timing)) return {};
  const { ab } = timing;
  return {
    abPairs: ab.pairs,
    abMedian: ab.headVsBaseMedian,
    ...(Number.isFinite(ab.headVsBaseUpper) ? { abUpper: ab.headVsBaseUpper } : {}),
    ...(Number.isFinite(ab.headVsReferenceUpper) ? { abHeadVsReferenceUpper: ab.headVsReferenceUpper } : {}),
    abNoise: ab.noise,
    abBaseVsReferenceMedian: ab.baseVsReferenceMedian,
    abExtraPairs: ab.extraPairs,
    ...(ab.confirmed.slower === undefined ? {} : { abSlowerConfirmed: ab.confirmed.slower }),
    ...(ab.confirmed.lost === undefined ? {} : { abLostConfirmed: ab.confirmed.lost }),
  };
}

/** The id of the speed row of a case: `<family>/<case>/throughput`, the id `throughputRow` gives it. */
export function speedRowId(family: Family, caseName: string): string {
  return `${family}/${caseName}/${SPEC.throughput.metric}`;
}
