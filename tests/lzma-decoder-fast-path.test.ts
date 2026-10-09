import { describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { decodeLzma } from '../src/lib/conversions/lzma-decoder';
import { LzmaRangeEncoder } from '../src/lib/conversions/lzma-encoder';
import { unpackXz } from '../src/lib/conversions/archive';
import * as model from '../src/lib/conversions/lzma-model';
import { CorruptStreamError } from '../src/lib/types';
import { SeededRandom } from './helpers/archive-corpus';
import { getOracleToolPath } from './helpers/differential-oracle';
import { oracleTest } from './helpers/oracle-test';

/**
 * The decoder keeps its range coder registers as int32 and builds distances as int32 bit patterns, copies long
 * matches as blocks and short ones byte by byte, and the .xz reader checks CRC-64 eight bytes at a time. The streams
 * here are written by the reference `xz` (or assembled bit by bit from the LZMA specification and then also judged by
 * `xz`), so the expected bytes and the verdicts on bad streams come from outside this code.
 */

const MAX_OUTPUT = 64 * 1024 * 1024;
const LZMA_PROPERTIES_BYTE = 0x5d;
const LZMA_ALONE_HEADER_BYTES = 13;
const DICTIONARY_BYTES = 4096;
const UNKNOWN_SIZE_BYTES = 8;
const XZ_STREAM_HEADER_BYTES = 12;
const XZ_BLOCK_HEADER_UNIT = 4;
const LZMA2_UNCOMPRESSED_CHUNK_HEADER_BYTES = 3;
const MAX_TAIL_CHECK_LENGTH = 70;
/** Match lengths around the point where the decoder switches from a byte loop to a block copy, and distances around 1 and 16. */
const COPY_LENGTHS = [2, 3, 8, 14, 15, 16, 17, 18, 31, 64, 273];
const COPY_DISTANCES = [1, 2, 7, 15, 16, 17, 100, 4095, 4096, 4097];

function xz(args: string[], input: Uint8Array): Buffer {
  return execFileSync(getOracleToolPath('xz')!, args, { input, maxBuffer: 1 << 28 });
}

describe('CRC-64 of the .xz reader', () => {
  oracleTest('accepts the check xz writes for every length across the 8-byte steps and the tail', ['xz'], () => {
    const random = new SeededRandom(71);
    for (let length = 0; length <= MAX_TAIL_CHECK_LENGTH; length++) {
      const data = random.bytes(length);
      const stream = xz(['-6', '--check=crc64', '-c'], data);
      expect(unpackXz(stream).equals(data), `length ${length}`).toBe(true);
    }
  });

  oracleTest('rejects a changed first or last payload byte at every length across the 8-byte steps and the tail', ['xz'], () => {
    const random = new SeededRandom(72);
    for (let length = 1; length <= MAX_TAIL_CHECK_LENGTH; length++) {
      const stream = xz(['-6', '--check=crc64', '-c'], random.bytes(length));
      // A short random input is stored as an uncompressed LZMA2 chunk, so its bytes follow the chunk header as they are.
      const blockHeaderBytes = (stream[XZ_STREAM_HEADER_BYTES] + 1) * XZ_BLOCK_HEADER_UNIT;
      const payload = XZ_STREAM_HEADER_BYTES + blockHeaderBytes + LZMA2_UNCOMPRESSED_CHUNK_HEADER_BYTES;
      for (const offset of [payload, payload + length - 1]) {
        const damaged = Buffer.from(stream);
        damaged[offset] ^= 0x80;
        expect(() => unpackXz(damaged), `length ${length}, byte ${offset - payload}`).toThrow(/payload CRC64 mismatch/);
      }
    }
  });
});

describe('match copies of every length and distance', () => {
  oracleTest('decodes xz streams whose matches cover each length and distance around the copy thresholds', ['xz'], () => {
    const random = new SeededRandom(73);
    const parts: Buffer[] = [random.bytes(9000)];
    let total = parts[0].length;
    for (const distance of COPY_DISTANCES) {
      for (const length of COPY_LENGTHS) {
        // The next piece repeats `length` bytes found `distance` bytes back (overlapping itself when distance < length),
        // then a few fresh bytes so the following repeat is a new match.
        const history = Buffer.concat(parts);
        const start = history.length - distance;
        const piece = Buffer.alloc(length);
        for (let i = 0; i < length; i++) piece[i] = i < distance ? history[start + i] : piece[i - distance];
        parts.push(piece, random.bytes(3));
        total += length + 3;
      }
    }
    const data = Buffer.concat(parts);
    expect(data.length).toBe(total);
    for (const preset of ['-0', '-6', '-9e']) {
      expect(unpackXz(xz([preset, '-c'], data)).equals(data), preset).toBe(true);
    }
  });

  oracleTest('decodes matches at the edge of a 4 KiB dictionary', ['xz'], () => {
    const random = new SeededRandom(74);
    const block = random.bytes(600);
    const pieces: Buffer[] = [];
    for (const gap of [DICTIONARY_BYTES - 700, DICTIONARY_BYTES - 600, DICTIONARY_BYTES - 599, DICTIONARY_BYTES + 100]) {
      pieces.push(block, random.bytes(gap));
    }
    pieces.push(block);
    const data = Buffer.concat(pieces);
    const stream = xz(['--lzma2=dict=4KiB,preset=6', '-c'], data);
    expect(unpackXz(stream).equals(data)).toBe(true);
  });

  oracleTest('decodes highly repetitive and incompressible input of one, two and a few bytes', ['xz'], () => {
    for (const data of [Buffer.from([0]), Buffer.from([1, 2]), Buffer.alloc(3, 0xff), Buffer.alloc(1 << 20, 0x41), new SeededRandom(75).bytes(200_000)]) {
      expect(unpackXz(xz(['-6', '-c'], data)).equals(data), `${data.length} bytes`).toBe(true);
    }
  });
});

/** An LZMA stream written step by step from the specification: a literal, then one match with a chosen length and distance. */
function literalThenMatch(literal: number, length: number, distance: number): Buffer {
  const probs = new Uint16Array(model.probabilityCount(3, 0)).fill(model.PROB_INIT);
  const rc = new LzmaRangeEncoder();
  // Literal at position 0 (state 0, no previous byte).
  rc.encodeBit(probs, model.IS_MATCH, 0);
  rc.encodeBitTree(probs, model.LITERAL, 8, literal);
  // Match at position 1 (state 0 after a literal, position state 1).
  const posState = 1;
  rc.encodeBit(probs, model.IS_MATCH + posState, 1);
  rc.encodeBit(probs, model.IS_REP, 0);
  const lenSymbol = length - model.MATCH_LEN_MIN;
  rc.encodeBit(probs, model.LEN_CODER + model.LEN_CHOICE, 0);
  rc.encodeBitTree(probs, model.LEN_CODER + model.LEN_LOW + (posState << 3), 3, lenSymbol);
  const lenState = Math.min(lenSymbol, model.LEN_TO_POS_STATES - 1);
  const top = 31 - Math.clz32(distance);
  const slot = 2 * top + ((distance >>> (top - 1)) & 1);
  rc.encodeBitTree(probs, model.POS_SLOT + (lenState << model.POS_SLOT_BITS), model.POS_SLOT_BITS, slot);
  const footerBits = (slot >>> 1) - 1;
  const base = ((2 | (slot & 1)) << footerBits) >>> 0;
  const reduced = (distance - base) >>> 0;
  rc.encodeDirectBits(reduced >>> model.ALIGN_BITS, footerBits - model.ALIGN_BITS);
  rc.encodeReverseBitTree(probs, model.ALIGN, model.ALIGN_BITS, reduced & ((1 << model.ALIGN_BITS) - 1));
  return rc.flush();
}

function lzmaAloneHeader(): Buffer {
  const header = Buffer.alloc(LZMA_ALONE_HEADER_BYTES);
  header[0] = LZMA_PROPERTIES_BYTE;
  header.writeUInt32LE(DICTIONARY_BYTES, 1);
  header.fill(0xff, LZMA_ALONE_HEADER_BYTES - UNKNOWN_SIZE_BYTES);
  return header;
}

const END_MARKER_DISTANCE = 0xffffffff;
/** Distances no dictionary reaches: the sign bit set, and the largest values below the end marker. */
const UNREACHABLE_DISTANCES = [0x80000000, 0x90000001, 0xc0000000, 0xfffffffe];

describe('distances that fill all 32 bits', () => {
  const props = Buffer.from([LZMA_PROPERTIES_BYTE, 0, 0x10, 0, 0]);

  it('stops at the end marker and reports a stream that ends before the stated size', () => {
    const payload = literalThenMatch(0x61, 2, END_MARKER_DISTANCE);
    expect(Buffer.from(decodeLzma(payload, props, 1, MAX_OUTPUT))).toEqual(Buffer.from('a'));
    expect(() => decodeLzma(payload, props, 2, MAX_OUTPUT)).toThrow(CorruptStreamError);
    expect(() => decodeLzma(payload, props, 2, MAX_OUTPUT)).toThrow(/ends after 1 of 2 bytes/);
  });

  oracleTest('the reference decoder reads the same end marker stream as one byte', ['xz'], () => {
    const stream = Buffer.concat([lzmaAloneHeader(), literalThenMatch(0x61, 2, END_MARKER_DISTANCE)]);
    expect(xz(['--format=lzma', '-dc'], stream)).toEqual(Buffer.from('a'));
  });

  it('refuses a distance that no dictionary reaches with a typed error', () => {
    for (const distance of UNREACHABLE_DISTANCES) {
      const payload = literalThenMatch(0x61, 2, distance);
      expect(() => decodeLzma(payload, props, 3, MAX_OUTPUT), `distance ${distance.toString(16)}`).toThrow(CorruptStreamError);
      expect(() => decodeLzma(payload, props, 3, MAX_OUTPUT), `distance ${distance.toString(16)}`).toThrow(/reaches before the start of the dictionary/);
    }
  });

  oracleTest('the reference decoder refuses the same streams', ['xz'], () => {
    for (const distance of UNREACHABLE_DISTANCES) {
      const stream = Buffer.concat([lzmaAloneHeader(), literalThenMatch(0x61, 2, distance)]);
      const run = spawnSync(getOracleToolPath('xz')!, ['--format=lzma', '-dc'], { input: stream });
      expect(run.status, `distance ${distance.toString(16)}`).toBe(1);
      expect(run.stderr.toString(), `distance ${distance.toString(16)}`).toMatch(/Compressed data is corrupt/);
      expect(run.stdout.toString('latin1'), `distance ${distance.toString(16)}`).toBe('a');
    }
  });
});
