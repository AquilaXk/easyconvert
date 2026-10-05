/**
 * RFC 8878 constant tables shared by the Zstandard encoder and decoder.
 *
 * Leaf module: it must not import other zstd modules so that `zstd.ts`,
 * `zstd-dict.ts`, `zstd-fse.ts`, `zstd-huffman.ts`, `zstd-encoder.ts` and
 * `zstd-decoder.ts` can all consume it without import cycles.
 */

/** Block_Maximum_Size: 128 KiB (RFC 8878 section 3.1.1.2.2). */
export const ZSTD_BLOCK_SIZE_MAX = 128 * 1024;

/** Smallest window log a frame may declare (RFC 8878 section 3.1.1.1.2). */
export const ZSTD_WINDOW_LOG_MIN = 10;

/**
 * Decoder window cap (2^27 = 128 MiB), the same ceiling the reference decoder applies by default.
 * A frame that declares a larger window is rejected before any allocation happens.
 */
export const ZSTD_DECODER_WINDOW_SIZE_MAX = 2 ** 27;

export const ZSTD_LEVEL_MIN = 1;
export const ZSTD_LEVEL_MAX = 19;
export const ZSTD_LEVEL_DEFAULT = 3;

/** Highest symbol (code) value per sequence field (RFC 8878 section 3.1.1.3.2.1). */
export const ZSTD_LL_MAX_CODE = 35;
export const ZSTD_ML_MAX_CODE = 52;
export const ZSTD_OF_MAX_CODE = 31;

/** Largest FSE accuracy log per field, and for Huffman weight tables. */
export const ZSTD_LL_MAX_ACCURACY_LOG = 9;
export const ZSTD_ML_MAX_ACCURACY_LOG = 9;
export const ZSTD_OF_MAX_ACCURACY_LOG = 8;
export const ZSTD_WEIGHT_MAX_ACCURACY_LOG = 6;

/** Accuracy logs of the predefined distributions (RFC 8878 section 3.1.1.3.2.2.1). */
export const ZSTD_LL_DEFAULT_ACCURACY_LOG = 6;
export const ZSTD_ML_DEFAULT_ACCURACY_LOG = 6;
export const ZSTD_OF_DEFAULT_ACCURACY_LOG = 5;

/** Smallest FSE accuracy log an encoder table description can declare. */
export const ZSTD_FSE_ACCURACY_LOG_MIN = 5;

/** Longest Huffman code length and highest symbol of the literals alphabet. */
export const ZSTD_HUFFMAN_MAX_BITS = 11;
export const ZSTD_HUFFMAN_MAX_SYMBOL = 255;

/** Initial repeat offsets (RFC 8878 section 3.1.2.5). */
export const ZSTD_REP_OFFSET_INITIAL: readonly [number, number, number] = [1, 4, 8];

/** Predefined normalized distributions; -1 marks a "less than 1" probability. */
export const ZSTD_LL_DEFAULT_DISTRIBUTION: readonly number[] = [
  4, 3, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 1, 1, 1, 2, 2, 2, 2, 2, 2, 2, 2, 2, 3, 2, 1, 1, 1, 1, 1,
  -1, -1, -1, -1,
];
export const ZSTD_ML_DEFAULT_DISTRIBUTION: readonly number[] = [
  1, 4, 3, 2, 2, 2, 2, 2, 2, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1,
  1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, -1, -1, -1, -1, -1, -1, -1,
];
export const ZSTD_OF_DEFAULT_DISTRIBUTION: readonly number[] = [
  1, 1, 1, 1, 1, 1, 2, 2, 2, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, -1, -1, -1, -1, -1,
];

// RFC 8878 section 3.1.1.3.2.1.1: baseline values and extra-bit counts per code.
export const LL_BASELINE: readonly number[] = [
  0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
  16, 18, 20, 22, 24, 28, 32, 40, 48, 64, 128, 256, 512, 1024, 2048, 4096,
  8192, 16384, 32768, 65536,
];
export const LL_BITS: readonly number[] = [
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  1, 1, 1, 1, 2, 2, 3, 3, 4, 6, 7, 8, 9, 10, 11, 12,
  13, 14, 15, 16,
];
export const ML_BASELINE: readonly number[] = [
  3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18,
  19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34,
  35, 37, 39, 41, 43, 47, 51, 59, 67, 83, 99, 131, 259, 515, 1027, 2051,
  4099, 8195, 16387, 32771, 65539,
];
export const ML_BITS: readonly number[] = [
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  1, 1, 1, 1, 2, 2, 3, 3, 4, 4, 5, 7, 8, 9, 10, 11,
  12, 13, 14, 15, 16,
];
