import {
  characterWeightedConfidence,
  confidenceWeightedCharacters,
  type OcrEnginePath,
} from './ocr-calibration';
import { detectColumnGutters, type OcrLineBlock, type OcrResult, type OcrWord } from './ocr-pdf-combiner';

/**
 * Korean-first CPU neural OCR engine support:
 * 1. Unicode Standard Annex #15 / KS X 1001 Hangul Jamo grapheme decomposition, composition, and
 *    sub-character visual-confusion distance in O(1) table lookups (`U+AC00..U+D7A3` = 19 Choseong x
 *    21 Jungseong x 28 Jongseong).
 * 2. Korean layout coherence analysis to detect when automatic multi-column segmentation (`PSM 3`)
 *    splits a single-column Korean paragraph into bogus 1-2 syllable / compatibility-Jamo fragments
 *    on skewed or shaded scans (`ko_a__skew3`, `ko_a__shade`).
 * 3. Candidate arbitration across unbinarized, Sauvola-binarized, and single-block (`PSM 6`) neural
 *    LSTM passes, followed by conservative Hangul Jamo composition and noise-line pruning.
 */

export const HANGUL_SYLLABLE_BASE = 0xac00;
export const HANGUL_SYLLABLE_LAST = 0xd7a3;
export const HANGUL_CHOSEONG_COUNT = 19;
export const HANGUL_JUNGSEONG_COUNT = 21;
export const HANGUL_JONGSEONG_COUNT = 28;
const HANGUL_JUNG_JONG = HANGUL_JUNGSEONG_COUNT * HANGUL_JONGSEONG_COUNT; // 588

const COMPAT_JAMO_FIRST = 0x3131;
const COMPAT_JAMO_LAST = 0x3163;
const CONJOINING_JAMO_FIRST = 0x1100;
const CONJOINING_JAMO_LAST = 0x11ff;
const FROM_CHAR_CODE_CHUNK = 4096;

/**
 * Compatibility Jamo (`U+3131..U+314E`) to Choseong index (`0..18`), or `-1` when not a modern Choseong.
 */
const COMPAT_TO_CHOSEONG = new Int8Array([
  0, 1, -1, 2, -1, -1, 3, 4, 5, -1, -1, -1, -1, -1, -1, -1,
  6, 7, 8, -1, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18,
]);

/**
 * Compatibility Jamo (`U+3131..U+314E`) to Jongseong index (`1..27`), or `-1` when not a modern Jongseong.
 */
const COMPAT_TO_JONGSEONG = new Int8Array([
  1, 2, 3, 4, 5, 6, 7, -1, 8, 9, 10, 11, 12, 13, 14, 15,
  16, 17, -1, 18, 19, 20, 21, 22, -1, 23, 24, 25, 26, 27,
]);

export interface HangulJamoTriple {
  /** Choseong index `0..18`. */
  readonly l: number;
  /** Jungseong index `0..20`. */
  readonly v: number;
  /** Jongseong index `0..27` (`0` = no final consonant). */
  readonly t: number;
}

/** True when `codePoint` is a precomposed modern Hangul syllable (`U+AC00..U+D7A3`). */
export function isHangulSyllableCode(codePoint: number): boolean {
  return codePoint >= HANGUL_SYLLABLE_BASE && codePoint <= HANGUL_SYLLABLE_LAST;
}

/** True when `codePoint` is a compatibility Hangul Jamo (`U+3131..U+318E`) or conjoining Jamo (`U+1100..U+11FF`). */
export function isCompatOrConjoiningJamoCode(codePoint: number): boolean {
  return (
    (codePoint >= 0x3131 && codePoint <= 0x318e) ||
    (codePoint >= CONJOINING_JAMO_FIRST && codePoint <= CONJOINING_JAMO_LAST)
  );
}

/** Decomposes a precomposed Hangul syllable (`U+AC00..U+D7A3`) into `{ l, v, t }` indices in O(1). */
export function decomposeHangulSyllable(codePoint: number): HangulJamoTriple | null {
  if (!isHangulSyllableCode(codePoint)) return null;
  const offset = codePoint - HANGUL_SYLLABLE_BASE;
  const l = (offset / HANGUL_JUNG_JONG) | 0;
  const rem = offset % HANGUL_JUNG_JONG;
  const v = (rem / HANGUL_JONGSEONG_COUNT) | 0;
  const t = rem % HANGUL_JONGSEONG_COUNT;
  return { l, v, t };
}

/** Composes `{ l, v, t }` indices into a precomposed Hangul syllable code point (`U+AC00..U+D7A3`). */
export function composeHangulSyllable(l: number, v: number, t = 0): number {
  if (
    l < 0 ||
    l >= HANGUL_CHOSEONG_COUNT ||
    v < 0 ||
    v >= HANGUL_JUNGSEONG_COUNT ||
    t < 0 ||
    t >= HANGUL_JONGSEONG_COUNT
  ) {
    throw new RangeError(`Invalid Hangul Jamo indices (${l}, ${v}, ${t})`);
  }
  return HANGUL_SYLLABLE_BASE + (l * HANGUL_JUNGSEONG_COUNT + v) * HANGUL_JONGSEONG_COUNT + t;
}

function compatChoseongIndex(code: number): number {
  if (code < COMPAT_JAMO_FIRST || code > 0x314e) return -1;
  return COMPAT_TO_CHOSEONG[code - COMPAT_JAMO_FIRST];
}

function compatJungseongIndex(code: number): number {
  if (code < 0x314f || code > COMPAT_JAMO_LAST) return -1;
  return code - 0x314f;
}

function compatJongseongIndex(code: number): number {
  if (code < COMPAT_JAMO_FIRST || code > 0x314e) return -1;
  return COMPAT_TO_JONGSEONG[code - COMPAT_JAMO_FIRST];
}

function codesToString(codes: readonly number[]): string {
  if (codes.length <= FROM_CHAR_CODE_CHUNK) {
    return String.fromCharCode(...codes);
  }
  const chunks: string[] = [];
  for (let offset = 0; offset < codes.length; offset += FROM_CHAR_CODE_CHUNK) {
    chunks.push(String.fromCharCode(...codes.slice(offset, offset + FROM_CHAR_CODE_CHUNK)));
  }
  return chunks.join('');
}

/**
 * Composes detached compatibility Jamo sequences (`U+3131..U+3163`) and conjoining Jamo (`U+1100..U+11FF`)
 * into canonical NFC Hangul syllables (`U+AC00..U+D7A3`). Also merges a trailing compatibility Jongseong
 * onto a preceding open Hangul syllable (`t === 0`, e.g. `하` + `ㄴ` -> `한`) when not followed by a vowel.
 */
export function composeDetachedHangulJamo(text: string): string {
  if (!text) return text;
  let hasCompat = false;
  let hasConjoining = false;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= COMPAT_JAMO_FIRST && code <= COMPAT_JAMO_LAST) {
      hasCompat = true;
    } else if (code >= CONJOINING_JAMO_FIRST && code <= CONJOINING_JAMO_LAST) {
      hasConjoining = true;
    }
  }
  const source = hasConjoining ? text.normalize('NFC') : text;
  if (!hasCompat) return source;

  const out: number[] = [];
  const len = source.length;
  let i = 0;
  let changed = false;
  while (i < len) {
    const c0 = source.charCodeAt(i);
    const l = compatChoseongIndex(c0);
    if (l >= 0 && i + 1 < len) {
      const v = compatJungseongIndex(source.charCodeAt(i + 1));
      if (v >= 0) {
        let t = 0;
        let advance = 2;
        if (i + 2 < len) {
          const candT = compatJongseongIndex(source.charCodeAt(i + 2));
          const nextV = i + 3 < len ? compatJungseongIndex(source.charCodeAt(i + 3)) : -1;
          if (candT > 0 && nextV < 0) {
            t = candT;
            advance = 3;
          }
        }
        out.push(composeHangulSyllable(l, v, t));
        changed = true;
        i += advance;
        continue;
      }
    }
    if (
      isHangulSyllableCode(c0) &&
      (c0 - HANGUL_SYLLABLE_BASE) % HANGUL_JONGSEONG_COUNT === 0 &&
      i + 1 < len
    ) {
      const candT = compatJongseongIndex(source.charCodeAt(i + 1));
      const nextV = i + 2 < len ? compatJungseongIndex(source.charCodeAt(i + 2)) : -1;
      if (candT > 0 && nextV < 0) {
        out.push(c0 + candT);
        changed = true;
        i += 2;
        continue;
      }
    }
    out.push(c0);
    i++;
  }
  return changed ? codesToString(out) : source;
}

/**
 * Visually confusable Jamo pairs in degraded/low-DPI Korean scans:
 * - Choseong: ㄱ(0)/ㅋ(15)/ㄲ(1), ㄷ(3)/ㅌ(16)/ㄸ(4)/ㄹ(5), ㅂ(7)/ㅍ(17)/ㅃ(8), ㅅ(9)/ㅈ(12)/ㅊ(14)/ㅆ(10), ㅇ(11)/ㅎ(18), ㄴ(2)/ㄹ(5), ㅁ(6)/ㅂ(7)
 * - Jungseong: ㅏ(0)/ㅑ(2)/ㅓ(4)/ㅕ(6), ㅗ(8)/ㅜ(13)/ㅡ(18)/ㅛ(12)/ㅠ(17), ㅐ(1)/ㅔ(5)/ㅒ(3)/ㅖ(7), ㅚ(11)/ㅙ(10)/ㅞ(15)
 * - Jongseong: ㄴ(4)/ㄹ(8)/ㅁ(16)/ㅇ(21), ㄱ(1)/ㅋ(24)/ㄲ(2)/ㅂ(17)/ㅍ(26), ㄷ(7)/ㅅ(19)/ㅆ(20)/ㅈ(22)/ㅊ(23)/ㅌ(25)
 */
const CHOSEONG_CONFUSION_GROUPS: ReadonlyArray<readonly number[]> = [
  [0, 1, 15],
  [2, 3, 4, 5, 16],
  [6, 7, 8, 17],
  [9, 10, 12, 13, 14],
  [11, 18],
];

const JUNGSEONG_CONFUSION_GROUPS: ReadonlyArray<readonly number[]> = [
  [0, 2, 4, 6],
  [1, 3, 5, 7],
  [8, 12, 13, 17, 18],
  [9, 10, 11, 14, 15, 16],
  [18, 19, 20],
];

const JONGSEONG_CONFUSION_GROUPS: ReadonlyArray<readonly number[]> = [
  [4, 8, 16, 21],
  [1, 2, 17, 24, 26],
  [7, 19, 20, 22, 23, 25],
];

function buildConfusionMatrix(size: number, groups: ReadonlyArray<readonly number[]>): Uint8Array {
  const table = new Uint8Array(size * size);
  for (const group of groups) {
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i];
        const b = group[j];
        table[a * size + b] = 1;
        table[b * size + a] = 1;
      }
    }
  }
  return table;
}

const CHOSEONG_CONFUSABLE = buildConfusionMatrix(HANGUL_CHOSEONG_COUNT, CHOSEONG_CONFUSION_GROUPS);
const JUNGSEONG_CONFUSABLE = buildConfusionMatrix(HANGUL_JUNGSEONG_COUNT, JUNGSEONG_CONFUSION_GROUPS);
const JONGSEONG_CONFUSABLE = buildConfusionMatrix(HANGUL_JONGSEONG_COUNT, JONGSEONG_CONFUSION_GROUPS);

const VISUAL_CONFUSION_COST = 0.35;

/**
 * Sub-character Jamo visual distance between two equal-length Hangul strings.
 * Identical Jamo cost 0; visually confusable Jamo cost 0.35; unrelated Jamo cost 1.0.
 */
export function jamoVisualDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length !== b.length) return Math.abs(a.length - b.length) * 3;
  let distance = 0;
  for (let i = 0; i < a.length; i++) {
    const codeA = a.charCodeAt(i);
    const codeB = b.charCodeAt(i);
    if (codeA === codeB) continue;
    if (!isHangulSyllableCode(codeA) || !isHangulSyllableCode(codeB)) {
      distance += 3;
      continue;
    }
    const offsetA = codeA - HANGUL_SYLLABLE_BASE;
    const lA = (offsetA / HANGUL_JUNG_JONG) | 0;
    const remA = offsetA % HANGUL_JUNG_JONG;
    const vA = (remA / HANGUL_JONGSEONG_COUNT) | 0;
    const tA = remA % HANGUL_JONGSEONG_COUNT;

    const offsetB = codeB - HANGUL_SYLLABLE_BASE;
    const lB = (offsetB / HANGUL_JUNG_JONG) | 0;
    const remB = offsetB % HANGUL_JUNG_JONG;
    const vB = (remB / HANGUL_JONGSEONG_COUNT) | 0;
    const tB = remB % HANGUL_JONGSEONG_COUNT;

    if (lA !== lB) {
      distance += CHOSEONG_CONFUSABLE[lA * HANGUL_CHOSEONG_COUNT + lB] ? VISUAL_CONFUSION_COST : 1;
    }
    if (vA !== vB) {
      distance += JUNGSEONG_CONFUSABLE[vA * HANGUL_JUNGSEONG_COUNT + vB] ? VISUAL_CONFUSION_COST : 1;
    }
    if (tA !== tB) {
      distance += JONGSEONG_CONFUSABLE[tA * HANGUL_JONGSEONG_COUNT + tB] ? VISUAL_CONFUSION_COST : 1;
    }
  }
  return distance;
}

interface CompactLineStats {
  readonly nonSpaceLength: number;
  readonly hasCompatJamo: boolean;
  readonly allNoiseJamoOrFiller: boolean;
}

function inspectCompactLine(text: string): CompactLineStats {
  let nonSpaceLength = 0;
  let hasCompatJamo = false;
  let allNoiseJamoOrFiller = true;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code <= 0x20 || code === 0x00a0) continue;
    nonSpaceLength++;
    const isJamo = isCompatOrConjoiningJamoCode(code);
    if (isJamo) hasCompatJamo = true;
    // '으' (0xc73c) and '르' (0xb974) are common single-glyph border/deskew artifacts under PSM 3.
    if (!isJamo && code !== 0xc73c && code !== 0xb974) {
      allNoiseJamoOrFiller = false;
    }
  }
  return { nonSpaceLength, hasCompatJamo, allNoiseJamoOrFiller };
}

export interface KoreanLayoutCoherence {
  /** Share of non-whitespace characters that are valid precomposed Hangul syllables or ASCII digits/letters/punctuation. */
  readonly validCharRatio: number;
  /** Count of standalone compatibility-Jamo characters (`U+3131..U+318E`) in the reading. */
  readonly compatJamoCount: number;
  /** Count of short fragment lines (<= 2 non-space characters) on a multi-line page without column gutters. */
  readonly fragmentLineCount: number;
  /** True when the layout exhibits bogus multi-column fragmentation (`fragmentLineCount > 0` or `compatJamoCount > 0`). */
  readonly fragmented: boolean;
}

/**
 * Evaluates whether a Korean OCR reading has clean paragraph line structure or suffers from
 * `PSM 3` multi-column fragmentation (such as orphan `으` / `르 르` lines on tilted or shaded scans).
 */
export function assessKoreanLayoutCoherence(result: OcrResult, pageWidth = 0): KoreanLayoutCoherence {
  const blocks = result.lineBlocks ?? [];
  let totalChars = 0;
  let validChars = 0;
  let compatJamoCount = 0;

  for (let i = 0; i < result.text.length; i++) {
    const code = result.text.charCodeAt(i);
    if (code <= 0x20 || code === 0x00a0) continue;
    totalChars++;
    if (isCompatOrConjoiningJamoCode(code)) {
      compatJamoCount++;
    } else if (
      isHangulSyllableCode(code) ||
      (code >= 0x21 && code <= 0x7e) ||
      (code >= 0x2000 && code <= 0x206f) ||
      (code >= 0x3000 && code <= 0x303f)
    ) {
      validChars++;
    }
  }

  const effectiveWidth = pageWidth > 0 ? pageWidth : (result.imageWidth ?? 0);
  const minColGap = effectiveWidth > 0 ? Math.max(12, Math.min(36, Math.round(effectiveWidth * 0.025))) : 15;
  const gutters = blocks.length >= 4 ? detectColumnGutters(blocks, minColGap) : [];
  let fragmentLineCount = 0;
  if (blocks.length >= 3 && gutters.length === 0) {
    const widths = blocks.map((b) => b.bbox.width).filter((w) => w > 0).sort((a, b) => a - b);
    const medianWidth = widths.length > 0 ? widths[widths.length >> 1] : 0;
    for (const block of blocks) {
      const stats = inspectCompactLine(block.text);
      if (stats.nonSpaceLength === 0) continue;
      const narrowFragment =
        medianWidth > 0 && block.bbox.width < medianWidth * 0.22 && stats.nonSpaceLength <= 2;
      if (stats.hasCompatJamo || (stats.nonSpaceLength <= 2 && narrowFragment)) {
        fragmentLineCount++;
      }
    }
  }

  const validCharRatio = totalChars > 0 ? validChars / totalChars : 1;
  return {
    validCharRatio,
    compatJamoCount,
    fragmentLineCount,
    fragmented: compatJamoCount > 0 || fragmentLineCount > 0,
  };
}

/**
 * Scores a Korean OCR candidate by combining calibrated character evidence with layout coherence.
 * Penalizes bogus `PSM 3` line fragmentation (`fragmentLineCount`) and uncomposed compatibility Jamo
 * so that a clean single-block or binarized reading wins over a fragmented reading with inflated raw confidence.
 */
export function scoreKoreanNeuralCandidate(
  result: OcrResult,
  _enginePath: OcrEnginePath,
  pageWidth = 0
): number {
  const evidence = confidenceWeightedCharacters(result.lineBlocks ?? []);
  if (evidence <= 0) return 0;
  const coherence = assessKoreanLayoutCoherence(result, pageWidth);
  const penaltyFactor = Math.max(
    0.5,
    coherence.validCharRatio - coherence.fragmentLineCount * 0.08 - coherence.compatJamoCount * 0.05
  );
  return evidence * penaltyFactor;
}

/** True when `language` includes Korean (`kor`). */
export function includesKoreanLanguage(language: string | undefined): boolean {
  if (!language) return false;
  return language
    .split('+')
    .map((part) => part.trim().toLowerCase())
    .includes('kor');
}

/**
 * Conservative Korean post-correction:
 * 1. Composes detached compatibility Jamo sequences (`ㄱ` + `ㅏ` -> `가`, `하` + `ㄴ` -> `한`) inside words and lines first.
 * 2. Prunes standalone 1-2 character compatibility-Jamo / border-artifact noise lines (e.g. `으`, `르 르`, `ㅡ`)
 *    when the page has real multi-word Korean text lines.
 * 3. Preserves the original `OcrResult` (including `\n\n` paragraph breaks) when nothing was pruned or composed,
 *    and recalculates `confidence` from `finalBlocks` when noise lines are pruned.
 */
export function postCorrectKoreanOcrResult(result: OcrResult): OcrResult {
  if (!result.text || !includesKoreanLanguage(result.language)) return result;
  const blocks = result.lineBlocks ?? [];
  if (blocks.length === 0) {
    const composedText = composeDetachedHangulJamo(result.text);
    if (composedText === result.text) return result;
    return {
      ...result,
      text: composedText,
      lines: composedText.split('\n').filter((line) => line.trim().length > 0),
    };
  }

  let realLineCount = 0;
  for (const block of blocks) {
    if (inspectCompactLine(block.text).nonSpaceLength >= 4) {
      realLineCount++;
    }
  }

  const filteredBlocks: OcrLineBlock[] = [];
  let pruned = false;
  let anyBlockChanged = false;

  for (const block of blocks) {
    let anyWordChanged = false;
    const correctedWords: OcrWord[] = block.words.map((word) => {
      const composed = composeDetachedHangulJamo(word.text);
      if (composed !== word.text) anyWordChanged = true;
      return composed === word.text ? word : { ...word, text: composed };
    });
    const lineText = composeDetachedHangulJamo(block.text);
    const stats = inspectCompactLine(lineText);

    if (
      realLineCount >= 2 &&
      stats.nonSpaceLength > 0 &&
      stats.nonSpaceLength <= 2 &&
      stats.allNoiseJamoOrFiller &&
      block.words.every((w) => (w.confidence ?? 0) < 0.78)
    ) {
      pruned = true;
      continue;
    }

    if (anyWordChanged || lineText !== block.text) {
      anyBlockChanged = true;
      filteredBlocks.push({
        ...block,
        text: lineText,
        words: correctedWords,
      });
    } else {
      filteredBlocks.push(block);
    }
  }

  if (!pruned && !anyBlockChanged) {
    return result;
  }

  const finalBlocks = filteredBlocks.length > 0 ? filteredBlocks : blocks;
  const lines = finalBlocks.map((b) => b.text).filter((line) => line.trim().length > 0);
  const text = lines.join('\n');
  const wordCount = finalBlocks.reduce((sum, b) => sum + b.words.length, 0);
  return {
    ...result,
    text,
    confidence: characterWeightedConfidence(finalBlocks),
    lines,
    wordCount,
    lineBlocks: finalBlocks,
  };
}

/**
 * Trigger quality threshold for evaluating a second (binarized/unscaled) pass on Korean (`kor`) pages.
 * Because `mergeWordsWithPageText` assigns each multi-syllable Korean word the minimum confidence of its
 * constituent syllable boxes, a clean 300 DPI Korean page scores ~0.8987 post-merge (vs ~0.9554 pre-merge),
 * whereas degraded scans (`shade`, `noise`, `skew3`) score <= 0.865.
 */
export const KOREAN_ALTERNATIVE_TRIGGER_QUALITY = 0.89;

/**
 * Resolves the effective Tesseract page segmentation mode for Korean (`kor`) pages:
 * switches automatic multi-column `PSM 3` (`'3'`) to single-block `PSM 6` (`'6'`) when
 * deskew or adaptive binarization was applied, while keeping `PSM 3` on unbinarized,
 * un-deskewed pages so multi-column Korean pages preserve their column reading order.
 */
export function resolveKoreanPageSegMode(
  tesseractLang: string,
  basePageSegMode: string,
  enginePath: OcrEnginePath | undefined,
  applied: { deskew: boolean; binarize: boolean }
): string {
  if (
    includesKoreanLanguage(tesseractLang) &&
    basePageSegMode === '3' &&
    (enginePath === 'neural' || enginePath === undefined) &&
    (applied.deskew || applied.binarize)
  ) {
    return '6';
  }
  return basePageSegMode;
}

/** Resolves the reported `OcrEnginePath` (`'neural'` when requested, otherwise `defaultPath`). */
export function resolveOcrEnginePath(
  requestedPath: OcrEnginePath | undefined,
  defaultPath: OcrEnginePath
): OcrEnginePath {
  return requestedPath === 'neural' ? 'neural' : defaultPath;
}

/**
 * Decides whether a Korean (`kor`) first-pass unbinarized `PSM 3` reading should evaluate the
 * binarized / single-block neural candidate even when `readingQuality >= KOREAN_ALTERNATIVE_TRIGGER_QUALITY`.
 */
export function shouldEvaluateKoreanNeuralAlternative(
  result: OcrResult,
  _enginePath: OcrEnginePath,
  pageWidth = 0
): boolean {
  if (!includesKoreanLanguage(result.language)) return false;
  const coherence = assessKoreanLayoutCoherence(result, pageWidth);
  return coherence.fragmented;
}
