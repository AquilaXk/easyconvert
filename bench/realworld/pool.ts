/**
 * A pool of job-server child processes. Each child takes one job at a time; a job with no answer by its window (its deadline and the
 * answer grace) kills its child (verdict hang) and a child that dies during a job is a crash. Either way a fresh child replaces it, so one bad file
 * never poisons the jobs after it.
 */
import { execFileSync, fork, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import type { JobReply, JobRequest } from './child';
import { OCR_MAX_INFLIGHT_PAGES, OCR_PAGE_CONCURRENCY_ENV } from '../../src/lib/conversions/ocr-page-batch';
import { ONNX_MAX_HELPER_THREADS, ONNX_OCR_THREADS_ENV } from '../../src/lib/conversions/ocr-onnx-helper';
import { OCR_PAGE_BUDGET_ENV, ocrPageBudgetMs } from '../../src/lib/conversions/ocr-work-budget';
import { availableCpus } from '../../src/lib/workers/available-cpus';
import { crashDetail, isTypedRefusal, type Verdict } from './verdict';

const CHILD_SCRIPT = path.join(__dirname, 'child.ts');
const CHILD_START_TIMEOUT_MS = 120_000;
/**
 * Healthy jobs one child serves before replacement (`DEFAULT_MAX_JOBS_PER_WORKER`), bounding retained V8, pdf.js, libvips,
 * and allocator caches across multi-hundred-job corpus shards without noticeable spawn overhead.
 */
export const DEFAULT_MAX_JOBS_PER_WORKER = 25;

export interface PoolOptions {
  workers: number;
  /** The deadline the converter holds a job to (the job server gives it to the conversion as its job deadline). */
  deadlineMs: number;
  /** Time past the deadline that a job may take to answer; `ANSWER_GRACE_MS` when not set. */
  answerGraceMs?: number;
  /** V8 heap cap of each child, in MiB. */
  heapMb: number;
  env: NodeJS.ProcessEnv;
  /** Replace healthy workers after this many jobs (`DEFAULT_MAX_JOBS_PER_WORKER` when unset, `0` disables). */
  maxJobsPerWorker?: number;
}

/** Workers of a nightly shard: the 4-vCPU runner minus one (see `workers` in run.ts). */
export const NIGHTLY_WORKERS = 3;
/** Jobs that may hang at the longest deadline before they use up half of a shard's `timeout-minutes` (nightly.yml, job realworld). */
export const TOLERATED_HUNG_JOBS = 10;
const NIGHTLY_SHARD_TIMEOUT_MS = 60 * 60_000;

/**
 * Time a job may take to answer after the deadline the converter holds it to. The job server aborts the conversion 2 s before that deadline
 * (child.ts), and the conversion then kills the office suite, removes its directories and writes the typed refusal, so a job that runs to its
 * deadline answers close to it, and a parent that waits for the deadline alone reports that answer as a hang. Only an answer past this
 * grace is a hang: the converter broke the deadline it was given. Gotenberg waits at most 5 s for a killed process to be reaped (`reapTimeout`,
 * `pkg/modules/libreoffice/api/libreoffice.go`), and 10 s is twice that.
 */
export const ANSWER_GRACE_MS = 10_000;

/** How long the pool waits for the answer of a job held to `deadlineMs`. */
export function answerWindowMs(deadlineMs: number, graceMs: number = ANSWER_GRACE_MS): number {
  return deadlineMs + graceMs;
}

/**
 * Longest deadline a single job may have whatever its size. The pool runs `NIGHTLY_WORKERS` jobs at a time, so `TOLERATED_HUNG_JOBS` hung
 * jobs hold it for TOLERATED_HUNG_JOBS x window / NIGHTLY_WORKERS, and that is kept to half of the shard timeout (30 min -> 9 min per job,
 * of which the answer grace is the last 10 s): a shard that is cancelled loses its report, and with it the hangs.
 */
export const MAX_JOB_DEADLINE_MS = (NIGHTLY_SHARD_TIMEOUT_MS / 2 * NIGHTLY_WORKERS) / TOLERATED_HUNG_JOBS - ANSWER_GRACE_MS;

/**
 * The deadline of a job on a file that is read by OCR, of `pages` pages (0 for any other file): the base deadline plus
 * the page budget the converter itself allows each page (src/lib/conversions/ocr-work-budget.ts), so a long scan that is
 * still being read is not reported as hung while the converter's own limits (a typed 413) are what bound it. A file
 * that is not read by OCR keeps the base deadline: its work is bounded by the parser deadline, not by pages.
 */
export function scaledDeadlineMs(baseMs: number, pages: number, pageBudgetMs: number = ocrPageBudgetMs()): number {
  return Math.max(baseMs, Math.min(MAX_JOB_DEADLINE_MS, baseMs + pages * pageBudgetMs));
}

export function childOcrPageConcurrency(workers: number, cpus: number = availableCpus()): number {
  return Math.max(1, Math.floor(cpus / Math.max(1, workers)));
}

/**
 * Intra-op ONNX helper threads allotted to each job server so `workers` concurrent servers share `cpus` cores without
 * oversubscribing OpenMP/ORT thread pools (e.g. 1 thread per helper across 3 workers on a 4-vCPU runner).
 */
export function childOcrOnnxThreads(workers: number, cpus: number = availableCpus()): number {
  return Math.max(1, Math.min(ONNX_MAX_HELPER_THREADS, Math.floor(cpus / Math.max(1, workers))));
}

/**
 * The page budget of a job server (ocr-work-budget.ts). The converter's default is measured with a document's pages read up to
 * `OCR_MAX_INFLIGHT_PAGES` at a time and a page cut into bands; a job server that is given a share of the cores reads fewer at once
 * (`childOcrPageConcurrency`), so each page takes proportionally longer, and the same document would be refused by a limit that is
 * about the pace of a production worker and not about the document. The budget grows by the parallelism the server gives up, so a
 * file is refused only where it would be on a worker that has the cores.
 */
export function childOcrPageBudgetMs(workers: number, cpus: number = availableCpus(), baseMs: number = ocrPageBudgetMs()): number {
  return baseMs * Math.ceil(OCR_MAX_INFLIGHT_PAGES / childOcrPageConcurrency(workers, cpus));
}

/** A job the pool runs: what the job server needs, and optionally its own deadline in place of the pool's. */
export type PoolJob = Omit<JobRequest, 'id'> & { deadlineMs?: number };

export interface JobOutcome {
  verdict: Verdict;
  ms: number;
  bytes?: number;
  /** Error class name, or the reason a job crashed, hung or produced a bad output. */
  detail?: string;
  status?: number | null;
}

/**
 * The processes below `root` in a `ps -A -o pid=,ppid=` table, at any depth. The office suite runs in a process group of its own, which the
 * group of the job server does not reach, and a process whose parent has died is no longer below it: they are listed before the server is killed.
 */
export function descendantPids(root: number, table: string): number[] {
  const children = new Map<number, number[]>();
  for (const line of table.split('\n')) {
    const [pid, parent] = line.trim().split(/\s+/).map(Number);
    if (!Number.isInteger(pid) || !Number.isInteger(parent)) continue;
    children.set(parent, [...(children.get(parent) ?? []), pid]);
  }
  const found: number[] = [];
  for (let queue = [root]; queue.length > 0; ) {
    const next = (children.get(queue.shift()!) ?? []).filter((pid) => !found.includes(pid));
    found.push(...next);
    queue.push(...next);
  }
  return found;
}

function processesBelow(root: number): number[] {
  try {
    return descendantPids(root, execFileSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8', timeout: 10_000 }));
  } catch {
    return [];
  }
}

/** Kills the child and everything it started, in its own group or another, so no converter outlives its job. */
function killTree(child: ChildProcess): void {
  if (child.pid === undefined) return;
  const below = processesBelow(child.pid);
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    child.kill('SIGKILL');
  }
  for (const pid of below) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Already gone.
    }
  }
}

interface Slot {
  child: ChildProcess;
  busy: boolean;
  jobs: number;
  broken: boolean;
}

function positiveIntEnv(raw: string | undefined): string | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? String(parsed) : undefined;
}

/** The page budget the job servers of a pool work to: the caller's own setting, else the share of the cores each server has. */
function poolPageBudgetMs(options: PoolOptions): number {
  const override = Number(options.env[OCR_PAGE_BUDGET_ENV]);
  return Number.isInteger(override) && override > 0 ? override : childOcrPageBudgetMs(options.workers);
}

/**
 * Effective child environment overrides passed to each job server: valid positive integer caller overrides are preserved,
 * empty or invalid strings fall back to per-worker CPU shares, and OCR page budget scales proportionally.
 */
export function poolChildEnv(options: PoolOptions): NodeJS.ProcessEnv {
  return {
    ...options.env,
    [OCR_PAGE_CONCURRENCY_ENV]: positiveIntEnv(options.env[OCR_PAGE_CONCURRENCY_ENV]) ?? String(childOcrPageConcurrency(options.workers)),
    [ONNX_OCR_THREADS_ENV]: positiveIntEnv(options.env[ONNX_OCR_THREADS_ENV]) ?? String(childOcrOnnxThreads(options.workers)),
    [OCR_PAGE_BUDGET_ENV]: String(poolPageBudgetMs(options)),
  };
}

function spawnChild(options: PoolOptions, onSpawn?: (child: ChildProcess) => void): Promise<ChildProcess> {
  const child = fork(CHILD_SCRIPT, [], {
    execArgv: ['--import', 'tsx', `--max-old-space-size=${options.heapMb}`],
    env: poolChildEnv(options),
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    detached: true,
  });
  onSpawn?.(child);
  child.stderr?.resume();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      killTree(child);
      reject(new Error('corpus job server did not start'));
    }, CHILD_START_TIMEOUT_MS);
    child.once('message', () => {
      clearTimeout(timer);
      resolve(child);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`corpus job server exited during start-up with code ${code}`));
    });
  });
}

function outcomeOf(reply: JobReply): JobOutcome {
  if (reply.kind === 'ok') return { verdict: 'ok', ms: reply.ms, bytes: reply.bytes };
  if (reply.kind === 'bad-output') return { verdict: 'bad-output', ms: reply.ms, bytes: reply.bytes, detail: reply.reason };
  const verdict: Verdict = isTypedRefusal(reply.facts) ? 'refused' : 'crash';
  return { verdict, ms: reply.ms, detail: crashDetail(reply.name, reply.message, reply.exit), status: reply.facts.status };
}

export class JobPool {
  private readonly slots: Slot[] = [];
  private readonly spawning = new Set<ChildProcess>();
  private readonly activeAbort = new Set<() => void>();
  private stopped = false;
  private nextId = 1;

  private constructor(private readonly options: PoolOptions) {}

  /** The page budget of the job servers, for the deadline of a job that is read by OCR. */
  get ocrPageBudgetMs(): number {
    return poolPageBudgetMs(this.options);
  }

  /** OS process IDs of the currently active job-server children. */
  get workerPids(): number[] {
    return this.slots
      .filter((slot) => !slot.broken && slot.child.exitCode === null && slot.child.signalCode === null)
      .map((slot) => slot.child.pid)
      .filter((pid): pid is number => pid !== undefined);
  }

  private async spawnSlotChild(): Promise<ChildProcess> {
    let spawned: ChildProcess | undefined;
    try {
      const child = await spawnChild(this.options, (c) => {
        spawned = c;
        this.spawning.add(c);
        if (this.stopped) killTree(c);
      });
      if (this.stopped) {
        killTree(child);
        throw new Error('job pool stopped during child start-up');
      }
      return child;
    } finally {
      if (spawned) this.spawning.delete(spawned);
    }
  }

  static async start(options: PoolOptions): Promise<JobPool> {
    const pool = new JobPool(options);
    const ready: ChildProcess[] = [];
    try {
      const children = await Promise.all(
        Array.from({ length: options.workers }, async () => {
          const child = await pool.spawnSlotChild();
          ready.push(child);
          return child;
        })
      );
      for (const child of children) pool.slots.push({ child, busy: false, jobs: 0, broken: false });
      return pool;
    } catch (err) {
      pool.stopped = true;
      for (const child of ready) killTree(child);
      for (const child of pool.spawning) killTree(child);
      throw err;
    }
  }

  private async replace(slot: Slot): Promise<boolean> {
    slot.child.removeAllListeners();
    killTree(slot.child);
    slot.broken = true;
    slot.jobs = 0;
    for (let attempt = 0; attempt < 2; attempt++) {
      if (this.stopped) return false;
      try {
        slot.child = await this.spawnSlotChild();
        slot.broken = false;
        return true;
      } catch {
        if (this.stopped) return false;
      }
    }
    return false;
  }

  private async runOn(slot: Slot, job: PoolJob): Promise<JobOutcome> {
    const { deadlineMs = this.options.deadlineMs, ...request } = job;
    const started = performance.now();
    if (this.stopped) return { verdict: 'crash', ms: 0, detail: 'job pool stopped' };
    if (slot.broken || !slot.child.connected) {
      const recovered = await this.replace(slot);
      if (!recovered || this.stopped || !slot.child.connected) {
        slot.busy = false;
        return { verdict: 'crash', ms: performance.now() - started, detail: 'job server replacement failed' };
      }
    }
    const id = this.nextId++;
    const maxJobs = this.options.maxJobsPerWorker ?? DEFAULT_MAX_JOBS_PER_WORKER;
    return new Promise((resolve) => {
      let settled = false;
      const finish = (outcome: JobOutcome, broken: boolean): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.activeAbort.delete(abortOnStop);
        slot.child.removeListener('message', onMessage);
        slot.child.removeListener('exit', onExit);
        slot.jobs += 1;
        const recycle = !this.stopped && (broken || (maxJobs > 0 && slot.jobs >= maxJobs));
        const done = (): void => {
          slot.busy = false;
          resolve(outcome);
        };
        if (recycle) void this.replace(slot).then(done, done);
        else done();
      };
      const abortOnStop = (): void => {
        finish({ verdict: 'crash', ms: performance.now() - started, detail: 'job pool stopped' }, false);
      };
      const onMessage = (reply: JobReply): void => {
        if (reply.id === id) finish(outcomeOf(reply), false);
      };
      const onExit = (code: number | null, signal: string | null): void => {
        finish({ verdict: 'crash', ms: performance.now() - started, detail: `job server died (code ${code}, signal ${signal})` }, true);
      };
      const windowMs = answerWindowMs(deadlineMs, this.options.answerGraceMs);
      const timer = setTimeout(() => {
        finish({ verdict: 'hang', ms: performance.now() - started, detail: `no answer within ${windowMs} ms` }, true);
      }, windowMs);
      this.activeAbort.add(abortOnStop);
      slot.child.on('message', onMessage);
      slot.child.once('exit', onExit);
      try {
        slot.child.send({ ...request, deadlineMs, id });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        finish({ verdict: 'crash', ms: performance.now() - started, detail: `job server send failed: ${msg}` }, true);
      }
    });
  }

  /** Runs every request with at most `workers` in flight; outcomes come back in request order. */
  async runAll(requests: readonly PoolJob[], onDone?: (index: number, outcome: JobOutcome) => void): Promise<JobOutcome[]> {
    const outcomes = new Array<JobOutcome>(requests.length);
    let next = 0;
    await Promise.all(
      this.slots.map(async (slot) => {
        while (next < requests.length) {
          const index = next++;
          slot.busy = true;
          outcomes[index] = await this.runOn(slot, requests[index]);
          onDone?.(index, outcomes[index]);
        }
      })
    );
    return outcomes;
  }

  stop(): void {
    this.stopped = true;
    for (const abort of [...this.activeAbort]) abort();
    for (const child of this.spawning) killTree(child);
    for (const slot of this.slots) {
      slot.broken = true;
      slot.child.removeAllListeners();
      killTree(slot.child);
    }
  }
}
