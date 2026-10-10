import { type ChildProcess, spawn } from 'node:child_process';
import path from 'node:path';
import type { Side } from './ab-speed';
import type { ChildMessage, HostMessage } from './ab-protocol';
import { REPO_ROOT } from './config';
import { BenchError } from './errors';
import type { Family } from './report';

/**
 * The benchmark's side of the A/B comparison: the base of the change runs in a second node process, started in the
 * checkout of the base commit (its own tsconfig and node_modules, BENCH_PRODUCT_ROOT pointing at it), and times `ours`
 * on request (bench/ab-child.ts, bench/ab-protocol.ts). Requests are strictly one at a time, so only one of the head,
 * the base and the reference is working at any moment.
 */

export class AbHostError extends BenchError {}

/** The base cannot run the row; the benchmark measures the row against the reference alone. */
export class BaseRowError extends AbHostError {}

export interface AbHostOptions {
  /** Checkout of the base commit. */
  baseRoot: string;
  families: Family[];
  quick: boolean;
  /** The script the child runs; bench/ab-child.ts unless a test supplies its own. */
  script?: string;
  log?: (message: string) => void;
}

const HELLO_TIMEOUT_MS = 120_000;
const ROW_TIMEOUT_MS = 20 * 60_000;

export class AbHost {
  private readonly queue: ChildMessage[] = [];
  private waiting: ((message: ChildMessage) => void) | null = null;
  private lost: string | null = null;
  private nextRow = 0;

  private constructor(private readonly child: ChildProcess) {
    child.on('message', (message) => this.deliver(message as ChildMessage));
    child.on('exit', (code, signal) => this.fail(`the base process ended (${signal ?? `exit ${code}`})`));
    child.on('error', (error) => this.fail(`the base process could not run: ${error.message}`));
  }

  static async start(options: AbHostOptions): Promise<AbHost> {
    const script = options.script ?? path.join(REPO_ROOT, 'bench', 'ab-child.ts');
    const tsx = require.resolve('tsx/cli');
    const args = [tsx, script, '--families', options.families.join(','), ...(options.quick ? ['--quick'] : [])];
    const child = spawn(process.execPath, args, {
      cwd: options.baseRoot,
      env: { ...process.env, BENCH_PRODUCT_ROOT: options.baseRoot },
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    });
    const host = new AbHost(child);
    const hello = await host.receive(HELLO_TIMEOUT_MS);
    if (hello.type !== 'hello') throw new AbHostError(`the base process answered ${hello.type} instead of hello`);
    options.log?.(`the base of the change runs in its own process (${options.baseRoot})`);
    return host;
  }

  private deliver(message: ChildMessage): void {
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = null;
      resolve(message);
    } else this.queue.push(message);
  }

  private fail(reason: string): void {
    if (this.lost !== null) return;
    this.lost = reason;
    this.deliver({ type: 'crashed', message: reason });
  }

  private receive(timeoutMs: number): Promise<ChildMessage> {
    const queued = this.queue.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise<ChildMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting = null;
        reject(new AbHostError(`the base process did not answer in ${timeoutMs / 1000} s`));
      }, timeoutMs);
      this.waiting = (message) => {
        clearTimeout(timer);
        resolve(message);
      };
    });
  }

  private send(message: HostMessage): void {
    if (this.lost !== null) throw new AbHostError(this.lost);
    this.child.send(message);
  }

  /** Waits until the base process asks for the time of the next row, which must be the row the benchmark is on. */
  async row(): Promise<void> {
    const expected = this.nextRow++;
    const message = await this.receive(ROW_TIMEOUT_MS);
    if (message.type === 'crashed') throw new AbHostError(message.message);
    if (message.type !== 'ready' || message.row !== expected) {
      throw new AbHostError(`the base process is out of step: expected row ${expected}, got ${JSON.stringify(message)}`);
    }
  }

  /** The base as a side of a pair. */
  side(): Side {
    const ask = async (request: HostMessage): Promise<number> => {
      this.send(request);
      const message = await this.receive(ROW_TIMEOUT_MS);
      if (message.type === 'timed') return message.ms;
      if (message.type === 'failed') throw new BaseRowError(message.message);
      throw new AbHostError(message.type === 'crashed' ? message.message : `the base process answered ${message.type}`);
    };
    return { call: () => ask({ type: 'call' }), sample: (calls) => ask({ type: 'sample', calls }) };
  }

  /** Lets the base process go on to its next row. */
  next(): void {
    this.send({ type: 'next' });
  }

  async stop(): Promise<void> {
    if (this.lost === null) {
      try {
        this.send({ type: 'exit' });
      } catch {
        // The process is gone already.
      }
    }
    await new Promise<void>((resolve) => {
      if (this.child.exitCode !== null || this.child.signalCode !== null) return resolve();
      const timer = setTimeout(() => this.child.kill('SIGKILL'), 10_000);
      this.child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}
