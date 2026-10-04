import { EventEmitter } from 'events';
import crypto from 'node:crypto';
import Redis from 'ioredis';

export interface JobOptions {
  jobId?: string;
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

export type JobState = 'waiting' | 'active' | 'completed' | 'failed' | 'delayed' | 'cancelled';

export type JobCounts = Record<JobState, number>;

/** States from which a job can still be cancelled. */
export const CANCELLABLE_JOB_STATES: ReadonlySet<JobState> = new Set<JobState>(['waiting', 'delayed', 'active']);

/** States a job never leaves. */
export const TERMINAL_JOB_STATES: ReadonlySet<JobState> = new Set<JobState>(['completed', 'failed', 'cancelled']);

/** Redis mode: how often a worker refreshes the heartbeat of each job it is running. */
export const HEARTBEAT_INTERVAL_MS = 5000;

/** Redis mode: heartbeat key TTL. An active job whose heartbeat expired is treated as stalled. */
export const STALL_TIMEOUT_MS = 30000;

/** Redis mode: how often a worker sweeps the active set for stalled jobs. */
export const STALLED_SWEEP_INTERVAL_MS = 15000;

export const STALLED_JOB_FAILURE_REASON = 'Job stalled: worker heartbeat lost';

/** Redis mode: tries to record a completion before leaving the job to the stalled sweep. */
export const COMPLETION_COMMIT_MAX_ATTEMPTS = 3;

/** Redis mode: wait before the first completion retry; it doubles for every further retry. */
export const COMPLETION_COMMIT_RETRY_BASE_DELAY_MS = 100;

/** Abort reason for an attempt whose job was cancelled. Cancelled jobs never retry. */
export class JobCancelledError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'AbortError';
  }
}

/** Abort reason for an attempt that exceeded `JobOptions.timeout`. The attempt fails and may retry. */
export class JobTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`Job timed out after ${timeoutMs}ms`);
    this.name = 'TimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

/** Abort reason for an attempt that lost its job to another attempt (Redis mode, after stall recovery). */
export class JobOwnershipLostError extends Error {
  constructor(jobId: string) {
    super(`Attempt no longer owns job ${jobId}: another attempt took it over after a stall`);
    this.name = 'OwnershipLostError';
  }
}

/** Random bytes in a job id (128 bits); ids of anonymous jobs act as capability URLs. */
const JOB_ID_RANDOM_BYTES = 16;

/** Random bytes in a Redis attempt token, which fences writes from stale attempts. */
const ATTEMPT_TOKEN_BYTES = 16;

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

  /**
   * @internal Redis mode: token of the attempt that popped this job. Completion, failure, requeue,
   * heartbeat, and progress writes are accepted only while the job hash still holds this token.
   */
  _attemptToken?: string;

  private emitter: EventEmitter;
  private onUpdateHook?: (job: Job<T, R>) => Promise<void> | void;

  /**
   * Abort controller of the current processing attempt. The worker replaces it when each attempt
   * starts (`_beginAttempt`), so a timeout that aborted one attempt does not leak into its retry.
   */
  private attemptController = new AbortController();

  /**
   * Aborts when the job is cancelled or the current attempt exceeds `opts.timeout`. Each attempt has
   * its own signal; processors should read it once when the attempt starts and keep that reference.
   */
  get signal(): AbortSignal {
    return this.attemptController.signal;
  }

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

  /** True once the job was cancelled, either in this process or through the attempt's signal. */
  isCancelled(): boolean {
    return this.state === 'cancelled' || this.signal.reason instanceof JobCancelledError;
  }

  /** True once another attempt took this job over, so this attempt must not record anything. */
  hasLostOwnership(): boolean {
    return this.signal.reason instanceof JobOwnershipLostError;
  }

  /** @internal Starts a processing attempt with a fresh abort signal. Called by the worker. */
  _beginAttempt(): void {
    this.attemptController = new AbortController();
  }

  /** @internal Aborts the current attempt. The first reason wins. */
  _abortAttempt(reason: JobCancelledError | JobTimeoutError | JobOwnershipLostError): void {
    if (!this.attemptController.signal.aborted) {
      this.attemptController.abort(reason);
    }
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
  getJobCounts(): Promise<JobCounts>;
  clean(grace: number, limit: number, type: 'completed' | 'failed' | 'cancelled'): Promise<string[]>;
  close(): Promise<void>;
  _popNextWaiting?(): Promise<Job<T, R> | undefined> | Job<T, R> | undefined;
  /** Moves an active job back to waiting/delayed. Returns false when the job is no longer active. */
  _requeue?(job: Job<T, R>, delayMs?: number): Promise<boolean> | boolean;
  /** Records completion. Returns false when the job is no longer active (for example, it was cancelled). */
  _onJobCompleted?(job: Job<T, R>, result: R): Promise<boolean> | boolean;
  /** Records final failure. Returns false when the job is no longer active (for example, it was cancelled). */
  _onJobFailed?(job: Job<T, R>, err: any): Promise<boolean> | boolean;
  /** Supervises an attempt the worker just started (heartbeat, remote cancel). Returns a stop function. */
  _monitorActiveJob?(job: Job<T, R>): () => void;
  /** Recovers active jobs whose worker stopped heartbeating. Returns the jobs it moved to failed. */
  _recoverStalledJobs?(): Promise<Job<T, R>[]>;
  getDlqEntries?(): Promise<DlqEntry<T>[]>;
  moveToDlq?(job: Job<T, R>, reason: string): Promise<void>;
  purgeDlq?(): Promise<number>;
  /**
   * Cancels a waiting, delayed, or active job, emitting `cancelled` once. Returns false for
   * completed, failed, already cancelled, or unknown jobs.
   */
  cancelJob(id: string, reason?: string): Promise<boolean>;
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
    const id = opts.jobId || `job_${Date.now()}_${crypto.randomBytes(JOB_ID_RANDOM_BYTES).toString('hex')}`;
    const existing = this.jobs.get(id);
    if (existing) {
      return existing;
    }
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

  async getJobCounts(): Promise<JobCounts> {
    const counts: JobCounts = { waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0, cancelled: 0 };
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

  _requeue(job: Job<T, R>, delayMs: number = 0): boolean {
    // Only an attempt that is still active may be retried; a cancel during the failure path wins.
    if (job.state !== 'active') {
      return false;
    }
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
    return true;
  }

  async clean(grace: number, limit: number, type: 'completed' | 'failed' | 'cancelled'): Promise<string[]> {
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
    if (!job || !CANCELLABLE_JOB_STATES.has(job.state)) return false;

    // Every state change happens before the first await, so no worker step can interleave with it.
    const wasActive = job.state === 'active';
    this.waitingIds = this.waitingIds.filter((wid) => wid !== id);
    this.delayedIds = this.delayedIds.filter((did) => did !== id);
    const timer = this.delayTimers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.delayTimers.delete(id);
    }

    job.state = 'cancelled';
    job.failedReason = reason;
    job.finishedOn = Date.now();
    if (wasActive) {
      job._abortAttempt(new JobCancelledError(reason));
    }
    await job.log(`Job cancelled: ${reason}`);
    this.emit('cancelled', job);
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

/** An attempt whose job was cancelled or taken over by another attempt must not record anything. */
function isAttemptDiscarded(job: Job): boolean {
  return job.isCancelled() || job.hasLostOwnership();
}

export class Worker<T = any, R = any> extends EventEmitter implements IQueueWorker<T, R> {
  readonly name: string;
  private queue: IQueueEngine<T, R>;
  private processor: Processor<T, R>;
  private concurrency: number;
  private activeCount: number = 0;
  private isRunning: boolean = true;
  private pollingTimer?: NodeJS.Timeout;
  private stalledSweepTimer?: NodeJS.Timeout;

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

    // Recover jobs whose worker process died mid-attempt (distributed engines only)
    if (this.queue.isDistributed && this.queue._recoverStalledJobs) {
      this.stalledSweepTimer = setInterval(() => {
        void this.recoverStalledJobs();
      }, STALLED_SWEEP_INTERVAL_MS);
      if (typeof this.stalledSweepTimer.unref === 'function') {
        this.stalledSweepTimer.unref();
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
    // A cancel can land between the pop and this call; a cancelled job never starts an attempt.
    if (job.state === 'cancelled') {
      return;
    }
    job._beginAttempt();
    job.state = 'active';
    job.processedOn = Date.now();
    job.attemptsMade++;
    this.emit('active', job);

    const stopMonitoring = this.queue._monitorActiveJob ? this.queue._monitorActiveJob(job) : undefined;
    try {
      let result: R;
      try {
        result = await this.runAttempt(job);
      } catch (err: any) {
        // A cancelled or superseded attempt never retries, never reaches the DLQ, and never emits `failed`.
        if (isAttemptDiscarded(job)) {
          return;
        }
        await this.handleJobFailure(job, err);
        return;
      }
      await this.completeJob(job, result);
    } finally {
      stopMonitoring?.();
    }
  }

  /**
   * Runs the processor for one attempt. With `opts.timeout`, the attempt's signal is aborted with a
   * JobTimeoutError once the timeout elapses and the attempt fails even if the processor ignores it.
   */
  private async runAttempt(job: Job<T, R>): Promise<R> {
    const timeoutMs = job.opts.timeout;
    if (!timeoutMs || timeoutMs <= 0) {
      return this.processor(job);
    }

    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        const timeoutError = new JobTimeoutError(timeoutMs);
        job._abortAttempt(timeoutError);
        reject(timeoutError);
      }, timeoutMs);
    });
    try {
      return await Promise.race([this.processor(job), timedOut]);
    } finally {
      clearTimeout(timer);
    }
  }

  private async completeJob(job: Job<T, R>, result: R): Promise<void> {
    // A cancel (or a takeover) that landed while the processor ran wins: nothing is recorded or emitted.
    if (isAttemptDiscarded(job)) {
      return;
    }
    if (this.queue._onJobCompleted) {
      const committed = await this.queue._onJobCompleted(job, result);
      if (!committed) {
        return;
      }
    }
    // In-process engines share this job object, so a cancel can also land during the await above.
    if (isAttemptDiscarded(job)) {
      return;
    }
    job.returnvalue = result;
    job.state = 'completed';
    job.finishedOn = Date.now();
    job.progress = 100;
    this.emit('completed', job, result);
  }

  private async recoverStalledJobs(): Promise<void> {
    if (!this.isRunning || !this.queue._recoverStalledJobs) {
      return;
    }
    try {
      const failedJobs = await this.queue._recoverStalledJobs();
      for (const job of failedJobs) {
        this.emit('failed', job, new Error(STALLED_JOB_FAILURE_REASON));
      }
    } catch (err) {
      console.error(`[Worker:${this.name}] Stalled job sweep failed:`, err);
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
      // The engine refuses the requeue when the job stopped being active (for example, it was cancelled).
      if (this.queue._requeue) {
        await this.queue._requeue(job, delay);
      }
      return;
    }

    if (this.queue._onJobFailed) {
      const committed = await this.queue._onJobFailed(job, err);
      if (!committed) {
        return;
      }
    }
    if (isAttemptDiscarded(job)) {
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
    if (this.pollingTimer) {
      clearInterval(this.pollingTimer);
      this.pollingTimer = undefined;
    }
    if (this.stalledSweepTimer) {
      clearInterval(this.stalledSweepTimer);
      this.stalledSweepTimer = undefined;
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

export const POP_NEXT_WAITING_JOB_LUA_SCRIPT = `
-- KEYS[1]: waitingKey
-- KEYS[2]: activeKey
-- KEYS[3]: job key prefix (e.g. prefix:{queue}:job:)
-- KEYS[4]: heartbeat key prefix (e.g. prefix:{queue}:heartbeat:)
-- ARGV[1]: processedOn timestamp in milliseconds
-- ARGV[2]: heartbeat TTL in milliseconds
-- ARGV[3]: attempt token of the new attempt
-- Pops ids until one is still waiting, marks it active under the new attempt token, starts its
-- heartbeat, and returns its hash. Ids whose job is no longer waiting (cancelled, missing) are dropped.
while true do
  local jobId = redis.call('LPOP', KEYS[1])
  if not jobId then
    return false
  end
  local jobKey = KEYS[3] .. jobId
  if redis.call('HGET', jobKey, 'state') == 'waiting' then
    redis.call('SADD', KEYS[2], jobId)
    redis.call('HSET', jobKey, 'state', 'active', 'processedOn', ARGV[1], 'attemptToken', ARGV[3])
    redis.call('SET', KEYS[4] .. jobId, ARGV[1], 'PX', ARGV[2])
    return redis.call('HGETALL', jobKey)
  end
end
`;

export const CANCEL_JOB_LUA_SCRIPT = `
-- KEYS[1]: job hash key
-- KEYS[2]: waitingKey
-- KEYS[3]: delayedKey
-- KEYS[4]: activeKey
-- KEYS[5]: cancelledKey
-- KEYS[6]: heartbeat key
-- ARGV[1]: job id
-- ARGV[2]: cancellation reason
-- ARGV[3]: finishedOn timestamp in milliseconds
-- ARGV[4]: log line to append
-- Returns 0 unless the job is waiting, delayed, or active; otherwise { previousState, job hash }.
local state = redis.call('HGET', KEYS[1], 'state')
if state ~= 'waiting' and state ~= 'delayed' and state ~= 'active' then
  return 0
end
redis.call('LREM', KEYS[2], 0, ARGV[1])
redis.call('ZREM', KEYS[3], ARGV[1])
redis.call('SREM', KEYS[4], ARGV[1])
redis.call('DEL', KEYS[6])
redis.call('SADD', KEYS[5], ARGV[1])
local logs = {}
local rawLogs = redis.call('HGET', KEYS[1], 'logs')
if rawLogs and rawLogs ~= '' then
  local ok, decoded = pcall(cjson.decode, rawLogs)
  if ok and type(decoded) == 'table' then
    logs = decoded
  end
end
table.insert(logs, ARGV[4])
redis.call('HSET', KEYS[1], 'state', 'cancelled', 'failedReason', ARGV[2], 'finishedOn', ARGV[3], 'logs', cjson.encode(logs))
return { state, redis.call('HGETALL', KEYS[1]) }
`;

export const REQUEUE_JOB_LUA_SCRIPT = `
-- KEYS[1]: job hash key
-- KEYS[2]: activeKey
-- KEYS[3]: waitingKey
-- KEYS[4]: delayedKey
-- KEYS[5]: heartbeat key
-- ARGV[1]: job id
-- ARGV[2]: attemptsMade
-- ARGV[3]: failedReason of the attempt
-- ARGV[4]: retry delay in milliseconds
-- ARGV[5]: current timestamp in milliseconds
-- ARGV[6]: attempt token of the caller
-- Returns 1 after moving the job from active to waiting/delayed, or 0 when it is no longer active
-- or another attempt owns it.
if redis.call('HGET', KEYS[1], 'state') ~= 'active' or redis.call('HGET', KEYS[1], 'attemptToken') ~= ARGV[6] then
  return 0
end
redis.call('SREM', KEYS[2], ARGV[1])
redis.call('DEL', KEYS[5])
local delayMs = tonumber(ARGV[4])
if delayMs > 0 then
  redis.call('ZADD', KEYS[4], tonumber(ARGV[5]) + delayMs, ARGV[1])
  redis.call('HSET', KEYS[1], 'state', 'delayed', 'attemptsMade', ARGV[2], 'failedReason', ARGV[3])
else
  redis.call('RPUSH', KEYS[3], ARGV[1])
  redis.call('HSET', KEYS[1], 'state', 'waiting', 'attemptsMade', ARGV[2], 'failedReason', ARGV[3])
end
return 1
`;

export const COMPLETE_JOB_LUA_SCRIPT = `
-- KEYS[1]: job hash key
-- KEYS[2]: activeKey
-- KEYS[3]: completedKey
-- KEYS[4]: heartbeat key
-- ARGV[1]: job id
-- ARGV[2]: finishedOn timestamp in milliseconds
-- ARGV[3]: JSON return value ('' when undefined)
-- ARGV[4]: attemptsMade
-- ARGV[5]: '1' to delete the job hash (removeOnComplete)
-- ARGV[6]: attempt token of the caller
-- Returns 1 after moving the job from active to completed, or 0 when it is no longer active
-- or another attempt owns it. A retry by the attempt that already completed the job also
-- returns 1, so a commit whose reply was lost is not reported as refused.
local state = redis.call('HGET', KEYS[1], 'state')
local ownsAttempt = redis.call('HGET', KEYS[1], 'attemptToken') == ARGV[6]
if state == 'completed' and ownsAttempt then
  return 1
end
if state ~= 'active' or not ownsAttempt then
  return 0
end
redis.call('SREM', KEYS[2], ARGV[1])
redis.call('DEL', KEYS[4])
if ARGV[5] == '1' then
  redis.call('DEL', KEYS[1])
else
  redis.call('SADD', KEYS[3], ARGV[1])
  redis.call('HSET', KEYS[1], 'state', 'completed', 'finishedOn', ARGV[2], 'progress', '100', 'returnvalue', ARGV[3], 'attemptsMade', ARGV[4])
end
return 1
`;

export const FAIL_JOB_LUA_SCRIPT = `
-- KEYS[1]: job hash key
-- KEYS[2]: activeKey
-- KEYS[3]: failedKey
-- KEYS[4]: heartbeat key
-- ARGV[1]: job id
-- ARGV[2]: finishedOn timestamp in milliseconds
-- ARGV[3]: failedReason
-- ARGV[4]: JSON stacktrace
-- ARGV[5]: attemptsMade
-- ARGV[6]: '1' to delete the job hash (removeOnFail)
-- ARGV[7]: attempt token of the caller
-- Returns 1 after moving the job from active to failed, or 0 when it is no longer active
-- or another attempt owns it.
if redis.call('HGET', KEYS[1], 'state') ~= 'active' or redis.call('HGET', KEYS[1], 'attemptToken') ~= ARGV[7] then
  return 0
end
redis.call('SREM', KEYS[2], ARGV[1])
redis.call('DEL', KEYS[4])
if ARGV[6] == '1' then
  redis.call('DEL', KEYS[1])
else
  redis.call('SADD', KEYS[3], ARGV[1])
  redis.call('HSET', KEYS[1], 'state', 'failed', 'finishedOn', ARGV[2], 'failedReason', ARGV[3], 'stacktrace', ARGV[4], 'attemptsMade', ARGV[5])
end
return 1
`;

export const REFRESH_HEARTBEAT_LUA_SCRIPT = `
-- KEYS[1]: job hash key
-- KEYS[2]: heartbeat key
-- ARGV[1]: current timestamp in milliseconds
-- ARGV[2]: heartbeat TTL in milliseconds
-- ARGV[3]: attempt token of the caller
-- Returns { 'refreshed', '' } after refreshing the heartbeat of the caller's own active attempt,
-- { 'cancelled', failedReason } when the job was cancelled, or { 'lost', state } when the caller
-- no longer owns the job. Only the owning attempt refreshes the heartbeat.
local state = redis.call('HGET', KEYS[1], 'state')
if state == 'cancelled' then
  return { 'cancelled', redis.call('HGET', KEYS[1], 'failedReason') or '' }
end
if state ~= 'active' or redis.call('HGET', KEYS[1], 'attemptToken') ~= ARGV[3] then
  return { 'lost', state or '' }
end
redis.call('SET', KEYS[2], ARGV[1], 'PX', ARGV[2])
return { 'refreshed', '' }
`;

export const UPDATE_ATTEMPT_PROGRESS_LUA_SCRIPT = `
-- KEYS[1]: job hash key
-- ARGV[1]: attempt token of the caller
-- ARGV[2]: progress
-- ARGV[3]: JSON logs
-- Returns 1 after writing progress and logs for the owning active attempt, or 0 otherwise.
if redis.call('HGET', KEYS[1], 'state') ~= 'active' or redis.call('HGET', KEYS[1], 'attemptToken') ~= ARGV[1] then
  return 0
end
redis.call('HSET', KEYS[1], 'progress', ARGV[2], 'logs', ARGV[3])
return 1
`;

export const RECOVER_STALLED_JOBS_LUA_SCRIPT = `
-- KEYS[1]: activeKey
-- KEYS[2]: waitingKey
-- KEYS[3]: failedKey
-- KEYS[4]: job key prefix (e.g. prefix:{queue}:job:)
-- KEYS[5]: heartbeat key prefix (e.g. prefix:{queue}:heartbeat:)
-- ARGV[1]: current timestamp in milliseconds
-- ARGV[2]: stalled failure reason
-- Active jobs without a live heartbeat lost their worker. The stalled attempt counts as made:
-- the job returns to waiting while attempts remain, otherwise it fails.
-- Returns { requeued ids, failed ids }.
local requeued = {}
local failed = {}
local activeIds = redis.call('SMEMBERS', KEYS[1])
for _, jobId in ipairs(activeIds) do
  if redis.call('EXISTS', KEYS[5] .. jobId) == 0 then
    local jobKey = KEYS[4] .. jobId
    redis.call('SREM', KEYS[1], jobId)
    if redis.call('HGET', jobKey, 'state') == 'active' then
      local attemptsMade = (tonumber(redis.call('HGET', jobKey, 'attemptsMade')) or 0) + 1
      local maxAttempts = 1
      local rawOpts = redis.call('HGET', jobKey, 'opts')
      if rawOpts then
        local ok, opts = pcall(cjson.decode, rawOpts)
        if ok and type(opts) == 'table' and tonumber(opts.attempts) and tonumber(opts.attempts) > 0 then
          maxAttempts = tonumber(opts.attempts)
        end
      end
      -- The stalled attempt loses ownership: clearing its token fences any write it still tries.
      redis.call('HDEL', jobKey, 'attemptToken')
      if attemptsMade < maxAttempts then
        redis.call('HSET', jobKey, 'state', 'waiting', 'attemptsMade', attemptsMade, 'failedReason', ARGV[2])
        redis.call('RPUSH', KEYS[2], jobId)
        table.insert(requeued, jobId)
      else
        redis.call('HSET', jobKey, 'state', 'failed', 'attemptsMade', attemptsMade, 'failedReason', ARGV[2], 'finishedOn', ARGV[1])
        redis.call('SADD', KEYS[3], jobId)
        table.insert(failed, jobId)
      end
    end
  end
end
return { requeued, failed }
`;

/** Converts a flat HGETALL reply (field, value, field, value, ...) into a record. */
function flatHashToRecord(flat: string[]): Record<string, string> {
  const record: Record<string, string> = {};
  for (let i = 0; i + 1 < flat.length; i += 2) {
    record[flat[i]] = flat[i + 1];
  }
  return record;
}

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
  /** Redis mode: attempts this process is running, so a remote cancel can abort their signal. */
  private localActiveJobs = new Map<string, Job<T, R>>();

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
    this.memoryFallback.on('cancelled', (job) => this.emit('cancelled', job));
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
            } else if (payload.event === 'cancelled' && typeof payload.jobId === 'string') {
              // Abort only; the refund and the `cancelled` event belong to the process that cancelled.
              this.abortLocalActiveJob(payload.jobId, String(payload.reason ?? ''));
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
    return `${this.keyPrefix}{${this.name}}:job:${id}`;
  }

  private get waitingKey(): string {
    return `${this.keyPrefix}{${this.name}}:waiting`;
  }

  private get activeKey(): string {
    return `${this.keyPrefix}{${this.name}}:active`;
  }

  private get completedKey(): string {
    return `${this.keyPrefix}{${this.name}}:completed`;
  }

  private get failedKey(): string {
    return `${this.keyPrefix}{${this.name}}:failed`;
  }

  private get delayedKey(): string {
    return `${this.keyPrefix}{${this.name}}:delayed`;
  }

  private get dlqKey(): string {
    return `${this.keyPrefix}{${this.name}}:dlq`;
  }

  private get cancelledKey(): string {
    return `${this.keyPrefix}{${this.name}}:cancelled`;
  }

  private get jobKeyPrefix(): string {
    return `${this.keyPrefix}{${this.name}}:job:`;
  }

  private get heartbeatKeyPrefix(): string {
    return `${this.keyPrefix}{${this.name}}:heartbeat:`;
  }

  private getHeartbeatKey(id: string): string {
    return `${this.heartbeatKeyPrefix}${id}`;
  }

  /** Aborts the attempt this process is running for `jobId`, if any, as cancelled. */
  private abortLocalActiveJob(jobId: string, reason: string): void {
    const job = this.localActiveJobs.get(jobId);
    if (!job) {
      return;
    }
    job.state = 'cancelled';
    job.failedReason = reason;
    job._abortAttempt(new JobCancelledError(reason));
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
            if (j._attemptToken) {
              // A running attempt writes only while it still owns the job.
              await this.redisClient.eval(
                UPDATE_ATTEMPT_PROGRESS_LUA_SCRIPT,
                1,
                this.getJobKey(j.id),
                j._attemptToken,
                String(j.progress),
                JSON.stringify(j.logs)
              );
            } else {
              await this.redisClient.hset(
                this.getJobKey(j.id),
                'progress',
                String(j.progress),
                'logs',
                JSON.stringify(j.logs)
              );
            }
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
      const id = opts.jobId || `job_${Date.now()}_${crypto.randomBytes(JOB_ID_RANDOM_BYTES).toString('hex')}`;
      if (opts.jobId) {
        try {
          const existingRaw = await this.redisClient.hgetall(this.getJobKey(id));
          if (existingRaw && Object.keys(existingRaw).length > 0) {
            return this.hashToJob(existingRaw);
          }
        } catch {}
      }
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
          } else if (type === 'cancelled') {
            const set = await this.redisClient.smembers(this.cancelledKey);
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

  async getJobCounts(): Promise<JobCounts> {
    if (this.redisClient && this.redisConnected) {
      try {
        const [waiting, active, completed, failed, delayed, cancelled] = await Promise.all([
          this.redisClient.llen(this.waitingKey),
          this.redisClient.scard(this.activeKey),
          this.redisClient.scard(this.completedKey),
          this.redisClient.scard(this.failedKey),
          this.redisClient.zcard(this.delayedKey),
          this.redisClient.scard(this.cancelledKey),
        ]);
        return {
          waiting: waiting || 0,
          active: active || 0,
          completed: completed || 0,
          failed: failed || 0,
          delayed: delayed || 0,
          cancelled: cancelled || 0,
        };
      } catch {
        return { waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0, cancelled: 0 };
      }
    }
    return this.memoryFallback.getJobCounts();
  }

  async clean(grace: number, limit: number, type: 'completed' | 'failed' | 'cancelled'): Promise<string[]> {
    if (this.redisClient && this.redisConnected) {
      try {
        const setKeysByType = {
          completed: this.completedKey,
          failed: this.failedKey,
          cancelled: this.cancelledKey,
        };
        const key = setKeysByType[type];
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
    const client = this.redisClient;
    if (!client || !this.redisConnected) {
      return this.memoryFallback.cancelJob(id, reason);
    }

    // Fail closed: a Redis error propagates instead of reporting a cancel that did not happen.
    const finishedOn = Date.now();
    const logEntry = `[${new Date(finishedOn).toISOString()}] Job cancelled: ${reason}`;
    const outcome = await client.eval(
      CANCEL_JOB_LUA_SCRIPT,
      6,
      this.getJobKey(id),
      this.waitingKey,
      this.delayedKey,
      this.activeKey,
      this.cancelledKey,
      this.getHeartbeatKey(id),
      id,
      reason,
      String(finishedOn),
      logEntry
    );
    if (!Array.isArray(outcome)) {
      return false;
    }

    const [previousState, rawHash] = outcome as [string, string[]];
    if (previousState === 'active') {
      this.abortLocalActiveJob(id, reason);
      await this.publishEvent({ event: 'cancelled', jobId: id, reason });
    }
    this.emit('cancelled', this.hashToJob(flatHashToRecord(rawHash)));
    return true;
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
    this.localActiveJobs.clear();
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
            `${this.keyPrefix}{${this.name}}:job:`,
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

        // 2. Atomically pop the next waiting job, mark it active under a fresh attempt token,
        //    and start its heartbeat
        const attemptToken = crypto.randomBytes(ATTEMPT_TOKEN_BYTES).toString('hex');
        const popped = await this.redisClient.eval(
          POP_NEXT_WAITING_JOB_LUA_SCRIPT,
          4,
          this.waitingKey,
          this.activeKey,
          this.jobKeyPrefix,
          this.heartbeatKeyPrefix,
          String(now),
          String(STALL_TIMEOUT_MS),
          attemptToken
        );
        if (!Array.isArray(popped) || popped.length === 0) {
          return undefined;
        }
        const job = this.hashToJob(flatHashToRecord(popped as string[]));
        job._attemptToken = attemptToken;
        return job;
      } catch (err) {
        console.error(`[DistributedBullMQAdapter:${this.name}] Failed to pop the next waiting job:`, err);
        return undefined;
      }
    }
    return this.memoryFallback._popNextWaiting();
  }

  async _requeue(job: Job<T, R>, delayMs: number = 0): Promise<boolean> {
    if (!this.redisClient || !this.redisConnected) {
      return this.memoryFallback._requeue(job, delayMs);
    }
    try {
      const moved = await this.redisClient.eval(
        REQUEUE_JOB_LUA_SCRIPT,
        5,
        this.getJobKey(job.id),
        this.activeKey,
        this.waitingKey,
        this.delayedKey,
        this.getHeartbeatKey(job.id),
        job.id,
        String(job.attemptsMade),
        job.failedReason || '',
        String(Math.max(0, delayMs)),
        String(Date.now()),
        job._attemptToken ?? ''
      );
      if (Number(moved) !== 1) {
        return false;
      }
      if (delayMs <= 0) {
        await this.publishEvent({ event: 'waiting', jobId: job.id });
        this.emit('waiting', job);
      }
      return true;
    } catch (err) {
      // The job stays active without a heartbeat, so the stalled sweep will recover it.
      console.error(`[DistributedBullMQAdapter:${this.name}] Failed to requeue job ${job.id}:`, err);
      return false;
    }
  }

  async _onJobCompleted(job: Job<T, R>, result: R): Promise<boolean> {
    const client = this.redisClient;
    if (!client || !this.redisConnected) {
      // In-process fallback: the worker guards the shared job object itself.
      return true;
    }
    const finishedOn = String(job.finishedOn || Date.now());
    const returnValue = result === undefined ? '' : JSON.stringify(result);
    let lastError: unknown;
    for (let commitAttempt = 1; commitAttempt <= COMPLETION_COMMIT_MAX_ATTEMPTS; commitAttempt++) {
      if (commitAttempt > 1) {
        const delayMs = COMPLETION_COMMIT_RETRY_BASE_DELAY_MS * 2 ** (commitAttempt - 2);
        console.warn(
          `[DistributedBullMQAdapter:${this.name}] Retrying completion of job ${job.id} in ${delayMs}ms (${commitAttempt}/${COMPLETION_COMMIT_MAX_ATTEMPTS}):`,
          lastError
        );
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
      try {
        const committed = await client.eval(
          COMPLETE_JOB_LUA_SCRIPT,
          4,
          this.getJobKey(job.id),
          this.activeKey,
          this.completedKey,
          this.getHeartbeatKey(job.id),
          job.id,
          finishedOn,
          returnValue,
          String(job.attemptsMade),
          job.opts?.removeOnComplete ? '1' : '0',
          job._attemptToken ?? ''
        );
        if (Number(committed) !== 1) {
          console.warn(
            `[DistributedBullMQAdapter:${this.name}] Discarded completion of job ${job.id}: this attempt no longer owns it.`
          );
          return false;
        }
        await this.publishEvent({ event: 'completed', jobId: job.id, result });
        return true;
      } catch (err) {
        lastError = err;
      }
    }
    // The job stays active without a heartbeat, so the stalled sweep will run it again.
    console.error(
      `[DistributedBullMQAdapter:${this.name}] Failed to record completion of job ${job.id} after ${COMPLETION_COMMIT_MAX_ATTEMPTS} attempts:`,
      lastError
    );
    return false;
  }

  async _onJobFailed(job: Job<T, R>, err: any): Promise<boolean> {
    if (!this.redisClient || !this.redisConnected) {
      // In-process fallback: the worker guards the shared job object itself.
      return true;
    }
    try {
      const committed = await this.redisClient.eval(
        FAIL_JOB_LUA_SCRIPT,
        4,
        this.getJobKey(job.id),
        this.activeKey,
        this.failedKey,
        this.getHeartbeatKey(job.id),
        job.id,
        String(job.finishedOn || Date.now()),
        job.failedReason || String(err),
        JSON.stringify(job.stacktrace || []),
        String(job.attemptsMade),
        job.opts?.removeOnFail ? '1' : '0',
        job._attemptToken ?? ''
      );
      if (Number(committed) !== 1) {
        console.warn(
          `[DistributedBullMQAdapter:${this.name}] Discarded failure of job ${job.id}: it is no longer active.`
        );
        return false;
      }
      await this.publishEvent({ event: 'failed', jobId: job.id, error: String(err) });
      return true;
    } catch (redisErr) {
      // The job stays active without a heartbeat, so the stalled sweep will recover it.
      console.error(`[DistributedBullMQAdapter:${this.name}] Failed to record failure of job ${job.id}:`, redisErr);
      return false;
    }
  }

  /**
   * Redis mode: while the worker runs `job`, refreshes its heartbeat key every HEARTBEAT_INTERVAL_MS
   * and watches for a cancel from another process. Returns a function that stops the supervision.
   */
  _monitorActiveJob(job: Job<T, R>): () => void {
    if (!this.redisClient || !this.redisConnected) {
      // In-process fallback: cancelJob aborts the shared job object directly.
      return () => undefined;
    }
    this.localActiveJobs.set(job.id, job);
    const timer = setInterval(() => {
      void this.refreshHeartbeat(job);
    }, HEARTBEAT_INTERVAL_MS);
    if (typeof timer.unref === 'function') {
      timer.unref();
    }
    return () => {
      clearInterval(timer);
      if (this.localActiveJobs.get(job.id) === job) {
        this.localActiveJobs.delete(job.id);
      }
    };
  }

  /**
   * Refreshes the heartbeat of the attempt `job` belongs to. Aborts the attempt when the job was
   * cancelled elsewhere, or when another attempt took it over (the refresh is then refused).
   */
  private async refreshHeartbeat(job: Job<T, R>): Promise<void> {
    const client = this.redisClient;
    if (!client || !this.redisConnected) {
      return;
    }
    try {
      const reply = (await client.eval(
        REFRESH_HEARTBEAT_LUA_SCRIPT,
        2,
        this.getJobKey(job.id),
        this.getHeartbeatKey(job.id),
        String(Date.now()),
        String(STALL_TIMEOUT_MS),
        job._attemptToken ?? ''
      )) as [string, string];
      const [outcome, detail] = reply;
      if (outcome === 'cancelled') {
        this.abortLocalActiveJob(job.id, detail);
      } else if (outcome === 'lost') {
        console.warn(
          `[DistributedBullMQAdapter:${this.name}] Attempt of job ${job.id} lost ownership (job is now ${detail || 'missing'}); aborting it.`
        );
        job._abortAttempt(new JobOwnershipLostError(job.id));
      }
    } catch (err) {
      console.warn(`[DistributedBullMQAdapter:${this.name}] Heartbeat refresh failed for job ${job.id}:`, err);
    }
  }

  /**
   * Redis mode: moves active jobs whose heartbeat expired back to waiting, or to failed plus the DLQ
   * once their attempts are exhausted. Returns the jobs it failed so the worker can report them.
   */
  async _recoverStalledJobs(): Promise<Job<T, R>[]> {
    const client = this.redisClient;
    if (!client || !this.redisConnected) {
      return [];
    }
    const [requeuedIds, failedIds] = (await client.eval(
      RECOVER_STALLED_JOBS_LUA_SCRIPT,
      5,
      this.activeKey,
      this.waitingKey,
      this.failedKey,
      this.jobKeyPrefix,
      this.heartbeatKeyPrefix,
      String(Date.now()),
      STALLED_JOB_FAILURE_REASON
    )) as [string[], string[]];

    if (requeuedIds.length > 0) {
      console.warn(
        `[DistributedBullMQAdapter:${this.name}] Requeued stalled jobs: ${requeuedIds.join(', ')}`
      );
      await this.publishEvent({ event: 'waiting' });
      this.emit('waiting');
    }

    const failedJobs: Job<T, R>[] = [];
    for (const jobId of failedIds) {
      const job = await this.getJob(jobId);
      if (!job) {
        console.error(`[DistributedBullMQAdapter:${this.name}] Stalled job ${jobId} vanished before DLQ transfer.`);
        continue;
      }
      await this.moveToDlq(job, STALLED_JOB_FAILURE_REASON);
      failedJobs.push(job);
    }
    if (failedJobs.length > 0) {
      console.warn(
        `[DistributedBullMQAdapter:${this.name}] Failed stalled jobs with exhausted attempts: ${failedIds.join(', ')}`
      );
    }
    return failedJobs;
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
  event: 'progress' | 'completed' | 'failed' | 'cancelled' | 'log';
  data: any;
}

/** Telemetry events after which a job emits nothing more. */
export const TERMINAL_TELEMETRY_EVENTS: ReadonlySet<JobTelemetryEvent['event']> = new Set<JobTelemetryEvent['event']>([
  'completed',
  'failed',
  'cancelled',
]);

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
  const onCancelled = (job: Job) => {
    if (job.id === jobId) {
      onEvent({ event: 'cancelled', data: { jobId, state: 'cancelled', error: job.failedReason } });
    }
  };

  queue.on('progress', onProgress);
  queue.on('completed', onCompleted);
  queue.on('failed', onFailed);
  queue.on('cancelled', onCancelled);

  return () => {
    queue.off('progress', onProgress);
    queue.off('completed', onCompleted);
    queue.off('failed', onFailed);
    queue.off('cancelled', onCancelled);
  };
}
