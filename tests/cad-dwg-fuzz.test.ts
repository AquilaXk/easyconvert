import os from 'node:os';
import { beforeAll, describe, expect, it } from 'vitest';
import { convertDwgToDxf } from '../src/lib/conversions/cad-dwg';
import { CadGeometryError, UnprocessableCadInputError } from '../src/lib/types';
import { getOracleToolPath } from './helpers/differential-oracle';
import { requireDwgSample } from './helpers/dwg-samples';
import { skipUnless } from './helpers/strict-skip';

/**
 * Damaged DWG input must be refused or converted within the limits of the job, never hang the worker and never fail with an
 * error that is not typed. The reader is a C program that parses an attacker-controlled file, so crashes (a signal, an abort)
 * are an expected outcome of damage; what matters is that the wrapper turns each one into a typed 422 inside the time limit.
 *
 * The damage is made from real drawings of three releases: truncations at every kind of position, single and many bit flips,
 * runs of zeros and of 0xFF over the body, and flips confined to the first 256 bytes, where the section locators and the file
 * header live. The generator is seeded, so a failing case is reproduced by its name.
 */

const reader = getOracleToolPath('dwg2dxf');
const haveReader = !skipUnless('dwg2dxf', reader !== null);

/** A job of the worker may run this long; a case that needs more than the limit below is a hang. */
const CASE_LIMIT_MS = 20_000;
const CASES_PER_BASE = 90;
const BASES = ['entity-line-2000.dwg', 'entity-arc-2018.dwg', 'dwg-example-2007.dwg'] as const;

/** mulberry32: a small seeded generator, so that every run damages the files the same way. */
function generator(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Damage {
  name: string;
  bytes: Buffer;
}

function damages(base: Buffer, label: string, seed: number): Damage[] {
  const next = generator(seed);
  const below = (n: number): number => Math.floor(next() * n);
  const out: Damage[] = [];
  // Truncations: inside the 6-byte code, inside the header, at random places, and one byte short of complete.
  for (const length of [0, 1, 5, 6, 7, 11, 12, 13, 32, 64, 128, 255, 256]) out.push({ name: `${label} truncated to ${length}`, bytes: base.subarray(0, Math.min(length, base.length)) });
  out.push({ name: `${label} truncated by one byte`, bytes: base.subarray(0, base.length - 1) });
  for (let i = 0; i < 20; i++) {
    const length = 1 + below(base.length - 1);
    out.push({ name: `${label} truncated to ${length}`, bytes: base.subarray(0, length) });
  }
  // Bit flips over the whole file: one, eight and sixty-four bits.
  for (const [count, repeats] of [[1, 12], [8, 10], [64, 8]] as const) {
    for (let i = 0; i < repeats; i++) {
      const bytes = Buffer.from(base);
      for (let k = 0; k < count; k++) bytes[below(bytes.length)] ^= 1 << below(8);
      out.push({ name: `${label} ${count} flipped bits #${i}`, bytes });
    }
  }
  // Flips confined to the first 256 bytes: the file header and the section locators.
  for (let i = 0; i < 14; i++) {
    const bytes = Buffer.from(base);
    for (let k = 0; k < 3; k++) bytes[6 + below(Math.min(250, bytes.length - 6))] ^= 1 << below(8);
    out.push({ name: `${label} header flips #${i}`, bytes });
  }
  // Runs of zeros and of 0xFF at random places.
  for (let i = 0; i < 8; i++) {
    const bytes = Buffer.from(base);
    const start = 6 + below(bytes.length - 6);
    bytes.fill(i % 2 === 0 ? 0 : 0xff, start, Math.min(bytes.length, start + 1 + below(512)));
    out.push({ name: `${label} ${i % 2 === 0 ? 'zero' : 'FF'} run #${i}`, bytes });
  }
  return out.slice(0, CASES_PER_BASE);
}

describe.skipIf(!haveReader)('damaged DWG files', () => {
  beforeAll(() => {
    process.env.DWG2DXF_PATH ??= reader as string;
  });

  for (const [index, id] of BASES.entries()) {
    it(`${id}: every damaged copy converts or is refused with a typed error within ${CASE_LIMIT_MS / 1000} s`, async (ctx) => {
      const base = await requireDwgSample(ctx, id);
      const cases = damages(base, id, 0xd0c + index);
      expect(cases.length).toBeGreaterThanOrEqual(CASES_PER_BASE - 5);
      const outcomes = { converted: 0, refused: 0 };
      const started = Date.now();
      for (const damage of cases) {
        const caseStarted = Date.now();
        let failure: unknown = null;
        try {
          const dxf = await convertDwgToDxf(damage.bytes, { timeoutMs: CASE_LIMIT_MS });
          expect(dxf.length, damage.name).toBeGreaterThan(0);
          outcomes.converted++;
        } catch (error) {
          failure = error;
        }
        if (failure !== null) {
          const typed = failure instanceof UnprocessableCadInputError || failure instanceof CadGeometryError;
          expect(typed, `${damage.name}: ${String(failure)}`).toBe(true);
          expect((failure as Error).message, damage.name).not.toContain(os.tmpdir());
          outcomes.refused++;
        }
        expect(Date.now() - caseStarted, damage.name).toBeLessThan(CASE_LIMIT_MS);
      }
      // Damage this heavy is refused far more often than it converts, and the total stays far below the sum of the case limits.
      expect(outcomes.refused).toBeGreaterThan(0);
      expect(Date.now() - started).toBeLessThan(CASE_LIMIT_MS * 3);
    }, CASE_LIMIT_MS * 4);
  }
});
