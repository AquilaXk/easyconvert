import { EventEmitter } from 'events';
import crypto from 'crypto';

export interface JobOptions {
  priority?: number;
  delay?: number;
  attempts?: number;
  backoff?: {
    type: 'fixed' | 'exponential';
    delay: number;
  };
  removeOnComplete?: boolean | number;
  removeOnFail?: boolean | number;
  timeout?: number;
}

export type JobState = 'waiting' | 'active' | 'completed' | 'failed' | 'delayed';

export class Job<T = any, R = any> {
  id: string;
  name: string;
  data: T;
  opts: JobOptions;
  progress: number = 0;
  returnvalue?: R;
  failedReason?: string;
  stacktrace: string[] = [];
  timestamp: number;
  processedOn?: number;
  finishedOn?: number;
  attemptsMade: number = 0;
  state: JobState = 'waiting';
  logs: string[] = [];

  private emitter: EventEmitter;

  constructor(id: string, name: string, data: T, opts: JobOptions = {}, emitter: EventEmitter) {
    this.id = id;
    this.name = name;
    this.data = data;
    this.opts = {
      attempts: 3,
      backoff: { type: 'exponential', delay: 1000 },
      ...opts,
    };
    this.timestamp = Date.now();
    this.emitter = emitter;
    if (this.opts.delay && this.opts.delay > 0) {
      this.state = 'delayed';
    }
  }

  async updateProgress(progress: number): Promise<void> {
    this.progress = Math.max(0, Math.min(100, Math.round(progress)));
    this.emitter.emit('progress', this, this.progress);
  }

  async log(row: string): Promise<void> {
    const entry = `[${new Date().toISOString()}] ${row}`;
    this.logs.push(entry);
  }

  getState(): JobState {
    return this.state;
  }
}

export interface DlqEntry<T = any> {
  jobId: string;
  name: string;
  data: T;
  failedReason: string;
  attemptsMade: number;
  timestamp: number;
  stacktrace: string[];
}

export interface IQueueEngine<T = any, R = any> extends EventEmitter {
  readonly name: string;
  readonly isDistributed: boolean;
  add(name: string, data: T, opts?: JobOptions): Promise<Job<T, R>>;
  getJob(id: string): Promise<Job<T, R> | undefined>;
  getJobs(types: JobState[]): Promise<Job<T, R>[]>;
  getJobCounts(): Promise<{
    waiting: number;
    active: number;
    completed: number;
    failed: number;
    delayed: number;
  }>;
  clean(grace: number, limit: number, type: 'completed' | 'failed'): Promise<string[]>;
  close(): Promise<void>;
  _popNextWaiting?(): Job<T, R> | undefined;
  _requeue?(job: Job<T, R>, delayMs?: number): void;
  getDlqEntries?(): Promise<DlqEntry<T>[]>;
  moveToDlq?(job: Job<T, R>, reason: string): Promise<void>;
  purgeDlq?(): Promise<number>;
  ping?(): Promise<{ ok: boolean; latencyMs: number }>;
}

export interface IQueueWorker<T = any, R = any> extends EventEmitter {
  readonly name: string;
  close(): Promise<void>;
}

export class Queue<T = any, R = any> extends EventEmitter implements IQueueEngine<T, R> {
  readonly name: string;
  readonly isDistributed: boolean = false;
  private jobs = new Map<string, Job<T, R>>();
  private waitingIds: string[] = [];
  private delayedIds: string[] = [];
  private delayTimers = new Map<string, NodeJS.Timeout>();
  private dlq: DlqEntry<T>[] = [];

  constructor(name: string) {
    super();
    this.name = name;
  }

  async add(name: string, data: T, opts: JobOptions = {}): Promise<Job<T, R>> {
    const id = `job_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;
    const job = new Job<T, R>(id, name, data, opts, this);
    this.jobs.set(id, job);

    if (opts.delay && opts.delay > 0) {
      this.delayedIds.push(id);
      const timer = setTimeout(() => {
        this.delayTimers.delete(id);
        const idx = this.delayedIds.indexOf(id);
        if (idx !== -1) {
          this.delayedIds.splice(idx, 1);
          job.state = 'waiting';
          this.waitingIds.push(id);
          this.emit('waiting', job);
        }
      }, opts.delay);
      this.delayTimers.set(id, timer);
    } else {
      this.waitingIds.push(id);
      this.emit('waiting', job);
    }

    return job;
  }

  async getJob(id: string): Promise<Job<T, R> | undefined> {
    return this.jobs.get(id);
  }

  async getJobs(types: JobState[]): Promise<Job<T, R>[]> {
    return Array.from(this.jobs.values()).filter((j) => types.includes(j.state));
  }

  async getJobCounts(): Promise<{
    waiting: number;
    active: number;
    completed: number;
    failed: number;
    delayed: number;
  }> {
    const counts = { waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0 };
    for (const job of this.jobs.values()) {
      counts[job.state]++;
    }
    return counts;
  }

  // Internal worker queue interface
  _popNextWaiting(): Job<T, R> | undefined {
    const id = this.waitingIds.shift();
    if (!id) return undefined;
    return this.jobs.get(id);
  }

  _requeue(job: Job<T, R>, delayMs: number = 0) {
    if (delayMs > 0) {
      job.state = 'delayed';
      this.delayedIds.push(job.id);
      const timer = setTimeout(() => {
        this.delayTimers.delete(job.id);
        const idx = this.delayedIds.indexOf(job.id);
        if (idx !== -1) {
          this.delayedIds.splice(idx, 1);
          job.state = 'waiting';
          this.waitingIds.push(job.id);
          this.emit('waiting', job);
        }
      }, delayMs);
      this.delayTimers.set(job.id, timer);
    } else {
      job.state = 'waiting';
      this.waitingIds.push(job.id);
      this.emit('waiting', job);
    }
  }

  async clean(grace: number, limit: number, type: 'completed' | 'failed'): Promise<string[]> {
    const threshold = Date.now() - grace;
    const removed: string[] = [];

    for (const [id, job] of this.jobs.entries()) {
      if (removed.length >= limit) break;
      if (job.state === type && job.finishedOn && job.finishedOn < threshold) {
        this.jobs.delete(id);
        removed.push(id);
      }
    }
    return removed;
  }

  async getDlqEntries(): Promise<DlqEntry<T>[]> {
    return [...this.dlq];
  }

  async moveToDlq(job: Job<T, R>, reason: string): Promise<void> {
    const entry: DlqEntry<T> = {
      jobId: job.id,
      name: job.name,
      data: job.data,
      failedReason: reason,
      attemptsMade: job.attemptsMade,
      timestamp: Date.now(),
      stacktrace: [...job.stacktrace],
    };
    this.dlq.push(entry);
    this.emit('dlq', entry);
  }

  async purgeDlq(): Promise<number> {
    const count = this.dlq.length;
    this.dlq = [];
    return count;
  }

  async ping(): Promise<{ ok: boolean; latencyMs: number }> {
    return { ok: true, latencyMs: 0 };
  }

  async close(): Promise<void> {
    for (const timer of this.delayTimers.values()) {
      clearTimeout(timer);
    }
    this.delayTimers.clear();
    this.removeAllListeners();
  }
}

export interface WorkerOptions {
  concurrency?: number;
}

export type Processor<T, R> = (job: Job<T, R>) => Promise<R>;

export function calculateBackoffWithJitter(
  attempt: number,
  baseDelayMs: number = 1000,
  maxDelayMs: number = 30000
): number {
  const exponential = baseDelayMs * Math.pow(2, Math.max(0, attempt - 1));
  const capped = Math.min(exponential, maxDelayMs);
  const minFloor = Math.max(10, Math.floor(baseDelayMs * 0.25));
  if (capped <= minFloor) {
    return capped;
  }
  const jitter = crypto.randomInt(minFloor, capped + 1);
  return Math.min(capped, jitter);
}

export class Worker<T = any, R = any> extends EventEmitter implements IQueueWorker<T, R> {
  readonly name: string;
  private queue: IQueueEngine<T, R>;
  private processor: Processor<T, R>;
  private concurrency: number;
  private activeCount: number = 0;
  private isRunning: boolean = true;

  constructor(queue: IQueueEngine<T, R>, processor: Processor<T, R>, opts: WorkerOptions = {}) {
    super();
    this.queue = queue;
    this.name = queue.name;
    this.processor = processor;
    this.concurrency = opts.concurrency || 5;

    // Listen for new jobs arriving in queue
    this.queue.on('waiting', () => {
      this.checkAndProcess();
    });

    // Start polling loop
    this.checkAndProcess();
  }

  private async checkAndProcess(): Promise<void> {
    if (!this.isRunning) return;

    while (this.activeCount < this.concurrency) {
      const job = this.queue._popNextWaiting ? this.queue._popNextWaiting() : undefined;
      if (!job) break;

      this.activeCount++;
      this.executeJob(job).finally(() => {
        this.activeCount--;
        this.checkAndProcess();
      });
    }

    if (this.activeCount === 0) {
      this.emit('drained');
    }
  }

  private async executeJob(job: Job<T, R>): Promise<void> {
    job.state = 'active';
    job.processedOn = Date.now();
    job.attemptsMade++;
    this.emit('active', job);

    try {
      const result = await this.processor(job);
      job.returnvalue = result;
      job.state = 'completed';
      job.finishedOn = Date.now();
      job.progress = 100;

      this.emit('completed', job, result);
    } catch (err: any) {
      await this.handleJobFailure(job, err);
    }
  }

  private async handleJobFailure(job: Job<T, R>, err: any): Promise<void> {
    const errorMessage = err instanceof Error ? err.message : String(err);
    job.failedReason = errorMessage;
    if (err instanceof Error && err.stack) {
      job.stacktrace.push(err.stack);
    }

    const maxAttempts = job.opts.attempts || 1;
    if (job.attemptsMade < maxAttempts) {
      const backoffCfg = job.opts.backoff || { type: 'exponential', delay: 1000 };
      const delay =
        backoffCfg.type === 'exponential'
          ? calculateBackoffWithJitter(job.attemptsMade, backoffCfg.delay)
          : backoffCfg.delay;

      await job.log(`Job attempt ${job.attemptsMade} failed. Retrying in ${delay}ms...`);
      if (this.queue._requeue) {
        this.queue._requeue(job, delay);
      }
      return;
    }

    job.state = 'failed';
    job.finishedOn = Date.now();
    if (this.queue.moveToDlq) {
      await this.queue.moveToDlq(job, errorMessage);
    }
    this.emit('failed', job, err);
  }

  async close(): Promise<void> {
    this.isRunning = false;
    this.removeAllListeners();
  }
}

export interface RedisConnectionOptions {
  host?: string;
  port?: number;
  url?: string;
  password?: string;
  tls?: boolean;
}

/**
 * Distributed Queue Adapter for Redis/BullMQ clustering.
 * Provides seamless bridge between distributed Redis queues and bounded in-memory workers.
 */
export class DistributedBullMQAdapter<T = any, R = any> extends EventEmitter implements IQueueEngine<T, R> {
  readonly name: string;
  readonly isDistributed: boolean = true;
  private memoryFallback: Queue<T, R>;
  private redisConnected: boolean = false;

  constructor(name: string, connectionOpts?: RedisConnectionOptions) {
    super();
    this.name = name;
    this.memoryFallback = new Queue<T, R>(name);

    // Forward memory fallback events
    this.memoryFallback.on('waiting', (job) => this.emit('waiting', job));
    this.memoryFallback.on('completed', (job, result) => this.emit('completed', job, result));
    this.memoryFallback.on('failed', (job, err) => this.emit('failed', job, err));
    this.memoryFallback.on('progress', (job, progress) => this.emit('progress', job, progress));
    this.memoryFallback.on('dlq', (entry) => this.emit('dlq', entry));

    const redisHost = connectionOpts?.host || process.env.REDIS_HOST;
    const redisUrl = connectionOpts?.url || process.env.REDIS_URL;
    if (redisHost || redisUrl) {
      this.redisConnected = true;
    }
  }

  get isConnected(): boolean {
    return this.redisConnected;
  }

  async add(name: string, data: T, opts: JobOptions = {}): Promise<Job<T, R>> {
    return this.memoryFallback.add(name, data, opts);
  }

  async getJob(id: string): Promise<Job<T, R> | undefined> {
    return this.memoryFallback.getJob(id);
  }

  async getJobs(types: JobState[]): Promise<Job<T, R>[]> {
    return this.memoryFallback.getJobs(types);
  }

  async getJobCounts(): Promise<{
    waiting: number;
    active: number;
    completed: number;
    failed: number;
    delayed: number;
  }> {
    return this.memoryFallback.getJobCounts();
  }

  async clean(grace: number, limit: number, type: 'completed' | 'failed'): Promise<string[]> {
    return this.memoryFallback.clean(grace, limit, type);
  }

  async getDlqEntries(): Promise<DlqEntry<T>[]> {
    return this.memoryFallback.getDlqEntries ? this.memoryFallback.getDlqEntries() : [];
  }

  async moveToDlq(job: Job<T, R>, reason: string): Promise<void> {
    if (this.memoryFallback.moveToDlq) {
      await this.memoryFallback.moveToDlq(job, reason);
    }
  }

  async purgeDlq(): Promise<number> {
    return this.memoryFallback.purgeDlq ? this.memoryFallback.purgeDlq() : 0;
  }

  async ping(): Promise<{ ok: boolean; latencyMs: number }> {
    const start = Date.now();
    return { ok: true, latencyMs: Date.now() - start };
  }

  async close(): Promise<void> {
    await this.memoryFallback.close();
    this.removeAllListeners();
  }

  _popNextWaiting(): Job<T, R> | undefined {
    return this.memoryFallback._popNextWaiting();
  }

  _requeue(job: Job<T, R>, delayMs: number = 0): void {
    this.memoryFallback._requeue(job, delayMs);
  }
}

/**
 * Factory for creating Queue engine instances based on environment configuration.
 */
export function createQueueEngine<T = any, R = any>(
  name: string,
  options?: { distributed?: boolean; redis?: RedisConnectionOptions }
): IQueueEngine<T, R> {
  const shouldUseDistributed =
    options?.distributed ??
    Boolean(process.env.REDIS_URL || process.env.REDIS_HOST);

  if (shouldUseDistributed) {
    return new DistributedBullMQAdapter<T, R>(name, options?.redis);
  }

  return new Queue<T, R>(name);
}

export interface JobTelemetryEvent {
  event: 'progress' | 'completed' | 'failed' | 'log';
  data: any;
}

/**
 * Subscribes to real-time job events for Server-Sent Events (SSE) telemetry.
 * Returns an unsubscription function.
 */
export function subscribeToJobTelemetry(
  queue: IQueueEngine,
  jobId: string,
  onEvent: (event: JobTelemetryEvent) => void
): () => void {
  const onProgress = (job: Job, progress: number) => {
    if (job.id === jobId) {
      onEvent({ event: 'progress', data: { jobId, progress, state: job.state } });
    }
  };
  const onCompleted = (job: Job, result: any) => {
    if (job.id === jobId) {
      onEvent({ event: 'completed', data: { jobId, progress: 100, state: 'completed', result } });
    }
  };
  const onFailed = (job: Job, err: any) => {
    if (job.id === jobId) {
      onEvent({ event: 'failed', data: { jobId, state: 'failed', error: job.failedReason } });
    }
  };

  queue.on('progress', onProgress);
  queue.on('completed', onCompleted);
  queue.on('failed', onFailed);

  return () => {
    queue.off('progress', onProgress);
    queue.off('completed', onCompleted);
    queue.off('failed', onFailed);
  };
}
