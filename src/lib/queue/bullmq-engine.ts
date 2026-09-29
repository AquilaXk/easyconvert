import { EventEmitter } from 'events';
import crypto from 'crypto';
import Redis from 'ioredis';

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
  private onUpdateHook?: (job: Job<T, R>) => Promise<void> | void;

  constructor(
    id: string,
    name: string,
    data: T,
    opts: JobOptions = {},
    emitter: EventEmitter,
    onUpdateHook?: (job: Job<T, R>) => Promise<void> | void
  ) {
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
    this.onUpdateHook = onUpdateHook;
    if (this.opts.delay && this.opts.delay > 0) {
      this.state = 'delayed';
    }
  }

  async updateProgress(progress: number): Promise<void> {
    this.progress = Math.max(0, Math.min(100, Math.round(progress)));
    this.emitter.emit('progress', this, this.progress);
    if (this.onUpdateHook) {
      try {
        await this.onUpdateHook(this);
      } catch {}
    }
  }

  async log(row: string): Promise<void> {
    const entry = `[${new Date().toISOString()}] ${row}`;
    this.logs.push(entry);
    if (this.onUpdateHook) {
      try {
        await this.onUpdateHook(this);
      } catch {}
    }
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
  _popNextWaiting?(): Promise<Job<T, R> | undefined> | Job<T, R> | undefined;
  _requeue?(job: Job<T, R>, delayMs?: number): Promise<void> | void;
  _onJobCompleted?(job: Job<T, R>, result: R): Promise<void> | void;
  _onJobFailed?(job: Job<T, R>, err: any): Promise<void> | void;
  getDlqEntries?(): Promise<DlqEntry<T>[]>;
  moveToDlq?(job: Job<T, R>, reason: string): Promise<void>;
  purgeDlq?(): Promise<number>;
  cancelJob?(id: string, reason?: string): Promise<boolean>;
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

  async cancelJob(id: string, reason: string = 'Cancelled by user'): Promise<boolean> {
    const job = this.jobs.get(id);
    if (!job) return false;
    if (job.state === 'completed' || job.state === 'failed') return false;

    this.waitingIds = this.waitingIds.filter((wid) => wid !== id);
    this.delayedIds = this.delayedIds.filter((did) => did !== id);
    const timer = this.delayTimers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.delayTimers.delete(id);
    }

    job.state = 'failed';
    job.failedReason = reason;
    job.finishedOn = Date.now();
    await job.log(`Job cancelled: ${reason}`);
    this.emit('failed', job, new Error(reason));
    return true;
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
  private pollingTimer?: NodeJS.Timeout;

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

    // Start background interval polling if queue is distributed across processes
    if (this.queue.isDistributed) {
      this.pollingTimer = setInterval(() => {
        this.checkAndProcess();
      }, 500);
      if (typeof this.pollingTimer.unref === 'function') {
        this.pollingTimer.unref();
      }
    }

    // Start initial polling loop
    this.checkAndProcess();
  }

  private isProcessing: boolean = false;
  private hasPendingCheck: boolean = false;

  private async checkAndProcess(): Promise<void> {
    if (!this.isRunning) return;
    if (this.isProcessing) {
      this.hasPendingCheck = true;
      return;
    }
    this.isProcessing = true;

    try {
      do {
        this.hasPendingCheck = false;
        while (this.isRunning && this.activeCount < this.concurrency) {
          let job: Job<T, R> | undefined;
          try {
            job = this.queue._popNextWaiting ? await this.queue._popNextWaiting() : undefined;
          } catch {
            break;
          }
          if (!job) break;

          this.activeCount++;
          this.executeJob(job).finally(() => {
            this.activeCount--;
            this.checkAndProcess();
          });
        }
      } while (this.hasPendingCheck && this.isRunning && this.activeCount < this.concurrency);
    } finally {
      this.isProcessing = false;
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

      if (this.queue._onJobCompleted) {
        await this.queue._onJobCompleted(job, result);
      }

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
        await this.queue._requeue(job, delay);
      }
      return;
    }

    job.state = 'failed';
    job.finishedOn = Date.now();
    if (this.queue._onJobFailed) {
      await this.queue._onJobFailed(job, err);
    }
    if (this.queue.moveToDlq) {
      await this.queue.moveToDlq(job, errorMessage);
    }
    this.emit('failed', job, err);
  }

  async close(): Promise<void> {
    this.isRunning = false;
    if (this.pollingTimer) {
      clearInterval(this.pollingTimer);
      this.pollingTimer = undefined;
    }
    this.removeAllListeners();
  }
}

export interface RedisConnectionOptions {
  host?: string;
  port?: number;
  url?: string;
  password?: string;
  tls?: boolean;
  redisClient?: Redis;
  keyPrefix?: string;
}

export const PROMOTE_DELAYED_JOBS_LUA_SCRIPT = `
-- KEYS[1]: delayedKey
-- KEYS[2]: waitingKey
-- KEYS[3]: jobPrefix (e.g. prefix:job:)
-- ARGV[1]: current timestamp in milliseconds
-- ARGV[2]: max batch size
local due = redis.call('ZRANGEBYSCORE', KEYS[1], 0, ARGV[1], 'LIMIT', 0, tonumber(ARGV[2] or 50))
local promoted = {}
if due and #due > 0 then
  for i, id in ipairs(due) do
    if redis.call('ZREM', KEYS[1], id) > 0 then
      redis.call('RPUSH', KEYS[2], id)
      redis.call('HSET', KEYS[3] .. id, 'state', 'waiting')
      table.insert(promoted, id)
    end
  end
end
return #promoted
`;

/**
 * Distributed Queue Adapter for Redis/BullMQ clustering.
 * Provides authentic Redis cluster storage (Hashes, Lists, Sets, Sorted Sets, Pub/Sub)
 * and seamless, zero-config in-memory fallback for local development and testnets.
 */
export class DistributedBullMQAdapter<T = any, R = any> extends EventEmitter implements IQueueEngine<T, R> {
  readonly name: string;
  readonly isDistributed: boolean = true;
  private memoryFallback: Queue<T, R>;
  private redisClient: Redis | null = null;
  private subClient: Redis | null = null;
  private redisConnected: boolean = false;
  private keyPrefix: string = 'easyconvert:queue:';
  private eventsChannel: string;

  constructor(name: string, connectionOpts?: RedisConnectionOptions) {
    super();
    this.name = name;
    this.memoryFallback = new Queue<T, R>(name);
    this.keyPrefix = connectionOpts?.keyPrefix || 'easyconvert:queue:';
    this.eventsChannel = `${this.keyPrefix}${this.name}:events`;

    // Forward memory fallback events
    this.memoryFallback.on('waiting', (job) => this.emit('waiting', job));
    this.memoryFallback.on('completed', (job, result) => this.emit('completed', job, result));
    this.memoryFallback.on('failed', (job, err) => this.emit('failed', job, err));
    this.memoryFallback.on('progress', (job, progress) => this.emit('progress', job, progress));
    this.memoryFallback.on('dlq', (entry) => this.emit('dlq', entry));

    if (connectionOpts?.redisClient) {
      this.redisClient = connectionOpts.redisClient;
      this.redisConnected = true;
      this.initPubSub();
    } else {
      const host = connectionOpts?.host || process.env.REDIS_HOST;
      const url = connectionOpts?.url || process.env.REDIS_URL;
      const port =
        connectionOpts?.port || (process.env.REDIS_PORT ? parseInt(process.env.REDIS_PORT, 10) : 6379);

      if (url) {
        try {
          this.redisClient = new Redis(url, {
            lazyConnect: true,
            enableOfflineQueue: false,
            maxRetriesPerRequest: 1,
          });
          this.redisConnected = true;
          this.initPubSub();
        } catch {
          this.redisConnected = false;
        }
      } else if (host) {
        try {
          this.redisClient = new Redis({
            host,
            port,
            lazyConnect: true,
            enableOfflineQueue: false,
            maxRetriesPerRequest: 1,
          });
          this.redisConnected = true;
          this.initPubSub();
        } catch {
          this.redisConnected = false;
        }
      }
    }
  }

  private initPubSub(): void {
    if (!this.redisClient) return;
    try {
      if (typeof this.redisClient.duplicate === 'function') {
        this.subClient = this.redisClient.duplicate();
        this.subClient.subscribe(this.eventsChannel).catch(() => {});
        this.subClient.on('message', (_chan, msg) => {
          try {
            const payload = JSON.parse(msg);
            if (payload.event === 'waiting') {
              this.emit('waiting');
            }
          } catch {}
        });
      }
    } catch {
      // Gracefully skip pub/sub if duplicate is not supported (e.g. mock)
    }
  }

  private async publishEvent(payload: Record<string, any>): Promise<void> {
    if (this.redisClient && this.redisConnected) {
      try {
        if (typeof this.redisClient.publish === 'function') {
          await this.redisClient.publish(this.eventsChannel, JSON.stringify(payload));
        }
      } catch {}
    }
  }

  get isConnected(): boolean {
    return this.redisConnected;
  }

  getRedisClient(): Redis | null {
    return this.redisClient;
  }

  setRedisClient(client: Redis | null): void {
    this.redisClient = client;
    this.redisConnected = Boolean(client);
    if (client) {
      this.initPubSub();
    }
  }

  private getJobKey(id: string): string {
    return `${this.keyPrefix}${this.name}:job:${id}`;
  }

  private get waitingKey(): string {
    return `${this.keyPrefix}${this.name}:waiting`;
  }

  private get activeKey(): string {
    return `${this.keyPrefix}${this.name}:active`;
  }

  private get completedKey(): string {
    return `${this.keyPrefix}${this.name}:completed`;
  }

  private get failedKey(): string {
    return `${this.keyPrefix}${this.name}:failed`;
  }

  private get delayedKey(): string {
    return `${this.keyPrefix}${this.name}:delayed`;
  }

  private get dlqKey(): string {
    return `${this.keyPrefix}${this.name}:dlq`;
  }

  private jobToHash(job: Job<T, R>): Record<string, string> {
    return {
      id: job.id,
      name: job.name,
      data: JSON.stringify(job.data ?? {}),
      opts: JSON.stringify(job.opts ?? {}),
      progress: String(job.progress),
      state: job.state,
      attemptsMade: String(job.attemptsMade),
      timestamp: String(job.timestamp),
      processedOn: job.processedOn ? String(job.processedOn) : '',
      finishedOn: job.finishedOn ? String(job.finishedOn) : '',
      returnvalue: job.returnvalue !== undefined ? JSON.stringify(job.returnvalue) : '',
      failedReason: job.failedReason || '',
      stacktrace: JSON.stringify(job.stacktrace || []),
      logs: JSON.stringify(job.logs || []),
    };
  }

  private hashToJob(raw: Record<string, string>): Job<T, R> {
    let parsedData: T = {} as T;
    try {
      parsedData = JSON.parse(raw.data || '{}');
    } catch {}

    let parsedOpts: JobOptions = {};
    try {
      parsedOpts = JSON.parse(raw.opts || '{}');
    } catch {}

    const job = new Job<T, R>(
      raw.id,
      raw.name || '',
      parsedData,
      parsedOpts,
      this,
      async (j) => {
        if (this.redisClient && this.redisConnected) {
          try {
            await this.redisClient.hset(
              this.getJobKey(j.id),
              'progress',
              String(j.progress),
              'logs',
              JSON.stringify(j.logs)
            );
          } catch {}
        }
      }
    );

    job.progress = Number(raw.progress || 0);
    job.state = (raw.state as JobState) || 'waiting';
    job.attemptsMade = Number(raw.attemptsMade || 0);
    job.timestamp = Number(raw.timestamp || Date.now());
    if (raw.processedOn) job.processedOn = Number(raw.processedOn);
    if (raw.finishedOn) job.finishedOn = Number(raw.finishedOn);
    if (raw.failedReason) job.failedReason = raw.failedReason;
    if (raw.returnvalue) {
      try {
        job.returnvalue = JSON.parse(raw.returnvalue);
      } catch {}
    }
    if (raw.stacktrace) {
      try {
        job.stacktrace = JSON.parse(raw.stacktrace);
      } catch {}
    }
    if (raw.logs) {
      try {
        job.logs = JSON.parse(raw.logs);
      } catch {}
    }
    return job;
  }

  async add(name: string, data: T, opts: JobOptions = {}): Promise<Job<T, R>> {
    if (this.redisClient && this.redisConnected) {
      const id = `job_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;
      const job = new Job<T, R>(
        id,
        name,
        data,
        opts,
        this,
        async (j) => {
          if (this.redisClient && this.redisConnected) {
            try {
              await this.redisClient.hset(
                this.getJobKey(j.id),
                'progress',
                String(j.progress),
                'logs',
                JSON.stringify(j.logs)
              );
            } catch {}
          }
        }
      );

      const hash = this.jobToHash(job);
      await this.redisClient.hset(this.getJobKey(id), hash);

      if (opts.delay && opts.delay > 0) {
        await this.redisClient.zadd(this.delayedKey, Date.now() + opts.delay, id);
      } else {
        await this.redisClient.rpush(this.waitingKey, id);
        await this.publishEvent({ event: 'waiting', jobId: id });
      }

      this.emit('waiting', job);
      return job;
    }
    return this.memoryFallback.add(name, data, opts);
  }

  async getJob(id: string): Promise<Job<T, R> | undefined> {
    if (this.redisClient && this.redisConnected) {
      try {
        const raw = await this.redisClient.hgetall(this.getJobKey(id));
        if (!raw || !raw.id) {
          return undefined;
        }
        return this.hashToJob(raw);
      } catch {
        return undefined;
      }
    }
    return this.memoryFallback.getJob(id);
  }

  async getJobs(types: JobState[]): Promise<Job<T, R>[]> {
    if (this.redisClient && this.redisConnected) {
      try {
        const ids: string[] = [];
        for (const type of types) {
          if (type === 'waiting') {
            const list = await this.redisClient.lrange(this.waitingKey, 0, -1);
            ids.push(...list);
          } else if (type === 'delayed') {
            const list = await this.redisClient.zrange(this.delayedKey, 0, '-1');
            ids.push(...list);
          } else if (type === 'active') {
            const set = await this.redisClient.smembers(this.activeKey);
            ids.push(...set);
          } else if (type === 'completed') {
            const set = await this.redisClient.smembers(this.completedKey);
            ids.push(...set);
          } else if (type === 'failed') {
            const set = await this.redisClient.smembers(this.failedKey);
            ids.push(...set);
          }
        }
        const uniqueIds = Array.from(new Set(ids));
        const jobs: Job<T, R>[] = [];
        for (const id of uniqueIds) {
          const j = await this.getJob(id);
          if (j) jobs.push(j);
        }
        return jobs;
      } catch {
        return [];
      }
    }
    return this.memoryFallback.getJobs(types);
  }

  async getJobCounts(): Promise<{
    waiting: number;
    active: number;
    completed: number;
    failed: number;
    delayed: number;
  }> {
    if (this.redisClient && this.redisConnected) {
      try {
        const [waiting, active, completed, failed, delayed] = await Promise.all([
          this.redisClient.llen(this.waitingKey),
          this.redisClient.scard(this.activeKey),
          this.redisClient.scard(this.completedKey),
          this.redisClient.scard(this.failedKey),
          this.redisClient.zcard(this.delayedKey),
        ]);
        return {
          waiting: waiting || 0,
          active: active || 0,
          completed: completed || 0,
          failed: failed || 0,
          delayed: delayed || 0,
        };
      } catch {
        return { waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0 };
      }
    }
    return this.memoryFallback.getJobCounts();
  }

  async clean(grace: number, limit: number, type: 'completed' | 'failed'): Promise<string[]> {
    if (this.redisClient && this.redisConnected) {
      try {
        const key = type === 'completed' ? this.completedKey : this.failedKey;
        const ids = await this.redisClient.smembers(key);
        const threshold = Date.now() - grace;
        const removed: string[] = [];
        for (const id of ids) {
          if (removed.length >= limit) break;
          const raw = await this.redisClient.hgetall(this.getJobKey(id));
          const finishedOn = Number(raw?.finishedOn || 0);
          if (finishedOn > 0 && finishedOn < threshold) {
            await this.redisClient.srem(key, id);
            await this.redisClient.del(this.getJobKey(id));
            removed.push(id);
          }
        }
        return removed;
      } catch {
        return [];
      }
    }
    return this.memoryFallback.clean(grace, limit, type);
  }

  async cancelJob(id: string, reason: string = 'Cancelled by user'): Promise<boolean> {
    if (this.redisClient && this.redisConnected) {
      try {
        const raw = await this.redisClient.hgetall(this.getJobKey(id));
        if (!raw || Object.keys(raw).length === 0) return false;
        const currentState = raw.state;
        if (currentState === 'completed' || currentState === 'failed') return false;

        await this.redisClient.lrem(this.waitingKey, 0, id);
        await this.redisClient.zrem(this.delayedKey, id);
        await this.redisClient.srem(this.activeKey, id);
        await this.redisClient.sadd(this.failedKey, id);

        await this.redisClient.hset(
          this.getJobKey(id),
          'state',
          'failed',
          'failedReason',
          reason,
          'finishedOn',
          Date.now().toString()
        );
        return true;
      } catch {
        return this.memoryFallback.cancelJob ? this.memoryFallback.cancelJob(id, reason) : false;
      }
    }
    return this.memoryFallback.cancelJob ? this.memoryFallback.cancelJob(id, reason) : false;
  }

  async getDlqEntries(): Promise<DlqEntry<T>[]> {
    if (this.redisClient && this.redisConnected) {
      try {
        const raws = await this.redisClient.lrange(this.dlqKey, 0, -1);
        return raws.map((r: string) => {
          try {
            return JSON.parse(r);
          } catch {
            return {
              jobId: '',
              name: '',
              data: {} as T,
              failedReason: r,
              attemptsMade: 0,
              timestamp: 0,
              stacktrace: [],
            };
          }
        });
      } catch {
        return [];
      }
    }
    return this.memoryFallback.getDlqEntries ? this.memoryFallback.getDlqEntries() : [];
  }

  async moveToDlq(job: Job<T, R>, reason: string): Promise<void> {
    if (this.redisClient && this.redisConnected) {
      try {
        const entry: DlqEntry<T> = {
          jobId: job.id,
          name: job.name,
          data: job.data,
          failedReason: reason,
          attemptsMade: job.attemptsMade,
          timestamp: Date.now(),
          stacktrace: [...job.stacktrace],
        };
        await this.redisClient.rpush(this.dlqKey, JSON.stringify(entry));
        this.emit('dlq', entry);
      } catch {}
      return;
    }
    if (this.memoryFallback.moveToDlq) {
      await this.memoryFallback.moveToDlq(job, reason);
    }
  }

  async purgeDlq(): Promise<number> {
    if (this.redisClient && this.redisConnected) {
      try {
        const count = await this.redisClient.llen(this.dlqKey);
        await this.redisClient.del(this.dlqKey);
        return count;
      } catch {
        return 0;
      }
    }
    return this.memoryFallback.purgeDlq ? this.memoryFallback.purgeDlq() : 0;
  }

  async ping(): Promise<{ ok: boolean; latencyMs: number }> {
    const start = Date.now();
    if (this.redisClient && this.redisConnected) {
      try {
        await this.redisClient.ping();
        return { ok: true, latencyMs: Date.now() - start };
      } catch {
        return { ok: false, latencyMs: Date.now() - start };
      }
    }
    return { ok: true, latencyMs: Date.now() - start };
  }

  async close(): Promise<void> {
    if (this.subClient) {
      try {
        await this.subClient.quit();
      } catch {}
      this.subClient = null;
    }
    if (this.redisClient) {
      try {
        await this.redisClient.quit();
      } catch {}
      this.redisClient = null;
    }
    this.redisConnected = false;
    await this.memoryFallback.close();
    this.removeAllListeners();
  }

  async _popNextWaiting(): Promise<Job<T, R> | undefined> {
    if (this.redisClient && this.redisConnected) {
      try {
        // 1. Promote due delayed jobs atomically
        const now = Date.now();
        try {
          await this.redisClient.eval(
            PROMOTE_DELAYED_JOBS_LUA_SCRIPT,
            3,
            this.delayedKey,
            this.waitingKey,
            `${this.keyPrefix}${this.name}:job:`,
            now.toString(),
            '50'
          );
        } catch {
          const dueDelayed = await this.redisClient.zrangebyscore(this.delayedKey, 0, now);
          if (dueDelayed && dueDelayed.length > 0) {
            for (const delayedId of dueDelayed) {
              const removed = await this.redisClient.zrem(this.delayedKey, delayedId);
              if (Number(removed) > 0) {
                await this.redisClient.rpush(this.waitingKey, delayedId);
                await this.redisClient.hset(this.getJobKey(delayedId), 'state', 'waiting');
              }
            }
          }
        }

        // 2. Pop next waiting job ID
        const jobId = await this.redisClient.lpop(this.waitingKey);
        if (!jobId) {
          return undefined;
        }

        // 3. Mark as active
        await this.redisClient.sadd(this.activeKey, jobId);
        const raw = await this.redisClient.hgetall(this.getJobKey(jobId));
        if (!raw || !raw.id) {
          await this.redisClient.srem(this.activeKey, jobId);
          return undefined;
        }

        await this.redisClient.hset(this.getJobKey(jobId), 'state', 'active');
        raw.state = 'active';
        return this.hashToJob(raw);
      } catch {
        return undefined;
      }
    }
    return this.memoryFallback._popNextWaiting();
  }

  async _requeue(job: Job<T, R>, delayMs: number = 0): Promise<void> {
    if (this.redisClient && this.redisConnected) {
      try {
        await this.redisClient.srem(this.activeKey, job.id);
        if (delayMs > 0) {
          await this.redisClient.zadd(this.delayedKey, Date.now() + delayMs, job.id);
          await this.redisClient.hset(
            this.getJobKey(job.id),
            'state',
            'delayed',
            'attemptsMade',
            String(job.attemptsMade),
            'failedReason',
            job.failedReason || ''
          );
        } else {
          await this.redisClient.rpush(this.waitingKey, job.id);
          await this.redisClient.hset(
            this.getJobKey(job.id),
            'state',
            'waiting',
            'attemptsMade',
            String(job.attemptsMade),
            'failedReason',
            job.failedReason || ''
          );
          await this.publishEvent({ event: 'waiting', jobId: job.id });
          this.emit('waiting', job);
        }
      } catch {}
      return;
    }
    this.memoryFallback._requeue(job, delayMs);
  }

  async _onJobCompleted(job: Job<T, R>, result: R): Promise<void> {
    if (this.redisClient && this.redisConnected) {
      try {
        await this.redisClient.srem(this.activeKey, job.id);
        if (job.opts?.removeOnComplete) {
          await this.redisClient.del(this.getJobKey(job.id));
        } else {
          await this.redisClient.sadd(this.completedKey, job.id);
          await this.redisClient.hset(
            this.getJobKey(job.id),
            'state',
            'completed',
            'finishedOn',
            String(job.finishedOn || Date.now()),
            'progress',
            '100',
            'returnvalue',
            JSON.stringify(result)
          );
        }
        await this.publishEvent({ event: 'completed', jobId: job.id, result });
      } catch {}
    }
  }

  async _onJobFailed(job: Job<T, R>, err: any): Promise<void> {
    if (this.redisClient && this.redisConnected) {
      try {
        await this.redisClient.srem(this.activeKey, job.id);
        if (job.opts?.removeOnFail) {
          await this.redisClient.del(this.getJobKey(job.id));
        } else {
          await this.redisClient.sadd(this.failedKey, job.id);
          await this.redisClient.hset(
            this.getJobKey(job.id),
            'state',
            'failed',
            'finishedOn',
            String(job.finishedOn || Date.now()),
            'failedReason',
            job.failedReason || String(err),
            'stacktrace',
            JSON.stringify(job.stacktrace || [])
          );
        }
        await this.publishEvent({ event: 'failed', jobId: job.id, error: String(err) });
      } catch {}
    }
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
    Boolean(process.env.REDIS_URL || process.env.REDIS_HOST || options?.redis?.redisClient);

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
