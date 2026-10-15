import { describe, expect, it, vi } from 'vitest';
import { createTarArchive, readTarEntries } from '../src/lib/conversions/archive';
import { ConversionFailedError } from '../src/lib/types';
import { END_OF_ARCHIVE, craftEntry, craftPaxHeader, paxRecordBytes } from './helpers/tar-craft';
import { expectLinearScaling, expectSizeIndependentOnInputs, SCALING_FACTOR, SCALING_TEST_TIMEOUT_MS, settle } from './helpers/timing';

/**
 * Timing-ratio checks moved out of archive-tar-posix-hardening.test.ts.
 * They compare runs of the same work and need a quiet machine, so they run in the nightly performance workflow
 * (`npx vitest run --no-file-parallelism .perf.test.ts`) and not in the PR gate.
 * The PR gate keeps a hang guard on the same hostile input in archive-tar-posix-hardening.test.ts.
 */

/** Real engine, CLI or large-input work: the 5 s default fails on a loaded CI shard without any regression; 60 s only stops a hang. */
const ENGINE_TEST_TIMEOUT_MS = 60_000;
const PAX_FLOOD_HEADERS = 16;
const SLASH_RUN_BASE = 2000;
const SLASH_RUN_ROUND_TRIPS = 100;

const KIB = 1024;
const MIB = KIB * KIB;
const PAX_CAP = MIB;

vi.setConfig({ testTimeout: ENGINE_TEST_TIMEOUT_MS });

describe('TAR reader: cumulative extension-header budget', () => {
  it('stops a flood of maximum-size pax headers within a bounded amount of work', async () => {
    // The reader refuses the archive once the pax budget is spent, so a flood four times as long must be
    // refused after about the same work (tests/helpers/timing.ts), not after reading all of it.
    const floodTar = (headers: number) => {
      const flood: Buffer[] = [];
      for (let i = 0; i < headers; i++) {
        flood.push(craftPaxHeader('x', paxRecordBytes(`k${i}`, 'v'.repeat(PAX_CAP - KIB))));
      }
      return Buffer.concat([...flood, craftEntry('f', 'X'), END_OF_ARCHIVE]);
    };
    const { largeResult } = await expectSizeIndependentOnInputs(
      'pax flood',
      (tar: Buffer) => settle(() => readTarEntries(tar)),
      { modest: floodTar(PAX_FLOOD_HEADERS), huge: floodTar(PAX_FLOOD_HEADERS * SCALING_FACTOR) }
    );
    expect(largeResult.ok).toBe(false);
    expect(!largeResult.ok && largeResult.error).toBeInstanceOf(ConversionFailedError);
  }, SCALING_TEST_TIMEOUT_MS);
});

describe('TAR writer: collisions keep directories as directories', () => {
  it('writes and reads names made of long slash runs in linear time', async () => {
    // The writer refuses names over 8192 characters, so the largest run is 8000 slashes; repeating the round
    // trip makes the smallest run long enough to time.
    const roundTrip = (slashes: number) => {
      const name = `a${'/'.repeat(slashes)}b`;
      let filename = '';
      for (let i = 0; i < SLASH_RUN_ROUND_TRIPS; i++) {
        filename = readTarEntries(createTarArchive([{ filename: name, buffer: Buffer.alloc(0) }]).buffer)[0].filename;
      }
      return filename;
    };
    const { largeResult } = await expectLinearScaling('slash-run names', roundTrip, { baseSize: SLASH_RUN_BASE });
    expect(largeResult).toBe('a/b');
  }, SCALING_TEST_TIMEOUT_MS);
});
