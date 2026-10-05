import { ConversionFailedError } from '../types';
import { highBit32 } from './zstd-fse';
import { SequenceStore, llCodeOf, mlCodeOf } from './zstd-sequences';
import {
  LL_BITS,
  ML_BITS,
  ZSTD_BLOCK_SIZE_MAX,
  ZSTD_LL_MAX_CODE,
  ZSTD_ML_MAX_CODE,
  ZSTD_OF_MAX_CODE,
  ZSTD_REP_OFFSET_INITIAL,
} from './zstd-tables';

/**
 * Price-driven optimal parser for compression levels 16-19.
 *
 * Match candidates come from a binary-tree match finder that reports every longer match at a
 * position; a forward dynamic program over a window of positions picks the cheapest sequence chain
 * using bit prices from adaptive literal, literal-length, match-length and offset statistics, with
 * repeat-offset candidates priced separately. All state lives in typed arrays sized by the window
 * or the block; nothing is allocated per position.
 */

export interface ZstdOptimalParams {
  /** log2 of the 4-byte hash head table. */
  hashLog: number;
  /** log2 of the number of tree nodes (positions) kept; older positions fall out of the tree. */
  btLog: number;
  /** Maximum tree nodes visited per position. */
  searchDepth: number;
  /** 3 adds a single-candidate 3-byte table so three-byte matches can be priced; otherwise 4. */
  minMatch: number;
  /** A match at least this long ends the search and is taken at once. */
  targetLength: number;
  /** Parse the first block twice so its prices come from its own statistics. */
  seedFirstBlock: boolean;
  /** Skip the search at a position whose successor is already almost as cheap. */
  skipSearch: boolean;
  /** Stop pricing a match's shorter lengths once one no longer beats the current plan. */
  earlyAbort: boolean;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Positions covered by one dynamic-programming window. */
export const ZSTD_OPTIMAL_WINDOW = 1 << 12;
const OPT_ARRAY_SIZE = ZSTD_OPTIMAL_WINDOW + 4;
const SEQUENCES_PER_WINDOW_MAX = ZSTD_OPTIMAL_WINDOW;
/** Longest compare the tree performs; also the point where a node's ordering is dropped as unknown. */
const TREE_COMPARE_MAX = ZSTD_OPTIMAL_WINDOW + 1;
const MIN_MATCH_LENGTH = 3;
const HASH_MULTIPLIER = 2654435761;
const HASH3_MULTIPLIER = 506832829;
const HASH3_LOG_MAX = 17;
/** A 3-byte candidate farther away than this costs more than the three literals it replaces. */
const HASH3_DISTANCE_MAX = 1 << 18;
const HASH_READ_BYTES = 8;
const TABLE_LOG_MIN = 8;
const TREE_RUN_SKIP_THRESHOLD = 384;
const TREE_RUN_SKIP_MAX = 192;
const TREE_UPDATE_INITIAL_BEST = 8;
const MATCHES_SLACK = 8;
/** Repeat-offset codes per sequence, and the bias that separates explicit offsets from them (RFC 8878 section 3.1.1.5). */
const REP_CODES = 3;
const OFFSET_BIAS = 3;

/** Prices are fixed point with this many fractional bits. */
const PRICE_SHIFT = 8;
const PRICE_UNIT = 1 << PRICE_SHIFT;
const PRICE_MAX = 1 << 30;
/** Every sequence costs a little more than its symbols, which biases the plan toward fewer, longer matches. */
const SEQUENCE_BIAS = PRICE_UNIT / 5;
/** Next-position shortcut: skip a search when the next position is at most this much dearer. */
const PRUNE_MARGIN = PRICE_UNIT / 2;

const STAT_SUM_LIMIT = 1 << 16;
const STAT_SUM_RESET = 1 << 15;
const LOG2_TABLE_SIZE = STAT_SUM_LIMIT + 1;
const LITERAL_SCALE_TARGET = 1 << 12;
const SYMBOL_SCALE_TARGET = 1 << 11;
const LITERAL_ALPHABET = 256;
/** Candidates this much shorter than the longest match are still compared by price when a long match ends the search. */
const LONG_MATCH_GAP_MAX = 16;
const LITERAL_COST_MIN = PRICE_UNIT;
const LL_LENGTH_CLAMP = ZSTD_BLOCK_SIZE_MAX - 1;
/** Literal and match lengths below these limits are priced from direct tables. */
const LL_SMALL_LIMIT = 64;
const ML_SMALL_LIMIT = 131;
/** The statistics-seeding pass of the first block searches this shallowly. */
const SEED_PASS_DEPTH = 8;
/** Seeding pays off while the first block is a sizeable share of the input; beyond this it only costs time. */
const SEED_INPUT_MAX_BYTES = 4 * ZSTD_BLOCK_SIZE_MAX;

/** Initial literal-length / offset frequencies used before any block statistics exist. */
const LL_PRIOR: readonly number[] = [4, 2, ...new Array<number>(ZSTD_LL_MAX_CODE - 1).fill(1)];
const OF_PRIOR: readonly number[] = [
  6, 2, 1, 1, 2, 3, 4, 4, 4, 3, 2, 1, ...new Array<number>(ZSTD_OF_MAX_CODE - 11).fill(1),
];

let log2Table: Int32Array | null = null;

/** round(log2(i) * 2^PRICE_SHIFT) for i in 1..STAT_SUM_LIMIT. */
function getLog2Table(): Int32Array {
  if (log2Table === null) {
    const table = new Int32Array(LOG2_TABLE_SIZE);
    for (let i = 1; i < LOG2_TABLE_SIZE; i++) table[i] = Math.round(Math.log2(i) * PRICE_UNIT);
    log2Table = table;
  }
  return log2Table;
}

/** Scales frequencies (each kept at least 1) so their sum does not exceed about `target`; returns the sum. */
function scaleStats(freq: Int32Array, count: number, target: number): number {
  let sum = 0;
  for (let i = 0; i < count; i++) sum += freq[i];
  if (sum <= target) return sum;
  const shift = highBit32(Math.floor(sum / target)) + 1;
  sum = 0;
  for (let i = 0; i < count; i++) {
    const scaled = 1 + (freq[i] >> shift);
    freq[i] = scaled;
    sum += scaled;
  }
  return sum;
}

function sumOf(freq: Int32Array, count: number): number {
  let sum = 0;
  for (let i = 0; i < count; i++) sum += freq[i];
  return sum;
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

export class OptimalParser {
  public rep1: number = ZSTD_REP_OFFSET_INITIAL[0];
  public rep2: number = ZSTD_REP_OFFSET_INITIAL[1];
  public rep3: number = ZSTD_REP_OFFSET_INITIAL[2];

  private readonly data: Uint8Array;
  private readonly windowSize: number;
  private readonly params: ZstdOptimalParams;
  private readonly insertEnd: number;
  private readonly sufficient: number;
  private readonly useHash3: boolean;
  private readonly skipSearch: boolean;
  private readonly earlyAbort: boolean;
  private readonly logTable: Int32Array;

  // Binary-tree match finder. Positions are stored as position + 1 so that 0 means "none".
  private readonly head: Int32Array;
  private readonly hashShift: number;
  private readonly bt: Int32Array;
  private readonly btMask: number;
  private readonly dummySlot: number;
  private readonly hash3: Int32Array | null;
  private readonly hash3Shift: number;
  private nextInsert = 0;
  private nextInsert3 = 0;
  private limit = 0;
  private depthLimit: number;
  private skipAhead = 1;
  private matchCount = 0;
  private readonly matchLen: Int32Array;
  private readonly matchOff: Int32Array;
  private rep0Cur = 0;
  private rep1Cur = 0;
  private rep2Cur = 0;

  // Dynamic-programming window.
  private readonly optPrice = new Int32Array(OPT_ARRAY_SIZE);
  private readonly optMlen = new Int32Array(OPT_ARRAY_SIZE);
  private readonly optOff = new Int32Array(OPT_ARRAY_SIZE);
  private readonly optLitlen = new Int32Array(OPT_ARRAY_SIZE);
  private readonly optRep0 = new Int32Array(OPT_ARRAY_SIZE);
  private readonly optRep1 = new Int32Array(OPT_ARRAY_SIZE);
  private readonly optRep2 = new Int32Array(OPT_ARRAY_SIZE);
  private readonly seqLit = new Int32Array(SEQUENCES_PER_WINDOW_MAX);
  private readonly seqMatch = new Int32Array(SEQUENCES_PER_WINDOW_MAX);
  private readonly seqOff = new Int32Array(SEQUENCES_PER_WINDOW_MAX);
  private anchorOut = 0;
  private repA = 0;
  private repB = 0;
  private repC = 0;

  // Adaptive statistics and the prices derived from them.
  private statsReady = false;
  private firstBlock = true;
  private readonly litFreq = new Int32Array(LITERAL_ALPHABET);
  private readonly llFreq = new Int32Array(ZSTD_LL_MAX_CODE + 1);
  private readonly mlFreq = new Int32Array(ZSTD_ML_MAX_CODE + 1);
  private readonly ofFreq = new Int32Array(ZSTD_OF_MAX_CODE + 1);
  private litSum = 0;
  private llSum = 0;
  private mlSum = 0;
  private ofSum = 0;
  private readonly litCost = new Int32Array(LITERAL_ALPHABET);
  private readonly llSmall = new Int32Array(LL_SMALL_LIMIT);
  private readonly mlSmall = new Int32Array(ML_SMALL_LIMIT);
  private readonly llCost = new Int32Array(ZSTD_LL_MAX_CODE + 1);
  private readonly mlCost = new Int32Array(ZSTD_ML_MAX_CODE + 1);
  private readonly ofCost = new Int32Array(ZSTD_OF_MAX_CODE + 1);
  private readonly blockHistogram = new Int32Array(LITERAL_ALPHABET);

  constructor(data: Uint8Array, params: ZstdOptimalParams, windowSize: number) {
    this.data = data;
    this.params = params;
    this.windowSize = windowSize;
    this.insertEnd = data.length - HASH_READ_BYTES;
    this.depthLimit = params.searchDepth;
    this.sufficient = Math.min(params.targetLength, ZSTD_OPTIMAL_WINDOW - 1);
    this.useHash3 = params.minMatch <= MIN_MATCH_LENGTH;
    this.skipSearch = params.skipSearch;
    this.earlyAbort = params.earlyAbort;
    this.logTable = getLog2Table();

    const inputLog = Math.max(TABLE_LOG_MIN, 32 - Math.clz32(data.length) + 1);
    const hashLog = Math.min(params.hashLog, inputLog);
    const btLog = Math.min(params.btLog, inputLog);
    this.head = new Int32Array(1 << hashLog);
    this.hashShift = 32 - hashLog;
    this.btMask = (1 << btLog) - 1;
    this.bt = new Int32Array(2 * (this.btMask + 1) + 1);
    this.dummySlot = 2 * (this.btMask + 1);
    if (this.useHash3) {
      const hash3Log = Math.min(HASH3_LOG_MAX, inputLog);
      this.hash3 = new Int32Array(1 << hash3Log);
      this.hash3Shift = 32 - hash3Log;
    } else {
      this.hash3 = null;
      this.hash3Shift = 0;
    }
    const matchCapacity = params.searchDepth + REP_CODES + MATCHES_SLACK;
    this.matchLen = new Int32Array(matchCapacity);
    this.matchOff = new Int32Array(matchCapacity);
  }

  // -------------------------------------------------------------------------
  // Match finder
  // -------------------------------------------------------------------------

  /** Length of the common prefix of data[a..] and data[b..], continuing from `len`, capped at `max`. */
  private commonLength(a: number, b: number, from: number, max: number): number {
    const d = this.data;
    let len = from;
    while (len < max && d[a + len] === d[b + len]) len++;
    return len;
  }

  private hash4(p: number): number {
    const d = this.data;
    const word = d[p] | (d[p + 1] << 8) | (d[p + 2] << 16) | (d[p + 3] << 24);
    return Math.imul(word, HASH_MULTIPLIER) >>> this.hashShift;
  }

  private hash3At(p: number): number {
    const d = this.data;
    const word = d[p] | (d[p + 1] << 8) | (d[p + 2] << 16);
    return Math.imul(word, HASH3_MULTIPLIER) >>> this.hash3Shift;
  }

  /**
   * Walks the tree for position p, linking p in as it goes. With `collect`, every match longer than
   * `best` is appended to the match list (lengths strictly increase). Without it, only the number of
   * following positions that are redundant (inside a long repeat) is computed, into `skipAhead`.
   */
  private walkTree(p: number, collect: boolean, bestInit: number): void {
    const d = this.data;
    const bt = this.bt;
    const btMask = this.btMask;
    const idx = p + 1;
    const h = this.hash4(p);
    let matchIdx = this.head[h];
    this.head[h] = idx;
    let smallerSlot = (p & btMask) << 1;
    let largerSlot = smallerSlot + 1;
    const btLow = btMask >= idx ? 0 : idx - btMask;
    const matchLow = idx > this.windowSize ? idx - this.windowSize - 1 : 0;
    const remaining = this.limit - p;
    const maxLen = remaining < TREE_COMPARE_MAX ? remaining : TREE_COMPARE_MAX;
    const matchLenOut = this.matchLen;
    const matchOffOut = this.matchOff;
    let commonSmaller = 0;
    let commonLarger = 0;
    let best = bestInit;
    let endIdx = idx + HASH_READ_BYTES + 1;
    let n = this.matchCount;
    let compares = this.depthLimit;

    while (compares > 0 && matchIdx > matchLow) {
      compares--;
      const m = matchIdx - 1;
      const nodeSlot = (m & btMask) << 1;
      let len = commonSmaller < commonLarger ? commonSmaller : commonLarger;
      len = this.commonLength(m, p, len, maxLen);
      if (len > best) {
        best = len;
        if (len > endIdx - matchIdx) endIdx = matchIdx + len;
        if (collect) {
          matchLenOut[n] = len;
          matchOffOut[n] = p - m + OFFSET_BIAS;
          n++;
        }
      }
      // The ordering of equal-so-far suffixes is unknown past the compare limit: drop the rest.
      if (len >= maxLen) break;
      if (d[m + len] < d[p + len]) {
        bt[smallerSlot] = matchIdx;
        commonSmaller = len;
        if (matchIdx <= btLow) {
          smallerSlot = this.dummySlot;
          break;
        }
        smallerSlot = nodeSlot + 1;
        matchIdx = bt[nodeSlot + 1];
      } else {
        bt[largerSlot] = matchIdx;
        commonLarger = len;
        if (matchIdx <= btLow) {
          largerSlot = this.dummySlot;
          break;
        }
        largerSlot = nodeSlot;
        matchIdx = bt[nodeSlot];
      }
    }
    bt[smallerSlot] = 0;
    bt[largerSlot] = 0;
    this.matchCount = n;
    if (!collect) {
      const repeatSkip = best > TREE_RUN_SKIP_THRESHOLD ? Math.min(TREE_RUN_SKIP_MAX, best - TREE_RUN_SKIP_THRESHOLD) : 0;
      const coverSkip = endIdx - (idx + HASH_READ_BYTES);
      this.skipAhead = repeatSkip > coverSkip ? repeatSkip : coverSkip;
    }
  }

  /** Inserts every position before p that has not been inserted yet. */
  private updateTree(p: number): void {
    let idx = this.nextInsert;
    const stop = p < this.insertEnd + 1 ? p : this.insertEnd + 1;
    while (idx < stop) {
      this.walkTree(idx, false, TREE_UPDATE_INITIAL_BEST);
      idx += this.skipAhead;
    }
    // The skip never jumps over p itself: p is about to be searched and must be able to see the repeat.
    if (idx > stop) idx = stop;
    if (idx > this.nextInsert) this.nextInsert = idx;
  }

  private insertHash3Before(p: number): void {
    const table = this.hash3;
    if (table === null) return;
    let i = this.nextInsert3;
    const stop = p < this.insertEnd + 1 ? p : this.insertEnd + 1;
    while (i < stop) {
      table[this.hash3At(i)] = i + 1;
      i++;
    }
    if (i > this.nextInsert3) this.nextInsert3 = i;
  }

  /**
   * Collects candidate matches at p into matchLen/matchOff (strictly increasing length) and returns
   * their count. Repeat offsets come first; an offset value 1..3 follows the literal-length-zero
   * shift of RFC 8878 section 3.1.2.5.
   */
  private findMatches(p: number, ll0: boolean): number {
    const d = this.data;
    const limit = this.limit;
    const maxLen = limit - p;
    const matchLenOut = this.matchLen;
    const matchOffOut = this.matchOff;
    const sufficient = this.sufficient;
    let n = 0;
    let best = MIN_MATCH_LENGTH - 1;

    // With no literals before the match, offset values 1..3 name repeat offsets 2, 3 and "first minus one".
    const firstCode = ll0 ? 1 : 0;
    for (let code = firstCode; code < firstCode + REP_CODES; code++) {
      let offset = this.rep0Cur - 1;
      if (code === 0) offset = this.rep0Cur;
      else if (code === 1) offset = this.rep1Cur;
      else if (code === 2) offset = this.rep2Cur;
      if (offset < 1 || offset > p || offset > this.windowSize) continue;
      const source = p - offset;
      const len = this.commonLength(source, p, 0, maxLen);
      if (len > best) {
        best = len;
        matchLenOut[n] = len;
        matchOffOut[n] = code - firstCode + 1;
        n++;
        if (len >= sufficient || len === maxLen) return n;
      }
    }

    if (p >= this.insertEnd + 1) return n;
    this.insertHash3Before(p);
    if (this.hash3 !== null) {
      const slot = this.hash3At(p);
      const candidate = this.hash3[slot];
      this.hash3[slot] = p + 1;
      this.nextInsert3 = p + 1;
      if (best < MIN_MATCH_LENGTH && candidate > 0 && p + 1 - candidate < HASH3_DISTANCE_MAX && p + 1 - candidate <= this.windowSize) {
        const source = candidate - 1;
        const len = this.commonLength(source, p, 0, maxLen);
        if (len >= MIN_MATCH_LENGTH) {
          best = len;
          matchLenOut[n] = len;
          matchOffOut[n] = p - source + OFFSET_BIAS;
          n++;
          if (len > ZSTD_OPTIMAL_WINDOW || len === maxLen) {
            this.nextInsert = p + 1;
            return n;
          }
        }
      }
    }

    this.updateTree(p);
    // A position inside a skipped repeat was never inserted: only repeat offsets can serve it.
    if (p < this.nextInsert) return n;
    this.matchCount = n;
    this.walkTree(p, true, best);
    this.nextInsert = p + 1;
    return this.matchCount;
  }

  private resetMatchFinder(): void {
    this.head.fill(0);
    if (this.hash3 !== null) this.hash3.fill(0);
    this.nextInsert = 0;
    this.nextInsert3 = 0;
  }

  // -------------------------------------------------------------------------
  // Statistics and prices
  // -------------------------------------------------------------------------

  private prepareStats(blockStart: number, blockEnd: number): void {
    if (this.statsReady) {
      this.litSum = scaleStats(this.litFreq, LITERAL_ALPHABET, LITERAL_SCALE_TARGET);
      this.llSum = scaleStats(this.llFreq, ZSTD_LL_MAX_CODE + 1, SYMBOL_SCALE_TARGET);
      this.mlSum = scaleStats(this.mlFreq, ZSTD_ML_MAX_CODE + 1, SYMBOL_SCALE_TARGET);
      this.ofSum = scaleStats(this.ofFreq, ZSTD_OF_MAX_CODE + 1, SYMBOL_SCALE_TARGET);
    } else {
      const histogram = this.blockHistogram.fill(0);
      const d = this.data;
      for (let i = blockStart; i < blockEnd; i++) histogram[d[i]]++;
      for (let s = 0; s < LITERAL_ALPHABET; s++) this.litFreq[s] = histogram[s] + 1;
      this.litSum = scaleStats(this.litFreq, LITERAL_ALPHABET, LITERAL_SCALE_TARGET);
      for (let s = 0; s <= ZSTD_LL_MAX_CODE; s++) this.llFreq[s] = LL_PRIOR[s];
      for (let s = 0; s <= ZSTD_ML_MAX_CODE; s++) this.mlFreq[s] = 1;
      for (let s = 0; s <= ZSTD_OF_MAX_CODE; s++) this.ofFreq[s] = OF_PRIOR[s];
      this.llSum = sumOf(this.llFreq, ZSTD_LL_MAX_CODE + 1);
      this.mlSum = sumOf(this.mlFreq, ZSTD_ML_MAX_CODE + 1);
      this.ofSum = sumOf(this.ofFreq, ZSTD_OF_MAX_CODE + 1);
      this.statsReady = true;
    }
    this.refreshCosts();
  }

  private refreshCosts(): void {
    const lg = this.logTable;
    if (this.litSum >= STAT_SUM_LIMIT) this.litSum = scaleStats(this.litFreq, LITERAL_ALPHABET, STAT_SUM_RESET);
    if (this.llSum >= STAT_SUM_LIMIT) this.llSum = scaleStats(this.llFreq, ZSTD_LL_MAX_CODE + 1, STAT_SUM_RESET);
    if (this.mlSum >= STAT_SUM_LIMIT) this.mlSum = scaleStats(this.mlFreq, ZSTD_ML_MAX_CODE + 1, STAT_SUM_RESET);
    if (this.ofSum >= STAT_SUM_LIMIT) this.ofSum = scaleStats(this.ofFreq, ZSTD_OF_MAX_CODE + 1, STAT_SUM_RESET);
    const litBase = lg[this.litSum];
    const llBase = lg[this.llSum];
    const mlBase = lg[this.mlSum];
    const ofBase = lg[this.ofSum];
    // A Huffman-coded literal never costs less than one bit, however skewed the histogram is.
    for (let b = 0; b < LITERAL_ALPHABET; b++) {
      const cost = litBase - lg[this.litFreq[b]];
      this.litCost[b] = cost > LITERAL_COST_MIN ? cost : LITERAL_COST_MIN;
    }
    for (let c = 0; c <= ZSTD_LL_MAX_CODE; c++) this.llCost[c] = LL_BITS[c] * PRICE_UNIT + llBase - lg[this.llFreq[c]];
    for (let c = 0; c <= ZSTD_ML_MAX_CODE; c++) this.mlCost[c] = ML_BITS[c] * PRICE_UNIT + mlBase - lg[this.mlFreq[c]];
    for (let c = 0; c <= ZSTD_OF_MAX_CODE; c++) this.ofCost[c] = c * PRICE_UNIT + ofBase - lg[this.ofFreq[c]];
    for (let l = 0; l < LL_SMALL_LIMIT; l++) this.llSmall[l] = this.llCost[llCodeOf(l)];
    for (let l = MIN_MATCH_LENGTH; l < ML_SMALL_LIMIT; l++) this.mlSmall[l] = this.mlCost[mlCodeOf(l)];
  }

  private llPrice(litLen: number): number {
    if (litLen < LL_SMALL_LIMIT) return this.llSmall[litLen];
    return this.llCost[llCodeOf(litLen < LL_LENGTH_CLAMP ? litLen : LL_LENGTH_CLAMP)];
  }

  private mlPrice(matchLen: number): number {
    return matchLen < ML_SMALL_LIMIT ? this.mlSmall[matchLen] : this.mlCost[mlCodeOf(matchLen)];
  }

  private updateStats(literalStart: number, litLen: number, matchLen: number, offBase: number): void {
    const d = this.data;
    const litFreq = this.litFreq;
    for (let i = 0; i < litLen; i++) litFreq[d[literalStart + i]]++;
    this.litSum += litLen;
    this.llFreq[llCodeOf(litLen)]++;
    this.llSum++;
    this.mlFreq[mlCodeOf(matchLen)]++;
    this.mlSum++;
    this.ofFreq[highBit32(offBase)]++;
    this.ofSum++;
  }

  // -------------------------------------------------------------------------
  // Repeat offsets
  // -------------------------------------------------------------------------

  /** Offset history after a sequence with `offBase`, from history (a, b, c), into repA/repB/repC. */
  private stepReps(a: number, b: number, c: number, offBase: number, ll0: boolean): void {
    if (offBase > REP_CODES) {
      this.repA = offBase - OFFSET_BIAS;
      this.repB = a;
      this.repC = b;
      return;
    }
    const index = offBase - 1 + (ll0 ? 1 : 0);
    if (index === 0) {
      this.repA = a;
      this.repB = b;
      this.repC = c;
    } else if (index === 1) {
      this.repA = b;
      this.repB = a;
      this.repC = c;
    } else if (index === 2) {
      this.repA = c;
      this.repB = a;
      this.repC = b;
    } else {
      this.repA = a - 1;
      this.repB = a;
      this.repC = b;
    }
  }

  // -------------------------------------------------------------------------
  // Parsing
  // -------------------------------------------------------------------------

  /**
   * Parses [blockStart, blockEnd) into sequences using the repeat offsets currently set on this
   * parser. Returns the number of literals that follow the last sequence.
   */
  public parseBlock(blockStart: number, blockEnd: number, store: SequenceStore): number {
    this.limit = blockEnd;
    this.prepareStats(blockStart, blockEnd);
    if (this.firstBlock) {
      this.firstBlock = false;
      if (this.params.seedFirstBlock && this.data.length <= SEED_INPUT_MAX_BYTES) {
        const saved1 = this.rep1;
        const saved2 = this.rep2;
        const saved3 = this.rep3;
        this.depthLimit = Math.min(this.params.searchDepth, SEED_PASS_DEPTH);
        this.runPass(blockStart, blockEnd, store);
        this.depthLimit = this.params.searchDepth;
        this.rep1 = saved1;
        this.rep2 = saved2;
        this.rep3 = saved3;
        this.resetMatchFinder();
        this.prepareStats(blockStart, blockEnd);
      }
    }
    return this.runPass(blockStart, blockEnd, store);
  }

  private runPass(blockStart: number, blockEnd: number, store: SequenceStore): number {
    const d = this.data;
    const optPrice = this.optPrice;
    const optMlen = this.optMlen;
    const optOff = this.optOff;
    const optLitlen = this.optLitlen;
    const optRep0 = this.optRep0;
    const optRep1 = this.optRep1;
    const optRep2 = this.optRep2;
    const matchLen = this.matchLen;
    const matchOff = this.matchOff;
    const ofCost = this.ofCost;
    const sufficient = this.sufficient;
    const skipSearch = this.skipSearch;
    const earlyAbort = this.earlyAbort;
    const lastProbe = Math.min(blockEnd - MIN_MATCH_LENGTH, this.insertEnd);
    let p = blockStart;
    let anchor = blockStart;
    store.count = 0;

    while (p <= lastProbe) {
      const startLit = p - anchor;
      this.rep0Cur = this.rep1;
      this.rep1Cur = this.rep2;
      this.rep2Cur = this.rep3;
      const first = this.findMatches(p, startLit === 0);
      if (first === 0) {
        p++;
        continue;
      }

      optMlen[0] = 0;
      optOff[0] = 0;
      optLitlen[0] = startLit;
      optPrice[0] = this.llPrice(startLit);
      optRep0[0] = this.rep1;
      optRep1[0] = this.rep2;
      optRep2[0] = this.rep3;

      const longestFirst = matchLen[first - 1];
      if (longestFirst > sufficient) {
        const pick = this.pickLongMatch(first, p);
        this.commitPath(anchor, 0, matchLen[pick], matchOff[pick], store);
        anchor = this.anchorOut;
        p = anchor;
        continue;
      }

      const zeroLitPrice = this.llPrice(0);
      let lastPos: number;
      {
        let pos = 1;
        for (; pos < MIN_MATCH_LENGTH; pos++) optPrice[pos] = PRICE_MAX;
        const basePrice = optPrice[0] + zeroLitPrice + SEQUENCE_BIAS;
        for (let k = 0; k < first; k++) {
          const off = matchOff[k];
          const ofc = ofCost[highBit32(off)];
          const end = matchLen[k];
          for (; pos <= end; pos++) {
            optMlen[pos] = pos;
            optOff[pos] = off;
            optLitlen[pos] = 0;
            optPrice[pos] = basePrice + ofc + this.mlPrice(pos);
          }
        }
        lastPos = pos - 1;
        optPrice[pos] = PRICE_MAX;
      }

      let tailLen = 0;
      let tailOff = 0;
      let tailCur = 0;
      for (let cur = 1; cur <= lastPos; cur++) {
        // One more literal on the plan that reaches cur - 1.
        const litlen = optLitlen[cur - 1] + 1;
        const literalPrice =
          optPrice[cur - 1] + this.litCost[d[p + cur - 1]] + this.llPrice(litlen) - this.llPrice(litlen - 1);
        if (literalPrice <= optPrice[cur]) {
          optMlen[cur] = 0;
          optOff[cur] = 0;
          optLitlen[cur] = litlen;
          optPrice[cur] = literalPrice;
        }
        // Offset history after the cheapest plan that reaches cur.
        if (optLitlen[cur] === 0) {
          const prev = cur - optMlen[cur];
          this.stepReps(optRep0[prev], optRep1[prev], optRep2[prev], optOff[cur], optLitlen[prev] === 0);
          optRep0[cur] = this.repA;
          optRep1[cur] = this.repB;
          optRep2[cur] = this.repC;
        } else {
          optRep0[cur] = optRep0[cur - 1];
          optRep1[cur] = optRep1[cur - 1];
          optRep2[cur] = optRep2[cur - 1];
        }

        const here = p + cur;
        if (here > lastProbe) continue;
        if (cur === lastPos) break;
        if (skipSearch && optPrice[cur + 1] <= optPrice[cur] + PRUNE_MARGIN) continue;

        const ll0 = optLitlen[cur] === 0;
        this.rep0Cur = optRep0[cur];
        this.rep1Cur = optRep1[cur];
        this.rep2Cur = optRep2[cur];
        const found = this.findMatches(here, ll0);
        if (found === 0) continue;
        const longest = matchLen[found - 1];
        if (longest > sufficient || cur + longest >= ZSTD_OPTIMAL_WINDOW || here + longest >= blockEnd) {
          const pick = this.pickLongMatch(found, here);
          tailLen = matchLen[pick];
          tailOff = matchOff[pick];
          tailCur = cur;
          break;
        }

        const basePrice = optPrice[cur] + zeroLitPrice + SEQUENCE_BIAS;
        for (let k = 0; k < found; k++) {
          const off = matchOff[k];
          const ofc = ofCost[highBit32(off)];
          const startLen = k > 0 ? matchLen[k - 1] + 1 : MIN_MATCH_LENGTH;
          for (let len = matchLen[k]; len >= startLen; len--) {
            const pos = cur + len;
            const price = basePrice + ofc + this.mlPrice(len);
            if (pos > lastPos || price < optPrice[pos]) {
              while (lastPos < pos) optPrice[++lastPos] = PRICE_MAX;
              optMlen[pos] = len;
              optOff[pos] = off;
              optLitlen[pos] = 0;
              optPrice[pos] = price;
            } else if (earlyAbort) {
              break;
            }
          }
        }
        optPrice[lastPos + 1] = PRICE_MAX;
      }

      if (tailLen > 0) {
        this.commitPath(anchor, tailCur, tailLen, tailOff, store);
        anchor = this.anchorOut;
        p = anchor;
      } else {
        this.commitPath(anchor, lastPos, 0, 0, store);
        anchor = this.anchorOut;
        p += lastPos;
      }
    }
    return blockEnd - anchor;
  }

  /**
   * Chooses the match to take outright when the longest candidate is long enough to end the search.
   * A slightly shorter candidate with a much cheaper offset (typically a repeat offset) wins when
   * the bytes it leaves over cost less as literals than the offset difference saves.
   */
  private pickLongMatch(found: number, here: number): number {
    const matchLen = this.matchLen;
    const matchOff = this.matchOff;
    const ofCost = this.ofCost;
    const litCost = this.litCost;
    const d = this.data;
    const longest = matchLen[found - 1];
    let best = found - 1;
    let bestPrice = ofCost[highBit32(matchOff[best])];
    for (let k = found - 2; k >= 0; k--) {
      const gap = longest - matchLen[k];
      if (gap > LONG_MATCH_GAP_MAX) break;
      let price = ofCost[highBit32(matchOff[k])];
      for (let i = 0; i < gap; i++) price += litCost[d[here + matchLen[k] + i]];
      if (price < bestPrice) {
        best = k;
        bestPrice = price;
      }
    }
    return best;
  }

  /**
   * Stores the cheapest plan that reaches window position `cur`, plus an optional final match that
   * starts there (after the literals pending at `cur`). Literals pending at the end of a plan without
   * a final match stay unstored and become the next window's leading literals.
   */
  private commitPath(
    anchor: number,
    cur: number,
    tailMatch: number,
    tailOffBase: number,
    store: SequenceStore
  ): void {
    const optMlen = this.optMlen;
    const optLitlen = this.optLitlen;
    const optOff = this.optOff;
    const seqLit = this.seqLit;
    const seqMatch = this.seqMatch;
    const seqOff = this.seqOff;
    let count = 0;
    let q = cur;
    if (tailMatch > 0) {
      const lit = optLitlen[q];
      seqLit[count] = lit;
      seqMatch[count] = tailMatch;
      seqOff[count] = tailOffBase;
      count++;
      q -= lit;
    } else {
      q -= optLitlen[q];
    }
    while (q > 0) {
      const len = optMlen[q];
      if (len < MIN_MATCH_LENGTH || count >= SEQUENCES_PER_WINDOW_MAX) {
        throw new ConversionFailedError('Zstandard encoder: optimal parse produced an inconsistent plan.');
      }
      const start = q - len;
      const lit = optLitlen[start];
      seqLit[count] = lit;
      seqMatch[count] = len;
      seqOff[count] = optOff[q];
      count++;
      q = start - lit;
    }

    let cursor = anchor;
    for (let i = count - 1; i >= 0; i--) {
      const lit = seqLit[i];
      const len = seqMatch[i];
      const offBase = seqOff[i];
      // A sequence spans at least three block bytes, so the store cannot fill up unless the plan is broken.
      if (store.count >= store.litLen.length) {
        throw new ConversionFailedError('Zstandard encoder: optimal parse overflowed the block sequence store.');
      }
      this.updateStats(cursor, lit, len, offBase);
      const slot = store.count++;
      store.litLen[slot] = lit;
      store.matchLen[slot] = len;
      store.offBase[slot] = offBase;
      this.stepReps(this.rep1, this.rep2, this.rep3, offBase, lit === 0);
      this.rep1 = this.repA;
      this.rep2 = this.repB;
      this.rep3 = this.repC;
      cursor += lit + len;
    }
    this.anchorOut = cursor;
    this.refreshCosts();
  }
}
