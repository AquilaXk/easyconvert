import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

/**
 * Production runs the web process and the worker in two containers that share only EASYCONVERT_STORAGE_DIR; each has a
 * temporary directory of its own, and a deploy starts a new web process while uploads are open. Here each side is a
 * fresh module graph with its own TMPDIR over one storage directory, or a child process with its own environment, so a
 * file or a session a process keeps only to itself is out of the other's reach, as in production.
 */

const ROOT = path.resolve(__dirname, '..');
const TSX_CLI = path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const WORKER_CHILD = path.join(ROOT, 'tests', 'helpers', 'storage-worker-child.ts');
const CHILD_TIMEOUT_MS = 60_000;
const BASE_URL = 'http://localhost:3000';
const VISITOR = { 'x-forwarded-for': '198.51.100.7' };
const MIB = 1024 * 1024;
const PART_BYTES = 32 * MIB;
/** Over the 64 MiB a single request carries, so the file can only arrive in parts. */
const UPLOAD_BYTES = 2 * PART_BYTES + MIB;
const RESULT_BYTES = 64 * MIB + MIB;
const RESULT_SEED = 0x5a5a5a5a;
const HTTP_OK = 200;

let baseDir: string;
let sharedDir: string;
let webTmp: string;
let workerTmp: string;

beforeEach(() => {
  baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ec-parts-shared-'));
  sharedDir = path.join(baseDir, 'shared-storage');
  webTmp = path.join(baseDir, 'web-tmp');
  workerTmp = path.join(baseDir, 'worker-tmp');
  for (const dir of [sharedDir, webTmp, workerTmp]) fs.mkdirSync(dir, { recursive: true });
  vi.stubEnv('STORAGE_DRIVER', 'local');
  vi.stubEnv('EASYCONVERT_STORAGE_DIR', sharedDir);
  vi.stubEnv('TRUSTED_PROXIES', '10.0.0.0/8');
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.resetModules();
  fs.rmSync(baseDir, { recursive: true, force: true });
});

/** Loads `load` as a process whose temporary directory is `tmpDir` would: a module graph of its own. */
async function asProcess<T>(tmpDir: string, load: () => Promise<T>): Promise<T> {
  vi.stubEnv('TMPDIR', tmpDir);
  vi.resetModules();
  return load();
}

function bytesUnder(dir: string): number {
  if (!fs.existsSync(dir)) return 0;
  return fs.readdirSync(dir, { recursive: true, withFileTypes: true }).reduce((sum, entry) => {
    return entry.isFile() ? sum + fs.statSync(path.join(entry.parentPath, entry.name)).size : sum;
  }, 0);
}

function temporaryFilesIn(dir: string): string[] {
  return fs.readdirSync(dir).filter((name) => /\.(tmp|comb)\./.test(name));
}

function patterned(length: number, seed = 0): Buffer {
  const bytes = Buffer.alloc(length);
  for (let offset = 0; offset < length; offset += 4) bytes.writeUInt32LE(((offset >>> 2) ^ seed) >>> 0, offset);
  return bytes;
}

function sha256(bytes: Buffer): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

/** The multipart route of the web process that is loaded now. */
async function multipartRoute() {
  const { POST } = await import('../src/app/api/storage/multipart/route');
  const json = (action: string, body: unknown) =>
    POST(
      new NextRequest(`${BASE_URL}/api/storage/multipart?action=${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...VISITOR },
        body: JSON.stringify(body),
      })
    );
  const part = (uploadId: string, partNumber: number, bytes: Buffer) =>
    POST(
      new NextRequest(`${BASE_URL}/api/storage/multipart?action=chunk&uploadId=${encodeURIComponent(uploadId)}&partNumber=${partNumber}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream', ...VISITOR },
        body: new Uint8Array(bytes),
      })
    );
  return { json, part };
}

async function openUpload(totalSize: number): Promise<string> {
  const opened = await (await multipartRoute()).json('initiate', { filename: 'big.bin', mimeType: 'application/octet-stream', totalSize, partSize: PART_BYTES });
  expect(opened.status).toBe(HTTP_OK);
  return (await opened.json()).uploadId;
}

/** Sends the parts `partNumbers` of `bytes`, and returns their receipts. */
async function sendParts(uploadId: string, bytes: Buffer, partNumbers: number[]): Promise<Array<{ partNumber: number; etag: string }>> {
  const { part } = await multipartRoute();
  const receipts = [];
  for (const partNumber of partNumbers) {
    const start = (partNumber - 1) * PART_BYTES;
    const stored = await part(uploadId, partNumber, bytes.subarray(start, start + PART_BYTES));
    expect(stored.status, `part ${partNumber} is stored`).toBe(HTTP_OK);
    receipts.push({ partNumber, etag: (await stored.json()).etag });
  }
  return receipts;
}

async function completeUpload(uploadId: string, parts: Array<{ partNumber: number; etag: string }>): Promise<Response> {
  return (await multipartRoute()).json('complete', { uploadId, parts });
}

const ALL_PARTS = [1, 2, 3];

/** Uploads `bytes` through /api/storage/multipart in parts, as the browser does, and returns the stored key. */
async function uploadInParts(bytes: Buffer): Promise<string> {
  const uploadId = await openUpload(bytes.length);
  const receipts = await sendParts(uploadId, bytes, ALL_PARTS);
  expect(bytesUnder(webTmp), 'the parts are not kept in the temporary directory of the web process').toBeLessThan(MIB);
  const done = await completeUpload(uploadId, receipts);
  expect(done.status).toBe(HTTP_OK);
  const completed = await done.json();
  expect(completed.size).toBe(bytes.length);
  return completed.key;
}

/** Runs one job over the stored upload `key` through the worker's own processNodeJob, in this module graph; returns the hash of the input it read. */
async function convertAsWorker(key: string): Promise<{ inputPath?: string; inputSha256: string }> {
  const { processNodeJob } = await import('../src/lib/queue/node-processor');
  const { Queue } = await import('../src/lib/queue/bullmq-engine');
  const { storageProvider } = await import('../src/lib/storage');
  let seen: { inputPath?: string; inputSha256: string } | undefined;
  const engine = {
    name: 'reading-engine',
    async convert(input: Buffer | { inputPath?: string }) {
      const inputPath = Buffer.isBuffer(input) ? undefined : input.inputPath;
      seen = { inputPath, inputSha256: sha256(inputPath ? fs.readFileSync(inputPath) : (input as Buffer)) };
      return { buffer: Buffer.from('ok'), size: 2, mimeType: 'text/plain', filename: 'out.txt' };
    },
  };
  const job = await new Queue<never, never>('worker-graph').add('convert', {
    jobId: 'read-upload', originalFilename: 'big.bin', sourceFormat: 'bin', targetFormat: 'txt', fileSize: 1, options: {}, storageKey: key,
  } as never);
  await processNodeJob(job as never, engine as never, storageProvider);
  return seen!;
}

/** Runs the worker as a child process of its own, with its own environment and temporary directory; resolves with what it printed. */
function runWorkerProcess(key: string, jobId: string): Promise<{ inputPath?: string; inputSha256: string; resultKey: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [TSX_CLI, WORKER_CHILD, key, jobId, String(RESULT_BYTES), String(RESULT_SEED)], {
      cwd: ROOT,
      env: {
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME ?? workerTmp,
        TMPDIR: workerTmp,
        STORAGE_DRIVER: 'local',
        EASYCONVERT_STORAGE_DIR: sharedDir,
        STORAGE_SIGNING_SECRET: 'test-secure-storage-signing-secret',
        QPDF_RUNNER: 'off',
      } as unknown as NodeJS.ProcessEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    const timer = setTimeout(() => child.kill('SIGKILL'), CHILD_TIMEOUT_MS);
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`the worker process exited with ${code}: ${stderr}`));
      else resolve(JSON.parse(stdout.trim().split('\n').pop()!));
    });
  });
}

/** The web process: it submitted the job `jobId`, so it can tell whose result a key is, and it serves the download. */
async function startWebProcess(jobId: string, storageKey?: string) {
  const { conversionQueue } = await import('../src/lib/queue/conversion-queue');
  const { GET } = await import('../src/app/api/storage/file/[...key]/route');
  const job = await conversionQueue.add(
    'convert',
    { jobId, originalFilename: 'in.csv', sourceFormat: 'csv', targetFormat: 'json', fileSize: 1, options: {}, ...(storageKey ? { storageKey } : { inputBufferBase64: 'YQ==' }) },
    { attempts: 1, delay: 60 * 60 * 1000, jobId }
  );
  const download = (key: string) => {
    vi.stubEnv('TMPDIR', webTmp);
    return GET(new NextRequest(`${BASE_URL}/api/storage/file/${key}`, { headers: VISITOR }), {
      params: Promise.resolve({ key: key.split('/') }),
    });
  };
  return { resultKey: `results/${job.id}/result.bin`, download };
}

describe('a file uploaded in parts to the web process is read by a worker that shares only the storage directory', () => {
  it('lets a worker process of its own read every byte of the upload from the storage directory and store a result over 64 MiB that the web process serves', async () => {
    const bytes = patterned(UPLOAD_BYTES);
    const key = await asProcess(webTmp, () => uploadInParts(bytes));
    const web = await asProcess(webTmp, () => startWebProcess('child-worker-job', key));

    const worker = await runWorkerProcess(key, 'child-worker-job');

    expect(worker.inputSha256, 'the worker read every byte of the upload').toBe(sha256(bytes));
    expect(path.relative(sharedDir, worker.inputPath ?? '').startsWith('..'), 'the worker read the upload where it is stored, not a copy').toBe(false);
    expect(worker.resultKey).toBe(web.resultKey);
    const response = await web.download(web.resultKey);
    expect(response.status).toBe(HTTP_OK);
    expect(sha256(Buffer.from(await response.arrayBuffer()))).toBe(sha256(patterned(RESULT_BYTES, RESULT_SEED)));
    const engineOutputs = fs.readdirSync(workerTmp).filter((name) => name.startsWith('engine-out-'));
    expect(engineOutputs.reduce((sum, name) => sum + bytesUnder(path.join(workerTmp, name)), 0), 'the worker left no copy of the result in its temporary directory').toBe(0);
  });

  it('frees the disk of the upload when the worker deletes it, as its retention sweep does', async () => {
    const key = await asProcess(webTmp, () => uploadInParts(patterned(UPLOAD_BYTES)));

    const deleted = await asProcess(workerTmp, async () => {
      const { storageProvider } = await import('../src/lib/storage');
      return storageProvider.deleteObject(key);
    });

    expect(deleted).toBe(true);
    expect(bytesUnder(sharedDir) + bytesUnder(webTmp), 'no copy of the upload is left on any disk').toBeLessThan(MIB);
  });
});

describe('an upload in parts across a restart of the web process', () => {
  it('takes the parts sent after the restart and completes the upload, which the worker reads whole', async () => {
    const bytes = patterned(UPLOAD_BYTES, 7);
    const { uploadId, first } = await asProcess(webTmp, async () => {
      const opened = await openUpload(bytes.length);
      return { uploadId: opened, first: await sendParts(opened, bytes, [1]) };
    });

    const key = await asProcess(webTmp, async () => {
      const rest = await sendParts(uploadId, bytes, [2, 3]);
      const done = await completeUpload(uploadId, [...first, ...rest]);
      expect(done.status, 'the restarted web process completes the upload').toBe(HTTP_OK);
      return (await done.json()).key as string;
    });

    const read = await asProcess(workerTmp, () => convertAsWorker(key));
    expect(read.inputSha256).toBe(sha256(bytes));
  });

  it('refuses a completion whose part cannot be read, and stores nothing and leaves no partial file', async () => {
    const bytes = patterned(UPLOAD_BYTES, 9);
    const { uploadId, receipts } = await asProcess(webTmp, async () => {
      const opened = await openUpload(bytes.length);
      return { uploadId: opened, receipts: await sendParts(opened, bytes, ALL_PARTS) };
    });
    const partTwo = fs
      .readdirSync(sharedDir, { recursive: true, withFileTypes: true })
      .find((entry) => entry.isFile() && entry.name === 'part-2.bin' && entry.parentPath.endsWith(uploadId));
    expect(partTwo, 'the parts are stored in the storage directory').toBeDefined();
    fs.rmSync(path.join(partTwo!.parentPath, partTwo!.name));

    const done = await asProcess(webTmp, () => completeUpload(uploadId, receipts));

    expect(done.status).not.toBe(HTTP_OK);
    expect(temporaryFilesIn(sharedDir), 'no partial assembly is left').toEqual([]);
    expect(fs.readdirSync(sharedDir).filter((name) => name.endsWith('.bin') || name.endsWith('.meta.json')), 'no object was stored').toEqual([]);
  });
});

describe('a result the worker saves reaches the web process that shares only the storage directory', () => {
  async function saveFromFile(key: string, bytes: Buffer): Promise<void> {
    const outputPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'engine-out-')), 'result.bin');
    fs.writeFileSync(outputPath, bytes);
    const { storageProvider } = await import('../src/lib/storage');
    await storageProvider.saveObjectFromFile!(key, outputPath, 'application/octet-stream', 'result.bin', 60_000);
  }

  it('serves the second save of one key whole, with the size of that save, after a retry saved it again', async () => {
    const web = await asProcess(webTmp, () => startWebProcess('resaved-job'));
    const first = patterned(3 * MIB, 1);
    const second = patterned(2 * MIB + 8, 2);

    await asProcess(workerTmp, () => saveFromFile(web.resultKey, first));
    await asProcess(workerTmp, () => saveFromFile(web.resultKey, second));

    const response = await web.download(web.resultKey);
    expect(response.status).toBe(HTTP_OK);
    expect(response.headers.get('content-length')).toBe(String(second.length));
    expect(sha256(Buffer.from(await response.arrayBuffer()))).toBe(sha256(second));
  });

  it('stores nothing and leaves no temporary file when the stream of a save fails half-way', async () => {
    const key = 'intermediate/graph-1/node-1/fetched.bin';
    const failing = new Readable({
      read() {
        this.push(Buffer.alloc(MIB, 1));
        this.destroy(new Error('connection reset'));
      },
    });

    await asProcess(workerTmp, async () => {
      const { storageProvider } = await import('../src/lib/storage');
      await expect(storageProvider.saveObjectFromStream(key, failing, { filename: 'fetched.bin', mimeType: 'application/octet-stream' })).rejects.toThrow(
        'connection reset'
      );
    });

    const reader = await asProcess(webTmp, async () => (await import('../src/lib/storage')).storageProvider);
    expect(await reader.getObject(key)).toBeUndefined();
    expect(temporaryFilesIn(sharedDir)).toEqual([]);
  });
});
