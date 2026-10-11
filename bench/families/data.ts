import fs from 'node:fs';
import path from 'node:path';
import { CORPUS_DIR, IN_PROCESS_REPEATS } from '../config';
import type { FamilyContext, FamilyRunner, RowWeight } from '../context';
import { convertWithProject } from '../convert';
import { OutputIntegrityError, ToolRunError } from '../errors';
import { PublicClassRows } from '../public-classes';
import { publicFile, publicSample, publicSamples, type PublicSample } from '../public-samples';
import { publicSpeedSample } from '../public-scope';
import { attemptOurs, CONVERTS_SPEC, convertsRow, unavailableRows } from '../public-support';
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
 *
 * The public samples (bench/corpus/public-manifest.json) are open datasets in CSV, JSON, JSON lines and Parquet (tall, wide,
 * unicode, empty cells, digit strings with leading zeros, long text with line breaks) and the test files of the Parquet format's
 * own repository (page encodings, codecs). Their truth is the text of the file itself (CSV, JSON, JSON lines), the expected-values
 * CSV that ships with a Parquet test file, or, for a Parquet file with neither, DuckDB's reading of it, while pyarrow is the
 * reference converter. A file the product refuses, or one that its output cannot be read back from, is a `converts` row instead
 * of a stopped run; the per-class rows average the cell mismatches over a class.
 */

type OutputKind = 'json' | 'csv' | 'parquet' | 'xlsx';
type Truth = { kind: 'csv' | 'jsonl' | 'json' | 'parquet'; file: string };
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
  /** The public sample the case reads; null for the generated table. */
  sample?: PublicSample;
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
/** A class row pools samples whose pairs have different reference tools; the sample rows name each one. */
const CLASS_REFERENCE = 'DuckDB, Apache Arrow (pyarrow), soffice';

const caseName = (item: DataCase): string => `${path.basename(item.source)}->${item.target}`;
const formatOf = (file: string): string => path.extname(file).slice(1);

/** The conversions of a public sample, by the format of the file: the reference tool of each is the one the generated table uses for the same pair. */
function publicCases(sample: PublicSample): DataCase[] {
  const format = String(sample.meta.format);
  const base = { source: sample.id, sample, size: false } as const;
  const truth: Truth = { kind: format === 'jsonl' || format === 'json' ? format : 'csv', file: sample.id };
  if (format === 'csv') {
    return [
      { ...base, target: 'json', truth, producer: 'duckdb', conversion: 'csv-json', weight: 'light' },
      { ...base, target: 'parquet', truth, producer: 'pyarrow', conversion: 'csv-parquet', weight: 'light', size: true },
      ...(sample.meta.xlsx === true ? [{ ...base, target: 'xlsx' as const, truth, producer: 'soffice' as const, weight: 'heavy' as const, size: true }] : []),
    ];
  }
  if (format === 'json' || format === 'jsonl') {
    return [{ ...base, target: 'csv', truth, producer: 'duckdb', conversion: format === 'json' ? 'json-csv' : 'jsonl-csv', weight: 'light' }];
  }
  // Parquet: the truth is a text twin that is another sample, or DuckDB's reading of the file.
  const twin = typeof sample.meta.truth === 'string' ? sample.meta.truth : 'parquet';
  const parquetTruth: Truth = twin === 'parquet' ? { kind: 'parquet', file: sample.id } : { kind: 'csv', file: twin };
  return [
    { ...base, target: 'csv', truth: parquetTruth, producer: 'pyarrow', conversion: 'parquet-csv', weight: 'light' },
    { ...base, target: 'json', truth: parquetTruth, producer: 'duckdb', conversion: 'parquet-json', weight: 'light' },
  ];
}

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
async function mismatchesOf(server: ReferenceServer, kind: OutputKind, file: string, truthKind: Truth['kind'], truthFile: string): Promise<number> {
  const result = await server.call<CheckResult>('data.check', { kind, file, truth: { kind: truthKind, file: truthFile } });
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

/** The files a case reads: the source under its own name (the office suite takes the format from the extension), and the truth. */
interface CaseFiles {
  source: string;
  truth: string;
}

const MEASURED_SPECS = (item: DataCase): MetricSpec[] => specsOf(item).filter((spec) => spec.kind !== 'throughput');

async function runCase(ctx: FamilyContext, item: DataCase, files: CaseFiles, tools: { server: ReferenceServer; soffice: string; profile: string }, classRows: PublicClassRows): Promise<BenchRow[]> {
  const name = caseName(item);
  const referenceTool = REFERENCE_TOOL[item.producer];
  const sample = item.sample ?? null;
  ctx.log(`data ${name}`);
  const sourceFile = files.source;
  const input = fs.readFileSync(sourceFile);
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
  const classKey = `->${item.target}`;
  let converted = true;
  if (ctx.quality) {
    if (sample) classRows.expect(sample.class, classKey, [...MEASURED_SPECS(item), CONVERTS_SPEC].map((spec) => spec.metric));
    const attempt = await attemptOurs(convertOurs, sample !== null);
    let referenceConverted = true;
    try {
      await produceReference();
    } catch (error) {
      if (sample === null || !(error instanceof ToolRunError)) throw error;
      referenceConverted = false;
      ctx.log(`data ${name}: the reference tool does not convert it (${error.message.slice(0, 160)})`);
    }
    if (sample) {
      if (!attempt.ok) ctx.log(`data ${name}: the product does not convert it (${attempt.reason})`);
      rows.push(convertsRow('data', name, attempt.ok, referenceConverted, referenceTool));
    }
    converted = attempt.ok;
    if (attempt.ok && referenceConverted) {
      const oursFile = ctx.scratch(`ours.${item.target}`);
      fs.writeFileSync(oursFile, attempt.value);
      let oursMismatches: number | null = null;
      try {
        oursMismatches = await mismatchesOf(tools.server, item.target, oursFile, item.truth.kind, files.truth);
      } catch (error) {
        // An output that the independent readers cannot read is a conversion that failed, not a run that failed.
        if (sample === null || !(error instanceof ToolRunError)) throw error;
        ctx.log(`data ${name}: the output is not readable (${error.message.slice(0, 160)})`);
        converted = false;
        rows.splice(rows.findIndex((row) => row.metric === CONVERTS_SPEC.metric), 1, convertsRow('data', name, false, true, referenceTool));
      }
      if (oursMismatches !== null) {
        rows.push(measuredRow('data', name, SPEC.cellMismatches, oursMismatches, await mismatchesOf(tools.server, item.target, referenceOut, item.truth.kind, files.truth), referenceTool));
        if (item.size) rows.push(measuredRow('data', name, SPEC.bytes, attempt.value.length, fs.statSync(referenceOut).size, referenceTool));
      }
    }
    if (sample) classRows.addRows(sample.class, classKey, rows, [...MEASURED_SPECS(item), CONVERTS_SPEC]);
  }
  if (ctx.speed && converted && (sample === null || publicSpeedSample('data', sample.id))) {
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

/** The files of a public case, or null when the host did not deliver one of them. */
async function publicFiles(ctx: FamilyContext, item: DataCase): Promise<CaseFiles | null> {
  const sample = item.sample as PublicSample;
  const cached = await publicFile(ctx, sample);
  if (cached === null) return null;
  const staged = ctx.scratch(`source-${sample.id}`);
  fs.copyFileSync(cached, staged);
  let truth = staged;
  if (item.truth.file !== sample.id) {
    const twin = publicSample(item.truth.file);
    if (twin === undefined) throw new OutputIntegrityError(`${sample.id}: the truth sample ${item.truth.file} is not in the public manifest`);
    const twinFile = await publicFile(ctx, twin);
    if (twinFile === null) return null;
    truth = twinFile;
  }
  return { source: staged, truth };
}

export const runData: FamilyRunner = async (ctx) => {
  const generated = CASES.filter((item) => ctx.inScope('data', caseName(item)));
  const published = publicSamples('data').flatMap(publicCases).filter((item) => ctx.inScope('data', caseName(item)));
  if (generated.length + published.length === 0) return [];
  const plan = ctx.plan(['python3', PYARROW_PSEUDO_TOOL, DUCKDB_PSEUDO_TOOL, OPENPYXL_PSEUDO_TOOL, 'soffice'], 'data');
  if (!plan.ok) return [...generated, ...published].flatMap((item) => skippedGroup('data', caseName(item), specsOf(item), REFERENCE_TOOL[item.producer], plan));
  const server = ReferenceServer.start(plan.paths.python3);
  try {
    const profile = `file://${path.join(ctx.work, 'soffice-profile')}`;
    const tools = { server, soffice: plan.paths.soffice, profile };
    const rows: BenchRow[] = [];
    const classRows = new PublicClassRows();
    for (const item of generated) rows.push(...(await runCase(ctx, item, { source: ctx.corpusPath(item.source), truth: ctx.corpusPath(item.truth.file) }, tools, classRows)));
    for (const item of published) {
      const files = await publicFiles(ctx, item);
      if (files === null) {
        rows.push(...unavailableRows('data', caseName(item), specsOf(item), REFERENCE_TOOL[item.producer], `public sample ${item.source} is not available`));
        continue;
      }
      rows.push(...(await runCase(ctx, item, files, tools, classRows)));
    }
    if (ctx.quality) {
      for (const row of classRows.rows('data', () => CLASS_REFERENCE)) {
        if (ctx.inScope('data', row.case)) rows.push(row);
      }
    }
    return rows;
  } finally {
    await server.close();
  }
};
