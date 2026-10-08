import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { crc32 } from '../src/lib/conversions/archive';
import { crc32Slicing8 } from '../src/lib/conversions/crc32';
import { oracleTest } from './helpers/oracle-test';
import { expectNoSlowerThanReference } from './helpers/timing';

/**
 * Speed of the bit-level archive primitives against independent references, plus correctness against the
 * command-line tools. Every speed claim is a ratio measured in this process (interleaved, best of several passes), so
 * it does not depend on how fast the runner is. A slow runner can opt out explicitly with ARCHIVE_SKIP_TIMING=1;
 * nothing skips silently in CI.
 */
// skip-ok: explicit opt-out (ARCHIVE_SKIP_TIMING=1) of the timing ratios on a slow shared runner, never set in CI.
const SKIP_TIMING = process.env.ARCHIVE_SKIP_TIMING === '1';
const TEST_TIMEOUT_MS = 120_000;
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

  it.skipIf(SKIP_TIMING)(
    'runs at least 5x faster than the byte-at-a-time loop on 4 MB',
    async () => {
      const data = pseudoRandomBytes(4 * MEGABYTE, 17);
      const expected = byteAtATime(data);
      await expectNoSlowerThanReference('crc32', () => byteAtATime(data), () => crc32(data), { maxRatio: 1 / 5 });
      expect(crc32(data)).toBe(expected);
    },
    TEST_TIMEOUT_MS
  );

  it.skipIf(SKIP_TIMING)(
    'the table fallback alone is at least 1.5x faster than the byte-at-a-time loop on 4 MB',
    async () => {
      const data = pseudoRandomBytes(4 * MEGABYTE, 19);
      await expectNoSlowerThanReference('crc32 slicing-by-8', () => byteAtATime(data), () => crc32Slicing8(data), { maxRatio: 1 / 1.5 });
    },
    TEST_TIMEOUT_MS
  );
});
