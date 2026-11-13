import { ConversionFailedError, CorruptStreamError, DecompressionLimitError, EncryptedOfficeDocumentError, PayloadLimitError, type PdfPageAnalysis } from '../types';
import { PdfStructureError } from './pdf-document';
import type { OcrResult } from './ocr-pdf-combiner';

/** Items a page may have before it is refused as hostile; real pages have a few thousand at most. */
export const PDF_TEXT_MAX_ITEMS_PER_PAGE = 100_000;
/** Words a page may have; one item can hold many words, so this bounds the output separately. */
export const PDF_TEXT_MAX_WORDS_PER_PAGE = 200_000;
/** Longest text item, in UTF-16 units; checked before any per-character array is allocated. */
export const PDF_TEXT_MAX_ITEM_CHARS = 1_048_576;
/** Text a page may hold in all its items, in UTF-16 units; checked before any glyph or per-character data is built. */
export const PDF_TEXT_MAX_CHARS_PER_PAGE = 2_097_152;
/**
 * Pages with more text items than this are laid out without reading the operator list (equal shares
 * per character). The operator list cannot be sized before it is read, so graphics-heavy pages are
 * bounded by the wall-clock deadline instead.
 */
export const PDF_TEXT_OPERATOR_LIST_MAX_ITEMS = 20_000;
/** Wall-clock limit for one extraction job in its worker thread. */
export const PDF_TEXT_DEADLINE_MS = 60_000;
/** Environment variable that overrides the deadline (milliseconds); tests use it to keep CI fast. */
export const PDF_TEXT_DEADLINE_ENV = 'EASYCONVERT_PDF_TEXT_DEADLINE_MS';

/** Pixels of an image pdfjs decodes; larger images are skipped by the reader instead of being decoded. */
export const PDF_TEXT_MAX_IMAGE_PIXELS = 50_000_000;
/** The `maxImageSize` of a job that writes no pictures: pdf.js skips every picture larger than it before decoding, so none is decoded. */
export const PDF_TEXT_NO_IMAGE_PIXELS = 0;
/** Memory one WebAssembly picture decoder (JBIG2 and CCITT, or JPEG 2000) may grow to in a thread; see pdf-wasm-memory.ts. */
export const PDF_WASM_DECODER_MAX_BYTES = 256 * 1024 * 1024;
/** Pages a document may have for its text content to be read; a larger document is refused with 413. */
export const PDF_TEXT_MAX_PAGES = 2_000;
/** Text items a whole document may have; with the per-page cap alone, a few thousand pages could still hold hundreds of millions. */
export const PDF_TEXT_MAX_ITEMS_PER_DOCUMENT = 500_000;
/** Text a whole document may hold, in UTF-16 units. */
export const PDF_TEXT_MAX_CHARS_PER_DOCUMENT = 16_777_216;
/** Graphics operators one page may have before the page's rules and images are no longer collected. */
export const PDF_CONTENT_MAX_OPERATORS_PER_PAGE = 2_000_000;
/** Ruling lines one page may contribute; more are dropped (the page is flagged), as they only serve table detection. */
export const PDF_CONTENT_MAX_RULES_PER_PAGE = 20_000;
/** Painted shapes one page may report (filled rectangles and filled or stroked paths); more are dropped. */
export const PDF_CONTENT_MAX_SHAPES_PER_PAGE = 5_000;
/** Numbers in the path data of the shapes of one page; the shapes that come after are dropped. */
export const PDF_CONTENT_MAX_SHAPE_COORDINATES_PER_PAGE = 400_000;
/** Image placements one page may report. */
export const PDF_CONTENT_MAX_IMAGES_PER_PAGE = 256;
/** Picture placements a document may return, counted per placement as the Markdown and HTML output repeat a picture at each; more is refused with a 413. */
export const PDF_CONTENT_MAX_PICTURES = 32_768;
/** Bytes of image files a document may return; more is refused with a 413. */
export const PDF_CONTENT_MAX_IMAGE_BYTES = 128 * 1024 * 1024;
/** Decoded content stream bytes of one page read to line up its images with their PDF streams. */
export const PDF_CONTENT_MAX_PAGE_STREAM_BYTES = 64 * 1024 * 1024;
/** Distinct fonts a document may report; the item table is bounded by the item caps, this bounds the font table. */
export const PDF_CONTENT_MAX_FONTS = 4_096;
/** Nesting depth of the save/restore stack followed while reading the operator list. */
export const PDF_CONTENT_MAX_STATE_DEPTH = 256;

export class PdfTextGeometryError extends ConversionFailedError {
  readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = 'PdfTextGeometryError';
  }
}

/** Pages a message names. */
const PAGE_NUMBERS_SHOWN = 10;

/** `page 3` or `pages 3, 5, 8`: the first few page numbers, then an ellipsis. */
export function pagesPhrase(pages: readonly number[]): string {
  return `${pages.length === 1 ? 'page' : 'pages'} ${pages.slice(0, PAGE_NUMBERS_SHOWN).join(', ')}${pages.length > PAGE_NUMBERS_SHOWN ? ', ...' : ''}`;
}

/**
 * No page of the document has text that reads: the glyphs the fonts give no Unicode value for (replacement characters,
 * control codes, private-use characters) outnumber the glyphs that map, so reading the pages would hand out garbage or
 * nothing. The request can enable OCR to read such pages instead (HTTP 400).
 */
export class PdfTextUnmappedError extends ConversionFailedError {
  readonly status = 400;
  readonly pages: readonly number[];
  constructor(pages: readonly number[]) {
    super(
      `PDF ${pagesPhrase(pages)} use a font with no Unicode mapping, so the text cannot be read; enable OCR to recognize ${pages.length === 1 ? 'it' : 'them'}.`
    );
    this.name = 'PdfTextUnmappedError';
    this.pages = pages;
  }
}

const WHITE_SPACE = /\s/u;

/** The characters of the runs that are not white space. */
export function visibleGlyphsOf(items: readonly PdfContentItem[]): number {
  let glyphs = 0;
  for (const item of items) for (const character of item.text) if (!WHITE_SPACE.test(character)) glyphs++;
  return glyphs;
}

/** Why a worker-thread job failed, so the host can rebuild the typed error across the thread boundary. */
export type PdfTextFailureKind = 'encrypted' | 'limit' | 'decompression' | 'structure' | 'corrupt-stream' | 'invalid';

export function pdfTextFailure(kind: PdfTextFailureKind | undefined, message: string): ConversionFailedError {
  switch (kind) {
    case 'encrypted':
      return new EncryptedOfficeDocumentError(message);
    case 'limit':
      return new PayloadLimitError(message);
    case 'decompression':
      return new DecompressionLimitError(message);
    case 'structure':
      return new PdfStructureError(message);
    case 'corrupt-stream':
      return new CorruptStreamError(message);
    default:
      return new PdfTextGeometryError(message);
  }
}

/** The kind to report for a typed error; the order matters because DecompressionLimitError is a PayloadLimitError. */
export function pdfTextFailureKindOf(error: unknown): PdfTextFailureKind {
  if (error instanceof EncryptedOfficeDocumentError) return 'encrypted';
  if (error instanceof DecompressionLimitError) return 'decompression';
  if (error instanceof PayloadLimitError) return 'limit';
  if (error instanceof PdfStructureError) return 'structure';
  if (error instanceof CorruptStreamError) return 'corrupt-stream';
  return 'invalid';
}

/** Which pages get word geometry: the listed ones, every page that has text, or none. */
export type PdfGeometryPages = readonly number[] | 'text-pages' | 'none';

export interface PdfTextJob {
  /** When set, the job's wall-clock limit in milliseconds, if that is less than the host's (`PDF_TEXT_DEADLINE_MS`). */
  deadlineMs?: number;
  /** When set, every page is analyzed for text-layer density and the analyses are returned. */
  densityThreshold?: number;
  geometry: PdfGeometryPages;
  /** When set, the positioned text, rules and images of every page (or the listed pages) are returned. */
  content?: boolean | readonly number[];
  /** With `content`: also return the pixels of the images (the PDF's own JPEG data, or a PNG of the decoded pixels). */
  images?: boolean;
  /** With `content`: the text a glyph the fonts give no Unicode value for becomes, in its place; without it the glyph is left out. */
  unmappedGlyphText?: string;
  /** With `content`: also read the colour of the text and of the rules and images' paint order, and the filled and stroked shapes of the page (a writer that draws them needs this). */
  colour?: boolean;
}

/** One font of a document, as the layout needs it. */
export interface PdfContentFont {
  /** BaseFont without its subset tag, for example `NotoSans-Bold`. */
  name: string;
  bold: boolean;
  italic: boolean;
  monospace: boolean;
  serif: boolean;
}

/**
 * A run of shown text in the page as displayed: points, origin at the top left, y growing downwards (the page
 * viewport, so /Rotate is applied). `x` is the left end of the run and `baseline` its baseline.
 */
export interface PdfContentItem {
  text: string;
  x: number;
  baseline: number;
  width: number;
  /** Em size in points. */
  size: number;
  /** Index into the document's font table, or -1 when the font is unknown. */
  font: number;
  /** The run contains right-to-left letters, so its text is already in logical order. */
  rtl: boolean;
  /** Baseline runs steeper than a small tolerance; such runs are not part of any line. */
  angled: boolean;
  /** Text of a vertical writing mode font. */
  vertical: boolean;
  /** Drawn by an annotation's appearance stream (pdf-annotation-text.ts), not by the page's content. */
  annotation?: true;
  /**
   * Set only on a page whose glyphs mostly have no Unicode value: the run is set in a Type 3 font, whose character codes are
   * no text when no glyph name says so (entry 227), so a reader that keeps the text of that page leaves the run out.
   */
  type3Font?: true;
  /**
   * Only in a job that reads colour, and only on a run with a colour other than black: the colour of the characters of `text`,
   * stretch by stretch in text order. A stretch ends at `end` (UTF-16 units) and the last one ends at the end of the text.
   */
  colors?: PdfContentColour[];
  /** Only on a run with light text (white on a band): the colour of the rectangle that holds the run, as 0xRRGGBB. */
  fill?: number;
}

/** One stretch of a run's text in one fill colour (stroke colour for stroked text), as 0xRRGGBB. */
export interface PdfContentColour {
  end: number;
  color: number;
}

/** An axis-aligned ruling line (a stroked segment or a thin filled rectangle), in page-viewport points. */
export interface PdfContentRule {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  thickness: number;
  /** In a job that reads colour: the colour as 0xRRGGBB, left out for black. */
  color?: number;
  /** In a job that reads colour: the place in the paint order of the page, shared with its images and shapes. */
  z?: number;
  /** The rule is a piece of the outline of a `PdfContentShape`, which draws it. */
  inShape?: true;
}

/** A placed image: its box in the page viewport and what is needed to find its pixels. */
export interface PdfContentImage {
  x: number;
  y: number;
  width: number;
  height: number;
  /** Pixel size of the image. */
  pixelWidth: number;
  pixelHeight: number;
  /** The image file: `jpeg` is the PDF's own JPEG stream byte for byte, `png` a PNG of the pixels pdfjs decoded. */
  data?: Uint8Array;
  format?: 'jpeg' | 'png';
  /** In a job that reads colour: the place in the paint order of the page, shared with its rules and shapes. */
  z?: number;
}

/**
 * A painted path of a page that is not a rule: a filled rectangle, or an outline of straight and curved segments with a fill, a
 * stroke or both. In the page viewport (points, origin top left). Only in a job that reads colour.
 */
export interface PdfContentShape {
  kind: 'rect' | 'path';
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** Fill colour as 0xRRGGBB; absent when the path is not filled. */
  fill?: number;
  /** Stroke colour as 0xRRGGBB and line width in points; absent when the path is not stroked (a stroked rectangle is four rules). */
  stroke?: number;
  strokeWidth?: number;
  /** Opacity of the fill below one. */
  alpha?: number;
  /** Segments of a `path` as pdf.js encodes them (a move, line, cubic curve, quadratic curve or close code, then its coordinates), in the viewport. */
  path?: number[];
  /** The place in the paint order of the page, shared with its rules and images. */
  z: number;
}

export interface PdfPageContent {
  pageNumber: number;
  width: number;
  height: number;
  items: PdfContentItem[];
  rules: PdfContentRule[];
  images: PdfContentImage[];
  /** In a job that reads colour: the painted shapes of the page in paint order. */
  shapes?: PdfContentShape[];
  /**
   * Glyphs left out of the items because no Unicode value was found for them: no ToUnicode map, no name in the font's
   * encoding that the Adobe Glyph List maps and, for a symbol font, no entry in its table.
   */
  unmappedGlyphs: number;
  /** Of `unmappedGlyphs`, the glyphs of Type 3 fonts: programs that draw what they please, so the lines of a figure are among them (entry 227). */
  unmappedType3Glyphs?: number;
  /** The operator list was not read (too many items or operators): no rules, images or font names for the page. */
  operatorsSkipped: boolean;
  /** Rules beyond the per-page cap were dropped. */
  rulesTruncated: boolean;
}

export interface PdfTextJobResult {
  analyses: PdfPageAnalysis[];
  geometry: Map<number, OcrResult>;
  /** Positioned content of the requested pages, in page order. */
  content: PdfPageContent[];
  /** The document's fonts; items refer to them by index. */
  fonts: PdfContentFont[];
}
