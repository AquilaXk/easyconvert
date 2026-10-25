import { describe, expect, it } from 'vitest';
import { LzmaRangeEncoder } from '../src/lib/conversions/lzma-encoder';
import { expectNoSlowerThanReference } from './helpers/timing';

/**
 * Timing-ratio checks moved out of archive-bitlevel-throughput.test.ts.
 * They compare runs of the same work and need a quiet machine, so they run in the nightly performance workflow
 * (`npx vitest run --no-file-parallelism .perf.test.ts`) and not in the PR gate.
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
  it.skipIf(SKIP_TIMING)(
    'encodes at least 2x faster than the BigInt reference',
    async () => {
      const coded = codedBitStream(1_500_000, 29);
      await expectNoSlowerThanReference(
        'range encoder',
        () => encodeStream(new BigIntRangeEncoder(), coded),
        () => encodeStream(new LzmaRangeEncoder(), coded),
        { maxRatio: 1 / 2 }
      );
    },
    TEST_TIMEOUT_MS
  );
});
