import { describe, it, expect, vi } from 'vitest';
import { decompressZstd } from '../src/lib/conversions/zstd';
import { ConversionFailedError } from '../src/lib/types';
import { buildRawFrame, makeRng } from './helpers/zstd-frames';
import { expectLinearOnInputs, SCALING_FACTOR, SCALING_TEST_TIMEOUT_MS } from './helpers/timing';

/**
 * Timing-ratio checks moved out of zstd-hostile-frames.test.ts.
 * They compare runs of the same work and need a quiet machine, so they run in the nightly performance workflow
 * (`npx vitest run --no-file-parallelism .perf.test.ts`) and not in the PR gate.
 * The PR gate keeps a hang guard on the same hostile input in zstd-hostile-frames.test.ts.
 */

/** Real engine, CLI or large-input work: the 5 s default fails on a loaded CI shard without any regression; 60 s only stops a hang. */
const ENGINE_TEST_TIMEOUT_MS = 60_000;
const TINY_FRAME_BASE_COUNT = 5000;

function repoDecode(frame: Buffer): Buffer | ConversionFailedError {
  try {
    return decompressZstd(frame);
  } catch (error) {
    expect(error).toBeInstanceOf(ConversionFailedError);
    return error as ConversionFailedError;
  }
}

vi.setConfig({ testTimeout: ENGINE_TEST_TIMEOUT_MS });

describe('decoder accepts valid hand-built frames', () => {
  it('decodes tens of thousands of tiny and empty frames without quadratic cost', async () => {
    const framesOf = (count: number) => {
      const frames: Buffer[] = [];
      const expected = Buffer.alloc(count);
      const rng = makeRng(9);
      for (let i = 0; i < count; i++) {
        const byte = Math.floor(rng() * 256);
        expected[i] = byte;
        frames.push(buildRawFrame(Buffer.from([byte])), buildRawFrame(Buffer.alloc(0)));
      }
      return { concatenated: Buffer.concat(frames), expected };
    };
    // 4x the frames may cost at most 8x the time; re-concatenating the output per frame costs 16x (tests/helpers/timing.ts).
    const small = framesOf(TINY_FRAME_BASE_COUNT);
    const large = framesOf(TINY_FRAME_BASE_COUNT * SCALING_FACTOR);
    const { largeResult: decoded } = await expectLinearOnInputs('tiny frames', (input: Buffer) => repoDecode(input) as Buffer, {
      small: small.concatenated,
      large: large.concatenated,
    });
    expect(Buffer.compare(decoded, large.expected)).toBe(0);
  }, SCALING_TEST_TIMEOUT_MS);
});
