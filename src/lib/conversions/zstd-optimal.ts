import { ZstdBtFinder } from './zstd-btfinder';
import { highBit32 } from './zstd-fse';
import * as seqCodes from './zstd-seq-codes';
import type { SequenceSink } from './zstd-seq-codes';
import * as tables from './zstd-tables';

/**
 * Optimal parser for Zstandard levels 16-19 (RFC 8878 section 3.1.1.3.2 for the sequence symbols, 3.1.2.5 for the repeat
 * offsets). A block is parsed in two passes. A binary-tree match finder first collects the match candidates of every
 * position of the block. Each pass then runs a forward dynamic program over those candidates in windows of `OPT_NUM`
 * positions: every position is a node, a literal or a match moves from one node to a later one, and the price of a move
 * is the number of bits the block's entropy coders would spend on it. The prices of the first pass come from the
 * statistics of the previous block (or the predefined distributions); the second pass is priced by the sequences the
 * first one chose, so that it follows the codes the finished block will really use.
 */

// Hoisted into module constants: under a CommonJS loader an imported binding is an accessor call on every use.
const ZSTD_MIN_MATCH = seqCodes.ZSTD_MIN_MATCH;
const llCodeOf = seqCodes.llCodeOf;
const mlCodeOf = seqCodes.mlCodeOf;
const LL_BITS_TABLE = seqCodes.LL_BITS_TABLE;
const ML_BITS_TABLE = seqCodes.ML_BITS_TABLE;
const LL_MAX_CODE = tables.ZSTD_LL_MAX_CODE;
const ML_MAX_CODE = tables.ZSTD_ML_MAX_CODE;
const OF_MAX_CODE = tables.ZSTD_OF_MAX_CODE;

/** Positions per dynamic-programming window; a window ends earlier when no match reaches further. */
export const OPT_NUM = 4096;
/** Candidates cached per position (the shortest ones and the longest). */
export const OPT_MAX_CANDIDATES = 16;
/** Passes over a block: the second is priced by the first. */
export const OPT_PASSES = 2;
/** Literal run lengths up to this have their coding cost tabulated. */
const LL_COST_TABLE_SIZE = 1 << 12;
const PRICE_INFINITY = 1e30;
const NODE_PAD = 4;
/** A symbol never seen costs as if it had been seen this often (bits are log2(total / seen)). */
const SMOOTHING = 0.25;
const LITERAL_UNSEEN_COUNT = 0.5;
const LITERAL_BITS_DEFAULT = 8;
const REP_CODES = 3;
const REPEAT_MEMO_SLOTS = 16;
const REPEAT_MEMO_MASK = REPEAT_MEMO_SLOTS - 1;
const MAX_FINDER_NICE = 1 << 10;

interface OptimalLevel {
  niceLength: number;
  searchDepth: number;
}

function bitsOf(count: number, total: number): number {
  return Math.log2(total / count);
}

/** Per-code price tables (in bits) for one pass. */
class PriceModel {
  readonly literal = new Float64Array(256);
  readonly llCost = new Float64Array(LL_COST_TABLE_SIZE);
  readonly mlCost: Float64Array;
  readonly llCode = new Float64Array(LL_MAX_CODE + 1);
  readonly mlCode = new Float64Array(ML_MAX_CODE + 1);
  readonly ofCode = new Float64Array(OF_MAX_CODE + 1);

  constructor(niceLength: number) {
    this.mlCost = new Float64Array(niceLength + 1);
  }

  /** Cost of a literal run of `litLen` bytes in the sequence that ends it (symbol plus extra bits). */
  literalRunCost(litLen: number): number {
    if (litLen < LL_COST_TABLE_SIZE) return this.llCost[litLen];
    const code = llCodeOf(litLen);
    return this.llCode[code] + LL_BITS_TABLE[code];
  }

  /** Sets the sequence-symbol prices from code histograms (counts per code). */
  setSymbols(ll: ArrayLike<number>, ml: ArrayLike<number>, of: ArrayLike<number>): void {
    fillCodePrices(this.llCode, ll);
    fillCodePrices(this.mlCode, ml);
    fillCodePrices(this.ofCode, of);
    for (let l = 0; l < LL_COST_TABLE_SIZE; l++) {
      const code = llCodeOf(l);
      this.llCost[l] = this.llCode[code] + LL_BITS_TABLE[code];
    }
    for (let l = 0; l < this.mlCost.length; l++) {
      if (l < ZSTD_MIN_MATCH) {
        this.mlCost[l] = PRICE_INFINITY;
        continue;
      }
      const code = mlCodeOf(l);
      this.mlCost[l] = this.mlCode[code] + ML_BITS_TABLE[code];
    }
  }

  /** Sets the literal prices from a byte histogram; an empty histogram prices every byte at 8 bits. */
  setLiterals(histogram: ArrayLike<number>): void {
    let total = 0;
    for (let b = 0; b < 256; b++) total += histogram[b];
    if (total === 0) {
      this.literal.fill(LITERAL_BITS_DEFAULT);
      return;
    }
    for (let b = 0; b < 256; b++) {
      const count = histogram[b] > 0 ? histogram[b] : LITERAL_UNSEEN_COUNT;
      this.literal[b] = Math.min(bitsOf(count, total), LITERAL_BITS_DEFAULT + 2);
    }
  }
}

function fillCodePrices(target: Float64Array, histogram: ArrayLike<number>): void {
  let total = 0;
  for (let c = 0; c < target.length; c++) total += histogram[c];
  const smoothedTotal = total + SMOOTHING * target.length;
  for (let c = 0; c < target.length; c++) target[c] = bitsOf(histogram[c] + SMOOTHING, smoothedTotal);
}

/** The predefined distributions (RFC 8878 section 3.1.1.3.2.2.1) as histograms: a "less than one" entry counts as 1. */
function predefinedHistogram(distribution: readonly number[], codes: number): Float64Array {
  const histogram = new Float64Array(codes);
  for (let c = 0; c < codes; c++) histogram[c] = Math.max(1, distribution[c] ?? 1);
  return histogram;
}

export class ZstdOptimalParser {
  public rep1: number = tables.ZSTD_REP_OFFSET_INITIAL[0];
  public rep2: number = tables.ZSTD_REP_OFFSET_INITIAL[1];
  public rep3: number = tables.ZSTD_REP_OFFSET_INITIAL[2];

  private readonly data: Uint8Array;
  private readonly view: DataView;
  private readonly windowSize: number;
  private readonly niceLength: number;
  private readonly finder: ZstdBtFinder;
  private readonly prices: PriceModel;

  // Candidate cache of the block being parsed: candidates of block position i are entries candStart[i]..candStart[i+1].
  private readonly candStart = new Int32Array(tables.ZSTD_BLOCK_SIZE_MAX + 2);
  private candLen = new Uint32Array(tables.ZSTD_BLOCK_SIZE_MAX * 4);
  private candDist = new Uint32Array(tables.ZSTD_BLOCK_SIZE_MAX * 4);

  // Dynamic-programming nodes of the current window.
  private readonly nodePrice: Float64Array;
  private readonly nodeMatchLen: Int32Array;
  private readonly nodeOffset: Int32Array;
  private readonly nodeLitLen: Int32Array;
  private readonly nodeRep1: Int32Array;
  private readonly nodeRep2: Int32Array;
  private readonly nodeRep3: Int32Array;
  /** Highest node written in the current window; every node above it still holds an infinite price. */
  private nodeEnd = 0;

  // The path found for a window, in reverse.
  private readonly pathStart = new Int32Array(OPT_NUM + 2);
  private readonly pathLength = new Int32Array(OPT_NUM + 2);
  private readonly pathOffset = new Int32Array(OPT_NUM + 2);

  // Result of resolveRep.
  private resolvedRep1 = 0;
  private resolvedRep2 = 0;
  private resolvedRep3 = 0;
  private forcedOffset = 0;

  // Statistics of the previous block, used as the prior of the next one; null until a block has been parsed.
  private priorLl: Float64Array | null = null;
  private priorMl: Float64Array | null = null;
  private priorOf: Float64Array | null = null;

  private readonly literalHistogram = new Uint32Array(256);
  private readonly llHistogram = new Float64Array(LL_MAX_CODE + 1);
  private readonly mlHistogram = new Float64Array(ML_MAX_CODE + 1);
  private readonly ofHistogram = new Float64Array(OF_MAX_CODE + 1);

  constructor(data: Uint8Array, level: OptimalLevel, windowSize: number) {
    this.data = data;
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    this.windowSize = windowSize;
    this.niceLength = Math.min(level.niceLength, MAX_FINDER_NICE);
    this.finder = new ZstdBtFinder(data, windowSize, this.niceLength, level.searchDepth);
    this.prices = new PriceModel(this.niceLength);
    const nodes = OPT_NUM + this.niceLength + NODE_PAD;
    this.nodePrice = new Float64Array(nodes).fill(PRICE_INFINITY);
    this.nodeMatchLen = new Int32Array(nodes);
    this.nodeOffset = new Int32Array(nodes);
    this.nodeLitLen = new Int32Array(nodes);
    this.nodeRep1 = new Int32Array(nodes);
    this.nodeRep2 = new Int32Array(nodes);
    this.nodeRep3 = new Int32Array(nodes);
  }

  /** Moves past a block that was emitted without parsing (a run of one byte). */
  public skipBlock(blockEnd: number): void {
    this.finder.advance(blockEnd);
  }

  /** Length of the common prefix of the data at a and b, up to max; compares four bytes per step while it can. */
  private matchLength(a: number, b: number, max: number): number {
    const d = this.data;
    const view = this.view;
    let n = 0;
    const wordEnd = max - 3;
    while (n < wordEnd && view.getUint32(a + n, true) === view.getUint32(b + n, true)) n += 4;
    while (n < max && d[a + n] === d[b + n]) n++;
    return n;
  }

  /**
   * Length of the match at `p` with the data `offset` bytes back. A match found at an earlier position of the same
   * repetition ends where it ends, so the length at a later position inside it is a subtraction, not a comparison.
   */
  private repeatLength(offset: number, p: number, avail: number): number {
    const slot = offset & REPEAT_MEMO_MASK;
    if (this.memoOffset[slot] === offset && this.memoFrom[slot] <= p && p < this.memoEnd[slot]) {
      return this.memoEnd[slot] - p;
    }
    const length = this.matchLength(p - offset, p, avail);
    this.memoOffset[slot] = offset;
    this.memoFrom[slot] = p;
    this.memoEnd[slot] = p + length;
    return length;
  }

  /** Offset value (RFC 8878 section 3.1.2.5) of `offset` given the literal run before it; sets the repeat offsets after it. */
  private resolveRep(offset: number, litLen: number, r1: number, r2: number, r3: number): number {
    if (litLen > 0) {
      if (offset === r1) {
        this.resolvedRep1 = r1;
        this.resolvedRep2 = r2;
        this.resolvedRep3 = r3;
        return 1;
      }
      if (offset === r2) {
        this.resolvedRep1 = offset;
        this.resolvedRep2 = r1;
        this.resolvedRep3 = r3;
        return 2;
      }
      if (offset === r3) {
        this.resolvedRep1 = offset;
        this.resolvedRep2 = r1;
        this.resolvedRep3 = r2;
        return 3;
      }
    } else {
      if (offset === r2) {
        this.resolvedRep1 = offset;
        this.resolvedRep2 = r1;
        this.resolvedRep3 = r3;
        return 1;
      }
      if (offset === r3) {
        this.resolvedRep1 = offset;
        this.resolvedRep2 = r1;
        this.resolvedRep3 = r2;
        return 2;
      }
      if (r1 > 1 && offset === r1 - 1) {
        this.resolvedRep1 = offset;
        this.resolvedRep2 = r1;
        this.resolvedRep3 = r2;
        return 3;
      }
    }
    this.resolvedRep1 = offset;
    this.resolvedRep2 = r1;
    this.resolvedRep3 = r2;
    return offset + REP_CODES;
  }

  /** Finds the candidates of every position of [blockStart, blockEnd) and caches them. */
  private collectCandidates(blockStart: number, blockEnd: number): void {
    const finder = this.finder;
    const lengths = finder.lengths;
    const distances = finder.distances;
    const candStart = this.candStart;
    let fill = 0;
    for (let p = blockStart; p < blockEnd; p++) {
      candStart[p - blockStart] = fill;
      const count = finder.findMatches();
      if (count === 0) continue;
      if (fill + OPT_MAX_CANDIDATES > this.candLen.length) this.growCandidates();
      const avail = blockEnd - p;
      let last = 0;
      // The shortest candidates and the longest one are kept when there are more than the cache holds.
      const first = count > OPT_MAX_CANDIDATES ? count - OPT_MAX_CANDIDATES : 0;
      for (let j = first; j < count; j++) {
        const len = lengths[j] < avail ? lengths[j] : avail;
        if (len <= last || len < ZSTD_MIN_MATCH) continue;
        last = len;
        this.candLen[fill] = len;
        this.candDist[fill] = distances[j];
        fill++;
      }
    }
    candStart[blockEnd - blockStart] = fill;
  }

  private growCandidates(): void {
    const lengths = new Uint32Array(this.candLen.length * 2);
    lengths.set(this.candLen);
    const distances = new Uint32Array(this.candDist.length * 2);
    distances.set(this.candDist);
    this.candLen = lengths;
    this.candDist = distances;
  }

  /**
   * Parses [blockStart, blockEnd) into sequences with the repeat offsets currently set on this parser. Returns the
   * number of literals that follow the last sequence.
   */
  public parseBlock(blockStart: number, blockEnd: number, store: SequenceSink): number {
    this.collectCandidates(blockStart, blockEnd);

    const literals = this.literalHistogram.fill(0);
    const d = this.data;
    for (let i = blockStart; i < blockEnd; i++) literals[d[i]]++;
    const prices = this.prices;
    prices.setLiterals(literals);
    this.setPriorSymbols();

    const startRep1 = this.rep1;
    const startRep2 = this.rep2;
    const startRep3 = this.rep3;
    let trailing = this.runPass(blockStart, blockEnd, store);
    for (let pass = 1; pass < OPT_PASSES; pass++) {
      this.gatherStatistics(blockStart, blockEnd, store, trailing);
      prices.setLiterals(this.literalHistogram);
      prices.setSymbols(this.llHistogram, this.mlHistogram, this.ofHistogram);
      this.rep1 = startRep1;
      this.rep2 = startRep2;
      this.rep3 = startRep3;
      trailing = this.runPass(blockStart, blockEnd, store);
    }
    this.gatherStatistics(blockStart, blockEnd, store, trailing);
    this.priorLl = Float64Array.from(this.llHistogram);
    this.priorMl = Float64Array.from(this.mlHistogram);
    this.priorOf = Float64Array.from(this.ofHistogram);
    return trailing;
  }

  private setPriorSymbols(): void {
    const ll = this.priorLl ?? predefinedHistogram(tables.ZSTD_LL_DEFAULT_DISTRIBUTION, LL_MAX_CODE + 1);
    const ml = this.priorMl ?? predefinedHistogram(tables.ZSTD_ML_DEFAULT_DISTRIBUTION, ML_MAX_CODE + 1);
    const of = this.priorOf ?? predefinedHistogram(tables.ZSTD_OF_DEFAULT_DISTRIBUTION, OF_MAX_CODE + 1);
    this.prices.setSymbols(ll, ml, of);
  }

  /** Counts the codes and the literal bytes of the sequences a pass produced. */
  private gatherStatistics(blockStart: number, blockEnd: number, store: SequenceSink, trailing: number): void {
    const d = this.data;
    const literals = this.literalHistogram.fill(0);
    const ll = this.llHistogram.fill(0);
    const ml = this.mlHistogram.fill(0);
    const of = this.ofHistogram.fill(0);
    let cursor = blockStart;
    for (let i = 0; i < store.count; i++) {
      const run = store.litLen[i];
      for (let k = 0; k < run; k++) literals[d[cursor + k]]++;
      cursor += run + store.matchLen[i];
      ll[llCodeOf(run)]++;
      ml[mlCodeOf(store.matchLen[i])]++;
      of[highBit32(store.offBase[i])]++;
    }
    for (let k = blockEnd - trailing; k < blockEnd; k++) literals[d[k]]++;
  }

  /** One dynamic-programming pass over the block; fills `store` and returns the trailing literal count. */
  private runPass(blockStart: number, blockEnd: number, store: SequenceSink): number {
    const nodePrice = this.nodePrice;
    const nodeLitLen = this.nodeLitLen;
    const nodeRep1 = this.nodeRep1;
    const nodeRep2 = this.nodeRep2;
    const nodeRep3 = this.nodeRep3;
    const nodeMatchLen = this.nodeMatchLen;
    const nodeOffset = this.nodeOffset;
    store.count = 0;
    this.memoOffset.fill(0);
    let pos = blockStart;
    let anchor = blockStart;

    while (pos < blockEnd) {
      const base = pos;
      nodePrice[0] = 0;
      nodeLitLen[0] = pos - anchor;
      nodeRep1[0] = this.rep1;
      nodeRep2[0] = this.rep2;
      nodeRep3[0] = this.rep3;
      this.nodeEnd = 0;

      let cur = 0;
      let forcedLength = 0;
      for (;;) {
        forcedLength = this.expand(cur, base, blockStart, blockEnd);
        if (forcedLength > 0) break;
        cur++;
        if (cur >= this.nodeEnd || cur >= OPT_NUM) break;
      }

      // Walk the cheapest path back from the node the window ended on.
      let pathCount = 0;
      let node = cur;
      while (node > 0) {
        const length = nodeMatchLen[node];
        if (length > 0) {
          this.pathStart[pathCount] = base + node - length;
          this.pathLength[pathCount] = length;
          this.pathOffset[pathCount] = nodeOffset[node];
          pathCount++;
          node -= length;
        } else {
          node--;
        }
      }
      for (let i = pathCount - 1; i >= 0; i--) {
        anchor = this.emit(store, anchor, this.pathStart[i], this.pathLength[i], this.pathOffset[i]);
      }
      pos = base + cur;
      if (forcedLength > 0) {
        anchor = this.emit(store, anchor, pos, forcedLength, this.forcedOffset);
        pos += forcedLength;
      }
      nodePrice.fill(PRICE_INFINITY, 1, this.nodeEnd + 1);
    }
    return blockEnd - anchor;
  }

  private emit(store: SequenceSink, anchor: number, start: number, length: number, offset: number): number {
    const litLen = start - anchor;
    const index = store.count++;
    store.litLen[index] = litLen;
    store.matchLen[index] = length;
    store.offBase[index] = this.resolveRep(offset, litLen, this.rep1, this.rep2, this.rep3);
    this.rep1 = this.resolvedRep1;
    this.rep2 = this.resolvedRep2;
    this.rep3 = this.resolvedRep3;
    return start + length;
  }

  /**
   * Sets the literal-run length and repeat offsets of node `cur` from the move that reached it. A node is only expanded
   * after its predecessor, whose state is therefore known.
   */
  private deriveState(cur: number): void {
    const length = this.nodeMatchLen[cur];
    if (length === 0) {
      const previous = cur - 1;
      this.nodeLitLen[cur] = this.nodeLitLen[previous] + 1;
      this.nodeRep1[cur] = this.nodeRep1[previous];
      this.nodeRep2[cur] = this.nodeRep2[previous];
      this.nodeRep3[cur] = this.nodeRep3[previous];
      return;
    }
    const previous = cur - length;
    this.resolveRep(this.nodeOffset[cur], this.nodeLitLen[previous], this.nodeRep1[previous], this.nodeRep2[previous], this.nodeRep3[previous]);
    this.nodeLitLen[cur] = 0;
    this.nodeRep1[cur] = this.resolvedRep1;
    this.nodeRep2[cur] = this.resolvedRep2;
    this.nodeRep3[cur] = this.resolvedRep3;
  }

  /**
   * Relaxes every move that starts at node `cur`. Returns a length when a match of at least the nice length starts
   * here (the window then ends at this node and the caller emits that match after the path), else 0.
   */
  private expand(cur: number, base: number, blockStart: number, blockEnd: number): number {
    const data = this.data;
    const prices = this.prices;
    const nice = this.niceLength;
    const p = base + cur;
    const avail = blockEnd - p;
    const price0 = this.nodePrice[cur];
    if (cur > 0) this.deriveState(cur);
    const litLen0 = this.nodeLitLen[cur];
    const r1 = this.nodeRep1[cur];
    const r2 = this.nodeRep2[cur];
    const r3 = this.nodeRep3[cur];

    // Matches of the nice length or more end the window here.
    let forced = 0;
    const repOffsets = this.repOffsets;
    if (litLen0 > 0) {
      repOffsets[0] = r1;
      repOffsets[1] = r2;
      repOffsets[2] = r3;
    } else {
      repOffsets[0] = r2;
      repOffsets[1] = r3;
      repOffsets[2] = r1 - 1;
    }
    const repLengths = this.repLengths;
    for (let k = 0; k < REP_CODES; k++) {
      const offset = repOffsets[k];
      let length = 0;
      // The first three bytes decide whether a repeat can be a match at all.
      if (
        offset >= 1 &&
        offset <= p &&
        offset <= this.windowSize &&
        avail >= ZSTD_MIN_MATCH &&
        data[p - offset] === data[p] &&
        data[p - offset + 1] === data[p + 1] &&
        data[p - offset + 2] === data[p + 2]
      ) {
        length = this.repeatLength(offset, p, avail);
        if (length >= nice && length > forced) {
          forced = length;
          this.forcedOffset = offset;
        }
      }
      repLengths[k] = length;
    }
    const first = this.candStart[p - blockStart];
    const last = this.candStart[p - blockStart + 1];
    if (last > first && this.candLen[last - 1] >= nice) {
      const distance = this.candDist[last - 1];
      const length = this.matchLength(p - distance, p, avail);
      if (length > forced) {
        forced = length;
        this.forcedOffset = distance;
      }
    }
    if (forced > 0) return forced;

    // Literal.
    const nodePrice = this.nodePrice;
    const byte = data[p];
    const literalPrice = price0 + prices.literal[byte] + prices.literalRunCost(litLen0 + 1) - prices.literalRunCost(litLen0);
    if (literalPrice < nodePrice[cur + 1]) this.setNode(cur + 1, literalPrice, 0, 0);

    // Matches priced from the literal-run cost of an empty run (the run's own cost was added literal by literal).
    const matchBase = price0 + prices.literalRunCost(0);
    const mlCost = prices.mlCost;
    const ofCode = prices.ofCode;
    for (let k = 0; k < REP_CODES; k++) {
      const length = repLengths[k];
      if (length < ZSTD_MIN_MATCH) continue;
      const offset = repOffsets[k];
      // The same offset reached through another slot has been priced already.
      if (k > 0 && (offset === repOffsets[0] || (k > 1 && offset === repOffsets[1]))) continue;
      const offBase = this.resolveRep(offset, litLen0, r1, r2, r3);
      const code = highBit32(offBase);
      const total = matchBase + ofCode[code] + code;
      this.relaxRange(cur, ZSTD_MIN_MATCH, length, total, mlCost, offset);
    }
    let from = ZSTD_MIN_MATCH;
    for (let j = first; j < last; j++) {
      const length = this.candLen[j];
      const distance = this.candDist[j];
      // A candidate at a repeat offset has been priced with the repeat's own range.
      const isRepeat = distance === repOffsets[0] || distance === repOffsets[1] || distance === repOffsets[2];
      if (!isRepeat) {
        const offBase = this.resolveRep(distance, litLen0, r1, r2, r3);
        const code = highBit32(offBase);
        const total = matchBase + ofCode[code] + code;
        this.relaxRange(cur, from, length, total, mlCost, distance);
      }
      from = length + 1;
    }
    return 0;
  }

  private readonly repOffsets = new Int32Array(REP_CODES);
  private readonly memoOffset = new Int32Array(REPEAT_MEMO_SLOTS);
  private readonly memoFrom = new Int32Array(REPEAT_MEMO_SLOTS);
  private readonly memoEnd = new Int32Array(REPEAT_MEMO_SLOTS);
  private readonly repLengths = new Int32Array(REP_CODES);

  private setNode(node: number, price: number, matchLen: number, offset: number): void {
    this.nodePrice[node] = price;
    this.nodeMatchLen[node] = matchLen;
    this.nodeOffset[node] = offset;
    if (node > this.nodeEnd) this.nodeEnd = node;
  }

  /** Relaxes the nodes reached by a match of every length in [from, to] at one offset. */
  private relaxRange(cur: number, from: number, to: number, basePrice: number, mlCost: Float64Array, offset: number): void {
    const nodePrice = this.nodePrice;
    const nodeMatchLen = this.nodeMatchLen;
    const nodeOffset = this.nodeOffset;
    let highest = 0;
    for (let length = from; length <= to; length++) {
      const price = basePrice + mlCost[length];
      const node = cur + length;
      if (price < nodePrice[node]) {
        nodePrice[node] = price;
        nodeMatchLen[node] = length;
        nodeOffset[node] = offset;
        highest = node;
      }
    }
    if (highest > this.nodeEnd) this.nodeEnd = highest;
  }
}
