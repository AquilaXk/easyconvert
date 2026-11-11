import type { OnnxOcrFailedError, OnnxOcrUnavailableError } from './ocr-onnx-helper';

/**
 * Which pages the ONNX engine reads by default, and how a page it did not read is reported. The recognizer is the Korean
 * PP-OCRv5 model, whose character set is Hangul, Latin letters, digits and punctuation, so it takes a request that names Korean and
 * at most English beside it. A request that names another language (`kor+jpn`, `kor+deu`) needs that language's own data and stays
 * with Tesseract, as every page of a language without Korean does.
 */

const ONNX_LANGUAGES: ReadonlySet<string> = new Set(['kor', 'eng']);

/** Whether a request's traineddata names (`kor`, `kor+eng`, `eng+kor`) are all ones the ONNX recognizer reads, with Korean among them. */
export function koreanOnnxLanguages(traineddata: readonly string[]): boolean {
  return traineddata.includes('kor') && traineddata.every((name) => ONNX_LANGUAGES.has(name));
}

/**
 * Longest side of the detector input. 2000 pixels read the measurement set at 0.33% character error against 0.41% at 1280, and
 * took 906 MB against 660 MB at the peak (policy decision 230); the product takes the smaller memory.
 */
export const ONNX_PRODUCT_DETECTOR_MAX_SIDE = 1280;

const said = new Set<string>();

/** One line in the server log per reason, the first time a Korean page is read by Tesseract because the ONNX engine could not be used. */
export function sayOnnxFallbackOnce(error: OnnxOcrUnavailableError | OnnxOcrFailedError): void {
  if (said.has(error.reason)) return;
  said.add(error.reason);
  console.warn(`[ocr] Korean pages are read by Tesseract because the ONNX engine is not usable (${error.reason}): ${error.message}`);
}
