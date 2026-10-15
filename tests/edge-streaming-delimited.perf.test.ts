import { describe, it, expect } from 'vitest';
import { resolveChunkTransformer } from '../src/lib/edge/workers/opfs-vfs.worker';
import { expectLinearOnInputs, SCALING_FACTOR, SCALING_TEST_TIMEOUT_MS } from './helpers/timing';

/**
 * Timing-ratio checks moved out of edge-streaming-delimited.test.ts.
 * They compare runs of the same work and need a quiet machine, so they run in the nightly performance workflow
 * (`npx vitest run --no-file-parallelism .perf.test.ts`) and not in the PR gate.
 * The PR gate keeps a hang guard on the same hostile input in edge-streaming-delimited.test.ts.
 */

/** Bytes of quoted CR-only records in the small run; the large run is four times as many (up to 4 MiB). */
const LINE_COUNT_BASE_BYTES = 1024 * 1024;

describe('streamed CSV <-> TSV matches the server parser', () => {
  it('records the line of quoted fields in linear time', async () => {
    // A CR-only file holds no LF, so every quoted field asks for the line of a position with no LF after it.
    const record = '"a","b"\r';
    const crOnly = (bytes: number) => new TextEncoder().encode(`h1,h2\r${record.repeat(Math.floor(bytes / record.length))}`);
    // 4x the bytes may cost at most 8x the time (tests/helpers/timing.ts); a quadratic line count takes 16x.
    const { largeResult } = await expectLinearOnInputs(
      'csv to tsv',
      // A transformer finishes after one whole-input call, so each run gets its own.
      (input: Uint8Array) => resolveChunkTransformer('csv', 'tsv', { delimiter: ',' })(input, 0, input.byteLength) as Uint8Array,
      { small: crOnly(LINE_COUNT_BASE_BYTES), large: crOnly(LINE_COUNT_BASE_BYTES * SCALING_FACTOR) }
    );
    expect(largeResult.byteLength).toBeGreaterThan((LINE_COUNT_BASE_BYTES * SCALING_FACTOR) / 2);
  }, SCALING_TEST_TIMEOUT_MS);
});
