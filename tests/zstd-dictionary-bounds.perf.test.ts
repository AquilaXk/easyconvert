import { describe, it, expect, vi } from 'vitest';
import { compressWithZstdDict, DATA_DICTIONARY_JSON_CSV, decompressWithZstdDict, ZSTD_DICT_MAGIC } from '../src/lib/conversions/zstd-dict';
import { assertFrameChecksum, buildFrame, compressedBlock, makeRng, rleTableSequencesBlock, type TestBlock } from './helpers/zstd-frames';
import { expectLinearOnInputs, SCALING_FACTOR, SCALING_TEST_TIMEOUT_MS } from './helpers/timing';

/**
 * Timing-ratio checks moved out of zstd-dictionary-bounds.test.ts.
 * They compare runs of the same work and need a quiet machine, so they run in the nightly performance workflow
 * (`npx vitest run --no-file-parallelism .perf.test.ts`) and not in the PR gate.
 * The PR gate keeps a hang guard on the same hostile input in zstd-dictionary-bounds.test.ts.
 */

/** Real engine, CLI or large-input work: the 5 s default fails on a loaded CI shard without any regression; 60 s only stops a hang. */
const ENGINE_TEST_TIMEOUT_MS = 60_000;

const LOW_ENTROPY_BASE_BYTES = 64 * 1024;

function dictFrame(blocks: TestBlock[], dictionaryId = ZSTD_DICT_MAGIC, contentSize?: number): Buffer {
  if (contentSize !== undefined) {
    return buildFrame(blocks, { singleSegment: true, contentSize, dictionaryId });
  }
  return buildFrame(blocks, { windowLog: 17, dictionaryId });
}

vi.setConfig({ testTimeout: ENGINE_TEST_TIMEOUT_MS });

describe('dictionary frames decode through the bounded block decoder', () => {
  it('decodes tens of thousands of sequences in linear time', async () => {
    const count = 30000;
    const frameOf = (sequences: number) => dictFrame([compressedBlock(rleTableSequencesBlock(sequences, 0x61))]);
    // 4x the sequences may cost at most 8x the time (tests/helpers/timing.ts); a quadratic decoder costs 16x.
    const { largeResult: decoded } = await expectLinearOnInputs(
      'dictionary sequences',
      (frame: Buffer) => decompressWithZstdDict(frame, DATA_DICTIONARY_JSON_CSV),
      { small: frameOf(count / SCALING_FACTOR), large: frameOf(count) }
    );
    expect(decoded.length).toBe(count * 4);
    expect(decoded.every((b) => b === 0x61)).toBe(true);
  }, SCALING_TEST_TIMEOUT_MS);
});

describe('dictionary compression stays inside the 128 KiB block maximum', () => {
  it('bounds the match search so low-entropy input does not make compression quadratic', async () => {
    const lowEntropy = (bytes: number) => {
      const rng = makeRng(2024);
      const input = Buffer.alloc(bytes);
      for (let i = 0; i < input.length; i++) input[i] = rng() < 0.5 ? 0x30 : 0x31;
      return input;
    };
    // 4x the input may cost at most 8x the time; an unbounded match search costs 16x (tests/helpers/timing.ts).
    const small = lowEntropy(LOW_ENTROPY_BASE_BYTES);
    const input = lowEntropy(LOW_ENTROPY_BASE_BYTES * SCALING_FACTOR);
    const { largeResult: frame } = await expectLinearOnInputs(
      'low-entropy compression',
      (data: Buffer) => compressWithZstdDict(data, DATA_DICTIONARY_JSON_CSV),
      { small, large: input }
    );
    assertFrameChecksum(frame, input);
    expect(Buffer.compare(decompressWithZstdDict(frame, DATA_DICTIONARY_JSON_CSV), input)).toBe(0);
  }, SCALING_TEST_TIMEOUT_MS);
});
