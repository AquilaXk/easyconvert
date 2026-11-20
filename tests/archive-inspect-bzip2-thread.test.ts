import { afterAll, describe, expect, it } from 'vitest';
import { BZIP2_INLINE_MAX_OUTPUT_BYTES, compressBzip2 } from '../src/lib/conversions/bzip2';
import { inspectArchive } from '../src/lib/conversions/archive';
import { UnsafeArchiveError } from '../src/lib/conversions/archive-extraction-safety';
import { CpuTaskAbortedError } from '../src/lib/types';
import { shutdownCpuPool } from '../src/lib/workers/cpu-pool';
import { hostileBzip2Streams } from './helpers/bzip2-hostile';
import { DEFAULT_HANG_GUARD_MS, expectWithinHangGuard } from './helpers/timing';

/**
 * Listing a .tar.bz2 decodes the stream on a CPU pool thread (entry 339, amended), up to the same cap as before, and a request that is
 * cancelled stops the thread. A hostile stream of under a megabyte asks for up to 100 times its size, which kept the event loop of the
 * web process for seconds.
 */
const TAR_BLOCK = 512;
const CANCEL_AFTER_MS = 30;

function tarOf(names: string[]): Buffer {
  const blocks = names.map((name) => {
    const header = Buffer.alloc(TAR_BLOCK);
    header.write(name, 0, 'ascii');
    header.write('0000644\0', 100, 'ascii');
    header.write('00000000000\0', 124, 'ascii');
    header.write('0', 156, 'ascii');
    header.write('ustar\0', 257, 'ascii');
    header.write('00', 263, 'ascii');
    header.fill(0x20, 148, 156);
    header.write(`${[...header].reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, '0')}\0 `, 148, 'ascii');
    return header;
  });
  return Buffer.concat([...blocks, Buffer.alloc(TAR_BLOCK * 2)]);
}

describe('listing a bzip2 stream on a pool thread', () => {
  afterAll(() => shutdownCpuPool());

  it('lists the entries of a .tar.bz2 that decodes to more than the calling thread decodes', async () => {
    const names = Array.from({ length: 9000 }, (_, i) => `dir/file-${i}.txt`);
    const tar = tarOf(names);
    expect(tar.length).toBeGreaterThan(BZIP2_INLINE_MAX_OUTPUT_BYTES);
    const listing = await inspectArchive(compressBzip2(tar), { filename: 'many.tar.bz2' });
    expect(listing.entries.map((entry) => entry.name)).toEqual(names);
  });

  it('refuses a stream whose output passes the cap with the compression-ratio refusal', async () => {
    const stream = hostileBzip2Streams(60);
    const error = await inspectArchive(stream, { filename: 'bomb.tar.bz2' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UnsafeArchiveError);
    expect(error).toMatchObject({ reason: 'compression-ratio', refusalCode: 'unsafe_archive' });
  });

  it('stops the decode when the request is cancelled', async () => {
    const stream = hostileBzip2Streams(14_000);
    const controller = new AbortController();
    const started = performance.now();
    const outcome = inspectArchive(stream, { filename: 'bomb.tar.bz2', signal: controller.signal }).catch((e: unknown) => e);
    setTimeout(() => controller.abort(), CANCEL_AFTER_MS);
    const error = await outcome;
    expect(error).toBeInstanceOf(CpuTaskAbortedError);
    expect(error).toMatchObject({ name: 'CpuTaskAbortedError', message: 'The bzip2Decode task was cancelled' });
    expectWithinHangGuard('a cancelled bzip2 decode', performance.now() - started, { guardMs: DEFAULT_HANG_GUARD_MS, expectedLocalMs: CANCEL_AFTER_MS + 10 });
  }, 60_000);

  it('answers a malformed stream with the failure of an unreadable bzip2 archive', async () => {
    const stream = Buffer.from(compressBzip2(tarOf(['a.txt'])));
    stream[stream.length - 9] ^= 0xff;
    const padded = Buffer.concat([stream, Buffer.alloc(1024, 0x41)]);
    await expect(inspectArchive(padded, { filename: 'bad.tar.bz2' })).rejects.toThrow('Failed to decompress bzip2 archive.');
  });
});
