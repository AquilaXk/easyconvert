import type { ConversionJobData, ConversionJobResult } from '../types';
import type { Job, JobState } from './bullmq-engine';
import { conversionQueue } from './conversion-queue';
import { graphScheduler } from './graph/scheduler';
import type { GraphExecutionState, GraphStatus } from './graph/scheduler-types';

/**
 * The newest `limit` jobs of `userId` in `states` that a client lists. A graph is run, charged and cancelled as one job, so
 * the node jobs it queues are left out (by the queue, before the page is counted, so a caller whose recent jobs are nearly all graph
 * nodes still gets a full page); the graph is read and cancelled by its own id. A Redis queue reads the ids of the caller's jobs
 * once and their jobs until the page is full.
 */
export async function listVisibleJobs(userId: string, states: JobState[], limit: number): Promise<Job<ConversionJobData, ConversionJobResult>[]> {
  return conversionQueue.getJobsByUser(userId, states, limit, 0, { excludeGraphNodes: true });
}

/** One entry of a list a client reads: a queue job, or a graph, which has no queue job of its own. */
export type ListedWork =
  | { kind: 'job'; job: Job<ConversionJobData, ConversionJobResult>; createdAt: number }
  | { kind: 'graph'; graph: GraphExecutionState; createdAt: number };

/**
 * The graph statuses a filter on job states asks for. A running graph is unfinished work, so it answers to `waiting` and
 * `active`; the ended statuses are the same words. No graph is `delayed`.
 */
function graphStatusesOf(states: readonly JobState[]): GraphStatus[] {
  const wanted = new Set<GraphStatus>();
  for (const state of states) {
    if (state === 'waiting' || state === 'active') wanted.add('running');
    else if (state === 'completed' || state === 'failed' || state === 'cancelled') wanted.add(state);
  }
  return [...wanted];
}

/** The state of a graph in the words of a queue job: a running graph is `active`. */
export function graphJobState(status: GraphStatus): JobState {
  return status === 'running' ? 'active' : status;
}

/** When the first node of a graph started, as the processing time of its job. */
export function graphProcessedOn(graph: GraphExecutionState): number | undefined {
  const started = Object.values(graph.nodes).flatMap((node) => (node.startedAt === undefined ? [] : [node.startedAt]));
  return started.length > 0 ? Math.min(...started) : undefined;
}

/**
 * The newest `limit` jobs and graphs of `userId` in `states`, newest first. The queues are read once (see `listVisibleJobs`) and
 * so is the index of the user's graphs (`listGraphsOfUser`), each for the page asked for, then the two are merged by creation time.
 */
export async function listVisibleWork(userId: string, states: JobState[], limit: number): Promise<ListedWork[]> {
  const graphStatuses = graphStatusesOf(states);
  const [jobs, graphs] = await Promise.all([
    listVisibleJobs(userId, states, limit),
    graphStatuses.length > 0 ? graphScheduler.listGraphsOfUser(userId, limit, graphStatuses) : Promise.resolve([]),
  ]);
  const work: ListedWork[] = [
    ...jobs.map((job): ListedWork => ({ kind: 'job', job, createdAt: job.timestamp })),
    ...graphs.map((graph): ListedWork => ({ kind: 'graph', graph, createdAt: graph.createdAt })),
  ];
  return work.sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
}
