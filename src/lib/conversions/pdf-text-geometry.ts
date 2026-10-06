import { ConversionFailedError } from '../types';
import type { OcrBaseline, OcrLayoutGroup, OcrLineBlock, OcrResult, OcrWord } from './ocr-pdf-combiner';

/**
 * Word, line, paragraph and block geometry for PDF pages whose text comes from the PDF's own text
 * layer, so hOCR and ALTO can be written for them without inventing boxes.
 *
 * pdfjs reports text as items (one per run of shown text) with a transform that places the run in
 * PDF user space (points, origin bottom-left). Everything here is converted with the page viewport
 * (scale 1), which applies /Rotate and flips y, so results are in the page as displayed: top-left
 * origin, points, size `viewport.width` x `viewport.height`.
 *
 * Words come from splitting items on white space. Where the page's glyph advances are available
 * (pdfjs exposes them through the operator list) the item's width is divided between its characters
 * in proportion to those advances; where they cannot be matched to the item, every UTF-16 unit of the
 * item gets an equal share of its width. Characters pdfjs inserted between runs (a gap, not a glyph)
 * count as a quarter em. The item's total width is always the one pdfjs reports.
 *
 * Text drawn at an angle: an item whose baseline is not within a few degrees of horizontal is one line
 * on its own, with the axis-aligned box that contains its rotated words and no baseline unless it runs
 * left to right at no more than 45 degrees from horizontal. Such lines each form their own paragraph
 * and block. Whole-page rotation is handled
 * exactly by the viewport.
 */

/** Items a page may have before it is refused as hostile; real pages have a few thousand at most. */
export const PDF_TEXT_MAX_ITEMS_PER_PAGE = 100_000;
/** Words a page may have; one item can hold many words, so this bounds the output separately. */
export const PDF_TEXT_MAX_WORDS_PER_PAGE = 200_000;
/** How far ahead in the glyph stream to look for an item's glyphs after a mismatch. */
const GLYPH_RESYNC_WINDOW = 256;
/** PDF glyph widths are in thousandths of an em. */
const GLYPH_UNITS_PER_EM = 1000;
/** Weight of a gap pdfjs turned into a space, in em, when the item's glyphs are weighed. */
const SYNTHETIC_SPACE_EM = 0.25;
/** Largest rise over run (about 1.7 degrees) at which an item still counts as horizontal. */
const HORIZONTAL_SLOPE_TOLERANCE = 0.03;
/** Baselines within this many em of each other are one row. */
const BASELINE_TOLERANCE_EM = 0.35;
/** A horizontal gap wider than this many em between two runs on one row separates two lines (columns). */
const COLUMN_GAP_EM = 2.5;
/** A baseline step of more than this many em starts a new paragraph. */
const PARAGRAPH_GAP_EM = 1.6;
/** A baseline step of more than this many em starts a new block. */
const BLOCK_GAP_EM = 3;
/** Ascent and descent in em for a font that reports none: a typical split of the em box. */
const FALLBACK_ASCENT_EM = 0.8;
const FALLBACK_DESCENT_EM = 0.2;
const TRANSFORM_VALUES = 6;
const CH_SPACE = 0x20;
const CH_NBSP = 0xa0;
const FIRST_UNICODE_SPACE = 0x2000;
const LAST_UNICODE_SPACE = 0x200a;
const CH_IDEOGRAPHIC_SPACE = 0x3000;

export class PdfTextGeometryError extends ConversionFailedError {
  readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = 'PdfTextGeometryError';
  }
}

interface Point {
  x: number;
  y: number;
}

interface Viewport {
  width: number;
  height: number;
  convertToViewportPoint(x: number, y: number): [number, number];
}

interface TextItem {
  str: string;
  transform: number[];
  width: number;
  fontName: string;
}

interface FontStyle {
  ascent?: number;
  descent?: number;
}

interface Glyph {
  unicode: string;
  width: number;
}

interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** One text item as displayed: its words, its box and the baseline it sits on. */
interface ItemRun {
  words: OcrWord[];
  box: Box;
  /** Displayed baseline, from its first to its last word; undefined when it runs steeper than 45 degrees or right to left. */
  baseline: OcrBaseline | undefined;
  horizontal: boolean;
  /** Em size in points. */
  size: number;
  baselineY: number;
}

interface TextLine {
  runs: ItemRun[];
  words: OcrWord[];
  box: Box;
  baseline: OcrBaseline | undefined;
  horizontal: boolean;
  size: number;
  baselineY: number;
}

function isWordSpace(code: number): boolean {
  return (
    code <= CH_SPACE ||
    code === CH_NBSP ||
    (code >= FIRST_UNICODE_SPACE && code <= LAST_UNICODE_SPACE) ||
    code === CH_IDEOGRAPHIC_SPACE
  );
}

function isTextItem(candidate: unknown): candidate is TextItem {
  const item = candidate as Partial<TextItem> | null;
  return (
    typeof item === 'object' &&
    item !== null &&
    typeof item.str === 'string' &&
    Array.isArray(item.transform) &&
    item.transform.length === TRANSFORM_VALUES &&
    item.transform.every((value) => Number.isFinite(value)) &&
    typeof item.width === 'number' &&
    Number.isFinite(item.width)
  );
}

/** The glyphs of every text-showing operator on the page, in drawing order. */
function collectGlyphs(operatorList: { fnArray: number[]; argsArray: unknown[][] }, ops: Record<string, number>): Glyph[] {
  const glyphs: Glyph[] = [];
  const addAll = (shown: unknown): void => {
    if (!Array.isArray(shown)) return;
    for (const entry of shown) {
      const glyph = entry as Partial<Glyph> | null;
      if (typeof glyph === 'object' && glyph !== null && typeof glyph.unicode === 'string' && typeof glyph.width === 'number') {
        glyphs.push({ unicode: glyph.unicode, width: glyph.width });
      }
    }
  };
  operatorList.fnArray.forEach((fn, index) => {
    const args = operatorList.argsArray[index];
    if (fn === ops.showText || fn === ops.showSpacedText || fn === ops.nextLineShowText) addAll(args?.[0]);
    else if (fn === ops.nextLineSetSpacingShowText) addAll(args?.[2]);
  });
  return glyphs;
}

/**
 * Weights, in em, for each UTF-16 unit of `text` taken from the glyphs starting at `start`, and the
 * index after the last glyph used; null when the glyphs do not spell `text`.
 */
function matchGlyphs(text: string, glyphs: Glyph[], start: number): { weights: number[]; next: number } | null {
  const weights: number[] = new Array<number>(text.length).fill(0);
  let at = 0;
  let glyphIndex = start;
  while (at < text.length) {
    if (glyphIndex >= glyphs.length) return null;
    const glyph = glyphs[glyphIndex];
    if (glyph.unicode === '') {
      glyphIndex++;
    } else if (text.startsWith(glyph.unicode, at)) {
      const share = glyph.width / GLYPH_UNITS_PER_EM / glyph.unicode.length;
      for (let i = 0; i < glyph.unicode.length; i++) weights[at + i] = share;
      at += glyph.unicode.length;
      glyphIndex++;
    } else if (isWordSpace(text.charCodeAt(at))) {
      // A gap pdfjs turned into a space is not a glyph of its own.
      weights[at] = SYNTHETIC_SPACE_EM;
      at++;
    } else {
      return null;
    }
  }
  return { weights, next: glyphIndex };
}

function weighItem(text: string, glyphs: Glyph[], cursor: { next: number }): number[] {
  let matched = matchGlyphs(text, glyphs, cursor.next);
  for (let offset = 1; matched === null && offset <= GLYPH_RESYNC_WINDOW; offset++) {
    matched = matchGlyphs(text, glyphs, cursor.next + offset);
  }
  if (matched === null) return new Array<number>(text.length).fill(1);
  cursor.next = matched.next;
  const total = matched.weights.reduce((sum, weight) => sum + weight, 0);
  return total > 0 ? matched.weights : new Array<number>(text.length).fill(1);
}

function unionOf(points: Point[]): Box {
  const box = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  for (const point of points) {
    box.x0 = Math.min(box.x0, point.x);
    box.y0 = Math.min(box.y0, point.y);
    box.x1 = Math.max(box.x1, point.x);
    box.y1 = Math.max(box.y1, point.y);
  }
  return box;
}

function toViewport(viewport: Viewport, x: number, y: number): Point {
  const [vx, vy] = viewport.convertToViewportPoint(x, y);
  return { x: vx, y: vy };
}

function toBBox(box: Box): OcrLineBlock['bbox'] {
  return { x: box.x0, y: box.y0, width: box.x1 - box.x0, height: box.y1 - box.y0 };
}

/** Splits one item into positioned words, or null when it has none or no usable geometry. */
function splitItem(item: TextItem, style: FontStyle | undefined, viewport: Viewport, weights: number[]): ItemRun | null {
  const [a, b, c, d, e, f] = item.transform;
  const run = Math.hypot(a, b);
  const size = Math.hypot(c, d);
  if (run === 0 || size === 0 || item.width <= 0) return null;
  // Text-space x axis (along the baseline) and y axis (up) in user space, as unit vectors.
  const ux = a / run;
  const uy = b / run;
  const vx = c / size;
  const vy = d / size;
  const ascent = typeof style?.ascent === 'number' && Number.isFinite(style.ascent) ? style.ascent : FALLBACK_ASCENT_EM;
  const descent = typeof style?.descent === 'number' && Number.isFinite(style.descent) ? -style.descent : FALLBACK_DESCENT_EM;
  const up = ascent * size;
  const down = descent * size;

  const total = weights.reduce((sum, weight) => sum + weight, 0);
  const offsets: number[] = new Array<number>(weights.length + 1);
  offsets[0] = 0;
  for (let i = 0; i < weights.length; i++) offsets[i + 1] = offsets[i] + (weights[i] / total) * item.width;

  const words: OcrWord[] = [];
  const corners: Point[] = [];
  let first: Point | null = null;
  let last: Point | null = null;
  let start = -1;
  for (let i = 0; i <= item.str.length; i++) {
    const space = i === item.str.length || isWordSpace(item.str.charCodeAt(i));
    if (space && start !== -1) {
      const d0 = offsets[start];
      const d1 = offsets[i];
      const p0 = { x: e + ux * d0, y: f + uy * d0 };
      const p1 = { x: e + ux * d1, y: f + uy * d1 };
      const wordCorners = [
        toViewport(viewport, p0.x + vx * up, p0.y + vy * up),
        toViewport(viewport, p1.x + vx * up, p1.y + vy * up),
        toViewport(viewport, p1.x - vx * down, p1.y - vy * down),
        toViewport(viewport, p0.x - vx * down, p0.y - vy * down),
      ];
      const box = unionOf(wordCorners);
      words.push({ text: item.str.slice(start, i), bbox: toBBox(box) });
      corners.push(...wordCorners);
      first ??= toViewport(viewport, p0.x, p0.y);
      last = toViewport(viewport, p1.x, p1.y);
      start = -1;
    } else if (!space && start === -1) {
      start = i;
    }
  }
  if (words.length === 0 || first === null || last === null) return null;

  const dx = last.x - first.x;
  const dy = last.y - first.y;
  const horizontal = dx > 0 && Math.abs(dy) <= HORIZONTAL_SLOPE_TOLERANCE * dx;
  return {
    words,
    box: unionOf(corners),
    baseline: dx > 0 && Math.abs(dy) <= dx ? { x0: first.x, y0: first.y, x1: last.x, y1: last.y } : undefined,
    horizontal,
    size,
    baselineY: first.y,
  };
}

function lineFrom(runs: ItemRun[]): TextLine {
  const words = runs.flatMap((run) => run.words);
  const box = unionOf(runs.flatMap((run) => [
    { x: run.box.x0, y: run.box.y0 },
    { x: run.box.x1, y: run.box.y1 },
  ]));
  const firstRun = runs[0];
  const lastRun = runs[runs.length - 1];
  let baseline: OcrBaseline | undefined;
  if (firstRun.baseline && lastRun.baseline) {
    baseline = { x0: firstRun.baseline.x0, y0: firstRun.baseline.y0, x1: lastRun.baseline.x1, y1: lastRun.baseline.y1 };
  }
  return {
    runs,
    words,
    box,
    baseline,
    horizontal: firstRun.horizontal,
    size: Math.max(...runs.map((run) => run.size)),
    baselineY: firstRun.baselineY,
  };
}

/** Horizontal runs become lines: one row per baseline, split where a gap is wide enough to be a column break. */
function buildLines(runs: ItemRun[]): TextLine[] {
  const horizontal = runs.filter((run) => run.horizontal).sort((p, q) => p.baselineY - q.baselineY || p.box.x0 - q.box.x0);
  const lines: TextLine[] = [];
  let row: ItemRun[] = [];
  const flushRow = (): void => {
    row.sort((p, q) => p.box.x0 - q.box.x0);
    let current: ItemRun[] = [];
    for (const run of row) {
      const previous = current[current.length - 1];
      if (previous && run.box.x0 - previous.box.x1 > COLUMN_GAP_EM * Math.max(run.size, previous.size)) {
        lines.push(lineFrom(current));
        current = [];
      }
      current.push(run);
    }
    if (current.length > 0) lines.push(lineFrom(current));
    row = [];
  };
  for (const run of horizontal) {
    if (row.length > 0 && run.baselineY - row[0].baselineY > BASELINE_TOLERANCE_EM * Math.max(run.size, row[0].size)) flushRow();
    row.push(run);
  }
  flushRow();
  return lines;
}

interface BlockState {
  group: OcrLayoutGroup;
}

interface ParagraphState {
  group: OcrLayoutGroup;
  block: BlockState;
  box: Box;
  baselineY: number;
}

function horizontalOverlap(a: Box, b: Box): boolean {
  return Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0) > 0;
}

/** Turns lines into line blocks sharing paragraph and block groups, by baseline steps and column overlap. */
function groupLines(lines: TextLine[], rotatedLines: TextLine[]): OcrLineBlock[] {
  const blocks: OcrLineBlock[] = [];
  const open: ParagraphState[] = [];
  const largest = Math.max(1, ...lines.map((line) => line.size));
  const emit = (line: TextLine, block: OcrLayoutGroup, paragraph: OcrLayoutGroup): void => {
    const lineBlock: OcrLineBlock = {
      text: line.words.map((word) => word.text).join(' '),
      bbox: toBBox(line.box),
      words: line.words,
      block,
      paragraph,
    };
    if (line.baseline) lineBlock.baseline = line.baseline;
    blocks.push(lineBlock);
  };

  for (const line of lines) {
    while (open.length > 0 && line.baselineY - open[0].baselineY > BLOCK_GAP_EM * largest) open.shift();
    let parent: ParagraphState | undefined;
    for (let i = open.length - 1; i >= 0; i--) {
      const candidate = open[i];
      const step = line.baselineY - candidate.baselineY;
      if (step > BASELINE_TOLERANCE_EM * line.size && step <= BLOCK_GAP_EM * line.size && horizontalOverlap(candidate.box, line.box)) {
        parent = candidate;
        break;
      }
    }
    let state: ParagraphState;
    if (parent && line.baselineY - parent.baselineY <= PARAGRAPH_GAP_EM * line.size) {
      state = parent;
      state.box = unionOf([
        { x: state.box.x0, y: state.box.y0 },
        { x: state.box.x1, y: state.box.y1 },
        { x: line.box.x0, y: line.box.y0 },
        { x: line.box.x1, y: line.box.y1 },
      ]);
      state.baselineY = line.baselineY;
    } else {
      const block = parent ? parent.block : { group: {} };
      state = { group: {}, block, box: { ...line.box }, baselineY: line.baselineY };
      open.push(state);
    }
    emit(line, state.block.group, state.group);
  }
  for (const line of rotatedLines) emit(line, {}, {});
  return blocks;
}

async function readPage(
  pdfjs: PdfJs,
  page: PdfJsPage,
  pageNumber: number
): Promise<OcrResult> {
  const viewport = page.getViewport({ scale: 1 });
  const content = await page.getTextContent();
  if (content.items.length > PDF_TEXT_MAX_ITEMS_PER_PAGE) {
    throw new PdfTextGeometryError(`PDF page ${pageNumber} has more than ${PDF_TEXT_MAX_ITEMS_PER_PAGE} text items.`);
  }
  const operatorList = await page.getOperatorList();
  const glyphs = collectGlyphs(operatorList, pdfjs.OPS);
  const cursor = { next: 0 };

  const runs: ItemRun[] = [];
  let wordTotal = 0;
  for (const candidate of content.items) {
    if (!isTextItem(candidate)) continue;
    // Every item consumes its glyphs, even when it is only white space, so the stream stays in step.
    const weights = weighItem(candidate.str, glyphs, cursor);
    if (candidate.str.trim() === '') continue;
    const run = splitItem(candidate, content.styles[candidate.fontName], viewport, weights);
    if (!run) continue;
    wordTotal += run.words.length;
    if (wordTotal > PDF_TEXT_MAX_WORDS_PER_PAGE) {
      throw new PdfTextGeometryError(`PDF page ${pageNumber} has more than ${PDF_TEXT_MAX_WORDS_PER_PAGE} words.`);
    }
    runs.push(run);
  }

  const rotated = runs.filter((run) => !run.horizontal).map((run) => lineFrom([run]));
  const lineBlocks = groupLines(buildLines(runs), rotated);
  const lines = lineBlocks.map((block) => block.text);
  return {
    text: lines.join('\n'),
    // The page's own text layer is exact; word confidence is left unknown.
    confidence: 1,
    wordCount: lineBlocks.reduce((sum, block) => sum + block.words.length, 0),
    lines,
    lineBlocks,
    imageWidth: viewport.width,
    imageHeight: viewport.height,
  };
}

interface PdfJsPage {
  getViewport(options: { scale: number }): Viewport;
  getTextContent(): Promise<{ items: unknown[]; styles: Record<string, FontStyle> }>;
  getOperatorList(): Promise<{ fnArray: number[]; argsArray: unknown[][] }>;
}

interface PdfJsDocument {
  numPages: number;
  getPage(pageNumber: number): Promise<PdfJsPage>;
}

interface PdfJsLoadingTask {
  promise: Promise<PdfJsDocument>;
  destroy(): Promise<void>;
}

interface PdfJs {
  OPS: Record<string, number>;
  getDocument(options: Record<string, unknown>): PdfJsLoadingTask;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Word geometry for the requested pages of a PDF, as one OcrResult per page (blocks, paragraphs,
 * lines and words with real boxes; baselines for left-to-right lines; no word confidence). A page
 * without text yields an empty result.
 * @throws PdfTextGeometryError when the document cannot be read, a page does not exist, or a page
 * exceeds the item or word limits.
 */
export async function extractPdfTextLayerPages(pdfBuffer: Buffer, pageNumbers: ReadonlySet<number>): Promise<Map<number, OcrResult>> {
  const results = new Map<number, OcrResult>();
  if (pageNumbers.size === 0) return results;
  let task: PdfJsLoadingTask | undefined;
  try {
    const pdfjs = (await import('pdfjs-dist/legacy/build/pdf.mjs')) as unknown as PdfJs;
    task = pdfjs.getDocument({
      data: new Uint8Array(pdfBuffer),
      useSystemFonts: true,
      disableFontFace: true,
      isEvalSupported: false,
      verbosity: 0,
    });
    const doc = await task.promise;
    for (const pageNumber of [...pageNumbers].sort((p, q) => p - q)) {
      if (!Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > doc.numPages) {
        throw new PdfTextGeometryError(`PDF page ${pageNumber} does not exist; the document has ${doc.numPages} pages.`);
      }
      results.set(pageNumber, await readPage(pdfjs, await doc.getPage(pageNumber), pageNumber));
    }
    return results;
  } catch (err) {
    if (err instanceof PdfTextGeometryError) throw err;
    throw new PdfTextGeometryError(`PDF text geometry could not be read: ${messageOf(err)}`);
  } finally {
    await task?.destroy().catch(() => undefined);
  }
}
