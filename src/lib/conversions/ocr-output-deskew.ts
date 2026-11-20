import {
  PDFContentStream,
  PDFName,
  PDFOperator,
  PDFPage,
  PDFRef,
  concatTransformationMatrix,
  popGraphicsState,
  pushGraphicsState,
} from 'pdf-lib';
import { type PlacedWord, advanceUnits } from './ocr-text-layer';
import { GLYPHLESS_ASCENT, GLYPHLESS_DESCENT, GLYPH_UNITS_PER_EM } from './ocr-text-layer-font';

export type { PlacedWord };

/**
 * Output deskew, the behaviour of `ocrmypdf --deskew`: the page of a searchable PDF is levelled, so that its text
 * layer runs along the rows of the page. The text layer of a skewed scan lies on the slanted lines of the scan, which
 * is right for search and selection, but a text extractor that regroups words by position (Poppler's `pdftotext`)
 * reads the lines of a slanted page in the wrong order: the right end of a line is higher than the left end of the
 * line above it. The whole page content, scan and text layer, is therefore turned by the measured skew with one
 * transformation matrix: nothing is resampled, and the bytes of the scan stay as they were.
 *
 * Like the reference, the sheet turns about its centre, the corners that the turn leaves empty are the white of the
 * page, and the corners it carries past the page are cut off. Unlike it, the page grows when a recognised word would
 * otherwise leave it, so no word is lost.
 */

/** A skew under this many degrees is left alone: a viewer's rendering of the turn costs more than it gains. */
export const OCR_OUTPUT_DESKEW_MIN_DEGREES = 0.25;
/** A skew over this many degrees is not a scan that was fed in crooked, and the page is left as it is. */
export const OCR_OUTPUT_DESKEW_MAX_DEGREES = 20;
/** A word's line must lie within this many degrees of the median skew to count as agreeing with it. */
export const OCR_OUTPUT_DESKEW_AGREEMENT_DEGREES = 1.5;
/** The share of the text (by length) that must agree with the median skew; a curved page does not. */
export const OCR_OUTPUT_DESKEW_AGREEMENT_SHARE = 0.8;
/** Fewer words than this do not say what the page's skew is. */
export const OCR_OUTPUT_DESKEW_MIN_WORDS = 6;

const DEGREES_TO_RADIANS = Math.PI / 180;
const QUARTER_TURN = Math.PI / 2;
const ASCENT_EM = GLYPHLESS_ASCENT / GLYPH_UNITS_PER_EM;
const DESCENT_EM = GLYPHLESS_DESCENT / GLYPH_UNITS_PER_EM;
const BOX_KEYS_TO_DROP = ['TrimBox', 'BleedBox', 'ArtBox'] as const;

function wordLength(word: PlacedWord): number {
  return (advanceUnits(word.text) / GLYPH_UNITS_PER_EM) * word.fontSize * (word.horizontalScaling / 100);
}

/** The angle of a baseline as its residual to the nearest quarter turn, in (-45, 45] degrees, in radians. */
function residualOfQuarterTurn(angle: number): number {
  return angle - QUARTER_TURN * Math.round(angle / QUARTER_TURN);
}

/**
 * The skew of a page's text layer, in radians counterclockwise (the angle the text runs at, as `PlacedWord.angle`),
 * or null when the page is not to be levelled: too few words, lines that do not agree (a curved page), a skew below
 * OCR_OUTPUT_DESKEW_MIN_DEGREES or above OCR_OUTPUT_DESKEW_MAX_DEGREES. A page turned by a quarter reads as its residual.
 * It is the median of the words' baselines, weighted by the length of each word along its baseline.
 */
export function measureTextSkewRadians(words: readonly PlacedWord[]): number | null {
  const measured = words
    .map((word) => ({ residual: residualOfQuarterTurn(word.angle), weight: wordLength(word) }))
    .filter((entry) => Number.isFinite(entry.residual) && entry.weight > 0);
  if (measured.length < OCR_OUTPUT_DESKEW_MIN_WORDS) return null;
  measured.sort((a, b) => a.residual - b.residual);
  const total = measured.reduce((sum, entry) => sum + entry.weight, 0);
  let seen = 0;
  let median = measured[measured.length - 1].residual;
  for (const entry of measured) {
    seen += entry.weight;
    if (seen >= total / 2) {
      median = entry.residual;
      break;
    }
  }
  const agreeing = measured
    .filter((entry) => Math.abs(entry.residual - median) <= OCR_OUTPUT_DESKEW_AGREEMENT_DEGREES * DEGREES_TO_RADIANS)
    .reduce((sum, entry) => sum + entry.weight, 0);
  if (agreeing / total < OCR_OUTPUT_DESKEW_AGREEMENT_SHARE) return null;
  const degrees = Math.abs(median) / DEGREES_TO_RADIANS;
  if (degrees < OCR_OUTPUT_DESKEW_MIN_DEGREES || degrees > OCR_OUTPUT_DESKEW_MAX_DEGREES) return null;
  return median;
}

interface Rectangle {
  x: number;
  y: number;
  width: number;
  height: number;
}

function union(a: Rectangle, minX: number, minY: number, maxX: number, maxY: number): Rectangle {
  const x = Math.min(a.x, minX);
  const y = Math.min(a.y, minY);
  return { x, y, width: Math.max(a.x + a.width, maxX) - x, height: Math.max(a.y + a.height, maxY) - y };
}

/** Whether the page has annotations, which a turn of the content would leave behind. */
function hasAnnotations(page: PDFPage): boolean {
  const annots = page.node.Annots();
  return annots !== undefined && annots.size() > 0;
}

/**
 * Turns the page's content (everything drawn, the text layer included) by `-skew` about the centre of its box, and
 * grows the box when a recognised word would leave it. Returns the angle the content was turned by (radians,
 * counterclockwise), or null when the page was left alone (see measureTextSkewRadians; a page with annotations is
 * left alone too, since they do not turn with the content).
 */
export function levelPageToText(page: PDFPage, words: readonly PlacedWord[]): number | null {
  const skew = measureTextSkewRadians(words);
  if (skew === null || hasAnnotations(page)) return null;

  const turn = -skew;
  const cos = Math.cos(turn);
  const sin = Math.sin(turn);
  const box = page.getCropBox();
  const centreX = box.x + box.width / 2;
  const centreY = box.y + box.height / 2;
  const toX = (x: number, y: number): number => centreX + (x - centreX) * cos - (y - centreY) * sin;
  const toY = (x: number, y: number): number => centreY + (x - centreX) * sin + (y - centreY) * cos;

  // The levelled extent of the words: each is a rectangle along its baseline, one em high about the baseline.
  let grown: Rectangle = box;
  for (const word of words) {
    const along = wordLength(word);
    const dx = Math.cos(word.angle);
    const dy = Math.sin(word.angle);
    for (const [u, v] of [
      [0, -DESCENT_EM],
      [along, -DESCENT_EM],
      [0, ASCENT_EM],
      [along, ASCENT_EM],
    ] as const) {
      const px = word.x + u * dx - v * word.fontSize * dy;
      const py = word.y + u * dy + v * word.fontSize * dx;
      grown = union(grown, toX(px, py), toY(px, py), toX(px, py), toY(px, py));
    }
  }

  const doc = page.doc;
  const wrap = (operators: PDFOperator[]): PDFRef => doc.context.register(PDFContentStream.of(doc.context.obj({}), operators));
  page.node.normalize();
  const start = wrap([
    pushGraphicsState(),
    concatTransformationMatrix(
      Number(cos.toFixed(8)),
      Number(sin.toFixed(8)),
      Number((-sin).toFixed(8)),
      Number(cos.toFixed(8)),
      Number((centreX - (centreX * cos - centreY * sin)).toFixed(4)),
      Number((centreY - (centreX * sin + centreY * cos)).toFixed(4))
    ),
  ]);
  const end = wrap([popGraphicsState()]);
  page.node.wrapContentStreams(start, end);

  const media = page.getMediaBox();
  const nextMedia = union(media, grown.x, grown.y, grown.x + grown.width, grown.y + grown.height);
  page.setMediaBox(nextMedia.x, nextMedia.y, nextMedia.width, nextMedia.height);
  if (page.node.has(PDFName.of('CropBox'))) page.setCropBox(grown.x, grown.y, grown.width, grown.height);
  for (const key of BOX_KEYS_TO_DROP) page.node.delete(PDFName.of(key));
  return turn;
}
