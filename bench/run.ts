/**
 * Quality benchmark runner (`npm run bench:quality`). Converts the committed corpus through the project's public
 * conversion entry point, measures the outputs with independent tools against reference encoders at matched
 * settings, writes bench-results/<date>.json and .md, and gates the result against bench/baseline.json.
 *
 * Exit codes: 0 pass, 1 at least one metric regressed, 2 the run itself failed (bad arguments, missing tool under
 * ORACLE_STRICT_MODE=1, a tool or output that could not be read).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BASELINE_PATH, DEFAULT_RUNS, HEAVY_RUNS_CAP, MAX_JSON_BYTES, MAX_RUNS, RESULTS_DIR, SCHEMA_VERSION, WARMUP_RUNS } from './config';
import { createContext, type Injection, parseInjection } from './context';
import { BenchArgumentError, BenchError, ReportSchemaError } from './errors';
import { FAMILY_RUNNERS } from './families';
import { buildBaseline, evaluateGate, type GateResult, readBaseline } from './gate';
import { type BenchReport, type BenchRow, FAMILIES, type Family, renderMarkdown, validateReport } from './report';
import { defaultResolver, LIBVMAF_PSEUDO_TOOL, toolVersion } from './tools';

const FAMILY_SET: ReadonlySet<string> = new Set(FAMILIES);
const REPORTED_TOOLS = ['ffmpeg', 'ffprobe', 'cwebp', 'dwebp', 'avifenc', 'avifdec', 'magick', 'zstd', 'xz', '7z', 'pdftotext', 'tesseract', 'soffice', 'ssimulacra2'] as const;
const EXIT_PASS = 0;
const EXIT_REGRESSION = 1;
const EXIT_ERROR = 2;
const DATE_LENGTH = 10;

export interface CliOptions {
  families: Family[];
  runs: number;
  updateBaseline: boolean;
  baselinePath: string;
  outDir: string;
  gate: boolean;
  injection: Injection | null;
  compareReport: string | null;
}

function takeValue(args: string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (value === undefined || value.startsWith('--')) throw new BenchArgumentError(`${flag} needs a value`);
  return value;
}

export function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    families: [...FAMILIES],
    runs: DEFAULT_RUNS,
    updateBaseline: false,
    baselinePath: BASELINE_PATH,
    outDir: RESULTS_DIR,
    gate: true,
    injection: null,
    compareReport: null,
  };
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === '--update-baseline') {
      options.updateBaseline = true;
    } else if (flag === '--no-gate') {
      options.gate = false;
    } else if (flag === '--family') {
      const names = takeValue(args, i++, flag).split(',').map((name) => name.trim());
      const unknown = names.filter((name) => !FAMILY_SET.has(name));
      if (unknown.length > 0) throw new BenchArgumentError(`unknown family ${unknown.join(', ')}; use ${FAMILIES.join(', ')}`);
      options.families = FAMILIES.filter((family) => names.includes(family));
    } else if (flag === '--runs') {
      const runs = Number(takeValue(args, i++, flag));
      if (!Number.isInteger(runs) || runs < 1 || runs > MAX_RUNS) throw new BenchArgumentError(`--runs must be an integer from 1 to ${MAX_RUNS}`);
      options.runs = runs;
    } else if (flag === '--baseline') {
      options.baselinePath = path.resolve(takeValue(args, i++, flag));
    } else if (flag === '--out') {
      options.outDir = path.resolve(takeValue(args, i++, flag));
    } else if (flag === '--inject-regression') {
      options.injection = parseInjection(takeValue(args, i++, flag));
    } else if (flag === '--compare-report') {
      options.compareReport = path.resolve(takeValue(args, i++, flag));
    } else {
      throw new BenchArgumentError(`unknown argument ${flag}`);
    }
  }
  if (options.updateBaseline && options.injection) throw new BenchArgumentError('--update-baseline cannot be combined with --inject-regression');
  if (options.updateBaseline && !options.gate) throw new BenchArgumentError('--update-baseline cannot be combined with --no-gate');
  return options;
}

function readReport(file: string): BenchReport {
  const size = fs.statSync(file).size;
  if (size > MAX_JSON_BYTES) throw new ReportSchemaError(`report ${file} is ${size} bytes, over the ${MAX_JSON_BYTES} byte limit`);
  return validateReport(JSON.parse(fs.readFileSync(file, 'utf8')) as unknown);
}

function describeRow(row: BenchRow): string {
  const fmt = (value: number | null): string => (value === null ? '-' : Number(value.toPrecision(5)).toString());
  return `${row.id}: ours ${fmt(row.ours)} ${row.unit}, reference ${fmt(row.reference)}, delta ${fmt(row.delta)}`;
}

function printGate(result: GateResult, out: (line: string) => void): void {
  out(`gate: ${result.compared} metrics compared, ${result.regressions.length} regressed, ${result.improvements.length} improved, ${result.unbaselined.length} without baseline, ${result.skipped.length} skipped`);
  for (const regression of result.regressions) out(`REGRESSION ${regression.message}`);
  for (const id of result.unbaselined) out(`no baseline yet: ${id}`);
}

async function measureAll(options: CliOptions, strict: boolean): Promise<BenchReport> {
  const resolve = defaultResolver();
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-quality-'));
  try {
    const ctx = createContext({
      resolve,
      strict,
      runs: options.runs,
      heavyRuns: Math.min(options.runs, HEAVY_RUNS_CAP),
      warmup: WARMUP_RUNS,
      injection: options.injection,
      work,
      log: (message) => process.stderr.write(`  ${message}\n`),
    });
    const rows: BenchRow[] = [];
    for (const family of options.families) {
      process.stderr.write(`family ${family}\n`);
      rows.push(...(await FAMILY_RUNNERS[family](ctx)));
    }
    const tools: Record<string, string | null> = {};
    for (const tool of REPORTED_TOOLS) tools[tool] = toolVersion(tool, resolve(tool));
    tools.libvmaf = resolve(LIBVMAF_PSEUDO_TOOL) ? 'ffmpeg filter present' : null;
    return validateReport({
      schemaVersion: SCHEMA_VERSION,
      generatedAt: new Date().toISOString(),
      strictMode: strict,
      families: options.families,
      host: { platform: os.platform(), arch: os.arch(), node: process.version, cpus: os.cpus().length },
      tools,
      settings: { runs: options.runs, injectedRegression: options.injection },
      rows,
    });
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

function writeReport(report: BenchReport, outDir: string): string {
  fs.mkdirSync(outDir, { recursive: true });
  const date = report.generatedAt.slice(0, DATE_LENGTH);
  const stem = path.join(outDir, report.settings.injectedRegression ? `${date}-${report.settings.injectedRegression}` : date);
  fs.writeFileSync(`${stem}.json`, `${JSON.stringify(report, null, 2)}\n`);
  fs.writeFileSync(`${stem}.md`, renderMarkdown(report));
  return stem;
}

export async function main(args: string[], out: (line: string) => void = (line) => process.stdout.write(`${line}\n`)): Promise<number> {
  const options = parseArgs(args);
  const strict = process.env.ORACLE_STRICT_MODE === '1';

  if (options.compareReport) {
    const result = evaluateGate(readReport(options.compareReport), readBaseline(options.baselinePath));
    printGate(result, out);
    return result.regressions.length > 0 ? EXIT_REGRESSION : EXIT_PASS;
  }

  const report = await measureAll(options, strict);
  const stem = writeReport(report, options.outDir);
  const measured = report.rows.filter((row) => row.status === 'measured');
  const skipped = report.rows.filter((row) => row.status === 'skipped');
  out(`report: ${stem}.json and ${stem}.md (${measured.length} measured, ${skipped.length} skipped)`);
  for (const row of skipped) out(`skipped ${row.id}: ${row.skipReason}`);
  for (const row of measured.filter((r) => r.kind === 'bdrate' || r.metric === 'throughput')) out(describeRow(row));

  if (options.updateBaseline) {
    const previous = fs.existsSync(options.baselinePath) ? readBaseline(options.baselinePath) : null;
    const next = buildBaseline(report, previous);
    fs.writeFileSync(options.baselinePath, `${JSON.stringify(next, null, 2)}\n`);
    out(`baseline updated: ${Object.keys(next.entries).length} entries in ${options.baselinePath}`);
    return EXIT_PASS;
  }
  if (!options.gate) return EXIT_PASS;
  if (!fs.existsSync(options.baselinePath)) throw new BenchArgumentError(`no baseline at ${options.baselinePath}; create it with --update-baseline`);
  const result = evaluateGate(report, readBaseline(options.baselinePath), { families: new Set(options.families) });
  printGate(result, out);
  return result.regressions.length > 0 ? EXIT_REGRESSION : EXIT_PASS;
}

if (require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error: unknown) => {
      process.stderr.write(`bench:quality failed: ${error instanceof BenchError ? `${error.name}: ${error.message}` : String(error instanceof Error ? error.stack : error)}\n`);
      process.exit(EXIT_ERROR);
    }
  );
}
