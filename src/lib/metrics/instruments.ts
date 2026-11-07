import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from '@prometheus-io/client';
import {
  FAMILIES,
  OUTCOMES,
  QUEUE_DEPTH_STATES,
  QUEUE_NAMES,
  REQUEST_ROUTES,
  SPAWN_FAILURE_REASONS,
  onList,
  type Family,
  type Outcome,
  type QueueDepthState,
  type QueueName,
  type RequestRoute,
  type SpawnFailureReason,
} from './labels';

/**
 * The service metrics (docs/slo.md). One registry per process, kept on `globalThis`: the framework builds the server hook and
 * each route into separate bundles, and a module-level registry would then be one registry per bundle, with the scrape
 * endpoint answering from an empty one. Every recorder puts its labels through the closed lists of `./labels`.
 */

const REGISTRY_KEY = Symbol.for('easyconvert.metrics.instruments');

const REQUEST_SECONDS_BUCKETS = [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 20, 30, 60, 120, 180];
const JOB_SECONDS_BUCKETS = [0.1, 0.5, 1, 2, 5, 10, 30, 60, 120, 300, 600, 1200, 1800, 3600];
const MS_PER_SECOND = 1000;

export interface Instruments {
  readonly registry: Registry;
  readonly requests: Counter<'route' | 'family' | 'outcome'>;
  readonly requestSeconds: Histogram<'route' | 'family' | 'outcome'>;
  readonly jobs: Counter<'family' | 'outcome'>;
  readonly jobSeconds: Histogram<'family' | 'outcome'>;
  readonly queueJobs: Gauge<'queue' | 'state'>;
  readonly queueOldestWaitingSeconds: Gauge<'queue'>;
  readonly queueSampleFailures: Counter;
  readonly sandboxSpawnFailures: Counter<'reason'>;
}

function createInstruments(): Instruments {
  const registry = new Registry();
  // process_start_time_seconds, process_cpu_*, process_resident_memory_bytes and the Node.js runtime metrics: a restart is a change of
  // the start time.
  collectDefaultMetrics({ register: registry });
  return {
    registry,
    requests: new Counter({
      name: 'easyconvert_http_requests_total',
      help: 'Answers of the convert routes, by route, family of the source format and outcome.',
      labelNames: ['route', 'family', 'outcome'] as const,
      registers: [registry],
    }),
    requestSeconds: new Histogram({
      name: 'easyconvert_http_request_duration_seconds',
      help: 'Seconds from the start of a convert request to its answer, by route, family and outcome.',
      labelNames: ['route', 'family', 'outcome'] as const,
      buckets: REQUEST_SECONDS_BUCKETS,
      registers: [registry],
    }),
    jobs: new Counter({
      name: 'easyconvert_jobs_total',
      help: 'Queue jobs that ended, by family of the source format and outcome. A job that is retried counts once, when it ends.',
      labelNames: ['family', 'outcome'] as const,
      registers: [registry],
    }),
    jobSeconds: new Histogram({
      name: 'easyconvert_job_duration_seconds',
      help: 'Seconds the last attempt of a job ran, by family and outcome.',
      labelNames: ['family', 'outcome'] as const,
      buckets: JOB_SECONDS_BUCKETS,
      registers: [registry],
    }),
    queueJobs: new Gauge({
      name: 'easyconvert_queue_jobs',
      help: 'Jobs in a queue, by queue and state (waiting, active, delayed). Read from the queue when scraped.',
      labelNames: ['queue', 'state'] as const,
      registers: [registry],
    }),
    queueOldestWaitingSeconds: new Gauge({
      name: 'easyconvert_queue_oldest_waiting_age_seconds',
      help: 'Seconds the job that has waited longest in a queue has waited; 0 when none waits. Read from the queue when scraped.',
      labelNames: ['queue'] as const,
      registers: [registry],
    }),
    queueSampleFailures: new Counter({
      name: 'easyconvert_queue_sample_failures_total',
      help: 'Scrapes in which the queue could not be read, so its gauges were left out.',
      registers: [registry],
    }),
    sandboxSpawnFailures: new Counter({
      name: 'easyconvert_sandbox_spawn_failures_total',
      help: 'Programs the sandbox did not start, by reason: the operating system refused the start, or the host cannot confine the program.',
      labelNames: ['reason'] as const,
      registers: [registry],
    }),
  };
}

type Holder = { [REGISTRY_KEY]?: Instruments };

export function instruments(): Instruments {
  const holder = globalThis as Holder;
  holder[REGISTRY_KEY] ??= createInstruments();
  return holder[REGISTRY_KEY];
}

/** Counts one answer of a convert route and times it. */
export function observeRequest(route: string, family: Family, outcome: Outcome, durationMs: number): void {
  const labels = {
    route: onList<RequestRoute>([...REQUEST_ROUTES, 'other'], route, 'other'),
    family: onList(FAMILIES, family, 'unknown'),
    outcome: onList(OUTCOMES, outcome, 'failed'),
  };
  const { requests, requestSeconds } = instruments();
  requests.inc(labels);
  requestSeconds.observe(labels, Math.max(0, durationMs) / MS_PER_SECOND);
}

/** Counts one job that ended, and times its last attempt when its run is known. */
export function observeJob(family: Family, outcome: Outcome, durationMs: number | undefined): void {
  const labels = { family: onList(FAMILIES, family, 'unknown'), outcome: onList(OUTCOMES, outcome, 'failed') };
  const { jobs, jobSeconds } = instruments();
  jobs.inc(labels);
  if (durationMs !== undefined && Number.isFinite(durationMs)) jobSeconds.observe(labels, Math.max(0, durationMs) / MS_PER_SECOND);
}

/** Counts one program the sandbox did not start. */
export function observeSandboxSpawnFailure(reason: SpawnFailureReason): void {
  // Called on the way to settling a spawn: a counter that throws must not leave the run unsettled until its timeout.
  try {
    instruments().sandboxSpawnFailures.inc({ reason: onList(SPAWN_FAILURE_REASONS, reason, 'spawn_error') });
  } catch {}
}

/** Sets the gauges of one queue from a reading. */
export function setQueueGauges(queue: QueueName, counts: Readonly<Record<QueueDepthState, number>>, oldestWaitingSeconds: number): void {
  const { queueJobs, queueOldestWaitingSeconds } = instruments();
  const name = onList(QUEUE_NAMES, queue, 'default');
  for (const state of QUEUE_DEPTH_STATES) queueJobs.set({ queue: name, state }, counts[state]);
  queueOldestWaitingSeconds.set({ queue: name }, oldestWaitingSeconds);
}

/** Forgets the readings of the queue gauges (the queue could not be read, and an old reading must not pass for a current one). */
export function clearQueueGauges(): void {
  const { queueJobs, queueOldestWaitingSeconds, queueSampleFailures } = instruments();
  queueJobs.reset();
  queueOldestWaitingSeconds.reset();
  queueSampleFailures.inc();
}
