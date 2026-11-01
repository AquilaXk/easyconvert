import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The web process and the workers share EASYCONVERT_STORAGE_DIR, and what a process leaves there when it stops (a copy,
 * an assembly, the parts of an open session) is known to no process that starts afterwards: the sweep reclaims it by age.
 */

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const KEY = 'results/job-1/result.bin';

let storageDir: string;

beforeEach(() => {
  storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ec-sweep-'));
  vi.stubEnv('STORAGE_DRIVER', 'local');
  vi.stubEnv('EASYCONVERT_STORAGE_DIR', storageDir);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  fs.rmSync(storageDir, { recursive: true, force: true });
});

/** A module graph of its own, as a process that starts afterwards has. */
async function startProcess() {
  vi.resetModules();
  return import('../src/lib/storage');
}

function writeAged(filePath: string, ageMs: number): string {
  fs.writeFileSync(filePath, 'x');
  const at = new Date(Date.now() - ageMs);
  fs.utimesSync(filePath, at, at);
  return filePath;
}

function age(target: string, ageMs: number): void {
  const at = new Date(Date.now() - ageMs);
  fs.utimesSync(target, at, at);
}

describe('the temporary files beside the objects', () => {
  it('removes a stale assembly, copy and stream save and keeps a fresh one, an object and its record', async () => {
    const { globalSharedObjects } = await startProcess();
    const final = globalSharedObjects.objectPath(KEY);
    const staleComb = writeAged(`${final}.comb.1700000000000.abcdef012345`, 11 * MINUTE_MS);
    const staleTmp = writeAged(`${final}.tmp.1700000000000.abcdef012345`, 11 * MINUTE_MS);
    const staleStream = writeAged(`${final}.tmp.6f1c3a52-aaaa-4bbb-8ccc-0123456789ab`, 11 * MINUTE_MS);
    const freshComb = writeAged(`${final}.comb.1700000000001.abcdef012345`, MINUTE_MS);
    const freshTmp = writeAged(`${final}.tmp.1700000000001.abcdef012345`, MINUTE_MS);
    const oldObject = writeAged(final, 48 * HOUR_MS);
    const oldRecord = writeAged(final.replace(/\.bin$/, '.meta.json'), 48 * HOUR_MS);

    globalSharedObjects.sweepStaleTempFiles();

    expect([staleComb, staleTmp, staleStream].filter((file) => fs.existsSync(file))).toEqual([]);
    expect([freshComb, freshTmp, oldObject, oldRecord].filter((file) => !fs.existsSync(file))).toEqual([]);
  });

  it('is part of the periodic sweep of the local driver', async () => {
    const { s3Storage, globalSharedObjects } = await startProcess();
    const stale = writeAged(`${globalSharedObjects.objectPath(KEY)}.comb.1700000000000.abcdef012345`, HOUR_MS);

    s3Storage.sweepExpiredObjects();

    expect(fs.existsSync(stale)).toBe(false);
  });
});

describe('the parts of sessions in the storage directory', () => {
  async function openSessionWithPart(s3Storage: Awaited<ReturnType<typeof startProcess>>['s3Storage']): Promise<string> {
    const { uploadId } = s3Storage.initiateMultipartUpload('big.bin', 'application/octet-stream', 10, undefined, 10);
    s3Storage.uploadPart(uploadId, 1, Buffer.alloc(10, 1));
    return path.join(storageDir, '.multipart', uploadId);
  }

  function ageTree(dir: string, ageMs: number): void {
    for (const name of fs.readdirSync(dir)) age(path.join(dir, name), ageMs);
    age(dir, ageMs);
  }

  it('removes the directory of a session no process owns once nothing in it was written for a day, and keeps a younger one', async () => {
    const opener = await startProcess();
    const abandoned = await openSessionWithPart(opener.s3Storage);
    const recent = await openSessionWithPart(opener.s3Storage);
    ageTree(abandoned, 25 * HOUR_MS);
    ageTree(recent, 23 * HOUR_MS);

    const restarted = await startProcess();
    const removed = restarted.s3Storage.sweepExpiredObjects();

    expect(removed).toBe(1);
    expect(fs.existsSync(abandoned)).toBe(false);
    expect(fs.existsSync(recent)).toBe(true);
  });

  it('keeps a directory whose own time is old but which holds a file written within the day', async () => {
    const opener = await startProcess();
    const session = await openSessionWithPart(opener.s3Storage);
    age(session, 25 * HOUR_MS);

    const restarted = await startProcess();
    restarted.s3Storage.sweepExpiredObjects();

    expect(fs.existsSync(session)).toBe(true);
  });

  it('keeps the directory of a session this process owns', async () => {
    const { s3Storage } = await startProcess();
    const session = await openSessionWithPart(s3Storage);
    ageTree(session, 25 * HOUR_MS);

    s3Storage.sweepExpiredObjects();

    expect(fs.existsSync(session)).toBe(true);
  });

  it('touches the directory of a session whenever it writes a part, which is what keeps the directory from looking abandoned', async () => {
    const { s3Storage } = await startProcess();
    const session = await openSessionWithPart(s3Storage);
    ageTree(session, 25 * HOUR_MS);
    const agedMtime = fs.statSync(session).mtimeMs;

    s3Storage.uploadPart(path.basename(session), 2, Buffer.alloc(10, 2));

    expect(fs.statSync(session).mtimeMs).toBeGreaterThan(agedMtime + 24 * HOUR_MS);
  });

  it('removes only the directories this driver names', async () => {
    const { s3Storage } = await startProcess();
    const foreign = path.join(storageDir, '.multipart', 'notes');
    fs.mkdirSync(foreign, { recursive: true });
    age(foreign, 48 * HOUR_MS);

    s3Storage.sweepExpiredObjects();

    expect(fs.existsSync(foreign)).toBe(true);
  });
});
