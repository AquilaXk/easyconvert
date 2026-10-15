/**
 * The entry of the process that measures one version of the change: `node --import tsx bench/ab-child.ts --families a,b
 * [--quick]`, started by the benchmark (bench/ab-host.ts) in the checkout of that version with BENCH_PRODUCT_ROOT set. It
 * runs this tree's family runners speed-only with the timer of bench/ab-child-core.ts. The part that answers the benchmark
 * is gate code; this entry is the harness's own, since it names the families and builds their context.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseChildArgs, runChild } from './ab-child-core';
import { createContext } from './context';
import { FAMILY_RUNNERS } from './families';
import { ReferenceCache } from './ref-cache';
import { FAMILIES } from './report';
import { defaultResolver } from './tools';

const options = parseChildArgs(process.argv.slice(2), FAMILIES);
runChild(
  {
    runners: FAMILY_RUNNERS,
    makeContext: (timer, log) => {
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
        log,
        timer,
      });
      return { ctx, dispose: () => fs.rmSync(work, { recursive: true, force: true }) };
    },
  },
  options
).then(
  () => process.exit(process.exitCode ?? 0),
  (error: unknown) => {
    process.stderr.write(`ab-child failed: ${String(error)}\n`);
    process.exit(1);
  }
);
