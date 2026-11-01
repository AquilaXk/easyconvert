import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import type { CorpusFile } from '../bench/realworld/manifest';
import { findTestSampleIds, testSampleListing } from '../scripts/prefetch-test-samples';

const root = mkdtempSync(path.join(tmpdir(), 'prefetch-ids-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('finding the corpus samples the tests name', () => {
  it('finds a manifest id quoted in a test file, nested or not, in any quote style, and leaves out one no test names', () => {
    mkdirSync(path.join(root, 'nested'));
    writeFileSync(path.join(root, 'a.test.ts'), "const sample = await requireRealworldSample(ctx, 'alpha.aac');\n");
    writeFileSync(path.join(root, 'nested', 'b.test.ts'), 'const a = "beta.avi"; const b = `gamma.xcf`;\n');
    const found = findTestSampleIds(['alpha.aac', 'beta.avi', 'gamma.xcf', 'unused.pdf'], root);
    expect(found).toEqual(['alpha.aac', 'beta.avi', 'gamma.xcf']);
  });

  it('ignores an id that is only part of a longer string or only written unquoted in a comment', () => {
    const directory = mkdtempSync(path.join(root, 'partial-'));
    writeFileSync(path.join(directory, 'c.test.ts'), "const name = 'prefix-delta.pdf'; // delta.pdf\n");
    expect(findTestSampleIds(['delta.pdf'], directory)).toEqual([]);
  });
});

describe('the listing CI keys the corpus cache on', () => {
  const file = (id: string, sha256: string) => ({ id, sha256 }) as CorpusFile;

  it('changes when a test names another sample or a named sample gets new bytes, and not otherwise', () => {
    const files = [file('alpha.aac', 'a1'), file('beta.avi', 'b1'), file('gamma.xcf', 'c1')];
    const listing = testSampleListing(files.slice(0, 2));
    expect(listing).toBe('alpha.aac a1\nbeta.avi b1\n');
    expect(testSampleListing(files.slice(0, 2))).toBe(listing);
    expect(testSampleListing(files)).not.toBe(listing);
    expect(testSampleListing([file('alpha.aac', 'a2'), files[1]])).not.toBe(listing);
  });

  it('prints one "<id> <sha256>" line per named sample, the same on every run, without creating the cache directory', () => {
    const cacheDirectory = path.join(root, 'no-cache-here');
    const run = () =>
      spawnSync(process.execPath, ['--import', 'tsx', 'scripts/prefetch-test-samples.ts', '--list'], {
        cwd: path.resolve(__dirname, '..'),
        encoding: 'utf8',
        env: { ...process.env, REALWORLD_CACHE: cacheDirectory },
      });
    const first = run();
    expect(first.status, first.stderr).toBe(0);
    const lines = first.stdout.split('\n').slice(0, -1);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(line).toMatch(/^\S+ [0-9a-f]{64}$/);
    expect(run().stdout).toBe(first.stdout);
    expect(existsSync(cacheDirectory)).toBe(false);
  }, 60_000);
});

describe('a strict run with a sample the prefetch did not leave in the cache', () => {
  const SAMPLE = 'fate-foo.aac';
  const strictHelper = async (cacheDirectory: string) => {
    vi.resetModules();
    vi.stubEnv('REALWORLD_CACHE', cacheDirectory);
    vi.stubEnv('ORACLE_STRICT_MODE', '1');
    return import('./helpers/realworld-sample');
  };
  const context = { skip: (): never => { throw new Error('skipped'); } };

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('fails before any download and names the prefetch step', async () => {
    const network = vi.spyOn(globalThis, 'fetch');
    const { requireRealworldSample } = await strictHelper(mkdtempSync(path.join(root, 'empty-cache-')));
    await expect(requireRealworldSample(context, SAMPLE)).rejects.toThrow(`real-world sample ${SAMPLE} is not in`);
    await expect(requireRealworldSample(context, SAMPLE)).rejects.toThrow('npm run prefetch:test-samples');
    expect(network).not.toHaveBeenCalled();
  });

  it('treats a cached file whose bytes do not match the pinned digest as missing', async () => {
    const network = vi.spyOn(globalThis, 'fetch');
    const cacheDirectory = mkdtempSync(path.join(root, 'stale-cache-'));
    writeFileSync(path.join(cacheDirectory, SAMPLE), 'not the pinned bytes');
    const { requireRealworldSample } = await strictHelper(cacheDirectory);
    await expect(requireRealworldSample(context, SAMPLE)).rejects.toThrow('npm run prefetch:test-samples');
    expect(network).not.toHaveBeenCalled();
  });
});

describe('the files a test may name as a sample', () => {
  it('hold the files of both corpora under ids that no two files share', async () => {
    const { readTestSampleFiles } = await import('../bench/realworld/test-samples');
    const files = readTestSampleFiles();
    const ids = files.map((file) => file.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(files.find((file) => file.id === 'cc-6200417.pdf')?.format).toBe('pdf');
    expect(ids).toContain('pdf-pdfjs-issue17333.pdf');
  });
});
