import { describe, expect, it } from 'vitest';
import { ARCHIVE_SECURITY_LIMITS } from '../src/lib/conversions/archive';
import { assertSafeArchiveListing, type ListedArchiveEntry } from '../src/lib/conversions/archive-extraction-safety';
import { expectLinearOnInputs, SCALING_FACTOR, SCALING_TEST_TIMEOUT_MS, settle } from './helpers/timing';

/**
 * Timing-ratio checks moved out of archive-review-round2.test.ts.
 * They compare runs of the same work and need a quiet machine, so they run in the nightly performance workflow
 * (`npx vitest run --no-file-parallelism .perf.test.ts`) and not in the PR gate.
 * The PR gate keeps a hang guard on the same hostile input in archive-review-round2.test.ts.
 */

const LINEAR_PROBE_SMALL = 12_250;
const LINEAR_PROBE_LARGE = 49_000;

const FAN_ENTRIES = 300;
/** 'd/' repeated, plus the fan prefix and the leaf, stays within the 256-level depth limit. */
const FAN_DEPTH = 253;

function entry(entryPath: string, isDirectory = false): ListedArchiveEntry {
  return { path: entryPath, isDirectory, sizeBytes: isDirectory ? 0 : 1, linkKind: null, isSpecial: false };
}

describe('NEW-1: implied directories count toward the entry cap', () => {
  it('rejects 300 entries that each imply 254 directories after the work of counting them, not of creating them', async () => {
    const fan = (entries: number) => Array.from({ length: entries }, (_, i) => entry(`${i}/${'d/'.repeat(FAN_DEPTH)}f`));
    // 300 entries imply about 76,000 directories, over the 50,000 cap. Linear accounting costs 4x for 4x the
    // entries (tests/helpers/timing.ts); creating or deduplicating directories pairwise would cost 16x.
    const { largeResult } = await expectLinearOnInputs(
      'implied directory accounting',
      (entries: ListedArchiveEntry[]) => settle(() => assertSafeArchiveListing(entries, 1_000_000, ARCHIVE_SECURITY_LIMITS)),
      { small: fan(FAN_ENTRIES), large: fan(FAN_ENTRIES * SCALING_FACTOR) }
    );
    expect(largeResult.ok).toBe(false);
    expect(!largeResult.ok && (largeResult.error as { reason?: string }).reason).toBe('entry-count');
  }, SCALING_TEST_TIMEOUT_MS);

  it('accounts 49,000 deep entries under one prefix in linear time', async () => {
    const shared = 'p/'.repeat(100);
    const listing = (count: number) => Array.from({ length: count }, (_, i) => entry(`${shared}${i}`));
    // 4x the entries: linear work grows about 4x, the old quadratic accounting about 16x.
    const { largeResult } = await expectLinearOnInputs(
      'assertSafeArchiveListing',
      (entries: ListedArchiveEntry[]) => assertSafeArchiveListing(entries, 1_000_000, ARCHIVE_SECURITY_LIMITS),
      { small: listing(LINEAR_PROBE_SMALL), large: listing(LINEAR_PROBE_LARGE) }
    );
    expect(largeResult.entryCount).toBe(LINEAR_PROBE_LARGE);
    expect(assertSafeArchiveListing(listing(LINEAR_PROBE_SMALL), 1_000_000, ARCHIVE_SECURITY_LIMITS).entryCount).toBe(LINEAR_PROBE_SMALL);
  }, SCALING_TEST_TIMEOUT_MS);
});
