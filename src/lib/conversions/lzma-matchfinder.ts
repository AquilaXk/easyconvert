import * as model from './lzma-model';

// Hoisted: under a CommonJS loader an imported binding is a getter call on every use.
const MATCH_LEN_MAX = model.MATCH_LEN_MAX;

/**
 * Binary-tree match finder for the LZMA encoder ("bt4"): positions that share a four-byte hash are kept in a binary
 * search tree ordered by the bytes that follow, so one descent yields the longest match at every distance that improves
 * on the last, in increasing length. Two direct tables answer the short cases a four-byte hash cannot: the nearest
 * earlier position with the same two bytes, and the same three bytes. The tree search is cut off after `depth` steps.
 *
 * The whole input is addressed directly (it is the dictionary), so a position is an index into `data`; the tree nodes
 * of position p live at (p mod cyclic) so that memory is bounded by the dictionary size, not the input size.
 */

const HASH2_BITS = 16;
const HASH3_BITS = 16;
const HASH4_BITS_MIN = 16;
const HASH4_BITS_MAX = 24;
const HASH_MULTIPLIER = 0x9e3779b1;
const NIL = 0;
/** Smallest dictionary the finder serves; the encoder never asks for less (the LZMA minimum is 4 KiB). */
const SPAN_MIN = 2;

/** Bytes the finder's tables take for a dictionary and an input length, used to refuse a level before allocating. */
export function matchFinderMemoryBytes(dictSize: number, inputLength: number): number {
  const cyclic = Math.min(dictSize, inputLength) + 1;
  const hash4Bits = hash4BitsFor(dictSize, inputLength);
  return (cyclic * 2 + (1 << hash4Bits) + (1 << HASH2_BITS) + (1 << HASH3_BITS)) * Int32Array.BYTES_PER_ELEMENT;
}

function hash4BitsFor(dictSize: number, inputLength: number): number {
  const span = Math.max(SPAN_MIN, Math.min(dictSize, inputLength));
  return Math.max(HASH4_BITS_MIN, Math.min(HASH4_BITS_MAX, 32 - Math.clz32(span)));
}

export class LzmaMatchFinder {
  /** Match lengths found at the last position, strictly increasing. */
  readonly lengths = new Uint32Array(MATCH_LEN_MAX);
  /** Zero-based distances (distance - 1) of those matches. */
  readonly distances = new Uint32Array(MATCH_LEN_MAX);
  /** Next position to be processed by `findMatches` / `skip`. */
  position = 0;

  /** position mod cyclic, kept incrementally so the tree search never divides. */
  private cyclicPosition = 0;
  private readonly data: Uint8Array;
  private readonly size: number;
  private readonly dictSize: number;
  private readonly depth: number;
  private readonly niceLength: number;
  private readonly cyclic: number;
  private readonly hash4Shift: number;
  private readonly hash2 = new Int32Array(1 << HASH2_BITS);
  private readonly hash3 = new Int32Array(1 << HASH3_BITS);
  private readonly hash4: Int32Array;
  private readonly son: Int32Array;

  constructor(data: Uint8Array, dictSize: number, niceLength: number, depth: number) {
    this.data = data;
    this.size = data.length;
    this.dictSize = dictSize;
    this.depth = depth;
    this.niceLength = Math.min(niceLength, MATCH_LEN_MAX);
    this.cyclic = Math.min(dictSize, data.length) + 1;
    const bits = hash4BitsFor(dictSize, data.length);
    this.hash4Shift = 32 - bits;
    this.hash4 = new Int32Array(1 << bits);
    this.son = new Int32Array(this.cyclic * 2);
  }

  /** Longest common prefix of the data at a and b, at most `limit` bytes. */
  private commonLength(a: number, b: number, limit: number): number {
    const d = this.data;
    let n = 0;
    while (n < limit && d[a + n] === d[b + n]) n++;
    return n;
  }

  /**
   * Collects the matches at the current position into `lengths` / `distances` and moves to the next position.
   * Returns how many were found. Candidates are positions strictly before the current one, within the dictionary.
   */
  findMatches(): number {
    const p = this.position++;
    const cyclicPos = this.cyclicPosition;
    this.cyclicPosition = cyclicPos + 1 === this.cyclic ? 0 : cyclicPos + 1;
    const d = this.data;
    const avail = Math.min(MATCH_LEN_MAX, this.size - p);
    if (avail < 2) return 0;
    const lengths = this.lengths;
    const distances = this.distances;
    let count = 0;
    let bestLen = 1;
    const dictSize = this.dictSize;

    const b0 = d[p];
    const b1 = d[p + 1];
    const h2 = b0 | (b1 << 8);
    const cand2 = this.hash2[h2] - 1;
    this.hash2[h2] = p + 1;
    if (cand2 >= 0 && p - cand2 <= dictSize) {
      // The two-byte table is exact: the candidate shares both bytes.
      lengths[count] = 2;
      distances[count] = p - cand2 - 1;
      count++;
      bestLen = 2;
    }
    if (avail < 3) return count;

    const b2 = d[p + 2];
    const h3 = Math.imul(b0 | (b1 << 8) | (b2 << 16), HASH_MULTIPLIER) >>> (32 - HASH3_BITS);
    const cand3 = this.hash3[h3] - 1;
    this.hash3[h3] = p + 1;
    if (cand3 >= 0 && p - cand3 <= dictSize && d[cand3] === b0 && d[cand3 + 1] === b1 && d[cand3 + 2] === b2) {
      if (bestLen < 3) {
        const len = 3 + this.commonLength(cand3 + 3, p + 3, avail - 3);
        // The three-byte hit is worth reporting when it beats the two-byte one; a longer tree match replaces it below.
        lengths[count] = len;
        distances[count] = p - cand3 - 1;
        count++;
        bestLen = len;
      }
    }
    if (avail < 4) return count;

    const word = b0 | (b1 << 8) | (b2 << 16) | (d[p + 3] << 24);
    const h4 = Math.imul(word, HASH_MULTIPLIER) >>> this.hash4Shift;
    let cur = this.hash4[h4] - 1;
    this.hash4[h4] = p + 1;

    const son = this.son;
    const cyclic = this.cyclic;
    let leftSlot = cyclicPos * 2; // where the "smaller" subtree pointer is written
    let rightSlot = leftSlot + 1; // where the "larger" subtree pointer is written
    let lenLow = 0;
    let lenHigh = 0;
    let steps = this.depth;
    const nice = Math.min(this.niceLength, avail);
    while (cur >= 0 && steps-- > 0 && p - cur <= dictSize) {
      let len = lenLow < lenHigh ? lenLow : lenHigh;
      len += this.commonLength(cur + len, p + len, avail - len);
      let nodeIndex = cyclicPos - (p - cur);
      if (nodeIndex < 0) nodeIndex += cyclic;
      const node = nodeIndex * 2;
      if (len > bestLen) {
        bestLen = len;
        lengths[count] = len;
        distances[count] = p - cur - 1;
        count++;
        if (len >= nice) {
          // Splice the new position in place of the candidate: both its subtrees move under the new node.
          son[leftSlot] = son[node];
          son[rightSlot] = son[node + 1];
          return count;
        }
      }
      if (d[cur + len] < d[p + len]) {
        // The candidate's string is smaller than the current one: it joins the smaller side.
        son[leftSlot] = cur + 1;
        leftSlot = node + 1;
        cur = son[leftSlot] - 1;
        lenLow = len;
      } else {
        son[rightSlot] = cur + 1;
        rightSlot = node;
        cur = son[rightSlot] - 1;
        lenHigh = len;
      }
    }
    son[leftSlot] = NIL;
    son[rightSlot] = NIL;
    return count;
  }

  /** Inserts the next `n` positions into the tables without collecting matches (the bytes of a chosen match). */
  skip(n: number): void {
    for (let i = 0; i < n; i++) this.insertOnly();
  }

  private insertOnly(): void {
    const p = this.position++;
    const cyclicPos = this.cyclicPosition;
    this.cyclicPosition = cyclicPos + 1 === this.cyclic ? 0 : cyclicPos + 1;
    const d = this.data;
    const avail = Math.min(MATCH_LEN_MAX, this.size - p);
    if (avail < 2) return;
    const b0 = d[p];
    const b1 = d[p + 1];
    this.hash2[b0 | (b1 << 8)] = p + 1;
    if (avail < 3) return;
    const b2 = d[p + 2];
    this.hash3[Math.imul(b0 | (b1 << 8) | (b2 << 16), HASH_MULTIPLIER) >>> (32 - HASH3_BITS)] = p + 1;
    if (avail < 4) return;
    const h4 = Math.imul(b0 | (b1 << 8) | (b2 << 16) | (d[p + 3] << 24), HASH_MULTIPLIER) >>> this.hash4Shift;
    let cur = this.hash4[h4] - 1;
    this.hash4[h4] = p + 1;

    const son = this.son;
    const cyclic = this.cyclic;
    let leftSlot = cyclicPos * 2;
    let rightSlot = leftSlot + 1;
    let lenLow = 0;
    let lenHigh = 0;
    let steps = this.depth;
    const dictSize = this.dictSize;
    const nice = Math.min(this.niceLength, avail);
    while (cur >= 0 && steps-- > 0 && p - cur <= dictSize) {
      let len = lenLow < lenHigh ? lenLow : lenHigh;
      len += this.commonLength(cur + len, p + len, avail - len);
      let nodeIndex = cyclicPos - (p - cur);
      if (nodeIndex < 0) nodeIndex += cyclic;
      const node = nodeIndex * 2;
      if (len >= nice) {
        son[leftSlot] = son[node];
        son[rightSlot] = son[node + 1];
        return;
      }
      if (d[cur + len] < d[p + len]) {
        son[leftSlot] = cur + 1;
        leftSlot = node + 1;
        cur = son[leftSlot] - 1;
        lenLow = len;
      } else {
        son[rightSlot] = cur + 1;
        rightSlot = node;
        cur = son[rightSlot] - 1;
        lenHigh = len;
      }
    }
    son[leftSlot] = NIL;
    son[rightSlot] = NIL;
  }
}
