import { highBit32 } from './zstd-fse';
import { LL_BASELINE, LL_BITS, ML_BASELINE, ML_BITS } from './zstd-tables';

/**
 * Sequence symbol codes of RFC 8878 section 3.1.1.3.2: the code of a literal length and of a match length, and the
 * typed tables of their baselines and extra-bit counts. Shared by the block encoder and the optimal parser so that the
 * parser prices exactly the symbols the encoder writes.
 */

/** The shortest match a sequence can carry (the match length baseline of code 0). */
export const ZSTD_MIN_MATCH = 3;
const SMALL_CODE_LOOKUP_SIZE = 64;
const MATCH_CODE_LOOKUP_SIZE = 128;
const LL_LARGE_CODE_BIAS = 19;
const ML_LARGE_CODE_BIAS = 36;

/** Typed copies of the code tables: module-local, so no accessor call per use under CommonJS interop. */
export const LL_BASELINE_TABLE = Uint32Array.from(LL_BASELINE);
export const LL_BITS_TABLE = Uint8Array.from(LL_BITS);
export const ML_BASELINE_TABLE = Uint32Array.from(ML_BASELINE);
export const ML_BITS_TABLE = Uint8Array.from(ML_BITS);

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
const ML_CODE_LOOKUP = buildLookup(ML_BASELINE, MATCH_CODE_LOOKUP_SIZE, ZSTD_MIN_MATCH);

export function llCodeOf(litLen: number): number {
  return litLen < SMALL_CODE_LOOKUP_SIZE ? LL_CODE_LOOKUP[litLen] : highBit32(litLen) + LL_LARGE_CODE_BIAS;
}

export function mlCodeOf(matchLen: number): number {
  const base = matchLen - ZSTD_MIN_MATCH;
  return base < MATCH_CODE_LOOKUP_SIZE ? ML_CODE_LOOKUP[base] : highBit32(base) + ML_LARGE_CODE_BIAS;
}

/** The sequences of a block as three parallel arrays: literal run, match length, and offset value (RFC 8878 3.1.2.5). */
export interface SequenceSink {
  count: number;
  readonly litLen: Uint32Array;
  readonly matchLen: Uint32Array;
  readonly offBase: Uint32Array;
}
