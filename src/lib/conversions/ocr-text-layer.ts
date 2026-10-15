import {
  PDFNumber,
  PDFHexString,
  PDFOperator,
  PDFOperatorNames,
  PDFPage,
  beginText,
  endText,
  popGraphicsState,
  pushGraphicsState,
  setFontAndSize,
  setTextMatrix,
  setTextRenderingMode,
  TextRenderingMode,
} from 'pdf-lib';
import { OcrEngineUnavailableError } from '../types';
import type { OcrLineBlock, OcrResult, OcrWord } from './ocr-pdf-combiner';
import {
  GLYPH_UNITS_PER_EM,
  GLYPHLESS_ASCENT,
  GLYPHLESS_DESCENT,
  glyphAdvanceForCodePoint,
} from './ocr-text-layer-font';

/**
 * The searchable-PDF text layer: every recognized word is shown, invisibly (text render mode 3),
 * on the baseline the engine found for its line, with the horizontal scaling that makes the word
 * exactly as wide as the engine's box. Viewers use it for search, selection and copy, so a word's
 * glyphs must lie where the word is on the scan.
 *
 * The font is the glyphless one of ocr-text-layer-font.ts, whose advances are known exactly
 * (500 or 1000 units per character), so the scaling is a division, not an estimate, and it is not
 * clamped. Its ascent and descent are the proportions of a text row (ascender top to descender
 * bottom), so a word set at the row's height spans the row in a viewer's selection.
 */

/** Words written to one page; a dense page holds a few thousand, so more is not a scan. */
export const OCR_MAX_WORDS_PER_PAGE = 50_000;
/** Characters written to one page, bounding the size of the content stream. */
export const OCR_MAX_TEXT_LAYER_CHARS_PER_PAGE = 2_000_000;

const PERCENT = 100;
const ASCENT_FRACTION = GLYPHLESS_ASCENT / GLYPH_UNITS_PER_EM;
const SPACE_CHARACTER = ' ';
const COORDINATE_DECIMALS = 4;
const MATRIX_DECIMALS = 6;
const DEGREES_TO_RADIANS = Math.PI / 180;

/**
 * Raised when a result has text but no line or word boxes to place it with. Nothing is invented: an
 * evenly spaced layer would put words where they are not on the page, so no PDF is made. The engine
 * returned no geometry, which is a fault of the engine rather than of the request (HTTP 503).
 */
export class OcrGeometryUnavailableError extends OcrEngineUnavailableError {
  constructor(message: string) {
    super(message);
    this.name = 'OcrGeometryUnavailableError';
  }
}

/** Raised when a page holds more words or characters than a text layer is allowed to. */
export class OcrTextLayerLimitError extends OcrEngineUnavailableError {
  constructor(message: string) {
    super(message);
    this.name = 'OcrTextLayerLimitError';
  }
}

/** One word of the layer, in PDF user space (points, y up). */
export interface PlacedWord {
  text: string;
  /** Whether a space follows, so that copied text keeps the words apart. */
  spaceAfter: boolean;
  /** The word's origin on its baseline. */
  x: number;
  y: number;
  /** Counterclockwise rotation of the baseline from the x axis, in radians. */
  angle: number;
  fontSize: number;
  /** Horizontal scaling (Tz) in percent that makes the word as wide as its box. */
  horizontalScaling: number;
}

interface Vector {
  x: number;
  y: number;
}

function unit(dx: number, dy: number): Vector | null {
  const length = Math.hypot(dx, dy);
  return length > 0 ? { x: dx / length, y: dy / length } : null;
}

/** Direction the text of a line runs in the page as scanned (y down). */
function lineDirection(block: OcrLineBlock): Vector {
  if (block.baseline) {
    const fromBaseline = unit(block.baseline.x1 - block.baseline.x0, block.baseline.y1 - block.baseline.y0);
    if (fromBaseline) return fromBaseline;
  }
  const radians = (block.angleDegrees ?? 0) * DEGREES_TO_RADIANS;
  return { x: Math.cos(radians), y: Math.sin(radians) };
}

function corners(word: OcrWord): Vector[] {
  const { x, y, width, height } = word.bbox;
  return [
    { x, y },
    { x: x + width, y },
    { x, y: y + height },
    { x: x + width, y: y + height },
  ];
}

/** The advance of a text in glyph units (1/1000 em). */
export function advanceUnits(text: string): number {
  let units = 0;
  for (const ch of text) units += glyphAdvanceForCodePoint(ch.codePointAt(0) as number);
  return units;
}

interface WordFrame {
  /** Origin of the word on its baseline, in the page as scanned (pixels, y down). */
  originX: number;
  originY: number;
  /** Length of the word's box along the baseline, and the height of the text row, in pixels. */
  along: number;
  across: number;
}

/**
 * Where a word sits in the frame of its line (`d` along the text, `n` towards the descenders).
 * With the line's baseline known, the word starts where its box starts along the baseline and sits
 * on the baseline, at the engine's row height. Without one (the native tool's TSV has none) the
 * word's own box gives the row: it is as tall as the box and its baseline is the font's ascent
 * below the top.
 */
function frameOf(word: OcrWord, block: OcrLineBlock, d: Vector, n: Vector): WordFrame {
  const points = corners(word);
  const reference = block.baseline ? { x: block.baseline.x0, y: block.baseline.y0 } : points[0];
  let uMin = Infinity;
  let uMax = -Infinity;
  let vMin = Infinity;
  let vMax = -Infinity;
  for (const p of points) {
    const u = (p.x - reference.x) * d.x + (p.y - reference.y) * d.y;
    const v = (p.x - reference.x) * n.x + (p.y - reference.y) * n.y;
    uMin = Math.min(uMin, u);
    uMax = Math.max(uMax, u);
    vMin = Math.min(vMin, v);
    vMax = Math.max(vMax, v);
  }
  const boxHeight = vMax - vMin;
  if (block.baseline) {
    return {
      originX: reference.x + uMin * d.x,
      originY: reference.y + uMin * d.y,
      along: uMax - uMin,
      across: block.rowHeight && block.rowHeight > 0 ? block.rowHeight : boxHeight,
    };
  }
  const v = vMin + ASCENT_FRACTION * boxHeight;
  return {
    originX: reference.x + uMin * d.x + v * n.x,
    originY: reference.y + uMin * d.y + v * n.y,
    along: uMax - uMin,
    across: boxHeight,
  };
}

function assertWithinLimits(words: number, characters: number): void {
  if (words > OCR_MAX_WORDS_PER_PAGE) {
    throw new OcrTextLayerLimitError(`The page has more than ${OCR_MAX_WORDS_PER_PAGE} words; no text layer is written.`);
  }
  if (characters > OCR_MAX_TEXT_LAYER_CHARS_PER_PAGE) {
    throw new OcrTextLayerLimitError(
      `The page has more than ${OCR_MAX_TEXT_LAYER_CHARS_PER_PAGE} characters; no text layer is written.`
    );
  }
}

/**
 * The words of a result placed on a page, in reading order, in PDF user space. `scaleX` and `scaleY`
 * are points per pixel of the scan (72 / dpi, or the page's points over the rendered pixels), and
 * `pageHeight` is the user-space y of the pixel grid's top edge (the page's height for a page whose box starts at the
 * origin) and `originX` the user-space x of its left edge. Throws OcrGeometryUnavailableError when the result has
 * text but a line without word boxes, or no lines at all.
 */
export function placeWords(result: OcrResult, scaleX: number, scaleY: number, pageHeight: number, originX = 0): PlacedWord[] {
  const lines = result.lineBlocks ?? [];
  if (lines.length === 0) {
    if (result.text.trim() === '') return [];
    throw new OcrGeometryUnavailableError(
      'The OCR result has text but no line or word boxes, so a text layer cannot be placed on the page.'
    );
  }
  const placed: PlacedWord[] = [];
  let characters = 0;
  for (const block of lines) {
    const words = block.words.filter((word) => word.text.trim() !== '');
    if (words.length === 0) {
      if (block.text.trim() === '') continue;
      throw new OcrGeometryUnavailableError(`The line '${block.text.trim().slice(0, 40)}' has no word boxes, so its text cannot be placed.`);
    }
    const d = lineDirection(block);
    const n: Vector = { x: -d.y, y: d.x };
    const angle = -Math.atan2(d.y * scaleY, d.x * scaleX);
    words.forEach((word, index) => {
      const text = word.text.trim();
      characters += text.length + 1;
      assertWithinLimits(placed.length + 1, characters);
      const frame = frameOf(word, block, d, n);
      const fontSize = frame.across * scaleY;
      const advance = (advanceUnits(text) / GLYPH_UNITS_PER_EM) * fontSize;
      placed.push({
        text,
        spaceAfter: index < words.length - 1,
        x: originX + frame.originX * scaleX,
        y: pageHeight - frame.originY * scaleY,
        angle,
        fontSize,
        // Exactly as wide as the box; a word with no advance (combining marks only) has nothing to scale.
        horizontalScaling: advance > 0 ? ((frame.along * scaleX) / advance) * PERCENT : PERCENT,
      });
    });
  }
  return placed;
}

function fixed(value: number, decimals: number): PDFNumber {
  return PDFNumber.of(Number(value.toFixed(decimals)));
}

/** Writes placed words into the page's content, invisibly, in the glyphless text layer font. */
export function writeTextLayer(
  page: PDFPage,
  words: readonly PlacedWord[],
  font: { fontName: string; encodeText: (text: string) => string }
): void {
  if (words.length === 0) return;
  const operators = [pushGraphicsState(), setTextRenderingMode(TextRenderingMode.Invisible)];
  for (const word of words) {
    if (!(word.fontSize > 0) || !Number.isFinite(word.fontSize)) continue;
    const cos = Math.cos(word.angle);
    const sin = Math.sin(word.angle);
    operators.push(
      beginText(),
      setFontAndSize(font.fontName, Number(word.fontSize.toFixed(COORDINATE_DECIMALS))),
      PDFOperator.of(PDFOperatorNames.SetTextHorizontalScaling, [fixed(word.horizontalScaling, COORDINATE_DECIMALS)]),
      setTextMatrix(
        Number(cos.toFixed(MATRIX_DECIMALS)),
        Number(sin.toFixed(MATRIX_DECIMALS)),
        Number((-sin).toFixed(MATRIX_DECIMALS)),
        Number(cos.toFixed(MATRIX_DECIMALS)),
        Number(word.x.toFixed(COORDINATE_DECIMALS)),
        Number(word.y.toFixed(COORDINATE_DECIMALS))
      ),
      PDFOperator.of(PDFOperatorNames.ShowText, [
        PDFHexString.of(font.encodeText(word.spaceAfter ? `${word.text}${SPACE_CHARACTER}` : word.text)),
      ]),
      endText()
    );
  }
  operators.push(popGraphicsState());
  page.pushOperators(...operators);
}
