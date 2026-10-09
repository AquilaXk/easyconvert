import { ConversionFailedError } from '../types';

/**
 * The block model the structured document readers produce and the structured writers (HTML, Markdown, EPUB, DOCX,
 * ODT, PDF blocks) consume. It keeps what a reader can know about a document's structure: heading levels, list
 * items with their level and rendered marker, tables with merged cells, images with their original bytes, links,
 * footnotes and endnotes, and page and section breaks. Layout (fonts, margins, positions) is not part of it.
 */

/** A document part that is not the format it claims to be, or whose structure cannot be read. HTTP 400. */
export class DocumentFormatError extends ConversionFailedError {
  readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = 'DocumentFormatError';
  }
}

export const MAX_HEADING_LEVEL = 6;
/** Levels a list nests to (ECMA-376 17.9.6 allows nine). */
export const MAX_LIST_LEVELS = 9;

export type DocImageMime = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/bmp' | 'image/tiff' | 'image/svg+xml';

export interface DocImage {
  /** The image file exactly as stored in the source. */
  readonly data: Buffer;
  readonly mime: DocImageMime;
  readonly alt: string;
  /** Displayed size in points, when the source states one. */
  readonly widthPt?: number;
  readonly heightPt?: number;
}

export interface DocTextInline {
  readonly kind: 'text';
  readonly text: string;
  readonly bold?: boolean;
  readonly italic?: boolean;
  readonly underline?: boolean;
  readonly strike?: boolean;
  readonly code?: boolean;
  readonly superscript?: boolean;
  readonly subscript?: boolean;
  /** An http, https or mailto URL, or `#name` for a bookmark in the same document. */
  readonly href?: string;
  /** Text size in points when it differs from the style's. */
  readonly sizePt?: number;
  /** RGB colour as six hex digits. */
  readonly color?: string;
}

export type DocInline =
  | DocTextInline
  | { readonly kind: 'image'; readonly image: DocImage }
  | { readonly kind: 'break' }
  | { readonly kind: 'noteRef'; readonly noteKind: 'footnote' | 'endnote'; readonly id: number; readonly label: string }
  | { readonly kind: 'anchor'; readonly name: string };

export type DocAlign = 'left' | 'center' | 'right' | 'justify';

export interface DocTableCell {
  readonly blocks: DocBlock[];
  readonly colSpan: number;
  readonly rowSpan: number;
  readonly header: boolean;
  /** Background as six hex digits. */
  readonly shading?: string;
}

export interface DocTableRow {
  readonly cells: DocTableCell[];
  readonly header: boolean;
}

export type DocBlock =
  | { readonly kind: 'heading'; readonly level: number; readonly inlines: DocInline[]; readonly label?: string; readonly id?: string }
  | { readonly kind: 'paragraph'; readonly inlines: DocInline[]; readonly align?: DocAlign }
  | {
      readonly kind: 'listItem';
      /** Zero-based nesting level. */
      readonly level: number;
      readonly ordered: boolean;
      /** The marker as the document renders it ("1.", "a)", "•"). */
      readonly marker: string;
      /** Counter value of an ordered item at its level. */
      readonly number: number;
      /** Numbering format (ECMA-376 ST_NumberFormat name, for example `decimal` or `lowerLetter`). */
      readonly format: string;
      /** Identifier of the list the item belongs to; a new value starts a new list. */
      readonly listId: number;
      readonly inlines: DocInline[];
    }
  | { readonly kind: 'table'; readonly rows: DocTableRow[]; readonly columnCount: number }
  | { readonly kind: 'code'; readonly text: string }
  | { readonly kind: 'quote'; readonly blocks: DocBlock[] }
  | { readonly kind: 'rule' }
  | { readonly kind: 'pageBreak' }
  | { readonly kind: 'sectionBreak'; readonly sectionType: 'nextPage' | 'continuous' | 'evenPage' | 'oddPage' | 'nextColumn' };

export interface DocNote {
  readonly id: number;
  readonly label: string;
  readonly blocks: DocBlock[];
}

/** Page geometry of a document's first section, in points. */
export interface DocPageSetup {
  readonly widthPt: number;
  readonly heightPt: number;
  readonly marginTopPt: number;
  readonly marginRightPt: number;
  readonly marginBottomPt: number;
  readonly marginLeftPt: number;
}

export interface DocModel {
  page?: DocPageSetup;
  /** Size in points of most of the text; runs of that size carry no `sizePt`. */
  bodySizePt?: number;
  title?: string;
  author?: string;
  /** BCP 47 language tag of the content, when the source states one. */
  language?: string;
  blocks: DocBlock[];
  footnotes: DocNote[];
  endnotes: DocNote[];
  /** Things the reader could not carry (unsupported image formats, shapes), for the caller to report. */
  warnings: string[];
}

export function emptyDocModel(): DocModel {
  return { blocks: [], footnotes: [], endnotes: [], warnings: [] };
}

/** The characters of `inlines` without markup; images and anchors contribute nothing, a break a newline. */
export function inlinesToText(inlines: readonly DocInline[]): string {
  let text = '';
  for (const inline of inlines) {
    if (inline.kind === 'text') text += inline.text;
    else if (inline.kind === 'break') text += '\n';
  }
  return text;
}

/** Visits `blocks` and every block nested in table cells and quotes, in document order. */
export function walkBlocks(blocks: readonly DocBlock[], visit: (block: DocBlock) => void): void {
  for (const block of blocks) {
    visit(block);
    if (block.kind === 'table') {
      for (const row of block.rows) for (const cell of row.cells) walkBlocks(cell.blocks, visit);
    } else if (block.kind === 'quote') {
      walkBlocks(block.blocks, visit);
    }
  }
}

/** Every image of the model's body, notes included, in document order. */
export function collectImages(model: DocModel): DocImage[] {
  const images: DocImage[] = [];
  const visitInlines = (inlines: readonly DocInline[]): void => {
    for (const inline of inlines) if (inline.kind === 'image') images.push(inline.image);
  };
  const visit = (block: DocBlock): void => {
    if (block.kind === 'heading' || block.kind === 'paragraph' || block.kind === 'listItem') visitInlines(block.inlines);
  };
  walkBlocks(model.blocks, visit);
  for (const note of [...model.footnotes, ...model.endnotes]) walkBlocks(note.blocks, visit);
  return images;
}

const IMAGE_SIGNATURES: readonly { mime: DocImageMime; prefix: readonly number[] }[] = [
  { mime: 'image/png', prefix: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { mime: 'image/jpeg', prefix: [0xff, 0xd8, 0xff] },
  { mime: 'image/gif', prefix: [0x47, 0x49, 0x46, 0x38] },
  { mime: 'image/bmp', prefix: [0x42, 0x4d] },
  { mime: 'image/tiff', prefix: [0x49, 0x49, 0x2a, 0x00] },
  { mime: 'image/tiff', prefix: [0x4d, 0x4d, 0x00, 0x2a] },
];
const SVG_SCAN_BYTES = 512;

/** The image type of `data` by its magic bytes, or null when it is none the model carries. */
export function sniffImageMime(data: Buffer): DocImageMime | null {
  for (const { mime, prefix } of IMAGE_SIGNATURES) {
    if (prefix.every((byte, index) => data[index] === byte)) return mime;
  }
  if (data.subarray(0, SVG_SCAN_BYTES).toString('utf8').includes('<svg')) return 'image/svg+xml';
  return null;
}

export const IMAGE_FILE_EXTENSION: Readonly<Record<DocImageMime, string>> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/bmp': 'bmp',
  'image/tiff': 'tif',
  'image/svg+xml': 'svg',
};

const SAFE_LINK_SCHEMES = /^(?:https?|mailto|ftp):/i;

/** A link target a writer may emit: an allowed scheme or an in-document anchor; anything else is not a link. */
export function safeHref(href: string | undefined): string | undefined {
  if (href === undefined) return undefined;
  const trimmed = href.trim();
  if (trimmed === '') return undefined;
  if (trimmed.startsWith('#') || SAFE_LINK_SCHEMES.test(trimmed)) return trimmed;
  return undefined;
}

export function escapeXmlText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function escapeXmlAttribute(text: string): string {
  return escapeXmlText(text).replace(/"/g, '&quot;');
}

/** Characters XML 1.0 forbids (controls other than tab, line feed and carriage return, lone surrogates, U+FFFE/F). */
// eslint-disable-next-line no-control-regex
const XML_FORBIDDEN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g;

export function stripXmlForbidden(text: string): string {
  return text.replace(XML_FORBIDDEN, '');
}

/** What occupies one grid position of a table: the cell that starts there, or the cell that covers it from the left or from above. */
export type TableSlot = { readonly cell: DocTableCell; readonly kind: 'origin' | 'colspan' | 'rowspan' } | null;

/** The grid of `table`: every position holds the cell that starts or extends there, or null where the row has no cell. */
export function tableSlots(table: Extract<DocBlock, { kind: 'table' }>): TableSlot[][] {
  const grid: TableSlot[][] = [];
  // The cell covering each column from an earlier row, with the rows it still covers.
  const covering = new Map<number, { cell: DocTableCell; rows: number }>();
  for (const row of table.rows) {
    const line: TableSlot[] = [];
    let column = 0;
    const skipCovered = (): void => {
      for (let held = covering.get(column); held !== undefined && held.rows > 0; held = covering.get(column)) {
        line[column] = { cell: held.cell, kind: 'rowspan' };
        held.rows -= 1;
        column += 1;
      }
    };
    for (const cell of row.cells) {
      skipCovered();
      for (let offset = 0; offset < cell.colSpan; offset += 1) {
        line[column + offset] = { cell, kind: offset === 0 ? 'origin' : 'colspan' };
        if (cell.rowSpan > 1) covering.set(column + offset, { cell, rows: cell.rowSpan - 1 });
        else covering.delete(column + offset);
      }
      column += cell.colSpan;
    }
    skipCovered();
    while (line.length < table.columnCount) line.push(null);
    grid.push(line);
  }
  return grid;
}

/**
 * The cells of `table` placed on its grid. A merged cell appears once, at its top-left grid position; the positions
 * it covers are null.
 */
export function expandTableGrid(table: Extract<DocBlock, { kind: 'table' }>): (DocTableCell | null)[][] {
  return tableSlots(table).map((row) => row.map((slot) => (slot && slot.kind === 'origin' ? slot.cell : null)));
}

/** Plain text of a block: its inlines, and for containers the text of their blocks joined by line breaks. */
export function blockText(block: DocBlock): string {
  switch (block.kind) {
    case 'heading':
    case 'paragraph':
    case 'listItem':
      return inlinesToText(block.inlines);
    case 'code':
      return block.text;
    case 'quote':
      return block.blocks.map(blockText).filter((text) => text !== '').join('\n');
    case 'table':
      return block.rows.map((row) => row.cells.map((cell) => cell.blocks.map(blockText).join(' ')).join('\t')).join('\n');
    default:
      return '';
  }
}

/**
 * Finds the text size most characters use, stores it as `model.bodySizePt` and removes `sizePt` from runs of that
 * size, so only runs that differ from the body text carry a size.
 */
export function normalizeBodySize(model: DocModel): void {
  const weight = new Map<number, number>();
  const visitInlines = (inlines: readonly DocInline[], apply: (inline: DocTextInline) => void): void => {
    for (const inline of inlines) if (inline.kind === 'text') apply(inline);
  };
  const visit = (apply: (inline: DocTextInline) => void) => (block: DocBlock): void => {
    if (block.kind === 'paragraph' || block.kind === 'listItem') visitInlines(block.inlines, apply);
  };
  const count = (inline: DocTextInline): void => {
    if (inline.sizePt !== undefined) weight.set(inline.sizePt, (weight.get(inline.sizePt) ?? 0) + inline.text.length);
  };
  const allBlocks = [model.blocks, ...model.footnotes.map((note) => note.blocks), ...model.endnotes.map((note) => note.blocks)];
  for (const blocks of allBlocks) walkBlocks(blocks, visit(count));
  let best: number | undefined;
  let bestWeight = 0;
  for (const [size, total] of weight) {
    if (total > bestWeight) {
      best = size;
      bestWeight = total;
    }
  }
  if (best === undefined) return;
  model.bodySizePt = best;
  const strip = (inline: DocTextInline): void => {
    if (inline.sizePt === best) delete (inline as { sizePt?: number }).sizePt;
  };
  for (const blocks of allBlocks) walkBlocks(blocks, visit(strip));
}
