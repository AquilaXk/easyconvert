import { afterEach, describe, expect, it, vi } from 'vitest';
import { compressBzip2, decompressBzip2 } from '../src/lib/conversions/bzip2';
import { unpackXzStream } from '../src/lib/conversions/xz-format';
import { CorruptStreamError, DecompressionLimitError } from '../src/lib/types';

/**
 * Work that concatenated streams may cost a bzip2 or xz reader: the same as the bytes of the file, never more per stream. The
 * work arrays of a bzip2 stream are made once for the file and for the block sizes it declares, not once for every stream.
 */

const STREAMS = 10_000;
const WORK_ARRAY_ELEMENTS = 100_000;
/** Hang guard only: a file of this many streams decodes in well under a second; a reader that costs 3 ms a stream takes 30 s. */
const STREAMS_HANG_GUARD_MS = 20_000;
vi.setConfig({ testTimeout: STREAMS_HANG_GUARD_MS });

/** The `Uint32Array` constructions of at least `minimum` elements while `run` executes. */
function bigUint32Arrays(minimum: number, run: () => void): number[] {
  const original = globalThis.Uint32Array;
  const lengths: number[] = [];
  globalThis.Uint32Array = new Proxy(original, {
    construct(target, args: [number], newTarget) {
      if (typeof args[0] === 'number' && args[0] >= minimum) lengths.push(args[0]);
      return Reflect.construct(target, args, newTarget);
    },
  });
  try {
    run();
  } finally {
    globalThis.Uint32Array = original;
  }
  return lengths;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('concatenated bzip2 streams', () => {
  const one = compressBzip2(Buffer.from('a'));
  const many = Buffer.concat(Array.from({ length: STREAMS }, () => one));

  it('make their block work array once, not once for every stream', () => {
    let out: Buffer = Buffer.alloc(0);
    const arrays = bigUint32Arrays(WORK_ARRAY_ELEMENTS, () => {
      out = decompressBzip2(many);
    });
    expect(out.equals(Buffer.alloc(STREAMS, 'a'))).toBe(true);
    expect(arrays.length).toBeLessThanOrEqual(1);
  });

  it('size the block work array by the output they may make, not by the block size they declare', () => {
    const lengths: number[] = [];
    const original = globalThis.Uint32Array;
    globalThis.Uint32Array = new Proxy(original, {
      construct(target, args: [number], newTarget) {
        if (typeof args[0] === 'number') lengths.push(args[0]);
        return Reflect.construct(target, args, newTarget);
      },
    });
    try {
      expect(decompressBzip2(one, 1).toString()).toBe('a');
    } finally {
      globalThis.Uint32Array = original;
    }
    expect(Math.max(...lengths)).toBeLessThan(WORK_ARRAY_ELEMENTS);
  });

  it('still stop at the output limit with its own error when the limit is far below the declared block size', () => {
    const text = Buffer.from('the quick brown fox jumps over the lazy dog. '.repeat(500));
    const packed = compressBzip2(text);
    expect(decompressBzip2(packed, text.length).equals(text)).toBe(true);
    expect(() => decompressBzip2(packed, 100)).toThrow(DecompressionLimitError);
  });

  it('still refuse a block that is past the size its stream declares', () => {
    // A block of 150,000 symbols written under a level 9 header, read as level 1 (block size 100,000).
    let seed = 12345;
    const noise = Buffer.alloc(150_000);
    for (let at = 0; at < noise.length; at++) {
      seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
      noise[at] = seed >>> 24;
    }
    const level1 = Buffer.from(compressBzip2(noise));
    level1[3] = '1'.charCodeAt(0);
    expect(() => decompressBzip2(level1)).toThrow(CorruptStreamError);
  });
});

describe('concatenated xz streams', () => {
  /** An empty stream written with a CRC-32 check: header, index of no blocks and footer, 32 bytes. */
  const empty = Buffer.from('fd377a585a0000016922de36000000001cdf44219042990d010000000001595a', 'hex');

  it('cost the work of reading the file when the streams are empty', () => {
    const many = Buffer.concat(Array.from({ length: 30_000 }, () => empty));
    const started = Date.now();
    expect(unpackXzStream(many, 1 << 20).length).toBe(0);
    expect(Date.now() - started).toBeLessThan(STREAMS_HANG_GUARD_MS);
  });

  it('refuse an index that lists more blocks than the file has bytes after a few operations per byte', () => {
    const bigCount = Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x01]);
    const bad = Buffer.concat([empty.subarray(0, 12), Buffer.from([0x00]), bigCount, Buffer.alloc(4 * 1024 * 1024, 0x01)]);
    const started = Date.now();
    expect(() => unpackXzStream(bad, 1 << 20)).toThrow(CorruptStreamError);
    expect(Date.now() - started).toBeLessThan(STREAMS_HANG_GUARD_MS);
  });
});
