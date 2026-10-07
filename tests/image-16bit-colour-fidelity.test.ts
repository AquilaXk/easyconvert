import { describe, it, expect } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import sharp from 'sharp';
import { convertImage } from '../src/lib/conversions/image';
import { encode16BitTiff } from '../src/lib/conversions/raw-hdr';
import { readExifOrientation } from './helpers/exif-orientation';
import { skipUnless } from './helpers/strict-skip';

/**
 * Regression for the colour shift of 16-bit RGB sources (the decoded RAW intermediate is a 16-bit TIFF):
 * the encoded 8-bit output must hold each sample's high byte, not a colour-managed re-rendering.
 *
 * Oracles: the expected values come from the sample table below (a separately authored 16-bit TIFF
 * writer feeds the converter), and the output pixels are decoded with ImageMagick, not with sharp.
 */

const BLOCK = 8;
const GRID = 4;
const SIDE = BLOCK * GRID;
const BYTE_SHIFT = 8;
const CHANNELS = 3;
const PNG_TOLERANCE = 1;
/** 4:2:0 chroma subsampling and quantisation move flat colours by a few levels. */
const JPEG_TOLERANCE = 4;

/** One flat 16-bit colour per block; spans black, white, saturated primaries, mid-tones and a skin-like tone. */
const BLOCK_COLOURS: ReadonlyArray<readonly [number, number, number]> = [
  [0, 0, 0],
  [65535, 65535, 65535],
  [40000, 20000, 10000],
  [65535, 0, 0],
  [0, 65535, 0],
  [0, 0, 65535],
  [32768, 32768, 32768],
  [51200, 38400, 29440],
  [12800, 25600, 51200],
  [60000, 45000, 5000],
  [256, 512, 768],
  [65280, 65024, 64768],
  [20000, 40000, 60000],
  [8192, 49152, 24576],
  [57344, 4096, 36864],
  [30000, 30000, 30000],
];

function blockColour(x: number, y: number): readonly [number, number, number] {
  return BLOCK_COLOURS[Math.floor(y / BLOCK) * GRID + Math.floor(x / BLOCK)];
}

/** Minimal baseline TIFF writer: little-endian, one uncompressed strip, 16-bit RGB, no profile. */
function writeTiff16(
  width: number,
  height: number,
  sampleAt: (x: number, y: number) => readonly [number, number, number],
  orientation?: number
): Buffer {
  const entryCount = orientation === undefined ? 9 : 10;
  const ifdBytes = 2 + entryCount * 12 + 4;
  const bitsOffset = 8 + ifdBytes;
  const dataOffset = bitsOffset + 6;
  const dataBytes = width * height * CHANNELS * 2;
  const entries: Array<[number, number, number, number]> = [
    [256, 3, 1, width],
    [257, 3, 1, height],
    [258, 3, 3, bitsOffset],
    [259, 3, 1, 1],
    [262, 3, 1, 2],
    [273, 4, 1, dataOffset],
  ];
  if (orientation !== undefined) entries.push([274, 3, 1, orientation]);
  entries.push([277, 3, 1, CHANNELS], [278, 3, 1, height], [279, 4, 1, dataBytes]);
  const out = Buffer.alloc(dataOffset + dataBytes);
  out.write('II', 0, 'latin1');
  out.writeUInt16LE(42, 2);
  out.writeUInt32LE(8, 4);
  out.writeUInt16LE(entryCount, 8);
  entries.forEach(([tag, type, count, value], index) => {
    const at = 10 + index * 12;
    out.writeUInt16LE(tag, at);
    out.writeUInt16LE(type, at + 2);
    out.writeUInt32LE(count, at + 4);
    if (type === 3 && count === 1) out.writeUInt16LE(value, at + 8);
    else out.writeUInt32LE(value, at + 8);
  });
  [16, 16, 16].forEach((bits, index) => out.writeUInt16LE(bits, bitsOffset + index * 2));
  let at = dataOffset;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      for (const sample of sampleAt(x, y)) {
        out.writeUInt16LE(sample, at);
        at += 2;
      }
    }
  }
  return out;
}

function imageMagickBinary(): string | null {
  for (const candidate of ['magick', 'convert']) {
    const probe = spawnSync(candidate, ['-version'], { encoding: 'utf-8' });
    if (probe.status === 0 && /ImageMagick/.test(probe.stdout)) return candidate;
  }
  return null;
}

const MAGICK = imageMagickBinary();
const SKIP_WITHOUT_MAGICK_BINARY = skipUnless('ImageMagick', MAGICK !== null);

/** Decodes an encoded image to 8-bit RGB samples with ImageMagick. */
function decodeRgb8(encoded: Buffer, extension: string): Buffer {
  const args = [`${extension}:-`, '-depth', '8', 'rgb:-'];
  return execFileSync(MAGICK as string, MAGICK === 'magick' ? ['convert', ...args] : args, {
    input: encoded,
    maxBuffer: SIDE * SIDE * CHANNELS * 4,
  });
}

/** `halfTurn` expects the stored grid rotated by 180 degrees, as EXIF orientation 3 displays it. */
function expectBlocksMatch(rgb: Buffer, tolerance: number, halfTurn = false): void {
  expect(rgb.length).toBe(SIDE * SIDE * CHANNELS);
  for (let blockY = 0; blockY < GRID; blockY += 1) {
    for (let blockX = 0; blockX < GRID; blockX += 1) {
      const centreX = blockX * BLOCK + BLOCK / 2;
      const centreY = blockY * BLOCK + BLOCK / 2;
      const expected = (halfTurn ? blockColour(SIDE - 1 - centreX, SIDE - 1 - centreY) : blockColour(centreX, centreY)).map(
        (sample) => sample >> BYTE_SHIFT
      );
      const at = (centreY * SIDE + centreX) * CHANNELS;
      const actual = [rgb[at], rgb[at + 1], rgb[at + 2]];
      actual.forEach((value, channel) => {
        expect(
          Math.abs(value - expected[channel]),
          `block (${blockX},${blockY}) channel ${channel}: got ${value}, expected ${expected[channel]}`
        ).toBeLessThanOrEqual(tolerance);
      });
    }
  }
}

const sources: ReadonlyArray<readonly [string, () => Buffer]> = [
  ['an independently written 16-bit TIFF', () => writeTiff16(SIDE, SIDE, blockColour)],
  [
    'the RAW decoders intermediate TIFF',
    () => {
      const samples = new Uint16Array(SIDE * SIDE * CHANNELS);
      for (let y = 0; y < SIDE; y += 1) {
        for (let x = 0; x < SIDE; x += 1) samples.set(blockColour(x, y), (y * SIDE + x) * CHANNELS);
      }
      return encode16BitTiff(SIDE, SIDE, samples);
    },
  ],
];

describe.each(sources)('convertImage of 16-bit RGB from %s', (_label, build) => {
  it('is read as 16-bit RGB without a profile', async () => {
    const meta = await sharp(build()).metadata();
    expect(meta.depth).toBe('ushort');
    expect(meta.channels).toBe(CHANNELS);
    expect(meta.hasProfile).toBe(false);
  });

  it.skipIf(SKIP_WITHOUT_MAGICK_BINARY)('keeps the high byte of every sample in PNG output', async () => {
    const result = await convertImage(build(), 'png', {}, 'sample.tiff', 'tiff');
    expect(result.buffer.subarray(1, 4).toString('latin1')).toBe('PNG');
    expectBlocksMatch(decodeRgb8(result.buffer, 'png'), PNG_TOLERANCE);
  });

  it.skipIf(SKIP_WITHOUT_MAGICK_BINARY)('keeps the high byte of every sample in JPEG output', async () => {
    const result = await convertImage(build(), 'jpg', { quality: 100 }, 'sample.tiff', 'tiff');
    expect(result.buffer.readUInt16BE(0)).toBe(0xffd8);
    expectBlocksMatch(decodeRgb8(result.buffer, 'jpg'), JPEG_TOLERANCE);
  });

  it.skipIf(SKIP_WITHOUT_MAGICK_BINARY)('keeps the high byte of every sample with metadata stripped', async () => {
    const result = await convertImage(build(), 'png', { stripMetadata: true }, 'sample.tiff', 'tiff');
    expectBlocksMatch(decodeRgb8(result.buffer, 'png'), PNG_TOLERANCE);
  });
});

describe('convertImage of 16-bit RGB with an EXIF orientation', () => {
  it.skipIf(SKIP_WITHOUT_MAGICK_BINARY)('applies the orientation to the pixels and leaves no stale tag, keeping the stored colours', async () => {
    const rotatedHalfTurn = 3;
    const source = writeTiff16(SIDE, SIDE, blockColour, rotatedHalfTurn);
    expect((await sharp(source).metadata()).orientation).toBe(rotatedHalfTurn);
    expect(readExifOrientation(source)).toBe(rotatedHalfTurn);
    const result = await convertImage(source, 'png', {}, 'sample.tiff', 'tiff');
    // The pixels are rotated by the half turn the tag asked for, so the tag must not ask for it again.
    expect([undefined, 1]).toContain(readExifOrientation(result.buffer));
    expectBlocksMatch(decodeRgb8(result.buffer, 'png'), PNG_TOLERANCE, true);
  });
});

describe('convertImage of 8-bit RGB (control)', () => {
  it.skipIf(SKIP_WITHOUT_MAGICK_BINARY)('keeps every sample of an 8-bit PNG exactly', async () => {
    const rgb8 = Buffer.alloc(SIDE * SIDE * CHANNELS);
    for (let y = 0; y < SIDE; y += 1) {
      for (let x = 0; x < SIDE; x += 1) {
        blockColour(x, y).forEach((sample, channel) => {
          rgb8[(y * SIDE + x) * CHANNELS + channel] = sample >> BYTE_SHIFT;
        });
      }
    }
    const source = await sharp(rgb8, { raw: { width: SIDE, height: SIDE, channels: CHANNELS } }).png().toBuffer();
    const result = await convertImage(source, 'png', {}, 'sample.png', 'png');
    expect(new Uint8Array(decodeRgb8(result.buffer, 'png'))).toEqual(new Uint8Array(rgb8));
  });
});
