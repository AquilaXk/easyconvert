/**
 * Binary-tree match finder for the optimal parser of zstd levels 16-19. Positions that share a hash of four bytes are
 * kept in a binary search tree ordered by the bytes that follow; one descent yields, in increasing length, the nearest
 * match at every length that improves on the previous. The descent is cut off after `depth` steps and a candidate that
 * matches `niceLength` bytes ends it by taking over the candidate's subtrees (so a run or a short period costs a bounded
 * number of steps per position, however long it is).
 *
 * The input is addressed directly (it is the window), so a position is an index into `data`; the nodes of position p
 * live at (p mod cyclic) so that the tree memory is bounded by the window size and not by the input size.
 */

/** Matches of at least this many bytes are looked up; shorter ones cost more to code than the bytes they replace. */
export const BT_MIN_MATCH = 4;
const HASH_MULTIPLIER = 0x9e3779b1;
const HASH_BITS_MIN = 12;
const HASH_BITS_MAX = 22;
const NIL = 0;
const NO_CANDIDATE = -1;
const WORD_BYTES = 4;
/** Candidates a position can report: lengths strictly increase, and none exceeds the nice length. */
export const BT_CANDIDATES_MAX = 64;

function hashBitsFor(inputLength: number): number {
  const bits = 32 - Math.clz32(Math.max(1, inputLength)) + 1;
  return Math.max(HASH_BITS_MIN, Math.min(HASH_BITS_MAX, bits));
}

export class ZstdBtFinder {
  /** Match lengths found at the last position, strictly increasing. */
  readonly lengths = new Uint32Array(BT_CANDIDATES_MAX);
  /** Distances (offsets, at least 1) of those matches. */
  readonly distances = new Uint32Array(BT_CANDIDATES_MAX);
  /** The next position `findMatches` / `advance` will process. */
  position = 0;

  private cyclicPosition = 0;
  private readonly data: Uint8Array;
  private readonly view: DataView;
  private readonly size: number;
  private readonly windowSize: number;
  private readonly depth: number;
  private readonly niceLength: number;
  private readonly cyclic: number;
  private readonly hashShift: number;
  private readonly head: Int32Array;
  private readonly son: Int32Array;

  constructor(data: Uint8Array, windowSize: number, niceLength: number, depth: number) {
    this.data = data;
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    this.size = data.length;
    this.windowSize = windowSize;
    this.depth = depth;
    this.niceLength = niceLength;
    this.cyclic = Math.min(windowSize, data.length) + 1;
    const bits = hashBitsFor(data.length);
    this.hashShift = 32 - bits;
    this.head = new Int32Array(1 << bits);
    this.son = new Int32Array(this.cyclic * 2);
  }

  /** Moves to `position` without inserting the positions in between (a block that was emitted without parsing). */
  advance(position: number): void {
    const step = position - this.position;
    this.position = position;
    this.cyclicPosition = (this.cyclicPosition + step) % this.cyclic;
  }

  /**
   * Inserts the current position and collects the matches found for it into `lengths` / `distances`, then moves to the
   * next position. Returns how many were found. A reported length of `niceLength` means "at least that long".
   */
  findMatches(): number {
    const p = this.position++;
    const cyclicPos = this.cyclicPosition;
    this.cyclicPosition = cyclicPos + 1 === this.cyclic ? 0 : cyclicPos + 1;
    const avail = Math.min(this.niceLength, this.size - p);
    if (avail < BT_MIN_MATCH) return 0;
    const d = this.data;
    const view = this.view;
    const word = d[p] | (d[p + 1] << 8) | (d[p + 2] << 16) | (d[p + 3] << 24);
    const h = Math.imul(word, HASH_MULTIPLIER) >>> this.hashShift;
    let cur = this.head[h] - 1;
    this.head[h] = p + 1;

    const lengths = this.lengths;
    const distances = this.distances;
    const son = this.son;
    const cyclic = this.cyclic;
    const windowSize = this.windowSize;
    let leftSlot = cyclicPos * 2; // where the pointer to the "smaller" subtree is written
    let rightSlot = leftSlot + 1; // where the pointer to the "larger" subtree is written
    let lenLow = 0;
    let lenHigh = 0;
    let steps = this.depth;
    let count = 0;
    let bestLen = BT_MIN_MATCH - 1;
    while (cur !== NO_CANDIDATE && steps-- > 0 && p - cur <= windowSize) {
      let len = lenLow < lenHigh ? lenLow : lenHigh;
      while (len + WORD_BYTES <= avail && view.getUint32(cur + len, true) === view.getUint32(p + len, true)) len += WORD_BYTES;
      while (len < avail && d[cur + len] === d[p + len]) len++;
      let nodeIndex = cyclicPos - (p - cur);
      if (nodeIndex < 0) nodeIndex += cyclic;
      const node = nodeIndex * 2;
      if (len > bestLen) {
        bestLen = len;
        // Keep room for the longest match: when the list is full the last slot is overwritten.
        const slot = count < BT_CANDIDATES_MAX ? count++ : BT_CANDIDATES_MAX - 1;
        lengths[slot] = len;
        distances[slot] = p - cur;
        if (len >= avail) {
          // Splice the new position in place of the candidate: both its subtrees move under the new node.
          son[leftSlot] = son[node];
          son[rightSlot] = son[node + 1];
          return count;
        }
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
    return count;
  }
}
