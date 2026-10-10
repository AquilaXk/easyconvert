import { BYTES_PER_MB } from './speed-config';
import type { AbTiming } from './ab-speed';
import type { BenchRow, Direction, Family, RowKind, Tolerance } from './report';
import type { AdaptiveTiming } from './speed-parity';
import { megabytesPerSecond, type InterleavedTiming } from './stats';

/**
 * How a speed row is built from a timing: which fields of the A/B comparison it carries into the verdict. It is gate code (the
 * `parity speed` job takes it from the base commit), so a change cannot decide which measurements the verdict sees.
 */

export interface MetricSpec {
  metric: string;
  unit: string;
  direction: Direction;
  kind: RowKind;
  tolerance: Tolerance;
}

/** The speed row of a case: its tolerance is the measurement allowance of the baseline gate, which speed rows never fail (the parity speed jobs judge them). */
export const THROUGHPUT_SPEC = { metric: 'throughput', unit: 'MB/s', direction: 'higher', kind: 'throughput', tolerance: { abs: 0, rel: 0.35 } } as const satisfies MetricSpec;

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
  return measuredRow(family, caseName, THROUGHPUT_SPEC, ours, reference, referenceTool, {
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
  return `${family}/${caseName}/${THROUGHPUT_SPEC.metric}`;
}

