import { describe, it, expect, vi } from 'vitest';
import * as cp from 'node:child_process';
import * as crypto from 'node:crypto';
import { compressBzip2 } from '../src/lib/conversions/bzip2';
import { expectLinearOnInputs, SCALING_FACTOR, SCALING_TEST_TIMEOUT_MS } from './helpers/timing';
import { skipUnless } from './helpers/strict-skip';

/**
 * Timing-ratio checks moved out of bzip2-reference-interop.test.ts.
 * They compare runs of the same work and need a quiet machine, so they run in the nightly performance workflow
 * (`npx vitest run --no-file-parallelism .perf.test.ts`) and not in the PR gate.
 * The PR gate keeps a hang guard on the same hostile input in bzip2-reference-interop.test.ts.
 */

/** Real engine, CLI or large-input work: the 5 s default fails on a loaded CI shard without any regression; 60 s only stops a hang. */
const ENGINE_TEST_TIMEOUT_MS = 60_000;

const MAX_BUFFER_BYTES = 256 * 1024 * 1024;
const BZIP2_MAX_BLOCK_BYTES = 900_000;

const SKIP_WITHOUT_BZIP2 = skipUnless('bzip2', cp.spawnSync('bzip2', ['--help'], { stdio: 'ignore' }).error === undefined);

function sha256(buf: Uint8Array): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function expectSameBytes(actual: Buffer, expected: Buffer): void {
  expect(actual.length).toBe(expected.length);
  expect(sha256(actual)).toBe(sha256(expected));
}

function systemBzip2(args: string[], input: Buffer): Buffer {
  const res = cp.spawnSync('bzip2', args, { input, maxBuffer: MAX_BUFFER_BYTES });
  if (res.error) throw res.error;
  if (res.status !== 0) {
    throw new Error(`bzip2 ${args.join(' ')} exited ${res.status}: ${res.stderr.toString('utf-8')}`);
  }
  return res.stdout;
}

vi.setConfig({ testTimeout: ENGINE_TEST_TIMEOUT_MS });

describe('bzip2 encoder output is accepted by the reference decoder', () => {
  // The block sorter must stay linear-time on the inputs that make a naive suffix sort quadratic. Growth is
  // compared on a quarter-size input and the full 900 kB block (tests/helpers/timing.ts), not against a budget.
  const timingCases: Array<[string, (bytes: number) => Buffer]> = [
    ['zeros', (bytes) => Buffer.alloc(bytes)],
    [
      'a 2-byte period',
      (bytes) => {
        // An odd length keeps the block from being an exact repetition of "ab", which the sorter shortcuts: both sizes
        // then take the same general path (tests/bzip2-bwt.perf.test.ts times the exact repetition).
        const buf = Buffer.alloc(bytes % 2 === 0 ? bytes - 1 : bytes);
        for (let i = 0; i < buf.length; i++) buf[i] = i % 2 === 0 ? 0x61 : 0x62;
        return buf;
      },
    ],
  ];

  for (const [name, make] of timingCases) {
    it.skipIf(SKIP_WITHOUT_BZIP2)(`compresses a 900 kB block of ${name} in linear time`, async () => {
      const input = make(BZIP2_MAX_BLOCK_BYTES);
      const { largeResult: compressed } = await expectLinearOnInputs('compressBzip2', (data: Buffer) => compressBzip2(data), {
        small: make(BZIP2_MAX_BLOCK_BYTES / SCALING_FACTOR),
        large: input,
      });
      expectSameBytes(systemBzip2(['-dc'], compressed), input);
    }, SCALING_TEST_TIMEOUT_MS);
  }
});
