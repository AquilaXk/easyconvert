import { runChild } from '../../bench/ab-child-core';
import { createContext, type FamilyRunner } from '../../bench/context';
import { ReferenceCache } from '../../bench/ref-cache';

/**
 * A stand-in for the family runners, to test the process that measures the base: three rows, of which the second cannot
 * run on this version (as a row of a capability the base lacks), and a record of the product root it was started with.
 */
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const runner: FamilyRunner = async (ctx) => {
  await ctx.time('compression/first/throughput', () => sleep(8), () => undefined, 'light');
  await ctx.time(
    'compression/second/throughput',
    () => {
      throw new Error(`this version cannot run the row (root ${process.env.BENCH_PRODUCT_ROOT})`);
    },
    () => undefined,
    'light'
  );
  await ctx.time('compression/third/throughput', () => sleep(2), () => undefined, 'light');
  return [];
};

runChild(
  {
    runners: { compression: runner },
    makeContext: (timer, log) => ({
      ctx: createContext({
        resolve: () => null,
        strict: false,
        runs: 1,
        heavyRuns: 1,
        warmup: 0,
        injection: null,
        parity: true,
        quality: false,
        speed: true,
        quick: false,
        refCache: new ReferenceCache({ dir: null, toolVersion: () => null, fileHash: () => '', harnessHash: () => '', log: () => undefined }),
        work: '/nonexistent',
        log,
        timer,
      }),
      dispose: () => undefined,
    }),
  },
  { families: ['compression'] }
).then(
  () => process.exit(process.exitCode ?? 0),
  () => process.exit(1)
);
