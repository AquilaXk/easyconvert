import { runChild } from '../../bench/ab-child';
import type { FamilyRunner } from '../../bench/context';
import { FAMILIES, type Family } from '../../bench/report';

/**
 * A stand-in for the family runners, to test the process that measures the base: three rows, of which the second cannot
 * run on this version (as a row of a capability the base lacks), and a record of the product root it was started with.
 */
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const runner: FamilyRunner = async (ctx) => {
  await ctx.time(() => sleep(8), () => undefined, 'light');
  await ctx.time(
    () => {
      throw new Error(`this version cannot run the row (root ${process.env.BENCH_PRODUCT_ROOT})`);
    },
    () => undefined,
    'light'
  );
  await ctx.time(() => sleep(2), () => undefined, 'light');
  return [];
};

const none: FamilyRunner = async () => [];
const runners = Object.fromEntries(FAMILIES.map((family) => [family, family === 'compression' ? runner : none])) as Record<Family, FamilyRunner>;

runChild(runners, { families: ["compression"], quick: false }).then(
  () => process.exit(process.exitCode ?? 0),
  () => process.exit(1)
);
