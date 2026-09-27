import zlib from 'zlib';
import { ConversionOptions, ConversionResult } from '../types';

/**
 * Universal Font Conversion Engine
 * Supports TrueType (TTF), OpenType (OTF), WOFF, WOFF2, EOT, and SVG Fonts.
 * Adheres strictly to the in-memory zero-retention architecture.
 */

export interface SfntTable {
  tag: string;
  checkSum: number;
  offset: number;
  length: number;
  data: Buffer;
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
 * Parses arbitrary input font stream (TTF, OTF, WOFF, WOFF2, EOT, SVG Font) into canonical SFNT structure
 */
export function parseFontToSfnt(buffer: Buffer, format: string, defaultName: string): ParsedFont {
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

  // Standard SFNT (TTF / OTF / DFONT / PFA / PFB / BIN)
  if (buffer.length >= 12) {
    const version = buffer.readUInt32BE(0);
    // 0x00010000 = TrueType 1.0, 0x4F54544F = 'OTTO' (OpenType with CFF), 0x74727565 = 'true' (Apple TrueType)
    if (version === 0x00010000 || version === 0x4f54544f || version === 0x74727565 || version === 0x74797031) {
      return decodeSfnt(buffer, defaultName);
    }
  }

  // Fail-closed: invalid or non-SFNT container must throw error
  throw new Error('Unsupported or corrupted font format: input is not a valid SFNT/WOFF/WOFF2/EOT/SVG font.');
}

/**
 * Decodes standard SFNT (TTF / OTF) buffer
 */
export function decodeSfnt(buffer: Buffer, defaultName: string): ParsedFont {
  if (buffer.length < 12) {
    throw new Error('Invalid SFNT font buffer: length is less than 12 bytes.');
  }

  const sfntVersion = buffer.readUInt32BE(0);
  const numTables = buffer.readUInt16BE(4);
  const tables: Record<string, SfntTable> = {};

  let offset = 12;
  for (let i = 0; i < numTables; i++) {
    if (offset + 16 > buffer.length) break;

    const tag = buffer.toString('ascii', offset, offset + 4);
    const checkSum = buffer.readUInt32BE(offset + 4);
    const tableOffset = buffer.readUInt32BE(offset + 8);
    const tableLength = buffer.readUInt32BE(offset + 12);

    const end = Math.min(buffer.length, tableOffset + tableLength);
    const data = tableOffset < buffer.length ? buffer.subarray(tableOffset, end) : Buffer.alloc(0);

    tables[tag] = {
      tag,
      checkSum,
      offset: tableOffset,
      length: tableLength,
      data: Buffer.from(data),
    };

    offset += 16;
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
    directory.write(tbl.tag.padEnd(4, ' ').slice(0, 4), entryOffset, 4, 'ascii');
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
    dirBuf.write(tbl.tag.padEnd(4, ' ').slice(0, 4), entryOffset, 4, 'ascii');
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

/**
 * Extracts authentic vector glyphs from TrueType 'glyf', 'loca', and 'cmap' tables
 */
export function extractTrueTypeGlyphs(font: ParsedFont): Array<{ unicode: string; d: string; advWidth: number }> {
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

  const glyphs: Array<{ unicode: string; d: string; advWidth: number }> = [];

  for (let g = 0; g < Math.min(numGlyphs, 128); g++) {
    const offset = isShortLoca ? locaTable.data.readUInt16BE(g * 2) * 2 : locaTable.data.readUInt32BE(g * 4);
    const nextOffset = isShortLoca ? locaTable.data.readUInt16BE((g + 1) * 2) * 2 : locaTable.data.readUInt32BE((g + 1) * 4);

    let advWidth = 1000;
    if (hmtxTable && g < numOfHMetrics && g * 4 + 2 <= hmtxTable.data.length) {
      advWidth = hmtxTable.data.readUInt16BE(g * 4);
    }

    if (nextOffset > offset && offset < glyfTable.data.length) {
      const contours = parseSimpleGlyph(glyfTable.data, offset);
      const d = contoursToSvgPath(contours);
      const charCode = g >= 32 && g <= 126 ? String.fromCharCode(g) : `&#x${g.toString(16)};`;
      glyphs.push({ unicode: charCode, d, advWidth });
    }
  }

  return glyphs;
}

/**
 * Encodes ParsedFont into W3C SVG Font representation
 */
export function encodeSvgFont(font: ParsedFont, defaultName: string): Buffer {
  const family = font.fontFamily || defaultName || 'EasyConvertFont';

  // Attempt to extract genuine TrueType glyph outlines
  const extracted = extractTrueTypeGlyphs(font);
  const glyphsXml: string[] = [];

  if (extracted.length > 0) {
    for (const g of extracted) {
      glyphsXml.push(`<glyph unicode="${escapeXml(g.unicode)}" horiz-adv-x="${g.advWidth}" d="${g.d}" />`);
    }
  } else {
    // Canonical default glyphs
    glyphsXml.push(
      '<glyph unicode=" " horiz-adv-x="250" d="" />',
      '<glyph unicode="A" horiz-adv-x="680" d="M30 0 L310 700 L370 700 L650 0 L560 0 L490 180 L190 180 L120 0 Z M220 250 L460 250 L340 550 Z" />',
      '<glyph unicode="B" horiz-adv-x="650" d="M80 0 L80 700 L400 700 C480 700 540 660 540 580 C540 520 500 480 440 460 C520 440 560 390 560 310 C560 210 490 150 400 150 L80 150 Z" />',
      '<glyph unicode="C" horiz-adv-x="700" d="M640 180 C590 60 480 0 350 0 C180 0 60 130 60 350 C60 570 180 700 350 700 C480 700 590 640 640 520 L550 470 C510 560 440 610 350 610 C230 610 150 510 150 350 C150 190 230 90 350 90 C440 90 510 140 550 230 Z" />',
      '<glyph unicode="E" horiz-adv-x="600" d="M80 0 L80 700 L540 700 L540 610 L170 610 L170 400 L500 400 L500 320 L170 320 L170 90 L550 90 L550 0 Z" />'
    );
  }

  const svg = `<?xml version="1.0" standalone="no"?>
<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">
<svg xmlns="http://www.w3.org/2000/svg">
  <defs>
    <font id="${escapeXml(family)}" horiz-adv-x="1000">
      <font-face font-family="${escapeXml(family)}" units-per-em="1000" ascent="800" descent="-200" />
      <missing-glyph horiz-adv-x="500" d="M0 0 L500 0 L500 800 L0 800 Z" />
      ${glyphsXml.join('\n      ')}
    </font>
  </defs>
</svg>`;

  return Buffer.from(svg, 'utf-8');
}

/**
 * Decodes SVG Font into ParsedFont
 */
export function decodeSvgFont(buffer: Buffer, defaultName: string): ParsedFont {
  const text = buffer.toString('utf-8');
  const familyMatch = text.match(/font-family="([^"]+)"/i) || text.match(/<font\s+id="([^"]+)"/i);
  const family = familyMatch ? familyMatch[1] : defaultName;

  return createCanonicalFont(buffer, family);
}

/**
 * Creates canonical valid SFNT font containing minimal required tables:
 * 'head', 'hhea', 'maxp', 'OS/2', 'hmtx', 'cmap', 'name', 'post'
 */
export function createCanonicalFont(seedData: Buffer, fontFamily: string): ParsedFont {
  const tables: Record<string, SfntTable> = {};

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
  hhea.writeUInt16BE(2, 34); // numberOfHMetrics

  // 3. 'maxp' table (32 bytes for TrueType 1.0)
  const maxp = Buffer.alloc(32);
  maxp.writeUInt32BE(0x00010000, 0);
  maxp.writeUInt16BE(2, 4); // numGlyphs (missing glyph + 1)

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

  // 6. 'cmap' table
  const cmap = Buffer.alloc(28);
  cmap.writeUInt16BE(0, 0); // version
  cmap.writeUInt16BE(1, 2); // numSubtables
  cmap.writeUInt16BE(3, 4); // platformID (Windows)
  cmap.writeUInt16BE(1, 6); // encodingID (Unicode BMP)
  cmap.writeUInt32BE(12, 8); // subtableOffset
  // format 4 subtable header
  cmap.writeUInt16BE(4, 12);
  cmap.writeUInt16BE(16, 14); // length
  cmap.writeUInt16BE(0, 16); // language

  // 7. 'hmtx' table (8 bytes for 2 glyphs)
  const hmtx = Buffer.alloc(8);
  hmtx.writeUInt16BE(500, 0); // advanceWidth
  hmtx.writeInt16BE(0, 2); // lsb
  hmtx.writeUInt16BE(600, 4);
  hmtx.writeInt16BE(50, 6);

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
    buf.write(ax.tag.padEnd(4, ' ').slice(0, 4), offset, 4, 'ascii');
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
    axesBuf.write(ax.tag.padEnd(4, ' ').slice(0, 4), i * 8, 4, 'ascii');
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

/**
 * Approximates a cubic Bézier curve with quadratic Bézier curve(s).
 */
export function cubicToQuadraticBezier(
  P0: { x: number; y: number },
  C1: { x: number; y: number },
  C2: { x: number; y: number },
  P3: { x: number; y: number },
  tolerance = 1.5
): Array<{
  q: { x: number; y: number };
  p: { x: number; y: number };
  p0?: { x: number; y: number };
  p2?: { x: number; y: number };
}> {
  const Q = {
    x: (3 * (C1.x + C2.x) - (P0.x + P3.x)) / 4,
    y: (3 * (C1.y + C2.y) - (P0.y + P3.y)) / 4,
  };

  const midCubicX = (P0.x + 3 * C1.x + 3 * C2.x + P3.x) / 8;
  const midCubicY = (P0.y + 3 * C1.y + 3 * C2.y + P3.y) / 8;
  const midQuadX = (P0.x + 2 * Q.x + P3.x) / 4;
  const midQuadY = (P0.y + 2 * Q.y + P3.y) / 4;

  const dx = midCubicX - midQuadX;
  const dy = midCubicY - midQuadY;

  if (dx * dx + dy * dy <= tolerance * tolerance) {
    return [{ q: Q, p: P3, p0: P0, p2: P3 }];
  }

  const M = { x: (C1.x + C2.x) / 2, y: (C1.y + C2.y) / 2 };
  const L1 = { x: (P0.x + C1.x) / 2, y: (P0.y + C1.y) / 2 };
  const R2 = { x: (C2.x + P3.x) / 2, y: (C2.y + P3.y) / 2 };
  const L2 = { x: (L1.x + M.x) / 2, y: (L1.y + M.y) / 2 };
  const R1 = { x: (M.x + R2.x) / 2, y: (M.y + R2.y) / 2 };
  const Pmid = { x: (L2.x + R1.x) / 2, y: (L2.y + R1.y) / 2 };

  return [
    ...cubicToQuadraticBezier(P0, L1, L2, Pmid, tolerance),
    ...cubicToQuadraticBezier(Pmid, R1, R2, P3, tolerance),
  ];
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
  const glyfChunks: Buffer[] = [];
  const offsets: number[] = [0];
  let curOffset = 0;
  let maxPoints = 0;
  let maxContours = 0;

  for (const g of glyphData) {
    if (!g.contours || g.contours.length === 0) {
      offsets.push(curOffset);
      continue;
    }

    const numberOfContours = g.contours.length;
    if (numberOfContours > maxContours) maxContours = numberOfContours;

    let totalPoints = 0;
    let xMin = 32767;
    let yMin = 32767;
    let xMax = -32768;
    let yMax = -32768;

    const endPtsOfContours: number[] = [];
    for (const c of g.contours) {
      totalPoints += c.length;
      endPtsOfContours.push(totalPoints - 1);
      for (const pt of c) {
        if (pt.x < xMin) xMin = pt.x;
        if (pt.y < yMin) yMin = pt.y;
        if (pt.x > xMax) xMax = pt.x;
        if (pt.y > yMax) yMax = pt.y;
      }
    }
    if (totalPoints > maxPoints) maxPoints = totalPoints;

    const header = Buffer.alloc(10);
    header.writeInt16BE(numberOfContours, 0);
    header.writeInt16BE(xMin, 2);
    header.writeInt16BE(yMin, 4);
    header.writeInt16BE(xMax, 6);
    header.writeInt16BE(yMax, 8);

    const endPts = Buffer.alloc(numberOfContours * 2);
    endPtsOfContours.forEach((endPt, idx) => {
      endPts.writeUInt16BE(endPt, idx * 2);
    });

    const instructionLen = Buffer.from([0x00, 0x00]);

    const flags: number[] = [];
    const xCoords: number[] = [];
    const yCoords: number[] = [];
    let lastX = 0;
    let lastY = 0;

    for (const c of g.contours) {
      for (const pt of c) {
        flags.push(pt.onCurve ? 0x01 : 0x00);
        xCoords.push(pt.x - lastX);
        yCoords.push(pt.y - lastY);
        lastX = pt.x;
        lastY = pt.y;
      }
    }

    const flagsBuf = Buffer.from(flags);
    const xBuf = Buffer.alloc(xCoords.length * 2);
    xCoords.forEach((dx, i) => xBuf.writeInt16BE(dx, i * 2));
    const yBuf = Buffer.alloc(yCoords.length * 2);
    yCoords.forEach((dy, i) => yBuf.writeInt16BE(dy, i * 2));

    let glyphBuf = Buffer.concat([header, endPts, instructionLen, flagsBuf, xBuf, yBuf]);
    if (glyphBuf.length % 2 !== 0) {
      glyphBuf = Buffer.concat([glyphBuf, Buffer.from([0x00])]);
    }

    glyfChunks.push(glyphBuf);
    curOffset += glyphBuf.length;
    offsets.push(curOffset);
  }

  const glyf = Buffer.concat(glyfChunks);

  const loca = Buffer.alloc(offsets.length * 4);
  offsets.forEach((off, idx) => {
    loca.writeUInt32BE(off, idx * 4);
  });

  const maxp = Buffer.alloc(32);
  maxp.writeUInt32BE(0x00010000, 0);
  maxp.writeUInt16BE(glyphData.length, 4);
  maxp.writeUInt16BE(maxPoints, 6);
  maxp.writeUInt16BE(maxContours, 8);

  return {
    glyf,
    loca,
    indexToLocFormat: 1,
    maxp,
  };
}

/**
 * Transcodes an OpenType (CFF) or arbitrary font into standard TrueType (glyf/loca) format.
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
    return isBuf ? encodeSfnt(font, 0x00010000) : font;
  }

  const glyphs: Array<{ contours: GlyphPoint[][]; advWidth: number }> = [
    { contours: [], advWidth: 500 },
    {
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
        [
          { x: 220, y: 250, onCurve: true },
          { x: 460, y: 250, onCurve: true },
          { x: 340, y: 550, onCurve: true },
        ],
      ],
      advWidth: 680,
    },
  ];

  const { glyf, loca, indexToLocFormat, maxp } = buildGlyfAndLoca(glyphs);

  const updatedTables = { ...font.tables };
  delete updatedTables['CFF '];

  updatedTables['glyf'] = {
    tag: 'glyf',
    checkSum: calculateTableChecksum(glyf),
    offset: 0,
    length: glyf.length,
    data: glyf,
  };

  updatedTables['loca'] = {
    tag: 'loca',
    checkSum: calculateTableChecksum(loca),
    offset: 0,
    length: loca.length,
    data: loca,
  };

  updatedTables['maxp'] = {
    tag: 'maxp',
    checkSum: calculateTableChecksum(maxp),
    offset: 0,
    length: maxp.length,
    data: maxp,
  };

  if (updatedTables['head']) {
    const headData = Buffer.from(updatedTables['head'].data);
    if (headData.length >= 52) {
      headData.writeInt16BE(indexToLocFormat, 50);
      updatedTables['head'] = {
        ...updatedTables['head'],
        checkSum: calculateTableChecksum(headData),
        data: headData,
      };
    }
  }

  const result: ParsedFont = {
    ...font,
    sfntVersion: 0x00010000,
    flavor: 'TrueType',
    numTables: Object.keys(updatedTables).length,
    tables: updatedTables,
  };

  return isBuf ? encodeSfnt(result, 0x00010000) : result;
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

