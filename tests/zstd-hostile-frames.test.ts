import { describe, it, expect, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { compressZstd, decompressZstd, getZstdBinaryPath } from '../src/lib/conversions/zstd';
import { ConversionFailedError } from '../src/lib/types';
import { oracleTest } from './helpers/oracle-test';
import {
  assertFrameChecksum,
  blockWithSequencesSection,
  buildFrame,
  buildRawFrame,
  compressedBlock,
  directTreeDescription,
  firstBlockSequenceCount,
  huffmanLiteralsSection,
  makeRng,
  maxSequenceBlockInput,
  noiseBytes,
  rawBlock,
  rawLiteralsSection,
  repeatOffsetStress,
  rleTableSequencesBlock,
  sequenceCountBytes,
  singleBlockFrame,
  singleSequenceBlock,
  twoSymbolHuffmanStream,
} from './helpers/zstd-frames';
import { SCALING_FACTOR, SCALING_TEST_TIMEOUT_MS, expectNoHangOnInput } from './helpers/timing';

/** Real engine, CLI or large-input work: the 5 s default fails on a loaded CI shard without any regression; 60 s only stops a hang. */
const ENGINE_TEST_TIMEOUT_MS = 60_000;
const TINY_FRAME_BASE_COUNT = 5000;
vi.setConfig({ testTimeout: ENGINE_TEST_TIMEOUT_MS });

const MIB = 1024 * 1024;
const BLOCK_MAX = 128 * 1024;
const SEQUENCE_TWO_BYTE_FORM_LIMIT = 0x7f00;
const SEQUENCE_ONE_BYTE_FORM_LIMIT = 128;
const LEVELS = [1, 3, 9, 19];

function zstdBinary(): string {
  const bin = getZstdBinaryPath();
  if (!bin) throw new Error('zstd CLI path unavailable although the oracle precondition passed.');
  return bin;
}

/** Decodes with the reference CLI; null when it rejects the stream. */
function cliDecode(frame: Buffer): Buffer | null {
  try {
    return execFileSync(zstdBinary(), ['-d', '-c', '-q'], {
      input: frame,
      maxBuffer: 512 * MIB,
      stdio: ['pipe', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }
}

function cliCompress(input: Buffer, level: number): Buffer {
  return execFileSync(zstdBinary(), [`-${level}`, '-c', '-q', '-T1'], { input, maxBuffer: 512 * MIB });
}

function cliTestsFile(frame: Buffer): boolean {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zstd-hostile-'));
  const file = path.join(dir, 'frame.zst');
  try {
    fs.writeFileSync(file, frame);
    execFileSync(zstdBinary(), ['-t', '-q', file], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function repoDecode(frame: Buffer): Buffer | ConversionFailedError {
  try {
    return decompressZstd(frame);
  } catch (error) {
    expect(error).toBeInstanceOf(ConversionFailedError);
    return error as ConversionFailedError;
  }
}

interface HostileCase {
  name: string;
  frame: Buffer;
  message: RegExp;
  /** The reference decoder also rejects it (it does not enforce the declared window on offsets). */
  cliRejects: boolean;
}

// ---------------------------------------------------------------------------
// Hand-built hostile frames
// ---------------------------------------------------------------------------

/** Compressed block whose sequences section starts with a table description claiming `accuracyLog`. */
function oversizedAccuracyLogBlock(field: 'literal' | 'offset' | 'match', accuracyLog: number): Buffer {
  const modes = field === 'literal' ? 2 << 6 : field === 'offset' ? 2 << 4 : 2 << 2;
  // The four low bits of the first description byte are accuracy log - 5; the rest of the table is junk.
  const description = Buffer.from([accuracyLog - 5, 0xff, 0xff, 0xff]);
  return blockWithSequencesSection(Buffer.alloc(0), Buffer.concat([Buffer.from([1, modes]), description]));
}

function huffmanBlock(tree: Buffer, streams: Buffer, regenerated: number, streamCount: 1 | 4): Buffer {
  return Buffer.concat([huffmanLiteralsSection(regenerated, tree, streams, streamCount), Buffer.from([0x00])]);
}

/** Jump table + four one-byte streams of four symbols each for the two-symbol tree. */
function fourStreams(sizes: [number, number, number], streams: Buffer): Buffer {
  const jump = Buffer.alloc(6);
  jump.writeUInt16LE(sizes[0], 0);
  jump.writeUInt16LE(sizes[1], 2);
  jump.writeUInt16LE(sizes[2], 4);
  return Buffer.concat([jump, streams]);
}

const TWO_SYMBOL_TREE = directTreeDescription([1]);
const FOUR_STREAM_BYTES = Buffer.concat([
  twoSymbolHuffmanStream([0, 1, 0, 1]),
  twoSymbolHuffmanStream([1, 1, 0, 0]),
  twoSymbolHuffmanStream([0, 0, 0, 1]),
  twoSymbolHuffmanStream([1, 0, 1, 1]),
]);
const FOUR_STREAM_EXPECTED = Buffer.from([0, 1, 0, 1, 1, 1, 0, 0, 0, 0, 0, 1, 1, 0, 1, 1]);

function hostileCases(): HostileCase[] {
  const history = Buffer.from('abcdefgh');
  return [
    {
      name: 'offset 0 (repeat code 3 with litLen 0 on rep1 == 1)',
      frame: singleBlockFrame(singleSequenceBlock(Buffer.alloc(0), { litLen: 0, matchLen: 3, offsetValue: 3 })),
      message: /invalid offset 0/,
      cliRejects: true,
    },
    {
      name: 'offset beyond the data produced so far (first block, nothing to copy from)',
      frame: singleBlockFrame(singleSequenceBlock(Buffer.alloc(0), { litLen: 0, matchLen: 4, offsetValue: 4 })),
      message: /exceeds the available window/,
      cliRejects: true,
    },
    {
      name: 'offset beyond the data produced so far (after an 8-byte raw block)',
      frame: buildFrame(
        [rawBlock(history), compressedBlock(singleSequenceBlock(Buffer.alloc(0), { litLen: 0, matchLen: 4, offsetValue: 103 }))],
        { windowLog: 17 }
      ),
      message: /exceeds the available window/,
      cliRejects: true,
    },
    {
      name: 'offset beyond the declared window while enough data exists',
      frame: buildFrame(
        [
          rawBlock(noiseBytes(1024, 1)),
          rawBlock(noiseBytes(1024, 2)),
          compressedBlock(singleSequenceBlock(Buffer.alloc(0), { litLen: 0, matchLen: 4, offsetValue: 1503 })),
        ],
        { windowLog: 10 }
      ),
      message: /exceeds the available window/,
      cliRejects: false,
    },
    {
      name: 'literal-length table accuracy log 10 (limit 9)',
      frame: singleBlockFrame(oversizedAccuracyLogBlock('literal', 10)),
      message: /accuracy log 10 exceeds 9/,
      cliRejects: true,
    },
    {
      name: 'match-length table accuracy log 10 (limit 9)',
      frame: singleBlockFrame(oversizedAccuracyLogBlock('match', 10)),
      message: /accuracy log 10 exceeds 9/,
      cliRejects: true,
    },
    {
      name: 'offset table accuracy log 9 (limit 8)',
      frame: singleBlockFrame(oversizedAccuracyLogBlock('offset', 9)),
      message: /accuracy log 9 exceeds 8/,
      cliRejects: true,
    },
    {
      name: 'Huffman weight table accuracy log 7 (limit 6)',
      frame: singleBlockFrame(
        huffmanBlock(Buffer.from([3, 0x02, 0xff, 0xff]), Buffer.from([0x01]), 4, 1)),
      message: /accuracy log 7 exceeds 6/,
      cliRejects: true,
    },
    {
      name: 'Huffman weights that do not complete to a power of two ([3, 1])',
      frame: singleBlockFrame(huffmanBlock(directTreeDescription([3, 1]), Buffer.from([0x01]), 4, 1)),
      message: /complete code/,
      cliRejects: true,
    },
    {
      name: 'Huffman weights that are all zero',
      frame: singleBlockFrame(huffmanBlock(directTreeDescription([0, 0]), Buffer.from([0x01]), 4, 1)),
      message: /no weighted symbols/,
      cliRejects: true,
    },
    {
      name: 'Huffman weight 12 (longest code is 11 bits)',
      frame: singleBlockFrame(huffmanBlock(directTreeDescription([12, 1]), Buffer.from([0x01]), 4, 1)),
      message: /weight out of range|11 bits/,
      cliRejects: true,
    },
    {
      name: 'treeless literals without a previous Huffman table',
      frame: singleBlockFrame(
        Buffer.concat([
          // type 3 (treeless), one stream, 4 literals, 1 payload byte
          Buffer.from([0x43, 0x40, 0x00]),
          Buffer.from([0x01]),
          Buffer.from([0x00]),
        ])),
      message: /treeless block without a previous Huffman table/,
      cliRejects: true,
    },
    {
      name: 'four-stream jump table whose sizes exceed the payload',
      frame: singleBlockFrame(
        huffmanBlock(TWO_SYMBOL_TREE, fourStreams([50, 1, 1], FOUR_STREAM_BYTES), 16, 4)),
      message: /stream sizes exceed payload/,
      cliRejects: true,
    },
    {
      name: 'four-stream jump table leaving the fourth stream empty',
      frame: singleBlockFrame(
        huffmanBlock(TWO_SYMBOL_TREE, fourStreams([1, 1, 1], FOUR_STREAM_BYTES.subarray(0, 3)), 16, 4)),
      message: /stream sizes exceed payload/,
      cliRejects: true,
    },
    {
      name: 'four-stream payload shorter than its jump table',
      frame: singleBlockFrame(huffmanBlock(TWO_SYMBOL_TREE, Buffer.from([1, 0, 1]), 16, 4)),
      message: /truncated jump table/,
      cliRejects: true,
    },
    {
      name: 'four-stream block with a zero-length first stream',
      frame: singleBlockFrame(
        huffmanBlock(TWO_SYMBOL_TREE, fourStreams([0, 2, 1], FOUR_STREAM_BYTES.subarray(0, 4)), 16, 4)),
      message: /empty stream|stream sizes/,
      cliRejects: true,
    },
    {
      name: 'four streams for fewer than four literals',
      frame: singleBlockFrame(huffmanBlock(TWO_SYMBOL_TREE, fourStreams([1, 1, 1], FOUR_STREAM_BYTES), 2, 4)),
      message: /too few literals/,
      cliRejects: true,
    },
    {
      name: 'zero sequences followed by trailing bytes',
      frame: singleBlockFrame(Buffer.concat([rawLiteralsSection(Buffer.from('abc')), Buffer.from([0x00, 0x7a])])),
      message: /trailing data after empty sequences/,
      cliRejects: true,
    },
    {
      name: 'truncated three-byte sequence count',
      frame: singleBlockFrame(blockWithSequencesSection(Buffer.alloc(0), Buffer.from([255, 0x01]))),
      message: /truncated count/,
      cliRejects: true,
    },
    {
      name: 'truncated two-byte sequence count',
      frame: singleBlockFrame(blockWithSequencesSection(Buffer.alloc(0), Buffer.from([200]))),
      message: /truncated count/,
      cliRejects: true,
    },
    {
      name: 'sequence count larger than the bitstream can hold',
      frame: singleBlockFrame(
        blockWithSequencesSection(
          Buffer.alloc(40000, 0x61),
          Buffer.concat([sequenceCountBytes(40000), Buffer.from([(1 << 6) | (1 << 4) | (1 << 2), 1, 2, 0, 0x01])])
        )),
      message: /over-read|not fully consumed/,
      cliRejects: true,
    },
    {
      name: 'sequences that decode past the block maximum',
      frame: singleBlockFrame(rleTableSequencesBlock(40000, 0x61)),
      message: /exceeds the block maximum/,
      cliRejects: true,
    },
    {
      name: 'declared content size smaller than the data in the blocks',
      frame: buildFrame([rawBlock(noiseBytes(1000, 4))], { windowLog: 17, contentSize: 300 }),
      message: /content size mismatch/,
      cliRejects: true,
    },
    {
      name: 'declared 20 MiB content size with an empty body',
      frame: buildFrame([rawBlock(Buffer.alloc(0))], { windowLog: 17, contentSize: 20 * MIB }),
      message: /content size mismatch/,
      // The reference CLI does not compare an oversized declared size with the decoded length.
      cliRejects: false,
    },
    {
      name: 'raw block larger than the block maximum',
      frame: buildFrame([rawBlock(Buffer.alloc(BLOCK_MAX + 1)), rawBlock(Buffer.alloc(0))], { windowLog: 20 }),
      message: /exceeds the block maximum/,
      cliRejects: true,
    },
  ];
}

describe('decoder fails closed on hand-built hostile frames', () => {
  for (const hostile of hostileCases()) {
    it(hostile.name, () => {
      const result = repoDecode(hostile.frame);
      expect(result).toBeInstanceOf(ConversionFailedError);
      expect((result as ConversionFailedError).message).toMatch(hostile.message);
    });
  }

  oracleTest('the reference decoder rejects the same frames', ['zstd'], () => {
    for (const hostile of hostileCases().filter((c) => c.cliRejects)) {
      expect(cliTestsFile(hostile.frame), hostile.name).toBe(false);
    }
  });

  it('declared sizes are rejected before any large allocation', () => {
    const before = process.memoryUsage().arrayBuffers;
    const ratioBomb = buildFrame([rawBlock(Buffer.alloc(0))], { windowLog: 17, contentSize: 300 * MIB });
    expect(() => decompressZstd(ratioBomb)).toThrow(/compression ratio/);
    const sizeBomb = buildFrame([rawBlock(Buffer.alloc(0))], { windowLog: 17, contentSize: 600 * MIB });
    expect(() => decompressZstd(sizeBomb)).toThrow(/uncompressed size exceeds limit/);
    expect(process.memoryUsage().arrayBuffers - before).toBeLessThan(64 * MIB);
  });
});

function sequenceFormName(count: number): string {
  if (count < SEQUENCE_ONE_BYTE_FORM_LIMIT) return '1';
  return count < SEQUENCE_TWO_BYTE_FORM_LIMIT ? '2' : '3';
}

describe('decoder accepts valid hand-built frames', () => {
  it('copies at exactly the declared window size', () => {
    const block = noiseBytes(1024, 11);
    const frame = buildFrame(
      [rawBlock(block), compressedBlock(singleSequenceBlock(Buffer.alloc(0), { litLen: 0, matchLen: 4, offsetValue: 1027 }))],
      { windowLog: 10 }
    );
    const expected = Buffer.concat([block, block.subarray(0, 4)]);
    expect(Buffer.compare(repoDecode(frame) as Buffer, expected)).toBe(0);
  });

  it('decodes one- and four-stream Huffman literals', () => {
    const oneStream = singleBlockFrame(
      huffmanBlock(TWO_SYMBOL_TREE, twoSymbolHuffmanStream([1, 0, 0, 1, 1, 1]), 6, 1));
    expect(Buffer.compare(repoDecode(oneStream) as Buffer, Buffer.from([1, 0, 0, 1, 1, 1]))).toBe(0);
    const four = singleBlockFrame(huffmanBlock(TWO_SYMBOL_TREE, fourStreams([1, 1, 1], FOUR_STREAM_BYTES), 16, 4));
    expect(Buffer.compare(repoDecode(four) as Buffer, FOUR_STREAM_EXPECTED)).toBe(0);
  });

  it('decodes a sequence with an explicit literal run and match', () => {
    const frame = singleBlockFrame(
      singleSequenceBlock(Buffer.from('abcd'), { litLen: 4, matchLen: 4, offsetValue: 7 }));
    expect(repoDecode(frame).toString()).toBe('abcdabcd');
  });

  for (const count of [1, 127, 128, 255, 256, 32511, 32512, 32768]) {
    it(`sequence count ${count} in the ${sequenceFormName(count)}-byte form`, () => {
      const frame = singleBlockFrame(rleTableSequencesBlock(count, 0x61));
      const decoded = repoDecode(frame) as Buffer;
      expect(decoded.length).toBe(count * 4);
      expect(decoded.every((b) => b === 0x61)).toBe(true);
    });
  }

  it('decodes tens of thousands of tiny and empty frames without quadratic cost (hang guard; growth ratio in the perf suite)', async () => {
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
    const large = framesOf(TINY_FRAME_BASE_COUNT * SCALING_FACTOR);
    const { largeResult: decoded } = await expectNoHangOnInput(
      'tiny frames',
      (input: Buffer) => repoDecode(input) as Buffer,
      large.concatenated
    );
    expect(Buffer.compare(decoded, large.expected)).toBe(0);
  }, SCALING_TEST_TIMEOUT_MS);

  oracleTest('the reference decoder produces the same bytes for every valid hand-built frame', ['zstd'], () => {
    const four = singleBlockFrame(huffmanBlock(TWO_SYMBOL_TREE, fourStreams([1, 1, 1], FOUR_STREAM_BYTES), 16, 4));
    expect(cliDecode(four)?.equals(FOUR_STREAM_EXPECTED)).toBe(true);
    const block = noiseBytes(1024, 11);
    const atWindow = buildFrame(
      [rawBlock(block), compressedBlock(singleSequenceBlock(Buffer.alloc(0), { litLen: 0, matchLen: 4, offsetValue: 1027 }))],
      { windowLog: 10 }
    );
    expect(cliDecode(atWindow)?.equals(repoDecode(atWindow) as Buffer)).toBe(true);
    const literalRun = singleBlockFrame(singleSequenceBlock(Buffer.from('abcd'), { litLen: 4, matchLen: 4, offsetValue: 7 }));
    expect(cliDecode(literalRun)?.toString()).toBe('abcdabcd');
    for (const count of [1, 127, 128, 255, 256, 32511, 32512, 32768]) {
      const frame = singleBlockFrame(rleTableSequencesBlock(count, 0x61));
      expect(cliDecode(frame)?.equals(repoDecode(frame) as Buffer), `sequence count ${count}`).toBe(true);
    }
    const tiny: Buffer[] = [];
    for (let i = 0; i < 2000; i++) tiny.push(buildRawFrame(Buffer.from([i & 0xff])), buildRawFrame(Buffer.alloc(0)));
    const concatenated = Buffer.concat(tiny);
    expect(cliDecode(concatenated)?.equals(repoDecode(concatenated) as Buffer)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Encoder output under the reference decoder at format boundaries
// ---------------------------------------------------------------------------

function textLike(length: number, seed: number): Buffer {
  const rng = makeRng(seed);
  const words = ['stream', 'frame', 'block', 'window', 'literal', 'sequence', 'offset', 'match', 'entropy', 'table'];
  const parts: string[] = [];
  let total = 0;
  while (total < length) {
    const word = words[Math.floor(rng() * words.length)] + (rng() < 0.2 ? '\n' : ' ');
    parts.push(word);
    total += word.length;
  }
  return Buffer.from(parts.join('').slice(0, length), 'latin1');
}

describe('encoder boundary cases', () => {
  const sizes = [BLOCK_MAX - 1, BLOCK_MAX, BLOCK_MAX + 1, 2 * BLOCK_MAX - 1, 2 * BLOCK_MAX, 2 * BLOCK_MAX + 1];

  it('splits input at 128 KiB +/- 1 into the expected number of blocks and round-trips', () => {
    for (const size of sizes) {
      for (const level of [1, 19]) {
        const input = textLike(size, size);
        const frame = compressZstd(input, { level });
        assertFrameChecksum(frame, input);
        expect(Buffer.compare(decompressZstd(frame), input), `${size} bytes level ${level}`).toBe(0);
      }
    }
  });

  oracleTest('CLI decodes every 128 KiB boundary size at levels 1, 3, 9 and 19', ['zstd'], () => {
    for (const size of sizes) {
      for (const [kind, input] of [
        ['text', textLike(size, size)],
        ['noise', noiseBytes(size, size)],
      ] as Array<[string, Buffer]>) {
        for (const level of LEVELS) {
          const frame = compressZstd(input, { level });
          expect(cliTestsFile(frame), `${kind} ${size} level ${level}: zstd -t`).toBe(true);
          const decoded = cliDecode(frame);
          expect(decoded?.equals(input), `${kind} ${size} level ${level}: bytes`).toBe(true);
        }
      }
    }
  });

  it('emits the three-byte sequence-count form for a block with at least 32512 sequences', () => {
    const input = maxSequenceBlockInput(190, 190);
    for (const level of [3, 9, 19]) {
      const frame = compressZstd(input, { level });
      assertFrameChecksum(frame, input);
      expect(firstBlockSequenceCount(frame), `level ${level}`).toBeGreaterThanOrEqual(32512);
      expect(Buffer.compare(decompressZstd(frame), input)).toBe(0);
    }
  });

  oracleTest('CLI decodes the maximum-sequence block (three-byte count form)', ['zstd'], () => {
    const input = maxSequenceBlockInput(190, 190);
    for (const level of [3, 9, 19]) {
      const frame = compressZstd(input, { level });
      assertFrameChecksum(frame, input);
      expect(cliTestsFile(frame), `level ${level}`).toBe(true);
      expect(cliDecode(frame)?.equals(input), `level ${level}`).toBe(true);
    }
    // The reference encoder's frame for the same data is decoded by the repo decoder too.
    expect(Buffer.compare(decompressZstd(cliCompress(input, 3)), input)).toBe(0);
  });

  it('round-trips back-to-back matches that use repeat codes with a zero literal length', () => {
    for (const seed of [5, 6, 7, 8]) {
      const input = repeatOffsetStress(250000, seed);
      for (const level of LEVELS) {
        const frame = compressZstd(input, { level });
        assertFrameChecksum(frame, input);
        expect(Buffer.compare(decompressZstd(frame), input), `seed ${seed} level ${level}`).toBe(0);
      }
    }
  });

  oracleTest('CLI decodes repeat-offset streams (litLen == 0 repeat codes) at levels 1, 3, 9 and 19', ['zstd'], () => {
    for (const seed of [5, 6, 7, 8]) {
      const input = repeatOffsetStress(250000, seed);
      for (const level of LEVELS) {
        const frame = compressZstd(input, { level });
        expect(cliTestsFile(frame), `seed ${seed} level ${level}: zstd -t`).toBe(true);
        expect(cliDecode(frame)?.equals(input), `seed ${seed} level ${level}: bytes`).toBe(true);
      }
    }
  });

  describe('matches at the window boundary (level 1 declares a 2^19 window)', () => {
    const WINDOW = 2 ** 19;
    const chunk = noiseBytes(4096, 77);
    const tail = noiseBytes(1000, 78);

    /** chunk, zero filler, chunk again so the two copies start exactly `distance` bytes apart. */
    function withDistance(distance: number): Buffer {
      return Buffer.concat([chunk, Buffer.alloc(distance - chunk.length), chunk, tail]);
    }

    it('uses a copy at distance == window and refuses one byte further', () => {
      const sizeAt = (distance: number): number => {
        const input = withDistance(distance);
        const frame = compressZstd(input, { level: 1 });
        assertFrameChecksum(frame, input);
        expect(Buffer.compare(decompressZstd(frame), input), `distance ${distance}`).toBe(0);
        return frame.length;
      };
      const inside = sizeAt(WINDOW);
      const justInside = sizeAt(WINDOW - 1);
      const outside = sizeAt(WINDOW + 1);
      expect(outside - inside).toBeGreaterThan(3000);
      expect(outside - justInside).toBeGreaterThan(3000);
    });

    oracleTest('CLI decodes copies at window - 1, window and window + 1', ['zstd'], () => {
      for (const distance of [WINDOW - 1, WINDOW, WINDOW + 1]) {
        const input = withDistance(distance);
        const frame = compressZstd(input, { level: 1 });
        expect(cliTestsFile(frame), `distance ${distance}: zstd -t`).toBe(true);
        expect(cliDecode(frame)?.equals(input), `distance ${distance}: bytes`).toBe(true);
      }
    });
  });
});
