import crypto from 'node:crypto';
import type {
  Block,
  DocumentImage,
  DocumentMargins,
  DocumentModel,
  ImageFormat,
  Inline,
  ListBlock,
  ListKind,
  ListLevelFormat,
  MarkerPunctuation,
  NoteDefinition,
  ParagraphBlock,
  Section,
  TableBlock,
  TableCellBlock,
} from './model';
import { MAX_HEADING_LEVEL } from './model';
import { sniffImageFormat } from './support';

/**
 * What the readers use to fill a DocumentModel: a sink that appends blocks (grouping consecutive list items into lists
 * and laying out table cells on their grid), a context that numbers lists and registers pictures once, and the page
 * defaults for sources that state no geometry.
 */

/** A4 in points, used when a source states no page geometry (text, Markdown, HTML). */
export const A4_WIDTH_PT = 595.28;
export const A4_HEIGHT_PT = 841.89;
export const DEFAULT_MARGIN_PT = 72;
export const DEFAULT_BODY_PT = 11;
/** Width a table without stated column widths is spread over (the text width of A4 with 72 pt margins). */
export const DEFAULT_TABLE_WIDTH_PT = 450;

export function defaultMargins(): DocumentMargins {
  return { top: DEFAULT_MARGIN_PT, right: DEFAULT_MARGIN_PT, bottom: DEFAULT_MARGIN_PT, left: DEFAULT_MARGIN_PT };
}

/** A document of `sections` with the default page, a sans body font and no notes. */
export function blankDocument(sections: Section[]): DocumentModel {
  return {
    sections,
    images: [],
    pageWidthPt: A4_WIDTH_PT,
    pageHeightPt: A4_HEIGHT_PT,
    margins: defaultMargins(),
    bodySize: DEFAULT_BODY_PT,
    bodyFont: 'sans',
    headingSizes: [],
    pageCount: 1,
  };
}

/** Pixel size read from a picture's header, for the formats whose header states it. */
export function imagePixelSize(data: Uint8Array, format: ImageFormat): { width: number; height: number } | undefined {
  const bytes = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  const PNG_IHDR_OFFSET = 16;
  const GIF_SIZE_OFFSET = 6;
  const BMP_SIZE_OFFSET = 18;
  const JPEG_MARKER_PREFIX = 0xff;
  const JPEG_SEGMENT_HEADER = 4;
  const JPEG_SOF_FIRST = 0xc0;
  const JPEG_SOF_LAST = 0xcf;
  const JPEG_NON_FRAME = new Set([0xc4, 0xc8, 0xcc]);
  if (format === 'png' && bytes.length >= PNG_IHDR_OFFSET + 8) return { width: bytes.readUInt32BE(PNG_IHDR_OFFSET), height: bytes.readUInt32BE(PNG_IHDR_OFFSET + 4) };
  if (format === 'gif' && bytes.length >= GIF_SIZE_OFFSET + 4) return { width: bytes.readUInt16LE(GIF_SIZE_OFFSET), height: bytes.readUInt16LE(GIF_SIZE_OFFSET + 2) };
  if (format === 'bmp' && bytes.length >= BMP_SIZE_OFFSET + 8) return { width: Math.abs(bytes.readInt32LE(BMP_SIZE_OFFSET)), height: Math.abs(bytes.readInt32LE(BMP_SIZE_OFFSET + 4)) };
  if (format === 'jpeg') {
    let offset = 2;
    while (offset + JPEG_SEGMENT_HEADER <= bytes.length) {
      if (bytes[offset] !== JPEG_MARKER_PREFIX) return undefined;
      const marker = bytes[offset + 1];
      const length = bytes.readUInt16BE(offset + 2);
      if (marker >= JPEG_SOF_FIRST && marker <= JPEG_SOF_LAST && !JPEG_NON_FRAME.has(marker) && offset + 9 <= bytes.length) {
        return { height: bytes.readUInt16BE(offset + 5), width: bytes.readUInt16BE(offset + 7) };
      }
      if (length < 2) return undefined;
      offset += 2 + length;
    }
  }
  return undefined;
}

const LIST_KINDS: ReadonlyMap<string, ListKind> = new Map([
  ['decimal', 'decimal'],
  ['lowerLetter', 'lowerLetter'],
  ['upperLetter', 'upperLetter'],
  ['lowerRoman', 'lowerRoman'],
  ['upperRoman', 'upperRoman'],
]);

/**
 * The level format of a list item from the source's number format name and rendered marker: the closest ListKind, the
 * punctuation the marker shows ("(1)", "1)" or "1."), the bullet glyph, and the source's own format name when the kind
 * cannot say it.
 */
export function listFormatOf(ordered: boolean, format: string, marker: string): Pick<ListItemDraft, 'kind' | 'punctuation' | 'glyph'> & { format?: string } {
  if (!ordered) return { kind: 'bullet', punctuation: 'dot', glyph: marker };
  const kind = LIST_KINDS.get(format) ?? 'decimal';
  let punctuation: MarkerPunctuation = 'dot';
  if (marker.startsWith('(') && marker.endsWith(')')) punctuation = 'both';
  else if (marker.endsWith(')')) punctuation = 'paren';
  return { kind, punctuation, glyph: '', ...(LIST_KINDS.has(format) ? {} : { format }) };
}

/** State shared by everything one reader produces for one document: list numbers, pictures and warnings. */
export class DocumentContext {
  readonly images: DocumentImage[] = [];
  readonly warnings: string[] = [];
  private readonly imageIdByHash = new Map<string, number>();
  private listCounter = 0;

  nextListId(): number {
    this.listCounter += 1;
    return this.listCounter;
  }

  /** Registers a picture once per distinct content and returns its id. */
  addImage(data: Buffer, format: ImageFormat = sniffImageFormat(data) ?? 'png'): number {
    const hash = crypto.createHash('sha256').update(data).digest('hex');
    const known = this.imageIdByHash.get(hash);
    if (known !== undefined) return known;
    const id = this.images.length + 1;
    const size = imagePixelSize(data, format);
    this.images.push({ id, format, data, pixelWidth: size?.width, pixelHeight: size?.height });
    this.imageIdByHash.set(hash, id);
    return id;
  }
}

/** A list item as a reader sees it: which source list it belongs to and how its marker is rendered. */
export interface ListItemDraft {
  /** Identifier of the list in the source; consecutive items of one source list join one ListBlock. */
  sourceId: number;
  /** Zero-based nesting level. */
  level: number;
  kind: ListKind;
  punctuation: MarkerPunctuation;
  glyph: string;
  /** The source's number format name when `kind` cannot say it (see ListLevelFormat.format). */
  format?: string;
  /** Counter value of an ordered item at its level. */
  value: number;
  /** The marker as the source renders it, when `kind`, `punctuation` and `glyph` do not give it. */
  marker?: string;
  runs: Inline[];
  rtl?: boolean;
}

export interface TableDraftCell {
  blocks: Block[];
  colSpan: number;
  rowSpan: number;
  header: boolean;
  shading?: string;
}

/** A table as the source states it: each cell once, with the number of columns and rows it spans. */
export interface TableDraft {
  rows: TableDraftCell[][];
  columnCount: number;
  /** Column widths in points, when the source states them. */
  columnWidthsPt?: number[];
  bordered?: boolean;
}

interface OpenList {
  block: ListBlock;
  sources: Set<number>;
}

/** Appends blocks to a list of blocks, grouping list items and laying tables out on their grid. */
export class BlockSink {
  blocks: Block[] = [];
  protected openList: OpenList | undefined;

  constructor(readonly context: DocumentContext) {}

  /** A sink for the content of a cell, quote or note of the same document. */
  nested(): BlockSink {
    return new BlockSink(this.context);
  }

  /** Adds a block. A finished list is dissolved into its items, so they join a list already open when they nest in it. */
  append(block: Block): void {
    if (block.type === 'list') {
      for (const item of block.items) {
        this.listItem({ sourceId: block.id, level: item.level, ...block.levels[item.level], value: item.value, marker: item.marker, runs: item.runs, rtl: item.rtl });
      }
      return;
    }
    this.openList = undefined;
    this.blocks.push(block);
  }

  appendAll(blocks: readonly Block[]): void {
    for (const block of blocks) this.append(block);
  }

  heading(level: number, runs: Inline[], extra: { label?: string; rtl?: boolean } = {}): void {
    const heading: Block = { type: 'heading', level: Math.min(Math.max(level, 1), MAX_HEADING_LEVEL), runs, rtl: extra.rtl ?? false };
    if (extra.label !== undefined) heading.label = extra.label;
    this.append(heading);
  }

  paragraph(runs: Inline[], extra: { align?: ParagraphBlock['align']; rtl?: boolean; size?: number } = {}): void {
    const paragraph: ParagraphBlock = { type: 'paragraph', runs, rtl: extra.rtl ?? false, align: extra.align ?? 'left' };
    if (extra.size !== undefined) paragraph.size = extra.size;
    this.append(paragraph);
  }

  code(text: string): void {
    this.append({ type: 'code', text });
  }

  quote(blocks: Block[]): void {
    this.append({ type: 'quote', blocks });
  }

  rule(): void {
    this.append({ type: 'rule' });
  }

  pageBreak(): void {
    this.append({ type: 'pageBreak' });
  }

  /**
   * Adds a list item. It joins the open list when it belongs to a source list the open list already holds, or nests
   * one level deeper than the last item; any other item starts a new list.
   */
  listItem(draft: ListItemDraft): void {
    const format: ListLevelFormat = { kind: draft.kind, punctuation: draft.punctuation, glyph: draft.glyph, ...(draft.format === undefined ? {} : { format: draft.format }) };
    const open = this.openList;
    const last = open?.block.items[open.block.items.length - 1];
    let target: ListBlock;
    if (open && last && (open.sources.has(draft.sourceId) || draft.level > last.level)) {
      target = open.block;
      open.sources.add(draft.sourceId);
    } else {
      target = { type: 'list', id: this.context.nextListId(), levels: [], items: [] };
      this.blocks.push(target);
      this.openList = { block: target, sources: new Set([draft.sourceId]) };
    }
    // A level the list reaches before an outer one is formatted like the first item that uses it.
    for (let level = 0; level <= draft.level; level += 1) target.levels[level] ??= format;
    target.items.push({ runs: draft.runs, level: draft.level, rtl: draft.rtl ?? false, value: draft.value, ...(draft.marker === undefined ? {} : { marker: draft.marker }) });
  }

  /** Adds a table; cells that continue a vertical merge are laid out as continuation slots. */
  table(draft: TableDraft): void {
    const rows: TableCellBlock[][] = [];
    // The cell covering each column from an earlier row: where it starts, how many columns and how many rows are left.
    const covering = new Map<number, { start: number; colSpan: number; rowsLeft: number }>();
    for (const draftRow of draft.rows) {
      const row: TableCellBlock[] = [];
      let column = 0;
      const skipCovered = (): void => {
        for (let held = covering.get(column); held !== undefined && held.rowsLeft > 0; held = covering.get(column)) {
          if (held.start === column) {
            row.push({ paragraphs: [], colSpan: held.colSpan, rowSpan: 1, continuation: true, header: false });
            held.rowsLeft -= 1;
            column += held.colSpan;
          } else {
            column += 1;
          }
        }
      };
      for (const cell of draftRow) {
        skipCovered();
        row.push(cellOf(cell));
        for (let offset = 0; offset < cell.colSpan; offset += 1) {
          if (cell.rowSpan > 1) covering.set(column + offset, { start: column, colSpan: cell.colSpan, rowsLeft: cell.rowSpan - 1 });
          else covering.delete(column + offset);
        }
        column += cell.colSpan;
      }
      skipCovered();
      rows.push(row);
    }
    const columns = Math.max(draft.columnCount, 1);
    const widths = draft.columnWidthsPt ?? Array.from({ length: columns }, () => DEFAULT_TABLE_WIDTH_PT / columns);
    const table: TableBlock = { type: 'table', rows, columnWidths: widths, bordered: draft.bordered ?? true };
    this.append(table);
  }
}

function cellOf(cell: TableDraftCell): TableCellBlock {
  const result: TableCellBlock = { paragraphs: [], blocks: cell.blocks, colSpan: cell.colSpan, rowSpan: cell.rowSpan, continuation: false, header: cell.header };
  if (cell.shading !== undefined) result.shading = cell.shading;
  return result;
}

/** A sink for the body of a document that can be cut into sections. */
export class BodySink extends BlockSink {
  private readonly finished: Section[] = [];

  /** Closes the section being filled: its blocks so far form a section of `columns` columns. */
  endSection(columns: number): void {
    this.finished.push({ columns, blocks: this.blocks });
    this.blocks = [];
    // A list does not continue across a section break.
    this.openList = undefined;
  }

  /** The sections: those closed, then the one being filled with `columns` columns. */
  sections(columns: number): Section[] {
    return [...this.finished, { columns, blocks: this.blocks }];
  }
}

export interface DocumentParts {
  sections: Section[];
  context: DocumentContext;
  pageWidthPt?: number;
  pageHeightPt?: number;
  margins?: DocumentMargins;
  bodySize?: number;
  footnotes?: NoteDefinition[];
  endnotes?: NoteDefinition[];
  title?: string;
  author?: string;
  language?: string;
}

/** Assembles the model from what a reader gathered; geometry and sizes the source did not state take the defaults. */
export function assembleDocument(parts: DocumentParts): DocumentModel {
  const model = blankDocument(parts.sections);
  model.images = parts.context.images;
  if (parts.pageWidthPt !== undefined && parts.pageHeightPt !== undefined) {
    model.pageWidthPt = parts.pageWidthPt;
    model.pageHeightPt = parts.pageHeightPt;
    model.pageStated = true;
  }
  if (parts.margins !== undefined) model.margins = parts.margins;
  if (parts.bodySize !== undefined) model.bodySize = parts.bodySize;
  if (parts.footnotes !== undefined && parts.footnotes.length > 0) model.footnotes = parts.footnotes;
  if (parts.endnotes !== undefined && parts.endnotes.length > 0) model.endnotes = parts.endnotes;
  if (parts.title !== undefined) model.title = parts.title;
  if (parts.author !== undefined) model.author = parts.author;
  if (parts.language !== undefined) model.language = parts.language;
  if (parts.context.warnings.length > 0) model.warnings = parts.context.warnings;
  return model;
}
