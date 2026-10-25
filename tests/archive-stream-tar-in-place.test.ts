import zlib from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readTarEntries } from '../src/lib/conversions/archive';
import { consumeUnpackedAsVettedTar, streamToTar, tarFromEntries, type TarPolicyRequest } from '../src/lib/conversions/archive-stream';
import { hostileTarEnd, hostileTarMember } from './helpers/hostile-tar';

const BLOCK = 512;
const GNU_LONG_NAME_BYTES = 505;
const KEEP_LAST_DUPLICATE: TarPolicyRequest = { collisionPolicy: 'overwrite' };

function referenceTarFromCopy(tar: Buffer): Buffer {
  return Buffer.concat(tarFromEntries(readTarEntries(Buffer.from(tar), { ignoreLinks: true })));
}

function consume(tar: Buffer, request: TarPolicyRequest = {}): { unpacked: Buffer; segments: Uint8Array[] } {
  const unpacked = Buffer.from(tar);
  return { unpacked, segments: consumeUnpackedAsVettedTar(unpacked, tar.length, request).segments };
}

function paxRecord(key: string, value: string): Buffer {
  let length = key.length + value.length + 3;
  let record = `${length} ${key}=${value}\n`;
  while (record.length !== length) {
    length = record.length;
    record = `${length} ${key}=${value}\n`;
  }
  return Buffer.from(record);
}

function gnuLongName(name: string): Buffer {
  return hostileTarMember({ name: '././@LongLink', typeflag: 'L' }, Buffer.from(`${name}\0`));
}

function expectLayoutChanged(tar: Buffer): void {
  const expected = referenceTarFromCopy(tar);
  const { unpacked, segments } = consume(tar, KEEP_LAST_DUPLICATE);

  expect(segments.length).toBeGreaterThan(1);
  expect(Buffer.concat(segments).equals(expected)).toBe(true);
  expect(unpacked.equals(tar)).toBe(true);
}

function pooledCopy(bytes: Buffer): Buffer {
  let probe = Buffer.allocUnsafe(1);
  for (let attempt = 0; probe.byteOffset !== 0 && attempt < Buffer.poolSize; attempt++) probe = Buffer.allocUnsafe(1);
  const copy = Buffer.allocUnsafe(bytes.length);
  bytes.copy(copy);
  return copy;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('consumeUnpackedAsVettedTar', () => {
  it('writes new headers over the old ones when every entry keeps its place, without a second copy of the bodies', () => {
    const tar = Buffer.concat([
      hostileTarMember({ name: 'a.txt', mode: 0o4755, magic: 'ustar ', version: ' \0', prefix: 'ignored' }, Buffer.from('first body')),
      hostileTarMember({ name: 'dir/', typeflag: '5' }),
      hostileTarMember({ name: 'empty.txt' }),
      hostileTarMember({ name: 'b.bin' }, Buffer.alloc(1500, 7)),
      hostileTarEnd(),
    ]);
    const expected = referenceTarFromCopy(tar);
    expect(expected.equals(tar)).toBe(false);

    const { unpacked, segments } = consume(tar);

    expect(segments).toHaveLength(1);
    expect(segments[0].buffer).toBe(unpacked.buffer);
    expect(Buffer.concat(segments).equals(expected)).toBe(true);
  });

  it('keeps the fast path when the unpacked bytes sit in a pooled buffer that the rewritten headers share', () => {
    const canonical = referenceTarFromCopy(
      Buffer.concat([gnuLongName('n'.repeat(130)), hostileTarMember({ name: 'short' }, Buffer.from('body')), hostileTarEnd()])
    );
    const unpacked = pooledCopy(canonical);
    expect(unpacked.buffer.byteLength).toBe(Buffer.poolSize);

    const { segments } = consumeUnpackedAsVettedTar(unpacked, canonical.length, {});

    expect(segments).toHaveLength(1);
    expect(segments[0].buffer).toBe(unpacked.buffer);
    expect(Buffer.concat(segments).equals(canonical)).toBe(true);
  });

  it('leaves out what follows the end-of-archive blocks', () => {
    const tar = Buffer.concat([
      hostileTarMember({ name: 'a.txt' }, Buffer.from('visible')),
      hostileTarEnd(),
      hostileTarMember({ name: 'hidden.txt' }, Buffer.from('HIDDEN')),
      hostileTarEnd(),
    ]);
    const expected = referenceTarFromCopy(tar);

    const { segments } = consume(tar);

    expect(Buffer.concat(segments).equals(expected)).toBe(true);
    expect(Buffer.concat(segments).includes('HIDDEN')).toBe(false);
    expect(Buffer.concat(segments)).toHaveLength(BLOCK + BLOCK + 2 * BLOCK);
  });

  it('gives the segments back, and writes nothing over the unpacked bytes, when a repeated name drops an entry', () => {
    expectLayoutChanged(
      Buffer.concat([
        hostileTarMember({ name: 'dup.txt' }, Buffer.from('first')),
        hostileTarMember({ name: 'keep.txt' }, Buffer.from('kept')),
        hostileTarMember({ name: 'dup.txt', magic: 'ustar ', version: ' \0' }, Buffer.from('second')),
        hostileTarEnd(),
      ])
    );
  });

  it('gives the segments back when links are left out', () => {
    const tar = Buffer.concat([
      hostileTarMember({ name: 'a.txt' }, Buffer.from('body')),
      hostileTarMember({ name: 'link', typeflag: '2', linkname: 'a.txt' }),
      hostileTarMember({ name: 'b.txt' }, Buffer.from('other')),
      hostileTarEnd(),
    ]);
    const expected = referenceTarFromCopy(tar);

    const { unpacked, segments } = consume(tar, { skipLinks: true });

    expect(segments.length).toBeGreaterThan(1);
    expect(Buffer.concat(segments).equals(expected)).toBe(true);
    expect(unpacked.equals(tar)).toBe(true);
  });

  it('gives the segments back when an entry is dropped for a name that sanitises to nothing', () => {
    expectLayoutChanged(
      Buffer.concat([
        hostileTarMember({ name: 'a.txt' }, Buffer.from('kept')),
        hostileTarMember({ name: '.' }, Buffer.alloc(1200, 9)),
        hostileTarMember({ name: 'b.txt' }, Buffer.from('also kept')),
        hostileTarEnd(),
      ])
    );
  });

  it('gives the segments back when the tar ends before its end-of-archive blocks', () => {
    const tar = hostileTarMember({ name: 'a.txt' }, Buffer.from('body'));
    const expected = referenceTarFromCopy(tar);
    expect(expected.length).toBeGreaterThan(tar.length);

    const { unpacked, segments } = consume(tar);

    expect(Buffer.concat(segments).equals(expected)).toBe(true);
    expect(unpacked.equals(tar)).toBe(true);
  });

  it('gives the segments back when a name over 100 characters grows the header block count', () => {
    expectLayoutChanged(
      Buffer.concat([
        hostileTarMember({ name: 'a.txt' }, Buffer.from('x')),
        gnuLongName('n'.repeat(GNU_LONG_NAME_BYTES)),
        hostileTarMember({ name: 'short' }, Buffer.from('y')),
        hostileTarEnd(),
      ])
    );
  });

  it('gives the segments back when a pax extended header is dropped and every body shifts', () => {
    expectLayoutChanged(
      Buffer.concat([
        hostileTarMember({ name: 'pax', typeflag: 'x' }, paxRecord('mtime', '1600000000')),
        hostileTarMember({ name: 'a.txt' }, Buffer.from('first body')),
        hostileTarMember({ name: 'b.txt' }, Buffer.from('second body')),
        hostileTarEnd(),
      ])
    );
  });

  it('writes into a view of a larger buffer at the view, not at the start of its memory', () => {
    const tar = Buffer.concat([hostileTarMember({ name: 'a.txt', magic: 'ustar ', version: ' \0' }, Buffer.from('body')), hostileTarEnd()]);
    const expected = referenceTarFromCopy(tar);
    const frame = Buffer.concat([Buffer.alloc(300, 0xaa), tar, Buffer.alloc(700, 0xbb)]);
    const unpacked = frame.subarray(300, 300 + tar.length);

    const { segments } = consumeUnpackedAsVettedTar(unpacked, tar.length, {});

    expect(Buffer.concat(segments).equals(expected)).toBe(true);
    expect(frame.subarray(0, 300).every((byte) => byte === 0xaa)).toBe(true);
    expect(frame.subarray(300 + tar.length).every((byte) => byte === 0xbb)).toBe(true);
  });
});

describe('gzip to tar', () => {
  function captureGunzip(): () => Buffer {
    const gunzip = zlib.gunzip;
    let decompressed: Buffer | undefined;
    vi.spyOn(zlib, 'gunzip').mockImplementation(((input: Buffer, options: object, callback: (error: Error | null, result: Buffer) => void) =>
      gunzip(input, options, (error, result) => {
        decompressed = result;
        callback(error, result);
      })) as never);
    return () => decompressed as Buffer;
  }

  function gzipToTar(tar: Buffer): Promise<{ segments: Uint8Array[] } | null> {
    return streamToTar({
      ...KEEP_LAST_DUPLICATE,
      compressor: 'gzip',
      source: { buffer: zlib.gzipSync(tar) },
      p7zBin: '',
      originalFilename: 'sample.tar.gz',
      timeoutMs: 10_000,
    });
  }

  it('returns the decompressed buffer itself, rewritten, for a tar that keeps its layout', async () => {
    const tar = Buffer.concat([
      hostileTarMember({ name: 'a.txt', magic: 'ustar ', version: ' \0' }, Buffer.from('first body')),
      hostileTarMember({ name: 'b.bin' }, Buffer.alloc(1500, 7)),
      hostileTarEnd(),
    ]);
    const decompressed = captureGunzip();

    const result = await gzipToTar(tar);

    expect(result?.segments).toHaveLength(1);
    expect(result?.segments[0].buffer).toBe(decompressed().buffer);
    expect(Buffer.concat(result?.segments ?? []).equals(referenceTarFromCopy(tar))).toBe(true);
  });

  it('returns the joined segments, and leaves the decompressed buffer alone, for a tar whose layout changes', async () => {
    const tar = Buffer.concat([
      hostileTarMember({ name: 'dup.txt' }, Buffer.from('first')),
      hostileTarMember({ name: 'keep.txt' }, Buffer.from('kept')),
      hostileTarMember({ name: 'dup.txt' }, Buffer.from('second')),
      hostileTarEnd(),
    ]);
    const decompressed = captureGunzip();

    const result = await gzipToTar(tar);

    expect(result?.segments.length).toBeGreaterThan(1);
    expect(Buffer.concat(result?.segments ?? []).equals(referenceTarFromCopy(tar))).toBe(true);
    expect(decompressed().equals(tar)).toBe(true);
  });
});
