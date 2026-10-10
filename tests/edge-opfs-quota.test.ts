import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';

// A pass-through spy on the inflater factory, so a test can see how many times a conversion started one: a
// retry in memory after a storage failure would create a second.
vi.mock('../src/lib/edge/workers/opfs-archive', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/edge/workers/opfs-archive')>();
  return { ...actual, createGunzipTarTransformer: vi.fn(actual.createGunzipTarTransformer) };
});

import { getEffectiveMaxFileSize } from '../src/lib/client-converter';
import { OPFS_MAX_FILE_BYTES } from '../src/lib/edge/opfs/limits';
import { createGunzipTarTransformer, OPFS_MAX_DECOMPRESSED_BYTES } from '../src/lib/edge/workers/opfs-archive';
import { EdgeStorageQuotaError, EdgeUnsupportedError, rehydrateWorkerError } from '../src/lib/edge/workers/worker-errors';
import { DecompressionLimitError } from '../src/lib/types';
import { mulberry32 } from './helpers/audio-signals';
import { craftEntry, END_OF_ARCHIVE } from './helpers/tar-craft';
import { failure, runOpfsConversion, runOpfsFailure } from './helpers/opfs-run';

const MIB = 1024 * 1024;

/** A tar whose single entry is `bytes` zero bytes: a few KiB when gzipped, so a small file inflates to a lot. */
function zeroTar(bytes: number): Buffer {
  return Buffer.concat([craftEntry('zeros.bin', Buffer.alloc(bytes)), END_OF_ARCHIVE]);
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.mocked(createGunzipTarTransformer).mockClear();
});

describe('a storage failure ends the conversion instead of restarting it in memory (issue #480)', () => {
  const BOMB = gzipSync(zeroTar(24 * MIB));

  it('reports a full quota during inflation as a typed error the router escalates', async () => {
    expect(BOMB.length).toBeLessThan(64 * 1024);
    const { error, fake, jobId } = await runOpfsFailure('sync-access-handle', 'gz', 'tar', BOMB, undefined, {
      quotaBytes: 6 * MIB,
    });

    expect(error).toBeInstanceOf(EdgeStorageQuotaError);
    expect(error).toBeInstanceOf(EdgeUnsupportedError);
    expect(error.message).toMatch(/storage quota/);
    // One inflater ran: the conversion was not started again over the in-memory path.
    expect(createGunzipTarTransformer).toHaveBeenCalledTimes(1);
    // What was written stayed inside the quota, and nothing of the conversion is left on disk.
    expect(fake.usedBytes()).toBe(0);
    expect(await fake.sessionFiles(jobId)).toEqual([]);
  });

  it('reports a full quota while compressing as the same typed error', async () => {
    const next = mulberry32(5);
    const noise = Buffer.from(Array.from({ length: 3 * MIB }, () => Math.floor(next() * 256)));
    const tar = Buffer.concat([craftEntry('noise.bin', noise), END_OF_ARCHIVE]);
    const { error, fake, jobId } = await runOpfsFailure('sync-access-handle', 'tar', 'tar_gz', tar, undefined, {
      quotaBytes: 4 * MIB,
    });
    expect(error).toBeInstanceOf(EdgeStorageQuotaError);
    expect(await fake.sessionFiles(jobId)).toEqual([]);
  });

  it('keeps the error class across the worker boundary', () => {
    const rebuilt = rehydrateWorkerError({ name: 'EdgeStorageQuotaError', message: 'the origin storage quota is used up' });
    expect(rebuilt).toBeInstanceOf(EdgeStorageQuotaError);
    expect(rebuilt.message).toBe('the origin storage quota is used up');
  });

  it('still converts in memory when the runtime has no sync access handle at all', async () => {
    const tar = zeroTar(4096);
    const { bytes } = await runOpfsConversion('sync-access-handle', 'tar', 'gz', tar, undefined, { syncAccess: false, expectsFallback: true });
    expect(Array.from(bytes.subarray(0, 3))).toEqual([0x1f, 0x8b, 0x08]);
  });

  it('still converts in memory when the storage cannot be opened before any data is read', async () => {
    const { bytes } = await runOpfsConversion('sync-access-handle', 'csv', 'tsv', Buffer.from('a,b\n1,2\n'), undefined, {
      getDirectoryFails: 'SecurityError',
      expectsFallback: true,
    });
    expect(bytes.toString('utf8')).toBe('a\tb\r\n1\t2');
  });

  it('never inflates in memory: with no sync access handle a gzip to tar conversion goes to the server', async () => {
    const { error } = await runOpfsFailure('sync-access-handle', 'gz', 'tar', gzipSync(zeroTar(4096)), undefined, {
      syncAccess: false,
    });
    expect(error).toBeInstanceOf(EdgeUnsupportedError);
    expect(error.message).toMatch(/Inflating/);
    expect(createGunzipTarTransformer).not.toHaveBeenCalled();
  });

  it('never inflates in memory on the plain in-memory route either', async () => {
    const error = await failure(runOpfsConversion('chunk-fallback', 'tar_gz', 'tar', gzipSync(zeroTar(4096))));
    expect(error).toBeInstanceOf(EdgeUnsupportedError);
    expect(error.message).toMatch(/Inflating/);
  });
});

describe('inflation is capped at the largest file the edge accepts, and a failure leaves no output (issue #480)', () => {
  it('derives the cap from the effective file size limit', () => {
    vi.stubGlobal('window', {});
    vi.stubGlobal('navigator', { storage: { getDirectory: async () => ({}) } });
    expect(OPFS_MAX_DECOMPRESSED_BYTES).toBe(OPFS_MAX_FILE_BYTES);
    expect(getEffectiveMaxFileSize()).toBe(OPFS_MAX_FILE_BYTES);
    expect(OPFS_MAX_FILE_BYTES).toBe(2 * 1024 * MIB);
  });

  it('stops a bomb above the cap with DecompressionLimitError and deletes the partial output', async () => {
    const { error, fake, jobId } = await runOpfsFailure('sync-access-handle', 'gz', 'tar', gzipSync(zeroTar(8 * MIB)), undefined, {
      maxOutputBytes: 2 * MIB,
    });
    expect(error).toBeInstanceOf(DecompressionLimitError);
    expect(error.message).toContain(`${2 * MIB} bytes`);
    expect(await fake.sessionFiles(jobId)).toEqual([]);
    expect(fake.usedBytes()).toBe(0);
  });

  it('cannot be raised above the file size limit by the job', async () => {
    const { bytes } = await runOpfsConversion('sync-access-handle', 'gz', 'tar', gzipSync(zeroTar(3 * MIB)), undefined, {
      maxOutputBytes: Number.MAX_SAFE_INTEGER,
    });
    expect(bytes.length).toBe(zeroTar(3 * MIB).length);
  });

  it.each([
    ['a damaged gzip stream', 'gz', 'tar', () => gzipSync(zeroTar(4096)).subarray(0, 40)],
    ['bytes that are not a tar', 'tar', 'tar_gz', () => Buffer.alloc(2048, 7)],
  ])('removes the session files after %s', async (_name, source, target, makeInput) => {
    const { error, fake, jobId } = await runOpfsFailure('sync-access-handle', source, target, makeInput());
    expect(error.name).toMatch(/Error$/);
    expect(await fake.sessionFiles(jobId)).toEqual([]);
  });

  it('keeps the output of a conversion that succeeds', async () => {
    const { bytes, fake } = await runOpfsConversion('sync-access-handle', 'gz', 'tar', gzipSync(zeroTar(4096)));
    expect(bytes.length).toBe(zeroTar(4096).length);
    expect(await fake.sessionFiles('job-gz-tar')).toEqual(['output.bin']);
  });

  it('creates an inflater whose cap is the one it was given', async () => {
    const inflater = createGunzipTarTransformer(MIB);
    const bomb = gzipSync(zeroTar(4 * MIB));
    const failureOfDrain = await failure(
      (async () => {
        for await (const _piece of inflater(new Uint8Array(bomb), 0, bomb.length) as AsyncIterable<Uint8Array>) {
          // consumed as the runner would write it
        }
      })()
    );
    expect(failureOfDrain).toMatchObject({ name: 'DecompressionLimitError', message: expect.stringContaining(`${MIB} bytes`) });
  });
});
