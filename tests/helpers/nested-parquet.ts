import { Thrift, TYPE_BINARY, TYPE_I32, TYPE_STRUCT, pageHeader, PAGE_DATA, ENC_PLAIN } from './hostile-parquet';

/**
 * Hand-assembles Parquet files with nested schemas: a schema tree, and for each column chunk its data pages with
 * repetition and definition levels written exactly as the test says. Like hostile-parquet.ts it has its own Thrift
 * writer and shares no code with the module under test.
 */

export const REQUIRED = 0;
export const OPTIONAL = 1;
export const REPEATED = 2;
export const INT32 = 1;

export interface SchemaField {
  name: string;
  repetition: number;
  /** The physical type of a leaf; a group has `children` instead. */
  physicalType?: number;
  children?: SchemaField[];
  /** ConvertedType of a group: 1 for MAP, 3 for LIST. */
  convertedType?: number;
}

export interface ChunkSpec {
  path: string[];
  physicalType: number;
  numValues: number;
  /** Header and body of every page of the chunk, in order. */
  pages: Buffer;
}

export interface NestedFileSpec {
  fields: SchemaField[];
  rowGroups: { numRows: number; chunks: ChunkSpec[] }[];
  /** The file-level row count; defaults to the sum of the row groups. */
  numRows?: number;
}

function varint(value: number): number[] {
  const out: number[] = [];
  let v = value;
  while (v >= 0x80) {
    out.push((v % 0x80) | 0x80);
    v = Math.floor(v / 0x80);
  }
  out.push(v);
  return out;
}

/** Run-length encodes levels as the RLE/bit-packed hybrid does, one run per stretch of equal values. */
export function rleLevels(levels: readonly number[], bitWidth: number): Buffer {
  const out: number[] = [];
  const valueBytes = Math.ceil(bitWidth / 8);
  for (let i = 0; i < levels.length; ) {
    let end = i;
    while (end < levels.length && levels[end] === levels[i]) end++;
    out.push(...varint((end - i) * 2));
    for (let b = 0; b < valueBytes; b++) out.push((levels[i] >> (8 * b)) & 0xff);
    i = end;
  }
  return Buffer.from(out);
}

/** The same run, stated by its length instead of by listing every level: for files that claim millions of entries. */
export function rleRun(length: number, value: number, bitWidth: number): Buffer {
  const valueBytes = Math.ceil(bitWidth / 8);
  const bytes = [...varint(length * 2)];
  for (let b = 0; b < valueBytes; b++) bytes.push((value >> (8 * b)) & 0xff);
  return Buffer.from(bytes);
}

function lengthPrefixed(body: Buffer): Buffer {
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32LE(body.length, 0);
  return Buffer.concat([prefix, body]);
}

export function int32Plain(values: readonly number[]): Buffer {
  const out = Buffer.alloc(values.length * 4);
  values.forEach((value, i) => out.writeInt32LE(value, i * 4));
  return out;
}

export function bitWidthOf(max: number): number {
  return 32 - Math.clz32(max);
}

export interface DataPageSpec {
  numValues: number;
  /** Already-encoded level sections (without the length prefix), or levels to run-length encode. */
  repetition?: Buffer | readonly number[];
  definition?: Buffer | readonly number[];
  maxRepetition: number;
  maxDefinition: number;
  values: Buffer;
}

function levelSection(levels: Buffer | readonly number[], max: number): Buffer {
  return lengthPrefixed(Buffer.isBuffer(levels) ? levels : rleLevels(levels, bitWidthOf(max)));
}

/** One uncompressed v1 data page with RLE levels. */
export function dataPage(spec: DataPageSpec): Buffer {
  const parts: Buffer[] = [];
  if (spec.maxRepetition > 0) parts.push(levelSection(spec.repetition ?? [], spec.maxRepetition));
  if (spec.maxDefinition > 0) parts.push(levelSection(spec.definition ?? [], spec.maxDefinition));
  parts.push(spec.values);
  const body = Buffer.concat(parts);
  const header = pageHeader({ type: PAGE_DATA, uncompressed: body.length, compressed: body.length, numValues: spec.numValues, encoding: ENC_PLAIN });
  return Buffer.concat([header, body]);
}

function writeSchemaField(t: Thrift, field: SchemaField): void {
  t.begin();
  if (field.physicalType !== undefined) t.i32(1, field.physicalType);
  t.i32(3, field.repetition);
  t.text(4, field.name);
  if (field.children !== undefined) t.i32(5, field.children.length);
  if (field.convertedType !== undefined) t.i32(6, field.convertedType);
  t.end();
  for (const child of field.children ?? []) writeSchemaField(t, child);
}

function countElements(fields: readonly SchemaField[]): number {
  return fields.reduce((sum, field) => sum + 1 + countElements(field.children ?? []), 0);
}

export function buildNestedParquet(spec: NestedFileSpec): Buffer {
  const body: Buffer[] = [];
  let offset = 4;
  const placed = spec.rowGroups.map((group) =>
    group.chunks.map((chunk) => {
      const at = offset;
      body.push(chunk.pages);
      offset += chunk.pages.length;
      return { chunk, at };
    })
  );
  const t = new Thrift();
  t.begin();
  t.i32(1, 1);
  t.list(2, TYPE_STRUCT, countElements(spec.fields) + 1);
  t.begin();
  t.text(4, 'schema');
  t.i32(5, spec.fields.length);
  t.end();
  for (const field of spec.fields) writeSchemaField(t, field);
  t.i64(3, spec.numRows ?? spec.rowGroups.reduce((sum, group) => sum + group.numRows, 0));
  t.list(4, TYPE_STRUCT, spec.rowGroups.length);
  spec.rowGroups.forEach((group, g) => {
    t.begin();
    t.list(1, TYPE_STRUCT, group.chunks.length);
    for (const { chunk, at } of placed[g]) {
      t.begin();
      t.i64(2, at);
      t.structField(3);
      t.i32(1, chunk.physicalType);
      t.list(2, TYPE_I32, 1);
      t.zigzag(0n);
      t.list(3, TYPE_BINARY, chunk.path.length);
      for (const name of chunk.path) {
        const bytes = Buffer.from(name, 'utf8');
        t.varint(BigInt(bytes.length));
        t.raw(bytes);
      }
      t.i32(4, 0);
      t.i64(5, chunk.numValues);
      t.i64(7, chunk.pages.length);
      t.i64(9, at);
      t.end();
      t.end();
    }
    t.i64(2, 0);
    t.i64(3, group.numRows);
    t.end();
  });
  t.end();
  const footer = t.bytes();
  const length = Buffer.alloc(4);
  length.writeUInt32LE(footer.length, 0);
  return Buffer.concat([Buffer.from('PAR1'), ...body, footer, length, Buffer.from('PAR1')]);
}
