import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { assembleXxh64, xxh64Wasm, xxh64WasmSupported, XXH64_WASM_MIN_BYTES } from '../src/lib/conversions/wasm/xxh64';
import { compressZstd, computeZstdChecksum, decompressZstd, FastStreamingXxHash64, xxh64 } from '../src/lib/conversions/zstd';
import { SeededRandom, zipfText } from './helpers/archive-corpus';
import { oracleTest } from './helpers/oracle-test';
import { skipUnless } from './helpers/strict-skip';
import { expectNoSlowerThanReference } from './helpers/timing';

/**
 * The WebAssembly XXH64 behind the Zstandard content checksum, against the xxHash specification: published vectors, an
 * independent BigInt implementation written here from the specification's pseudo-code, frames made by the `zstd`
 * command line (which verify or carry the checksum), and the runtime without WebAssembly.
 */
// skip-ok: explicit opt-out (XXH64_SKIP_TIMING=1) of the speed ratio on a slow shared runner, never set in CI.
const SKIP_TIMING = process.env.XXH64_SKIP_TIMING === '1';
const TEST_TIMEOUT_MS = 180_000;
const MEGABYTE = 1024 * 1024;
const MIN_SPEEDUP = 4;
const LOW_32_BITS = 0xffffffffn;

const P1 = 0x9e3779b185ebca87n;
const P2 = 0xc2b2ae3d27d4eb4fn;
const P3 = 0x165667b19e3779f9n;
const P4 = 0x85ebca77c2b2ae63n;
const P5 = 0x27d4eb2f165667c5n;
const MASK = (1n << 64n) - 1n;

/** XXH64 with seed 0 straight from the specification's steps, in BigInt arithmetic. */
function referenceXxh64(input: Uint8Array): bigint {
  const rotl = (x: bigint, r: bigint): bigint => ((x << r) | (x >> (64n - r))) & MASK;
  const round = (acc: bigint, value: bigint): bigint => (rotl((acc + value * P2) & MASK, 31n) * P1) & MASK;
  const merge = (acc: bigint, value: bigint): bigint => (((acc ^ round(0n, value)) * P1 + P4) & MASK);
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
  const length = input.length;
  let offset = 0;
  let h: bigint;
  if (length >= 32) {
    let v1 = (P1 + P2) & MASK;
    let v2 = P2;
    let v3 = 0n;
    let v4 = (MASK + 1n - P1) & MASK;
    for (; offset + 32 <= length; offset += 32) {
      v1 = round(v1, view.getBigUint64(offset, true));
      v2 = round(v2, view.getBigUint64(offset + 8, true));
      v3 = round(v3, view.getBigUint64(offset + 16, true));
      v4 = round(v4, view.getBigUint64(offset + 24, true));
    }
    h = (rotl(v1, 1n) + rotl(v2, 7n) + rotl(v3, 12n) + rotl(v4, 18n)) & MASK;
    h = merge(h, v1);
    h = merge(h, v2);
    h = merge(h, v3);
    h = merge(h, v4);
  } else {
    h = P5;
  }
  h = (h + BigInt(length)) & MASK;
  for (; offset + 8 <= length; offset += 8) {
    h = (rotl(h ^ round(0n, view.getBigUint64(offset, true)), 27n) * P1 + P4) & MASK;
  }
  if (offset + 4 <= length) {
    h = (rotl(h ^ ((BigInt(view.getUint32(offset, true)) * P1) & MASK), 23n) * P2 + P3) & MASK;
    offset += 4;
  }
  for (; offset < length; offset++) {
    h = (rotl(h ^ ((BigInt(input[offset]) * P5) & MASK), 11n) * P1) & MASK;
  }
  h ^= h >> 33n;
  h = (h * P2) & MASK;
  h ^= h >> 29n;
  h = (h * P3) & MASK;
  h ^= h >> 32n;
  return h;
}

function scriptChecksum(data: Uint8Array): number {
  const hasher = new FastStreamingXxHash64();
  hasher.update(data);
  return hasher.digest();
}

describe.skipIf(skipUnless('WebAssembly', xxh64WasmSupported()))('WebAssembly XXH64', () => {
  // Published values for seed 0 (the xxHash repository's documentation and sanity tests).
  it.each([
    ['', 0xef46db3751d8e999n],
    ['a', 0xd24ec4f1a98c6e5bn],
    ['abc', 0x44bc2cf5ad770999n],
    ['Nobody inspects the spammish repetition', 0xfbcea83c8a378bf1n],
  ])('hashes %j to its published value (reference implementation and published value agree)', (text, expected) => {
    const bytes = Buffer.from(text, 'latin1');
    expect(referenceXxh64(bytes)).toBe(expected);
    expect(xxh64(bytes)).toBe(expected);
  });

  it('assembles to a valid module that exports stripes and finish', () => {
    const bytes = assembleXxh64();
    expect(WebAssembly.validate(bytes)).toBe(true);
    expect(WebAssembly.Module.exports(new WebAssembly.Module(bytes)).map((entry) => entry.name).sort()).toEqual(['finish', 'stripes']);
  });

  it('agrees with the BigInt reference for every length up to 300 and around the stripe, word and chunk edges', () => {
    const rng = new SeededRandom(64);
    const lengths = new Set<number>();
    for (let n = 0; n <= 300; n++) lengths.add(n);
    for (const n of [511, 512, 1023, 1024, 1025, 1055, 4095, 4096, 65_537, MEGABYTE - 1, MEGABYTE, MEGABYTE + 1, MEGABYTE + 33, 2 * MEGABYTE + 5]) lengths.add(n);
    const disagreements: number[] = [];
    for (const length of lengths) {
      const data = rng.bytes(length);
      const expected = referenceXxh64(data);
      // Below the threshold the module is still correct; the caller just does not use it.
      if (xxh64Wasm(data) !== expected) disagreements.push(length);
    }
    expect(disagreements).toEqual([]);
  }, TEST_TIMEOUT_MS);

  it('hashes a view into a larger buffer by its bytes only', () => {
    const backing = new SeededRandom(5).bytes(5000);
    const view = backing.subarray(1001, 4003);
    expect(xxh64Wasm(view)).toBe(referenceXxh64(Buffer.from(view)));
  });

  it('is used by the zstd checksum from the threshold up and gives the script implementation\'s value', () => {
    for (const length of [XXH64_WASM_MIN_BYTES - 1, XXH64_WASM_MIN_BYTES, 5000, MEGABYTE + 7]) {
      const data = new SeededRandom(length).bytes(length);
      expect(computeZstdChecksum(data), `length ${length}`).toBe(scriptChecksum(data));
      expect(computeZstdChecksum(data)).toBe(Number(referenceXxh64(data) & LOW_32_BITS));
    }
  });

  oracleTest(
    'frames made by this encoder pass zstd -d with its checksum verified, and frames made by zstd pass this decoder',
    ['zstd'],
    () => {
      const inputs = [zipfText(300_000, 12), new SeededRandom(8).bytes(70_000), Buffer.alloc(200_000, 0x5a)];
      for (const data of inputs) {
        const ours = compressZstd(data, { level: 3, checksum: true });
        const restored = execFileSync('zstd', ['-d', '-q', '-c'], { input: ours, maxBuffer: 16 * MEGABYTE });
        expect(restored.equals(data)).toBe(true);
        const theirs = execFileSync('zstd', ['-3', '-q', '-c', '--check'], { input: data, maxBuffer: 16 * MEGABYTE });
        expect(decompressZstd(theirs).equals(data)).toBe(true);
      }
    },
    TEST_TIMEOUT_MS
  );

  oracleTest(
    'a frame whose stored checksum is wrong is still rejected by the decoder',
    ['zstd'],
    () => {
      const data = zipfText(100_000, 3);
      const frame = Buffer.from(execFileSync('zstd', ['-3', '-q', '-c', '--check'], { input: data, maxBuffer: 16 * MEGABYTE }));
      frame[frame.length - 1] ^= 0x01;
      expect(() => decompressZstd(frame)).toThrow(/checksum/i);
    },
    TEST_TIMEOUT_MS
  );

  it('falls back to the script implementation, with the same values, in a runtime without WebAssembly', () => {
    const child = path.join(__dirname, 'helpers', 'xxh64-no-wasm-child.cts');
    const output = execFileSync(process.execPath, ['--no-expose-wasm', '-r', 'tsx/cjs', child], { encoding: 'utf8', cwd: path.join(__dirname, '..') });
    const result = JSON.parse(output.trim().split('\n').pop() ?? '{}') as Record<string, unknown>;
    const data = Buffer.alloc(5000);
    for (let i = 0; i < data.length; i++) data[i] = (i * 31 + (i >> 3)) & 0xff;
    expect(result).toEqual({
      webassembly: 'undefined',
      supported: false,
      wasmHash: null,
      checksum: Number(referenceXxh64(data) & LOW_32_BITS),
      roundTrip: true,
    });
  }, TEST_TIMEOUT_MS);
});

describe.skipIf(SKIP_TIMING || skipUnless('WebAssembly', xxh64WasmSupported()))('WebAssembly XXH64 speed', () => {
  it(`hashes 8 MB at least ${MIN_SPEEDUP}x faster than the script implementation`, async () => {
    const data = new SeededRandom(2).bytes(8 * MEGABYTE);
    const expected = scriptChecksum(data);
    const measurement = await expectNoSlowerThanReference(
      'xxh64',
      () => scriptChecksum(data),
      () => computeZstdChecksum(data),
      { maxRatio: 1 / MIN_SPEEDUP, passes: 5 }
    );
    expect(measurement.largeResult).toBe(expected);
  }, TEST_TIMEOUT_MS);
});
