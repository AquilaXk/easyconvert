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
  image?: InlineImage;
  note?: NoteReference;
  /** A named position other parts of the document link to. */
  anchor?: string;
}

export interface ParagraphBlock {
  type: 'paragraph';
  runs: Inline[];
  rtl: boolean;
  align: 'left' | 'center' | 'right' | 'justify';
  /** Em size in points of the paragraph's text, when it differs from the body size. */
  size?: number;
}

export interface HeadingBlock {
  type: 'heading';
  /** 1 to 6; the PDF layout analysis finds 1 to 4. */
  level: number;
  runs: Inline[];
  rtl: boolean;
  /** The number the document shows before the heading text ("2.1"), when it is generated rather than typed. */
  label?: string;
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
}

export interface ImageBlock {
  type: 'image';
  /** Key into DocumentModel.images. */
  imageId: number;
  widthPt: number;
  heightPt: number;
  alt?: string;
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
  /** The source states its page size and margins (a DOCX does, Markdown does not), so a writer that draws pages uses them. */
  pageStated?: boolean;
  /** Running header lines repeated at the top of the pages (as on the first page that has them). */
  pageHeader?: Inline[][];
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
