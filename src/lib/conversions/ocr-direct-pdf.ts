import type { Metadata } from 'sharp';
import type { ConversionOptions, ConversionResult } from '../types';
import { parseApng } from './image-apng';
import { assertEncodedImageWithinLimit } from './image-input-limits';
import { DEFAULT_PRINT_DENSITY } from './image-print-density';
import { generateSearchablePdf, recognizePage } from './ocr';
import { calibrateOcrResult } from './ocr-calibration';
import { planJpegPassthrough } from './pdf-jpeg-passthrough';

const MUTATING_IMAGE_OPTIONS: ReadonlyArray<keyof ConversionOptions> = [
  'page',
  'pages',
  'multiPageOutput',
  'width',
  'height',
  'fit',
  'kernel',
  'stripMetadata',
  'background',
  'dpi',
  'rotate',
  'tint',
  'toneMap',
  'targetColorSpace',
];

function hasDirectOcrDisqualifyingOption(options: ConversionOptions): boolean {
  return MUTATING_IMAGE_OPTIONS.some((key) => options[key] !== undefined && options[key] !== false);
}

/** Recognizes `imageBuffer` and embeds its invisible text layer into a lossless searchable PDF. */
export async function renderOcrSearchablePdf(
  imageBuffer: Buffer,
  options: ConversionOptions,
  baseName: string,
  statesDensity: boolean,
  precheckedHeader?: Metadata,
  frameFields: Record<string, unknown> = {}
): Promise<ConversionResult> {
  const recognized = await recognizePage(imageBuffer, options.ocrLanguage, {
    detectOrientation: options.ocrDetectOrientation,
    precheckedHeader,
  });
  const ocrResult = calibrateOcrResult(recognized.result, recognized.enginePath);
  // decodePdfPages emits PNGs at 72 dpi when no print density is declared (or statesDensity is false);
  // keep that page size when passing upright PNG/JPEG directly so geometry matches assemblePicturePdf.
  const pdfOcrResult =
    precheckedHeader !== undefined && (!statesDensity || ocrResult.imageDpi?.assumed)
      ? { ...ocrResult, imageDpi: { dpi: DEFAULT_PRINT_DENSITY.x, assumed: true } }
      : ocrResult;
  const searchablePdf = await generateSearchablePdf(
    imageBuffer,
    pdfOcrResult,
    options,
    baseName,
    precheckedHeader !== undefined
  );
  return {
    buffer: searchablePdf,
    mimeType: 'application/pdf',
    filename: `${baseName}.pdf`,
    size: searchablePdf.length,
    ocrExtractedText: ocrResult.text,
    ocrConfidence: ocrResult.confidence,
    ...frameFields,
  };
}

/**
 * Bypasses `decodePdfPages` PNG decode/zlib-recompress when `ocrEnabled` runs on an upright, single-frame,
 * unmutated PNG or passthrough-eligible baseline JPEG within image limits.
 */
export async function tryDirectOcrSearchablePdf(
  activeBuffer: Buffer,
  options: ConversionOptions,
  baseName: string,
  context: { skipDirect: boolean; statesDensity: boolean; mapFailure: (err: unknown) => unknown }
): Promise<ConversionResult | null> {
  if (!options.ocrEnabled || context.skipDirect || hasDirectOcrDisqualifyingOption(options)) {
    return null;
  }
  let header: Metadata;
  try {
    header = await assertEncodedImageWithinLimit(activeBuffer);
  } catch (err: unknown) {
    throw context.mapFailure(err);
  }
  const singleFrame = (header.pages ?? 1) <= 1;
  const upright = !header.orientation || header.orientation === 1;
  const directFormat =
    (header.format === 'png' && !parseApng(activeBuffer)) ||
    (header.format === 'jpeg' && planJpegPassthrough(activeBuffer) !== null);
  if (!singleFrame || !upright || !directFormat) return null;
  return renderOcrSearchablePdf(activeBuffer, options, baseName, context.statesDensity, header);
}
