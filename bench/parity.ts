import { GAP_BACKING_LOG_MARGIN, GATE_EPSILON, PARITY_SCHEMA_VERSION, SPEED_GAP_FLOOR, SPEED_HISTORY_CONFIDENCE, SPEED_HISTORY_MIN_POINTS, SPEED_PARITY_TOLERANCE } from './speed-config';
import { ParityInputError } from './errors';
import { allowedWorsening, worsening } from './gate';
import { describeGap, type GapEntry, type GapFile, gapIndex, isSpeedRowId } from './parity-gaps';
import type { BenchReport, BenchRow, Family } from './report';
import { AB_NIGHTLY_ONLY, type AbNightlyOnly } from './ab-config';
import { slowdownLine } from './ab-speed';
import { speedGapThreshold } from './speed-history';

/**
 * Reference-parity verdict. Every measured row must be at or above the reference tool; the row's own tolerance is the
 * measurement allowance and nothing else. Quality numbers are deterministic for fixed tool versions, speed is judged by
 * the confidence interval a parity run recorded on the row (bench/speed-parity.ts).
 *
 *   bd_rate_*            ours <= 0 (a negative BD-rate needs fewer bits at equal quality)
 *   cer, word F1, ...    the direction of the metric: ours no worse than the reference
 *   size ratio, bytes    ours no larger than the reference, where size is the whole story (lossless, compression)
 *   SSIM, PSNR, SNR ...  no lower than the reference at equal size; where the sizes differ the rate-distortion
 *                        trade-off is the BD-rate of the case, so these rows pass or fail with it
 *   throughput           the lower bound of the speed-ratio interval is at least 1 - SPEED_PARITY_TOLERANCE
 *
 * Staged rollout: a quality row is never excused. A speed row listed in bench/parity-gaps.json is tracked: below the
 * reference does not fail it, getting slower than its history predicts does (the upper bound of its interval under the
 * lower edge of the one-sided prediction bound over the CI-measured ratios of its latest runs, bench/speed-history.ts),
 * and reaching parity is reported so the entry can be removed. With fewer points than SPEED_HISTORY_MIN_POINTS the
 * row is reported and not failed. A speed row that is not listed has to pass outright.
 */

export type ParityOutcome = 'pass' | 'fail' | 'not-evaluated';

export type ParityBasis =
  | 'at-or-above'
  | 'within-allowance'
  | 'below-reference'
  | 'defers-to-bd-rate'
  | 'speed-pass'
  | 'speed-below-reference'
  | 'speed-unstable-at-cap'
  | 'tracked-gap'
  | 'tracked-short-history'
  | 'tracked-now-at-parity'
  | 'tracked-slower-than-gap'
  | 'speed-slower-than-base'
  | 'speed-lost-parity'
  | 'speed-not-slower-than-base'
  | 'speed-unchanged-below-reference'
  | 'speed-nightly-only'
  | 'gap-not-backed'
  | 'unsupported'
  | 'skipped';

export interface RowVerdict {
  id: string;
  family: Family;
  case: string;
  metric: string;
  outcome: ParityOutcome;
  basis: ParityBasis;
  /** One sentence naming the numbers behind the outcome. */
  detail: string;
  /** How much worse ours is than the reference (negative: ahead); null for rows without a point comparison. */
  worsening: number | null;
  allowance: number | null;
  /** The known gap behind a failing row, when bench/parity-gaps.json lists it. */
  gap: GapEntry | null;
}

export interface ParitySummary {
  evaluated: number;
  pass: number;
  /** Passing rows whose worsening is inside the measurement allowance, listed so a drift is visible. */
  withinAllowance: number;
  fail: number;
  /** Passing speed rows that are below the reference and tracked by a gap entry, at or above their recorded ratio. */
  tracked: number;
  /** Tracked speed rows that now pass the parity rule: their gap entry can be removed. */
  nowAtParity: number;
  notEvaluated: number;
}

export interface ParityVerdict {
  schemaVersion: number;
  /** pass: every evaluated row is at or above the reference. */
  verdict: 'pass' | 'fail';
  summary: ParitySummary;
  rows: RowVerdict[];
}

/** A speed row below the reference that a gap entry tracks and that passed: within its history, or too new to judge. */
const isTracked = (row: RowVerdict): boolean => row.basis === 'tracked-gap' || row.basis === 'tracked-short-history';

/** Metrics measured at one rate-distortion point; at unequal size they are judged with the case's BD-rate. */
const POINT_QUALITY_METRICS: ReadonlySet<string> = new Set(['ssim', 'psnr', 'vmaf', 'ssimulacra2', 'snr']);
const SIZE_METRICS: ReadonlySet<string> = new Set(['bytes', 'bitrate']);

const MESSAGE_PRECISION = 5;
function show(value: number): string {
  return Number(value.toPrecision(MESSAGE_PRECISION)).toString();
}

interface Direct {
  worsening: number;
  allowance: number;
  ok: boolean;
  /** Not worse at all, so the allowance was not needed. */
  ahead: boolean;
}

function direct(row: BenchRow): Direct {
  const reference = row.reference as number;
  const ours = row.ours as number;
  // A BD-rate row stores the curve difference as `ours` against a reference of 0; the allowance is its absolute one.
  const allowance = allowedWorsening(row.tolerance, reference);
  const behind = worsening(row.direction, reference, ours);
  return { worsening: behind, allowance, ok: behind <= allowance + GATE_EPSILON, ahead: behind <= GATE_EPSILON };
}

function directBasis(d: Direct): ParityBasis {
  if (d.ahead) return 'at-or-above';
  return d.ok ? 'within-allowance' : 'below-reference';
}

function describeDirect(row: BenchRow, d: Direct): string {
  const side = row.direction === 'higher' ? 'at least' : 'at most';
  const numbers = `${row.metric} ${show(row.ours as number)} ${row.unit} against the reference ${show(row.reference as number)} (${side} the reference is required`;
  return d.ok ? `${numbers}, allowance ${show(d.allowance)})` : `${numbers}; ours is worse by ${show(d.worsening)}, allowance ${show(d.allowance)})`;
}

type SpeedJudgement = Omit<RowVerdict, 'id' | 'family' | 'case' | 'metric' | 'gap'>;

function judgeAbsolute(row: BenchRow, gap: GapEntry | null): SpeedJudgement {
  if (row.speedVerdict === undefined) {
    throw new ParityInputError(`${row.id} is a throughput row without a speed decision; measure it with --parity`);
  }
  const line = 1 - SPEED_PARITY_TOLERANCE;
  const interval =
    row.ratioLow !== undefined && row.ratioHigh !== undefined ? `speed ratio ${show(row.ratioMedian ?? row.ratio ?? NaN)} [${show(row.ratioLow)}, ${show(row.ratioHigh)}] over ${row.runs ?? '?'} pairs` : `speed ratio ${show(row.ratio ?? NaN)}`;
  const none = { worsening: null, allowance: null };
  const tracked = gap !== null && gap.ratio !== null ? { issue: gap.issue, recorded: gap.ratio, history: (gap.history ?? []).map((point) => point.ratio) } : null;
  if (row.speedVerdict === 'pass') {
    if (tracked) {
      return { outcome: 'pass', basis: 'tracked-now-at-parity', detail: `${interval}; now at parity: remove ${row.id} from bench/parity-gaps.json (issue #${tracked.issue})`, ...none };
    }
    return { outcome: 'pass', basis: 'speed-pass', detail: `${interval}; the lower bound is at least ${show(line)}`, ...none };
  }
  if (tracked) {
    // The history stores the median of each run, so the median is what is compared; the interval only decides whether the
    // row passes the normal rule. A run unstable at the cap is judged the same way: its median still counts.
    const median = row.ratioMedian ?? row.ratio ?? 0;
    const threshold = speedGapThreshold(tracked.history, tracked.recorded);
    const share = `${show(SPEED_GAP_FLOOR * 100)}%`;
    const confidence = `${show(SPEED_HISTORY_CONFIDENCE * 100)}%`;
    const basis = tracked.history.length > 0 ? `the median ${show(threshold.level)} of its last ${tracked.history.length} CI runs` : `its recorded ratio ${show(threshold.level)}`;
    const floor = `${share} of ${basis} (${show(threshold.floor)})`;
    const bound = threshold.bound;
    let limit: string;
    if (bound === null) {
      limit = `${floor}, the only limit while the history has ${tracked.history.length} of the ${SPEED_HISTORY_MIN_POINTS} CI-measured runs a bound needs`;
    } else if (bound.lower >= threshold.floor) {
      limit = `the ${confidence} one-sided prediction bound ${show(bound.lower)} over the last ${bound.points} CI runs (geometric mean ${show(bound.centre)})`;
    } else {
      limit = `${floor}, which is above the ${confidence} one-sided prediction bound ${show(bound.lower)} over the last ${bound.points} CI runs`;
    }
    if (median < threshold.lower) {
      return { outcome: 'fail', basis: 'tracked-slower-than-gap', detail: `${interval}; tracked (issue #${tracked.issue}), but its median ${show(median)} is below ${limit}: it got slower than its history`, ...none };
    }
    if (bound === null) {
      return {
        outcome: 'pass',
        basis: 'tracked-short-history',
        detail: `${interval}; below the reference, tracked (issue #${tracked.issue}) with ${tracked.history.length} of the ${SPEED_HISTORY_MIN_POINTS} CI-measured runs a bound needs: judged by ${floor}`,
        ...none,
      };
    }
    return { outcome: 'pass', basis: 'tracked-gap', detail: `${interval}; below the reference, tracked (issue #${tracked.issue}), median not below ${limit}`, ...none };
  }
  if (row.unstableAtCap) {
    return { outcome: 'fail', basis: 'speed-unstable-at-cap', detail: `${interval}; the interval still straddled ${show(line)} at the cap on pairs, which counts as a failure`, ...none };
  }
  return { outcome: 'fail', basis: 'speed-below-reference', detail: `${interval}; the upper bound is below ${show(line)}, so ours is slower than the reference`, ...none };
}

/**
 * The history rule of a tracked gap in a run that measures the head and the base in processes of their own. The history
 * holds ratios measured with ours in the benchmark's own process; here the benchmark is a light coordinator, so the
 * reference (a spawned tool) is timed from a smaller process and its ratio is not the same number, for the rows whose
 * time is mostly the spawn. The comparison with the history is therefore made on what this change did to the row: the
 * level of the history (its median, or the recorded ratio) times the median head-to-base ratio is the ratio the history
 * would have measured, and the history's floor and prediction bound apply to that.
 */
function judgeTrackedAgainstBase(row: BenchRow, gap: GapEntry, headVsBaseMedian: number): SpeedJudgement {
  const recorded = gap.ratio ?? 1;
  const history = (gap.history ?? []).map((point) => point.ratio);
  const level = speedGapThreshold(history, recorded).level;
  const adjusted = level * headVsBaseMedian;
  const judged = judgeAbsolute({ ...row, ratio: adjusted, ratioMedian: adjusted, ratioLow: undefined, ratioHigh: undefined, speedVerdict: adjusted >= 1 - SPEED_PARITY_TOLERANCE ? 'pass' : 'fail', unstableAtCap: false }, gap);
  return { ...judged, detail: `its history level ${show(level)} times the head-to-base ratio ${show(headVsBaseMedian)}: ${judged.detail}` };
}

export interface ParityOptions {
  /** Regression thresholds of rows other than bench/ab-config.ts names; for tests of the verdict. */
  regression?: Readonly<Record<string, { delta: number }>>;
  /** Nightly-only rows other than bench/ab-config.ts names; for tests of the verdict. */
  nightlyOnly?: Readonly<Record<string, Pick<AbNightlyOnly, 'reason'>>>;
  /**
   * The gap file of the base the change is measured against. When given, every gap entry that is new or changed
   * against it must be backed by the speed rows of this report (bench/config.ts, GAP_BACKING_LOG_MARGIN).
   */
  baseGaps?: GapFile;
}

const canonicalGap = (gap: GapEntry): string => JSON.stringify({ id: gap.id, issue: gap.issue, ratio: gap.ratio, note: gap.note, history: gap.history ?? [] });

/** Why a new or changed gap entry is not backed by the measured row, or null when it is. */
function gapBackingFailure(gap: GapEntry, base: GapEntry | undefined, row: BenchRow | undefined): string | null {
  if (row === undefined || row.status !== 'measured' || row.kind !== 'throughput') return `the entry is new or changed, but this run did not measure ${gap.id}`;
  const centre = row.ratioMedian ?? row.ratio;
  if (centre === null || centre === undefined) return 'the entry is new or changed, but the measured row has no speed ratio';
  // A row measured against the base was timed from another process than the history, so its ratio is not the one the entry records; only the form of the entry can be checked then.
  const comparable = row.abPairs === undefined;
  const margin = Math.exp(GAP_BACKING_LOG_MARGIN);
  const low = comparable ? (row.ratioLow ?? centre) / margin : 0;
  const high = comparable ? (row.ratioHigh ?? centre) * margin : Number.POSITIVE_INFINITY;
  const range = `[${show(low)}, ${show(high)}]`;
  if (gap.ratio === null || gap.ratio < low || gap.ratio > high) return `the recorded ratio ${gap.ratio === null ? 'none' : show(gap.ratio)} is outside ${range}, the speed ratio interval this run measured for the row`;
  const known = new Set((base?.history ?? []).map((point) => JSON.stringify(point)));
  for (const point of gap.history ?? []) {
    if (known.has(JSON.stringify(point))) continue;
    if (point.commit === undefined) return `the history point ${show(point.ratio)} of ${point.at} is new and has no commit: only bench:refresh-speed writes history, from a CI report`;
    if (point.ratio < low || point.ratio > high) return `the new history point ${show(point.ratio)} of ${point.at} is outside ${range}, the speed ratio interval this run measured for the row`;
  }
  return null;
}

/**
 * A speed row measured against the base of the change in the same pairs (bench/ab-speed.ts). It fails only on evidence:
 *  - the head is credibly slower than the base by more than the row's regression threshold (the one-sided upper bound of
 *    the median of base time / head time is below 1 / (1 + threshold)) and a second set of fresh pairs shows it too, or
 *  - the base was at or above the reference and the head is credibly below it (the upper bound of reference time /
 *    head time is below the pass line) and the second set shows it too, or
 *  - the row is a tracked gap and its median fell under what its history predicts (bench/parity-gaps.json): a change
 *    that makes a known gap worse by less than the threshold still may not walk it down run after run.
 * Otherwise the change did not make the row worse and it passes; a row below the reference that the base was already
 * below is the standing gap the nightly run reports (the absolute rule), not a failure of this change.
 */
function judgeSpeed(row: BenchRow, gap: GapEntry | null, options: ParityOptions): SpeedJudgement {
  const comparedWithBase = row.abPairs !== undefined || row.abFallback !== undefined;
  const nightly = (options.nightlyOnly ?? AB_NIGHTLY_ONLY)[row.id];
  if (nightly !== undefined && comparedWithBase) {
    return { outcome: 'pass', basis: 'speed-nightly-only', detail: `not judged on a pull request: ${nightly.reason}`, worsening: null, allowance: null };
  }
  if (row.abPairs === undefined) return judgeAbsolute(row, gap);
  const line = 1 - SPEED_PARITY_TOLERANCE;
  const slowerLine = slowdownLine(row.id, options.regression);
  const none = { worsening: null, allowance: null };
  const median = row.abMedian ?? row.ratio ?? 0;
  const against = `head against base ${show(median)} over ${row.abPairs} pairs`;
  if (row.abUpper !== undefined && row.abUpper < slowerLine && row.abSlowerConfirmed !== false) {
    return { outcome: 'fail', basis: 'speed-slower-than-base', detail: `${against}; the one-sided upper bound ${show(row.abUpper)} is below ${show(slowerLine)}: the change made the row more than ${show(100 * (1 / slowerLine - 1))}% slower than its base`, ...none };
  }
  const baseVersusReference = row.abBaseVsReferenceMedian ?? 0;
  if (baseVersusReference >= line && row.abHeadVsReferenceUpper !== undefined && row.abHeadVsReferenceUpper < line && row.abLostConfirmed !== false) {
    return {
      outcome: 'fail',
      basis: 'speed-lost-parity',
      detail: `${against}; the base was at the reference (${show(baseVersusReference)}), the head is credibly below it: the upper bound ${show(row.abHeadVsReferenceUpper)} is below ${show(line)}`,
      ...none,
    };
  }
  if (gap !== null) return judgeTrackedAgainstBase(row, gap, median);
  const bound = row.abUpper === undefined ? 'too few pairs for a bound' : `upper bound ${show(row.abUpper)}`;
  if (row.speedVerdict === 'pass') return { outcome: 'pass', basis: 'speed-pass', detail: `${against} (${bound}); at the reference`, ...none };
  if (baseVersusReference >= line) return { outcome: 'pass', basis: 'speed-not-slower-than-base', detail: `${against} (${bound}); not credibly below the reference`, ...none };
  return { outcome: 'pass', basis: 'speed-unchanged-below-reference', detail: `${against} (${bound}); below the reference on the base as well (${show(baseVersusReference)}): the standing gap the nightly run reports`, ...none };
}

export function evaluateParity(report: BenchReport, gaps: GapFile, options: ParityOptions = {}): ParityVerdict {
  const gapById = gapIndex(gaps);
  const verdicts: RowVerdict[] = [];
  const caseKey = (row: BenchRow): string => `${row.family}/${row.case}`;
  const measured = report.rows.filter((row) => row.status === 'measured');
  const byCase = new Map<string, BenchRow[]>();
  for (const row of measured) byCase.set(caseKey(row), [...(byCase.get(caseKey(row)) ?? []), row]);

  const base = (row: BenchRow): Pick<RowVerdict, 'id' | 'family' | 'case' | 'metric' | 'gap'> => ({
    id: row.id,
    family: row.family,
    case: row.case,
    metric: row.metric,
    gap: gapById.get(row.id) ?? null,
  });

  for (const row of report.rows) {
    if (row.status === 'skipped') {
      const unsupported = row.skipKind === 'unsupported';
      verdicts.push({
        ...base(row),
        outcome: 'not-evaluated',
        basis: unsupported ? 'unsupported' : 'skipped',
        detail: row.skipReason ?? 'skipped',
        worsening: null,
        allowance: null,
      });
      continue;
    }
    if (row.kind === 'throughput') {
      verdicts.push({ ...base(row), ...judgeSpeed(row, gapById.get(row.id) ?? null, options) });
      continue;
    }
    const siblings = byCase.get(caseKey(row)) ?? [];
    const bdRows = siblings.filter((other) => other.kind === 'bdrate');
    const own = direct(row);
    const tradeOff = bdRows.length > 0 && (POINT_QUALITY_METRICS.has(row.metric) || SIZE_METRICS.has(row.metric));
    if (!tradeOff) {
      verdicts.push({
        ...base(row),
        outcome: own.ok ? 'pass' : 'fail',
        basis: directBasis(own),
        detail: describeDirect(row, own),
        worsening: own.worsening,
        allowance: own.allowance,
      });
      continue;
    }
    // A point of a rate-distortion curve: it stands on its own only when the size is not larger.
    const sizeRows = siblings.filter((other) => SIZE_METRICS.has(other.metric));
    const sizeOk = sizeRows.every((size) => direct(size).ok);
    const standsAlone = own.ok && (SIZE_METRICS.has(row.metric) || sizeOk);
    if (standsAlone) {
      verdicts.push({
        ...base(row),
        outcome: 'pass',
        basis: directBasis(own),
        detail: describeDirect(row, own),
        worsening: own.worsening,
        allowance: own.allowance,
      });
      continue;
    }
    const bdOk = bdRows.every((bd) => direct(bd).ok);
    const bdNames = bdRows.map((bd) => bd.metric).join(', ');
    verdicts.push({
      ...base(row),
      outcome: bdOk ? 'pass' : 'fail',
      basis: bdOk ? 'defers-to-bd-rate' : 'below-reference',
      detail: `${describeDirect(row, own)}; the sizes differ, so the case is judged by ${bdNames}${bdOk ? ', which is at or above the reference' : ', which is below the reference'}`,
      worsening: own.worsening,
      allowance: own.allowance,
    });
  }

  if (options.baseGaps) {
    const baseById = gapIndex(options.baseGaps);
    const measuredById = new Map(report.rows.map((row) => [row.id, row] as const));
    for (const gap of gaps.gaps) {
      const base = baseById.get(gap.id);
      if (!isSpeedRowId(gap.id) || (base !== undefined && canonicalGap(base) === canonicalGap(gap))) continue;
      const failure = gapBackingFailure(gap, base, measuredById.get(gap.id));
      if (failure === null) continue;
      const detail = `known-gap entry not backed by this run: ${failure}`;
      const index = verdicts.findIndex((verdict) => verdict.id === gap.id);
      if (index >= 0) {
        verdicts[index] = { ...verdicts[index], outcome: 'fail', basis: 'gap-not-backed', detail: `${detail}; ${verdicts[index].detail}`, gap };
      } else {
        const [family, caseName, metric] = gap.id.split('/');
        verdicts.push({ id: gap.id, family: family as Family, case: caseName, metric, outcome: 'fail', basis: 'gap-not-backed', detail, worsening: null, allowance: null, gap });
      }
    }
  }

  const evaluated = verdicts.filter((row) => row.outcome !== 'not-evaluated');
  const summary: ParitySummary = {
    evaluated: evaluated.length,
    pass: evaluated.filter((row) => row.outcome === 'pass').length,
    withinAllowance: evaluated.filter((row) => row.outcome === 'pass' && row.basis === 'within-allowance').length,
    fail: evaluated.filter((row) => row.outcome === 'fail').length,
    tracked: evaluated.filter(isTracked).length,
    nowAtParity: evaluated.filter((row) => row.basis === 'tracked-now-at-parity').length,
    notEvaluated: verdicts.length - evaluated.length,
  };
  return { schemaVersion: PARITY_SCHEMA_VERSION, verdict: summary.fail > 0 ? 'fail' : 'pass', summary, rows: verdicts };
}

/** `BELOW REFERENCE <row id>: ...` lines for the failing rows, each naming its known gap or that it is not one. */
export function failureLines(verdict: ParityVerdict): string[] {
  return verdict.rows
    .filter((row) => row.outcome === 'fail')
    .map((row) => `BELOW REFERENCE ${row.id}: ${row.detail} [${describeGap(row.gap ?? undefined)}]`);
}

/** Plain-text table of every row's outcome, for the console. */
/** The rows of each report section: failing, tracked below the reference, tracked and now at parity, and the rest. */
function sections(verdict: ParityVerdict): { failing: RowVerdict[]; tracked: RowVerdict[]; nowAtParity: RowVerdict[]; passing: RowVerdict[]; skipped: RowVerdict[] } {
  const rows = verdict.rows;
  return {
    failing: rows.filter((row) => row.outcome === 'fail'),
    tracked: rows.filter(isTracked),
    nowAtParity: rows.filter((row) => row.basis === 'tracked-now-at-parity'),
    passing: rows.filter((row) => row.outcome === 'pass' && !isTracked(row) && row.basis !== 'tracked-now-at-parity'),
    skipped: rows.filter((row) => row.outcome === 'not-evaluated'),
  };
}

function summaryLine(verdict: ParityVerdict): string {
  const { summary } = verdict;
  return `parity: ${verdict.verdict.toUpperCase()} (${summary.evaluated} rows evaluated: ${summary.fail} failing, ${summary.tracked} tracked below the reference, ${summary.nowAtParity} tracked and now at parity, ${summary.pass - summary.tracked - summary.nowAtParity} at or above the reference of which ${summary.withinAllowance} within the measurement allowance; ${summary.notEvaluated} not evaluated)`;
}

/** Plain-text report for the console, in sections: failing rows, tracked rows, rows now at parity, then the rest. */
export function renderParityText(verdict: ParityVerdict): string[] {
  const { failing, tracked, nowAtParity, passing, skipped } = sections(verdict);
  const lines = [summaryLine(verdict)];
  const section = (title: string, rows: RowVerdict[], mark: string): void => {
    if (rows.length === 0) return;
    lines.push(`${title} (${rows.length})`);
    for (const row of rows) lines.push(`  ${mark} ${row.id} [${row.basis}] ${row.detail}`);
  };
  section('FAILING ROWS', failing, 'FAIL');
  section('TRACKED ROWS (below the reference, listed in bench/parity-gaps.json)', tracked, 'TRACK');
  section('NOW AT PARITY (remove from bench/parity-gaps.json)', nowAtParity, 'DONE');
  section('AT OR ABOVE THE REFERENCE', passing, 'PASS');
  section('NOT EVALUATED', skipped, 'SKIP');
  return lines;
}

/** Markdown for the job summary and the pull request comment, in the same sections. */
export function renderParityMarkdown(verdict: ParityVerdict): string {
  const { failing, tracked, nowAtParity, passing, skipped } = sections(verdict);
  const cell = (text: string): string => text.replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const lines = [`**Reference parity: ${verdict.verdict.toUpperCase()}**`, '', summaryLine(verdict).replace(/^parity: \S+ /, ''), ''];
  const table = (title: string, rows: RowVerdict[]): void => {
    if (rows.length === 0) return;
    lines.push(`#### ${title} (${rows.length})`, '', '| Row | Basis | Detail |', '|---|---|---|');
    for (const row of rows) lines.push(`| ${cell(row.id)} | ${row.basis} | ${cell(row.detail)} |`);
    lines.push('');
  };
  table('Failing rows', failing);
  table('Tracked rows: below the reference, listed in bench/parity-gaps.json', tracked);
  table('Now at parity: remove from bench/parity-gaps.json', nowAtParity);
  table('At or above the reference', passing);
  table('Not evaluated', skipped);
  return lines.join('\n');
}

export type ParityScope = 'quality' | 'speed' | 'both';

/**
 * What a parity run leaves for the CI step that decides the job: the verdict, the baseline regressions (which no
 * label excuses) and the exit code the run returned. Read by scripts/ci-parity-policy.mjs.
 */
export interface ParityRunFile {
  schemaVersion: number;
  generatedAt: string;
  families: Family[];
  quick: boolean;
  scope: ParityScope;
  strictMode: boolean;
  injectedRegression: string | null;
  exitCode: number;
  baseline: { compared: number; regressions: string[] };
  parity: ParityVerdict;
}
