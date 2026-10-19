import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { findTestSampleIds } from '../scripts/prefetch-test-samples';

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
