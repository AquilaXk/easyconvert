import { describe, expect, it } from 'vitest';
import { lmsListCapacity, POSITION_MASK, suffixSort } from '../src/lib/conversions/bzip2-suffix-sort';
import { SeededRandom } from './helpers/archive-corpus';

/**
 * The suffix sorter against the definition: the suffixes ordered by comparing them symbol by symbol, a suffix that is a
 * prefix of another first. The sorter is given arrays of exactly the size it documents, so a scratch array that was too
 * small would show as a wrong order (a typed array drops writes past its end).
 */

const TYPE_BIT = 0x80000000 | 0;
const BYTE_VALUES = 256;

function compareSuffixes(text: ArrayLike<number>, a: number, b: number): number {
  const n = text.length;
  let k = 0;
  while (a + k < n && b + k < n && text[a + k] === text[b + k]) k++;
  if (a + k === n) return -1;
  if (b + k === n) return 1;
  return text[a + k] - text[b + k];
}

function definitionOrder(text: ArrayLike<number>): number[] {
  return Array.from({ length: text.length }, (_, i) => i).sort((a, b) => compareSuffixes(text, a, b));
}

/** Entries of the sorter's suffix array, the type bit included. */
function sortedEntries(text: ArrayLike<number>, alphabet: number): Int32Array {
  const n = text.length;
  const symbols = Int32Array.from(text);
  const sa = new Int32Array(n);
  suffixSort(symbols, n, sa, alphabet, new Int32Array(lmsListCapacity(n)));
  return sa;
}

function positions(entries: Int32Array): number[] {
  return Array.from(entries, (entry) => entry & POSITION_MASK);
}

function expectSorted(text: ArrayLike<number>, alphabet: number, label: string): void {
  expect(positions(sortedEntries(text, alphabet)), label).toEqual(definitionOrder(text));
}

function allStrings(alphabet: number, length: number): number[][] {
  let strings: number[][] = [[]];
  for (let i = 0; i < length; i++) strings = strings.flatMap((s) => Array.from({ length: alphabet }, (_, symbol) => [...s, symbol]));
  return strings;
}

function fibonacciText(length: number): number[] {
  let previous = [0];
  let current = [0, 1];
  while (current.length < length) [previous, current] = [current, [...current, ...previous]];
  return current.slice(0, length);
}

function thueMorseText(length: number): number[] {
  return Array.from({ length }, (_, i) => {
    let bits = 0;
    for (let v = i; v > 0; v &= v - 1) bits++;
    return bits % 2;
  });
}

describe('suffix sort', () => {
  it('orders every string of up to 9 symbols over 3 symbols and of up to 13 over 2 as the definition does', () => {
    for (let length = 1; length <= 9; length++) {
      for (const text of allStrings(3, length)) expectSorted(text, 3, text.join(''));
    }
    for (let length = 10; length <= 13; length++) {
      for (const text of allStrings(2, length)) expectSorted(text, 2, text.join(''));
    }
  });

  it('orders random texts of many lengths over alphabets from 1 to 256 symbols', () => {
    const rng = new SeededRandom(2024);
    for (let trial = 0; trial < 400; trial++) {
      const length = 1 + rng.below(400);
      const alphabet = [1, 2, 3, 4, 8, 40, BYTE_VALUES][trial % 7];
      const text = Array.from({ length }, () => rng.below(alphabet));
      expectSorted(text, alphabet, `trial ${trial}: ${length} symbols over ${alphabet}`);
    }
  });

  it.each([
    ['all equal', (n: number) => new Array<number>(n).fill(7)],
    ['period 2', (n: number) => Array.from({ length: n }, (_, i) => i % 2)],
    ['period 3', (n: number) => Array.from({ length: n }, (_, i) => i % 3)],
    ['ascending', (n: number) => Array.from({ length: n }, (_, i) => i % BYTE_VALUES)],
    ['descending', (n: number) => Array.from({ length: n }, (_, i) => BYTE_VALUES - 1 - (i % BYTE_VALUES))],
    ['runs of growing length', (n: number) => Array.from({ length: n }, (_, i) => Math.floor(Math.sqrt(i)) % 3)],
    ['Fibonacci word', fibonacciText],
    ['Thue-Morse word', thueMorseText],
  ])('orders %s texts of sizes up to 2500, where every level of the recursion is as large as it can be', (_name, build) => {
    for (const length of [1, 2, 3, 4, 5, 8, 13, 100, 377, 1000, 2500]) expectSorted(build(length), BYTE_VALUES, `${_name} ${length}`);
  });

  it('puts a suffix that is a prefix of another before it, as if the text ended in a symbol smaller than all others', () => {
    // "banana": the suffixes a, ana, anana come in this order, and so do na and nana.
    expect(positions(sortedEntries([1, 0, 13, 0, 13, 0], 14))).toEqual([5, 3, 1, 0, 4, 2]);
  });

  it('flags each entry when the suffix before it is of type S (smaller than its successor), and never the first position', () => {
    const rng = new SeededRandom(7);
    for (let trial = 0; trial < 60; trial++) {
      const text = Array.from({ length: 2 + rng.below(300) }, () => rng.below(1 + (trial % 5)));
      const entries = sortedEntries(text, 5);
      entries.forEach((entry) => {
        const position = entry & POSITION_MASK;
        const beforeIsSmall = position > 0 && compareSuffixes(text, position - 1, position) < 0;
        expect((entry & TYPE_BIT) !== 0, `trial ${trial} position ${position}`).toBe(beforeIsSmall);
      });
    }
  });

  it('sorts a large random text into a permutation whose neighbours are in order', () => {
    const rng = new SeededRandom(11);
    const text = Array.from({ length: 300_000 }, () => rng.below(BYTE_VALUES));
    const order = positions(sortedEntries(text, BYTE_VALUES));
    expect(new Set(order).size).toBe(text.length);
    for (let i = 1; i < order.length; i++) {
      if (compareSuffixes(text, order[i - 1], order[i]) >= 0) expect.fail(`suffixes ${order[i - 1]} and ${order[i]} are out of order at row ${i}`);
    }
  });

  it('reuses its scratch arrays across texts without leaking state', () => {
    const sa = new Int32Array(500);
    const lms = new Int32Array(lmsListCapacity(500));
    const rng = new SeededRandom(5);
    for (let trial = 0; trial < 20; trial++) {
      const length = 50 + rng.below(450);
      const text = Array.from({ length }, () => rng.below(4));
      suffixSort(Int32Array.from(text), length, sa, 4, lms);
      expect(positions(sa.subarray(0, length))).toEqual(definitionOrder(text));
    }
  });
});
