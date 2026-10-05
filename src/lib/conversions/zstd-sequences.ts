import { highBit32 } from './zstd-fse';
import { LL_BASELINE, ML_BASELINE } from './zstd-tables';

/**
 * Sequence storage and code lookup shared by the Zstandard block encoder and its match finders
 * (hash-chain lazy parser and binary-tree optimal parser).
 */

const MIN_MATCH_CODE_LENGTH = 3;
const SMALL_CODE_LOOKUP_SIZE = 64;
const MATCH_CODE_LOOKUP_SIZE = 128;
const LL_LARGE_CODE_BIAS = 19;
const ML_LARGE_CODE_BIAS = 36;

/** Parsed sequences of one block: literal run, match length and offset value (RFC 8878 section 3.1.1.4). */
export class SequenceStore {
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

export function llCodeOf(litLen: number): number {
  return litLen < SMALL_CODE_LOOKUP_SIZE ? LL_CODE_LOOKUP[litLen] : highBit32(litLen) + LL_LARGE_CODE_BIAS;
}

export function mlCodeOf(matchLen: number): number {
  const base = matchLen - MIN_MATCH_CODE_LENGTH;
  return base < MATCH_CODE_LOOKUP_SIZE ? ML_CODE_LOOKUP[base] : highBit32(base) + ML_LARGE_CODE_BIAS;
}
