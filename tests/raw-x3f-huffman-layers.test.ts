import { describe, it, expect } from 'vitest';
import { decodeHuffmanLayers, type X3fImageSection } from '../src/lib/conversions/raw-x3f';
import { RawDecodeError } from '../src/lib/types';

/**
 * The Huffman-coded (SD14/SD15 generation, format 0x06) sensor section: valid tables around the width of
 * the decoder's first-bits lookup, and damaged sections that must be refused with the same message however
 * the bits are read.
 *
 * Oracle: the section is written here by a separate encoder that follows the documented layout (1024
 * signed differences, 1024 code words with the length in the top 5 bits, rows of per-pixel codes for
 * layers 0, 1 and 2 padded to whole 32-bit words, then the rows' byte offsets), and the expected samples
 * are the planes the encoder walked.
 */

const IMAGE_HEADER_BYTES = 28;
const IMAGE_TYPE_RAW = 3;
const IMAGE_FORMAT_HUFFMAN = 0x06;
const TABLE_ENTRIES = 1024;
const LENGTH_SHIFT = 27;
const WORD_BITS = 32;
const LAYERS = 3;
const WIDTH = 41;
const HEIGHT = 5;
const MAX_CODE_BITS = 26;
/** Hang guard only: a damaged section is refused in milliseconds. */
const HANG_GUARD_MS = 10_000;

interface Code {
  length: number;
  code: number;
}

/** Prefix-free codes of the given lengths, which must not decrease: the canonical assignment. */
function canonicalCodes(lengths: number[]): Code[] {
  let code = 0;
  let previous = lengths[0];
  return lengths.map((length) => {
    code *= 2 ** (length - previous);
    previous = length;
    const assigned = { length, code };
    code += 1;
    return assigned;
  });
}

/** Lengths 1, 2, ..., last, last: a complete code (every bit string starts with exactly one code). */
const unaryLengths = (last: number): number[] => [...Array.from({ length: last }, (_, index) => index + 1), last];

/** Leaf i stands for a difference of an alternating sign that grows with i. */
const unaryDifferences = (leaves: number): number[] => Array.from({ length: leaves }, (_, leaf) => (leaf % 2 === 0 ? 1 : -1) * (leaf + 1) * 3);

interface Table {
  codes: Code[];
  differences: number[];
}

const UNARY_12: Table = { codes: canonicalCodes(unaryLengths(12)), differences: unaryDifferences(13) };
const UNARY_26: Table = { codes: canonicalCodes(unaryLengths(MAX_CODE_BITS)), differences: unaryDifferences(MAX_CODE_BITS + 1) };
/** 1024 ten-bit codes: with a first-bits table of 12 bits or fewer, every slot of it holds a code. */
const FLAT_1024: Table = {
  codes: canonicalCodes(Array.from({ length: TABLE_ENTRIES }, () => 10)),
  differences: Array.from({ length: TABLE_ENTRIES }, (_, leaf) => leaf - TABLE_ENTRIES / 2),
};
/** Short codes for the common differences, long ones for the rare: lengths on both sides of any plausible table width. */
const MIXED: Table = {
  codes: canonicalCodes([2, 3, 4, 8, 11, 12, 13, 14, 20, 26, 26]),
  differences: [0, 1, -1, 7, -7, 60, -60, 300, -300, 2000, -2000],
};

/** Appends bits most significant first and pads to whole 32-bit words. */
class WordWriter {
  private readonly bits: number[] = [];

  write(value: number, count: number): void {
    for (let bit = count - 1; bit >= 0; bit -= 1) this.bits.push(Math.floor(value / 2 ** bit) % 2);
  }

  finish(): Buffer {
    while (this.bits.length % WORD_BITS !== 0) this.bits.push(0);
    const bytes = Buffer.alloc(this.bits.length / 8);
    this.bits.forEach((bit, index) => {
      bytes[index >> 3] |= bit << (7 - (index & 7));
    });
    return bytes;
  }
}

/** Deterministic pseudo-random leaf numbers (a 32-bit linear congruential generator). */
function leafSequence(count: number, leaves: number): number[] {
  let state = 12345;
  return Array.from({ length: count }, () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return (state >>> 8) % leaves;
  });
}

interface Encoded {
  rows: Buffer[];
  planes: number[][];
}

/** Walks `table` with the pseudo-random leaves, writing each row and recording the samples it must decode to. */
function encode(table: Table, width = WIDTH, height = HEIGHT): Encoded {
  const leafOf = leafSequence(width * height * LAYERS, table.codes.length);
  const planes = Array.from({ length: LAYERS }, () => new Array<number>(width * height).fill(0));
  const rows = Array.from({ length: height }, (_, row) => {
    const writer = new WordWriter();
    const predictors = [0, 0, 0];
    for (let column = 0; column < width; column += 1) {
      for (let layer = 0; layer < LAYERS; layer += 1) {
        const leaf = leafOf[(row * width + column) * LAYERS + layer];
        writer.write(table.codes[leaf].code, table.codes[leaf].length);
        predictors[layer] += table.differences[leaf];
        planes[layer][row * width + column] = predictors[layer];
      }
    }
    return writer.finish();
  });
  return { rows, planes };
}

interface Section {
  file: Buffer;
  image: X3fImageSection;
}

interface Shape {
  columns?: number;
  /** Overrides the row offset table. */
  offsets?: number[];
}

/** Writes the section around `rows`, one row per row of the image. */
function buildSection(table: Table, rows: Buffer[], { columns = WIDTH, offsets }: Shape = {}): Section {
  const header = Buffer.alloc(IMAGE_HEADER_BYTES);
  header.write('SECi', 0, 'latin1');
  header.writeUInt32LE(IMAGE_TYPE_RAW, 8);
  header.writeUInt32LE(IMAGE_FORMAT_HUFFMAN, 12);
  header.writeUInt32LE(columns, 16);
  header.writeUInt32LE(rows.length, 20);
  const differences = Buffer.alloc(TABLE_ENTRIES * 2);
  table.differences.forEach((difference, leaf) => differences.writeInt16LE(difference, leaf * 2));
  const words = Buffer.alloc(TABLE_ENTRIES * 4);
  table.codes.forEach((entry, leaf) => words.writeUInt32LE(((entry.length << LENGTH_SHIFT) | entry.code) >>> 0, leaf * 4));
  let start = 0;
  const rowOffsets = offsets ?? rows.map((row) => ((start += row.length), start - row.length));
  const offsetBytes = Buffer.alloc(rowOffsets.length * 4);
  rowOffsets.forEach((offset, index) => offsetBytes.writeUInt32LE(offset, index * 4));
  const file = Buffer.concat([header, differences, words, ...rows, offsetBytes]);
  return {
    file,
    image: { offset: 0, length: file.length, type: 'IMAG', imageType: IMAGE_TYPE_RAW, format: IMAGE_FORMAT_HUFFMAN, columns, rows: rows.length },
  };
}

function expectRefused(section: Section, message: RegExp): void {
  const started = performance.now();
  let caught: unknown;
  try {
    decodeHuffmanLayers(section.file, section.image);
  } catch (error) {
    caught = error;
  }
  expect(performance.now() - started).toBeLessThan(HANG_GUARD_MS);
  expect(caught).toBeInstanceOf(RawDecodeError);
  expect((caught as RawDecodeError).message).toMatch(message);
}

describe('Huffman sensor section with valid tables', () => {
  it.each([
    ['a complete code of lengths 1 to 12, which fills every slot of a 12-bit first-bits table', UNARY_12],
    ['a complete code of lengths 1 to 26, whose codes are mostly longer than the first-bits table', UNARY_26],
    ['1024 ten-bit codes, which fill every slot of the first-bits table', FLAT_1024],
    ['short codes beside codes of 13, 14, 20 and 26 bits', MIXED],
  ])('decodes every sample of %s', (_name, table) => {
    const { rows, planes } = encode(table);
    const { file, image } = buildSection(table, rows);
    const layers = decodeHuffmanLayers(file, image);
    expect([layers.width, layers.height]).toEqual([WIDTH, HEIGHT]);
    expect(layers.planes.map((plane) => Array.from(plane))).toEqual(planes);
  });

  it('decodes rows whose codes end exactly on a word edge', () => {
    // Six 16-bit codes per two-pixel row fill three whole words.
    const table: Table = { codes: canonicalCodes([16, 16]), differences: [5, -5] };
    const { rows, planes } = encode(table, 2, 3);
    expect(rows.map((row) => row.length)).toEqual([12, 12, 12]);
    const layers = decodeHuffmanLayers(...sectionArgs(buildSection(table, rows, { columns: 2 })));
    expect(layers.planes.map((plane) => Array.from(plane))).toEqual(planes);
  });
});

function sectionArgs(section: Section): [Buffer, X3fImageSection] {
  return [section.file, section.image];
}

describe('Huffman sensor section with damaged data', () => {
  it('refuses a table with a code that is a prefix of another', () => {
    const table: Table = { codes: [{ length: 1, code: 0 }, { length: 2, code: 1 }], differences: [0, 1] };
    expectRefused(buildSection(table, encode(UNARY_12).rows), /overlapping codes/);
  });

  it('refuses a table in which the shorter code comes after the longer one', () => {
    const table: Table = { codes: [{ length: 2, code: 1 }, { length: 1, code: 0 }], differences: [0, 1] };
    expectRefused(buildSection(table, encode(UNARY_12).rows), /overlapping codes/);
  });

  it('refuses two leaves with one code', () => {
    const table: Table = { codes: [{ length: 12, code: 0x155 }, { length: 12, code: 0x155 }], differences: [0, 1] };
    expectRefused(buildSection(table, encode(UNARY_12).rows), /overlapping codes/);
  });

  it.each([27, 31])('refuses a code of %i bits', (length) => {
    const table: Table = { codes: [{ length, code: 1 }], differences: [0] };
    expectRefused(buildSection(table, encode(UNARY_12).rows), /Huffman code is \d+ bits long/);
  });

  it('refuses a bit string that no code starts with, in the middle of a row', () => {
    const table: Table = { codes: [{ length: 3, code: 0 }], differences: [1] };
    const rows = Array.from({ length: HEIGHT }, () => Buffer.alloc(Math.ceil((WIDTH * LAYERS * 3) / WORD_BITS) * 4, 0xff));
    expectRefused(buildSection(table, rows), /unassigned Huffman code/);
  });

  it('refuses a bit string that no code starts with, on the last word of a row', () => {
    // The row is all valid codes but the very last bit string, which is 111.
    const table: Table = { codes: [{ length: 3, code: 0 }], differences: [1] };
    const writer = new WordWriter();
    for (let sample = 0; sample < WIDTH * LAYERS - 1; sample += 1) writer.write(0, 3);
    writer.write(0b111, 3);
    const row = writer.finish();
    expectRefused(buildSection(table, Array.from({ length: HEIGHT }, () => row)), /unassigned Huffman code/);
  });

  it('refuses a row whose last code needs bits beyond the row', () => {
    // Every bit is 1, so every code is the 26-bit one: the first sample takes 26 of the 32 bits of the only
    // word of each of two rows, the second needs 26 more. The row holds enough bits for its pixels (6 of 32).
    const row = Buffer.alloc(4, 0xff);
    expectRefused(buildSection(UNARY_26, [row, row], { columns: 2 }), /ends early/);
  });

  it('refuses a row whose last word is taken by a code that straddles two words and is followed by one more', () => {
    // Two all-ones words: samples 1 and 2 take 52 of the 64 bits (the second one reads the second word),
    // so the third finds 12 bits left, fewer than its code, and no word after them.
    const row = Buffer.alloc(8, 0xff);
    expectRefused(buildSection(UNARY_26, [row, row], { columns: 2 }), /ends early/);
  });

  it('refuses a row that holds a word the codes do not reach', () => {
    const { rows } = encode(UNARY_12);
    rows[2] = Buffer.concat([rows[2], Buffer.alloc(4)]);
    expectRefused(buildSection(UNARY_12, rows), /row 2 does not end where the row table says/);
  });

  it('refuses a row too short for its pixels', () => {
    const { rows } = encode(UNARY_12);
    rows[1] = rows[1].subarray(0, 12);
    expectRefused(buildSection(UNARY_12, rows), /row 1 is too small/);
  });

  it('refuses a row offset that leaves the data', () => {
    const { rows } = encode(UNARY_12);
    const total = rows.reduce((sum, row) => sum + row.length, 0);
    expectRefused(buildSection(UNARY_12, rows, { offsets: [0, rows[0].length, total + 4, total + 8, total + 12] }), /lies outside the sensor data/);
  });

  it('refuses a sample that leaves the 16-bit range', () => {
    const table: Table = { codes: [{ length: 1, code: 0 }], differences: [32767] };
    const writer = new WordWriter();
    for (let sample = 0; sample < WIDTH * LAYERS; sample += 1) writer.write(0, 1);
    const row = writer.finish();
    expectRefused(buildSection(table, Array.from({ length: HEIGHT }, () => row)), /outside the 16-bit range/);
  });

  it('refuses a section shorter than its tables', () => {
    const section = buildSection(UNARY_12, encode(UNARY_12).rows);
    expectRefused({ file: section.file.subarray(0, 100), image: { ...section.image, length: 100 } }, /shorter than its tables/);
  });
});
