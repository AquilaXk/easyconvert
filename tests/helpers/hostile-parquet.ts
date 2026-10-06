/**
 * Hand-assembles Parquet files (footer, page headers) byte by byte so tests can describe layouts no
 * well-behaved writer produces: overlapping chunks, lying page sizes, dictionary bombs. This builder
 * has its own minimal Thrift compact-protocol writer and shares no code with the module under test.
 */

const TYPE_I32 = 5;
const TYPE_I64 = 6;
const TYPE_BINARY = 8;
const TYPE_LIST = 9;
const TYPE_STRUCT = 12;

class Thrift {
  private out: number[] = [];
  private last: number[] = [0];

  varint(value: bigint): void {
    let v = value;
    while (v >= 0x80n) {
      this.out.push(Number(v & 0x7fn) | 0x80);
      v >>= 7n;
    }
    this.out.push(Number(v));
  }

  raw(data: Uint8Array): void {
    for (const b of data) this.out.push(b);
  }

  zigzag(n: bigint): void {
    this.varint(n >= 0n ? n << 1n : ((-n) << 1n) - 1n);
  }

  field(id: number, type: number): void {
    const delta = id - this.last[this.last.length - 1];
    if (delta > 0 && delta <= 15) {
      this.out.push((delta << 4) | type);
    } else {
      this.out.push(type);
      this.zigzag(BigInt(id));
    }
    this.last[this.last.length - 1] = id;
  }

  i32(id: number, value: number): void {
    this.field(id, TYPE_I32);
    this.zigzag(BigInt(value));
  }

  i64(id: number, value: number): void {
    this.field(id, TYPE_I64);
    this.zigzag(BigInt(value));
  }

  text(id: number, value: string): void {
    this.field(id, TYPE_BINARY);
    const bytes = Buffer.from(value, 'utf8');
    this.varint(BigInt(bytes.length));
    this.raw(bytes);
  }

  list(id: number, elementType: number, size: number): void {
    this.field(id, TYPE_LIST);
    if (size < 15) {
      this.out.push((size << 4) | elementType);
    } else {
      this.out.push(0xf0 | elementType);
      this.varint(BigInt(size));
    }
  }

  begin(): void {
    this.last.push(0);
  }

  structField(id: number): void {
    this.field(id, TYPE_STRUCT);
    this.begin();
  }

  end(): void {
    this.out.push(0);
    this.last.pop();
  }

  bytes(): Buffer {
    return Buffer.from(this.out);
  }
}

export const PAGE_DATA = 0;
export const PAGE_DICTIONARY = 2;
export const ENC_PLAIN = 0;
export const ENC_RLE = 3;
export const ENC_RLE_DICTIONARY = 8;
export const CODEC_UNCOMPRESSED = 0;
export const CODEC_SNAPPY = 1;
export const CODEC_ZSTD = 6;
export const PHYSICAL_INT32 = 1;
export const PHYSICAL_INT64 = 2;
export const PHYSICAL_BYTE_ARRAY = 6;
export const REPETITION_REQUIRED = 0;
export const REPETITION_OPTIONAL = 1;

export interface PageHeaderSpec {
  type: number;
  uncompressed?: number;
  compressed?: number;
  numValues?: number;
  encoding?: number;
  definitionLevelEncoding?: number;
}

/** Serializes a PageHeader; any size left undefined is omitted from the wire (a malformed header). */
export function pageHeader(spec: PageHeaderSpec): Buffer {
  const t = new Thrift();
  t.begin();
  t.i32(1, spec.type);
  if (spec.uncompressed !== undefined) t.i32(2, spec.uncompressed);
  if (spec.compressed !== undefined) t.i32(3, spec.compressed);
  const sub = spec.type === PAGE_DICTIONARY ? 7 : 5;
  t.structField(sub);
  t.i32(1, spec.numValues ?? 0);
  t.i32(2, spec.encoding ?? ENC_PLAIN);
  if (spec.type === PAGE_DATA) {
    t.i32(3, spec.definitionLevelEncoding ?? ENC_RLE);
    t.i32(4, ENC_RLE);
  }
  t.end();
  t.end();
  return t.bytes();
}

export interface ChunkSpec {
  name: string;
  physicalType: number;
  codec: number;
  numValues: number;
  dataPageOffset: number;
  dictionaryPageOffset?: number;
  totalCompressedSize?: number;
}

export interface LeafSpec {
  name: string;
  physicalType: number;
  repetition: number;
  convertedType?: number;
  scale?: number;
  precision?: number;
  typeLength?: number;
}

export interface HostileFileSpec {
  /** Bytes placed between the leading and trailing magic, before the footer. File offsets start at 4. */
  body: Buffer;
  leaves: LeafSpec[];
  rowGroups: { numRows: number; chunks: ChunkSpec[] }[];
  /** Overrides the file-level num_rows (defaults to the sum of the row groups). */
  numRows?: number;
}

export function buildHostileParquet(spec: HostileFileSpec): Buffer {
  const t = new Thrift();
  t.begin();
  t.i32(1, 1);
  t.list(2, TYPE_STRUCT, spec.leaves.length + 1);
  t.begin();
  t.text(4, 'root');
  t.i32(5, spec.leaves.length);
  t.end();
  for (const leaf of spec.leaves) {
    t.begin();
    t.i32(1, leaf.physicalType);
    if (leaf.typeLength !== undefined) t.i32(2, leaf.typeLength);
    t.i32(3, leaf.repetition);
    t.text(4, leaf.name);
    if (leaf.convertedType !== undefined) t.i32(6, leaf.convertedType);
    if (leaf.scale !== undefined) t.i32(7, leaf.scale);
    if (leaf.precision !== undefined) t.i32(8, leaf.precision);
    t.end();
  }
  const total = spec.numRows ?? spec.rowGroups.reduce((sum, g) => sum + g.numRows, 0);
  t.i64(3, total);
  t.list(4, TYPE_STRUCT, spec.rowGroups.length);
  for (const group of spec.rowGroups) {
    t.begin();
    t.list(1, TYPE_STRUCT, group.chunks.length);
    for (const chunk of group.chunks) {
      t.begin();
      t.i64(2, chunk.dictionaryPageOffset ?? chunk.dataPageOffset);
      t.structField(3);
      t.i32(1, chunk.physicalType);
      t.list(2, TYPE_I32, 1);
      t.zigzag(0n);
      t.list(3, TYPE_BINARY, 1);
      const nameBytes = Buffer.from(chunk.name, 'utf8');
      t.varint(BigInt(nameBytes.length));
      t.raw(nameBytes);
      t.i32(4, chunk.codec);
      t.i64(5, chunk.numValues);
      if (chunk.totalCompressedSize !== undefined) t.i64(7, chunk.totalCompressedSize);
      t.i64(9, chunk.dataPageOffset);
      if (chunk.dictionaryPageOffset !== undefined) t.i64(11, chunk.dictionaryPageOffset);
      t.end();
      t.end();
    }
    t.i64(2, 0);
    t.i64(3, group.numRows);
    t.end();
  }
  t.end();
  const footer = t.bytes();
  const length = Buffer.alloc(4);
  length.writeUInt32LE(footer.length, 0);
  return Buffer.concat([Buffer.from('PAR1'), spec.body, footer, length, Buffer.from('PAR1')]);
}
