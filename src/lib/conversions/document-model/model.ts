export type ListKind = 'bullet' | 'decimal' | 'lowerLetter' | 'upperLetter' | 'lowerRoman' | 'upperRoman';

/** How a counter is punctuated: "1." (dot), "1)" (paren) or "(1)" (both). */
export type MarkerPunctuation = 'dot' | 'paren' | 'both';

/**
 * The structured document the PDF layout analysis produces and the DOCX, HTML, Markdown and text writers consume:
 * sections with columns, headings, paragraphs, lists, tables and images, with inline weight and style. It carries no
 * coordinates; the layout stays in the page analysis.
 */

export interface Inline {
  text: string;
  bold: boolean;
  italic: boolean;
  monospace: boolean;
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
  /** 1 to 4. */
  level: number;
  runs: Inline[];
  rtl: boolean;
}

export interface ListLevelFormat {
  kind: ListKind;
  punctuation: MarkerPunctuation;
  /** The bullet character of a bullet level. */
  glyph: string;
}

export interface ListItem {
  runs: Inline[];
  /** 0 for the outermost level. */
  level: number;
  rtl: boolean;
  /** The counter the item showed in the PDF (kept so a numbered list restarts where it did). */
  value: number;
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
  paragraphs: ParagraphBlock[];
  colSpan: number;
  /** Rows this cell covers, counting its own; only set on the cell that starts the merge. */
  rowSpan: number;
  /** The slot is covered by the cell above (vMerge continue). */
  continuation: boolean;
  header: boolean;
}

export interface TableBlock {
  type: 'table';
  rows: TableCellBlock[][];
  /** Column widths in points. */
  columnWidths: number[];
  /** The PDF drew lines around the cells (a ruled table); an aligned table without lines has none. */
  bordered: boolean;
}

export interface ImageBlock {
  type: 'image';
  /** Key into DocumentModel.images. */
  imageId: number;
  widthPt: number;
  heightPt: number;
}

export type Block = ParagraphBlock | HeadingBlock | ListBlock | TableBlock | ImageBlock;

export interface Section {
  /** 1 for single-column text. */
  columns: number;
  blocks: Block[];
}

export interface DocumentImage {
  id: number;
  /** `jpeg` bytes are the PDF's own stream; `png` is a re-encoding of decoded pixels. */
  format: 'jpeg' | 'png';
  data: Uint8Array;
  pixelWidth: number;
  pixelHeight: number;
}

export interface DocumentMargins {
  top: number;
  right: number;
  bottom: number;
  left: number;
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
}
