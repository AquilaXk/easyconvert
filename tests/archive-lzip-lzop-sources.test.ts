import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { convertFile } from '../src/lib/conversions';
import { decompressLzip } from '../src/lib/conversions/lzip';
import { decompressLzo1xBlock } from '../src/lib/conversions/lzo1x';
import { decompressLzop } from '../src/lib/conversions/lzop';
import { CorruptStreamError, DecompressionLimitError } from '../src/lib/types';
import { oracleTest } from './helpers/oracle-test';
import { requireOracleTool } from './helpers/differential-oracle';
import { fileDigests, readArchiveTree, unpackWith } from './helpers/archive-output-tree';

/**
 * lzip (`.lz`) and lzop (`.lzo`, `.tar.lzo`, `.tzo`) files are read in process: 7-Zip opens neither. The inputs are real
 * files written by lzip 1.24 and lzop 1.04 (tests/fixtures/archive-sources/PROVENANCE); the expected bytes are the
 * literals those tools were given. Beyond the fixtures, the tools themselves compress generated data of every shape and
 * size and the readers must return it byte for byte.
 */

const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'archive-sources');
const NO_LIMIT = Number.MAX_SAFE_INTEGER;
const MIB = 1024 * 1024;
const BYTE_VALUES = 256;
const CONVERT_TIMEOUT_MS = 120_000;

const fixture = (name: string): Buffer => fs.readFileSync(path.join(FIXTURE_DIR, name));

/** The 400-line text of long.txt (15,600 bytes). */
const LONG_TEXT = Buffer.from(Array.from({ length: 400 }, (_unused, i) => `line ${String(i).padStart(4, '0')} of the archive probe payload\n`).join(''));
/** multiblock.txt: 12,000 lines in which each line repeats ten times, 468,000 bytes, which lzop writes as two blocks. */
const MULTIBLOCK_TEXT = Buffer.from(
  Array.from({ length: 12_000 }, (_unused, i) => `line ${String(Math.floor(i / 10)).padStart(6, '0')} of the multi block payload\n`).join('')
);
const TREE_FILES: Readonly<Record<string, Buffer>> = {
  'hello.txt': Buffer.from('hello archive\n'),
  'dir/nested.txt': Buffer.from('nested file\n'),
  'dir/data.bin': Buffer.from(Array.from({ length: BYTE_VALUES }, (_unused, i) => i)),
};

const LZOP_TEXT_FIXTURES: Array<[string, Buffer]> = [
  ['long.txt.lzo', LONG_TEXT],
  ['long-best-crc32.txt.lzo', LONG_TEXT],
  ['long-nochecksum.txt.lzo', LONG_TEXT],
  ['multiblock.txt.lzo', MULTIBLOCK_TEXT],
];
const LZIP_TEXT_FIXTURES: Array<[string, Buffer]> = [
  ['long.txt.lz', LONG_TEXT],
  ['two-members.txt.lz', LONG_TEXT],
];

function expectCorrupt(operation: () => unknown, pattern: RegExp): void {
  let failure: unknown;
  try {
    operation();
  } catch (err) {
    failure = err;
  }
  expect(failure).toBeInstanceOf(CorruptStreamError);
  expect((failure as Error).message).toMatch(pattern);
}

// ---------------------------------------------------------------------------------------------------------------------
// LZO1X blocks, assembled by hand from the instruction set (every expected output is worked out on paper).
// ---------------------------------------------------------------------------------------------------------------------

const END_MARKER = [0x11, 0x00, 0x00];
const bytes = (...parts: Array<number | string | number[]>): Uint8Array =>
  Uint8Array.from(parts.flatMap((part) => (typeof part === 'string' ? [...Buffer.from(part, 'latin1')] : Array.isArray(part) ? part : [part])));

describe('LZO1X block decoding', () => {
  it('decodes a block that is only the end marker to nothing', () => {
    expect(decompressLzo1xBlock(bytes(END_MARKER), 0)).toEqual(new Uint8Array(0));
  });

  it('decodes a leading literal run of four or more bytes (first byte 17 + count)', () => {
    expect(Buffer.from(decompressLzo1xBlock(bytes(17 + 5, 'abcde', END_MARKER), 5)).toString()).toBe('abcde');
  });

  it('decodes a leading literal run of fewer than four bytes', () => {
    expect(Buffer.from(decompressLzo1xBlock(bytes(17 + 2, 'ab', END_MARKER), 2)).toString()).toBe('ab');
  });

  it('decodes a two-byte match after three literals, then a four-byte match, overlapping its own output', () => {
    // 3 literals "abc"; instruction 0b0000_10_00 + 0x00: a 2-byte match at distance 1 + 2 + (0 << 2) = 3 copies "ab";
    // 0x68 = 0b011_010_00 + 0x00: length (0x68 >> 5) + 1 = 4, distance ((0x68 >> 2) & 7) + 1 = 3 copies "cabc".
    const block = bytes(17 + 3, 'abc', 0x08, 0x00, 0x68, 0x00, END_MARKER);
    expect(Buffer.from(decompressLzo1xBlock(block, 9)).toString()).toBe('abcabcabc');
  });

  it('decodes a match that repeats one byte (distance 1 overlaps the bytes being written)', () => {
    // "x", then M3 0b001_00011: length 3 + 2 = 5, distance 1 (the 16-bit field 0 means distance 0 + 1).
    expect(Buffer.from(decompressLzo1xBlock(bytes(17 + 1, 'x', 0x23, 0x00, 0x00, END_MARKER), 6)).toString()).toBe('xxxxxx');
  });

  it('decodes the literal count of a run that carries a length extension (zero bytes of 255 each)', () => {
    // Instruction 0 in state 0: 15 + (255 + 1) + 3 = 274 literals.
    const literals = Buffer.alloc(274, 'q');
    const decoded = decompressLzo1xBlock(bytes(0x00, 0x00, 0x01, [...literals], END_MARKER), 274);
    expect(Buffer.from(decoded).equals(literals)).toBe(true);
  });

  it('decodes a long-distance match (instruction 16 to 31) and the literals that follow a match', () => {
    // 16,400 literals (count 15 + 16,382 + 3 with the extension 64 zero bytes then 62), then M4 length 5 at distance
    // 16,384 + 6 = 16,390, then two trailing literals (the low two bits of the 16-bit field) "yz".
    const literals = Buffer.from(Array.from({ length: 16_400 }, (_unused, i) => (i * 7 + (i >> 8)) & 0xff));
    const block = bytes(0x00, new Array(64).fill(0), 62, [...literals], 0x13, (6 << 2) | 2, 0x00, 'yz', END_MARKER);
    const expected = Buffer.concat([literals, literals.subarray(16_400 - 16_390, 16_400 - 16_390 + 5), Buffer.from('yz')]);
    expect(Buffer.from(decompressLzo1xBlock(block, expected.length)).equals(expected)).toBe(true);
  });

  it('refuses a match that reaches before the start of the block', () => {
    expectCorrupt(() => decompressLzo1xBlock(bytes(17 + 3, 'abc', 0x08, 0x04, END_MARKER), 5), /before the start of the block/);
  });

  it('refuses output longer than the stated block size, and shorter', () => {
    expectCorrupt(() => decompressLzo1xBlock(bytes(17 + 5, 'abcde', END_MARKER), 4), /exceeds the stated block size/);
    expectCorrupt(() => decompressLzo1xBlock(bytes(17 + 5, 'abcde', END_MARKER), 6), /ends after 5 of 6 bytes/);
  });

  it('refuses a block cut off inside an instruction, a literal run or the length extension', () => {
    expectCorrupt(() => decompressLzo1xBlock(bytes(17 + 5, 'abcde', 0x11), 5), /input ends inside an instruction/);
    expectCorrupt(() => decompressLzo1xBlock(bytes(17 + 5, 'ab'), 5), /literal run reaches past the input/);
    expectCorrupt(() => decompressLzo1xBlock(bytes(0x00, 0x00, 0x00), 1000), /input ends inside an instruction/);
    expectCorrupt(() => decompressLzo1xBlock(bytes(), 0), /input ends inside an instruction/);
  });

  it('refuses a block without its end marker and one with data after it', () => {
    expectCorrupt(() => decompressLzo1xBlock(bytes(17 + 5, 'abcde'), 5), /input ends inside an instruction/);
    expectCorrupt(() => decompressLzo1xBlock(bytes(17 + 5, 'abcde', END_MARKER, 'zz'), 5), /data follows the end-of-stream marker/);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// lzop files
// ---------------------------------------------------------------------------------------------------------------------

describe('lzop files written by lzop', () => {
  for (const [file, expected] of LZOP_TEXT_FIXTURES) {
    it(`${file} decodes to the text it was given`, () => {
      expect(decompressLzop(fixture(file), NO_LIMIT).equals(expected)).toBe(true);
    });
  }

  it('tree.tar.lzo decodes to a tar of the three files', () => {
    const tar = decompressLzop(fixture('tree.tar.lzo'), NO_LIMIT);
    expect(tar).toHaveLength(10_240);
    expect(tar.toString('latin1', 257, 262)).toBe('ustar');
  });

  it('refuses an output over the limit before decoding the block that would pass it', () => {
    expect(() => decompressLzop(fixture('long.txt.lzo'), LONG_TEXT.length - 1)).toThrow(DecompressionLimitError);
    expect(decompressLzop(fixture('long.txt.lzo'), LONG_TEXT.length)).toHaveLength(LONG_TEXT.length);
  });

  it('refuses a flipped byte in the compressed data (the block checksum or the decoder notices)', () => {
    for (const [file] of LZOP_TEXT_FIXTURES) {
      const damaged = Buffer.from(fixture(file));
      damaged[Math.floor(damaged.length / 2)] ^= 0x40;
      expect(() => decompressLzop(damaged, NO_LIMIT), file).toThrow(CorruptStreamError);
    }
  });

  it('refuses a damaged header, a truncated file, trailing data and a file that is not lzop', () => {
    const intact = fixture('long.txt.lzo');
    const header = Buffer.from(intact);
    header[20] ^= 0x01;
    expectCorrupt(() => decompressLzop(header, NO_LIMIT), /header checksum/);
    expectCorrupt(() => decompressLzop(intact.subarray(0, intact.length - 9), NO_LIMIT), /input ends inside the file structure/);
    expectCorrupt(() => decompressLzop(Buffer.concat([intact, Buffer.from('x')]), NO_LIMIT), /data follows the end of the file/);
    expectCorrupt(() => decompressLzop(Buffer.from('not an lzop file at all'), NO_LIMIT), /magic is missing/);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// An lzop container assembled by hand, to reach the header flags lzop only writes on request.
// ---------------------------------------------------------------------------------------------------------------------

const LZOP_MAGIC = Buffer.from([0x89, 0x4c, 0x5a, 0x4f, 0x00, 0x0d, 0x0a, 0x1a, 0x0a]);
const ADLER_MODULUS = 65521;

function adler32(data: Uint8Array): number {
  let low = 1;
  let high = 0;
  for (const byte of data) {
    low = (low + byte) % ADLER_MODULUS;
    high = (high + low) % ADLER_MODULUS;
  }
  return ((high << 16) | low) >>> 0;
}

function u32(value: number): Buffer {
  const out = Buffer.alloc(4);
  out.writeUInt32BE(value >>> 0);
  return out;
}

interface LzoBlock {
  data: Buffer;
  compressed: Buffer;
}

interface HandBuiltLzop {
  flags: number;
  version?: number;
  method?: number;
  /** A Buffer is a stored block (compressed length equal to uncompressed length); an object is an LZO1X block and the bytes it decodes to. */
  blocks: Array<Buffer | LzoBlock>;
  /** Replaces a block's declared uncompressed length, for the oversize checks. */
  declaredLength?: number;
}

const F_ADLER32_D = 0x1;
const F_ADLER32_C = 0x2;
const F_CRC32_C = 0x200;
const F_CRC32_D = 0x100;
const F_MULTIPART = 0x400;
const F_FILTER = 0x800;
const F_H_CRC32 = 0x1000;

function buildLzop(spec: HandBuiltLzop): Buffer {
  const name = Buffer.from('hand.bin');
  const fields = Buffer.concat([
    Buffer.from([(spec.version ?? 0x1040) >> 8, (spec.version ?? 0x1040) & 0xff, 0x20, 0xa0, 0x09, 0x40, spec.method ?? 1, 1]),
    u32(spec.flags),
    ...(spec.flags & F_FILTER ? [u32(1)] : []),
    u32(0o100644),
    u32(0),
    u32(0),
    Buffer.from([name.length]),
    name,
  ]);
  const headerChecksum = spec.flags & F_H_CRC32 ? zlib.crc32(fields) : adler32(fields);
  const parts = [LZOP_MAGIC, fields, u32(headerChecksum)];
  for (const block of spec.blocks) {
    const { data, compressed } = Buffer.isBuffer(block) ? { data: block, compressed: block } : block;
    parts.push(u32(spec.declaredLength ?? data.length), u32(compressed.length));
    // Order of the format: the checksum of the decompressed block, then (for a block that is not stored) of the compressed one.
    if (spec.flags & F_CRC32_D) parts.push(u32(zlib.crc32(data)));
    else if (spec.flags & F_ADLER32_D) parts.push(u32(adler32(data)));
    if (compressed !== data) {
      if (spec.flags & F_CRC32_C) parts.push(u32(zlib.crc32(compressed)));
      else if (spec.flags & F_ADLER32_C) parts.push(u32(adler32(compressed)));
    }
    parts.push(compressed);
  }
  parts.push(u32(0));
  return Buffer.concat(parts);
}

describe('the lzop container', () => {
  const PAYLOAD = Buffer.from('stored block payload');

  it('reads stored blocks under each checksum flag, including a CRC-32 header checksum', () => {
    for (const flags of [0, F_ADLER32_D, F_CRC32_D, F_H_CRC32 | F_CRC32_D]) {
      const file = buildLzop({ flags, blocks: [PAYLOAD, PAYLOAD] });
      expect(decompressLzop(file, NO_LIMIT).equals(Buffer.concat([PAYLOAD, PAYLOAD])), `flags ${flags.toString(16)}`).toBe(true);
    }
  });

  it('refuses a stored block whose checksum is wrong', () => {
    const file = buildLzop({ flags: F_ADLER32_D, blocks: [PAYLOAD] });
    file[file.length - 5] ^= 0x01;
    expectCorrupt(() => decompressLzop(file, NO_LIMIT), /decompressed block checksum/);
  });

  // 'x' then a 299-byte match at distance 1 (length 33 + 255 + 11), then the end marker: 10 bytes that decode to 300.
  const COMPRESSED_X300 = Buffer.from([18, 0x78, 0x20, 0x00, 0x0b, 0x00, 0x00, 0x11, 0x00, 0x00]);
  const LZO_BLOCK: LzoBlock = { data: Buffer.alloc(300, 'x'), compressed: COMPRESSED_X300 };
  const CHECKSUM_FLAGS: Array<[string, number]> = [
    ['no checksum', 0],
    ['Adler-32 of the decompressed block', F_ADLER32_D],
    ['CRC-32 of the decompressed block', F_CRC32_D],
    ['Adler-32 of the compressed block', F_ADLER32_C],
    ['CRC-32 of the compressed block', F_CRC32_C],
    ['Adler-32 of both', F_ADLER32_D | F_ADLER32_C],
    ['CRC-32 of both', F_CRC32_D | F_CRC32_C],
    ['CRC-32 of the decompressed and Adler-32 of the compressed block', F_CRC32_D | F_ADLER32_C],
  ];

  it('decodes an LZO1X block under every checksum flag, the decompressed checksum written before the compressed one', () => {
    for (const [label, flags] of CHECKSUM_FLAGS) {
      expect(decompressLzop(buildLzop({ flags, blocks: [LZO_BLOCK] }), NO_LIMIT).equals(LZO_BLOCK.data), label).toBe(true);
    }
  });

  it('refuses an LZO1X block whose compressed-block checksum is wrong, before it decodes the block', () => {
    for (const [label, flags] of CHECKSUM_FLAGS.filter(([, f]) => (f & (F_ADLER32_C | F_CRC32_C)) !== 0)) {
      const file = buildLzop({ flags, blocks: [LZO_BLOCK] });
      // The compressed checksum is the last word before the compressed bytes.
      file[file.length - 4 - COMPRESSED_X300.length - 1] ^= 0x01;
      expect(() => decompressLzop(file, NO_LIMIT), label).toThrow(/Corrupt lzop data: the compressed block checksum/);
    }
  });

  it('refuses an LZO1X block whose decompressed-block checksum is wrong', () => {
    for (const [label, flags] of CHECKSUM_FLAGS.filter(([, f]) => (f & (F_ADLER32_D | F_CRC32_D)) !== 0)) {
      const file = buildLzop({ flags, blocks: [LZO_BLOCK] });
      // The decompressed checksum follows the two lengths; the compressed one, when present, sits between it and the data.
      const compressedChecksumBytes = (flags & (F_ADLER32_C | F_CRC32_C)) !== 0 ? 4 : 0;
      file[file.length - 4 - COMPRESSED_X300.length - compressedChecksumBytes - 1] ^= 0x01;
      expect(() => decompressLzop(file, NO_LIMIT), label).toThrow(/Corrupt lzop data: the decompressed block checksum/);
    }
  });

  it('refuses an LZO1X block whose bytes were damaged under a compressed-block checksum, and one the decoder cannot read under none', () => {
    const withChecksum = buildLzop({ flags: F_CRC32_C, blocks: [LZO_BLOCK] });
    withChecksum[withChecksum.length - 4 - 3] ^= 0x40;
    expectCorrupt(() => decompressLzop(withChecksum, NO_LIMIT), /compressed block checksum/);
    const noChecksum = buildLzop({ flags: 0, blocks: [{ data: LZO_BLOCK.data, compressed: Buffer.from(COMPRESSED_X300.subarray(0, 6)) }] });
    expectCorrupt(() => decompressLzop(noChecksum, NO_LIMIT), /input ends inside an instruction/);
  });

  it('writes no compressed-block checksum for a stored block, whatever the flags say', () => {
    for (const flags of [F_ADLER32_C, F_CRC32_C, F_ADLER32_D | F_ADLER32_C, F_CRC32_D | F_CRC32_C]) {
      expect(decompressLzop(buildLzop({ flags, blocks: [PAYLOAD] }), NO_LIMIT).equals(PAYLOAD), flags.toString(16)).toBe(true);
    }
  });

  it('refuses multi-part files, filters, old header versions, other methods and oversized or invalid blocks', () => {
    expectCorrupt(() => decompressLzop(buildLzop({ flags: F_MULTIPART, blocks: [PAYLOAD] }), NO_LIMIT), /multi-part/);
    expectCorrupt(() => decompressLzop(buildLzop({ flags: F_FILTER, blocks: [PAYLOAD] }), NO_LIMIT), /filter/);
    expectCorrupt(() => decompressLzop(buildLzop({ flags: 0, version: 0x0900, blocks: [PAYLOAD] }), NO_LIMIT), /older than this reader supports/);
    expectCorrupt(() => decompressLzop(buildLzop({ flags: 0, method: 0x40, blocks: [PAYLOAD] }), NO_LIMIT), /not an LZO1X method/);
    expectCorrupt(() => decompressLzop(buildLzop({ flags: 0, blocks: [PAYLOAD], declaredLength: 65 * MIB }), NO_LIMIT), /larger than the format allows/);
    expectCorrupt(() => decompressLzop(buildLzop({ flags: 0, blocks: [PAYLOAD], declaredLength: 8 }), NO_LIMIT), /invalid compressed length/);
  });

  it('checks the declared size against the limit before it reads the block', () => {
    const file = buildLzop({ flags: 0, blocks: [PAYLOAD], declaredLength: 32 * MIB });
    expect(() => decompressLzop(file.subarray(0, file.length - 4 - PAYLOAD.length), 10 * MIB)).toThrow(DecompressionLimitError);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// lzip files
// ---------------------------------------------------------------------------------------------------------------------

describe('lzip files written by lzip', () => {
  for (const [file, expected] of LZIP_TEXT_FIXTURES) {
    it(`${file} decodes to the text it was given`, () => {
      expect(decompressLzip(fixture(file), NO_LIMIT).equals(expected)).toBe(true);
    });
  }

  it('tree.tar.lz decodes to a tar of the three files', () => {
    const tar = decompressLzip(fixture('tree.tar.lz'), NO_LIMIT);
    expect(tar).toHaveLength(10_240);
    expect(tar.toString('latin1', 257, 262)).toBe('ustar');
  });

  it('refuses an output over the limit before decoding', () => {
    expect(() => decompressLzip(fixture('long.txt.lz'), LONG_TEXT.length - 1)).toThrow(DecompressionLimitError);
    expect(() => decompressLzip(fixture('two-members.txt.lz'), LONG_TEXT.length - 1)).toThrow(DecompressionLimitError);
    expect(decompressLzip(fixture('long.txt.lz'), LONG_TEXT.length)).toHaveLength(LONG_TEXT.length);
  });

  it('refuses damage anywhere in a member: the stream, the CRC-32, the sizes, the header and the version', () => {
    const intact = fixture('long.txt.lz');
    const mutate = (offset: number, value: number): Buffer => {
      const copy = Buffer.from(intact);
      copy[offset < 0 ? copy.length + offset : offset] = value;
      return copy;
    };
    expect(() => decompressLzip(mutate(100, intact[100] ^ 0x20), NO_LIMIT)).toThrow(CorruptStreamError);
    expectCorrupt(() => decompressLzip(mutate(-20, intact[intact.length - 20] ^ 1), NO_LIMIT), /CRC-32/);
    expectCorrupt(() => decompressLzip(mutate(-16, intact[intact.length - 16] ^ 1), NO_LIMIT), /different size than its trailer/);
    // 327 becomes 326: the member would start one byte late, where no header is.
    expectCorrupt(() => decompressLzip(mutate(-8, intact[intact.length - 8] ^ 1), NO_LIMIT), /a member header is missing/);
    expectCorrupt(() => decompressLzip(mutate(0, 0x4d), NO_LIMIT), /member header is missing/);
    expectCorrupt(() => decompressLzip(mutate(4, 0), NO_LIMIT), /version 0 is not supported/);
    expectCorrupt(() => decompressLzip(mutate(5, 0x00), NO_LIMIT), /invalid dictionary size/);
  });

  it('refuses a member size that cannot be a member of this file: smaller than a header and a trailer, or longer than the file', () => {
    const intact = fixture('long.txt.lz');
    const withMemberSize = (size: number): Buffer => {
      const copy = Buffer.from(intact);
      copy.writeBigUInt64LE(BigInt(size), copy.length - 8);
      return copy;
    };
    expectCorrupt(() => decompressLzip(withMemberSize(25), NO_LIMIT), /member size does not fit/);
    expectCorrupt(() => decompressLzip(withMemberSize(intact.length + 1), NO_LIMIT), /member size does not fit/);
    // The size the file really has is the one that is accepted.
    expect(decompressLzip(withMemberSize(intact.length), NO_LIMIT).equals(LONG_TEXT)).toBe(true);
  });

  it('refuses a truncated file, trailing data and a file that is not lzip', () => {
    const intact = fixture('long.txt.lz');
    expectCorrupt(() => decompressLzip(intact.subarray(0, intact.length - 1), NO_LIMIT), /member|header/);
    expectCorrupt(() => decompressLzip(Buffer.concat([intact, Buffer.from('trailing')]), NO_LIMIT), /member|header/);
    expectCorrupt(() => decompressLzip(Buffer.from('anything at all'), NO_LIMIT), /shorter than one member/);
    expectCorrupt(() => decompressLzip(Buffer.alloc(0), NO_LIMIT), /the file is empty/);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Against the tools themselves
// ---------------------------------------------------------------------------------------------------------------------

/** A deterministic generator (mulberry32) so a failing size reproduces. */
function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Data that uses every kind of match the compressors can write: random bytes (literal runs), runs of one byte, short
 * repeats of earlier text, and copies from 100, 3,000, 20,000 and 60,000 bytes back (the four distance classes).
 */
function generatedData(length: number, seed: number): Buffer {
  const random = prng(seed);
  const out = Buffer.alloc(length);
  let at = 0;
  const distances = [3, 100, 3_000, 20_000, 60_000];
  while (at < length) {
    const kind = Math.floor(random() * 4);
    const count = Math.min(length - at, 1 + Math.floor(random() * (kind === 0 ? 40 : 600)));
    if (kind === 0) {
      for (let i = 0; i < count; i++) out[at + i] = Math.floor(random() * 256);
    } else if (kind === 1) {
      out.fill(Math.floor(random() * 256), at, at + count);
    } else {
      const distance = Math.min(at, distances[Math.floor(random() * distances.length)]);
      for (let i = 0; i < count; i++) out[at + i] = distance > 0 ? out[at + i - distance] : Math.floor(random() * 256);
    }
    at += count;
  }
  return out;
}

const GENERATED_SIZES = [0, 1, 3, 4, 17, 18, 19, 255, 256, 1_000, 4_097, 65_000, 70_000, 300_000, 700_000];

function withTemporaryFile<T>(data: Buffer, run: (file: string) => T): T {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lz-oracle-'));
  try {
    const file = path.join(dir, 'data.bin');
    fs.writeFileSync(file, data);
    return run(file);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('lzop and lzip as the oracle', () => {
  oracleTest('every fixture decodes to the bytes lzop and lzip decode it to', ['lzop', 'lzip'], () => {
    for (const [file] of LZOP_TEXT_FIXTURES) {
      const viaTool = execFileSync(requireOracleTool('lzop'), ['-dc', path.join(FIXTURE_DIR, file)], { maxBuffer: 64 * MIB });
      expect(decompressLzop(fixture(file), NO_LIMIT).equals(viaTool), file).toBe(true);
    }
    for (const [file] of LZIP_TEXT_FIXTURES) {
      const viaTool = execFileSync(requireOracleTool('lzip'), ['-dc', path.join(FIXTURE_DIR, file)], { maxBuffer: 64 * MIB });
      expect(decompressLzip(fixture(file), NO_LIMIT).equals(viaTool), file).toBe(true);
    }
  });

  oracleTest('data compressed by lzop at the fast and the best level, with each checksum, comes back byte for byte', ['lzop'], () => {
    const lzop = requireOracleTool('lzop');
    for (const [index, size] of GENERATED_SIZES.entries()) {
      const data = generatedData(size, 1000 + index);
      for (const options of [['-1'], ['-9'], ['-3', '--crc32'], ['-1', '-F']]) {
        const packed = withTemporaryFile(data, (file) => execFileSync(lzop, [...options, '-c', file], { maxBuffer: 64 * MIB }));
        expect(decompressLzop(packed, NO_LIMIT).equals(data), `${size} bytes with lzop ${options.join(' ')}`).toBe(true);
      }
    }
  }, CONVERT_TIMEOUT_MS);

  oracleTest('data compressed by lzip at the fast and the best level, in one member or several, comes back byte for byte', ['lzip'], () => {
    const lzip = requireOracleTool('lzip');
    for (const [index, size] of GENERATED_SIZES.entries()) {
      const data = generatedData(size, 2000 + index);
      for (const options of [['-0'], ['-9'], ['-6', '-s', '4KiB']]) {
        const packed = withTemporaryFile(data, (file) => execFileSync(lzip, [...options, '-c', file], { maxBuffer: 64 * MIB }));
        expect(decompressLzip(packed, NO_LIMIT).equals(data), `${size} bytes with lzip ${options.join(' ')}`).toBe(true);
      }
    }
    const first = generatedData(50_000, 7);
    const second = generatedData(30_000, 8);
    const members = Buffer.concat(
      [first, second].map((data) => withTemporaryFile(data, (file) => execFileSync(lzip, ['-9', '-c', file], { maxBuffer: 64 * MIB })))
    );
    expect(decompressLzip(members, NO_LIMIT).equals(Buffer.concat([first, second]))).toBe(true);
  }, CONVERT_TIMEOUT_MS);
});

// ---------------------------------------------------------------------------------------------------------------------
// Conversion
// ---------------------------------------------------------------------------------------------------------------------

const TARGETS = ['zip', 'tar', 'tar.gz', 'tar.bz2', '7z'] as const;

describe('lz, lzo, tar.lzo and tzo sources convert to every archive target', () => {
  for (const [file, expected] of [...LZOP_TEXT_FIXTURES, ...LZIP_TEXT_FIXTURES]) {
    for (const target of TARGETS) {
      const format = file.endsWith('.lz') ? 'lz' : 'lzo';
      oracleTest(`${file} to ${target} holds the one file it compressed`, ['7z', 'tar'], async () => {
        const result = await convertFile(fixture(file), format, target, {}, file);
        const output = await readArchiveTree(result.buffer, target);
        expect(fileDigests(output.files)).toEqual(fileDigests(new Map([[file.replace(/\.lzo?$/, ''), expected]])));
      }, CONVERT_TIMEOUT_MS);
    }
  }

  for (const [file, format] of [
    ['tree.tar.lzo', 'tar.lzo'],
    ['tree.tar.lzo', 'tzo'],
    ['tree.tar.lz', 'lz'],
  ] as const) {
    for (const target of TARGETS) {
      oracleTest(`${file} read as .${format} to ${target} holds the files of the tar`, ['7z', 'tar'], async () => {
        const result = await convertFile(fixture(file), format, target, {}, file);
        const output = await readArchiveTree(result.buffer, target);
        expect(fileDigests(output.files)).toEqual(fileDigests(new Map(Object.entries(TREE_FILES))));
      }, CONVERT_TIMEOUT_MS);
    }
  }

  oracleTest('the output of a tarball equals what lzop and lzip with tar unpack it to', ['7z', 'tar', 'lzop', 'lzip'], async () => {
    for (const [file, tool, format] of [
      ['tree.tar.lzo', 'lzop', 'tar.lzo'],
      ['tree.tar.lz', 'lzip', 'lz'],
    ] as const) {
      const unpacked = unpackWith((outDir) => {
        const tar = execFileSync(requireOracleTool(tool), ['-dc', path.join(FIXTURE_DIR, file)], { maxBuffer: 16 * MIB });
        execFileSync(requireOracleTool('tar'), ['-xf', '-', '-C', outDir], { input: tar });
      });
      const result = await convertFile(fixture(file), format, 'tar.gz', {}, file);
      const output = await readArchiveTree(result.buffer, 'tar.gz');
      expect(fileDigests(output.files), file).toEqual(fileDigests(unpacked.files));
    }
  }, CONVERT_TIMEOUT_MS);

  it.each(['lz', 'lzo', 'tar.lzo', 'tzo'])('.%s that is not a valid file is refused with a typed corrupt-stream error', async (format) => {
    const failure = await convertFile(Buffer.from('anything at all, long enough to look at'), format, 'zip', {}, `sample.${format}`).catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(CorruptStreamError);
    expect((failure as Error).message).toMatch(/Corrupt lz(ip|op) data/);
  });

  oracleTest('a bomb of zeros is cut off at the ratio cap with the typed archive-bomb error', ['lzop', 'lzip'], async () => {
    // Past the 32 MiB output below which the ratio is not judged.
    const zeros = Buffer.alloc(40 * MIB);
    for (const [tool, format] of [
      ['lzop', 'lzo'],
      ['lzip', 'lz'],
    ] as const) {
      const packed = withTemporaryFile(zeros, (file) => execFileSync(requireOracleTool(tool), ['-9', '-c', file], { maxBuffer: 16 * MIB }));
      expect(packed.length * 100, tool).toBeLessThan(40 * MIB);
      const failure = await convertFile(packed, format, 'zip', {}, `bomb.${format}`).catch((err: unknown) => err);
      expect(failure, tool).toMatchObject({ name: 'UnsafeArchiveError', reason: 'compression-ratio' });
    }
  }, CONVERT_TIMEOUT_MS);
});
