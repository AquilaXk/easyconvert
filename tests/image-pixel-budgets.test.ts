import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { convertImage } from '../src/lib/conversions/image';
import {
  HDR_FLOAT_PIXEL_BUDGET,
  InputPixelLimitError,
  QUANTIZER_PIXEL_BUDGET,
  RAW_SENSOR_PIXEL_BUDGET,
  assertPixelBudget,
  resizedDimensions,
} from '../src/lib/conversions/image-input-limits';
import { bombTiff } from './helpers/image-bombs';
import { buildUltraHdrJpeg } from './helpers/ultrahdr-builder';

const BYTES_PER_MIB = 1024 * 1024;
const HTTP_PAYLOAD_TOO_LARGE = 413;

/** Written out from the measurements in the issue thread, not read back from the module under test. */
const EXPECTED_QUANTIZER_LIMIT = 16_000_000;
const EXPECTED_SENSOR_LIMIT = 64_000_000;

/** 5000 x 5000 = 25 megapixels: over the quantizer budget, well under the 100 MP input limit. */
const QUANTIZER_BOMB_SIDE = 5_000;
/** Largest sensor side that fits the budget (8000 x 8000 = 64 MP) and the first side over it. */
const SENSOR_SIDE_AT_BUDGET = 8_000;
const SENSOR_SIDE_OVER_BUDGET = 8_200;
/** 9000 x 9000 = 81 MP: over the Ultra HDR budget, under the input limit. */
const HDR_SIDE_OVER_BUDGET = 9_000;
/** 15000 x 15000 = 225 MP: over the input limit itself. */
const HDR_SIDE_OVER_INPUT_LIMIT = 15_000;
const HDR_SOURCE_SIDE = 32;
const QUANTIZER_REJECTION_RSS_BYTES = 400 * BYTES_PER_MIB;
/** Well under the 243 MB RGB raster of an 81 MP picture, so a decode before the refusal would fail the bound. */
const HDR_REJECTION_RSS_BYTES = 150 * BYTES_PER_MIB;
/** 10000 x 10000 = 100 MP: what a 5000 x 5000 picture becomes when scaled to twice its sides. */
const SCALED_UP_SIDE = 10_000;
const SCALED_DOWN_SIDE = 500;
/** OpenEXR file magic number 20000630 (0x762f3101), as written on disk. */
const OPENEXR_MAGIC = [0x76, 0x2f, 0x31, 0x01];

const SOF0_MARKER = Buffer.from([0xff, 0xc0]);
const SOF_HEIGHT_OFFSET = 5;
const SOF_WIDTH_OFFSET = 7;

describe('budgets of the in-process per-pixel paths', () => {
  it('states the measured limits', () => {
    expect(QUANTIZER_PIXEL_BUDGET.maxPixels).toBe(EXPECTED_QUANTIZER_LIMIT);
    expect(RAW_SENSOR_PIXEL_BUDGET.maxPixels).toBe(EXPECTED_SENSOR_LIMIT);
    expect(HDR_FLOAT_PIXEL_BUDGET.maxPixels).toBe(EXPECTED_SENSOR_LIMIT);
  });

  it('accepts exactly the budget and refuses one pixel more, naming the limit and the path', () => {
    expect(() => assertPixelBudget(4_000, 4_000, QUANTIZER_PIXEL_BUDGET)).not.toThrow();
    const run = (): void => assertPixelBudget(4_000, 4_001, QUANTIZER_PIXEL_BUDGET);
    expect(run).toThrow(InputPixelLimitError);
    expect(run).toThrow(`over the limit of ${EXPECTED_QUANTIZER_LIMIT} pixels for Oklab and Riemersma palette quantization`);
  });
});

describe('palette quantizers refuse pictures that would not fit the job memory share', () => {
  const targets: Array<[string, string, Record<string, unknown>]> = [
    ['png', 'Oklab', { quantizer: 'oklab' }],
    ['png', 'Riemersma', { ditherMethod: 'riemersma', colorDepth: 8 }],
    ['gif', 'Oklab', { quantizer: 'oklab' }],
    ['bmp', 'Oklab', { quantizer: 'oklab', colorDepth: 8 }],
  ];

  it.each(targets)('refuses a 25 MP picture for %s output with %s quantization before the per-pixel work', async (target, _label, options) => {
    const source = await sharp({
      create: { width: QUANTIZER_BOMB_SIDE, height: QUANTIZER_BOMB_SIDE, channels: 3, background: { r: 30, g: 120, b: 200 } },
    })
      .png()
      .toBuffer();
    const rssBefore = process.memoryUsage().rss;
    let error: unknown;
    try {
      await convertImage(source, target, options, 'big.png', 'png');
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(InputPixelLimitError);
    expect(error).toMatchObject({
      status: HTTP_PAYLOAD_TOO_LARGE,
      limit: EXPECTED_QUANTIZER_LIMIT,
      width: QUANTIZER_BOMB_SIDE,
      height: QUANTIZER_BOMB_SIDE,
    });
    // The raster is decoded once (100 MB) and never expanded into the Oklab working arrays (2.8 GB).
    expect(process.memoryUsage().rss - rssBefore).toBeLessThan(QUANTIZER_REJECTION_RSS_BYTES);
  });

  it('still quantizes a small picture and writes the requested palette size', async () => {
    const source = await sharp({ create: { width: 48, height: 48, channels: 3, background: { r: 10, g: 200, b: 30 } } }).png().toBuffer();
    const result = await convertImage(source, 'png', { quantizer: 'oklab', colors: 4 }, 'small.png', 'png');
    const { data, info } = await sharp(result.buffer).raw().toBuffer({ resolveWithObject: true });
    expect([info.width, info.height]).toEqual([48, 48]);
    const colours = new Set<string>();
    for (let i = 0; i < data.length; i += info.channels) colours.add(data.subarray(i, i + info.channels).toString('hex'));
    expect(colours.size).toBeLessThanOrEqual(4);
  });
});

describe('camera RAW sensors keep their own, larger budget', () => {
  it('refuses a sensor over 64 MP from the TIFF header, before any strip is read', async () => {
    const dng = bombTiff(SENSOR_SIDE_OVER_BUDGET, SENSOR_SIDE_OVER_BUDGET);
    const run = convertImage(dng, 'png', {}, 'sensor.dng', 'dng');
    await expect(run).rejects.toBeInstanceOf(InputPixelLimitError);
    await expect(run).rejects.toMatchObject({ limit: EXPECTED_SENSOR_LIMIT, width: SENSOR_SIDE_OVER_BUDGET });
  });

  it('lets a 61 MP sensor past the budget gate (it fails later, on its missing pixel data, not as too large)', async () => {
    const dng = bombTiff(SENSOR_SIDE_AT_BUDGET, SENSOR_SIDE_AT_BUDGET);
    const run = convertImage(dng, 'png', {}, 'sensor.dng', 'dng');
    await expect(run).rejects.not.toBeInstanceOf(InputPixelLimitError);
  });
});

async function smallUltraHdr(): Promise<{ file: Buffer }> {
  return buildUltraHdrJpeg({
    width: HDR_SOURCE_SIDE,
    height: HDR_SOURCE_SIDE,
    sdrRgb: Buffer.alloc(HDR_SOURCE_SIDE * HDR_SOURCE_SIDE * 3, 128),
    gainMap: Buffer.alloc(HDR_SOURCE_SIDE * HDR_SOURCE_SIDE, 128),
    metadata: { gainMapMin: 0, gainMapMax: 2, gamma: 1, offsetSdr: 1 / 64, offsetHdr: 1 / 64 },
  });
}

describe('Ultra HDR reconstruction is bounded before the float arrays are built', () => {
  it('refuses a primary image over the budget declared in its header', async () => {
    const built = await smallUltraHdr();
    const file = Buffer.from(built.file);
    const sof = file.indexOf(SOF0_MARKER);
    expect(sof).toBeGreaterThan(0);
    file.writeUInt16BE(HDR_SIDE_OVER_BUDGET, sof + SOF_HEIGHT_OFFSET);
    file.writeUInt16BE(HDR_SIDE_OVER_BUDGET, sof + SOF_WIDTH_OFFSET);

    const run = convertImage(file, 'exr', {}, 'photo.jpg', 'ultrahdr');
    await expect(run).rejects.toBeInstanceOf(InputPixelLimitError);
    await expect(run).rejects.toMatchObject({ status: HTTP_PAYLOAD_TOO_LARGE, limit: EXPECTED_SENSOR_LIMIT, width: HDR_SIDE_OVER_BUDGET });
  });

  it('refuses a primary image over the 100 MP input limit', async () => {
    const built = await smallUltraHdr();
    const file = Buffer.from(built.file);
    const sof = file.indexOf(SOF0_MARKER);
    file.writeUInt16BE(HDR_SIDE_OVER_INPUT_LIMIT, sof + SOF_HEIGHT_OFFSET);
    file.writeUInt16BE(HDR_SIDE_OVER_INPUT_LIMIT, sof + SOF_WIDTH_OFFSET);
    const run = convertImage(file, 'png', {}, 'photo.jpg', 'ultrahdr');
    await expect(run).rejects.toMatchObject({ status: HTTP_PAYLOAD_TOO_LARGE, width: HDR_SIDE_OVER_INPUT_LIMIT, height: HDR_SIDE_OVER_INPUT_LIMIT });
  });

  it('still reconstructs a small Ultra HDR image', async () => {
    const built = await smallUltraHdr();
    const result = await convertImage(built.file, 'png', {}, 'photo.jpg', 'ultrahdr');
    const meta = await sharp(result.buffer).metadata();
    expect([meta.width, meta.height]).toEqual([HDR_SOURCE_SIDE, HDR_SOURCE_SIDE]);
  });
});

describe('EXR and Ultra HDR output hold float arrays, so they share the HDR budget', () => {
  /** 9000 x 9000 = 81 MP: over the 64 MP HDR budget, under the 100 MP input limit. */
  async function solid(format: 'png' | 'jpeg', side: number): Promise<Buffer> {
    const base = sharp({ create: { width: side, height: side, channels: 3, background: { r: 90, g: 140, b: 30 } } });
    return format === 'png' ? base.png().toBuffer() : base.jpeg().toBuffer();
  }

  it.each([
    ['exr', 'png'],
    ['exr', 'jpeg'],
    ['ultrahdr', 'png'],
  ] as const)('refuses an 81 MP %s output from a %s source before the float array is built', async (target, format) => {
    const source = await solid(format, HDR_SIDE_OVER_BUDGET);
    const rssBefore = process.memoryUsage().rss;
    const run = convertImage(source, target, {}, `big.${format}`, format === 'png' ? 'png' : 'jpg');
    await expect(run).rejects.toBeInstanceOf(InputPixelLimitError);
    await expect(run).rejects.toMatchObject({
      status: HTTP_PAYLOAD_TOO_LARGE,
      limit: EXPECTED_SENSOR_LIMIT,
      width: HDR_SIDE_OVER_BUDGET,
      height: HDR_SIDE_OVER_BUDGET,
    });
    // The decision comes from the header: the 243 MB RGB raster of this picture is never decoded either.
    expect(process.memoryUsage().rss - rssBefore).toBeLessThan(HDR_REJECTION_RSS_BYTES);
  });

  it.each(['exr', 'ultrahdr'])('judges %s output by the resize target: a 25 MP picture scaled up to 100 MP is refused undecoded', async (target) => {
    const source = await solid('png', QUANTIZER_BOMB_SIDE);
    const rssBefore = process.memoryUsage().rss;
    const run = convertImage(source, target, { width: SCALED_UP_SIDE, height: SCALED_UP_SIDE, fit: 'fill' }, 'up.png', 'png');
    await expect(run).rejects.toBeInstanceOf(InputPixelLimitError);
    await expect(run).rejects.toMatchObject({ limit: EXPECTED_SENSOR_LIMIT, width: SCALED_UP_SIDE, height: SCALED_UP_SIDE });
    expect(process.memoryUsage().rss - rssBefore).toBeLessThan(HDR_REJECTION_RSS_BYTES);
  });

  it('lets an 81 MP picture through when it is scaled down to a size within the budget', async () => {
    const source = await solid('png', HDR_SIDE_OVER_BUDGET);
    const result = await convertImage(source, 'exr', { width: SCALED_DOWN_SIDE }, 'down.png', 'png');
    expect([...result.buffer.subarray(0, 4)]).toEqual(OPENEXR_MAGIC);
  });

  it('still writes a small EXR, starting with the OpenEXR magic number', async () => {
    const result = await convertImage(await solid('png', HDR_SOURCE_SIDE), 'exr', {}, 'small.png', 'png');
    expect([...result.buffer.subarray(0, 4)]).toEqual(OPENEXR_MAGIC);
  });
});

describe('the size a resize leaves, which the budgets are judged by before decoding', () => {
  // Worked by hand for a 4000 x 2000 picture and a 1000 x 1000 box.
  it.each([
    ['no request', {}, 4000, 2000],
    ['fill', { width: 1000, height: 1000, fit: 'fill' }, 1000, 1000],
    ['contain', { width: 1000, height: 1000, fit: 'contain' }, 1000, 1000],
    ['cover', { width: 1000, height: 1000, fit: 'cover' }, 1000, 1000],
    ['inside keeps the aspect ratio within the box', { width: 1000, height: 1000, fit: 'inside' }, 1000, 500],
    ['outside keeps the aspect ratio around the box', { width: 1000, height: 1000, fit: 'outside' }, 2000, 1000],
    ['a width alone scales the height', { width: 500 }, 500, 250],
    ['a height alone scales the width', { height: 500 }, 1000, 500],
    ['numeric strings from a form', { width: '500' }, 500, 250],
  ])('%s', (_label, request, width, height) => {
    expect(resizedDimensions(4000, 2000, request)).toEqual({ width, height });
  });
});
