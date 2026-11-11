import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanupWorkerSandboxDir, createWorkerSandboxDir } from '../src/worker/sandbox';
import {
  SANDBOX_STALE_AFTER_MS,
  startWorkerSandboxSweep,
  stopWorkerSandboxSweep,
  sweepWorkerSandboxDirs,
  WORKER_SANDBOX_DIR_NAME,
} from '../src/worker/sandbox-sweep';
import { LibreOfficePoolManager } from '../src/worker/libreoffice-pool';

/**
 * What a worker killed by SIGKILL leaves in the temporary directory, and what removes it (docs/policy-decisions.md, entry 232). The
 * temporary directory is a directory of the test: os.tmpdir() follows TMPDIR, and the worker modules ask it on every call.
 */

const HOUR = 60 * 60 * 1000;
const originalTmpdir = process.env.TMPDIR;
let tmp: string;

/** A directory another process made: nothing in this process owns it. */
function foreignDir(prefix: string, ageMs: number): string {
  const dir = path.join(tmp, `${prefix}${crypto.randomUUID()}`);
  fs.mkdirSync(dir, { mode: 0o700 });
  fs.writeFileSync(path.join(dir, 'x'), 'x');
  const when = new Date(Date.now() - ageMs);
  fs.utimesSync(dir, when, when);
  return dir;
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(originalTmpdir ?? os.tmpdir(), 'sandbox-sweep-'));
  process.env.TMPDIR = tmp;
});

afterEach(() => {
  stopWorkerSandboxSweep();
  vi.restoreAllMocks();
  if (originalTmpdir === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = originalTmpdir;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('the names a sweep recognises', () => {
  it('are those the worker gives its directories, and nothing else in a temporary directory', () => {
    for (const prefix of ['easyconvert_worker_sandbox_', 'libreoffice_profile_worker-1a2b3c4d_', 'libreoffice_work_worker-1a2b3c4d_', 'libreoffice_probe_profile_1a2b3c4d_', 'libreoffice_probe_work_1a2b3c4d_']) {
      expect(WORKER_SANDBOX_DIR_NAME.test(`${prefix}${crypto.randomUUID()}`), prefix).toBe(true);
    }
    for (const name of ['easyconvert_worker_sandbox_', 'easyconvert_worker_sandbox_not-a-uuid', `other_${crypto.randomUUID()}`, `test_sandbox_${crypto.randomUUID()}`, 'worker-heartbeat.json', `.org.chromium.${crypto.randomUUID()}`]) {
      expect(WORKER_SANDBOX_DIR_NAME.test(name), name).toBe(false);
    }
  });

  it('match the prefixes that src/worker/libreoffice-pool.ts passes to createWorkerSandboxDir', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'worker', 'libreoffice-pool.ts'), 'utf-8');
    const prefixes = [...source.matchAll(/createWorkerSandboxDir\(`([a-z_]+)_\$\{(\w+)\}_`\)/g)].map((match) => `${match[1]}_worker-1a2b3c4d_`);
    expect(prefixes).toHaveLength(4);
    for (const prefix of prefixes) expect(WORKER_SANDBOX_DIR_NAME.test(`${prefix}${crypto.randomUUID()}`), prefix).toBe(true);
  });
});

describe('sweepWorkerSandboxDirs', () => {
  it('removes the directories of a worker that is gone, sandbox and LibreOffice profile alike, once nobody has touched them for the stale age', () => {
    const sandbox = foreignDir('easyconvert_worker_sandbox_', SANDBOX_STALE_AFTER_MS + 1000);
    const profile = foreignDir('libreoffice_profile_worker-1a2b3c4d_', 2 * HOUR);
    const work = foreignDir('libreoffice_work_worker-1a2b3c4d_', 2 * HOUR);
    const removed = sweepWorkerSandboxDirs();
    expect(removed.sort()).toEqual([sandbox, profile, work].map((dir) => path.basename(dir)).sort());
    for (const dir of [sandbox, profile, work]) expect(fs.existsSync(dir), dir).toBe(false);
  });

  it('keeps a directory that was touched within the stale age: its owner may be a live replica that shares the directory', () => {
    const young = foreignDir('easyconvert_worker_sandbox_', SANDBOX_STALE_AFTER_MS - 60_000);
    expect(sweepWorkerSandboxDirs()).toEqual([]);
    expect(fs.existsSync(young)).toBe(true);
  });

  it('keeps every directory of this process, however old it looks', () => {
    const own = createWorkerSandboxDir();
    const ancient = new Date(Date.now() - 5 * HOUR);
    fs.utimesSync(own, ancient, ancient);
    expect(sweepWorkerSandboxDirs()).toEqual([]);
    expect(fs.existsSync(own)).toBe(true);
    cleanupWorkerSandboxDir(own);
    // once it is cleaned up it is nobody's: a leftover of the same name would be swept
    fs.mkdirSync(own);
    fs.utimesSync(own, ancient, ancient);
    expect(sweepWorkerSandboxDirs()).toEqual([path.basename(own)]);
  });

  it('leaves files, other names and links alone', () => {
    const outside = fs.mkdtempSync(path.join(tmp, 'outside-'));
    fs.writeFileSync(path.join(outside, 'keep'), 'k');
    const old = new Date(Date.now() - 5 * HOUR);
    const unrelated = path.join(tmp, `unrelated_${crypto.randomUUID()}`);
    fs.mkdirSync(unrelated);
    fs.utimesSync(unrelated, old, old);
    const file = path.join(tmp, `easyconvert_worker_sandbox_${crypto.randomUUID()}`);
    fs.writeFileSync(file, 'f');
    fs.utimesSync(file, old, old);
    const link = path.join(tmp, `easyconvert_worker_sandbox_${crypto.randomUUID()}`);
    fs.symlinkSync(outside, link);
    fs.lutimesSync(link, old, old);
    expect(sweepWorkerSandboxDirs()).toEqual([]);
    expect(fs.existsSync(unrelated)).toBe(true);
    expect(fs.existsSync(file)).toBe(true);
    expect(fs.readlinkSync(link)).toBe(outside);
    expect(fs.existsSync(path.join(outside, 'keep'))).toBe(true);
  });

  it('returns nothing, and does not throw, when the directory cannot be read', () => {
    expect(sweepWorkerSandboxDirs({ directory: path.join(tmp, 'missing') })).toEqual([]);
  });

  it('takes the stale age and the clock as options', () => {
    const dir = foreignDir('easyconvert_worker_sandbox_', 1000);
    expect(sweepWorkerSandboxDirs({ staleAfterMs: 5000 })).toEqual([]);
    expect(sweepWorkerSandboxDirs({ staleAfterMs: 5000, now: Date.now() + 10_000 })).toEqual([path.basename(dir)]);
  });
});

describe('startWorkerSandboxSweep', () => {
  it('sweeps at once at start-up, which is what removes the leftovers of the worker that was killed', () => {
    const leftover = foreignDir('libreoffice_profile_worker-1a2b3c4d_', 2 * HOUR);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    startWorkerSandboxSweep(60_000);
    expect(fs.existsSync(leftover)).toBe(false);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('Removed 1 sandbox directory'));
  });

  it('refreshes the time of the directories of this process each interval, so that a replica that shares the directory does not sweep them', () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      const own = createWorkerSandboxDir();
      const old = new Date(Date.now() - HOUR);
      fs.utimesSync(own, old, old);
      startWorkerSandboxSweep(1000);
      expect(Date.now() - fs.statSync(own).mtimeMs).toBeLessThan(5000);
      fs.utimesSync(own, old, old);
      vi.advanceTimersByTime(1000);
      expect(Date.now() - fs.statSync(own).mtimeMs).toBeLessThan(5000);
      cleanupWorkerSandboxDir(own);
    } finally {
      vi.useRealTimers();
    }
  });

  it('sweeps again each interval, and stops when it is stopped', () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      startWorkerSandboxSweep(1000);
      const late = foreignDir('easyconvert_worker_sandbox_', 2 * HOUR);
      vi.advanceTimersByTime(1000);
      expect(fs.existsSync(late)).toBe(false);
      stopWorkerSandboxSweep();
      const after = foreignDir('easyconvert_worker_sandbox_', 2 * HOUR);
      vi.advanceTimersByTime(5000);
      expect(fs.existsSync(after)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('the LibreOffice pool and the sweep', () => {
  it('removes the profile and work directories of its slots on shutdown, which is what the drain of a recycled worker now runs', async () => {
    const pool = new LibreOfficePoolManager({
      sofficePath: '/bin/true',
      enabled: true,
      minWorkers: 2,
      maxWorkers: 2,
      readinessProbe: false,
      executor: async () => ({ stdout: '', stderr: '', exitCode: 0 }) as never,
    });
    await pool.init();
    const names = (): string[] => fs.readdirSync(tmp).filter((name) => name.startsWith('libreoffice_'));
    expect(names()).toHaveLength(4);
    await pool.shutdown();
    expect(names()).toEqual([]);
  });
});
