import { setOwn } from './data-json';
import type { DataObject, DataValue } from './data-json';
import { PARQUET_MAX_DECODED_VALUE_BYTES, ParquetFormatError } from './parquet-format';
import type { ParquetValue } from './parquet-logical';
import { assembleRowGroup, decodeNestedChunk } from './parquet-nested';
import type { LeafStream } from './parquet-nested';
import { decodeChunk, prepareParquetPlans } from './parquet-reader';
import type { ChunkPlan, DecodeBudget, FileMeta } from './parquet-reader';
import { cellShapeOf } from './parquet-schema';
import type { CellShape, SchemaNode } from './parquet-schema';

/**
 * A Parquet file read into the columns of its table: the entry points of the reader. A flat table is decoded column by
 * column; a table with nested or repeated columns is decoded leaf by leaf and assembled into records (parquet-nested.ts).
 */

export interface DecodedParquetColumns {
  names: string[];
  columns: ParquetValue[][];
  numRows: number;
  /** Per column: how a table target cuts it into cells (see CellShape). */
  shapes: CellShape[];
}

/** The chunk plans of each row group, each group ordered by schema leaf. */
function groupByRowGroup(plans: ChunkPlan[], leafCount: number): ChunkPlan[][] {
  const groups: ChunkPlan[][] = [];
  for (let first = 0; first < plans.length; first += leafCount) {
    const group = plans.slice(first, first + leafCount);
    group.sort((a, b) => a.leaf.colIndex - b.leaf.colIndex);
    groups.push(group);
  }
  return groups;
}

function decodeNestedColumns(buffer: Buffer, meta: FileMeta, root: SchemaNode, plans: ChunkPlan[], budget: DecodeBudget): DecodedParquetColumns {
  const columns: ParquetValue[][] = root.children.map(() => []);
  for (const group of groupByRowGroup(plans, meta.leaves.length)) {
    const streams: LeafStream[] = group.map((plan) => decodeNestedChunk(buffer, plan, budget));
    assembleRowGroup(root, streams, group[0].rows, columns);
  }
  return {
    names: root.children.map((child) => child.name),
    columns,
    numRows: meta.numRows,
    shapes: root.children.map(cellShapeOf),
  };
}

function decodeFlatColumns(buffer: Buffer, meta: FileMeta, plans: ChunkPlan[], budget: DecodeBudget): DecodedParquetColumns {
  const columns = new Map<string, ParquetValue[]>();
  const writeOffsets = new Map<string, number>();
  const singleRowGroup = plans.length === meta.leaves.length;
  for (const plan of plans) {
    const values = decodeChunk(buffer, plan, budget);
    if (singleRowGroup) {
      columns.set(plan.leaf.name, values);
      continue;
    }
    const existing = columns.get(plan.leaf.name);
    if (existing) {
      const base = writeOffsets.get(plan.leaf.name) ?? 0;
      for (let i = 0; i < values.length; i++) existing[base + i] = values[i];
      writeOffsets.set(plan.leaf.name, base + values.length);
    } else {
      const col = new Array<ParquetValue>(meta.numRows);
      for (let i = 0; i < values.length; i++) col[i] = values[i];
      columns.set(plan.leaf.name, col);
      writeOffsets.set(plan.leaf.name, values.length);
    }
  }

  const names = meta.leaves.map((leaf) => leaf.name).filter((name) => columns.has(name));
  const columnValues = names.map((name) => columns.get(name) as ParquetValue[]);
  return { names, columns: columnValues, numRows: meta.numRows, shapes: names.map(() => 'plain') };
}

function decodeParquetColumnsUnguarded(buffer: Buffer): DecodedParquetColumns {
  const { meta, plans } = prepareParquetPlans(buffer);
  const { root } = meta;
  if (meta.numRows === 0) {
    const fields: { name: string }[] = root === null ? meta.leaves : root.children;
    return {
      names: fields.map((field) => field.name),
      columns: fields.map(() => []),
      numRows: 0,
      shapes: root === null ? fields.map(() => 'plain') : root.children.map(cellShapeOf),
    };
  }
  const budget: DecodeBudget = { valueBytes: PARQUET_MAX_DECODED_VALUE_BYTES };
  return root === null ? decodeFlatColumns(buffer, meta, plans, budget) : decodeNestedColumns(buffer, meta, root, plans, budget);
}

function mapRangeError(error: unknown): unknown {
  // Allocation limits of the JS engine (array or string length) mean the table is too large to hold.
  if (error instanceof RangeError) {
    return new ParquetFormatError(`Unsupported Parquet file: the decoded table exceeds engine limits (${error.message})`);
  }
  return error;
}

/**
 * Deserializes a Parquet file into column vectors in schema order: the leaves of a flat table, the top-level fields
 * (lists, structs and maps assembled) of a table with nested columns.
 */
export function decodeParquetColumns(buffer: Buffer): DecodedParquetColumns {
  try {
    return decodeParquetColumnsUnguarded(buffer);
  } catch (error) {
    throw mapRangeError(error);
  }
}

const CHAR_ZERO = 0x30;
const CHAR_NINE = 0x39;

/** A column name that a plain record assignment would mangle: `__proto__`, or an array index, which reorders keys. */
function isUnsafeRecordKey(name: string): boolean {
  const first = name.codePointAt(0) ?? 0;
  return name === '__proto__' || (first >= CHAR_ZERO && first <= CHAR_NINE);
}

export interface ParquetRecords {
  records: Record<string, unknown>[];
  /** The columns a table target cuts into more or other than one cell each (structs and maps), by name. */
  shapes: ReadonlyMap<string, CellShape>;
}

/**
 * Deserializes a Parquet file into row records. Integers beyond 2^53, decimals, dates, times and
 * timestamps are returned as exact strings; binary that is not UTF-8 text is returned as base64.
 * A list is an array, a struct an object, and a map an object when its keys are strings, otherwise an
 * array of {key, value}.
 */
export function decodeParquetTable(buffer: Buffer): ParquetRecords {
  try {
    const { names, columns: columnValues, numRows, shapes: columnShapes } = decodeParquetColumnsUnguarded(buffer);
    const shapes = new Map<string, CellShape>();
    names.forEach((name, c) => {
      if (columnShapes[c] !== 'plain') shapes.set(name, columnShapes[c]);
    });
    if (numRows === 0) return { records: [], shapes };
    const needsSetOwn = names.some(isUnsafeRecordKey);
    const records: Record<string, unknown>[] = new Array<Record<string, unknown>>(numRows);
    for (let r = 0; r < numRows; r++) {
      const row: Record<string, ParquetValue> = {};
      if (needsSetOwn) {
        for (let c = 0; c < names.length; c++) {
          setOwn(row as DataObject, names[c], (columnValues[c][r] ?? null) as DataValue);
        }
      } else {
        for (let c = 0; c < names.length; c++) {
          row[names[c]] = columnValues[c][r] ?? null;
        }
      }
      records[r] = row;
    }
    return { records, shapes };
  } catch (error) {
    throw mapRangeError(error);
  }
}

export function decodeParquet(buffer: Buffer): Record<string, unknown>[] {
  return decodeParquetTable(buffer).records;
}
