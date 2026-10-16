/**
 * Which registry formats have real sample files. A real sample is a file pinned by digest in one of the corpus manifests
 * (the public sample sets of the parity benchmark, the real-world corpus, the camera-RAW fixtures); files that a test or the
 * generator writes do not count, because a conversion judged only on inputs we produced is judged on our own producer.
 *
 *   npx tsx bench/realworld/format-coverage.ts   prints the table: format, samples, producers, sources
 *
 * The rule (tests/corpus-format-coverage.test.ts): every format has at least MIN_REAL_SAMPLES samples, or an entry in
 * format-coverage-exceptions.json that says why no public sample with a usable licence exists. The producer count is
 * reported, not enforced: whether a second producer of a format exists is a finding of the search, not a property a test can know.
 */
import fs from 'node:fs';
import path from 'node:path';

export const MIN_REAL_SAMPLES = 3;
export const EXCEPTIONS_PATH = path.join(__dirname, 'format-coverage-exceptions.json');
export const EXCEPTIONS_SCHEMA = 1;

const REPO_ROOT = path.join(__dirname, '..', '..');
const REMOTE_MANIFEST_PATH = path.join(REPO_ROOT, 'bench', 'corpus', 'remote-manifest.json');
const REALWORLD_MANIFEST_PATH = path.join(__dirname, 'manifest.json');
const RAW_FIXTURE_MANIFESTS = ['manifest.json', 'variants.json'].map((name) => path.join(REPO_ROOT, 'tests', 'fixtures', 'raw', name));
const RAW_FIXTURE_PRODUCER = 'pixls';

/** One real file: the registry format it is a sample of, and who produced or published it. */
export interface RealSample {
  format: string;
  producer: string;
  /** The manifest that pins it (`remote`, `realworld`, `raw-fixtures`). */
  manifest: string;
}

export interface FormatCoverage {
  format: string;
  samples: number;
  producers: number;
}

export interface CoverageException {
  reason: string;
  /** The sources that were searched, each with what was found there. */
  searched: string[];
}

export interface CoverageExceptions {
  schema: number;
  /** Formats allowed fewer than MIN_REAL_SAMPLES samples. */
  formats: Record<string, CoverageException>;
}

interface RemoteEntry {
  id: string;
  set: string;
  meta?: { format?: string };
}
interface RealworldEntry {
  format: string;
  source: string;
  producer?: string;
}
interface FixtureEntry {
  format: string;
}

function readJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
}

/** The registry format of a remote-manifest sample: its declared format, else the longest known suffix of the file name. */
export function remoteFormatOf(entry: RemoteEntry, knownFormats: ReadonlySet<string>): string | null {
  const declared = entry.meta?.format;
  if (declared !== undefined) return knownFormats.has(declared) ? declared : null;
  const dot = entry.id.indexOf('.');
  for (let start = dot; start !== -1; start = entry.id.indexOf('.', start + 1)) {
    const suffix = entry.id.slice(start + 1).toLowerCase();
    if (knownFormats.has(suffix)) return suffix;
  }
  return null;
}

export function collectRealSamples(knownFormats: ReadonlySet<string>): RealSample[] {
  const samples: RealSample[] = [];
  for (const entry of readJson<{ samples: RemoteEntry[] }>(REMOTE_MANIFEST_PATH).samples) {
    const format = remoteFormatOf(entry, knownFormats);
    if (format !== null) samples.push({ format, producer: entry.set, manifest: 'remote' });
  }
  for (const entry of readJson<{ files: RealworldEntry[] }>(REALWORLD_MANIFEST_PATH).files) {
    samples.push({ format: entry.format, producer: entry.producer ?? entry.source, manifest: 'realworld' });
  }
  for (const file of RAW_FIXTURE_MANIFESTS) {
    for (const entry of readJson<FixtureEntry[]>(file)) samples.push({ format: entry.format, producer: RAW_FIXTURE_PRODUCER, manifest: 'raw-fixtures' });
  }
  return samples;
}

/** Samples and distinct producers per format, for each of `formats`. */
export function coverageOf(formats: readonly string[], samples: readonly RealSample[]): FormatCoverage[] {
  const byFormat = new Map<string, RealSample[]>();
  for (const sample of samples) byFormat.set(sample.format, [...(byFormat.get(sample.format) ?? []), sample]);
  return formats.map((format) => {
    const own = byFormat.get(format) ?? [];
    return { format, samples: own.length, producers: new Set(own.map((sample) => sample.producer)).size };
  });
}

export function readExceptions(file = EXCEPTIONS_PATH): CoverageExceptions {
  const exceptions = readJson<CoverageExceptions>(file);
  if (exceptions.schema !== EXCEPTIONS_SCHEMA) throw new Error(`${file}: schema ${exceptions.schema}, expected ${EXCEPTIONS_SCHEMA}`);
  return exceptions;
}

/** Why a format breaks the rule, or null when it keeps it. */
export function violationOf(row: FormatCoverage, exceptions: CoverageExceptions): string | null {
  if (row.samples >= MIN_REAL_SAMPLES || exceptions.formats[row.format] !== undefined) return null;
  return `${row.format}: ${row.samples} real samples, ${MIN_REAL_SAMPLES} needed, and no recorded reason`;
}

function printTable(): void {
  const { getAllFormats } = require('../../src/lib/registry') as typeof import('../../src/lib/registry');
  const formats = getAllFormats().map((def) => def.id);
  const rows = coverageOf(formats, collectRealSamples(new Set(formats)));
  console.log('| Format | Samples | Producers |\n|---|---|---|');
  for (const row of rows) console.log(`| ${row.format} | ${row.samples} | ${row.producers} |`);
}

if (require.main === module) printTable();
