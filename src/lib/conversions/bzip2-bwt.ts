/**
 * Burrows-Wheeler transform for the bzip2 encoder: a linear-time suffix array by induced sorting (SA-IS; Nong, Zhang
 * and Chan, "Two Efficient Algorithms for Linear Time Suffix Array Construction", IEEE Trans. Computers 60(10), 2011)
 * over the block followed by a copy of its own start, from which the order of the block's cyclic rotations follows.
 *
 * Rotation i of block B is B[i..n) B[0..i), the length-n prefix of suffix i of the doubled block BB. Sorting all of BB
 * costs twice the time and memory the block needs, so the fast path appends only the first e = WRAP_EXTENSION bytes
 * (T = B B[0..e) $) and checks the result: when every two neighbouring rotations in the sorted order differ within their
 * first e + 1 bytes, the suffix order of T equals the rotation order, because up to that position both rotations' bytes
 * lie inside the common valid prefix of their suffixes, so the first difference decides both orders; neighbours that
 * are strictly increasing make the whole list sorted. A block where two rotations agree for longer (a long repeat) is
 * sorted again over the full doubled block, where no rotation is a proper prefix of another.
 *
 * A block that is a word repeated n / d times has only d distinct rotations: it is sorted on the word alone and the
 * equal rotations are listed in the order the previous prefix-doubling implementation left them in, which keeps the
 * stream byte-identical (see `sortRotations`).
 *
 * Every path is linear in the block length: the induced sorting is linear, the neighbour check compares hashes first
 * and stops after VERIFY_BUDGET_PER_BYTE confirmed bytes per block byte, and the fallback is one more linear sort. A
 * block of one repeated byte or of period two costs far less than a random block; a Fibonacci block takes the fallback.
 */

const BYTE_VALUES = 256;
/** The sentinel is symbol 0, so every byte is shifted up by one. */
const ALPHABET_WITH_SENTINEL = BYTE_VALUES + 1;
const EMPTY = -1;
/** Largest block (in bytes) the transform accepts: bzip2 blocks are at most 900k, so this leaves a wide margin. */
export const BWT_MAX_BLOCK_BYTES = 1 << 24;

/** Scratch arrays reused from block to block; capacity grows to the largest block seen and never shrinks. */
export class BwtWorkspace {
  private text = new Int32Array(0);
  private suffixArray = new Int32Array(0);

  /** A text array and a suffix array of exactly `length` symbols (the sentinel included). */
  arrays(length: number): { text: Int32Array; suffixArray: Int32Array } {
    if (this.text.length < length) {
      this.text = new Int32Array(length);
      this.suffixArray = new Int32Array(length);
    }
    return { text: this.text.subarray(0, length), suffixArray: this.suffixArray.subarray(0, length) };
  }
}

function bucketBounds(text: Int32Array, n: number, bucket: Int32Array, alphabet: number, ends: boolean): void {
  bucket.fill(0, 0, alphabet);
  for (let i = 0; i < n; i++) bucket[text[i]]++;
  let sum = 0;
  for (let i = 0; i < alphabet; i++) {
    sum += bucket[i];
    bucket[i] = ends ? sum : sum - bucket[i];
  }
}

function induceLarge(text: Int32Array, sa: Int32Array, n: number, isSmall: Uint8Array, bucket: Int32Array, alphabet: number): void {
  bucketBounds(text, n, bucket, alphabet, false);
  for (let i = 0; i < n; i++) {
    const suffix = sa[i];
    if (suffix > 0) {
      const prev = suffix - 1;
      if (isSmall[prev] === 0) sa[bucket[text[prev]]++] = prev;
    }
  }
}

function induceSmall(text: Int32Array, sa: Int32Array, n: number, isSmall: Uint8Array, bucket: Int32Array, alphabet: number): void {
  bucketBounds(text, n, bucket, alphabet, true);
  for (let i = n - 1; i >= 0; i--) {
    const suffix = sa[i];
    if (suffix > 0) {
      const prev = suffix - 1;
      if (isSmall[prev] === 1) sa[--bucket[text[prev]]] = prev;
    }
  }
}

/**
 * Suffix array of `text[0..n)` into `sa[0..n)`. `text` holds symbols in [0, alphabet) and ends with a sentinel 0 that
 * occurs nowhere else. Recursion depth is at most log2(n): each level works on at most half the symbols of the last.
 */
function induceSort(text: Int32Array, sa: Int32Array, n: number, alphabet: number): void {
  if (n === 1) {
    sa[0] = 0;
    return;
  }
  // Suffix types: 1 = S (smaller than its successor), 0 = L. The sentinel is S, the symbol before it is L.
  const isSmall = new Uint8Array(n);
  isSmall[n - 1] = 1;
  for (let i = n - 2; i >= 0; i--) {
    const here = text[i];
    const next = text[i + 1];
    isSmall[i] = here < next || (here === next && isSmall[i + 1] === 1) ? 1 : 0;
  }
  const bucket = new Int32Array(alphabet);

  // Stage 1: sort the LMS substrings by one induced pass from their (arbitrarily ordered) bucket ends.
  bucketBounds(text, n, bucket, alphabet, true);
  sa.fill(EMPTY, 0, n);
  let lmsCount = 0;
  for (let i = 1; i < n; i++) {
    if (isSmall[i] === 1 && isSmall[i - 1] === 0) {
      sa[--bucket[text[i]]] = i;
      lmsCount++;
    }
  }
  induceLarge(text, sa, n, isSmall, bucket, alphabet);
  induceSmall(text, sa, n, isSmall, bucket, alphabet);

  // Gather the sorted LMS substrings at the front and give equal substrings equal names.
  let sorted = 0;
  for (let i = 0; i < n; i++) {
    const pos = sa[i];
    if (pos > 0 && isSmall[pos] === 1 && isSmall[pos - 1] === 0) sa[sorted++] = pos;
  }
  sa.fill(EMPTY, sorted, n);
  let names = 0;
  let previous = EMPTY;
  for (let i = 0; i < sorted; i++) {
    const pos = sa[i];
    let different = previous === EMPTY;
    if (!different) {
      for (let d = 0; ; d++) {
        if (text[pos + d] !== text[previous + d] || isSmall[pos + d] !== isSmall[previous + d]) {
          different = true;
          break;
        }
        if (d > 0 && ((isSmall[pos + d] === 1 && isSmall[pos + d - 1] === 0) || (isSmall[previous + d] === 1 && isSmall[previous + d - 1] === 0))) break;
      }
    }
    if (different) {
      names++;
      previous = pos;
    }
    sa[sorted + (pos >> 1)] = names - 1;
  }
  for (let i = n - 1, j = n - 1; i >= sorted; i--) {
    if (sa[i] >= 0) sa[j--] = sa[i];
  }

  // Stage 2: the order of the LMS suffixes is the suffix array of the reduced string of names.
  const reduced = sa.subarray(n - lmsCount, n);
  const reducedSa = sa.subarray(0, lmsCount);
  if (names < lmsCount) {
    induceSort(reduced, reducedSa, lmsCount, names);
  } else {
    for (let i = 0; i < lmsCount; i++) reducedSa[reduced[i]] = i;
  }

  // Stage 3: place the LMS suffixes in their final order and induce the rest.
  bucketBounds(text, n, bucket, alphabet, true);
  for (let i = 1, j = 0; i < n; i++) {
    if (isSmall[i] === 1 && isSmall[i - 1] === 0) reduced[j++] = i;
  }
  for (let i = 0; i < lmsCount; i++) reducedSa[i] = reduced[reducedSa[i]];
  sa.fill(EMPTY, lmsCount, n);
  for (let i = lmsCount - 1; i >= 0; i--) {
    const pos = sa[i];
    sa[i] = EMPTY;
    sa[--bucket[text[pos]]] = pos;
  }
  induceLarge(text, sa, n, isSmall, bucket, alphabet);
  induceSmall(text, sa, n, isSmall, bucket, alphabet);
}

/** Length of the smallest period of `block` read cyclically, or `block.length` when the block is not periodic. */
function cyclicPeriod(block: Uint8Array): number {
  const n = block.length;
  const failure = new Int32Array(n);
  let k = 0;
  for (let i = 1; i < n; i++) {
    while (k > 0 && block[i] !== block[k]) k = failure[k - 1];
    if (block[i] === block[k]) k++;
    failure[i] = k;
  }
  const period = n - failure[n - 1];
  return n % period === 0 ? period : n;
}

export interface BwtResult {
  lColumn: Uint8Array;
  origPtr: number;
}

/** Bytes of the block's start appended to it on the fast path; also bounds how long a repeat the fast path accepts. */
export const WRAP_EXTENSION = 131_072;
/** The neighbour check gives up and the block is sorted over the doubled text after this many compared bytes per block byte. */
const VERIFY_BUDGET_PER_BYTE = 24;

/** Rotation start offsets in sorted order from the suffix array of `block + block[0..extension) + sentinel`. */
function rotationsFromTruncated(block: Uint8Array, workspace: BwtWorkspace, extension: number): Int32Array {
  const n = block.length;
  const total = n + extension + 1;
  const { text, suffixArray } = workspace.arrays(total);
  for (let i = 0; i < n; i++) text[i] = block[i] + 1;
  for (let i = 0; i < extension; i++) text[n + i] = block[i] + 1;
  text[total - 1] = 0;
  induceSort(text, suffixArray, total, ALPHABET_WITH_SENTINEL);
  const rotation = new Int32Array(n);
  let rows = 0;
  for (let i = 0; i < total; i++) {
    const start = suffixArray[i];
    if (start < n) rotation[rows++] = start;
  }
  return rotation;
}

const HASH_BASE = 0x9e3779b1;

/**
 * True when every pair of neighbouring rotations differs within its first `extension + 1` bytes. A polynomial hash of
 * every such prefix is compared first: different hashes prove that the prefixes differ, so most pairs cost two
 * lookups. Equal hashes are confirmed byte by byte, which settles both a real repeat (the check fails) and a hash
 * collision (the pair is fine); the byte comparisons are capped at VERIFY_BUDGET_PER_BYTE per block byte so that
 * crafted collisions cannot make the check expensive.
 */
function neighboursDifferWithin(block: Uint8Array, rotation: Int32Array, extension: number): boolean {
  const n = block.length;
  const limit = extension + 1;
  const wrapped = new Uint8Array(n + limit);
  wrapped.set(block, 0);
  wrapped.set(block.subarray(0, limit), n);
  // prefixHash[i] hashes wrapped[0..i); the hash of wrapped[a..a+limit) is prefixHash[a+limit] - prefixHash[a] * base^limit.
  const prefixHash = new Int32Array(n + limit + 1);
  let h = 0;
  for (let i = 0; i < n + limit; i++) {
    h = (Math.imul(h, HASH_BASE) + wrapped[i] + 1) | 0;
    prefixHash[i + 1] = h;
  }
  let basePower = 1;
  for (let i = 0; i < limit; i++) basePower = Math.imul(basePower, HASH_BASE);
  let budget = VERIFY_BUDGET_PER_BYTE * n;
  let previousStart = rotation[0];
  let previousHash = (prefixHash[previousStart + limit] - Math.imul(prefixHash[previousStart], basePower)) | 0;
  for (let k = 1; k < n; k++) {
    const b = rotation[k];
    const hash = (prefixHash[b + limit] - Math.imul(prefixHash[b], basePower)) | 0;
    if (hash === previousHash) {
      const a = previousStart;
      let q = 0;
      while (q < limit && wrapped[a + q] === wrapped[b + q]) q++;
      if (q === limit || wrapped[a + q] > wrapped[b + q]) return false;
      budget -= q + 1;
      if (budget < 0) return false;
    }
    previousStart = b;
    previousHash = hash;
  }
  return true;
}

/** Rotation start offsets in sorted order from the suffix array of the doubled block; every rotation is distinct. */
function rotationsFromDoubled(block: Uint8Array, workspace: BwtWorkspace): Int32Array {
  const n = block.length;
  const total = 2 * n + 1;
  const { text, suffixArray } = workspace.arrays(total);
  for (let i = 0; i < n; i++) {
    const symbol = block[i] + 1;
    text[i] = symbol;
    text[i + n] = symbol;
  }
  text[2 * n] = 0;
  induceSort(text, suffixArray, total, ALPHABET_WITH_SENTINEL);
  const rotation = new Int32Array(n);
  let rows = 0;
  for (let i = 0; i < total && rows < n; i++) {
    const start = suffixArray[i];
    if (start < n) rotation[rows++] = start;
  }
  return rotation;
}

/** Sorted rotation starts of a block whose rotations are all distinct (it is not a repetition of a shorter word). */
function sortDistinctRotations(block: Uint8Array, workspace: BwtWorkspace, wrapExtension: number): Int32Array {
  if (block.length > wrapExtension) {
    const candidate = rotationsFromTruncated(block, workspace, wrapExtension);
    if (neighboursDifferWithin(block, candidate, wrapExtension)) return candidate;
  }
  return rotationsFromDoubled(block, workspace);
}

/**
 * Smallest r with 2^r >= n, the number of passes the original prefix-doubling sort made over a block of n bytes.
 * Those passes shifted equal rotations by 2^r - 1 positions in total (modulo n), which fixed the order of equal rotations.
 */
function doublingPasses(n: number): number {
  return 32 - Math.clz32(n - 1);
}

/**
 * Sorted rotation starts of any block. A block that is a word repeated n / d times has only d distinct rotations; those
 * are sorted on the word alone. The n / d starts that share one rotation are then listed in the order that
 * `(start + 2^r - 1) mod n` ascends, with r = doublingPasses(n): this reproduces the order the previous prefix-doubling
 * sort left equal rotations in, so the stream (and the row of the unrotated block that it records) is unchanged.
 * Any order of equal rotations is a valid bzip2 stream; keeping this one keeps the output byte-identical.
 */
function sortRotations(block: Uint8Array, workspace: BwtWorkspace, wrapExtension: number): Int32Array {
  const n = block.length;
  const period = cyclicPeriod(block);
  if (period === n) return sortDistinctRotations(block, workspace, wrapExtension);
  const wordRotations = sortDistinctRotations(block.subarray(0, period), workspace, wrapExtension);
  const rotation = new Int32Array(n);
  const repeats = n / period;
  // Starts at or after n - shift sort first: their shifted key wraps around to a small value.
  const shift = (2 ** doublingPasses(n) - 1) % n;
  const wrapFrom = n - shift;
  let row = 0;
  for (let i = 0; i < period; i++) {
    const first = wordRotations[i];
    const firstWrapped = Math.min(repeats, Math.max(0, Math.ceil((wrapFrom - first) / period)));
    for (let r = firstWrapped; r < repeats; r++) rotation[row++] = first + r * period;
    for (let r = 0; r < firstWrapped; r++) rotation[row++] = first + r * period;
  }
  return rotation;
}

/**
 * Sorts the cyclic rotations of `block` and returns the last column and the row of the unrotated block. Rotations that
 * are equal (a block that repeats with a period dividing its length) keep the order described at `sortRotations`.
 * `wrapExtension` is the fast path's wrap length; tests lower it to exercise the fallback on small blocks.
 */
export function burrowsWheelerTransform(
  block: Uint8Array,
  workspace: BwtWorkspace = new BwtWorkspace(),
  wrapExtension: number = WRAP_EXTENSION
): BwtResult {
  const n = block.length;
  if (n > BWT_MAX_BLOCK_BYTES) throw new RangeError(`BWT block of ${n} bytes exceeds ${BWT_MAX_BLOCK_BYTES}`);
  const lColumn = new Uint8Array(n);
  if (n === 0) return { lColumn, origPtr: 0 };
  if (n === 1) {
    lColumn[0] = block[0];
    return { lColumn, origPtr: 0 };
  }

  const rotation = sortRotations(block, workspace, wrapExtension);
  let origPtr = 0;
  for (let i = 0; i < n; i++) {
    const start = rotation[i];
    if (start === 0) origPtr = i;
    lColumn[i] = block[start === 0 ? n - 1 : start - 1];
  }
  return { lColumn, origPtr };
}
