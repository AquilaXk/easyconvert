import fs from 'node:fs';
import type { Job } from '../src/lib/queue/bullmq-engine';
import type { ConversionJobData, ConversionJobResult } from '../src/lib/types';

/**
 * Runs one decompression scenario in a fresh process and prints how it ended, how long the call took and how far the
 * process's peak RSS rose during it. The fixture is read from a file before the baseline is taken, so the peak that
 * is measured belongs to the scenario alone: no earlier test in a shared worker can have raised it already. Modules
 * load inside the scenario, so a run pays only for what it uses.
 *
 *   node --import tsx decompression-bomb-child.ts <scenario> <fixture file>
 */

const KIB = 1024;
const PACKAGE_ENTRY_LIMIT_BYTES = 1024 * 1024;
const GRAPH_ENTRY_TTL_MS = 60_000;

function graphJob(inputKey: string) {
  const graphId = `g_child_${Date.now()}`;
  return {
    id: `${graphId}:n1`,
    data: {
      jobId: `${graphId}:n1`,
      sourceFormat: 'bin',
      targetFormat: 'bin',
      fileSize: 0,
      options: {},
      graphId,
      graphNodeId: 'n1',
      graphNode: { op: 'archive.extract' },
      inputArtifacts: [inputKey],
    },
    opts: { attempts: 1 },
    attemptsMade: 1,
    signal: new AbortController().signal,
    log: async () => {},
    updateProgress: async () => {},
  } as unknown as Job<ConversionJobData, ConversionJobResult>;
}

/** Loads what the scenario needs and returns the call to measure, so module loading is not part of the measurement. */
type Scenario = (fixture: Buffer) => Promise<() => Promise<unknown>>;

const SCENARIOS: Record<string, Scenario> = {
  gunzip: async (fixture) => {
    const { gunzipStreamingWithLimits } = await import('../src/lib/conversions/archive');
    return () => gunzipStreamingWithLimits(fixture);
  },
  'convert-tar-gz': async (fixture) => {
    const { convertArchive } = await import('../src/lib/conversions/archive');
    return () => convertArchive(fixture, 'tar.gz', 'zip', {}, 'bomb.tar.gz');
  },
  'convert-tgz': async (fixture) => {
    const { convertArchive } = await import('../src/lib/conversions/archive');
    return () => convertArchive(fixture, 'tgz', 'zip', {}, 'bomb.tgz');
  },
  'convert-gz': async (fixture) => {
    const { convertArchive } = await import('../src/lib/conversions/archive');
    return () => convertArchive(fixture, 'gz', 'zip', {}, 'bomb.gz');
  },
  inspect: async (fixture) => {
    const { inspectArchive } = await import('../src/lib/conversions/archive');
    return () => inspectArchive(fixture, { filename: 'bomb.tar.gz' });
  },
  'graph-tgz': async (fixture) => {
    const { s3Storage } = await import('../src/lib/storage/s3-storage');
    const { processGraphNodeJob } = await import('../src/lib/queue/graph/node-executor');
    const key = `tests/decompression-bomb-child/${Date.now()}_bomb.tgz`;
    await s3Storage.saveObject(key, fixture, 'application/gzip', 'bomb.tgz', GRAPH_ENTRY_TTL_MS);
    return () => processGraphNodeJob(graphJob(key), undefined, s3Storage);
  },
  repair: async (fixture) => {
    const { repairZipArchive } = await import('../src/lib/conversions/archive');
    return () => repairZipArchive(fixture);
  },
  xlsx: async (fixture) => {
    const { parseAllXlsxWorksheets } = await import('../src/lib/conversions/office');
    return () => parseAllXlsxWorksheets(fixture);
  },
  'package-entry': async (fixture) => {
    const { openPackage, readPackageEntry } = await import('../src/lib/conversions/package-access');
    return async () => {
      const zip = await openPackage(fixture, 'DOCX');
      return readPackageEntry(zip, 'word/document.xml', PACKAGE_ENTRY_LIMIT_BYTES, 'test package');
    };
  },
  sevenzip: async (fixture) => {
    const { extract7zArchive } = await import('../src/lib/conversions/archive');
    return async () => extract7zArchive(fixture);
  },
};

async function main(): Promise<void> {
  const [name, fixturePath] = process.argv.slice(2);
  const scenario = SCENARIOS[name];
  if (!scenario || !fixturePath) throw new Error(`usage: <scenario> <fixture file>; scenarios: ${Object.keys(SCENARIOS).join(', ')}`);
  const fixture = fs.readFileSync(fixturePath);
  const run = await scenario(fixture);
  const rssBefore = process.resourceUsage().maxRSS * KIB;
  const started = Date.now();
  let error: { name: string; status?: number; message: string } | null = null;
  let size: number | null = null;
  try {
    const value = await run();
    if (Buffer.isBuffer(value)) size = value.length;
  } catch (caught) {
    const failure = caught as { name?: string; status?: number; message?: string };
    error = { name: String(failure.name), status: failure.status, message: String(failure.message).slice(0, 200) };
  }
  const elapsedMs = Date.now() - started;
  const rssGrowthBytes = process.resourceUsage().maxRSS * KIB - rssBefore;
  process.stdout.write(`RESULT:${JSON.stringify({ error, elapsedMs, rssGrowthBytes, size })}\n`);
  process.exit(0);
}

void main();
