import { describe, it, expect } from 'vitest';
import { redactText } from '../src/lib/security/redact';
import { expectLinearOnInputs, SCALING_FACTOR, SCALING_TEST_TIMEOUT_MS } from './helpers/timing';

/**
 * Timing-ratio checks moved out of secret-redaction-bypasses.test.ts.
 * They compare runs of the same work and need a quiet machine, so they run in the nightly performance workflow
 * (`npx vitest run --no-file-parallelism .perf.test.ts`) and not in the PR gate.
 * The PR gate keeps a hang guard on the same hostile input in secret-redaction-bypasses.test.ts.
 */

/** Characters in the smaller of the two sizes each shape is built at. */
const SHAPE_LENGTH = 300_000;

describe('linear-time scanning of the new rules', () => {
  it('handles long runs of backslashes, quotes and unterminated values', async () => {
    // 4x the input may cost at most 8x the time, interleaved and best of N (tests/helpers/timing.ts).
    const shapes: Array<[string, (length: number) => string]> = [
      ['backslashes', (length) => '\\'.repeat(length)],
      ['escaped quotes after a key', (length) => 'password=\\"'.repeat(length / 10)],
      ['unterminated quoted value', (length) => 'password="' + '\\"'.repeat(length / 2)],
      ['authorization headers', (length) => 'Authorization: '.repeat(length / 15)],
      ['userinfo separators', (length) => `https://${'a@'.repeat(length / 2)}`],
      ['unclosed header groups', (length) => 'headers: {'.repeat(length / 10)],
      ['opening braces', (length) => `headers: ${'{'.repeat(length)}`],
      ['hyphenated key', (length) => `x${'-a'.repeat(length / 2)}: 1`],
    ];
    for (const [label, build] of shapes) {
      const { largeResult } = await expectLinearOnInputs(label, (text: string) => redactText(text), {
        small: build(SHAPE_LENGTH),
        large: build(SHAPE_LENGTH * SCALING_FACTOR),
      });
      expect(typeof largeResult).toBe('string');
    }
  }, SCALING_TEST_TIMEOUT_MS);
});
