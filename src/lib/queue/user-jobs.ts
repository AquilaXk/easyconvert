import type { ConversionJobData, ConversionJobResult } from '../types';
import type { Job, JobState } from './bullmq-engine';
import { conversionQueue } from './conversion-queue';

/** Jobs of a caller read from the queues per request; a caller whose recent jobs are nearly all graph nodes gets the page that fits in these. */
const MAX_JOBS_SCANNED = 1000;

/** Whether `job` is one node of a graph, which the graph answers for as a whole. */
function isGraphNodeJob(job: Job<ConversionJobData, ConversionJobResult>): boolean {
  return Boolean(job.data?.graphId);
}

/**
 * The newest `limit` jobs of `userId` in `states` that a client lists. A graph is run, charged and cancelled as one job, so
 * the node jobs it queues are left out; the graph is read and cancelled by its own id. The queues are read once per request
 * (a Redis queue reads the ids of the caller's jobs whatever the page asks for), up to MAX_JOBS_SCANNED jobs.
 */
export async function listVisibleJobs(userId: string, states: JobState[], limit: number): Promise<Job<ConversionJobData, ConversionJobResult>[]> {
  const jobs = await conversionQueue.getJobsByUser(userId, states, MAX_JOBS_SCANNED, 0);
  return jobs.filter((job) => !isGraphNodeJob(job)).slice(0, limit);
}
