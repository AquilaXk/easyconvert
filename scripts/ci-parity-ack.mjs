#!/usr/bin/env node
// The acknowledgement rule of `verify` for a failed `parity speed` job. Temporary: it goes when the speed rows are
// compared against the base inside one job (#700).
//
//   node scripts/ci-parity-ack.mjs --verdict <parity-verdict.json> --specific <families> --role <repository role>
//        [--actor <login>] [--comment-file <file>]
//
// prints `acknowledged=true|false` and one `reason=` line per refusal, and exits 0 either way (the workflow reads the
// output). A pull request carrying the `parity-ack` label, added by someone with the admin or maintain role, passes a
// failed speed run only when EVERY failing row of that run's verdict is noise the harness could not decide:
//   1. its basis is `speed-unstable-at-cap` (the interval still straddled the parity line at the cap on pairs), on a
//      throughput row: never a credible slowdown (`speed-below-reference`, `tracked-slower-than-gap`) and never a quality row;
//   2. its median ratio is at least the parity line (0.97);
//   3. its family is in the pull request's family set only through the all-family rules: the change maps no file
//      specifically to that family.
// Anything else (no verdict, a verdict that is not a strict speed run, a baseline regression, no failing row, a missing
// number) is refused, so the rule fails closed.
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The speed parity line: a row passes when its ratio is at least 1 minus the tolerance (bench/config.ts, SPEED_PARITY_TOLERANCE). */
export const PARITY_LINE = 0.97;
export const ACK_LABEL = 'parity-ack';
export const ACK_ROLES = new Set(['admin', 'maintain']);
export const COMMENT_MARKER = '<!-- parity-ack -->';
const MAX_VERDICT_BYTES = 8 * 1024 * 1024;
const UNDECIDED_BASIS = 'speed-unstable-at-cap';

/** Whether the repository role of the person who added the label lets the label count. */
export function mayAcknowledge(role) {
  return typeof role === 'string' && ACK_ROLES.has(role);
}

const isNumber = (value) => typeof value === 'number' && Number.isFinite(value);

/**
 * Judges a parsed verdict. Returns { acknowledged, rows, reasons }: `rows` are the failing rows that were acknowledged
 * (all of them when `acknowledged`), `reasons` why not.
 */
export function judgeAcknowledgement(verdict, { specific = [], role } = {}) {
  const reasons = [];
  if (!mayAcknowledge(role)) reasons.push(`the label was not added by someone with the admin or maintain role (role: ${role || 'unknown'})`);
  const parity = verdict?.parity;
  if (verdict === null || typeof verdict !== 'object' || parity === null || typeof parity !== 'object' || !Array.isArray(parity.rows)) {
    return { acknowledged: false, rows: [], reasons: [...reasons, 'there is no readable parity verdict for this run'] };
  }
  if (verdict.scope !== 'speed' || verdict.strictMode !== true || verdict.quick !== false || verdict.injectedRegression !== null) {
    reasons.push('the verdict is not a strict, full speed run without an injected regression');
  }
  if (!Array.isArray(verdict.baseline?.regressions) || verdict.baseline.regressions.length > 0) {
    reasons.push('the run has a regression against the recorded baseline');
  }
  const failing = parity.rows.filter((row) => row?.outcome === 'fail');
  if (failing.length === 0) reasons.push('the verdict has no failing row, so the job failed for another reason');
  const blocked = new Set(specific);
  const acknowledged = [];
  for (const row of failing) {
    const id = String(row?.id);
    if (row.basis !== UNDECIDED_BASIS || row.metric !== 'throughput') {
      reasons.push(`${id}: ${row.basis === 'speed-below-reference' || row.basis === 'tracked-slower-than-gap' ? 'a credible slowdown' : 'not an undecided speed row'} (basis ${row.basis}, metric ${row.metric}) cannot be acknowledged`);
      continue;
    }
    const speed = row.speed;
    if (!isNumber(speed?.median) || !isNumber(speed?.low) || !isNumber(speed?.high)) {
      reasons.push(`${id}: the verdict carries no measured ratio and interval`);
      continue;
    }
    if (speed.median < PARITY_LINE) {
      reasons.push(`${id}: the median ratio ${speed.median} is below ${PARITY_LINE}`);
      continue;
    }
    if (typeof row.family !== 'string' || blocked.has(row.family)) {
      reasons.push(`${id}: the change maps files specifically to the ${row.family} family, so its row is not shared noise`);
      continue;
    }
    acknowledged.push({ id, family: row.family, median: speed.median, low: speed.low, high: speed.high, pairs: speed.pairs });
  }
  return reasons.length === 0 ? { acknowledged: true, rows: acknowledged, reasons } : { acknowledged: false, rows: [], reasons };
}

/** The pull request comment that records an acknowledgement. */
export function acknowledgementComment(rows, { actor, role, runUrl } = {}) {
  const lines = [
    COMMENT_MARKER,
    '### Speed parity acknowledged',
    '',
    `\`parity speed\` failed on rows it could not decide, and \`verify\` passed them because the \`${ACK_LABEL}\` label was added by ${actor ? `@${actor}` : 'a maintainer'}${role ? ` (${role})` : ''}.`,
    '',
    '| Row | Median ratio | Interval | Pairs |',
    '|---|---|---|---|',
    ...rows.map((row) => `| \`${row.id}\` | ${row.median} | [${row.low}, ${row.high}] | ${row.pairs ?? 'unknown'} |`),
    '',
    `Rule (temporary until #700): every failing row must be undecided at the cap on pairs (\`${UNDECIDED_BASIS}\`), have a median ratio of at least ${PARITY_LINE}, and belong to a family this change reaches only through shared rules. A credible slowdown, a quality row or a family the change maps files to is never acknowledged.`,
  ];
  if (runUrl) lines.push('', `Run: ${runUrl}`);
  return `${lines.join('\n')}\n`;
}

function readVerdict(file) {
  try {
    const text = readFileSync(file, 'utf8');
    if (text.length > MAX_VERDICT_BYTES) return null;
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function option(args, name) {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? undefined : args[index + 1];
}

function main(args) {
  const verdict = readVerdict(option(args, 'verdict') ?? 'parity-verdict.json');
  const specific = (option(args, 'specific') ?? '').split(',').map((name) => name.trim()).filter(Boolean);
  const result = judgeAcknowledgement(verdict, { specific, role: option(args, 'role') });
  console.log(`acknowledged=${result.acknowledged}`);
  for (const reason of result.reasons) console.log(`reason=${reason}`);
  const commentFile = option(args, 'comment-file');
  if (result.acknowledged && commentFile) {
    writeFileSync(commentFile, acknowledgementComment(result.rows, { actor: option(args, 'actor'), role: option(args, 'role'), runUrl: option(args, 'run-url') }));
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}
