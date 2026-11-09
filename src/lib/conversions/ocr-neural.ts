import {
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
  return (codePoint >= 0x3131 && codePoint <= 0x318e) || (codePoint >= 0x1100 && codePoint <= 0x11ff);
}

/** Decomposes a precomposed Hangul syllable (`U+AC00..U+D7A3`) into `{ l, v, t }` indices in O(1). */
export function decomposeHangulSyllable(codePoint: number): HangulJamoTriple | null {
  if (!isHangulSyllableCode(codePoint)) return null;
  const offset = codePoint - HANGUL_SYLLABLE_BASE;
  const l = Math.floor(offset / HANGUL_JUNG_JONG);
  const rem = offset % HANGUL_JUNG_JONG;
  const v = Math.floor(rem / HANGUL_JONGSEONG_COUNT);
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

/**
 * Composes detached compatibility Jamo sequences (`U+3131..U+3163`) into canonical NFC Hangul
 * syllables (`U+AC00..U+D7A3`). For example, `ㄱ` + `ㅏ` -> `가`, `ㄱ` + `ㅏ` + `ㅇ` -> `강`,
 * while leaving `ㄱ` + `ㅏ` + `나다` as `가나다` (when the consonant after a vowel is followed by
 * another vowel, it starts the next syllable rather than acting as Jongseong).
 */
export function composeDetachedHangulJamo(text: string): string {
  if (!text) return text;
  let hasCompat = false;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= COMPAT_JAMO_FIRST && code <= COMPAT_JAMO_LAST) {
      hasCompat = true;
      break;
    }
  }
  if (!hasCompat) return text;

  const out: number[] = [];
  const len = text.length;
  let i = 0;
  while (i < len) {
    const c0 = text.charCodeAt(i);
    const l = compatChoseongIndex(c0);
    if (l >= 0 && i + 1 < len) {
      const v = compatJungseongIndex(text.charCodeAt(i + 1));
      if (v >= 0) {
        let t = 0;
        let advance = 2;
        if (i + 2 < len) {
          const candT = compatJongseongIndex(text.charCodeAt(i + 2));
          const nextV = i + 3 < len ? compatJungseongIndex(text.charCodeAt(i + 3)) : -1;
          if (candT > 0 && nextV < 0) {
            t = candT;
            advance = 3;
          }
        }
        out.push(composeHangulSyllable(l, v, t));
        i += advance;
        continue;
      }
    }
    out.push(c0);
    i++;
  }
  return String.fromCharCode(...out);
}

/**
 * Visually confusable Jamo pairs in degraded/low-DPI Korean scans:
 * - Choseong: ㄱ(0)/ㅋ(15)/ㄲ(1), ㄷ(3)/ㅌ(16)/ㄸ(4)/ㄹ(5), ㅂ(7)/ㅍ(17)/ㅃ(8), ㅅ(9)/ㅈ(12)/ㅊ(14)/ㅆ(10), ㅇ(11)/ㅎ(18), ㄴ(2)/ㄹ(5), ㅁ(6)/ㅂ(7)
 * - Jungseong: ㅏ(0)/ㅑ(2)/ㅓ(4)/ㅕ(6), ㅗ(8)/ㅜ(13)/ㅡ(18)/ㅛ(12)/ㅠ(17), ㅐ(1)/ㅔ(5)/ㅒ(3)/ㅖ(7), ㅚ(11)/ㅙ(10)/ㅞ(15)
 * - Jongseong: ㄱ(1)/ㅋ(24)/ㄲ(2), ㄴ(4)/ㄹ(8)/ㅁ(16)/ㅇ(21), ㄷ(7)/ㅅ(19)/ㅈ(22)/ㅊ(23)/ㅌ(25), ㅂ(17)/ㅍ(26)
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
  [0, 4, 8, 16, 21],
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
    const decA = decomposeHangulSyllable(codeA);
    const decB = decomposeHangulSyllable(codeB);
    if (!decA || !decB) {
      distance += 3;
      continue;
    }
    if (decA.l !== decB.l) {
      distance += CHOSEONG_CONFUSABLE[decA.l * HANGUL_CHOSEONG_COUNT + decB.l] ? VISUAL_CONFUSION_COST : 1;
    }
    if (decA.v !== decB.v) {
      distance += JUNGSEONG_CONFUSABLE[decA.v * HANGUL_JUNGSEONG_COUNT + decB.v] ? VISUAL_CONFUSION_COST : 1;
    }
    if (decA.t !== decB.t) {
      distance += JONGSEONG_CONFUSABLE[decA.t * HANGUL_JONGSEONG_COUNT + decB.t] ? VISUAL_CONFUSION_COST : 1;
    }
  }
  return distance;
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

  for (const ch of result.text) {
    const code = ch.codePointAt(0) ?? 0;
    if (code <= 0x20) continue;
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

  const gutters = blocks.length >= 4 && pageWidth > 0 ? detectColumnGutters(blocks, pageWidth) : [];
  let fragmentLineCount = 0;
  if (blocks.length >= 3 && gutters.length === 0) {
    const widths = blocks.map((b) => b.bbox.width).filter((w) => w > 0).sort((a, b) => a - b);
    const medianWidth = widths.length > 0 ? widths[Math.floor(widths.length / 2)] : 0;
    for (const block of blocks) {
      const compact = block.text.replace(/\s+/g, '');
      if (compact.length === 0) continue;
      const hasCompat = Array.from(compact).some((c) => isCompatOrConjoiningJamoCode(c.codePointAt(0) ?? 0));
      const narrowFragment = medianWidth > 0 && block.bbox.width < medianWidth * 0.22 && compact.length <= 2;
      if (hasCompat || (compact.length <= 2 && narrowFragment)) {
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
 * 1. Prunes standalone 1-character compatibility-Jamo noise lines (e.g. `으`, `ㅡ`, `ㅣ` from deskew/border artifacts)
 *    when the page has real multi-word Korean text lines.
 * 2. Composes detached compatibility Jamo sequences (`ㄱ` + `ㅏ` -> `가`) inside words and lines.
 * 3. Never invents text on blank inputs and preserves all word/line bounding boxes.
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

  const realLines = blocks.filter((b) => b.text.replace(/\s+/g, '').length >= 4);
  const filteredBlocks: OcrLineBlock[] = [];
  for (const block of blocks) {
    const compact = block.text.replace(/\s+/g, '');
    if (
      realLines.length >= 2 &&
      compact.length > 0 &&
      compact.length <= 2 &&
      Array.from(compact).every((ch) => {
        const code = ch.codePointAt(0) ?? 0;
        return isCompatOrConjoiningJamoCode(code) || ch === '으' || ch === '르';
      }) &&
      block.words.every((w) => (w.confidence ?? 0) < 0.78)
    ) {
      continue;
    }

    let anyWordChanged = false;
    const correctedWords: OcrWord[] = block.words.map((word) => {
      const composed = composeDetachedHangulJamo(word.text);
      if (composed !== word.text) anyWordChanged = true;
      return composed === word.text ? word : { ...word, text: composed };
    });
    const lineText = composeDetachedHangulJamo(block.text);
    filteredBlocks.push(
      !anyWordChanged && lineText === block.text
        ? block
        : {
            ...block,
            text: lineText,
            words: correctedWords,
          }
    );
  }

  const finalBlocks = filteredBlocks.length > 0 ? filteredBlocks : blocks;
  const lines = finalBlocks.map((b) => b.text).filter((line) => line.trim().length > 0);
  const text = lines.join('\n');
  const wordCount = finalBlocks.reduce((sum, b) => sum + b.words.length, 0);
  return {
    ...result,
    text,
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
 * running on the neural path or when deskew / adaptive binarization was applied.
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
    (enginePath === 'neural' || (enginePath === undefined && (applied.deskew || applied.binarize)))
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
