import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { encodeDib, MAX_PALETTE_COLOURS } from '../src/lib/conversions/metafile-dib';
import { emfStretchDib, stretchDibRecordBytes, wmfStretchDib, type RegionBitmap } from '../src/lib/conversions/metafile-bitmap';
import { readMetafilePage } from '../src/lib/conversions/vector-metafile';
import { skipWithoutTools } from './helpers/strict-skip';

/**
 * The bitmap record of a region is written with the least depth that holds its colours exactly (1, 4 or 8 bits with a colour table, as
 * the office suite's own writers keep a bitmap that has a palette) and as 24 bits otherwise, always uncompressed (entry 461). The bytes are
 * checked against the layouts of MS-EMF 2.2.2 (BitmapInfoHeader) and MS-WMF 2.2.2.3, read back by a decoder written here from those
 * rules, and the pictures are drawn by Inkscape and the office suite.
 */

const BI_RGB = 0;
const INFO_HEADER_BYTES = 40;
const EMF_STRETCHDIBITS_HEADER_BYTES = 80;
const WMF_STRETCHDIB_HEADER_BYTES = 28;

type Rgb = [number, number, number];

/** A picture from rows of colours, top row first. */
function pictureOf(rows: readonly (readonly Rgb[])[]): RegionBitmap {
  const height = rows.length;
  const width = rows[0].length;
  return { rect: { x0: 0, y0: 0, x1: width, y1: height }, width, height, rgb: Buffer.from(rows.flat().flat()) };
}

/** A picture of `width` by `height` pixels whose colour is `colourAt(x, y)`. */
function paint(width: number, height: number, colourAt: (x: number, y: number) => Rgb): RegionBitmap {
  const rows: Rgb[][] = [];
  for (let y = 0; y < height; y++) rows.push(Array.from({ length: width }, (_, x) => colourAt(x, y)));
  return pictureOf(rows);
}

/** The n-th of 65,536 colours, all different, and the first 256 spread over the range. */
function distinctColour(n: number): Rgb {
  const high = n >> 8;
  return [(n * 37) % 256, (n * 91 + 5 + high * 17) % 256, (n * 151 + 11 + high * 29) % 256];
}

interface DecodedDib {
  bitCount: number;
  compression: number;
  sizeImage: number;
  clrUsed: number;
  palette: Rgb[];
  /** Rows of colours, top row first. */
  rows: Rgb[][];
  /** The bytes of the pixel data as written, without padding of the record. */
  bits: Buffer;
}

/** Reads a device-independent bitmap from the rules of the format: the info header, a colour table of `biClrUsed` entries (4 bytes: blue, green, red, 0), then the bits. */
function decodeDib(info: Buffer, bits: Buffer): DecodedDib {
  expect(info.readUInt32LE(0)).toBe(INFO_HEADER_BYTES);
  const width = info.readInt32LE(4);
  const height = info.readInt32LE(8);
  expect(Math.sign(height)).toBe(1); // bottom-up, the only order that run-length coding allows
  expect(info.readUInt16LE(12)).toBe(1);
  const bitCount = info.readUInt16LE(14);
  const compression = info.readUInt32LE(16);
  const sizeImage = info.readUInt32LE(20);
  const clrUsed = info.readUInt32LE(32);
  expect(info.length).toBe(INFO_HEADER_BYTES + clrUsed * 4);
  const palette: Rgb[] = [];
  for (let i = 0; i < clrUsed; i++) {
    const at = INFO_HEADER_BYTES + i * 4;
    palette.push([info[at + 2], info[at + 1], info[at]]);
  }
  const indexRows: number[][] = [];
  expect(compression).toBe(BI_RGB);
  const stride = Math.ceil((width * bitCount) / 32) * 4;
  expect(bits.length).toBe(stride * height);
  for (let y = height - 1; y >= 0; y--) {
    const row: number[] = [];
    for (let x = 0; x < width; x++) {
      const bit = x * bitCount;
      const base = y * stride + (bit >> 3);
      if (bitCount === 24) row.push(-1);
      else if (bitCount === 8) row.push(bits[base]);
      else row.push((bits[base] >> (8 - bitCount - (bit & 7))) & ((1 << bitCount) - 1));
    }
    indexRows.push(row);
  }
  const rows: Rgb[][] = indexRows.map((indices, i) => {
    expect(indices, `row ${i}`).toHaveLength(width);
    if (bitCount === 24) {
      const y = height - 1 - i;
      const stride = Math.ceil((width * 24) / 32) * 4;
      return indices.map((_, x) => [bits[y * stride + x * 3 + 2], bits[y * stride + x * 3 + 1], bits[y * stride + x * 3]] as Rgb);
    }
    return indices.map((index) => palette[index]);
  });
  expect(rows).toHaveLength(height);
  return { bitCount, compression, sizeImage, clrUsed, palette, rows, bits };
}

/** The bitmap of an EMR_STRETCHDIBITS record, found by the offsets and sizes the record gives. */
function readEmfRecord(record: Buffer): DecodedDib {
  const offBmi = record.readUInt32LE(48);
  const cbBmi = record.readUInt32LE(52);
  const offBits = record.readUInt32LE(56);
  const cbBits = record.readUInt32LE(60);
  expect(offBmi).toBe(EMF_STRETCHDIBITS_HEADER_BYTES);
  expect(offBits).toBe(offBmi + cbBmi);
  expect(record.readUInt32LE(4)).toBe(record.length);
  expect(record.length % 4).toBe(0);
  expect(record.length - offBits - cbBits, 'padding after the bits').toBeLessThan(4);
  return decodeDib(record.subarray(offBmi, offBmi + cbBmi), record.subarray(offBits, offBits + cbBits));
}

/** The bitmap of a META_STRETCHDIB record: the info header, the colour table and the bits follow the 28 bytes of the record's parameters. */
function readWmfRecord(record: Buffer): DecodedDib {
  expect(record.readUInt32LE(0) * 2).toBe(record.length);
  const clrUsed = record.readUInt32LE(WMF_STRETCHDIB_HEADER_BYTES + 32);
  const infoBytes = INFO_HEADER_BYTES + clrUsed * 4;
  const sizeImage = record.readUInt32LE(WMF_STRETCHDIB_HEADER_BYTES + 20);
  const bitsStart = WMF_STRETCHDIB_HEADER_BYTES + infoBytes;
  expect(record.length - bitsStart - sizeImage, 'padding after the bits').toBeLessThan(2);
  return decodeDib(record.subarray(WMF_STRETCHDIB_HEADER_BYTES, bitsStart), record.subarray(bitsStart, bitsStart + sizeImage));
}

function rowsOf(bitmap: RegionBitmap): Rgb[][] {
  const rows: Rgb[][] = [];
  for (let y = 0; y < bitmap.height; y++) {
    const row: Rgb[] = [];
    for (let x = 0; x < bitmap.width; x++) {
      const at = (y * bitmap.width + x) * 3;
      row.push([bitmap.rgb[at], bitmap.rgb[at + 1], bitmap.rgb[at + 2]]);
    }
    rows.push(row);
  }
  return rows;
}

const WHITE: Rgb = [255, 255, 255];
const BLACK: Rgb = [0, 0, 0];
const RED: Rgb = [255, 0, 0];

describe('the depth of a region picture', () => {
  it('is 1 bit with a table of 2 entries for a picture of 2 colours, in the order they first appear', () => {
    const bitmap = pictureOf([
      [WHITE, BLACK, WHITE],
      [BLACK, BLACK, WHITE],
    ]);
    const dib = readEmfRecord(emfStretchDib(bitmap, 1));
    expect(dib.bitCount).toBe(1);
    expect(dib.compression).toBe(BI_RGB);
    expect(dib.clrUsed).toBe(2);
    expect(dib.palette).toEqual([WHITE, BLACK]);
    // Bottom row first, the leftmost pixel in the high bit, each row padded to 4 bytes: bits 110 then 010.
    expect([...dib.bits]).toEqual([0b11000000, 0, 0, 0, 0b01000000, 0, 0, 0]);
    expect(dib.rows).toEqual(rowsOf(bitmap));
  });

  it('is 1 bit for a picture of one colour', () => {
    const bitmap = paint(5, 3, () => RED);
    const dib = readEmfRecord(emfStretchDib(bitmap, 1));
    expect(dib.bitCount).toBe(1);
    expect(dib.palette).toEqual([RED]);
    expect(dib.rows).toEqual(rowsOf(bitmap));
  });

  it('is 4 bits with a table of 16 entries at most for 3 to 16 colours, the high nibble first', () => {
    const bitmap = paint(16, 4, (x, y) => distinctColour((x + y) % 16));
    const dib = readEmfRecord(emfStretchDib(bitmap, 1));
    expect(dib.bitCount).toBe(4);
    expect(dib.compression).toBe(BI_RGB);
    expect(dib.clrUsed).toBe(16);
    expect(dib.rows).toEqual(rowsOf(bitmap));
    // The bottom row (y = 3) starts with the colours of x = 0 and x = 1, which are the shades 3 and 4.
    const first = dib.palette.findIndex((colour) => colour.join() === distinctColour(3).join());
    const second = dib.palette.findIndex((colour) => colour.join() === distinctColour(4).join());
    expect(dib.bits[0]).toBe((first << 4) | second);
  });

  it('is 8 bits for 17 to 256 colours, with exactly the colours of the picture in the table', () => {
    const bitmap = paint(256, 8, (x, y) => distinctColour((x + y * 7) % 256));
    const dib = readEmfRecord(emfStretchDib(bitmap, 1));
    expect(dib.bitCount).toBe(8);
    expect(dib.compression).toBe(BI_RGB);
    expect(dib.clrUsed).toBe(256);
    expect(dib.rows).toEqual(rowsOf(bitmap));
    expect(new Set(dib.palette.map((colour) => colour.join())).size).toBe(256);
  });

  it('is 24 bits with no table for 257 colours', () => {
    const bitmap = paint(257, 4, (x) => distinctColour(x));
    expect(MAX_PALETTE_COLOURS).toBe(256);
    const dib = readEmfRecord(emfStretchDib(bitmap, 1));
    expect(dib.bitCount).toBe(24);
    expect(dib.compression).toBe(BI_RGB);
    expect(dib.clrUsed).toBe(0);
    expect(dib.rows).toEqual(rowsOf(bitmap));
    expect(emfStretchDib(bitmap, 1)).toHaveLength(80 + 40 + Math.ceil((257 * 3) / 4) * 4 * 4);
  });

  it('keeps the 24-bit rows from the bottom up as blue, green, red', () => {
    const bitmap = paint(300, 2, (x, y) => (x === 0 && y === 0 ? [0x10, 0x20, 0x30] : distinctColour(x)));
    const record = emfStretchDib(bitmap, 1);
    const stride = Math.ceil((300 * 3) / 4) * 4;
    const offBits = record.readUInt32LE(56);
    expect([...record.subarray(offBits + stride, offBits + stride + 3)]).toEqual([0x30, 0x20, 0x10]);
  });
});

describe('the record that holds the bitmap', () => {
  const flat = paint(120, 40, (x, y) => (x < 60 ? (y < 20 ? RED : WHITE) : y < 20 ? BLACK : [0, 0, 255]));

  it('gives EMR_STRETCHDIBITS the offsets and sizes of the table and the bits', () => {
    const bitmap = { ...flat, rect: { x0: 4, y0: 6, x1: 124, y1: 46 } };
    const record = emfStretchDib(bitmap, 2);
    expect(record.readUInt32LE(0)).toBe(81);
    expect(record.readInt32LE(40)).toBe(120); // cxSrc
    expect(record.readInt32LE(44)).toBe(40); // cySrc
    expect(record.readInt32LE(52)).toBe(40 + 16); // cbBmiSrc: the header and 4 entries
    expect(record.readUInt32LE(60)).toBe(60 * 40); // cbBitsSrc: 4 bits a pixel, 120 pixels (60 bytes, a multiple of 4) a row, 40 rows
    expect(record.readUInt32LE(64)).toBe(0); // DIB_RGB_COLORS
    expect(record.readUInt32LE(68)).toBe(0x00cc0020); // SRCCOPY
    expect(record.readInt32LE(72)).toBe(240); // cxDest
    expect(record.readInt32LE(76)).toBe(80); // cyDest
    const dib = readEmfRecord(record);
    expect(dib.rows).toEqual(rowsOf(bitmap));
  });

  it('gives META_STRETCHDIB the same bitmap after the 28 bytes of its parameters, to the word', () => {
    const record = wmfStretchDib(flat, 1);
    expect(record.readUInt16LE(4)).toBe(0x0f43);
    expect(record.readInt16LE(12)).toBe(40);
    expect(record.readInt16LE(14)).toBe(120);
    const dib = readWmfRecord(record);
    expect(dib.rows).toEqual(rowsOf(flat));
    expect(dib.bitCount).toBe(4);
  });

  it('does not run-length code a flat picture, which the reference reader does not draw', () => {
    const bitmap = paint(300, 40, (x) => (x < 10 ? RED : WHITE));
    for (const dib of [readEmfRecord(emfStretchDib(bitmap, 1)), readWmfRecord(wmfStretchDib(bitmap, 1))]) {
      expect({ bitCount: dib.bitCount, compression: dib.compression }).toEqual({ bitCount: 1, compression: BI_RGB });
      expect(dib.rows).toEqual(rowsOf(bitmap));
    }
  });

  it('pads the rows to 4 bytes, so that a record is a whole number of words in both formats', () => {
    for (const width of [1, 3, 7, 9, 31, 33]) {
      const bitmap = paint(width, 3, (x, y) => distinctColour(x + y * width));
      expect(emfStretchDib(bitmap, 1).length % 4).toBe(0);
      expect(wmfStretchDib(bitmap, 1).length % 2).toBe(0);
      expect(readEmfRecord(emfStretchDib(bitmap, 1)).rows).toEqual(rowsOf(bitmap));
    }
  });

  it('is never longer than the 24-bit record that stretchDibRecordBytes counts against the limit of the file', () => {
    for (const bitmap of [flat, paint(300, 4, (x) => distinctColour(x)), paint(9, 9, () => RED)]) {
      expect(emfStretchDib(bitmap, 1).length).toBeLessThanOrEqual(stretchDibRecordBytes(bitmap, 'emf'));
      expect(wmfStretchDib(bitmap, 1).length).toBeLessThanOrEqual(stretchDibRecordBytes(bitmap, 'wmf'));
    }
  });

  it('writes a page of flat artwork in the bytes of the 1-bit picture, not the 24-bit one of the same region', () => {
    const page = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="150pt" height="75pt" viewBox="0 0 150 75"><defs><linearGradient id="g"><stop offset="0" stop-color="#f00"/><stop offset="1" stop-color="#00f"/></linearGradient></defs><rect x="15" y="15" width="45" height="30" fill="url(#g)"/></svg>'
    );
    const read = readMetafilePage(page, 'emf');
    const [rect] = read.regions;
    const width = rect.x1 - rect.x0;
    const height = rect.y1 - rect.y0;
    const flat = paint(width, height, (x, y) => (x < 3 || y < 3 ? WHITE : RED));
    const noisy = paint(width, height, (x, y) => distinctColour(x * height + y));
    const flatFile = read.write([{ ...flat, rect }]);
    const noisyFile = read.write([{ ...noisy, rect }]);
    // The same page and rectangle: the noisy picture is 24 bits and the flat one 1 bit with a table of 2 entries.
    const rows24 = Math.ceil((width * 24) / 32) * 4;
    const rows1 = Math.ceil(width / 32) * 4;
    expect(noisyFile.length - flatFile.length).toBe(rows24 * height - (8 + rows1 * height));
  });

  it('refuses a picture whose colour bytes are not its pixels', () => {
    expect(() => encodeDib({ width: 2, height: 2, rgb: Buffer.alloc(5) })).toThrow(/2 by 2 pixels holds 5 bytes of colour/);
  });
});

const toolsMissing = skipWithoutTools('inkscape', 'soffice');
const READER_TIMEOUT_MS = 180_000;
/** A reader's resampling moves a mean by a few levels of 255; a wrong colour table or a flipped picture moves it by tens. */
const MAX_MEAN_DIFFERENCE = 12;

interface Raw {
  data: Buffer;
  width: number;
  height: number;
}

const rawOf = (file: string): Promise<Raw> =>
  sharp(file).flatten({ background: '#ffffff' }).removeAlpha().raw().toBuffer({ resolveWithObject: true }).then((r) => ({ data: r.data, width: r.info.width, height: r.info.height }));

/** The metafile drawn by Inkscape at 96 pixels to the inch. */
function inkscapePixels(metafile: Buffer, target: string, directory: string): Promise<Raw> {
  const input = path.join(directory, `input.${target}`);
  const output = path.join(directory, 'inkscape.png');
  fs.writeFileSync(input, metafile);
  spawnSync('inkscape', [input, '--export-type=png', `--export-filename=${output}`, '-d', '96'], { timeout: READER_TIMEOUT_MS, stdio: 'ignore' });
  return rawOf(output);
}

/** The metafile drawn by the office suite, cropped to the drawing. */
function officePixels(metafile: Buffer, target: string, directory: string): Promise<Raw> {
  const input = path.join(directory, `office.${target}`);
  fs.writeFileSync(input, metafile);
  spawnSync('soffice', ['--headless', `-env:UserInstallation=file://${directory}/profile`, '--convert-to', 'png', '--outdir', path.join(directory, 'o'), input], {
    timeout: READER_TIMEOUT_MS,
    stdio: 'ignore',
  });
  return sharp(path.join(directory, 'o', 'office.png'))
    .flatten({ background: '#ffffff' })
    .trim({ background: '#ffffff', threshold: 24 })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
    .then((r) => ({ data: r.data, width: r.info.width, height: r.info.height }));
}

/** A page of one picture that fills it, written as `format`. */
function pageOf(bitmap: RegionBitmap, format: 'emf' | 'wmf'): Buffer {
  const svg = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${bitmap.width}px" height="${bitmap.height}px" viewBox="0 0 ${bitmap.width} ${bitmap.height}"><defs><linearGradient id="g"><stop offset="0" stop-color="#f00"/><stop offset="1" stop-color="#00f"/></linearGradient></defs><rect x="0" y="0" width="${bitmap.width}" height="${bitmap.height}" fill="url(#g)"/></svg>`
  );
  const read = readMetafilePage(svg, format);
  expect(read.regions).toHaveLength(1);
  return read.write([{ ...bitmap, rect: read.regions[0] }]);
}

const A: Rgb = [200, 30, 30];
const B: Rgb = [240, 200, 10];

interface DepthCase {
  name: string;
  bitmap: RegionBitmap;
  bitCount: number;
  compression: number;
}

/** One picture for each depth the writer picks, of a shape that makes it the shortest choice and with a top half that differs from the bottom half. */
const DEPTHS: DepthCase[] = [
  { name: '1 bit', bitmap: paint(80, 40, (x, y) => (y < 20 ? ((x + y) % 2 === 0 ? A : B) : x % 4 === 0 ? B : A)), bitCount: 1, compression: BI_RGB },
  { name: '4 bits', bitmap: paint(80, 40, (x, y) => distinctColour(y < 20 ? x % 12 : x % 6)), bitCount: 4, compression: BI_RGB },
  { name: '8 bits', bitmap: paint(80, 40, (x, y) => distinctColour(y < 20 ? x % 40 : 40 + (x % 20))), bitCount: 8, compression: BI_RGB },
  { name: '24 bits', bitmap: paint(80, 40, (x, y) => ((c) => (y < 20 ? c : ([255 - c[0], c[1], c[2]] as Rgb)))(distinctColour(x * 40 + y))), bitCount: 24, compression: BI_RGB },
];

/** The mean colour of the middle half (across and down) of each quadrant of a picture of 3 channels: top left, top right, bottom left, bottom right. */
function quadrantMeans({ data, width, height }: Raw): Rgb[] {
  const means: Rgb[] = [];
  for (const row of [0, 1]) {
    for (const column of [0, 1]) {
      const sum = [0, 0, 0];
      let pixels = 0;
      for (let y = Math.floor(height * (0.125 + row * 0.5)); y < Math.floor(height * (0.375 + row * 0.5)); y++) {
        for (let x = Math.floor(width * (0.125 + column * 0.5)); x < Math.floor(width * (0.375 + column * 0.5)); x++, pixels++) {
          for (let c = 0; c < 3; c++) sum[c] += data[(y * width + x) * 3 + c];
        }
      }
      means.push([sum[0] / pixels, sum[1] / pixels, sum[2] / pixels]);
    }
  }
  return means;
}

describe.skipIf(toolsMissing)('the pictures that two other readers draw', () => {
  for (const format of ['emf', 'wmf'] as const) {
    for (const { name, bitmap, bitCount, compression } of DEPTHS) {
      it(
        `draws a picture of ${name} as ${format.toUpperCase()} in both readers`,
        async () => {
          const metafile = pageOf(bitmap, format);
          const rect = { x0: 0, y0: 0, x1: bitmap.width, y1: bitmap.height };
          const dib = format === 'emf' ? readEmfRecord(emfStretchDib({ ...bitmap, rect }, 1)) : readWmfRecord(wmfStretchDib({ ...bitmap, rect }, 1));
          expect({ bitCount: dib.bitCount, compression: dib.compression }).toEqual({ bitCount, compression });
          const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dib-'));
          try {
            // A reader draws the page a pixel or so larger than the picture and may resample it, so the middle of each quadrant is compared by its mean colour.
            const expected = quadrantMeans({ data: bitmap.rgb, width: bitmap.width, height: bitmap.height });
            for (const [reader, drawn] of [
              ['Inkscape', await inkscapePixels(metafile, format, directory)],
              ['the office suite', await officePixels(metafile, format, directory)],
            ] as const) {
              const got = quadrantMeans(drawn);
              const worst = got.map((mean, quadrant) => Math.max(...mean.map((channel, c) => Math.abs(channel - expected[quadrant][c]))));
              expect(
                worst.map((difference) => difference <= MAX_MEAN_DIFFERENCE),
                `${reader}: quadrant means ${JSON.stringify(got)} against ${JSON.stringify(expected)}`
              ).toEqual([true, true, true, true]);
            }
          } finally {
            fs.rmSync(directory, { recursive: true, force: true });
          }
        },
        READER_TIMEOUT_MS
      );
    }
  }
});
