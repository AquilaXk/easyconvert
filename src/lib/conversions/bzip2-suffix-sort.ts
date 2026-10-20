/**
 * Suffix sorting by induced sorting (SA-IS; Nong, Zhang and Chan, "Two Efficient Algorithms for Linear Time Suffix Array
 * Construction", IEEE Trans. Computers 60(10), 2011), arranged the way the fastest implementations of the last decade
 * arrange it (the libsais and divsufsort designs):
 *  - the end of the text is a virtual sentinel, smaller than every symbol, so no symbol is spent on it;
 *  - an entry of the suffix array carries one extra bit, the type of the suffix before it, which is known when the entry
 *    is written (from two neighbouring symbols that one cache line holds). The induction passes then read the text once
 *    per entry and need no array of suffix types;
 *  - the positions of the LMS suffixes are listed once, by the scan that finds them, so the later stages never rescan the
 *    text to find them again.
 *
 * Cost: linear time. Memory beyond the text and the suffix array (4 bytes per symbol each): the LMS lists of all levels
 * (together at most 4 bytes per symbol) and three tables of one entry per distinct symbol for each level. Recursion
 * depth is at most log2(n): each level works on at most half the symbols of the level above.
 */

/** Bit 31 of a suffix array entry: set when the suffix before the entry's suffix is of type S. */
const BEFORE_IS_SMALL = -0x80000000;
/** The position stored in an entry, without the type bit. */
export const POSITION_MASK = 0x7fffffff;

/** Entries of the LMS list `suffixSort` needs for a text of `length` symbols: the lists of all levels together. */
export function lmsListCapacity(length: number): number {
  return length;
}

/** The symbol counts of one level and the bucket pointers that the induction passes move. */
interface Buckets {
  alphabet: number;
  /** Occurrences of each symbol. */
  counts: Int32Array;
  /** Occurrences of each symbol as an L suffix (one that is larger than its successor). */
  largeCounts: Int32Array;
  /** Next free slot of each bucket, set by `startPointers` or `endPointers`. */
  pointers: Int32Array;
}

function startPointers({ alphabet, counts, pointers }: Buckets): void {
  let sum = 0;
  for (let symbol = 0; symbol < alphabet; symbol++) {
    pointers[symbol] = sum;
    sum += counts[symbol];
  }
}

function endPointers({ alphabet, counts, pointers }: Buckets): void {
  let sum = 0;
  for (let symbol = 0; symbol < alphabet; symbol++) {
    sum += counts[symbol];
    pointers[symbol] = sum;
  }
}

/** Entry for the L suffix `position`: its type bit says whether the suffix before it is S. */
function largeEntry(text: Int32Array, position: number, symbol: number): number {
  return position > 0 && text[position - 1] < symbol ? position | BEFORE_IS_SMALL : position;
}

/** Entry for the S suffix `position`: its type bit says whether the suffix before it is S. */
function smallEntry(text: Int32Array, position: number, symbol: number): number {
  return position > 0 && text[position - 1] <= symbol ? position | BEFORE_IS_SMALL : position;
}

/** Places the L suffixes: the suffix before the sentinel first, then every suffix that an entry without the type bit induces. */
function induceLarge(text: Int32Array, n: number, sa: Int32Array, pointers: Int32Array): void {
  const last = n - 1;
  const lastSymbol = text[last];
  sa[pointers[lastSymbol]++] = largeEntry(text, last, lastSymbol);
  for (let i = 0; i < n; i++) {
    const entry = sa[i];
    if (entry > 0) {
      const prev = entry - 1;
      const symbol = text[prev];
      sa[pointers[symbol]++] = largeEntry(text, prev, symbol);
    }
  }
}

/** Places the S suffixes: every entry with the type bit induces the suffix before it, scanning from the end. */
function induceSmall(text: Int32Array, n: number, sa: Int32Array, pointers: Int32Array): void {
  for (let i = n - 1; i >= 0; i--) {
    const entry = sa[i];
    if (entry < 0) {
      const prev = (entry & POSITION_MASK) - 1;
      const symbol = text[prev];
      sa[--pointers[symbol]] = smallEntry(text, prev, symbol);
    }
  }
}

/**
 * Sorts the suffixes of `text[0..n)` (n >= 1, symbols in [0, alphabet)) into `sa[0..n)`. A suffix that is a prefix of
 * another sorts before it. Every entry of the result may carry the type bit: read a position with `& POSITION_MASK`.
 * `sa` has room for n entries and `lms` for `lmsListCapacity(n)`.
 */
export function suffixSort(text: Int32Array, n: number, sa: Int32Array, alphabet: number, lms: Int32Array): void {
  if (n === 1) {
    sa[0] = 0;
    return;
  }
  const buckets: Buckets = {
    alphabet,
    counts: new Int32Array(alphabet),
    largeCounts: new Int32Array(alphabet),
    pointers: new Int32Array(alphabet),
  };
  const { counts, largeCounts, pointers } = buckets;
  for (let i = 0; i < n; i++) counts[text[i]]++;

  // Scan from the end for the LMS positions (an S suffix after an L suffix); list them from the last to the first and
  // seed them at the ends of their buckets. The last suffix is L: only the sentinel follows it.
  endPointers(buckets);
  sa.fill(0, 0, n);
  let lmsCount = 0;
  let isSmall = false;
  let next = text[n - 1];
  largeCounts[next]++;
  for (let i = n - 2; i >= 0; i--) {
    const symbol = text[i];
    if (symbol < next || (symbol === next && isSmall)) {
      isSmall = true;
    } else {
      if (isSmall) {
        sa[--pointers[next]] = i + 1;
        lms[lmsCount++] = i + 1;
      }
      isSmall = false;
      largeCounts[symbol]++;
    }
    next = symbol;
  }

  if (lmsCount > 1) seedLmsSuffixesSorted(text, n, sa, lms, lmsCount, buckets);

  startPointers(buckets);
  induceLarge(text, n, sa, pointers);
  endPointers(buckets);
  induceSmall(text, n, sa, pointers);
}

/** Moves the sorted LMS entries to the front of `sa`: they are the entries of each bucket's S range that have no type bit. */
function gatherLmsEntries(sa: Int32Array, { alphabet, counts, largeCounts }: Buckets): void {
  let gathered = 0;
  let end = 0;
  for (let symbol = 0; symbol < alphabet; symbol++) {
    end += counts[symbol];
    for (let i = end - counts[symbol] + largeCounts[symbol]; i < end; i++) {
      const entry = sa[i];
      if (entry > 0) sa[gathered++] = entry;
    }
  }
}

/**
 * Names the sorted LMS substrings, equal ones alike, at `sa[lmsCount + position / 2]`, and returns the number of names.
 * An LMS substring runs from an LMS position to the next one, itself included; the last one runs to the sentinel and is
 * unique. LMS positions are at least two apart, so the halved positions are distinct. `lms` lists the positions from the
 * last, so the length of the substring at lms[k] is lms[k - 1] - lms[k] + 1.
 */
function nameLmsSubstrings(text: Int32Array, sa: Int32Array, lms: Int32Array, lmsCount: number): number {
  const room = lmsCount;
  sa[room + (lms[0] >> 1)] = 0;
  for (let k = 1; k < lmsCount; k++) sa[room + (lms[k] >> 1)] = lms[k - 1] - lms[k] + 1;
  let names = 0;
  let previous = 0;
  let previousLength = -1;
  for (let i = 0; i < lmsCount; i++) {
    const position = sa[i];
    const length = sa[room + (position >> 1)];
    let different = length !== previousLength;
    for (let d = 0; !different && d < length; d++) different = text[position + d] !== text[previous + d];
    if (different) {
      names++;
      previous = position;
      previousLength = length;
    }
    sa[room + (position >> 1)] = names - 1;
  }
  return names;
}

/**
 * Leaves the LMS suffixes in sorted order at the ends of their buckets and nothing else in `sa`: sorts the LMS substrings
 * by one induced pass from the unordered seeds, names them, takes the suffix array of the names, and seeds again.
 */
function seedLmsSuffixesSorted(text: Int32Array, n: number, sa: Int32Array, lms: Int32Array, lmsCount: number, buckets: Buckets): void {
  startPointers(buckets);
  induceLarge(text, n, sa, buckets.pointers);
  endPointers(buckets);
  induceSmall(text, n, sa, buckets.pointers);
  gatherLmsEntries(sa, buckets);
  const names = nameLmsSubstrings(text, sa, lms, lmsCount);

  // The reduced string: the names in text order, at the end of `sa`. It overlaps the room the names were written in, but
  // the k-th name is read from a slot below the one it is written to, and a slot is written only after the names that
  // lived in it were read (the positions are at least two apart, so there are at most (n - 1) / 2 of them).
  const reduced = sa.subarray(n - lmsCount, n);
  for (let k = 0; k < lmsCount; k++) reduced[lmsCount - 1 - k] = sa[lmsCount + (lms[k] >> 1)];

  // The order of the LMS suffixes is the suffix array of the reduced string.
  const reducedSa = sa.subarray(0, lmsCount);
  if (names < lmsCount) {
    suffixSort(reduced, lmsCount, reducedSa, names, lms.subarray(lmsCount));
  } else {
    for (let i = 0; i < lmsCount; i++) reducedSa[reduced[i]] = i;
  }

  // Seed the LMS suffixes in that order, the largest first, so the smallest ends up first in its bucket.
  for (let j = 0; j < lmsCount; j++) sa[j] = lms[lmsCount - 1 - (sa[j] & POSITION_MASK)];
  sa.fill(0, lmsCount, n);
  endPointers(buckets);
  const { pointers } = buckets;
  for (let j = lmsCount - 1; j >= 0; j--) {
    const position = sa[j];
    sa[j] = 0;
    sa[--pointers[text[position]]] = position;
  }
}
