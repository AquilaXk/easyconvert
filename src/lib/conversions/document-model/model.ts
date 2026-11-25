import { ConversionFailedError } from '../../types';

export type ListKind = 'bullet' | 'decimal' | 'lowerLetter' | 'upperLetter' | 'lowerRoman' | 'upperRoman';

/** How a counter is punctuated: "1." (dot), "1)" (paren) or "(1)" (both). */
export type MarkerPunctuation = 'dot' | 'paren' | 'both';

/**
 * The structured document every reader produces and every writer consumes: sections with columns, headings,
 * paragraphs, lists, tables, images, code, quotes, rules and page breaks, with inline weight, style, links, pictures,
 * note references and anchors, plus footnotes and endnotes. The PDF layout analysis fills it from page geometry; the
 * DOCX, EPUB, HTML, Markdown, text and HWP readers fill it from structure the source states. It carries no
 * coordinates; the layout stays in the page analysis.
 */

/** A document part that is not the format it claims to be, or whose structure cannot be read. HTTP 400. */
export class DocumentFormatError extends ConversionFailedError {
  readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = 'DocumentFormatError';
  }
}

/** Deepest heading level (HTML h6, WordprocessingML Heading6). */
export const MAX_HEADING_LEVEL = 6;
/** Levels a list nests to (ECMA-376 17.9.6 allows nine). */
export const MAX_LIST_LEVELS = 9;

/** A picture placed in a paragraph; `imageId` keys DocumentModel.images. */
export interface InlineImage {
  imageId: number;
  /** Displayed size in points, when the source states one. */
  widthPt?: number;
  heightPt?: number;
  alt: string;
}

/** A reference to a footnote or endnote definition of the model. */
export interface NoteReference {
  kind: 'footnote' | 'endnote';
  id: number;
  /** The number or mark the document shows at the reference. */
  label: string;
}

/**
 * A stretch of text with one style, or one inline object: a run with `image`, `note` or `anchor` set has empty text.
 * A line break inside a paragraph is the text "\n"; a tab is "\t".
 */
export interface Inline {
  text: string;
  bold: boolean;
  italic: boolean;
  monospace: boolean;
  underline?: boolean;
  strike?: boolean;
  superscript?: boolean;
  subscript?: boolean;
  /** An http, https, mailto or ftp URL, or `#name` for an anchor of the same document. */
  href?: string;
  /** Text size in points when it differs from the body text. */
  sizePt?: number;
  /** RGB colour as six hex digits. */
  color?: string;
  /** Background of the run as six hex digits (white text on a coloured badge). */
  shading?: string;
  /** Horizontal scale of the glyphs in percent (a PDF page set in a face narrower or wider than the one the document is written in). */
  widthPercent?: number;
  image?: InlineImage;
  note?: NoteReference;
  /** A named position other parts of the document link to. */
  anchor?: string;
}

/**
 * A shape a PDF page paints under its text, hung on a paragraph: a filled rectangle or an outline of lines and curves. Its box is
 * in points, `x` from the left edge of the page and `y` from the top of the paragraph it hangs on (negative above it), so the shape
 * keeps its place against that paragraph's text however the document flows; with `pageRelative`, `y` is from the top of the page.
 */
export interface PageGradientStop {
  pos: number;
  color: string;
  alpha?: number;
}

export interface PageLinearGradient {
  kind: 'linear';
  angleDeg: number;
  stops: PageGradientStop[];
}

export interface PageShape {
  kind: 'rect' | 'path';
  x: number;
  y: number;
  width: number;
  height: number;
  /** Fill and stroke colour as six hex digits. */
  fill?: string;
  /** Linear gradient fill as hex stops. */
  gradient?: PageLinearGradient;
  stroke?: string;
  strokeWidthPt?: number;
  /** Fill opacity below one. */
  alpha?: number;
  /** Stroke opacity below one. */
  strokeAlpha?: number;
  /** Whether the outline is drawn dashed. */
  dashed?: boolean;
  /** The segments of a `path`, as pdf.js encodes them, relative to the corner of the box. */
  path?: number[];
  /** `y` counts from the top of the page and not from the paragraph. */
  pageRelative?: true;
}

/**
 * How a PDF page sets a paragraph, for a writer that keeps the page's spacing (a document read with `pages`). Lengths are in points;
 * the paragraph's lines have an exact height, and `beforePt` is the gap above the first line's box from the box of what stands above it.
 */
export interface ParagraphFormat {
  beforePt: number;
  lineHeightPt: number;
  /** Indent of the paragraph from the left margin. */
  leftPt: number;
  /** Indent of the first line against `leftPt`; negative hangs it. */
  firstLinePt: number;
  /** Indent from the right margin, which makes the lines wrap where the page's did. */
  rightPt: number;
  align?: 'left' | 'center' | 'right' | 'justify';
  /**
   * The paragraph stood beside text that the flow has already passed (the pieces of a brace, a line set in a margin): it is set as a
   * frame at this place on the page, and takes no height from the flow. `xPt` and `yPt` are from the page's top left corner.
   */
  frame?: { xPt: number; yPt: number; widthPt: number };
  /** The paragraph is the first of a column of its page, so a writer starts a new column before it. */
  columnBreakBefore?: true;
}

export interface ParagraphBlock {
  type: 'paragraph';
  runs: Inline[];
  rtl: boolean;
  align: 'left' | 'center' | 'right' | 'justify';
  /** Em size in points of the paragraph's text, when it differs from the body size. */
  size?: number;
  /** Background of the paragraph as six hex digits (a PDF paints text on a filled area). */
  shading?: string;
  /** Shapes of the page that hang on this paragraph (see `PageShape`). */
  shapes?: PageShape[];
  /** Height in points the paragraph holds open for the shapes that hang on it, when it has no text. */
  spacerPt?: number;
  format?: ParagraphFormat;
}

export interface HeadingBlock {
  type: 'heading';
  /** 1 to 6; the PDF layout analysis finds 1 to 4. */
  level: number;
  runs: Inline[];
  rtl: boolean;
  /** The number the document shows before the heading text ("2.1"), when it is generated rather than typed. */
  label?: string;
  /** Background of the heading as six hex digits. */
  shading?: string;
  /** Shapes of the page that hang on this heading (see `PageShape`). */
  shapes?: PageShape[];
  format?: ParagraphFormat;
}

export interface ListLevelFormat {
  kind: ListKind;
  punctuation: MarkerPunctuation;
  /** The bullet character of a bullet level. */
  glyph: string;
  /** The ECMA-376 number format name (ganada, decimalZero, ...) when the source's format is richer than `kind`. */
  format?: string;
}

export interface ListItem {
  runs: Inline[];
  /** 0 for the outermost level. */
  level: number;
  rtl: boolean;
  /** The counter the item showed in the source (kept so a numbered list restarts where it did). */
  value: number;
  /** The marker as the source renders it ("1.1.", "III)", "•") when that differs from the one `levels` gives. */
  marker?: string;
  format?: ParagraphFormat;
}

export interface ListBlock {
  type: 'list';
  /** Distinct per list; numbering.xml gives each list its own numbering instance. */
  id: number;
  /** Format of each level that the list uses, indexed by level. */
  levels: ListLevelFormat[];
  items: ListItem[];
}

export interface TableCellBlock {
  /** The cell's paragraphs, when it holds nothing but paragraphs (the PDF layout analysis produces these). */
  paragraphs: ParagraphBlock[];
  /** The cell's content in order, when it holds more than paragraphs (lists, tables, quotes); then `paragraphs` is empty. */
  blocks?: Block[];
  colSpan: number;
  /** Rows this cell covers, counting its own; only set on the cell that starts the merge. */
  rowSpan: number;
  /** The slot is covered by the cell above (vMerge continue). */
  continuation: boolean;
  header: boolean;
  /** Background as six hex digits. */
  shading?: string;
}

export interface TableBlock {
  type: 'table';
  rows: TableCellBlock[][];
  /** Column widths in points. */
  columnWidths: number[];
  /** The source drew lines around the cells (a ruled table); an aligned table without lines has none. */
  bordered: boolean;
  /** Colour of the lines of a ruled table as six hex digits and their width in points, when the source states them (black, half a point otherwise). */
  border?: { color: string; widthPt: number };
  /** Gap in points above the table from what stands above it (a document read with `pages`). */
  beforePt?: number;
  /** Indent of the table's left edge from the left margin, in points (a document read with `pages`). */
  indentPt?: number;
  /** The least height of each row in points, as the page drew them (a document read with `pages`). */
  rowHeights?: number[];
}

export interface ImageBlock {
  type: 'image';
  /** Key into DocumentModel.images. */
  imageId: number;
  widthPt: number;
  heightPt: number;
  alt?: string;
  /** Where the page set the picture, in points from its top left corner (a document read with `pages`): it is set there and takes no room from the text. */
  position?: { x: number; y: number };
}

/** Preformatted text, lines separated by "\n". */
export interface CodeBlock {
  type: 'code';
  text: string;
}

export interface QuoteBlock {
  type: 'quote';
  blocks: Block[];
}

export interface RuleBlock {
  type: 'rule';
}

export interface PageBreakBlock {
  type: 'pageBreak';
}

export type Block = ParagraphBlock | HeadingBlock | ListBlock | TableBlock | ImageBlock | CodeBlock | QuoteBlock | RuleBlock | PageBreakBlock;

/** How a section starts relative to the one before it (ECMA-376 17.6.22). */
export type SectionBreakType = 'nextPage' | 'continuous' | 'evenPage' | 'oddPage' | 'nextColumn';

export interface Section {
  /** 1 for single-column text. */
  columns: number;
  blocks: Block[];
  /** How this section starts; absent means continuous, which is how the PDF layout analysis splits a page. */
  breakType?: SectionBreakType;
  /** The page of this section shows no running header or footer although the document has them (a first page without a letterhead). */
  omitsHeader?: true;
  omitsFooter?: true;
  /** Top margin of the page this section starts, in points, where it differs from the document's (a page that starts higher than the others). */
  marginTopPt?: number;
}

export type ImageFormat = 'jpeg' | 'png' | 'gif' | 'bmp' | 'tiff' | 'svg';

export interface DocumentImage {
  id: number;
  /** `jpeg` bytes are the source's own stream; PDF `png` is a re-encoding of decoded pixels. The other formats are source files as stored. */
  format: ImageFormat;
  data: Uint8Array;
  /** Pixel size, when the source or the file header states it. */
  pixelWidth?: number;
  pixelHeight?: number;
}

export interface DocumentMargins {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface NoteDefinition {
  id: number;
  /** The number or mark the document shows. */
  label: string;
  blocks: Block[];
}

export interface DocumentModel {
  sections: Section[];
  images: DocumentImage[];
  pageWidthPt: number;
  pageHeightPt: number;
  margins: DocumentMargins;
  /** Body text size in points. */
  bodySize: number;
  /** Generic family of the body font. */
  bodyFont: 'serif' | 'sans' | 'monospace';
  /** Mean size in points of the headings of each level, index 0 for level 1; absent levels are not used. */
  headingSizes: (number | undefined)[];
  pageCount: number;
  /** The blocks keep the spacing, indents and page starts of the PDF pages they were read from (`ParagraphFormat`), so a writer sets no spacing of its own. */
  pageFlow?: true;
  /** The source states its page size and margins (a DOCX does, Markdown does not), so a writer that draws pages uses them. */
  pageStated?: boolean;
  /** Running header lines repeated at the top of the pages (as on the first page that has them). */
  pageHeader?: Inline[][];
  /** Distance in points from the top edge of the page to the running header, and from the bottom edge to the running footer (default one half inch), when the source places them. */
  headerDistancePt?: number;
  footerDistancePt?: number;
  /** Running footer lines repeated at the bottom of the pages (as on the first page that has them). */
  pageFooter?: Inline[][];
  footnotes?: NoteDefinition[];
  endnotes?: NoteDefinition[];
  title?: string;
  author?: string;
  /** The picture that is the book's cover (an ebook source states one); an EPUB writer marks it as the cover image. */
  coverImageId?: number;
  /** BCP 47 language tag of the content, when the source states one. */
  language?: string;
  /** Things the reader could not carry (unsupported image formats, shapes), for the caller to report. */
  warnings?: string[];
}
