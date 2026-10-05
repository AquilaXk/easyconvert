import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { compressZstd, decompressZstd, getZstdBinaryPath, ZSTD_MAGIC_LE } from '../src/lib/conversions/zstd';
import { ConversionFailedError } from '../src/lib/types';
import { oracleTest } from './helpers/oracle-test';

// ---------------------------------------------------------------------------
// Deterministic corpora (generated here so the suite never depends on repo files)
// ---------------------------------------------------------------------------

const MIB = 1024 * 1024;
const BLOCK_MAX = 128 * 1024;
const LEVELS_UNDER_ORACLE = [1, 3, 9, 19];
const LEVEL3_RATIO_TARGET = 0.35;
const LEVEL19_RATIO_TARGET = 0.25;
/** The pure TypeScript encoder must stay within this factor of the reference encoder's size. */
const MAX_SIZE_FACTOR_VS_CLI = 1.15;
const BLOCK_TYPE_RAW = 0;
const BLOCK_TYPE_RLE = 1;
const BLOCK_TYPE_COMPRESSED = 2;

function makeRng(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x100000000;
  };
}

function noiseBytes(length: number, seed: number): Buffer {
  const rng = makeRng(seed);
  const out = Buffer.alloc(length);
  for (let i = 0; i < length; i++) out[i] = Math.floor(rng() * 256);
  return out;
}

function jsonRecords(length: number, seed: number): Buffer {
  const rng = makeRng(seed);
  const pick = (n: number): number => Math.floor(rng() * n);
  const names = ['alice', 'bob', 'carol', 'dave', 'erin', 'frank', 'grace', 'heidi', 'ivan', 'judy'];
  const statuses = ['active', 'pending', 'suspended', 'archived'];
  const tags = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta'];
  const rows: string[] = [];
  let total = 0;
  let id = 1000;
  while (total < length) {
    const row = JSON.stringify({
      id: id++,
      name: names[pick(names.length)] + pick(500),
      email: `${names[pick(names.length)]}${pick(9999)}@example.com`,
      status: statuses[pick(statuses.length)],
      score: pick(100000) / 100,
      tags: [tags[pick(8)], tags[pick(8)], tags[pick(8)]],
      address: { city: 'City' + pick(300), zip: String(10000 + pick(80000)), country: 'US' },
      createdAt: `2024-${String(1 + pick(12)).padStart(2, '0')}-${String(1 + pick(28)).padStart(2, '0')}T12:00:00Z`,
    });
    rows.push(row);
    total += row.length + 1;
  }
  return Buffer.from(rows.join('\n'), 'latin1').subarray(0, length);
}

/** Zipf-distributed pseudo-words grouped into sentences: English-like entropy and word reuse. */
function englishLikeText(length: number, vocabSize: number, seed: number): Buffer {
  const rng = makeRng(seed);
  const syllables = ['ba', 'ke', 'lo', 'mi', 'nu', 'ra', 'se', 'ti', 'vo', 'wa', 'xe', 'zi', 'an', 'el', 'in', 'or', 'um', 'st', 'tr', 'ch'];
  const vocab: string[] = [];
  for (let i = 0; i < vocabSize; i++) {
    const syllableCount = 1 + Math.floor(rng() * 3);
    let word = '';
    for (let k = 0; k < syllableCount; k++) word += syllables[Math.floor(rng() * syllables.length)];
    vocab.push(word);
  }
  const parts: string[] = [];
  let total = 0;
  let sentenceLength = 0;
  while (total < length) {
    const rank = Math.max(0, Math.floor(vocabSize ** rng()) - 1);
    let word = vocab[Math.min(vocabSize - 1, rank)];
    if (sentenceLength === 0) word = word[0].toUpperCase() + word.slice(1);
    sentenceLength++;
    const endsSentence = sentenceLength > 6 + Math.floor(rng() * 10);
    const comma = rng() < 0.08;
    let token = word + ' ';
    if (endsSentence) token = word + '.\n';
    else if (comma) token = word + ', ';
    if (endsSentence) sentenceLength = 0;
    parts.push(token);
    total += token.length;
  }
  return Buffer.from(parts.join('').slice(0, length), 'latin1');
}

/** Structured binary: little-endian records with slowly changing fields. */
function structuredBinary(length: number): Buffer {
  const out = Buffer.alloc(length);
  const recordSize = 16;
  for (let i = 0; i + recordSize <= length; i += recordSize) {
    const n = i / recordSize;
    out.writeUInt32LE(n, i);
    out.writeUInt16LE((n * 7) & 0xffff, i + 4);
    out.writeUInt16LE(0xbeef, i + 6);
    out.writeFloatLE(n * 0.25, i + 8);
    out.writeUInt32LE((0xdeadbeef ^ (n >> 4)) >>> 0, i + 12);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Independent frame structure parser and CLI helpers (oracles, not the code under test)
// ---------------------------------------------------------------------------

interface ParsedBlock {
  type: number;
  size: number;
  last: boolean;
}

interface ParsedFrame {
  singleSegment: boolean;
  checksumFlag: boolean;
  windowSize: number;
  contentSize: number | null;
  blocks: ParsedBlock[];
  totalLength: number;
}

function parseFrameStructure(frame: Buffer): ParsedFrame {
  expect(frame.subarray(0, 4).equals(ZSTD_MAGIC_LE)).toBe(true);
  let pos = 4;
  const fhd = frame[pos++];
  const fcsFlag = fhd >> 6;
  const singleSegment = ((fhd >> 5) & 1) === 1;
  const checksumFlag = ((fhd >> 2) & 1) === 1;
  expect(fhd & 0x03).toBe(0);
  let windowSize = 0;
  if (!singleSegment) {
    const descriptor = frame[pos++];
    const base = 2 ** (10 + (descriptor >> 3));
    windowSize = base + (base / 8) * (descriptor & 7);
  }
  let contentSize: number | null = null;
  if (fcsFlag === 0 && singleSegment) contentSize = frame[pos++];
  else if (fcsFlag === 1) {
    contentSize = frame.readUInt16LE(pos) + 256;
    pos += 2;
  } else if (fcsFlag === 2) {
    contentSize = frame.readUInt32LE(pos);
    pos += 4;
  }
  if (singleSegment && contentSize !== null) windowSize = contentSize;

  const blocks: ParsedBlock[] = [];
  let last = false;
  while (!last) {
    const header = frame[pos] | (frame[pos + 1] << 8) | (frame[pos + 2] << 16);
    pos += 3;
    last = (header & 1) === 1;
    const type = (header >> 1) & 3;
    const size = header >>> 3;
    blocks.push({ type, size, last });
    pos += type === BLOCK_TYPE_RLE ? 1 : size;
  }
  if (checksumFlag) pos += 4;
  return { singleSegment, checksumFlag, windowSize, contentSize, blocks, totalLength: pos };
}

/**
 * Independent oracle for a frame produced by compressZstd: checks the wire structure with the
 * test-local parser above and the content checksum with the BigInt XXH64 reference below.
 */
function assertFrameStructure(frame: Buffer, input: Buffer): ParsedFrame {
  const parsed = parseFrameStructure(frame);
  expect(parsed.totalLength).toBe(frame.length);
  expect(parsed.contentSize).toBe(input.length);
  expect(parsed.blocks.filter((b) => b.last)).toHaveLength(1);
  expect(parsed.blocks[parsed.blocks.length - 1].last).toBe(true);
  for (const block of parsed.blocks) expect(block.size).toBeLessThanOrEqual(BLOCK_MAX);
  if (parsed.checksumFlag) {
    expect(frame.readUInt32LE(frame.length - 4)).toBe(Number(referenceXxh64(input) & 0xffffffffn));
  }
  return parsed;
}

/** Straightforward BigInt XXH64 (seed 0) written from the public algorithm description. */
function referenceXxh64(data: Buffer): bigint {
  const mask = 0xffffffffffffffffn;
  const p1 = 11400714785074694791n;
  const p2 = 14029467366897019727n;
  const p3 = 1609587929392839161n;
  const p4 = 9650029242287828579n;
  const p5 = 2870177450012600261n;
  const rotl = (x: bigint, r: bigint): bigint => ((x << r) | (x >> (64n - r))) & mask;
  const round = (acc: bigint, input: bigint): bigint => (rotl((acc + input * p2) & mask, 31n) * p1) & mask;
  const merge = (acc: bigint, val: bigint): bigint => (((acc ^ round(0n, val)) * p1) + p4) & mask;
  let pos = 0;
  let hash: bigint;
  if (data.length >= 32) {
    let v1 = (p1 + p2) & mask;
    let v2 = p2;
    let v3 = 0n;
    let v4 = (0n - p1) & mask;
    while (pos + 32 <= data.length) {
      v1 = round(v1, data.readBigUInt64LE(pos));
      v2 = round(v2, data.readBigUInt64LE(pos + 8));
      v3 = round(v3, data.readBigUInt64LE(pos + 16));
      v4 = round(v4, data.readBigUInt64LE(pos + 24));
      pos += 32;
    }
    hash = (rotl(v1, 1n) + rotl(v2, 7n) + rotl(v3, 12n) + rotl(v4, 18n)) & mask;
    hash = merge(hash, v1);
    hash = merge(hash, v2);
    hash = merge(hash, v3);
    hash = merge(hash, v4);
  } else {
    hash = p5;
  }
  hash = (hash + BigInt(data.length)) & mask;
  while (pos + 8 <= data.length) {
    hash ^= round(0n, data.readBigUInt64LE(pos));
    hash = (rotl(hash, 27n) * p1 + p4) & mask;
    pos += 8;
  }
  if (pos + 4 <= data.length) {
    hash ^= (BigInt(data.readUInt32LE(pos)) * p1) & mask;
    hash = (rotl(hash, 23n) * p2 + p3) & mask;
    pos += 4;
  }
  while (pos < data.length) {
    hash ^= (BigInt(data[pos]) * p5) & mask;
    hash = (rotl(hash, 11n) * p1) & mask;
    pos++;
  }
  hash ^= hash >> 33n;
  hash = (hash * p2) & mask;
  hash ^= hash >> 29n;
  hash = (hash * p3) & mask;
  hash ^= hash >> 32n;
  return hash;
}

function zstdBinary(): string {
  const bin = getZstdBinaryPath();
  if (!bin) throw new Error('zstd CLI path unavailable although the oracle precondition passed.');
  return bin;
}

function cliCompress(input: Buffer, level: number, extraArgs: string[] = []): Buffer {
  return execFileSync(zstdBinary(), [`-${level}`, '-c', '-q', '-T1', ...extraArgs], {
    input,
    maxBuffer: 256 * MIB,
  });
}

function cliDecompress(frame: Buffer): Buffer {
  return execFileSync(zstdBinary(), ['-d', '-c', '-q'], { input: frame, maxBuffer: 256 * MIB });
}

function withTempFile<T>(data: Buffer, action: (file: string) => T): T {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zstd-engine-'));
  const file = path.join(dir, `${crypto.randomBytes(6).toString('hex')}.zst`);
  try {
    fs.writeFileSync(file, data);
    return action(file);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function cliTestPasses(frame: Buffer): boolean {
  return withTempFile(frame, (file) => {
    try {
      execFileSync(zstdBinary(), ['-t', '-q', file], { stdio: 'pipe' });
      return true;
    } catch {
      return false;
    }
  });
}

function cliFrameInfo(frame: Buffer): { windowSize: number; decompressedSize: number | null; checkHex: string | null; frames: number } {
  const text = withTempFile(frame, (file) => execFileSync(zstdBinary(), ['-lv', file], { encoding: 'utf8' }));
  const window = /Window Size: .*\((\d+) B\)/.exec(text);
  const size = /Decompressed Size: .*\((\d+) B\)/.exec(text);
  const check = /Check: XXH64 ([0-9a-f]+)/.exec(text);
  const frames = /# Zstandard Frames: (\d+)/.exec(text);
  if (!window || !frames) throw new Error(`Unparseable zstd -lv output: ${text}`);
  return {
    windowSize: Number(window[1]),
    decompressedSize: size ? Number(size[1]) : null,
    checkHex: check ? check[1] : null,
    frames: Number(frames[1]),
  };
}

// ---------------------------------------------------------------------------

describe('compressZstd', () => {
  it('compressZstd output is smaller than the input on compressible data', () => {
    const input = englishLikeText(64 * 1024, 500, 11);
    const compressed = compressZstd(input);
    assertFrameStructure(compressed, input);
    expect(compressed.length).toBeLessThan(input.length * 0.5);
    expect(Buffer.compare(decompressZstd(compressed), input)).toBe(0);
  });

  it('honors the level: higher levels never produce larger output on a 512 KiB text corpus', () => {
    const input = englishLikeText(512 * 1024, 2000, 3);
    const sizes = LEVELS_UNDER_ORACLE.map((level) => compressZstd(input, { level }).length);
    for (let i = 1; i < sizes.length; i++) {
      expect(sizes[i]).toBeLessThanOrEqual(sizes[i - 1]);
    }
    expect(sizes[sizes.length - 1]).toBeLessThan(sizes[0] * 0.95);
  });

  it('meets the ratio targets on a 1 MiB JSON-ish corpus (level 3 <= 0.35, level 19 <= 0.25)', () => {
    const input = jsonRecords(MIB, 21);
    const level3 = compressZstd(input, { level: 3 });
    const level19 = compressZstd(input, { level: 19 });
    assertFrameStructure(level3, input);
    assertFrameStructure(level19, input);
    expect(level3.length / input.length).toBeLessThanOrEqual(LEVEL3_RATIO_TARGET);
    expect(level19.length / input.length).toBeLessThanOrEqual(LEVEL19_RATIO_TARGET);
    expect(Buffer.compare(decompressZstd(level3), input)).toBe(0);
    expect(Buffer.compare(decompressZstd(level19), input)).toBe(0);
  });

  it('emits Compressed blocks within the 128 KiB limit, a content size, and the checksum flag by default', () => {
    const input = jsonRecords(300 * 1024, 5);
    const frame = compressZstd(input);
    const parsed = parseFrameStructure(frame);
    expect(parsed.checksumFlag).toBe(true);
    expect(parsed.contentSize).toBe(input.length);
    expect(parsed.totalLength).toBe(frame.length);
    expect(parsed.blocks).toHaveLength(3);
    expect(parsed.blocks.map((b) => b.type)).toEqual([BLOCK_TYPE_COMPRESSED, BLOCK_TYPE_COMPRESSED, BLOCK_TYPE_COMPRESSED]);
    expect(parsed.blocks.map((b) => b.last)).toEqual([false, false, true]);
    for (const block of parsed.blocks) expect(block.size).toBeLessThanOrEqual(BLOCK_MAX);
    // The trailing 4 bytes are the low 32 bits of XXH64 (seed 0) over the content, little endian.
    expect(frame.readUInt32LE(frame.length - 4)).toBe(Number(referenceXxh64(input) & 0xffffffffn));
  });

  it('omits the checksum when requested and still round-trips', () => {
    const input = jsonRecords(40 * 1024, 6);
    const frame = compressZstd(input, { checksum: false });
    const parsed = assertFrameStructure(frame, input);
    expect(parsed.checksumFlag).toBe(false);
    expect(Buffer.compare(decompressZstd(frame), input)).toBe(0);
  });

  it('declares a window descriptor when the input exceeds the level window', () => {
    // Level 1 declares a 2^19 window; 1.5 MiB of text must therefore use a window descriptor.
    const input = englishLikeText(1536 * 1024, 500, 4);
    const frame = compressZstd(input, { level: 1 });
    const parsed = assertFrameStructure(frame, input);
    expect(parsed.singleSegment).toBe(false);
    expect(parsed.windowSize).toBe(2 ** 19);
    expect(Buffer.compare(decompressZstd(frame), input)).toBe(0);
  });

  it('rejects unsupported levels with a typed error', () => {
    const input = Buffer.from('level validation');
    for (const level of [0, 20, -1, 3.5, Number.NaN]) {
      expect(() => compressZstd(input, { level })).toThrow(ConversionFailedError);
    }
  });

  describe('fuzz corpus round-trips through the repo decoder', () => {
    const corpus: Array<[string, Buffer]> = [
      ['0-byte', Buffer.alloc(0)],
      ['1-byte', Buffer.from([0x41])],
      ['3-byte', Buffer.from('abc')],
      ['all-zeros 1000 B', Buffer.alloc(1000)],
      ['random 100 KiB', noiseBytes(100 * 1024, 99)],
      ['repetitive 4 KiB pattern x 8', Buffer.concat(Array.from({ length: 8 }, () => noiseBytes(4096, 7)))],
      ['structured binary 200 KiB', structuredBinary(200 * 1024)],
      ['json 150 KiB', jsonRecords(150 * 1024, 8)],
      ['mixed random+text', Buffer.concat([noiseBytes(5000, 1), englishLikeText(30000, 300, 2), noiseBytes(5000, 3)])],
    ];
    for (const [name, input] of corpus) {
      for (const level of LEVELS_UNDER_ORACLE) {
        it(`${name} at level ${level}`, () => {
          const frame = compressZstd(input, { level });
          const parsed = assertFrameStructure(frame, input);
          const restored = decompressZstd(frame);
          expect(restored.length).toBe(input.length);
          expect(Buffer.compare(restored, input)).toBe(0);
          if (name.startsWith('random')) {
            // Incompressible data must fall back to Raw blocks with only framing overhead.
            expect(parsed.blocks.every((b) => b.type === BLOCK_TYPE_RAW)).toBe(true);
            expect(frame.length).toBeLessThanOrEqual(input.length + 3 * parsed.blocks.length + 4 + 4 + 1 + 4);
          }
        });
      }
    }

    it('compresses an all-zero megabyte to a tiny frame that the bomb guard refuses to expand', () => {
      const zeros = Buffer.alloc(MIB);
      const frame = compressZstd(zeros, { level: 3 });
      assertFrameStructure(frame, zeros);
      expect(frame.length).toBeLessThan(64);
      expect(() => decompressZstd(frame)).toThrow(/Archive bomb detected/);
    });
  });
});

describe('compressZstd against the zstd CLI', () => {
  oracleTest('CLI -t accepts and -d reproduces the input at levels 1, 3, 9 and 19', ['zstd'], () => {
    const inputs: Array<[string, Buffer]> = [
      ['json', jsonRecords(400 * 1024, 31)],
      ['english', englishLikeText(400 * 1024, 2000, 32)],
      ['binary', structuredBinary(300 * 1024)],
      ['random', noiseBytes(70 * 1024, 33)],
      ['empty', Buffer.alloc(0)],
      ['zeros', Buffer.alloc(MIB)],
    ];
    for (const [name, input] of inputs) {
      for (const level of LEVELS_UNDER_ORACLE) {
        const frame = compressZstd(input, { level });
        expect(cliTestPasses(frame), `${name} level ${level}: zstd -t`).toBe(true);
        const decoded = cliDecompress(frame);
        expect(decoded.length, `${name} level ${level}: length`).toBe(input.length);
        expect(Buffer.compare(decoded, input), `${name} level ${level}: bytes`).toBe(0);
      }
    }
  });

  oracleTest('zstd -lv reports the declared window, content size and the same XXH64 check as the CLI', ['zstd'], () => {
    const small = jsonRecords(50 * 1024, 41);
    const smallInfo = cliFrameInfo(compressZstd(small));
    expect(smallInfo.frames).toBe(1);
    expect(smallInfo.decompressedSize).toBe(small.length);
    expect(smallInfo.windowSize).toBe(small.length);
    expect(smallInfo.checkHex).toBe(cliFrameInfo(cliCompress(small, 3)).checkHex);

    const large = englishLikeText(1536 * 1024, 500, 42);
    const largeInfo = cliFrameInfo(compressZstd(large, { level: 1 }));
    expect(largeInfo.decompressedSize).toBe(large.length);
    expect(largeInfo.windowSize).toBe(2 ** 19);
    expect(largeInfo.checkHex).toBe(cliFrameInfo(cliCompress(large, 1)).checkHex);
  });

  oracleTest('compression ratio meets the targets and stays within 15% of the CLI at the same level', ['zstd'], () => {
    const corpora: Array<[string, Buffer]> = [
      ['json', jsonRecords(MIB, 51)],
      ['english', englishLikeText(MIB, 500, 52)],
    ];
    const ratios = new Map<string, number>();
    for (const [name, input] of corpora) {
      for (const level of [3, 19]) {
        const ours = compressZstd(input, { level }).length;
        const reference = cliCompress(input, level).length;
        expect(ours / reference, `${name} level ${level} size vs CLI`).toBeLessThanOrEqual(MAX_SIZE_FACTOR_VS_CLI);
        ratios.set(`${name}:${level}:ours`, ours / input.length);
        ratios.set(`${name}:${level}:cli`, reference / input.length);
      }
    }
    // The absolute targets are meaningful because the reference encoder meets them on the same corpus.
    for (const who of ['cli', 'ours']) {
      expect(ratios.get(`json:3:${who}`)).toBeLessThanOrEqual(LEVEL3_RATIO_TARGET);
      expect(ratios.get(`json:19:${who}`)).toBeLessThanOrEqual(LEVEL19_RATIO_TARGET);
    }
  });
});

describe('decompressZstd', () => {
  oracleTest('decodes CLI-produced frames at every level from 1 to 19 (streamed frames without a content size)', ['zstd'], () => {
    const inputs: Array<[string, Buffer]> = [
      ['json', jsonRecords(300 * 1024, 61)],
      ['english', englishLikeText(260 * 1024, 2000, 62)],
      ['binary', structuredBinary(140 * 1024)],
      ['mixed', Buffer.concat([noiseBytes(40000, 63), englishLikeText(150000, 800, 64), structuredBinary(60000)])],
    ];
    for (const [name, input] of inputs) {
      for (let level = 1; level <= 19; level++) {
        const frame = cliCompress(input, level);
        const restored = decompressZstd(frame);
        expect(restored.length, `${name} level ${level}: length`).toBe(input.length);
        expect(Buffer.compare(restored, input), `${name} level ${level}: bytes`).toBe(0);
      }
    }
  });

  oracleTest('decodes CLI frames with a content size, without a checksum, and with long-distance matching', ['zstd'], () => {
    const input = Buffer.concat([jsonRecords(200 * 1024, 71), englishLikeText(200 * 1024, 700, 72)]);
    const variants: string[][] = [
      ['--content-size'],
      ['--no-check'],
      ['--long=24'],
      ['--zstd=wlog=20,strat=7'],
      ['--zstd=strat=9,wlog=24,hlog=20,clog=20,slog=6,mml=3,tlen=999'],
      ['--format=zstd', '--no-dictID'],
    ];
    for (const args of variants) {
      const frame = cliCompress(input, 9, args);
      const restored = decompressZstd(frame);
      expect(Buffer.compare(restored, input), args.join(' ')).toBe(0);
    }
    const smallFrame = cliCompress(Buffer.from('tiny payload for a tiny frame'), 3);
    expect(decompressZstd(smallFrame).toString('latin1')).toBe('tiny payload for a tiny frame');
  });

  oracleTest('decodes concatenated CLI frames and skips skippable frames', ['zstd'], () => {
    const first = jsonRecords(30 * 1024, 81);
    const second = englishLikeText(30 * 1024, 300, 82);
    const skippable = Buffer.alloc(8 + 5);
    skippable.writeUInt32LE(0x184d2a53, 0);
    skippable.writeUInt32LE(5, 4);
    const secondFrame = compressZstd(second, { level: 5 });
    assertFrameStructure(secondFrame, second);
    const combined = Buffer.concat([cliCompress(first, 3), skippable, secondFrame]);
    const restored = decompressZstd(combined);
    expect(Buffer.compare(restored, Buffer.concat([first, second]))).toBe(0);
  });

  it('enforces the decoder window cap before decoding anything', () => {
    // Window descriptor exponent 18 declares 2^28 bytes, above the 2^27 cap, followed by an empty last raw block.
    const oversize = Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x00, 18 << 3, 0x01, 0x00, 0x00]);
    expect(() => decompressZstd(oversize)).toThrow(ConversionFailedError);
    expect(() => decompressZstd(oversize)).toThrow(/window size .* exceeds the decoder limit/i);

    const atCap = Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x00, 17 << 3, 0x01, 0x00, 0x00]);
    expect(decompressZstd(atCap).length).toBe(0);
  });

  it('surfaces malformed streams as ConversionFailedError without any fallback decoder', () => {
    const input = jsonRecords(80 * 1024, 91);
    const frame = compressZstd(input, { level: 5 });
    assertFrameStructure(frame, input);
    const failures: Buffer[] = [
      frame.subarray(0, 9),
      frame.subarray(0, 100),
      frame.subarray(0, frame.length - 1),
      Buffer.concat([frame, Buffer.from([0x00, 0x01])]),
      Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x08, 0x00, 0x00, 0x00, 0x00]),
    ];
    for (const broken of failures) {
      expect(() => decompressZstd(broken)).toThrow(ConversionFailedError);
    }
  });

  it('never returns altered data for randomly corrupted frames', () => {
    const input = jsonRecords(60 * 1024, 92);
    const frame = compressZstd(input, { level: 6 });
    assertFrameStructure(frame, input);
    const rng = makeRng(777);
    let rejected = 0;
    for (let i = 0; i < 300; i++) {
      const mutated = Buffer.from(frame);
      const flips = 1 + Math.floor(rng() * 3);
      for (let k = 0; k < flips; k++) {
        const index = Math.floor(rng() * mutated.length);
        mutated[index] ^= 1 << Math.floor(rng() * 8);
      }
      try {
        const restored = decompressZstd(mutated);
        // Only benign flips (for example the unused header bit) may decode, and then to the exact input.
        expect(Buffer.compare(restored, input)).toBe(0);
      } catch (error) {
        expect(error).toBeInstanceOf(ConversionFailedError);
        rejected++;
      }
    }
    expect(rejected).toBeGreaterThan(250);
  });

  it('rejects a content size that disagrees with the decoded length', () => {
    const input = Buffer.from('content size tamper check, content size tamper check');
    const frame = compressZstd(input);
    expect(assertFrameStructure(frame, input).singleSegment).toBe(true);
    const tampered = Buffer.from(frame);
    tampered[5] = input.length + 1;
    expect(() => decompressZstd(tampered)).toThrow(/content size mismatch/i);
  });

  oracleTest('rejects tampered CLI frames in agreement with zstd -t', ['zstd'], () => {
    const input = englishLikeText(120 * 1024, 900, 93);
    const frame = cliCompress(input, 7);
    const rng = makeRng(4242);
    let agreed = 0;
    for (let i = 0; i < 40; i++) {
      const mutated = Buffer.from(frame);
      mutated[8 + Math.floor(rng() * (mutated.length - 8))] ^= 1 << Math.floor(rng() * 8);
      const cliAccepts = cliTestPasses(mutated);
      let repoAccepts = true;
      try {
        decompressZstd(mutated);
      } catch (error) {
        expect(error).toBeInstanceOf(ConversionFailedError);
        repoAccepts = false;
      }
      expect(repoAccepts).toBe(cliAccepts);
      agreed++;
    }
    expect(agreed).toBe(40);
  });
});
