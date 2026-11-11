import { ConversionFailedError, OcrEngineUnavailableError } from '../types';
import { assertEncodedImageWithinLimit, openLimitedSharp, rethrowInputPixelLimit } from './image-input-limits';
import {
  ONNX_DETECTOR_MAX_SIDE,
  ONNX_DETECTOR_MIN_SIDE,
  ONNX_OCR_MODEL_DIR_ENV,
  planDetectorSize,
  recognizeOnnxInput,
  type OnnxOcrOptions,
  type OnnxPageInput,
} from './ocr-onnx';
import type { OcrResult } from './ocr-pdf-combiner';

/** The most pixels of a page that are kept at full resolution; a larger page is reduced first (a text line is cut to 48 pixels anyway). */
export const ONNX_MAX_PAGE_PIXELS = 16_000_000;

export interface OnnxPrepareOptions {
  detectorMinSide?: number;
  detectorMaxSide?: number;
  /** Clockwise turn in degrees given to the page after its EXIF turn. */
  quarterTurn?: 0 | 90 | 180 | 270;
  maxPixels?: number;
}

/**
 * Decodes a page for the recognizer: EXIF turn applied, flattened on white, reduced when it holds more than `maxPixels`, and
 * a copy scaled into the detector's range. This is the part that reads the untrusted file, so the process that runs the
 * models never sees an encoded image.
 */
export async function prepareOnnxInput(imageBuffer: Buffer, options: OnnxPrepareOptions = {}): Promise<OnnxPageInput> {
  try {
    await assertEncodedImageWithinLimit(imageBuffer);
    let pipeline = openLimitedSharp(imageBuffer).autoOrient();
    if (options.quarterTurn) pipeline = pipeline.rotate(options.quarterTurn);
    const { data, info } = await pipeline.flatten({ background: '#ffffff' }).toColourspace('srgb').removeAlpha().raw().toBuffer({ resolveWithObject: true });
    let rgb = new Uint8Array(data.buffer, data.byteOffset, data.length);
    let { width, height } = info;
    const maxPixels = options.maxPixels ?? ONNX_MAX_PAGE_PIXELS;
    if (width * height > maxPixels) {
      const scale = Math.sqrt(maxPixels / (width * height));
      const reduced = await openLimitedSharp(Buffer.from(rgb.buffer, rgb.byteOffset, rgb.length), { raw: { width, height, channels: 3 } })
        .resize(Math.max(1, Math.floor(width * scale)), Math.max(1, Math.floor(height * scale)), { fit: 'fill' })
        .raw()
        .toBuffer({ resolveWithObject: true });
      rgb = new Uint8Array(reduced.data.buffer, reduced.data.byteOffset, reduced.data.length);
      width = reduced.info.width;
      height = reduced.info.height;
    }
    const plan = planDetectorSize(width, height, options.detectorMinSide ?? ONNX_DETECTOR_MIN_SIDE, options.detectorMaxSide ?? ONNX_DETECTOR_MAX_SIDE);
    const resized = await openLimitedSharp(Buffer.from(rgb.buffer, rgb.byteOffset, rgb.length), { raw: { width, height, channels: 3 } })
      .resize(plan.width, plan.height, { fit: 'fill' })
      .raw()
      .toBuffer();
    return { width, height, rgb, detector: { width: plan.width, height: plan.height, rgb: new Uint8Array(resized.buffer, resized.byteOffset, resized.length) } };
  } catch (err) {
    rethrowInputPixelLimit(err);
    if (err instanceof OcrEngineUnavailableError || err instanceof ConversionFailedError) throw err;
    throw new ConversionFailedError('Invalid image: the OCR input could not be decoded.');
  }
}

/**
 * Recognizes one page with the ONNX detector and recognizer. Boxes are in the pixels of the page as displayed (EXIF turn
 * applied); the page is not otherwise prepared (no levelling, no binarization): the models read photographs as they are.
 */
export async function recognizePageOnnx(imageBuffer: Buffer, options: OnnxOcrOptions & OnnxPrepareOptions = {}): Promise<OcrResult> {
  const modelDir = options.modelDir ?? process.env[ONNX_OCR_MODEL_DIR_ENV];
  if (!modelDir) throw new OcrEngineUnavailableError(`The ONNX OCR engine needs a model directory (${ONNX_OCR_MODEL_DIR_ENV}).`);
  const input = await prepareOnnxInput(imageBuffer, options);
  options.signal?.throwIfAborted();
  return recognizeOnnxInput(input, options);
}
