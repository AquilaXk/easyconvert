// Verdict policy of the reference-parity job in ci.yml. The benchmark run leaves bench-results/parity-verdict.json;
// this module turns it into the job's result:
//
//   pass  every evaluated row is at or above the reference tool, and no metric is worse than our own baseline;
//   fail  anything else: a row below the reference, a regression against our own baseline, a run made without strict
//         mode, or a benchmark that itself failed. Nothing excuses a failure; the job summary lists the rows.
//
// It is called from actions/github-script and needs no GitHub client: a failing run is visible in Actions.

const RUN_FILE_SCHEMA_VERSION = 1;
const MAX_RUN_FILE_BYTES = 8 * 1024 * 1024;
/** Upper bounds on what a run file may make this module loop over. */
export const MAX_ROWS = 5000;
export const MAX_FAMILIES = 64;
const EXIT_CODES = new Set([0, 1, 2, 3]);

export class ParityPolicyError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ParityPolicyError';
  }
}

function fail(message) {
  throw new ParityPolicyError(`parity verdict file: ${message}`);
}

/** Validates the JSON a parity run wrote (bench/parity.ts ParityRunFile). */
export function parseRunFile(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail('must be an object');
  if (value.schemaVersion !== RUN_FILE_SCHEMA_VERSION) fail(`schemaVersion must be ${RUN_FILE_SCHEMA_VERSION}`);
  if (!Number.isInteger(value.exitCode) || !EXIT_CODES.has(value.exitCode)) fail('exitCode must be 0, 1, 2 or 3');
  if (typeof value.strictMode !== 'boolean') fail('strictMode must be a boolean');
  if (!Array.isArray(value.families) || value.families.length > MAX_FAMILIES) fail('families must be a short list');
  const baseline = value.baseline;
  if (typeof baseline !== 'object' || baseline === null || !Array.isArray(baseline.regressions) || baseline.regressions.some((item) => typeof item !== 'string')) {
    fail('baseline.regressions must be a list of strings');
  }
  const parity = value.parity;
  if (typeof parity !== 'object' || parity === null || (parity.verdict !== 'pass' && parity.verdict !== 'fail')) fail('parity.verdict must be "pass" or "fail"');
  if (!Array.isArray(parity.rows) || parity.rows.length > MAX_ROWS) fail(`parity.rows must be a list of at most ${MAX_ROWS} rows`);
  for (const row of parity.rows) {
    if (typeof row?.id !== 'string' || typeof row.family !== 'string' || typeof row.detail !== 'string') fail('every row needs an id, a family and a detail');
    if (row.outcome !== 'pass' && row.outcome !== 'fail' && row.outcome !== 'not-evaluated') fail(`row ${row.id} has an unknown outcome`);
    if (row.gap !== null && (typeof row.gap !== 'object' || (row.gap.issue !== null && !Number.isInteger(row.gap.issue)))) fail(`row ${row.id} has a malformed gap`);
  }
  const failing = parity.rows.filter((row) => row.outcome === 'fail').length;
  if ((parity.verdict === 'fail') !== (failing > 0)) fail('parity.verdict disagrees with its rows');
  return value;
}

export function readRunFile(file, fs) {
  const size = fs.statSync(file).size;
  if (size > MAX_RUN_FILE_BYTES) fail(`${file} is ${size} bytes, over the ${MAX_RUN_FILE_BYTES} byte limit`);
  return parseRunFile(JSON.parse(fs.readFileSync(file, 'utf8')));
}

/** The job's outcome for a verdict file. `requireStrict`: the run must have been made with ORACLE_STRICT_MODE=1, so a missing tool cannot hide a row. */
export function decide(run, { requireStrict }) {
  if (requireStrict && !run.strictMode) {
    return { outcome: 'fail', reasons: ['the benchmark ran without ORACLE_STRICT_MODE=1, so a missing reference tool could have skipped rows'] };
  }
  if (run.baseline.regressions.length > 0) {
    return { outcome: 'fail', reasons: ['a metric is worse than our own baseline', ...run.baseline.regressions.map((message) => `REGRESSION ${message}`)] };
  }
  if (run.exitCode === 2) return { outcome: 'fail', reasons: ['the benchmark run itself failed'] };
  if (run.parity.verdict === 'pass') return { outcome: 'pass', reasons: [] };
  const below = run.parity.rows.filter((row) => row.outcome === 'fail');
  return { outcome: 'fail', reasons: [`${below.length} row${below.length === 1 ? ' is' : 's are'} below the reference tool`] };
}

/** Entry point for the workflow step. Fails the step through core.setFailed unless the outcome is pass. */
export function applyParityVerdict({ core, fs, runFilePath, requireStrict = true }) {
  let run;
  try {
    run = readRunFile(runFilePath, fs);
  } catch (error) {
    core.setFailed(`no usable parity verdict: ${error instanceof Error ? error.message : String(error)}`);
    return 'fail';
  }
  const decision = decide(run, { requireStrict });
  for (const reason of decision.reasons) core.info(reason);
  if (decision.outcome === 'pass') return 'pass';
  core.setFailed(decision.reasons[0] ?? 'reference parity failed');
  return 'fail';
}
