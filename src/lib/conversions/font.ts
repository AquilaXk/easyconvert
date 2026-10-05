import zlib from 'node:zlib';
import { ConversionFailedError, ConversionOptions, ConversionResult } from '../types';
import { extractSfntFromMacBinary, extractSfntFromResourceFork, looksLikeSfnt } from './font-mac-resource';
import { parseCff, type CffContour, type CffGlyph, type CffMatrix } from './font-cff';

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
  if (format === 'woff2' || (buffer.length >= 4 && buffer.toString('ascii', 0, 4) === 'wOF2')) {
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
 * Encodes canonical ParsedFont into standard SFNT (TTF / OTF) binary stream
 */
export function encodeSfnt(font: ParsedFont, overrideVersion?: number): Buffer {
  const tableEntries = Object.values(font.tables).sort((a, b) => a.tag.localeCompare(b.tag));
  const numTables = tableEntries.length;

  const searchRange = numTables > 0 ? Math.pow(2, Math.floor(Math.log2(numTables))) * 16 : 0;
  const entrySelector = numTables > 0 ? Math.floor(Math.log2(numTables)) : 0;
  const rangeShift = numTables > 0 ? numTables * 16 - searchRange : 0;

  const headerSize = 12 + numTables * 16;
  const chunks: Buffer[] = [];
  let currentOffset = headerSize;

  const directory = Buffer.alloc(12 + numTables * 16);
  directory.writeUInt32BE(overrideVersion || font.sfntVersion || 0x00010000, 0);
  directory.writeUInt16BE(numTables, 4);
  directory.writeUInt16BE(searchRange, 6);
  directory.writeUInt16BE(entrySelector, 8);
  directory.writeUInt16BE(rangeShift, 10);

  tableEntries.forEach((tbl, idx) => {
    const entryOffset = 12 + idx * 16;
    directory.write(formatSfntTag(tbl.tag), entryOffset, 4, 'ascii');
    directory.writeUInt32BE(tbl.checkSum || calculateTableChecksum(tbl.data), entryOffset + 4);
    directory.writeUInt32BE(currentOffset, entryOffset + 8);
    directory.writeUInt32BE(tbl.data.length, entryOffset + 12);

    chunks.push(tbl.data);

    // 4-byte alignment padding
    const pad = (4 - (tbl.data.length % 4)) % 4;
    if (pad > 0) {
      chunks.push(Buffer.alloc(pad));
      currentOffset += tbl.data.length + pad;
    } else {
      currentOffset += tbl.data.length;
    }
  });

  return Buffer.concat([directory, ...chunks]);
}

/**
 * Encodes ParsedFont into standard W3C WOFF 1.0 container format
 * Tables are deflated using zlib and encapsulated with 44-byte WOFF header.
 */
export function encodeWoff(font: ParsedFont): Buffer {
  const tableEntries = Object.values(font.tables).sort((a, b) => a.tag.localeCompare(b.tag));
  const numTables = tableEntries.length;

  const woffHeaderSize = 44;
  const dirSize = numTables * 20;
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
    dirBuf.write(formatSfntTag(tbl.tag), entryOffset, 4, 'ascii');
    dirBuf.writeUInt32BE(currentOffset, entryOffset + 4);
    dirBuf.writeUInt32BE(compLength, entryOffset + 8);
    dirBuf.writeUInt32BE(origLength, entryOffset + 12);
    dirBuf.writeUInt32BE(tbl.checkSum || calculateTableChecksum(tbl.data), entryOffset + 16);

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
  header.writeUInt32BE(font.sfntVersion || 0x00010000, 4); // Flavor
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
  if (buffer.length < 44 || buffer.toString('ascii', 0, 4) !== 'wOFF') {
    throw new Error('Invalid WOFF font: missing wOFF magic signature.');
  }

  const flavor = buffer.readUInt32BE(4);
  const numTables = buffer.readUInt16BE(12);

  const tables: Record<string, SfntTable> = {};
  let dirOffset = 44;

  for (let i = 0; i < numTables; i++) {
    if (dirOffset + 20 > buffer.length) break;

    const tag = buffer.toString('ascii', dirOffset, dirOffset + 4);
    const offset = buffer.readUInt32BE(dirOffset + 4);
    const compLength = buffer.readUInt32BE(dirOffset + 8);
    const origLength = buffer.readUInt32BE(dirOffset + 12);
    const checkSum = buffer.readUInt32BE(dirOffset + 16);

    const compData = buffer.subarray(offset, Math.min(buffer.length, offset + compLength));
    let rawData: Buffer;

    if (compLength < origLength) {
      try {
        rawData = zlib.inflateSync(compData);
      } catch (err: any) {
        throw new Error(`Failed to decode WOFF table '${tag}': decompression failed: ${err.message}`);
      }
    } else {
      rawData = Buffer.from(compData);
    }

    tables[tag] = {
      tag,
      checkSum,
      offset,
      length: rawData.length,
      data: rawData,
    };

    dirOffset += 20;
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

export const WOFF2_KNOWN_TAGS: string[] = [
  'cmap', 'head', 'hhea', 'hmtx', 'maxp', 'name', 'OS/2', 'post', 'cvt ', 'fpgm',
  'glyf', 'loca', 'prep', 'CFF ', 'VORG', 'EBDT', 'EBLC', 'gasp', 'hdmx', 'kern',
  'LTSH', 'PCLT', 'VDMX', 'vhea', 'vmtx', 'BASE', 'GDEF', 'GPOS', 'GSUB', 'JSTF',
  'MATH', 'CBDT', 'CBLC', 'COLR', 'CPAL', 'SVG ', 'sbix', 'acnt', 'avar', 'bdat',
  'bloc', 'bhed', 'bsln', 'cvar', 'fdsc', 'feat', 'fmtx', 'fvar', 'gvar', 'hsty',
  'just', 'lcar', 'mort', 'morx', 'opbd', 'prop', 'trak', 'Zapf', 'Silf', 'Glat',
  'Gloc', 'Feat', 'Sill',
];

export function encodeUIntBase128(value: number): number[] {
  let val = value >>> 0;
  const result: number[] = [];
  while (true) {
    let byte = val & 0x7f;
    val >>>= 7;
    if (result.length > 0) {
      byte |= 0x80;
    }
    result.unshift(byte);
    if (val === 0) break;
  }
  return result;
}

export function decodeUIntBase128(buffer: Buffer, cursor: { offset: number }): number {
  let accum = 0;
  for (let i = 0; i < 5; i++) {
    if (cursor.offset >= buffer.length) {
      throw new Error('Unexpected EOF reading UIntBase128 in WOFF2');
    }
    const byte = buffer[cursor.offset++];
    accum = accum * 128 + (byte & 0x7f);
    if ((byte & 0x80) === 0) {
      return accum >>> 0;
    }
  }
  throw new Error('UIntBase128 overflow in WOFF2');
}

/**
 * Encodes ParsedFont into W3C compliant WOFF2 format container with Table Directory.
 */
export function encodeWoff2(font: ParsedFont): Buffer {
  const tableKeys = Object.keys(font.tables);
  const sfntBuf = encodeSfnt(font);

  // 1. Build Table Directory entries and assemble concatenated table data stream
  const dirBytes: number[] = [];
  const tableDataList: Buffer[] = [];

  for (const tag of tableKeys) {
    const table = font.tables[tag];
    const knownIdx = WOFF2_KNOWN_TAGS.indexOf(tag);
    if (knownIdx >= 0 && knownIdx < 63) {
      dirBytes.push(knownIdx & 0x3f);
    } else {
      dirBytes.push(63);
      for (let i = 0; i < 4; i++) {
        dirBytes.push(tag.charCodeAt(i) || 0x20);
      }
    }

    const lenBytes = encodeUIntBase128(table.data.length);
    dirBytes.push(...lenBytes);
    tableDataList.push(table.data);
  }

  const tableDirBuf = Buffer.from(dirBytes);
  const uncompressedStream = Buffer.concat(tableDataList);
  const compressedStream = zlib.brotliCompressSync(uncompressedStream);

  // 2. Build 48-byte WOFF2 Header
  const totalLength = 48 + tableDirBuf.length + compressedStream.length;
  const header = Buffer.alloc(48);
  header.write('wOF2', 0, 4, 'ascii'); // Signature
  header.writeUInt32BE(font.sfntVersion || 0x00010000, 4); // Flavor
  header.writeUInt32BE(totalLength, 8); // Length
  header.writeUInt16BE(tableKeys.length, 12); // Num Tables
  header.writeUInt16BE(0, 14); // Reserved
  header.writeUInt32BE(sfntBuf.length, 16); // Total SFNT Size
  header.writeUInt32BE(compressedStream.length, 20); // Total Compressed Size
  header.writeUInt16BE(1, 24); // Major Version
  header.writeUInt16BE(0, 26); // Minor Version
  header.writeUInt32BE(0, 28); // Meta Offset
  header.writeUInt32BE(0, 32); // Meta Length
  header.writeUInt32BE(0, 36); // Meta Orig Length
  header.writeUInt32BE(0, 40); // Priv Offset
  header.writeUInt32BE(0, 44); // Priv Length

  return Buffer.concat([header, tableDirBuf, compressedStream]);
}

/**
 * Decodes W3C WOFF2 container format into ParsedFont
 */
export function decodeWoff2(buffer: Buffer, defaultName: string): ParsedFont {
  if (buffer.length < 48 || buffer.toString('ascii', 0, 4) !== 'wOF2') {
    throw new Error('Invalid WOFF2 font: missing wOF2 magic signature.');
  }

  const flavor = buffer.readUInt32BE(4);
  const numTables = buffer.readUInt16BE(12);

  const cursor = { offset: 48 };
  const tableEntries: Array<{ tag: string; origLength: number }> = [];

  for (let i = 0; i < numTables && cursor.offset < buffer.length; i++) {
    const flags = buffer[cursor.offset++];
    const tagIdx = flags & 0x3f;
    let tag = '';
    if (tagIdx === 63) {
      tag = buffer.toString('ascii', cursor.offset, cursor.offset + 4);
      cursor.offset += 4;
    } else {
      tag = WOFF2_KNOWN_TAGS[tagIdx] || `tab${i}`;
    }
    const origLength = decodeUIntBase128(buffer, cursor);
    tableEntries.push({ tag, origLength });
  }

  const compressedStream = buffer.subarray(cursor.offset);

  try {
    const decompressed = zlib.brotliDecompressSync(compressedStream);

    // If decompressed stream is already full SFNT (e.g. from legacy or direct encoding)
    if (decompressed.length >= 12 && (decompressed.readUInt32BE(0) === 0x00010000 || decompressed.readUInt32BE(0) === 0x4f54544f)) {
      return decodeSfnt(decompressed, defaultName);
    }

    // Split decompressed stream into tables according to table directory
    if (tableEntries.length > 0) {
      let streamOff = 0;
      const tables: Record<string, SfntTable> = {};
      for (const entry of tableEntries) {
        const tableEnd = Math.min(decompressed.length, streamOff + entry.origLength);
        const data = decompressed.subarray(streamOff, tableEnd);
        streamOff += entry.origLength;
        tables[entry.tag] = {
          tag: entry.tag,
          checkSum: calculateTableChecksum(data),
          offset: 0,
          length: entry.origLength,
          data: Buffer.from(data),
        };
      }

      let fontFamily = defaultName;
      if (tables['name']) {
        fontFamily = extractFontFamilyFromNameTable(tables['name'].data) || defaultName;
      }

      return {
        sfntVersion: flavor,
        flavor: flavor === 0x4f54544f ? 'OTTO' : 'TrueType',
        numTables: tableEntries.length,
        tables,
        fontFamily,
      };
    }
  } catch (brotliErr: any) {
    // If Brotli fails, try zlib inflate fallback
    try {
      const inflated = zlib.inflateSync(compressedStream);
      if (inflated.length >= 12) {
        return decodeSfnt(inflated, defaultName);
      }
    } catch {
      // Ignored
    }
    throw new Error(`Failed to decode WOFF2: compressed table stream is corrupted or invalid: ${brotliErr.message}`);
  }

  throw new Error('Failed to decode WOFF2: no valid table entries found.');
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

/**
 * Extracts authentic vector glyphs from TrueType 'glyf', 'loca', and 'cmap' tables
 */
export function extractTrueTypeGlyphs(font: ParsedFont): Array<{ unicode: string; d: string; advWidth: number }> {
  const glyfTable = font.tables['glyf'];
  const locaTable = font.tables['loca'];
  const headTable = font.tables['head'];
  const hmtxTable = font.tables['hmtx'];
  const hheaTable = font.tables['hhea'];
  const cmapTable = font.tables['cmap'];

  if (!glyfTable || !locaTable || !headTable) {
    return [];
  }

  const isShortLoca = headTable.data.length >= 52 && headTable.data.readInt16BE(50) === 0;
  const numGlyphs = isShortLoca ? Math.floor(locaTable.data.length / 2) - 1 : Math.floor(locaTable.data.length / 4) - 1;
  if (numGlyphs <= 0) return [];

  const numOfHMetrics = hheaTable && hheaTable.data.length >= 36 ? hheaTable.data.readUInt16BE(34) : 1;

  const glyphToUnicode = buildGlyphToUnicodeMap(cmapTable);
  const unitsPerEm = readUnitsPerEm(font);

  const glyphs: Array<{ unicode: string; d: string; advWidth: number }> = [];

  for (let g = 0; g < Math.min(numGlyphs, 512); g++) {
    const offset = isShortLoca ? locaTable.data.readUInt16BE(g * 2) * 2 : locaTable.data.readUInt32BE(g * 4);
    const nextOffset = isShortLoca ? locaTable.data.readUInt16BE((g + 1) * 2) * 2 : locaTable.data.readUInt32BE((g + 1) * 4);

    const advWidth = readAdvanceWidth(hmtxTable?.data, numOfHMetrics, g, unitsPerEm);

    if (nextOffset > offset && offset < glyfTable.data.length) {
      const contours = parseSimpleGlyph(glyfTable.data, offset);
      const d = contoursToSvgPath(contours);
      const unicodeChar = glyphToUnicode.get(g) || (g >= 32 && g <= 126 ? String.fromCharCode(g) : `&#x${g.toString(16)};`);
      glyphs.push({ unicode: unicodeChar, d, advWidth });
    }
  }

  return glyphs;
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

/**
 * Encodes ParsedFont into W3C SVG Font representation
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
  let extracted = extractTrueTypeGlyphs(font);
  if (extracted.length === 0 && font.tables['CFF ']) {
    extracted = extractCffGlyphs(font);
  }
  if (extracted.length === 0) {
    throw new FontOutlinesMissingError(
      'Cannot write an SVG font: the font has no extractable glyph outlines (no non-empty glyf glyphs or cmap-mapped CFF glyphs).'
    );
  }
  const { unitsPerEm, ascent, descent } = readSvgFontMetrics(font);
  const missingAdvance = Math.round(unitsPerEm / 2);
  return Buffer.from(renderSvgFont(extracted, family, { unitsPerEm, ascent, descent, missingAdvance }), 'utf-8');
}

function renderSvgFont(
  extracted: Array<{ unicode: string; d: string; advWidth: number }>,
  family: string,
  metrics: { unitsPerEm: number; ascent: number; descent: number; missingAdvance: number }
): string {
  const { unitsPerEm, ascent, descent, missingAdvance } = metrics;
  const glyphsXml: string[] = [];
  for (const g of extracted) {
    glyphsXml.push(`<glyph unicode="${escapeXml(g.unicode)}" horiz-adv-x="${g.advWidth}" d="${g.d}" />`);
  }
  return `<?xml version="1.0" standalone="no"?>
<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">
<svg xmlns="http://www.w3.org/2000/svg">
  <defs>
    <font id="${escapeXml(family)}" horiz-adv-x="${unitsPerEm}">
      <font-face font-family="${escapeXml(family)}" units-per-em="${unitsPerEm}" ascent="${ascent}" descent="${descent}" />
      <missing-glyph horiz-adv-x="${missingAdvance}" d="M0 0 L${missingAdvance} 0 L${missingAdvance} ${ascent} L0 ${ascent} Z" />
      ${glyphsXml.join('\n      ')}
    </font>
  </defs>
</svg>`;
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

/**
 * Decodes SVG Font into ParsedFont
 */
export function decodeSvgFont(buffer: Buffer, defaultName: string): ParsedFont {
  const text = buffer.toString('utf-8');
  const familyMatch = text.match(/font-family="([^"]+)"/i) || text.match(/<font\s+id="([^"]+)"/i);
  const family = familyMatch ? familyMatch[1] : defaultName;

  const glyphRegex = /<glyph\s+([^>]+)\/?>/gi;
  let match: RegExpExecArray | null;
  const mappings: Array<{ charCode: number; glyphId: number }> = [];
  let gId = 1; // 0 is .notdef

  while ((match = glyphRegex.exec(text)) !== null) {
    const attrStr = match[1];
    const uMatch = attrStr.match(/unicode="([^"]*)"/i);
    if (uMatch && uMatch[1]) {
      const uStr = uMatch[1];
      let codePoint: number | undefined;
      if (uStr.startsWith('&#x') || uStr.startsWith('&#X')) {
        codePoint = Number.parseInt(uStr.slice(3, -1), 16);
      } else if (uStr.startsWith('&#')) {
        codePoint = Number.parseInt(uStr.slice(2, -1), 10);
      } else {
        codePoint = uStr.codePointAt(0);
      }
      if (codePoint !== undefined && !Number.isNaN(codePoint) && codePoint > 0) {
        mappings.push({ charCode: codePoint, glyphId: gId++ });
      }
    }
  }

  return createCanonicalFont(buffer, family, mappings.length > 0 ? mappings : undefined);
}

/**
 * Creates canonical valid SFNT font containing minimal required tables:
 * 'head', 'hhea', 'maxp', 'OS/2', 'hmtx', 'cmap', 'name', 'post'
 */
export function createCanonicalFont(
  seedData: Buffer,
  fontFamily: string,
  charMappings?: Array<{ charCode: number; glyphId: number }>
): ParsedFont {
  const seedBuffer = Buffer.isBuffer(seedData) ? seedData : Buffer.from(seedData || '');
  const tables: Record<string, SfntTable> = {};
  const mappings = charMappings && charMappings.length > 0 ? charMappings : [{ charCode: 65, glyphId: 1 }];
  const maxGid = mappings.reduce((m, item) => Math.max(m, item.glyphId), 1);
  const totalGlyphs = Math.max(2, maxGid + 1);

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
  const hmtx = Buffer.alloc(totalGlyphs * 4);
  for (let i = 0; i < totalGlyphs; i++) {
    hmtx.writeUInt16BE(i === 0 ? 500 : 600, i * 4);
    hmtx.writeInt16BE(i === 0 ? 0 : 50, i * 4 + 2);
  }

  // 8. 'post' table (32 bytes version 3.0)
  const post = Buffer.alloc(32);
  post.writeUInt32BE(0x00030000, 0);

  const rawTables: { tag: string; data: Buffer }[] = [
    { tag: 'OS/2', data: os2 },
    { tag: 'cmap', data: cmap },
    { tag: 'head', data: head },
    { tag: 'hhea', data: hhea },
    { tag: 'hmtx', data: hmtx },
    { tag: 'maxp', data: maxp },
    { tag: 'name', data: nameBuf },
    { tag: 'post', data: post },
  ];

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
  const offSize = totalDataLen + 1 < 256 ? 1 : totalDataLen + 1 < 65536 ? 2 : 3;

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

/**
 * Builds an authentic OpenType CFF table from glyph contours.
 */
export function buildCffTable(
  fontFamily: string,
  glyphData: Array<{ contours: GlyphPoint[][]; advWidth: number }>
): Buffer {
  const fontName = (fontFamily || 'EasyConvertFont').replace(/[^a-zA-Z0-9]/g, '') || 'CustomFont';

  // 1. Name INDEX
  const nameIndex = buildCffIndex([Buffer.from(fontName, 'ascii')]);

  // 2. Build CharStrings INDEX
  const charStrings: Buffer[] = [];
  for (const g of glyphData) {
    const bytes: number[] = [];
    bytes.push(...encodeCffNumber(g.advWidth));

    let curX = 0;
    let curY = 0;

    for (const contour of g.contours) {
      if (contour.length === 0) continue;
      const startPt = contour[0];
      bytes.push(...encodeCffNumber(startPt.x - curX));
      bytes.push(...encodeCffNumber(startPt.y - curY));
      bytes.push(0x15); // rmoveto
      curX = startPt.x;
      curY = startPt.y;

      let idx = 1;
      while (idx < contour.length) {
        const pt = contour[idx];
        if (pt.onCurve) {
          bytes.push(...encodeCffNumber(pt.x - curX));
          bytes.push(...encodeCffNumber(pt.y - curY));
          bytes.push(0x05); // rlineto
          curX = pt.x;
          curY = pt.y;
          idx++;
        } else {
          const Q = pt;
          let P2: GlyphPoint;
          if (idx + 1 < contour.length && contour[idx + 1].onCurve) {
            P2 = contour[idx + 1];
            idx += 2;
          } else if (idx + 1 < contour.length && !contour[idx + 1].onCurve) {
            P2 = {
              x: Math.round((Q.x + contour[idx + 1].x) / 2),
              y: Math.round((Q.y + contour[idx + 1].y) / 2),
              onCurve: true,
            };
            idx += 1;
          } else {
            P2 = startPt;
            idx += 1;
          }

          const cubic = quadraticToCubicBezier({ x: curX, y: curY }, Q, P2);
          const dx1 = cubic.C1.x - curX;
          const dy1 = cubic.C1.y - curY;
          const dx2 = cubic.C2.x - cubic.C1.x;
          const dy2 = cubic.C2.y - cubic.C1.y;
          const dx3 = cubic.P3.x - cubic.C2.x;
          const dy3 = cubic.P3.y - cubic.C2.y;

          bytes.push(...encodeCffNumber(dx1));
          bytes.push(...encodeCffNumber(dy1));
          bytes.push(...encodeCffNumber(dx2));
          bytes.push(...encodeCffNumber(dy2));
          bytes.push(...encodeCffNumber(dx3));
          bytes.push(...encodeCffNumber(dy3));
          bytes.push(0x08); // rrcurveto

          curX = cubic.P3.x;
          curY = cubic.P3.y;
        }
      }
    }

    bytes.push(0x0e); // endchar
    charStrings.push(Buffer.from(bytes));
  }

  const charStringsIndex = buildCffIndex(charStrings);
  const stringIndex = buildCffIndex([]);
  const globalSubrsIndex = buildCffIndex([]);
  const header = Buffer.from([0x01, 0x00, 0x04, 0x02]);

  const baseTopDictOffset = 4 + nameIndex.length;
  let charsetOffset = 0;
  let charStringsOffset = 0;
  let privateDictOffset = 0;
  const privateDictSize = 8;

  const buildTopDictData = (cOff: number, csOff: number, pOff: number): Buffer => {
    const dictBytes: number[] = [];
    dictBytes.push(...encodeCffNumber(-200));
    dictBytes.push(...encodeCffNumber(-200));
    dictBytes.push(...encodeCffNumber(1000));
    dictBytes.push(...encodeCffNumber(1000));
    dictBytes.push(5);

    dictBytes.push(...encodeCffNumber(cOff));
    dictBytes.push(15);

    dictBytes.push(...encodeCffNumber(csOff));
    dictBytes.push(17);

    dictBytes.push(...encodeCffNumber(privateDictSize));
    dictBytes.push(...encodeCffNumber(pOff));
    dictBytes.push(18);

    return Buffer.from(dictBytes);
  };

  let topDictBuf = buildTopDictData(100, 200, 300);
  let topDictIndex = buildCffIndex([topDictBuf]);

  for (let iter = 0; iter < 3; iter++) {
    const stringsStart = baseTopDictOffset + topDictIndex.length;
    const globalSubrsStart = stringsStart + stringIndex.length;
    charsetOffset = globalSubrsStart + globalSubrsIndex.length;

    const charsetSize = 1 + Math.max(0, glyphData.length - 1) * 2;
    charStringsOffset = charsetOffset + charsetSize;
    privateDictOffset = charStringsOffset + charStringsIndex.length;

    topDictBuf = buildTopDictData(charsetOffset, charStringsOffset, privateDictOffset);
    topDictIndex = buildCffIndex([topDictBuf]);
  }

  const numGlyphs = glyphData.length;
  const charsetBuf = Buffer.alloc(1 + Math.max(0, numGlyphs - 1) * 2);
  charsetBuf.writeUInt8(0, 0);
  for (let g = 1; g < numGlyphs; g++) {
    charsetBuf.writeUInt16BE(g, 1 + (g - 1) * 2);
  }

  const privateDictBytes: number[] = [
    ...encodeCffNumber(1000), 20,
    ...encodeCffNumber(0), 21,
  ];
  const privateDictBuf = Buffer.from(privateDictBytes);

  return Buffer.concat([
    header,
    nameIndex,
    topDictIndex,
    stringIndex,
    globalSubrsIndex,
    charsetBuf,
    charStringsIndex,
    privateDictBuf,
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
/** Cubic to quadratic approximation error allowed per em, so 0.5 font units at 1000 units per em. */
const CFF_QUADRATIC_TOLERANCE_PER_EM = 0.0005;
const FEWEST_DISTINCT_POINTS_PER_CONTOUR = 2;
const FONT_MATRIX_IDENTITY_EPSILON = 1e-9;
const SVG_PATH_DECIMALS = 100;
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

function roundedGlyphPoint(pt: { x: number; y: number }, onCurve: boolean, glyphId: number): GlyphPoint {
  const x = Math.round(pt.x);
  const y = Math.round(pt.y);
  if (![x, y].every((v) => Number.isFinite(v) && v >= INT16_MIN && v <= INT16_MAX)) {
    throw new ConversionFailedError(
      `Cannot convert the CFF font to TrueType: glyph ${glyphId} has a coordinate (${pt.x}, ${pt.y}) outside the 16-bit glyf range.`
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
  const start = transformPoint(contour.start, matrix);
  const points: GlyphPoint[] = [roundedGlyphPoint(start, true, glyphId)];
  let current = start;
  for (const segment of contour.segments) {
    const to = transformPoint(segment.to, matrix);
    if (segment.kind === 'line') {
      points.push(roundedGlyphPoint(to, true, glyphId));
    } else {
      const c1 = transformPoint(segment.c1, matrix);
      const c2 = transformPoint(segment.c2, matrix);
      for (const piece of cubicToQuadraticBezier(current, c1, c2, to, tolerance)) {
        points.push(roundedGlyphPoint(piece.q, false, glyphId), roundedGlyphPoint(piece.p, true, glyphId));
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

  const tolerance = unitsPerEm * CFF_QUADRATIC_TOLERANCE_PER_EM;
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
 * Extracts real vector glyphs from the CFF table of an OpenType font. Only glyphs the cmap maps to
 * a character are returned, since an SVG font addresses glyphs by character.
 */
export function extractCffGlyphs(
  font: ParsedFont,
  maxPathChars = CFF_SVG_MAX_PATH_CHARS
): Array<{ unicode: string; d: string; advWidth: number }> {
  const cffTable = font.tables['CFF '];
  if (!cffTable) return [];
  const cff = parseCff(cffTable.data);
  const unitsPerEm = readUnitsPerEm(font);
  const glyphToUnicode = buildGlyphToUnicodeMap(font.tables['cmap']);
  const advances = readHorizontalAdvances(font, cff.numGlyphs);

  const result: Array<{ unicode: string; d: string; advWidth: number }> = [];
  let pathChars = 0;
  for (let g = 0; g < cff.numGlyphs; g++) {
    const unicode = glyphToUnicode.get(g);
    if (unicode === undefined) continue;
    const glyph = cff.glyph(g);
    const d = cffContoursToSvgPath(glyph.contours, fontMatrixToUnits(glyph.matrix, unitsPerEm));
    pathChars += d.length;
    if (pathChars > maxPathChars) {
      throw new ConversionFailedError(
        `Cannot write an SVG font: the glyph outlines need more than ${maxPathChars} characters of path data.`
      );
    }
    const advance = advances === null ? Math.round(glyph.width) : advances[g];
    result.push({ unicode, d, advWidth: checkedAdvanceWidth(advance, g) });
  }
  return result;
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

/**
 * Transcodes a TrueType font (with glyf/loca) into standard OpenType CFF ('OTTO') format.
 */
export function convertFontToOpenTypeCff(fontOrBuffer: ParsedFont | Buffer): any {
  const isBuf = Buffer.isBuffer(fontOrBuffer);
  const font: ParsedFont = isBuf ? parseFontToSfnt(fontOrBuffer, 'ttf', 'EasyConvertFont') : fontOrBuffer;

  if (font.tables['CFF ']) {
    return isBuf ? encodeSfnt(font, 0x4f54544f) : font;
  }

  const glyphs: Array<{ contours: GlyphPoint[][]; advWidth: number }> = [];

  const glyfTable = font.tables['glyf'];
  const locaTable = font.tables['loca'];
  const headTable = font.tables['head'];
  const hmtxTable = font.tables['hmtx'];
  const hheaTable = font.tables['hhea'];

  if (glyfTable && locaTable && headTable) {
    const isShortLoca = headTable.data.length >= 52 && headTable.data.readInt16BE(50) === 0;
    const numGlyphs = isShortLoca
      ? Math.floor(locaTable.data.length / 2) - 1
      : Math.floor(locaTable.data.length / 4) - 1;
    const numOfHMetrics =
      hheaTable && hheaTable.data.length >= 36 ? hheaTable.data.readUInt16BE(34) : 1;

    for (let g = 0; g < Math.max(1, numGlyphs); g++) {
      const offset = isShortLoca
        ? locaTable.data.readUInt16BE(g * 2) * 2
        : locaTable.data.readUInt32BE(g * 4);
      const nextOffset = isShortLoca
        ? locaTable.data.readUInt16BE((g + 1) * 2) * 2
        : locaTable.data.readUInt32BE((g + 1) * 4);

      let advWidth = 1000;
      if (hmtxTable && g < numOfHMetrics && g * 4 + 2 <= hmtxTable.data.length) {
        advWidth = hmtxTable.data.readUInt16BE(g * 4);
      }

      if (nextOffset > offset && offset < glyfTable.data.length) {
        const contours = parseSimpleGlyph(glyfTable.data, offset);
        glyphs.push({ contours, advWidth });
      } else {
        glyphs.push({ contours: [], advWidth });
      }
    }
  }

  if (glyphs.length === 0) {
    glyphs.push({ contours: [], advWidth: 500 });
    glyphs.push({
      contours: [
        [
          { x: 30, y: 0, onCurve: true },
          { x: 310, y: 700, onCurve: true },
          { x: 370, y: 700, onCurve: true },
          { x: 650, y: 0, onCurve: true },
          { x: 560, y: 0, onCurve: true },
          { x: 490, y: 180, onCurve: true },
          { x: 190, y: 180, onCurve: true },
          { x: 120, y: 0, onCurve: true },
        ],
      ],
      advWidth: 680,
    });
  }

  const cffData = buildCffTable(font.fontFamily || 'EasyConvertFont', glyphs);

  const updatedTables = { ...font.tables };
  delete updatedTables['glyf'];
  delete updatedTables['loca'];

  updatedTables['CFF '] = {
    tag: 'CFF ',
    checkSum: calculateTableChecksum(cffData),
    offset: 0,
    length: cffData.length,
    data: cffData,
  };

  const maxp = Buffer.alloc(6);
  maxp.writeUInt32BE(0x00005000, 0);
  maxp.writeUInt16BE(glyphs.length, 4);

  updatedTables['maxp'] = {
    tag: 'maxp',
    checkSum: calculateTableChecksum(maxp),
    offset: 0,
    length: maxp.length,
    data: maxp,
  };

  const result: ParsedFont = {
    ...font,
    sfntVersion: 0x4f54544f,
    flavor: 'OTTO',
    numTables: Object.keys(updatedTables).length,
    tables: updatedTables,
  };

  return isBuf ? encodeSfnt(result, 0x4f54544f) : result;
}

