import { CorruptStreamError } from '../types';

/**
 * HWP 5.0 records (Hancom "Hangul Document File Format 5.0", record structure) and paragraph text: the tag ids, the
 * record header with its 12-bit size and extended size word, and the UTF-16 paragraph text with its control
 * characters.
 */

/**
 * HWP 5.0 Record Tag IDs
 */
export const HWP_TAGS = {
  DOCUMENT_PROPERTIES: 16,
  ID_MAPPINGS: 17,
  BIN_DATA: 18,
  FACE_NAME: 19,
  BORDER_FILL: 20,
  CHAR_SHAPE: 21,
  TAB_DEF: 22,
  NUMBERING: 23,
  BULLET: 24,
  PARA_SHAPE: 25,
  STYLE: 26,
  DOC_DATA: 27,
  DISTRIBUTE_DOC_DATA: 28,

  // Section / BodyText Tags
  PARA_HEADER: 66,
  PARA_TEXT: 67,
  PARA_CHAR_SHAPE: 68,
  PARA_LINE_SEG: 69,
  PARA_RANGE_TAG: 70,
  CTRL_HEADER: 71,
  LIST_HEADER: 72,
  PAGE_DEF: 73,
  FOOTNOTE: 74,
  PAGE_BORDER_FILL: 75,
  SHAPE_COMPONENT: 76,
  TABLE: 77,
  SHAPE_COMPONENT_LINE: 78,
  SHAPE_COMPONENT_RECTANGLE: 79,
  SHAPE_COMPONENT_ELLIPSE: 80,
  SHAPE_COMPONENT_ARC: 81,
  SHAPE_COMPONENT_POLYGON: 82,
  SHAPE_COMPONENT_CURVE: 83,
  SHAPE_COMPONENT_OLE: 84,
  SHAPE_COMPONENT_PICTURE: 85,
  SHAPE_COMPONENT_CONTAINER: 86,
  CTRL_DATA: 87,
  EQEDIT: 88,
} as const;

/**
 * HWP 5.0 Record representation
 */
export interface HwpRecord {
  tagId: number;
  level: number;
  size: number;
  payload: Buffer;
}

/**
 * Builds an HWP 5.0 record buffer with support for extended sizes (>= 0xFFF)
 */
export function buildHwpRecord(tagId: number, level: number, payload: Buffer): Buffer {
  const size = payload.length;
  if (size < 0xfff) {
    const header = ((tagId & 0x3ff) | ((level & 0x3ff) << 10) | ((size & 0xfff) << 20)) >>> 0;
    const rec = Buffer.alloc(4 + size);
    rec.writeUInt32LE(header, 0);
    payload.copy(rec, 4);
    return rec;
  } else {
    const header = ((tagId & 0x3ff) | ((level & 0x3ff) << 10) | (0xfff << 20)) >>> 0;
    const rec = Buffer.alloc(4 + 4 + size);
    rec.writeUInt32LE(header, 0);
    rec.writeUInt32LE(size, 4);
    payload.copy(rec, 8);
    return rec;
  }
}

/** A 12-bit record size of 0xfff means the real size follows as a 32-bit word (HWP 5.0 file format, record structure). */
const HWP_EXTENDED_SIZE_MARKER = 0xfff;

/**
 * Parses sequential HWP 5.0 records from a decompressed stream buffer
 */
export function parseHwpRecords(buffer: Buffer): HwpRecord[] {
  const records: HwpRecord[] = [];
  let offset = 0;

  while (offset + 4 <= buffer.length) {
    const header = buffer.readUInt32LE(offset);
    offset += 4;

    const tagId = header & 0x3ff;
    const level = (header >> 10) & 0x3ff;
    let size = (header >> 20) & 0xfff;

    if (size === HWP_EXTENDED_SIZE_MARKER) {
      if (offset + 4 > buffer.length) {
        throw new CorruptStreamError(`Corrupt HWP record: tag ${tagId} is cut off inside its extended size field.`);
      }
      size = buffer.readUInt32LE(offset);
      offset += 4;
    }

    if (offset + size > buffer.length) {
      throw new CorruptStreamError(
        `Corrupt HWP record: tag ${tagId} declares ${size} payload bytes but only ${buffer.length - offset} remain.`
      );
    }

    const payload = Buffer.from(buffer.subarray(offset, offset + size));
    offset += size;

    records.push({ tagId, level, size, payload });
  }

  if (offset < buffer.length) {
    throw new CorruptStreamError(`Corrupt HWP record stream: ${buffer.length - offset} stray bytes follow the last record.`);
  }

  return records;
}

/** A control character that carries data takes 8 UTF-16 units in paragraph text: the code, six data units, the code again. */
export const HWP_CONTROL_UNITS = 8;
/** Extended controls (HWP 5.0 file format, control characters) have a CTRL_HEADER record after the paragraph text. */
const HWP_EXTENDED_CONTROLS: ReadonlySet<number> = new Set([1, 2, 3, 11, 12, 14, 15, 16, 17, 18, 21, 22, 23]);
/** Inline controls carry their data in the text and have no record of their own. */
const HWP_INLINE_CONTROLS: ReadonlySet<number> = new Set([4, 5, 6, 7, 8, 9, 19, 20]);
export const HWP_TAB = 0x09;
export const HWP_FIELD_BEGIN = 0x03;
export const HWP_FIELD_END = 0x04;
const HWP_LINE_BREAK = 0x0a;
const HWP_HYPHEN = 0x18;
/** Non-breaking and fixed-width spaces. */
const HWP_SPACE_CONTROLS: ReadonlySet<number> = new Set([0x1e, 0x1f]);
const HWP_FIRST_PRINTABLE = 0x20;
export const HWP_UTF16_UNIT_BYTES = 2;
/** Data units of a control that hold its four-character id (the first two of the six). */
const HWP_CONTROL_ID_UNITS = 2;
/** Characters turned into a string per call, so a large paragraph cannot overflow the argument stack. */
const HWP_TEXT_CHUNK_UNITS = 4096;
/** Most UTF-16 units one paragraph may hold. */
export const HWP_MAX_PARAGRAPH_UNITS = 16 * 1024 * 1024;

/** A control character found in paragraph text. */
export interface HwpTextControl {
  readonly code: number;
  /** Index in the decoded text at which the control stood. */
  readonly offset: number;
  /** Control id for an extended control or a field ("tbl ", "gso ", "%hlk"), null for an inline control without one. */
  readonly id: string | null;
  readonly extended: boolean;
}

export interface HwpParagraphText {
  readonly text: string;
  readonly controls: HwpTextControl[];
  /** Decoded-text index of every raw UTF-16 unit of the record (and one past the end), for positions the record counts in units. */
  readonly offsetOfUnit: Uint32Array;
}

/** The four characters of a control id stored in two UTF-16 units, as they read in the format document ("tbl ", "gso "). */
function controlId(low: number, high: number): string {
  return String.fromCharCode(high >> 8, high & 0xff, low >> 8, low & 0xff);
}

/**
 * Decodes the UTF-16LE text of a paragraph record and lists its controls. Controls that carry data (section and
 * column definitions, tables, drawing objects, fields, footnotes, bookmarks and the like) take 8 units and
 * contribute no text, except the tab; a line break stays a newline; the paragraph end and other single-unit
 * controls contribute nothing. An odd byte count, a control cut off by the end of the record, or one whose closing
 * unit does not repeat its code is a corrupt record.
 */
export function decodeHwpParagraph(buffer: Buffer): HwpParagraphText {
  if (buffer.length % HWP_UTF16_UNIT_BYTES !== 0) {
    throw new CorruptStreamError('Corrupt HWP paragraph text: the record does not hold whole UTF-16 characters.');
  }
  const unitCount = buffer.length / HWP_UTF16_UNIT_BYTES;
  if (unitCount > HWP_MAX_PARAGRAPH_UNITS) {
    throw new CorruptStreamError(`Corrupt HWP paragraph text: a paragraph of ${unitCount} characters is longer than the limit of ${HWP_MAX_PARAGRAPH_UNITS}.`);
  }
  const units: number[] = [];
  const controls: HwpTextControl[] = [];
  const offsetOfUnit = new Uint32Array(unitCount + 1);
  for (let index = 0; index < unitCount; index += 1) {
    const code = buffer.readUInt16LE(index * HWP_UTF16_UNIT_BYTES);
    offsetOfUnit[index] = units.length;
    if (HWP_EXTENDED_CONTROLS.has(code) || HWP_INLINE_CONTROLS.has(code)) {
      if (index + HWP_CONTROL_UNITS > unitCount) {
        throw new CorruptStreamError(`Corrupt HWP paragraph text: control character ${code} is cut off by the end of the record.`);
      }
      const closing = buffer.readUInt16LE((index + HWP_CONTROL_UNITS - 1) * HWP_UTF16_UNIT_BYTES);
      if (closing !== code) {
        throw new CorruptStreamError(`Corrupt HWP paragraph text: control character ${code} is not repeated at its end.`);
      }
      const low = buffer.readUInt16LE((index + 1) * HWP_UTF16_UNIT_BYTES);
      const high = buffer.readUInt16LE((index + 1 + HWP_CONTROL_ID_UNITS - 1) * HWP_UTF16_UNIT_BYTES);
      const extended = HWP_EXTENDED_CONTROLS.has(code);
      const hasId = extended || code === HWP_FIELD_END;
      controls.push({ code, offset: units.length, id: hasId ? controlId(low, high) : null, extended });
      if (code === HWP_TAB) units.push(HWP_TAB);
      for (let skipped = 1; skipped < HWP_CONTROL_UNITS; skipped += 1) offsetOfUnit[index + skipped] = units.length;
      index += HWP_CONTROL_UNITS - 1;
    } else if (code === HWP_LINE_BREAK) {
      units.push(HWP_LINE_BREAK);
    } else if (code === HWP_HYPHEN) {
      units.push(0x2d);
    } else if (HWP_SPACE_CONTROLS.has(code)) {
      units.push(HWP_FIRST_PRINTABLE);
    } else if (code >= HWP_FIRST_PRINTABLE) {
      units.push(code);
    }
  }
  offsetOfUnit[unitCount] = units.length;
  let text = '';
  for (let index = 0; index < units.length; index += HWP_TEXT_CHUNK_UNITS) {
    text += String.fromCodePoint(...units.slice(index, index + HWP_TEXT_CHUNK_UNITS));
  }
  return { text, controls, offsetOfUnit };
}

/** The text of a paragraph record without its controls. */
export function decodeHwpText(buffer: Buffer): string {
  return decodeHwpParagraph(buffer).text;
}
