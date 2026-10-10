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
import {
  BASELINE_PATH,
  REPO_ROOT,
  DEFAULT_RUNS,
  HEAVY_RUNS_CAP,
  MAX_JSON_BYTES,
  MAX_RUNS,
  PARITY_GAPS_PATH,
  PARITY_SCHEMA_VERSION,
  PARITY_VERDICT_FILE,
  REF_CACHE_DIR,
  RESULTS_DIR,
  SCHEMA_VERSION,
  WARMUP_RUNS,
} from './config';
import { AbHost } from './ab-host';
import { AB_EXTRA_BUDGET_MS } from './ab-config';
import { createContext, type Injection, parseInjection } from './context';
import { BenchArgumentError, BenchError, ReportSchemaError } from './errors';
import { FAMILY_RUNNERS } from './families';
import { buildBaseline, evaluateGate, type GateResult, readBaseline } from './gate';
import { corpusFileHash, harnessHash } from './harness-hash';
import { evaluateParity, failureLines, type ParityRunFile, type ParityScope, renderParityMarkdown, renderParityText } from './parity';
import { readGaps } from './parity-gaps';
import { ReferenceCache, sha256Hex } from './ref-cache';
import { type BenchReport, type BenchRow, FAMILIES, type Family, renderMarkdown, reportSource, validateReport } from './report';
import { rowInScope } from './scope';
import { defaultResolver, LIBVMAF_PSEUDO_TOOL, toolVersion } from './tools';

const FAMILY_SET: ReadonlySet<string> = new Set(FAMILIES);
const REPORTED_TOOLS = ['ffmpeg', 'ffprobe', 'cwebp', 'dwebp', 'avifenc', 'avifdec', 'magick', 'zstd', 'xz', '7z', 'pdftotext', 'tesseract', 'soffice', 'pdfimages', 'epubcheck', 'ssimulacra2'] as const;
const EXIT_PASS = 0;
/** A metric got worse than our own baseline: never excused by a label. */
const EXIT_REGRESSION = 1;
const EXIT_ERROR = 2;
/** Every metric is at its baseline, but at least one row is below the reference tool. */
const EXIT_BELOW_REFERENCE = 3;
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
  /** Reference-parity gate: ours must be at or above the reference tool on every row. */
  parity: boolean;
  /** Parity only: the representative subset of cases per family (QUICK_SUBSET). */
  quick: boolean;
  qualityOnly: boolean;
  speedOnly: boolean;
  /** Parity only: read and write the reference-side cache. */
  refCache: boolean;
  cacheDir: string;
  gapsPath: string;
  /** Parity, speed only: a checkout of the base commit; speed rows are then measured against it in the same pairs, by a second process (bench/ab-host.ts). */
  baseRoot: string | null;
  /** Parity only: the gap file of the base of the change; its new or changed entries must be backed by the speed rows measured in this run. */
  baseGapsPath: string | null;
  /** Print a hash of the reference tool versions and exit (the key of the CI cache). */
  printToolFingerprint: boolean;
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
    parity: false,
    quick: false,
    qualityOnly: false,
    speedOnly: false,
    refCache: true,
    cacheDir: REF_CACHE_DIR,
    gapsPath: PARITY_GAPS_PATH,
    baseRoot: null,
    baseGapsPath: null,
    printToolFingerprint: false,
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
    } else if (flag === '--parity') {
      options.parity = true;
    } else if (flag === '--quick') {
      options.quick = true;
    } else if (flag === '--quality-only') {
      options.qualityOnly = true;
    } else if (flag === '--speed-only') {
      options.speedOnly = true;
    } else if (flag === '--no-ref-cache') {
      options.refCache = false;
    } else if (flag === '--cache-dir') {
      options.cacheDir = path.resolve(takeValue(args, i++, flag));
    } else if (flag === '--gaps') {
      options.gapsPath = path.resolve(takeValue(args, i++, flag));
    } else if (flag === '--base-root') {
      options.baseRoot = path.resolve(takeValue(args, i++, flag));
    } else if (flag === '--base-gaps') {
      options.baseGapsPath = path.resolve(takeValue(args, i++, flag));
    } else if (flag === '--print-tool-fingerprint') {
      options.printToolFingerprint = true;
    } else {
      throw new BenchArgumentError(`unknown argument ${flag}`);
    }
  }
  if (options.updateBaseline && options.injection) throw new BenchArgumentError('--update-baseline cannot be combined with --inject-regression');
  if (options.updateBaseline && !options.gate) throw new BenchArgumentError('--update-baseline cannot be combined with --no-gate');
  for (const [flag, used] of [['--quick', options.quick], ['--quality-only', options.qualityOnly], ['--speed-only', options.speedOnly]] as const) {
    if (used && !options.parity) throw new BenchArgumentError(`${flag} needs --parity`);
  }
  if (options.qualityOnly && options.speedOnly) throw new BenchArgumentError('--quality-only and --speed-only exclude each other');
  if (options.parity && options.updateBaseline) throw new BenchArgumentError('--update-baseline cannot be combined with --parity');
  // A workflow names the base checkout through the environment, so that its command line stays the one the benchmark documents.
  if (options.baseRoot === null && options.parity && options.speedOnly && process.env.BENCH_BASE_ROOT) options.baseRoot = path.resolve(process.env.BENCH_BASE_ROOT);
  if (options.baseRoot && options.injection !== null && options.injection !== 'slow-ours') throw new BenchArgumentError('--base-root takes no injected regression but slow-ours');
  if (options.baseRoot && !(options.parity && options.speedOnly)) throw new BenchArgumentError('--base-root needs --parity and --speed-only');
  if (options.parity && !options.gate) throw new BenchArgumentError('--parity cannot be combined with --no-gate');
  if (options.baseGapsPath && !options.parity) throw new BenchArgumentError('--base-gaps needs --parity');
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
  for (const note of result.speedNotes) out(`note ${note}`);
  for (const id of result.unbaselined) out(`no baseline yet: ${id}`);
}

function toolsOf(resolve: ReturnType<typeof defaultResolver>): Record<string, string | null> {
  const tools: Record<string, string | null> = {};
  for (const tool of REPORTED_TOOLS) tools[tool] = toolVersion(tool, resolve(tool));
  tools.libvmaf = resolve(LIBVMAF_PSEUDO_TOOL) ? 'ffmpeg filter present' : null;
  return tools;
}

/** Hash of every reference tool's version line: changes exactly when a reference tool is upgraded, added or removed. */
export function toolFingerprint(tools: Record<string, string | null>): string {
  return sha256Hex(JSON.stringify(Object.entries(tools).sort(([a], [b]) => (a < b ? -1 : 1))));
}

async function measureAll(options: CliOptions, strict: boolean): Promise<BenchReport> {
  const log = (message: string): void => {
    process.stderr.write(`  ${message}\n`);
  };
  // The head and the base each run in a process of their own: neither has the advantage of the benchmark's own process.
  const hosts = options.baseRoot
    ? {
        head: await AbHost.start({ root: REPO_ROOT, families: options.families, quick: options.quick, injection: options.injection, log }),
        base: await AbHost.start({ root: options.baseRoot, families: options.families, quick: options.quick, log }),
      }
    : null;
  try {
    return await measureWith(options, strict, hosts);
  } finally {
    await Promise.all([hosts?.head.stop(), hosts?.base.stop()]);
  }
}

async function measureWith(options: CliOptions, strict: boolean, hosts: { head: AbHost; base: AbHost } | null): Promise<BenchReport> {
  const resolve = defaultResolver();
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-quality-'));
  try {
    const versions = new Map<string, string | null>();
    const log = (message: string): void => {
      process.stderr.write(`  ${message}\n`);
    };
    const fileHashes = new Map<string, string>();
    const harnessHashes = new Map<string, string>();
    const memoized = (cache: Map<string, string>, key: string, compute: () => string): string => {
      const known = cache.get(key);
      if (known !== undefined) return known;
      const computed = compute();
      cache.set(key, computed);
      return computed;
    };
    const refCache = new ReferenceCache({
      dir: options.parity && options.refCache ? options.cacheDir : null,
      toolVersion: (tool) => {
        if (!versions.has(tool)) versions.set(tool, toolVersion(tool, resolve(tool)));
        return versions.get(tool) ?? null;
      },
      fileHash: (relative) => memoized(fileHashes, relative, () => corpusFileHash(relative)),
      harnessHash: (family) => memoized(harnessHashes, family, () => harnessHash(family)),
      log,
    });
    const ctx = createContext({
      resolve,
      strict,
      runs: options.runs,
      heavyRuns: Math.min(options.runs, HEAVY_RUNS_CAP),
      warmup: WARMUP_RUNS,
      injection: options.injection,
      parity: options.parity,
      quality: !options.speedOnly,
      speed: !options.qualityOnly,
      quick: options.quick,
      refCache,
      work,
      log,
      ab: hosts ? { ...hosts, extra: { remainingMs: AB_EXTRA_BUDGET_MS } } : null,
    });
    const rows: BenchRow[] = [];
    for (const family of options.families) {
      process.stderr.write(`family ${family}\n`);
      rows.push(...(await FAMILY_RUNNERS[family](ctx)));
    }
    if (options.parity) {
      const { hits, misses, corrupt } = refCache.stats;
      process.stderr.write(`reference cache: ${hits} hits, ${misses} measured, ${corrupt} corrupt (${options.refCache ? options.cacheDir : 'off'})\n`);
    }
    return validateReport({
      schemaVersion: SCHEMA_VERSION,
      generatedAt: new Date().toISOString(),
      strictMode: strict,
      families: options.families,
      host: { platform: os.platform(), arch: os.arch(), node: process.version, cpus: os.cpus().length },
      tools: toolsOf(resolve),
      settings: { runs: options.runs, injectedRegression: options.injection },
      ...(reportSource(process.env) ? { source: reportSource(process.env) } : {}),
      rows,
    });
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

function writeReport(report: BenchReport, outDir: string, suffix = ''): string {
  fs.mkdirSync(outDir, { recursive: true });
  const date = report.generatedAt.slice(0, DATE_LENGTH);
  const named = report.settings.injectedRegression ? `${date}-${report.settings.injectedRegression}` : date;
  const stem = path.join(outDir, `${named}${suffix}`);
  fs.writeFileSync(`${stem}.json`, `${JSON.stringify(report, null, 2)}\n`);
  fs.writeFileSync(`${stem}.md`, renderMarkdown(report));
  return stem;
}

/** File-name suffix that keeps a parity report apart from a full run's report of the same day. */
function reportSuffix(options: CliOptions): string {
  if (!options.parity) return '';
  const quick = options.quick ? '-quick' : '';
  return `-parity-${parityScope(options)}${quick}`;
}

function parityScope(options: CliOptions): ParityScope {
  if (options.qualityOnly) return 'quality';
  return options.speedOnly ? 'speed' : 'both';
}

/**
 * Baseline gate and parity verdict of a parity run. The gate checks only what was measured: quality rows or
 * throughput rows (a baseline throughput entry has a ratio), and the cases of the quick subset when `--quick` is set.
 * Regressions against our own baseline return EXIT_REGRESSION and are never excused; a row below the reference with
 * every metric at its baseline returns EXIT_BELOW_REFERENCE. The verdict is also written for the CI step that applies
 * the label policy.
 */
function judgeParity(report: BenchReport, options: CliOptions, out: (line: string) => void): number {
  if (!fs.existsSync(options.baselinePath)) throw new BenchArgumentError(`no baseline at ${options.baselinePath}; create it with --update-baseline`);
  const scope = parityScope(options);
  const include = (id: string, entry: { ratio: number | null }): boolean => {
    if (!rowInScope(options.quick, id)) return false;
    if (scope === 'both') return true;
    return scope === 'speed' ? entry.ratio !== null : entry.ratio === null;
  };
  const gate = evaluateGate(report, readBaseline(options.baselinePath), { families: new Set(options.families), include });
  printGate(gate, out);
  // A quality-only run measures no speed, so it cannot back a gap entry; the speed run of the same change does.
  const baseGaps = options.baseGapsPath && scope !== 'quality' ? readGaps(options.baseGapsPath) : undefined;
  const parity = evaluateParity(report, readGaps(options.gapsPath), { baseGaps });
  for (const line of failureLines(parity)) out(line);
  for (const line of renderParityText(parity)) out(line);

  let exitCode = EXIT_PASS;
  if (gate.regressions.length > 0) exitCode = EXIT_REGRESSION;
  else if (parity.verdict === 'fail') exitCode = EXIT_BELOW_REFERENCE;
  const file: ParityRunFile = {
    schemaVersion: PARITY_SCHEMA_VERSION,
    generatedAt: report.generatedAt,
    families: options.families,
    quick: options.quick,
    scope,
    strictMode: report.strictMode,
    injectedRegression: report.settings.injectedRegression,
    exitCode,
    baseline: { compared: gate.compared, regressions: gate.regressions.map((regression) => regression.message) },
    parity,
  };
  fs.mkdirSync(options.outDir, { recursive: true });
  fs.writeFileSync(path.join(options.outDir, PARITY_VERDICT_FILE), `${JSON.stringify(file, null, 2)}\n`);
  fs.writeFileSync(path.join(options.outDir, PARITY_VERDICT_FILE.replace(/\.json$/, '.md')), renderParityMarkdown(parity));
  return exitCode;
}

export async function main(args: string[], out: (line: string) => void = (line) => process.stdout.write(`${line}\n`)): Promise<number> {
  const options = parseArgs(args);
  const strict = process.env.ORACLE_STRICT_MODE === '1';

  if (options.printToolFingerprint) {
    out(toolFingerprint(toolsOf(defaultResolver())));
    return EXIT_PASS;
  }

  if (options.compareReport) {
    const compared = readReport(options.compareReport);
    if (options.parity) return judgeParity(compared, options, out);
    const result = evaluateGate(compared, readBaseline(options.baselinePath));
    printGate(result, out);
    return result.regressions.length > 0 ? EXIT_REGRESSION : EXIT_PASS;
  }

  const report = await measureAll(options, strict);
  const stem = writeReport(report, options.outDir, reportSuffix(options));
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
  if (options.parity) return judgeParity(report, options, out);
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
