/**
 * Refreshes the recorded speed ratios (`bench/baseline.json` throughput entries and `bench/parity-gaps.json` ratios and
 * run histories) from the benchmark reports a CI speed-parity run uploads. Speed depends on the machine, so a ratio recorded from
 * a laptop is wrong for the runner that enforces it: this command accepts only reports measured under
 * ORACLE_STRICT_MODE=1 on Linux (the runner), with no injected regression, by a `--parity` run.
 *
 *   npm run bench:refresh-speed -- <report.json | artifact directory>...          prints what would change
 *   npm run bench:refresh-speed -- --write <report.json | artifact directory>...  rewrites the two files
 *
 * Sources: the `parity-speed-results` artifact of the `parity speed` job of ci.yml (7 days), or the
 * `bench-speed-results` artifact of the nightly workflow (30 days; start one with `gh workflow run nightly.yml`).
 *
 * Exit codes: 0 done, 2 the inputs cannot be used.
 */
import fs from 'node:fs';
import path from 'node:path';
import { BASELINE_PATH, MAX_JSON_BYTES, PARITY_GAPS_PATH, PARITY_VERDICT_FILE, SPEED_HISTORY_MAX_POINTS } from './config';
import { BenchArgumentError, BenchError, ReportSchemaError } from './errors';
import { type Baseline, buildBaseline, readBaseline } from './gate';
import { type GapFile, isSpeedRowId, readGaps } from './parity-gaps';
import { type BenchReport, type BenchRow, validateReport } from './report';
import { appendSpeedHistory } from './speed-history';

const EXIT_DONE = 0;
const EXIT_UNUSABLE = 2;
const RATIO_DECIMALS = 100;
/** The gap-note wording the refresh may rewrite; any other note was written by hand and stays as it is. */
const GENERATED_NOTE = /^speed ratio [\d.]+ or below when recorded/;
const RUNNER_PLATFORM = 'linux';

export class SpeedRefreshError extends BenchError {}

export interface RatioChange {
  id: string;
  before: number | null;
  after: number;
}

export interface HistoryChange {
  id: string;
  /** Runs the row's history holds afterwards. */
  points: number;
}

export interface SpeedRefresh {
  baseline: Baseline;
  gaps: GapFile;
  baselineChanges: RatioChange[];
  gapChanges: RatioChange[];
  /** Tracked rows whose history gained a run. */
  historyChanges: HistoryChange[];
  /** Tracked rows that now pass the parity rule: remove their entries from bench/parity-gaps.json. */
  nowAtParity: string[];
  /** Tracked rows whose interval was still undecided at the cap: their ratio is not trustworthy, so it is left alone. */
  leftUnstable: string[];
  /** Tracked rows the reports do not cover. */
  notInReports: string[];
}

/** A report is usable only when it was measured the way the gate measures: on the runner, strictly, by a parity run. */
function checkMeasuredOnRunner(report: BenchReport, label: string): void {
  if (report.host.platform !== RUNNER_PLATFORM) {
    throw new SpeedRefreshError(`${label}: measured on ${report.host.platform}, but the gate runs on ${RUNNER_PLATFORM}; speed ratios must come from the CI runner`);
  }
  if (!report.strictMode) throw new SpeedRefreshError(`${label}: not measured under ORACLE_STRICT_MODE=1, so a missing reference tool may have skipped rows`);
  if (report.settings.injectedRegression !== null) throw new SpeedRefreshError(`${label}: measured with the injected regression ${report.settings.injectedRegression}`);
}

function speedRows(report: BenchReport, label: string): BenchRow[] {
  const rows = report.rows.filter((row) => row.status === 'measured' && row.kind === 'throughput');
  for (const row of rows) {
    if (row.speedVerdict === undefined || row.ratioMedian === undefined) {
      throw new SpeedRefreshError(`${label}: ${row.id} carries no speed decision; the report must come from a --parity run`);
    }
  }
  return rows;
}

const floorRatio = (value: number): number => Math.floor(value * RATIO_DECIMALS) / RATIO_DECIMALS;
const showRatio = (value: number): string => Number(value.toFixed(2)).toString();

/**
 * New baseline and gap files from CI speed reports.
 *
 * - Every measured speed row sets its baseline ratio (a row without an entry gets one). Quality entries are untouched.
 * - A tracked row below the reference gets the median of its interval added to its history (the latest
 *   SPEED_HISTORY_MAX_POINTS runs, one point per report, ordered by the report's time), and the latest point rounded
 *   down to two decimals as its recorded ratio. A tracked row that now passes keeps its entry and is listed, so the
 *   removal is a reviewed edit.
 * - A row that was still undecided at the cap changes nothing: its median is noise.
 */
export function planSpeedRefresh(reports: ReadonlyArray<{ label: string; report: BenchReport }>, baseline: Baseline, gaps: GapFile): SpeedRefresh {
  if (reports.length === 0) throw new SpeedRefreshError('no report to refresh from');
  const measured = new Map<string, BenchRow>();
  const measuredAt = new Map<string, string>();
  for (const { label, report } of reports) {
    checkMeasuredOnRunner(report, label);
    for (const row of speedRows(report, label)) {
      if (measured.has(row.id)) throw new SpeedRefreshError(`${label}: ${row.id} is also in an earlier report; refresh from one run per row`);
      measured.set(row.id, row);
      measuredAt.set(row.id, report.generatedAt);
    }
  }
  if (measured.size === 0) throw new SpeedRefreshError('the reports hold no measured speed row');

  const stable = [...measured.values()].filter((row) => row.unstableAtCap !== true);
  const next = buildBaseline({ ...reports[0].report, rows: stable }, baseline);
  const baselineChanges: RatioChange[] = [];
  for (const row of stable) {
    const before = baseline.entries[row.id]?.ratio ?? null;
    const after = next.entries[row.id].ratio;
    if (after !== null && after !== before) baselineChanges.push({ id: row.id, before, after });
  }

  const gapChanges: RatioChange[] = [];
  const historyChanges: HistoryChange[] = [];
  const nowAtParity: string[] = [];
  const leftUnstable: string[] = [];
  const notInReports: string[] = [];
  const nextGaps = gaps.gaps.map((gap) => {
    if (!isSpeedRowId(gap.id)) return gap;
    const row = measured.get(gap.id);
    if (!row) {
      notInReports.push(gap.id);
      return gap;
    }
    if (row.unstableAtCap === true) {
      leftUnstable.push(gap.id);
      return gap;
    }
    if (row.speedVerdict === 'pass') {
      nowAtParity.push(gap.id);
      return gap;
    }
    const runAt = measuredAt.get(gap.id) as string;
    const history = appendSpeedHistory(gap.history ?? [], row.ratioMedian as number, runAt);
    if (!(gap.history ?? []).some((point) => point.at === runAt)) historyChanges.push({ id: gap.id, points: history.length });
    const after = floorRatio(history[history.length - 1].ratio);
    if (!(after > 0)) throw new SpeedRefreshError(`${gap.id}: the measured ratio ${row.ratioMedian} rounds to zero`);
    if (after !== gap.ratio) gapChanges.push({ id: gap.id, before: gap.ratio, after });
    const note =
      after !== gap.ratio && GENERATED_NOTE.test(gap.note)
        ? `speed ratio ${showRatio(after)} or below when recorded on the CI runner (previous record ${gap.ratio === null ? 'none' : showRatio(gap.ratio)}): ours is slower than the reference tool`
        : gap.note;
    return { ...gap, ratio: after, note, history };
  });
  return { baseline: next, gaps: { schemaVersion: gaps.schemaVersion, gaps: nextGaps }, baselineChanges, gapChanges, historyChanges, nowAtParity, leftUnstable, notInReports };
}

/** `<file>` for a report, or every `*.json` in a directory except the verdict file a parity run leaves beside it. */
function reportFiles(input: string): string[] {
  if (!fs.statSync(input).isDirectory()) return [input];
  const files = fs
    .readdirSync(input)
    .filter((name) => name.endsWith('.json') && name !== PARITY_VERDICT_FILE)
    .sort()
    .map((name) => path.join(input, name));
  if (files.length === 0) throw new SpeedRefreshError(`${input} holds no report`);
  return files;
}

function readReportFile(file: string): BenchReport {
  const size = fs.statSync(file).size;
  if (size > MAX_JSON_BYTES) throw new ReportSchemaError(`report ${file} is ${size} bytes, over the ${MAX_JSON_BYTES} byte limit`);
  return validateReport(JSON.parse(fs.readFileSync(file, 'utf8')) as unknown);
}

interface RefreshOptions {
  write: boolean;
  baselinePath: string;
  gapsPath: string;
  inputs: string[];
}

function parseRefreshArgs(args: string[]): RefreshOptions {
  const options: RefreshOptions = { write: false, baselinePath: BASELINE_PATH, gapsPath: PARITY_GAPS_PATH, inputs: [] };
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === '--write') options.write = true;
    else if (flag === '--baseline' || flag === '--gaps') {
      const value = args[++i];
      if (value === undefined || value.startsWith('--')) throw new BenchArgumentError(`${flag} needs a value`);
      if (flag === '--baseline') options.baselinePath = path.resolve(value);
      else options.gapsPath = path.resolve(value);
    } else if (flag.startsWith('--')) throw new BenchArgumentError(`unknown argument ${flag}`);
    else options.inputs.push(flag);
  }
  if (options.inputs.length === 0) throw new BenchArgumentError('give at least one report file or artifact directory');
  return options;
}

function describeChanges(title: string, changes: RatioChange[], out: (line: string) => void): void {
  out(`${title}: ${changes.length}`);
  for (const change of changes) out(`  ${change.id}: ${change.before === null ? 'none' : showRatio(change.before)} -> ${showRatio(change.after)}`);
}

export function main(args: string[], out: (line: string) => void = (line) => process.stdout.write(`${line}\n`)): number {
  const options = parseRefreshArgs(args);
  const reports = options.inputs
    .flatMap(reportFiles)
    .map((file) => ({ label: file, report: readReportFile(file) }));
  const plan = planSpeedRefresh(reports, readBaseline(options.baselinePath), readGaps(options.gapsPath));
  describeChanges('baseline speed ratios changed', plan.baselineChanges, out);
  describeChanges('known-gap ratios changed', plan.gapChanges, out);
  out(`tracked-gap histories extended: ${plan.historyChanges.length}`);
  for (const change of plan.historyChanges) out(`  ${change.id}: ${change.points} of ${SPEED_HISTORY_MAX_POINTS} runs kept`);
  for (const id of plan.nowAtParity) out(`now at parity, remove from bench/parity-gaps.json: ${id}`);
  for (const id of plan.leftUnstable) out(`left unchanged, undecided at the cap: ${id}`);
  for (const id of plan.notInReports) out(`left unchanged, not in the reports: ${id}`);
  if (!options.write) {
    out('dry run: nothing written; add --write to rewrite bench/baseline.json and bench/parity-gaps.json');
    return EXIT_DONE;
  }
  fs.writeFileSync(options.baselinePath, `${JSON.stringify(plan.baseline, null, 2)}\n`);
  fs.writeFileSync(options.gapsPath, `${JSON.stringify(plan.gaps, null, 2)}\n`);
  out(`written: ${options.baselinePath} and ${options.gapsPath}`);
  return EXIT_DONE;
}

if (require.main === module) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (error) {
    process.stderr.write(`bench:refresh-speed failed: ${error instanceof BenchError ? `${error.name}: ${error.message}` : String(error instanceof Error ? error.stack : error)}\n`);
    process.exit(EXIT_UNUSABLE);
  }
}
