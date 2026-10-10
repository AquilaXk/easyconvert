import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { compressZstd, decompressZstd } from '../src/lib/conversions/zstd';
import { SeededRandom, proseText, runBytes, sourceText } from './helpers/archive-corpus';
import { getOracleToolPath } from './helpers/differential-oracle';
import { oracleTest } from './helpers/oracle-test';

/**
 * Edges of the decoder's bulk paths against frames the `zstd` command line wrote: the Huffman literals of one and of
 * four streams down to a few bytes per stream (where the 32-bit container cannot be refilled any more and the last
 * symbols are read one at a time), and matches that copy four bytes at a time (an offset of 4 or more, overlapping
 * itself) up to the last byte of the output buffer, where the copy must fall back to single bytes.
 */
const TEST_TIMEOUT_MS = 120_000;
const CLI_LEVELS = [1, 3, 9] as const;

function cliCompress(data: Buffer, level: number): Buffer {
  return execFileSync(getOracleToolPath('zstd')!, [`-${level}`, '-q', '-c'], { input: data, maxBuffer: 1 << 26 });
}

function cliDecompress(frame: Buffer): Buffer {
  return execFileSync(getOracleToolPath('zstd')!, ['-d', '-q', '-c'], { input: frame, maxBuffer: 1 << 26 });
}

/** Sizes from the smallest Huffman-coded literal sections up through several blocks, with the awkward residues of 4 streams. */
function literalSizes(): number[] {
  const sizes: number[] = [];
  for (let size = 33; size <= 130; size++) sizes.push(size);
  for (let size = 131; size <= 2300; size += 37) sizes.push(size);
  sizes.push(16383, 16384, 16385, 65535, 131072, 131073, 262145);
  return sizes;
}

describe('Huffman literals of the reference encoder, at every size that changes the stream layout', () => {
  oracleTest(
    'prose and noise-seasoned text restore byte for byte through our decoder',
    ['zstd'],
    () => {
      for (const size of literalSizes()) {
        const text = proseText(size, 1000 + size);
        const seasoned = Buffer.concat([text.subarray(0, size >> 1), new SeededRandom(size).bytes(size - (size >> 1))]);
        for (const input of [text, seasoned]) {
          const frame = cliCompress(input, 3);
          expect(Buffer.compare(decompressZstd(frame), input), `size ${size}`).toBe(0);
        }
      }
    },
    TEST_TIMEOUT_MS
  );

  oracleTest(
    'source text at levels 1, 3 and 9 restores byte for byte, and our own frames restore with the command line',
    ['zstd'],
    () => {
      for (const size of [200, 777, 4096, 40_000, 140_000, 300_000]) {
        const input = sourceText(size, 2000 + size);
        for (const level of CLI_LEVELS) {
          expect(Buffer.compare(decompressZstd(cliCompress(input, level)), input), `cli frame, size ${size}, level ${level}`).toBe(0);
          expect(Buffer.compare(cliDecompress(compressZstd(input, { level })), input), `our frame, size ${size}, level ${level}`).toBe(0);
        }
      }
    },
    TEST_TIMEOUT_MS
  );
});

describe('matches that copy a word at a time, up to the end of the output', () => {
  oracleTest(
    'a pattern of every period from 1 to 17, ending on a match of every length, restores byte for byte',
    ['zstd'],
    () => {
      for (let period = 1; period <= 17; period++) {
        const unit = new SeededRandom(period).bytes(period);
        for (const extra of [0, 1, 2, 3, 4, 5, 7, 8, 9, 31, 32, 33, 63, 64, 65, 200]) {
          const input = Buffer.concat([new SeededRandom(500 + period).bytes(40), Buffer.alloc(120 + extra, 0).map((_, i) => unit[i % period])]);
          for (const level of [1, 3]) {
            const frame = cliCompress(input, level);
            expect(Buffer.compare(decompressZstd(frame), input), `period ${period}, extra ${extra}, level ${level}`).toBe(0);
          }
        }
      }
    },
    TEST_TIMEOUT_MS
  );

  oracleTest(
    'long runs and short runs of a few byte values restore byte for byte at levels 1, 3 and 9',
    ['zstd'],
    () => {
      for (const seed of [3, 4, 5]) {
        const input = runBytes(150_000, seed);
        for (const level of CLI_LEVELS) {
          expect(Buffer.compare(decompressZstd(cliCompress(input, level)), input), `seed ${seed}, level ${level}`).toBe(0);
        }
      }
    },
    TEST_TIMEOUT_MS
  );
});
