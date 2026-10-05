import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import Redis from 'ioredis';
import { redactSecrets, redactText, scrubError } from '../security/redact';

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

/** New queue job ID; graph job IDs use the same format. */
export function generateJobId(): string {
  return `job_${Date.now()}_${crypto.randomBytes(JOB_ID_RANDOM_BYTES).toString('hex')}`;
}

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
    const entry = `[${new Date().toISOString()}] ${redactText(row)}`;
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

let lastPriorityTime = 0;

export function getMonotonicPriorityTimestamp(): number {
  const now = Date.now();
  if (now > lastPriorityTime) {
    lastPriorityTime = now;
    return now;
  }
  lastPriorityTime += 1;
  return lastPriorityTime;
}

/**
 * Calculates priority score for waiting ZSET:
 * score = priorityRank * 1e12 + (timestamp % 1e12)
 * High priority jobs (priority 1 > 2 > 0/default 1000) have lower score and execute first.
 * Strict FIFO order is preserved within the same priority level.
 */
export function calculateJobPriorityScore(priority?: number, timestamp?: number): number {
  const ts = typeof timestamp === 'number' ? timestamp : getMonotonicPriorityTimestamp();
  const priorityRank = typeof priority === 'number' && priority > 0 ? priority : 1000;
  return priorityRank * 1e12 + (ts % 1e12);
}

export interface IQueueEngine<T = any, R = any> extends EventEmitter {
  readonly name: string;
  readonly isDistributed: boolean;
  add(name: string, data: T, opts?: JobOptions): Promise<Job<T, R>>;
  getJob(id: string): Promise<Job<T, R> | undefined>;
  getJobs(types: JobState[]): Promise<Job<T, R>[]>;
  getJobsByUser(userId: string, states?: JobState[], limit?: number, offset?: number): Promise<Job<T, R>[]>;
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
  pause(): void;
  close(): Promise<void>;
}

/**
 * Dead-letter record of a failed job. Everything in it is masked: the reason and stack traces may
 * quote a request, and the job data may hold credentials. Data that cannot be masked within the
 * redaction limits is left out rather than stored as it is.
 */
function buildDlqEntry<T, R>(job: Job<T, R>, reason: string): DlqEntry<T> {
  let data: T | undefined;
  try {
    data = redactSecrets(job.data);
  } catch {
    data = undefined;
  }
  return {
    jobId: job.id,
    name: job.name,
    data: data as T,
    failedReason: redactText(reason),
    attemptsMade: job.attemptsMade,
    timestamp: Date.now(),
    stacktrace: job.stacktrace.map(redactText),
  };
}

export class Queue<T = any, R = any> extends EventEmitter implements IQueueEngine<T, R> {
  readonly name: string;
  readonly isDistributed: boolean = false;
  private jobs = new Map<string, Job<T, R>>();
  private waitingIds: string[] = [];
  private delayedIds: string[] = [];
  private delayTimers = new Map<string, NodeJS.Timeout>();
  private userJobs = new Map<string, string[]>();
  private dlq: DlqEntry<T>[] = [];

  constructor(name: string) {
    super();
    this.name = name;
  }

  private insertWaitingId(id: string): void {
    const job = this.jobs.get(id);
    const score = job ? calculateJobPriorityScore(job.opts.priority, job.timestamp) : Infinity;
    let insertIdx = this.waitingIds.length;
    for (let i = 0; i < this.waitingIds.length; i++) {
      const otherJob = this.jobs.get(this.waitingIds[i]);
      const otherScore = otherJob ? calculateJobPriorityScore(otherJob.opts.priority, otherJob.timestamp) : Infinity;
      if (score < otherScore) {
        insertIdx = i;
        break;
      }
    }
    this.waitingIds.splice(insertIdx, 0, id);
  }

  async add(name: string, data: T, opts: JobOptions = {}): Promise<Job<T, R>> {
    const id = opts.jobId || generateJobId();
    const existing = this.jobs.get(id);
    if (existing) {
      return existing;
    }
    const timestamp = getMonotonicPriorityTimestamp();
    const job = new Job<T, R>(id, name, data, opts, this);
    job.timestamp = timestamp;
    this.jobs.set(id, job);

    const userId = (data as any)?.userId;
    if (userId && typeof userId === 'string') {
      const userList = this.userJobs.get(userId) || [];
      userList.push(id);
      this.userJobs.set(userId, userList);
    }

    if (opts.delay && opts.delay > 0) {
      this.delayedIds.push(id);
      const timer = setTimeout(() => {
        this.delayTimers.delete(id);
        const idx = this.delayedIds.indexOf(id);
        if (idx !== -1) {
          this.delayedIds.splice(idx, 1);
          job.state = 'waiting';
          this.insertWaitingId(id);
          this.emit('waiting', job);
        }
      }, opts.delay);
      this.delayTimers.set(id, timer);
    } else {
      this.insertWaitingId(id);
      this.emit('waiting', job);
    }

    return job;
  }

  async getJob(id: string): Promise<Job<T, R> | undefined> {
    return this.jobs.get(id);
  }

  async getJobs(types: JobState[]): Promise<Job<T, R>[]> {
    const result: Job<T, R>[] = [];
    if (types.includes('waiting')) {
      for (const id of this.waitingIds) {
        const job = this.jobs.get(id);
        if (job && job.state === 'waiting') {
          result.push(job);
        }
      }
    }
    for (const job of this.jobs.values()) {
      if (job.state !== 'waiting' && types.includes(job.state)) {
        result.push(job);
      }
    }
    return result;
  }

  private removeUserJob(id: string, userId?: string): void {
    if (!userId) return;
    const userList = this.userJobs.get(userId);
    if (userList) {
      const next = userList.filter((jid) => jid !== id);
      if (next.length === 0) {
        this.userJobs.delete(userId);
      } else {
        this.userJobs.set(userId, next);
      }
    }
  }

  async getJobsByUser(
    userId: string,
    states?: JobState[],
    limit: number = 50,
    offset: number = 0
  ): Promise<Job<T, R>[]> {
    const ids = this.userJobs.get(userId);
    if (!ids || ids.length === 0) {
      return [];
    }
    const validStates = states && states.length > 0 ? new Set(states) : null;
    const matching: Job<T, R>[] = [];
    const staleIds: string[] = [];
    for (let i = ids.length - 1; i >= 0; i--) {
      const job = this.jobs.get(ids[i]);
      if (!job) {
        staleIds.push(ids[i]);
        continue;
      }
      if (!validStates || validStates.has(job.state)) {
        matching.push(job);
      }
    }
    if (staleIds.length > 0) {
      const staleSet = new Set(staleIds);
      const remaining = ids.filter((id) => !staleSet.has(id));
      if (remaining.length === 0) {
        this.userJobs.delete(userId);
      } else {
        this.userJobs.set(userId, remaining);
      }
    }
    matching.sort((a, b) => b.timestamp - a.timestamp);
    return matching.slice(offset, offset + limit);
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
    while (this.waitingIds.length > 0) {
      const id = this.waitingIds.shift()!;
      const job = this.jobs.get(id);
      if (job && job.state === 'waiting') {
        return job;
      }
    }
    return undefined;
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
          this.insertWaitingId(job.id);
          this.emit('waiting', job);
        }
      }, delayMs);
      this.delayTimers.set(job.id, timer);
    } else {
      job.state = 'waiting';
      this.insertWaitingId(job.id);
      this.emit('waiting', job);
    }
    return true;
  }

  _onJobCompleted(job: Job<T, R>, _result: R): boolean {
    if (job.opts?.removeOnComplete === true) {
      this.jobs.delete(job.id);
      this.removeUserJob(job.id, (job.data as any)?.userId);
    } else if (typeof job.opts?.removeOnComplete === 'number') {
      const maxToKeep = job.opts.removeOnComplete;
      const completed = Array.from(this.jobs.values())
        .filter((j) => j.state === 'completed')
        .sort((a, b) => (b.finishedOn || 0) - (a.finishedOn || 0));
      for (let i = maxToKeep; i < completed.length; i++) {
        this.jobs.delete(completed[i].id);
        this.removeUserJob(completed[i].id, (completed[i].data as any)?.userId);
      }
    }
    return true;
  }

  _onJobFailed(job: Job<T, R>, _err: any): boolean {
    if (job.opts?.removeOnFail === true) {
      this.jobs.delete(job.id);
      this.removeUserJob(job.id, (job.data as any)?.userId);
    } else if (typeof job.opts?.removeOnFail === 'number') {
      const maxToKeep = job.opts.removeOnFail;
      const failed = Array.from(this.jobs.values())
        .filter((j) => j.state === 'failed')
        .sort((a, b) => (b.finishedOn || 0) - (a.finishedOn || 0));
      for (let i = maxToKeep; i < failed.length; i++) {
        this.jobs.delete(failed[i].id);
        this.removeUserJob(failed[i].id, (failed[i].data as any)?.userId);
      }
    }
    return true;
  }

  async clean(grace: number, limit: number, type: 'completed' | 'failed' | 'cancelled'): Promise<string[]> {
    const threshold = Date.now() - grace;
    const removed: string[] = [];

    for (const [id, job] of this.jobs.entries()) {
      if (removed.length >= limit) break;
      if (job.state === type && job.finishedOn && job.finishedOn <= threshold) {
        this.jobs.delete(id);
        const userId = (job.data as any)?.userId;
        if (userId) {
          const userList = this.userJobs.get(userId);
          if (userList) {
            this.userJobs.set(
              userId,
              userList.filter((jid) => jid !== id)
            );
          }
        }
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
    const entry = buildDlqEntry(job, reason);
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
  private queues: IQueueEngine<T, R>[];
  private processor: Processor<T, R>;
  private concurrency: number;
  private activeCount: number = 0;
  private isRunning: boolean = true;
  private pollingTimer?: NodeJS.Timeout;
  private stalledSweepTimer?: NodeJS.Timeout;
  private waitingListeners: Map<IQueueEngine<T, R>, () => void> = new Map();

  get queue(): IQueueEngine<T, R> {
    return this.queues[0];
  }

  constructor(
    queue: IQueueEngine<T, R> | IQueueEngine<T, R>[],
    processor: Processor<T, R>,
    opts: WorkerOptions = {}
  ) {
    super();
    const queueList = Array.isArray(queue) ? queue : [queue];
    if (queueList.length === 0) {
      throw new Error('Worker requires at least one queue to subscribe to');
    }
    this.queues = queueList;
    this.name = queueList[0].name;
    this.processor = processor;
    this.concurrency = opts.concurrency || 5;

    // Listen for new jobs arriving in any of the subscribed queues
    for (const q of this.queues) {
      const listener = () => {
        this.checkAndProcess();
      };
      q.on('waiting', listener);
      this.waitingListeners.set(q, listener);
    }

    // Start background interval polling if any queue is distributed across processes
    if (this.queues.some((q) => q.isDistributed)) {
      this.pollingTimer = setInterval(() => {
        this.checkAndProcess();
      }, 500);
      if (typeof this.pollingTimer.unref === 'function') {
        this.pollingTimer.unref();
      }
    }

    // Recover jobs whose worker process died mid-attempt (distributed engines only)
    if (this.queues.some((q) => q.isDistributed && Boolean(q._recoverStalledJobs))) {
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
          let poppedJob: Job<T, R> | undefined;
          let sourceQueue: IQueueEngine<T, R> | undefined;

          for (const q of this.queues) {
            try {
              if (q._popNextWaiting) {
                const j = await q._popNextWaiting();
                if (j) {
                  poppedJob = j;
                  sourceQueue = q;
                  break;
                }
              }
            } catch {
              continue;
            }
          }

          if (!poppedJob || !sourceQueue) break;

          this.activeCount++;
          void this.executeJob(poppedJob, sourceQueue)
            .catch((err) => {
              console.error(`[Worker:${this.name}] Unhandled executeJob error:`, err);
            })
            .finally(() => {
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

  private async executeJob(job: Job<T, R>, queue: IQueueEngine<T, R>): Promise<void> {
    // A cancel can land between the pop and this call; a cancelled job never starts an attempt.
    if (job.state === 'cancelled') {
      return;
    }
    job._beginAttempt();
    job.state = 'active';
    job.processedOn = Date.now();
    job.attemptsMade++;
    this.emit('active', job);

    const stopMonitoring = queue._monitorActiveJob ? queue._monitorActiveJob(job) : undefined;
    try {
      let result: R;
      try {
        result = await this.runAttempt(job);
      } catch (err: any) {
        // A cancelled or superseded attempt never retries, never reaches the DLQ, and never emits `failed`.
        if (isAttemptDiscarded(job)) {
          return;
        }
        await this.handleJobFailure(job, queue, err);
        return;
      }
      await this.completeJob(job, queue, result);
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

  private async completeJob(job: Job<T, R>, queue: IQueueEngine<T, R>, result: R): Promise<void> {
    // A cancel (or a takeover) that landed while the processor ran wins: nothing is recorded or emitted.
    if (isAttemptDiscarded(job)) {
      return;
    }
    if (queue._onJobCompleted) {
      const committed = await queue._onJobCompleted(job, result);
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
    if (!this.isRunning) {
      return;
    }
    const distributedQueues = this.queues.filter((q) => q.isDistributed && q._recoverStalledJobs);
    await Promise.all(
      distributedQueues.map(async (q) => {
        try {
          const failedJobs = await q._recoverStalledJobs!();
          for (const job of failedJobs) {
            this.emit('failed', job, new Error(STALLED_JOB_FAILURE_REASON));
          }
        } catch (err) {
          console.error(`[Worker:${this.name}] Stalled job sweep failed for queue ${q.name}:`, err);
        }
      })
    );
  }

  private async handleJobFailure(job: Job<T, R>, queue: IQueueEngine<T, R>, err: any): Promise<void> {
    // Mask the error itself so the failed event, console output and rethrows also show masked text.
    scrubError(err);
    const errorMessage = redactText(err instanceof Error ? err.message : String(err));
    job.failedReason = errorMessage;
    if (err instanceof Error && err.stack) {
      job.stacktrace.push(redactText(err.stack));
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
      if (queue._requeue) {
        await queue._requeue(job, delay);
      }
      return;
    }

    if (queue._onJobFailed) {
      const committed = await queue._onJobFailed(job, err);
      if (!committed) {
        return;
      }
    }
    if (isAttemptDiscarded(job)) {
      return;
    }
    job.state = 'failed';
    job.finishedOn = Date.now();
    if (queue.moveToDlq) {
      await queue.moveToDlq(job, errorMessage);
    }
    this.emit('failed', job, err);
  }

  pause(): void {
    this.isRunning = false;
    if (this.pollingTimer) {
      clearInterval(this.pollingTimer);
      this.pollingTimer = undefined;
    }
    if (this.stalledSweepTimer) {
      clearInterval(this.stalledSweepTimer);
      this.stalledSweepTimer = undefined;
    }
    for (const [q, listener] of this.waitingListeners.entries()) {
      q.removeListener('waiting', listener);
    }
    this.waitingListeners.clear();
  }

  async close(): Promise<void> {
    this.pause();
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

/** Key prefix of every queue engine key; graph state keys share it. */
export const DEFAULT_QUEUE_KEY_PREFIX = 'easyconvert:queue:';

export const ADD_JOB_LUA_SCRIPT = `
-- KEYS[1]: job hash key
-- KEYS[2]: waitingKey (ZSET)
-- KEYS[3]: delayedKey (ZSET)
-- KEYS[4]: userJobsKey (ZSET, or placeholder if none)
-- ARGV[1]: jobId
-- ARGV[2]: isDelayed ('1' or '0')
-- ARGV[3]: delayUntil timestamp in ms
-- ARGV[4]: priorityScore (score for waiting ZSET)
-- ARGV[5]: timestamp in ms (score for userJobsKey)
-- ARGV[6]: userId (empty string if none)
-- ARGV[7]: eventsChannel ({queue}:events)
-- ARGV[8]: jobEventsChannel ({queue}:job:{id}:events)
-- ARGV[9..N]: flat key-value pairs for HSET

if redis.call('EXISTS', KEYS[1]) == 1 then
  return { 0, redis.call('HGETALL', KEYS[1]) }
end

for i = 9, #ARGV, 2 do
  redis.call('HSET', KEYS[1], ARGV[i], ARGV[i + 1])
end

if ARGV[2] == '1' then
  redis.call('ZADD', KEYS[3], tonumber(ARGV[3]), ARGV[1])
else
  local t = redis.call('TYPE', KEYS[2])
  local typeName = (type(t) == 'table' and t.ok) or t
  if typeName == 'list' then
    local items = redis.call('LRANGE', KEYS[2], 0, -1)
    redis.call('DEL', KEYS[2])
    for idx, itemId in ipairs(items) do
      redis.call('ZADD', KEYS[2], 1000000000000000 + idx, itemId)
    end
  end
  redis.call('ZADD', KEYS[2], tonumber(ARGV[4]), ARGV[1])
  local waitingPayload = cjson.encode({ event = 'waiting', jobId = ARGV[1] })
  redis.call('PUBLISH', ARGV[7], waitingPayload)
  redis.call('PUBLISH', ARGV[8], waitingPayload)
end

if ARGV[6] ~= '' and KEYS[4] ~= '' then
  redis.call('ZADD', KEYS[4], tonumber(ARGV[5]), ARGV[1])
end

return { 1 }
`;

export const PROMOTE_DELAYED_JOBS_LUA_SCRIPT = `
-- KEYS[1]: delayedKey
-- KEYS[2]: waitingKey
-- KEYS[3]: jobPrefix (e.g. prefix:job:)
-- ARGV[1]: current timestamp in milliseconds
-- ARGV[2]: max batch size
-- ARGV[3]: eventsChannel (optional)
local due = redis.call('ZRANGEBYSCORE', KEYS[1], 0, ARGV[1], 'LIMIT', 0, tonumber(ARGV[2] or 50))
local promoted = {}

local t = redis.call('TYPE', KEYS[2])
local typeName = (type(t) == 'table' and t.ok) or t
if typeName == 'list' then
  local items = redis.call('LRANGE', KEYS[2], 0, -1)
  redis.call('DEL', KEYS[2])
  for _, itemId in ipairs(items) do
    local rawOpts = redis.call('HGET', KEYS[3] .. itemId, 'opts')
    local prioRank = 1000
    if rawOpts and rawOpts ~= '' then
      local ok, opts = pcall(cjson.decode, rawOpts)
      if ok and type(opts) == 'table' and tonumber(opts.priority) and tonumber(opts.priority) > 0 then
        prioRank = tonumber(opts.priority)
      end
    end
    local rawTs = redis.call('HGET', KEYS[3] .. itemId, 'timestamp')
    local ts = tonumber(rawTs) or tonumber(ARGV[1])
    local score = prioRank * 1000000000000 + (ts % 1000000000000)
    redis.call('ZADD', KEYS[2], score, itemId)
  end
end

if due and #due > 0 then
  for i, id in ipairs(due) do
    if redis.call('ZREM', KEYS[1], id) > 0 then
      local rawOpts = redis.call('HGET', KEYS[3] .. id, 'opts')
      local prioRank = 1000
      if rawOpts and rawOpts ~= '' then
        local ok, opts = pcall(cjson.decode, rawOpts)
        if ok and type(opts) == 'table' and tonumber(opts.priority) and tonumber(opts.priority) > 0 then
          prioRank = tonumber(opts.priority)
        end
      end
      local score = prioRank * 1000000000000 + (tonumber(ARGV[1]) % 1000000000000)
      redis.call('ZADD', KEYS[2], score, id)
      redis.call('HSET', KEYS[3] .. id, 'state', 'waiting')
      table.insert(promoted, id)
      if ARGV[3] and ARGV[3] ~= '' then
        local waitingPayload = cjson.encode({ event = 'waiting', jobId = id })
        redis.call('PUBLISH', ARGV[3], waitingPayload)
      end
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

-- Auto-migrate waitingKey from list to zset if needed
local t = redis.call('TYPE', KEYS[1])
local typeName = (type(t) == 'table' and t.ok) or t
if typeName == 'list' then
  local items = redis.call('LRANGE', KEYS[1], 0, -1)
  redis.call('DEL', KEYS[1])
  for _, itemId in ipairs(items) do
    local rawOpts = redis.call('HGET', KEYS[3] .. itemId, 'opts')
    local prioRank = 1000
    if rawOpts and rawOpts ~= '' then
      local ok, opts = pcall(cjson.decode, rawOpts)
      if ok and type(opts) == 'table' and tonumber(opts.priority) and tonumber(opts.priority) > 0 then
        prioRank = tonumber(opts.priority)
      end
    end
    local rawTs = redis.call('HGET', KEYS[3] .. itemId, 'timestamp')
    local ts = tonumber(rawTs) or tonumber(ARGV[1])
    local score = prioRank * 1000000000000 + (ts % 1000000000000)
    redis.call('ZADD', KEYS[1], score, itemId)
  end
end

while true do
  local popped = redis.call('ZPOPMIN', KEYS[1])
  if not popped or #popped == 0 then
    return false
  end
  local jobId = popped[1]
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
local t = redis.call('TYPE', KEYS[2])
local typeName = (type(t) == 'table' and t.ok) or t
if typeName == 'list' then
  redis.call('LREM', KEYS[2], 0, ARGV[1])
else
  redis.call('ZREM', KEYS[2], ARGV[1])
end
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
-- ARGV[7]: priorityScore (score for waiting ZSET)
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
  local t = redis.call('TYPE', KEYS[3])
  local typeName = (type(t) == 'table' and t.ok) or t
  if typeName == 'list' then
    local items = redis.call('LRANGE', KEYS[3], 0, -1)
    redis.call('DEL', KEYS[3])
    for idx, itemId in ipairs(items) do
      redis.call('ZADD', KEYS[3], 1000000000000000 + idx, itemId)
    end
  end
  local score = tonumber(ARGV[7]) or 1000000000000000
  redis.call('ZADD', KEYS[3], score, ARGV[1])
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

local t = redis.call('TYPE', KEYS[2])
local typeName = (type(t) == 'table' and t.ok) or t
if typeName == 'list' then
  local items = redis.call('LRANGE', KEYS[2], 0, -1)
  redis.call('DEL', KEYS[2])
  for _, itemId in ipairs(items) do
    redis.call('ZADD', KEYS[2], 1000000000000000, itemId)
  end
end

local activeIds = redis.call('SMEMBERS', KEYS[1])
for _, jobId in ipairs(activeIds) do
  if redis.call('EXISTS', KEYS[5] .. jobId) == 0 then
    local jobKey = KEYS[4] .. jobId
    redis.call('SREM', KEYS[1], jobId)
    if redis.call('HGET', jobKey, 'state') == 'active' then
      local attemptsMade = (tonumber(redis.call('HGET', jobKey, 'attemptsMade')) or 0) + 1
      local maxAttempts = 1
      local rawOpts = redis.call('HGET', jobKey, 'opts')
      local prioRank = 1000
      if rawOpts then
        local ok, opts = pcall(cjson.decode, rawOpts)
        if ok and type(opts) == 'table' then
          if tonumber(opts.attempts) and tonumber(opts.attempts) > 0 then
            maxAttempts = tonumber(opts.attempts)
          end
          if tonumber(opts.priority) and tonumber(opts.priority) > 0 then
            prioRank = tonumber(opts.priority)
          end
        end
      end
      -- The stalled attempt loses ownership: clearing its token fences any write it still tries.
      redis.call('HDEL', jobKey, 'attemptToken')
      if attemptsMade < maxAttempts then
        redis.call('HSET', jobKey, 'state', 'waiting', 'attemptsMade', attemptsMade, 'failedReason', ARGV[2])
        local rawTs = redis.call('HGET', jobKey, 'timestamp')
        local ts = tonumber(rawTs) or tonumber(ARGV[1])
        local score = prioRank * 1000000000000 + (ts % 1000000000000)
        redis.call('ZADD', KEYS[2], score, jobId)
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
  private keyPrefix: string = DEFAULT_QUEUE_KEY_PREFIX;
  private eventsChannel: string;
  private localRecentEvents = new Set<string>();
  /** Redis mode: attempts this process is running, so a remote cancel can abort their signal. */
  private localActiveJobs = new Map<string, Job<T, R>>();

  constructor(name: string, connectionOpts?: RedisConnectionOptions) {
    super();
    this.name = name;
    this.memoryFallback = new Queue<T, R>(name);
    this.keyPrefix = connectionOpts?.keyPrefix || DEFAULT_QUEUE_KEY_PREFIX;
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
      this.setupConnectionTracking(this.redisClient);
      if (this.redisConnected) {
        this.initPubSub();
      }
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
          this.setupConnectionTracking(this.redisClient);
          this.redisClient.connect().catch(() => {
            this.redisConnected = false;
          });
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
          this.setupConnectionTracking(this.redisClient);
          this.redisClient.connect().catch(() => {
            this.redisConnected = false;
          });
        } catch {
          this.redisConnected = false;
        }
      }
    }
  }

  getJobEventsChannel(id: string): string {
    return `${this.keyPrefix}${this.name}:job:${id}:events`;
  }

  getUserJobsKey(userId: string): string {
    return `${this.keyPrefix}{${this.name}}:user_jobs:${userId}`;
  }

  private setupConnectionTracking(client: Redis): void {
    const status = (client as any).status;
    if (typeof status === 'string') {
      this.redisConnected = status === 'ready' || status === 'connecting' || status === 'connect';
    } else {
      this.redisConnected = true;
    }

    if (typeof client.on === 'function') {
      client.on('ready', () => {
        this.redisConnected = true;
        this.initPubSub();
      });
      client.on('connect', () => {
        const s = (client as any).status;
        if (s === 'ready' || s === 'connect' || s === 'connecting') {
          this.redisConnected = true;
        }
      });
      client.on('close', () => {
        this.redisConnected = false;
      });
      client.on('end', () => {
        this.redisConnected = false;
      });
      client.on('error', (_err) => {
        const s = (client as any).status;
        if (s === 'close' || s === 'end') {
          this.redisConnected = false;
        }
      });
    }
  }

  private initPubSub(): void {
    if (!this.redisClient) return;
    try {
      if (typeof this.redisClient.duplicate === 'function') {
        if (!this.subClient) {
          this.subClient = this.redisClient.duplicate();
          this.subClient.subscribe(this.eventsChannel).catch(() => {});
          this.subClient.on('message', (_chan, msg) => {
            try {
              const payload = JSON.parse(msg);
              const eventKey = `${payload.event}:${payload.jobId}`;
              if (this.localRecentEvents.has(eventKey)) {
                return;
              }
              if (payload.event === 'waiting') {
                this.emit('waiting');
              } else if (payload.event === 'progress' && payload.jobId) {
                const localJob = this.localActiveJobs.get(payload.jobId);
                if (localJob) {
                  localJob.progress = Number(payload.progress || 0);
                  this.emit('progress', localJob, localJob.progress);
                } else {
                  this.emit('progress', { id: payload.jobId, progress: Number(payload.progress || 0), state: 'active' }, Number(payload.progress || 0));
                }
              } else if (payload.event === 'completed' && payload.jobId) {
                const localJob = this.localActiveJobs.get(payload.jobId);
                if (localJob) {
                  localJob.state = 'completed';
                  localJob.progress = 100;
                  localJob.returnvalue = payload.result;
                  this.emit('completed', localJob, payload.result);
                } else {
                  this.emit('completed', { id: payload.jobId, state: 'completed', progress: 100, returnvalue: payload.result }, payload.result);
                }
              } else if (payload.event === 'failed' && payload.jobId) {
                const localJob = this.localActiveJobs.get(payload.jobId);
                if (localJob) {
                  localJob.state = 'failed';
                  localJob.failedReason = payload.error;
                  this.emit('failed', localJob, payload.error);
                } else {
                  this.emit('failed', { id: payload.jobId, state: 'failed', failedReason: payload.error }, payload.error);
                }
              } else if (payload.event === 'cancelled' && typeof payload.jobId === 'string') {
                this.abortLocalActiveJob(payload.jobId, String(payload.reason ?? ''));
                this.emit(`telemetry:${payload.jobId}`, {
                  event: 'cancelled',
                  data: { jobId: payload.jobId, state: 'cancelled', error: payload.reason },
                });
              }
            } catch {}
          });
        }
      }
    } catch {
      // Gracefully skip pub/sub if duplicate is not supported (e.g. mock)
    }
  }

  private markLocalEvent(event: string, jobId?: string): void {
    if (!jobId) return;
    const key = `${event}:${jobId}`;
    this.localRecentEvents.add(key);
    setTimeout(() => {
      this.localRecentEvents.delete(key);
    }, 5000);
  }

  private async publishEvent(payload: Record<string, any>): Promise<void> {
    if (this.redisClient && this.redisConnected) {
      try {
        if (payload.event && payload.jobId) {
          this.markLocalEvent(payload.event, payload.jobId);
        }
        if (typeof this.redisClient.publish === 'function') {
          const serialized = JSON.stringify(payload);
          await this.redisClient.publish(this.eventsChannel, serialized);
          if (payload.jobId) {
            await this.redisClient.publish(this.getJobEventsChannel(payload.jobId), serialized);
          }
        }
      } catch {}
    }
  }

  get isConnected(): boolean {
    return Boolean(this.redisClient && this.redisConnected);
  }

  getRedisClient(): Redis | null {
    return this.redisClient;
  }

  setRedisClient(client: Redis | null): void {
    this.redisClient = client;
    if (client) {
      this.setupConnectionTracking(client);
      if (this.redisConnected) {
        this.initPubSub();
      }
    } else {
      this.redisConnected = false;
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
            await this.publishEvent({ event: 'progress', jobId: j.id, progress: j.progress });
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
      const id = opts.jobId || generateJobId();
      const userId = (data as any)?.userId ? String((data as any).userId) : '';
      const userJobsKey = userId ? this.getUserJobsKey(userId) : '';
      const now = getMonotonicPriorityTimestamp();
      const isDelayed = Boolean(opts.delay && opts.delay > 0);
      const delayUntil = isDelayed ? now + opts.delay! : 0;
      const priorityScore = calculateJobPriorityScore(opts.priority, now);

      if (typeof this.redisClient.eval === 'function') {
        const jobInstance = new Job<T, R>(id, name, data, opts, this, async (j) => {
          if (this.redisClient && this.redisConnected) {
            try {
              if (j._attemptToken) {
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
              await this.publishEvent({ event: 'progress', jobId: j.id, progress: j.progress });
            } catch {}
          }
        });

        const hash = this.jobToHash(jobInstance);
        const flatHash: string[] = [];
        for (const [k, v] of Object.entries(hash)) {
          flatHash.push(k, v);
        }

        const res = (await this.redisClient.eval(
          ADD_JOB_LUA_SCRIPT,
          4,
          this.getJobKey(id),
          this.waitingKey,
          this.delayedKey,
          userJobsKey || `${this.keyPrefix}{${this.name}}:user_jobs:none`,
          id,
          isDelayed ? '1' : '0',
          String(delayUntil),
          String(priorityScore),
          String(now),
          userId,
          this.eventsChannel,
          this.getJobEventsChannel(id),
          ...flatHash
        )) as [number, string[]?];

        if (Array.isArray(res) && res[0] === 0 && res[1]) {
          return this.hashToJob(flatHashToRecord(res[1]));
        }

        const job = this.hashToJob(hash);
        if (!isDelayed) {
          this.emit('waiting', job);
        }
        return job;
      } else {
        // Fallback for mock Redis without eval
        if (opts.jobId) {
          try {
            const existingRaw = await this.redisClient.hgetall(this.getJobKey(id));
            if (existingRaw && Object.keys(existingRaw).length > 0) {
              return this.hashToJob(existingRaw);
            }
          } catch {}
        }

        const job = new Job<T, R>(id, name, data, opts, this, async (j) => {
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
        });

        const hash = this.jobToHash(job);
        await this.redisClient.hset(this.getJobKey(id), hash);

        if (isDelayed) {
          if (typeof this.redisClient.zadd === 'function') {
            await this.redisClient.zadd(this.delayedKey, delayUntil, id);
          }
        } else {
          if (typeof this.redisClient.zadd === 'function') {
            await this.redisClient.zadd(this.waitingKey, priorityScore, id);
          } else if (typeof this.redisClient.rpush === 'function') {
            await this.redisClient.rpush(this.waitingKey, id);
          }
          await this.publishEvent({ event: 'waiting', jobId: id });
        }

        if (userId && typeof this.redisClient.zadd === 'function') {
          await this.redisClient.zadd(userJobsKey, now, id);
        }

        this.emit('waiting', job);
        return job;
      }
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
            let list: string[] = [];
            if (typeof this.redisClient.zrange === 'function') {
              try {
                list = await this.redisClient.zrange(this.waitingKey, 0, -1 as any);
              } catch {}
            }
            if ((!list || list.length === 0) && typeof this.redisClient.lrange === 'function') {
              try {
                const legacyList = await this.redisClient.lrange(this.waitingKey, 0, -1);
                if (legacyList && legacyList.length > 0) {
                  list = legacyList;
                }
              } catch {}
            }
            ids.push(...(list || []));
          } else if (type === 'delayed') {
            const list = await this.redisClient.zrange(this.delayedKey, 0, -1 as any);
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
        const getWaitingCount = async (): Promise<number> => {
          if (!this.redisClient) return 0;
          if (typeof this.redisClient.zcard === 'function') {
            try {
              const count = await this.redisClient.zcard(this.waitingKey);
              if (typeof count === 'number' && !Number.isNaN(count)) return count;
            } catch {}
          }
          if (typeof this.redisClient.llen === 'function') {
            try {
              const count = await this.redisClient.llen(this.waitingKey);
              if (typeof count === 'number' && !Number.isNaN(count)) return count;
            } catch {}
          }
          return 0;
        };

        const [waiting, active, completed, failed, delayed, cancelled] = await Promise.all([
          getWaitingCount(),
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

  async getJobsByUser(
    userId: string,
    states?: JobState[],
    limit: number = 50,
    offset: number = 0
  ): Promise<Job<T, R>[]> {
    if (this.redisClient && this.redisConnected) {
      try {
        const userKey = this.getUserJobsKey(userId);
        const allJobIds = await this.redisClient.zrevrange(userKey, 0, -1);
        if (!allJobIds || allJobIds.length === 0) {
          return [];
        }

        const matchedJobs: Job<T, R>[] = [];
        const staleJobIds: string[] = [];
        const batchSize = Math.max(50, limit + offset);

        for (let i = 0; i < allJobIds.length; i += batchSize) {
          const chunk = allJobIds.slice(i, i + batchSize);
          const chunkJobs = await Promise.all(chunk.map((id) => this.getJob(id)));
          for (let j = 0; j < chunk.length; j++) {
            const job = chunkJobs[j];
            if (!job) {
              staleJobIds.push(chunk[j]);
              continue;
            }
            if (!states || states.length === 0 || states.includes(job.state)) {
              matchedJobs.push(job);
            }
          }
          if (matchedJobs.length >= offset + limit && (!states || states.length === 0)) {
            break;
          }
        }

        if (staleJobIds.length > 0) {
          try {
            await this.redisClient.zrem(userKey, ...staleJobIds);
          } catch {}
        }

        return matchedJobs.slice(offset, offset + limit);
      } catch {
        return [];
      }
    }
    return this.memoryFallback.getJobsByUser(userId, states, limit, offset);
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
          if (finishedOn > 0 && finishedOn <= threshold) {
            await this.redisClient.srem(key, id);
            await this.redisClient.del(this.getJobKey(id));
            try {
              let userId = '';
              if (raw?.data) {
                const parsed = JSON.parse(raw.data);
                userId = parsed.userId || '';
              }
              if (userId) {
                await this.redisClient.zrem(this.getUserJobsKey(userId), id);
              }
            } catch {}
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
    }
    await this.publishEvent({ event: 'cancelled', jobId: id, reason });
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
        const entry = buildDlqEntry(job, reason);
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

  private async pruneStateJobs(stateKey: string, maxToKeep: number): Promise<void> {
    if (!this.redisClient || !this.redisConnected) return;
    try {
      const ids = await this.redisClient.smembers(stateKey);
      if (ids.length <= maxToKeep) return;
      const jobsWithTime: { id: string; finishedOn: number; userId?: string }[] = [];
      const records = await Promise.all(
        ids.map(async (id) => {
          if (!this.redisClient) return null;
          const raw = await this.redisClient.hmget(this.getJobKey(id), 'finishedOn', 'data');
          let userId: string | undefined;
          try {
            if (raw[1]) {
              const parsed = JSON.parse(raw[1]);
              userId = parsed.userId;
            }
          } catch {}
          return {
            id,
            finishedOn: Number(raw[0] || 0),
            userId,
          };
        })
      );
      for (const rec of records) {
        if (rec) jobsWithTime.push(rec);
      }
      jobsWithTime.sort((a, b) => b.finishedOn - a.finishedOn);
      const toRemove = jobsWithTime.slice(maxToKeep);
      await Promise.all(
        toRemove.map(async (item) => {
          if (!this.redisClient) return;
          await this.redisClient.srem(stateKey, item.id);
          await this.redisClient.del(this.getJobKey(item.id));
          if (item.userId) {
            try {
              await this.redisClient.zrem(this.getUserJobsKey(item.userId), item.id);
            } catch {}
          }
        })
      );
    } catch {}
  }

  async _requeue(job: Job<T, R>, delayMs: number = 0): Promise<boolean> {
    if (!this.redisClient || !this.redisConnected) {
      return this.memoryFallback._requeue(job, delayMs);
    }
    try {
      const now = Date.now();
      const priorityScore = calculateJobPriorityScore(job.opts?.priority, now);
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
        String(now),
        job._attemptToken ?? '',
        String(priorityScore)
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
      return this.memoryFallback._onJobCompleted(job, result);
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
          job.opts?.removeOnComplete === true ? '1' : '0',
          job._attemptToken ?? ''
        );
        if (Number(committed) !== 1) {
          console.warn(
            `[DistributedBullMQAdapter:${this.name}] Discarded completion of job ${job.id}: this attempt no longer owns it.`
          );
          return false;
        }
        await this.publishEvent({ event: 'completed', jobId: job.id, result });
        if (job.opts?.removeOnComplete === true) {
          const userId = (job.data as any)?.userId;
          if (userId) {
            try {
              await client.zrem(this.getUserJobsKey(userId), job.id);
            } catch {}
          }
        } else if (typeof job.opts?.removeOnComplete === 'number') {
          await this.pruneStateJobs(this.completedKey, job.opts.removeOnComplete);
        }
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
      return this.memoryFallback._onJobFailed(job, err);
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
        job.failedReason || redactText(String(err)),
        JSON.stringify(job.stacktrace || []),
        String(job.attemptsMade),
        job.opts?.removeOnFail === true ? '1' : '0',
        job._attemptToken ?? ''
      );
      if (Number(committed) !== 1) {
        console.warn(
          `[DistributedBullMQAdapter:${this.name}] Discarded failure of job ${job.id}: it is no longer active.`
        );
        return false;
      }
      await this.publishEvent({ event: 'failed', jobId: job.id, error: redactText(String(err)) });
      if (job.opts?.removeOnFail === true) {
        const userId = (job.data as any)?.userId;
        if (userId) {
          try {
            await this.redisClient.zrem(this.getUserJobsKey(userId), job.id);
          } catch {}
        }
      } else if (typeof job.opts?.removeOnFail === 'number') {
        await this.pruneStateJobs(this.failedKey, job.opts.removeOnFail);
      }
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
      await this.publishEvent({ event: 'failed', jobId: job.id, error: STALLED_JOB_FAILURE_REASON });
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

  const onTelemetry = (e: JobTelemetryEvent) => {
    onEvent(e);
  };

  queue.on('progress', onProgress);
  queue.on('completed', onCompleted);
  queue.on('failed', onFailed);
  queue.on('cancelled', onCancelled);
  (queue as any).on?.(`telemetry:${jobId}`, onTelemetry);

  return () => {
    queue.off('progress', onProgress);
    queue.off('completed', onCompleted);
    queue.off('failed', onFailed);
    queue.off('cancelled', onCancelled);
    (queue as any).off?.(`telemetry:${jobId}`, onTelemetry);
  };
}
