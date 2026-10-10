import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { crc32 } from '../src/lib/conversions/archive';
import { crc32Slicing8 } from '../src/lib/conversions/crc32';
import { LzmaRangeEncoder } from '../src/lib/conversions/lzma-encoder';
import { oracleTest } from './helpers/oracle-test';

const MEGABYTE = 1024 * 1024;
const LCG_MULTIPLIER = 1664525;
const LCG_INCREMENT = 1013904223;
const BYTE_MASK = 0xff;

/** Deterministic pseudo-random bytes (an LCG), so that every run measures the same input. */
function pseudoRandomBytes(length: number, seed: number): Buffer {
  const out = Buffer.alloc(length);
  let state = seed >>> 0;
  for (let i = 0; i < length; i++) {
    state = (Math.imul(state, LCG_MULTIPLIER) + LCG_INCREMENT) >>> 0;
    out[i] = (state >>> 24) & BYTE_MASK;
  }
  return out;
}

describe('CRC-32', () => {
  /** The textbook one-table, one-byte-at-a-time loop (ISO 3309 / ITU-T V.42), written here as the speed reference. */
  const referenceTable = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    referenceTable[n] = c >>> 0;
  }
  function byteAtATime(buf: Uint8Array): number {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) c = referenceTable[(c ^ buf[i]) & BYTE_MASK] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  // Published check values: the CRC-32 catalogue entry for "123456789" and the pangram vector used by zlib's tests.
  const VECTORS: ReadonlyArray<[string, number]> = [
    ['', 0x00000000],
    ['a', 0xe8b7be43],
    ['123456789', 0xcbf43926],
    ['The quick brown fox jumps over the lazy dog', 0x414fa339],
  ];

  it.each(VECTORS)('matches the published check value for %j', (text, expected) => {
    expect(crc32(Buffer.from(text, 'latin1'))).toBe(expected);
    expect(crc32Slicing8(Buffer.from(text, 'latin1'))).toBe(expected);
  });

  it('slicing-by-8 equals the byte loop at every length and alignment around the 8-byte stride', () => {
    const data = pseudoRandomBytes(300, 7);
    for (let offset = 0; offset < 9; offset++) {
      for (let length = 0; length < 70; length++) {
        const view = data.subarray(offset, offset + length);
        expect(crc32Slicing8(view)).toBe(byteAtATime(view));
      }
    }
  });

  it('continues a running checksum across chunk boundaries', () => {
    const data = pseudoRandomBytes(10_000, 11);
    const whole = byteAtATime(data);
    for (const split of [0, 1, 7, 8, 9, 4096, 9999, 10_000]) {
      expect(crc32(data.subarray(split), crc32(data.subarray(0, split)))).toBe(whole);
      expect(crc32Slicing8(data.subarray(split), crc32Slicing8(data.subarray(0, split)))).toBe(whole);
    }
  });

  // gzip stores the CRC-32 of the uncompressed data in its trailer: an independent implementation to compare with.
  oracleTest('agrees with the CRC-32 gzip writes in its trailer', ['gzip'], () => {
    const data = pseudoRandomBytes(200_003, 13);
    const gz = execFileSync('gzip', ['-c', '-n'], { input: data, maxBuffer: 4 * MEGABYTE });
    const trailerCrc = gz.readUInt32LE(gz.length - 8);
    expect(gz.readUInt32LE(gz.length - 4)).toBe(data.length);
    expect(crc32(data)).toBe(trailerCrc);
    expect(crc32Slicing8(data)).toBe(trailerCrc);
  });

});

/**
 * The LZMA range encoder (LZMA specification, "RangeEnc"), written here with a BigInt `low` and a plain array output,
 * the way the encoder was first written, as the speed and byte reference. It shares nothing with the production class.
 */
class BigIntRangeEncoder {
  private low = 0n;
  private range = 0xffffffff;
  private cache = 0;
  private cacheSize = 1;
  private readonly out: number[] = [];

  encodeBit(probs: Uint16Array, index: number, bit: number): void {
    const prob = probs[index];
    const bound = (this.range >>> 11) * prob;
    if (bit === 0) {
      this.range = bound >>> 0;
      probs[index] = prob + ((2048 - prob) >>> 5);
    } else {
      this.low += BigInt(bound >>> 0);
      this.range = (this.range - bound) >>> 0;
      probs[index] = prob - (prob >>> 5);
    }
    while (this.range < 0x01000000) {
      this.range = (this.range << 8) >>> 0;
      this.shiftLow();
    }
  }

  encodeDirectBits(value: number, count: number): void {
    for (let i = count - 1; i >= 0; i--) {
      this.range >>>= 1;
      if ((value >>> i) & 1) this.low += BigInt(this.range);
      if (this.range < 0x01000000) {
        this.range = (this.range << 8) >>> 0;
        this.shiftLow();
      }
    }
  }

  private shiftLow(): void {
    const carry = Number((this.low >> 32n) & 0xffn);
    if (carry !== 0 || this.low < 0xff000000n) {
      let temp = this.cache;
      do {
        this.out.push((temp + carry) & 0xff);
        temp = 0xff;
      } while (--this.cacheSize > 0);
      this.cache = Number((this.low >> 24n) & 0xffn);
      this.cacheSize = 1;
    } else {
      this.cacheSize++;
    }
    this.low = (this.low & 0x00ffffffn) << 8n;
  }

  flush(): Buffer {
    for (let i = 0; i < 5; i++) this.shiftLow();
    return Buffer.from(this.out);
  }
}

interface CodedBits {
  probCount: number;
  contexts: Uint16Array;
  bits: Uint8Array;
  directValues: Uint32Array;
}

/**
 * A skewed bit stream over 2048 contexts, with a direct-bits symbol every so often, shaped like what a literal-heavy
 * LZMA stream feeds the coder (so carries and 0xFF runs in `low` do occur).
 */
function codedBitStream(count: number, seed: number): CodedBits {
  const probCount = 2048;
  const contexts = new Uint16Array(count);
  const bits = new Uint8Array(count);
  const directValues = new Uint32Array(Math.ceil(count / 64));
  let state = seed >>> 0;
  const next = (): number => {
    state = (Math.imul(state, LCG_MULTIPLIER) + LCG_INCREMENT) >>> 0;
    return state >>> 8;
  };
  for (let i = 0; i < count; i++) {
    const context = next() % probCount;
    contexts[i] = context;
    // Context c emits a 1 with a probability that rises with c, from about 2% to about 98%.
    bits[i] = next() % 1000 < 20 + (context * 960) / probCount ? 1 : 0;
  }
  for (let i = 0; i < directValues.length; i++) directValues[i] = next() & 0x3ffff;
  return { probCount, contexts, bits, directValues };
}

function encodeStream(encoder: Pick<BigIntRangeEncoder, 'encodeBit' | 'encodeDirectBits' | 'flush'>, coded: CodedBits): Buffer {
  const probs = new Uint16Array(coded.probCount).fill(1024);
  const { contexts, bits, directValues } = coded;
  for (let i = 0; i < bits.length; i++) {
    encoder.encodeBit(probs, contexts[i], bits[i]);
    if ((i & 63) === 63) encoder.encodeDirectBits(directValues[i >> 6], 18);
  }
  return encoder.flush();
}

describe('LZMA range encoder', () => {
  it('writes the same bytes as the BigInt reference on a bit stream with carries', () => {
    const coded = codedBitStream(300_000, 23);
    const expected = encodeStream(new BigIntRangeEncoder(), coded);
    const actual = encodeStream(new LzmaRangeEncoder(), coded);
    expect(actual.length).toBe(expected.length);
    expect(actual.equals(expected)).toBe(true);
  });

  it('writes the same bytes on streams that force a long run of 0xFF before a carry', () => {
    // Probability 1 contexts push `low` to the top of the interval; many equal bits produce 0xFF cache runs.
    const count = 120_000;
    const coded: CodedBits = {
      probCount: 4,
      contexts: new Uint16Array(count).map((_, i) => i % 4),
      bits: new Uint8Array(count).map((_, i) => (i % 97 === 0 ? 0 : 1)),
      directValues: new Uint32Array(Math.ceil(count / 64)).fill(0x3ffff),
    };
    expect(encodeStream(new LzmaRangeEncoder(), coded).equals(encodeStream(new BigIntRangeEncoder(), coded))).toBe(true);
  });

});
