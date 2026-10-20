import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { burrowsWheelerTransform, BwtWorkspace } from '../src/lib/conversions/bzip2-bwt';
import { compressBzip2 } from '../src/lib/conversions/bzip2';
import { proseText, SeededRandom } from './helpers/archive-corpus';
import { expectBwt, fibonacciWord, naiveRotationSort, prefixDoubling, randomBlock, repeatWord } from './helpers/bwt-reference';
import { getOracleToolPath } from './helpers/differential-oracle';
import { oracleTest } from './helpers/oracle-test';

/**
 * The Burrows-Wheeler step and the encoder over blocks of every size and shape, against the independent references of
 * `helpers/bwt-reference.ts`: the definition for tiny blocks, the previous prefix-doubling sort (whose order of equal
 * rotations the stream keeps) for the rest, and the `bzip2` command line for the streams.
 */

const BZIP2_BLOCK_BYTES = 899_981;
const TEST_TIMEOUT_MS = 180_000;
const SMALL_SIZE_LIMIT = 64;

type Shape = (length: number, seed: number) => Uint8Array;

/** Bytes in runs of 1 to 4, the shape of a block after the encoder's first run-length step. */
function shortRuns(length: number, seed: number): Uint8Array {
  const rng = new SeededRandom(seed);
  const out = new Uint8Array(length);
  for (let i = 0; i < length; ) {
    const value = rng.below(6);
    for (let run = 1 + rng.below(4); run > 0 && i < length; run--) out[i++] = value;
  }
  return out;
}

/** Prose with a 150 000-byte stretch of it repeated later: longer than the sorter's wrap length, so the sorter must take its fallback. */
function proseWithLongRepeat(length: number, seed: number): Uint8Array {
  const repeated = 150_000;
  const prose = new Uint8Array(proseText(length, seed));
  if (length < 3 * repeated) return prose;
  prose.copyWithin(length - repeated - 7, 11, 11 + repeated);
  return prose;
}

const SHAPES: ReadonlyArray<readonly [string, Shape]> = [
  ['prose', (length, seed) => new Uint8Array(proseText(length, seed))],
  ['random bytes', (length, seed) => new Uint8Array(new SeededRandom(seed).bytes(length))],
  ['two letters', (length, seed) => randomBlock(length, 2, seed)],
  ['short runs', shortRuns],
  ['word repeated with one byte changed', (length) => {
    const block = repeatWord('abcab', length);
    block[length >> 1] = 120;
    return block;
  }],
  ['Fibonacci word', (length) => fibonacciWord(length)],
  ['prose with a long repeat', proseWithLongRepeat],
];

/** True when no two rotations of the block are equal, so the definition leaves no order of equal rows to choose. */
function hasDistinctRotations(block: Uint8Array): boolean {
  const text = Buffer.from(block).toString('latin1');
  const rotations = new Set(Array.from({ length: text.length }, (_, i) => text.slice(i) + text.slice(0, i)));
  return rotations.size === text.length;
}

/** Sizes spread evenly on a log scale between two bounds, so every decade is sampled. */
function logSpacedSizes(from: number, to: number, count: number): number[] {
  return Array.from({ length: count }, (_, i) => Math.round(from * (to / from) ** (i / (count - 1))));
}

describe('bzip2 Burrows-Wheeler transform over block sizes', () => {
  it('matches the previous sort and, when the rotations are distinct, the definition for every size up to 64 over every shape', () => {
    const workspace = new BwtWorkspace();
    for (const [name, build] of SHAPES) {
      for (let length = 2; length <= SMALL_SIZE_LIMIT; length++) {
        const block = build(length, length);
        const actual = burrowsWheelerTransform(block, workspace);
        expectBwt(actual, prefixDoubling(block), `${name} ${length}`);
        if (hasDistinctRotations(block)) expectBwt(actual, naiveRotationSort(block), `${name} ${length} against the definition`);
      }
    }
  });

  it('matches the previous sort for sizes from 65 bytes to a full block over every shape', () => {
    const workspace = new BwtWorkspace();
    const sizes = logSpacedSizes(65, 400_000, 14);
    for (const [name, build] of SHAPES) {
      for (const [index, length] of sizes.entries()) {
        const block = build(length, 100 + index);
        expectBwt(burrowsWheelerTransform(block, workspace), prefixDoubling(block), `${name} ${length}`);
      }
    }
  }, TEST_TIMEOUT_MS);

  it('matches the previous sort on full 899 981-byte blocks of text, of two letters and with a repeat past the wrap length', () => {
    const workspace = new BwtWorkspace();
    for (const name of ['prose', 'two letters', 'prose with a long repeat']) {
      const build = SHAPES.find(([shapeName]) => shapeName === name)![1];
      const block = build(BZIP2_BLOCK_BYTES, 77);
      expectBwt(burrowsWheelerTransform(block, workspace), prefixDoubling(block), `${name} full block`);
    }
  }, TEST_TIMEOUT_MS);
});

describe('bzip2 streams over block sizes', () => {
  oracleTest('`bzip2 -t` accepts and `bzip2 -dc` restores streams of every shape and of sizes around the block size', ['bzip2'], () => {
    const bzip2 = getOracleToolPath('bzip2')!;
    for (const [name, build] of SHAPES) {
      for (const length of [1, 4_095, 300_001, BZIP2_BLOCK_BYTES, 1_000_003]) {
        const data = Buffer.from(build(length, 9));
        const compressed = compressBzip2(data);
        execFileSync(bzip2, ['-t'], { input: compressed });
        expect(execFileSync(bzip2, ['-dc'], { input: compressed, maxBuffer: 1 << 26 }).equals(data), `${name} ${length}`).toBe(true);
      }
    }
  }, TEST_TIMEOUT_MS);
});
