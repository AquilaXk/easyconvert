import { type ChildProcess, spawn } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Side } from './ab-speed';
import type { ChildMessage, HostMessage } from './ab-protocol';
import { REPO_ROOT } from './config';
import { BenchError } from './errors';
import type { Family } from './report';

/**
 * The benchmark's side of the A/B comparison: the head and the base of the change each run in a node process of their own,
 * started in their checkout (its own tsconfig and node_modules, BENCH_PRODUCT_ROOT pointing at it), and time `ours`
 * on request (bench/ab-child.ts, bench/ab-protocol.ts). Requests are strictly one at a time, so only one of the head,
 * the base and the reference is working at any moment.
 */

export class AbHostError extends BenchError {}

/** A version cannot run the row; for the base the benchmark measures the row against the reference alone. */
export class BaseRowError extends AbHostError {}

export interface AbHostOptions {
  /** The checkout whose product the process measures: the head or the base of the change. */
  root: string;
  families: Family[];
  quick: boolean;
  /** A regression injected into this version (a test of the gate), passed to the process. */
  injection?: string | null;
  /** How long the process may take to end after it is told to, before it is killed. */
  stopGraceMs?: number;
  /** How long the process may take to say hello. */
  helloTimeoutMs?: number;
  /** The script the child runs; bench/ab-child.ts unless a test supplies its own. */
  script?: string;
  log?: (message: string) => void;
}

const HELLO_TIMEOUT_MS = 120_000;
const ROW_TIMEOUT_MS = 20 * 60_000;
/** How long a process may take to end after it is told to; then it is killed. */
const STOP_GRACE_MS = 10_000;

export class AbHost {
  private readonly queue: ChildMessage[] = [];
  private waiting: ((message: ChildMessage) => void) | null = null;
  private lost: string | null = null;
  private nextRow = 0;

  private constructor(
    private readonly child: ChildProcess,
    private readonly stopGraceMs: number
  ) {
    child.on('message', (message) => this.deliver(message as ChildMessage));
    child.on('exit', (code, signal) => this.fail(`the base process ended (${signal ?? `exit ${code}`})`));
    child.on('error', (error) => this.fail(`the base process could not run: ${error.message}`));
  }

  static async start(options: AbHostOptions): Promise<AbHost> {
    const script = options.script ?? path.join(REPO_ROOT, 'bench', 'ab-child.ts');
    // One process that runs the script itself (node with tsx's loader), so killing it ends the measuring: the tsx CLI is a wrapper that
    // starts the script in a second process, which a kill of the wrapper leaves running.
    const loader = pathToFileURL(path.join(path.dirname(require.resolve('tsx/package.json')), 'dist', 'loader.mjs')).href;
    const args = ['--import', loader, script, '--families', options.families.join(','), ...(options.quick ? ['--quick'] : []), ...(options.injection ? ['--inject-regression', options.injection] : [])];
    const child = spawn(process.execPath, args, {
      cwd: options.root,
      env: { ...process.env, BENCH_PRODUCT_ROOT: options.root },
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    });
    const host = new AbHost(child, options.stopGraceMs ?? STOP_GRACE_MS);
    try {
      const hello = await host.receive(options.helloTimeoutMs ?? HELLO_TIMEOUT_MS);
      if (hello.type !== 'hello') throw new AbHostError(`the process answered ${hello.type} instead of hello`);
    } catch (error) {
      // A process that did not say hello is not left running.
      await host.stop(true);
      throw error;
    }
    options.log?.(`${options.root} is measured by a process of its own`);
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

  /** Waits until the process asks for the time of the next row, which must be the row the benchmark is on (same number, same id). */
  async row(id: string): Promise<void> {
    const expected = this.nextRow++;
    const message = await this.receive(ROW_TIMEOUT_MS);
    if (message.type === 'crashed') throw new AbHostError(message.message);
    if (message.type !== 'ready' || message.row !== expected || message.id !== id) {
      throw new AbHostError(`the process is out of step: expected row ${expected} (${id}), got ${JSON.stringify(message)}`);
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

  /** The process id, for a test that the process is gone. */
  get pid(): number | undefined {
    return this.child.pid;
  }

  async stop(immediately = false): Promise<void> {
    if (immediately) this.child.kill('SIGKILL');
    else if (this.lost === null) {
      try {
        this.send({ type: 'exit' });
      } catch {
        // The process is gone already.
      }
    }
    await new Promise<void>((resolve) => {
      if (this.child.exitCode !== null || this.child.signalCode !== null) return resolve();
      const timer = setTimeout(() => this.child.kill('SIGKILL'), this.stopGraceMs);
      this.child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}
