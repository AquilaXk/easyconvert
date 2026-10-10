import fs from 'node:fs';
import type { Job } from '../src/lib/queue/bullmq-engine';
import { convertArchive, extract7zArchive, gunzipStreamingWithLimits, inspectArchive, repairZipArchive } from '../src/lib/conversions/archive';
import { parseAllXlsxWorksheets } from '../src/lib/conversions/office';
import { openPackage, readPackageEntry } from '../src/lib/conversions/package-access';
import { processGraphNodeJob } from '../src/lib/queue/graph/node-executor';
import { s3Storage } from '../src/lib/storage/s3-storage';
import type { ConversionJobData, ConversionJobResult } from '../src/lib/types';

/**
 * Runs one decompression scenario in a fresh process and prints how it ended, how long the call took and how far the
 * process's peak RSS rose during it. The fixture is read from a file before the baseline is taken, so the peak that
 * is measured belongs to the scenario alone: no earlier test in a shared worker can have raised it already.
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

type Scenario = (fixture: Buffer) => Promise<unknown>;

const SCENARIOS: Record<string, Scenario> = {
  gunzip: (fixture) => gunzipStreamingWithLimits(fixture),
  'convert-tar-gz': (fixture) => convertArchive(fixture, 'tar.gz', 'zip', {}, 'bomb.tar.gz'),
  'convert-tgz': (fixture) => convertArchive(fixture, 'tgz', 'zip', {}, 'bomb.tgz'),
  'convert-gz': (fixture) => convertArchive(fixture, 'gz', 'zip', {}, 'bomb.gz'),
  inspect: (fixture) => inspectArchive(fixture, { filename: 'bomb.tar.gz' }),
  'graph-tgz': async (fixture) => {
    const key = `tests/decompression-bomb-child/${Date.now()}_bomb.tgz`;
    await s3Storage.saveObject(key, fixture, 'application/gzip', 'bomb.tgz', GRAPH_ENTRY_TTL_MS);
    return processGraphNodeJob(graphJob(key), undefined, s3Storage);
  },
  repair: (fixture) => repairZipArchive(fixture),
  xlsx: (fixture) => parseAllXlsxWorksheets(fixture),
  'package-entry': async (fixture) => {
    const zip = await openPackage(fixture, 'DOCX');
    return readPackageEntry(zip, 'word/document.xml', PACKAGE_ENTRY_LIMIT_BYTES, 'test package');
  },
  sevenzip: async (fixture) => extract7zArchive(fixture),
};

async function main(): Promise<void> {
  const [name, fixturePath] = process.argv.slice(2);
  const scenario = SCENARIOS[name];
  if (!scenario || !fixturePath) throw new Error(`usage: <scenario> <fixture file>; scenarios: ${Object.keys(SCENARIOS).join(', ')}`);
  const fixture = fs.readFileSync(fixturePath);
  const rssBefore = process.resourceUsage().maxRSS * KIB;
  const started = Date.now();
  let error: { name: string; status?: number; message: string } | null = null;
  let size: number | null = null;
  try {
    const value = await scenario(fixture);
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
