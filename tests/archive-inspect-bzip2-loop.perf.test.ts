import { afterAll, describe, expect, it } from 'vitest';
import { ARCHIVE_SECURITY_LIMITS, inspectArchive } from '../src/lib/conversions/archive';
import { UnsafeArchiveError, unpackedBytesCap } from '../src/lib/conversions/archive-extraction-safety';
import { decompressBzip2 } from '../src/lib/conversions/bzip2';
import { EVENT_LOOP_BLOCK_BUDGET_MS, shutdownCpuPool } from '../src/lib/workers/cpu-pool';
import { hostileBzip2Streams } from './helpers/bzip2-hostile';
import { LOOP_SAMPLE_INTERVAL_MS, withLoopMonitor } from './helpers/loop-monitor';

/**
 * Listing a bzip2 archive must not hold the event loop of the web process past its budget (entry 369): a stream of 14 KB that decodes to
 * the 32 MiB floor held it 144 ms when the decode ran on the calling thread. The loop is measured by the CPU time the thread uses
 * between two timer ticks (helpers/loop-monitor.ts); a control case shows that the monitor sees the blocked loop of the decoder.
 */
const BUDGET_MS = EVENT_LOOP_BLOCK_BUDGET_MS + LOOP_SAMPLE_INTERVAL_MS;
const TEST_TIMEOUT_MS = 120_000;
const HOSTILE_BLOCKS = 200;

describe('event loop while a bzip2 archive is listed', () => {
  afterAll(() => shutdownCpuPool());

  it('the monitor reports a blocked loop for the synchronous bzip2 decoder (control)', async () => {
    const stream = hostileBzip2Streams(HOSTILE_BLOCKS);
    const cap = unpackedBytesCap(stream.length, ARCHIVE_SECURITY_LIMITS);
    const { heldMs } = await withLoopMonitor(async () => {
      expect(() => decompressBzip2(stream, cap)).toThrow(/exceeds the limit/);
    });
    expect(heldMs).toBeGreaterThan(BUDGET_MS);
  }, TEST_TIMEOUT_MS);

  it('listing a hostile stream that decodes to the cap keeps the loop delay under the budget', async () => {
    const stream = hostileBzip2Streams(HOSTILE_BLOCKS);
    const { value, heldMs } = await withLoopMonitor(() => inspectArchive(stream, { filename: 'bomb.tar.bz2' }).catch((e: unknown) => e));
    expect(value).toBeInstanceOf(UnsafeArchiveError);
    expect(value).toMatchObject({ reason: 'compression-ratio' });
    expect(heldMs).toBeLessThan(BUDGET_MS);
  }, TEST_TIMEOUT_MS);
});
