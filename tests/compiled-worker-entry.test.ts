import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { olderThanSource } from '../src/lib/workers/compiled-worker';
import { resolveCpuWorkerEntry } from '../src/lib/workers/cpu-pool';

/**
 * A stale `dist/<worker>.js` made local tests run last week's code. A host starts the TypeScript source when the build is older than it
 * and the source can run; a build that is not older, or has no source to give way to, is what production starts.
 */

const SRC_ROOT = path.resolve(__dirname, '..', 'src');
/** The launcher compares the build with the source by modification time in its own code. */
const OWN_FRESHNESS_CHECK = path.join('lib', 'security', 'sandbox-launcher.ts');
const DIST_WORKER_PATH = /path\.join\([^)]*'dist'[^)]*\.js`?\)/;
const HOUR_SECONDS = 3600;

let dir = '';
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = '';
});

/** A `dist/<name>.js` whose modification time is `ageSeconds` before now (negative: after). */
function distWithWorker(name: string, ageSeconds: number): string {
  dir = mkdtempSync(path.join(os.tmpdir(), 'easyconvert-dist-'));
  mkdirSync(path.join(dir, 'dist'));
  const file = path.join(dir, 'dist', `${name}.js`);
  writeFileSync(file, '// build\n');
  const stamp = Date.now() / 1000 - ageSeconds;
  utimesSync(file, stamp, stamp);
  // The hosts find tsx from the working directory.
  writeFileSync(path.join(dir, 'package.json'), '{}');
  symlinkSync(path.join(SRC_ROOT, '..', 'node_modules'), path.join(dir, 'node_modules'));
  return file;
}

function sourceFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.ts$/.test(entry.name) ? [full] : [];
  });
}

describe('olderThanSource', () => {
  it('is true for a build older than the source, false for a newer one, and false with no source', () => {
    const built = distWithWorker('some-worker', HOUR_SECONDS);
    const source = path.join(dir, 'some-worker.ts');
    writeFileSync(source, '// source\n');
    expect(olderThanSource(built, source)).toBe(true);
    const newer = distWithWorker('some-worker', -HOUR_SECONDS);
    expect(olderThanSource(newer, source)).toBe(false);
    expect(olderThanSource(newer, undefined)).toBe(false);
  });
});

describe('the worker hosts', () => {
  it('start the source when the build under dist/ is older than it', () => {
    distWithWorker('cpu-worker', HOUR_SECONDS * 24 * 365);
    vi.spyOn(process, 'cwd').mockReturnValue(dir);
    expect(resolveCpuWorkerEntry().kind).toBe('source');
  });

  it('start a build that is not older than the source', () => {
    const built = distWithWorker('cpu-worker', -HOUR_SECONDS);
    vi.spyOn(process, 'cwd').mockReturnValue(dir);
    expect(resolveCpuWorkerEntry()).toEqual({ kind: 'compiled', file: built });
  });

  it('compare a build under dist/ with its source in every host', () => {
    const unchecked = sourceFiles(SRC_ROOT)
      .filter((file) => path.relative(SRC_ROOT, file) !== OWN_FRESHNESS_CHECK)
      .filter((file) => DIST_WORKER_PATH.test(readFileSync(file, 'utf-8')) && !readFileSync(file, 'utf-8').includes('olderThanSource('))
      .map((file) => path.relative(SRC_ROOT, file));
    expect(unchecked).toEqual([]);
  });
});
