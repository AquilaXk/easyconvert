import { describe, expect, it } from 'vitest';
import { createZipBuffer } from '../src/lib/conversions/zip-writer';
import { SeededRandom } from './helpers/archive-corpus';

const CRC_POLYNOMIAL = 0xedb88320;
const CENTRAL_SIGNATURE = 0x02014b50;
const CENTRAL_CRC_OFFSET = 16;

/** Bit-at-a-time CRC-32 (the definition of RFC 1952 / ISO 3309), written apart from the writer and from zlib. */
function referenceCrc32(data: Uint8Array, seed = 0): number {
  let crc = ~seed >>> 0;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? (crc >>> 1) ^ CRC_POLYNOMIAL : crc >>> 1;
  }
  return ~crc >>> 0;
}

/** The CRC-32 field of every central directory record, in order. */
function centralCrcs(archive: Buffer): number[] {
  const end = archive.length - 22;
  const count = archive.readUInt16LE(end + 10);
  let at = archive.readUInt32LE(end + 16);
  const crcs: number[] = [];
  for (let i = 0; i < count; i++) {
    expect(archive.readUInt32LE(at)).toBe(CENTRAL_SIGNATURE);
    crcs.push(archive.readUInt32LE(at + CENTRAL_CRC_OFFSET));
    at += 46 + archive.readUInt16LE(at + 28) + archive.readUInt16LE(at + 30) + archive.readUInt16LE(at + 32);
  }
  return crcs;
}

describe('CRC-32 of ZIP entries', () => {
  it('the known check value of "123456789" is 0xCBF43926', () => {
    expect(referenceCrc32(Buffer.from('123456789'))).toBe(0xcbf43926);
  });

  it('the CRC the writer records equals the bitwise definition for random lengths at random offsets of a larger buffer', async () => {
    const random = new SeededRandom(2026);
    const backing = random.bytes(70_000);
    const entries = Array.from({ length: 40 }, (_, index) => {
      const length = index < 8 ? index : random.below(40_000);
      const offset = random.below(backing.length - length);
      return { name: `e${index}.dat`, data: backing.subarray(offset, offset + length), method: 'store' as const };
    });
    const crcs = centralCrcs(await createZipBuffer(entries));
    expect(crcs).toEqual(entries.map((entry) => referenceCrc32(entry.data)));
  });

  it('a streamed entry in chunks of random sizes (also empty chunks) gets the CRC of the whole', async () => {
    const random = new SeededRandom(7);
    const whole = random.bytes(300_000);
    const chunks: Uint8Array[] = [];
    for (let at = 0; at < whole.length; ) {
      const size = random.below(20_000);
      chunks.push(whole.subarray(at, at + size));
      at += size;
    }
    const archive = await createZipBuffer([{ name: 'streamed.dat', data: chunks, method: 'store' }]);
    expect(centralCrcs(archive)).toEqual([referenceCrc32(whole)]);
  });

  it('a deflated entry is checksummed over its input, not its output', async () => {
    const data = Buffer.from('abcabcabc'.repeat(5000));
    const archive = await createZipBuffer([{ name: 'rep.txt', data, method: 'deflate' }]);
    expect(centralCrcs(archive)).toEqual([referenceCrc32(data)]);
  });
});
