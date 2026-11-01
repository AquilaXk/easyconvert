import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

/**
 * Production runs the web process and the worker in two containers that share only EASYCONVERT_STORAGE_DIR; each has a
 * temporary directory of its own. Here each side is a fresh module graph with its own TMPDIR over one storage directory,
 * so a file the web process keeps only in its temporary directory is out of the worker's reach, as in production.
 */

const BASE_URL = 'http://localhost:3000';
const MIB = 1024 * 1024;
const PART_BYTES = 32 * MIB;
/** Over the 64 MiB a single request carries, so the file can only arrive in parts. */
const UPLOAD_BYTES = 2 * PART_BYTES + MIB;
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

function uploadBytes(): Buffer {
  const bytes = Buffer.alloc(UPLOAD_BYTES);
  for (let offset = 0; offset < bytes.length; offset += 4) bytes.writeUInt32LE(offset >>> 2, offset);
  return bytes;
}

function sha256(bytes: Buffer): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

/** Uploads `bytes` through /api/storage/multipart in parts, as the browser does, and returns the stored key. */
async function uploadInParts(bytes: Buffer): Promise<string> {
  const { POST } = await import('../src/app/api/storage/multipart/route');
  const visitor = { 'x-forwarded-for': '198.51.100.7' };
  const json = (action: string, body: unknown) =>
    POST(
      new NextRequest(`${BASE_URL}/api/storage/multipart?action=${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...visitor },
        body: JSON.stringify(body),
      })
    );

  const opened = await json('initiate', { filename: 'big.bin', mimeType: 'application/octet-stream', totalSize: bytes.length, partSize: PART_BYTES });
  expect(opened.status).toBe(HTTP_OK);
  const { uploadId } = await opened.json();

  const receipts = [];
  for (let start = 0, partNumber = 1; start < bytes.length; start += PART_BYTES, partNumber++) {
    const stored = await POST(
      new NextRequest(`${BASE_URL}/api/storage/multipart?action=chunk&uploadId=${encodeURIComponent(uploadId)}&partNumber=${partNumber}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream', ...visitor },
        body: new Uint8Array(bytes.subarray(start, start + PART_BYTES)),
      })
    );
    expect(stored.status).toBe(HTTP_OK);
    receipts.push({ partNumber, etag: (await stored.json()).etag });
  }
  expect(bytesUnder(webTmp), 'the parts are not kept in the temporary directory of the web process').toBeLessThan(MIB);

  const done = await json('complete', { uploadId, parts: receipts });
  expect(done.status).toBe(HTTP_OK);
  const completed = await done.json();
  expect(completed.size).toBe(bytes.length);
  return completed.key;
}

/** The bytes of `key` as the worker reads its input (node-processor.ts): the file on disk, else the buffer. */
async function readAsWorker(key: string): Promise<Buffer> {
  const { storageProvider } = await import('../src/lib/storage');
  const stored = await storageProvider.getObject(key);
  expect(stored, 'the worker finds the stored upload').toBeDefined();
  return stored!.filePath && fs.existsSync(stored!.filePath) ? fs.readFileSync(stored!.filePath) : stored!.buffer;
}

describe('a file uploaded in parts to the web process is read by a worker that shares only the storage directory', () => {
  it('lets the worker read every byte of the assembled upload after the web process and its temporary directory are gone', async () => {
    const bytes = uploadBytes();
    const key = await asProcess(webTmp, () => uploadInParts(bytes));
    fs.rmSync(webTmp, { recursive: true, force: true });

    const read = await asProcess(workerTmp, () => readAsWorker(key));

    expect(read.length).toBe(bytes.length);
    expect(sha256(read)).toBe(sha256(bytes));
  });

  it('frees the disk of the upload when the worker deletes it, as its retention sweep does', async () => {
    const key = await asProcess(webTmp, () => uploadInParts(uploadBytes()));

    const deleted = await asProcess(workerTmp, async () => {
      const { storageProvider } = await import('../src/lib/storage');
      return storageProvider.deleteObject(key);
    });

    expect(deleted).toBe(true);
    expect(bytesUnder(sharedDir) + bytesUnder(webTmp), 'no copy of the upload is left on any disk').toBeLessThan(MIB);
  });
});

const RESULT_BYTES = 64 * MIB + MIB;

/** What the worker does with an engine's output file (node-processor.ts): writes it in its own temporary directory and stores it from there. */
async function saveResultAsWorker(key: string, bytes: Buffer): Promise<string> {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-out-'));
  const outputPath = path.join(outputDir, 'result.bin');
  fs.writeFileSync(outputPath, bytes);
  const { storageProvider } = await import('../src/lib/storage');
  await storageProvider.saveObjectFromFile!(key, outputPath, 'application/octet-stream', 'result.bin', 60_000);
  return outputPath;
}

/** The web process: it submitted the job, so it can tell whose result a key is, and it serves the download. */
async function startWebProcess() {
  const { conversionQueue } = await import('../src/lib/queue/conversion-queue');
  const { GET } = await import('../src/app/api/storage/file/[...key]/route');
  const job = await conversionQueue.add(
    'convert',
    { jobId: 'web-submitted', originalFilename: 'in.csv', sourceFormat: 'csv', targetFormat: 'json', fileSize: 1, options: {}, inputBufferBase64: 'YQ==' },
    { attempts: 1, delay: 60 * 60 * 1000 }
  );
  const download = (key: string) => {
    vi.stubEnv('TMPDIR', webTmp);
    return GET(new NextRequest(`${BASE_URL}/api/storage/file/${key}`, { headers: { 'x-forwarded-for': '198.51.100.7' } }), {
      params: Promise.resolve({ key: key.split('/') }),
    });
  };
  return { resultKey: `results/${job.id}/result.bin`, download };
}

describe('a result the worker saves from a file reaches the web process that shares only the storage directory', () => {
  it('serves every byte of a result over 64 MiB after the worker and its temporary directory are gone', async () => {
    const bytes = Buffer.alloc(RESULT_BYTES);
    for (let offset = 0; offset < bytes.length; offset += 4) bytes.writeUInt32LE((offset >>> 2) ^ 0x5a5a5a5a, offset);
    const web = await asProcess(webTmp, startWebProcess);
    const key = web.resultKey;

    await asProcess(workerTmp, () => saveResultAsWorker(key, bytes));
    fs.rmSync(workerTmp, { recursive: true, force: true });

    const response = await web.download(key);

    expect(response.status).toBe(HTTP_OK);
    const served = Buffer.from(await response.arrayBuffer());
    expect(served.length).toBe(bytes.length);
    expect(sha256(served)).toBe(sha256(bytes));
  });
});

