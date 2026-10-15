import { describe, it, expect, vi } from 'vitest';
import { decodeTrueLayers, type X3fImageSection } from '../src/lib/conversions/raw-x3f';
import { RawDecodeError } from '../src/lib/types';

/** Real engine, CLI or large-input work: the 5 s default fails on a loaded CI shard without any regression; 60 s only stops a hang. */
const ENGINE_TEST_TIMEOUT_MS = 60_000;
vi.setConfig({ testTimeout: ENGINE_TEST_TIMEOUT_MS });

/**
 * Hostile and edge-case 8-bit Huffman tables in the TRUE-coded sensor section (DP1/DP2, Merrill).
 *
 * Oracle: the section is written here by a separate encoder that follows the layout documented for the
 * format (seeds, (length, left-aligned code) pairs ended by length 0, plane sizes, 16-byte aligned planes;
 * a sample is its predictor plus a difference coded as a bit count n and n bits), and the expected samples
 * are the planes the encoder was given.
 */

const IMAGE_HEADER_BYTES = 28;
const IMAGE_TYPE_RAW = 3;
const IMAGE_FORMAT_TRUE = 0x1e;
const PLANES = 3;
const PLANE_ALIGNMENT = 16;
const CODE_BITS = 8;
const MAX_TABLE_PAIRS = 256;
const MAX_EXTRA_BITS = 16;
const WIDTH = 6;
const HEIGHT = 4;
/** A hostile table must be refused immediately: the whole decode of this tiny image takes milliseconds. */
/** Hang guard only: a hostile table is refused in milliseconds. */
const HOSTILE_HANG_GUARD_MS = 10_000;

interface Pair {
  length: number;
  code: number;
}

/** Appends bits most significant first. */
class BitWriter {
  private readonly bytes: number[] = [];
  private pending = 0;
  private pendingBits = 0;

  write(value: number, count: number): void {
    for (let bit = count - 1; bit >= 0; bit -= 1) {
      this.pending = (this.pending << 1) | ((value >>> bit) & 1);
      this.pendingBits += 1;
      if (this.pendingBits === CODE_BITS) {
        this.bytes.push(this.pending);
        this.pending = 0;
        this.pendingBits = 0;
      }
    }
  }

  finish(): Buffer {
    if (this.pendingBits > 0) this.write(0, CODE_BITS - this.pendingBits);
    return Buffer.from(this.bytes);
  }
}

/** Table where leaf n (n extra bits) has a single 5-bit-or-shorter code: "0" for leaf 0, "1" + 4 bits for leaves 1..16. */
const COMPACT_TABLE: Pair[] = Array.from({ length: MAX_EXTRA_BITS + 1 }, (_, leaf) =>
  leaf === 0 ? { length: 1, code: 0x00 } : { length: 5, code: (0x10 | (leaf - 1)) << 3 }
);

/** Full table: every one of the 256 eight-bit patterns is the code of the leaf with that number. */
const FLAT_TABLE: Pair[] = Array.from({ length: MAX_TABLE_PAIRS }, (_, leaf) => ({ length: CODE_BITS, code: leaf }));

function bitLength(value: number): number {
  return value === 0 ? 0 : Math.floor(Math.log2(value)) + 1;
}

/** Encodes one plane with the documented 2x2 predictor and returns its bytes. */
function encodePlane(plane: number[], seed: number, table: Pair[]): Buffer {
  const writer = new BitWriter();
  const rowStart = [seed, seed, seed, seed];
  const running = [0, 0];
  for (let row = 0; row < HEIGHT; row += 1) {
    for (let column = 0; column < WIDTH; column += 1) {
      const parity = column & 1;
      const startIndex = (row & 1) * 2 + parity;
      const value = plane[row * WIDTH + column];
      const previous = column < 2 ? rowStart[startIndex] : running[parity];
      const difference = value - previous;
      const bits = bitLength(Math.abs(difference));
      const entry = table[bits];
      writer.write(entry.code >> (CODE_BITS - entry.length), entry.length);
      if (bits > 0) writer.write(difference > 0 ? difference : difference + (1 << bits) - 1, bits);
      running[parity] = value;
      if (column < 2) rowStart[startIndex] = value;
    }
  }
  return writer.finish();
}

function align(buffer: Buffer): Buffer {
  const padded = Buffer.alloc(Math.ceil(buffer.length / PLANE_ALIGNMENT) * PLANE_ALIGNMENT);
  buffer.copy(padded);
  return padded;
}

interface Section {
  file: Buffer;
  image: X3fImageSection;
}

/** Writes a TRUE sensor section whose Huffman table is `tableBytes` (including any terminator) and planes are `planeData`. */
function buildSection(tableBytes: Buffer, planeData: Buffer[], seeds: number[]): Section {
  const header = Buffer.alloc(IMAGE_HEADER_BYTES);
  header.write('SECi', 0, 'latin1');
  header.writeUInt32LE(IMAGE_TYPE_RAW, 8);
  header.writeUInt32LE(IMAGE_FORMAT_TRUE, 12);
  header.writeUInt32LE(WIDTH, 16);
  header.writeUInt32LE(HEIGHT, 20);
  const seedBytes = Buffer.alloc(8);
  seeds.forEach((seed, index) => seedBytes.writeUInt16LE(seed, index * 2));
  const sizes = Buffer.alloc(PLANES * 4);
  planeData.forEach((data, index) => sizes.writeUInt32LE(data.length, index * 4));
  const file = Buffer.concat([header, seedBytes, tableBytes, sizes, ...planeData.map(align)]);
  return {
    file,
    image: { offset: 0, length: file.length, type: 'IMAG', imageType: IMAGE_TYPE_RAW, format: IMAGE_FORMAT_TRUE, columns: WIDTH, rows: HEIGHT },
  };
}

function tableBytes(pairs: Pair[], terminated = true): Buffer {
  const bytes = pairs.flatMap((pair) => [pair.length, pair.code]);
  return Buffer.from(terminated ? [...bytes, 0, 0] : bytes);
}

const SEEDS = [1000, 2000, 3000];
const PLANE_VALUES: number[][] = [
  [1000, 1004, 996, 1010, 990, 1020, 1001, 1003, 1000, 1000, 1500, 400, 1002, 1005, 999, 1011, 991, 1021, 1000, 1000, 1000, 1000, 1000, 1000],
  [2000, 2000, 2001, 1999, 2100, 1900, 2000, 2002, 2003, 1997, 2004, 1996, 2500, 1500, 2501, 1499, 2502, 1498, 2000, 2000, 2000, 2000, 2000, 2000],
  [3000, 3001, 3000, 3002, 3005, 2995, 3100, 2900, 3000, 3000, 3000, 3000, 3200, 2800, 3300, 2700, 3400, 2600, 3000, 3001, 3002, 3003, 3004, 3005],
];

function validSection(table: Pair[]): Section {
  const planes = PLANE_VALUES.map((values, layer) => encodePlane(values, SEEDS[layer], table));
  return buildSection(tableBytes(table), planes, SEEDS);
}

/** A section with the given table whose plane data is arbitrary but long enough to pass the size checks. */
function sectionWithTable(bytes: Buffer): Section {
  const filler = Buffer.alloc(WIDTH * HEIGHT, 0x55);
  return buildSection(bytes, [filler, filler, filler], SEEDS);
}

function expectRejectedQuickly(section: Section, message: RegExp): void {
  const started = performance.now();
  let caught: unknown;
  try {
    decodeTrueLayers(section.file, section.image);
  } catch (error) {
    caught = error;
  }
  expect(performance.now() - started).toBeLessThan(HOSTILE_HANG_GUARD_MS);
  expect(caught).toBeInstanceOf(RawDecodeError);
  expect((caught as RawDecodeError).message).toMatch(message);
}

describe('TRUE sensor section with valid 8-bit Huffman tables', () => {
  it.each([
    ['a 17-leaf table of mixed code lengths', COMPACT_TABLE],
    ['a 256-entry table that fills every 8-bit pattern', FLAT_TABLE],
  ])('decodes every sample of %s', (_name, table) => {
    const { file, image } = validSection(table);
    const layers = decodeTrueLayers(file, image);
    expect(layers.width).toBe(WIDTH);
    expect(layers.height).toBe(HEIGHT);
    expect(layers.planes.map((plane) => Array.from(plane))).toEqual(PLANE_VALUES);
  });
});

describe('TRUE sensor section with hostile 8-bit Huffman tables', () => {
  it('rejects a code that is a prefix of another code', () => {
    const prefixed: Pair[] = [
      { length: 1, code: 0x80 },
      { length: 2, code: 0xc0 },
    ];
    expectRejectedQuickly(sectionWithTable(tableBytes(prefixed)), /overlapping codes/);
  });

  it('rejects two leaves that share one full-length code', () => {
    const duplicated: Pair[] = [
      { length: 8, code: 0x41 },
      { length: 8, code: 0x41 },
    ];
    expectRejectedQuickly(sectionWithTable(tableBytes(duplicated)), /overlapping codes/);
  });

  it.each([9, 16, 32, 255])('rejects a code length of %i bits', (length) => {
    expectRejectedQuickly(sectionWithTable(tableBytes([{ length, code: 0xff }])), /Huffman code is \d+ bits long/);
  });

  it('rejects a table with more than 256 pairs', () => {
    // Only 256 distinct 8-bit codes exist, so the 257th pair repeats one: the decoder must reject the
    // table by its length, before it ever looks for overlapping codes.
    const oversized: Pair[] = Array.from({ length: MAX_TABLE_PAIRS + 1 }, (_, leaf) => ({ length: CODE_BITS, code: leaf % MAX_TABLE_PAIRS }));
    expectRejectedQuickly(sectionWithTable(tableBytes(oversized)), /Huffman table is too long/);
  });

  it('rejects a table that never reaches its terminator inside the section', () => {
    const open = Buffer.from(FLAT_TABLE.flatMap((pair) => [pair.length, pair.code]));
    const header = Buffer.alloc(IMAGE_HEADER_BYTES);
    header.write('SECi', 0, 'latin1');
    const file = Buffer.concat([header, Buffer.alloc(8), open]);
    const image: X3fImageSection = { offset: 0, length: file.length, type: 'IMAG', imageType: IMAGE_TYPE_RAW, format: IMAGE_FORMAT_TRUE, columns: WIDTH, rows: HEIGHT };
    expectRejectedQuickly({ file, image }, /not terminated/);
  });

  it('rejects compressed data that selects a pattern no code covers', () => {
    // The only code is "1" (leaf 0); the filler byte 0x55 starts with the unassigned bit 0.
    expectRejectedQuickly(sectionWithTable(tableBytes([{ length: 1, code: 0x80 }])), /unassigned Huffman code/);
  });

  it('rejects an empty table with data that needs a code', () => {
    expectRejectedQuickly(sectionWithTable(tableBytes([])), /unassigned Huffman code/);
  });

  it('rejects a leaf that asks for more extra bits than a sample holds', () => {
    // Leaf 17 needs 17 extra bits. Leaves 0..16 take the eight-bit codes 0x02..0x12 (a zero-length pair
    // would end the table), and leaf 17 is the one-bit code "1", which the all-ones data selects.
    const leaves: Pair[] = Array.from({ length: MAX_EXTRA_BITS + 1 }, (_, leaf) => ({ length: CODE_BITS, code: leaf + 2 }));
    const table: Pair[] = [...leaves, { length: 1, code: 0x80 }];
    const ones = Buffer.alloc(WIDTH * HEIGHT, 0xff);
    const section = buildSection(tableBytes(table), [ones, ones, ones], SEEDS);
    expectRejectedQuickly(section, /difference of 17 bits is not valid/);
  });
});
