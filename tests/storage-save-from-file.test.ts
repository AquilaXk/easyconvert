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
  const rename = fs.renameSync;
  return vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
    if (from === sourcePath) throw exdev();
    return rename(from, to);
  });
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
    expect(fs.readdirSync(storageDir).filter((name) => name.includes('.tmp.')), 'no temporary copy is left').toEqual([]);
  });

  it('removes the temporary copy and keeps the source when the copy fails', async () => {
    renameFailsAcrossVolumes();
    const { storageProvider, globalSharedObjects } = await loadStorage();
    const copy = fs.copyFileSync;
    vi.spyOn(fs, 'copyFileSync').mockImplementation((from, to, mode) => {
      copy(from, to, mode);
      throw Object.assign(new Error('ENOSPC: no space left on device, copyfile'), { code: 'ENOSPC' });
    });

    expect(() => storageProvider.saveObjectFromFile!(KEY, sourcePath, 'application/octet-stream', 'result.bin')).toThrow(/ENOSPC/);

    expect(fs.readFileSync(sourcePath).equals(CONTENT)).toBe(true);
    expect(fs.existsSync(globalSharedObjects.objectPath(KEY))).toBe(false);
    expect(fs.readdirSync(storageDir).filter((name) => name.includes('.tmp.'))).toEqual([]);
  });

  it('refuses without copying when the rename fails for another reason than the volumes', async () => {
    const denied = Object.assign(new Error('EACCES: permission denied, rename'), { code: 'EACCES' });
    vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      throw denied;
    });
    const copy = vi.spyOn(fs, 'copyFileSync');
    const { storageProvider } = await loadStorage();

    expect(() => storageProvider.saveObjectFromFile!(KEY, sourcePath, 'application/octet-stream', 'result.bin')).toThrow(denied);

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
