import type { OcrBaseline, OcrBBox, OcrLayoutGroup, OcrLineBlock, OcrResult, OcrWord } from './ocr-pdf-combiner';

/**
 * Preprocessing can resize and turn the page, so the recognizer reports boxes in the prepared
 * image's pixels. Callers (searchable PDF text layers, HOCR and ALTO export) place them on the
 * original image, so every box is mapped back before a result leaves `performOcr`.
 */

/** How the prepared image was made from the upright source image: resized, then turned. */
export interface OcrGeometry {
  sourceWidth: number;
  sourceHeight: number;
  /** Size after the rescale step, before the turn. */
  scaledWidth: number;
  scaledHeight: number;
  /** Size of the image the recognizer reads (the turned image's bounding box). */
  outputWidth: number;
  outputHeight: number;
  /** Clockwise turn about the image centre applied after scaling; 0 when the page was not turned. */
  rotationDegrees: number;
}

const DEGREES_TO_RADIANS = Math.PI / 180;

export function identityGeometry(width: number, height: number): OcrGeometry {
  return {
    sourceWidth: width,
    sourceHeight: height,
    scaledWidth: width,
    scaledHeight: height,
    outputWidth: width,
    outputHeight: height,
    rotationDegrees: 0,
  };
}

function isIdentity(g: OcrGeometry): boolean {
  return g.rotationDegrees === 0 && g.sourceWidth === g.outputWidth && g.sourceHeight === g.outputHeight;
}

/** Maps a point from prepared-image pixels to source-image pixels (unclamped). */
function mapPointToSource(x: number, y: number, g: OcrGeometry): [number, number] {
  const radians = g.rotationDegrees * DEGREES_TO_RADIANS;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  // Undo the clockwise turn (rows grow downwards) about the centre, then the scale.
  const dx = x - g.outputWidth / 2;
  const dy = y - g.outputHeight / 2;
  const scaledX = dx * cos + dy * sin + g.scaledWidth / 2;
  const scaledY = -dx * sin + dy * cos + g.scaledHeight / 2;
  return [scaledX / (g.scaledWidth / g.sourceWidth), scaledY / (g.scaledHeight / g.sourceHeight)];
}

/**
 * Maps a box from prepared-image pixels to source-image pixels. A turned box is not a box, so the
 * result is the bounding box of its four corners; it stays inside the source and is at least 1 px.
 */
export function mapBoxToSource(box: OcrBBox, g: OcrGeometry): OcrBBox {
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const [cornerX, cornerY] of [
    [box.x, box.y],
    [box.x + box.width, box.y],
    [box.x, box.y + box.height],
    [box.x + box.width, box.y + box.height],
  ]) {
    const [sourceX, sourceY] = mapPointToSource(cornerX, cornerY, g);
    left = Math.min(left, sourceX);
    right = Math.max(right, sourceX);
    top = Math.min(top, sourceY);
    bottom = Math.max(bottom, sourceY);
  }
  const x0 = Math.min(g.sourceWidth - 1, Math.max(0, Math.round(left)));
  const y0 = Math.min(g.sourceHeight - 1, Math.max(0, Math.round(top)));
  const x1 = Math.min(g.sourceWidth, Math.max(x0 + 1, Math.round(right)));
  const y1 = Math.min(g.sourceHeight, Math.max(y0 + 1, Math.round(bottom)));
  return { ...box, x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

function mapWord(word: OcrWord, g: OcrGeometry): OcrWord {
  return { ...word, bbox: mapBoxToSource(word.bbox, g) };
}

/**
 * Lines of one block or paragraph share the same group object, and exporters group lines by that
 * identity, so each group is mapped once and the mapped copy is shared the same way.
 */
type GroupCache = Map<OcrLayoutGroup, OcrLayoutGroup>;

function mapLayoutGroup(group: OcrLayoutGroup | undefined, g: OcrGeometry, cache: GroupCache): OcrLayoutGroup | undefined {
  if (!group) return group;
  let mapped = cache.get(group);
  if (!mapped) {
    mapped = group.bbox ? { ...group, bbox: mapBoxToSource(group.bbox, g) } : { ...group };
    cache.set(group, mapped);
  }
  return mapped;
}

function mapBaseline(baseline: OcrBaseline | undefined, g: OcrGeometry): OcrBaseline | undefined {
  if (!baseline) return baseline;
  const [x0, y0] = mapPointToSource(baseline.x0, baseline.y0, g);
  const [x1, y1] = mapPointToSource(baseline.x1, baseline.y1, g);
  return { x0, y0, x1, y1 };
}

/** A vertical text measure (row height, ascenders, descenders) in source pixels. */
function mapRowMeasure(value: number | undefined, g: OcrGeometry): number | undefined {
  if (value === undefined) return value;
  return value * (g.sourceHeight / g.scaledHeight);
}

function mapLineBlock(block: OcrLineBlock, g: OcrGeometry, cache: GroupCache): OcrLineBlock {
  return {
    ...block,
    bbox: mapBoxToSource(block.bbox, g),
    words: block.words.map((word) => mapWord(word, g)),
    block: mapLayoutGroup(block.block, g, cache),
    paragraph: mapLayoutGroup(block.paragraph, g, cache),
    baseline: mapBaseline(block.baseline, g),
    rowHeight: mapRowMeasure(block.rowHeight, g),
    ascenders: mapRowMeasure(block.ascenders, g),
    descenders: mapRowMeasure(block.descenders, g),
  };
}

/** Returns the result with every box, and the reported page size, in source-image pixels. */
export function mapOcrResultToSource(result: OcrResult, g: OcrGeometry): OcrResult {
  if (isIdentity(g)) {
    return { ...result, imageWidth: g.sourceWidth, imageHeight: g.sourceHeight };
  }
  const groups: GroupCache = new Map();
  return {
    ...result,
    lineBlocks: result.lineBlocks?.map((block) => mapLineBlock(block, g, groups)),
    imageWidth: g.sourceWidth,
    imageHeight: g.sourceHeight,
  };
}

function shiftBoxDown(box: OcrBBox, offsetY: number): OcrBBox {
  return { ...box, y: box.y + offsetY };
}

function shiftLineBlockDown(block: OcrLineBlock, offsetY: number, cache: GroupCache): OcrLineBlock {
  const shiftGroup = (group: OcrLayoutGroup | undefined): OcrLayoutGroup | undefined => {
    if (!group) return group;
    let shifted = cache.get(group);
    if (!shifted) {
      shifted = group.bbox ? { ...group, bbox: shiftBoxDown(group.bbox, offsetY) } : { ...group };
      cache.set(group, shifted);
    }
    return shifted;
  };
  const { baseline } = block;
  return {
    ...block,
    bbox: shiftBoxDown(block.bbox, offsetY),
    words: block.words.map((word) => ({ ...word, bbox: shiftBoxDown(word.bbox, offsetY) })),
    block: shiftGroup(block.block),
    paragraph: shiftGroup(block.paragraph),
    baseline: baseline ? { ...baseline, y0: baseline.y0 + offsetY, y1: baseline.y1 + offsetY } : baseline,
  };
}

/**
 * Appends the recognition of another raster image of the same page below the ones already merged.
 * Every image is recognised in its own pixels, so its boxes start at 0; they are moved down by the
 * height merged so far, which keeps the merged boxes in one coordinate space (the stack of images,
 * `imageHeight` tall) and keeps layout analysis and exporters from interleaving the images' lines.
 */
export function appendOcrResultBelow(existing: OcrResult, next: OcrResult, nextWidth: number, nextHeight: number): OcrResult {
  const offsetY = existing.imageHeight || 0;
  const groups: GroupCache = new Map();
  const confidence =
    existing.confidence !== null && next.confidence !== null
      ? (existing.confidence + next.confidence) / 2
      : (existing.confidence ?? next.confidence);
  return {
    text: `${existing.text}\n\n${next.text}`.trim(),
    confidence,
    wordCount: existing.wordCount + next.wordCount,
    lines: [...existing.lines, ...next.lines],
    lineBlocks: [...(existing.lineBlocks || []), ...(next.lineBlocks || []).map((block) => shiftLineBlockDown(block, offsetY, groups))],
    imageWidth: Math.max(existing.imageWidth || 0, nextWidth),
    imageHeight: offsetY + nextHeight,
  };
}
