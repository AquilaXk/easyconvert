import { afterEach, describe, expect, it, vi } from 'vitest';
import zlib from 'node:zlib';
import { createZipArchive } from '../src/lib/conversions/archive';
import { createZipBuffer, zipDeflateAheadEntries } from '../src/lib/conversions/zip-writer';
import * as availableCpusModule from '../src/lib/workers/available-cpus';
import { jsonRecords, proseText, SeededRandom, sha256Hex } from './helpers/archive-corpus';

const KIBIBYTE = 1024;

function inputFiles(): { filename: string; buffer: Buffer }[] {
  const random = new SeededRandom(99);
  return Array.from({ length: 14 }, (_, index) => ({
    filename: `dir${index % 3}/file${String(index).padStart(2, '0')}.${index % 4 === 3 ? 'dat' : 'txt'}`,
    // sizes from 1 KiB to a few hundred KiB, text and noise, so the jobs finish in an order unlike the entry order
    buffer: index % 4 === 3 ? random.bytes((index + 1) * 23 * KIBIBYTE) : index % 2 ? jsonRecords((15 - index) * 31 * KIBIBYTE, index) : proseText((index + 1) * 17 * KIBIBYTE, index),
  }));
}

/** Names in central directory order. */
function centralNames(archive: Buffer): string[] {
  const end = archive.length - 22;
  const count = archive.readUInt16LE(end + 10);
  let at = archive.readUInt32LE(end + 16);
  const names: string[] = [];
  for (let i = 0; i < count; i++) {
    const nameLength = archive.readUInt16LE(at + 28);
    names.push(archive.subarray(at + 46, at + 46 + nameLength).toString('utf8'));
    at += 46 + nameLength + archive.readUInt16LE(at + 30) + archive.readUInt16LE(at + 32);
  }
  return names;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('createZipArchive deflates entries ahead', () => {
  it('lists the entries in input order, folders ahead of their files, and gives the same bytes on every run', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-03-04T05:06:08'));
    const files = inputFiles();
    const first = (await createZipArchive(files, {}, 'a.zip')).buffer;
    const runs = await Promise.all([createZipArchive(files, {}, 'a.zip'), createZipArchive(files, {}, 'a.zip')]);
    expect(runs[0].buffer.equals(first)).toBe(true);
    expect(runs[1].buffer.equals(first)).toBe(true);
    const names = centralNames(first);
    expect(names.filter((name) => !name.endsWith('/'))).toEqual(files.map((file) => file.filename));
    for (const [index, name] of names.entries()) {
      if (name.endsWith('/')) continue;
      const parent = name.slice(0, name.lastIndexOf('/') + 1);
      expect(names.indexOf(parent)).toBeGreaterThanOrEqual(0);
      expect(names.indexOf(parent)).toBeLessThan(index);
    }
  });

  it('writes the bytes a sequential deflate of every entry writes', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-03-04T05:06:08'));
    const files = inputFiles();
    const ahead = (await createZipArchive(files, {}, 'a.zip')).buffer;
    // the same entries through the writer's default one-at-a-time deflater
    const sequentialEntries = [];
    const emitted = new Set<string>();
    for (const file of files) {
      const folder = `${file.filename.split('/')[0]}/`;
      if (!emitted.has(folder)) {
        emitted.add(folder);
        sequentialEntries.push({ name: folder, mtime: new Date() });
      }
      sequentialEntries.push({ name: file.filename, data: file.buffer, level: 6, mtime: new Date() });
    }
    const sequential = await createZipBuffer(sequentialEntries);
    expect(sha256Hex(ahead)).toBe(sha256Hex(sequential));
  });

  it('runs no more entries ahead than the cores the container may use, and at most the pool', () => {
    const cpus = vi.spyOn(availableCpusModule, 'availableCpus');
    for (const [cores, expected] of [[1, 1], [2, 2], [4, 4], [64, 4]] as const) {
      cpus.mockReturnValue(cores);
      expect(zipDeflateAheadEntries()).toBe(expected);
    }
  });

  it('fails with the first deflate error and leaves no unhandled rejection from the entries ahead of it', async () => {
    const unhandled: unknown[] = [];
    const listener = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', listener);
    try {
      vi.spyOn(zlib, 'deflateRaw').mockImplementation(((_data: unknown, _options: unknown, callback: (error: Error | null, result?: Buffer) => void) => {
        callback(new Error('deflate refused'));
      }) as unknown as typeof zlib.deflateRaw);
      vi.spyOn(zlib, 'deflateRawSync').mockImplementation(() => {
        throw new Error('deflate refused');
      });
      const files = Array.from({ length: 12 }, (_, index) => ({ filename: `f${index}.txt`, buffer: proseText(80 * KIBIBYTE, index) }));
      await expect(createZipArchive(files, {}, 'a.zip')).rejects.toThrow('deflate refused');
      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      process.off('unhandledRejection', listener);
    }
    expect(unhandled).toEqual([]);
  });
});
