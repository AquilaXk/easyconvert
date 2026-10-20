import { expect } from 'vitest';
import { SeededRandom } from './archive-corpus';

/**
 * Independent references for the bzip2 Burrows-Wheeler step: the transform's definition (a naive sort of the rotations),
 * the previous prefix-doubling implementation, and builders of the repetitive blocks that stress a suffix sorter. Nothing
 * here imports production code.
 */

const BYTE_VALUES = 256;

export interface Bwt {
  lColumn: Uint8Array;
  origPtr: number;
}

/** The transform's definition: sort the n rotations by comparing them byte by byte; equal rotations by ascending start. */
export function naiveRotationSort(block: Uint8Array): Bwt {
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
export function prefixDoubling(block: Uint8Array): Bwt {
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

export function repeatWord(word: string, length: number): Uint8Array {
  return Buffer.from(word.repeat(Math.ceil(length / word.length)).slice(0, length), 'latin1');
}

export function fibonacciWord(length: number): Uint8Array {
  let previous = 'a';
  let current = 'ab';
  while (current.length < length) {
    const next = current + previous;
    previous = current;
    current = next;
  }
  return Buffer.from(current.slice(0, length), 'latin1');
}

export function randomBlock(length: number, alphabet: number, seed: number): Uint8Array {
  const rng = new SeededRandom(seed);
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) out[i] = 97 + rng.below(alphabet);
  return out;
}

export function expectBwt(actual: Bwt, expected: Bwt, label: string): void {
  expect(actual.origPtr, `${label}: row of the unrotated block`).toBe(expected.origPtr);
  expect(Buffer.from(actual.lColumn).equals(Buffer.from(expected.lColumn)), `${label}: last column`).toBe(true);
}
