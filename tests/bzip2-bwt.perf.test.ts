import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { burrowsWheelerTransform, BwtWorkspace, WRAP_EXTENSION } from '../src/lib/conversions/bzip2-bwt';
import { compressBzip2 } from '../src/lib/conversions/bzip2';
import { proseText, SeededRandom } from './helpers/archive-corpus';
import { expectBwt, fibonacciWord, naiveRotationSort, prefixDoubling, randomBlock, repeatWord } from './helpers/bwt-reference';
import { getOracleToolPath } from './helpers/differential-oracle';
import { oracleTest } from './helpers/oracle-test';
import { expectLinearOnInputs, expectNoSlowerThanReference, SCALING_TEST_TIMEOUT_MS } from './helpers/timing';

/**
 * Regression guard for the suffix sorter against prefix doubling on a full block. Node.js 24 made the reference 2.1 times
 * faster and the previous sorter (a generic induced sort over a type array) 1.4 times, which left it at 1.5x on the CI
 * runner (nightly run on Node.js 24: ratio 0.65 against the bound 0.5). The current sorter (bzip2-suffix-sort.ts: type bits in the
 * suffix array entries, no type array, no rescans) measures 2.2x on the 4-core Linux test VM (ratio 0.44 to 0.50 in 22 runs, idle
 * and beside 24 busy processes; the median of 9 alternating runs reads the same 0.44 to 0.49). A bound of 0.5 left 8% for the
 * host: 1 run in 20 read 0.508 beside 12 busy processes and 1 in 20 read 0.558 beside 36, after the 12 passes the helper takes. The
 * bound is 1.6x (ratio 0.625): above every run measured, below the previous sorter (1.4x, ratio 0.71) and far below prefix doubling (1x).
 */
const MIN_BWT_SPEEDUP = 1.6;

/**
 * The Burrows-Wheeler step of the bzip2 encoder against independent references:
 *  - a naive sort of the n cyclic rotations (the definition of the transform) for blocks without equal rotations;
 *  - the previous implementation (prefix doubling with counting sorts), reproduced here, for the exact row of the
 *    unrotated block, which for a block that repeats a word depends on how equal rotations are ordered;
 *  - the `bzip2` command line, which must decode what the encoder writes.
 * Speed claims are ratios against the reproduced previous implementation, measured in this process. A slow runner can
 * opt out explicitly with ARCHIVE_SKIP_TIMING=1; nothing skips silently in CI.
 */
// skip-ok: explicit opt-out (ARCHIVE_SKIP_TIMING=1) of the timing ratios on a slow shared runner, never set in CI.
const SKIP_TIMING = process.env.ARCHIVE_SKIP_TIMING === '1';
const TEST_TIMEOUT_MS = 180_000;
const BZIP2_BLOCK_BYTES = 899_981;
const REPO_ROOT = path.resolve(__dirname, '..');

/** The repository's own TypeScript sources (a reproducible, realistic text input), `bytes` long, in a fixed order. */
function repositorySource(bytes: number): Buffer {
  const parts: Buffer[] = [];
  let total = 0;
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (total >= bytes) return;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.ts')) {
        const data = fs.readFileSync(full);
        parts.push(data);
        total += data.length;
      }
    }
  };
  walk(path.join(REPO_ROOT, 'src'));
  walk(path.join(REPO_ROOT, 'tests'));
  return Buffer.concat(parts).subarray(0, bytes);
}

describe('bzip2 Burrows-Wheeler transform', () => {
  it('matches the definition (naive rotation sort) on random blocks over small and large alphabets', () => {
    const workspace = new BwtWorkspace();
    for (let seed = 1; seed <= 60; seed++) {
      const length = 2 + ((seed * 37) % 150);
      const alphabet = [2, 3, 5, 26, 200][seed % 5];
      const block = randomBlock(length, alphabet, seed);
      expectBwt(burrowsWheelerTransform(block, workspace), naiveRotationSort(block), `seed ${seed} length ${length} alphabet ${alphabet}`);
    }
  });

  it('matches the definition on blocks that are a word repeated, with the previous order of equal rotations', () => {
    const workspace = new BwtWorkspace();
    const words = ['a', 'ab', 'abc', 'abca', 'aab', 'abcdefg', 'xyxyz'];
    for (const word of words) {
      for (const repeats of [2, 3, 4, 5, 8, 13, 16, 17, 31, 64, 100]) {
        const block = repeatWord(word, word.length * repeats);
        expectBwt(burrowsWheelerTransform(block, workspace), prefixDoubling(block), `${word} x ${repeats}`);
      }
    }
  });

  it('matches the previous implementation on Fibonacci words and all-equal blocks of many lengths', () => {
    const workspace = new BwtWorkspace();
    for (const length of [2, 3, 5, 8, 13, 21, 100, 377, 1000, 4181, 10_946]) {
      expectBwt(burrowsWheelerTransform(fibonacciWord(length), workspace), prefixDoubling(fibonacciWord(length)), `fibonacci ${length}`);
      const equal = repeatWord('q', length);
      expectBwt(burrowsWheelerTransform(equal, workspace), prefixDoubling(equal), `all-equal ${length}`);
    }
  });

  it('matches the previous implementation on realistic text above the wrap length (the fast path)', () => {
    const block = new Uint8Array(proseText(WRAP_EXTENSION + 9000, 71));
    expectBwt(burrowsWheelerTransform(block), prefixDoubling(block), 'prose just above the wrap length');
  });

  it('falls back to the full doubled sort when a repeat is longer than the wrap length, and still matches', () => {
    // 3000 random bytes occur three times, so neighbouring rotations agree for far longer than the lowered wrap length.
    const unit = randomBlock(3000, 200, 5);
    const filler = proseText(4000, 6);
    const block = Buffer.concat([unit, filler.subarray(0, 700), unit, filler.subarray(700, 2500), unit, filler.subarray(2500)]);
    const lowWrap = 256;
    expectBwt(burrowsWheelerTransform(block, new BwtWorkspace(), lowWrap), prefixDoubling(block), 'long repeats, wrap 256');
    expectBwt(burrowsWheelerTransform(block, new BwtWorkspace(), 1 << 16), prefixDoubling(block), 'long repeats, wrap above block');
  });

  it('keeps the fast path for text with only short repeats and agrees with the previous implementation', () => {
    const block = new Uint8Array(proseText(40_000, 9));
    expectBwt(burrowsWheelerTransform(block, new BwtWorkspace(), 512), prefixDoubling(block), 'prose, wrap 512');
  });

  it('reuses one workspace across blocks of different sizes without leaking state', () => {
    const workspace = new BwtWorkspace();
    const big = new Uint8Array(proseText(30_000, 3));
    const small = randomBlock(500, 4, 8);
    const first = burrowsWheelerTransform(big, workspace, 1000);
    burrowsWheelerTransform(small, workspace);
    expectBwt(burrowsWheelerTransform(big, workspace, 1000), first, 'second run on the same workspace');
    expectBwt(burrowsWheelerTransform(small, workspace), naiveRotationSort(small), 'small block after a big one');
  });

  it('rejects a block over the size limit with a RangeError', () => {
    expect(() => burrowsWheelerTransform({ length: 1 << 25 } as unknown as Uint8Array)).toThrow(RangeError);
  });

  it.skipIf(SKIP_TIMING)(
    `sorts a 900 kB block of repository source at least ${MIN_BWT_SPEEDUP}x faster than prefix doubling`,
    async () => {
      const block = new Uint8Array(repositorySource(4_000_000).subarray(2_000_000, 2_000_000 + BZIP2_BLOCK_BYTES));
      expect(block.length).toBe(BZIP2_BLOCK_BYTES);
      const workspace = new BwtWorkspace();
      await expectNoSlowerThanReference(
        'bwt of repository text',
        () => prefixDoubling(block),
        () => burrowsWheelerTransform(block, workspace),
        { maxRatio: 1 / MIN_BWT_SPEEDUP, passes: 3 }
      );
    },
    TEST_TIMEOUT_MS
  );

  it.skipIf(SKIP_TIMING)(
    'sorts a 900 kB all-equal block within 2x of the time of a random block',
    async () => {
      const equal = repeatWord('z', BZIP2_BLOCK_BYTES);
      const random = new SeededRandom(99).bytes(BZIP2_BLOCK_BYTES);
      const workspace = new BwtWorkspace();
      await expectNoSlowerThanReference(
        'all-equal against random block',
        () => burrowsWheelerTransform(random, workspace),
        () => burrowsWheelerTransform(equal, workspace),
        { maxRatio: 2, passes: 3 }
      );
    },
    TEST_TIMEOUT_MS
  );

  describe.each([
    ['fibonacci word', (n: number) => fibonacciWord(n)],
    ['period 2', (n: number) => repeatWord('ab', n - (n % 2))],
    ['all equal', (n: number) => repeatWord('x', n)],
    ['two letters, random', (n: number) => randomBlock(n, 2, 17)],
  ])('%s', (_name, build) => {
    it.skipIf(SKIP_TIMING)(
      'stays linear: 4x the block takes at most 8x the time',
      async () => {
        const small = build(150_000);
        const large = build(600_000);
        const workspace = new BwtWorkspace();
        await expectLinearOnInputs('bwt scaling', (block: Uint8Array) => burrowsWheelerTransform(block, workspace), { small, large, maxRatio: 8 });
      },
      SCALING_TEST_TIMEOUT_MS
    );
  });
});

describe('bzip2 streams from the encoder', () => {
  oracleTest('`bzip2 -t` accepts and `bzip2 -dc` restores repetitive and mixed blocks', ['bzip2'], () => {
    const bzip2 = getOracleToolPath('bzip2')!;
    const inputs: Array<[string, Uint8Array]> = [
      ['fibonacci 300k', fibonacciWord(300_000)],
      ['period 2, 250k', repeatWord('ab', 250_000)],
      ['all equal 100k', repeatWord('k', 100_000)],
      ['prose 200k', proseText(200_000, 41)],
      ['repeats longer than 16k', Buffer.concat([randomBlock(20_000, 200, 3), proseText(30_000, 4), randomBlock(20_000, 200, 3)])],
    ];
    for (const [name, data] of inputs) {
      const compressed = compressBzip2(Buffer.from(data));
      execFileSync(bzip2, ['-t'], { input: compressed });
      expect(execFileSync(bzip2, ['-dc'], { input: compressed, maxBuffer: 1 << 26 }).equals(Buffer.from(data)), name).toBe(true);
    }
  });
});

/**
 * Regression guard, not the speed target: the encoder measured about 3.5x the tool's time locally and 4.2x to 4.4x on
 * the CI runner, against about 6.6x before the rewrite. The issue's 3x speed-up (about 2.2x the tool) is not met yet.
 */
const MAX_BZIP2_TIME_RATIO = 5.5;

// skip-ok: explicit opt-out (ARCHIVE_SKIP_TIMING=1) of the timing ratios on a slow shared runner, never set in CI.
describe.skipIf(SKIP_TIMING)('bzip2 encoder throughput', () => {
  oracleTest(
    `compresses 2 MB of repository source in no more than ${MAX_BZIP2_TIME_RATIO}x the time of \`bzip2 -9\``,
    ['bzip2'],
    async () => {
      const bzip2 = getOracleToolPath('bzip2')!;
      const data = repositorySource(2 * 1024 * 1024);
      await expectNoSlowerThanReference(
        'compressBzip2 against bzip2 -9',
        () => execFileSync(bzip2, ['-9', '-c'], { input: data, maxBuffer: 1 << 26 }),
        () => compressBzip2(data),
        { maxRatio: MAX_BZIP2_TIME_RATIO, passes: 3 }
      );
    },
    TEST_TIMEOUT_MS
  );
});
