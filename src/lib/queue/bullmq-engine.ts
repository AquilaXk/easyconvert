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

export class Queue<T = any, R = any> extends EventEmitter {
  readonly name: string;
  private jobs = new Map<string, Job<T, R>>();
  private waitingIds: string[] = [];
  private delayedIds: string[] = [];

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
      setTimeout(() => {
        const idx = this.delayedIds.indexOf(id);
        if (idx !== -1) {
          this.delayedIds.splice(idx, 1);
          job.state = 'waiting';
          this.waitingIds.push(id);
          this.emit('waiting', job);
        }
      }, opts.delay);
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
      setTimeout(() => {
        const idx = this.delayedIds.indexOf(job.id);
        if (idx !== -1) {
          this.delayedIds.splice(idx, 1);
          job.state = 'waiting';
          this.waitingIds.push(job.id);
          this.emit('waiting', job);
        }
      }, delayMs);
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

  async close(): Promise<void> {
    this.removeAllListeners();
  }
}

export interface WorkerOptions {
  concurrency?: number;
}

export type Processor<T, R> = (job: Job<T, R>) => Promise<R>;

export class Worker<T = any, R = any> extends EventEmitter {
  readonly name: string;
  private queue: Queue<T, R>;
  private processor: Processor<T, R>;
  private concurrency: number;
  private activeCount: number = 0;
  private isRunning: boolean = true;

  constructor(queue: Queue<T, R>, processor: Processor<T, R>, opts: WorkerOptions = {}) {
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
      const job = this.queue._popNextWaiting();
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
      const errorMessage = err instanceof Error ? err.message : String(err);
      job.failedReason = errorMessage;
      if (err instanceof Error && err.stack) {
        job.stacktrace.push(err.stack);
      }

      const maxAttempts = job.opts.attempts || 1;
      if (job.attemptsMade < maxAttempts) {
        // Calculate backoff delay
        const backoffCfg = job.opts.backoff || { type: 'fixed', delay: 1000 };
        const delay =
          backoffCfg.type === 'exponential'
            ? backoffCfg.delay * Math.pow(2, job.attemptsMade - 1)
            : backoffCfg.delay;

        await job.log(`Job attempt ${job.attemptsMade} failed. Retrying in ${delay}ms...`);
        this.queue._requeue(job, delay);
      } else {
        job.state = 'failed';
        job.finishedOn = Date.now();
        this.emit('failed', job, err);
      }
    }
  }

  async close(): Promise<void> {
    this.isRunning = false;
    this.removeAllListeners();
  }
}
