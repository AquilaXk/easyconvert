/**
 * Tesseract recognition parameters shared by the WebAssembly worker and the native CLI.
 * Values are the numeric constants from the Tesseract API (PageSegMode / OcrEngineMode).
 */

/**
 * PSM 3: fully automatic page segmentation, finds columns and blocks.
 *
 * Trade-off: this is chosen for prose and multi-column pages (on the two-column golden pages the
 * character error rate falls from about 73% under single-block PSM 6 to under 1%). A table drawn without ruling
 * lines is read column by column instead of row by row, so row order is lost and a few cells can
 * be dropped (about 70% character error rate against row-wise reading, word recall 0.9 on the
 * golden fixture). Tables with ruling lines read correctly. A layout-aware recognizer, not a
 * different PSM, is the fix for borderless tables.
 */
export const OCR_PSM_AUTO = '3';
/** PSM 6: one uniform block of text; reads small crops and single lines that PSM 3 finds nothing in. */
export const OCR_PSM_SINGLE_BLOCK = '6';
/**
 * Images up to this height hold one or two text lines (a UI label, a cropped word or line) and no
 * page layout. Page layout analysis on them can return stray glyphs instead of the text (a 120x40
 * Korean label read as "00 [기" under PSM 3 on one engine build), so they are read as one block.
 */
export const OCR_SMALL_CROP_MAX_HEIGHT_PX = 100;
/**
 * PSM 7: a single text line. A one-row crop read as a block (PSM 6) can gain a ghost line, for
 * example "한글" read as "한글\n글" from a bitmap font, which line mode does not produce.
 */
export const OCR_PSM_SINGLE_LINE = '7';
/** Gray levels below this count as ink when counting text rows. */
const TEXT_ROW_INK_THRESHOLD = 128;
/** Ink bands thinner than this many rows are specks, not text rows. */
const TEXT_ROW_MIN_HEIGHT_PX = 2;
/** The single-block retry replaces an empty automatic reading when it recognizes at least this many more words. */
export const OCR_FALLBACK_MIN_WORD_GAIN = 1;
/** PSM 5: a single uniform block of vertically aligned text, for `_vert` traineddata. */
export const OCR_PSM_VERTICAL_BLOCK = '5';
/** OEM 0: the legacy engine, which orientation and script detection needs. */
export const OCR_OEM_LEGACY_ONLY = 0;
/** OEM 1: LSTM neural-network engine only. */
export const OCR_OEM_LSTM_ONLY = 1;

const VERTICAL_DATA_SUFFIX = '_vert';
const LANGUAGE_SEPARATOR = '+';

export interface OcrSegmentation {
  pageSegMode: string;
  engineMode: number;
}

function isVerticalData(tesseractLang: string): boolean {
  return tesseractLang.split(LANGUAGE_SEPARATOR).some((lang) => lang.endsWith(VERTICAL_DATA_SUFFIX));
}

/**
 * Picks page segmentation and engine mode for a Tesseract language set such as `eng` or `jpn_vert`,
 * and for the image height in pixels when it is known.
 */
export function ocrSegmentationFor(tesseractLang: string, imageHeight?: number, textRows?: number): OcrSegmentation {
  let pageSegMode = OCR_PSM_AUTO;
  if (isVerticalData(tesseractLang)) {
    pageSegMode = OCR_PSM_VERTICAL_BLOCK;
  } else if (imageHeight !== undefined && imageHeight <= OCR_SMALL_CROP_MAX_HEIGHT_PX) {
    pageSegMode = textRows === 1 ? OCR_PSM_SINGLE_LINE : OCR_PSM_SINGLE_BLOCK;
  }
  return { pageSegMode, engineMode: OCR_OEM_LSTM_ONLY };
}

/**
 * Counts horizontal ink bands in an 8-bit gray image (one byte per pixel): runs of rows holding
 * at least one dark pixel, separated by blank rows. Bands thinner than TEXT_ROW_MIN_HEIGHT_PX are
 * ignored as specks.
 */
export function countTextRows(gray: Uint8Array, width: number, height: number): number {
  let rows = 0;
  let run = 0;
  for (let y = 0; y <= height; y++) {
    let ink = false;
    if (y < height) {
      const start = y * width;
      for (let x = 0; x < width && !ink; x++) ink = gray[start + x] < TEXT_ROW_INK_THRESHOLD;
    }
    if (ink) {
      run++;
      continue;
    }
    if (run >= TEXT_ROW_MIN_HEIGHT_PX) rows++;
    run = 0;
  }
  return rows;
}

/**
 * Segmentation for a second attempt when automatic segmentation recognized no words, or null when
 * there is none. Vertical data is already single-block, and PSM 6 would read it sideways.
 */
export function ocrFallbackPageSegMode(tesseractLang: string): string | null {
  return isVerticalData(tesseractLang) ? null : OCR_PSM_SINGLE_BLOCK;
}

/** Whether a retry found enough more words than the first reading to replace it. */
export function fallbackReadsMore(firstWordCount: number, retryWordCount: number): boolean {
  return retryWordCount - firstWordCount >= OCR_FALLBACK_MIN_WORD_GAIN;
}
