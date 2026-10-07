import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CcittRasterError, encodeCcittG4, type BitonalRaster } from '../src/lib/conversions/ccitt-g4';
import { oracleTest } from './helpers/oracle-test';
import { magickConvert } from './helpers/magick-compare';

/**
 * The CCITT Group 4 encoder is checked against the encoder in ImageMagick's TIFF writer (the standard fax
 * library behind it), which writes the same T.6 strip for the same raster: every code of both run-length tables,
 * the make-up codes past 2560 pixels, the pass, vertical and horizontal modes, rows that are not a whole number
 * of bytes wide, the EOFB code and the padding must match bit for bit. Pixel-level decoding of the strip inside a
 * PDF is checked in ocr-pdf-png-passthrough.perf.test.ts.
 */

const TIFF_TAG_STRIP_OFFSETS = 273;
const TIFF_TAG_STRIP_BYTE_COUNTS = 279;
const TIFF_TYPE_SHORT = 3;
const TIFF_ENTRY_BYTES = 12;
const TIFF_VALUE_OFFSET = 8;
const NO_LIMIT = 1 << 28;
const WIDE_ROW_PX = 2700;
const LCG_MULTIPLIER = 1103515245;
const LCG_INCREMENT = 12345;
const LCG_MASK = 0x7fffffff;

/** Packs pixels into rows, most significant bit first; a clear bit is a black pixel. */
function pack(width: number, height: number, isBlack: (x: number, y: number) => boolean): BitonalRaster {
  const rowBytes = Math.ceil(width / 8);
  const data = new Uint8Array(rowBytes * height).fill(0xff);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (isBlack(x, y)) data[y * rowBytes + (x >> 3)] &= ~(0x80 >> (x & 7));
    }
  }
  return { width, height, data };
}

/**
 * The strip ImageMagick writes for `raster` as a Group 4 TIFF with one strip. The raster is handed over bit for
 * bit as a PBM, which the writer codes with set bits as black, the polarity of this encoder's clear bits.
 */
function referenceStrip(raster: BitonalRaster): Buffer {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccitt-g4-'));
  try {
    const rowBytes = Math.ceil(raster.width / 8);
    const body = Buffer.from(raster.data);
    const padding = raster.width % 8;
    if (padding) {
      for (let y = 0; y < raster.height; y++) body[y * rowBytes + rowBytes - 1] &= 0xff << (8 - padding);
    }
    fs.writeFileSync(path.join(dir, 'in.pbm'), Buffer.concat([Buffer.from(`P4\n${raster.width} ${raster.height}\n`), body]));
    magickConvert([
      path.join(dir, 'in.pbm'),
      '-define',
      `tiff:rows-per-strip=${raster.height}`,
      '-compress',
      'Group4',
      path.join(dir, 'out.tif'),
    ]);
    return stripOf(fs.readFileSync(path.join(dir, 'out.tif')));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Reads the single strip of a baseline TIFF from its first image file directory (TIFF 6.0, section 2). */
function stripOf(tiff: Buffer): Buffer {
  const littleEndian = tiff.toString('latin1', 0, 2) === 'II';
  const u16 = (offset: number) => (littleEndian ? tiff.readUInt16LE(offset) : tiff.readUInt16BE(offset));
  const u32 = (offset: number) => (littleEndian ? tiff.readUInt32LE(offset) : tiff.readUInt32BE(offset));
  const directory = u32(4);
  let offset = -1;
  let count = -1;
  for (let i = 0; i < u16(directory); i++) {
    const entry = directory + 2 + i * TIFF_ENTRY_BYTES;
    const value = u16(entry + 2) === TIFF_TYPE_SHORT ? u16(entry + TIFF_VALUE_OFFSET) : u32(entry + TIFF_VALUE_OFFSET);
    if (u16(entry) === TIFF_TAG_STRIP_OFFSETS) offset = value;
    if (u16(entry) === TIFF_TAG_STRIP_BYTE_COUNTS) count = value;
  }
  if (offset < 0 || count < 0) throw new Error('the TIFF has no single strip');
  return tiff.subarray(offset, offset + count);
}

function expectSameStrip(raster: BitonalRaster): void {
  const mine = encodeCcittG4(raster, NO_LIMIT);
  expect(mine).not.toBeNull();
  const reference = referenceStrip(raster);
  expect(Buffer.from(mine as Uint8Array).equals(reference)).toBe(true);
}

function randomRaster(width: number, height: number, blackShare: number, seed: number): BitonalRaster {
  let state = seed;
  const grid = new Uint8Array(width * height);
  for (let i = 0; i < grid.length; i++) {
    state = (state * LCG_MULTIPLIER + LCG_INCREMENT) & LCG_MASK;
    grid[i] = state / LCG_MASK < blackShare ? 1 : 0;
  }
  return pack(width, height, (x, y) => grid[y * width + x] === 1);
}

describe('CCITT Group 4 encoder against the ImageMagick TIFF writer', () => {
  oracleTest('codes every white and black run length up to 2700 pixels like the reference', [], () => {
    // Row n has n white pixels then black: white code n and black code (width - n), for every n.
    expectSameStrip(pack(WIDE_ROW_PX, WIDE_ROW_PX + 1, (x, y) => x >= y));
    // Row n has n black pixels then white: black code n and white code (width - n).
    expectSameStrip(pack(WIDE_ROW_PX, WIDE_ROW_PX + 1, (x, y) => x < y));
  });

  oracleTest('codes shifting runs against the row above like the reference', [], () => {
    expectSameStrip(pack(WIDE_ROW_PX, 400, (x, y) => x >= 100 + y * 5 && x < 100 + y * 5 + y * 3));
    expectSameStrip(pack(1200, 300, (x, y) => ((x >> 5) + (y >> 4)) % 3 === 0 && (x + (y % 5)) % 37 < 20));
  });

  oracleTest('codes rows two make-up codes long (5200 pixels) like the reference', [], () => {
    expectSameStrip(pack(5200, 3, (x, y) => y === 1 && x >= 2600 && x < 2601));
  });

  oracleTest('codes random rasters of awkward widths like the reference', [], () => {
    const cases: Array<[number, number, number]> = [
      [1, 7, 0.5],
      [7, 50, 0.5],
      [8, 50, 0.3],
      [9, 50, 0.7],
      [63, 80, 0.4],
      [64, 80, 0.5],
      [65, 80, 0.1],
      [257, 120, 0.5],
      [1000, 200, 0.02],
      [1000, 200, 0.98],
      [1001, 200, 0.5],
      [2550, 60, 0.001],
      [3000, 60, 0.5],
    ];
    cases.forEach(([width, height, share], index) => expectSameStrip(randomRaster(width, height, share, 1000 + index)));
  });
});

describe('CCITT Group 4 encoder limits', () => {
  it('gives up with null once the strip would pass the byte limit, and not before', () => {
    const raster = randomRaster(300, 100, 0.5, 7);
    const full = encodeCcittG4(raster, NO_LIMIT) as Uint8Array;
    expect(full.length).toBeGreaterThan(1000);
    expect(encodeCcittG4(raster, full.length)).toEqual(full);
    expect(encodeCcittG4(raster, full.length - 1)).toBeNull();
    expect(encodeCcittG4(raster, 0)).toBeNull();
  });

  it('codes an all-white page as one vertical code per row and the end-of-block code', () => {
    // Each row is V0 (a single 1 bit) against the white reference line; 8 rows fill a byte, then EOFB (000000000001 twice).
    const raster = pack(16, 8, () => false);
    expect(Array.from(encodeCcittG4(raster, NO_LIMIT) as Uint8Array)).toEqual([0xff, 0x00, 0x10, 0x01]);
  });

  it('rejects a raster whose data does not match its size', () => {
    expect(() => encodeCcittG4({ width: 10, height: 2, data: new Uint8Array(3) }, NO_LIMIT)).toThrow(
      new CcittRasterError('A 10x2 bitonal raster is 4 bytes, got 3')
    );
    expect(() => encodeCcittG4({ width: 0, height: 2, data: new Uint8Array(0) }, NO_LIMIT)).toThrow(
      new CcittRasterError('A CCITT raster needs a positive integer size, got 0x2')
    );
  });
});
