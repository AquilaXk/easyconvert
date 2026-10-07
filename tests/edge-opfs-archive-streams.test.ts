import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CorruptStreamError, DecompressionLimitError } from '../src/lib/types';
import { OPFS_CHUNK_SIZE, runOpfsWorkerJob } from '../src/lib/edge/workers/opfs-vfs.worker';
import { EdgeUnsupportedError, rehydrateWorkerError } from '../src/lib/edge/workers/worker-errors';
import { isOpfsStreamingSupported, resolveConversionTier } from '../src/lib/edge/tier-router';
import { oracleTest } from './helpers/oracle-test';
import { failure, OPFS_ROUTES, runOpfsConversion, type OpfsRoute } from './helpers/opfs-run';
import { mulberry32 } from './helpers/audio-signals';
import { craftEntry, END_OF_ARCHIVE, craftHeader } from './helpers/tar-craft';
import { walkTar } from './helpers/tar-walker';

const MIB = 1024 * 1024;

/** Deterministic text-like bytes that deflate well, so the compressed size differs visibly from the input. */
function compressibleBytes(length: number, seed: number): Buffer {
  const next = mulberry32(seed);
  const out = Buffer.alloc(length);
  for (let i = 0; i < length; i++) out[i] = 97 + Math.floor(next() * 4);
  return out;
}

function makeTar(entries: Array<[string, Buffer]>): Buffer {
  return Buffer.concat([...entries.map(([name, data]) => craftEntry(name, data)), END_OF_ARCHIVE]);
}

const SMALL_TAR = makeTar([
  ['notes.txt', Buffer.from('first entry\n')],
  ['data/blob.bin', compressibleBytes(3000, 7)],
]);
/** Three 4 MiB-class entries: the archive spans more than two OPFS chunks. */
const LARGE_TAR = makeTar([
  ['a.bin', compressibleBytes(3 * MIB, 1)],
  ['b.bin', compressibleBytes(3 * MIB, 2)],
  ['c.bin', compressibleBytes(3 * MIB, 3)],
]);

const convert = runOpfsConversion;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe.each<OpfsRoute>(OPFS_ROUTES)('OPFS archive streams, %s (issue #480)', (route) => {
  it.each([
    ['tar', 'tar_gz'],
    ['tar', 'gz'],
  ])('%s to %s writes a gzip member that inflates to the source tar', async (source, target) => {
    const { bytes } = await convert(route, source, target, SMALL_TAR);

    expect(Array.from(bytes.subarray(0, 3))).toEqual([0x1f, 0x8b, 0x08]);
    // node:zlib checks the CRC-32 and ISIZE trailer of RFC 1952.
    const inflated = gunzipSync(bytes);
    expect(inflated.equals(SMALL_TAR)).toBe(true);
    expect(walkTar(inflated).map((entry) => [entry.name, entry.size])).toEqual([
      ['notes.txt', 12],
      ['data/blob.bin', 3000],
    ]);
  });

  it('compresses a multi-chunk tar into one gzip member whose entries all survive', async () => {
    expect(LARGE_TAR.length).toBeGreaterThan(2 * OPFS_CHUNK_SIZE);
    const { bytes } = await convert(route, 'tar', 'tar_gz', LARGE_TAR);

    expect(bytes.length).toBeLessThan(LARGE_TAR.length);
    const inflated = gunzipSync(bytes);
    expect(inflated.equals(LARGE_TAR)).toBe(true);
    expect(walkTar(inflated).map((entry) => entry.name)).toEqual(['a.bin', 'b.bin', 'c.bin']);
  });

  it.each([
    ['gz', 'tar'],
    ['tar_gz', 'tar'],
  ])('%s to %s writes exactly the decompressed tar', async (source, target) => {
    const gz = gzipSync(LARGE_TAR);
    const { bytes } = await convert(route, source, target, gz);

    expect(bytes.equals(LARGE_TAR)).toBe(true);
    expect(walkTar(bytes).map((entry) => entry.name)).toEqual(['a.bin', 'b.bin', 'c.bin']);
  });

  it('refuses a gzip stream whose content is not a tar archive', async () => {
    const notTar = gzipSync(Buffer.from('plain text, not a tar archive\n'.repeat(400)));
    const error = await failure(convert(route, 'gz', 'tar', notTar));
    expect(error).toMatchObject({ name: 'EdgeUnsupportedError', message: expect.stringMatching(/not a POSIX ustar/) });
    expect(error).toBeInstanceOf(EdgeUnsupportedError);
  });

  it('refuses a tar input that is not a tar archive instead of gzipping it', async () => {
    const random = Buffer.from(compressibleBytes(4096, 9));
    const error = await failure(convert(route, 'tar', 'tar_gz', random));
    expect(error).toMatchObject({ name: 'EdgeUnsupportedError', message: expect.stringMatching(/not a POSIX ustar/) });
    expect(error).toBeInstanceOf(EdgeUnsupportedError);
  });

  it('fails a truncated gzip stream with CorruptStreamError', async () => {
    const gz = gzipSync(SMALL_TAR);
    const error = await failure(convert(route, 'gz', 'tar', gz.subarray(0, gz.length - 12)));
    expect(error).toMatchObject({ name: 'CorruptStreamError', message: expect.stringMatching(/gzip stream is damaged/) });
    expect(error).toBeInstanceOf(CorruptStreamError);
  });

  it('fails a gzip stream with a damaged CRC-32 with CorruptStreamError', async () => {
    const gz = Buffer.from(gzipSync(SMALL_TAR));
    gz[gz.length - 8] ^= 0xff;
    const error = await failure(convert(route, 'gz', 'tar', gz));
    expect(error).toMatchObject({ name: 'CorruptStreamError', message: expect.stringMatching(/gzip stream is damaged/) });
    expect(error).toBeInstanceOf(CorruptStreamError);
  });

  it('fails a tar cut inside an entry body with CorruptStreamError', async () => {
    const cut = SMALL_TAR.subarray(0, 512 + 100);
    const direct = await failure(convert(route, 'tar', 'tar_gz', cut));
    expect(direct).toMatchObject({ name: 'CorruptStreamError', message: expect.stringMatching(/ends inside an entry/) });
    const viaGzip = await failure(convert(route, 'gz', 'tar', gzipSync(cut)));
    expect(viaGzip).toMatchObject({ name: 'CorruptStreamError', message: expect.stringMatching(/ends inside an entry/) });
  });

  it('fails a tar with no end-of-archive marker with CorruptStreamError', async () => {
    const noEnd = SMALL_TAR.subarray(0, SMALL_TAR.length - 1024);
    const error = await failure(convert(route, 'tar', 'tar_gz', noEnd));
    expect(error).toMatchObject({ name: 'CorruptStreamError', message: expect.stringMatching(/end-of-archive marker is missing/) });
  });

  it('fails a tar whose second header has a bad checksum with CorruptStreamError', async () => {
    const second = SMALL_TAR.indexOf(Buffer.from('data/blob.bin'));
    const damaged = Buffer.from(SMALL_TAR);
    damaged[second + 5] ^= 0x01;
    const error = await failure(convert(route, 'tar', 'tar_gz', damaged));
    expect(error).toMatchObject({ name: 'CorruptStreamError', message: expect.stringMatching(/entry 2 has a wrong header checksum/) });
  });

  it('fails a tar followed by non-zero bytes after the end marker with CorruptStreamError', async () => {
    const trailing = Buffer.concat([SMALL_TAR, craftHeader({ name: 'late', typeflag: '0', size: 0 })]);
    const error = await failure(convert(route, 'tar', 'tar_gz', trailing));
    expect(error).toMatchObject({ name: 'CorruptStreamError', message: expect.stringMatching(/follows the end-of-archive marker/) });
  });
});

describe('OPFS archive write sizes (issue #480)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('writes the decompressed tar in pieces no larger than one OPFS chunk', async () => {
    const { maxWrite } = await convert('sync-access-handle', 'gz', 'tar', gzipSync(LARGE_TAR));
    // The input copy is one 4 MiB window and the output is written as the inflater produces it.
    expect(maxWrite).toBeLessThanOrEqual(OPFS_CHUNK_SIZE);
  });
});

describe('OPFS archive limits and typed errors (issue #480)', () => {
  it('stops a gzip stream that inflates past the output cap with DecompressionLimitError', async () => {
    const { createGunzipTarTransformer } = await import('../src/lib/edge/workers/opfs-archive');
    const bomb = gzipSync(Buffer.alloc(4 * MIB));
    const transform = createGunzipTarTransformer(MIB);
    const result = transform(new Uint8Array(bomb), 0, bomb.length) as AsyncIterable<Uint8Array>;
    let written = 0;
    const error = await failure(
      (async () => {
        for await (const piece of result) written += piece.byteLength;
      })()
    );
    expect(error).toMatchObject({
      name: 'DecompressionLimitError',
      status: 413,
      message: expect.stringContaining(`${MIB} bytes`),
    });
    expect(error).toBeInstanceOf(DecompressionLimitError);
    // Pieces up to the cap may already be written; none past it.
    expect(written).toBeLessThanOrEqual(MIB);
  });

  it('sends CorruptStreamError across the worker boundary and rebuilds the class', async () => {
    const gz = gzipSync(SMALL_TAR);
    const messages: Array<Record<string, unknown>> = [];
    await runOpfsWorkerJob(
      {
        type: 'START_OPFS_STREAM',
        jobId: 'job-corrupt',
        sourceFormat: 'gz',
        targetFormat: 'tar',
        totalSize: gz.length - 12,
        file: new Blob([gz.subarray(0, gz.length - 12) as BlobPart]),
      },
      (message) => messages.push(message)
    );
    const failures = messages.filter((message) => message.type === 'ERROR');
    expect(failures).toHaveLength(1);
    expect(failures[0].error).toMatchObject({ name: 'CorruptStreamError', message: expect.stringContaining('gzip') });
    const rebuilt = rehydrateWorkerError(failures[0].error);
    expect(rebuilt).toBeInstanceOf(CorruptStreamError);
    expect(rebuilt.message).toBe((failures[0].error as { message: string }).message);
  });

  it('keeps the archive pairs on the OPFS tier only for the pairs that are implemented', () => {
    for (const [source, target] of [
      ['tar', 'tar_gz'],
      ['tar', 'gz'],
      ['gz', 'tar'],
      ['tar_gz', 'tar'],
    ]) {
      expect(isOpfsStreamingSupported(source, target)).toBe(true);
      const tier = resolveConversionTier(source, target, 200 * MIB, {}, { hasOpfsSyncAccess: true });
      expect(tier.tier).toBe('L3');
    }
  });
});

describe('OPFS archive streams against the reference tools (issue #480)', () => {
  oracleTest('tar lists the entries of the compressed output', ['tar'], async () => {
    const { bytes } = await convert('chunk-fallback', 'tar', 'tar_gz', SMALL_TAR);
    const dir = mkdtempSync(path.join(os.tmpdir(), 'opfs-archive-'));
    try {
      const file = path.join(dir, 'out.tar.gz');
      writeFileSync(file, bytes);
      const listing = spawnSync('tar', ['-tzf', file], { encoding: 'utf8' });
      expect(listing.status).toBe(0);
      expect(listing.stdout.trim().split('\n')).toEqual(['notes.txt', 'data/blob.bin']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
