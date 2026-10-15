/**
 * Refreshes the recorded speed ratios (`bench/baseline.json` throughput entries and `bench/parity-gaps.json` ratios and
 * run histories) from the benchmark reports a CI speed-parity run uploads. Speed depends on the machine, so a ratio recorded from
 * a laptop is wrong for the runner that enforces it: this command accepts only reports measured under
 * ORACLE_STRICT_MODE=1 on Linux (the runner), with no injected regression, by a `--parity` run, and recording the commit,
 * branch and event of its run. A history takes runs of the default branch's nightly workflow (schedule or manual
 * dispatch) or push only: the report of a pull request that regressed would otherwise lower the bound of every later
 * pull request. `--allow-branch <name>` accepts the runs of that one branch as well, for a branch that is itself
 * refreshing its numbers before it merges.
 *
 *   npm run bench:refresh-speed -- <report.json | artifact directory>...          prints what would change
 *   npm run bench:refresh-speed -- --write <report.json | artifact directory>...  rewrites the two files
 *   npm run bench:refresh-speed -- --reseed [--write]                              restarts every history at its last step
 *
 * Sources: the `bench-speed-results` artifact of the nightly workflow (30 days; start one with
 * `gh workflow run nightly.yml`), or the `parity-speed-results` artifact of the `parity speed` job of ci.yml (7 days) from
 * a run on the default branch.
 *
 * Exit codes: 0 done, 2 the inputs cannot be used.
 */
import fs from 'node:fs';
import path from 'node:path';
import { BASELINE_PATH, DEFAULT_BRANCH, MAX_JSON_BYTES, PARITY_GAPS_PATH, PARITY_VERDICT_FILE, SPEED_HISTORY_MAX_POINTS, SPEED_REFRESH_EVENTS } from './config';
import { BenchArgumentError, BenchError, ReportSchemaError } from './errors';
import { type Baseline, buildBaseline, readBaseline } from './gate';
import { type GapFile, isSpeedRowId, readGaps } from './parity-gaps';
import { type BenchReport, type BenchRow, validateReport } from './report';
import { appendSpeedHistory, sinceLastStep } from './speed-history';

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
  /** Tracked rows whose new run was a step up, so the older points were dropped. */
  restarted: string[];
  /** Tracked rows that now pass the parity rule: remove their entries from bench/parity-gaps.json. */
  nowAtParity: string[];
  /** Rows whose interval was still undecided at the cap: their baseline ratio is not trustworthy, so it is left alone. */
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

export interface RefreshOptions {
  /** A branch other than the default one whose runs may extend the histories. */
  allowBranch?: string;
}

/** A report is usable for a history only when a nightly or push run of the default branch (or the allowed branch) measured it. */
function checkSource(report: BenchReport, label: string, allowBranch: string | undefined): void {
  const source = report.source;
  if (source === undefined) {
    throw new SpeedRefreshError(`${label}: the report records no commit, branch or event, so the run that measured it cannot be told from a pull request's; refresh from a report made by a current nightly run`);
  }
  const fromDefault = source.branch === DEFAULT_BRANCH && SPEED_REFRESH_EVENTS.has(source.event);
  const fromAllowed = allowBranch !== undefined && source.branch === allowBranch;
  if (!fromDefault && !fromAllowed) {
    throw new SpeedRefreshError(
      `${label}: measured by the ${source.event} run of ${source.branch}, which is not a run of ${DEFAULT_BRANCH} (${[...SPEED_REFRESH_EVENTS].join(', ')}); pass --allow-branch ${source.branch} to refresh from that branch's own run`
    );
  }
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
 * - A row that was still undecided at the cap keeps its baseline ratio, but its median still joins the history of a tracked row.
 */
export function planSpeedRefresh(reports: ReadonlyArray<{ label: string; report: BenchReport }>, baseline: Baseline, gaps: GapFile, options: RefreshOptions = {}): SpeedRefresh {
  if (reports.length === 0) throw new SpeedRefreshError('no report to refresh from');
  const measured = new Map<string, BenchRow>();
  const measuredAt = new Map<string, string>();
  const measuredCommit = new Map<string, string>();
  for (const { label, report } of reports) {
    checkMeasuredOnRunner(report, label);
    checkSource(report, label, options.allowBranch);
    for (const row of speedRows(report, label)) {
      if (measured.has(row.id)) throw new SpeedRefreshError(`${label}: ${row.id} is also in an earlier report; refresh from one run per row`);
      measured.set(row.id, row);
      measuredAt.set(row.id, report.generatedAt);
      measuredCommit.set(row.id, (report.source as { commit: string }).commit);
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
  const restarted: string[] = [];
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
    // A run still undecided at the cap leaves the baseline ratio alone, but its median is a measurement and joins the history:
    // without it a row that is unstable every night keeps a stale latest median, and nothing is held against the floor.
    if (row.unstableAtCap === true) leftUnstable.push(gap.id);
    if (row.speedVerdict === 'pass') {
      nowAtParity.push(gap.id);
      return gap;
    }
    const runAt = measuredAt.get(gap.id) as string;
    const previous = gap.history ?? [];
    const history = appendSpeedHistory(previous, row.ratioMedian as number, runAt, measuredCommit.get(gap.id));
    if (!previous.some((point) => point.at === runAt)) {
      historyChanges.push({ id: gap.id, points: history.length });
      if (history.length <= previous.length) restarted.push(gap.id);
    }
    const after = floorRatio(history[history.length - 1].ratio);
    if (!(after > 0)) throw new SpeedRefreshError(`${gap.id}: the measured ratio ${row.ratioMedian} rounds to zero`);
    if (after !== gap.ratio) gapChanges.push({ id: gap.id, before: gap.ratio, after });
    const note =
      after !== gap.ratio && GENERATED_NOTE.test(gap.note)
        ? `speed ratio ${showRatio(after)} or below when recorded on the CI runner (previous record ${gap.ratio === null ? 'none' : showRatio(gap.ratio)}): ours is slower than the reference tool`
        : gap.note;
    return { ...gap, ratio: after, note, history };
  });
  return { baseline: next, gaps: { schemaVersion: gaps.schemaVersion, gaps: nextGaps }, baselineChanges, gapChanges, historyChanges, restarted, nowAtParity, leftUnstable, notInReports };
}

export interface Reseed {
  gaps: GapFile;
  /** Histories that held points from before their last step. */
  restarted: Array<{ id: string; dropped: number; points: number }>;
}

/** The gap file with every history cut back to the points since its last step; nothing else changes. */
export function reseedGapHistories(gaps: GapFile): Reseed {
  const restarted: Reseed['restarted'] = [];
  const next = gaps.gaps.map((gap) => {
    if (gap.history === undefined) return gap;
    const kept = sinceLastStep(gap.history);
    if (kept.length === gap.history.length) return gap;
    restarted.push({ id: gap.id, dropped: gap.history.length - kept.length, points: kept.length });
    return { ...gap, history: kept };
  });
  return { gaps: { schemaVersion: gaps.schemaVersion, gaps: next }, restarted };
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

interface CliOptions {
  write: boolean;
  reseed: boolean;
  allowBranch?: string;
  baselinePath: string;
  gapsPath: string;
  inputs: string[];
}

function parseRefreshArgs(args: string[]): CliOptions {
  const options: CliOptions = { write: false, reseed: false, baselinePath: BASELINE_PATH, gapsPath: PARITY_GAPS_PATH, inputs: [] };
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === '--write') options.write = true;
    else if (flag === '--reseed') options.reseed = true;
    else if (flag === '--baseline' || flag === '--gaps' || flag === '--allow-branch') {
      const value = args[++i];
      if (value === undefined || value.startsWith('--')) throw new BenchArgumentError(`${flag} needs a value`);
      if (flag === '--baseline') options.baselinePath = path.resolve(value);
      else if (flag === '--gaps') options.gapsPath = path.resolve(value);
      else options.allowBranch = value;
    } else if (flag.startsWith('--')) throw new BenchArgumentError(`unknown argument ${flag}`);
    else options.inputs.push(flag);
  }
  if (options.reseed && options.inputs.length > 0) throw new BenchArgumentError('--reseed rewrites the histories on file and takes no report');
  if (!options.reseed && options.inputs.length === 0) throw new BenchArgumentError('give at least one report file or artifact directory');
  return options;
}

function describeChanges(title: string, changes: RatioChange[], out: (line: string) => void): void {
  out(`${title}: ${changes.length}`);
  for (const change of changes) out(`  ${change.id}: ${change.before === null ? 'none' : showRatio(change.before)} -> ${showRatio(change.after)}`);
}

function reseedMain(options: CliOptions, out: (line: string) => void): number {
  const result = reseedGapHistories(readGaps(options.gapsPath));
  out(`histories restarted at their last step: ${result.restarted.length}`);
  for (const item of result.restarted) out(`  ${item.id}: dropped ${item.dropped} points, ${item.points} kept`);
  if (!options.write) {
    out('dry run: nothing written; add --write to rewrite bench/parity-gaps.json');
    return EXIT_DONE;
  }
  fs.writeFileSync(options.gapsPath, `${JSON.stringify(result.gaps, null, 2)}\n`);
  out(`written: ${options.gapsPath}`);
  return EXIT_DONE;
}

export function main(args: string[], out: (line: string) => void = (line) => process.stdout.write(`${line}\n`)): number {
  const options = parseRefreshArgs(args);
  if (options.reseed) return reseedMain(options, out);
  const reports = options.inputs
    .flatMap(reportFiles)
    .map((file) => ({ label: file, report: readReportFile(file) }));
  const plan = planSpeedRefresh(reports, readBaseline(options.baselinePath), readGaps(options.gapsPath), { allowBranch: options.allowBranch });
  describeChanges('baseline speed ratios changed', plan.baselineChanges, out);
  describeChanges('known-gap ratios changed', plan.gapChanges, out);
  out(`tracked-gap histories extended: ${plan.historyChanges.length}`);
  for (const change of plan.historyChanges) out(`  ${change.id}: ${change.points} of ${SPEED_HISTORY_MAX_POINTS} runs kept`);
  for (const id of plan.restarted) out(`history restarted at a step up: ${id}`);
  for (const id of plan.nowAtParity) out(`now at parity, remove from bench/parity-gaps.json: ${id}`);
  for (const id of plan.leftUnstable) out(`baseline ratio left unchanged, undecided at the cap (its median joined the history): ${id}`);
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
