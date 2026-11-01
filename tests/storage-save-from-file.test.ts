import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A result the worker stores from a file ends up in the storage directory, which is all the web process shares with it.
 * The rename that moves it there fails with EXDEV when the worker's output directory is on another volume.
 */

const KEY = 'results/job-1/result.bin';
const CONTENT = crypto.randomBytes(256 * 1024);

let baseDir: string;
let storageDir: string;
let sourcePath: string;

function exdev(): NodeJS.ErrnoException {
  return Object.assign(new Error('EXDEV: cross-device link not permitted, rename'), { code: 'EXDEV' });
}

async function loadStorage() {
  vi.resetModules();
  return import('../src/lib/storage');
}

/** Makes every rename of the output file fail the way a rename across volumes does; other renames work. */
function renameFailsAcrossVolumes() {
  const rename = fs.promises.rename;
  return vi.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => {
    if (from === sourcePath) throw exdev();
    return rename(from, to);
  });
}

function leftTemporaryFiles(): string[] {
  return fs.readdirSync(storageDir).filter((name) => name.includes('.tmp.'));
}

beforeEach(() => {
  baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ec-save-file-'));
  storageDir = path.join(baseDir, 'shared-storage');
  sourcePath = path.join(baseDir, 'worker-tmp', 'result.bin');
  fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
  fs.writeFileSync(sourcePath, CONTENT);
  vi.stubEnv('STORAGE_DRIVER', 'local');
  vi.stubEnv('EASYCONVERT_STORAGE_DIR', storageDir);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.resetModules();
  fs.rmSync(baseDir, { recursive: true, force: true });
});

describe('S3ObjectStorageService.saveObjectFromFile on the local driver', () => {
  it('moves the file to the path every process reads and leaves nothing at the old one', async () => {
    const { storageProvider, globalSharedObjects } = await loadStorage();

    const stored = await storageProvider.saveObjectFromFile!(KEY, sourcePath, 'application/octet-stream', 'result.bin');

    expect(stored.filePath).toBe(globalSharedObjects.objectPath(KEY));
    expect(fs.readFileSync(stored.filePath!).equals(CONTENT)).toBe(true);
    expect(fs.existsSync(sourcePath)).toBe(false);
    expect(stored.size).toBe(CONTENT.length);
  });

  it('copies the file beside its final name and renames it into place when the volumes differ, then removes the source', async () => {
    const rename = renameFailsAcrossVolumes();
    const { storageProvider, globalSharedObjects } = await loadStorage();

    const stored = await storageProvider.saveObjectFromFile!(KEY, sourcePath, 'application/octet-stream', 'result.bin');

    const finalPath = globalSharedObjects.objectPath(KEY);
    expect(stored.filePath).toBe(finalPath);
    expect(fs.readFileSync(finalPath).equals(CONTENT)).toBe(true);
    expect(fs.existsSync(sourcePath)).toBe(false);
    const renamedIntoPlace = rename.mock.calls.filter(([from, to]) => to === finalPath && from !== sourcePath);
    expect(renamedIntoPlace.map(([from]) => path.dirname(String(from)))).toEqual([path.dirname(finalPath)]);
    expect(leftTemporaryFiles(), 'no temporary copy is left').toEqual([]);
  });

  it('copies off the event loop, so a timer fires while the copy is under way and the copy is not a synchronous one', async () => {
    renameFailsAcrossVolumes();
    const copy = fs.promises.copyFile;
    let releaseCopy!: () => void;
    const copyMayEnd = new Promise<void>((resolve) => {
      releaseCopy = resolve;
    });
    let copyStarted = false;
    vi.spyOn(fs.promises, 'copyFile').mockImplementation(async (from, to, mode) => {
      copyStarted = true;
      await copy(from, to, mode);
      await copyMayEnd;
    });
    const syncCopy = vi.spyOn(fs, 'copyFileSync');
    const { storageProvider } = await loadStorage();

    const saving = Promise.resolve(storageProvider.saveObjectFromFile!(KEY, sourcePath, 'application/octet-stream', 'result.bin'));
    let settled = false;
    void saving.then(() => {
      settled = true;
    });
    let timerFired = false;
    await new Promise<void>((resolve) =>
      setTimeout(() => {
        timerFired = true;
        resolve();
      }, 20)
    );

    expect(copyStarted, 'the copy has begun').toBe(true);
    expect(timerFired, 'the loop ran during the copy').toBe(true);
    expect(settled, 'the save waits for the copy').toBe(false);
    releaseCopy();
    const stored = await saving;
    expect(fs.readFileSync(stored.filePath!).equals(CONTENT)).toBe(true);
    expect(syncCopy).not.toHaveBeenCalled();
  });

  it('flushes the temporary copy to disk before it renames it into place', async () => {
    const rename = renameFailsAcrossVolumes();
    const events: string[] = [];
    const open = fs.promises.open;
    vi.spyOn(fs.promises, 'open').mockImplementation(async (...args) => {
      const handle = await open(...(args as Parameters<typeof open>));
      const sync = handle.sync.bind(handle);
      handle.sync = async () => {
        events.push('fsync');
        return sync();
      };
      return handle;
    });
    const { storageProvider, globalSharedObjects } = await loadStorage();
    const finalPath = globalSharedObjects.objectPath(KEY);
    const passThrough = rename.getMockImplementation()!;
    rename.mockImplementation(async (from, to) => {
      if (to === finalPath && from !== sourcePath) events.push('rename into place');
      return passThrough(from, to);
    });

    await storageProvider.saveObjectFromFile!(KEY, sourcePath, 'application/octet-stream', 'result.bin');

    expect(events).toEqual(['fsync', 'rename into place']);
  });

  it('removes the temporary copy and keeps the source when the copy fails', async () => {
    renameFailsAcrossVolumes();
    const { storageProvider, globalSharedObjects } = await loadStorage();
    const copy = fs.promises.copyFile;
    vi.spyOn(fs.promises, 'copyFile').mockImplementation(async (from, to, mode) => {
      await copy(from, to, mode);
      throw Object.assign(new Error('ENOSPC: no space left on device, copyfile'), { code: 'ENOSPC' });
    });

    await expect(storageProvider.saveObjectFromFile!(KEY, sourcePath, 'application/octet-stream', 'result.bin')).rejects.toThrow(/ENOSPC/);

    expect(fs.readFileSync(sourcePath).equals(CONTENT)).toBe(true);
    expect(fs.existsSync(globalSharedObjects.objectPath(KEY))).toBe(false);
    expect(leftTemporaryFiles()).toEqual([]);
  });

  it('refuses a copy whose size differs from the source, removes it and keeps the source', async () => {
    renameFailsAcrossVolumes();
    const { storageProvider, globalSharedObjects } = await loadStorage();
    const copy = fs.promises.copyFile;
    vi.spyOn(fs.promises, 'copyFile').mockImplementation(async (from, to, mode) => {
      await copy(from, to, mode);
      fs.truncateSync(String(to), CONTENT.length - 1);
    });

    await expect(storageProvider.saveObjectFromFile!(KEY, sourcePath, 'application/octet-stream', 'result.bin')).rejects.toThrow(
      new RegExp(`holds ${CONTENT.length - 1} bytes, expected ${CONTENT.length}`)
    );

    expect(fs.readFileSync(sourcePath).equals(CONTENT)).toBe(true);
    expect(fs.existsSync(globalSharedObjects.objectPath(KEY))).toBe(false);
    expect(leftTemporaryFiles()).toEqual([]);
  });

  it('stores the object when the source cannot be removed afterwards, and says so', async () => {
    renameFailsAcrossVolumes();
    const rm = fs.promises.rm;
    vi.spyOn(fs.promises, 'rm').mockImplementation(async (target, options) => {
      if (target === sourcePath) throw Object.assign(new Error('EPERM: operation not permitted, unlink'), { code: 'EPERM' });
      return rm(target, options);
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { storageProvider, globalSharedObjects } = await loadStorage();

    const stored = await storageProvider.saveObjectFromFile!(KEY, sourcePath, 'application/octet-stream', 'result.bin');

    expect(fs.readFileSync(globalSharedObjects.objectPath(KEY)).equals(CONTENT)).toBe(true);
    expect(stored.size).toBe(CONTENT.length);
    expect(globalSharedObjects.get(KEY)?.size, 'the record exists for every process').toBe(CONTENT.length);
    expect(warn.mock.calls.map(([message]) => String(message))).toEqual([expect.stringContaining(sourcePath)]);
  });

  it('refuses without copying when the rename fails for another reason than the volumes', async () => {
    const denied = Object.assign(new Error('EACCES: permission denied, rename'), { code: 'EACCES' });
    vi.spyOn(fs.promises, 'rename').mockRejectedValue(denied);
    const copy = vi.spyOn(fs.promises, 'copyFile');
    const { storageProvider } = await loadStorage();

    await expect(storageProvider.saveObjectFromFile!(KEY, sourcePath, 'application/octet-stream', 'result.bin')).rejects.toBe(denied);

    expect(copy).not.toHaveBeenCalled();
    expect(fs.existsSync(sourcePath)).toBe(true);
  });

  it('keeps a file that is already at the path of its key', async () => {
    const { storageProvider, globalSharedObjects } = await loadStorage();
    const inPlace = globalSharedObjects.objectPath(KEY);
    fs.mkdirSync(storageDir, { recursive: true });
    fs.writeFileSync(inPlace, CONTENT);

    const stored = await storageProvider.saveObjectFromFile!(KEY, inPlace, 'application/octet-stream', 'result.bin');

    expect(stored.filePath).toBe(inPlace);
    expect(fs.readFileSync(inPlace).equals(CONTENT)).toBe(true);
  });
});
