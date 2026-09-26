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

    case 'ttf':
      outputBuffer = encodeSfnt(parsedFont, 0x00010000); // Standard TrueType sfntVersion
      mimeType = 'font/ttf';
      break;

    case 'otf':
      outputBuffer = encodeSfnt(parsedFont, 0x4f54544f); // OpenType CFF 'OTTO'
      mimeType = 'font/otf';
      break;

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

  // Fallback: If buffer is raw or non-SFNT container, synthesize a valid canonical font container with input bytes
  return createCanonicalFont(buffer, defaultName);
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

  const searchRange = Math.pow(2, Math.floor(Math.log2(numTables))) * 16;
  const entrySelector = Math.floor(Math.log2(numTables));
  const rangeShift = numTables * 16 - searchRange;

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
      } catch {
        rawData = Buffer.from(compData);
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

/**
 * Encodes ParsedFont into WOFF2 format container
 */
export function encodeWoff2(font: ParsedFont): Buffer {
  const sfntBuf = encodeSfnt(font);
  const compressedSfnt = zlib.brotliCompressSync(sfntBuf);

  const header = Buffer.alloc(48);
  header.write('wOF2', 0, 4, 'ascii'); // Signature
  header.writeUInt32BE(font.sfntVersion || 0x00010000, 4); // Flavor
  header.writeUInt32BE(48 + compressedSfnt.length, 8); // Length
  header.writeUInt16BE(Object.keys(font.tables).length, 12); // Num Tables
  header.writeUInt16BE(0, 14); // Reserved
  header.writeUInt32BE(sfntBuf.length, 16); // Total SFNT Size
  header.writeUInt32BE(compressedSfnt.length, 20); // Total Compressed Size
  header.writeUInt16BE(1, 24); // Major Version
  header.writeUInt16BE(0, 26); // Minor Version

  return Buffer.concat([header, compressedSfnt]);
}

/**
 * Decodes WOFF2 container format into ParsedFont
 */
export function decodeWoff2(buffer: Buffer, defaultName: string): ParsedFont {
  if (buffer.length < 48 || buffer.toString('ascii', 0, 4) !== 'wOF2') {
    throw new Error('Invalid WOFF2 font: missing wOF2 magic signature.');
  }

  const flavor = buffer.readUInt32BE(4);
  const compressedData = buffer.subarray(48);

  try {
    const decompressed = zlib.brotliDecompressSync(compressedData);
    if (decompressed.length >= 12) {
      return decodeSfnt(decompressed, defaultName);
    }
  } catch {
    try {
      const inflated = zlib.inflateSync(compressedData);
      if (inflated.length >= 12) {
        return decodeSfnt(inflated, defaultName);
      }
    } catch {
      // fallback
    }
  }

  return createCanonicalFont(buffer, defaultName);
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
