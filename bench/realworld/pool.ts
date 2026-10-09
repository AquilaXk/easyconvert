/**
 * A pool of job-server child processes. Each child takes one job at a time; a job past its deadline kills its child
 * (verdict hang) and a child that dies during a job is a crash. Either way a fresh child replaces it, so one bad file
 * never poisons the jobs after it.
 */
import { fork, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import type { JobReply, JobRequest } from './child';
import { ocrPageBudgetMs } from '../../src/lib/conversions/ocr-work-budget';
import { isTypedRefusal, type Verdict } from './verdict';

const CHILD_SCRIPT = path.join(__dirname, 'child.ts');
const CHILD_START_TIMEOUT_MS = 120_000;

export interface PoolOptions {
  workers: number;
  deadlineMs: number;
  /** V8 heap cap of each child, in MiB. */
  heapMb: number;
  env: NodeJS.ProcessEnv;
}

/** Workers of a nightly shard: the 4-vCPU runner minus one (see `workers` in run.ts). */
export const NIGHTLY_WORKERS = 3;
/** Jobs that may hang at the longest deadline before they use up half of a shard's `timeout-minutes` (nightly.yml, job realworld). */
export const TOLERATED_HUNG_JOBS = 10;
const NIGHTLY_SHARD_TIMEOUT_MS = 60 * 60_000;

/**
 * Longest a single job may run whatever its size. The pool runs `NIGHTLY_WORKERS` jobs at a time, so
 * `TOLERATED_HUNG_JOBS` hung jobs hold it for TOLERATED_HUNG_JOBS x cap / NIGHTLY_WORKERS, and that is kept to half of
 * the shard timeout (30 min -> 9 min per job): a shard that is cancelled loses its report, and with it the hangs.
 */
export const MAX_JOB_DEADLINE_MS = (NIGHTLY_SHARD_TIMEOUT_MS / 2 * NIGHTLY_WORKERS) / TOLERATED_HUNG_JOBS;

/**
 * The deadline of a job on a file that is read by OCR, of `pages` pages (0 for any other file): the base deadline plus
 * the page budget the converter itself allows each page (src/lib/conversions/ocr-work-budget.ts), so a long scan that is
 * still being read is not reported as hung while the converter's own limits (a typed 413) are what bound it. A file
 * that is not read by OCR keeps the base deadline: its work is bounded by the parser deadline, not by pages.
 */
export function scaledDeadlineMs(baseMs: number, pages: number): number {
  return Math.max(baseMs, Math.min(MAX_JOB_DEADLINE_MS, baseMs + pages * ocrPageBudgetMs()));
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

/** Kills the child and everything it started (it leads its own process group), so no converter outlives its job. */
function killTree(child: ChildProcess): void {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    child.kill('SIGKILL');
  }
}

interface Slot {
  child: ChildProcess;
  busy: boolean;
}

function spawnChild(options: PoolOptions): Promise<ChildProcess> {
  const child = fork(CHILD_SCRIPT, [], {
    execArgv: ['--import', 'tsx', `--max-old-space-size=${options.heapMb}`],
    env: options.env,
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    detached: true,
  });
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
  return { verdict, ms: reply.ms, detail: `${reply.name}: ${reply.message}`, status: reply.facts.status };
}

export class JobPool {
  private readonly slots: Slot[] = [];
  private nextId = 1;

  private constructor(private readonly options: PoolOptions) {}

  static async start(options: PoolOptions): Promise<JobPool> {
    const pool = new JobPool(options);
    const children = await Promise.all(Array.from({ length: options.workers }, () => spawnChild(options)));
    for (const child of children) pool.slots.push({ child, busy: false });
    return pool;
  }

  private async replace(slot: Slot): Promise<void> {
    slot.child.removeAllListeners();
    killTree(slot.child);
    slot.child = await spawnChild(this.options);
  }

  private runOn(slot: Slot, job: PoolJob): Promise<JobOutcome> {
    const { deadlineMs = this.options.deadlineMs, ...request } = job;
    const id = this.nextId++;
    const started = performance.now();
    return new Promise((resolve) => {
      const finish = (outcome: JobOutcome, broken: boolean): void => {
        clearTimeout(timer);
        slot.child.removeListener('message', onMessage);
        slot.child.removeListener('exit', onExit);
        const done = (): void => {
          slot.busy = false;
          resolve(outcome);
        };
        if (broken) void this.replace(slot).then(done, done);
        else done();
      };
      const onMessage = (reply: JobReply): void => {
        if (reply.id === id) finish(outcomeOf(reply), false);
      };
      const onExit = (code: number | null, signal: string | null): void => {
        finish({ verdict: 'crash', ms: performance.now() - started, detail: `job server died (code ${code}, signal ${signal})` }, true);
      };
      const timer = setTimeout(() => {
        finish({ verdict: 'hang', ms: performance.now() - started, detail: `no answer within ${deadlineMs} ms` }, true);
      }, deadlineMs);
      slot.child.on('message', onMessage);
      slot.child.once('exit', onExit);
      slot.child.send({ ...request, id });
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
    for (const slot of this.slots) {
      slot.child.removeAllListeners();
      killTree(slot.child);
    }
  }
}
