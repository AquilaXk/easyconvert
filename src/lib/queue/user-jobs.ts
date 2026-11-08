import type { ConversionJobData, ConversionJobResult } from '../types';
import type { Job, JobState } from './bullmq-engine';
import { conversionQueue } from './conversion-queue';

/** Jobs read from the queue per request while the page is filled; a caller whose recent jobs are nearly all graph nodes gets the page that fits in these. */
const MAX_JOBS_SCANNED = 1000;

/** Whether `job` is one node of a graph, which the graph answers for as a whole. */
function isGraphNodeJob(job: Job<ConversionJobData, ConversionJobResult>): boolean {
  return Boolean(job.data?.graphId);
}

/**
 * The newest `limit` jobs of `userId` in `states` that a client lists. A graph is run, charged and cancelled as one job, so
 * the node jobs it queues are left out; the graph is read and cancelled by its own id.
 */
export async function listVisibleJobs(userId: string, states: JobState[], limit: number): Promise<Job<ConversionJobData, ConversionJobResult>[]> {
  const listed: Job<ConversionJobData, ConversionJobResult>[] = [];
  let scanned = 0;
  while (listed.length < limit && scanned < MAX_JOBS_SCANNED) {
    const batch = await conversionQueue.getJobsByUser(userId, states, limit, scanned);
    for (const job of batch) {
      if (!isGraphNodeJob(job)) listed.push(job);
    }
    if (batch.length < limit) break;
    scanned += batch.length;
  }
  return listed.slice(0, limit);
}
