import { CorruptStreamError, PayloadLimitError } from '../types';
import { formatListNumber } from './docx-numbering';
import {
  emptyDocModel,
  safeHref,
  sniffImageMime,
  type DocAlign,
  type DocBlock,
  type DocInline,
  type DocModel,
  type DocTableCell,
  type DocTableRow,
  type DocTextInline,
} from './document-model';
import { HWP_FIELD_BEGIN, HWP_FIELD_END, HWP_TAGS, HWP_UTF16_UNIT_BYTES, decodeHwpParagraph, type HwpParagraphText, type HwpRecord, type HwpTextControl } from './hwp-records';

/**
 * Reads the records of an HWP 5.0 document (Hancom "Hangul Document File Format 5.0") into the shared block model.
 *
 * DocInfo supplies the character shapes (bold, italic, underline, size, colour), paragraph shapes (alignment, outline
 * level, numbering or bullet), styles, numbering and bullet definitions, and the BinData entries. The section streams
 * are walked by record level: a paragraph's PARA_HEADER owns the records below it; its extended control characters
 * pair, in order, with the CTRL_HEADER records that follow its text; a table (`tbl `) lists its cells as LIST_HEADER
 * records each followed by the cell's paragraphs at the same level; a drawing object (`gso `) holds a picture, or a
 * LIST_HEADER with the paragraphs of its text box; footnotes and endnotes hold paragraph lists; headers and footers
 * are not body content. Output keeps document order.
 */

/** Deepest nesting of paragraph lists (cells inside text boxes inside cells ...) read. */
export const HWP_MAX_LIST_DEPTH = 32;
/** Most records one document may hold. */
export const HWP_MAX_RECORDS = 4_000_000;
/** Most cells one table may declare. */
export const HWP_MAX_TABLE_CELLS = 250_000;
/** Most pictures and bytes of pictures one document may carry. */
export const HWP_MAX_IMAGES = 2_000;
export const HWP_MAX_IMAGE_BYTES = 256 * 1024 * 1024;
/** Most footnotes and endnotes one document may carry. */
export const HWP_MAX_NOTES = 100_000;

const HWP_UNITS_PER_POINT = 100;
const CONTROL_ID_BYTES = 4;
const PARA_HEADER_MIN_BYTES = 12;
const PARA_SHAPE_ID_OFFSET = 8;
const PARA_STYLE_ID_OFFSET = 10;
const PARA_BREAK_OFFSET = 11;
const PARA_BREAK_PAGE = 0x04;
const CHAR_SHAPE_MIN_BYTES = 56;
const CHAR_SHAPE_HEIGHT_OFFSET = 42;
const CHAR_SHAPE_ATTR_OFFSET = 46;
const CHAR_SHAPE_COLOR_OFFSET = 52;
const PARA_SHAPE_MIN_BYTES = 32;
const PARA_SHAPE_NUMBERING_OFFSET = 30;
const HEAD_NONE = 0;
const HEAD_OUTLINE = 1;
const HEAD_NUMBER = 2;
const HEAD_BULLET = 3;
const NUMBERING_LEVELS = 7;
const NUMBERING_HEAD_BYTES = 12;
const NUMBERING_SHAPE_SHIFT = 5;
const NUMBERING_SHAPE_MASK = 0x1f;
const BULLET_CHAR_OFFSET = 12;
const CELL_COLUMN_OFFSET = 8;
const CELL_ROW_OFFSET = 10;
const CELL_COLUMN_SPAN_OFFSET = 12;
const CELL_ROW_SPAN_OFFSET = 14;
const CELL_MIN_BYTES = 16;
const TABLE_ROWS_OFFSET = 4;
const TABLE_COLUMNS_OFFSET = 6;
const TABLE_MIN_BYTES = 8;
/** Table attribute bit: the first row repeats at the top of every page, which marks it as the header row. */
const TABLE_REPEAT_HEADER = 0x4;
const PICTURE_BIN_ITEM_OFFSET = 71;
const OBJECT_WIDTH_OFFSET = 16;
const OBJECT_HEIGHT_OFFSET = 20;
const OBJECT_MIN_BYTES = 24;
const FIELD_COMMAND_LENGTH_OFFSET = 9;
const FIELD_COMMAND_OFFSET = 11;
const BIN_DATA_EMBEDDED = 1;
const MAX_HEADING_LEVEL = 6;
const OUTLINE_STYLE = /^Outline (\d)$/;
const BULLET_FALLBACK = '•';
/** Private-use bullets the word processor writes, mapped to Unicode. */
const PRIVATE_USE_BULLETS: ReadonlyMap<string, string> = new Map([
  ['', '▪'],
  ['', '•'],
  ['', '➢'],
  ['', '✓'],
]);

/** Control ids (four characters, as they read in the format document). */
const CONTROL_TABLE = 'tbl ';
const CONTROL_DRAWING = 'gso ';
const CONTROL_EQUATION = 'eqed';
const CONTROL_FOOTNOTE = 'fn  ';
const CONTROL_ENDNOTE = 'en  ';
const CONTROL_HYPERLINK = '%hlk';

interface HwpCharShape {
  sizePt: number;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  superscript: boolean;
  subscript: boolean;
  color?: string;
}

interface HwpParaShape {
  align: DocAlign | undefined;
  headType: number;
  /** Zero-based outline or numbering level. */
  level: number;
  numberingId: number;
}

interface HwpNumberingLevel {
  format: string;
  shape: number;
  start: number;
}

interface HwpBinEntry {
  streamName: string;
  compress: boolean | undefined;
}

export interface HwpDocInfo {
  charShapes: HwpCharShape[];
  paraShapes: HwpParaShape[];
  /** English style names in file order ("Outline 1" ...). */
  styleNames: string[];
  /** Numbering definitions in file order, each with its seven levels. */
  numberings: HwpNumberingLevel[][];
  bullets: string[];
  binData: HwpBinEntry[];
}

/** Supplies the bytes of an embedded picture stream by its name (`BinData/BIN0001.png`), already inflated when the entry is compressed. */
export type HwpBinLoader = (streamName: string, compress: boolean | undefined) => Buffer | undefined;

function corrupt(detail: string): CorruptStreamError {
  return new CorruptStreamError(`Invalid HWP document: ${detail}`);
}

function alignOf(value: number): DocAlign | undefined {
  switch (value) {
    case 0:
      return 'justify';
    case 2:
      return 'right';
    case 3:
      return 'center';
    default:
      return undefined;
  }
}

function colorOf(colorref: number): string | undefined {
  const red = colorref & 0xff;
  const green = (colorref >> 8) & 0xff;
  const blue = (colorref >> 16) & 0xff;
  if (red === 0 && green === 0 && blue === 0) return undefined;
  return [red, green, blue].map((channel) => channel.toString(16).padStart(2, '0')).join('').toUpperCase();
}

function utf16String(payload: Buffer, offset: number, length: number): string | undefined {
  const end = offset + length * HWP_UTF16_UNIT_BYTES;
  return end <= payload.length ? payload.toString('utf16le', offset, end) : undefined;
}

/** Reads the DocInfo records that give the formatting of paragraphs and characters. */
export function readHwpDocInfo(records: readonly HwpRecord[]): HwpDocInfo {
  const info: HwpDocInfo = { charShapes: [], paraShapes: [], styleNames: [], numberings: [], bullets: [], binData: [] };
  for (const record of records) {
    const { payload } = record;
    switch (record.tagId) {
      case HWP_TAGS.CHAR_SHAPE: {
        if (payload.length < CHAR_SHAPE_MIN_BYTES) throw corrupt('a character shape record is shorter than its fixed fields.');
        const attributes = payload.readUInt32LE(CHAR_SHAPE_ATTR_OFFSET);
        info.charShapes.push({
          sizePt: payload.readInt32LE(CHAR_SHAPE_HEIGHT_OFFSET) / HWP_UNITS_PER_POINT,
          italic: (attributes & 0x1) !== 0,
          bold: (attributes & 0x2) !== 0,
          underline: ((attributes >> 2) & 0x3) === 1,
          superscript: (attributes & (1 << 15)) !== 0,
          subscript: (attributes & (1 << 16)) !== 0,
          strike: ((attributes >> 18) & 0x7) !== 0,
          color: colorOf(payload.readUInt32LE(CHAR_SHAPE_COLOR_OFFSET)),
        });
        break;
      }
      case HWP_TAGS.PARA_SHAPE: {
        if (payload.length < PARA_SHAPE_MIN_BYTES) throw corrupt('a paragraph shape record is shorter than its fixed fields.');
        const attributes = payload.readUInt32LE(0);
        info.paraShapes.push({
          align: alignOf((attributes >> 2) & 0x7),
          headType: (attributes >> 23) & 0x3,
          level: (attributes >> 25) & 0x7,
          numberingId: payload.readUInt16LE(PARA_SHAPE_NUMBERING_OFFSET),
        });
        break;
      }
      case HWP_TAGS.STYLE: {
        const nameLength = payload.length >= 2 ? payload.readUInt16LE(0) : 0;
        const englishAt = 2 + nameLength * HWP_UTF16_UNIT_BYTES;
        const englishLength = payload.length >= englishAt + 2 ? payload.readUInt16LE(englishAt) : 0;
        info.styleNames.push(utf16String(payload, englishAt + 2, englishLength) ?? '');
        break;
      }
      case HWP_TAGS.NUMBERING: {
        const levels: HwpNumberingLevel[] = [];
        let offset = 0;
        for (let level = 0; level < NUMBERING_LEVELS; level += 1) {
          if (offset + NUMBERING_HEAD_BYTES + 2 > payload.length) throw corrupt('a numbering record is cut off inside its level formats.');
          const attributes = payload.readUInt32LE(offset);
          const length = payload.readUInt16LE(offset + NUMBERING_HEAD_BYTES);
          const format = utf16String(payload, offset + NUMBERING_HEAD_BYTES + 2, length);
          if (format === undefined) throw corrupt('a numbering record is cut off inside a level format.');
          levels.push({ format, shape: (attributes >> NUMBERING_SHAPE_SHIFT) & NUMBERING_SHAPE_MASK, start: 1 });
          offset += NUMBERING_HEAD_BYTES + 2 + length * HWP_UTF16_UNIT_BYTES;
        }
        // The start number of the first level, then (from 5.0.2.5) one start number per level.
        const perLevel = offset + 2 + NUMBERING_LEVELS * 4;
        if (payload.length >= perLevel) {
          for (let level = 0; level < NUMBERING_LEVELS; level += 1) levels[level].start = payload.readUInt32LE(offset + 2 + level * 4) || 1;
        } else if (payload.length >= offset + 2) {
          levels[0].start = payload.readUInt16LE(offset) || 1;
        }
        info.numberings.push(levels);
        break;
      }
      case HWP_TAGS.BULLET: {
        const bullet = payload.length >= BULLET_CHAR_OFFSET + 2 ? String.fromCharCode(payload.readUInt16LE(BULLET_CHAR_OFFSET)) : BULLET_FALLBACK;
        info.bullets.push(PRIVATE_USE_BULLETS.get(bullet) ?? (/[-]/.test(bullet) ? BULLET_FALLBACK : bullet));
        break;
      }
      case HWP_TAGS.BIN_DATA: {
        if (payload.length < 6) {
          info.binData.push({ streamName: '', compress: undefined });
          break;
        }
        const attributes = payload.readUInt16LE(0);
        if ((attributes & 0xf) !== BIN_DATA_EMBEDDED) {
          info.binData.push({ streamName: '', compress: undefined });
          break;
        }
        const id = payload.readUInt16LE(2);
        const extension = utf16String(payload, 6, payload.readUInt16LE(4)) ?? '';
        const mode = (attributes >> 4) & 0x3;
        let compress: boolean | undefined;
        if (mode === 1) compress = true;
        else if (mode === 2) compress = false;
        info.binData.push({ streamName: `BinData/BIN${id.toString(16).toUpperCase().padStart(4, '0')}.${extension}`, compress });
        break;
      }
      default:
        break;
    }
  }
  return info;
}

function controlIdOf(payload: Buffer): string {
  return payload.length >= CONTROL_ID_BYTES ? String.fromCharCode(payload[3], payload[2], payload[1], payload[0]) : '';
}

function subtreeEnd(records: readonly HwpRecord[], index: number): number {
  const level = records[index].level;
  let end = index + 1;
  while (end < records.length && records[end].level > level) end += 1;
  return end;
}

interface TextRun {
  text: string;
  shapeId: number;
}

/** Stateful reader of the section streams of one document. */
class HwpModelReader {
  readonly model: DocModel = emptyDocModel();
  private recordsSeen = 0;
  private imageCount = 0;
  private imageBytes = 0;
  private noteCount = 0;
  /** Counters of every numbering (by id), per level. */
  private readonly counters = new Map<number, (number | undefined)[]>();
  private readonly pictureCache = new Map<number, Buffer | null>();

  constructor(
    private readonly info: HwpDocInfo,
    private readonly loadBin: HwpBinLoader
  ) {}

  readSection(records: readonly HwpRecord[]): void {
    this.recordsSeen += records.length;
    if (this.recordsSeen > HWP_MAX_RECORDS) throw new PayloadLimitError(`The HWP document holds more than ${HWP_MAX_RECORDS} records.`);
    let index = 0;
    while (index < records.length) {
      const record = records[index];
      if (record.tagId === HWP_TAGS.PARA_HEADER && record.level === 0) {
        index = this.paragraphs(records, index, 0, 'body', 0, this.model.blocks);
      } else {
        index += 1;
      }
    }
  }

  /** Reads the paragraphs at `level` starting at `start` into `out`; returns the index of the first record after them. */
  private paragraphs(records: readonly HwpRecord[], start: number, level: number, kind: Container, depth: number, out: DocBlock[]): number {
    if (depth > HWP_MAX_LIST_DEPTH) throw corrupt(`paragraph lists nest deeper than ${HWP_MAX_LIST_DEPTH} levels.`);
    let index = start;
    while (index < records.length && records[index].tagId === HWP_TAGS.PARA_HEADER && records[index].level === level) {
      const end = subtreeEnd(records, index);
      this.paragraph(records, index, end, kind, depth, out);
      index = end;
    }
    return index;
  }

  private paragraph(records: readonly HwpRecord[], headerIndex: number, end: number, kind: Container, depth: number, out: DocBlock[]): void {
    const header = records[headerIndex];
    const level = header.level;
    if (header.payload.length < PARA_HEADER_MIN_BYTES) throw corrupt('a paragraph header is shorter than its fixed fields.');
    const shapeId = header.payload.readUInt16LE(PARA_SHAPE_ID_OFFSET);
    const styleId = header.payload[PARA_STYLE_ID_OFFSET];
    const breakFlags = header.payload[PARA_BREAK_OFFSET];

    let text: HwpParagraphText = { text: '', controls: [], offsetOfUnit: new Uint32Array(1) };
    let shapeRuns: { position: number; shape: number }[] = [];
    const controls: { index: number; id: string; end: number }[] = [];
    for (let child = headerIndex + 1; child < end; child += 1) {
      const record = records[child];
      if (record.level !== level + 1) continue;
      if (record.tagId === HWP_TAGS.PARA_TEXT) {
        text = decodeHwpParagraph(record.payload);
      } else if (record.tagId === HWP_TAGS.PARA_CHAR_SHAPE) {
        shapeRuns = [];
        for (let at = 0; at + 8 <= record.payload.length; at += 8) shapeRuns.push({ position: record.payload.readUInt32LE(at), shape: record.payload.readUInt32LE(at + 4) });
      } else if (record.tagId === HWP_TAGS.CTRL_HEADER) {
        controls.push({ index: child, id: controlIdOf(record.payload), end: subtreeEnd(records, child) });
      }
    }

    // Extended control characters pair, in order, with the control records below the paragraph.
    const anchors = text.controls.filter((control) => control.extended);
    const placed = new Map<HwpTextControl, { index: number; id: string; end: number }>();
    const used = new Set<number>();
    for (const anchor of anchors) {
      const match = controls.find((control, position) => !used.has(position) && control.id === anchor.id);
      if (match) {
        used.add(controls.indexOf(match));
        placed.set(anchor, match);
      }
    }
    const unplaced = controls.filter((_control, position) => !used.has(position));

    const role = this.roleOf(shapeId, styleId);
    const inlines: DocInline[] = [];
    // Floating objects (text boxes) anchored in the paragraph follow its text.
    const deferred: DocBlock[] = [];
    let roleSpent = false;
    let href: string | undefined;

    const flush = (): void => {
      const trimmed = trimInlines(inlines.splice(0, inlines.length));
      if (trimmed.length === 0) return;
      if (!roleSpent) {
        roleSpent = true;
        out.push(this.blockFor(role, trimmed));
      } else {
        out.push({ kind: 'paragraph', inlines: trimmed });
      }
    };

    if ((breakFlags & PARA_BREAK_PAGE) !== 0 && out.length > 0 && kind === 'body') out.push({ kind: 'pageBreak' });

    const pushText = (from: number, to: number): void => {
      if (to <= from) return;
      for (const run of this.textRuns(text.text, from, to, shapeRuns, text.offsetOfUnit)) {
        inlines.push(this.styled(run.text, run.shapeId, href));
      }
    };

    let cursor = 0;
    for (const control of text.controls) {
      pushText(cursor, control.offset);
      cursor = control.offset;
      if (control.code === HWP_FIELD_BEGIN && control.id === CONTROL_HYPERLINK) {
        const record = placed.get(control);
        href = record ? this.hyperlinkTarget(records[record.index].payload) : undefined;
        continue;
      }
      if (control.code === HWP_FIELD_END) {
        href = undefined;
        continue;
      }
      const record = placed.get(control);
      if (!record) continue;
      this.control(records, record, kind, depth, inlines, flush, out, deferred);
    }
    pushText(cursor, text.text.length);
    for (const record of unplaced) this.control(records, record, kind, depth, inlines, flush, out, deferred);
    flush();
    out.push(...deferred);
  }

  private control(
    records: readonly HwpRecord[],
    control: { index: number; id: string; end: number },
    kind: Container,
    depth: number,
    inlines: DocInline[],
    flush: () => void,
    out: DocBlock[],
    deferred: DocBlock[]
  ): void {
    switch (control.id) {
      case CONTROL_TABLE:
        flush();
        this.table(records, control, depth, out);
        break;
      case CONTROL_DRAWING:
        this.drawing(records, control, kind, depth, inlines, deferred);
        break;
      case CONTROL_EQUATION:
        // Equations are a script language the block model has no element for; they are reported, not drawn.
        this.model.warnings.push('An equation was left out of the converted document.');
        break;
      case CONTROL_FOOTNOTE:
      case CONTROL_ENDNOTE:
        this.note(records, control, depth, inlines);
        break;
      default:
        break;
    }
  }

  private note(records: readonly HwpRecord[], control: { index: number; id: string; end: number }, depth: number, inlines: DocInline[]): void {
    this.noteCount += 1;
    if (this.noteCount > HWP_MAX_NOTES) throw new PayloadLimitError(`The HWP document holds more than ${HWP_MAX_NOTES} notes.`);
    const noteKind = control.id === CONTROL_FOOTNOTE ? 'footnote' : 'endnote';
    const list = noteKind === 'footnote' ? this.model.footnotes : this.model.endnotes;
    const id = list.length + 1;
    const blocks: DocBlock[] = [];
    this.listsOf(records, control, noteKind, depth, blocks);
    list.push({ id, label: String(id), blocks });
    inlines.push({ kind: 'noteRef', noteKind, id, label: String(id) });
  }

  /** Reads every paragraph list (LIST_HEADER and its paragraphs) in the subtree of `control`. */
  private listsOf(records: readonly HwpRecord[], control: { index: number; end: number }, kind: Container, depth: number, out: DocBlock[]): void {
    let index = control.index + 1;
    while (index < control.end) {
      const record = records[index];
      if (record.tagId === HWP_TAGS.LIST_HEADER) {
        index = this.paragraphs(records, index + 1, record.level, kind, depth + 1, out);
      } else {
        index += 1;
      }
    }
  }

  private drawing(
    records: readonly HwpRecord[],
    control: { index: number; end: number },
    kind: Container,
    depth: number,
    inlines: DocInline[],
    deferred: DocBlock[]
  ): void {
    const common = records[control.index].payload;
    let index = control.index + 1;
    while (index < control.end) {
      const record = records[index];
      if (record.tagId === HWP_TAGS.SHAPE_COMPONENT_PICTURE) {
        const picture = this.picture(record.payload, common);
        if (picture) inlines.push(picture);
        index += 1;
      } else if (record.tagId === HWP_TAGS.LIST_HEADER) {
        // A text box: its paragraphs are block content after the paragraph it is anchored in.
        index = this.paragraphs(records, index + 1, record.level, kind === 'cell' ? 'cell' : 'textbox', depth + 1, deferred);
      } else {
        index += 1;
      }
    }
  }

  private picture(payload: Buffer, common: Buffer): DocInline | undefined {
    if (payload.length < PICTURE_BIN_ITEM_OFFSET + 2) throw corrupt('a picture record is shorter than its fixed fields.');
    const item = payload.readUInt16LE(PICTURE_BIN_ITEM_OFFSET);
    const entry = this.info.binData[item - 1];
    if (!entry || entry.streamName === '') {
      this.model.warnings.push(`A picture refers to the missing or linked picture ${item} and was left out.`);
      return undefined;
    }
    let data = this.pictureCache.get(item);
    if (data === undefined) {
      this.imageCount += 1;
      if (this.imageCount > HWP_MAX_IMAGES) throw new PayloadLimitError(`The HWP document embeds more than ${HWP_MAX_IMAGES} pictures.`);
      data = this.loadBin(entry.streamName, entry.compress) ?? null;
      if (data) {
        this.imageBytes += data.length;
        if (this.imageBytes > HWP_MAX_IMAGE_BYTES) throw new PayloadLimitError(`The HWP document embeds more than ${HWP_MAX_IMAGE_BYTES} bytes of pictures.`);
      }
      this.pictureCache.set(item, data);
    }
    const mime = data ? sniffImageMime(data) : null;
    if (!data || mime === null) {
      this.model.warnings.push(`The picture ${entry.streamName} is not a PNG, JPEG, GIF, BMP, TIFF or SVG image and was left out.`);
      return undefined;
    }
    const sized = common.length >= OBJECT_MIN_BYTES;
    return {
      kind: 'image',
      image: {
        data,
        mime,
        alt: '',
        widthPt: sized ? common.readUInt32LE(OBJECT_WIDTH_OFFSET) / HWP_UNITS_PER_POINT : undefined,
        heightPt: sized ? common.readUInt32LE(OBJECT_HEIGHT_OFFSET) / HWP_UNITS_PER_POINT : undefined,
      },
    };
  }

  private table(records: readonly HwpRecord[], control: { index: number; end: number }, depth: number, out: DocBlock[]): void {
    const tableLevel = records[control.index].level + 1;
    let rowCount = 0;
    let columnCount = 0;
    let repeatHeader = false;
    interface PendingCell {
      row: number;
      column: number;
      cell: { blocks: DocBlock[]; colSpan: number; rowSpan: number; header: boolean };
    }
    const cells: PendingCell[] = [];
    const captions: DocBlock[] = [];
    let index = control.index + 1;
    while (index < control.end) {
      const record = records[index];
      if (record.level !== tableLevel) {
        index += 1;
        continue;
      }
      if (record.tagId === HWP_TAGS.TABLE) {
        if (record.payload.length < TABLE_MIN_BYTES) throw corrupt('a table record is shorter than its fixed fields.');
        repeatHeader = (record.payload.readUInt32LE(0) & TABLE_REPEAT_HEADER) !== 0;
        rowCount = record.payload.readUInt16LE(TABLE_ROWS_OFFSET);
        columnCount = record.payload.readUInt16LE(TABLE_COLUMNS_OFFSET);
        if (rowCount * columnCount > HWP_MAX_TABLE_CELLS) {
          throw corrupt(`a table declares ${rowCount} x ${columnCount} cells, more than the limit of ${HWP_MAX_TABLE_CELLS}.`);
        }
        index += 1;
      } else if (record.tagId === HWP_TAGS.LIST_HEADER) {
        if (rowCount === 0) {
          // A list header before the table record is the caption.
          index = this.paragraphs(records, index + 1, record.level, 'caption', depth + 1, captions);
          continue;
        }
        if (record.payload.length < CELL_MIN_BYTES) throw corrupt('a table cell record is shorter than its fixed fields.');
        const column = record.payload.readUInt16LE(CELL_COLUMN_OFFSET);
        const row = record.payload.readUInt16LE(CELL_ROW_OFFSET);
        if (row >= rowCount || column >= columnCount) {
          throw corrupt(`a table cell at row ${row}, column ${column} lies outside its ${rowCount} x ${columnCount} table.`);
        }
        const blocks: DocBlock[] = [];
        index = this.paragraphs(records, index + 1, record.level, 'cell', depth + 1, blocks);
        cells.push({
          row,
          column,
          cell: {
            blocks,
            colSpan: Math.max(1, Math.min(record.payload.readUInt16LE(CELL_COLUMN_SPAN_OFFSET), columnCount - column)),
            rowSpan: Math.max(1, Math.min(record.payload.readUInt16LE(CELL_ROW_SPAN_OFFSET), rowCount - row)),
            header: false,
          },
        });
      } else {
        index += 1;
      }
    }
    out.push(...captions);
    if (rowCount === 0 || columnCount === 0 || cells.length === 0) return;
    const rows: DocTableRow[] = [];
    for (let row = 0; row < rowCount; row += 1) {
      const inRow = cells.filter((entry) => entry.row === row).sort((a, b) => a.column - b.column);
      // Two cells at one address cannot both be drawn; the first stays.
      const seen = new Set<number>();
      const unique = inRow.filter((entry) => !seen.has(entry.column) && seen.add(entry.column));
      const header = repeatHeader && row === 0;
      for (const entry of unique) entry.cell.header = header;
      rows.push({ cells: unique.map((entry) => entry.cell as DocTableCell), header });
    }
    out.push({ kind: 'table', rows, columnCount });
  }

  private hyperlinkTarget(payload: Buffer): string | undefined {
    if (payload.length < FIELD_COMMAND_OFFSET) return undefined;
    const command = utf16String(payload, FIELD_COMMAND_OFFSET, payload.readUInt16LE(FIELD_COMMAND_LENGTH_OFFSET));
    if (command === undefined) return undefined;
    // "target;type;..." with ";" inside the target written as "\;".
    const target = command.replace(/\\;/g, '\u0000').split(';')[0].replace(/\u0000/g, ';');
    return safeHref(target);
  }

  private styled(text: string, shapeId: number, href: string | undefined): DocTextInline {
    const shape = this.info.charShapes[shapeId];
    const inline: { -readonly [K in keyof DocTextInline]: DocTextInline[K] } = { kind: 'text', text };
    if (shape) {
      if (shape.bold) inline.bold = true;
      if (shape.italic) inline.italic = true;
      if (shape.underline && href === undefined) inline.underline = true;
      if (shape.strike) inline.strike = true;
      if (shape.superscript) inline.superscript = true;
      if (shape.subscript) inline.subscript = true;
      if (shape.color && href === undefined) inline.color = shape.color;
    }
    if (href !== undefined) inline.href = href;
    return inline;
  }

  /** Splits `text[from, to)` at the character shape boundaries. */
  private textRuns(text: string, from: number, to: number, shapeRuns: readonly { position: number; shape: number }[], offsetOfUnit: Uint32Array): TextRun[] {
    const starts = shapeRuns.map((run) => ({ offset: offsetOfUnit[Math.min(run.position, offsetOfUnit.length - 1)], shape: run.shape }));
    const runs: TextRun[] = [];
    let at = from;
    while (at < to) {
      let current = -1;
      let next = to;
      for (const start of starts) {
        if (start.offset <= at) current = start.shape;
        else if (start.offset < next) next = start.offset;
      }
      runs.push({ text: text.slice(at, next), shapeId: current });
      at = next;
    }
    return runs;
  }

  private roleOf(shapeId: number, styleId: number): ParagraphRole {
    const shape = this.info.paraShapes[shapeId];
    if (this.info.paraShapes.length > 0 && shape === undefined) throw corrupt(`a paragraph names the missing paragraph shape ${shapeId}.`);
    const style = OUTLINE_STYLE.exec(this.info.styleNames[styleId] ?? '');
    if (style) return { kind: 'heading', level: Math.min(Number(style[1]), MAX_HEADING_LEVEL), align: shape?.align };
    if (!shape || shape.headType === HEAD_NONE) return { kind: 'paragraph', align: shape?.align };
    if (shape.headType === HEAD_OUTLINE) return { kind: 'heading', level: Math.min(shape.level + 1, MAX_HEADING_LEVEL), align: shape.align };
    return { kind: shape.headType === HEAD_NUMBER ? 'number' : 'bullet', shape, align: shape.align };
  }

  private blockFor(role: ParagraphRole, inlines: DocInline[]): DocBlock {
    if (role.kind === 'heading') return { kind: 'heading', level: role.level, inlines };
    if (role.kind === 'number') {
      const marker = this.numberMarker(role.shape);
      if (marker) {
        return { kind: 'listItem', level: role.shape.level, ordered: true, marker: marker.text, number: marker.number, format: marker.format, listId: this.listIdFor(role.shape.numberingId), inlines };
      }
    }
    if (role.kind === 'bullet') {
      const bullet = this.info.bullets[role.shape.numberingId - 1] ?? BULLET_FALLBACK;
      return { kind: 'listItem', level: role.shape.level, ordered: false, marker: bullet, number: 1, format: 'bullet', listId: this.listIdFor(role.shape.numberingId + 1000), inlines };
    }
    return { kind: 'paragraph', inlines, align: role.align };
  }

  private lastListKey = -1;
  private currentListId = 0;

  private listIdFor(key: number): number {
    if (key !== this.lastListKey) {
      this.lastListKey = key;
      this.currentListId += 1;
    }
    return this.currentListId;
  }

  private numberMarker(shape: HwpParaShape): { text: string; number: number; format: string } | undefined {
    const levels = this.info.numberings[shape.numberingId - 1];
    if (!levels) return undefined;
    const level = Math.min(shape.level, NUMBERING_LEVELS - 1);
    let counters = this.counters.get(shape.numberingId);
    if (!counters) {
      counters = new Array<number | undefined>(NUMBERING_LEVELS).fill(undefined);
      this.counters.set(shape.numberingId, counters);
    }
    counters[level] = counters[level] === undefined ? levels[level].start : (counters[level] as number) + 1;
    for (let deeper = level + 1; deeper < NUMBERING_LEVELS; deeper += 1) counters[deeper] = undefined;
    const text = levels[level].format.replace(/\^([1-7])/g, (_match, digit: string) => {
      const referenced = Number(digit) - 1;
      return formatListNumber(counters?.[referenced] ?? levels[referenced].start, numberFormatOf(levels[referenced].shape));
    });
    return { text, number: counters[level] as number, format: numberFormatOf(levels[level].shape) };
  }
}

type Container = 'body' | 'cell' | 'textbox' | 'caption' | 'footnote' | 'endnote';

type ParagraphRole =
  | { kind: 'paragraph'; align: DocAlign | undefined }
  | { kind: 'heading'; level: number; align: DocAlign | undefined }
  | { kind: 'number' | 'bullet'; shape: HwpParaShape; align: DocAlign | undefined };

/** The numbering formats of HWP 5.0 (paragraph head shapes), as ECMA-376 number formats. */
function numberFormatOf(shape: number): string {
  switch (shape) {
    case 1:
      return 'decimalEnclosedCircle';
    case 2:
      return 'upperRoman';
    case 3:
      return 'lowerRoman';
    case 4:
      return 'upperLetter';
    case 5:
      return 'lowerLetter';
    case 8:
      return 'ganada';
    case 10:
      return 'chosung';
    default:
      return 'decimal';
  }
}

function trimInlines(inlines: DocInline[]): DocInline[] {
  const result = inlines.slice();
  while (result.length > 0) {
    const head = result[0];
    if (head.kind !== 'text') break;
    const trimmed = head.text.replace(/^[ \t\r\n]+/, '');
    if (trimmed === '') result.shift();
    else {
      result[0] = { ...head, text: trimmed };
      break;
    }
  }
  while (result.length > 0) {
    const tail = result[result.length - 1];
    if (tail.kind !== 'text') break;
    const trimmed = tail.text.replace(/[ \t\r\n]+$/, '');
    if (trimmed === '') result.pop();
    else {
      result[result.length - 1] = { ...tail, text: trimmed };
      break;
    }
  }
  return result;
}

/**
 * Reads the section streams (already inflated) into the block model. `docInfo` is the decoded DocInfo stream's records,
 * `loadBin` supplies the picture streams. Malformed records throw a CorruptStreamError; limits throw a PayloadLimitError.
 */
export function readHwpSections(docInfo: readonly HwpRecord[], sections: readonly (readonly HwpRecord[])[], loadBin: HwpBinLoader): DocModel {
  const reader = new HwpModelReader(readHwpDocInfo(docInfo), loadBin);
  for (const section of sections) reader.readSection(section);
  return reader.model;
}
