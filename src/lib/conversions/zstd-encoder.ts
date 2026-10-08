import {
  buildFseEncodeTable,
  estimateFseBits,
  fseInitState,
  highBit32,
  normalizeFseCounts,
  writeFseNormalizedTable,
  type FseEncodeTable,
} from './zstd-fse';
import {
  buildHuffmanEncodeTable,
  encodeHuffmanLiterals,
  estimateHuffmanBits,
  writeHuffmanTableDescription,
} from './zstd-huffman';
import {
  LL_BASELINE,
  LL_BITS,
  ML_BASELINE,
  ML_BITS,
  ZSTD_BLOCK_SIZE_MAX,
  ZSTD_FSE_ACCURACY_LOG_MIN,
  ZSTD_LL_DEFAULT_ACCURACY_LOG,
  ZSTD_LL_DEFAULT_DISTRIBUTION,
  ZSTD_LL_MAX_ACCURACY_LOG,
  ZSTD_LL_MAX_CODE,
  ZSTD_ML_DEFAULT_ACCURACY_LOG,
  ZSTD_ML_DEFAULT_DISTRIBUTION,
  ZSTD_ML_MAX_ACCURACY_LOG,
  ZSTD_ML_MAX_CODE,
  ZSTD_OF_DEFAULT_ACCURACY_LOG,
  ZSTD_OF_DEFAULT_DISTRIBUTION,
  ZSTD_OF_MAX_ACCURACY_LOG,
  ZSTD_OF_MAX_CODE,
  ZSTD_REP_OFFSET_INITIAL,
} from './zstd-tables';

/**
 * RFC 8878 compressor: LZ77 match finding (hash chains, lazy matching, repeat offsets) and
 * compressed-block emission (Huffman literals, FSE sequences).
 */

// ---------------------------------------------------------------------------
// Level table
// ---------------------------------------------------------------------------

export interface ZstdLevelParams {
  /** log2 of the declared window (largest allowed match offset). */
  windowLog: number;
  /** log2 of the hash head table size. */
  hashLog: number;
  /** log2 of the chain table size; 0 disables chains (single probe). */
  chainLog: number;
  /** Maximum candidates visited per position. */
  searchDepth: number;
  /** Shortest hash-found match accepted; also the number of bytes hashed (4 to 6). */
  minMatch: number;
  /** A match at least this long ends the search immediately. */
  niceLength: number;
  /** Lazy evaluation lookahead: 0 greedy, 1 lazy, 2 lazy2. */
  lazyDepth: number;
  /** Search acceleration: step grows every 2^skipStrength unmatched bytes; 0 disables it. */
  skipStrength: number;
  /** Insert every position of an accepted match into the hash chains. */
  insertMatchInterior: boolean;
  /**
   * With interior insertion on, a match longer than twice this many bytes inserts only its first and last this many
   * positions into the chains; the middle of a long match mostly repeats positions the finder already knows.
   */
  interiorInsertCap?: number;
}

const LEVEL_PARAMS_TABLE: readonly ZstdLevelParams[] = [
  // level 1
  { windowLog: 19, hashLog: 14, chainLog: 0, searchDepth: 1, minMatch: 5, niceLength: 16, lazyDepth: 0, skipStrength: 6, insertMatchInterior: false },
  // level 2
  { windowLog: 19, hashLog: 15, chainLog: 0, searchDepth: 1, minMatch: 5, niceLength: 24, lazyDepth: 0, skipStrength: 6, insertMatchInterior: false },
  // level 3
  { windowLog: 20, hashLog: 16, chainLog: 16, searchDepth: 4, minMatch: 4, niceLength: 32, lazyDepth: 0, skipStrength: 7, insertMatchInterior: true, interiorInsertCap: 16 },
  // level 4
  { windowLog: 20, hashLog: 17, chainLog: 17, searchDepth: 6, minMatch: 4, niceLength: 48, lazyDepth: 1, skipStrength: 7, insertMatchInterior: true },
  // level 5
  { windowLog: 21, hashLog: 17, chainLog: 18, searchDepth: 8, minMatch: 4, niceLength: 48, lazyDepth: 1, skipStrength: 8, insertMatchInterior: true },
  // level 6
  { windowLog: 21, hashLog: 18, chainLog: 18, searchDepth: 12, minMatch: 4, niceLength: 64, lazyDepth: 1, skipStrength: 8, insertMatchInterior: true },
  // level 7
  { windowLog: 21, hashLog: 18, chainLog: 19, searchDepth: 16, minMatch: 4, niceLength: 64, lazyDepth: 1, skipStrength: 0, insertMatchInterior: true },
  // level 8
  { windowLog: 22, hashLog: 19, chainLog: 19, searchDepth: 24, minMatch: 4, niceLength: 96, lazyDepth: 2, skipStrength: 0, insertMatchInterior: true },
  // level 9
  { windowLog: 22, hashLog: 19, chainLog: 20, searchDepth: 32, minMatch: 4, niceLength: 128, lazyDepth: 2, skipStrength: 0, insertMatchInterior: true },
  // level 10
  { windowLog: 22, hashLog: 20, chainLog: 20, searchDepth: 48, minMatch: 4, niceLength: 128, lazyDepth: 2, skipStrength: 0, insertMatchInterior: true },
  // level 11
  { windowLog: 22, hashLog: 20, chainLog: 21, searchDepth: 64, minMatch: 4, niceLength: 160, lazyDepth: 2, skipStrength: 0, insertMatchInterior: true },
  // level 12
  { windowLog: 23, hashLog: 20, chainLog: 21, searchDepth: 96, minMatch: 4, niceLength: 192, lazyDepth: 2, skipStrength: 0, insertMatchInterior: true },
  // level 13
  { windowLog: 23, hashLog: 21, chainLog: 22, searchDepth: 128, minMatch: 4, niceLength: 224, lazyDepth: 2, skipStrength: 0, insertMatchInterior: true },
  // level 14
  { windowLog: 23, hashLog: 21, chainLog: 22, searchDepth: 160, minMatch: 4, niceLength: 256, lazyDepth: 2, skipStrength: 0, insertMatchInterior: true },
  // level 15
  { windowLog: 23, hashLog: 21, chainLog: 22, searchDepth: 192, minMatch: 4, niceLength: 256, lazyDepth: 2, skipStrength: 0, insertMatchInterior: true },
  // level 16
  { windowLog: 23, hashLog: 22, chainLog: 22, searchDepth: 256, minMatch: 4, niceLength: 256, lazyDepth: 2, skipStrength: 0, insertMatchInterior: true },
  // level 17
  { windowLog: 23, hashLog: 22, chainLog: 23, searchDepth: 320, minMatch: 4, niceLength: 384, lazyDepth: 2, skipStrength: 0, insertMatchInterior: true },
  // level 18
  { windowLog: 23, hashLog: 22, chainLog: 23, searchDepth: 448, minMatch: 4, niceLength: 512, lazyDepth: 2, skipStrength: 0, insertMatchInterior: true },
  // level 19
  { windowLog: 23, hashLog: 22, chainLog: 23, searchDepth: 640, minMatch: 4, niceLength: 768, lazyDepth: 2, skipStrength: 0, insertMatchInterior: true },
];

/** Search parameters for a level in 1..19. */
export function getZstdLevelParams(level: number): ZstdLevelParams {
  return LEVEL_PARAMS_TABLE[level - 1];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const HASH_MULTIPLIER_A = 2654435761;
const HASH_MULTIPLIER_B = 2246822519;
const HASH_READ_BYTES = 8;
const REP_MIN_MATCH = 3;
const MIN_MATCH_CODE_LENGTH = 3;
/** Approximate fixed cost of a sequence: literal-length and match-length symbols plus their extras. */
const MATCH_OVERHEAD_BITS = 10;
/** Approximate cost of the offset symbol beyond the offset's own extra bits. */
const OFFSET_SYMBOL_BITS = 3;
const REP_SYMBOL_BITS = 2;
const LITERAL_BITS_MAX = 8;
const LITERAL_BITS_MIN = 1;
/** Every 2^N consecutive unmatched bytes halve the chain search depth, bounding time on incompressible data. */
const LITERAL_RUN_DEPTH_SHIFT = 8;
const LITERAL_RUN_DEPTH_SHIFT_MAX = 6;
const NO_POSITION = -1;
const OUTPUT_MIN_INITIAL_BYTES = 1024;
const MIN_TABLE_LOG = 8;
const RLE_BLOCK_MIN_LENGTH = 8;
const HUFFMAN_MIN_LITERALS = 32;
const SINGLE_STREAM_LITERALS_MAX = 1023;
const FOUR_STREAM_FORMAT10_MAX = 16383;
const RAW_LITERALS_ONE_BYTE_MAX = 31;
const RAW_LITERALS_TWO_BYTE_MAX = 4095;
const SEQ_COUNT_TWO_BYTE_BASE = 128;
const SEQ_COUNT_TWO_BYTE_LIMIT = 0x7f00;
const SEQ_COUNT_MARKER = 255;
const MODE_PREDEFINED = 0;
const MODE_RLE = 1;
const MODE_COMPRESSED = 2;
const BLOCK_HEADER_BYTES = 3;
const BLOCK_TYPE_RAW = 0;
const BLOCK_TYPE_RLE = 1;
const BLOCK_TYPE_COMPRESSED = 2;
const BITS_PER_BYTE = 8;
const SMALL_CODE_LOOKUP_SIZE = 64;
const MATCH_CODE_LOOKUP_SIZE = 128;
const LL_LARGE_CODE_BIAS = 19;
/** Most bytes one sequence can add to the bitstream: 16 + 16 + 31 extra bits and three FSE states of up to 9 bits. */
const SEQUENCE_MAX_BYTES = 16;
/** Offsets up to 2^24 fit one accumulator write next to the pending bits; larger ones are written in two parts. */
const OFFSET_WINDOW_BITS_MAX = 24;
const OFFSET_LOW_BITS = 16;
const OFFSET_LOW_MASK = (1 << OFFSET_LOW_BITS) - 1;
const OFFSET_LOW_RADIX = 1 << OFFSET_LOW_BITS;
/** Typed copies of the code tables: module-local, so no accessor call per use under CommonJS interop. */
const LL_BASELINE_TABLE = Uint32Array.from(LL_BASELINE);
const LL_BITS_TABLE = Uint8Array.from(LL_BITS);
const ML_BASELINE_TABLE = Uint32Array.from(ML_BASELINE);
const ML_BITS_TABLE = Uint8Array.from(ML_BITS);
const ML_LARGE_CODE_BIAS = 36;

/** Worst-case compressed size of `inputLength` bytes (raw blocks plus framing). */
export function zstdBlocksBound(inputLength: number): number {
  const blocks = Math.max(1, Math.ceil(inputLength / ZSTD_BLOCK_SIZE_MAX));
  return inputLength + blocks * BLOCK_HEADER_BYTES;
}

// ---------------------------------------------------------------------------
// Code lookup
// ---------------------------------------------------------------------------

function buildLookup(baselines: readonly number[], size: number, valueBias: number): Uint8Array {
  const lookup = new Uint8Array(size);
  let code = 0;
  for (let v = 0; v < size; v++) {
    const value = v + valueBias;
    while (code + 1 < baselines.length && baselines[code + 1] <= value) code++;
    lookup[v] = code;
  }
  return lookup;
}

const LL_CODE_LOOKUP = buildLookup(LL_BASELINE, SMALL_CODE_LOOKUP_SIZE, 0);
const ML_CODE_LOOKUP = buildLookup(ML_BASELINE, MATCH_CODE_LOOKUP_SIZE, MIN_MATCH_CODE_LENGTH);

function llCodeOf(litLen: number): number {
  return litLen < SMALL_CODE_LOOKUP_SIZE ? LL_CODE_LOOKUP[litLen] : highBit32(litLen) + LL_LARGE_CODE_BIAS;
}

function mlCodeOf(matchLen: number): number {
  const base = matchLen - MIN_MATCH_CODE_LENGTH;
  return base < MATCH_CODE_LOOKUP_SIZE ? ML_CODE_LOOKUP[base] : highBit32(base) + ML_LARGE_CODE_BIAS;
}

// ---------------------------------------------------------------------------
// Match finder
// ---------------------------------------------------------------------------

class SequenceStore {
  public count = 0;
  public readonly litLen: Uint32Array;
  public readonly matchLen: Uint32Array;
  public readonly offBase: Uint32Array;

  constructor(capacity: number) {
    this.litLen = new Uint32Array(capacity);
    this.matchLen = new Uint32Array(capacity);
    this.offBase = new Uint32Array(capacity);
  }
}

class MatchFinder {
  public rep1: number = ZSTD_REP_OFFSET_INITIAL[0];
  public rep2: number = ZSTD_REP_OFFSET_INITIAL[1];
  public rep3: number = ZSTD_REP_OFFSET_INITIAL[2];

  private readonly data: Uint8Array;
  private readonly view: DataView;
  private readonly dataLength: number;
  private readonly params: ZstdLevelParams;
  private readonly windowSize: number;
  private readonly head: Int32Array;
  private readonly chain: Int32Array | null;
  private readonly hashShift: number;
  private readonly chainMask: number;
  private readonly chainReach: number;
  private readonly insertEnd: number;
  private nextInsert = 0;
  private bestLen = 0;
  private bestOffset = 0;
  private bestScore = 0;
  private depthLimit = 1;
  /** Estimated cost in bits of one literal byte in the block being parsed. */
  public literalBits = LITERAL_BITS_MAX;

  constructor(data: Uint8Array, params: ZstdLevelParams, windowSize: number) {
    this.data = data;
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    this.dataLength = data.length;
    this.params = params;
    this.windowSize = windowSize;
    // Tables never need more slots than roughly two per input byte.
    const inputLog = Math.max(MIN_TABLE_LOG, 32 - Math.clz32(data.length) + 1);
    const hashLog = Math.min(params.hashLog, inputLog);
    const chainLog = Math.min(params.chainLog, inputLog);
    this.head = new Int32Array(1 << hashLog).fill(NO_POSITION);
    this.hashShift = 32 - hashLog;
    if (chainLog > 0 && params.searchDepth > 1) {
      this.chain = new Int32Array(1 << chainLog);
      this.chainMask = (1 << chainLog) - 1;
    } else {
      this.chain = null;
      this.chainMask = 0;
    }
    this.chainReach = this.chainMask - HASH_READ_BYTES;
    this.insertEnd = data.length - HASH_READ_BYTES;
  }

  /** Hash of the minMatch bytes at p, given the little-endian word of the first four. */
  private hashOfWord(word: number, p: number): number {
    const d = this.data;
    let h = Math.imul(word, HASH_MULTIPLIER_A);
    const minMatch = this.params.minMatch;
    if (minMatch >= 5) {
      const tail = minMatch >= 6 ? d[p + 4] | (d[p + 5] << 8) : d[p + 4];
      h ^= Math.imul(tail + 1, HASH_MULTIPLIER_B);
      h = Math.imul(h ^ (h >>> 15), HASH_MULTIPLIER_A);
    }
    return h >>> this.hashShift;
  }

  private hash(p: number): number {
    const d = this.data;
    return this.hashOfWord(d[p] | (d[p + 1] << 8) | (d[p + 2] << 16) | (d[p + 3] << 24), p);
  }

  /**
   * Inserts every position in [nextInsert, p) into the hash chains (clamped to the last hashable position). The word of
   * four bytes is rolled from one position to the next, so each insertion loads one new byte instead of four.
   */
  private catchUpTo(p: number): void {
    let next = this.nextInsert;
    const stop = p < this.insertEnd + 1 ? p : this.insertEnd + 1;
    if (next >= stop) return;
    const d = this.data;
    const head = this.head;
    const chain = this.chain;
    const chainMask = this.chainMask;
    let word = d[next] | (d[next + 1] << 8) | (d[next + 2] << 16) | (d[next + 3] << 24);
    while (next < stop) {
      const h = this.hashOfWord(word, next);
      if (chain !== null) chain[next & chainMask] = head[h];
      head[h] = next;
      next++;
      word = (word >>> 8) | (d[next + 3] << 24);
    }
    this.nextInsert = next;
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

  /** Sets bestLen/bestOffset/bestScore for position p; bestLen is 0 when nothing qualifies. */
  private findBest(p: number, limit: number): void {
    const maxLen = limit - p;
    let bestLen = 0;
    let bestOffset = 0;
    let bestScore = 0;

    for (let r = 0; r < 3; r++) {
      let offset = this.rep3;
      if (r === 0) offset = this.rep1;
      else if (r === 1) offset = this.rep2;
      if (offset > p || offset > this.windowSize) continue;
      const len = this.matchLength(p - offset, p, maxLen);
      if (len < REP_MIN_MATCH) continue;
      const score = len * this.literalBits - MATCH_OVERHEAD_BITS - REP_SYMBOL_BITS;
      if (score > bestScore) {
        bestScore = score;
        bestLen = len;
        bestOffset = offset;
      }
    }

    if (bestLen < maxLen && bestLen < this.params.niceLength) {
      const found = this.searchChain(p, maxLen, bestLen);
      if (found > 0) {
        const score =
          found * this.literalBits - MATCH_OVERHEAD_BITS - OFFSET_SYMBOL_BITS - highBit32(this.bestOffset + 1);
        if (score > bestScore) {
          bestScore = score;
          bestLen = found;
          bestOffset = this.bestOffset;
        }
      }
    }
    this.bestLen = bestLen;
    this.bestOffset = bestOffset;
    this.bestScore = bestScore;
  }

  /** Hash-chain probe. Returns the best length (> floor) and leaves its offset in bestOffset, else 0. */
  private searchChain(p: number, maxLen: number, floor: number): number {
    const params = this.params;
    const d = this.data;
    const chain = this.chain;
    let cand = this.head[this.hash(p)];
    let bestLen = floor > params.minMatch - 1 ? floor : params.minMatch - 1;
    let bestOffset = 0;
    let steps = this.depthLimit;
    const nice = params.niceLength;
    while (cand !== NO_POSITION && steps > 0) {
      steps--;
      const distance = p - cand;
      if (distance > this.windowSize) break;
      if (d[cand + bestLen] === d[p + bestLen]) {
        const len = this.matchLength(cand, p, maxLen);
        if (len > bestLen) {
          const gain = this.literalBits * (len - bestLen);
          const costDelta = bestOffset === 0 ? 0 : highBit32(distance + 1) - highBit32(bestOffset + 1);
          if (bestOffset === 0 || gain > costDelta) {
            bestLen = len;
            bestOffset = distance;
          }
          if (len >= nice || len === maxLen) break;
        }
      }
      if (chain === null || distance > this.chainReach) break;
      const next = chain[cand & this.chainMask];
      if (next >= cand) break;
      cand = next;
    }
    if (bestOffset === 0) return 0;
    this.bestOffset = bestOffset;
    return bestLen;
  }

  /** Maps an offset to its offset value (RFC 8878 section 3.1.2.5) and updates repeat offsets. */
  private resolveOffset(offset: number, litLen: number): number {
    if (litLen > 0) {
      if (offset === this.rep1) return 1;
      if (offset === this.rep2) {
        this.rep2 = this.rep1;
        this.rep1 = offset;
        return 2;
      }
      if (offset === this.rep3) {
        this.rep3 = this.rep2;
        this.rep2 = this.rep1;
        this.rep1 = offset;
        return 3;
      }
    } else {
      if (offset === this.rep2) {
        this.rep2 = this.rep1;
        this.rep1 = offset;
        return 1;
      }
      if (offset === this.rep3) {
        this.rep3 = this.rep2;
        this.rep2 = this.rep1;
        this.rep1 = offset;
        return 2;
      }
      if (this.rep1 > 1 && offset === this.rep1 - 1) {
        this.rep3 = this.rep2;
        this.rep2 = this.rep1;
        this.rep1 = offset;
        return 3;
      }
    }
    this.rep3 = this.rep2;
    this.rep2 = this.rep1;
    this.rep1 = offset;
    return offset + 3;
  }

  /**
   * Parses [blockStart, blockEnd) into sequences using the repeat offsets currently set on this
   * finder. Returns the number of literals that follow the last sequence.
   */
  public parseBlock(blockStart: number, blockEnd: number, store: SequenceStore): number {
    const params = this.params;
    const lazyDepth = params.lazyDepth;
    const skipStrength = params.skipStrength;
    const interiorCap = params.interiorInsertCap ?? Infinity;
    const lastProbe = Math.min(blockEnd - REP_MIN_MATCH, this.insertEnd);
    let p = blockStart;
    let anchor = blockStart;
    store.count = 0;

    while (p <= lastProbe) {
      this.catchUpTo(p);
      const literalRun = p - anchor;
      const depthShift = Math.min(LITERAL_RUN_DEPTH_SHIFT_MAX, literalRun >> LITERAL_RUN_DEPTH_SHIFT);
      this.depthLimit = Math.max(1, params.searchDepth >> depthShift);
      this.findBest(p, blockEnd);
      if (this.bestLen === 0) {
        const step = skipStrength > 0 ? 1 + ((p - anchor) >> skipStrength) : 1;
        if (step > 1) {
          // Positions inside a stride over incompressible bytes are not worth inserting: only the probed one is.
          this.catchUpTo(p + 1);
          if (p + step > this.nextInsert) this.nextInsert = p + step;
        }
        p += step;
        continue;
      }
      let len = this.bestLen;
      let offset = this.bestOffset;
      let score = this.bestScore;

      if (lazyDepth > 0 && len < params.niceLength) {
        for (let depth = 0; depth < lazyDepth && p + 1 <= lastProbe && len < params.niceLength; depth++) {
          this.catchUpTo(p + 1);
          this.findBest(p + 1, blockEnd);
          if (this.bestLen > 0 && this.bestScore > score + this.literalBits) {
            p++;
            len = this.bestLen;
            offset = this.bestOffset;
            score = this.bestScore;
            depth = -1;
          } else {
            break;
          }
        }
      }

      while (p > anchor && p > offset && this.data[p - 1] === this.data[p - 1 - offset]) {
        p--;
        len++;
      }

      const litLen = p - anchor;
      const idx = store.count++;
      store.litLen[idx] = litLen;
      store.matchLen[idx] = len;
      store.offBase[idx] = this.resolveOffset(offset, litLen);
      const matchEnd = p + len;
      if (!params.insertMatchInterior) {
        this.catchUpTo(p + 1);
        const skipTo = matchEnd - 2;
        if (skipTo > this.nextInsert) this.nextInsert = skipTo;
      } else if (len > interiorCap * 2) {
        this.catchUpTo(p + 1 + interiorCap);
        const skipTo = matchEnd - interiorCap;
        if (skipTo > this.nextInsert) this.nextInsert = skipTo;
      }
      p = matchEnd;
      anchor = matchEnd;
    }
    return blockEnd - anchor;
  }

}

// ---------------------------------------------------------------------------
// Block encoding
// ---------------------------------------------------------------------------

interface ModeChoice {
  mode: number;
  /** Encode table for compressed and predefined modes; null for RLE. */
  table: FseEncodeTable | null;
  rleSymbol: number;
  /** Serialised table description (compressed mode) or the RLE symbol byte. */
  description: Uint8Array;
}

function padDistribution(distribution: readonly number[], maxSymbol: number): Int16Array {
  const padded = new Int16Array(maxSymbol + 1);
  for (let i = 0; i < distribution.length; i++) padded[i] = distribution[i];
  return padded;
}

interface PredefinedEncoder {
  distribution: Int16Array;
  accuracyLog: number;
  maxSymbol: number;
  table: FseEncodeTable;
}

function buildPredefined(distribution: readonly number[], maxSymbol: number, accuracyLog: number): PredefinedEncoder {
  const padded = padDistribution(distribution, maxSymbol);
  const lastNonZero = distribution.length - 1;
  return { distribution: padded, accuracyLog, maxSymbol, table: buildFseEncodeTable(padded, lastNonZero, accuracyLog) };
}

const PREDEFINED_LL = buildPredefined(ZSTD_LL_DEFAULT_DISTRIBUTION, ZSTD_LL_MAX_CODE, ZSTD_LL_DEFAULT_ACCURACY_LOG);
const PREDEFINED_ML = buildPredefined(ZSTD_ML_DEFAULT_DISTRIBUTION, ZSTD_ML_MAX_CODE, ZSTD_ML_DEFAULT_ACCURACY_LOG);
const PREDEFINED_OF = buildPredefined(ZSTD_OF_DEFAULT_DISTRIBUTION, ZSTD_OF_MAX_CODE, ZSTD_OF_DEFAULT_ACCURACY_LOG);

const TABLE_DESCRIPTION_SCRATCH_BYTES = 512;

function chooseSymbolMode(
  histogram: Uint32Array,
  maxSymbol: number,
  count: number,
  predefined: PredefinedEncoder,
  maxAccuracyLog: number
): ModeChoice {
  let distinct = 0;
  let onlySymbol = 0;
  let highest = 0;
  for (let s = 0; s <= maxSymbol; s++) {
    if (histogram[s] > 0) {
      distinct++;
      onlySymbol = s;
      highest = s;
    }
  }
  if (distinct === 1) {
    return { mode: MODE_RLE, table: null, rleSymbol: onlySymbol, description: Uint8Array.of(onlySymbol) };
  }
  const predefinedBits = estimateFseBits(histogram, maxSymbol, predefined.distribution, predefined.accuracyLog);

  let bestBits = Infinity;
  let bestLog = 0;
  let bestCounts: Int16Array | null = null;
  let bestDescription: Uint8Array | null = null;
  const scratch = new Uint8Array(TABLE_DESCRIPTION_SCRATCH_BYTES);
  let minLog = ZSTD_FSE_ACCURACY_LOG_MIN;
  while (1 << minLog < distinct) minLog++;
  for (let accuracyLog = minLog; accuracyLog <= maxAccuracyLog; accuracyLog++) {
    const counts = normalizeFseCounts(histogram, highest, count, accuracyLog);
    const end = writeFseNormalizedTable(scratch, 0, counts, highest, accuracyLog);
    if (end < 0) continue;
    const bits = estimateFseBits(histogram, highest, counts, accuracyLog) + end * BITS_PER_BYTE;
    if (bits < bestBits) {
      bestBits = bits;
      bestLog = accuracyLog;
      bestCounts = counts;
      bestDescription = scratch.slice(0, end);
    }
  }
  if (bestCounts !== null && bestDescription !== null && bestBits < predefinedBits) {
    return {
      mode: MODE_COMPRESSED,
      table: buildFseEncodeTable(bestCounts, highest, bestLog),
      rleSymbol: 0,
      description: bestDescription,
    };
  }
  if (!Number.isFinite(predefinedBits)) {
    throw new Error('Zstandard encoder: no feasible sequence table mode.');
  }
  return { mode: MODE_PREDEFINED, table: predefined.table, rleSymbol: 0, description: new Uint8Array(0) };
}

export class ZstdBlockEncoder {
  private readonly data: Uint8Array;
  private readonly finder: MatchFinder;
  private readonly store: SequenceStore;
  private readonly literals = new Uint8Array(ZSTD_BLOCK_SIZE_MAX);
  private readonly llCodes: Uint8Array;
  private readonly mlCodes: Uint8Array;
  private readonly ofCodes: Uint8Array;
  private readonly llHistogram = new Uint32Array(ZSTD_LL_MAX_CODE + 1);
  private readonly mlHistogram = new Uint32Array(ZSTD_ML_MAX_CODE + 1);
  private readonly ofHistogram = new Uint32Array(ZSTD_OF_MAX_CODE + 1);
  private readonly literalHistogram = new Uint32Array(256);
  private readonly blockHistogram = new Uint32Array(256);
  private out = new Uint8Array(0);
  private outBound = 0;
  private committedRep1: number = ZSTD_REP_OFFSET_INITIAL[0];
  private committedRep2: number = ZSTD_REP_OFFSET_INITIAL[1];
  private committedRep3: number = ZSTD_REP_OFFSET_INITIAL[2];

  constructor(data: Uint8Array, params: ZstdLevelParams, windowSize: number) {
    this.data = data;
    this.finder = new MatchFinder(data, params, windowSize);
    const capacity = Math.floor(ZSTD_BLOCK_SIZE_MAX / REP_MIN_MATCH) + 2;
    this.store = new SequenceStore(capacity);
    this.llCodes = new Uint8Array(capacity);
    this.mlCodes = new Uint8Array(capacity);
    this.ofCodes = new Uint8Array(capacity);
  }

  /**
   * Encodes the whole input as blocks after `prefix`, leaving `trailerBytes` of spare room for the
   * caller. The output buffer starts at roughly half the input size (compressible data never
   * outgrows that) and grows toward the raw-block bound only if the data turns out incompressible.
   */
  public encodeAll(prefix: Uint8Array, trailerBytes: number): { data: Uint8Array; length: number } {
    const length = this.data.length;
    const fixed = prefix.length + trailerBytes;
    const bound = fixed + zstdBlocksBound(length);
    const initial = Math.min(bound, fixed + Math.max(OUTPUT_MIN_INITIAL_BYTES, Math.ceil(length / 2)));
    this.out = new Uint8Array(initial);
    this.out.set(prefix);
    this.outBound = bound;
    let pos = prefix.length;
    if (length === 0) {
      this.reserve(pos, BLOCK_HEADER_BYTES);
      this.out[pos++] = 1;
      this.out[pos++] = 0;
      this.out[pos++] = 0;
    }
    for (let blockStart = 0; blockStart < length; blockStart += ZSTD_BLOCK_SIZE_MAX) {
      const blockEnd = Math.min(blockStart + ZSTD_BLOCK_SIZE_MAX, length);
      this.reserve(pos, BLOCK_HEADER_BYTES + (blockEnd - blockStart) + trailerBytes);
      pos = this.encodeBlock(blockStart, blockEnd, blockEnd === length, this.out, pos);
    }
    this.reserve(pos, trailerBytes);
    return { data: this.out, length: pos };
  }

  /** Guarantees `extra` writable bytes after `pos`, growing (doubling, capped at the bound) if needed. */
  private reserve(pos: number, extra: number): void {
    if (pos + extra <= this.out.length) return;
    const capacity = Math.min(this.outBound, Math.max(this.out.length * 2, pos + extra));
    if (capacity < pos + extra) throw new Error('Zstandard encoder output exceeded its worst-case bound.');
    const grown = new Uint8Array(capacity);
    grown.set(this.out.subarray(0, pos));
    this.out = grown;
  }

  private writeBlockHeader(out: Uint8Array, pos: number, last: boolean, type: number, size: number): void {
    const value = (last ? 1 : 0) | (type << 1) | (size << 3);
    out[pos] = value & 0xff;
    out[pos + 1] = (value >> 8) & 0xff;
    out[pos + 2] = (value >> 16) & 0xff;
  }

  private isRunOfOneByte(start: number, end: number): boolean {
    const d = this.data;
    const first = d[start];
    for (let i = start + 1; i < end; i++) {
      if (d[i] !== first) return false;
    }
    return true;
  }

  /** Order-0 entropy of the block in bits per byte: the price match finding compares matches against. */
  private estimateLiteralBits(start: number, end: number): number {
    const histogram = this.blockHistogram.fill(0);
    const d = this.data;
    for (let i = start; i < end; i++) histogram[d[i]]++;
    const total = end - start;
    let weighted = 0;
    for (let s = 0; s < histogram.length; s++) {
      const c = histogram[s];
      if (c > 0) weighted += c * Math.log2(c);
    }
    const entropy = Math.log2(total) - weighted / total;
    return Math.min(LITERAL_BITS_MAX, Math.max(LITERAL_BITS_MIN, entropy));
  }

  private encodeBlock(blockStart: number, blockEnd: number, last: boolean, out: Uint8Array, pos: number): number {
    const size = blockEnd - blockStart;
    if (size >= RLE_BLOCK_MIN_LENGTH && this.isRunOfOneByte(blockStart, blockEnd)) {
      this.writeBlockHeader(out, pos, last, BLOCK_TYPE_RLE, size);
      out[pos + BLOCK_HEADER_BYTES] = this.data[blockStart];
      return pos + BLOCK_HEADER_BYTES + 1;
    }

    const finder = this.finder;
    finder.literalBits = this.estimateLiteralBits(blockStart, blockEnd);
    finder.rep1 = this.committedRep1;
    finder.rep2 = this.committedRep2;
    finder.rep3 = this.committedRep3;
    const trailing = finder.parseBlock(blockStart, blockEnd, this.store);
    const payloadStart = pos + BLOCK_HEADER_BYTES;
    // A compressed block is only worth emitting when it is strictly smaller than the raw payload.
    const cap = payloadStart + size - 1;
    const end = this.emitCompressedPayload(blockStart, blockEnd, trailing, out, payloadStart, cap);
    if (end >= 0) {
      this.committedRep1 = finder.rep1;
      this.committedRep2 = finder.rep2;
      this.committedRep3 = finder.rep3;
      this.writeBlockHeader(out, pos, last, BLOCK_TYPE_COMPRESSED, end - payloadStart);
      return end;
    }
    this.writeBlockHeader(out, pos, last, BLOCK_TYPE_RAW, size);
    out.set(this.data.subarray(blockStart, blockEnd), payloadStart);
    return payloadStart + size;
  }

  /** Writes literals + sequences sections at out[pos..cap]. Returns the end position or -1. */
  private emitCompressedPayload(
    blockStart: number,
    blockEnd: number,
    trailing: number,
    out: Uint8Array,
    pos: number,
    cap: number
  ): number {
    const store = this.store;
    const d = this.data;
    const lits = this.literals;
    let litCount = 0;
    let cursor = blockStart;
    for (let i = 0; i < store.count; i++) {
      const run = store.litLen[i];
      for (let k = 0; k < run; k++) lits[litCount++] = d[cursor + k];
      cursor += run + store.matchLen[i];
    }
    for (let k = blockEnd - trailing; k < blockEnd; k++) lits[litCount++] = d[k];

    const afterLiterals = this.writeLiteralsSection(litCount, out, pos, cap);
    if (afterLiterals < 0) return -1;
    return this.writeSequencesSection(out, afterLiterals, cap);
  }

  private rawLiteralsHeaderBytes(count: number): number {
    if (count <= RAW_LITERALS_ONE_BYTE_MAX) return 1;
    return count <= RAW_LITERALS_TWO_BYTE_MAX ? 2 : 3;
  }

  private writeRawHeader(type: number, count: number, out: Uint8Array, pos: number): number {
    if (count <= RAW_LITERALS_ONE_BYTE_MAX) {
      out[pos] = type | (count << 3);
      return pos + 1;
    }
    if (count <= RAW_LITERALS_TWO_BYTE_MAX) {
      const value = type | (1 << 2) | (count << 4);
      out[pos] = value & 0xff;
      out[pos + 1] = value >> 8;
      return pos + 2;
    }
    const value = type | (3 << 2) | (count << 4);
    out[pos] = value & 0xff;
    out[pos + 1] = (value >> 8) & 0xff;
    out[pos + 2] = value >> 16;
    return pos + 3;
  }

  private writeLiteralsSection(count: number, out: Uint8Array, pos: number, cap: number): number {
    const lits = this.literals;
    const rawHeaderBytes = this.rawLiteralsHeaderBytes(count);
    const rawEnd = pos + rawHeaderBytes + count;

    const histogram = this.literalHistogram;
    histogram.fill(0);
    for (let i = 0; i < count; i++) histogram[lits[i]]++;

    if (count > 1) {
      let distinct = 0;
      for (let s = 0; s < 256 && distinct < 2; s++) if (histogram[s] > 0) distinct++;
      if (distinct === 1) {
        if (pos + rawHeaderBytes + 1 > cap) return -1;
        const end = this.writeRawHeader(1, count, out, pos);
        out[end] = lits[0];
        return end + 1;
      }
    }

    if (count >= HUFFMAN_MIN_LITERALS) {
      const table = buildHuffmanEncodeTable(histogram);
      if (table !== null) {
        const estimatedBytes = (estimateHuffmanBits(table, histogram) + BITS_PER_BYTE - 1) >> 3;
        if (estimatedBytes < count) {
          const headerBytes = this.compressedLiteralsHeaderBytes(count);
          const payloadStart = pos + headerBytes;
          const treeEnd = writeHuffmanTableDescription(table, out, payloadStart, cap);
          if (treeEnd >= 0) {
            const fourStreams = count > SINGLE_STREAM_LITERALS_MAX;
            const streamsEnd = encodeHuffmanLiterals(table, lits, count, fourStreams, out, treeEnd, cap);
            if (streamsEnd >= 0 && streamsEnd < rawEnd) {
              this.writeCompressedLiteralsHeader(count, streamsEnd - payloadStart, fourStreams, out, pos);
              return streamsEnd;
            }
          }
        }
      }
    }

    if (rawEnd > cap) return -1;
    const end = this.writeRawHeader(0, count, out, pos);
    for (let i = 0; i < count; i++) out[end + i] = lits[i];
    return end + count;
  }

  private compressedLiteralsHeaderBytes(count: number): number {
    if (count <= SINGLE_STREAM_LITERALS_MAX) return 3;
    return count <= FOUR_STREAM_FORMAT10_MAX ? 4 : 5;
  }

  private writeCompressedLiteralsHeader(
    count: number,
    compressedSize: number,
    fourStreams: boolean,
    out: Uint8Array,
    pos: number
  ): void {
    let format: number;
    let sizeBits: number;
    let bytes: number;
    if (!fourStreams) {
      format = 0;
      sizeBits = 10;
      bytes = 3;
    } else if (count <= FOUR_STREAM_FORMAT10_MAX) {
      format = 2;
      sizeBits = 14;
      bytes = 4;
    } else {
      format = 3;
      sizeBits = 18;
      bytes = 5;
    }
    let value = 2 + format * 4 + count * 16 + compressedSize * 2 ** (4 + sizeBits);
    for (let i = 0; i < bytes; i++) {
      out[pos + i] = value % 256;
      value = Math.floor(value / 256);
    }
  }

  private writeSequencesSection(out: Uint8Array, startPos: number, cap: number): number {
    const store = this.store;
    const n = store.count;
    let pos = startPos;
    if (pos + 3 > cap) return -1;
    if (n < SEQ_COUNT_TWO_BYTE_BASE) {
      out[pos++] = n;
    } else if (n < SEQ_COUNT_TWO_BYTE_LIMIT) {
      out[pos++] = (n >> 8) + SEQ_COUNT_TWO_BYTE_BASE;
      out[pos++] = n & 0xff;
    } else {
      out[pos++] = SEQ_COUNT_MARKER;
      out[pos++] = (n - SEQ_COUNT_TWO_BYTE_LIMIT) & 0xff;
      out[pos++] = (n - SEQ_COUNT_TWO_BYTE_LIMIT) >> 8;
    }
    if (n === 0) return pos;

    const llHist = this.llHistogram.fill(0);
    const mlHist = this.mlHistogram.fill(0);
    const ofHist = this.ofHistogram.fill(0);
    const { llCodes, mlCodes, ofCodes } = this;
    for (let i = 0; i < n; i++) {
      const ll = llCodeOf(store.litLen[i]);
      const ml = mlCodeOf(store.matchLen[i]);
      const of = highBit32(store.offBase[i]);
      llCodes[i] = ll;
      mlCodes[i] = ml;
      ofCodes[i] = of;
      llHist[ll]++;
      mlHist[ml]++;
      ofHist[of]++;
    }

    const llChoice = chooseSymbolMode(llHist, ZSTD_LL_MAX_CODE, n, PREDEFINED_LL, ZSTD_LL_MAX_ACCURACY_LOG);
    const ofChoice = chooseSymbolMode(ofHist, ZSTD_OF_MAX_CODE, n, PREDEFINED_OF, ZSTD_OF_MAX_ACCURACY_LOG);
    const mlChoice = chooseSymbolMode(mlHist, ZSTD_ML_MAX_CODE, n, PREDEFINED_ML, ZSTD_ML_MAX_ACCURACY_LOG);

    const descriptionBytes = llChoice.description.length + ofChoice.description.length + mlChoice.description.length;
    if (pos + 1 + descriptionBytes > cap) return -1;
    out[pos++] = (llChoice.mode << 6) | (ofChoice.mode << 4) | (mlChoice.mode << 2);
    for (const choice of [llChoice, ofChoice, mlChoice]) {
      if (choice.mode === MODE_PREDEFINED) continue;
      out.set(choice.description, pos);
      pos += choice.description.length;
    }

    const llTable = llChoice.mode === MODE_RLE ? null : llChoice.table;
    const ofTable = ofChoice.mode === MODE_RLE ? null : ofChoice.table;
    const mlTable = mlChoice.mode === MODE_RLE ? null : mlChoice.table;
    return this.writeSequenceBitstream(out, pos, cap, n, llTable, ofTable, mlTable);
  }

  /**
   * Writes the interleaved FSE bitstream of the sequences in reverse order (RFC 8878 section 3.1.1.4), then the final
   * states and the end mark. The accumulator lives in locals and whole sequences are checked against the capacity
   * once, so no per-bit bookkeeping runs in the loop. Returns the end position, or -1 when the stream cannot fit below
   * `cap` (the caller then emits a raw block).
   */
  private writeSequenceBitstream(
    out: Uint8Array,
    startPos: number,
    cap: number,
    n: number,
    llTable: FseEncodeTable | null,
    ofTable: FseEncodeTable | null,
    mlTable: FseEncodeTable | null
  ): number {
    const { llCodes, mlCodes, ofCodes } = this;
    const store = this.store;
    const litLenOf = store.litLen;
    const matchLenOf = store.matchLen;
    const offBaseOf = store.offBase;
    let bytePos = startPos;
    let acc = 0;
    let pending = 0;

    let llState = llTable === null ? 0 : fseInitState(llTable, llCodes[n - 1]);
    let ofState = ofTable === null ? 0 : fseInitState(ofTable, ofCodes[n - 1]);
    let mlState = mlTable === null ? 0 : fseInitState(mlTable, mlCodes[n - 1]);
    const llDeltaNb = llTable === null ? null : llTable.deltaNbBits;
    const llDeltaFind = llTable === null ? null : llTable.deltaFindState;
    const llStates = llTable === null ? null : llTable.stateTable;
    const mlDeltaNb = mlTable === null ? null : mlTable.deltaNbBits;
    const mlDeltaFind = mlTable === null ? null : mlTable.deltaFindState;
    const mlStates = mlTable === null ? null : mlTable.stateTable;
    const ofDeltaNb = ofTable === null ? null : ofTable.deltaNbBits;
    const ofDeltaFind = ofTable === null ? null : ofTable.deltaFindState;
    const ofStates = ofTable === null ? null : ofTable.stateTable;

    for (let i = n - 1; i >= 0; i--) {
      // One sequence writes at most 16 + 16 + 32 extra bits and three states of at most 9 bits.
      if (bytePos + SEQUENCE_MAX_BYTES > cap) return -1;
      if (i < n - 1) {
        if (ofDeltaNb !== null && ofDeltaFind !== null && ofStates !== null) {
          const symbol = ofCodes[i];
          const nb = (ofState + ofDeltaNb[symbol]) >> 16;
          acc |= (ofState & ((1 << nb) - 1)) << pending;
          pending += nb;
          ofState = ofStates[(ofState >> nb) + ofDeltaFind[symbol]];
        }
        if (mlDeltaNb !== null && mlDeltaFind !== null && mlStates !== null) {
          const symbol = mlCodes[i];
          const nb = (mlState + mlDeltaNb[symbol]) >> 16;
          acc |= (mlState & ((1 << nb) - 1)) << pending;
          pending += nb;
          mlState = mlStates[(mlState >> nb) + mlDeltaFind[symbol]];
        }
        while (pending >= BITS_PER_BYTE) {
          out[bytePos++] = acc & 0xff;
          acc >>>= BITS_PER_BYTE;
          pending -= BITS_PER_BYTE;
        }
        if (llDeltaNb !== null && llDeltaFind !== null && llStates !== null) {
          const symbol = llCodes[i];
          const nb = (llState + llDeltaNb[symbol]) >> 16;
          acc |= (llState & ((1 << nb) - 1)) << pending;
          pending += nb;
          llState = llStates[(llState >> nb) + llDeltaFind[symbol]];
        }
      }
      // Extra bits of sequence i in reverse of the decoder's read order: literal length, match length, offset.
      const llCode = llCodes[i];
      const llBits = LL_BITS_TABLE[llCode];
      if (llBits > 0) {
        acc |= (litLenOf[i] - LL_BASELINE_TABLE[llCode]) << pending;
        pending += llBits;
      }
      while (pending >= BITS_PER_BYTE) {
        out[bytePos++] = acc & 0xff;
        acc >>>= BITS_PER_BYTE;
        pending -= BITS_PER_BYTE;
      }
      const mlCode = mlCodes[i];
      const mlBits = ML_BITS_TABLE[mlCode];
      if (mlBits > 0) {
        acc |= (matchLenOf[i] - ML_BASELINE_TABLE[mlCode]) << pending;
        pending += mlBits;
      }
      while (pending >= BITS_PER_BYTE) {
        out[bytePos++] = acc & 0xff;
        acc >>>= BITS_PER_BYTE;
        pending -= BITS_PER_BYTE;
      }
      const ofCode = ofCodes[i];
      if (ofCode > 0) {
        if (ofCode <= OFFSET_WINDOW_BITS_MAX) {
          acc |= (offBaseOf[i] - (1 << ofCode)) << pending;
          pending += ofCode;
        } else {
          const extra = offBaseOf[i] - 2 ** ofCode;
          acc |= (extra & OFFSET_LOW_MASK) << pending;
          pending += OFFSET_LOW_BITS;
          while (pending >= BITS_PER_BYTE) {
            out[bytePos++] = acc & 0xff;
            acc >>>= BITS_PER_BYTE;
            pending -= BITS_PER_BYTE;
          }
          acc |= Math.floor(extra / OFFSET_LOW_RADIX) << pending;
          pending += ofCode - OFFSET_LOW_BITS;
        }
      }
      while (pending >= BITS_PER_BYTE) {
        out[bytePos++] = acc & 0xff;
        acc >>>= BITS_PER_BYTE;
        pending -= BITS_PER_BYTE;
      }
    }

    // Final states: match length, offset, literal length, then the stop bit.
    if (bytePos + SEQUENCE_MAX_BYTES > cap) return -1;
    if (mlTable !== null) {
      acc |= (mlState - (1 << mlTable.accuracyLog)) << pending;
      pending += mlTable.accuracyLog;
    }
    if (ofTable !== null) {
      while (pending >= BITS_PER_BYTE) {
        out[bytePos++] = acc & 0xff;
        acc >>>= BITS_PER_BYTE;
        pending -= BITS_PER_BYTE;
      }
      acc |= (ofState - (1 << ofTable.accuracyLog)) << pending;
      pending += ofTable.accuracyLog;
    }
    if (llTable !== null) {
      while (pending >= BITS_PER_BYTE) {
        out[bytePos++] = acc & 0xff;
        acc >>>= BITS_PER_BYTE;
        pending -= BITS_PER_BYTE;
      }
      acc |= (llState - (1 << llTable.accuracyLog)) << pending;
      pending += llTable.accuracyLog;
    }
    while (pending >= BITS_PER_BYTE) {
      out[bytePos++] = acc & 0xff;
      acc >>>= BITS_PER_BYTE;
      pending -= BITS_PER_BYTE;
    }
    acc |= 1 << pending;
    out[bytePos++] = acc & 0xff;
    return bytePos > cap ? -1 : bytePos;
  }
}
