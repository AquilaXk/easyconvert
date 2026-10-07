import type { OcrBaseline, OcrBBox, OcrLayoutGroup, OcrLineBlock, OcrResult, OcrWord } from './ocr-pdf-combiner';

/**
 * Preprocessing can resize and turn the page, so the recognizer reports boxes in the prepared
 * image's pixels. Callers (searchable PDF text layers, HOCR and ALTO export) place them on the
 * original image, so every box is mapped back before a result leaves `performOcr`.
 */

/** Quarter turns the page can be given before recognition, in degrees clockwise. */
export type OcrQuarterTurn = 0 | 90 | 180 | 270;

/**
 * How the prepared image was made from the upright source image: turned by a multiple of 90
 * degrees when the page was scanned sideways or upside down, resized, then levelled by a small turn.
 */
export interface OcrGeometry {
  sourceWidth: number;
  sourceHeight: number;
  /**
   * Clockwise turn of 0, 90, 180 or 270 degrees applied to the source before everything else;
   * absent when the page was not turned. After a 90 or 270 degree turn the page is `sourceHeight`
   * wide and `sourceWidth` tall.
   */
  quarterTurnDegrees?: OcrQuarterTurn;
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

function quarterTurnOf(g: OcrGeometry): OcrQuarterTurn {
  return g.quarterTurnDegrees ?? 0;
}

function isIdentity(g: OcrGeometry): boolean {
  return (
    g.rotationDegrees === 0 &&
    quarterTurnOf(g) === 0 &&
    g.sourceWidth === g.outputWidth &&
    g.sourceHeight === g.outputHeight
  );
}

/** Size of the source after its quarter turn, before rescaling. */
export function orientedSize(g: OcrGeometry): [number, number] {
  const sideways = quarterTurnOf(g) === 90 || quarterTurnOf(g) === 270;
  return sideways ? [g.sourceHeight, g.sourceWidth] : [g.sourceWidth, g.sourceHeight];
}

/** Maps a point of the quarter-turned page back to the page as it was scanned (continuous coordinates). */
function undoQuarterTurn(x: number, y: number, g: OcrGeometry): [number, number] {
  switch (quarterTurnOf(g)) {
    case 90:
      return [y, g.sourceHeight - x];
    case 180:
      return [g.sourceWidth - x, g.sourceHeight - y];
    case 270:
      return [g.sourceWidth - y, x];
    default:
      return [x, y];
  }
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
  const [orientedWidth, orientedHeight] = orientedSize(g);
  return undoQuarterTurn(
    scaledX / (g.scaledWidth / orientedWidth),
    scaledY / (g.scaledHeight / orientedHeight),
    g
  );
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

/** A text measure across the rows (row height, ascenders, descenders) in source pixels; the rescale is uniform. */
function mapRowMeasure(value: number | undefined, g: OcrGeometry): number | undefined {
  if (value === undefined) return value;
  const [, orientedHeight] = orientedSize(g);
  return value * (orientedHeight / g.scaledHeight);
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
