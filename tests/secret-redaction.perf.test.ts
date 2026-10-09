import { describe, it } from 'vitest';
import { redactText } from '../src/lib/security/redact';
import { expectLinearOnInputs, SCALING_FACTOR, SCALING_TEST_TIMEOUT_MS } from './helpers/timing';

/**
 * Running time of the secret redactor on pathological input. It lives in the perf suite, which runs one file at a
 * time: at 4x the input the base run takes about 9 ms, and a sharded run that shares the runner's cores moved the
 * ratio past its bound (8.46 against 8) on a scan that is linear.
 */

/** Characters in the smaller of the two sizes each pathological shape is built at. */
const PATHOLOGICAL_LENGTH = 300_000;

describe('redactText', () => {
  it('scans long unbroken and repetitive input in linear time', async () => {
    // 4x the input may cost at most 8x the time, interleaved and best of N (tests/helpers/timing.ts); a quadratic
    // scan costs 16x. The shapes are built from a length so both sizes have the same form.
    const shapes: Array<[string, (length: number) => string]> = [
      ['a= pairs', (length) => 'a='.repeat(length)],
      ['http:// openers', (length) => 'http://'.repeat(length / 3)],
      ['dots after a host', (length) => `https://a${'.'.repeat(length)}x`],
      ['unterminated password quotes', (length) => 'password="'.repeat(length / 10)],
      ['spaces after a key', (length) => `token:${' '.repeat(length)}x`],
    ];
    for (const [label, build] of shapes) {
      await expectLinearOnInputs(label, (text: string) => redactText(text), {
        small: build(PATHOLOGICAL_LENGTH),
        large: build(PATHOLOGICAL_LENGTH * SCALING_FACTOR),
      });
    }
  }, SCALING_TEST_TIMEOUT_MS);
});
