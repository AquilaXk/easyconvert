import type { OcrBBox, OcrLineBlock, OcrResult, OcrWord } from './ocr-pdf-combiner';

/**
 * Preprocessing can resize the page, so the recognizer reports boxes in the prepared image's
 * pixels. Callers (searchable PDF text layers, HOCR and ALTO export) place them on the original
 * image, so every box is mapped back before a result leaves `performOcr`.
 */

/** Where the prepared image sits relative to the upright source image. */
export interface OcrGeometry {
  sourceWidth: number;
  sourceHeight: number;
  /** Size of the image the recognizer reads. */
  outputWidth: number;
  outputHeight: number;
}

export function identityGeometry(width: number, height: number): OcrGeometry {
  return { sourceWidth: width, sourceHeight: height, outputWidth: width, outputHeight: height };
}

function isIdentity(g: OcrGeometry): boolean {
  return g.sourceWidth === g.outputWidth && g.sourceHeight === g.outputHeight;
}

/** Maps a box from prepared-image pixels to source-image pixels; it stays inside the source and is at least 1 px. */
export function mapBoxToSource(box: OcrBBox, g: OcrGeometry): OcrBBox {
  const scaleX = g.outputWidth / g.sourceWidth;
  const scaleY = g.outputHeight / g.sourceHeight;
  const x0 = Math.min(g.sourceWidth - 1, Math.max(0, Math.round(box.x / scaleX)));
  const y0 = Math.min(g.sourceHeight - 1, Math.max(0, Math.round(box.y / scaleY)));
  const x1 = Math.min(g.sourceWidth, Math.max(x0 + 1, Math.round((box.x + box.width) / scaleX)));
  const y1 = Math.min(g.sourceHeight, Math.max(y0 + 1, Math.round((box.y + box.height) / scaleY)));
  return { ...box, x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

function mapWord(word: OcrWord, g: OcrGeometry): OcrWord {
  return { ...word, bbox: mapBoxToSource(word.bbox, g) };
}

function mapLineBlock(block: OcrLineBlock, g: OcrGeometry): OcrLineBlock {
  return { ...block, bbox: mapBoxToSource(block.bbox, g), words: block.words.map((word) => mapWord(word, g)) };
}

/** Returns the result with every box, and the reported page size, in source-image pixels. */
export function mapOcrResultToSource(result: OcrResult, g: OcrGeometry): OcrResult {
  if (isIdentity(g)) {
    return { ...result, imageWidth: g.sourceWidth, imageHeight: g.sourceHeight };
  }
  return {
    ...result,
    lineBlocks: result.lineBlocks?.map((block) => mapLineBlock(block, g)),
    imageWidth: g.sourceWidth,
    imageHeight: g.sourceHeight,
  };
}
