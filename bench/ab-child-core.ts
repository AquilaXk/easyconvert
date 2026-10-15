/**
 * The process that measures a version of the change (bench/ab-child.ts is its entry), started by the
 * benchmark (bench/ab-host.ts) with the checkout of the base commit as its working directory and BENCH_PRODUCT_ROOT set
 * to it, so its product, tsconfig and node_modules are the base's own. It runs the family runners speed-only, answers
 * the benchmark's requests to time `ours` (bench/ab-protocol.ts), and discards the rows it produces itself.
 */
import { performance } from 'node:perf_hooks';
import type { ChildMessage, HostMessage } from './ab-protocol';
import type { AdaptiveTiming } from './speed-parity';
import { slowed, type TimerInit } from './speed-timing';

/** What a runner gets back for a row the benchmark times: a stub, since the child's rows are not used. */
const STUB_TIMING: AdaptiveTiming = {
  runs: 1,
  oursMs: [1],
  referenceMs: [1],
  oursMedianMs: 1,
  referenceMedianMs: 1,
  oursCv: 0,
  referenceCv: 0,
  repeats: { ours: 1, reference: 1 },
  decision: { verdict: 'pass', pairs: 1, median: 1, lower: null, upper: null, confidence: null, passLine: 0.97 },
  unstableAtCap: false,
};

export interface ChildOptions {
  families: string[];
  /** `slow-ours`: the version this process measures is slowed, as the benchmark slows its own side (a test of the gate). */
  slowOurs?: boolean;
}

/** The timer a family runner's context asks for the time of a row with (the `timer` of bench/speed-timing.ts). */
export type ChildTimer = NonNullable<TimerInit['timer']>;

/** What the process needs of the harness, which is the change's own and so passed in: the family runners, and the context they run with. */
export interface ChildDeps<Ctx> {
  runners: Readonly<Record<string, (ctx: Ctx) => Promise<unknown>>>;
  /** The context of a speed-only run with this timer, and what to do when the process is done with it. */
  makeContext: (timer: ChildTimer, log: (message: string) => void) => { ctx: Ctx; dispose: () => void };
}

/** The messages of the benchmark, in order, as an awaitable queue. */
function inbox(): () => Promise<HostMessage> {
  const queue: HostMessage[] = [];
  let waiting: ((message: HostMessage) => void) | null = null;
  process.on('message', (message) => {
    if (waiting) {
      const resolve = waiting;
      waiting = null;
      resolve(message as HostMessage);
    } else queue.push(message as HostMessage);
  });
  return () => {
    const next = queue.shift();
    if (next) return Promise.resolve(next);
    return new Promise<HostMessage>((resolve) => {
      waiting = resolve;
    });
  };
}

const send = (message: ChildMessage): void => {
  if (!process.send) throw new Error('ab-child must be started with an IPC channel');
  process.send(message);
};

export async function runChild<Ctx>(deps: ChildDeps<Ctx>, options: ChildOptions): Promise<void> {
  const receive = inbox();
  let rows = 0;
  const timer: ChildTimer = async (rowId, rawOurs) => {
    const ours = options.slowOurs ? slowed(rawOurs) : rawOurs;
    send({ type: 'ready', row: rows++, id: rowId });
    for (;;) {
      const message = await receive();
      if (message.type === 'next') return STUB_TIMING;
      if (message.type === 'exit') throw new Error('the benchmark ended while a row was being timed');
      try {
        const start = performance.now();
        const calls = message.type === 'sample' ? message.calls : 1;
        for (let call = 0; call < calls; call++) await ours();
        send({ type: 'timed', ms: (performance.now() - start) / calls });
      } catch (error) {
        send({ type: 'failed', message: error instanceof Error ? error.message : String(error) });
      }
    }
  };
  const { ctx, dispose } = deps.makeContext(timer, (message) => process.stderr.write(`  [base] ${message}\n`));
  try {
    send({ type: 'hello' });
    for (const family of options.families) await deps.runners[family](ctx);
    send({ type: 'finished', rows });
    for (;;) if ((await receive()).type === 'exit') break;
  } catch (error) {
    send({ type: 'crashed', message: error instanceof Error ? (error.stack ?? error.message) : String(error) });
    process.exitCode = 1;
  } finally {
    dispose();
  }
}

/** The options of a measuring process from its command line: `--families a,b [--quick] [--inject-regression slow-ours]`. */
export function parseChildArgs(args: string[], known: readonly string[]): ChildOptions & { quick: boolean } {
  const at = args.indexOf('--families');
  const names = at >= 0 ? args[at + 1].split(',') : [...known];
  const unknown = names.filter((name) => !known.includes(name));
  if (unknown.length > 0) throw new Error(`unknown family ${unknown.join(', ')}`);
  const injected = args.indexOf('--inject-regression');
  return { families: known.filter((family) => names.includes(family)), quick: args.includes('--quick'), slowOurs: injected >= 0 && args[injected + 1] === 'slow-ours' };
}
