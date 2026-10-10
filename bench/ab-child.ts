/**
 * The process that measures the base of the change: `tsx bench/ab-child.ts --families a,b [--quick]`, started by the
 * benchmark (bench/ab-host.ts) with the checkout of the base commit as its working directory and BENCH_PRODUCT_ROOT set
 * to it, so its product, tsconfig and node_modules are the base's own. It runs the family runners speed-only, answers
 * the benchmark's requests to time `ours` (bench/ab-protocol.ts), and discards the rows it produces itself.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import type { ChildMessage, HostMessage } from './ab-protocol';
import { createContext, type FamilyRunner, slowed } from './context';
import { FAMILY_RUNNERS } from './families';
import { ReferenceCache } from './ref-cache';
import { FAMILIES, type Family } from './report';
import type { AdaptiveTiming } from './speed-parity';
import { defaultResolver } from './tools';

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
  families: Family[];
  quick: boolean;
  /** `slow-ours`: the version this process measures is slowed, as the benchmark slows its own side (a test of the gate). */
  slowOurs?: boolean;
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

export async function runChild(runners: Readonly<Record<Family, FamilyRunner>>, options: ChildOptions): Promise<void> {
  const receive = inbox();
  let rows = 0;
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-ab-child-'));
  const ctx = createContext({
    resolve: defaultResolver(),
    strict: process.env.ORACLE_STRICT_MODE === '1',
    runs: 1,
    heavyRuns: 1,
    warmup: 0,
    injection: null,
    parity: true,
    quality: false,
    speed: true,
    quick: options.quick,
    refCache: new ReferenceCache({ dir: null, toolVersion: () => null, fileHash: () => '', harnessHash: () => '', log: () => undefined }),
    work,
    log: (message) => process.stderr.write(`  [base] ${message}\n`),
    timer: async (rawOurs) => {
      const ours = options.slowOurs ? slowed(rawOurs) : rawOurs;
      send({ type: 'ready', row: rows++ });
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
    },
  });
  try {
    send({ type: 'hello' });
    for (const family of options.families) await runners[family](ctx);
    send({ type: 'finished', rows });
    for (;;) if ((await receive()).type === 'exit') break;
  } catch (error) {
    send({ type: 'crashed', message: error instanceof Error ? (error.stack ?? error.message) : String(error) });
    process.exitCode = 1;
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

function parseChildArgs(args: string[]): ChildOptions {
  const at = args.indexOf('--families');
  const names = at >= 0 ? args[at + 1].split(',') : [...FAMILIES];
  const unknown = names.filter((name) => !(FAMILIES as readonly string[]).includes(name));
  if (unknown.length > 0) throw new Error(`unknown family ${unknown.join(', ')}`);
  const injected = args.indexOf('--inject-regression');
  return { families: FAMILIES.filter((family) => names.includes(family)), quick: args.includes('--quick'), slowOurs: injected >= 0 && args[injected + 1] === 'slow-ours' };
}

if (require.main === module) {
  runChild(FAMILY_RUNNERS, parseChildArgs(process.argv.slice(2))).then(
    () => process.exit(process.exitCode ?? 0),
    (error: unknown) => {
      process.stderr.write(`ab-child failed: ${String(error)}\n`);
      process.exit(1);
    }
  );
}
