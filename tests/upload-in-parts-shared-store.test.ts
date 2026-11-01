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
