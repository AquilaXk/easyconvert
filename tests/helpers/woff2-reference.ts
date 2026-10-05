/**
 * An unoptimised, spec-literal WOFF2 reader for tests, written from the W3C WOFF2 Recommendation
 * (table directory, transformed glyf, loca and hmtx tables). It shares no code with src/ and models
 * glyphs as plain objects, so a table it rebuilds from the output of the encoder under test is an
 * independent check. Its own correctness is pinned against the Google reference decoder in
 * font-woff2-reference.test.ts.
 */
import { brotliDecompressSync } from 'node:zlib';

export const KNOWN_TAGS = [
  'cmap', 'head', 'hhea', 'hmtx', 'maxp', 'name', 'OS/2', 'post', 'cvt ', 'fpgm', 'glyf', 'loca', 'prep',
  'CFF ', 'VORG', 'EBDT', 'EBLC', 'gasp', 'hdmx', 'kern', 'LTSH', 'PCLT', 'VDMX', 'vhea', 'vmtx', 'BASE',
  'GDEF', 'GPOS', 'GSUB', 'EBSC', 'JSTF', 'MATH', 'CBDT', 'CBLC', 'COLR', 'CPAL', 'SVG ', 'sbix', 'acnt',
  'avar', 'bdat', 'bloc', 'bsln', 'cvar', 'fdsc', 'feat', 'fmtx', 'fvar', 'gvar', 'hsty', 'just', 'lcar',
  'mort', 'morx', 'opbd', 'prop', 'trak', 'Zapf', 'Silf', 'Glat', 'Gloc', 'Feat', 'Sill',
];

export interface DirectoryRow {
  tag: string;
  flags: number;
  /** bits 6 and 7 of the flags byte */
  version: number;
  origLength: number;
  /** present for transformed tables only */
  transformLength?: number;
  /** length of the bytes stored in the Brotli stream */
  storedLength: number;
}

export interface Woff2Header {
  flavor: number;
  length: number;
  numTables: number;
  reserved: number;
  totalSfntSize: number;
  totalCompressedSize: number;
  majorVersion: number;
  minorVersion: number;
  metaOffset: number;
  metaLength: number;
  metaOrigLength: number;
  privOffset: number;
  privLength: number;
}

export interface Woff2Reading {
  header: Woff2Header;
  directory: DirectoryRow[];
  /** The Brotli stream after decompression: the stored bytes of all tables, in directory order. */
  stream: Buffer;
  /** Stored bytes per table (transformed bytes for transformed tables). */
  stored: Map<string, Buffer>;
  /** The sfnt tables after reversing the transforms; head's indexToLocFormat is set from the glyf transform. */
  tables: Map<string, Buffer>;
  /** Byte offset where the compressed stream ends. */
  compressedEnd: number;
}

function base128(data: Buffer, at: number): { value: number; next: number } {
  let value = 0;
  for (let i = 0; i < 5; i++) {
    const byte = data[at + i];
    if (i === 0 && byte === 0x80) throw new Error('UIntBase128 starts with a zero group');
    value = value * 128 + (byte & 0x7f);
    if ((byte & 0x80) === 0) return { value, next: at + i + 1 };
  }
  throw new Error('UIntBase128 is longer than five bytes');
}

class Reader {
  at: number;
  constructor(readonly data: Buffer, start: number, readonly end: number) {
    this.at = start;
  }
  u8(): number {
    if (this.at >= this.end) throw new Error('stream ended early');
    return this.data[this.at++];
  }
  u16(): number {
    const v = (this.u8() << 8) | this.u8();
    return v;
  }
  i16(): number {
    const v = this.u16();
    return v >= 0x8000 ? v - 0x10000 : v;
  }
  u255(): number {
    const code = this.u8();
    if (code === 253) return this.u16();
    if (code === 255) return this.u8() + 253;
    if (code === 254) return this.u8() + 506;
    return code;
  }
  bytes(n: number): Buffer {
    if (this.at + n > this.end) throw new Error('stream ended early');
    const out = this.data.subarray(this.at, this.at + n);
    this.at += n;
    return out;
  }
}

interface Point {
  x: number;
  y: number;
  on: boolean;
}

interface Glyph {
  contours: number;
  bbox: [number, number, number, number];
  endPoints: number[];
  points: Point[];
  overlap: boolean;
  instructions: Buffer;
  /** composite glyphs: the component records, verbatim, and whether instructions follow them */
  components?: Buffer;
  hasInstructions?: boolean;
}

/** Decodes the coordinate triplet of one point (Recommendation, Triplet Encoding table). */
function readTriplet(flag: number, glyphs: Reader): { dx: number; dy: number; on: boolean } {
  const on = (flag & 0x80) === 0;
  const index = flag & 0x7f;
  const sign = (bit: number, magnitude: number): number => ((index >> bit) & 1 ? magnitude : -magnitude);
  if (index < 10) {
    const y = Math.floor(index / 2) * 256 + glyphs.u8();
    return { dx: 0, dy: sign(0, y), on };
  }
  if (index < 20) {
    const x = Math.floor((index - 10) / 2) * 256 + glyphs.u8();
    return { dx: sign(0, x), dy: 0, on };
  }
  if (index < 84) {
    const j = index - 20;
    const b = glyphs.u8();
    const x = 1 + (j & 0x30) + (b >> 4);
    const y = 1 + ((j & 0x0c) << 2) + (b & 0x0f);
    return { dx: sign(0, x), dy: sign(1, y), on };
  }
  if (index < 120) {
    const j = index - 84;
    const x = 1 + Math.floor(j / 12) * 256 + glyphs.u8();
    const y = 1 + Math.floor((j % 12) / 4) * 256 + glyphs.u8();
    return { dx: sign(0, x), dy: sign(1, y), on };
  }
  if (index < 124) {
    const b0 = glyphs.u8();
    const b1 = glyphs.u8();
    const b2 = glyphs.u8();
    return { dx: sign(0, (b0 << 4) | (b1 >> 4)), dy: sign(1, ((b1 & 0x0f) << 8) | b2), on };
  }
  const x = glyphs.u16();
  const y = glyphs.u16();
  return { dx: sign(0, x), dy: sign(1, y), on };
}

function componentLength(flags: number): number {
  let length = 4 + (flags & 0x0001 ? 4 : 2);
  if (flags & 0x0008) length += 2;
  else if (flags & 0x0040) length += 4;
  else if (flags & 0x0080) length += 8;
  return length;
}

/** Reads the glyphs of a transformed glyf table. */
function readTransformedGlyphs(data: Buffer): { glyphs: Glyph[]; indexFormat: number } {
  const version = data.readUInt16BE(0);
  const optionFlags = data.readUInt16BE(2);
  const numGlyphs = data.readUInt16BE(4);
  const indexFormat = data.readUInt16BE(6);
  if (version !== 0) throw new Error(`glyf transform version ${version}`);
  const sizes = [0, 1, 2, 3, 4, 5, 6].map((i) => data.readUInt32BE(8 + i * 4));
  const starts: number[] = [];
  let at = 36;
  for (const size of sizes) {
    starts.push(at);
    at += size;
  }
  const overlapAt = at;
  if (at + (optionFlags & 1 ? (numGlyphs + 7) >> 3 : 0) !== data.length) throw new Error('glyf transform size mismatch');
  const nContour = new Reader(data, starts[0], starts[0] + sizes[0]);
  const nPoints = new Reader(data, starts[1], starts[1] + sizes[1]);
  const flagStream = new Reader(data, starts[2], starts[2] + sizes[2]);
  const glyphStream = new Reader(data, starts[3], starts[3] + sizes[3]);
  const composite = new Reader(data, starts[4], starts[4] + sizes[4]);
  const bboxBitmapBytes = Math.ceil(numGlyphs / 32) * 4;
  const bbox = new Reader(data, starts[5] + bboxBitmapBytes, starts[5] + sizes[5]);
  const instructions = new Reader(data, starts[6], starts[6] + sizes[6]);
  const bit = (offset: number, id: number): boolean => (data[offset + (id >> 3)] & (0x80 >> (id & 7))) !== 0;

  const glyphs: Glyph[] = [];
  for (let id = 0; id < numGlyphs; id++) {
    const contours = nContour.i16();
    const hasBox = bit(starts[5], id);
    const glyph: Glyph = { contours, bbox: [0, 0, 0, 0], endPoints: [], points: [], overlap: false, instructions: Buffer.alloc(0) };
    if (contours === 0) {
      glyphs.push(glyph);
      continue;
    }
    if (contours === -1) {
      const from = composite.at;
      let haveInstructions = false;
      for (let more = true; more; ) {
        const flags = composite.u16();
        composite.u16();
        composite.bytes(componentLength(flags) - 4);
        haveInstructions ||= (flags & 0x0100) !== 0;
        more = (flags & 0x0020) !== 0;
      }
      glyph.components = Buffer.from(composite.data.subarray(from, composite.at));
      glyph.hasInstructions = haveInstructions;
      if (haveInstructions) glyph.instructions = Buffer.from(instructions.bytes(glyphStream.u255()));
    } else {
      let total = 0;
      for (let c = 0; c < contours; c++) {
        total += nPoints.u255();
        glyph.endPoints.push(total - 1);
      }
      const flagBytes = [...flagStream.bytes(total)];
      let x = 0;
      let y = 0;
      for (const flag of flagBytes) {
        const t = readTriplet(flag, glyphStream);
        x += t.dx;
        y += t.dy;
        glyph.points.push({ x, y, on: t.on });
      }
      glyph.instructions = Buffer.from(instructions.bytes(glyphStream.u255()));
      glyph.overlap = optionFlags & 1 ? bit(overlapAt, id) : false;
    }
    if (hasBox) {
      glyph.bbox = [bbox.i16(), bbox.i16(), bbox.i16(), bbox.i16()];
    } else {
      const xs = glyph.points.map((p) => p.x);
      const ys = glyph.points.map((p) => p.y);
      glyph.bbox = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
    }
    glyphs.push(glyph);
  }
  return { glyphs, indexFormat };
}

/** Serialises one glyph the way the reference decoder does: packed flags, shortest coordinates, instructions inline. */
function writeGlyph(glyph: Glyph): Buffer {
  const head = Buffer.alloc(10);
  head.writeInt16BE(glyph.contours, 0);
  glyph.bbox.forEach((v, i) => head.writeInt16BE(v, 2 + i * 2));
  const parts: Buffer[] = [head];
  if (glyph.contours === -1) {
    parts.push(glyph.components!);
    if (glyph.hasInstructions) {
      const length = Buffer.alloc(2);
      length.writeUInt16BE(glyph.instructions.length);
      parts.push(length, glyph.instructions);
    }
  } else {
    const endPoints = Buffer.alloc(glyph.endPoints.length * 2);
    glyph.endPoints.forEach((v, i) => endPoints.writeUInt16BE(v, i * 2));
    const instructionLength = Buffer.alloc(2);
    instructionLength.writeUInt16BE(glyph.instructions.length);
    parts.push(endPoints, instructionLength, glyph.instructions);
    const flags: number[] = [];
    const xs: number[] = [];
    const ys: number[] = [];
    let px = 0;
    let py = 0;
    glyph.points.forEach((p, i) => {
      let flag = p.on ? 1 : 0;
      const dx = p.x - px;
      const dy = p.y - py;
      if (dx === 0) flag |= 0x10;
      else if (Math.abs(dx) < 256) {
        flag |= 0x02 | (dx > 0 ? 0x10 : 0);
        xs.push(Math.abs(dx));
      } else xs.push((dx >> 8) & 0xff, dx & 0xff);
      if (dy === 0) flag |= 0x20;
      else if (Math.abs(dy) < 256) {
        flag |= 0x04 | (dy > 0 ? 0x20 : 0);
        ys.push(Math.abs(dy));
      } else ys.push((dy >> 8) & 0xff, dy & 0xff);
      if (i === 0 && glyph.overlap) flag |= 0x40;
      flags.push(flag);
      px = p.x;
      py = p.y;
    });
    const packed: number[] = [];
    for (let i = 0; i < flags.length; ) {
      let run = 1;
      while (i + run < flags.length && flags[i + run] === flags[i] && run < 256) run++;
      if (run > 1) packed.push(flags[i] | 0x08, run - 1);
      else packed.push(flags[i]);
      i += run;
    }
    parts.push(Buffer.from(packed), Buffer.from(xs), Buffer.from(ys));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, Buffer.alloc((4 - (body.length % 4)) % 4)]);
}

function rebuildGlyf(data: Buffer): { glyf: Buffer; loca: Buffer; indexFormat: number; xMin: number[] } {
  const { glyphs, indexFormat } = readTransformedGlyphs(data);
  const chunks = glyphs.map((g) => (g.contours === 0 ? Buffer.alloc(0) : writeGlyph(g)));
  const offsets = [0];
  for (const chunk of chunks) offsets.push(offsets[offsets.length - 1] + chunk.length);
  const loca = Buffer.alloc(offsets.length * (indexFormat ? 4 : 2));
  offsets.forEach((offset, i) => (indexFormat ? loca.writeUInt32BE(offset, i * 4) : loca.writeUInt16BE(offset / 2, i * 2)));
  return {
    glyf: Buffer.concat(chunks),
    loca,
    indexFormat,
    xMin: glyphs.map((g) => (g.contours === 0 ? 0 : g.bbox[0])),
  };
}

function rebuildHmtx(data: Buffer, numGlyphs: number, numHMetrics: number, xMin: number[]): Buffer {
  const flags = data[0];
  const hasLsb = (flags & 1) === 0;
  const hasTail = (flags & 2) === 0;
  const advances: number[] = [];
  let at = 1;
  for (let i = 0; i < numHMetrics; i++, at += 2) advances.push(data.readUInt16BE(at));
  const lsb: number[] = [];
  for (let i = 0; i < numHMetrics; i++) {
    if (hasLsb) {
      lsb.push(data.readInt16BE(at));
      at += 2;
    } else lsb.push(xMin[i]);
  }
  const tail: number[] = [];
  for (let i = numHMetrics; i < numGlyphs; i++) {
    if (hasTail) {
      tail.push(data.readInt16BE(at));
      at += 2;
    } else tail.push(xMin[i]);
  }
  if (at !== data.length) throw new Error('hmtx transform size mismatch');
  const out = Buffer.alloc(numHMetrics * 4 + tail.length * 2);
  advances.forEach((a, i) => {
    out.writeUInt16BE(a, i * 4);
    out.writeInt16BE(lsb[i], i * 4 + 2);
  });
  tail.forEach((v, i) => out.writeInt16BE(v, numHMetrics * 4 + i * 2));
  return out;
}

export function readWoff2Reference(woff2: Buffer): Woff2Reading {
  if (woff2.toString('latin1', 0, 4) !== 'wOF2') throw new Error('not a WOFF2 file');
  const header: Woff2Header = {
    flavor: woff2.readUInt32BE(4),
    length: woff2.readUInt32BE(8),
    numTables: woff2.readUInt16BE(12),
    reserved: woff2.readUInt16BE(14),
    totalSfntSize: woff2.readUInt32BE(16),
    totalCompressedSize: woff2.readUInt32BE(20),
    majorVersion: woff2.readUInt16BE(24),
    minorVersion: woff2.readUInt16BE(26),
    metaOffset: woff2.readUInt32BE(28),
    metaLength: woff2.readUInt32BE(32),
    metaOrigLength: woff2.readUInt32BE(36),
    privOffset: woff2.readUInt32BE(40),
    privLength: woff2.readUInt32BE(44),
  };
  let at = 48;
  const directory: DirectoryRow[] = [];
  for (let i = 0; i < header.numTables; i++) {
    const flags = woff2[at++];
    let tag: string;
    if ((flags & 0x3f) === 63) {
      tag = woff2.toString('latin1', at, at + 4);
      at += 4;
    } else tag = KNOWN_TAGS[flags & 0x3f];
    const version = flags >> 6;
    const orig = base128(woff2, at);
    at = orig.next;
    const transformed = tag === 'glyf' || tag === 'loca' ? version === 0 : version !== 0;
    const row: DirectoryRow = { tag, flags, version, origLength: orig.value, storedLength: orig.value };
    if (transformed) {
      const t = base128(woff2, at);
      at = t.next;
      row.transformLength = t.value;
      row.storedLength = t.value;
    }
    directory.push(row);
  }
  const compressedEnd = at + header.totalCompressedSize;
  const stream = brotliDecompressSync(woff2.subarray(at, compressedEnd));
  const stored = new Map<string, Buffer>();
  let offset = 0;
  for (const row of directory) {
    stored.set(row.tag, stream.subarray(offset, offset + row.storedLength));
    offset += row.storedLength;
  }
  if (offset !== stream.length) throw new Error('directory lengths do not add up to the Brotli stream');

  const tables = new Map<string, Buffer>();
  let glyf: ReturnType<typeof rebuildGlyf> | undefined;
  const glyfRow = directory.find((r) => r.tag === 'glyf');
  if (glyfRow !== undefined && glyfRow.transformLength !== undefined) glyf = rebuildGlyf(stored.get('glyf')!);
  for (const row of directory) {
    const data = stored.get(row.tag)!;
    if (row.tag === 'glyf' && glyf) tables.set('glyf', glyf.glyf);
    else if (row.tag === 'loca' && glyf) tables.set('loca', glyf.loca);
    else if (row.tag === 'hmtx' && row.transformLength !== undefined) {
      const numGlyphs = stored.get('maxp')!.readUInt16BE(4);
      tables.set('hmtx', rebuildHmtx(data, numGlyphs, stored.get('hhea')!.readUInt16BE(34), glyf!.xMin));
    } else if (row.tag === 'head' && glyf) {
      const head = Buffer.from(data);
      head.writeInt16BE(glyf.indexFormat, 50);
      tables.set('head', head);
    } else tables.set(row.tag, Buffer.from(data));
  }
  return { header, directory, stream, stored, tables, compressedEnd };
}

export const SFNT_FLAG_OVERLAP_SIMPLE = 0x40;

/** The offset in glyf of the first flag byte of a simple glyph, from the loca, glyf and head tables of an sfnt. */
export function firstFlagOffset(tables: Map<string, Buffer>, glyphId: number): number {
  const loca = tables.get('loca')!;
  const glyf = tables.get('glyf')!;
  const long = tables.get('head')!.readInt16BE(50) === 1;
  const start = long ? loca.readUInt32BE(glyphId * 4) : loca.readUInt16BE(glyphId * 2) * 2;
  const contours = glyf.readInt16BE(start);
  const instructionLength = glyf.readUInt16BE(start + 10 + 2 * contours);
  return start + 10 + 2 * contours + 2 + instructionLength;
}

/**
 * Reads a WOFF2 file with the spec-literal reader and throws when the file is not self-consistent:
 * header length and sfnt size, ascending tags, and the declared origLength of every table matching the
 * table the reader rebuilds from its stored bytes.
 */
export function assertWoff2Consistent(woff2: Buffer): Woff2Reading {
  const reading = readWoff2Reference(woff2);
  if (reading.header.length !== woff2.length) throw new Error('header length differs from the file size');
  let sfntSize = 12 + 16 * reading.directory.length;
  let previousTag = '';
  for (const row of reading.directory) {
    if (row.tag <= previousTag) throw new Error(`table ${row.tag} is out of order`);
    previousTag = row.tag;
    const rebuilt = reading.tables.get(row.tag)!;
    if (rebuilt.length !== row.origLength) throw new Error(`table ${row.tag} rebuilds to ${rebuilt.length} bytes, the directory declares ${row.origLength}`);
    sfntSize += Math.ceil(row.origLength / 4) * 4;
  }
  if (sfntSize !== reading.header.totalSfntSize) throw new Error(`totalSfntSize ${reading.header.totalSfntSize} should be ${sfntSize}`);
  return reading;
}
