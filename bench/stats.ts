import { performance } from 'node:perf_hooks';
import { MAX_RUNS, MS_PER_SECOND } from './config';
import { BenchArgumentError } from './errors';

export function median(values: readonly number[]): number {
  if (values.length === 0) throw new BenchArgumentError('median needs at least one value');
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function mean(values: readonly number[]): number {
  if (values.length === 0) throw new BenchArgumentError('mean needs at least one value');
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** Coefficient of variation (sample standard deviation over the mean); 0 for a single sample. */
export function coefficientOfVariation(values: readonly number[]): number {
  if (values.length < 2) return 0;
  const average = mean(values);
  if (average === 0) return 0;
  const variance = values.reduce((sum, value) => sum + (value - average) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance) / average;
}

export interface InterleavedTiming {
  runs: number;
  oursMs: number[];
  referenceMs: number[];
  oursMedianMs: number;
  referenceMedianMs: number;
  oursCv: number;
  referenceCv: number;
}

async function timed(action: () => Promise<void> | void): Promise<number> {
  const start = performance.now();
  await action();
  return performance.now() - start;
}

/**
 * Times two actions in one window: each run executes both, and the order alternates between runs so a drifting
 * machine load or a warming cache favours neither side. The result is the median of `runs` samples per side
 * with the coefficient of variation, after `warmup` untimed rounds.
 */
export async function interleavedTiming(
  ours: () => Promise<void> | void,
  reference: () => Promise<void> | void,
  runs: number,
  warmup: number
): Promise<InterleavedTiming> {
  if (!Number.isInteger(runs) || runs < 1 || runs > MAX_RUNS) {
    throw new BenchArgumentError(`runs must be an integer from 1 to ${MAX_RUNS}, got ${runs}`);
  }
  for (let i = 0; i < warmup; i++) {
    await ours();
    await reference();
  }
  const oursMs: number[] = [];
  const referenceMs: number[] = [];
  for (let run = 0; run < runs; run++) {
    if (run % 2 === 0) {
      oursMs.push(await timed(ours));
      referenceMs.push(await timed(reference));
    } else {
      referenceMs.push(await timed(reference));
      oursMs.push(await timed(ours));
    }
  }
  return {
    runs,
    oursMs,
    referenceMs,
    oursMedianMs: median(oursMs),
    referenceMedianMs: median(referenceMs),
    oursCv: coefficientOfVariation(oursMs),
    referenceCv: coefficientOfVariation(referenceMs),
  };
}

/** Megabytes per second of `bytes` processed in `milliseconds`. */
export function megabytesPerSecond(bytes: number, milliseconds: number, bytesPerMegabyte: number): number {
  return bytes / bytesPerMegabyte / (milliseconds / MS_PER_SECOND);
}
