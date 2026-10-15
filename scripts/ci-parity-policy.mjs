// Label policy of the reference-parity jobs in ci.yml. The benchmark run leaves bench-results/parity-verdict.json;
// this module turns it into the job's result:
//
//   pass    every evaluated row is at or above the reference tool, and no metric is worse than our own baseline;
//   exempt  a pull request labelled `security` that links an issue is excused from the parity verdict only: the
//           job posts one comment listing the rows below the reference with their gap issue, opens or updates one
//           `parity-gap` issue per family, and succeeds;
//   fail    anything else, including every regression against our own baseline, which no label excuses.
//
// The exemption never reaches tests, the anti-cheat guard, lint, build, the container or conformance: those are other
// jobs that this module does not touch. It is called from actions/github-script, with the injected client.

/** Label that grants the exemption, and the label the per-family gap issues carry. */
export const SECURITY_LABEL = 'security';
export const GAP_LABEL = 'parity-gap';
export const GAP_LABEL_COLOR = 'fbca04';
export const GAP_LABEL_DESCRIPTION = 'A family has rows below the reference tool';
export const COMMENT_MARKER_PREFIX = '<!-- parity-exemption:';
const RUN_FILE_SCHEMA_VERSION = 1;
const MAX_RUN_FILE_BYTES = 8 * 1024 * 1024;
/** Upper bounds on what a pull request text or a run file may make this module loop over. */
export const MAX_LINKED_ISSUES = 20;
export const MAX_ROWS = 5000;
export const MAX_FAMILIES = 64;
const MAX_ROWS_IN_COMMENT = 200;
const ISSUE_TEXT_LIMIT = 60_000;
const EXIT_CODES = new Set([0, 1, 2, 3]);
/** The label already exists (422) / the issue does not exist (404). */
const STATUS_VALIDATION_FAILED = 422;
const STATUS_NOT_FOUND = 404;

export class ParityPolicyError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ParityPolicyError';
  }
}

/**
 * Issue numbers a pull request names: a closing keyword (close, fix, resolve in any tense) or a reference keyword
 * (refs, ref, related to, part of, see) followed by #N. Deduplicated, in order of appearance, at most MAX_LINKED_ISSUES.
 */
export function linkedIssueNumbers(text) {
  const pattern = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?|refs?|related to|part of|see)\s*:?\s+#(\d{1,9})\b/gi;
  const found = [];
  for (const match of String(text ?? '').slice(0, ISSUE_TEXT_LIMIT).matchAll(pattern)) {
    const number = Number(match[1]);
    if (number > 0 && !found.includes(number)) found.push(number);
    if (found.length >= MAX_LINKED_ISSUES) break;
  }
  return found;
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

/** Rows below the reference tool, grouped by family (in order of first appearance). */
export function belowReferenceByFamily(run) {
  const families = new Map();
  for (const row of run.parity.rows) {
    if (row.outcome !== 'fail') continue;
    families.set(row.family, [...(families.get(row.family) ?? []), row]);
  }
  return families;
}

/**
 * The job's outcome for a verdict file.
 *   labels        names of the labels the pull request carries now
 *   verifiedIssues  numbers of the linked references that are real issues of this repository (not pull requests)
 *   requireStrict   the run must have been made with ORACLE_STRICT_MODE=1, so a missing tool cannot hide a row
 */
export function decide(run, { labels, verifiedIssues, requireStrict }) {
  if (requireStrict && !run.strictMode) {
    return { outcome: 'fail', exempt: false, reasons: ['the benchmark ran without ORACLE_STRICT_MODE=1, so a missing reference tool could have skipped rows'] };
  }
  if (run.baseline.regressions.length > 0) {
    return {
      outcome: 'fail',
      exempt: false,
      reasons: ['a metric is worse than our own baseline; no label excuses a regression', ...run.baseline.regressions.map((message) => `REGRESSION ${message}`)],
    };
  }
  if (run.exitCode === 2) return { outcome: 'fail', exempt: false, reasons: ['the benchmark run itself failed'] };
  if (run.parity.verdict === 'pass') return { outcome: 'pass', exempt: false, reasons: [] };
  const below = run.parity.rows.filter((row) => row.outcome === 'fail');
  const labelled = labels.includes(SECURITY_LABEL);
  if (labelled && verifiedIssues.length > 0) {
    return {
      outcome: 'exempt',
      exempt: true,
      reasons: [`the pull request is labelled "${SECURITY_LABEL}" and links issue #${verifiedIssues.join(', #')}: the parity verdict is waived, tests and every other check still apply`],
    };
  }
  const missing = [];
  if (!labelled) missing.push(`the "${SECURITY_LABEL}" label`);
  if (verifiedIssues.length === 0) missing.push('a linked issue');
  return {
    outcome: 'fail',
    exempt: false,
    reasons: [`${below.length} row${below.length === 1 ? ' is' : 's are'} below the reference tool; the security exemption needs ${missing.join(' and ')}`],
  };
}

function gapText(gap) {
  if (!gap) return 'no gap recorded';
  return gap.issue === null ? 'known gap, no issue filed' : `#${gap.issue}`;
}

const cell = (text) => String(text).replace(/\|/g, '\\|').replace(/\n/g, ' ');

/** Table of the rows below the reference, with the issue that tracks each. */
function rowTable(rows) {
  const shown = rows.slice(0, MAX_ROWS_IN_COMMENT);
  const lines = ['| Row | Detail | Gap |', '|---|---|---|', ...shown.map((row) => `| ${cell(row.id)} | ${cell(row.detail)} | ${gapText(row.gap)} |`)];
  if (rows.length > shown.length) lines.push(`| ... | ${rows.length - shown.length} more rows | |`);
  return lines.join('\n');
}

export function commentMarker(scope) {
  return `${COMMENT_MARKER_PREFIX}${scope} -->`;
}

/** The one comment a job posts when the exemption applies. */
export function renderExemptionComment(run, { scope, issues, familyIssues }) {
  const rows = run.parity.rows.filter((row) => row.outcome === 'fail');
  const perFamily = [...belowReferenceByFamily(run).keys()].map((family) => `- ${family}: ${familyIssues.get(family) ?? 'no issue could be opened'}`);
  return [
    commentMarker(scope),
    `**Reference parity (${scope}) waived by the \`${SECURITY_LABEL}\` exemption** (linked ${issues.map((n) => `#${n}`).join(', ')}).`,
    '',
    `${rows.length} row${rows.length === 1 ? ' is' : 's are'} below the reference tool. The exemption covers this verdict only: tests, the guard, lint, build, the container and conformance still have to pass, and no metric may be worse than our own baseline.`,
    '',
    rowTable(rows),
    '',
    'Tracking issues:',
    ...perFamily,
    '',
  ].join('\n');
}

export function gapIssueTitle(family) {
  return `Parity gap: ${family}`;
}

/** Body of a family's `parity-gap` issue, listing the rows that are below the reference. */
export function renderGapIssue(family, rows, { pullRequest, runUrl }) {
  return [
    `Rows of the \`${family}\` family are below the reference tool. A pull request that touches this family has to bring every row to parity; this issue tracks the rows.`,
    '',
    rowTable(rows),
    '',
    `Last seen on #${pullRequest}: ${runUrl}`,
    '',
  ].join('\n');
}

/** Whether an error from the GitHub client carries this HTTP status. */
function hasStatus(error, status) {
  return typeof error === 'object' && error !== null && 'status' in error && error.status === status;
}

async function ensureLabel(github, owner, repo) {
  try {
    await github.rest.issues.createLabel({ owner, repo, name: GAP_LABEL, color: GAP_LABEL_COLOR, description: GAP_LABEL_DESCRIPTION });
  } catch (error) {
    if (!hasStatus(error, STATUS_VALIDATION_FAILED)) throw error;
  }
}

/** Opens the open `parity-gap` issue of each family or updates its body; returns family -> "#N". */
export async function upsertGapIssues(github, { owner, repo, run, pullRequest, runUrl }) {
  const families = belowReferenceByFamily(run);
  if (families.size === 0) return new Map();
  await ensureLabel(github, owner, repo);
  const open = await github.paginate(github.rest.issues.listForRepo, { owner, repo, labels: GAP_LABEL, state: 'open', per_page: 100 });
  const result = new Map();
  for (const [family, rows] of families) {
    const title = gapIssueTitle(family);
    const body = renderGapIssue(family, rows, { pullRequest, runUrl });
    const existing = open.find((issue) => !issue.pull_request && issue.title === title);
    if (existing) {
      await github.rest.issues.update({ owner, repo, issue_number: existing.number, body });
      result.set(family, `#${existing.number}`);
    } else {
      const created = await github.rest.issues.create({ owner, repo, title, labels: [GAP_LABEL], body });
      result.set(family, `#${created.data.number}`);
    }
  }
  return result;
}

/** Creates the scope's comment, or replaces the one a previous run left (found by its marker). */
export async function upsertComment(github, { owner, repo, pullRequest, scope, body }) {
  const marker = commentMarker(scope);
  const comments = await github.paginate(github.rest.issues.listComments, { owner, repo, issue_number: pullRequest, per_page: 100 });
  const existing = comments.find((comment) => typeof comment.body === 'string' && comment.body.startsWith(marker));
  if (existing) {
    await github.rest.issues.updateComment({ owner, repo, comment_id: existing.id, body });
  } else {
    await github.rest.issues.createComment({ owner, repo, issue_number: pullRequest, body });
  }
}

/** The linked references that are issues of this repository: a pull request, or a number that does not exist, is not one. */
export async function verifyIssues(github, { owner, repo, numbers }) {
  const verified = [];
  for (const number of numbers.slice(0, MAX_LINKED_ISSUES)) {
    try {
      const { data } = await github.rest.issues.get({ owner, repo, issue_number: number });
      if (!data.pull_request) verified.push(number);
    } catch (error) {
      if (!hasStatus(error, STATUS_NOT_FOUND)) throw error;
    }
  }
  return verified;
}

/**
 * Entry point for the workflow step. `scope` is "quality" or "speed". Fails the step through core.setFailed unless the
 * outcome is pass or exempt; on exempt it comments and opens or updates the gap issues first.
 */
export async function applyParityVerdict({ github, context, core, fs, runFilePath, scope, requireStrict = true }) {
  const { owner, repo } = context.repo;
  const pull = context.payload.pull_request;
  if (!pull) throw new ParityPolicyError('the parity policy runs on pull requests only');
  let run;
  try {
    run = readRunFile(runFilePath, fs);
  } catch (error) {
    core.setFailed(`no usable parity verdict: ${error instanceof Error ? error.message : String(error)}`);
    return 'fail';
  }
  const labels = (pull.labels ?? []).map((label) => label.name);
  const numbers = linkedIssueNumbers(`${pull.title ?? ''}\n${pull.body ?? ''}`);
  const verifiedIssues = labels.includes(SECURITY_LABEL) ? await verifyIssues(github, { owner, repo, numbers }) : [];
  const decision = decide(run, { labels, verifiedIssues, requireStrict });
  for (const reason of decision.reasons) core.info(reason);

  if (decision.outcome === 'pass') return 'pass';
  if (decision.outcome === 'exempt') {
    const runUrl = `${context.serverUrl}/${owner}/${repo}/actions/runs/${context.runId}`;
    const familyIssues = await upsertGapIssues(github, { owner, repo, run, pullRequest: pull.number, runUrl });
    const body = renderExemptionComment(run, { scope, issues: verifiedIssues, familyIssues });
    await upsertComment(github, { owner, repo, pullRequest: pull.number, scope, body });
    core.warning(`reference parity (${scope}) waived by the ${SECURITY_LABEL} exemption: ${run.parity.rows.filter((row) => row.outcome === 'fail').length} rows are below the reference`);
    return 'exempt';
  }
  core.setFailed(decision.reasons[0] ?? 'reference parity failed');
  return 'fail';
}
