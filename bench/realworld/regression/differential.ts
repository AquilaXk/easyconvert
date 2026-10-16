/**
 * The differential judge: the same files through the same pairs on the head and on an earlier run, so a file that converted
 * before and does not now is a regression even when no reference tool can open it. The earlier run is the result set of the last
 * full run, kept as an artifact; a job counts only when both sides ran the same file to the same target.
 */
import type { UnavailableFile } from '../judge';
import { evaluate, type GateResult, type JobRecord, knownIssue, type KnownFailure } from '../report';
import type { Verdict } from '../verdict';

export interface Regression {
  file: string;
  source: string;
  target: string;
  before: Verdict;
  now: Verdict;
  detail?: string;
}

export interface Differential {
  regressions: Regression[];
  /** Jobs present in both result sets. */
  compared: number;
  /** Jobs present in only one result set (a changed target list, a file added to or dropped from the night). */
  notComparable: number;
  /** Jobs that failed or were refused before and convert now. */
  repaired: number;
}

const keyOf = (job: JobRecord): string => `${job.file}\u0000${job.target}`;

export function differential(previous: readonly JobRecord[], current: readonly JobRecord[]): Differential {
  const before = new Map(previous.map((job) => [keyOf(job), job]));
  const regressions: Regression[] = [];
  let compared = 0;
  let repaired = 0;
  for (const job of current) {
    const earlier = before.get(keyOf(job));
    if (earlier === undefined) continue;
    compared++;
    if (earlier.verdict === 'ok' && job.verdict !== 'ok') {
      regressions.push({ file: job.file, source: job.source, target: job.target, before: earlier.verdict, now: job.verdict, ...(job.detail === undefined ? {} : { detail: job.detail }) });
    }
    if (earlier.verdict !== 'ok' && job.verdict === 'ok') repaired++;
  }
  const notComparable = previous.length - compared + (current.length - compared);
  return { regressions, compared, notComparable, repaired };
}

export interface RegressionGate extends GateResult {
  /** Regressions no known failure explains. */
  regressions: Regression[];
  knownRegressions: { regression: Regression; issue: number }[];
  /** Null when there was no earlier result set to compare with. */
  differential: Differential | null;
  /** Corpus files that could not be fetched, or whose bytes differ from the manifest: the corpus is wrong, not the converter. */
  unavailable: UnavailableFile[];
}

function asJob(regression: Regression): JobRecord {
  return { file: regression.file, source: regression.source, target: regression.target, verdict: regression.now, ms: 0, ...(regression.detail === undefined ? {} : { detail: regression.detail }) };
}

/**
 * The gate of a run: any crash, hang or bad output, and any regression, unless a known failure with an issue explains it; and any
 * corpus file that could not be fetched.
 */
export function evaluateRegression(jobs: readonly JobRecord[], previous: readonly JobRecord[] | null, knownFailures: readonly KnownFailure[], unavailable: readonly UnavailableFile[] = []): RegressionGate {
  const base = evaluate(jobs, null, knownFailures);
  const result = previous === null ? null : differential(previous, jobs);
  const regressions: Regression[] = [];
  const knownRegressions: RegressionGate['knownRegressions'] = [];
  for (const regression of result?.regressions ?? []) {
    const issue = knownIssue(asJob(regression), knownFailures);
    if (issue === null) regressions.push(regression);
    else knownRegressions.push({ regression, issue });
  }
  return { ...base, pass: base.pass && regressions.length === 0 && unavailable.length === 0, regressions, knownRegressions, differential: result, unavailable: [...unavailable] };
}
