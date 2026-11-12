import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LocalFsStorage, MULTIPART_SESSION_TTL_MS } from '../src/lib/storage/local-fs-storage';
import { S3ObjectStorageService } from '../src/lib/storage/s3-storage';

/**
 * The erasure of an account finds the open multipart sessions of the local store by their owner and removes them with their
 * parts: the sessions are directories of the storage directory (`.parts/<id>/session.json`), so an owner is read from each.
 */

let baseDir: string;
let local: LocalFsStorage;
let storage: S3ObjectStorageService;

const MIB = 1024 * 1024;

function sessionDir(uploadId: string): string {
  return path.join(baseDir, '.parts', uploadId);
}

async function openSession(ownerUserId: string | undefined, withPart = true): Promise<string> {
  const init = await storage.initiateMultipartUpload('in.csv', 'text/csv', 2 * MIB, ownerUserId);
  if (withPart) await storage.uploadPart(init.uploadId, 1, Buffer.alloc(1024, 7));
  return init.uploadId;
}

beforeEach(() => {
  baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ec-multipart-owner-'));
  local = new LocalFsStorage({ storageDir: baseDir, signingSecret: 'multipart-owner-erasure-secret-0001' });
  storage = new S3ObjectStorageService({ signingSecret: 'multipart-owner-erasure-secret-0001', multipart: local });
});

afterEach(() => {
  vi.restoreAllMocks();
  local.stopGc();
  storage.stopGc();
  fs.rmSync(baseDir, { recursive: true, force: true });
});

describe('the open multipart sessions of an owner in the local store', () => {
  it('lists the sessions of the owner, and no other owner\'s or anonymous one', async () => {
    const mine = await openSession('user-a');
    const mineToo = await openSession('user-a', false);
    await openSession('user-b');
    await openSession('anon:203.0.113.0');
    await openSession(undefined);

    expect(await storage.uploadSessionsOfOwner('user-a')).toEqual([mine, mineToo].sort());
    expect(await storage.uploadSessionsOfOwner('nobody')).toEqual([]);
  });

  it('aborts the sessions of the owner with their parts, and keeps another owner\'s session and its parts', async () => {
    const mine = await openSession('user-a');
    const theirs = await openSession('user-b');
    expect(fs.readdirSync(sessionDir(mine)).some((name) => name.startsWith('part-'))).toBe(true);

    expect(await storage.abortUploadSessionsOfOwner('user-a')).toEqual([mine]);

    expect(fs.existsSync(sessionDir(mine))).toBe(false);
    expect(await storage.getUploadSession(mine)).toBeUndefined();
    expect(fs.existsSync(sessionDir(theirs))).toBe(true);
    expect((await storage.getUploadedParts(theirs))?.map((part) => part.partNumber)).toEqual([1]);
  });

  it('removes a session whose time is over but which the sweep has not removed yet, since its parts are still on disk', async () => {
    const stale = await openSession('user-a');
    const file = path.join(sessionDir(stale), 'session.json');
    const record = JSON.parse(fs.readFileSync(file, 'utf-8'));
    fs.writeFileSync(file, JSON.stringify({ ...record, expiresAt: Date.now() - 1 }));
    expect(await storage.getUploadSession(stale)).toBeUndefined();

    expect(await storage.abortUploadSessionsOfOwner('user-a')).toEqual([stale]);

    expect(fs.existsSync(sessionDir(stale))).toBe(false);
    expect(MULTIPART_SESSION_TTL_MS).toBeGreaterThan(0);
  });

  it('skips a directory with no readable record, which names no owner, and a name that is no session id', async () => {
    const mine = await openSession('user-a');
    const broken = path.join(baseDir, '.parts', `up_${Date.now()}_${'a'.repeat(24)}`);
    fs.mkdirSync(broken);
    fs.writeFileSync(path.join(broken, 'session.json'), '{not json');
    const empty = path.join(baseDir, '.parts', `up_${Date.now()}_${'b'.repeat(24)}`);
    fs.mkdirSync(empty);
    fs.mkdirSync(path.join(baseDir, '.parts', 'not-a-session'));

    expect(await storage.abortUploadSessionsOfOwner('user-a')).toEqual([mine]);
    expect(fs.existsSync(broken)).toBe(true);
    expect(fs.existsSync(empty)).toBe(true);
  });

  it('fails when a session cannot be removed, and when a record cannot be read, instead of reporting it gone', async () => {
    const mine = await openSession('user-a');
    const realRm = fs.promises.rm.bind(fs.promises);
    vi.spyOn(fs.promises, 'rm').mockImplementation((async (target: fs.PathLike, options?: fs.RmOptions) => {
      if (String(target).includes(mine)) throw Object.assign(new Error('disk refused'), { code: 'EIO' });
      return realRm(target, options);
    }) as never);
    await expect(storage.abortUploadSessionsOfOwner('user-a')).rejects.toThrow('disk refused');
    expect(fs.existsSync(sessionDir(mine))).toBe(true);
    vi.restoreAllMocks();

    const realRead = fs.promises.readFile.bind(fs.promises);
    vi.spyOn(fs.promises, 'readFile').mockImplementation((async (target: fs.PathLike | fs.promises.FileHandle, ...rest: unknown[]) => {
      if (String(target).endsWith('session.json')) throw Object.assign(new Error('read refused'), { code: 'EIO' });
      return (realRead as (...args: unknown[]) => Promise<unknown>)(target, ...rest);
    }) as never);
    await expect(storage.uploadSessionsOfOwner('user-a')).rejects.toThrow('read refused');
    vi.restoreAllMocks();

    expect(await storage.abortUploadSessionsOfOwner('user-a')).toEqual([mine]);
  });

  it('answers nothing when the storage directory has no parts directory', async () => {
    fs.rmSync(path.join(baseDir, '.parts'), { recursive: true, force: true });
    expect(await storage.uploadSessionsOfOwner('user-a')).toEqual([]);
    expect(await storage.abortUploadSessionsOfOwner('user-a')).toEqual([]);
  });
});
