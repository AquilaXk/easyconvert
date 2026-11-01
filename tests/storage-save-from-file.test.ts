import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A result the worker stores from a file ends up in the storage directory, which is all the web process shares with it.
 * The rename that moves it there fails with EXDEV when the worker's output directory is on another volume.
 */

const KEY = 'results/job-1/result.bin';
const MINUTE_MS = 60 * 1000;
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
  vi.useRealTimers();
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
    renameFailsAcrossVolumes();
    const renameSync = vi.spyOn(fs, 'renameSync');
    const { storageProvider, globalSharedObjects } = await loadStorage();

    const stored = await storageProvider.saveObjectFromFile!(KEY, sourcePath, 'application/octet-stream', 'result.bin');

    const finalPath = globalSharedObjects.objectPath(KEY);
    expect(stored.filePath).toBe(finalPath);
    expect(fs.readFileSync(finalPath).equals(CONTENT)).toBe(true);
    expect(fs.existsSync(sourcePath)).toBe(false);
    const renamedIntoPlace = renameSync.mock.calls.filter(([, to]) => to === finalPath);
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
    renameFailsAcrossVolumes();
    const events: string[] = [];
    const open = fs.promises.open;
    vi.spyOn(fs.promises, 'open').mockImplementation(async (...args) => {
      const handle = await open(...(args as Parameters<typeof open>));
      const sync = handle.sync.bind(handle);
      handle.sync = async () => {
        events.push(`fsync ${String(args[0])}`);
        return sync();
      };
      return handle;
    });
    const { storageProvider, globalSharedObjects } = await loadStorage();
    const finalPath = globalSharedObjects.objectPath(KEY);
    const renameSync = fs.renameSync;
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (to === finalPath) events.push(`rename ${String(from)} into place`);
      return renameSync(from, to);
    });

    await storageProvider.saveObjectFromFile!(KEY, sourcePath, 'application/octet-stream', 'result.bin');

    const intoPlace = events.findIndex((event) => event.endsWith(' into place'));
    const copy = /^rename (.*) into place$/.exec(events[intoPlace] ?? '')?.[1];
    expect(copy, 'the copy is renamed into place').toBeDefined();
    expect(events.indexOf(`fsync ${copy}`), 'the copy is flushed before').toBeGreaterThanOrEqual(0);
    expect(events.indexOf(`fsync ${copy}`)).toBeLessThan(intoPlace);
  });

  // skip-ok: root reads a file whatever its mode, so a read-only source cannot be set up.
  it.skipIf(process.getuid?.() === 0)('copies a read-only source, whose mode the copy keeps', async () => {
    renameFailsAcrossVolumes();
    fs.chmodSync(sourcePath, 0o444);
    const { storageProvider, globalSharedObjects } = await loadStorage();

    await storageProvider.saveObjectFromFile!(KEY, sourcePath, 'application/octet-stream', 'result.bin');

    expect(fs.readFileSync(globalSharedObjects.objectPath(KEY)).equals(CONTENT)).toBe(true);
    expect(leftTemporaryFiles()).toEqual([]);
  });

  it('gives the temporary copy of a source written two hours ago the time of the copy by the time it flushes it, so the sweep does not take it for abandoned', async () => {
    renameFailsAcrossVolumes();
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    fs.utimesSync(sourcePath, twoHoursAgo, twoHoursAgo);
    const copyStartedAt = Date.now();
    const mtimeAtFlush: number[] = [];
    const open = fs.promises.open;
    vi.spyOn(fs.promises, 'open').mockImplementation(async (...args) => {
      const handle = await open(...(args as Parameters<typeof open>));
      const sync = handle.sync.bind(handle);
      handle.sync = async () => {
        if (/\.bin\.tmp\./.test(String(args[0]))) mtimeAtFlush.push(fs.statSync(String(args[0])).mtimeMs);
        return sync();
      };
      return handle;
    });
    const { storageProvider } = await loadStorage();

    await storageProvider.saveObjectFromFile!(KEY, sourcePath, 'application/octet-stream', 'result.bin');

    expect(mtimeAtFlush).toHaveLength(1);
    expect(mtimeAtFlush[0]).toBeGreaterThanOrEqual(copyStartedAt - 1000);
  });

  it('stores the object when the temporary copy cannot be touched, and says so', async () => {
    renameFailsAcrossVolumes();
    vi.spyOn(fs.promises, 'utimes').mockRejectedValue(Object.assign(new Error('EPERM: operation not permitted, utime'), { code: 'EPERM' }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { storageProvider, globalSharedObjects } = await loadStorage();

    await storageProvider.saveObjectFromFile!(KEY, sourcePath, 'application/octet-stream', 'result.bin');

    expect(fs.readFileSync(globalSharedObjects.objectPath(KEY)).equals(CONTENT)).toBe(true);
    expect(warn.mock.calls.some(([message]) => /touch/i.test(String(message)))).toBe(true);
  });

  it('copies at most two files across volumes at once, so long copies do not take every thread of the file system pool', async () => {
    const rename = fs.promises.rename;
    vi.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => {
      if (String(from).includes(`${path.sep}worker-tmp${path.sep}`)) throw exdev();
      return rename(from, to);
    });
    const copy = fs.promises.copyFile;
    let running = 0;
    let mostAtOnce = 0;
    const releases: Array<() => void> = [];
    vi.spyOn(fs.promises, 'copyFile').mockImplementation(async (from, to, mode) => {
      running++;
      mostAtOnce = Math.max(mostAtOnce, running);
      await copy(from, to, mode);
      await new Promise<void>((resolve) => releases.push(resolve));
      running--;
    });
    const { storageProvider } = await loadStorage();
    const sources = [1, 2, 3].map((n) => {
      const source = path.join(baseDir, 'worker-tmp', `result-${n}.bin`);
      fs.writeFileSync(source, CONTENT);
      return source;
    });

    const saves = sources.map((source, n) => storageProvider.saveObjectFromFile!(`results/job-${n}/result.bin`, source, 'application/octet-stream', 'result.bin'));
    for (let turn = 0; turn < 50 && releases.length < 2; turn++) await new Promise((resolve) => setTimeout(resolve, 5));

    expect(releases, 'two copies run').toHaveLength(2);
    expect(running).toBe(2);
    while (releases.length > 0 || running > 0) {
      releases.shift()?.();
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await Promise.all(saves);
    expect(mostAtOnce).toBe(2);
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

describe('an attempt that is aborted while it saves its result', () => {
  const EARLIER = crypto.randomBytes(4096);

  async function storeEarlierAttempt() {
    const storage = await loadStorage();
    const earlierSource = path.join(baseDir, 'worker-tmp', 'earlier.bin');
    fs.writeFileSync(earlierSource, EARLIER);
    const earlier = await storage.storageProvider.saveObjectFromFile!(KEY, earlierSource, 'application/octet-stream', 'result.bin');
    return { storage, earlier };
  }

  async function expectEarlierObjectServed(etag: string) {
    vi.restoreAllMocks();
    const reader = await loadStorage();
    expect(reader.globalSharedObjects.get(KEY)?.etag, 'the record of the earlier save').toBe(etag);
    expect(fs.readFileSync(reader.globalSharedObjects.objectPath(KEY)).equals(EARLIER), 'the bytes of the earlier save').toBe(true);
    expect(leftTemporaryFiles(), 'no temporary file is left').toEqual([]);
  }

  it('stores nothing and keeps the object another attempt stored when it is aborted during its copy', async () => {
    const { storage, earlier } = await storeEarlierAttempt();
    renameFailsAcrossVolumes();
    const attempt = new AbortController();
    const copy = fs.promises.copyFile;
    vi.spyOn(fs.promises, 'copyFile').mockImplementation(async (from, to, mode) => {
      await copy(from, to, mode);
      attempt.abort(new Error('the attempt lost its lock'));
    });

    await expect(
      storage.storageProvider.saveObjectFromFile!(KEY, sourcePath, 'application/octet-stream', 'result.bin', 60_000, attempt.signal)
    ).rejects.toThrow(/lost its lock/);

    await expectEarlierObjectServed(earlier.etag);
  });

  it('stores nothing and keeps the object another attempt stored when it was aborted before the save', async () => {
    const { storage, earlier } = await storeEarlierAttempt();

    await expect(
      storage.storageProvider.saveObjectFromFile!(KEY, sourcePath, 'application/octet-stream', 'result.bin', 60_000, AbortSignal.abort(new Error('aborted before the save')))
    ).rejects.toThrow(/aborted before the save/);

    await expectEarlierObjectServed(earlier.etag);
  });
});

describe('a file to store that is not a regular file', () => {
  it('refuses a symbolic link with a typed error and stores nothing, leaving the file it points to alone', async () => {
    const { storageProvider, globalSharedObjects } = await loadStorage();
    const { NotARegularFileError } = await import('../src/lib/storage/errors');
    const elsewhere = path.join(baseDir, 'elsewhere.txt');
    fs.writeFileSync(elsewhere, 'not the output');
    const link = path.join(baseDir, 'worker-tmp', 'link.bin');
    fs.symlinkSync(elsewhere, link);

    const saving = storageProvider.saveObjectFromFile!(KEY, link, 'application/octet-stream', 'result.bin');

    await expect(saving).rejects.toBeInstanceOf(NotARegularFileError);
    expect(globalSharedObjects.get(KEY)).toBeUndefined();
    expect(fs.existsSync(globalSharedObjects.objectPath(KEY))).toBe(false);
    expect(fs.readFileSync(elsewhere, 'utf-8')).toBe('not the output');
  });

  it('refuses a directory with a typed error and stores nothing', async () => {
    const { storageProvider, globalSharedObjects } = await loadStorage();
    const { NotARegularFileError } = await import('../src/lib/storage/errors');
    const dir = path.join(baseDir, 'worker-tmp', 'out-dir');
    fs.mkdirSync(dir);

    await expect(storageProvider.saveObjectFromFile!(KEY, dir, 'application/octet-stream', 'result.bin')).rejects.toBeInstanceOf(NotARegularFileError);
    expect(fs.existsSync(globalSharedObjects.objectPath(KEY))).toBe(false);
  });

  it('refuses an engine output that is a symbolic link before it is handed off or copied to a named destination', async () => {
    await loadStorage();
    const { NotARegularFileError } = await import('../src/lib/storage/errors');
    const { withSandboxDir, handOffOutput, preserveOutput } = await import('../src/worker/worker-output');
    const elsewhere = path.join(baseDir, 'elsewhere.txt');
    fs.writeFileSync(elsewhere, 'not the output');
    const named = path.join(baseDir, 'named-destination.pdf');

    await withSandboxDir('easyconvert-office-', async (jobDir) => {
      const output = path.join(jobDir, 'output.pdf');
      fs.symlinkSync(elsewhere, output);
      await expect(handOffOutput(output, 'pdf')).rejects.toBeInstanceOf(NotARegularFileError);
      expect(() => preserveOutput(output, 'pdf', { outputPath: named } as never)).toThrow(NotARegularFileError);
    });

    expect(fs.existsSync(named), 'nothing was copied to the named destination').toBe(false);
    expect(fs.readdirSync(path.join(storageDir, '.staging')), 'nothing was handed off').toEqual([]);
  });

  it('keeps a file an engine writes one level above its job directory out of the directory of the objects', async () => {
    await loadStorage();
    const { withSandboxDir } = await import('../src/worker/worker-output');

    await withSandboxDir('easyconvert-office-', async (jobDir) => {
      fs.writeFileSync(path.join(jobDir, '..', 'x'), 'escaped');
    });

    expect(fs.existsSync(path.join(storageDir, 'x'))).toBe(false);
    expect(fs.readdirSync(storageDir).filter((name) => !name.startsWith('.'))).toEqual([]);
  });
});

describe('the record of an object the local driver stores', () => {
  it('fails the save when the record cannot be written, and leaves the object an earlier save of the key stored', async () => {
    const { storageProvider } = await loadStorage();
    const earlier = await storageProvider.saveObjectFromFile!(KEY, sourcePath, 'application/octet-stream', 'result.bin');
    const retrySource = path.join(baseDir, 'worker-tmp', 'retry.bin');
    fs.writeFileSync(retrySource, crypto.randomBytes(CONTENT.length + 4096));
    const open = fs.promises.open;
    vi.spyOn(fs.promises, 'open').mockImplementation(async (...args) => {
      if (String(args[0]).includes('.meta.json')) throw Object.assign(new Error('ENOSPC: no space left on device, open'), { code: 'ENOSPC' });
      return open(...(args as Parameters<typeof open>));
    });

    await expect(storageProvider.saveObjectFromFile!(KEY, retrySource, 'application/octet-stream', 'result.bin')).rejects.toThrow(/ENOSPC/);

    vi.restoreAllMocks();
    const reader = await loadStorage();
    expect(reader.globalSharedObjects.get(KEY)?.etag, 'the record of the earlier save').toBe(earlier.etag);
    expect(fs.readFileSync(reader.globalSharedObjects.objectPath(KEY)).equals(CONTENT), 'the bytes of the earlier save').toBe(true);
    expect(leftTemporaryFiles(), 'the staged bytes are removed').toEqual([]);
  });

  it('refuses an object whose bytes stay at a path only this process reads, whatever its size', async () => {
    const { globalSharedObjects } = await loadStorage();
    const privateFile = path.join(baseDir, 'worker-tmp', 'large.bin');
    fs.writeFileSync(privateFile, Buffer.alloc(0));
    fs.truncateSync(privateFile, 65 * 1024 * 1024);

    expect(() =>
      globalSharedObjects.set(KEY, {
        key: KEY,
        filename: 'large.bin',
        mimeType: 'application/octet-stream',
        size: 65 * 1024 * 1024,
        etag: '"e"',
        uploadedAt: Date.now(),
        expiresAt: Date.now() + 60_000,
        filePath: privateFile,
      })
    ).toThrow(/only this process/);
    expect(fs.existsSync(globalSharedObjects.objectPath(KEY))).toBe(false);
  });
});

describe('a stream the local driver stores', () => {
  it('keeps the temporary file of a source that sends nothing for longer than the sweep waits, by touching it while it waits', async () => {
    const { TEMP_REFRESH_MS } = await import('../src/lib/storage/temp-file');
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const { storageProvider, globalSharedObjects } = await loadStorage();
    const source = new PassThrough();
    const saving = storageProvider.saveObjectFromStream(KEY, source, { filename: 'quiet.bin', mimeType: 'application/octet-stream' });
    source.write(Buffer.alloc(1024, 7));
    let temp: string | undefined;
    for (let turn = 0; turn < 200 && !temp; turn++) {
      await new Promise((resolve) => setImmediate(resolve));
      temp = fs.existsSync(storageDir) ? fs.readdirSync(storageDir).find((name) => name.includes('.tmp.')) : undefined;
    }
    expect(temp, 'the save writes a temporary file').toBeDefined();
    const tempPath = path.join(storageDir, temp!);
    const lastWrite = new Date(Date.now() - 50 * MINUTE_MS);
    fs.utimesSync(tempPath, lastWrite, lastWrite);

    vi.advanceTimersByTime(TEMP_REFRESH_MS);
    for (let turn = 0; turn < 200 && fs.statSync(tempPath).mtimeMs < lastWrite.getTime() + 1000; turn++) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    await globalSharedObjects.sweepStaleTempFiles(Date.now() + 20 * MINUTE_MS);

    expect(fs.existsSync(tempPath), 'the quiet writer keeps its file').toBe(true);
    source.end(Buffer.alloc(1024, 8));
    const stored = await saving;
    vi.useRealTimers();
    expect(stored.size).toBe(2048);
  });
});

describe('the output of a job of the local driver', () => {
  it('runs the job in the storage directory, so its output is stored by renames and never copied', async () => {
    const copyFile = vi.spyOn(fs.promises, 'copyFile');
    const copyFileSync = vi.spyOn(fs, 'copyFileSync');
    const { storageProvider, globalSharedObjects } = await loadStorage();
    const { withSandboxDir, handOffOutput } = await import('../src/worker/worker-output');

    await withSandboxDir('easyconvert-ffmpeg-', async (jobDir) => {
      expect(path.relative(storageDir, jobDir).startsWith('..'), 'the job directory is in the storage directory').toBe(false);
      const output = path.join(jobDir, 'output.flac');
      fs.writeFileSync(output, CONTENT);
      const handed = await handOffOutput(output, 'flac');
      await storageProvider.saveObjectFromFile!(KEY, handed, 'audio/flac', 'result.flac');
    });

    expect(fs.readFileSync(globalSharedObjects.objectPath(KEY)).equals(CONTENT)).toBe(true);
    expect(copyFile).not.toHaveBeenCalled();
    expect(copyFileSync).not.toHaveBeenCalled();
  });
});
