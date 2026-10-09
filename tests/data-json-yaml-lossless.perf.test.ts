import { describe, it, expect } from 'vitest';
import { convertFile } from '../src/lib/conversions';
import { expectLinearOnInputs, SCALING_FACTOR, SCALING_TEST_TIMEOUT_MS } from './helpers/timing';

/**
 * Timing-ratio checks moved out of data-json-yaml-lossless.test.ts.
 * They compare runs of the same work and need a quiet machine, so they run in the nightly performance workflow
 * (`npx vitest run --no-file-parallelism .perf.test.ts`) and not in the PR gate.
 * The PR gate keeps a hang guard on the same hostile input in data-json-yaml-lossless.test.ts.
 */

describe('YAML keys are checked in linear time', () => {
  const SMALL_KEY_COUNT = 10_000;

  /**
   * 4x the keys may cost at most 8x the time (tests/helpers/timing.ts): linear work scales by about 4, the
   * pairwise uniqueness check this replaces scaled by 16 (19 s at 40,000 keys, 147 s at 100,000).
   */
  const LARGE_KEY_COUNT = SMALL_KEY_COUNT * SCALING_FACTOR;

  const SCALING_PASSES_FOR_CONVERSION = 2;

  const yamlWithKeys = (keyCount: number) =>
    Buffer.from(Array.from({ length: keyCount }, (_, i) => `k${i}: ${i}`).join('\n'), 'utf-8');

  it('converts YAML maps in time linear in their key count', async () => {
    const { largeResult } = await expectLinearOnInputs(
      'yaml to json',
      (yamlText: Buffer) => convertFile(yamlText, 'yaml', 'json', {}, 'keys.yaml'),
      { small: yamlWithKeys(SMALL_KEY_COUNT), large: yamlWithKeys(LARGE_KEY_COUNT), passes: SCALING_PASSES_FOR_CONVERSION }
    );
    const parsed = JSON.parse(largeResult.buffer.toString('utf-8')) as Record<string, number>;
    expect(Object.keys(parsed)).toHaveLength(LARGE_KEY_COUNT);
    expect(parsed[`k${LARGE_KEY_COUNT - 1}`]).toBe(LARGE_KEY_COUNT - 1);
  }, SCALING_TEST_TIMEOUT_MS);
});
