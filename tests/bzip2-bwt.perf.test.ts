import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { burrowsWheelerTransform, BwtWorkspace, WRAP_EXTENSION } from '../src/lib/conversions/bzip2-bwt';
import { compressBzip2 } from '../src/lib/conversions/bzip2';
import { proseText, SeededRandom } from './helpers/archive-corpus';
import { getOracleToolPath } from './helpers/differential-oracle';
import { oracleTest } from './helpers/oracle-test';
import { expectLinearOnInputs, expectNoSlowerThanReference, SCALING_TEST_TIMEOUT_MS } from './helpers/timing';

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
const BYTE_VALUES = 256;
const BZIP2_BLOCK_BYTES = 899_981;
const REPO_ROOT = path.resolve(__dirname, '..');

interface Bwt {
  lColumn: Uint8Array;
  origPtr: number;
}

/** The transform's definition: sort the n rotations by comparing them byte by byte; equal rotations by ascending start. */
function naiveRotationSort(block: Uint8Array): Bwt {
  const n = block.length;
  const starts = Array.from({ length: n }, (_, i) => i);
  starts.sort((a, b) => {
    for (let k = 0; k < n; k++) {
      const x = block[(a + k) % n];
      const y = block[(b + k) % n];
      if (x !== y) return x - y;
    }
    return a - b;
  });
  const lColumn = new Uint8Array(n);
  let origPtr = 0;
  starts.forEach((start, row) => {
    if (start === 0) origPtr = row;
    lColumn[row] = block[(start + n - 1) % n];
  });
  return { lColumn, origPtr };
}

/** Prefix doubling over cyclic rotations with counting sorts: how the encoder sorted blocks before the linear-time rewrite. */
function prefixDoubling(block: Uint8Array): Bwt {
  const n = block.length;
  const lColumn = new Uint8Array(n);
  if (n === 1) {
    lColumn[0] = block[0];
    return { lColumn, origPtr: 0 };
  }
  let p = new Int32Array(n);
  const pn = new Int32Array(n);
  let c = new Int32Array(n);
  let cn = new Int32Array(n);
  const cnt = new Int32Array(Math.max(n, BYTE_VALUES));
  for (let i = 0; i < n; i++) cnt[block[i]]++;
  for (let i = 1; i < BYTE_VALUES; i++) cnt[i] += cnt[i - 1];
  for (let i = n - 1; i >= 0; i--) p[--cnt[block[i]]] = i;
  let classes = 1;
  c[p[0]] = 0;
  for (let i = 1; i < n; i++) {
    if (block[p[i]] !== block[p[i - 1]]) classes++;
    c[p[i]] = classes - 1;
  }
  for (let h = 1; h < n && classes < n; h *= 2) {
    for (let i = 0; i < n; i++) {
      const shifted = p[i] - h;
      pn[i] = shifted < 0 ? shifted + n : shifted;
    }
    cnt.fill(0, 0, classes);
    for (let i = 0; i < n; i++) cnt[c[pn[i]]]++;
    for (let i = 1; i < classes; i++) cnt[i] += cnt[i - 1];
    for (let i = n - 1; i >= 0; i--) p[--cnt[c[pn[i]]]] = pn[i];
    cn[p[0]] = 0;
    classes = 1;
    for (let i = 1; i < n; i++) {
      const curSecond = (p[i] + h) % n;
      const prevSecond = (p[i - 1] + h) % n;
      if (c[p[i]] !== c[p[i - 1]] || c[curSecond] !== c[prevSecond]) classes++;
      cn[p[i]] = classes - 1;
    }
    const swap = c;
    c = cn;
    cn = swap;
  }
  let origPtr = 0;
  for (let i = 0; i < n; i++) {
    const idx = p[i];
    if (idx === 0) origPtr = i;
    lColumn[i] = block[idx === 0 ? n - 1 : idx - 1];
  }
  return { lColumn, origPtr };
}

function repeatWord(word: string, length: number): Uint8Array {
  return Buffer.from(word.repeat(Math.ceil(length / word.length)).slice(0, length), 'latin1');
}

function fibonacciWord(length: number): Uint8Array {
  let previous = 'a';
  let current = 'ab';
  while (current.length < length) {
    const next = current + previous;
    previous = current;
    current = next;
  }
  return Buffer.from(current.slice(0, length), 'latin1');
}

function randomBlock(length: number, alphabet: number, seed: number): Uint8Array {
  const rng = new SeededRandom(seed);
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) out[i] = 97 + rng.below(alphabet);
  return out;
}

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

function expectBwt(actual: Bwt, expected: Bwt, label: string): void {
  expect(actual.origPtr, `${label}: row of the unrotated block`).toBe(expected.origPtr);
  expect(Buffer.from(actual.lColumn).equals(Buffer.from(expected.lColumn)), `${label}: last column`).toBe(true);
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
    'sorts a 900 kB block of repository source at least 2.5x faster than prefix doubling',
    async () => {
      const block = new Uint8Array(repositorySource(4_000_000).subarray(2_000_000, 2_000_000 + BZIP2_BLOCK_BYTES));
      expect(block.length).toBe(BZIP2_BLOCK_BYTES);
      const workspace = new BwtWorkspace();
      await expectNoSlowerThanReference(
        'bwt of repository text',
        () => prefixDoubling(block),
        () => burrowsWheelerTransform(block, workspace),
        { maxRatio: 1 / 2.5, passes: 3 }
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
