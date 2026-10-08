import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { compressLzma2Async, compressLzmaAsync, compressLzma2, compressLzma } from '../src/lib/conversions/lzma-encoder';
import { compressZstd, compressZstdAsync, ZSTD_POOL_MIN_LEVEL } from '../src/lib/conversions/zstd';
import { create7zArchive, create7zArchiveAsync, extract7zArchive, packXz, packXzAsync } from '../src/lib/conversions/archive';
import { shutdownCpuPool } from '../src/lib/workers/cpu-pool';
import { getOracleToolPath } from './helpers/differential-oracle';
import { oracleTest } from './helpers/oracle-test';
import { sourceText, zipfText } from './helpers/archive-corpus';

/**
 * The pool variants of the pure encoders must hand back the bytes of the synchronous ones: the thread runs the same
 * code, so any difference is a transport bug. Outputs are also read by the reference tools (xz, zstd, 7z).
 */
const TEXT_BYTES = 300 * 1024;
const NATIVE_7Z_BYTES = 2 * 1024 * 1024;
const TEST_TIMEOUT_MS = 300_000;
/** Path that is absolute and absent: get7zBinaryPath() then reports that no 7-Zip is installed. */
const NO_SEVEN_ZIP = '/nonexistent/easyconvert-no-7z';

afterAll(async () => {
  await shutdownCpuPool();
});

function withoutSevenZip<T>(run: () => Promise<T>): Promise<T> {
  const saved = { p7zip: process.env.P7ZIP_PATH, p7z: process.env.P7Z_PATH };
  process.env.P7ZIP_PATH = NO_SEVEN_ZIP;
  delete process.env.P7Z_PATH;
  return run().finally(() => {
    if (saved.p7zip === undefined) delete process.env.P7ZIP_PATH;
    else process.env.P7ZIP_PATH = saved.p7zip;
    if (saved.p7z !== undefined) process.env.P7Z_PATH = saved.p7z;
  });
}

describe('pool variants of the pure compressors equal the synchronous encoders', () => {
  it('compressLzma2Async returns the bytes and properties of compressLzma2', async () => {
    const input = zipfText(TEXT_BYTES, 11);
    const viaPool = await compressLzma2Async(input, { level: 6 });
    const direct = compressLzma2(input, { level: 6 });
    expect(viaPool.buffer.equals(direct.buffer)).toBe(true);
    expect(viaPool.props.equals(direct.props)).toBe(true);
    expect(viaPool.uncompressedSize).toBe(input.length);
  }, TEST_TIMEOUT_MS);

  it('compressLzmaAsync returns the bytes and properties of compressLzma', async () => {
    const input = sourceText(TEXT_BYTES, 12);
    const viaPool = await compressLzmaAsync(input, { level: 3 });
    const direct = compressLzma(input, { level: 3 });
    expect(viaPool.buffer.equals(direct.buffer)).toBe(true);
    expect(viaPool.props.equals(direct.props)).toBe(true);
  }, TEST_TIMEOUT_MS);

  it('packXzAsync returns the stream of packXz', async () => {
    const input = zipfText(TEXT_BYTES, 13);
    const viaPool = await packXzAsync(input, { compressionLevel: 4 });
    expect(viaPool.equals(packXz(input, { compressionLevel: 4 }))).toBe(true);
  }, TEST_TIMEOUT_MS);

  oracleTest('the xz stream built on a pool thread decodes with `xz -dc`', ['xz'], async () => {
    const input = zipfText(TEXT_BYTES, 14);
    const viaPool = await packXzAsync(input, { compressionLevel: 6 });
    const restored = execFileSync(getOracleToolPath('xz')!, ['-dc'], { input: viaPool, maxBuffer: 1 << 28 });
    expect(restored.equals(input)).toBe(true);
  }, TEST_TIMEOUT_MS);

  it('compressZstdAsync equals compressZstd at a level that runs on the pool and at one that runs inline', async () => {
    const input = sourceText(TEXT_BYTES, 15);
    expect(ZSTD_POOL_MIN_LEVEL).toBe(10);
    for (const level of [3, ZSTD_POOL_MIN_LEVEL, 19]) {
      const viaPool = await compressZstdAsync(input, { level });
      expect(viaPool.equals(compressZstd(input, { level }))).toBe(true);
    }
  }, TEST_TIMEOUT_MS);

  oracleTest('a level-19 frame built on a pool thread decodes with `zstd -dc`', ['zstd'], async () => {
    const input = sourceText(TEXT_BYTES, 16);
    const frame = await compressZstdAsync(input, { level: 19 });
    const restored = execFileSync(getOracleToolPath('zstd')!, ['-dc'], { input: frame, maxBuffer: 1 << 28 });
    expect(restored.equals(input)).toBe(true);
  }, TEST_TIMEOUT_MS);

  it('an invalid zstd level is rejected with the same typed error on the pool path', async () => {
    await expect(compressZstdAsync(sourceText(TEXT_BYTES, 17), { level: 23 })).rejects.toThrow(/Unsupported zstd compression level 23/);
  });
});

describe('create7zArchiveAsync', () => {
  const files = [
    { filename: 'src/a.ts', buffer: sourceText(TEXT_BYTES, 21) },
    { filename: 'notes/b.txt', buffer: zipfText(TEXT_BYTES, 22) },
    { filename: 'tiny.txt', buffer: Buffer.from('tiny\n') },
  ];

  it('without 7-Zip it equals the synchronous pure archive', async () => {
    await withoutSevenZip(async () => {
      const viaPool = await create7zArchiveAsync(files, { compressionLevel: 5 }, 'out.7z');
      expect(viaPool.buffer.equals(create7zArchive(files, { compressionLevel: 5 }, 'out.7z').buffer)).toBe(true);
      expect(viaPool.filename).toBe('out.7z');
    });
  }, TEST_TIMEOUT_MS);

  oracleTest('the pure archive built on pool threads passes `7z t`', ['7z'], async () => {
    await withoutSevenZip(async () => {
      const viaPool = await create7zArchiveAsync(files, { compressionLevel: 5, solid: true }, 'out.7z');
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pool7z-'));
      const file = path.join(dir, 'pure.7z');
      fs.writeFileSync(file, viaPool.buffer);
      const out = execFileSync(getOracleToolPath('7z')!, ['t', '-y', file], { encoding: 'utf8' });
      expect(out).toMatch(/Everything is Ok/);
      const restored = extract7zArchive(viaPool.buffer);
      expect(restored.map((f) => f.filename).sort()).toEqual(files.map((f) => f.filename).sort());
      for (const f of files) expect(restored.find((r) => r.filename === f.filename)!.buffer.equals(f.buffer)).toBe(true);
    });
  }, TEST_TIMEOUT_MS);

  oracleTest('with 7-Zip a large archive is written by 7-Zip (LZMA2) and passes `7z t` with identical contents', ['7z'], async () => {
    const large = [
      { filename: 'big/one.txt', buffer: zipfText(NATIVE_7Z_BYTES, 31) },
      { filename: 'big/two.ts', buffer: sourceText(NATIVE_7Z_BYTES / 2, 32) },
    ];
    const archive = await create7zArchiveAsync(large, { compressionLevel: 6 }, 'native.7z');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'native7z-'));
    const file = path.join(dir, 'native.7z');
    fs.writeFileSync(file, archive.buffer);
    const sevenZip = getOracleToolPath('7z')!;
    expect(execFileSync(sevenZip, ['t', '-y', file], { encoding: 'utf8' })).toMatch(/Everything is Ok/);
    // The listing names the LZMA2 method and the entries that were asked for.
    const listing = execFileSync(sevenZip, ['l', '-slt', file], { encoding: 'utf8' });
    expect(listing).toMatch(/Method = LZMA2:\d+/);
    for (const f of large) {
      const out = execFileSync(sevenZip, ['x', '-so', '-y', file, f.filename], { maxBuffer: 1 << 28 });
      expect(out.equals(f.buffer)).toBe(true);
    }
    expect(archive.size).toBe(archive.buffer.length);
    expect(archive.mimeType).toBe('application/x-7z-compressed');
    expect(archive.filename).toBe('native.7z');
  }, TEST_TIMEOUT_MS);

  oracleTest('with 7-Zip a stored (level 0) archive stays on the pure writer and is byte-identical to it', ['7z'], async () => {
    const stored = await create7zArchiveAsync(files, { compressionLevel: 0 }, 'stored.7z');
    expect(stored.buffer.equals(create7zArchive(files, { compressionLevel: 0 }, 'stored.7z').buffer)).toBe(true);
  }, TEST_TIMEOUT_MS);
});
