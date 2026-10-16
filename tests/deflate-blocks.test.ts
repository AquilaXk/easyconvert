import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import zlib from 'node:zlib';
import { DEFLATE_BLOCK_BYTES, deflateRawBlocks, zlibLevelFor } from '../src/lib/conversions/deflate-blocks';
import { jsonRecords, runBytes, sha256Hex, zipfText } from './helpers/archive-corpus';
import { getOracleToolPath } from './helpers/differential-oracle';
import { oracleTest } from './helpers/oracle-test';

/**
 * Raw deflate in parallel blocks joined by sync flushes. The stream is read back by zlib's inflate and by the `gzip`
 * tool (the stream wrapped in a gzip member whose CRC-32 and length come from the input), never by the code under test.
 */
const BLOCK = DEFLATE_BLOCK_BYTES;

function gzipMemberOf(data: Buffer, deflated: Buffer): Buffer {
  const header = Buffer.from([0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 3]);
  const trailer = Buffer.alloc(8);
  trailer.writeUInt32LE(zlib.crc32(data), 0);
  trailer.writeUInt32LE(data.length >>> 0, 4);
  return Buffer.concat([header, deflated, trailer]);
}

const SIZES = [0, 1, 1000, BLOCK - 1, BLOCK, BLOCK + 1, 2 * BLOCK, 2 * BLOCK + 1, 3 * BLOCK + 12345];

describe('deflateRawBlocks', () => {
  it.each(SIZES)('a stream of %i bytes inflates to the input', async (size) => {
    const data = Buffer.concat([zipfText(Math.ceil(size / 2), 7), runBytes(Math.floor(size / 2), 8)]).subarray(0, size);
    for (const level of [1, 6, 9]) {
      const deflated = await deflateRawBlocks(data, level);
      expect(sha256Hex(zlib.inflateRawSync(deflated)), `level ${level}`).toBe(sha256Hex(data));
    }
  });

  oracleTest(
    'the gzip tool reads a many-block stream and its CRC-32 matches',
    ['gzip'],
    async () => {
      const data = Buffer.concat([zipfText(700_000, 11), jsonRecords(500_000, 12), runBytes(300_000, 13)]);
      const deflated = await deflateRawBlocks(data, 6);
      const member = gzipMemberOf(data, deflated);
      const gzip = getOracleToolPath('gzip') as string;
      execFileSync(gzip, ['-t'], { input: member });
      expect(sha256Hex(execFileSync(gzip, ['-d', '-c'], { input: member, maxBuffer: 64 * 1024 * 1024 }))).toBe(sha256Hex(data));
    }
  );

  it('writes the same bytes every time, whatever the pool does', async () => {
    const data = Buffer.concat([zipfText(900_000, 21), jsonRecords(400_000, 22)]);
    const first = await deflateRawBlocks(data, 6);
    const again = await Promise.all([deflateRawBlocks(data, 6), deflateRawBlocks(data, 6)]);
    expect(again[0].equals(first)).toBe(true);
    expect(again[1].equals(first)).toBe(true);
  });

  it('keeps matches that reach across a cut: the size is within 0.5 percent of one call at the same zlib level', async () => {
    const data = Buffer.concat([zipfText(600_000, 31), jsonRecords(500_000, 32), runBytes(200_000, 33)]);
    for (const level of [1, 6, 9]) {
      const blocks = await deflateRawBlocks(data, level);
      const whole = zlib.deflateRawSync(data, { level: zlibLevelFor(level) });
      expect(blocks.length, `level ${level}`).toBeLessThanOrEqual(whole.length * 1.005);
    }
  });

  it('uses the preset dictionary: 20 KB of random bytes repeated across a cut cost one copy, not two', async () => {
    const unit = randomBytes(20_000);
    const data = Buffer.concat([Buffer.alloc(BLOCK - unit.length, 0x20), unit, unit]);
    const blocks = await deflateRawBlocks(data, 6);
    expect(blocks.length).toBeLessThan(unit.length * 1.1);
    expect(zlib.inflateRawSync(blocks).equals(data)).toBe(true);
  });

  it('maps the product levels to zlib levels that never shrink as the level rises', () => {
    const mapped = Array.from({ length: 10 }, (_, level) => zlibLevelFor(level));
    expect(mapped).toEqual([0, 1, 2, 3, 4, 8, 8, 9, 9, 9]);
    for (let level = 1; level < mapped.length; level++) expect(mapped[level]).toBeGreaterThanOrEqual(mapped[level - 1]);
  });

  it('level 0 stores: the output is longer than the input and inflates to it', async () => {
    const data = zipfText(2 * BLOCK + 5, 51);
    const stored = await deflateRawBlocks(data, 0);
    expect(stored.length).toBeGreaterThan(data.length);
    expect(zlib.inflateRawSync(stored).equals(data)).toBe(true);
  });
});
