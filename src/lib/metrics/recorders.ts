import { classifyJobFailure } from '../queue/job-failure';
import { familyOfFormat } from './families';
import { observeJob, observeRequest } from './instruments';
import { outcomeOfStatus } from './labels';

/** What the recorders read of a queue job. */
interface EndedJob {
  data?: { sourceFormat?: unknown };
  processedOn?: number;
  finishedOn?: number;
}

const HTTP_INTERNAL_SERVER_ERROR = 500;

/** Counts and times one answer of a convert route; `source` is the registry's id of the source format when the route learned it. */
export function recordConvertAnswer(route: string, source: string | undefined, status: number, startedAt: number): void {
  observeRequest(route, familyOfFormat(source), outcomeOfStatus(status), Date.now() - startedAt);
}

function lastAttemptMs(job: EndedJob): number | undefined {
  return job.processedOn !== undefined && job.finishedOn !== undefined ? job.finishedOn - job.processedOn : undefined;
}

/** Counts a job that ended with a result. */
export function recordJobCompleted(job: EndedJob): void {
  observeJob(familyOfFormat(job.data?.sourceFormat), 'ok', lastAttemptMs(job));
}

/** Counts a job whose last attempt failed: by the status its failure answers on the synchronous API (a deadline is 504). */
export function recordJobFailed(job: EndedJob, err: unknown): void {
  const status = classifyJobFailure(err).status ?? HTTP_INTERNAL_SERVER_ERROR;
  observeJob(familyOfFormat(job.data?.sourceFormat), outcomeOfStatus(status), lastAttemptMs(job));
}
