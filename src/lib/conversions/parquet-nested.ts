import { setOwn } from './data-json';
import type { DataObject, DataValue } from './data-json';
import { decompressPageSlice } from './parquet-codec';
import { decodeBitPackedLevels } from './parquet-encodings';
import { Encoding, FieldRepetitionType, PageType, PARQUET_CELL_BYTES, ParquetFormatError, ParquetUnsupportedError } from './parquet-format';
import type { ColumnValue, ParquetValue } from './parquet-logical';
import { chargeValueBytes, decodeEncodedValues, readDictionaryPage, readV2ValuesPage } from './parquet-reader';
import type { ChunkPlan, DecodeBudget, Dictionary, LeafColumn, ScannedPage } from './parquet-reader';
import { decodeRleHybrid } from './parquet-rle';
import type { SchemaNode } from './parquet-schema';

/**
 * Nested columns: the pages of every leaf are decoded to their repetition levels, definition levels and present values
 * (the same page decoding as a flat column), and the leaves are put back together into records by the walk Dremel
 * describes (Melnik et al., "Dremel: Interactive Analysis of Web-Scale Datasets", section 4), as parquet-mr and Arrow read them.
 *
 * Untrusted-input bounds: the entries of every repeated column together are bounded by the cell limit before any page is
 * read (planChunks), each page's levels are charged to the decoded-value budget, a level above its maximum, a record
 * count that differs from the row group's, and a column that ends early or holds entries nobody read are typed errors, and
 * the walk recurses at most as deep as the schema, which is bounded by PARQUET_MAX_NESTING_DEPTH.
 */

const LENGTH_PREFIX_BYTES = 4;

/** What one leaf column of a row group holds: a level per entry, and the values of the entries that are present. */
export interface LeafStream {
  leaf: LeafColumn;
  /** Null when the column has no such levels (its maximum is 0). */
  definitions: Uint8Array | null;
  repetitions: Uint8Array | null;
  values: ColumnValue[];
  entries: number;
}

function bitWidthOf(maxLevel: number): number {
  return 32 - Math.clz32(maxLevel);
}

/** Counts the levels equal to `target` and fails on one above `maxLevel`, which the encoding allows but the column cannot hold. */
function countLevels(levels: Uint8Array, maxLevel: number, target: number, kind: string, leaf: LeafColumn): number {
  let counted = 0;
  for (let i = 0; i < levels.length; i++) {
    const level = levels[i];
    if (level > maxLevel) {
      throw new ParquetFormatError(`Corrupted Parquet file: ${kind} level ${level} out of range in column '${leaf.name}'`);
    }
    if (level === target) counted++;
  }
  return counted;
}

/** The levels of a v1 page: RLE behind a 4-byte length, or the deprecated bit-packed layout. Returns where they end. */
function readLevelsV1(body: Buffer, start: number, encoding: number, maxLevel: number, out: Uint8Array, leaf: LeafColumn): number {
  const bitWidth = bitWidthOf(maxLevel);
  if (encoding === Encoding.BIT_PACKED) return decodeBitPackedLevels(body, start, bitWidth, out.length, out, leaf.name);
  if (encoding !== Encoding.RLE) {
    throw new ParquetUnsupportedError(`Unsupported Parquet level encoding ${encoding} in column '${leaf.name}'`);
  }
  if (start + LENGTH_PREFIX_BYTES > body.length) {
    throw new ParquetFormatError(`Corrupted Parquet file: truncated levels in column '${leaf.name}'`);
  }
  const end = start + LENGTH_PREFIX_BYTES + body.readUInt32LE(start);
  if (end > body.length) {
    throw new ParquetFormatError(`Corrupted Parquet file: levels exceed page bounds in column '${leaf.name}'`);
  }
  decodeRleHybrid(body, start + LENGTH_PREFIX_BYTES, end, bitWidth, out.length, out);
  return end;
}

interface PageSlices {
  repetitions: Uint8Array | null;
  definitions: Uint8Array | null;
}

class ChunkReader {
  private offset = 0;
  private records = 0;
  private dictionary: Dictionary | null = null;
  readonly stream: LeafStream;

  constructor(
    private readonly buffer: Buffer,
    private readonly plan: ChunkPlan,
    private readonly budget: DecodeBudget
  ) {
    const { leaf, values } = plan;
    this.stream = {
      leaf,
      definitions: leaf.maxDef > 0 ? new Uint8Array(values) : null,
      repetitions: leaf.maxRep > 0 ? new Uint8Array(values) : null,
      values: [],
      entries: values,
    };
  }

  read(): LeafStream {
    for (const page of this.plan.pages) this.readPage(page);
    this.checkRecords();
    return this.stream;
  }

  private readPage(page: ScannedPage): void {
    const { type } = page.header;
    if (type === PageType.INDEX_PAGE) return;
    if (type === PageType.DICTIONARY_PAGE) {
      this.dictionary = readDictionaryPage(this.buffer, this.plan, page);
      return;
    }
    if (type !== PageType.DATA_PAGE && type !== PageType.DATA_PAGE_V2) {
      throw new ParquetUnsupportedError(`Unsupported Parquet page type ${type} in column '${this.plan.leaf.name}'`);
    }
    const { header } = page;
    const { leaf } = this.plan;
    chargeValueBytes(this.budget, header.numValues * PARQUET_CELL_BYTES);
    const slices = this.slicesOf(header.numValues);
    const decoded = type === PageType.DATA_PAGE ? this.readV1(page, slices) : this.readV2(page, slices);
    const present = decodeEncodedValues(decoded.body, decoded.pos, decoded.present, header.encoding, leaf, this.dictionary, this.budget);
    if (present.length < decoded.present) {
      throw new ParquetFormatError(`Corrupted Parquet file: column '${leaf.name}' holds fewer values than its levels name`);
    }
    for (let i = 0; i < decoded.present; i++) this.stream.values.push(present[i]);
    this.offset += header.numValues;
  }

  private slicesOf(count: number): PageSlices {
    const { repetitions, definitions } = this.stream;
    return {
      repetitions: repetitions === null ? null : repetitions.subarray(this.offset, this.offset + count),
      definitions: definitions === null ? null : definitions.subarray(this.offset, this.offset + count),
    };
  }

  private readV1(page: ScannedPage, slices: PageSlices): { body: Buffer; pos: number; present: number } {
    const { header } = page;
    const { leaf, chunk } = this.plan;
    const body = decompressPageSlice(chunk.codec, this.buffer, page.bodyStart, page.bodyEnd, header.uncompressedSize);
    let pos = 0;
    if (slices.repetitions !== null) {
      pos = readLevelsV1(body, pos, header.repetitionLevelEncoding, leaf.maxRep, slices.repetitions, leaf);
      this.records += countLevels(slices.repetitions, leaf.maxRep, 0, 'repetition', leaf);
    }
    let present = header.numValues;
    if (slices.definitions !== null) {
      pos = readLevelsV1(body, pos, header.definitionLevelEncoding, leaf.maxDef, slices.definitions, leaf);
      present = countLevels(slices.definitions, leaf.maxDef, leaf.maxDef, 'definition', leaf);
    }
    return { body, pos, present };
  }

  /** A v2 page keeps its levels outside the compressed section, RLE without a length prefix. */
  private readV2(page: ScannedPage, slices: PageSlices): { body: Buffer; pos: number; present: number } {
    const { header } = page;
    const { leaf, chunk } = this.plan;
    const raw = this.buffer.subarray(page.bodyStart, page.bodyEnd);
    const repBytes = header.repetitionLevelsByteLength;
    const levelBytes = repBytes + header.definitionLevelsByteLength;
    let records = header.numValues;
    if (slices.repetitions !== null) {
      decodeRleHybrid(raw, 0, repBytes, bitWidthOf(leaf.maxRep), header.numValues, slices.repetitions);
      records = countLevels(slices.repetitions, leaf.maxRep, 0, 'repetition', leaf);
      this.records += records;
    }
    let present = header.numValues;
    if (slices.definitions !== null) {
      decodeRleHybrid(raw, repBytes, levelBytes, bitWidthOf(leaf.maxDef), header.numValues, slices.definitions);
      present = countLevels(slices.definitions, leaf.maxDef, leaf.maxDef, 'definition', leaf);
    }
    if (header.numNulls !== header.numValues - present || header.numRows !== records) {
      throw new ParquetFormatError(`Corrupted Parquet file: v2 page header disagrees with its levels in column '${leaf.name}'`);
    }
    return { body: readV2ValuesPage(raw, chunk.codec, header, leaf), pos: 0, present };
  }

  /** The chunk's records must start where the row group's rows do: one repetition level 0 per row. */
  private checkRecords(): void {
    const { leaf, rows } = this.plan;
    const { repetitions } = this.stream;
    if (repetitions === null) return;
    if (this.records !== rows || repetitions[0] !== 0) {
      throw new ParquetFormatError(
        `Corrupted Parquet file: column '${leaf.name}' holds ${this.records} records for a row group of ${rows} rows`
      );
    }
  }
}

/** Decodes every page of one leaf's column chunk to its levels and present values. */
export function decodeNestedChunk(buffer: Buffer, plan: ChunkPlan, budget: DecodeBudget): LeafStream {
  return new ChunkReader(buffer, plan, budget).read();
}

interface Cursor {
  stream: LeafStream;
  entry: number;
  valueIndex: number;
}

function columnEnded(leaf: LeafColumn): ParquetFormatError {
  return new ParquetFormatError(`Corrupted Parquet file: column '${leaf.name}' ends before all rows are present`);
}

/**
 * Reads one row group's records out of the leaf streams. Every leaf under a node carries one entry per instance of the
 * node (a present value, or the level at which it is absent), so a node is read from the first leaf under it and the
 * others are advanced in step.
 *
 * Each entry is also checked against where the walk is. The walk decides where an instance of a repeated node ends from the
 * first leaf under it alone, so a sibling leaf whose levels split the entries differently would be read at the wrong
 * places with no sign of it in the values. The repetition level an entry must carry is the `boundary` the walk hands down:
 * 0 for the first entry of a record, the level of the repeated node for the second and later instances of it, and for the
 * first instance whatever its parent was entered with.
 */
class RecordAssembler {
  private readonly cursors: Cursor[];

  constructor(streams: LeafStream[]) {
    this.cursors = streams.map((stream) => ({ stream, entry: 0, valueIndex: 0 }));
  }

  /** Every entry and every value of every leaf must have been read once the row group's rows are. */
  finish(): void {
    for (const { entry, valueIndex, stream } of this.cursors) {
      if (entry !== stream.entries || valueIndex !== stream.values.length) {
        throw new ParquetFormatError(`Corrupted Parquet file: column '${stream.leaf.name}' holds entries beyond the rows of its row group`);
      }
    }
  }

  readField(node: SchemaNode, boundary: number): ParquetValue {
    if (node.repetition === FieldRepetitionType.REPEATED) {
      const items: ParquetValue[] = [];
      if (this.repeatedStart(node, boundary)) {
        let level = boundary;
        do {
          items.push(this.readBody(node, level));
          level = node.repLevel;
        } while (this.repeatedContinues(node));
      }
      return items;
    }
    if (node.repetition === FieldRepetitionType.OPTIONAL && this.definitionAt(node) < node.defLevel) {
      this.skip(node, boundary);
      return null;
    }
    return this.readBody(node, boundary);
  }

  private definitionAt(node: SchemaNode): number {
    const cursor = this.cursors[node.firstLeaf];
    if (cursor.entry >= cursor.stream.entries) throw columnEnded(cursor.stream.leaf);
    const levels = cursor.stream.definitions;
    return levels === null ? 0 : levels[cursor.entry];
  }

  /** The entry at the cursor must start an instance at the level the walk expects. */
  private checkBoundary(cursor: Cursor, boundary: number): void {
    const { repetitions, leaf } = cursor.stream;
    const level = repetitions === null ? 0 : repetitions[cursor.entry];
    if (level !== boundary) {
      throw new ParquetFormatError(
        `Corrupted Parquet file: repetition level ${level} where column '${leaf.name}' must have ${boundary}; its levels disagree with its siblings`
      );
    }
  }

  /** Moves past the entries of a node that is null or empty: each of its leaves holds exactly one. */
  private skip(node: SchemaNode, boundary: number): void {
    for (let i = node.firstLeaf; i < node.endLeaf; i++) {
      const cursor = this.cursors[i];
      if (cursor.entry >= cursor.stream.entries) throw columnEnded(cursor.stream.leaf);
      this.checkBoundary(cursor, boundary);
      cursor.entry++;
    }
  }

  /** True when a repeated node has an instance here; an empty list is passed over. */
  private repeatedStart(repeated: SchemaNode, boundary: number): boolean {
    if (this.definitionAt(repeated) >= repeated.defLevel) return true;
    this.skip(repeated, boundary);
    return false;
  }

  /** True when the next entry repeats the node at its own level, which is how the next instance of a list begins. */
  private repeatedContinues(repeated: SchemaNode): boolean {
    const cursor = this.cursors[repeated.firstLeaf];
    const { stream } = cursor;
    if (cursor.entry >= stream.entries || stream.repetitions === null) return false;
    const level = stream.repetitions[cursor.entry];
    if (level > repeated.repLevel) {
      throw new ParquetFormatError(`Corrupted Parquet file: repetition level ${level} is deeper than column '${stream.leaf.name}' allows here`);
    }
    return level === repeated.repLevel;
  }

  private readBody(node: SchemaNode, boundary: number): ParquetValue {
    switch (node.kind) {
      case 'leaf':
        return this.readLeaf(node, boundary);
      case 'list':
        return this.readList(node, boundary);
      case 'map':
        return this.readMap(node, boundary);
      default:
        return this.readStruct(node, boundary);
    }
  }

  private readLeaf(node: SchemaNode, boundary: number): ParquetValue {
    const cursor = this.cursors[node.firstLeaf];
    const { stream } = cursor;
    if (cursor.entry >= stream.entries) throw columnEnded(stream.leaf);
    const level = stream.definitions === null ? 0 : stream.definitions[cursor.entry];
    if (level !== stream.leaf.maxDef) {
      throw new ParquetFormatError(`Corrupted Parquet file: the levels of column '${stream.leaf.name}' disagree with its siblings`);
    }
    this.checkBoundary(cursor, boundary);
    cursor.entry++;
    return stream.values[cursor.valueIndex++];
  }

  private readStruct(node: SchemaNode, boundary: number): ParquetValue {
    const record: { [key: string]: ParquetValue } = {};
    for (const child of node.children) setOwn(record as DataObject, child.name, this.readField(child, boundary) as DataValue);
    return record;
  }

  private readList(node: SchemaNode, boundary: number): ParquetValue {
    const [repeated] = node.children;
    const element = node.element as SchemaNode;
    const items: ParquetValue[] = [];
    if (this.repeatedStart(repeated, boundary)) {
      let level = boundary;
      do {
        items.push(element === repeated ? this.readBody(repeated, level) : this.readField(element, level));
        level = repeated.repLevel;
      } while (this.repeatedContinues(repeated));
    }
    return items;
  }

  private readMap(node: SchemaNode, boundary: number): ParquetValue {
    const [repeated] = node.children;
    const [keyNode, valueNode] = repeated.children;
    const keys: ParquetValue[] = [];
    const values: ParquetValue[] = [];
    if (this.repeatedStart(repeated, boundary)) {
      let level = boundary;
      do {
        keys.push(this.readField(keyNode, level));
        values.push(this.readField(valueNode, level));
        level = repeated.repLevel;
      } while (this.repeatedContinues(repeated));
    }
    return node.textKeys && keysAreDistinctText(keys) ? objectOf(keys as string[], values) : pairsOf(keys, values);
  }
}

function keysAreDistinctText(keys: ParquetValue[]): boolean {
  const seen = new Set<ParquetValue>();
  for (const key of keys) {
    if (typeof key !== 'string' || seen.has(key)) return false;
    seen.add(key);
  }
  return true;
}

function objectOf(keys: string[], values: ParquetValue[]): ParquetValue {
  const record: { [key: string]: ParquetValue } = {};
  for (let i = 0; i < keys.length; i++) setOwn(record as DataObject, keys[i], values[i] as DataValue);
  return record;
}

function pairsOf(keys: ParquetValue[], values: ParquetValue[]): ParquetValue {
  return keys.map((key, i) => ({ key, value: values[i] }));
}

/** Appends the rows of one row group to the table's top-level columns. */
export function assembleRowGroup(root: SchemaNode, streams: LeafStream[], rows: number, columns: ParquetValue[][]): void {
  const assembler = new RecordAssembler(streams);
  for (let row = 0; row < rows; row++) {
    for (let c = 0; c < root.children.length; c++) columns[c].push(assembler.readField(root.children[c], 0));
  }
  assembler.finish();
}
