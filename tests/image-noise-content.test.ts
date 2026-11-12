import sharp, { type Sharp } from 'sharp';
import { describe, expect, it } from 'vitest';
import { convertImage } from '../src/lib/conversions/image';
import { greenRasterOf, isNoiseDominated, NOISE_DOMINATED_RATIO, NOISE_MIN_DIFFERENCE, readNoise, type Raster } from '../src/lib/conversions/image-content';
import { jpegOptionsFor, jpegTableDependsOnNoise } from '../src/lib/conversions/image-encoder-defaults';

/**
 * The noise reading that picks the JPEG quantisation table of a photograph (entry 266). The pictures are built here from a hash and a
 * ramp, so no expectation depends on the code under test. White noise reads 1, a ramp reads near 0, a photograph in between.
 */

const MIX_MULTIPLIER = 0x45d9f3b;
const SIDE = 192;
const RGB = 3;

/** A byte from the position and the band: uniform over 0..255 and uncorrelated between neighbours (a multiplicative hash alone steps by a constant). */
function hashByte(at: number): number {
  let h = at + 1;
  h = Math.imul(h ^ (h >>> 16), MIX_MULTIPLIER);
  h = Math.imul(h ^ (h >>> 16), MIX_MULTIPLIER);
  return (h ^ (h >>> 16)) & 0xff;
}

function rasterOf(channels: number, make: (x: number, y: number, band: number) => number, side = SIDE, wide = false): Raster {
  const samples = wide ? new Uint16Array(side * side * channels) : new Uint8Array(side * side * channels);
  for (let y = 0; y < side; y += 1) {
    for (let x = 0; x < side; x += 1) {
      for (let band = 0; band < channels; band += 1) samples[(y * side + x) * channels + band] = make(x, y, band);
    }
  }
  return { samples, width: side, height: side, channels };
}

const whiteNoise = (x: number, y: number, band: number): number => hashByte((y * SIDE + x) * RGB + band);
const ramp = (x: number, y: number): number => Math.min(255, Math.floor(x / 1.5) + Math.floor(y / 4));
/** Soft structure at the scale of a block (amplitude 90 levels, a period of about 30 pixels) with a grain of +-2 levels: a clean photograph. */
const grainyTexture = (x: number, y: number, band: number): number =>
  Math.round(128 + 90 * Math.sin(x / 5) * Math.cos(y / 6.5)) + (hashByte((y * SIDE + x) * RGB + band) >> 6) - 2;

const ratioOf = (raster: Raster): number => readNoise(raster).ratio;
/** White noise of +-`amplitude` levels around 128. */
const faintNoise = (amplitude: number) => (x: number, y: number, band: number): number => 128 + Math.round(((hashByte((y * SIDE + x) * RGB + band) - 127.5) / 127.5) * amplitude);

describe('readNoise', () => {
  it('reads white noise as 1 and a ramp as under 0.1', () => {
    expect(ratioOf(rasterOf(RGB, whiteNoise))).toBeGreaterThan(0.9);
    expect(ratioOf(rasterOf(RGB, whiteNoise))).toBeLessThan(1.1);
    expect(ratioOf(rasterOf(RGB, (x, y) => ramp(x, y)))).toBeLessThan(0.1);
  });

  it('reads a flat picture as 0 (no variation to divide)', () => {
    expect(readNoise(rasterOf(RGB, () => 77))).toEqual({ ratio: 0, difference: 0 });
  });

  it('reads the size of the differences as the root mean square of neighbour differences in levels: 2 * sigma for white noise, ~104 for uniform 0..255', () => {
    expect(readNoise(rasterOf(RGB, whiteNoise)).difference).toBeGreaterThan(95);
    expect(readNoise(rasterOf(RGB, whiteNoise)).difference).toBeLessThan(115);
    expect(readNoise(rasterOf(RGB, (x, y) => ramp(x, y))).difference).toBeLessThan(2);
  });

  it('puts a soft texture with a photograph\'s grain below the limit and white noise above it', () => {
    expect(ratioOf(rasterOf(RGB, grainyTexture))).toBeLessThan(NOISE_DOMINATED_RATIO);
    expect(isNoiseDominated(rasterOf(RGB, whiteNoise))).toBe(true);
    expect(isNoiseDominated(rasterOf(RGB, grainyTexture))).toBe(false);
  });

  it('does not call noise dominated that the quantisers drop anyway: white noise of +-3 levels reads 1 but its differences are under the limit', () => {
    const faint = readNoise(rasterOf(RGB, faintNoise(3)));
    expect(faint.ratio).toBeGreaterThan(0.9);
    expect(faint.difference).toBeLessThan(NOISE_MIN_DIFFERENCE);
    expect(isNoiseDominated(rasterOf(RGB, faintNoise(3)))).toBe(false);
    expect(isNoiseDominated(rasterOf(RGB, faintNoise(40)))).toBe(true);
  });

  it('reads nothing from a picture of under 16 blocks, however noisy it is', () => {
    expect(ratioOf(rasterOf(RGB, whiteNoise, 24))).toBe(0);
    expect(ratioOf(rasterOf(RGB, whiteNoise, 32))).toBeGreaterThan(0.9);
  });

  it('reads the green band of a colour picture and the only band of a grey one, whatever follows', () => {
    const green = (x: number, y: number): number => hashByte(y * SIDE + x);
    const colour = readNoise(rasterOf(RGB, (x, y, band) => (band === 1 ? green(x, y) : 100)));
    const grey = readNoise(rasterOf(1, (x, y) => green(x, y)));
    const greyAlpha = readNoise(rasterOf(2, (x, y, band) => (band === 0 ? green(x, y) : 255)));
    const rgba = readNoise(rasterOf(4, (x, y, band) => (band === 1 ? green(x, y) : band === 3 ? 255 : 100)));
    expect(colour.ratio).toBeGreaterThan(0.9);
    expect([grey, greyAlpha, rgba]).toEqual([colour, colour, colour]);
  });

  it('reads the high byte of 16-bit samples: the same picture at 8 and at 16 bits reads alike, and noise in the low byte is not noise', () => {
    const eightBit = readNoise(rasterOf(RGB, whiteNoise));
    expect(readNoise(rasterOf(RGB, (x, y, band) => whiteNoise(x, y, band) * 257, SIDE, true))).toEqual(eightBit);
    const lowByteNoise = rasterOf(RGB, (x, y, band) => ramp(x, y) * 256 + (hashByte((y * SIDE + x) * RGB + band) & 0xff), SIDE, true);
    expect(ratioOf(lowByteNoise)).toBeLessThan(0.1);
  });

  it('visits a regular grid of at most 256 blocks, so a large picture costs what a small one does', () => {
    const side = 2048;
    const big = rasterOf(RGB, (x, y, band) => hashByte((y * side + x) * RGB + band), side);
    const started = performance.now();
    for (let run = 0; run < 20; run += 1) readNoise(big);
    const perRun = (performance.now() - started) / 20;
    expect(ratioOf(big)).toBeGreaterThan(0.9);
    expect(perRun).toBeLessThan(5);
  });
});

describe('greenRasterOf', () => {
  it('is the green band of a colour picture in 8 bits, the grey band of a grey one, and nothing of the alpha plane', async () => {
    const colour = rasterOf(4, (x, y, band) => (band === 3 ? 200 : hashByte((y * SIDE + x) * 4 + band)));
    const picture = sharp(colour.samples, { raw: { width: SIDE, height: SIDE, channels: 4 } });
    const green = await greenRasterOf(picture);
    expect([green.width, green.height, green.channels, green.samples.length]).toEqual([SIDE, SIDE, 1, SIDE * SIDE]);
    expect(Buffer.from(green.samples).equals(Buffer.from(colour.samples.filter((_, at) => at % 4 === 1)))).toBe(true);
    const grey = rasterOf(1, (x, y) => hashByte(y * SIDE + x));
    const greyRaster = await greenRasterOf(sharp(grey.samples, { raw: { width: SIDE, height: SIDE, channels: 1 } }));
    expect(Buffer.from(greyRaster.samples).equals(Buffer.from(grey.samples))).toBe(true);
  });
});

describe('the JPEG table of a noise-dominated photograph', () => {
  /** The DQT segments of a JPEG, as one hex string: the quantisation tables the encoder wrote. */
  function quantisationTables(jpeg: Buffer): string {
    const tables: string[] = [];
    for (let at = 2; at + 4 <= jpeg.length && jpeg[at] === 0xff && jpeg[at + 1] !== 0xda; ) {
      const length = jpeg.readUInt16BE(at + 2);
      if (jpeg[at + 1] === 0xdb) tables.push(jpeg.subarray(at + 4, at + 2 + length).toString('hex'));
      at += 2 + length;
    }
    return tables.join('|');
  }

  const png = async (make: (x: number, y: number, band: number) => number, wide = false): Promise<Buffer> => {
    const raster = rasterOf(RGB, make, SIDE, wide);
    return sharp(raster.samples, { raw: { width: SIDE, height: SIDE, channels: RGB } }).toColourspace(wide ? 'rgb16' : 'srgb').png().toBuffer();
  };
  const tablesOf = async (picture: Buffer, table: number, quality: number): Promise<string> =>
    quantisationTables(await sharp(picture).jpeg({ quality, quantisationTable: table, chromaSubsampling: quality >= 90 ? '4:4:4' : '4:2:0' }).toBuffer());
  const convertedTables = async (picture: Buffer, options: { quality: number; width?: number }): Promise<string> =>
    quantisationTables((await convertImage(picture, 'jpg', options, 'picture.png', 'png')).buffer);

  it('is table 2 below the full-chroma quality, table 0 from it, and table 3 for a picture that is not noise-dominated', async () => {
    const noisy = await png(whiteNoise);
    expect(await convertedTables(noisy, { quality: 70 })).toBe(await tablesOf(noisy, 2, 70));
    expect(await convertedTables(noisy, { quality: 92 })).toBe(await tablesOf(noisy, 0, 92));
    const grainy = await png(grainyTexture);
    expect(await convertedTables(grainy, { quality: 70 })).toBe(await tablesOf(grainy, 3, 70));
    expect(await tablesOf(noisy, 2, 70)).not.toBe(await tablesOf(noisy, 3, 70));
  });

  it('reads a PNG that is not decoded to memory the same way: a profile that does something and an EXIF block send the picture down the encoder route, and its table is the same', async () => {
    const noisy = await png(whiteNoise);
    const smooth = await png(grainyTexture);
    for (const decorate of [(image: Sharp) => image.withIccProfile('p3'), (image: Sharp) => image.withExif({ IFD0: { Copyright: 'table test' } })]) {
      const noisyWithBlock = await decorate(sharp(noisy)).png().toBuffer();
      const smoothWithBlock = await decorate(sharp(smooth)).png().toBuffer();
      expect(await convertedTables(noisyWithBlock, { quality: 70 })).toBe(await tablesOf(noisy, 2, 70));
      expect(await convertedTables(smoothWithBlock, { quality: 70 })).toBe(await tablesOf(smooth, 3, 70));
    }
  });

  it('does not read a source that is not a PNG: a JPEG of the noisy picture keeps table 3', async () => {
    const noisy = await png(whiteNoise);
    const jpeg = await sharp(noisy).jpeg({ quality: 95, chromaSubsampling: '4:4:4' }).toBuffer();
    const converted = quantisationTables((await convertImage(jpeg, 'jpg', { quality: 70 }, 'picture.jpg', 'jpg')).buffer);
    expect(converted).toBe(await tablesOf(jpeg, 3, 70));
  });

  it('reads a 16-bit picture at its high byte', async () => {
    const noisy = await png((x, y, band) => whiteNoise(x, y, band) * 257, true);
    expect(await convertedTables(noisy, { quality: 70 })).toBe(await tablesOf(noisy, 2, 70));
  });

  it('keeps table 3 when the request resizes the picture, as the noise it read is averaged away', async () => {
    const noisy = await png(whiteNoise);
    expect(await convertedTables(noisy, { quality: 70, width: 96 })).toBe(await tablesOf(await sharp(noisy).resize(96).png().toBuffer(), 3, 70));
  });
});

describe('jpegTableDependsOnNoise and jpegOptionsFor', () => {
  it('asks for the reading only of a photograph below the full-chroma quality, the default quality included', () => {
    expect(jpegTableDependsOnNoise(undefined, 'photo')).toBe(true);
    expect([89, 90, 100].map((quality) => jpegTableDependsOnNoise(quality, 'photo'))).toEqual([true, false, false]);
    expect([40, 92].map((quality) => jpegTableDependsOnNoise(quality, 'graphic'))).toEqual([false, false]);
  });

  it('takes table 2 for a noisy photograph below 90 and table 0 from 90, and leaves graphics at table 2 whatever the reading', () => {
    expect([40, 85, 89].map((quality) => jpegOptionsFor(quality, 'photo', false, true).quantisationTable)).toEqual([2, 2, 2]);
    expect([90, 96].map((quality) => jpegOptionsFor(quality, 'photo', false, true).quantisationTable)).toEqual([0, 0]);
    expect(jpegOptionsFor(70, 'photo', false, false).quantisationTable).toBe(3);
    expect([70, 92].map((quality) => jpegOptionsFor(quality, 'graphic', false, true).quantisationTable)).toEqual([2, 2]);
    expect(jpegOptionsFor(70, 'photo', true, true)).toMatchObject({ progressive: true, quantisationTable: 2 });
  });
});
