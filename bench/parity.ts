import { GATE_EPSILON, PARITY_SCHEMA_VERSION, SPEED_PARITY_TOLERANCE } from './config';
import { ParityInputError } from './errors';
import { allowedWorsening, worsening } from './gate';
import { describeGap, type GapEntry, type GapFile, gapIndex } from './parity-gaps';
import type { BenchReport, BenchRow, Family } from './report';

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
  notEvaluated: number;
}

export interface ParityVerdict {
  schemaVersion: number;
  /** pass: every evaluated row is at or above the reference. */
  verdict: 'pass' | 'fail';
  summary: ParitySummary;
  rows: RowVerdict[];
}

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

function judgeSpeed(row: BenchRow): Omit<RowVerdict, 'id' | 'family' | 'case' | 'metric' | 'gap'> {
  if (row.speedVerdict === undefined) {
    throw new ParityInputError(`${row.id} is a throughput row without a speed decision; measure it with --parity`);
  }
  const line = 1 - SPEED_PARITY_TOLERANCE;
  const interval =
    row.ratioLow !== undefined && row.ratioHigh !== undefined ? `speed ratio ${show(row.ratioMedian ?? row.ratio ?? NaN)} [${show(row.ratioLow)}, ${show(row.ratioHigh)}] over ${row.runs ?? '?'} pairs` : `speed ratio ${show(row.ratio ?? NaN)}`;
  if (row.speedVerdict === 'pass') {
    return { outcome: 'pass', basis: 'speed-pass', detail: `${interval}; the lower bound is at least ${show(line)}`, worsening: null, allowance: null };
  }
  if (row.unstableAtCap) {
    return { outcome: 'fail', basis: 'speed-unstable-at-cap', detail: `${interval}; the interval still straddled ${show(line)} at the cap on pairs, which counts as a failure`, worsening: null, allowance: null };
  }
  return { outcome: 'fail', basis: 'speed-below-reference', detail: `${interval}; the upper bound is below ${show(line)}, so ours is slower than the reference`, worsening: null, allowance: null };
}

export function evaluateParity(report: BenchReport, gaps: GapFile): ParityVerdict {
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
      verdicts.push({ ...base(row), ...judgeSpeed(row) });
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

  const evaluated = verdicts.filter((row) => row.outcome !== 'not-evaluated');
  const summary: ParitySummary = {
    evaluated: evaluated.length,
    pass: evaluated.filter((row) => row.outcome === 'pass').length,
    withinAllowance: evaluated.filter((row) => row.outcome === 'pass' && row.basis === 'within-allowance').length,
    fail: evaluated.filter((row) => row.outcome === 'fail').length,
    notEvaluated: verdicts.length - evaluated.length,
  };
  return { schemaVersion: PARITY_SCHEMA_VERSION, verdict: summary.fail > 0 ? 'fail' : 'pass', summary, rows: verdicts };
}

const OUTCOME_MARK: Readonly<Record<ParityOutcome, string>> = { pass: 'PASS', fail: 'FAIL', 'not-evaluated': 'SKIP' };

/** `BELOW REFERENCE <row id>: ...` lines for the failing rows, each naming its known gap or that it is not one. */
export function failureLines(verdict: ParityVerdict): string[] {
  return verdict.rows
    .filter((row) => row.outcome === 'fail')
    .map((row) => `BELOW REFERENCE ${row.id}: ${row.detail} [${describeGap(row.gap ?? undefined)}]`);
}

/** Plain-text table of every row's outcome, for the console. */
export function renderParityText(verdict: ParityVerdict): string[] {
  const lines = [
    `parity: ${verdict.verdict.toUpperCase()} (${verdict.summary.evaluated} rows evaluated, ${verdict.summary.pass} at or above the reference of which ${verdict.summary.withinAllowance} within the measurement allowance, ${verdict.summary.fail} below, ${verdict.summary.notEvaluated} not evaluated)`,
  ];
  for (const row of verdict.rows) {
    lines.push(`  ${OUTCOME_MARK[row.outcome]} ${row.id} [${row.basis}] ${row.detail}`);
  }
  return lines;
}

/** Markdown table for the job summary and the pull request comment. */
export function renderParityMarkdown(verdict: ParityVerdict): string {
  const lines = [
    `**Reference parity: ${verdict.verdict.toUpperCase()}** — ${verdict.summary.evaluated} rows evaluated, ${verdict.summary.fail} below the reference, ${verdict.summary.withinAllowance} passing only within the measurement allowance, ${verdict.summary.notEvaluated} not evaluated.`,
    '',
    '| Row | Outcome | Basis | Detail |',
    '|---|---|---|---|',
  ];
  const cell = (text: string): string => text.replace(/\|/g, '\\|').replace(/\n/g, ' ');
  for (const row of verdict.rows) {
    lines.push(`| ${cell(row.id)} | ${row.outcome} | ${row.basis} | ${cell(row.detail)} |`);
  }
  lines.push('');
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
