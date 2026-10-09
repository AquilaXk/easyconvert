/**
 * A pool of job-server child processes. Each child takes one job at a time; a job past its deadline kills its child
 * (verdict hang) and a child that dies during a job is a crash. Either way a fresh child replaces it, so one bad file
 * never poisons the jobs after it.
 */
import { fork, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import type { JobReply, JobRequest } from './child';
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
    for (let i = 0; i < options.workers; i++) pool.slots.push({ child: await spawnChild(options), busy: false });
    return pool;
  }

  private async replace(slot: Slot): Promise<void> {
    slot.child.removeAllListeners();
    killTree(slot.child);
    slot.child = await spawnChild(this.options);
  }

  private runOn(slot: Slot, request: Omit<JobRequest, 'id'>): Promise<JobOutcome> {
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
        finish({ verdict: 'hang', ms: performance.now() - started, detail: `no answer within ${this.options.deadlineMs} ms` }, true);
      }, this.options.deadlineMs);
      slot.child.on('message', onMessage);
      slot.child.once('exit', onExit);
      slot.child.send({ ...request, id });
    });
  }

  /** Runs every request with at most `workers` in flight; outcomes come back in request order. */
  async runAll(requests: readonly Omit<JobRequest, 'id'>[], onDone?: (index: number, outcome: JobOutcome) => void): Promise<JobOutcome[]> {
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
