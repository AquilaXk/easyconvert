/**
 * Independent writers for classic Macintosh font containers, authored from the published
 * layouts (Inside Macintosh resource file format, MacBinary II/III specification) with no
 * dependency on src/. Used to build .dfont and .bin inputs and hostile variants of them.
 */

// ---------------------------------------------------------------------------
// Minimal TrueType font (glyf outlines) built from the OpenType specification.
// ---------------------------------------------------------------------------

export interface TestGlyph {
  /** Unicode code point mapped to this glyph through the BMP cmap. */
  codePoint: number;
  /** Closed contours of on-curve points in font units. */
  contours: Array<Array<[number, number]>>;
}

export interface TestFontSpec {
  family: string;
  style?: string;
  glyphs?: TestGlyph[];
}

const UNITS_PER_EM = 1000;
const ADVANCE_WIDTH = 600;
const ASCENDER = 800;
const DESCENDER = -200;
const HEAD_MAGIC = 0x5f0f3cf5;
const SFNT_TRUETYPE = 0x00010000;
const NAME_PLATFORM_WINDOWS = 3;
const NAME_ENCODING_UNICODE_BMP = 1;
const NAME_LANGUAGE_US_ENGLISH = 0x0409;
const NAME_ID_FAMILY = 1;
const NAME_ID_SUBFAMILY = 2;
const NAME_ID_FULL = 4;
const NAME_ID_POSTSCRIPT = 6;

const DEFAULT_GLYPHS: readonly TestGlyph[] = [
  {
    codePoint: 0x41,
    contours: [
      [
        [50, 0],
        [50, 700],
        [550, 700],
        [550, 0],
      ],
    ],
  },
  {
    codePoint: 0x42,
    contours: [
      [
        [50, 0],
        [300, 700],
        [550, 0],
      ],
    ],
  },
  {
    codePoint: 0x43,
    contours: [
      [
        [50, 0],
        [50, 300],
        [250, 300],
        [250, 0],
      ],
      [
        [300, 400],
        [300, 700],
        [550, 700],
        [550, 400],
      ],
    ],
  },
];

function pad4(data: Buffer): Buffer {
  const remainder = data.length % 4;
  return remainder === 0 ? data : Buffer.concat([data, Buffer.alloc(4 - remainder)]);
}

function sfntChecksum(data: Buffer): number {
  const padded = pad4(data);
  let sum = 0;
  for (let i = 0; i < padded.length; i += 4) {
    sum = (sum + padded.readUInt32BE(i)) >>> 0;
  }
  return sum;
}

function simpleGlyphRecord(contours: Array<Array<[number, number]>>): Buffer {
  const points = contours.flat();
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  const endPoints: number[] = [];
  let running = -1;
  for (const contour of contours) {
    running += contour.length;
    endPoints.push(running);
  }
  const header = Buffer.alloc(10 + endPoints.length * 2 + 2);
  header.writeInt16BE(contours.length, 0);
  header.writeInt16BE(Math.min(...xs), 2);
  header.writeInt16BE(Math.min(...ys), 4);
  header.writeInt16BE(Math.max(...xs), 6);
  header.writeInt16BE(Math.max(...ys), 8);
  endPoints.forEach((end, i) => header.writeUInt16BE(end, 10 + i * 2));
  header.writeUInt16BE(0, 10 + endPoints.length * 2); // instructionLength
  const flags = Buffer.alloc(points.length, 0x01); // on-curve, 16-bit x and y deltas
  const xDeltas = Buffer.alloc(points.length * 2);
  const yDeltas = Buffer.alloc(points.length * 2);
  let prevX = 0;
  let prevY = 0;
  points.forEach(([x, y], i) => {
    xDeltas.writeInt16BE(x - prevX, i * 2);
    yDeltas.writeInt16BE(y - prevY, i * 2);
    prevX = x;
    prevY = y;
  });
  return pad4(Buffer.concat([header, flags, xDeltas, yDeltas]));
}

function utf16be(text: string): Buffer {
  const out = Buffer.alloc(text.length * 2);
  for (let i = 0; i < text.length; i++) out.writeUInt16BE(text.charCodeAt(i), i * 2);
  return out;
}

function buildNameTable(family: string, style: string): Buffer {
  const records: Array<[number, string]> = [
    [NAME_ID_FAMILY, family],
    [NAME_ID_SUBFAMILY, style],
    [NAME_ID_FULL, `${family} ${style}`],
    [NAME_ID_POSTSCRIPT, `${family.replace(/\s+/g, '')}-${style.replace(/\s+/g, '')}`],
  ];
  const stringStart = 6 + records.length * 12;
  const header = Buffer.alloc(stringStart);
  header.writeUInt16BE(0, 0);
  header.writeUInt16BE(records.length, 2);
  header.writeUInt16BE(stringStart, 4);
  const strings: Buffer[] = [];
  let offset = 0;
  records.forEach(([nameId, text], i) => {
    const encoded = utf16be(text);
    const base = 6 + i * 12;
    header.writeUInt16BE(NAME_PLATFORM_WINDOWS, base);
    header.writeUInt16BE(NAME_ENCODING_UNICODE_BMP, base + 2);
    header.writeUInt16BE(NAME_LANGUAGE_US_ENGLISH, base + 4);
    header.writeUInt16BE(nameId, base + 6);
    header.writeUInt16BE(encoded.length, base + 8);
    header.writeUInt16BE(offset, base + 10);
    strings.push(encoded);
    offset += encoded.length;
  });
  return Buffer.concat([header, ...strings]);
}

function buildCmapTable(codePoints: number[]): Buffer {
  // One format 4 segment per code point plus the 0xFFFF terminator.
  const segCount = codePoints.length + 1;
  const subtable = Buffer.alloc(16 + segCount * 8);
  subtable.writeUInt16BE(4, 0);
  subtable.writeUInt16BE(subtable.length, 2);
  subtable.writeUInt16BE(0, 4);
  subtable.writeUInt16BE(segCount * 2, 6);
  const entrySelector = Math.floor(Math.log2(segCount));
  const searchRange = 2 * 2 ** entrySelector;
  subtable.writeUInt16BE(searchRange, 8);
  subtable.writeUInt16BE(entrySelector, 10);
  subtable.writeUInt16BE(segCount * 2 - searchRange, 12);
  const endBase = 14;
  const startBase = endBase + segCount * 2 + 2;
  const deltaBase = startBase + segCount * 2;
  const rangeBase = deltaBase + segCount * 2;
  codePoints.forEach((cp, i) => {
    const glyphId = i + 1;
    subtable.writeUInt16BE(cp, endBase + i * 2);
    subtable.writeUInt16BE(cp, startBase + i * 2);
    subtable.writeUInt16BE((glyphId - cp) & 0xffff, deltaBase + i * 2);
    subtable.writeUInt16BE(0, rangeBase + i * 2);
  });
  const last = codePoints.length;
  subtable.writeUInt16BE(0xffff, endBase + last * 2);
  subtable.writeUInt16BE(0xffff, startBase + last * 2);
  subtable.writeUInt16BE(1, deltaBase + last * 2);
  subtable.writeUInt16BE(0, rangeBase + last * 2);

  const header = Buffer.alloc(12);
  header.writeUInt16BE(0, 0);
  header.writeUInt16BE(1, 2);
  header.writeUInt16BE(NAME_PLATFORM_WINDOWS, 4);
  header.writeUInt16BE(NAME_ENCODING_UNICODE_BMP, 6);
  header.writeUInt32BE(12, 8);
  return Buffer.concat([header, subtable]);
}

/** The OpenType table directory is sorted by the tag bytes, not by locale collation. */
function compareTagBytes(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'latin1'), Buffer.from(b, 'latin1'));
}

function assembleSfnt(version: number, tables: Record<string, Buffer>): Buffer {
  const tags = Object.keys(tables).sort(compareTagBytes);
  const numTables = tags.length;
  const entrySelector = Math.floor(Math.log2(numTables));
  const searchRange = 16 * 2 ** entrySelector;
  const directory = Buffer.alloc(12 + numTables * 16);
  directory.writeUInt32BE(version, 0);
  directory.writeUInt16BE(numTables, 4);
  directory.writeUInt16BE(searchRange, 6);
  directory.writeUInt16BE(entrySelector, 8);
  directory.writeUInt16BE(numTables * 16 - searchRange, 10);
  const bodies: Buffer[] = [];
  let offset = directory.length;
  tags.forEach((tag, i) => {
    const body = tables[tag];
    const base = 12 + i * 16;
    directory.write(tag, base, 4, 'latin1');
    directory.writeUInt32BE(sfntChecksum(body), base + 4);
    directory.writeUInt32BE(offset, base + 8);
    directory.writeUInt32BE(body.length, base + 12);
    bodies.push(pad4(body));
    offset += pad4(body).length;
  });
  const font = Buffer.concat([directory, ...bodies]);
  // checkSumAdjustment: 0xB1B0AFBA minus the checksum of the whole font (head field zeroed).
  const headIndex = tags.indexOf('head');
  const headOffset = directory.readUInt32BE(12 + headIndex * 16 + 8);
  font.writeUInt32BE((0xb1b0afba - sfntChecksum(font)) >>> 0, headOffset + 8);
  return font;
}

/** Builds a small but fully valid TrueType font (glyf outlines, BMP cmap, name, OS/2, post). */
export function buildTrueTypeFont(spec: TestFontSpec): Buffer {
  const style = spec.style ?? 'Regular';
  const glyphSpecs = spec.glyphs ?? [...DEFAULT_GLYPHS];
  const notdef: Array<Array<[number, number]>> = [
    [
      [50, 0],
      [50, 700],
      [550, 700],
      [550, 0],
    ],
  ];
  const records = [notdef, ...glyphSpecs.map((g) => g.contours)].map((contours) => simpleGlyphRecord(contours));
  const numGlyphs = records.length;

  const loca = Buffer.alloc((numGlyphs + 1) * 4);
  let glyfOffset = 0;
  records.forEach((record, i) => {
    loca.writeUInt32BE(glyfOffset, i * 4);
    glyfOffset += record.length;
  });
  loca.writeUInt32BE(glyfOffset, numGlyphs * 4);
  const glyf = Buffer.concat(records);

  const allPoints = [notdef, ...glyphSpecs.map((g) => g.contours)].flatMap((c) => c.flat());
  const maxPoints = Math.max(...[notdef, ...glyphSpecs.map((g) => g.contours)].map((c) => c.flat().length));
  const maxContours = Math.max(...[notdef, ...glyphSpecs.map((g) => g.contours)].map((c) => c.length));
  const xMin = Math.min(...allPoints.map((p) => p[0]));
  const yMin = Math.min(...allPoints.map((p) => p[1]));
  const xMax = Math.max(...allPoints.map((p) => p[0]));
  const yMax = Math.max(...allPoints.map((p) => p[1]));

  const head = Buffer.alloc(54);
  head.writeUInt32BE(SFNT_TRUETYPE, 0);
  head.writeUInt32BE(0x00010000, 4);
  head.writeUInt32BE(HEAD_MAGIC, 12);
  head.writeUInt16BE(0x000b, 16);
  head.writeUInt16BE(UNITS_PER_EM, 18);
  head.writeInt16BE(xMin, 36);
  head.writeInt16BE(yMin, 38);
  head.writeInt16BE(xMax, 40);
  head.writeInt16BE(yMax, 42);
  head.writeInt16BE(7, 46); // lowestRecPPEM
  head.writeInt16BE(2, 48); // fontDirectionHint
  head.writeInt16BE(1, 50); // indexToLocFormat: 32-bit offsets

  const hhea = Buffer.alloc(36);
  hhea.writeUInt32BE(0x00010000, 0);
  hhea.writeInt16BE(ASCENDER, 4);
  hhea.writeInt16BE(DESCENDER, 6);
  hhea.writeUInt16BE(ADVANCE_WIDTH, 10);
  hhea.writeInt16BE(xMin, 12);
  hhea.writeInt16BE(UNITS_PER_EM - xMax, 14);
  hhea.writeInt16BE(xMax, 16);
  hhea.writeInt16BE(1, 18); // caretSlopeRise
  hhea.writeUInt16BE(numGlyphs, 34);

  const maxp = Buffer.alloc(32);
  maxp.writeUInt32BE(0x00010000, 0);
  maxp.writeUInt16BE(numGlyphs, 4);
  maxp.writeUInt16BE(maxPoints, 6);
  maxp.writeUInt16BE(maxContours, 8);
  maxp.writeUInt16BE(2, 14); // maxZones
  maxp.writeUInt16BE(1, 24); // maxComponentElements

  const hmtx = Buffer.alloc(numGlyphs * 4);
  for (let i = 0; i < numGlyphs; i++) {
    hmtx.writeUInt16BE(ADVANCE_WIDTH, i * 4);
    hmtx.writeInt16BE(xMin, i * 4 + 2);
  }

  const codePoints = glyphSpecs.map((g) => g.codePoint);
  const os2 = Buffer.alloc(78);
  os2.writeUInt16BE(0, 0);
  os2.writeInt16BE(ADVANCE_WIDTH, 2);
  os2.writeUInt16BE(400, 4);
  os2.writeUInt16BE(5, 6);
  os2.writeUInt32BE(1, 42); // ulUnicodeRange1: Basic Latin
  os2.write('TEST', 58, 4, 'latin1');
  os2.writeUInt16BE(0x40, 62); // fsSelection: REGULAR
  os2.writeUInt16BE(Math.min(...codePoints), 64);
  os2.writeUInt16BE(Math.max(...codePoints), 66);
  os2.writeInt16BE(ASCENDER, 68);
  os2.writeInt16BE(DESCENDER, 70);
  os2.writeUInt16BE(ASCENDER, 74);
  os2.writeUInt16BE(-DESCENDER, 76);

  const post = Buffer.alloc(32);
  post.writeUInt32BE(0x00030000, 0);
  post.writeInt16BE(-100, 8);
  post.writeInt16BE(50, 10);

  return assembleSfnt(SFNT_TRUETYPE, {
    cmap: buildCmapTable(codePoints),
    glyf,
    head,
    hhea,
    hmtx,
    loca,
    maxp,
    name: buildNameTable(spec.family, style),
    'OS/2': os2,
    post,
  });
}

// ---------------------------------------------------------------------------
// Resource fork writer
// ---------------------------------------------------------------------------

export interface TestResource {
  type: string;
  id: number;
  name?: string;
  data: Buffer;
}

const FORK_DATA_OFFSET = 256; // 16-byte header + 112 system + 128 application reserved bytes
const MAP_HEADER_BYTES = 28;
const TYPE_ENTRY_BYTES = 8;
const REF_ENTRY_BYTES = 12;

/** Parsed pieces of a resource fork that hostile tests patch after the fact. */
export interface ForkLayout {
  fork: Buffer;
  mapOffset: number;
  typeListOffset: number;
  /** Absolute file offset of each type entry, in map order. */
  typeEntryOffsets: number[];
  /** Absolute file offset of each reference entry, in map order. */
  refEntryOffsets: number[];
}

export function buildResourceForkWithLayout(resources: TestResource[]): ForkLayout {
  const types: string[] = [];
  for (const r of resources) if (!types.includes(r.type)) types.push(r.type);

  const dataChunks: Buffer[] = [];
  const dataOffsets = new Map<TestResource, number>();
  let dataLength = 0;
  for (const r of resources) {
    const chunk = Buffer.alloc(4 + r.data.length);
    chunk.writeUInt32BE(r.data.length, 0);
    r.data.copy(chunk, 4);
    dataOffsets.set(r, dataLength);
    dataChunks.push(chunk);
    dataLength += chunk.length;
  }

  const typeListSize = 2 + types.length * TYPE_ENTRY_BYTES;
  const refListsStart = MAP_HEADER_BYTES + typeListSize;
  const nameChunks: Buffer[] = [];
  const nameOffsets = new Map<TestResource, number>();
  let nameLength = 0;
  for (const r of resources) {
    if (r.name === undefined) continue;
    const bytes = Buffer.from(r.name, 'latin1');
    nameOffsets.set(r, nameLength);
    nameChunks.push(Buffer.from([bytes.length]), bytes);
    nameLength += 1 + bytes.length;
  }
  const refListsSize = resources.length * REF_ENTRY_BYTES;
  const nameListOffset = refListsStart + refListsSize;
  const mapLength = nameListOffset + nameLength;

  const map = Buffer.alloc(mapLength);
  map.writeUInt16BE(MAP_HEADER_BYTES, 24); // type list offset
  map.writeUInt16BE(nameListOffset, 26);
  map.writeUInt16BE(types.length - 1, MAP_HEADER_BYTES);
  const typeEntryOffsets: number[] = [];
  const refEntryOffsets: number[] = [];
  let refCursor = refListsStart;
  types.forEach((type, t) => {
    const group = resources.filter((r) => r.type === type);
    const entry = MAP_HEADER_BYTES + 2 + t * TYPE_ENTRY_BYTES;
    typeEntryOffsets.push(entry);
    map.write(type, entry, 4, 'latin1');
    map.writeUInt16BE(group.length - 1, entry + 4);
    map.writeUInt16BE(refCursor - MAP_HEADER_BYTES, entry + 6);
    for (const r of group) {
      refEntryOffsets.push(refCursor);
      map.writeInt16BE(r.id, refCursor);
      map.writeUInt16BE(nameOffsets.get(r) ?? 0xffff, refCursor + 2);
      map.writeUInt32BE(dataOffsets.get(r)!, refCursor + 4); // attribute byte 0 + 24-bit offset
      refCursor += REF_ENTRY_BYTES;
    }
  });
  Buffer.concat(nameChunks).copy(map, nameListOffset);

  const mapOffset = FORK_DATA_OFFSET + dataLength;
  const header = Buffer.alloc(FORK_DATA_OFFSET);
  header.writeUInt32BE(FORK_DATA_OFFSET, 0);
  header.writeUInt32BE(mapOffset, 4);
  header.writeUInt32BE(dataLength, 8);
  header.writeUInt32BE(mapLength, 12);
  header.copy(map, 0, 0, 16); // the map begins with a copy of the fork header
  const fork = Buffer.concat([header, ...dataChunks, map]);
  return {
    fork,
    mapOffset,
    typeListOffset: mapOffset + MAP_HEADER_BYTES,
    typeEntryOffsets: typeEntryOffsets.map((o) => mapOffset + o),
    refEntryOffsets: refEntryOffsets.map((o) => mapOffset + o),
  };
}

export function buildResourceFork(resources: TestResource[]): Buffer {
  return buildResourceForkWithLayout(resources).fork;
}

/** A .dfont: a resource fork whose 'sfnt' resources each hold one complete SFNT font. */
export function buildDfont(fonts: Buffer[], firstId = 128): Buffer {
  return buildResourceFork(
    fonts.map((data, i) => ({ type: 'sfnt', id: firstId + i, data }))
  );
}

/** Resource fork holding only bitmap (NFNT) and FOND resources, as a pre-TrueType suitcase would. */
export function buildBitmapOnlyFork(): Buffer {
  return buildResourceFork([
    { type: 'FOND', id: 128, name: 'Chicago', data: Buffer.alloc(52, 0x11) },
    { type: 'NFNT', id: 128, data: Buffer.alloc(26, 0x22) },
  ]);
}

// ---------------------------------------------------------------------------
// MacBinary II / III writer
// ---------------------------------------------------------------------------

const MACBINARY_BLOCK = 128;

/** CRC-16/XMODEM, table-driven (distinct implementation from the bitwise one in src). */
const CRC_TABLE: number[] = Array.from({ length: 256 }, (_, n) => {
  let value = n << 8;
  for (let k = 0; k < 8; k++) value = value & 0x8000 ? (value << 1) ^ 0x1021 : value << 1;
  return value & 0xffff;
});

export function crc16Table(data: Buffer): number {
  let crc = 0;
  for (const byte of data) crc = ((crc << 8) ^ CRC_TABLE[((crc >> 8) ^ byte) & 0xff]) & 0xffff;
  return crc;
}

export interface MacBinarySpec {
  name?: string;
  dataFork?: Buffer;
  resourceFork?: Buffer;
  fileType?: string;
  creator?: string;
  /** 'II' writes version bytes 129/129 and a CRC; 'III' adds the 'mBIN' signature (version 130). */
  version?: 'II' | 'III';
}

function padBlock(data: Buffer): Buffer {
  const remainder = data.length % MACBINARY_BLOCK;
  return remainder === 0 ? data : Buffer.concat([data, Buffer.alloc(MACBINARY_BLOCK - remainder)]);
}

export function buildMacBinary(spec: MacBinarySpec = {}): Buffer {
  const name = Buffer.from(spec.name ?? 'Test Font', 'latin1');
  const dataFork = spec.dataFork ?? Buffer.alloc(0);
  const resourceFork = spec.resourceFork ?? Buffer.alloc(0);
  const header = Buffer.alloc(MACBINARY_BLOCK);
  header[1] = name.length;
  name.copy(header, 2);
  header.write(spec.fileType ?? 'FFIL', 65, 4, 'latin1');
  header.write(spec.creator ?? 'DMOV', 69, 4, 'latin1');
  header.writeUInt32BE(dataFork.length, 83);
  header.writeUInt32BE(resourceFork.length, 87);
  header.writeUInt32BE(0xb0000000, 91); // creation date (seconds since 1904)
  header.writeUInt32BE(0xb0000000, 95);
  if (spec.version === 'III') header.write('mBIN', 102, 4, 'latin1');
  header[122] = spec.version === 'III' ? 130 : 129;
  header[123] = 129;
  header.writeUInt16BE(crc16Table(header.subarray(0, 124)), 124);
  return Buffer.concat([header, padBlock(dataFork), padBlock(resourceFork)]);
}

/** Recomputes the MacBinary II/III header CRC after a test patched header bytes. */
export function refreshMacBinaryCrc(file: Buffer): void {
  file.writeUInt16BE(crc16Table(file.subarray(0, 124)), 124);
}
