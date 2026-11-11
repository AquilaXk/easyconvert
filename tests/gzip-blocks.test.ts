import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import zlib from 'node:zlib';
import { DEFLATE_BLOCK_BYTES, gzipInBlocks } from '../src/lib/conversions/deflate-blocks';
import { getOracleToolPath } from './helpers/differential-oracle';
import { oracleTest } from './helpers/oracle-test';
import { jsonRecords, runBytes, sha256Hex, zipfText } from './helpers/archive-corpus';

const SMALL_LIMIT = 64 * 1024;
const BLOCK = DEFLATE_BLOCK_BYTES;

function sample(size: number, seed: number): Buffer {
  return Buffer.concat([zipfText(Math.ceil(size / 2), seed), runBytes(Math.floor(size / 2), seed + 1)]).subarray(0, size);
}

describe('gzipInBlocks', () => {
  it.each([0, 1, 1000, SMALL_LIMIT - 1, SMALL_LIMIT])('a buffer of %i bytes is zlib.gzipSync output byte for byte', async (size) => {
    const data = sample(size, 3);
    for (const level of [1, 6, 9]) {
      expect((await gzipInBlocks(data, level)).equals(zlib.gzipSync(data, { level })), `level ${level}`).toBe(true);
    }
  });

  it.each([SMALL_LIMIT + 1, BLOCK, BLOCK + 1, 3 * BLOCK + 12345])('a buffer of %i bytes gunzips to the input', async (size) => {
    const data = sample(size, 5);
    for (const level of [0, 1, 6, 9]) {
      expect(sha256Hex(zlib.gunzipSync(await gzipInBlocks(data, level))), `level ${level}`).toBe(sha256Hex(data));
    }
  });

  it('writes the header zlib writes: no name or time, Unix, and the extra-flags byte of level 9 and of the fastest levels', async () => {
    const data = sample(2 * BLOCK, 7);
    const extraFlags = async (level: number): Promise<number> => (await gzipInBlocks(data, level))[8];
    const reference = (level: number): number => zlib.gzipSync(Buffer.from('x'), { level })[8];
    for (const level of [0, 1, 2, 6, 9]) expect(await extraFlags(level), `level ${level}`).toBe(reference(level));
    const header = await gzipInBlocks(data, 6);
    expect([...header.subarray(0, 4)]).toEqual([0x1f, 0x8b, 8, 0]);
    expect(header.readUInt32LE(4)).toBe(0);
    expect(header[9], 'the OS byte is Unix on every platform, as zlib writes it on Linux').toBe(3);
  });

  it('records the CRC-32 and the length of the whole input in the trailer', async () => {
    const data = Buffer.concat([zipfText(700_000, 11), jsonRecords(500_000, 12)]);
    const member = await gzipInBlocks(data, 6);
    expect(member.readUInt32LE(member.length - 8)).toBe(zlib.crc32(data));
    expect(member.readUInt32LE(member.length - 4)).toBe(data.length);
  });

  it('is within 0.5 percent of one zlib call and writes the same bytes every time', async () => {
    const data = Buffer.concat([zipfText(900_000, 21), jsonRecords(400_000, 22), runBytes(200_000, 23)]);
    const first = await gzipInBlocks(data, 6);
    const again = await Promise.all([gzipInBlocks(data, 6), gzipInBlocks(data, 6)]);
    expect(again[0].equals(first) && again[1].equals(first)).toBe(true);
    const whole = zlib.gzipSync(data, { level: 6 });
    expect(Math.abs(first.length - whole.length) / whole.length).toBeLessThan(0.005);
  });

  oracleTest('the gzip tool tests the member and reads the same bytes', ['gzip'], async () => {
    const data = Buffer.concat([zipfText(700_000, 31), jsonRecords(500_000, 32), runBytes(300_000, 33)]);
    const member = await gzipInBlocks(data, 6);
    const gzip = getOracleToolPath('gzip') as string;
    execFileSync(gzip, ['-t'], { input: member });
    expect(sha256Hex(execFileSync(gzip, ['-d', '-c'], { input: member, maxBuffer: 64 * 1024 * 1024 }))).toBe(sha256Hex(data));
  });
});
