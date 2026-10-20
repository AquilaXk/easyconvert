import { describe, expect, it } from 'vitest';
import { computeBzBlockCrc } from '../src/lib/conversions/bzip2-crc';
import { SeededRandom } from './helpers/archive-corpus';

/** CRC-32/BZIP2 by its definition: one bit at a time, most significant bit first, polynomial 0x04C11DB7. */
function bitwiseBzCrc(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte << 24;
    for (let bit = 0; bit < 8; bit++) crc = crc & 0x80000000 ? (crc << 1) ^ 0x04c11db7 : crc << 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

describe('bzip2 block checksum', () => {
  it('has the published check value of CRC-32/BZIP2 for "123456789"', () => {
    expect(computeBzBlockCrc(Buffer.from('123456789', 'latin1'))).toBe(0xfc891918);
  });

  it('is 0 for no bytes', () => {
    expect(computeBzBlockCrc(new Uint8Array(0))).toBe(0);
  });

  it('equals the bit-by-bit definition for every length up to 80 (the 8-byte steps and every tail)', () => {
    const data = new SeededRandom(3).bytes(80);
    for (let length = 0; length <= data.length; length++) {
      expect(computeBzBlockCrc(data.subarray(0, length)), `length ${length}`).toBe(bitwiseBzCrc(data.subarray(0, length)));
    }
  });

  it('equals the definition on 1 MB of random bytes, of zeros and of ones, and on an unaligned view', () => {
    const random = new SeededRandom(9).bytes(1_000_003);
    expect(computeBzBlockCrc(random)).toBe(bitwiseBzCrc(random));
    expect(computeBzBlockCrc(random.subarray(5, 999_999))).toBe(bitwiseBzCrc(random.subarray(5, 999_999)));
    expect(computeBzBlockCrc(new Uint8Array(1 << 20))).toBe(bitwiseBzCrc(new Uint8Array(1 << 20)));
    expect(computeBzBlockCrc(new Uint8Array(1 << 20).fill(0xff))).toBe(bitwiseBzCrc(new Uint8Array(1 << 20).fill(0xff)));
  });
});
