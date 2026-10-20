/**
 * Burrows-Wheeler transform for the bzip2 encoder: the suffix array of the block followed by a copy of its own start
 * (`bzip2-suffix-sort.ts`, linear-time induced sorting), from which the order of the block's cyclic rotations follows.
 *
 * Rotation i of block B is B[i..n) B[0..i), the length-n prefix of suffix i of the doubled block BB. Sorting all of BB
 * costs twice the time and memory the block needs, so the fast path appends only the first e = WRAP_EXTENSION bytes
 * (T = B B[0..e)) and checks the result: when every two neighbouring rotations in the sorted order differ within their
 * first e + 1 bytes, the suffix order of T equals the rotation order, because up to that position both rotations' bytes
 * lie inside the common valid prefix of their suffixes, so the first difference decides both orders; neighbours that
 * are strictly increasing make the whole list sorted. A block where two rotations agree for longer (a long repeat) is
 * sorted again over the full doubled block, where no rotation is a proper prefix of another.
 *
 * A block that is a word repeated n / d times has only d distinct rotations: it is sorted on the word alone and the
 * equal rotations are listed in the order the previous prefix-doubling implementation left them in, which keeps the
 * stream byte-identical (see `sortRotations`).
 *
 * Every path is linear in the block length: the induced sorting is linear, the neighbour check compares 16-bit window
 * hashes first and stops after VERIFY_BUDGET_PER_BYTE confirmed bytes per block byte, and the fallback is one more
 * linear sort. A block of one repeated byte or of period two costs far less than a random block; a Fibonacci block
 * takes the fallback.
 *
 * Memory: the workspace holds three 4-byte arrays of the sorted text's length (the text, the suffix array and the LMS
 * lists), n + WRAP_EXTENSION symbols on the fast path and 2n on the fallback (12.4 MB and 21.6 MB for a 900 kB block),
 * and 2 bytes per block byte of window hashes; it is allocated once per workspace and reused for every block.
 */

import { lmsListCapacity, POSITION_MASK, suffixSort } from './bzip2-suffix-sort';

const BYTE_VALUES = 256;
/** Largest block (in bytes) the transform accepts: bzip2 blocks are at most 900k, so this leaves a wide margin. */
export const BWT_MAX_BLOCK_BYTES = 1 << 24;

/** Scratch arrays reused from block to block; capacity grows to the largest block seen and never shrinks. */
export class BwtWorkspace {
  private text = new Int32Array(0);
  private suffixArray = new Int32Array(0);
  private lmsList = new Int32Array(0);
  private windowHashes = new Uint16Array(0);

  /** A text array, a suffix array and an LMS list sized for `length` symbols. */
  arrays(length: number): { text: Int32Array; suffixArray: Int32Array; lms: Int32Array } {
    if (this.text.length < length) {
      this.text = new Int32Array(length);
      this.suffixArray = new Int32Array(length);
      this.lmsList = new Int32Array(lmsListCapacity(length));
    }
    return { text: this.text.subarray(0, length), suffixArray: this.suffixArray.subarray(0, length), lms: this.lmsList };
  }

  /** An array of `length` 16-bit hash values. */
  hashes(length: number): Uint16Array {
    if (this.windowHashes.length < length) this.windowHashes = new Uint16Array(length);
    return this.windowHashes;
  }
}

/** True when `block` read cyclically is unchanged by a rotation of `shift` positions. */
function isRotationInvariant(block: Uint8Array, shift: number): boolean {
  const n = block.length;
  for (let i = 0; i + shift < n; i++) {
    if (block[i] !== block[i + shift]) return false;
  }
  return true;
}

/** Prime factors of `value`, each once, ascending. */
function distinctPrimeFactors(value: number): number[] {
  const factors: number[] = [];
  let rest = value;
  for (let factor = 2; factor * factor <= rest; factor++) {
    if (rest % factor !== 0) continue;
    factors.push(factor);
    while (rest % factor === 0) rest /= factor;
  }
  if (rest > 1) factors.push(rest);
  return factors;
}

/**
 * Length of the smallest period of `block` read cyclically, or `block.length` when the block is not periodic.
 * A block has a period p < n that divides n exactly when some n / q, for a prime factor q of n, is a period; those few
 * comparisons stop at the first mismatch, so the border table that finds the smallest period is built only for a block
 * that is periodic.
 */
function cyclicPeriod(block: Uint8Array): number {
  const n = block.length;
  if (!distinctPrimeFactors(n).some((factor) => isRotationInvariant(block, n / factor))) return n;
  const failure = new Int32Array(n);
  let k = 0;
  for (let i = 1; i < n; i++) {
    while (k > 0 && block[i] !== block[k]) k = failure[k - 1];
    if (block[i] === block[k]) k++;
    failure[i] = k;
  }
  return n - failure[n - 1];
}

export interface BwtResult {
  lColumn: Uint8Array;
  origPtr: number;
}

/** Bytes of the block's start appended to it on the fast path; also bounds how long a repeat the fast path accepts. */
export const WRAP_EXTENSION = 131_072;
/** The neighbour check gives up and the block is sorted over the doubled text after this many compared bytes per block byte. */
const VERIFY_BUDGET_PER_BYTE = 24;

/** Moves the starts below `n` to the front of `suffixArray`, in order, and returns that front (the rotation order). */
function rotationStarts(suffixArray: Int32Array, n: number): Int32Array {
  const positionMask = POSITION_MASK;
  let rows = 0;
  for (let i = 0; rows < n; i++) {
    const start = suffixArray[i] & positionMask;
    if (start < n) suffixArray[rows++] = start;
  }
  return suffixArray.subarray(0, n);
}

/**
 * Rotation start offsets in sorted order from the suffix array of `block + block[0..extension)`, or null when two
 * neighbouring rotations agree for longer than the extension (the order may then differ from the rotation order).
 */
function rotationsFromTruncated(block: Uint8Array, workspace: BwtWorkspace, extension: number): Int32Array | null {
  const n = block.length;
  const total = n + extension;
  const { text, suffixArray, lms } = workspace.arrays(total);
  text.set(block);
  for (let i = 0; i < extension; i++) text[n + i] = block[i];
  suffixSort(text, total, suffixArray, BYTE_VALUES, lms);
  const rotation = rotationStarts(suffixArray, n);
  return neighboursDifferWithin(text, n, rotation, extension, workspace) ? rotation : null;
}

const HASH_BASE = 0x9e3779b1;
/** The window hashes keep their top 16 bits: a wrong match costs one short byte comparison, and the table stays small. */
const HASH_SHIFT = 16;

/**
 * True when every pair of neighbouring rotations differs within its first `extension + 1` bytes. `text` holds the block
 * followed by its first `extension` bytes, which are all the bytes those prefixes read. A rolling polynomial hash of every
 * such prefix is compared first: different hashes prove that the prefixes differ, so most pairs cost one lookup. Equal
 * hashes are confirmed byte by byte, which settles both a real repeat (the check fails) and a hash collision (the pair
 * is fine); the byte comparisons are capped at VERIFY_BUDGET_PER_BYTE per block byte so that crafted collisions cannot
 * make the check expensive.
 */
function neighboursDifferWithin(text: Int32Array, n: number, rotation: Int32Array, extension: number, workspace: BwtWorkspace): boolean {
  const limit = extension + 1;
  // windowHash[i] is the top half of the polynomial hash of text[i..i+limit), rolled forward one position at a time.
  const windowHash = workspace.hashes(n);
  let hash = 0;
  let basePower = 1;
  for (let i = 0; i < limit; i++) {
    hash = (Math.imul(hash, HASH_BASE) + text[i] + 1) | 0;
    basePower = Math.imul(basePower, HASH_BASE);
  }
  windowHash[0] = hash >>> HASH_SHIFT;
  for (let i = 0; i + 1 < n; i++) {
    hash = (Math.imul(hash, HASH_BASE) + text[i + limit] - Math.imul(text[i] + 1, basePower) + 1) | 0;
    windowHash[i + 1] = hash >>> HASH_SHIFT;
  }
  let budget = VERIFY_BUDGET_PER_BYTE * n;
  let previousStart = rotation[0];
  let previousHash = windowHash[previousStart];
  for (let k = 1; k < n; k++) {
    const b = rotation[k];
    const hashOfB = windowHash[b];
    if (hashOfB === previousHash) {
      const a = previousStart;
      let q = 0;
      while (q < limit && text[a + q] === text[b + q]) q++;
      if (q === limit || text[a + q] > text[b + q]) return false;
      budget -= q + 1;
      if (budget < 0) return false;
    }
    previousStart = b;
    previousHash = hashOfB;
  }
  return true;
}

/** Rotation start offsets in sorted order from the suffix array of the doubled block; every rotation is distinct. */
function rotationsFromDoubled(block: Uint8Array, workspace: BwtWorkspace): Int32Array {
  const n = block.length;
  const total = 2 * n;
  const { text, suffixArray, lms } = workspace.arrays(total);
  text.set(block);
  text.set(block, n);
  suffixSort(text, total, suffixArray, BYTE_VALUES, lms);
  return rotationStarts(suffixArray, n);
}

/** Sorted rotation starts of a block whose rotations are all distinct (it is not a repetition of a shorter word). */
function sortDistinctRotations(block: Uint8Array, workspace: BwtWorkspace, wrapExtension: number): Int32Array {
  if (block.length > wrapExtension) {
    const candidate = rotationsFromTruncated(block, workspace, wrapExtension);
    if (candidate !== null) return candidate;
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
