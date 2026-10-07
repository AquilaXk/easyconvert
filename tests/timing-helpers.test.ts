import { describe, expect, it } from 'vitest';
import {
  expectLinearScaling,
  expectSizeIndependent,
  measureInterleaved,
  SCALING_FACTOR,
  SCALING_TEST_TIMEOUT_MS,
} from './helpers/timing';

/**
 * The timing helpers are the oracle for every complexity claim in the suite, so they are checked against
 * algorithms whose growth is known by construction: a loop of n steps, a loop of n * n steps, and work that
 * ignores its size argument.
 */

const LINEAR_STEPS_PER_UNIT = 4000;
const LINEAR_BASE = 2000;
const QUADRATIC_BASE = 1500;
const CONSTANT_STEPS = 20_000;
const MODEST_CLAIM = 1000;
const HUGE_CLAIM = 1_000_000;
/** Steps per claimed unit for a reader that trusts the claim and walks it. */
const CLAIM_WALK_STEPS_PER_UNIT = 50;

let sink = 0;

function linearWork(n: number): void {
  let sum = 0;
  for (let i = 0; i < n * LINEAR_STEPS_PER_UNIT; i++) sum += i % 7;
  sink += sum;
}

function quadraticWork(n: number): void {
  let sum = 0;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) sum += (i ^ j) & 3;
  }
  sink += sum;
}

function constantWork(): void {
  let sum = 0;
  for (let i = 0; i < CONSTANT_STEPS; i++) sum += i % 5;
  sink += sum;
}

function claimWalkingWork(claimed: number): void {
  let sum = 0;
  for (let i = 0; i < claimed * CLAIM_WALK_STEPS_PER_UNIT; i++) sum += i & 1;
  sink += sum;
}

describe('timing helpers separate linear from super-linear growth', () => {
  it('accepts work whose time grows in proportion to the input', async () => {
    const measurement = await expectLinearScaling('linear loop', linearWork, { baseSize: LINEAR_BASE });
    expect(measurement.ratio).toBeGreaterThan(1);
    expect(measurement.ratio).toBeLessThanOrEqual(SCALING_FACTOR * 2);
  }, SCALING_TEST_TIMEOUT_MS);

  it('rejects quadratic work with a message that names the growth', async () => {
    await expect(expectLinearScaling('quadratic loop', quadraticWork, { baseSize: QUADRATIC_BASE })).rejects.toThrow(
      /quadratic loop: 4x the input took \d+\.\d+x as long/
    );
  }, SCALING_TEST_TIMEOUT_MS);

  it('refuses a comparison whose small run is too short to time', async () => {
    await expect(expectLinearScaling('trivial loop', () => undefined, { baseSize: 1 })).rejects.toThrow(
      /too short to time/
    );
  }, SCALING_TEST_TIMEOUT_MS);

  it('keeps the best of the interleaved passes of each side', async () => {
    const measurement = await measureInterleaved(
      () => linearWork(LINEAR_BASE),
      () => linearWork(LINEAR_BASE * SCALING_FACTOR)
    );
    expect(measurement.smallMs).toBeGreaterThan(0);
    expect(measurement.largeMs).toBeGreaterThan(measurement.smallMs);
    expect(measurement.ratio).toBeCloseTo(measurement.largeMs / measurement.smallMs, 10);
  }, SCALING_TEST_TIMEOUT_MS);
});

describe('size-independence check', () => {
  it('accepts a rejection that ignores the claimed size', async () => {
    await expectSizeIndependent('constant work', constantWork, { modestSize: MODEST_CLAIM, hugeSize: HUGE_CLAIM });
  }, SCALING_TEST_TIMEOUT_MS);

  it('rejects a reader whose work follows the claimed size', async () => {
    await expect(
      expectSizeIndependent('claim walker', claimWalkingWork, { modestSize: MODEST_CLAIM, hugeSize: HUGE_CLAIM })
    ).rejects.toThrow(/claim walker: the larger input took .* the work must not grow with the input/);
  }, SCALING_TEST_TIMEOUT_MS);
});
