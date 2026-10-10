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

/** Length of the probe that finds the direction text runs in after mapping, in prepared-image pixels. */
const DIRECTION_PROBE_PX = 100;
const ANGLE_DECIMALS = 2;

/**
 * The direction the text of a line runs in on the source page, in degrees clockwise from the x
 * axis (y down), or undefined when it is horizontal. The recognizer reads its lines left to right
 * in the prepared image, so the direction is where a step to the right there lands on the source.
 */
function mapLineAngle(block: OcrLineBlock, g: OcrGeometry): number | undefined {
  const centerX = block.bbox.x + block.bbox.width / 2;
  const centerY = block.bbox.y + block.bbox.height / 2;
  const [x0, y0] = mapPointToSource(centerX, centerY, g);
  const [x1, y1] = mapPointToSource(centerX + DIRECTION_PROBE_PX, centerY, g);
  const degrees = Number(((Math.atan2(y1 - y0, x1 - x0) / DEGREES_TO_RADIANS)).toFixed(ANGLE_DECIMALS));
  return degrees === 0 ? undefined : degrees;
}

function mapLineBlock(block: OcrLineBlock, g: OcrGeometry, cache: GroupCache): OcrLineBlock {
  return {
    ...block,
    angleDegrees: mapLineAngle(block, g),
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

/** Space left between a trimmed word box and the word it was cut back to: this share of the line's word height. */
const TRIMMED_WORD_GAP_HEIGHT_SHARE = 0.1;
/** The gap is at least this many pixels; boxes are whole pixels, so less would leave the boxes touching. */
const MIN_TRIMMED_WORD_GAP_PX = 1;

interface Interval {
  start: number;
  end: number;
}

interface LineAxis {
  vertical: boolean;
  interval: (word: OcrWord) => Interval;
}

/** The axis a line runs along: x for a horizontal line, y when the words' centres spread further in y (as in `_vert` data). */
function lineAxis(words: readonly OcrWord[]): LineAxis {
  const spread = (centre: (word: OcrWord) => number): number => {
    const values = words.map(centre);
    return Math.max(...values) - Math.min(...values);
  };
  const vertical = spread((word) => word.bbox.y + word.bbox.height / 2) > spread((word) => word.bbox.x + word.bbox.width / 2);
  return {
    vertical,
    interval: vertical
      ? (word) => ({ start: word.bbox.y, end: word.bbox.y + word.bbox.height })
      : (word) => ({ start: word.bbox.x, end: word.bbox.x + word.bbox.width }),
  };
}

/** The word with its extent along the line set to [start, end). */
function withInterval(word: OcrWord, axis: LineAxis, start: number, end: number): OcrWord {
  const bbox = axis.vertical
    ? { ...word.bbox, y: start, height: end - start }
    : { ...word.bbox, x: start, width: end - start };
  return { ...word, bbox };
}

/**
 * The engine sometimes reports a word box that runs on over the words after it (a word read near the end of
 * a line whose box takes in the rest of the line, or one that reaches into the next word). The words of a line
 * do not overlap, so a box that reaches into a word listed after it is cut back to where that word starts, in the
 * direction the line reads in. Text is never touched, only the extent of a box; a line whose boxes are
 * consistent is returned as it is.
 */
function trimLine(words: OcrWord[]): OcrWord[] {
  if (words.length < 2) return words;
  const axis = lineAxis(words);
  let direction = 0;
  for (let i = 1; i < words.length; i++) {
    const before = axis.interval(words[i - 1]);
    const after = axis.interval(words[i]);
    direction += Math.sign(after.start + after.end - before.start - before.end);
  }
  const forwards = direction >= 0;
  const heights = words.map((word) => (axis.vertical ? word.bbox.width : word.bbox.height)).sort((a, b) => a - b);
  const gap = Math.max(MIN_TRIMMED_WORD_GAP_PX, Math.round(heights[Math.floor(heights.length / 2)] * TRIMMED_WORD_GAP_HEIGHT_SHARE));
  let changed = false;
  const trimmed = words.map((word, index) => {
    const own = axis.interval(word);
    let cut: number | null = null;
    for (const later of words.slice(index + 1)) {
      const inside = axis.interval(later);
      if (inside.end <= inside.start) continue;
      // Cut back to the first word reached: its near edge in reading direction.
      if (forwards && inside.start > own.start && inside.start < own.end) {
        cut = cut === null ? inside.start : Math.min(cut, inside.start);
      }
      if (!forwards && inside.end < own.end && inside.end > own.start) {
        cut = cut === null ? inside.end : Math.max(cut, inside.end);
      }
    }
    if (cut === null) return word;
    const start = forwards ? own.start : cut + gap;
    const end = forwards ? cut - gap : own.end;
    if (end - start < 1) return word;
    changed = true;
    return withInterval(word, axis, start, end);
  });
  return changed ? trimmed : words;
}

/** Returns the result with every word box that overruns the words after it cut back (see trimLine). */
export function trimOverreachingWords(result: OcrResult): OcrResult {
  if (!result.lineBlocks) return result;
  let changed = false;
  const lineBlocks = result.lineBlocks.map((block) => {
    const words = trimLine(block.words);
    if (words === block.words) return block;
    changed = true;
    return { ...block, words };
  });
  return changed ? { ...result, lineBlocks } : result;
}
