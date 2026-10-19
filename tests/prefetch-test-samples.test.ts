import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
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
