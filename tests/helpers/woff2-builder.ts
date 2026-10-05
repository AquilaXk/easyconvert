/**
 * Hand-assembles WOFF2 containers (W3C WOFF2 Recommendation) so tests can feed the
 * decoder precisely malformed files. Nothing here imports from src/.
 */
import { brotliCompressSync, constants as zlibConstants } from 'node:zlib';

export const WOFF2_HEADER_BYTES = 48;
export const TRANSFORM_SHIFT = 6;
export const TAG_EXPLICIT = 63;

const KNOWN_TAG_INDEX: Record<string, number> = {
  cmap: 0, head: 1, hhea: 2, hmtx: 3, maxp: 4, name: 5, 'OS/2': 6, post: 7, 'cvt ': 8, fpgm: 9, glyf: 10,
  loca: 11, prep: 12, 'CFF ': 13,
};

export function base128(value: number): number[] {
  const groups = [value % 128];
  let rest = Math.floor(value / 128);
  while (rest > 0) {
    groups.unshift((rest % 128) | 0x80);
    rest = Math.floor(rest / 128);
  }
  return groups;
}

export function u255(value: number): number[] {
  if (value < 253) return [value];
  if (value < 506) return [255, value - 253];
  if (value < 762) return [254, value - 506];
  return [253, value >> 8, value & 0xff];
}

export interface Woff2TableSpec {
  tag: string;
  /** Bytes stored in the Brotli stream for this table (transformed bytes when a transform applies). */
  data: Buffer;
  /** Bits 6 and 7 of the flags byte. */
  version?: number;
  /** Defaults to data.length. */
  origLength?: number;
  /** Written only when given. */
  transformLength?: number;
  /** Replaces the whole directory entry (for example to inject a redundant 0x80 byte). */
  rawEntry?: number[];
}

export interface Woff2Spec {
  flavor?: number;
  tables: Woff2TableSpec[];
  /** Bytes of the compressed stream; defaults to the Brotli form of the concatenated table data. */
  compressed?: Buffer;
  numTables?: number;
  totalSfntSize?: number;
  totalCompressedSize?: number;
  lengthOverride?: number;
  /** Bytes inserted between the table directory and the compressed stream (collection header). */
  afterDirectory?: number[];
  meta?: { offset?: number; length: number; origLength: number; data?: Buffer };
  priv?: { offset?: number; data: Buffer };
}

export function brotliFont(data: Buffer): Buffer {
  return brotliCompressSync(data, {
    params: {
      [zlibConstants.BROTLI_PARAM_MODE]: zlibConstants.BROTLI_MODE_FONT,
      [zlibConstants.BROTLI_PARAM_QUALITY]: 5,
    },
  });
}

export function buildWoff2(spec: Woff2Spec): Buffer {
  const directory: number[] = [];
  for (const table of spec.tables) {
    if (table.rawEntry !== undefined) {
      directory.push(...table.rawEntry);
      continue;
    }
    const known = KNOWN_TAG_INDEX[table.tag];
    const index = known === undefined ? TAG_EXPLICIT : known;
    directory.push(index | ((table.version ?? 0) << TRANSFORM_SHIFT));
    if (index === TAG_EXPLICIT) directory.push(...Buffer.from(table.tag, 'latin1'));
    directory.push(...base128(table.origLength ?? table.data.length));
    if (table.transformLength !== undefined) directory.push(...base128(table.transformLength));
  }
  directory.push(...(spec.afterDirectory ?? []));
  const stream = spec.compressed ?? brotliFont(Buffer.concat(spec.tables.map((t) => t.data)));
  let length = WOFF2_HEADER_BYTES + directory.length + stream.length;
  const pad = (n: number): number => (4 - (n % 4)) % 4;
  const parts: Buffer[] = [Buffer.alloc(WOFF2_HEADER_BYTES), Buffer.from(directory), stream];
  let metaOffset = 0;
  let metaLength = 0;
  let metaOrigLength = 0;
  let privOffset = 0;
  let privLength = 0;
  if (spec.meta !== undefined || spec.priv !== undefined) {
    parts.push(Buffer.alloc(pad(length)));
    length += pad(length);
  }
  if (spec.meta !== undefined) {
    const block = spec.meta.data ?? brotliFont(Buffer.alloc(spec.meta.origLength));
    metaOffset = spec.meta.offset ?? length;
    metaLength = spec.meta.length;
    metaOrigLength = spec.meta.origLength;
    parts.push(block);
    length += block.length;
    if (spec.priv !== undefined) {
      parts.push(Buffer.alloc(pad(length)));
      length += pad(length);
    }
  }
  if (spec.priv !== undefined) {
    privOffset = spec.priv.offset ?? length;
    privLength = spec.priv.data.length;
    parts.push(spec.priv.data);
    length += spec.priv.data.length;
  }
  const tail = pad(length);
  parts.push(Buffer.alloc(tail));
  length += tail;

  const header = parts[0];
  header.write('wOF2', 0, 'latin1');
  header.writeUInt32BE(spec.flavor ?? 0x00010000, 4);
  header.writeUInt32BE(spec.lengthOverride ?? length, 8);
  header.writeUInt16BE(spec.numTables ?? spec.tables.length, 12);
  header.writeUInt32BE(spec.totalSfntSize ?? 0, 16);
  header.writeUInt32BE(spec.totalCompressedSize ?? stream.length, 20);
  header.writeUInt16BE(1, 24);
  header.writeUInt32BE(metaOffset, 28);
  header.writeUInt32BE(metaLength, 32);
  header.writeUInt32BE(metaOrigLength, 36);
  header.writeUInt32BE(privOffset, 40);
  header.writeUInt32BE(privLength, 44);
  return Buffer.concat(parts);
}

export interface TransformedGlyfSpec {
  numGlyphs: number;
  indexFormat?: number;
  version?: number;
  optionFlags?: number;
  nContour: number[];
  nPoints?: number[];
  flags?: number[];
  glyph?: number[];
  composite?: number[];
  /** bbox bitmap bytes followed by the explicit boxes */
  bbox?: number[];
  instruction?: number[];
  overlap?: number[];
  /** Overrides the size fields (in stream order) to build files whose sizes lie. */
  sizeOverrides?: Partial<Record<'nContour' | 'nPoints' | 'flags' | 'glyph' | 'composite' | 'bbox' | 'instruction', number>>;
}

export function bboxBitmapBytes(numGlyphs: number): number {
  return ((numGlyphs + 31) >> 5) << 2;
}

/** The glyf transform of the Recommendation: a header followed by seven sub-streams. */
export function transformedGlyf(spec: TransformedGlyfSpec): Buffer {
  const nContour = Buffer.alloc(spec.nContour.length * 2);
  spec.nContour.forEach((v, i) => nContour.writeInt16BE(v, i * 2));
  const streams = {
    nContour,
    nPoints: Buffer.from(spec.nPoints ?? []),
    flags: Buffer.from(spec.flags ?? []),
    glyph: Buffer.from(spec.glyph ?? []),
    composite: Buffer.from(spec.composite ?? []),
    bbox: Buffer.from(spec.bbox ?? new Array(bboxBitmapBytes(spec.numGlyphs)).fill(0)),
    instruction: Buffer.from(spec.instruction ?? []),
  };
  const header = Buffer.alloc(36);
  header.writeUInt16BE(spec.version ?? 0, 0);
  header.writeUInt16BE(spec.optionFlags ?? 0, 2);
  header.writeUInt16BE(spec.numGlyphs, 4);
  header.writeUInt16BE(spec.indexFormat ?? 0, 6);
  const order = ['nContour', 'nPoints', 'flags', 'glyph', 'composite', 'bbox', 'instruction'] as const;
  order.forEach((key, i) => {
    header.writeUInt32BE(spec.sizeOverrides?.[key] ?? streams[key].length, 8 + i * 4);
  });
  return Buffer.concat([header, ...order.map((key) => streams[key]), Buffer.from(spec.overlap ?? [])]);
}

export function sfntHead(indexToLocFormat: number): Buffer {
  const head = Buffer.alloc(54);
  head.writeUInt32BE(0x00010000, 0);
  head.writeUInt32BE(0x5f0f3cf5, 12);
  head.writeUInt16BE(1000, 18);
  head.writeInt16BE(indexToLocFormat, 50);
  return head;
}

export function sfntMaxp(numGlyphs: number): Buffer {
  const maxp = Buffer.alloc(32);
  maxp.writeUInt32BE(0x00010000, 0);
  maxp.writeUInt16BE(numGlyphs, 4);
  return maxp;
}

export function sfntHhea(numberOfHMetrics: number): Buffer {
  const hhea = Buffer.alloc(36);
  hhea.writeUInt32BE(0x00010000, 0);
  hhea.writeUInt16BE(numberOfHMetrics, 34);
  return hhea;
}

/** The padded loca of a font in which every glyph has the given length. */
export function glyfLoca(lengths: number[], long: boolean): Buffer {
  const loca = Buffer.alloc((lengths.length + 1) * (long ? 4 : 2));
  let offset = 0;
  for (let i = 0; i <= lengths.length; i++) {
    if (long) loca.writeUInt32BE(offset, i * 4);
    else loca.writeUInt16BE(offset / 2, i * 2);
    offset += lengths[i] ?? 0;
  }
  return loca;
}

export const TRIANGLE_GLYF_LENGTH = 24;

/**
 * Tables of a two glyph font (glyph 0 empty, glyph 1 a triangle with points (10,10), (20,0), (0,0))
 * whose glyf is already in the glyf transform. Reconstructed, glyph 1 takes 23 bytes padded to 24.
 */
export function minimalTransformedFont(overrides: Partial<TransformedGlyfSpec> = {}): Woff2TableSpec[] {
  const glyf = transformedGlyf({
    numGlyphs: 2,
    nContour: [0, 1],
    nPoints: u255(3),
    flags: [23, 21, 10],
    glyph: [0x99, 0x99, 20, 0],
    ...overrides,
  });
  const hmtx = Buffer.alloc(8);
  hmtx.writeUInt16BE(500, 0);
  hmtx.writeUInt16BE(600, 4);
  return [
    { tag: 'glyf', data: glyf, version: 0, origLength: TRIANGLE_GLYF_LENGTH, transformLength: glyf.length },
    { tag: 'head', data: sfntHead(0) },
    { tag: 'hhea', data: sfntHhea(2) },
    { tag: 'hmtx', data: hmtx },
    { tag: 'loca', data: Buffer.alloc(0), version: 0, origLength: 6, transformLength: 0 },
    { tag: 'maxp', data: sfntMaxp(2) },
  ];
}

/** A plain sfnt (tables in ascending tag order, four-byte aligned) around the given tables. */
export function sfntFromTables(version: number, tables: Map<string, Buffer>): Buffer {
  const tags = [...tables.keys()].sort();
  const directory = Buffer.alloc(12 + 16 * tags.length);
  directory.writeUInt32BE(version, 0);
  directory.writeUInt16BE(tags.length, 4);
  const parts: Buffer[] = [directory];
  let offset = directory.length;
  tags.forEach((tag, i) => {
    const data = tables.get(tag)!;
    const at = 12 + i * 16;
    directory.write(tag, at, 'latin1');
    directory.writeUInt32BE(offset, at + 8);
    directory.writeUInt32BE(data.length, at + 12);
    const padded = Buffer.concat([data, Buffer.alloc((4 - (data.length % 4)) % 4)]);
    parts.push(padded);
    offset += padded.length;
  });
  return Buffer.concat(parts);
}
