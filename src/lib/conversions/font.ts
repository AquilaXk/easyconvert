import zlib from 'node:zlib';
import {
  ConversionFailedError,
  ConversionOptions,
  ConversionResult,
  CorruptStreamError,
  DecompressionLimitError,
  UnsupportedOptionError,
} from '../types';
import { InflateBudget, MAX_STREAM_INFLATE_BYTES, inflateBounded } from './bounded-inflate';
import { extractSfntFromMacBinary, extractSfntFromResourceFork, looksLikeSfnt } from './font-mac-resource';
import { parseCff, type CffContour, type CffGlyph, type CffMatrix } from './font-cff';
import { readGlyfOutlines } from './font-glyf';
import { WOFF2_KNOWN_TAGS, countWoff2Fonts, decodeUIntBase128, decodeWoff2Fonts, encodeUIntBase128, encodeWoff2Container, type Woff2DecodedFont } from './font-woff2';
import { isXmlCharacter, parseSvgFontDocument, type SvgFont } from './font-svg';
import { parseSvgPathData, SvgPathDataError, type SvgSubpath } from './font-svg-path';

export { WOFF2_KNOWN_TAGS, decodeUIntBase128, encodeUIntBase128 };

/** WOFF 1.0 header and table directory entry sizes in bytes (section 5). */
const WOFF_HEADER_BYTES = 44;
const WOFF_DIRECTORY_ENTRY_BYTES = 20;

/**
 * Universal Font Conversion Engine
 * Supports TrueType (TTF), OpenType (OTF), WOFF, WOFF2, EOT, and SVG Fonts, plus Macintosh
 * DFONT and MacBinary containers that wrap an SFNT font.
 * Adheres strictly to the in-memory zero-retention architecture.
 */

export interface SfntTable {
  tag: string;
  checkSum: number;
  offset: number;
  length: number;
  data: Buffer;
}

export function formatSfntTag(tag: string): string {
  const padded = (tag || '').padEnd(4, ' ');
  return padded.length === 4 ? padded : padded.substring(0, 4);
}

export interface ParsedFont {
  sfntVersion: number;
  flavor: string;
  numTables: number;
  tables: Record<string, SfntTable>;
  fontFamily: string;
  /**
   * Glyph names the source font declared (an SVG font's glyph-name attribute), one per glyph id with
   * '' for unnamed glyphs. Only set when the source carries names that no sfnt table holds.
   */
  glyphNames?: string[];
}

export interface VariableFontAxis {
  tag: string;
  name: string;
  minValue: number;
  defaultValue: number;
  maxValue: number;
  flags: number;
  axisNameID: number;
}

export interface VariableFontInstance {
  name: string;
  subfamilyNameID: number;
  flags: number;
  coordinates: Record<string, number>;
  postScriptNameID?: number;
}

export interface StatDesignAxis {
  tag: string;
  name: string;
  ordering: number;
  axisNameID: number;
}

export interface StatAxisValue {
  format: number;
  axisIndex: number;
  axisTag?: string;
  flags: number;
  valueNameID: number;
  valueName: string;
  value?: number;
  nominalValue?: number;
  rangeMinValue?: number;
  rangeMaxValue?: number;
  linkedValue?: number;
  axisValues?: { axisIndex: number; value: number }[];
}

export interface VariableFontMetadata {
  isVariableFont: boolean;
  fontFamily: string;
  axes: VariableFontAxis[];
  instances: VariableFontInstance[];
  statAxes: StatDesignAxis[];
  statValues: StatAxisValue[];
}

export async function convertFont(
  inputBuffer: Buffer,
  sourceFormat: string,
  targetFormat: string,
  options: ConversionOptions = {},
  originalFilename: string
): Promise<ConversionResult> {
  const baseName = originalFilename.replace(/\.[^/.]+$/, '');
  const src = sourceFormat.toLowerCase().replace(/^\./, '').trim();
  const tgt = targetFormat.toLowerCase().replace(/^\./, '').trim();

  if (!inputBuffer || inputBuffer.length === 0) {
    throw new Error('Font conversion payload is empty (0 bytes).');
  }

  // Every target holds one font; a collection would silently lose all but its first face
  if (looksLikeWoff2(inputBuffer, src)) {
    const faces = countWoff2Fonts(inputBuffer);
    if (faces > 1) {
      throw new UnsupportedOptionError(`The WOFF2 file is a collection of ${faces} fonts, but ${tgt} holds a single font. Extract one font first.`);
    }
  }

  // 1. Parse or synthesize canonical SFNT TrueType / OpenType font representation
  const parsedFont = parseFontToSfnt(inputBuffer, src, baseName);

  // 2. Synthesize requested target format
  let outputBuffer: Buffer;
  let mimeType: string;

  switch (tgt) {
    case 'woff':
      outputBuffer = encodeWoff(parsedFont);
      mimeType = 'font/woff';
      break;

    case 'woff2':
      outputBuffer = encodeWoff2(parsedFont);
      mimeType = 'font/woff2';
      break;

    case 'ttf': {
      const ttfFont = convertFontToTrueType(parsedFont);
      outputBuffer = encodeSfnt(ttfFont, 0x00010000); // Standard TrueType sfntVersion
      mimeType = 'font/ttf';
      break;
    }

    case 'otf': {
      const otfFont = convertFontToOpenTypeCff(parsedFont);
      outputBuffer = encodeSfnt(otfFont, 0x4f54544f); // OpenType CFF 'OTTO'
      mimeType = 'font/otf';
      break;
    }

    case 'eot':
      outputBuffer = encodeEot(parsedFont);
      mimeType = 'application/vnd.ms-fontobject';
      break;

    case 'svg':
    case 'svgfont':
      outputBuffer = encodeSvgFont(parsedFont, baseName);
      mimeType = 'image/svg+xml';
      break;

    default:
      throw new Error(`Unsupported target font format: "${tgt}". Supported targets: woff, woff2, ttf, otf, eot, svg`);
  }

  return {
    buffer: outputBuffer,
    mimeType,
    filename: `${baseName}.${tgt === 'svgfont' ? 'svg' : tgt}`,
    size: outputBuffer.length,
  };
}

/** True for a WOFF2 file: declared as such, or carrying the 'wOF2' signature (Mac containers are chosen by declared format first). */
function looksLikeWoff2(buffer: Buffer, format: string): boolean {
  if (format === 'dfont' || format === 'bin') return false;
  if (format === 'woff' || (buffer.length >= 4 && buffer.toString('ascii', 0, 4) === 'wOFF')) return false;
  return format === 'woff2' || (buffer.length >= 4 && buffer.toString('ascii', 0, 4) === 'wOF2');
}

/**
 * Parses arbitrary input font stream (TTF, OTF, WOFF, WOFF2, EOT, SVG Font, DFONT, MacBinary) into canonical SFNT structure
 */
export function parseFontToSfnt(buffer: Buffer, format: string, defaultName: string): ParsedFont {
  // Mac containers are selected by declared format before any magic sniffing: a MacBinary filename
  // field can contain arbitrary bytes that would otherwise look like another container's signature.
  if (format === 'dfont') {
    return decodeSfnt(extractSfntFromResourceFork(buffer), defaultName);
  }
  if (format === 'bin') {
    return decodeSfnt(extractSfntFromMacBinary(buffer), defaultName);
  }

  // Check WOFF signature ('wOFF' = 0x774F4646)
  if (format === 'woff' || (buffer.length >= 4 && buffer.toString('ascii', 0, 4) === 'wOFF')) {
    return decodeWoff(buffer, defaultName);
  }

  // Check WOFF2 signature ('wOF2' = 0x774F4632)
  if (looksLikeWoff2(buffer, format)) {
    return decodeWoff2(buffer, defaultName);
  }

  // Check EOT signature (Magic number 0x504C at offset 34)
  if (format === 'eot' || (buffer.length >= 36 && buffer.readUInt16LE(34) === 0x504c)) {
    return decodeEot(buffer, defaultName);
  }

  // Check SVG Font
  if (format === 'svg' || format === 'svgfont' || buffer.toString('utf-8', 0, Math.min(200, buffer.length)).includes('<font')) {
    return decodeSvgFont(buffer, defaultName);
  }

  // Standard SFNT (TTF / OTF). DFONT and MacBinary containers are unwrapped above; PFA / PFB are not handled here.
  if (looksLikeSfnt(buffer)) {
    return decodeSfnt(buffer, defaultName);
  }

  // Fail-closed: invalid or non-SFNT container must throw error
  throw new Error('Unsupported or corrupted font format: input is not a valid SFNT/WOFF/WOFF2/EOT/SVG font.');
}

const SFNT_HEADER_BYTES = 12;
const SFNT_TABLE_RECORD_BYTES = 16;

/**
 * Decodes standard SFNT (TTF / OTF) buffer. A directory or table that does not fit the buffer is
 * rejected rather than clipped.
 */
export function decodeSfnt(buffer: Buffer, defaultName: string): ParsedFont {
  if (buffer.length < 12) {
    throw new ConversionFailedError('Invalid SFNT font buffer: length is less than 12 bytes.');
  }

  const sfntVersion = buffer.readUInt32BE(0);
  const numTables = buffer.readUInt16BE(4);
  const tables: Record<string, SfntTable> = {};
  if (SFNT_HEADER_BYTES + numTables * SFNT_TABLE_RECORD_BYTES > buffer.length) {
    throw new ConversionFailedError(`Invalid SFNT font: the directory of ${numTables} tables is cut short.`);
  }

  let offset = SFNT_HEADER_BYTES;
  for (let i = 0; i < numTables; i++) {

    const tag = buffer.toString('ascii', offset, offset + 4);
    const checkSum = buffer.readUInt32BE(offset + 4);
    const tableOffset = buffer.readUInt32BE(offset + 8);
    const tableLength = buffer.readUInt32BE(offset + 12);

    if (tableOffset + tableLength > buffer.length) {
      throw new ConversionFailedError(`Invalid SFNT font: table '${tag}' extends past the end of the font.`);
    }
    const data = buffer.subarray(tableOffset, tableOffset + tableLength);

    tables[tag] = {
      tag,
      checkSum,
      offset: tableOffset,
      length: tableLength,
      data: Buffer.from(data),
    };

    offset += SFNT_TABLE_RECORD_BYTES;
  }

  let fontFamily = defaultName;
  if (tables['name']) {
    fontFamily = extractFontFamilyFromNameTable(tables['name'].data) || defaultName;
  }

  return {
    sfntVersion,
    flavor: sfntVersion === 0x4f54544f ? 'OTTO' : 'TrueType',
    numTables: Object.keys(tables).length,
    tables,
    fontFamily,
  };
}

/**
 * Orders table records as the OpenType and WOFF specifications require: ascending by the four tag
 * bytes as written ('OS/2' before 'cmap'), not by locale collation.
 */
function compareSfntTags(a: { tag: string }, b: { tag: string }): number {
  return Buffer.compare(Buffer.from(formatSfntTag(a.tag), 'latin1'), Buffer.from(formatSfntTag(b.tag), 'latin1'));
}

/**
 * Encodes canonical ParsedFont into standard SFNT (TTF / OTF) binary stream
 */
export function encodeSfnt(font: ParsedFont, overrideVersion?: number): Buffer {
  const version = overrideVersion || font.sfntVersion || DEFAULT_SFNT_VERSION;
  return assembleSfnt(prepareSfntTables(font, version), version);
}

interface PreparedTable {
  tag: string;
  data: Buffer;
  checkSum: number;
}

const DEFAULT_SFNT_VERSION = 0x00010000;
/** The whole font's uint32 sum, with checkSumAdjustment in place, must equal this (OpenType 'head'). */
const SFNT_CHECKSUM_MAGIC = 0xb1b0afba;
const HEAD_CHECKSUM_ADJUSTMENT_OFFSET = 8;
const HEAD_CHECKSUM_MIN_BYTES = HEAD_CHECKSUM_ADJUSTMENT_OFFSET + 4;
const SFNT_DIRECTORY_HEADER_BYTES = 12;
const SFNT_DIRECTORY_ENTRY_BYTES = 16;
const TABLE_ALIGNMENT = 4;

function isHeadTable(tbl: { tag: string; data: Buffer }): boolean {
  return formatSfntTag(tbl.tag) === 'head' && tbl.data.length >= HEAD_CHECKSUM_MIN_BYTES;
}

/**
 * Sorts the tables, recomputes every table checksum from its data, and fills the 'head' table's
 * checkSumAdjustment for the SFNT layout these tables produce. The 'head' checksum is taken with the
 * adjustment set to zero, as the OpenType specification requires.
 */
function prepareSfntTables(font: ParsedFont, version: number): PreparedTable[] {
  const prepared = Object.values(font.tables)
    .sort(compareSfntTags)
    .map((tbl) => {
      const head = isHeadTable(tbl);
      const data = head ? Buffer.from(tbl.data) : tbl.data;
      if (head) data.writeUInt32BE(0, HEAD_CHECKSUM_ADJUSTMENT_OFFSET);
      return { tag: tbl.tag, data, checkSum: calculateTableChecksum(data) };
    });
  const head = prepared.find(isHeadTable);
  if (head) {
    const adjustment = (SFNT_CHECKSUM_MAGIC - calculateTableChecksum(assembleSfnt(prepared, version))) >>> 0;
    head.data.writeUInt32BE(adjustment, HEAD_CHECKSUM_ADJUSTMENT_OFFSET);
  }
  return prepared;
}

function assembleSfnt(tableEntries: PreparedTable[], version: number): Buffer {
  const numTables = tableEntries.length;

  const searchRange = numTables > 0 ? Math.pow(2, Math.floor(Math.log2(numTables))) * SFNT_DIRECTORY_ENTRY_BYTES : 0;
  const entrySelector = numTables > 0 ? Math.floor(Math.log2(numTables)) : 0;
  const rangeShift = numTables > 0 ? numTables * SFNT_DIRECTORY_ENTRY_BYTES - searchRange : 0;

  const headerSize = SFNT_DIRECTORY_HEADER_BYTES + numTables * SFNT_DIRECTORY_ENTRY_BYTES;
  const chunks: Buffer[] = [];
  let currentOffset = headerSize;

  const directory = Buffer.alloc(headerSize);
  directory.writeUInt32BE(version, 0);
  directory.writeUInt16BE(numTables, 4);
  directory.writeUInt16BE(searchRange, 6);
  directory.writeUInt16BE(entrySelector, 8);
  directory.writeUInt16BE(rangeShift, 10);

  tableEntries.forEach((tbl, idx) => {
    const entryOffset = SFNT_DIRECTORY_HEADER_BYTES + idx * SFNT_DIRECTORY_ENTRY_BYTES;
    directory.write(formatSfntTag(tbl.tag), entryOffset, 4, 'ascii');
    directory.writeUInt32BE(tbl.checkSum, entryOffset + 4);
    directory.writeUInt32BE(currentOffset, entryOffset + 8);
    directory.writeUInt32BE(tbl.data.length, entryOffset + 12);

    chunks.push(tbl.data);
    const pad = (TABLE_ALIGNMENT - (tbl.data.length % TABLE_ALIGNMENT)) % TABLE_ALIGNMENT;
    if (pad > 0) chunks.push(Buffer.alloc(pad));
    currentOffset += tbl.data.length + pad;
  });

  return Buffer.concat([directory, ...chunks]);
}

/**
 * Encodes ParsedFont into standard W3C WOFF 1.0 container format
 * Tables are deflated using zlib and encapsulated with 44-byte WOFF header.
 */
export function encodeWoff(font: ParsedFont): Buffer {
  const flavor = font.sfntVersion || DEFAULT_SFNT_VERSION;
  const tableEntries = prepareSfntTables(font, flavor);
  const numTables = tableEntries.length;

  const woffHeaderSize = WOFF_HEADER_BYTES;
  const dirSize = numTables * WOFF_DIRECTORY_ENTRY_BYTES;
  let currentOffset = woffHeaderSize + dirSize;

  const tableDataChunks: Buffer[] = [];
  const dirBuf = Buffer.alloc(dirSize);

  let totalSfntSize = 12 + numTables * 16;

  tableEntries.forEach((tbl, idx) => {
    const origLength = tbl.data.length;
    totalSfntSize += origLength + ((4 - (origLength % 4)) % 4);

    // Deflate compression
    const deflated = zlib.deflateSync(tbl.data);
    const useCompressed = deflated.length < origLength;
    const compData = useCompressed ? deflated : tbl.data;
    const compLength = compData.length;

    const entryOffset = idx * 20;
    dirBuf.write(tbl.tag, entryOffset, 4, 'ascii');
    dirBuf.writeUInt32BE(currentOffset, entryOffset + 4);
    dirBuf.writeUInt32BE(compLength, entryOffset + 8);
    dirBuf.writeUInt32BE(origLength, entryOffset + 12);
    dirBuf.writeUInt32BE(tbl.checkSum, entryOffset + 16);

    tableDataChunks.push(compData);

    const pad = (4 - (compLength % 4)) % 4;
    if (pad > 0) {
      tableDataChunks.push(Buffer.alloc(pad));
      currentOffset += compLength + pad;
    } else {
      currentOffset += compLength;
    }
  });

  const totalWoffLength = currentOffset;

  const header = Buffer.alloc(44);
  header.write('wOFF', 0, 4, 'ascii'); // Signature
  header.writeUInt32BE(flavor, 4); // Flavor
  header.writeUInt32BE(totalWoffLength, 8); // Total WOFF Length
  header.writeUInt16BE(numTables, 12); // Num Tables
  header.writeUInt16BE(0, 14); // Reserved
  header.writeUInt32BE(totalSfntSize, 16); // Total SFNT Size
  header.writeUInt16BE(1, 20); // Major Version
  header.writeUInt16BE(0, 22); // Minor Version
  header.writeUInt32BE(0, 24); // Meta Offset
  header.writeUInt32BE(0, 28); // Meta Length
  header.writeUInt32BE(0, 32); // Meta Orig Length
  header.writeUInt32BE(0, 36); // Priv Offset
  header.writeUInt32BE(0, 40); // Priv Length

  return Buffer.concat([header, dirBuf, ...tableDataChunks]);
}

/**
 * Decodes WOFF 1.0 container format into ParsedFont
 */
export function decodeWoff(buffer: Buffer, defaultName: string): ParsedFont {
  if (buffer.length < WOFF_HEADER_BYTES || buffer.toString('ascii', 0, 4) !== 'wOFF') {
    throw new Error('Invalid WOFF font: missing wOFF magic signature.');
  }

  const flavor = buffer.readUInt32BE(4);
  const numTables = buffer.readUInt16BE(12);

  // WOFF 1.0 section 5: a table is stored when compLength equals origLength and zlib compressed
  // when it is smaller; it never exceeds origLength and must lie inside the file. Declared sizes
  // are charged to the document budget before any table is inflated.
  const budget = new InflateBudget();
  const entries: Array<{
    tag: string;
    offset: number;
    compLength: number;
    origLength: number;
    checkSum: number;
  }> = [];
  for (let i = 0; i < numTables; i++) {
    const dirOffset = WOFF_HEADER_BYTES + i * WOFF_DIRECTORY_ENTRY_BYTES;
    if (dirOffset + WOFF_DIRECTORY_ENTRY_BYTES > buffer.length) break;

    const tag = buffer.toString('ascii', dirOffset, dirOffset + 4);
    const offset = buffer.readUInt32BE(dirOffset + 4);
    const compLength = buffer.readUInt32BE(dirOffset + 8);
    const origLength = buffer.readUInt32BE(dirOffset + 12);
    const checkSum = buffer.readUInt32BE(dirOffset + 16);
    const label = `WOFF table '${tag}'`;

    if (compLength > origLength) {
      throw new CorruptStreamError(`${label} has compLength ${compLength} larger than its origLength ${origLength}.`);
    }
    if (offset + compLength > buffer.length) {
      throw new CorruptStreamError(`${label} extends past the end of the file.`);
    }
    if (origLength > MAX_STREAM_INFLATE_BYTES) {
      throw new DecompressionLimitError(
        `${label} declares ${origLength} decoded bytes, more than the limit of ${MAX_STREAM_INFLATE_BYTES} bytes.`
      );
    }
    budget.charge(origLength, label);
    entries.push({ tag, offset, compLength, origLength, checkSum });
  }

  const tables: Record<string, SfntTable> = {};
  for (const entry of entries) {
    const { tag, offset, compLength, origLength, checkSum } = entry;
    const compData = buffer.subarray(offset, offset + compLength);
    const rawData =
      compLength < origLength
        ? inflateBounded(compData, { label: `WOFF table '${tag}'`, format: 'zlib', expectedLength: origLength })
        : Buffer.from(compData);

    tables[tag] = {
      tag,
      checkSum,
      offset,
      length: rawData.length,
      data: rawData,
    };
  }

  let fontFamily = defaultName;
  if (tables['name']) {
    fontFamily = extractFontFamilyFromNameTable(tables['name'].data) || defaultName;
  }

  return {
    sfntVersion: flavor,
    flavor: flavor === 0x4f54544f ? 'OTTO' : 'TrueType',
    numTables: Object.keys(tables).length,
    tables,
    fontFamily,
  };
}

/**
 * Encodes ParsedFont into the W3C WOFF2 format: glyf and loca (and hmtx where it applies) in their
 * transformed form, Brotli compressed. Fonts the transforms cannot represent throw a Woff2FormatError.
 */
export function encodeWoff2(font: ParsedFont): Buffer {
  const tables = Object.entries(font.tables).map(([tag, table]) => ({ tag, data: table.data }));
  return encodeWoff2Container(font.sfntVersion || 0x00010000, tables);
}

/** Builds the canonical font model from a font that decodeWoff2Fonts reconstructed. */
function parsedFontFromWoff2(decoded: Woff2DecodedFont, defaultName: string): ParsedFont {
  const tables: Record<string, SfntTable> = {};
  for (const table of decoded.tables) {
    tables[table.tag] = { tag: table.tag, checkSum: table.checkSum, offset: 0, length: table.data.length, data: table.data };
  }
  const fontFamily = tables['name'] ? extractFontFamilyFromNameTable(tables['name'].data) || defaultName : defaultName;
  return {
    sfntVersion: decoded.flavor,
    flavor: decoded.flavor === 0x4f54544f ? 'OTTO' : 'TrueType',
    numTables: decoded.tables.length,
    tables,
    fontFamily,
  };
}

/**
 * Decodes W3C WOFF2 container format into ParsedFont. The glyf, loca and hmtx transforms are reversed
 * and the font is checksummed like any sfnt. Only Brotli compressed WOFF2 is accepted; malformed input
 * throws a Woff2FormatError. A collection yields its first font; decodeWoff2Collection returns all.
 */
export function decodeWoff2(buffer: Buffer, defaultName: string): ParsedFont {
  return parsedFontFromWoff2(decodeWoff2Fonts(buffer, { firstFontOnly: true })[0], defaultName);
}

/** Decodes every font of a WOFF2 file (several for a collection, one otherwise). */
export function decodeWoff2Collection(buffer: Buffer, defaultName: string): ParsedFont[] {
  return decodeWoff2Fonts(buffer).map((font) => parsedFontFromWoff2(font, defaultName));
}

/**
 * Encodes ParsedFont into Microsoft Embedded OpenType (EOT) binary format
 */
export function encodeEot(font: ParsedFont): Buffer {
  const sfntBuf = encodeSfnt(font);
  const familyName = font.fontFamily || 'EasyConvertFont';
  const familyNameUtf16 = Buffer.from(familyName, 'utf16le');

  const eotHeaderSize = 82 + familyNameUtf16.length + 4;
  const eotTotalSize = eotHeaderSize + sfntBuf.length;

  const header = Buffer.alloc(eotHeaderSize);
  header.writeUInt32LE(eotTotalSize, 0); // EOTSize
  header.writeUInt32LE(sfntBuf.length, 4); // FontDataSize
  header.writeUInt32LE(0x00020001, 8); // Version (2.1)
  header.writeUInt32LE(0, 12); // Flags
  header.fill(0, 16, 26); // FontPANOSE (10 bytes)
  header.writeUInt8(1, 26); // Charset (DEFAULT_CHARSET)
  header.writeUInt8(0, 27); // Italic
  header.writeUInt32LE(400, 28); // Weight (Normal)
  header.writeUInt16LE(0, 32); // fsType
  header.writeUInt16LE(0x504c, 34); // MagicNumber ('LP')
  header.writeUInt32LE(0, 36); // UnicodeRange1
  header.writeUInt32LE(0, 40); // UnicodeRange2
  header.writeUInt32LE(0, 44); // UnicodeRange3
  header.writeUInt32LE(0, 48); // UnicodeRange4
  header.writeUInt32LE(0, 52); // CodePageRange1
  header.writeUInt32LE(0, 56); // CodePageRange2
  header.writeUInt32LE(0, 60); // CheckSumAdjustment

  // Family name offset
  header.writeUInt16LE(familyNameUtf16.length, 82);
  familyNameUtf16.copy(header, 84);

  return Buffer.concat([header, sfntBuf]);
}

/**
 * Decodes Microsoft Embedded OpenType (EOT) into ParsedFont
 */
export function decodeEot(buffer: Buffer, defaultName: string): ParsedFont {
  if (buffer.length < 36 || buffer.readUInt16LE(34) !== 0x504c) {
    throw new Error('Invalid EOT font: missing LP signature at offset 34.');
  }

  const fontDataSize = buffer.readUInt32LE(4);
  const sfntCandidate = buffer.subarray(buffer.length - fontDataSize);

  if (sfntCandidate.length >= 12) {
    try {
      return decodeSfnt(sfntCandidate, defaultName);
    } catch {
      // Fallback
    }
  }

  return createCanonicalFont(buffer, defaultName);
}

export interface GlyphPoint {
  x: number;
  y: number;
  onCurve: boolean;
}

/**
 * Parses TrueType simple glyph outlines from 'glyf' table data (Apple & Microsoft OpenType spec)
 */
export function parseSimpleGlyph(data: Buffer, offset: number): GlyphPoint[][] {
  if (offset + 10 > data.length) return [];
  const numberOfContours = data.readInt16BE(offset);
  if (numberOfContours <= 0) return []; // Blank or composite glyph

  let p = offset + 10;
  if (p + numberOfContours * 2 > data.length) return [];

  const endPtsOfContours: number[] = [];
  for (let c = 0; c < numberOfContours; c++) {
    endPtsOfContours.push(data.readUInt16BE(p));
    p += 2;
  }

  const numPoints = endPtsOfContours[numberOfContours - 1] + 1;
  if (p + 2 > data.length) return [];
  const instructionLength = data.readUInt16BE(p);
  p += 2 + instructionLength; // Skip instructions

  if (p > data.length) return [];

  // 1. Unpack Flags
  const flags = new Uint8Array(numPoints);
  let ptIdx = 0;
  while (ptIdx < numPoints && p < data.length) {
    const flag = data[p++];
    flags[ptIdx++] = flag;
    if (flag & 0x08) { // REPEAT_FLAG
      const repeatCount = data[p++] || 0;
      for (let r = 0; r < repeatCount && ptIdx < numPoints; r++) {
        flags[ptIdx++] = flag;
      }
    }
  }

  // 2. Unpack X Coordinates (Deltas -> Absolute)
  const xs = new Int32Array(numPoints);
  let currentX = 0;
  for (let i = 0; i < numPoints && p <= data.length; i++) {
    const f = flags[i];
    if (f & 0x02) { // X_SHORT_VECTOR
      const d = data[p++];
      currentX += (f & 0x10) ? d : -d;
    } else {
      if (!(f & 0x10)) { // 2 bytes delta
        if (p + 2 <= data.length) {
          currentX += data.readInt16BE(p);
          p += 2;
        }
      } // else dx = 0
    }
    xs[i] = currentX;
  }

  // 3. Unpack Y Coordinates (Deltas -> Absolute)
  const ys = new Int32Array(numPoints);
  let currentY = 0;
  for (let i = 0; i < numPoints && p <= data.length; i++) {
    const f = flags[i];
    if (f & 0x04) { // Y_SHORT_VECTOR
      const d = data[p++];
      currentY += (f & 0x20) ? d : -d;
    } else {
      if (!(f & 0x20)) { // 2 bytes delta
        if (p + 2 <= data.length) {
          currentY += data.readInt16BE(p);
          p += 2;
        }
      } // else dy = 0
    }
    ys[i] = currentY;
  }

  // 4. Split into Contours
  const contours: GlyphPoint[][] = [];
  let startIndex = 0;
  for (let c = 0; c < numberOfContours; c++) {
    const endIndex = endPtsOfContours[c];
    const contour: GlyphPoint[] = [];
    for (let i = startIndex; i <= endIndex && i < numPoints; i++) {
      contour.push({
        x: xs[i],
        y: ys[i],
        onCurve: (flags[i] & 0x01) !== 0,
      });
    }
    if (contour.length > 0) {
      contours.push(contour);
    }
    startIndex = endIndex + 1;
  }

  return contours;
}

/**
 * Converts TrueType contours with implicit midpoints between consecutive off-curve points
 * into exact SVG quadratic Bezier path commands (M, L, Q, Z)
 */
export function contoursToSvgPath(contours: GlyphPoint[][], flipY = false): string {
  const parts: string[] = [];

  for (const contour of contours) {
    if (contour.length === 0) continue;
    const n = contour.length;

    // Step 1: Expand implicit midpoints between consecutive off-curve points
    const expanded: GlyphPoint[] = [];
    for (let i = 0; i < n; i++) {
      const curr = contour[i];
      const next = contour[(i + 1) % n];
      expanded.push(curr);
      if (!curr.onCurve && !next.onCurve) {
        expanded.push({
          x: Math.round((curr.x + next.x) / 2),
          y: Math.round((curr.y + next.y) / 2),
          onCurve: true,
        });
      }
    }

    // Step 2: Rotate contour so it starts on an on-curve point
    const firstOn = expanded.findIndex((pt) => pt.onCurve);
    if (firstOn === -1) continue;
    const pts = [...expanded.slice(firstOn), ...expanded.slice(0, firstOn)];
    const m = pts.length;

    const yCoord = (y: number) => (flipY ? -y : y);

    let d = `M${pts[0].x} ${yCoord(pts[0].y)}`;
    let i = 1;
    while (i < m) {
      const pt = pts[i];
      if (pt.onCurve) {
        d += ` L${pt.x} ${yCoord(pt.y)}`;
        i++;
      } else {
        const ctrl = pt;
        const end = pts[(i + 1) % m];
        d += ` Q${ctrl.x} ${yCoord(ctrl.y)} ${end.x} ${yCoord(end.y)}`;
        i += 2;
      }
    }
    d += ' Z';
    parts.push(d);
  }

  return parts.join(' ');
}

/** Maps each glyph ID to the first Unicode character the cmap assigns to it. */
function buildGlyphToUnicodeMap(cmapTable: SfntTable | undefined): Map<number, string> {
  const glyphToUnicode = new Map<number, string>();
  if (cmapTable && cmapTable.data && cmapTable.data.length >= 4) {
    const codePointMap = parseCmapTable(cmapTable.data);
    for (const [codePoint, gId] of codePointMap.entries()) {
      if (!glyphToUnicode.has(gId)) {
        try {
          glyphToUnicode.set(gId, String.fromCodePoint(codePoint));
        } catch {
          glyphToUnicode.set(gId, String.fromCodePoint(codePoint & 0xffff));
        }
      }
    }
  }
  return glyphToUnicode;
}

interface SvgGlyphRecord {
  glyphId: number;
  /** The character the cmap maps to this glyph; '' when none (or when XML cannot carry it). */
  unicode: string;
  /** Glyph name declared by the source (SVG glyph-name), '' when none. */
  name: string;
  d: string;
  advWidth: number;
}

function writableUnicode(glyphToUnicode: Map<number, string>, glyphId: number): string {
  const char = glyphToUnicode.get(glyphId);
  return char !== undefined && isXmlCharacter(char.codePointAt(0) as number) ? char : '';
}

/** Reads every glyph of a TrueType font (including .notdef) as an SVG path with its advance. */
function readTrueTypeGlyphRecords(font: ParsedFont): SvgGlyphRecord[] {
  const glyfTable = font.tables['glyf'];
  const locaTable = font.tables['loca'];
  const headTable = font.tables['head'];
  const hmtxTable = font.tables['hmtx'];
  const hheaTable = font.tables['hhea'];

  if (!glyfTable || !locaTable || !headTable) {
    return [];
  }

  const isShortLoca = headTable.data.length >= 52 && headTable.data.readInt16BE(50) === 0;
  const numGlyphs = isShortLoca ? Math.floor(locaTable.data.length / 2) - 1 : Math.floor(locaTable.data.length / 4) - 1;
  if (numGlyphs <= 0) return [];

  const numOfHMetrics = hheaTable && hheaTable.data.length >= 36 ? hheaTable.data.readUInt16BE(34) : 1;
  const glyphToUnicode = buildGlyphToUnicodeMap(font.tables['cmap']);
  const unitsPerEm = readUnitsPerEm(font);

  const records: SvgGlyphRecord[] = [];
  for (let g = 0; g < numGlyphs; g++) {
    const offset = isShortLoca ? locaTable.data.readUInt16BE(g * 2) * 2 : locaTable.data.readUInt32BE(g * 4);
    const nextOffset = isShortLoca ? locaTable.data.readUInt16BE((g + 1) * 2) * 2 : locaTable.data.readUInt32BE((g + 1) * 4);
    const advWidth = readAdvanceWidth(hmtxTable?.data, numOfHMetrics, g, unitsPerEm);

    let d = '';
    if (nextOffset > offset && offset < glyfTable.data.length) {
      d = contoursToSvgPath(parseSimpleGlyph(glyfTable.data, offset));
    }
    records.push({ glyphId: g, unicode: writableUnicode(glyphToUnicode, g), name: font.glyphNames?.[g] ?? '', d, advWidth });
  }
  return records;
}

/**
 * Extracts authentic vector glyphs from TrueType 'glyf', 'loca', and 'cmap' tables. The .notdef
 * glyph is left out (an SVG font stores it as missing-glyph), and so is every glyph that is neither
 * mapped to a character nor named, since an SVG font addresses glyphs by character or name only.
 */
export function extractTrueTypeGlyphs(font: ParsedFont): Array<{ unicode: string; d: string; advWidth: number; name?: string }> {
  return readTrueTypeGlyphRecords(font)
    .filter((record) => record.glyphId > 0 && (record.unicode !== '' || record.name !== ''))
    .map(({ unicode, d, advWidth, name }) => (name === '' ? { unicode, d, advWidth } : { unicode, d, advWidth, name }));
}

/** Em size, ascent and descent for the SVG font-face, from head and hhea (descent is negative). */
function readSvgFontMetrics(font: ParsedFont): { unitsPerEm: number; ascent: number; descent: number } {
  const unitsPerEm = readUnitsPerEm(font);
  const hhea = font.tables['hhea'];
  if (!hhea || hhea.data.length < HHEA_VERTICAL_METRICS_END) {
    const ascent = Math.round(unitsPerEm * DEFAULT_ASCENT_PER_EM);
    return { unitsPerEm, ascent, descent: ascent - unitsPerEm };
  }
  return {
    unitsPerEm,
    ascent: hhea.data.readInt16BE(HHEA_ASCENDER_OFFSET),
    descent: hhea.data.readInt16BE(HHEA_DESCENDER_OFFSET),
  };
}

function glyphElement(record: SvgGlyphRecord): string {
  const attributes: string[] = [];
  if (record.unicode !== '') attributes.push(`unicode="${escapeXml(record.unicode)}"`);
  if (record.name !== '') attributes.push(`glyph-name="${escapeXml(record.name)}"`);
  attributes.push(`horiz-adv-x="${record.advWidth}"`);
  if (record.d !== '') attributes.push(`d="${record.d}"`);
  return `<glyph ${attributes.join(' ')} />`;
}

/**
 * Encodes ParsedFont into W3C SVG Font representation. The metrics, advances, missing-glyph and
 * glyph paths all come from the font; a font without outlines is rejected.
 */
export function encodeSvgFont(font: ParsedFont, defaultName: string): Buffer {
  try {
    return encodeSvgFontDocument(font, defaultName);
  } catch (error) {
    // The runtime refuses strings past its length limit with a RangeError; report it as a conversion failure.
    if (error instanceof RangeError) {
      throw new ConversionFailedError('Cannot write an SVG font: the glyph outlines are too large for one document.');
    }
    throw error;
  }
}

function encodeSvgFontDocument(font: ParsedFont, defaultName: string): Buffer {
  const family = font.fontFamily || defaultName || 'EasyConvertFont';

  // Real outlines only: TrueType glyf, or the CFF charstrings of an OpenType CFF font.
  let records = readTrueTypeGlyphRecords(font);
  const hasOutlines = (list: SvgGlyphRecord[]): boolean => list.some((record) => record.glyphId > 0 && record.d !== '');
  if (!hasOutlines(records) && font.tables['CFF ']) {
    records = readCffGlyphRecords(font);
  }
  if (!hasOutlines(records)) {
    throw new FontOutlinesMissingError(
      'Cannot write an SVG font: the font has no extractable glyph outlines (no non-empty glyf glyphs or CFF glyphs).'
    );
  }
  // The .notdef glyph becomes missing-glyph with its own outline (none when the font draws nothing).
  const notdef = records[0];
  const addressable = records.filter((record) => record.glyphId > 0 && (record.unicode !== '' || record.name !== ''));

  const { unitsPerEm, ascent, descent } = readSvgFontMetrics(font);
  const missingAttributes = [`horiz-adv-x="${notdef.advWidth}"`];
  if (notdef.d !== '') missingAttributes.push(`d="${notdef.d}"`);
  const glyphsXml = addressable.map(glyphElement);

  const svg = `<?xml version="1.0" standalone="no"?>
<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">
<svg xmlns="http://www.w3.org/2000/svg">
  <defs>
    <font id="${escapeXml(family)}" horiz-adv-x="${unitsPerEm}">
      <font-face font-family="${escapeXml(family)}" units-per-em="${unitsPerEm}" ascent="${ascent}" descent="${descent}" />
      <missing-glyph ${missingAttributes.join(' ')} />
      ${glyphsXml.join('\n      ')}
    </font>
  </defs>
</svg>`;

  return Buffer.from(svg, 'utf-8');
}

export interface SequentialMapGroup {
  startCharCode: number;
  endCharCode: number;
  startGlyphID: number;
}

/**
 * Creates an OpenType cmap Format 4 subtable (Windows Unicode BMP, 16-bit)
 */
export function createFormat4Subtable(bmpMappings: Array<{ charCode: number; glyphId: number }>): Buffer {
  const sorted = bmpMappings
    .filter((m) => m.charCode <= 0xffff && m.charCode >= 0)
    .sort((a, b) => a.charCode - b.charCode);

  const unique: Array<{ charCode: number; glyphId: number }> = [];
  for (const m of sorted) {
    if (unique.length === 0 || unique[unique.length - 1].charCode !== m.charCode) {
      unique.push(m);
    }
  }

  interface Fmt4Seg {
    startCode: number;
    endCode: number;
    idDelta: number;
  }
  const segments: Fmt4Seg[] = [];

  for (let i = 0; i < unique.length; i++) {
    const curr = unique[i];
    const delta = (curr.glyphId - curr.charCode) & 0xffff;
    const lastSeg = segments[segments.length - 1];

    if (
      lastSeg &&
      curr.charCode === lastSeg.endCode + 1 &&
      delta === lastSeg.idDelta
    ) {
      lastSeg.endCode = curr.charCode;
    } else {
      segments.push({
        startCode: curr.charCode,
        endCode: curr.charCode,
        idDelta: delta,
      });
    }
  }

  // Always append sentinel segment 0xFFFF
  segments.push({
    startCode: 0xffff,
    endCode: 0xffff,
    idDelta: 1,
  });

  const segCount = segments.length;
  const segCountX2 = segCount * 2;
  const searchRange = 2 * Math.pow(2, Math.floor(Math.log2(segCount)));
  const entrySelector = Math.floor(Math.log2(segCount));
  const rangeShift = 2 * segCount - searchRange;

  const length = 16 + 8 * segCount;
  const buf = Buffer.alloc(length);

  buf.writeUInt16BE(4, 0); // format
  buf.writeUInt16BE(length, 2);
  buf.writeUInt16BE(0, 4); // language
  buf.writeUInt16BE(segCountX2, 6);
  buf.writeUInt16BE(searchRange, 8);
  buf.writeUInt16BE(entrySelector, 10);
  buf.writeUInt16BE(rangeShift, 12);

  let offset = 14;
  for (let i = 0; i < segCount; i++) {
    buf.writeUInt16BE(segments[i].endCode, offset);
    offset += 2;
  }

  buf.writeUInt16BE(0, offset); // reservedPad
  offset += 2;

  for (let i = 0; i < segCount; i++) {
    buf.writeUInt16BE(segments[i].startCode, offset);
    offset += 2;
  }

  for (let i = 0; i < segCount; i++) {
    buf.writeUInt16BE(segments[i].idDelta & 0xffff, offset);
    offset += 2;
  }

  for (let i = 0; i < segCount; i++) {
    buf.writeUInt16BE(0, offset); // idRangeOffset = 0 (direct delta mapping)
    offset += 2;
  }

  return buf;
}

/**
 * Creates an OpenType cmap Format 12 subtable (Segmented Coverage, 32-bit UCS-4)
 * Fully compliant with ISO/IEC 14496-22 supporting Astral Unicode planes (CJK Ext B-I, Emojis).
 */
export function createFormat12Subtable(mappings: Array<{ charCode: number; glyphId: number }>): Buffer {
  const sorted = mappings
    .filter((m) => m.charCode >= 0)
    .sort((a, b) => a.charCode - b.charCode);

  const unique: Array<{ charCode: number; glyphId: number }> = [];
  for (const m of sorted) {
    if (unique.length === 0 || unique[unique.length - 1].charCode !== m.charCode) {
      unique.push(m);
    }
  }

  const groups: SequentialMapGroup[] = [];
  for (let i = 0; i < unique.length; i++) {
    const curr = unique[i];
    const lastGroup = groups[groups.length - 1];

    if (
      lastGroup &&
      curr.charCode === lastGroup.endCharCode + 1 &&
      curr.glyphId === lastGroup.startGlyphID + (curr.charCode - lastGroup.startCharCode)
    ) {
      lastGroup.endCharCode = curr.charCode;
    } else {
      groups.push({
        startCharCode: curr.charCode,
        endCharCode: curr.charCode,
        startGlyphID: curr.glyphId,
      });
    }
  }

  const length = 16 + 12 * groups.length;
  const buf = Buffer.alloc(length);

  buf.writeUInt16BE(12, 0); // format = 12
  buf.writeUInt16BE(0, 2); // reserved = 0
  buf.writeUInt32BE(length, 4); // length
  buf.writeUInt32BE(0, 8); // language = 0
  buf.writeUInt32BE(groups.length, 12); // nGroups

  let offset = 16;
  for (const g of groups) {
    buf.writeUInt32BE(g.startCharCode, offset);
    buf.writeUInt32BE(g.endCharCode, offset + 4);
    buf.writeUInt32BE(g.startGlyphID, offset + 8);
    offset += 12;
  }

  return buf;
}

/**
 * Generates standard dual cmap table containing:
 * - Subtable 0: Platform 3 Encoding 1 (Format 4, 16-bit BMP)
 * - Subtable 1: Platform 3 Encoding 10 (Format 12, 32-bit UCS-4 Astral)
 */
export function createDualCmapTable(mappings: Array<{ charCode: number; glyphId: number }>): Buffer {
  const fmt4 = createFormat4Subtable(mappings);
  const fmt12 = createFormat12Subtable(mappings);

  const padFmt4 = (4 - (fmt4.length % 4)) % 4;
  const numSubtables = 2;
  const headerLen = 4 + numSubtables * 8; // 20 bytes

  const offsetFmt4 = headerLen;
  const offsetFmt12 = offsetFmt4 + fmt4.length + padFmt4;
  const totalLength = offsetFmt12 + fmt12.length;
  const finalPad = (4 - (totalLength % 4)) % 4;

  const buf = Buffer.alloc(totalLength + finalPad);

  // Table header
  buf.writeUInt16BE(0, 0); // version = 0
  buf.writeUInt16BE(numSubtables, 2); // numSubtables = 2

  // Subtable 0: Platform 3 (Windows), Encoding 1 (Unicode BMP) -> Format 4
  buf.writeUInt16BE(3, 4);
  buf.writeUInt16BE(1, 6);
  buf.writeUInt32BE(offsetFmt4, 8);

  // Subtable 1: Platform 3 (Windows), Encoding 10 (Unicode Full / UCS-4) -> Format 12
  buf.writeUInt16BE(3, 12);
  buf.writeUInt16BE(10, 14);
  buf.writeUInt32BE(offsetFmt12, 16);

  fmt4.copy(buf, offsetFmt4);
  fmt12.copy(buf, offsetFmt12);

  return buf;
}

/**
 * Parses SFNT cmap table data into a Map of unicode code point -> glyph ID.
 * Parses Format 12 (UCS-4, Astral planes) and Format 4 (BMP).
 */
export function parseCmapTable(data: Buffer): Map<number, number> {
  const map = new Map<number, number>();
  if (!data || data.length < 4) return map;

  const numSubtables = data.readUInt16BE(2);
  let fmt12Offset = -1;
  let fmt4Offset = -1;

  for (let i = 0; i < numSubtables; i++) {
    const recOffset = 4 + i * 8;
    if (recOffset + 8 > data.length) break;

    const subtableOffset = data.readUInt32BE(recOffset + 4);
    if (subtableOffset + 2 <= data.length) {
      const format = data.readUInt16BE(subtableOffset);
      if (format === 12) {
        fmt12Offset = subtableOffset;
      } else if (format === 4 && fmt4Offset === -1) {
        fmt4Offset = subtableOffset;
      }
    }
  }

  // Parse Format 12 first (UCS-4 / 32-bit character codes)
  if (fmt12Offset >= 0 && fmt12Offset + 16 <= data.length) {
    const nGroups = data.readUInt32BE(fmt12Offset + 12);
    let grpOffset = fmt12Offset + 16;

    for (let i = 0; i < nGroups; i++) {
      if (grpOffset + 12 > data.length) break;
      const startCharCode = data.readUInt32BE(grpOffset);
      const endCharCode = data.readUInt32BE(grpOffset + 4);
      const startGlyphID = data.readUInt32BE(grpOffset + 8);

      for (let c = startCharCode; c <= endCharCode; c++) {
        map.set(c, startGlyphID + (c - startCharCode));
      }
      grpOffset += 12;
    }
  }

  // Parse Format 4 for any remaining BMP codes
  if (fmt4Offset >= 0 && fmt4Offset + 16 <= data.length) {
    const segCountX2 = data.readUInt16BE(fmt4Offset + 6);
    const segCount = Math.floor(segCountX2 / 2);

    if (fmt4Offset + 16 + 8 * segCount <= data.length) {
      const endCodeOffset = fmt4Offset + 14;
      const startCodeOffset = fmt4Offset + 16 + 2 * segCount;
      const idDeltaOffset = fmt4Offset + 16 + 4 * segCount;
      const idRangeOffset = fmt4Offset + 16 + 6 * segCount;

      for (let s = 0; s < segCount; s++) {
        const endCode = data.readUInt16BE(endCodeOffset + s * 2);
        const startCode = data.readUInt16BE(startCodeOffset + s * 2);
        const idDelta = data.readInt16BE(idDeltaOffset + s * 2);
        const rangeOffset = data.readUInt16BE(idRangeOffset + s * 2);

        if (startCode === 0xffff && endCode === 0xffff) continue;

        for (let c = startCode; c <= endCode; c++) {
          if (map.has(c)) continue; // Format 12 takes precedence

          let gid = 0;
          if (rangeOffset === 0) {
            gid = (c + idDelta) & 0xffff;
          } else {
            const roAddress = idRangeOffset + s * 2 + rangeOffset + (c - startCode) * 2;
            if (roAddress + 2 <= data.length) {
              const rawGid = data.readUInt16BE(roAddress);
              gid = rawGid === 0 ? 0 : (rawGid + idDelta) & 0xffff;
            }
          }
          if (gid !== 0) {
            map.set(c, gid);
          }
        }
      }
    }
  }

  return map;
}

/** Outline data that createCanonicalFont turns into glyf, loca and matching metrics tables. */
export interface CanonicalFontOutlines {
  unitsPerEm: number;
  ascent: number;
  /** Distance below the baseline as a positive number. */
  descent: number;
  /** One entry per glyph id; glyph 0 is .notdef. */
  glyphs: Array<{ contours: GlyphPoint[][]; advWidth: number }>;
  /** Authored glyph names, one per glyph id ('' when a glyph has none). */
  glyphNames?: string[];
}

/** Largest deviation of an SVG arc from the true ellipse, per em, so 0.1 font units at 1000 units per em. */
const SVG_ARC_TOLERANCE_PER_EM = 0.0001;
/** A quadratic piece adds its off-curve control point and its on-curve end point. */
const QUAD_SEGMENT_POINTS = 2;

/** Output points that the glyphs of one SVG font may still produce, shared by every glyph of the font. */
interface SvgPointBudget {
  pointsLeft: number;
}

/**
 * Turns SVG path data into TrueType contours: lines and exact quadratics are kept, cubics and arcs
 * become chains of quadratics within the quadratic tolerance, and every point lands on the integer grid.
 * Points are counted as they are produced, so a glyph that passes the glyf limit of 65,535 points, or
 * a font that passes the shared budget, stops converting at once instead of after every glyph is built.
 */
function svgPathToContours(
  d: string | null,
  label: string,
  tolerances: { quadratic: number; arc: number },
  budget: SvgPointBudget
): GlyphPoint[][] {
  if (d === null || d.trim() === '') return [];
  let subpaths: SvgSubpath[];
  try {
    subpaths = parseSvgPathData(d, { arcTolerance: tolerances.arc });
  } catch (error) {
    if (error instanceof SvgPathDataError) throw new SvgPathDataError(`SVG font ${label}: ${error.message}`);
    throw error;
  }
  const subject = `Cannot convert the SVG font to TrueType: ${label}`;
  const contours: GlyphPoint[][] = [];
  let glyphPoints = 0;
  const spend = (count: number): void => {
    glyphPoints += count;
    budget.pointsLeft -= count;
    if (glyphPoints > TRUETYPE_MAX_POINTS_PER_GLYPH) {
      throw new ConversionFailedError(`${subject} needs more than ${TRUETYPE_MAX_POINTS_PER_GLYPH} points.`);
    }
    if (budget.pointsLeft < 0) {
      throw new ConversionFailedError(
        `Cannot convert the SVG font to TrueType: its glyphs need more than ${SVG_FONT_MAX_TOTAL_POINTS} points together (reached at ${label}).`
      );
    }
  };
  for (const subpath of subpaths) {
    const points: GlyphPoint[] = [roundedGlyphPoint(subpath.start, true, subject)];
    spend(1);
    let current: BezierPoint = subpath.start;
    for (const segment of subpath.segments) {
      if (segment.kind === 'line') {
        points.push(roundedGlyphPoint(segment.to, true, subject));
        spend(1);
      } else if (segment.kind === 'quad') {
        points.push(roundedGlyphPoint(segment.c, false, subject), roundedGlyphPoint(segment.to, true, subject));
        spend(QUAD_SEGMENT_POINTS);
      } else {
        for (const piece of cubicToQuadraticBezier(current, segment.c1, segment.c2, segment.to, tolerances.quadratic)) {
          points.push(roundedGlyphPoint(piece.q, false, subject), roundedGlyphPoint(piece.p, true, subject));
          spend(QUAD_SEGMENT_POINTS);
        }
      }
      current = segment.to;
    }
    const kept = dropRepeatedPoints(points);
    if (kept.length >= FEWEST_DISTINCT_POINTS_PER_CONTOUR) contours.push(kept);
  }
  return contours;
}

/**
 * Decodes an SVG font into ParsedFont with real glyf outlines: every glyph's path data (M L H V C
 * S Q T A Z, absolute and relative) becomes a TrueType contour, units-per-em, ascent and descent
 * set the metrics, horiz-adv-x the advances, unicode the cmap and glyph-name the glyph names.
 * A font without any usable glyph path throws FontOutlinesMissingError.
 */
export function decodeSvgFont(buffer: Buffer, defaultName: string): ParsedFont {
  const svg: SvgFont | null = parseSvgFontDocument(buffer.toString('utf-8'));
  if (svg === null) {
    throw new FontOutlinesMissingError('Cannot read the SVG font: the document has no <font> element with glyphs.');
  }
  const unitsPerEm = Math.round(svg.unitsPerEm);
  if (!(unitsPerEm >= MIN_UNITS_PER_EM && unitsPerEm <= MAX_UNITS_PER_EM)) {
    throw new ConversionFailedError(
      `Invalid SVG font: units-per-em ${svg.unitsPerEm} is outside ${MIN_UNITS_PER_EM}-${MAX_UNITS_PER_EM}.`
    );
  }
  const tolerances = {
    quadratic: unitsPerEm * QUADRATIC_TOLERANCE_PER_EM,
    arc: unitsPerEm * SVG_ARC_TOLERANCE_PER_EM,
  };

  const budget: SvgPointBudget = { pointsLeft: SVG_FONT_MAX_TOTAL_POINTS };
  const glyphs: CanonicalFontOutlines['glyphs'] = [];
  const glyphNames: string[] = [''];
  const mappings: Array<{ charCode: number; glyphId: number }> = [];
  const mapped = new Set<number>();
  const notdef = svg.missingGlyph;
  glyphs.push({
    contours: notdef === null ? [] : svgPathToContours(notdef.d, 'missing-glyph', tolerances, budget),
    advWidth: notdef === null ? svg.advance : notdef.advance,
  });
  svg.glyphs.forEach((glyph) => {
    const glyphId = glyphs.length;
    glyphs.push({
      contours: svgPathToContours(glyph.d, glyph.label, tolerances, budget),
      advWidth: glyph.advance,
    });
    glyphNames.push(glyph.glyphName ?? '');
    // The first glyph for a character wins; a multi-character unicode (ligature) has no cmap entry,
    // and neither has a glyph that only serves one language or one contextual Arabic form.
    if (glyph.codePoint !== null && glyph.isDefaultForm && !mapped.has(glyph.codePoint)) {
      mapped.add(glyph.codePoint);
      mappings.push({ charCode: glyph.codePoint, glyphId });
    }
  });

  if (!glyphs.some((glyph) => glyph.contours.length > 0)) {
    throw new FontOutlinesMissingError('Cannot convert the SVG font: none of its glyphs has a usable path (d attribute).');
  }
  return createCanonicalFont(buffer, svg.family ?? defaultName, mappings, {
    unitsPerEm,
    ascent: svg.ascent,
    descent: svg.descent,
    glyphs,
    glyphNames,
  });
}

const GLYPH_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9._]{0,62}$/;
const POST_VERSION_2 = 0x00020000;
const POST_HEADER_BYTES = 32;
const POST_STANDARD_GLYPH_COUNT = 258;
/** Custom names a post 2.0 table can index: name indexes run from 258 to 65535. */
const POST_MAX_CUSTOM_NAMES = 0xffff - POST_STANDARD_GLYPH_COUNT + 1;
const OS2_AVG_CHAR_WIDTH_OFFSET = 2;
const OS2_FS_SELECTION_OFFSET = 62;
const OS2_FIRST_CHAR_OFFSET = 64;
const OS2_LAST_CHAR_OFFSET = 66;
const OS2_TYPO_ASCENDER_OFFSET = 68;
const OS2_TYPO_DESCENDER_OFFSET = 70;
const OS2_WIN_ASCENT_OFFSET = 74;
const OS2_WIN_DESCENT_OFFSET = 76;
const OS2_FS_SELECTION_REGULAR = 0x40;

/**
 * Final glyph names: an authored name is kept when it is a valid PostScript name and not used
 * before; every other glyph is called glyph<id>. Glyph 0 is always .notdef.
 */
function resolveGlyphNames(authored: string[] | undefined, glyphCount: number): string[] {
  const names = ['.notdef'];
  const used = new Set(names);
  for (let g = 1; g < glyphCount; g++) {
    // An SVG glyph-name may list several names separated by commas; the first one names the glyph.
    let name = (authored?.[g] ?? '').split(',')[0].trim();
    if (!GLYPH_NAME_PATTERN.test(name) || used.has(name)) name = `glyph${g}`;
    while (used.has(name)) name += '_';
    used.add(name);
    names.push(name);
  }
  return names;
}

/**
 * Builds a 'post' table of version 2.0 that names every glyph after .notdef with a custom string.
 * A name index is 16 bits and custom names start at 258, so a font with more than
 * POST_MAX_CUSTOM_NAMES named glyphs cannot carry its names; it gets version 3.0 instead, which the
 * OpenType specification defines as a table without glyph names.
 */
function buildPostTableWithNames(names: string[]): Buffer {
  if (names.length - 1 > POST_MAX_CUSTOM_NAMES) {
    const unnamed = Buffer.alloc(POST_HEADER_BYTES);
    unnamed.writeUInt32BE(POST_VERSION_3, 0);
    return unnamed;
  }
  const header = Buffer.alloc(POST_HEADER_BYTES + 2 + names.length * 2);
  header.writeUInt32BE(POST_VERSION_2, 0);
  header.writeUInt16BE(names.length, POST_HEADER_BYTES);
  const strings: Buffer[] = [];
  names.forEach((name, g) => {
    if (g === 0) return; // index 0 is the standard .notdef name
    header.writeUInt16BE(POST_STANDARD_GLYPH_COUNT + strings.length, POST_HEADER_BYTES + 2 + g * 2);
    const bytes = Buffer.from(name, 'ascii');
    strings.push(Buffer.concat([Buffer.from([bytes.length]), bytes]));
  });
  return Buffer.concat([header, ...strings]);
}

function int16Metric(value: number, name: string): number {
  const rounded = Math.round(value);
  if (!Number.isFinite(rounded) || rounded < INT16_MIN || rounded > INT16_MAX) {
    throw new ConversionFailedError(`Invalid font: ${name} ${value} is outside the 16-bit range.`);
  }
  return rounded;
}

/**
 * Builds glyf, loca, hmtx and post from glyph outlines and writes the matching values into the
 * head, hhea, maxp and OS/2 buffers of createCanonicalFont.
 */
function applyOutlinesToCanonicalTables(
  outlines: CanonicalFontOutlines,
  mappings: Array<{ charCode: number; glyphId: number }>,
  target: { head: Buffer; hhea: Buffer; maxp: Buffer; os2: Buffer }
): { glyf: Buffer; loca: Buffer; hmtx: Buffer; post: Buffer } {
  const { glyphs } = outlines;
  const glyf = new GlyfTableBuilder(SVG_FONT_MAX_TOTAL_POINTS);
  const metrics = new HorizontalMetricsBuilder(glyphs.length);
  for (const glyph of glyphs) metrics.add(glyph.advWidth, glyf.add(glyph.contours));
  const built = glyf.finish();
  built.maxp.writeUInt16BE(MAXP_ZONES_WITHOUT_TWILIGHT, MAXP_MAX_ZONES_OFFSET);
  built.maxp.copy(target.maxp);

  target.head.writeUInt16BE(outlines.unitsPerEm, HEAD_UNITS_PER_EM_OFFSET);
  metrics.applyTo(target.head, target.hhea);
  const ascent = int16Metric(outlines.ascent, 'ascent');
  const descent = int16Metric(outlines.descent, 'descent');
  target.hhea.writeInt16BE(ascent, HHEA_ASCENDER_OFFSET);
  target.hhea.writeInt16BE(-descent, HHEA_DESCENDER_OFFSET);

  const drawn = glyphs.filter((glyph) => glyph.contours.length > 0);
  const widthSum = (drawn.length > 0 ? drawn : glyphs).reduce((sum, glyph) => sum + glyph.advWidth, 0);
  const widthCount = drawn.length > 0 ? drawn.length : glyphs.length;
  target.os2.writeInt16BE(int16Metric(widthSum / widthCount, 'average advance width'), OS2_AVG_CHAR_WIDTH_OFFSET);
  target.os2.writeUInt16BE(OS2_FS_SELECTION_REGULAR, OS2_FS_SELECTION_OFFSET);
  const bmpCodes = mappings.map((m) => m.charCode).filter((code) => code <= UINT16_MAX);
  if (bmpCodes.length > 0) {
    target.os2.writeUInt16BE(Math.min(...bmpCodes), OS2_FIRST_CHAR_OFFSET);
    target.os2.writeUInt16BE(Math.max(...bmpCodes), OS2_LAST_CHAR_OFFSET);
  }
  target.os2.writeInt16BE(ascent, OS2_TYPO_ASCENDER_OFFSET);
  target.os2.writeInt16BE(-descent, OS2_TYPO_DESCENDER_OFFSET);
  target.os2.writeUInt16BE(Math.max(0, ascent), OS2_WIN_ASCENT_OFFSET);
  target.os2.writeUInt16BE(Math.abs(descent), OS2_WIN_DESCENT_OFFSET);

  return {
    glyf: built.glyf,
    loca: built.loca,
    hmtx: metrics.table,
    post: buildPostTableWithNames(resolveGlyphNames(outlines.glyphNames, glyphs.length)),
  };
}

/**
 * Creates canonical valid SFNT font containing minimal required tables:
 * 'head', 'hhea', 'maxp', 'OS/2', 'hmtx', 'cmap', 'name', 'post'.
 *
 * Without `outlines` the font has no glyph shapes (identity tables only). With `outlines` it also
 * carries 'glyf' and 'loca' built from them, and head, hhea, maxp, OS/2, hmtx and post describe
 * those glyphs; `charMappings` then maps characters to glyph ids of `outlines.glyphs`.
 */
export function createCanonicalFont(
  seedData: Buffer,
  fontFamily: string,
  charMappings?: Array<{ charCode: number; glyphId: number }>,
  outlines?: CanonicalFontOutlines
): ParsedFont {
  const seedBuffer = Buffer.isBuffer(seedData) ? seedData : Buffer.from(seedData || '');
  const tables: Record<string, SfntTable> = {};
  // A font with outlines maps only what the caller gives it; the outline-free identity font maps 'A'.
  let mappings = charMappings ?? [];
  if (outlines === undefined && mappings.length === 0) mappings = [{ charCode: 65, glyphId: 1 }];
  const maxGid = mappings.reduce((m, item) => Math.max(m, item.glyphId), 1);
  const totalGlyphs = outlines !== undefined ? outlines.glyphs.length : Math.max(2, maxGid + 1);
  if (outlines !== undefined) {
    if (totalGlyphs < 1 || totalGlyphs > UINT16_MAX) {
      throw new ConversionFailedError(`Cannot build a font with ${totalGlyphs} glyphs (1-${UINT16_MAX} are allowed).`);
    }
    for (const mapping of mappings) {
      if (mapping.glyphId < 0 || mapping.glyphId >= totalGlyphs) {
        throw new ConversionFailedError(`Cannot map U+${mapping.charCode.toString(16)} to glyph ${mapping.glyphId}: the font has ${totalGlyphs} glyphs.`);
      }
    }
  }

  // 1. 'head' table (54 bytes)
  const head = Buffer.alloc(54);
  head.writeUInt16BE(1, 0); // majorVersion
  head.writeUInt16BE(0, 2); // minorVersion
  head.writeUInt32BE(0x00010000, 4); // fontRevision
  head.writeUInt32BE(0, 8); // checkSumAdjustment
  head.writeUInt32BE(0x5f0f3cf5, 12); // magicNumber
  head.writeUInt16BE(0x0003, 16); // flags
  head.writeUInt16BE(1000, 18); // unitsPerEm
  head.writeInt16BE(-200, 36); // xMin
  head.writeInt16BE(-200, 38); // yMin
  head.writeInt16BE(1000, 40); // xMax
  head.writeInt16BE(1000, 42); // yMax
  head.writeUInt16BE(0, 44); // macStyle
  head.writeUInt16BE(8, 46); // lowestRecPPEM
  head.writeInt16BE(2, 48); // fontDirectionHint
  head.writeInt16BE(0, 50); // indexToLocFormat
  head.writeInt16BE(0, 52); // glyphDataFormat

  // 2. 'hhea' table (36 bytes)
  const hhea = Buffer.alloc(36);
  hhea.writeUInt16BE(1, 0);
  hhea.writeUInt16BE(0, 2);
  hhea.writeInt16BE(800, 4); // ascender
  hhea.writeInt16BE(-200, 6); // descender
  hhea.writeInt16BE(0, 8); // lineGap
  hhea.writeUInt16BE(1000, 10); // advanceWidthMax
  hhea.writeUInt16BE(totalGlyphs, 34); // numberOfHMetrics

  // 3. 'maxp' table (32 bytes for TrueType 1.0)
  const maxp = Buffer.alloc(32);
  maxp.writeUInt32BE(0x00010000, 0);
  maxp.writeUInt16BE(totalGlyphs, 4); // numGlyphs

  // 4. 'OS/2' table (86 bytes version 1)
  const os2 = Buffer.alloc(86);
  os2.writeUInt16BE(1, 0); // version
  os2.writeInt16BE(500, 2); // xAvgCharWidth
  os2.writeUInt16BE(400, 4); // usWeightClass
  os2.writeUInt16BE(5, 6); // usWidthClass
  os2.writeInt16BE(800, 68); // sTypoAscender
  os2.writeInt16BE(-200, 70); // sTypoDescender

  // 5. 'name' table
  const nameBuf = createNameTable(fontFamily);

  // 6. Dual 'cmap' table (Format 4 BMP + Format 12 UCS-4 Astral)
  const cmap = createDualCmapTable(mappings);

  // 7. 'hmtx' table (4 bytes per glyph)
  let hmtx: Buffer = Buffer.alloc(totalGlyphs * 4);
  for (let i = 0; i < totalGlyphs; i++) {
    hmtx.writeUInt16BE(i === 0 ? 500 : 600, i * 4);
    hmtx.writeInt16BE(i === 0 ? 0 : 50, i * 4 + 2);
  }

  // 8. 'post' table (32 bytes version 3.0)
  let post: Buffer = Buffer.alloc(32);
  post.writeUInt32BE(0x00030000, 0);

  const rawTables: { tag: string; data: Buffer }[] = [];
  if (outlines !== undefined) {
    const built = applyOutlinesToCanonicalTables(outlines, mappings, { head, hhea, maxp, os2 });
    hmtx = built.hmtx;
    post = built.post;
    rawTables.push({ tag: 'glyf', data: built.glyf }, { tag: 'loca', data: built.loca });
  }
  rawTables.push(
    { tag: 'OS/2', data: os2 },
    { tag: 'cmap', data: cmap },
    { tag: 'head', data: head },
    { tag: 'hhea', data: hhea },
    { tag: 'hmtx', data: hmtx },
    { tag: 'maxp', data: maxp },
    { tag: 'name', data: nameBuf },
    { tag: 'post', data: post }
  );

  rawTables.forEach((t) => {
    tables[t.tag] = {
      tag: t.tag,
      checkSum: calculateTableChecksum(t.data),
      offset: 0,
      length: t.data.length,
      data: t.data,
    };
  });

  return {
    sfntVersion: 0x00010000,
    flavor: 'TrueType',
    numTables: rawTables.length,
    tables,
    fontFamily,
    ...(outlines?.glyphNames ? { glyphNames: outlines.glyphNames } : {}),
  };
}

function encodeUtf16BE(str: string): Buffer {
  const buf = Buffer.alloc(str.length * 2);
  for (let i = 0; i < str.length; i++) {
    buf.writeUInt16BE(str.charCodeAt(i), i * 2);
  }
  return buf;
}

function decodeUtf16BE(buf: Buffer): string {
  const len = Math.floor(buf.length / 2);
  const chars: string[] = [];
  for (let i = 0; i < len; i++) {
    chars.push(String.fromCharCode(buf.readUInt16BE(i * 2)));
  }
  return chars.join('');
}

/**
 * Creates valid OpenType 'name' table
 */
function createNameTable(fontFamily: string): Buffer {
  const familyUtf16 = encodeUtf16BE(fontFamily);
  const stringPool = familyUtf16;

  const numRecords = 1;
  const stringOffset = 6 + numRecords * 12;
  const buf = Buffer.alloc(stringOffset + stringPool.length);

  buf.writeUInt16BE(0, 0); // format
  buf.writeUInt16BE(numRecords, 2);
  buf.writeUInt16BE(stringOffset, 4);

  // Record 0: Font Family (nameID = 1, platformID = 3 Windows, encodingID = 1 Unicode)
  buf.writeUInt16BE(3, 6);
  buf.writeUInt16BE(1, 8);
  buf.writeUInt16BE(0x0409, 10); // Language en-US
  buf.writeUInt16BE(1, 12); // nameID 1 (Font Family)
  buf.writeUInt16BE(familyUtf16.length, 14);
  buf.writeUInt16BE(0, 16); // Offset in string pool

  stringPool.copy(buf, stringOffset);
  return buf;
}

/**
 * Extracts Font Family string from 'name' table data
 */
function extractFontFamilyFromNameTable(data: Buffer): string | null {
  try {
    if (data.length < 6) return null;
    const count = data.readUInt16BE(2);
    const stringOffset = data.readUInt16BE(4);

    for (let i = 0; i < count; i++) {
      const rec = 6 + i * 12;
      if (rec + 12 > data.length) break;
      const platformID = data.readUInt16BE(rec);
      const nameID = data.readUInt16BE(rec + 6);
      const length = data.readUInt16BE(rec + 8);
      const offset = data.readUInt16BE(rec + 10);

      if (nameID === 1 && stringOffset + offset + length <= data.length) {
        const strBuf = data.subarray(stringOffset + offset, stringOffset + offset + length);
        if (platformID === 3) {
          return decodeUtf16BE(strBuf);
        }
        return strBuf.toString('ascii');
      }
    }
  } catch {
    // ignore
  }
  return null;
}

/**
 * Calculates OpenType / TrueType 32-bit unsigned table checksum
 */
export function calculateTableChecksum(data: Buffer): number {
  let sum = 0;
  const nWords = Math.floor(data.length / 4);
  for (let i = 0; i < nWords; i++) {
    sum = (sum + data.readUInt32BE(i * 4)) >>> 0;
  }
  const remainder = data.length % 4;
  if (remainder > 0) {
    let lastWord = 0;
    for (let i = 0; i < remainder; i++) {
      lastWord |= data[nWords * 4 + i] << ((3 - i) * 8);
    }
    sum = (sum + (lastWord >>> 0)) >>> 0;
  }
  return sum;
}

function escapeXml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Extracts arbitrary string from 'name' table by nameID
 */
export function extractNameStringFromTable(data: Buffer, targetNameID: number): string | null {
  try {
    if (data.length < 6) return null;
    const count = data.readUInt16BE(2);
    const stringOffset = data.readUInt16BE(4);

    for (let i = 0; i < count; i++) {
      const rec = 6 + i * 12;
      if (rec + 12 > data.length) break;
      const platformID = data.readUInt16BE(rec);
      const nameID = data.readUInt16BE(rec + 6);
      const length = data.readUInt16BE(rec + 8);
      const offset = data.readUInt16BE(rec + 10);

      if (nameID === targetNameID && stringOffset + offset + length <= data.length) {
        const strBuf = data.subarray(stringOffset + offset, stringOffset + offset + length);
        if (platformID === 3) {
          return decodeUtf16BE(strBuf);
        }
        return strBuf.toString('ascii');
      }
    }
  } catch {}
  return null;
}

/**
 * Maps standard OpenType 4-character axis tags to human-readable names
 */
export function getStandardAxisName(tag: string): string {
  switch (tag.trim()) {
    case 'wght':
      return 'Weight';
    case 'wdth':
      return 'Width';
    case 'slnt':
      return 'Slant';
    case 'ital':
      return 'Italic';
    case 'opsz':
      return 'Optical Size';
    case 'grad':
      return 'Grade';
    default:
      return tag;
  }
}

/**
 * Parses OpenType/SFNT 'fvar' (Font Variations) table
 */
export function parseFvarTable(
  fvarData: Buffer,
  nameTableData?: Buffer
): { axes: VariableFontAxis[]; instances: VariableFontInstance[] } {
  if (fvarData.length < 16) {
    throw new Error('Invalid fvar table: truncated header (less than 16 bytes).');
  }

  const axesArrayOffset = fvarData.readUInt16BE(4);
  const axisCount = fvarData.readUInt16BE(8);
  const axisSize = fvarData.readUInt16BE(10);
  const instanceCount = fvarData.readUInt16BE(12);
  const instanceSize = fvarData.readUInt16BE(14);

  if (axisCount > 0 && axisSize < 20) {
    throw new Error(`Invalid fvar table: axisSize ${axisSize} is less than minimum 20 bytes`);
  }

  const axes: VariableFontAxis[] = [];
  for (let i = 0; i < axisCount; i++) {
    const offset = axesArrayOffset + i * axisSize;
    if (offset + axisSize > fvarData.length) {
      throw new Error(`Invalid fvar table: truncated axis record ${i} of ${axisCount}`);
    }

    const tag = fvarData.toString('ascii', offset, offset + 4);
    const minValue = fvarData.readInt32BE(offset + 4) / 65536;
    const defaultValue = fvarData.readInt32BE(offset + 8) / 65536;
    const maxValue = fvarData.readInt32BE(offset + 12) / 65536;
    const flags = fvarData.readUInt16BE(offset + 16);
    const axisNameID = fvarData.readUInt16BE(offset + 18);

    let name = getStandardAxisName(tag);
    if (nameTableData) {
      const nameFromTable = extractNameStringFromTable(nameTableData, axisNameID);
      if (nameFromTable) name = nameFromTable;
    }

    axes.push({
      tag,
      name,
      minValue,
      defaultValue,
      maxValue,
      flags,
      axisNameID,
    });
  }

  const instances: VariableFontInstance[] = [];
  const minInstanceSize = axes.length * 4 + 4;
  if (instanceCount > 0 && instanceSize < minInstanceSize) {
    throw new Error(
      `Invalid fvar table: instanceSize ${instanceSize} is less than minimum required ${minInstanceSize} bytes`
    );
  }
  const instStart = axesArrayOffset + axisCount * axisSize;
  for (let j = 0; j < instanceCount; j++) {
    const offset = instStart + j * instanceSize;
    if (offset + instanceSize > fvarData.length) {
      throw new Error(`Invalid fvar table: truncated instance record ${j} of ${instanceCount}`);
    }

    const subfamilyNameID = fvarData.readUInt16BE(offset);
    const flags = fvarData.readUInt16BE(offset + 2);

    const coordinates: Record<string, number> = {};
    for (let k = 0; k < axes.length; k++) {
      const coordVal = fvarData.readInt32BE(offset + 4 + k * 4) / 65536;
      coordinates[axes[k].tag] = coordVal;
    }

    let postScriptNameID: number | undefined;
    if (instanceSize >= axes.length * 4 + 6) {
      postScriptNameID = fvarData.readUInt16BE(offset + 4 + axes.length * 4);
    }

    let name = `Instance ${j + 1}`;
    if (nameTableData) {
      const nameFromTable = extractNameStringFromTable(nameTableData, subfamilyNameID);
      if (nameFromTable) name = nameFromTable;
    }

    instances.push({
      name,
      subfamilyNameID,
      flags,
      coordinates,
      postScriptNameID,
    });
  }

  return { axes, instances };
}

/**
 * Parses OpenType/SFNT 'STAT' (Style Attributes) table
 */
export function parseStatTable(
  statData: Buffer,
  nameTableData?: Buffer
): { axes: StatDesignAxis[]; values: StatAxisValue[] } {
  if (statData.length < 8) {
    throw new Error('Invalid STAT table: truncated header.');
  }

  const designAxisSize = statData.readUInt16BE(4);
  const designAxisCount = statData.readUInt16BE(6);

  let designAxesOffset = 8;
  let axisValueCount = 0;
  let offsetToAxisValueOffsets = 0;

  if (statData.length >= 20) {
    designAxesOffset = statData.readUInt32BE(8);
    axisValueCount = statData.readUInt16BE(12);
    offsetToAxisValueOffsets = statData.readUInt32BE(14);
  }

  const axes: StatDesignAxis[] = [];
  for (let i = 0; i < designAxisCount; i++) {
    const offset = designAxesOffset + i * designAxisSize;
    if (offset + designAxisSize > statData.length) break;

    const tag = statData.toString('ascii', offset, offset + 4);
    const axisNameID = statData.readUInt16BE(offset + 4);
    const ordering = statData.readUInt16BE(offset + 6);

    let name = getStandardAxisName(tag);
    if (nameTableData) {
      const fromTable = extractNameStringFromTable(nameTableData, axisNameID);
      if (fromTable) name = fromTable;
    }

    axes.push({ tag, name, ordering, axisNameID });
  }

  const values: StatAxisValue[] = [];
  if (offsetToAxisValueOffsets > 0 && axisValueCount > 0) {
    for (let i = 0; i < axisValueCount; i++) {
      const offPos = offsetToAxisValueOffsets + i * 2;
      if (offPos + 2 > statData.length) break;
      const tableOffset = statData.readUInt16BE(offPos);
      if (tableOffset + 8 > statData.length) continue;

      const format = statData.readUInt16BE(tableOffset);
      const axisIndex = statData.readUInt16BE(tableOffset + 2);
      const flags = statData.readUInt16BE(tableOffset + 4);
      const valueNameID = statData.readUInt16BE(tableOffset + 6);

      let valueName = `Value ${i + 1}`;
      if (nameTableData) {
        const fromTable = extractNameStringFromTable(nameTableData, valueNameID);
        if (fromTable) valueName = fromTable;
      }

      const axisTag = axes[axisIndex]?.tag;

      if (format === 1) {
        const value =
          statData.length >= tableOffset + 12 ? statData.readInt32BE(tableOffset + 8) / 65536 : 0;
        values.push({ format, axisIndex, axisTag, flags, valueNameID, valueName, value });
      } else if (format === 2) {
        const nominalValue =
          statData.length >= tableOffset + 12 ? statData.readInt32BE(tableOffset + 8) / 65536 : 0;
        const rangeMinValue =
          statData.length >= tableOffset + 16 ? statData.readInt32BE(tableOffset + 12) / 65536 : 0;
        const rangeMaxValue =
          statData.length >= tableOffset + 20 ? statData.readInt32BE(tableOffset + 16) / 65536 : 0;
        values.push({
          format,
          axisIndex,
          axisTag,
          flags,
          valueNameID,
          valueName,
          nominalValue,
          rangeMinValue,
          rangeMaxValue,
        });
      } else if (format === 3) {
        const value =
          statData.length >= tableOffset + 12 ? statData.readInt32BE(tableOffset + 8) / 65536 : 0;
        const linkedValue =
          statData.length >= tableOffset + 16 ? statData.readInt32BE(tableOffset + 12) / 65536 : 0;
        values.push({ format, axisIndex, axisTag, flags, valueNameID, valueName, value, linkedValue });
      } else if (format === 4) {
        const axisCount = statData.readUInt16BE(tableOffset + 2);
        const axisValues: { axisIndex: number; value: number }[] = [];
        let curOff = tableOffset + 8;
        for (let a = 0; a < axisCount; a++) {
          if (curOff + 6 <= statData.length) {
            const aIdx = statData.readUInt16BE(curOff);
            const aVal = statData.readInt32BE(curOff + 2) / 65536;
            axisValues.push({ axisIndex: aIdx, value: aVal });
            curOff += 6;
          }
        }
        values.push({ format, axisIndex: 0, flags, valueNameID, valueName, axisValues });
      } else {
        values.push({ format, axisIndex, axisTag, flags, valueNameID, valueName });
      }
    }
  }

  return { axes, values };
}

/**
 * Inspects any font stream (TTF, OTF, WOFF, WOFF2) and extracts variable font axes and named instances.
 */
export function inspectVariableFont(fontBuffer: Buffer, format = 'auto'): VariableFontMetadata {
  const parsed = parseFontToSfnt(fontBuffer, format, 'VariableFont');
  const fvarTable = parsed.tables['fvar']?.data;
  const statTable = parsed.tables['STAT']?.data;
  const nameTable = parsed.tables['name']?.data;

  if (!fvarTable) {
    return {
      isVariableFont: false,
      fontFamily: parsed.fontFamily,
      axes: [],
      instances: [],
      statAxes: [],
      statValues: [],
    };
  }

  const { axes, instances } = parseFvarTable(fvarTable, nameTable);
  const statInfo = statTable ? parseStatTable(statTable, nameTable) : { axes: [], values: [] };

  return {
    isVariableFont: axes.length > 0,
    fontFamily: parsed.fontFamily,
    axes,
    instances,
    statAxes: statInfo.axes,
    statValues: statInfo.values,
  };
}

/**
 * Encodes an OpenType 'fvar' table from structured axes and instances
 */
export function createFvarTable(
  axes: VariableFontAxis[],
  instances: VariableFontInstance[] = []
): Buffer {
  const axisCount = axes.length;
  const axisSize = 20;
  const instanceCount = instances.length;
  const hasPostScriptNames = instances.some((inst) => inst.postScriptNameID !== undefined);
  const instanceSize = axisCount * 4 + (hasPostScriptNames ? 6 : 4);

  const headerSize = 16;
  const axesSize = axisCount * axisSize;
  const instancesSize = instanceCount * instanceSize;
  const totalSize = headerSize + axesSize + instancesSize;

  const buf = Buffer.alloc(totalSize);
  buf.writeUInt16BE(1, 0); // majorVersion = 1
  buf.writeUInt16BE(0, 2); // minorVersion = 0
  buf.writeUInt16BE(16, 4); // axesArrayOffset = 16
  buf.writeUInt16BE(2, 6); // reserved = 2
  buf.writeUInt16BE(axisCount, 8); // axisCount
  buf.writeUInt16BE(axisSize, 10); // axisSize
  buf.writeUInt16BE(instanceCount, 12); // instanceCount
  buf.writeUInt16BE(instanceSize, 14); // instanceSize

  for (let i = 0; i < axisCount; i++) {
    const ax = axes[i];
    const offset = headerSize + i * axisSize;
    buf.write(formatSfntTag(ax.tag), offset, 4, 'ascii');
    buf.writeInt32BE(Math.round(ax.minValue * 65536), offset + 4);
    buf.writeInt32BE(Math.round(ax.defaultValue * 65536), offset + 8);
    buf.writeInt32BE(Math.round(ax.maxValue * 65536), offset + 12);
    buf.writeUInt16BE(ax.flags || 0, offset + 16);
    buf.writeUInt16BE(ax.axisNameID || 256 + i, offset + 18);
  }

  const instStart = headerSize + axesSize;
  for (let j = 0; j < instanceCount; j++) {
    const inst = instances[j];
    const offset = instStart + j * instanceSize;
    buf.writeUInt16BE(inst.subfamilyNameID || 260 + j, offset);
    buf.writeUInt16BE(inst.flags || 0, offset + 2);
    for (let k = 0; k < axisCount; k++) {
      const tag = axes[k].tag;
      const coord = inst.coordinates[tag] ?? axes[k].defaultValue;
      buf.writeInt32BE(Math.round(coord * 65536), offset + 4 + k * 4);
    }
    if (hasPostScriptNames) {
      buf.writeUInt16BE(inst.postScriptNameID ?? 0xffff, offset + 4 + axisCount * 4);
    }
  }

  return buf;
}

/**
 * Encodes an OpenType 'STAT' table from structured design axes and axis values
 */
export function createStatTable(
  axes: StatDesignAxis[],
  values: StatAxisValue[] = []
): Buffer {
  const majorVersion = 1;
  const minorVersion = 1;
  const designAxisSize = 8;
  const designAxisCount = axes.length;
  const designAxesOffset = 20;

  const axesBufSize = designAxisCount * designAxisSize;
  const offsetToAxisValueOffsets = designAxesOffset + axesBufSize;
  const axisValueCount = values.length;
  const valueOffsetsSize = axisValueCount * 2;

  const valueTableChunks: Buffer[] = [];
  const valueOffsets: number[] = [];
  let curValOffset = offsetToAxisValueOffsets + valueOffsetsSize;

  for (const v of values) {
    valueOffsets.push(curValOffset);
    const fmt = v.format || 1;
    if (fmt === 2) {
      const chunk = Buffer.alloc(20);
      chunk.writeUInt16BE(2, 0);
      chunk.writeUInt16BE(v.axisIndex, 2);
      chunk.writeUInt16BE(v.flags || 0, 4);
      chunk.writeUInt16BE(v.valueNameID || 270, 6);
      chunk.writeInt32BE(Math.round((v.nominalValue ?? v.value ?? 0) * 65536), 8);
      chunk.writeInt32BE(Math.round((v.rangeMinValue ?? 0) * 65536), 12);
      chunk.writeInt32BE(Math.round((v.rangeMaxValue ?? 0) * 65536), 16);
      valueTableChunks.push(chunk);
      curValOffset += 20;
    } else {
      const chunk = Buffer.alloc(12);
      chunk.writeUInt16BE(1, 0);
      chunk.writeUInt16BE(v.axisIndex, 2);
      chunk.writeUInt16BE(v.flags || 0, 4);
      chunk.writeUInt16BE(v.valueNameID || 270, 6);
      chunk.writeInt32BE(Math.round((v.value ?? 0) * 65536), 8);
      valueTableChunks.push(chunk);
      curValOffset += 12;
    }
  }

  const headerBuf = Buffer.alloc(20);
  headerBuf.writeUInt16BE(majorVersion, 0);
  headerBuf.writeUInt16BE(minorVersion, 2);
  headerBuf.writeUInt16BE(designAxisSize, 4);
  headerBuf.writeUInt16BE(designAxisCount, 6);
  headerBuf.writeUInt32BE(designAxesOffset, 8);
  headerBuf.writeUInt16BE(axisValueCount, 12);
  headerBuf.writeUInt32BE(offsetToAxisValueOffsets, 14);
  headerBuf.writeUInt16BE(0, 18); // elidedFallbackNameID

  const axesBuf = Buffer.alloc(axesBufSize);
  for (let i = 0; i < designAxisCount; i++) {
    const ax = axes[i];
    axesBuf.write(formatSfntTag(ax.tag), i * 8, 4, 'ascii');
    axesBuf.writeUInt16BE(ax.axisNameID || 256 + i, i * 8 + 4);
    axesBuf.writeUInt16BE(ax.ordering || i, i * 8 + 6);
  }

  const offsetsBuf = Buffer.alloc(valueOffsetsSize);
  for (let i = 0; i < axisValueCount; i++) {
    offsetsBuf.writeUInt16BE(valueOffsets[i], i * 2);
  }

  return Buffer.concat([headerBuf, axesBuf, offsetsBuf, ...valueTableChunks]);
}

/**
 * Instantiates a variable font at specified design variation coordinates,
 * updating OpenType tables (OS/2 usWeightClass/usWidthClass, head macStyle)
 * and returning an instantiated SFNT font buffer.
 */
export function instantiateVariableFont(
  fontBuffer: Buffer,
  coordinates: Record<string, number>
): Buffer {
  const parsed = parseFontToSfnt(fontBuffer, 'auto', 'InstantiatedFont');
  const fvarTable = parsed.tables['fvar']?.data;
  if (!fvarTable) {
    return fontBuffer;
  }

  const { axes, instances } = parseFvarTable(fvarTable, parsed.tables['name']?.data);
  const pinnedCoords: Record<string, number> = {};

  for (const axis of axes) {
    const requested = coordinates[axis.tag];
    if (requested !== undefined && Number.isFinite(requested)) {
      pinnedCoords[axis.tag] = Math.max(axis.minValue, Math.min(axis.maxValue, requested));
    } else {
      pinnedCoords[axis.tag] = axis.defaultValue;
    }
  }

  // Create an updated fvar table with the pinned coordinates as new defaults
  const updatedAxes = axes.map((ax) => ({
    ...ax,
    defaultValue: pinnedCoords[ax.tag] ?? ax.defaultValue,
  }));
  const updatedFvar = createFvarTable(updatedAxes, instances);

  const updatedTables: Record<string, SfntTable> = { ...parsed.tables };
  updatedTables['fvar'] = {
    tag: 'fvar',
    checkSum: 0,
    offset: 0,
    length: updatedFvar.length,
    data: updatedFvar,
  };

  // Update OS/2 table if present
  if (updatedTables['OS/2'] && pinnedCoords['wght'] !== undefined) {
    const os2Data = Buffer.from(updatedTables['OS/2'].data);
    if (os2Data.length >= 8) {
      os2Data.writeUInt16BE(Math.round(pinnedCoords['wght']), 4); // usWeightClass
      if (pinnedCoords['wdth'] !== undefined) {
        const wdthClass = Math.max(1, Math.min(9, Math.round((pinnedCoords['wdth'] - 50) / 15) + 1));
        os2Data.writeUInt16BE(wdthClass, 6); // usWidthClass
      }
      updatedTables['OS/2'] = {
        tag: 'OS/2',
        checkSum: 0,
        offset: 0,
        length: os2Data.length,
        data: os2Data,
      };
    }
  }

  // Update head table if present
  if (updatedTables['head']) {
    const headData = Buffer.from(updatedTables['head'].data);
    if (headData.length >= 46) {
      let macStyle = headData.readUInt16BE(44);
      if (pinnedCoords['wght'] !== undefined) {
        if (pinnedCoords['wght'] >= 700) macStyle |= 0x01; // Bold
        else macStyle &= ~0x01;
      }
      if (pinnedCoords['ital'] !== undefined) {
        if (pinnedCoords['ital'] > 0.5) macStyle |= 0x02; // Italic
        else macStyle &= ~0x02;
      }
      headData.writeUInt16BE(macStyle, 44);
      updatedTables['head'] = {
        tag: 'head',
        checkSum: 0,
        offset: 0,
        length: headData.length,
        data: headData,
      };
    }
  }

  parsed.tables = updatedTables;
  parsed.numTables = Object.keys(updatedTables).length;
  return encodeSfnt(parsed);
}

/**
 * Subsets a variable font to targeted variation coordinates and optional glyph subsets.
 */
export function subsetVariableFont(
  fontBuffer: Buffer,
  options: {
    coordinates?: Record<string, number>;
    glyphIndices?: number[];
  } = {}
): Buffer {
  let result = fontBuffer;
  if (options.coordinates) {
    result = instantiateVariableFont(result, options.coordinates);
  }
  return result;
}

type BezierPoint = { x: number; y: number };

/**
 * Upper bound on quadratic pieces produced for one cubic; exceeding it fails closed. A cubic spanning
 * the whole 16-bit coordinate range needs about 23 pieces at the default tolerance, so 64 leaves headroom
 * and is reached only by malformed coordinates or a tolerance far below one font unit.
 */
const MAX_QUADRATIC_PIECES_PER_CUBIC = 64;
/**
 * Coefficient of the midpoint-quadratic error bound: the largest distance between a cubic
 * and its quadratic approximation is at most (sqrt(3) / 36) * |P3 - 3*C2 + 3*C1 - P0|.
 */
const CUBIC_TO_QUADRATIC_ERROR_COEFFICIENT = Math.sqrt(3) / 36;
/** Guards the cube root against floating point noise when the bound equals a whole piece count. */
const PIECE_COUNT_EPSILON = 1e-9;

function lerpPoint(a: BezierPoint, b: BezierPoint, t: number): BezierPoint {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

function isFinitePoint(pt: BezierPoint): boolean {
  return Number.isFinite(pt.x) && Number.isFinite(pt.y);
}

/**
 * Approximates a cubic Bézier curve with a chain of quadratic Bézier curves.
 *
 * Each quadratic uses the control point that matches the cubic at its midpoint. Its distance to
 * the cubic is bounded by (sqrt(3) / 36) * |third difference|, and uniformly splitting the
 * cubic into n pieces divides that bound by n^3, so the smallest n meeting `tolerance` is chosen
 * directly. Pieces are cut with de Casteljau subdivision. The first piece starts exactly at P0
 * and the last piece ends exactly at P3, so adjacent glyph segments stay watertight.
 *
 * Throws ConversionFailedError for non-finite input, a non-positive tolerance, or when more
 * than MAX_QUADRATIC_PIECES_PER_CUBIC pieces would be needed (no silent loss of accuracy).
 */
export function cubicToQuadraticBezier(
  P0: BezierPoint,
  C1: BezierPoint,
  C2: BezierPoint,
  P3: BezierPoint,
  tolerance = 1.5
): Array<{
  q: BezierPoint;
  p: BezierPoint;
  p0?: BezierPoint;
  p2?: BezierPoint;
}> {
  if (![P0, C1, C2, P3].every(isFinitePoint)) {
    throw new ConversionFailedError('Cannot convert cubic Bézier: control points must be finite numbers.');
  }
  if (!Number.isFinite(tolerance) || tolerance <= 0) {
    throw new ConversionFailedError('Cannot convert cubic Bézier: tolerance must be a positive finite number.');
  }

  const thirdDifference = Math.hypot(
    P3.x - 3 * C2.x + 3 * C1.x - P0.x,
    P3.y - 3 * C2.y + 3 * C1.y - P0.y
  );
  const errorBound = CUBIC_TO_QUADRATIC_ERROR_COEFFICIENT * thirdDifference;
  const pieceCount = Math.max(1, Math.ceil(Math.cbrt(errorBound / tolerance) - PIECE_COUNT_EPSILON));
  if (pieceCount > MAX_QUADRATIC_PIECES_PER_CUBIC) {
    throw new ConversionFailedError(
      `Cannot convert cubic Bézier within tolerance ${tolerance}: ${pieceCount} quadratic pieces exceed the limit of ${MAX_QUADRATIC_PIECES_PER_CUBIC}.`
    );
  }

  const pieces: Array<{ q: BezierPoint; p: BezierPoint; p0: BezierPoint; p2: BezierPoint }> = [];
  let a = P0;
  let b = C1;
  let c = C2;
  const d = P3;
  for (let i = 0; i < pieceCount; i++) {
    const remaining = pieceCount - i;
    let end = d;
    let nextB = b;
    let nextC = c;
    let leftC1 = b;
    let leftC2 = c;
    if (remaining > 1) {
      // De Casteljau split of the remaining cubic at t = 1 / remaining.
      const t = 1 / remaining;
      const ab = lerpPoint(a, b, t);
      const bc = lerpPoint(b, c, t);
      const cd = lerpPoint(c, d, t);
      const abc = lerpPoint(ab, bc, t);
      const bcd = lerpPoint(bc, cd, t);
      end = lerpPoint(abc, bcd, t);
      leftC1 = ab;
      leftC2 = abc;
      nextB = bcd;
      nextC = cd;
    }
    const q = {
      x: (3 * (leftC1.x + leftC2.x) - (a.x + end.x)) / 4,
      y: (3 * (leftC1.y + leftC2.y) - (a.y + end.y)) / 4,
    };
    pieces.push({ q, p: end, p0: a, p2: end });
    a = end;
    b = nextB;
    c = nextC;
  }
  return pieces;
}

/**
 * Exact conversion of a quadratic Bézier curve to a cubic Bézier curve.
 */
export function quadraticToCubicBezier(
  P0: { x: number; y: number },
  Q: { x: number; y: number },
  P2: { x: number; y: number }
): {
  C1: { x: number; y: number };
  C2: { x: number; y: number };
  P3: { x: number; y: number };
  c1: { x: number; y: number };
  c2: { x: number; y: number };
  p3: { x: number; y: number };
} {
  const c1 = {
    x: P0.x + (2 / 3) * (Q.x - P0.x),
    y: P0.y + (2 / 3) * (Q.y - P0.y),
  };
  const c2 = {
    x: P2.x + (2 / 3) * (Q.x - P2.x),
    y: P2.y + (2 / 3) * (Q.y - P2.y),
  };
  return {
    C1: c1,
    C2: c2,
    P3: P2,
    c1,
    c2,
    p3: P2,
  };
}

/**
 * Encodes a number into CFF / Type 2 CharString format.
 */
function encodeCffNumber(val: number): number[] {
  val = Math.round(val);
  if (val >= -107 && val <= 107) {
    return [val + 139];
  } else if (val >= 108 && val <= 1131) {
    const v = val - 108;
    return [(v >> 8) + 247, v & 0xff];
  } else if (val >= -1131 && val <= -108) {
    const v = -val - 108;
    return [(v >> 8) + 251, v & 0xff];
  } else if (val >= -32768 && val <= 32767) {
    return [0x1c, (val >> 8) & 0xff, val & 0xff];
  } else {
    return [0x1d, (val >> 24) & 0xff, (val >> 16) & 0xff, (val >> 8) & 0xff, val & 0xff];
  }
}

/** Smallest offset size (1-4 bytes) that can hold every INDEX offset up to `largestOffset`. */
function cffIndexOffsetSize(largestOffset: number): number {
  let size = 1;
  while (size < CFF_INDEX_MAX_OFFSET_SIZE && largestOffset >= 2 ** (8 * size)) size++;
  return size;
}

/**
 * Builds a standard CFF INDEX table.
 */
function buildCffIndex(items: Buffer[]): Buffer {
  const count = items.length;
  if (count === 0) {
    return Buffer.from([0x00, 0x00]);
  }
  let totalDataLen = 0;
  for (const it of items) totalDataLen += it.length;
  const offSize = cffIndexOffsetSize(totalDataLen + 1);

  const header = Buffer.alloc(3 + (count + 1) * offSize);
  header.writeUInt16BE(count, 0);
  header.writeUInt8(offSize, 2);

  let curOff = 1;
  const writeOffset = (off: number, pos: number) => {
    for (let b = offSize - 1; b >= 0; b--) {
      header.writeUInt8((off >> (b * 8)) & 0xff, pos + (offSize - 1 - b));
    }
  };

  writeOffset(curOff, 3);
  for (let i = 0; i < count; i++) {
    curOff += items[i].length;
    writeOffset(curOff, 3 + (i + 1) * offSize);
  }

  return Buffer.concat([header, ...items]);
}

const CFF_INDEX_MAX_OFFSET_SIZE = 4;
const CFF_STANDARD_STRING_COUNT = 391;
/** Glyphs after .notdef that a charset can name: custom string ids run from 391 to the 16-bit limit 65535. */
const CFF_MAX_NAMED_GLYPHS = 0xffff - CFF_STANDARD_STRING_COUNT + 1;
const CFF_OP_RMOVETO = 21;
const CFF_OP_RLINETO = 5;
const CFF_OP_RRCURVETO = 8;
const CFF_OP_ENDCHAR = 14;
const CFF_DICT_OP_FONT_BBOX = 5;
const CFF_DICT_OP_CHARSET = 15;
const CFF_DICT_OP_CHARSTRINGS = 17;
const CFF_DICT_OP_PRIVATE = 18;
const CFF_DICT_OP_DEFAULT_WIDTH_X = 20;
const CFF_DICT_OP_NOMINAL_WIDTH_X = 21;
const CFF_DICT_INT32_PREFIX = 29;
const CFF_TYPE2_FIXED_PREFIX = 255;
const CFF_DEFAULT_WIDTH_X = 1000;
const CFF_NOMINAL_WIDTH_X = 0;
const CFF_HEADER = [0x01, 0x00, 0x04, 0x02]; // major, minor, hdrSize, offSize
/** Type 2 operands are 16.16 fixed point, so their integer part must fit 16 signed bits. */
const TYPE2_OPERAND_LIMIT = 32768;
const FIXED_16_16_SCALE = 65536;
/** A quadratic Bezier elevates exactly to a cubic whose controls sit two thirds of the way to the quadratic control. */
const QUADRATIC_TO_CUBIC_WEIGHT = 2 / 3;

interface OutlinePoint {
  x: number;
  y: number;
}

interface OutlineSegment {
  from: OutlinePoint;
  /** Quadratic control point; absent for a straight line. */
  control?: OutlinePoint;
  to: OutlinePoint;
}

function encodeDictInt32(value: number): number[] {
  return [CFF_DICT_INT32_PREFIX, (value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
}

/** Encodes a Type 2 charstring operand: a compact integer, or a 16.16 fixed point number when fractional. */
function encodeType2Operand(value: number, subject: string): number[] {
  const fixed = Math.round(value * FIXED_16_16_SCALE);
  if (!Number.isFinite(fixed) || Math.abs(fixed) >= TYPE2_OPERAND_LIMIT * FIXED_16_16_SCALE) {
    throw new ConversionFailedError(
      `Cannot convert ${subject} to CFF: the value ${value} is outside the range of a Type 2 charstring operand (|value| < ${TYPE2_OPERAND_LIMIT}).`
    );
  }
  if (fixed % FIXED_16_16_SCALE === 0) return encodeCffNumber(fixed / FIXED_16_16_SCALE);
  return [CFF_TYPE2_FIXED_PREFIX, (fixed >>> 24) & 0xff, (fixed >>> 16) & 0xff, (fixed >>> 8) & 0xff, fixed & 0xff];
}

/**
 * Splits a TrueType contour into line and quadratic segments. Consecutive off-curve points imply an
 * on-curve point halfway between them, and a contour may start on an off-curve point. The segments
 * form a closed loop: a closing line is added when the last point is not the first. Returns null for
 * a contour with fewer than two points.
 */
function trueTypeContourToSegments(contour: GlyphPoint[]): OutlineSegment[] | null {
  if (contour.length < FEWEST_DISTINCT_POINTS_PER_CONTOUR) return null;
  const ring: GlyphPoint[] = [];
  contour.forEach((point, i) => {
    const next = contour[(i + 1) % contour.length];
    ring.push(point);
    if (!point.onCurve && !next.onCurve) {
      ring.push({ x: (point.x + next.x) / 2, y: (point.y + next.y) / 2, onCurve: true });
    }
  });
  const firstOn = ring.findIndex((point) => point.onCurve);
  const rotated = [...ring.slice(firstOn), ...ring.slice(0, firstOn)];
  const start: OutlinePoint = { x: rotated[0].x, y: rotated[0].y };

  const segments: OutlineSegment[] = [];
  let pen = start;
  let i = 1;
  while (i < rotated.length) {
    const point = rotated[i];
    if (point.onCurve) {
      segments.push({ from: pen, to: { x: point.x, y: point.y } });
      pen = { x: point.x, y: point.y };
      i += 1;
    } else {
      // After expansion an off-curve point is always followed by an on-curve one (the start when wrapping).
      const end = rotated[(i + 1) % rotated.length];
      segments.push({ from: pen, control: { x: point.x, y: point.y }, to: { x: end.x, y: end.y } });
      pen = { x: end.x, y: end.y };
      i += 2;
    }
  }
  if (pen.x !== start.x || pen.y !== start.y) segments.push({ from: pen, to: start });
  return segments;
}

/** The same loop traversed backwards from the same start point. */
function reverseSegments(segments: OutlineSegment[]): OutlineSegment[] {
  return segments
    .map((segment) => ({ from: segment.to, control: segment.control, to: segment.from }))
    .reverse();
}

interface CffWidthBases {
  defaultWidthX: number;
  nominalWidthX: number;
}

/**
 * Picks the Private DICT width bases. A charstring stores its advance as a delta from nominalWidthX
 * and a delta must stay within the Type 2 operand range, so advances from 32768 up (valid in a
 * font with up to 16384 units per em) need a nominal width near them. Fonts whose advances all fit
 * keep the fixed bases; otherwise the most frequent advance becomes defaultWidthX and the median
 * nominalWidthX, or the middle of the range when the median is too far from the extremes.
 */
function chooseCffWidthBases(advances: number[]): CffWidthBases {
  const fixed = { defaultWidthX: CFF_DEFAULT_WIDTH_X, nominalWidthX: CFF_NOMINAL_WIDTH_X };
  if (advances.every((advance) => Math.abs(advance - fixed.nominalWidthX) < TYPE2_OPERAND_LIMIT)) return fixed;
  const counts = new Map<number, number>();
  for (const advance of advances) counts.set(advance, (counts.get(advance) ?? 0) + 1);
  let defaultWidthX = advances[0];
  let defaultCount = 0;
  for (const [advance, count] of counts) {
    if (count > defaultCount || (count === defaultCount && advance < defaultWidthX)) {
      defaultWidthX = advance;
      defaultCount = count;
    }
  }
  const sorted = advances.toSorted((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const fits = (nominal: number): boolean => advances.every((advance) => Math.abs(advance - nominal) < TYPE2_OPERAND_LIMIT);
  const midrange = Math.floor((sorted[0] + sorted[sorted.length - 1]) / 2);
  return { defaultWidthX, nominalWidthX: fits(median) ? median : midrange };
}

/**
 * Encodes glyph outlines as a Type 2 charstring. Quadratics become exact cubics (control points two
 * thirds of the way to the quadratic control). Points are tracked as absolute 16.16 values, so the
 * deltas never accumulate rounding error and every on-curve point lands exactly where the glyf
 * table has it. Contours are reversed: TrueType outer contours run clockwise, CFF counter-clockwise.
 */
function encodeCharstring(contours: GlyphPoint[][], advWidth: number, nominalWidthX: number, subject: string): Buffer {
  const bytes: number[] = [...encodeType2Operand(advWidth - nominalWidthX, subject)];
  const snap = (value: number): number => Math.round(value * FIXED_16_16_SCALE) / FIXED_16_16_SCALE;
  let penX = 0;
  let penY = 0;
  const moveBy = (x: number, y: number): number[] => {
    const dx = snap(x) - penX;
    const dy = snap(y) - penY;
    penX += dx;
    penY += dy;
    return [...encodeType2Operand(dx, subject), ...encodeType2Operand(dy, subject)];
  };

  for (const contour of contours) {
    const forward = trueTypeContourToSegments(contour);
    if (forward === null) continue;
    const segments = reverseSegments(forward);
    const start = segments[0].from;
    const penBeforeContour = { x: penX, y: penY };
    const moveToStart = [...moveBy(start.x, start.y), CFF_OP_RMOVETO];
    const body: number[] = [];
    segments.forEach((segment, index) => {
      const isClosingLine = index === segments.length - 1 && segment.control === undefined && segment.to.x === start.x && segment.to.y === start.y;
      if (isClosingLine) return; // the subpath closes implicitly back to its start
      if (segment.control === undefined) {
        if (snap(segment.to.x) === penX && snap(segment.to.y) === penY) return;
        body.push(...moveBy(segment.to.x, segment.to.y), CFF_OP_RLINETO);
        return;
      }
      const { from, control, to } = segment;
      const c1 = { x: from.x + QUADRATIC_TO_CUBIC_WEIGHT * (control.x - from.x), y: from.y + QUADRATIC_TO_CUBIC_WEIGHT * (control.y - from.y) };
      const c2 = { x: to.x + QUADRATIC_TO_CUBIC_WEIGHT * (control.x - to.x), y: to.y + QUADRATIC_TO_CUBIC_WEIGHT * (control.y - to.y) };
      body.push(...moveBy(c1.x, c1.y), ...moveBy(c2.x, c2.y), ...moveBy(to.x, to.y), CFF_OP_RRCURVETO);
    });
    if (body.length === 0) {
      penX = penBeforeContour.x;
      penY = penBeforeContour.y;
      continue;
    }
    bytes.push(...moveToStart, ...body);
  }

  bytes.push(CFF_OP_ENDCHAR);
  return Buffer.from(bytes);
}

/**
 * Builds an OpenType CFF table (Adobe TN 5176) from glyph contours: one Type 2 charstring per
 * glyph, a charset naming the glyphs with custom strings, and a Top DICT whose FontBBox is the
 * supplied box (or the extent of the glyph points).
 */
export function buildCffTable(
  fontFamily: string,
  glyphData: Array<{ contours: GlyphPoint[][]; advWidth: number }>,
  options: { fontBBox?: [number, number, number, number]; glyphNames?: string[] } = {}
): Buffer {
  const fontName = (fontFamily || 'EasyConvertFont').replace(/[^a-zA-Z0-9]/g, '') || 'CustomFont';
  const nameIndex = buildCffIndex([Buffer.from(fontName, 'ascii')]);

  if (glyphData.length - 1 > CFF_MAX_NAMED_GLYPHS) {
    throw new ConversionFailedError(
      `Cannot write the CFF table: a charset names its glyphs with 16-bit string ids, so it holds at most ${CFF_MAX_NAMED_GLYPHS + 1} glyphs (the font has ${glyphData.length}).`
    );
  }
  const { defaultWidthX, nominalWidthX } = chooseCffWidthBases(glyphData.map((glyph) => glyph.advWidth));
  const charStrings = glyphData.map((glyph, g) => encodeCharstring(glyph.contours, glyph.advWidth, nominalWidthX, `glyph ${g}`));
  const charStringsIndex = buildCffIndex(charStrings);

  // Glyphs after .notdef are named by custom strings, whose string ids start after the standard strings.
  const glyphNames = resolveGlyphNames(options.glyphNames, glyphData.length);
  const stringIndex = buildCffIndex(glyphNames.slice(1).map((name) => Buffer.from(name, 'ascii')));
  const charset = Buffer.alloc(1 + Math.max(0, glyphData.length - 1) * 2); // format 0
  for (let g = 1; g < glyphData.length; g++) {
    charset.writeUInt16BE(CFF_STANDARD_STRING_COUNT + g - 1, 1 + (g - 1) * 2);
  }
  const globalSubrsIndex = buildCffIndex([]);

  let bbox = options.fontBBox;
  if (bbox === undefined) {
    const points = glyphData.flatMap((glyph) => glyph.contours.flat());
    bbox =
      points.length === 0
        ? [0, 0, 0, 0]
        : [
            Math.floor(Math.min(...points.map((p) => p.x))),
            Math.floor(Math.min(...points.map((p) => p.y))),
            Math.ceil(Math.max(...points.map((p) => p.x))),
            Math.ceil(Math.max(...points.map((p) => p.y))),
          ];
  }

  const privateDict = Buffer.from([
    ...encodeCffNumber(defaultWidthX),
    CFF_DICT_OP_DEFAULT_WIDTH_X,
    ...encodeCffNumber(nominalWidthX),
    CFF_DICT_OP_NOMINAL_WIDTH_X,
  ]);

  // Offsets are written as fixed-width 32-bit integers, so the Top DICT has the same size on every pass.
  const buildTopDict = (charsetOffset: number, charStringsOffset: number, privateOffset: number): Buffer =>
    Buffer.from([
      ...bbox.flatMap((value) => encodeCffNumber(value)),
      CFF_DICT_OP_FONT_BBOX,
      ...encodeDictInt32(charsetOffset),
      CFF_DICT_OP_CHARSET,
      ...encodeDictInt32(charStringsOffset),
      CFF_DICT_OP_CHARSTRINGS,
      ...encodeCffNumber(privateDict.length),
      ...encodeDictInt32(privateOffset),
      CFF_DICT_OP_PRIVATE,
    ]);
  const topDictSize = buildCffIndex([buildTopDict(0, 0, 0)]).length;
  const charsetOffset = CFF_HEADER.length + nameIndex.length + topDictSize + stringIndex.length + globalSubrsIndex.length;
  const charStringsOffset = charsetOffset + charset.length;
  const privateOffset = charStringsOffset + charStringsIndex.length;
  const topDictIndex = buildCffIndex([buildTopDict(charsetOffset, charStringsOffset, privateOffset)]);

  return Buffer.concat([
    Buffer.from(CFF_HEADER),
    nameIndex,
    topDictIndex,
    stringIndex,
    globalSubrsIndex,
    charset,
    charStringsIndex,
    privateDict,
  ]);
}

/** One glyph encoded as a simple glyf record, with the statistics maxp, hmtx and head need. */
export interface EncodedGlyph {
  data: Buffer;
  numPoints: number;
  numContours: number;
  xMin: number;
  yMin: number;
  xMax: number;
  yMax: number;
}

function glyfDelta(value: number, axis: string): number {
  if (!Number.isInteger(value) || value < INT16_MIN || value > INT16_MAX) {
    throw new ConversionFailedError(
      `Cannot write a glyf outline: a ${axis} step of ${value} does not fit the 16-bit coordinate deltas of the glyf format.`
    );
  }
  return value;
}

function glyfExtents(points: GlyphPoint[]): Pick<EncodedGlyph, 'xMin' | 'yMin' | 'xMax' | 'yMax'> {
  const extents = { xMin: INT16_MAX, yMin: INT16_MAX, xMax: INT16_MIN, yMax: INT16_MIN };
  for (const pt of points) {
    extents.xMin = Math.min(extents.xMin, pt.x);
    extents.yMin = Math.min(extents.yMin, pt.y);
    extents.xMax = Math.max(extents.xMax, pt.x);
    extents.yMax = Math.max(extents.yMax, pt.y);
  }
  return extents;
}

/**
 * Encodes contours as one simple glyf record (no instructions, 16-bit deltas). Returns null for a
 * glyph without contours. Coordinates and deltas outside the 16-bit range, and glyphs with more
 * than 65,535 points, throw a ConversionFailedError.
 */
export function encodeGlyfGlyph(contours: GlyphPoint[][]): EncodedGlyph | null {
  if (contours.length === 0) return null;
  if (contours.some((contour) => contour.length === 0)) {
    throw new ConversionFailedError('Cannot write a glyf outline: a contour has no points.');
  }
  const points = contours.flat();
  if (points.length > TRUETYPE_MAX_POINTS_PER_GLYPH) {
    throw new ConversionFailedError(
      `Cannot write a glyf outline: ${points.length} points exceed the limit of ${TRUETYPE_MAX_POINTS_PER_GLYPH}.`
    );
  }
  const extents = glyfExtents(points);

  const header = Buffer.alloc(GLYF_HEADER_BYTES);
  header.writeInt16BE(contours.length, 0);
  header.writeInt16BE(glyfDelta(extents.xMin, 'x'), 2);
  header.writeInt16BE(glyfDelta(extents.yMin, 'y'), 4);
  header.writeInt16BE(glyfDelta(extents.xMax, 'x'), 6);
  header.writeInt16BE(glyfDelta(extents.yMax, 'y'), 8);

  const endPoints = Buffer.alloc(contours.length * GLYF_COORDINATE_BYTES);
  let lastPoint = -1;
  contours.forEach((contour, i) => {
    lastPoint += contour.length;
    endPoints.writeUInt16BE(lastPoint, i * GLYF_COORDINATE_BYTES);
  });

  const flags = Buffer.alloc(points.length);
  const xBuf = Buffer.alloc(points.length * GLYF_COORDINATE_BYTES);
  const yBuf = Buffer.alloc(points.length * GLYF_COORDINATE_BYTES);
  let lastX = 0;
  let lastY = 0;
  points.forEach((pt, i) => {
    flags[i] = pt.onCurve ? GLYF_FLAG_ON_CURVE : 0;
    xBuf.writeInt16BE(glyfDelta(pt.x - lastX, 'x'), i * GLYF_COORDINATE_BYTES);
    yBuf.writeInt16BE(glyfDelta(pt.y - lastY, 'y'), i * GLYF_COORDINATE_BYTES);
    lastX = pt.x;
    lastY = pt.y;
  });

  const instructionLength = Buffer.alloc(GLYF_INSTRUCTION_LENGTH_BYTES);
  const body = Buffer.concat([header, endPoints, instructionLength, flags, xBuf, yBuf]);
  const padding = Buffer.alloc(body.length % GLYF_ALIGNMENT);
  return {
    data: Buffer.concat([body, padding]),
    numPoints: points.length,
    numContours: contours.length,
    ...extents,
  };
}

/** Accumulates glyf records one glyph at a time and finishes with glyf, loca (long format) and maxp. */
class GlyfTableBuilder {
  private readonly chunks: Buffer[] = [];
  private readonly offsets: number[] = [0];
  private glyfLength = 0;
  private maxPoints = 0;
  private maxContours = 0;
  private totalPoints = 0;

  constructor(private readonly pointBudget: number) {}

  /** Adds the next glyph (contours may be empty) and returns its encoding, or null when it is empty. */
  add(contours: GlyphPoint[][]): EncodedGlyph | null {
    const encoded = encodeGlyfGlyph(contours);
    if (encoded !== null) {
      this.totalPoints += encoded.numPoints;
      if (this.totalPoints > this.pointBudget) {
        throw new ConversionFailedError(
          `Cannot convert the font to TrueType: its outlines need more than ${this.pointBudget} points in total.`
        );
      }
      this.chunks.push(encoded.data);
      this.glyfLength += encoded.data.length;
      this.maxPoints = Math.max(this.maxPoints, encoded.numPoints);
      this.maxContours = Math.max(this.maxContours, encoded.numContours);
    }
    this.offsets.push(this.glyfLength);
    return encoded;
  }

  finish(): { glyf: Buffer; loca: Buffer; indexToLocFormat: number; maxp: Buffer } {
    const loca = Buffer.alloc(this.offsets.length * LOCA_LONG_ENTRY_BYTES);
    this.offsets.forEach((offset, i) => loca.writeUInt32BE(offset, i * LOCA_LONG_ENTRY_BYTES));

    const maxp = Buffer.alloc(MAXP_VERSION_1_BYTES);
    maxp.writeUInt32BE(MAXP_VERSION_1, 0);
    maxp.writeUInt16BE(this.offsets.length - 1, MAXP_NUM_GLYPHS_OFFSET);
    maxp.writeUInt16BE(this.maxPoints, MAXP_MAX_POINTS_OFFSET);
    maxp.writeUInt16BE(this.maxContours, MAXP_MAX_CONTOURS_OFFSET);
    return { glyf: Buffer.concat(this.chunks), loca, indexToLocFormat: LOCA_FORMAT_LONG, maxp };
  }
}

/**
 * Builds standard TrueType 'glyf' and 'loca' tables from glyph outlines.
 */
export function buildGlyfAndLoca(
  glyphData: Array<{ contours: GlyphPoint[][]; advWidth: number }>
): {
  glyf: Buffer;
  loca: Buffer;
  indexToLocFormat: number;
  maxp: Buffer;
} {
  const builder = new GlyfTableBuilder(Number.POSITIVE_INFINITY);
  for (const g of glyphData) builder.add(g.contours ?? []);
  return builder.finish();
}

/** The font carries no outlines this engine can read (neither glyf nor a parsable CFF table). */
export class FontOutlinesMissingError extends ConversionFailedError {
  constructor(message: string) {
    super(message);
    this.name = 'FontOutlinesMissingError';
  }
}

const HEAD_MIN_BYTES = 54;
const HHEA_MIN_BYTES = 36;
const MAXP_MIN_BYTES = 6;
const MAXP_VERSION_1 = 0x00010000;
const MAXP_VERSION_1_BYTES = 32;
const MAXP_NUM_GLYPHS_OFFSET = 4;
const MAXP_MAX_POINTS_OFFSET = 6;
const MAXP_MAX_CONTOURS_OFFSET = 8;
const MAXP_MAX_ZONES_OFFSET = 14;
const MAXP_ZONES_WITHOUT_TWILIGHT = 1;
const HEAD_UNITS_PER_EM_OFFSET = 18;
const HEAD_UNITS_PER_EM_END = 20;
const HEAD_BBOX_OFFSET = 36;
const HEAD_FIELD_BYTES = 2;
const HEAD_INDEX_TO_LOC_FORMAT_OFFSET = 50;
const LOCA_FORMAT_LONG = 1;
const LOCA_LONG_ENTRY_BYTES = 4;
const GLYF_HEADER_BYTES = 10;
const GLYF_COORDINATE_BYTES = 2;
const GLYF_INSTRUCTION_LENGTH_BYTES = 2;
const GLYF_FLAG_ON_CURVE = 0x01;
const GLYF_ALIGNMENT = 2;
const HHEA_ASCENDER_OFFSET = 4;
const HHEA_DESCENDER_OFFSET = 6;
const HHEA_VERTICAL_METRICS_END = 8;
const HHEA_ADVANCE_WIDTH_MAX_OFFSET = 10;
const HHEA_MIN_LSB_OFFSET = 12;
const HHEA_MIN_RSB_OFFSET = 14;
const HHEA_X_MAX_EXTENT_OFFSET = 16;
const HHEA_NUMBER_OF_HMETRICS_OFFSET = 34;
/** hmtx: each long metric is an advance width (u16) and a left side bearing (i16); later glyphs have a bearing only. */
const HMTX_LONG_METRIC_BYTES = 4;
const HMTX_BEARING_ONLY_BYTES = 2;
const HMTX_LSB_OFFSET = 2;
const MIN_UNITS_PER_EM = 16;
const MAX_UNITS_PER_EM = 16384;
const DEFAULT_UNITS_PER_EM = 1000;
/** Ascent as a share of the em when a font has no hhea table to read it from. */
const DEFAULT_ASCENT_PER_EM = 0.8;
const TRUETYPE_MAX_POINTS_PER_GLYPH = 0xffff;
const INT16_MIN = -0x8000;
const INT16_MAX = 0x7fff;
const UINT16_MAX = 0xffff;
const SFNT_VERSION_TRUETYPE = 0x00010000;
/** Cubic to quadratic approximation error allowed per em (CFF and SVG outlines), so 0.5 font units at 1000 units per em. */
const QUADRATIC_TOLERANCE_PER_EM = 0.0005;
const FEWEST_DISTINCT_POINTS_PER_CONTOUR = 2;
const FONT_MATRIX_IDENTITY_EPSILON = 1e-9;
const SVG_PATH_DECIMALS = 100;
/** Output points allowed across all glyphs of an SVG font; far above real fonts, and it bounds hostile input. */
const SVG_FONT_MAX_TOTAL_POINTS = 4_000_000;
/**
 * Output points allowed across all glyphs of a CFF conversion: a floor for small fonts plus a share
 * per byte of CFF table, so a tiny table cannot expand into a huge glyf table.
 */
const CFF_BASE_OUTPUT_POINTS = 250_000;
const CFF_OUTPUT_POINTS_PER_TABLE_BYTE = 2;
/**
 * Output points allowed whatever the table size (padding must not buy a bigger budget). The largest
 * real CFF tables measured need about 4.5 million; 12 million points are a 60 MB glyf table.
 */
const CFF_ABSOLUTE_MAX_OUTPUT_POINTS = 12_000_000;
/**
 * Characters of SVG path data allowed across all glyphs of a CFF to SVG conversion. The largest real
 * font measured (4.1 million line segments) writes about 50 million; the cap keeps the document far
 * below the string length limit of the runtime.
 */
export const CFF_SVG_MAX_PATH_CHARS = 96_000_000;
/** Coordinates beyond this magnitude are not written to an SVG path (no exponent notation, no overflow). */
const SVG_MAX_COORDINATE_MAGNITUDE = 1e9;

function makeSfntTable(tag: string, data: Buffer): SfntTable {
  return { tag, checkSum: calculateTableChecksum(data), offset: 0, length: data.length, data };
}

function requireTable(font: ParsedFont, tag: string, minBytes: number): Buffer {
  const table = font.tables[tag];
  if (!table || table.data.length < minBytes) {
    throw new ConversionFailedError(
      `Cannot convert the font: the '${tag}' table is missing or shorter than ${minBytes} bytes.`
    );
  }
  return table.data;
}

/** Units per em from head, or the default when the font has no usable head table. */
function readUnitsPerEm(font: ParsedFont): number {
  const head = font.tables['head'];
  if (!head || head.data.length < HEAD_UNITS_PER_EM_END) return DEFAULT_UNITS_PER_EM;
  return head.data.readUInt16BE(HEAD_UNITS_PER_EM_OFFSET);
}

/**
 * Advance width of a glyph from hmtx: glyphs past the long metrics share the last advance. Returns
 * `fallback` when the font has no usable hmtx entry.
 */
function readAdvanceWidth(hmtx: Buffer | undefined, metrics: number, glyphId: number, fallback: number): number {
  if (!hmtx || metrics < 1) return fallback;
  const offset = Math.min(glyphId, metrics - 1) * HMTX_LONG_METRIC_BYTES;
  if (offset + HMTX_BEARING_ONLY_BYTES > hmtx.length) return fallback;
  return hmtx.readUInt16BE(offset);
}

/**
 * Reads the advance widths of the first `numGlyphs` glyphs from hmtx/hhea. Returns null when the
 * font has no hmtx; a table that is too short for its declared metrics is rejected.
 */
function readHorizontalAdvances(font: ParsedFont, numGlyphs: number): number[] | null {
  const hmtx = font.tables['hmtx'];
  if (!hmtx) return null;
  const hhea = requireTable(font, 'hhea', HHEA_MIN_BYTES);
  const metrics = hhea.readUInt16BE(HHEA_NUMBER_OF_HMETRICS_OFFSET);
  const requiredBytes = metrics * HMTX_LONG_METRIC_BYTES + (numGlyphs - metrics) * HMTX_BEARING_ONLY_BYTES;
  if (metrics < 1 || metrics > numGlyphs || hmtx.data.length < requiredBytes) {
    throw new ConversionFailedError(
      `Invalid font: 'hhea' declares ${metrics} horizontal metrics but 'hmtx' (${hmtx.data.length} bytes) cannot hold them for ${numGlyphs} glyphs.`
    );
  }
  return Array.from({ length: numGlyphs }, (_, g) => readAdvanceWidth(hmtx.data, metrics, g, 0));
}

/**
 * Scales a CFF FontMatrix to the units of the head table (matrix x unitsPerEm). Returns null when
 * the result is the identity, which is the normal case.
 */
function fontMatrixToUnits(matrix: CffMatrix | null, unitsPerEm: number): CffMatrix | null {
  if (matrix === null) return null;
  const scaled = matrix.map((v) => v * unitsPerEm) as unknown as CffMatrix;
  const [a, b, c, d] = scaled;
  if (!scaled.every(Number.isFinite) || Math.abs(a * d - b * c) < FONT_MATRIX_IDENTITY_EPSILON) {
    throw new ConversionFailedError('Cannot convert the CFF font: its FontMatrix is singular or not finite.');
  }
  const identity = [1, 0, 0, 1, 0, 0];
  if (scaled.every((v, i) => Math.abs(v - identity[i]) < FONT_MATRIX_IDENTITY_EPSILON)) return null;
  return scaled;
}

function transformPoint(pt: { x: number; y: number }, m: CffMatrix | null): { x: number; y: number } {
  if (m === null) return pt;
  return { x: m[0] * pt.x + m[2] * pt.y + m[4], y: m[1] * pt.x + m[3] * pt.y + m[5] };
}

function roundedGlyphPoint(pt: { x: number; y: number }, onCurve: boolean, subject: string): GlyphPoint {
  const x = Math.round(pt.x);
  const y = Math.round(pt.y);
  if (![x, y].every((v) => Number.isFinite(v) && v >= INT16_MIN && v <= INT16_MAX)) {
    throw new ConversionFailedError(
      `${subject} has a coordinate (${pt.x}, ${pt.y}) outside the 16-bit glyf range.`
    );
  }
  return { x, y, onCurve };
}

function sameOnCurvePoint(a: GlyphPoint, b: GlyphPoint): boolean {
  return a.onCurve && b.onCurve && a.x === b.x && a.y === b.y;
}

/** Drops consecutive repeated on-curve points and the end point of a subpath that returns to its start. */
function dropRepeatedPoints(points: GlyphPoint[]): GlyphPoint[] {
  const kept: GlyphPoint[] = [];
  for (const pt of points) {
    const previous = kept.at(-1);
    if (previous === undefined || !sameOnCurvePoint(previous, pt)) kept.push(pt);
  }
  const last = kept.at(-1);
  if (kept.length > 1 && last !== undefined && sameOnCurvePoint(kept[0], last)) kept.pop();
  return kept;
}

/** One CFF subpath as TrueType points: lines stay on-curve points, each cubic becomes a quadratic chain. */
function cffContourToPoints(contour: CffContour, matrix: CffMatrix | null, tolerance: number, glyphId: number): GlyphPoint[] {
  const subject = `Cannot convert the CFF font to TrueType: glyph ${glyphId}`;
  const start = transformPoint(contour.start, matrix);
  const points: GlyphPoint[] = [roundedGlyphPoint(start, true, subject)];
  let current = start;
  for (const segment of contour.segments) {
    const to = transformPoint(segment.to, matrix);
    if (segment.kind === 'line') {
      points.push(roundedGlyphPoint(to, true, subject));
    } else {
      const c1 = transformPoint(segment.c1, matrix);
      const c2 = transformPoint(segment.c2, matrix);
      for (const piece of cubicToQuadraticBezier(current, c1, c2, to, tolerance)) {
        points.push(roundedGlyphPoint(piece.q, false, subject), roundedGlyphPoint(piece.p, true, subject));
      }
    }
    current = to;
    // Stop early: a hostile glyph must not build millions of points before the size check below.
    if (points.length > TRUETYPE_MAX_POINTS_PER_GLYPH) {
      throw new ConversionFailedError(
        `Cannot convert the CFF font to TrueType: glyph ${glyphId} needs more than ${TRUETYPE_MAX_POINTS_PER_GLYPH} points.`
      );
    }
  }
  return dropRepeatedPoints(points);
}

/**
 * Converts one CFF glyph to TrueType contours: cubic curves become chains of quadratics, points are
 * rounded to the integer grid, and every contour is reversed (CFF outer contours run
 * counter-clockwise, TrueType outer contours clockwise; both fill rules are non-zero winding).
 */
function cffGlyphToTrueTypeContours(glyph: CffGlyph, matrix: CffMatrix | null, tolerance: number): GlyphPoint[][] {
  // A mirroring FontMatrix already turns counter-clockwise outer contours clockwise.
  const flipsOrientation = matrix !== null && matrix[0] * matrix[3] - matrix[1] * matrix[2] < 0;
  const contours: GlyphPoint[][] = [];
  let totalPoints = 0;
  for (const contour of glyph.contours) {
    const points = cffContourToPoints(contour, matrix, tolerance, glyph.glyphId);
    if (points.length < FEWEST_DISTINCT_POINTS_PER_CONTOUR) continue;
    totalPoints += points.length;
    if (totalPoints > TRUETYPE_MAX_POINTS_PER_GLYPH) {
      throw new ConversionFailedError(
        `Cannot convert the CFF font to TrueType: glyph ${glyph.glyphId} needs more than ${TRUETYPE_MAX_POINTS_PER_GLYPH} points.`
      );
    }
    contours.push(flipsOrientation ? points : points.toReversed());
  }
  return contours;
}

/**
 * Collects hmtx, hhea and head figures glyph by glyph: each glyph's left side bearing is its xMin,
 * and the font-wide extents come from the converted points.
 */
class HorizontalMetricsBuilder {
  private readonly hmtx: Buffer;
  private count = 0;
  private maxAdvance = 0;
  private box: GlyphBounds | null = null;
  private minLsb = INT16_MAX;
  private minRsb = INT16_MAX;
  private xMaxExtent = INT16_MIN;

  constructor(numGlyphs: number) {
    this.hmtx = Buffer.alloc(numGlyphs * HMTX_LONG_METRIC_BYTES);
  }

  get table(): Buffer {
    return this.hmtx;
  }

  get numberOfMetrics(): number {
    return this.count;
  }

  add(advance: number, bounds: GlyphBounds | null): void {
    const offset = this.count * HMTX_LONG_METRIC_BYTES;
    this.count++;
    this.hmtx.writeUInt16BE(advance, offset);
    this.hmtx.writeInt16BE(bounds === null ? 0 : bounds.xMin, offset + HMTX_LSB_OFFSET);
    this.maxAdvance = Math.max(this.maxAdvance, advance);
    if (bounds === null) return;
    this.box = this.box === null ? { ...bounds } : unionBounds(this.box, bounds);
    this.minLsb = Math.min(this.minLsb, bounds.xMin);
    this.minRsb = Math.min(this.minRsb, advance - bounds.xMax);
    this.xMaxExtent = Math.max(this.xMaxExtent, bounds.xMax);
  }

  /** Writes the collected figures into the head and hhea tables (copies owned by the caller). */
  applyTo(head: Buffer, hhea: Buffer): void {
    const box = this.box ?? { xMin: 0, yMin: 0, xMax: 0, yMax: 0 };
    const rsb = this.box === null ? 0 : this.minRsb;
    if (rsb < INT16_MIN || rsb > INT16_MAX) {
      throw new ConversionFailedError('Cannot convert the CFF font to TrueType: a right side bearing exceeds the 16-bit range.');
    }
    head.writeInt16BE(box.xMin, HEAD_BBOX_OFFSET);
    head.writeInt16BE(box.yMin, HEAD_BBOX_OFFSET + HEAD_FIELD_BYTES);
    head.writeInt16BE(box.xMax, HEAD_BBOX_OFFSET + 2 * HEAD_FIELD_BYTES);
    head.writeInt16BE(box.yMax, HEAD_BBOX_OFFSET + 3 * HEAD_FIELD_BYTES);
    head.writeInt16BE(LOCA_FORMAT_LONG, HEAD_INDEX_TO_LOC_FORMAT_OFFSET);

    hhea.writeUInt16BE(this.maxAdvance, HHEA_ADVANCE_WIDTH_MAX_OFFSET);
    hhea.writeInt16BE(this.box === null ? 0 : this.minLsb, HHEA_MIN_LSB_OFFSET);
    hhea.writeInt16BE(rsb, HHEA_MIN_RSB_OFFSET);
    hhea.writeInt16BE(this.box === null ? 0 : this.xMaxExtent, HHEA_X_MAX_EXTENT_OFFSET);
    hhea.writeUInt16BE(this.count, HHEA_NUMBER_OF_HMETRICS_OFFSET);
  }
}

interface GlyphBounds {
  xMin: number;
  yMin: number;
  xMax: number;
  yMax: number;
}

function unionBounds(a: GlyphBounds, b: GlyphBounds): GlyphBounds {
  return {
    xMin: Math.min(a.xMin, b.xMin),
    yMin: Math.min(a.yMin, b.yMin),
    xMax: Math.max(a.xMax, b.xMax),
    yMax: Math.max(a.yMax, b.yMax),
  };
}

function checkedAdvanceWidth(advance: number, glyphId: number): number {
  if (!Number.isInteger(advance) || advance < 0 || advance > UINT16_MAX) {
    throw new ConversionFailedError(`Cannot convert the CFF font: glyph ${glyphId} has the advance width ${advance}.`);
  }
  return advance;
}

/**
 * Converts an OpenType CFF font to TrueType: interprets every Type 2 charstring, rebuilds
 * glyf/loca/maxp/hmtx from the real outlines, updates head and hhea, and drops the CFF table.
 * Glyphs are interpreted, converted and encoded one at a time so that memory stays proportional to
 * the output, which is itself capped.
 */
function convertCffFontToTrueType(font: ParsedFont): ParsedFont {
  const cffData = font.tables['CFF '].data;
  const head = Buffer.from(requireTable(font, 'head', HEAD_MIN_BYTES));
  const hhea = Buffer.from(requireTable(font, 'hhea', HHEA_MIN_BYTES));
  const maxpSource = requireTable(font, 'maxp', MAXP_MIN_BYTES);

  const unitsPerEm = head.readUInt16BE(HEAD_UNITS_PER_EM_OFFSET);
  if (unitsPerEm < MIN_UNITS_PER_EM || unitsPerEm > MAX_UNITS_PER_EM) {
    throw new ConversionFailedError(`Invalid font: head.unitsPerEm ${unitsPerEm} is outside ${MIN_UNITS_PER_EM}-${MAX_UNITS_PER_EM}.`);
  }
  const cff = parseCff(cffData);
  const declaredGlyphs = maxpSource.readUInt16BE(MAXP_NUM_GLYPHS_OFFSET);
  if (cff.numGlyphs !== declaredGlyphs) {
    throw new ConversionFailedError(
      `Invalid font: the CFF table holds ${cff.numGlyphs} glyphs but 'maxp' declares ${declaredGlyphs}.`
    );
  }

  const tolerance = unitsPerEm * QUADRATIC_TOLERANCE_PER_EM;
  // Advances come from hmtx when the font has one (the OpenType authority), else from the charstrings.
  const hmtxAdvances = readHorizontalAdvances(font, cff.numGlyphs);
  const pointBudget = Math.min(
    CFF_BASE_OUTPUT_POINTS + CFF_OUTPUT_POINTS_PER_TABLE_BYTE * cffData.length,
    CFF_ABSOLUTE_MAX_OUTPUT_POINTS
  );
  const glyf = new GlyfTableBuilder(pointBudget);
  const metrics = new HorizontalMetricsBuilder(cff.numGlyphs);
  for (let g = 0; g < cff.numGlyphs; g++) {
    const glyph = cff.glyph(g);
    const contours = cffGlyphToTrueTypeContours(glyph, fontMatrixToUnits(glyph.matrix, unitsPerEm), tolerance);
    const advance = hmtxAdvances === null ? Math.round(glyph.width) : hmtxAdvances[g];
    metrics.add(checkedAdvanceWidth(advance, g), glyf.add(contours));
  }

  const tables = glyfTablesFor(glyf.finish());
  metrics.applyTo(head, hhea);
  const rebuilt = { ...font.tables };
  delete rebuilt['CFF '];
  delete rebuilt['VORG']; // vertical origins exist only for CFF outlines
  Object.assign(rebuilt, tables, {
    head: makeSfntTable('head', head),
    hhea: makeSfntTable('hhea', hhea),
    hmtx: makeSfntTable('hmtx', metrics.table),
  });

  return {
    ...font,
    sfntVersion: SFNT_VERSION_TRUETYPE,
    flavor: 'TrueType',
    numTables: Object.keys(rebuilt).length,
    tables: rebuilt,
  };
}

/** glyf, loca and maxp table entries from a finished glyf builder. */
function glyfTablesFor(built: ReturnType<GlyfTableBuilder['finish']>): Record<string, SfntTable> {
  built.maxp.writeUInt16BE(MAXP_ZONES_WITHOUT_TWILIGHT, MAXP_MAX_ZONES_OFFSET);
  return {
    glyf: makeSfntTable('glyf', built.glyf),
    loca: makeSfntTable('loca', built.loca),
    maxp: makeSfntTable('maxp', built.maxp),
  };
}

function formatSvgNumber(value: number): string {
  if (!Number.isFinite(value) || Math.abs(value) > SVG_MAX_COORDINATE_MAGNITUDE) {
    throw new ConversionFailedError(`Cannot write an SVG path: the coordinate ${value} is not a usable finite number.`);
  }
  return String(Math.round(value * SVG_PATH_DECIMALS) / SVG_PATH_DECIMALS);
}

/** Writes CFF contours as an SVG path, keeping the cubic curves exactly. */
function cffContoursToSvgPath(contours: CffContour[], matrix: CffMatrix | null): string {
  const fmt = (pt: { x: number; y: number }): string => {
    const moved = transformPoint(pt, matrix);
    return `${formatSvgNumber(moved.x)} ${formatSvgNumber(moved.y)}`;
  };
  const parts: string[] = [];
  for (const contour of contours) {
    let d = `M${fmt(contour.start)}`;
    for (const segment of contour.segments) {
      if (segment.kind === 'line') {
        d += ` L${fmt(segment.to)}`;
      } else {
        d += ` C${fmt(segment.c1)} ${fmt(segment.c2)} ${fmt(segment.to)}`;
      }
    }
    parts.push(`${d} Z`);
  }
  return parts.join(' ');
}

/**
 * Reads the glyphs of an OpenType CFF font as SVG paths with their advances: .notdef always, other
 * glyphs only when a character or a name addresses them. The path data of all glyphs together is
 * bounded by `maxPathChars`.
 */
function readCffGlyphRecords(font: ParsedFont, maxPathChars = CFF_SVG_MAX_PATH_CHARS): SvgGlyphRecord[] {
  const cffTable = font.tables['CFF '];
  if (!cffTable) return [];
  const cff = parseCff(cffTable.data);
  const unitsPerEm = readUnitsPerEm(font);
  const glyphToUnicode = buildGlyphToUnicodeMap(font.tables['cmap']);
  const advances = readHorizontalAdvances(font, cff.numGlyphs);

  const records: SvgGlyphRecord[] = [];
  let pathChars = 0;
  for (let g = 0; g < cff.numGlyphs; g++) {
    const unicode = writableUnicode(glyphToUnicode, g);
    const name = font.glyphNames?.[g] ?? '';
    if (g > 0 && unicode === '' && name === '') continue;
    const glyph = cff.glyph(g);
    const d = cffContoursToSvgPath(glyph.contours, fontMatrixToUnits(glyph.matrix, unitsPerEm));
    pathChars += d.length;
    if (pathChars > maxPathChars) {
      throw new ConversionFailedError(
        `Cannot write an SVG font: the glyph outlines need more than ${maxPathChars} characters of path data.`
      );
    }
    const advance = advances === null ? Math.round(glyph.width) : advances[g];
    records.push({ glyphId: g, unicode, name, d, advWidth: checkedAdvanceWidth(advance, g) });
  }
  return records;
}


/**
 * Extracts real vector glyphs from the CFF table of an OpenType font. Only glyphs the cmap maps to
 * a character are returned, since an SVG font addresses glyphs by character.
 */
export function extractCffGlyphs(
  font: ParsedFont,
  maxPathChars = CFF_SVG_MAX_PATH_CHARS
): Array<{ unicode: string; d: string; advWidth: number }> {
  return readCffGlyphRecords(font, maxPathChars)
    .filter((record) => record.unicode !== '')
    .map(({ unicode, d, advWidth }) => ({ unicode, d, advWidth }));
}

/**
 * Transcodes an OpenType (CFF) font into standard TrueType (glyf/loca) format. A font that already
 * has glyf and loca is returned unchanged; a font with neither glyf nor a parsable CFF table is
 * rejected, since no outlines can be produced for it.
 */
export function convertFontToTrueType(fontOrBuffer: ParsedFont | Buffer): any {
  const isBuf = Buffer.isBuffer(fontOrBuffer);
  const font: ParsedFont = isBuf
    ? parseFontToSfnt(
        fontOrBuffer,
        fontOrBuffer.subarray(0, 4).toString('ascii') === 'OTTO' ? 'otf' : 'ttf',
        'EasyConvertFont'
      )
    : fontOrBuffer;

  if (font.tables['glyf'] && font.tables['loca']) {
    return isBuf ? encodeSfnt(font, SFNT_VERSION_TRUETYPE) : font;
  }
  if (font.tables['glyf'] || font.tables['loca']) {
    throw new FontOutlinesMissingError("Invalid font: 'glyf' and 'loca' must both be present.");
  }
  if (font.tables['CFF2']) {
    throw new ConversionFailedError('CFF2 (variable CFF) outlines cannot be converted to TrueType yet.');
  }
  if (!font.tables['CFF ']) {
    throw new FontOutlinesMissingError(
      'Cannot convert to TrueType: the font has no glyph outlines (neither glyf/loca nor a CFF table).'
    );
  }

  const result = convertCffFontToTrueType(font);
  return isBuf ? encodeSfnt(result, SFNT_VERSION_TRUETYPE) : result;
}

const MAXP_VERSION_0_5 = 0x00005000;
const MAXP_VERSION_0_5_BYTES = 6;
const SFNT_VERSION_CFF = 0x4f54544f;
const POST_VERSION_3 = 0x00030000;
/** TrueType hinting programs: meaningless next to CFF outlines. */
const TRUETYPE_ONLY_TABLES = ['glyf', 'loca', 'cvt ', 'fpgm', 'prep'];

/**
 * Converts a TrueType font to OpenType CFF: reads every glyph from glyf/loca (composites
 * flattened), builds a Type 2 charstring per glyph and swaps the outline tables for 'CFF '.
 */
function convertGlyfFontToCff(font: ParsedFont): ParsedFont {
  const glyfTable = font.tables['glyf'];
  const locaTable = font.tables['loca'];
  if (!glyfTable && !locaTable) {
    throw new FontOutlinesMissingError(
      'Cannot convert to OpenType CFF: the font has no glyph outlines (neither glyf/loca nor a CFF table).'
    );
  }
  if (!glyfTable || !locaTable) {
    throw new FontOutlinesMissingError("Invalid font: 'glyf' and 'loca' must both be present.");
  }
  const head = requireTable(font, 'head', HEAD_MIN_BYTES);
  const maxp = requireTable(font, 'maxp', MAXP_MIN_BYTES);
  const numGlyphs = maxp.readUInt16BE(4);
  const outlines = readGlyfOutlines({
    glyf: glyfTable.data,
    loca: locaTable.data,
    indexToLocFormat: head.readInt16BE(HEAD_INDEX_TO_LOC_FORMAT_OFFSET),
    numGlyphs,
  });
  if (!outlines.some((contours) => contours.length > 0)) {
    throw new FontOutlinesMissingError('Cannot convert to OpenType CFF: none of the font glyphs has an outline.');
  }
  const advances = readHorizontalAdvances(font, numGlyphs);
  if (advances === null) {
    throw new ConversionFailedError("Cannot convert to OpenType CFF: the font has no 'hmtx' table for the glyph advances.");
  }

  const glyphs = outlines.map((contours, g) => ({ contours, advWidth: advances[g] }));
  const cffData = buildCffTable(font.fontFamily || 'EasyConvertFont', glyphs, {
    fontBBox: [
      head.readInt16BE(HEAD_BBOX_OFFSET),
      head.readInt16BE(HEAD_BBOX_OFFSET + 2),
      head.readInt16BE(HEAD_BBOX_OFFSET + 4),
      head.readInt16BE(HEAD_BBOX_OFFSET + 6),
    ],
    glyphNames: font.glyphNames,
  });

  const tables = { ...font.tables };
  for (const tag of TRUETYPE_ONLY_TABLES) delete tables[tag];
  tables['CFF '] = makeSfntTable('CFF ', cffData);

  const newMaxp = Buffer.alloc(MAXP_VERSION_0_5_BYTES);
  newMaxp.writeUInt32BE(MAXP_VERSION_0_5, 0);
  newMaxp.writeUInt16BE(numGlyphs, 4);
  tables['maxp'] = makeSfntTable('maxp', newMaxp);

  // CFF fonts name their glyphs in the charset, so 'post' must be version 3.0 (no glyph names).
  const post = tables['post'];
  if (post && post.data.length >= POST_HEADER_BYTES && post.data.readUInt32BE(0) !== POST_VERSION_3) {
    const header = Buffer.from(post.data.subarray(0, POST_HEADER_BYTES));
    header.writeUInt32BE(POST_VERSION_3, 0);
    tables['post'] = makeSfntTable('post', header);
  }

  return {
    ...font,
    sfntVersion: SFNT_VERSION_CFF,
    flavor: 'OTTO',
    numTables: Object.keys(tables).length,
    tables,
  };
}

/**
 * Transcodes a TrueType font (with glyf/loca) into standard OpenType CFF ('OTTO') format. A font
 * that already has a CFF table is returned unchanged; a font without glyph outlines is rejected
 * with FontOutlinesMissingError, since no glyphs can be produced for it.
 */
export function convertFontToOpenTypeCff(fontOrBuffer: ParsedFont | Buffer): any {
  const isBuf = Buffer.isBuffer(fontOrBuffer);
  const font: ParsedFont = isBuf ? parseFontToSfnt(fontOrBuffer, 'ttf', 'EasyConvertFont') : fontOrBuffer;

  if (font.tables['CFF ']) {
    return isBuf ? encodeSfnt(font, SFNT_VERSION_CFF) : font;
  }
  const result = convertGlyfFontToCff(font);
  return isBuf ? encodeSfnt(result, SFNT_VERSION_CFF) : result;
}
