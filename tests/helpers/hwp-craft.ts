/**
 * Builds HWP 5.0 records for reader tests, with the byte layouts written out from the "Hangul Document File Format
 * 5.0" specification (record header: tag 10 bits, level 10 bits, size 12 bits; DocInfo and BodyText record fields at
 * the offsets named below). It shares nothing with the converter's own HWP writer.
 */

const EXTENDED_SIZE = 0xfff;

export interface RawRecord {
  tagId: number;
  level: number;
  size: number;
  payload: Buffer;
}

export const TAG = {
  BIN_DATA: 18,
  CHAR_SHAPE: 21,
  NUMBERING: 23,
  BULLET: 24,
  PARA_SHAPE: 25,
  STYLE: 26,
  PARA_HEADER: 66,
  PARA_TEXT: 67,
  PARA_CHAR_SHAPE: 68,
  CTRL_HEADER: 71,
  LIST_HEADER: 72,
  SHAPE_COMPONENT: 76,
  TABLE: 77,
  PICTURE: 85,
  EQEDIT: 88,
} as const;

export function rec(tagId: number, level: number, payload: Buffer = Buffer.alloc(0)): RawRecord {
  return { tagId, level, size: payload.length, payload };
}

/** The records as a byte stream (what a section stream holds before compression). */
export function pack(records: readonly RawRecord[]): Buffer {
  const parts: Buffer[] = [];
  for (const record of records) {
    const extended = record.payload.length >= EXTENDED_SIZE;
    const header = Buffer.alloc(extended ? 8 : 4);
    const size = extended ? EXTENDED_SIZE : record.payload.length;
    header.writeUInt32LE(((record.tagId & 0x3ff) | ((record.level & 0x3ff) << 10) | (size << 20)) >>> 0, 0);
    if (extended) header.writeUInt32LE(record.payload.length, 4);
    parts.push(header, record.payload);
  }
  return Buffer.concat(parts);
}

const utf16 = (text: string): Buffer => Buffer.from(text, 'utf16le');

/** Length-prefixed UTF-16 string (WORD count, then the characters). */
function wstring(text: string): Buffer {
  const length = Buffer.alloc(2);
  length.writeUInt16LE(text.length, 0);
  return Buffer.concat([length, utf16(text)]);
}

/** The eight UTF-16 units of an extended or inline control: the code, the four-character id (reversed on disk), padding, the code. */
export function controlUnits(code: number, id = '\0\0\0\0'): Buffer {
  const units = Buffer.alloc(16);
  units.writeUInt16LE(code, 0);
  // The id characters are stored as the little-endian double word of the id read left to right.
  const bytes = Buffer.from([id.charCodeAt(3), id.charCodeAt(2), id.charCodeAt(1), id.charCodeAt(0)]);
  bytes.copy(units, 2);
  units.writeUInt16LE(code, 14);
  return units;
}

/** DocInfo CHAR_SHAPE: base size at offset 42 (1/100 pt), attribute bits at 46 (bit 0 italic, bit 1 bold, bits 2-3 underline), colour at 52. */
export function charShape(options: { sizePt?: number; bold?: boolean; italic?: boolean; underline?: boolean; color?: number } = {}): RawRecord {
  const payload = Buffer.alloc(72);
  payload.writeInt32LE(Math.round((options.sizePt ?? 10) * 100), 42);
  let attributes = 0;
  if (options.italic) attributes |= 1;
  if (options.bold) attributes |= 2;
  if (options.underline) attributes |= 1 << 2;
  payload.writeUInt32LE(attributes >>> 0, 46);
  payload.writeUInt32LE(options.color ?? 0, 52);
  return rec(TAG.CHAR_SHAPE, 1, payload);
}

/** DocInfo PARA_SHAPE: attribute 1 at offset 0 (bits 2-4 alignment, bits 23-24 head type, bits 25-27 level), numbering or bullet id at 30. */
export function paraShape(options: { align?: number; headType?: number; level?: number; numberingId?: number } = {}): RawRecord {
  const payload = Buffer.alloc(54);
  const attributes = ((options.align ?? 0) << 2) | ((options.headType ?? 0) << 23) | ((options.level ?? 0) << 25);
  payload.writeUInt32LE(attributes >>> 0, 0);
  payload.writeUInt16LE(options.numberingId ?? 0, 30);
  return rec(TAG.PARA_SHAPE, 1, payload);
}

/** DocInfo STYLE: Korean name, English name, then properties, next style, language, paragraph shape and character shape ids. */
export function style(englishName: string, koreanName = englishName): RawRecord {
  return rec(TAG.STYLE, 1, Buffer.concat([wstring(koreanName), wstring(englishName), Buffer.alloc(8)]));
}

/** DocInfo NUMBERING: seven levels of (12-byte head with the number shape in attribute bits 5-9, format string), then start numbers. */
export function numbering(levels: readonly { shape: number; format: string }[], starts?: readonly number[]): RawRecord {
  const parts: Buffer[] = [];
  for (let level = 0; level < 7; level += 1) {
    const given = levels[level] ?? { shape: 0, format: `^${level + 1}.` };
    const head = Buffer.alloc(12);
    head.writeUInt32LE(((given.shape << 5) | 0x0c) >>> 0, 0);
    head.writeUInt32LE(0xffffffff, 8);
    parts.push(head, wstring(given.format));
  }
  const start = Buffer.alloc(2 + 28);
  start.writeUInt16LE(starts?.[0] ?? 1, 0);
  for (let level = 0; level < 7; level += 1) start.writeUInt32LE(starts?.[level] ?? 1, 2 + level * 4);
  return rec(TAG.NUMBERING, 1, Buffer.concat([...parts, start]));
}

/** DocInfo BULLET: 12-byte head, then the bullet character. */
export function bullet(character: string): RawRecord {
  const payload = Buffer.alloc(25);
  payload.writeUInt16LE(character.charCodeAt(0), 12);
  return rec(TAG.BULLET, 1, payload);
}

/** DocInfo BIN_DATA for an embedded picture: attributes (type 1 = embedded, bits 4-5 compression), id, extension. */
export function binData(id: number, extension: string, compression = 2): RawRecord {
  const payload = Buffer.concat([Buffer.alloc(6), utf16(extension)]);
  payload.writeUInt16LE(1 | (compression << 4), 0);
  payload.writeUInt16LE(id, 2);
  payload.writeUInt16LE(extension.length, 4);
  return rec(TAG.BIN_DATA, 1, payload);
}

export interface ParagraphSpec {
  text?: string;
  /** Raw UTF-16 content of PARA_TEXT; wins over `text`. Build it with controlUnits(). */
  units?: Buffer;
  shape?: number;
  style?: number;
  /** PARA_HEADER division byte (offset 11): 0x04 starts a new page. */
  breakFlags?: number;
  /** (start position in UTF-16 units of the record, character shape id) pairs. */
  charShapes?: [number, number][];
}

/** PARA_HEADER (paragraph shape id at offset 8, style id at 10, division flags at 11) and its text and character shape records. */
export function para(level: number, spec: ParagraphSpec = {}): RawRecord[] {
  const header = Buffer.alloc(24);
  header.writeUInt16LE(spec.shape ?? 0, 8);
  header[10] = spec.style ?? 0;
  header[11] = spec.breakFlags ?? 0;
  const content = spec.units ?? utf16(spec.text ?? '');
  const end = Buffer.alloc(2);
  end.writeUInt16LE(0x0d, 0);
  const text = Buffer.concat([content, end]);
  header.writeUInt32LE(text.length / 2, 0);
  const records = [rec(TAG.PARA_HEADER, level, header), rec(TAG.PARA_TEXT, level + 1, text)];
  const shapes = spec.charShapes ?? [[0, 0]];
  const shapePayload = Buffer.alloc(shapes.length * 8);
  shapes.forEach(([position, id], index) => {
    shapePayload.writeUInt32LE(position, index * 8);
    shapePayload.writeUInt32LE(id, index * 8 + 4);
  });
  records.push(rec(TAG.PARA_CHAR_SHAPE, level + 1, shapePayload));
  return records;
}

/** CTRL_HEADER: the id bytes as stored (reversed), then the control's own fields. */
export function ctrl(level: number, id: string, rest: Buffer = Buffer.alloc(0)): RawRecord {
  const head = Buffer.from([id.charCodeAt(3), id.charCodeAt(2), id.charCodeAt(1), id.charCodeAt(0)]);
  return rec(TAG.CTRL_HEADER, level, Buffer.concat([head, rest]));
}

/** Common drawing-object properties after the id: attribute, vertical offset, horizontal offset, width, height (1/7200 inch). */
export function objectProperties(widthUnits: number, heightUnits: number): Buffer {
  const payload = Buffer.alloc(40);
  payload.writeUInt32LE(widthUnits, 12);
  payload.writeUInt32LE(heightUnits, 16);
  return payload;
}

/** TABLE record: attribute (bit 2 repeats the header row), rows at offset 4, columns at 6. */
export function table(level: number, rows: number, columns: number, repeatHeader = false): RawRecord {
  const payload = Buffer.alloc(8 + rows * 2 + 2);
  payload.writeUInt32LE(repeatHeader ? 0x4 : 0, 0);
  payload.writeUInt16LE(rows, 4);
  payload.writeUInt16LE(columns, 6);
  return rec(TAG.TABLE, level, payload);
}

/** LIST_HEADER of a table cell: column at offset 8, row at 10, column span at 12, row span at 14. */
export function cell(level: number, column: number, row: number, colSpan = 1, rowSpan = 1): RawRecord {
  const payload = Buffer.alloc(34);
  payload.writeUInt16LE(column, 8);
  payload.writeUInt16LE(row, 10);
  payload.writeUInt16LE(colSpan, 12);
  payload.writeUInt16LE(rowSpan, 14);
  return rec(TAG.LIST_HEADER, level, payload);
}

/** LIST_HEADER of a text box, caption, header, footer or note. */
export function listHeader(level: number): RawRecord {
  return rec(TAG.LIST_HEADER, level, Buffer.alloc(6));
}

/** PICTURE: the BinData item number (1-based, in BIN_DATA order) at offset 71. */
export function picture(level: number, item: number): RawRecord {
  const payload = Buffer.alloc(90);
  payload.writeUInt16LE(item, 71);
  return rec(TAG.PICTURE, level, payload);
}

/** Field (hyperlink) CTRL_HEADER: attributes, an extra byte, the command length and the command. */
export function fieldControl(level: number, id: string, command: string): RawRecord {
  const rest = Buffer.concat([Buffer.alloc(5), wstring(command)]);
  return ctrl(level, id, rest);
}
