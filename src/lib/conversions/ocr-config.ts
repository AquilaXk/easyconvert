/**
 * Tesseract recognition parameters shared by the WebAssembly worker and the native CLI.
 * Values are the numeric constants from the Tesseract API (PageSegMode / OcrEngineMode).
 */

/** PSM 3: fully automatic page segmentation, finds columns and blocks. */
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
