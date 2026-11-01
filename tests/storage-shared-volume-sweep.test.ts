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
  vi.useRealTimers();
  vi.restoreAllMocks();
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
  it('removes a stale assembly, copy and record update and keeps a fresh one, an object and its record', async () => {
    const { globalSharedObjects } = await startProcess();
    const final = globalSharedObjects.objectPath(KEY);
    const record = final.replace(/\.bin$/, '.meta.json');
    const staleComb = writeAged(`${final}.comb.1700000000000.abcdef012345`, 61 * MINUTE_MS);
    const staleTmp = writeAged(`${final}.tmp.1700000000000.abcdef012345`, 61 * MINUTE_MS);
    const staleRecord = writeAged(`${record}.tmp.1700000000000.abcdef012345`, 61 * MINUTE_MS);
    const freshComb = writeAged(`${final}.comb.1700000000001.abcdef012345`, MINUTE_MS);
    const freshTmp = writeAged(`${final}.tmp.1700000000001.abcdef012345`, MINUTE_MS);
    const oldObject = writeAged(final, 48 * HOUR_MS);
    const oldRecord = writeAged(record, 48 * HOUR_MS);
    const lookalike = writeAged(path.join(storageDir, 'notes.tmp.txt'), 48 * HOUR_MS);

    globalSharedObjects.sweepStaleTempFiles();

    expect([staleComb, staleTmp, staleRecord].filter((file) => fs.existsSync(file))).toEqual([]);
    expect([freshComb, freshTmp, oldObject, oldRecord, lookalike].filter((file) => !fs.existsSync(file))).toEqual([]);
  });

  it('keeps a temporary file that was written 15 minutes ago, as a writer that has been quiet that long still owns it, and removes one 61 minutes old', async () => {
    const { globalSharedObjects } = await startProcess();
    const final = globalSharedObjects.objectPath(KEY);
    const quiet = writeAged(`${final}.tmp.1700000000000.abcdef012345`, 15 * MINUTE_MS);
    const abandoned = writeAged(`${final}.tmp.1700000000001.abcdef012345`, 61 * MINUTE_MS);

    globalSharedObjects.sweepStaleTempFiles();

    expect(fs.existsSync(quiet)).toBe(true);
    expect(fs.existsSync(abandoned)).toBe(false);
  });

  it('is part of the periodic sweep of the local driver', async () => {
    const { s3Storage, globalSharedObjects } = await startProcess();
    const stale = writeAged(`${globalSharedObjects.objectPath(KEY)}.comb.1700000000000.abcdef012345`, HOUR_MS + MINUTE_MS);

    s3Storage.sweepExpiredObjects();

    expect(fs.existsSync(stale)).toBe(false);
  });

  it('removes the bytes of an object that has had no record for an hour, as a save that stopped between its two renames leaves them, and keeps the bytes that have a record or are fresh', async () => {
    const { globalSharedObjects } = await startProcess();
    const orphan = writeAged(globalSharedObjects.objectPath('results/job-2/out.bin'), HOUR_MS + MINUTE_MS);
    const fresh = writeAged(globalSharedObjects.objectPath('results/job-3/out.bin'), MINUTE_MS);
    const stored = writeAged(globalSharedObjects.objectPath(KEY), 48 * HOUR_MS);
    writeAged(stored.replace(/\.bin$/, '.meta.json'), 48 * HOUR_MS);
    const foreign = writeAged(path.join(storageDir, 'notes.bin'), 48 * HOUR_MS);

    globalSharedObjects.sweepStaleTempFiles();

    expect(fs.existsSync(orphan), 'bytes without a record for an hour').toBe(false);
    expect([fresh, stored, foreign].filter((file) => !fs.existsSync(file))).toEqual([]);
  });

  it('says once, not on every sweep, that a temporary file could not be removed', async () => {
    const { globalSharedObjects } = await startProcess();
    const stuck = writeAged(`${globalSharedObjects.objectPath(KEY)}.tmp.1700000000000.abcdef012345`, 2 * HOUR_MS);
    const rmSync = fs.rmSync;
    vi.spyOn(fs, 'rmSync').mockImplementation((target, options) => {
      if (String(target) === stuck) throw Object.assign(new Error('EACCES: permission denied, unlink'), { code: 'EACCES' });
      return rmSync(target, options);
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    globalSharedObjects.sweepStaleTempFiles();
    globalSharedObjects.sweepStaleTempFiles();

    expect(warn.mock.calls.filter(([message]) => String(message).includes(stuck))).toHaveLength(1);
  });
});

describe('the sessions of uploads in parts in the storage directory', () => {
  type Storage = Awaited<ReturnType<typeof startProcess>>;

  /** Opens a session at `ageMs` ago and writes its first part now; returns its id and directory. */
  async function openSession(storage: Storage, ageMs: number): Promise<{ uploadId: string; dir: string }> {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() - ageMs);
    const { uploadId } = await storage.s3Storage.initiateMultipartUpload('big.bin', 'application/octet-stream', 20, undefined, 10);
    vi.useRealTimers();
    return { uploadId, dir: path.join(storageDir, '.parts', uploadId) };
  }

  it('removes a session an hour after its day is over by the time in its name, although a part was written into it just now', async () => {
    const storage = await startProcess();
    const abandoned = await openSession(storage, 25 * HOUR_MS + MINUTE_MS);
    fs.writeFileSync(path.join(abandoned.dir, 'part-1.bin'), Buffer.alloc(10, 1));
    const recent = await openSession(storage, 23 * HOUR_MS);

    const restarted = await startProcess();
    restarted.localFsStorage.sweepExpiredObjects();

    expect(fs.existsSync(abandoned.dir)).toBe(false);
    expect(fs.existsSync(recent.dir)).toBe(true);
  });

  it('refuses the parts of a session whose day is over, and keeps its directory for the hour a part already on the way may take', async () => {
    const storage = await startProcess();
    const expired = await openSession(storage, 24 * HOUR_MS + 30 * MINUTE_MS);

    expect(await storage.s3Storage.getUploadSession(expired.uploadId)).toBeUndefined();
    storage.localFsStorage.sweepExpiredObjects();
    expect(fs.existsSync(expired.dir)).toBe(true);
  });

  it('removes only the directories this driver names', async () => {
    const { localFsStorage } = await startProcess();
    const foreign = path.join(storageDir, '.parts', 'notes');
    fs.mkdirSync(foreign, { recursive: true });
    age(foreign, 48 * HOUR_MS);

    localFsStorage.sweepExpiredObjects();

    expect(fs.existsSync(foreign)).toBe(true);
  });

  it('says once, not on every sweep, that a session could not be removed', async () => {
    const storage = await startProcess();
    const stuck = await openSession(storage, 26 * HOUR_MS);
    const rmSync = fs.rmSync;
    vi.spyOn(fs, 'rmSync').mockImplementation((target, options) => {
      if (String(target) === stuck.dir) throw Object.assign(new Error('EACCES: permission denied, rmdir'), { code: 'EACCES' });
      return rmSync(target, options);
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    storage.localFsStorage.sweepExpiredObjects();
    storage.localFsStorage.sweepExpiredObjects();

    expect(warn.mock.calls.filter(([message]) => String(message).includes(stuck.dir))).toHaveLength(1);
  });
});

describe('the directories of jobs in the storage directory', () => {
  it('removes the directory of a job that started over two hours ago, the longest deadline and an hour, as a worker that stopped leaves it, and keeps one that started within that time', async () => {
    const { s3Storage } = await startProcess();
    const { withSandboxDir } = await import('../src/worker/worker-output');
    let abandonedDir = '';
    let recentDir = '';
    let finishJobs!: () => void;
    const jobsMayFinish = new Promise<void>((resolve) => (finishJobs = resolve));
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() - 2 * HOUR_MS - MINUTE_MS);
    const abandoned = withSandboxDir('easyconvert-ffmpeg-', async (dir) => {
      abandonedDir = dir;
      await jobsMayFinish;
    });
    vi.setSystemTime(Date.now() + 2 * MINUTE_MS);
    const recent = withSandboxDir('easyconvert-ffmpeg-', async (dir) => {
      recentDir = dir;
      await jobsMayFinish;
    });
    vi.useRealTimers();

    s3Storage.sweepExpiredObjects();

    expect(path.relative(storageDir, abandonedDir).startsWith('..'), 'the job directory is in the storage directory').toBe(false);
    expect(fs.existsSync(abandonedDir)).toBe(false);
    expect(fs.existsSync(recentDir)).toBe(true);
    finishJobs();
    await Promise.all([abandoned, recent]);
  });

  it('refuses a job directory prefix whose name the sweep could not read the time from', async () => {
    await startProcess();
    const { makeJobDirectory } = await import('../src/lib/storage/temp-file');

    for (const prefix of ['easyconvert-1700000000000-', '../easyconvert-', 'easyconvert', 'Easyconvert-', 'easy convert-']) {
      expect(() => makeJobDirectory(prefix), prefix).toThrow(/prefix/);
    }
    const entries = (dir: string): string[] => (fs.existsSync(dir) ? fs.readdirSync(dir) : []);
    expect(entries(path.join(storageDir, '.staging')), 'no job directory was made').toEqual([]);
    expect(entries(storageDir).filter((name) => !name.startsWith('.')), 'nothing was made beside the objects').toEqual([]);
    const made = makeJobDirectory('easyconvert-7z-');
    expect(path.basename(made).startsWith('easyconvert-7z-')).toBe(true);
  });
});
