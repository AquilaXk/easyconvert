import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getOracleToolPath, OracleToolMissingError } from './differential-oracle';

/**
 * Wrapper around tests/helpers/parquet_oracle.py: pyarrow (and DuckDB) read and write the bytes,
 * so no expected value ever comes from the module under test.
 */

const ORACLE_SCRIPT = path.join(__dirname, 'parquet_oracle.py');
const EXIT_MODULE_MISSING = 3;
const ORACLE_TIMEOUT_MS = 120_000;
const ORACLE_MAX_BUFFER_BYTES = 512 * 1024 * 1024;

export type OracleValue = string | number | boolean | bigint | null;

export interface OracleColumnChunk {
  path: string;
  physicalType: string;
  codec: string;
  encodings: string[];
  numValues: number;
  hasDictionaryPage: boolean;
  totalCompressedSize: number;
  totalUncompressedSize: number;
  hasStatistics: boolean;
  nullCount?: number;
  hasMinMax?: boolean;
  min?: OracleValue;
  max?: OracleValue;
}

export interface PyArrowReadResult {
  numRows: number;
  numRowGroups: number;
  schema: { name: string; type: string; nullable: boolean }[];
  rowGroups: { numRows: number; columns: OracleColumnChunk[] }[];
  columns: Record<string, OracleValue[]>;
}

export interface DuckDbReadResult {
  names: string[];
  types: string[];
  numRows: number;
  columns: Record<string, OracleValue[]>;
}

function untag(value: unknown): OracleValue {
  if (value !== null && typeof value === 'object') {
    const tagged = value as { $f?: string; $i?: string };
    if (typeof tagged.$f === 'string') return Buffer.from(tagged.$f, 'hex').readDoubleBE(0);
    if (typeof tagged.$i === 'string') return BigInt(tagged.$i);
  }
  return value as OracleValue;
}

function runOracle(args: string[]): unknown {
  const python = getOracleToolPath('python3');
  if (!python) throw new OracleToolMissingError('python3', 'python3 is required for the Parquet oracle');
  try {
    const stdout = execFileSync(python, ['-I', ORACLE_SCRIPT, ...args], {
      encoding: 'utf-8',
      timeout: ORACLE_TIMEOUT_MS,
      maxBuffer: ORACLE_MAX_BUFFER_BYTES,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return JSON.parse(stdout);
  } catch (error) {
    const failure = error as { status?: number; stderr?: string };
    if (failure.status === EXIT_MODULE_MISSING) {
      const moduleName = /MODULE_MISSING (\S+)/.exec(failure.stderr ?? '')?.[1] ?? 'python module';
      throw new OracleToolMissingError(moduleName, `Parquet oracle module "${moduleName}" is not installed`);
    }
    throw new Error(`Parquet oracle "${args[0]}" failed: ${failure.stderr ?? String(error)}`);
  }
}

function untagColumns(columns: Record<string, unknown[]>): Record<string, OracleValue[]> {
  const out: Record<string, OracleValue[]> = {};
  for (const [name, values] of Object.entries(columns)) {
    out[name] = values.map(untag);
  }
  return out;
}

export function withOracleTempDir<T>(fn: (dir: string) => T): T {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'parquet-oracle-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Reads `bytes` with pyarrow; throws when pyarrow rejects the file. */
export function pyarrowRead(bytes: Buffer): PyArrowReadResult {
  return withOracleTempDir((dir) => {
    const file = path.join(dir, 'in.parquet');
    fs.writeFileSync(file, bytes);
    const raw = runOracle(['read', file]) as PyArrowReadResult;
    const rowGroups = raw.rowGroups.map((rg) => ({
      ...rg,
      columns: rg.columns.map((c) => ({ ...c, min: untag(c.min), max: untag(c.max) })),
    }));
    return { ...raw, rowGroups, columns: untagColumns(raw.columns) };
  });
}

/** Reads `bytes` with DuckDB; throws OracleToolMissingError when duckdb is not installed. */
export function duckdbRead(bytes: Buffer): DuckDbReadResult {
  return withOracleTempDir((dir) => {
    const file = path.join(dir, 'in.parquet');
    fs.writeFileSync(file, bytes);
    const raw = runOracle(['duckdb', file]) as DuckDbReadResult;
    return { ...raw, columns: untagColumns(raw.columns) };
  });
}

export type ReferenceColumnKind = 'int64' | 'double' | 'string' | 'bool';

/** Writes the columns with the reference writer and returns the file bytes. */
export function pyarrowWrite(
  columns: Record<string, (string | number | boolean | null)[]>,
  schema: [string, ReferenceColumnKind][],
  codec: 'snappy' | 'zstd' | 'none'
): Buffer {
  return withOracleTempDir((dir) => {
    const rowsFile = path.join(dir, 'rows.json');
    const schemaFile = path.join(dir, 'schema.json');
    const outFile = path.join(dir, 'out.parquet');
    fs.writeFileSync(rowsFile, JSON.stringify(columns));
    fs.writeFileSync(schemaFile, JSON.stringify(schema));
    runOracle(['write', rowsFile, schemaFile, outFile, codec]);
    return fs.readFileSync(outFile);
  });
}

export function pyarrowSnappyCompress(raw: Buffer): Buffer {
  return pyarrowCompress('snappy', raw);
}

export function pyarrowCompress(codec: 'snappy' | 'zstd', raw: Buffer): Buffer {
  return withOracleTempDir((dir) => {
    const inFile = path.join(dir, 'raw.bin');
    const outFile = path.join(dir, 'packed.bin');
    fs.writeFileSync(inFile, raw);
    runOracle(['codec-compress', codec, inFile, outFile]);
    return fs.readFileSync(outFile);
  });
}

export function pyarrowSnappyDecompress(packed: Buffer, rawSize: number): Buffer {
  return withOracleTempDir((dir) => {
    const inFile = path.join(dir, 'packed.bin');
    const outFile = path.join(dir, 'raw.bin');
    fs.writeFileSync(inFile, packed);
    runOracle(['snappy-decompress', inFile, outFile, String(rawSize)]);
    return fs.readFileSync(outFile);
  });
}
