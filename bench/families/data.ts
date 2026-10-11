import fs from 'node:fs';
import path from 'node:path';
import { CORPUS_DIR, IN_PROCESS_REPEATS } from '../config';
import type { FamilyContext, FamilyRunner, RowWeight } from '../context';
import { convertWithProject } from '../convert';
import { OutputIntegrityError } from '../errors';
import { ReferenceServer } from '../reference-server';
import type { BenchRow } from '../report';
import { measuredRow, type MetricSpec, skippedGroup, SPEC, speedRowId, throughputRow } from '../rows';
import { DUCKDB_PSEUDO_TOOL, OPENPYXL_PSEUDO_TOOL, PYARROW_PSEUDO_TOOL, runTool } from '../tools';

/**
 * Data family: the tabular conversions the product advertises between CSV, JSON lines and JSON, Parquet and XLSX, on one
 * table of 2,500 rows that carries the cells that break converters (commas, quotes and line breaks inside a cell, digit
 * strings with leading zeros, strings that read as exponents, empty cells, East Asian text and emoji).
 *
 * References: DuckDB for CSV and JSON, Apache Arrow (pyarrow) for Parquet, both in a Python process that stays up for the run
 * (bench/reference-server.ts), so that a timed call measures the conversion and not the interpreter start; LibreOffice
 * (`soffice --convert-to`) for XLSX, a cold process per document, as in the document family.
 *
 * Quality oracle: every cell of an output is read back by a parser that is not this project's code (the Python csv and json
 * modules; pyarrow and DuckDB, two independent Parquet readers, of which the worse counts; openpyxl), rendered to text and
 * compared with the text of the source cell. A converter that turns "007" into 7, "1e5" into 100000.0 or an ISO timestamp
 * into a database timestamp has changed the cell, and the count says by how many. The sizes of the Parquet and XLSX outputs
 * are measured against the reference's.
 */

type OutputKind = 'json' | 'csv' | 'parquet' | 'xlsx';
type Truth = { kind: 'csv' | 'jsonl'; file: string };
type Producer = 'duckdb' | 'pyarrow' | 'soffice';

interface DataCase {
  /** Corpus file, and the format of it. */
  source: string;
  target: OutputKind;
  truth: Truth;
  producer: Producer;
  /** The conversion the reference server runs; absent for LibreOffice. */
  conversion?: string;
  weight: RowWeight;
  /** Whether the size of the output is a row (formats with their own compression). */
  size: boolean;
}

const TABLE = 'data/table';
const CASES: readonly DataCase[] = [
  { source: `${TABLE}.csv`, target: 'json', truth: { kind: 'csv', file: `${TABLE}.csv` }, producer: 'duckdb', conversion: 'csv-json', weight: 'light', size: false },
  { source: `${TABLE}.jsonl`, target: 'csv', truth: { kind: 'jsonl', file: `${TABLE}.jsonl` }, producer: 'duckdb', conversion: 'jsonl-csv', weight: 'light', size: false },
  { source: `${TABLE}.csv`, target: 'parquet', truth: { kind: 'csv', file: `${TABLE}.csv` }, producer: 'pyarrow', conversion: 'csv-parquet', weight: 'light', size: true },
  { source: `${TABLE}.parquet`, target: 'csv', truth: { kind: 'csv', file: `${TABLE}.csv` }, producer: 'pyarrow', conversion: 'parquet-csv', weight: 'light', size: false },
  { source: `${TABLE}.parquet`, target: 'json', truth: { kind: 'csv', file: `${TABLE}.csv` }, producer: 'duckdb', conversion: 'parquet-json', weight: 'light', size: false },
  { source: `${TABLE}.csv`, target: 'xlsx', truth: { kind: 'csv', file: `${TABLE}.csv` }, producer: 'soffice', weight: 'heavy', size: true },
  { source: `${TABLE}.xlsx`, target: 'csv', truth: { kind: 'csv', file: `${TABLE}.csv` }, producer: 'soffice', weight: 'heavy', size: false },
];
const REFERENCE_TOOL: Readonly<Record<Producer, string>> = { duckdb: 'DuckDB', pyarrow: 'Apache Arrow (pyarrow)', soffice: 'soffice' };
const NATIVE_ENGINE_PREFIX = 'native-';

const caseName = (item: DataCase): string => `${path.basename(item.source)}->${item.target}`;
const formatOf = (file: string): string => path.extname(file).slice(1);

interface ReaderScore {
  cells: number;
  mismatches: number;
  first: string | null;
}

interface CheckResult {
  readers: Record<string, ReaderScore>;
}

function specsOf(item: DataCase): MetricSpec[] {
  return [SPEC.cellMismatches, ...(item.size ? [SPEC.bytes] : []), SPEC.throughput];
}

/** The cells the output gets wrong according to the worst of the independent readers. */
async function mismatchesOf(server: ReferenceServer, kind: OutputKind, file: string, truth: Truth): Promise<number> {
  const result = await server.call<CheckResult>('data.check', { kind, file, truth: { kind: truth.kind, file: path.join(CORPUS_DIR, truth.file) } });
  return Math.max(...Object.values(result.readers).map((reader) => reader.mismatches));
}

function sofficeConvert(soffice: string, profile: string, input: string, item: DataCase, outDir: string): string {
  fs.mkdirSync(outDir, { recursive: true });
  // CSV in and out is read and written as UTF-8 with a comma and a double quote, whatever the locale of the machine.
  const csvOptions = '44,34,76,1';
  const args = [`-env:UserInstallation=${profile}`, '--headless'];
  if (formatOf(item.source) === 'csv') args.push(`--infilter=CSV:${csvOptions}`);
  args.push('--convert-to', item.target === 'csv' ? `csv:Text - txt - csv (StarCalc):${csvOptions}` : item.target, '--outdir', outDir, input);
  runTool(soffice, args);
  return path.join(outDir, `${path.parse(input).name}.${item.target}`);
}

async function runCase(ctx: FamilyContext, item: DataCase, tools: { server: ReferenceServer; soffice: string; profile: string }): Promise<BenchRow[]> {
  const name = caseName(item);
  const referenceTool = REFERENCE_TOOL[item.producer];
  ctx.log(`data ${name}`);
  const sourceFile = ctx.corpusPath(item.source);
  const input = ctx.corpusBuffer(item.source);
  const convertOurs = async (): Promise<Buffer> => {
    const converted = await convertWithProject(input, formatOf(item.source), item.target, {}, path.basename(item.source));
    if (converted.engineUsed.startsWith(NATIVE_ENGINE_PREFIX)) {
      throw new OutputIntegrityError(`${name} ran on ${converted.engineUsed}; a data row compares the in-process engine with the reference tool, not a native engine with itself`);
    }
    return converted.buffer;
  };
  const referenceOut = ctx.scratch(`reference.${item.target}`);
  const produceReference = async (): Promise<void> => {
    if (item.producer === 'soffice') {
      const produced = sofficeConvert(tools.soffice, tools.profile, sourceFile, item, ctx.scratch('reference-out'));
      fs.copyFileSync(produced, referenceOut);
    } else {
      await tools.server.call('data.convert', { kind: item.conversion, src: sourceFile, dst: referenceOut });
    }
  };

  const rows: BenchRow[] = [];
  if (ctx.quality) {
    const oursBytes = await convertOurs();
    const oursFile = ctx.scratch(`ours.${item.target}`);
    fs.writeFileSync(oursFile, oursBytes);
    await produceReference();
    rows.push(
      measuredRow('data', name, SPEC.cellMismatches, await mismatchesOf(tools.server, item.target, oursFile, item.truth), await mismatchesOf(tools.server, item.target, referenceOut, item.truth), referenceTool)
    );
    if (item.size) rows.push(measuredRow('data', name, SPEC.bytes, oursBytes.length, fs.statSync(referenceOut).size, referenceTool));
  }
  if (ctx.speed) {
    const timing = await ctx.time(
      speedRowId('data', name),
      async () => {
        await convertOurs();
      },
      produceReference,
      item.weight,
      item.weight === 'light' ? IN_PROCESS_REPEATS : 1
    );
    rows.push(throughputRow('data', name, input.length, timing, referenceTool));
  }
  return rows;
}

export const runData: FamilyRunner = async (ctx) => {
  const cases = CASES.filter((item) => ctx.inScope('data', caseName(item)));
  if (cases.length === 0) return [];
  const plan = ctx.plan(['python3', PYARROW_PSEUDO_TOOL, DUCKDB_PSEUDO_TOOL, OPENPYXL_PSEUDO_TOOL, 'soffice'], 'data');
  if (!plan.ok) return cases.flatMap((item) => skippedGroup('data', caseName(item), specsOf(item), REFERENCE_TOOL[item.producer], plan));
  const server = ReferenceServer.start(plan.paths.python3);
  try {
    const profile = `file://${path.join(ctx.work, 'soffice-profile')}`;
    const rows: BenchRow[] = [];
    for (const item of cases) rows.push(...(await runCase(ctx, item, { server, soffice: plan.paths.soffice, profile })));
    return rows;
  } finally {
    await server.close();
  }
};
