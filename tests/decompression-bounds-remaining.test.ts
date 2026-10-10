import { beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import zlib from 'node:zlib';
import type { Job } from '@/lib/queue/bullmq-engine';
import { ARCHIVE_SECURITY_LIMITS, convertArchive, extract7zArchive, gunzipStreamingWithLimits, inspectArchive, repairZipArchive } from '../src/lib/conversions/archive';
import { processGraphNodeJob } from '../src/lib/queue/graph/node-executor';
import { s3Storage } from '../src/lib/storage/s3-storage';
import { ConversionFailedError, CorruptStreamError, DecompressionLimitError, type ConversionJobData, type ConversionJobResult } from '../src/lib/types';
import { oracleTest } from './helpers/oracle-test';
import { requireOracleTool } from './helpers/differential-oracle';

const MIB = 1024 * 1024;
/** Decoded size of every bomb: far past what an unbounded decoder could hold without the peak RSS showing it. */
const BOMB_BYTES = 256 * MIB;
/** Peak RSS a bounded decoder may add while it refuses a bomb. An unbounded one adds BOMB_BYTES. */
const MAX_RSS_GROWTH_BYTES = 96 * MIB;
const FAST_REJECTION_MS = 5_000;

/** `totalBytes` of zeros compressed by a zlib stream, produced in blocks so the fixture itself stays small. */
async function compressZeros(totalBytes: number, kind: 'gzip' | 'rawDeflate'): Promise<Buffer> {
  const stream = kind === 'gzip' ? zlib.createGzip({ level: 9 }) : zlib.createDeflateRaw({ level: 9 });
  const parts: Buffer[] = [];
  stream.on('data', (part: Buffer) => parts.push(part));
  const block = Buffer.alloc(MIB);
  for (let written = 0; written < totalBytes; written += block.length) {
    if (!stream.write(block)) await once(stream, 'drain');
  }
  stream.end();
  await once(stream, 'end');
  return Buffer.concat(parts);
}

function peakRssBytes(): number {
  return process.resourceUsage().maxRSS * 1024;
}

interface Outcome {
  error: unknown;
  elapsedMs: number;
  rssGrowth: number;
}

/** Runs `operation`, which must be refused, and returns the error with how long it took and how far the peak RSS grew. */
async function refused(operation: () => Promise<unknown>): Promise<Outcome> {
  const rssBefore = peakRssBytes();
  const started = Date.now();
  let error: unknown;
  try {
    await operation();
  } catch (caught) {
    error = caught;
  }
  return { error, elapsedMs: Date.now() - started, rssGrowth: peakRssBytes() - rssBefore };
}

function expectBombRefused(outcome: Outcome): void {
  expect(outcome.error).toBeInstanceOf(DecompressionLimitError);
  expect((outcome.error as DecompressionLimitError).status).toBe(413);
  expect(outcome.elapsedMs).toBeLessThan(FAST_REJECTION_MS);
  expect(outcome.rssGrowth).toBeLessThan(MAX_RSS_GROWTH_BYTES);
}

function oneFileTar(name: string): Buffer {
  const tar = Buffer.alloc(1024);
  tar.write(name, 0, 'latin1');
  tar.write('0000644\0', 100, 'latin1');
  tar.write('00000000000\0', 124, 'latin1');
  tar.write('0', 156, 'latin1');
  tar.write('ustar\0', 257, 'latin1');
  tar.write('00', 263, 'latin1');
  tar.write('        ', 148, 'latin1');
  let sum = 0;
  for (const byte of tar.subarray(0, 512)) sum += byte;
  tar.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'latin1');
  return tar;
}

describe('decompression bombs are refused as typed 413 errors, fast and with bounded memory', () => {
  // The first inflate in a process allocates its working buffers; that one-off cost is not the refusal being measured.
  let gzipBomb: Buffer;
  let rawDeflateBomb: Buffer;
  beforeAll(async () => {
    await gunzipStreamingWithLimits(await compressZeros(4 * MIB, 'gzip')).catch(() => undefined);
    // Compressed once: building a bomb costs more CPU than refusing it, and CI shards run test files side by side.
    gzipBomb = await compressZeros(BOMB_BYTES, 'gzip');
    rawDeflateBomb = await compressZeros(BOMB_BYTES, 'rawDeflate');
  });

  it('gunzipStreamingWithLimits throws a DecompressionLimitError for a size or ratio bomb', async () => {
    const bomb = gzipBomb;
    expect(BOMB_BYTES / bomb.length).toBeGreaterThan(ARCHIVE_SECURITY_LIMITS.MAX_RATIO * 2);
    expectBombRefused(await refused(() => gunzipStreamingWithLimits(bomb)));
  });

  it('convertArchive refuses a tar.gz and a plain gz bomb', async () => {
    const bomb = gzipBomb;
    for (const source of ['tar.gz', 'tgz', 'gz'] as const) {
      expectBombRefused(await refused(() => convertArchive(bomb, source, 'zip', {}, `bomb.${source}`)));
    }
  });

  it('a corrupt gzip stream stays a plain 400 conversion failure, not a limit error', async () => {
    const corrupt = zlib.gzipSync(Buffer.alloc(4096, 1)).subarray(0, 30);
    const outcome = await refused(() => convertArchive(corrupt, 'tar.gz', 'zip', {}, 'corrupt.tar.gz'));
    expect(outcome.error).toBeInstanceOf(ConversionFailedError);
    expect(outcome.error).not.toBeInstanceOf(DecompressionLimitError);
    expect((outcome.error as ConversionFailedError).message).toMatch(/^Failed to decompress GZIP archive 'corrupt\.tar\.gz'/);
  });

  it('inspectArchive refuses a gzip bomb instead of inflating it', async () => {
    const bomb = gzipBomb;
    expectBombRefused(await refused(() => inspectArchive(bomb, { filename: 'bomb.tar.gz' })));
  });

  it('inspectArchive still lists an ordinary tar.gz', async () => {
    const report = await inspectArchive(zlib.gzipSync(oneFileTar('hello.txt')), { filename: 'real.tar.gz' });
    expect(report.entries.map((entry) => entry.name)).toEqual(['hello.txt']);
  });

  describe('graph archive.extract node', () => {
    function extractJob(inputKey: string) {
      const graphId = `g_bounds_${Date.now()}`;
      return {
        id: `${graphId}:n1`,
        data: {
          jobId: `${graphId}:n1`,
          sourceFormat: 'bin',
          targetFormat: 'bin',
          fileSize: 0,
          options: {},
          graphId,
          graphNodeId: 'n1',
          graphNode: { op: 'archive.extract' },
          inputArtifacts: [inputKey],
        },
        opts: { attempts: 1 },
        attemptsMade: 1,
        signal: new AbortController().signal,
        log: async () => {},
        updateProgress: async () => {},
      } as unknown as Job<ConversionJobData, ConversionJobResult>;
    }

    it('refuses a tgz bomb', async () => {
      const bomb = gzipBomb;
      const key = `tests/decompression-bounds-remaining/${Date.now()}_bomb.tgz`;
      await s3Storage.saveObject(key, bomb, 'application/gzip', 'bomb.tgz', 60_000);
      expectBombRefused(await refused(() => processGraphNodeJob(extractJob(key), undefined, s3Storage)));
    });

    it('still extracts an ordinary tgz', async () => {
      const key = `tests/decompression-bounds-remaining/${Date.now()}_real.tgz`;
      await s3Storage.saveObject(key, zlib.gzipSync(oneFileTar('hello.txt')), 'application/gzip', 'real.tgz', 60_000);
      const result = await processGraphNodeJob(extractJob(key), undefined, s3Storage);
      expect(result.resultKey).toMatch(/hello\.txt$/);
    });
  });

  describe('ZIP repair salvage', () => {
    const originalZipPath = process.env.ZIP_PATH;

    /** Forces the in-process salvage path: the external zip binary is reported as absent. */
    async function withoutZipBinary<T>(operation: () => Promise<T>): Promise<T> {
      process.env.ZIP_PATH = path.join(os.tmpdir(), 'no-such-zip-binary');
      try {
        return await operation();
      } finally {
        if (originalZipPath === undefined) delete process.env.ZIP_PATH;
        else process.env.ZIP_PATH = originalZipPath;
      }
    }

    /** A ZIP cut down to one local file header and its deflate data, with no central directory, which repair must salvage. */
    function localEntryOnly(name: string, deflated: Buffer): Buffer {
      const header = Buffer.alloc(30);
      header.writeUInt32LE(0x04034b50, 0);
      header.writeUInt16LE(20, 4);
      header.writeUInt16LE(8, 8);
      header.writeUInt32LE(deflated.length, 18);
      header.writeUInt16LE(Buffer.byteLength(name), 26);
      return Buffer.concat([header, Buffer.from(name), deflated]);
    }

    it('refuses a deflate entry that expands past the archive limits', async () => {
      const bomb = localEntryOnly('zeros.bin', rawDeflateBomb);
      expectBombRefused(await withoutZipBinary(() => refused(() => repairZipArchive(bomb))));
    });

    it('still salvages an ordinary deflate entry', async () => {
      const text = Buffer.from('salvaged text '.repeat(200));
      const repaired = await withoutZipBinary(() => repairZipArchive(localEntryOnly('note.txt', zlib.deflateRawSync(text))));
      expect(repaired.subarray(0, 2).toString('latin1')).toBe('PK');
      expect(repaired.includes(Buffer.from('note.txt'))).toBe(true);
    });
  });

  describe('7z Deflate folder', () => {
    const DEFLATE_FOLDER_PREFIX = Buffer.from([0x0b, 0x01, 0x00, 0x01, 0x03, 0x04, 0x01, 0x08, 0x0c]);
    const START_HEADER_BYTES = 32;
    const DECLARED_BYTES = 5 * MIB;
    const ACTUAL_BYTES = 64 * MIB;

    /** Writes `value` as a 7z NUMBER of exactly four bytes. */
    function sevenZipNumber4(value: number): Buffer {
      return Buffer.from([0xe0 | ((value >>> 24) & 0x0f), value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff]);
    }

    /** A 7-Zip written Deflate archive of zeros whose folder declares `DECLARED_BYTES` while the stream holds `ACTUAL_BYTES`. */
    function archiveWithUnderstatedSize(dir: string): Buffer {
      const source = path.join(dir, 'zeros.bin');
      fs.closeSync(fs.openSync(source, 'w'));
      fs.truncateSync(source, ACTUAL_BYTES);
      const archivePath = path.join(dir, 'zeros.7z');
      execFileSync(requireOracleTool('7z'), ['a', '-t7z', '-m0=Deflate', '-mx=1', '-mhc=off', '-y', archivePath, 'zeros.bin'], { cwd: dir, stdio: 'ignore' });
      const archive = fs.readFileSync(archivePath);
      const at = archive.indexOf(DEFLATE_FOLDER_PREFIX, START_HEADER_BYTES);
      expect(at, 'plain-header Deflate folder').toBeGreaterThan(0);
      const numberAt = at + DEFLATE_FOLDER_PREFIX.length;
      expect(archive[numberAt] & 0xf0).toBe(0xe0);
      sevenZipNumber4(DECLARED_BYTES).copy(archive, numberAt);
      const nextHeaderOffset = Number(archive.readBigUInt64LE(12));
      const nextHeaderSize = Number(archive.readBigUInt64LE(20));
      const header = archive.subarray(START_HEADER_BYTES + nextHeaderOffset, START_HEADER_BYTES + nextHeaderOffset + nextHeaderSize);
      archive.writeUInt32LE(zlib.crc32(header), 28);
      archive.writeUInt32LE(zlib.crc32(archive.subarray(12, 32)), 8);
      return archive;
    }

    oracleTest('a stream that decodes past the size its folder declares is refused at that size', ['7z'], async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bounds-7z-'));
      try {
        const archive = archiveWithUnderstatedSize(dir);
        expect(archive.length * ARCHIVE_SECURITY_LIMITS.MAX_RATIO).toBeGreaterThan(DECLARED_BYTES);
        const outcome = await refused(async () => extract7zArchive(archive));
        expect(outcome.error).toBeInstanceOf(CorruptStreamError);
        expect(outcome.rssGrowth).toBeLessThan(MAX_RSS_GROWTH_BYTES);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});
