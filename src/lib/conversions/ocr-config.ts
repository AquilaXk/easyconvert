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
/** PSM 5: a single uniform block of vertically aligned text, for `_vert` traineddata. */
export const OCR_PSM_VERTICAL_BLOCK = '5';
/** OEM 1: LSTM neural-network engine only. */
export const OCR_OEM_LSTM_ONLY = 1;

const VERTICAL_DATA_SUFFIX = '_vert';
const LANGUAGE_SEPARATOR = '+';

export interface OcrSegmentation {
  pageSegMode: string;
  engineMode: number;
}

/** Picks page segmentation and engine mode for a Tesseract language set such as `eng` or `jpn_vert`. */
export function ocrSegmentationFor(tesseractLang: string): OcrSegmentation {
  const vertical = tesseractLang.split(LANGUAGE_SEPARATOR).some((lang) => lang.endsWith(VERTICAL_DATA_SUFFIX));
  return {
    pageSegMode: vertical ? OCR_PSM_VERTICAL_BLOCK : OCR_PSM_AUTO,
    engineMode: OCR_OEM_LSTM_ONLY,
  };
}
