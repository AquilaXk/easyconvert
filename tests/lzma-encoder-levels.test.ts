import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compressLzma, compressLzma2, LZMA_MAX_ENCODER_MEMORY } from '../src/lib/conversions/lzma-encoder';
import { decompressLzma, decompressLzma2, packXz, unpackXz, create7zArchive } from '../src/lib/conversions/archive';
import { UnsupportedOptionError } from '../src/lib/types';
import { SeededRandom, proseText, sourceText, zipfText } from './helpers/archive-corpus';
import { oracleTest } from './helpers/oracle-test';

/**
 * The LZMA / LZMA2 encoder against the reference tools: size ratios on text, validity and byte-identical decoding at the
 * levels the issue names, the LZMA2 chunk layer (one dictionary reset, state carried across chunks), and malformed
 * options. Expected sizes come from the xz and 7z command-line tools, never from the module under test.
 */
const MEGABYTE = 1024 * 1024;
const TEST_TIMEOUT_MS = 240_000;
const LEVELS = [0, 3, 6, 9] as const;
/** Level 9 must reach this fraction of the input on 1 MB of text (issue acceptance criterion). */
const LEVEL9_MAX_RATIO = 0.2;
/** Level 6 may be this much larger than `xz -6` (issue acceptance criterion: within 5%). */
const LEVEL6_MAX_VS_XZ = 1.05;
const LZMA2_END = 0x00;
const LZMA2_RAW_RESET = 0x01;
const LZMA2_RAW = 0x02;
const LZMA2_LZMA_FLAG = 0x80;
const LZMA2_MODE_SHIFT = 5;
const LZMA2_MODE_MASK = 3;
const LZMA2_MODE_DICT_RESET = 3;
const LZMA2_SIZE_HIGH_MASK = 0x1f;
const LZMA2_LZMA_HEADER_BYTES = 5;
const LZMA2_PROPS_BYTES = 1;
const LZMA2_RAW_HEADER_BYTES = 3;
const LZMA2_MODE_NEW_PROPS = 2;

interface ChunkWalk {
  chunks: number;
  dictionaryResets: number;
  stateResets: number;
  rawChunks: number;
  unpacked: number;
  endsWithEnd: boolean;
}

/** Walks the LZMA2 chunk headers (xz file format, "LZMA2") without decoding any chunk. */
function walkLzma2(stream: Uint8Array): ChunkWalk {
  const walk: ChunkWalk = { chunks: 0, dictionaryResets: 0, stateResets: 0, rawChunks: 0, unpacked: 0, endsWithEnd: false };
  let pos = 0;
  while (pos < stream.length) {
    const control = stream[pos];
    if (control === LZMA2_END) {
      walk.endsWithEnd = pos === stream.length - 1;
      return walk;
    }
    walk.chunks++;
    if (control === LZMA2_RAW_RESET || control === LZMA2_RAW) {
      if (control === LZMA2_RAW_RESET) walk.dictionaryResets++;
      const size = ((stream[pos + 1] << 8) | stream[pos + 2]) + 1;
      walk.rawChunks++;
      walk.unpacked += size;
      pos += LZMA2_RAW_HEADER_BYTES + size;
      continue;
    }
    expect(control & LZMA2_LZMA_FLAG, `control byte 0x${control.toString(16)} at ${pos}`).toBe(LZMA2_LZMA_FLAG);
    const mode = (control >> LZMA2_MODE_SHIFT) & LZMA2_MODE_MASK;
    if (mode === LZMA2_MODE_DICT_RESET) walk.dictionaryResets++;
    if (mode >= 1) walk.stateResets++;
    const unpackedSize = (((control & LZMA2_SIZE_HIGH_MASK) << 16) | (stream[pos + 1] << 8) | stream[pos + 2]) + 1;
    const packedSize = ((stream[pos + 3] << 8) | stream[pos + 4]) + 1;
    walk.unpacked += unpackedSize;
    pos += LZMA2_LZMA_HEADER_BYTES + (mode >= LZMA2_MODE_NEW_PROPS ? LZMA2_PROPS_BYTES : 0) + packedSize;
  }
  throw new Error('LZMA2 stream ended without an end byte');
}

function withTempDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'lzma-levels-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function xzSize(data: Buffer, level: number): number {
  return execFileSync('xz', [`-${level}`, '-c', '-T1'], { input: data, maxBuffer: 64 * MEGABYTE }).length;
}

const CORPORA: ReadonlyArray<[string, Buffer]> = [
  ['English-like prose', zipfText(MEGABYTE, 459)],
  ['TypeScript-like source', sourceText(MEGABYTE, 460)],
];

describe('LZMA2 encoder ratio', () => {
  for (const [name, data] of CORPORA) {
    it(`reaches ${LEVEL9_MAX_RATIO} of the input at level 9 on 1 MB of ${name}`, () => {
      const packed = packXz(data, { compressionLevel: 9 });
      expect(packed.length / data.length).toBeLessThanOrEqual(LEVEL9_MAX_RATIO);
      expect(unpackXz(packed).equals(data)).toBe(true);
    }, TEST_TIMEOUT_MS);

    oracleTest(
      `stays within 5% of xz -6 at level 6 on 1 MB of ${name}`,
      ['xz'],
      () => {
        const ours = packXz(data, { compressionLevel: 6 }).length;
        expect(ours / xzSize(data, 6)).toBeLessThanOrEqual(LEVEL6_MAX_VS_XZ);
      },
      TEST_TIMEOUT_MS
    );
  }
});

describe('LZMA2 encoder validity', () => {
  for (const level of LEVELS) {
    oracleTest(
      `level ${level} output passes xz -t and xz -dc returns the input`,
      ['xz'],
      () => {
        const data = Buffer.concat([proseText(300_000, 11 + level), sourceText(200_000, 31 + level)]);
        const packed = packXz(data, { compressionLevel: level });
        withTempDir((dir) => {
          const file = join(dir, 'out.xz');
          writeFileSync(file, packed);
          execFileSync('xz', ['-t', file]);
          const decoded = execFileSync('xz', ['-dc', file], { maxBuffer: 64 * MEGABYTE });
          expect(decoded.length).toBe(data.length);
          expect(decoded.equals(data)).toBe(true);
        });
      },
      TEST_TIMEOUT_MS
    );
  }

  oracleTest(
    'xz -lvv reports the dictionary size of the level, capped by the input size',
    ['xz'],
    () => {
      // Input length -> the dictionary xz lists: the smallest 2^n or 3*2^(n-1) that holds the input.
      const cases: ReadonlyArray<[number, string]> = [
        [MEGABYTE, '1MiB'],
        [100_000, '128KiB'],
        [60_000, '64KiB'],
        [6000, '6KiB'],
      ];
      withTempDir((dir) => {
        for (const [length, expected] of cases) {
          const file = join(dir, `dict-${length}.xz`);
          writeFileSync(file, packXz(proseText(length, 5), { compressionLevel: 9 }));
          const listing = execFileSync('xz', ['-lvv', file], { encoding: 'utf8' });
          const dictionary = /--lzma2=dict=(\S+)/.exec(listing)?.[1];
          expect(dictionary, `input of ${length} bytes`).toBe(expected);
        }
      });
    },
    TEST_TIMEOUT_MS
  );

  oracleTest(
    'the raw LZMA streams of a 7z archive pass 7z t at each level',
    ['7z'],
    () => {
      const data = Buffer.concat([proseText(150_000, 71), sourceText(150_000, 72)]);
      for (const level of LEVELS) {
        const archive = create7zArchive([{ filename: 'doc.txt', buffer: data }], { compressionLevel: level }).buffer;
        withTempDir((dir) => {
          const file = join(dir, `level-${level}.7z`);
          writeFileSync(file, archive);
          const out = execFileSync('7z', ['t', file], { encoding: 'utf8' });
          expect(out).toContain('Everything is Ok');
          const content = execFileSync('7z', ['e', '-so', file, 'doc.txt'], { maxBuffer: 64 * MEGABYTE });
          expect(content.equals(data)).toBe(true);
        });
      }
    },
    TEST_TIMEOUT_MS
  );

  it('round-trips raw LZMA and LZMA2 through the decoder at every level', () => {
    const data = Buffer.concat([proseText(120_000, 91), Buffer.alloc(20_000, 0x61), sourceText(80_000, 92)]);
    for (const level of LEVELS) {
      const lzma = compressLzma(data, { level });
      expect(decompressLzma(lzma.buffer, lzma.props, data.length).equals(data)).toBe(true);
      const lzma2 = compressLzma2(data, { level });
      expect(decompressLzma2(lzma2.buffer, lzma2.props, data.length).equals(data)).toBe(true);
    }
  });

  it('round-trips random data of many sizes through the decoder', () => {
    const rng = new SeededRandom(2024);
    for (let i = 0; i < 40; i++) {
      const length = rng.below(6000);
      const alphabet = 1 + rng.below(8);
      const data = Buffer.alloc(length);
      for (let k = 0; k < length; k++) data[k] = rng.below(alphabet);
      const level = LEVELS[rng.below(LEVELS.length)];
      const out = compressLzma2(data, { level });
      expect(decompressLzma2(out.buffer, out.props, data.length).equals(data), `case ${i} length ${length} level ${level}`).toBe(true);
    }
  });

  oracleTest(
    'xz -dc agrees on fuzzed inputs including empty, one byte and incompressible data',
    ['xz'],
    () => {
      const rng = new SeededRandom(77);
      const cases: Buffer[] = [Buffer.alloc(0), Buffer.from([0]), Buffer.from('aa'), Buffer.alloc(70_000)];
      const noise = Buffer.alloc(150_000);
      for (let i = 0; i < noise.length; i++) noise[i] = rng.below(256);
      cases.push(noise);
      cases.push(Buffer.concat([proseText(40_000, 3), noise.subarray(0, 70_000), proseText(40_000, 4)]));
      withTempDir((dir) => {
        cases.forEach((data, index) => {
          const file = join(dir, `case-${index}.xz`);
          writeFileSync(file, packXz(data, { compressionLevel: LEVELS[index % LEVELS.length] }));
          const decoded = execFileSync('xz', ['-dc', file], { maxBuffer: 64 * MEGABYTE });
          expect(decoded.equals(data), `case ${index} of ${data.length} bytes`).toBe(true);
        });
      });
    },
    TEST_TIMEOUT_MS
  );
});

describe('LZMA2 chunk layer', () => {
  it('writes exactly one dictionary reset over a multi-chunk stream and carries state between chunks', () => {
    const data = Buffer.concat([proseText(700_000, 21), sourceText(700_000, 22)]);
    const out = compressLzma2(data, { level: 6 });
    const walk = walkLzma2(out.buffer);
    expect(walk.endsWithEnd).toBe(true);
    expect(walk.unpacked).toBe(data.length);
    expect(walk.chunks).toBeGreaterThan(2);
    expect(walk.dictionaryResets).toBe(1);
    // Compressible text never needs a model restart after the first chunk.
    expect(walk.rawChunks).toBe(0);
    expect(walk.stateResets).toBe(1);
  }, TEST_TIMEOUT_MS);

  it('stores incompressible data raw and restarts the model after it, with one dictionary reset', () => {
    const rng = new SeededRandom(5);
    const noise = Buffer.alloc(200_000);
    for (let i = 0; i < noise.length; i++) noise[i] = rng.below(256);
    const data = Buffer.concat([proseText(100_000, 8), noise, proseText(100_000, 9)]);
    const out = compressLzma2(data, { level: 3 });
    const walk = walkLzma2(out.buffer);
    expect(walk.unpacked).toBe(data.length);
    expect(walk.rawChunks).toBeGreaterThan(0);
    expect(walk.dictionaryResets).toBe(1);
    expect(decompressLzma2(out.buffer, out.props, data.length).equals(data)).toBe(true);
  });

  it('keeps every chunk inside the format limits', () => {
    const data = proseText(3 * MEGABYTE, 33);
    const out = compressLzma2(data, { level: 1 });
    let pos = 0;
    let chunks = 0;
    while (out.buffer[pos] !== LZMA2_END) {
      const control = out.buffer[pos];
      if (control === LZMA2_RAW_RESET || control === LZMA2_RAW) {
        pos += LZMA2_RAW_HEADER_BYTES + (((out.buffer[pos + 1] << 8) | out.buffer[pos + 2]) + 1);
      } else {
        const mode = (control >> LZMA2_MODE_SHIFT) & LZMA2_MODE_MASK;
        const packed = ((out.buffer[pos + 3] << 8) | out.buffer[pos + 4]) + 1;
        const unpacked = (((control & LZMA2_SIZE_HIGH_MASK) << 16) | (out.buffer[pos + 1] << 8) | out.buffer[pos + 2]) + 1;
        expect(unpacked).toBeLessThanOrEqual(1 << 21);
        expect(packed).toBeLessThanOrEqual(1 << 16);
        pos += LZMA2_LZMA_HEADER_BYTES + (mode >= LZMA2_MODE_NEW_PROPS ? LZMA2_PROPS_BYTES : 0) + packed;
      }
      chunks++;
    }
    expect(chunks).toBeGreaterThan(1);
    expect(pos).toBe(out.buffer.length - 1);
    expect(decompressLzma2(out.buffer, out.props, data.length).equals(data)).toBe(true);
  }, TEST_TIMEOUT_MS);
});

describe('LZMA encoder options', () => {
  it('rejects a level outside 0-9 with a typed error', () => {
    expect(() => compressLzma2(Buffer.from('abc'), { level: 10 })).toThrow(UnsupportedOptionError);
    expect(() => compressLzma(Buffer.from('abc'), { level: -1 })).toThrow(UnsupportedOptionError);
    expect(() => compressLzma(Buffer.from('abc'), { level: 2.5 })).toThrow(/integer from 0 to 9/);
  });

  it('rejects a non-positive dictionary size with a typed error', () => {
    expect(() => compressLzma2(Buffer.from('abc'), { dictSize: 0 })).toThrow(UnsupportedOptionError);
  });

  it('keeps the encoder memory bound a fixed named limit', () => {
    expect(LZMA_MAX_ENCODER_MEMORY).toBe(512 * MEGABYTE);
  });
});
