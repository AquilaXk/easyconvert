import { describe, expect, it } from 'vitest';
import { dispatchConversion } from '../src/lib/conversions/dispatch';
import { MAX_INPUT_PIXELS_ENV } from '../src/lib/conversions/image-input-limit-config';
import { findMagick, MAGICK_PATH_ENV } from '../src/lib/conversions/image-magick-cli';
import { encodePsd } from '../src/lib/conversions/psd-writer';
import { buildDdsArgb, buildDdsDxt1, buildPcx, buildPnm, buildRleTga, buildTga, dxt1Palette, type RgbaPixel } from './helpers/image-format-builders';
import { decodeRgba, maxSampleDifference, rgbaBytes, sixteenBitSamples } from './helpers/image-pixels';
import { requireRealworldSample } from './helpers/realworld-sample';
import { skipUnless } from './helpers/strict-skip';

/**
 * Pictures in formats the image library has no loader for (PSD, XCF, TGA, PCX, DDS, PNM) convert through ImageMagick's coders
 * (#783: every one was refused with "header could not be decoded"). The small files are written in this test from the format
 * documents with pixel values the test knows, so the decode is judged against those values and not against another decoder;
 * the real files of the corpus are judged by the facts their headers state.
 */

const needsMagick = skipUnless('ImageMagick (magick or convert)', findMagick() !== null);

const RED: RgbaPixel = { r: 255, g: 0, b: 0, a: 255 };
const GREEN: RgbaPixel = { r: 0, g: 255, b: 0, a: 255 };
const BLUE: RgbaPixel = { r: 0, g: 0, b: 255, a: 255 };
const YELLOW: RgbaPixel = { r: 255, g: 255, b: 0, a: 255 };
const FOUR_COLOURS = [RED, GREEN, BLUE, YELLOW];
const TRANSLUCENT_BLUE: RgbaPixel = { r: 0, g: 0, b: 255, a: 128 };

async function toPng(bytes: Buffer, format: string): Promise<Buffer> {
  return (await dispatchConversion(bytes, format, 'png', {}, `picture.${format}`)).buffer;
}

describe.skipIf(needsMagick)('legacy raster formats with known pixels', () => {
  it('decodes an uncompressed 24-bit TGA', async () => {
    const decoded = await decodeRgba(await toPng(buildTga(2, 2, FOUR_COLOURS, false), 'tga'));
    expect([decoded.width, decoded.height]).toEqual([2, 2]);
    expect(decoded.data).toEqual(rgbaBytes(FOUR_COLOURS));
  });

  it('decodes a 32-bit TGA with its alpha channel', async () => {
    const pixels = [RED, TRANSLUCENT_BLUE];
    const decoded = await decodeRgba(await toPng(buildTga(2, 1, pixels, true), 'tga'));
    expect(decoded.data).toEqual(rgbaBytes(pixels));
  });

  it('decodes a run-length TGA', async () => {
    const decoded = await decodeRgba(await toPng(buildRleTga(3, [GREEN, BLUE]), 'tga'));
    expect([decoded.width, decoded.height]).toEqual([3, 2]);
    expect(decoded.data).toEqual(rgbaBytes([GREEN, GREEN, GREEN, BLUE, BLUE, BLUE]));
  });

  it('decodes an 8-bit run-length PCX with a 256-colour palette', async () => {
    const palette = [RED, GREEN, BLUE, YELLOW];
    const indices = [0, 0, 0, 1, 2, 3, 3, 3, 3];
    const decoded = await decodeRgba(await toPng(buildPcx(3, 3, indices, palette), 'pcx'));
    expect([decoded.width, decoded.height]).toEqual([3, 3]);
    expect(decoded.data).toEqual(rgbaBytes(indices.map((index) => palette[index])));
  });

  it.each([
    ['P6 raw colour', 'ppm', 'P6' as const],
    ['P3 plain colour', 'ppm', 'P3' as const],
    ['P6 under the .pnm name', 'pnm', 'P6' as const],
  ])('decodes a %s file', async (_label, format, kind) => {
    const samples = FOUR_COLOURS.flatMap((p) => [p.r, p.g, p.b]);
    const decoded = await decodeRgba(await toPng(buildPnm(kind, 2, 2, 255, samples), format));
    expect(decoded.data).toEqual(rgbaBytes(FOUR_COLOURS));
  });

  it.each([
    ['P5 raw', 'P5' as const],
    ['P2 plain', 'P2' as const],
  ])('decodes a %s grey map with a maximum value below 255', async (_label, kind) => {
    const decoded = await decodeRgba(await toPng(buildPnm(kind, 4, 1, 15, [0, 5, 10, 15]), 'pgm'));
    const levels = [0, 85, 170, 255];
    expect(decoded.data).toEqual(rgbaBytes(levels.map((v) => ({ r: v, g: v, b: v, a: 255 }))));
  });

  it('keeps all 16 bits of a 16-bit grey map', async () => {
    const samples = [0, 257, 40000, 65535];
    expect(await sixteenBitSamples(await toPng(buildPnm('P5', 4, 1, 65535, samples), 'pgm'), 'grey16')).toEqual(samples);
  });

  it.each([
    ['P1 plain', 'P1' as const],
    ['P4 raw', 'P4' as const],
  ])('decodes a %s bitmap with 1 as black', async (_label, kind) => {
    const bits = [1, 0, 0, 1, 1, 1, 0, 0, 1, 0];
    const decoded = await decodeRgba(await toPng(buildPnm(kind, 5, 2, 1, bits), 'pbm'));
    expect([decoded.width, decoded.height]).toEqual([5, 2]);
    expect(decoded.data).toEqual(rgbaBytes(bits.map((bit) => ({ r: bit ? 0 : 255, g: bit ? 0 : 255, b: bit ? 0 : 255, a: 255 }))));
  });

  it('decodes the merged image of a PSD written by the project writer, 8 and 16 bits', async () => {
    const rgb8 = Uint8Array.from(FOUR_COLOURS.flatMap((p) => [p.r, p.g, p.b]));
    const eight = await decodeRgba(await toPng(encodePsd({ width: 2, height: 2, channels: 3, depth: 8, samples: rgb8 }), 'psd'));
    expect(eight.data).toEqual(rgbaBytes(FOUR_COLOURS));

    const deep = new Uint16Array([0, 257, 40000, 65535, 1000, 30000]);
    const sixteen = encodePsd({ width: 2, height: 1, channels: 3, depth: 16, samples: new Uint8Array(deep.buffer) });
    expect(await sixteenBitSamples(await toPng(sixteen, 'psd'), 'rgb16')).toEqual(Array.from(deep));
  });

  it('decodes an uncompressed A8R8G8B8 DDS surface', async () => {
    const pixels = [RED, GREEN, BLUE, TRANSLUCENT_BLUE];
    const decoded = await decodeRgba(await toPng(buildDdsArgb(2, 2, pixels), 'dds'));
    expect(decoded.data).toEqual(rgbaBytes(pixels));
  });

  it('decodes a DXT1 block to the colours the format defines', async () => {
    const color0 = 0xf800;
    const color1 = 0x001f;
    const indices = [0, 1, 2, 3, 3, 2, 1, 0, 0, 0, 1, 1, 2, 2, 3, 3];
    const palette = dxt1Palette(color0, color1);
    const decoded = await decodeRgba(await toPng(buildDdsDxt1(color0, color1, indices), 'dds'));
    expect(maxSampleDifference(decoded, { width: 4, height: 4, data: rgbaBytes(indices.map((index) => palette[index])) })).toBeLessThanOrEqual(1);
  });
});

describe.skipIf(needsMagick)('real files', () => {
  it.for([
    ['cc-logo.xcf', 'xcf', 'png'],
    ['cc-logo-large.xcf', 'xcf', 'jpg'],
    ['wc-orfeologoa1.xcf', 'xcf', 'png'],
  ] as const)('flattens the layers of %s to the canvas the header states', async ([id, format, target], ctx) => {
    const sample = await requireRealworldSample(ctx, id);
    // GIMP XCF: "gimp xcf " + version, then width and height as big-endian 32-bit values (XCF specification, file header).
    const canvas = { width: sample.bytes.readUInt32BE(14), height: sample.bytes.readUInt32BE(18) };
    const result = await dispatchConversion(sample.bytes, format, target, {}, id);
    const decoded = await decodeRgba(result.buffer);
    expect({ width: decoded.width, height: decoded.height }).toEqual(canvas);
    const distinct = new Set(Array.from({ length: decoded.width * decoded.height }, (_, i) => decoded.data.readUInt32LE(i * 4)));
    expect(distinct.size).toBeGreaterThan(1);
  });

  // The sizes are the ones the header of each file states (the PSD and TGA headers, the PCX window, the Netpbm header line).
  it.for([
    ['tika-testpsd.psd', 'psd', 537, 51],
    ['pil-hopper.psd', 'psd', 128, 128],
    ['vips-targa.tga', 'tga', 433, 433],
    ['pil-rgb32rle.tga', 'tga', 199, 199],
    ['tika-testpcx.pcx', 'pcx', 100, 75],
    ['pil-hopper.ppm', 'ppm', 128, 128],
    ['pil-hopper_16bit_plain.pgm', 'pgm', 128, 128],
    ['lo-rhbz160429-1.pbm', 'pbm', 3561, 1],
  ] as const)('converts %s to JPEG and PNG of the size its header states', async ([id, format, width, height], ctx) => {
    const sample = await requireRealworldSample(ctx, id);
    for (const target of ['jpg', 'png']) {
      const result = await dispatchConversion(sample.bytes, format, target, {}, id);
      const decoded = await decodeRgba(result.buffer);
      expect([decoded.width, decoded.height]).toEqual([width, height]);
    }
  });
});

describe.skipIf(needsMagick)('files that cannot be decoded', () => {
  it('refuses a PCX that ends before its pixels do instead of answering with the part that was read', async () => {
    const whole = buildPcx(8, 8, Array.from({ length: 64 }, (_, i) => i % 4), [RED, GREEN, BLUE, YELLOW]);
    const cut = whole.subarray(0, 128 + 10);
    await expect(toPng(cut, 'pcx')).rejects.toMatchObject({ name: 'ConversionFailedError', message: 'Invalid image: the PCX picture could not be decoded' });
  });

  it('refuses bytes that are not the declared format', async () => {
    await expect(toPng(Buffer.from('this is not a picture at all'), 'tga')).rejects.toMatchObject({ name: 'ConversionFailedError', message: 'Invalid image: the TGA picture could not be decoded' });
    await expect(toPng(Buffer.from('P6\n2 2\n255\nabc'), 'ppm')).rejects.toMatchObject({ name: 'ConversionFailedError', message: 'Invalid image: the PPM picture could not be decoded' });
  });

  it('refuses a tiny file that declares a picture over the input limit before decoding it', async () => {
    const huge = Buffer.from('P5\n20000 20000\n255\n');
    await expect(toPng(huge, 'pgm')).rejects.toMatchObject({ name: 'InputPixelLimitError', status: 413, width: 20000, height: 20000 });
  });

  it('refuses an XCF whose header does not state a canvas', async () => {
    const header = (magic: string, terminator: number, width: number, height: number): Buffer => {
      const bytes = Buffer.alloc(24);
      bytes.write(magic, 0, 'latin1');
      bytes.write('v011', 9, 'latin1');
      bytes[13] = terminator;
      bytes.writeUInt32BE(width, 14);
      bytes.writeUInt32BE(height, 18);
      return bytes;
    };
    const refusal = { name: 'ConversionFailedError', message: 'Invalid image: the XCF header could not be decoded' };
    await expect(toPng(Buffer.from('gimp xcf'), 'xcf')).rejects.toMatchObject(refusal);
    await expect(toPng(header('gimp xcg ', 0, 10, 10), 'xcf')).rejects.toMatchObject(refusal);
    await expect(toPng(header('gimp xcf ', 1, 10, 10), 'xcf')).rejects.toMatchObject(refusal);
    await expect(toPng(header('gimp xcf ', 0, 0, 10), 'xcf')).rejects.toMatchObject(refusal);
    await expect(toPng(header('gimp xcf ', 0, 10, 0), 'xcf')).rejects.toMatchObject(refusal);
  });

  it('holds the layers of a GIMP project and the canvas they are drawn on to the input limit together', async (ctx) => {
    // wc-orfeologoa1.xcf: a 503 x 172 canvas (86,516 pixels), a layer of the same size and a layer of 116 x 81 (9,396 pixels).
    const sample = await requireRealworldSample(ctx, 'wc-orfeologoa1.xcf');
    const saved = process.env[MAX_INPUT_PIXELS_ENV];
    try {
      process.env[MAX_INPUT_PIXELS_ENV] = '150000';
      await expect(dispatchConversion(sample.bytes, 'xcf', 'png', {}, 'logo.xcf')).rejects.toMatchObject({ name: 'InputPixelLimitError', status: 413, limit: 150000 });
      process.env[MAX_INPUT_PIXELS_ENV] = '200000';
      const decoded = await decodeRgba((await dispatchConversion(sample.bytes, 'xcf', 'png', {}, 'logo.xcf')).buffer);
      expect([decoded.width, decoded.height]).toEqual([503, 172]);
    } finally {
      if (saved === undefined) delete process.env[MAX_INPUT_PIXELS_ENV];
      else process.env[MAX_INPUT_PIXELS_ENV] = saved;
    }
  });

  it('names the missing engine when ImageMagick is not installed', async () => {
    const saved = process.env[MAGICK_PATH_ENV];
    process.env[MAGICK_PATH_ENV] = '/nonexistent/magick';
    try {
      await expect(toPng(buildTga(1, 1, [RED], false), 'tga')).rejects.toMatchObject({ name: 'EngineUnavailableError', engineName: 'magick' });
    } finally {
      if (saved === undefined) delete process.env[MAGICK_PATH_ENV];
      else process.env[MAGICK_PATH_ENV] = saved;
    }
  });
});
