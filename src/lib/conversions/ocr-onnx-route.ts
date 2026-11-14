import type { OnnxRecognizer } from './ocr-onnx';
import type { OnnxOcrFailedError, OnnxOcrUnavailableError } from './ocr-onnx-helper';
import type { OcrEngineFallback } from './ocr-pdf-combiner';

/**
 * Which pages the ONNX engine reads, and how a page it did not read is reported. By default it reads a request that names Korean and
 * at most English beside it with the Korean PP-OCRv5 recognizer (Hangul, Latin letters, digits and punctuation); a request that names
 * another language (`kor+jpn`, `kor+deu`) needs that language's own data and stays with Tesseract, as every page of a language without
 * Korean does. English alone is read by Tesseract first and gets the English recognizer only as the second reading of a page that
 * Tesseract read poorly (policy decision 299).
 */

const ONNX_LANGUAGES: ReadonlySet<string> = new Set(['kor', 'eng']);

/** Whether a request's traineddata names (`kor`, `kor+eng`, `eng+kor`) are all ones the ONNX recognizer reads, with Korean among them. */
export function koreanOnnxLanguages(traineddata: readonly string[]): boolean {
  return traineddata.includes('kor') && traineddata.every((name) => ONNX_LANGUAGES.has(name));
}

/** The recognizer that gives the second reading of a page Tesseract read poorly, or null when the request has none (every language but English alone). */
export function onnxSecondReadingRecognizer(traineddata: readonly string[]): OnnxRecognizer | null {
  return traineddata.length === 1 && traineddata[0] === 'eng' ? 'eng' : null;
}

/**
 * Longest side of the detector input. 2000 pixels read the measurement set at 0.33% character error against 0.41% at 1280, and
 * took 906 MB against 660 MB at the peak (policy decision 230); the product takes the smaller memory.
 */
export const ONNX_PRODUCT_DETECTOR_MAX_SIDE = 1280;

const said = new Set<string>();

/** One line in the server log per reason, the first time a page is read by Tesseract because the ONNX engine could not be used. */
export function sayOnnxFallbackOnce(error: OnnxOcrUnavailableError | OnnxOcrFailedError): void {
  if (said.has(error.reason)) return;
  said.add(error.reason);
  console.warn(`[ocr] Pages are read by Tesseract because the ONNX engine is not usable (${error.reason}): ${error.message}`);
}

/**
 * The fallback a result reports when the ONNX engine did not read the page (`onnx`) and the Tesseract reading itself fell back from the
 * WebAssembly engine to the native tool (`tesseract`): the later one, with the earlier one under `previous`, so that neither is lost.
 */
export function chainEngineFallbacks(onnx: OcrEngineFallback | undefined, tesseract: OcrEngineFallback | undefined): OcrEngineFallback | undefined {
  if (onnx && tesseract) return { ...tesseract, previous: onnx };
  return tesseract ?? onnx;
}
