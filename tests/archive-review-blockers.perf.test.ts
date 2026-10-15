import { describe, expect, it, vi } from 'vitest';
import { resolveArchiveEntryCollisions } from '../src/lib/conversions/archive';
import { expectLinearOnInputs, SCALING_FACTOR, SCALING_TEST_TIMEOUT_MS } from './helpers/timing';

/**
 * Timing-ratio checks moved out of archive-review-blockers.test.ts.
 * They compare runs of the same work and need a quiet machine, so they run in the nightly performance workflow
 * (`npx vitest run --no-file-parallelism .perf.test.ts`) and not in the PR gate.
 * The PR gate keeps a hang guard on the same hostile input in archive-review-blockers.test.ts.
 */

/** Real engine, CLI or large-input work: the 5 s default fails on a loaded CI shard without any regression; 60 s only stops a hang. */
const ENGINE_TEST_TIMEOUT_MS = 60_000;

const DUPLICATE_COUNT = 50_000;

vi.setConfig({ testTimeout: ENGINE_TEST_TIMEOUT_MS });

describe('PR #499 review blockers', () => {
  describe('5. renaming duplicates is linear', () => {
    it('renames 50,000 identical names in linear time with the same numbering as before', async () => {
      const duplicates = (count: number) => Array.from({ length: count }, () => ({ filename: 'a.txt', buffer: Buffer.alloc(0) }));
      const { largeResult: renamed } = await expectLinearOnInputs(
        'resolveArchiveEntryCollisions',
        (files: Array<{ filename: string; buffer: Buffer }>) => resolveArchiveEntryCollisions(files, 'rename'),
        { small: duplicates(DUPLICATE_COUNT / SCALING_FACTOR), large: duplicates(DUPLICATE_COUNT) }
      );

      expect(renamed.map((f) => f.filename).slice(0, 4)).toEqual(['a.txt', 'a-1.txt', 'a-2.txt', 'a-3.txt']);
      expect(renamed[DUPLICATE_COUNT - 1].filename).toBe(`a-${DUPLICATE_COUNT - 1}.txt`);
      expect(new Set(renamed.map((f) => f.filename)).size).toBe(DUPLICATE_COUNT);
    }, SCALING_TEST_TIMEOUT_MS);
  });
});
