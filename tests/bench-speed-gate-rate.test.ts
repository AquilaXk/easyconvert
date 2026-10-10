import { describe, expect, it } from 'vitest';
import { PARITY_SCHEMA_VERSION, SCHEMA_VERSION } from '../bench/config';
import { evaluateParity } from '../bench/parity';
import { throughputRow } from '../bench/rows';
import { adaptiveSpeedTiming, HEAVY_SPEED_PLAN, LIGHT_SPEED_PLAN, type SpeedPlan } from '../bench/speed-parity';

/**
 * The false-failure rate of the speed rule and its sensitivity, measured on simulated rows: each pair of ours and the
 * reference is drawn with a known true speed ratio and a log-normal noise of 5 percent per pair (the width of the
 * intervals CI recorded for near-parity rows: [0.958, 1.008] at 25 pairs), through the real sequential procedure
 * (adaptiveSpeedTiming: first cap, second cap) and the real verdict (evaluateParity). The random numbers come from a
 * fixed seed, so the rates are reproducible. "Old rule" is the plan without the second cap and with the verdict at the cap
 * taken as a failure.
 */

const TRIALS = 500;
const NOISE = 0.05;
const ID = 'compression/c/throughput';

/** mulberry32: a small seeded generator, enough for reproducible noise. */
function random(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const gaussian = (uniform: () => number): number => Math.sqrt(-2 * Math.log(1 - uniform())) * Math.cos(2 * Math.PI * uniform());

async function fails(trueRatio: number, plan: SpeedPlan, seed: number, newRule: boolean, recorded: number): Promise<boolean> {
  const uniform = random(seed);
  let clock = 0;
  const timing = await adaptiveSpeedTiming(
    () => {
      clock += 100 / (trueRatio * Math.exp(NOISE * gaussian(uniform)));
    },
    () => {
      clock += 100;
    },
    { ...plan, warmup: 0, extendedMaxPairs: newRule ? plan.extendedMaxPairs : undefined },
    () => clock
  );
  const row = throughputRow('compression', 'c', 1e6, timing, 'tool');
  const report = {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: '2026-01-01T00:00:00.000Z',
    strictMode: true,
    families: ['compression' as const],
    host: { platform: 'linux', arch: 'x64', node: 'v20.0.0', cpus: 4 },
    tools: {},
    settings: { runs: 1, injectedRegression: null },
    rows: [row],
  };
  const verdict = evaluateParity(report, { schemaVersion: PARITY_SCHEMA_VERSION, gaps: [] }, newRule ? { recordedRatios: new Map([[ID, recorded]]) } : {});
  // The old rule counted a row undecided at the cap as a failure whatever its median.
  if (!newRule) return verdict.rows[0].outcome === 'fail' || row.unstableAtCap === true;
  return verdict.rows[0].outcome === 'fail';
}

async function rate(trueRatio: number, plan: SpeedPlan, newRule: boolean, recorded = 1): Promise<number> {
  let failures = 0;
  for (let trial = 0; trial < TRIALS; trial++) if (await fails(trueRatio, plan, 7000 + trial, newRule, recorded)) failures++;
  return failures / TRIALS;
}

describe.each([
  ['light', LIGHT_SPEED_PLAN],
  ['heavy', HEAVY_SPEED_PLAN],
])('the speed rule on %s rows with 5 percent noise per pair', (_name, plan) => {
  it('fails about one row in a hundred or fewer at true parity, where the old rule failed several', async () => {
    const before = await rate(1, plan, false);
    const after = await rate(1, plan, true);
    // The rates this reproduces, with the replay of recorded CI reports, are in bench/README.md.
    expect(after).toBeLessThanOrEqual(0.012);
    expect(after).toBeLessThan(before);
  });

  it('fails a row 1 percent under parity less often than before', async () => {
    expect(await rate(0.99, plan, true)).toBeLessThan(await rate(0.99, plan, false));
  });

  it('still fails an injected 10 percent slowdown of a row at parity, every time', async () => {
    expect(await rate(0.9, plan, true, 1)).toBe(1);
    expect(await rate(0.92, plan, true, 1)).toBe(1);
  });

  it('keeps failing a row clearly under the pass line, and passes one clearly above it', async () => {
    expect(await rate(0.94, plan, true)).toBeGreaterThan(0.99);
    expect(await rate(1.05, plan, true, 1.05)).toBe(0);
  });
});
