import { describe, it, expect, vi } from 'vitest';
import * as cp from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { compressBzip2, decompressBzip2 } from '../src/lib/conversions/bzip2';
import { convertFile } from '../src/lib/conversions';
import { ConversionFailedError } from '../src/lib/types';
import { SCALING_TEST_TIMEOUT_MS, expectNoHangOnInput } from './helpers/timing';
import { skipUnless } from './helpers/strict-skip';

/** Real engine, CLI or large-input work: the 5 s default fails on a loaded CI shard without any regression; 60 s only stops a hang. */
const ENGINE_TEST_TIMEOUT_MS = 60_000;
vi.setConfig({ testTimeout: ENGINE_TEST_TIMEOUT_MS });

/**
 * Interop suite for the pure-TypeScript bzip2 codec. The independent oracle is the system `bzip2`
 * binary: it decodes everything the encoder emits and produces every stream the decoder consumes.
 */

const MAX_BUFFER_BYTES = 256 * 1024 * 1024;
const MULTI_BLOCK_INPUT_BYTES = 2_500_000;
const BZIP2_MAX_BLOCK_BYTES = 900_000;
/** Hang guard only: these hand-assembled hostile streams are refused in about a millisecond. */
const HOSTILE_HANG_GUARD_MS = 10_000;
const BZIP2_FIXTURE_TAR = path.resolve(__dirname, 'fixtures', 'sample.tar');

const SKIP_WITHOUT_BZIP2 = skipUnless('bzip2', cp.spawnSync('bzip2', ['--help'], { stdio: 'ignore' }).error === undefined);
const SKIP_WITHOUT_TAR = skipUnless('tar', cp.spawnSync('tar', ['--version'], { stdio: 'ignore' }).error === undefined);

function sha256(buf: Uint8Array): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function expectSameBytes(actual: Buffer, expected: Buffer): void {
  expect(actual.length).toBe(expected.length);
  expect(sha256(actual)).toBe(sha256(expected));
}

function systemBzip2(args: string[], input: Buffer): Buffer {
  const res = cp.spawnSync('bzip2', args, { input, maxBuffer: MAX_BUFFER_BYTES });
  if (res.error) throw res.error;
  if (res.status !== 0) {
    throw new Error(`bzip2 ${args.join(' ')} exited ${res.status}: ${res.stderr.toString('utf-8')}`);
  }
  return res.stdout;
}

function lcgBytes(length: number, seed: number, mask = 0xff): Buffer {
  const out = Buffer.alloc(length);
  let x = seed >>> 0;
  for (let i = 0; i < length; i++) {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    out[i] = (x >>> 24) & mask;
  }
  return out;
}

function mixedInput(): Buffer {
  const text = Buffer.from(
    Array.from({ length: 8000 }, (_, i) => `line ${i}: the quick brown fox jumps over the lazy dog\n`).join(''),
    'utf-8'
  );
  const period7 = Buffer.alloc(500_000);
  for (let i = 0; i < period7.length; i++) period7[i] = (i % 7) * 31;
  const parts = [
    lcgBytes(600_000, 1),
    text.subarray(0, 400_000),
    Buffer.alloc(300_000),
    period7,
    lcgBytes(700_000, 2, 0x0f),
  ];
  return Buffer.concat(parts).subarray(0, MULTI_BLOCK_INPUT_BYTES);
}

const allByteValues = Buffer.from(Array.from({ length: 256 }, (_, i) => i));

const SMALL_LENGTHS = [2, 3, 5, 6, 7, 8, 9, 10];
const BLOCK_BOUNDARY_LENGTHS = [899_981, 899_982, 900_000, 900_001];

const CASES: Array<[string, () => Buffer]> = [
  ['empty input', () => Buffer.alloc(0)],
  ['single byte', () => Buffer.from('a')],
  ['run of exactly four', () => Buffer.from('aaaa')],
  ['run of four then a literal', () => Buffer.from('aaaaab')],
  ['300 identical bytes', () => Buffer.alloc(300, 0x61)],
  ['1000 zero bytes', () => Buffer.alloc(1000)],
  ['all 256 byte values', () => allByteValues],
  ['sample.tar fixture', () => fs.readFileSync(BZIP2_FIXTURE_TAR)],
  ['pseudo-random LCG data', () => lcgBytes(200_000, 42)],
  ['2.5 MB mixed multi-block input', mixedInput],
  ...SMALL_LENGTHS.map((length): [string, () => Buffer] => [`${length} identical bytes`, () => Buffer.alloc(length, 7)]),
  ...SMALL_LENGTHS.map((length): [string, () => Buffer] => [
    `${length} distinct bytes`,
    () => Buffer.from(Array.from({ length }, (_, i) => i)),
  ]),
  // Level 9 blocks hold 900000 - 19 bytes after the first run-length stage; random data barely changes size.
  ...BLOCK_BOUNDARY_LENGTHS.map((length): [string, () => Buffer] => [`${length} random bytes at the block boundary`, () => lcgBytes(length, length)]),
  ['a run straddling the first block boundary', () => Buffer.concat([lcgBytes(BLOCK_BOUNDARY_LENGTHS[0] - 3, 11), Buffer.alloc(300, 9)])],
];

describe('bzip2 encoder output is accepted by the reference decoder', () => {
  for (const [name, make] of CASES) {
    it.skipIf(SKIP_WITHOUT_BZIP2)(`round-trips ${name} through system bzip2 -dc`, () => {
      const input = make();
      const compressed = compressBzip2(input);
      expect(compressed.subarray(0, 3).toString('latin1')).toBe('BZh');
      expectSameBytes(systemBzip2(['-dc'], compressed), input);
    });
  }

  it.skipIf(SKIP_WITHOUT_BZIP2)('emits a stream that passes bzip2 -t with level-9 block size and valid trailer', () => {
    const input = Buffer.alloc(100);
    const compressed = compressBzip2(input);
    expect(compressed[3]).toBe('9'.charCodeAt(0));
    expect(systemBzip2(['-t'], compressed).length).toBe(0);
    expectSameBytes(systemBzip2(['-dc'], compressed), input);
  });

  it.skipIf(SKIP_WITHOUT_BZIP2)('splits multi-block input without crossing the 900k block limit', () => {
    const input = mixedInput();
    const compressed = compressBzip2(input);
    // Each block starts with the 48-bit block magic; count occurrences on the byte-unaligned bit stream.
    const bits = Array.from(compressed, (b) => b.toString(2).padStart(8, '0')).join('');
    const blockMagic = '001100010100000101011001001001100101001101011001';
    let count = 0;
    for (let at = bits.indexOf(blockMagic); at !== -1; at = bits.indexOf(blockMagic, at + 1)) count++;
    expect(count).toBeGreaterThanOrEqual(Math.ceil(input.length / BZIP2_MAX_BLOCK_BYTES));
    expectSameBytes(systemBzip2(['-dc'], compressed), input);
  });

  // The block sorter must stay linear-time on the inputs that make a naive suffix sort quadratic. Growth is
  // compared on a quarter-size input and the full 900 kB block (tests/helpers/timing.ts), not against a budget.
  const timingCases: Array<[string, (bytes: number) => Buffer]> = [
    ['zeros', (bytes) => Buffer.alloc(bytes)],
    [
      'a 2-byte period',
      (bytes) => {
        // An odd length keeps the block from being an exact repetition of "ab", which the sorter shortcuts: both sizes
        // then take the same general path (tests/bzip2-bwt.perf.test.ts times the exact repetition).
        const buf = Buffer.alloc(bytes % 2 === 0 ? bytes - 1 : bytes);
        for (let i = 0; i < buf.length; i++) buf[i] = i % 2 === 0 ? 0x61 : 0x62;
        return buf;
      },
    ],
  ];
  for (const [name, make] of timingCases) {
    it.skipIf(SKIP_WITHOUT_BZIP2)(`compresses a 900 kB block of ${name} in linear time (hang guard; growth ratio in the perf suite)`, async () => {
      const input = make(BZIP2_MAX_BLOCK_BYTES);
      const { largeResult: compressed } = await expectNoHangOnInput(
        'compressBzip2',
        (data: Buffer) => compressBzip2(data),
        input
      );
      expectSameBytes(systemBzip2(['-dc'], compressed), input);
    }, SCALING_TEST_TIMEOUT_MS);
  }
});

describe('bzip2 decoder consumes reference encoder output', () => {
  for (const level of ['-1', '-9']) {
    for (const [name, make] of CASES) {
      it.skipIf(SKIP_WITHOUT_BZIP2)(`decodes system bzip2 ${level} output for ${name}`, () => {
        const input = make();
        const reference = systemBzip2(['-c', level], input);
        expectSameBytes(decompressBzip2(reference), input);
      });
    }
  }

  it.skipIf(SKIP_WITHOUT_BZIP2)('decodes a 1000-byte run compressed by system bzip2 (inverse RLE1)', () => {
    const input = Buffer.alloc(1000);
    const decoded = decompressBzip2(systemBzip2(['-c'], input));
    expect(decoded.length).toBe(1000);
    expectSameBytes(decoded, input);
  });

  it.skipIf(SKIP_WITHOUT_BZIP2)('decodes concatenated streams like bzip2 -dc', () => {
    const first = Buffer.from('first stream payload ');
    const second = Buffer.from('second stream payload aaaaaaaaaa');
    const joined = Buffer.concat([systemBzip2(['-c'], first), systemBzip2(['-c', '-1'], second)]);
    expect(systemBzip2(['-dc'], joined).toString('utf-8')).toBe(Buffer.concat([first, second]).toString('utf-8'));
    expect(decompressBzip2(joined).toString('utf-8')).toBe(Buffer.concat([first, second]).toString('utf-8'));
  });
});

// ---------------------------------------------------------------------------------------------
// Hostile input
// ---------------------------------------------------------------------------------------------

/** MSB-first bit assembler used to hand-build bzip2 streams independently of the production code. */
class TestBitStream {
  private readonly bits: number[] = [];

  push(value: number, width: number): this {
    for (let i = width - 1; i >= 0; i--) {
      this.bits.push(Math.floor(value / 2 ** i) % 2);
    }
    return this;
  }

  toBuffer(): Buffer {
    const out = Buffer.alloc(Math.ceil(this.bits.length / 8));
    this.bits.forEach((bit, idx) => {
      out[idx >> 3] |= bit << (7 - (idx & 7));
    });
    return out;
  }
}

const BLOCK_MAGIC = [0x31, 0x41, 0x59, 0x26, 0x53, 0x59];
const END_MAGIC = [0x17, 0x72, 0x45, 0x38, 0x50, 0x90];
// One in-use byte (0x41) gives alphabet {RUNA, RUNB, EOB} with canonical codes 0, 10, 11.
const SYMBOL_CODES: Record<string, [number, number]> = { A: [0b0, 1], B: [0b10, 2], E: [0b11, 2] };
const SINGLE_SYMBOL_LENGTHS = [1, 2, 2];

interface HandBlock {
  digit?: number;
  blockCrc: number;
  origPtr?: number;
  numTrees?: number;
  selectors?: number[];
  symbols: string;
}

function handAssemble(spec: HandBlock): Buffer {
  const bs = new TestBitStream();
  for (const ch of `BZh${spec.digit ?? 9}`) bs.push(ch.charCodeAt(0), 8);
  BLOCK_MAGIC.forEach((b) => bs.push(b, 8));
  bs.push(spec.blockCrc, 32).push(0, 1).push(spec.origPtr ?? 0, 24);
  // In-use map: group 4 (0x40..0x4f) present, only 0x41 set.
  for (let g = 0; g < 16; g++) bs.push(g === 4 ? 1 : 0, 1);
  for (let j = 0; j < 16; j++) bs.push(j === 1 ? 1 : 0, 1);
  const numTrees = spec.numTrees ?? 2;
  const selectors = spec.selectors ?? [0];
  bs.push(numTrees, 3).push(selectors.length, 15);
  for (const sel of selectors) {
    for (let i = 0; i < sel; i++) bs.push(1, 1);
    bs.push(0, 1);
  }
  for (let t = 0; t < numTrees; t++) {
    let cur = SINGLE_SYMBOL_LENGTHS[0];
    bs.push(cur, 5);
    for (const target of SINGLE_SYMBOL_LENGTHS) {
      while (cur < target) {
        bs.push(0b10, 2);
        cur++;
      }
      bs.push(0, 1);
    }
  }
  for (const sym of spec.symbols) {
    const [code, width] = SYMBOL_CODES[sym];
    bs.push(code, width);
  }
  END_MAGIC.forEach((b) => bs.push(b, 8));
  bs.push(spec.blockCrc, 32);
  return bs.toBuffer();
}

function expectFastTypedFailure(input: Buffer, message: RegExp): void {
  const started = performance.now();
  let caught: unknown;
  try {
    decompressBzip2(input);
  } catch (err) {
    caught = err;
  }
  const elapsed = performance.now() - started;
  expect(caught).toBeInstanceOf(ConversionFailedError);
  expect((caught as Error).message).toMatch(message);
  expect(elapsed).toBeLessThan(HOSTILE_HANG_GUARD_MS);
}

describe('bzip2 decoder rejects hostile input with a typed error', () => {
  const payload = Buffer.from('hostile input corpus: the quick brown fox jumps over the lazy dog');
  const BLOCK_CRC_OFFSET = 10;

  it.skipIf(SKIP_WITHOUT_BZIP2)('accepts the hand-assembled single-byte control stream', () => {
    const referenceA = systemBzip2(['-c'], Buffer.from('A'));
    const crc = referenceA.readUInt32BE(BLOCK_CRC_OFFSET);
    const control = handAssemble({ blockCrc: crc, symbols: 'AE' });
    expect(systemBzip2(['-dc'], control).toString('latin1')).toBe('A');
    expect(decompressBzip2(control).toString('latin1')).toBe('A');
  });

  it.skipIf(SKIP_WITHOUT_BZIP2)('rejects a truncated stream', () => {
    const reference = systemBzip2(['-c'], payload);
    expectFastTypedFailure(reference.subarray(0, reference.length - 10), /truncat|end of|EOF/i);
  });

  it.skipIf(SKIP_WITHOUT_BZIP2)('rejects a flipped block CRC byte', () => {
    const reference = Buffer.from(systemBzip2(['-c'], payload));
    reference[BLOCK_CRC_OFFSET] ^= 0xff;
    expectFastTypedFailure(reference, /CRC/i);
  });

  it.skipIf(SKIP_WITHOUT_BZIP2)('rejects a flipped combined stream CRC byte', () => {
    const reference = Buffer.from(systemBzip2(['-c'], payload));
    reference[reference.length - 1] ^= 0xff;
    expectFastTypedFailure(reference, /CRC/i);
  });

  it.skipIf(SKIP_WITHOUT_BZIP2)('rejects trailing garbage after the end-of-stream marker', () => {
    const reference = systemBzip2(['-c'], payload);
    expectFastTypedFailure(Buffer.concat([reference, Buffer.from('garbage')]), /trailing/i);
  });

  it.skipIf(SKIP_WITHOUT_BZIP2)('accepts zero padding after the last stream', () => {
    const reference = systemBzip2(['-c'], payload);
    const padded = Buffer.concat([reference, Buffer.alloc(512)]);
    expectSameBytes(decompressBzip2(padded), payload);
  });

  it.skipIf(SKIP_WITHOUT_BZIP2)('rejects a block-size digit outside 1..9', () => {
    for (const digit of ['0', 'A', '/']) {
      const reference = Buffer.from(systemBzip2(['-c'], payload));
      reference[3] = digit.charCodeAt(0);
      expectFastTypedFailure(reference, /block size/i);
    }
  });

  it.skipIf(SKIP_WITHOUT_BZIP2)('rejects numTrees outside 2..6', () => {
    const crc = systemBzip2(['-c'], Buffer.from('A')).readUInt32BE(BLOCK_CRC_OFFSET);
    expectFastTypedFailure(handAssemble({ blockCrc: crc, numTrees: 7, symbols: 'AE' }), /tree/i);
    expectFastTypedFailure(handAssemble({ blockCrc: crc, numTrees: 1, symbols: 'AE' }), /tree/i);
  });

  it.skipIf(SKIP_WITHOUT_BZIP2)('rejects zero selectors and selector indices beyond numTrees', () => {
    const crc = systemBzip2(['-c'], Buffer.from('A')).readUInt32BE(BLOCK_CRC_OFFSET);
    expectFastTypedFailure(handAssemble({ blockCrc: crc, selectors: [], symbols: 'AE' }), /selector/i);
    expectFastTypedFailure(handAssemble({ blockCrc: crc, selectors: [2], symbols: 'AE' }), /selector/i);
  });

  it.skipIf(SKIP_WITHOUT_BZIP2)('rejects a zero run longer than the declared block size', () => {
    const crc = systemBzip2(['-c'], Buffer.from('A')).readUInt32BE(BLOCK_CRC_OFFSET);
    // Twenty RUNB symbols encode a run of 2 * (2^20 - 1) bytes, far above the 100 kB block of level 1.
    const hostile = handAssemble({ digit: 1, blockCrc: crc, symbols: `${'B'.repeat(20)}E` });
    expectFastTypedFailure(hostile, /block size|exceeds/i);
  });

  it.skipIf(SKIP_WITHOUT_BZIP2)('rejects an unbounded RUNB run without allocating or looping', () => {
    const crc = systemBzip2(['-c'], Buffer.from('A')).readUInt32BE(BLOCK_CRC_OFFSET);
    const hostile = handAssemble({ digit: 9, blockCrc: crc, symbols: `${'B'.repeat(40)}E` });
    expectFastTypedFailure(hostile, /block size|exceeds/i);
  });

  it.skipIf(SKIP_WITHOUT_BZIP2)('rejects an origPtr beyond the decoded block length', () => {
    const crc = systemBzip2(['-c'], Buffer.from('A')).readUInt32BE(BLOCK_CRC_OFFSET);
    expectFastTypedFailure(handAssemble({ blockCrc: crc, origPtr: 1, symbols: 'AE' }), /origPtr|pointer/i);
    expectFastTypedFailure(handAssemble({ blockCrc: crc, origPtr: 0xffffff, symbols: 'AE' }), /origPtr|pointer/i);
  });

  it.skipIf(SKIP_WITHOUT_BZIP2)('rejects an empty block (no symbols before end-of-block)', () => {
    const crc = systemBzip2(['-c'], Buffer.from('A')).readUInt32BE(BLOCK_CRC_OFFSET);
    expectFastTypedFailure(handAssemble({ blockCrc: crc, symbols: 'E' }), /origPtr|pointer|empty/i);
  });

  it('rejects an input with a bad signature and a too-short input', () => {
    expectFastTypedFailure(Buffer.from('not a bzip2 stream at all'), /signature|bzip2/i);
    expectFastTypedFailure(Buffer.from('BZh9'), /short|truncat|EOF|end of/i);
  });

  it.skipIf(SKIP_WITHOUT_BZIP2)('fails closed when the output would exceed maxOutputBytes', () => {
    const bomb = systemBzip2(['-c'], Buffer.alloc(2_000_000));
    const started = performance.now();
    let caught: unknown;
    try {
      decompressBzip2(bomb, 10_000);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ConversionFailedError);
    expect((caught as Error).message).toMatch(/exceeds|limit/i);
    expect(performance.now() - started).toBeLessThan(HOSTILE_HANG_GUARD_MS);
    // The same stream decodes when the limit allows it.
    expect(decompressBzip2(bomb, 2_000_000).length).toBe(2_000_000);
  });
});

describe('archive-level bzip2 output', () => {
  it.skipIf(SKIP_WITHOUT_BZIP2 || SKIP_WITHOUT_TAR)('convertFile(sample.tar -> tar.bz2) passes bzip2 -t and lists the same entries', async () => {
    const tarBytes = fs.readFileSync(BZIP2_FIXTURE_TAR);
    const result = await convertFile(tarBytes, 'tar', 'tar.bz2', {}, 'sample.tar');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bzip2-archive-'));
    try {
      const bz2Path = path.join(dir, 'out.tar.bz2');
      fs.writeFileSync(bz2Path, result.buffer);
      const test = cp.spawnSync('bzip2', ['-t', bz2Path]);
      expect(test.status).toBe(0);
      expect(test.stderr.toString('utf-8')).toBe('');

      const listed = cp.spawnSync('tar', ['-tjf', bz2Path]).stdout.toString('utf-8').trim().split('\n').sort();
      const expected = cp.spawnSync('tar', ['-tf', BZIP2_FIXTURE_TAR]).stdout.toString('utf-8').trim().split('\n').sort();
      expect(expected.length).toBeGreaterThan(0);
      expect(listed).toEqual(expected);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
