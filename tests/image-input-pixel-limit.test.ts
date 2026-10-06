import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import sharp from 'sharp';
import { POST as v1ConvertPost } from '../src/app/api/v1/convert/route';
import { POST as legacyConvertPost } from '../src/app/api/convert/route';
import { convertImage, encodeBmp } from '../src/lib/conversions/image';
import {
  InputPixelLimitError,
  MAX_INPUT_PIXELS_ENV,
  maxInputPixels,
  openLimitedSharp,
} from '../src/lib/conversions/image-input-limits';
import { redisKeyStore } from '../src/lib/api-keys/redis-key-store';
import { userStore } from '../src/lib/auth/user-store';
import { bombBmp, bombJpeg, bombPng, bombTiff, bombWebp } from './helpers/image-bombs';

const BYTES_PER_MIB = 1024 * 1024;
/** Time a bomb may take to be refused, and the RSS it may add (the issue's acceptance numbers). */
const MAX_REJECTION_MS = 50;
const MAX_RSS_GROWTH_BYTES = 50 * BYTES_PER_MIB;
const REJECTION_ATTEMPTS = 3;

/** Written out by hand from the issue and the image-service convention, not read back from the module. */
const EXPECTED_DEFAULT_LIMIT = 100_000_000;
/** 16383 x 16383: the largest WebP canvas, and sharp's own default limit. */
const EXPECTED_CEILING = 16383 * 16383;
const HTTP_PAYLOAD_TOO_LARGE = 413;
const PAYLOAD_TOO_LARGE_PROBLEM = 'https://api.easyconvert.io/problems/payload-too-large';

/** Side of a declared canvas of 225 megapixels: over the limit, yet under sharp's own default of 268 MP. */
const SIDE_UNDER_NATIVE_DEFAULT = 15_000;
/** Side of a declared canvas of 900 megapixels: over every limit. */
const SIDE_OVER_EVERYTHING = 30_000;
/** Largest side a lossy WebP can declare. */
const WEBP_MAX_SIDE = 16_383;

/** Small limit used to test the boundary cheaply: 64 x 64 pixels. */
const SMALL_LIMIT_SIDE = 64;
const SMALL_LIMIT = SMALL_LIMIT_SIDE * SMALL_LIMIT_SIDE;

const PNG_IHDR_WIDTH_OFFSET = 16;
const PNG_IHDR_HEIGHT_OFFSET = 20;

interface BombCase {
  name: string;
  source: string;
  build: () => Buffer;
  width: number;
  height: number;
}

const BOMBS: BombCase[] = [
  { name: 'PNG 15000x15000', source: 'png', build: () => bombPng(SIDE_UNDER_NATIVE_DEFAULT, SIDE_UNDER_NATIVE_DEFAULT), width: SIDE_UNDER_NATIVE_DEFAULT, height: SIDE_UNDER_NATIVE_DEFAULT },
  { name: 'PNG 30000x30000', source: 'png', build: () => bombPng(SIDE_OVER_EVERYTHING, SIDE_OVER_EVERYTHING), width: SIDE_OVER_EVERYTHING, height: SIDE_OVER_EVERYTHING },
  { name: 'JPEG 15000x15000', source: 'jpg', build: () => bombJpeg(SIDE_UNDER_NATIVE_DEFAULT, SIDE_UNDER_NATIVE_DEFAULT), width: SIDE_UNDER_NATIVE_DEFAULT, height: SIDE_UNDER_NATIVE_DEFAULT },
  { name: 'JPEG 30000x30000', source: 'jpg', build: () => bombJpeg(SIDE_OVER_EVERYTHING, SIDE_OVER_EVERYTHING), width: SIDE_OVER_EVERYTHING, height: SIDE_OVER_EVERYTHING },
  { name: 'WebP 16383x16383', source: 'webp', build: () => bombWebp(WEBP_MAX_SIDE, WEBP_MAX_SIDE), width: WEBP_MAX_SIDE, height: WEBP_MAX_SIDE },
  { name: 'TIFF 15000x15000', source: 'tiff', build: () => bombTiff(SIDE_UNDER_NATIVE_DEFAULT, SIDE_UNDER_NATIVE_DEFAULT), width: SIDE_UNDER_NATIVE_DEFAULT, height: SIDE_UNDER_NATIVE_DEFAULT },
  { name: 'TIFF 30000x30000', source: 'tiff', build: () => bombTiff(SIDE_OVER_EVERYTHING, SIDE_OVER_EVERYTHING), width: SIDE_OVER_EVERYTHING, height: SIDE_OVER_EVERYTHING },
  { name: 'BMP 20000x20000', source: 'bmp', build: () => bombBmp(20_000, 20_000), width: 20_000, height: 20_000 },
];

/** Runs `convert` and returns how long it took to reject, the RSS it added, and the error. */
async function measureRejection(convert: () => Promise<unknown>): Promise<{ ms: number; rssGrowth: number; error: unknown }> {
  const rssBefore = process.memoryUsage().rss;
  const start = performance.now();
  let error: unknown;
  try {
    await convert();
  } catch (caught) {
    error = caught;
  }
  const ms = performance.now() - start;
  return { ms, rssGrowth: process.memoryUsage().rss - rssBefore, error };
}

async function solidPng(width: number, height: number): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: { r: 200, g: 40, b: 90 } } }).png().toBuffer();
}

describe('input pixel limit configuration', () => {
  it('defaults to 100 megapixels', () => {
    expect(maxInputPixels({})).toBe(EXPECTED_DEFAULT_LIMIT);
    expect(maxInputPixels({ [MAX_INPUT_PIXELS_ENV]: '' })).toBe(EXPECTED_DEFAULT_LIMIT);
  });

  it('honours the environment override and lowers a value above the hard ceiling', () => {
    expect(maxInputPixels({ [MAX_INPUT_PIXELS_ENV]: '4096' })).toBe(SMALL_LIMIT);
    expect(maxInputPixels({ [MAX_INPUT_PIXELS_ENV]: ' 4096\n' })).toBe(SMALL_LIMIT);
    expect(maxInputPixels({ [MAX_INPUT_PIXELS_ENV]: String(EXPECTED_CEILING) })).toBe(EXPECTED_CEILING);
    expect(maxInputPixels({ [MAX_INPUT_PIXELS_ENV]: '999999999999' })).toBe(EXPECTED_CEILING);
    expect(maxInputPixels({ [MAX_INPUT_PIXELS_ENV]: '99999999999999999999999' })).toBe(EXPECTED_CEILING);
  });

  it.each(['0', '-5', '1.5', 'abc', '1e3', '0x10', '+5', '4096px', 'NaN', 'Infinity'])(
    'falls back to the default for the malformed override %j and warns once, without failing requests',
    (value) => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const env = { [MAX_INPUT_PIXELS_ENV]: value };
        expect(maxInputPixels(env)).toBe(EXPECTED_DEFAULT_LIMIT);
        expect(maxInputPixels(env)).toBe(EXPECTED_DEFAULT_LIMIT);
        expect(warn).toHaveBeenCalledTimes(1);
        expect(String(warn.mock.calls[0][0])).toContain(MAX_INPUT_PIXELS_ENV);
        expect(String(warn.mock.calls[0][0])).toContain(`${EXPECTED_DEFAULT_LIMIT}`);
      } finally {
        warn.mockRestore();
      }
    }
  );

  it('keeps converting under a malformed override instead of answering 500', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const previous = process.env[MAX_INPUT_PIXELS_ENV];
    process.env[MAX_INPUT_PIXELS_ENV] = 'lots';
    try {
      const result = await convertImage(await solidPng(SMALL_LIMIT_SIDE, SMALL_LIMIT_SIDE), 'png', {}, 'ok.png', 'png');
      expect(result.buffer.readUInt32BE(PNG_IHDR_WIDTH_OFFSET)).toBe(SMALL_LIMIT_SIDE);
    } finally {
      if (previous === undefined) delete process.env[MAX_INPUT_PIXELS_ENV];
      else process.env[MAX_INPUT_PIXELS_ENV] = previous;
      warn.mockRestore();
    }
  });
});

describe('decompression bombs are refused from the header', () => {
  beforeAll(async () => {
    // Load the native decoders once so the measurements below cover the rejection, not library start-up.
    await convertImage(await solidPng(SMALL_LIMIT_SIDE, SMALL_LIMIT_SIDE), 'jpg', {}, 'warm.png', 'png');
  });

  it.each(BOMBS)('$name is rejected with a typed 413 error inside the time and memory budget', async ({ source, build, width, height }) => {
    const bomb = build();
    expect(bomb.length).toBeLessThan(1024);

    let best: { ms: number; rssGrowth: number; error: unknown } | undefined;
    for (let attempt = 0; attempt < REJECTION_ATTEMPTS; attempt++) {
      const run = await measureRejection(() => convertImage(bomb, 'png', {}, `bomb.${source}`, source));
      if (!best || run.ms < best.ms) best = run;
    }

    expect(best?.error).toBeInstanceOf(InputPixelLimitError);
    expect(best?.error).toMatchObject({ status: HTTP_PAYLOAD_TOO_LARGE, limit: EXPECTED_DEFAULT_LIMIT, width, height });
    expect((best?.error as Error).message).toContain(`${EXPECTED_DEFAULT_LIMIT} pixels`);
    expect((best?.error as Error).message).toContain(`${width}x${height}`);
    expect(best?.ms).toBeLessThan(MAX_REJECTION_MS);
    expect(best?.rssGrowth).toBeLessThan(MAX_RSS_GROWTH_BYTES);
  });

  it('refuses the same bomb for every output format, including the OCR and PDF routes', async () => {
    const bomb = bombPng(SIDE_UNDER_NATIVE_DEFAULT, SIDE_UNDER_NATIVE_DEFAULT);
    for (const target of ['jpg', 'webp', 'tiff', 'avif', 'gif', 'bmp', 'pdf', 'xps', 'hocr']) {
      const run = convertImage(bomb, target, {}, 'bomb.png', 'png');
      await expect(run, target).rejects.toBeInstanceOf(InputPixelLimitError);
      await expect(run, target).rejects.toMatchObject({ status: HTTP_PAYLOAD_TOO_LARGE, limit: EXPECTED_DEFAULT_LIMIT });
    }
  });

  it('refuses a bomb nested in an ICO container', async () => {
    const png = bombPng(SIDE_UNDER_NATIVE_DEFAULT, SIDE_UNDER_NATIVE_DEFAULT);
    const ico = Buffer.alloc(22);
    ico.writeUInt16LE(1, 2); // image type: icon
    ico.writeUInt16LE(1, 4); // one image
    ico.writeUInt32LE(png.length, 14);
    ico.writeUInt32LE(ico.length, 18);
    const run = convertImage(Buffer.concat([ico, png]), 'png', {}, 'bomb.ico', 'ico');
    await expect(run).rejects.toBeInstanceOf(InputPixelLimitError);
    await expect(run).rejects.toMatchObject({ status: HTTP_PAYLOAD_TOO_LARGE, width: SIDE_UNDER_NATIVE_DEFAULT });
  });

  it('refuses a bomb declared by a TIFF-based camera RAW before the sensor is assembled', async () => {
    const dng = bombTiff(SIDE_UNDER_NATIVE_DEFAULT, SIDE_UNDER_NATIVE_DEFAULT);
    const run = convertImage(dng, 'png', {}, 'bomb.dng', 'dng');
    await expect(run).rejects.toBeInstanceOf(InputPixelLimitError);
    await expect(run).rejects.toMatchObject({ width: SIDE_UNDER_NATIVE_DEFAULT, height: SIDE_UNDER_NATIVE_DEFAULT });
  });

  it('passes the limit to the native decoder as well', async () => {
    // Even when the header gate is bypassed, a sharp instance opened by the module refuses the canvas itself.
    await expect(openLimitedSharp(bombJpeg(SIDE_UNDER_NATIVE_DEFAULT, SIDE_UNDER_NATIVE_DEFAULT)).metadata()).rejects.toThrow(
      /exceeds pixel limit/
    );
  });
});

describe('images at and below the limit still convert', () => {
  const previous = process.env[MAX_INPUT_PIXELS_ENV];

  beforeEach(() => {
    process.env[MAX_INPUT_PIXELS_ENV] = String(SMALL_LIMIT);
  });

  afterEach(() => {
    if (previous === undefined) delete process.env[MAX_INPUT_PIXELS_ENV];
    else process.env[MAX_INPUT_PIXELS_ENV] = previous;
  });

  it('converts an image of exactly the limit', async () => {
    const result = await convertImage(await solidPng(SMALL_LIMIT_SIDE, SMALL_LIMIT_SIDE), 'png', {}, 'at.png', 'png');
    expect(result.buffer.readUInt32BE(PNG_IHDR_WIDTH_OFFSET)).toBe(SMALL_LIMIT_SIDE);
    expect(result.buffer.readUInt32BE(PNG_IHDR_HEIGHT_OFFSET)).toBe(SMALL_LIMIT_SIDE);
  });

  it('converts an image one row below the limit', async () => {
    const result = await convertImage(await solidPng(SMALL_LIMIT_SIDE, SMALL_LIMIT_SIDE - 1), 'png', {}, 'below.png', 'png');
    expect(result.buffer.readUInt32BE(PNG_IHDR_HEIGHT_OFFSET)).toBe(SMALL_LIMIT_SIDE - 1);
  });

  it('refuses an image one row above the limit and states the configured limit', async () => {
    const run = convertImage(await solidPng(SMALL_LIMIT_SIDE, SMALL_LIMIT_SIDE + 1), 'png', {}, 'above.png', 'png');
    await expect(run).rejects.toBeInstanceOf(InputPixelLimitError);
    await expect(run).rejects.toThrow(`over the input limit of ${SMALL_LIMIT} pixels`);
  });

  it('keeps the Oklab palette GIF path typed on both sides of the limit', async () => {
    const gif = await sharp({ create: { width: SMALL_LIMIT_SIDE, height: SMALL_LIMIT_SIDE, channels: 3, background: { r: 10, g: 200, b: 30 } } })
      .gif()
      .toBuffer();
    const converted = await convertImage(gif, 'png', { quantizer: 'oklab', colors: 16 }, 'ok.gif', 'gif');
    expect(converted.buffer.readUInt32BE(PNG_IHDR_WIDTH_OFFSET)).toBe(SMALL_LIMIT_SIDE);

    const over = await sharp({ create: { width: SMALL_LIMIT_SIDE + 1, height: SMALL_LIMIT_SIDE, channels: 3, background: { r: 10, g: 200, b: 30 } } })
      .gif()
      .toBuffer();
    await expect(convertImage(over, 'png', { quantizer: 'oklab' }, 'over.gif', 'gif')).rejects.toBeInstanceOf(InputPixelLimitError);
  });

  it('applies the limit to the pure TypeScript BMP decoder before allocating', async () => {
    await expect(convertImage(bombBmp(SMALL_LIMIT_SIDE + 1, SMALL_LIMIT_SIDE), 'png', {}, 'over.bmp', 'bmp')).rejects.toBeInstanceOf(
      InputPixelLimitError
    );
    const whole = encodeBmp(Buffer.alloc(SMALL_LIMIT * 3, 9), SMALL_LIMIT_SIDE, SMALL_LIMIT_SIDE, 3);
    const ok = await convertImage(whole, 'png', {}, 'at.bmp', 'bmp');
    expect(ok.buffer.readUInt32BE(PNG_IHDR_WIDTH_OFFSET)).toBe(SMALL_LIMIT_SIDE);
  });
});

describe('API answers 413 for an image over the input limit', () => {
  let secretKey: string;

  beforeEach(async () => {
    const user = await userStore.createUser({
      name: 'Pixel Limit Tester',
      email: `pixel_limit_${Date.now()}_${Math.random().toString(36).slice(2)}@easyconvert.local`,
      tier: 'pro',
    });
    const key = await redisKeyStore.generateApiKey(user.id, 'Pixel Limit Key', { scopes: ['convert:write', 'convert:read'] });
    secretKey = key.secretKey;
  });

  function uploadRequest(url: string, file: Buffer, fileName: string, targetFormat: string): NextRequest {
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(file)]), fileName);
    form.append('targetFormat', targetFormat);
    return new NextRequest(url, { method: 'POST', headers: { Authorization: `Bearer ${secretKey}` }, body: form });
  }

  it('POST /api/v1/convert returns a payload-too-large problem that states the limit', async () => {
    const bomb = bombPng(SIDE_UNDER_NATIVE_DEFAULT, SIDE_UNDER_NATIVE_DEFAULT);
    const res = await v1ConvertPost(uploadRequest('http://localhost/api/v1/convert', bomb, 'bomb.png', 'jpg'));
    expect(res.status).toBe(HTTP_PAYLOAD_TOO_LARGE);
    expect(res.headers.get('content-type')).toContain('application/problem+json');
    const problem = await res.json();
    expect(problem).toMatchObject({ status: HTTP_PAYLOAD_TOO_LARGE, type: PAYLOAD_TOO_LARGE_PROBLEM, success: false });
    expect(problem.detail).toContain(`over the input limit of ${EXPECTED_DEFAULT_LIMIT} pixels`);
    expect(problem.detail).toContain('15000x15000');
  });

  it('POST /api/convert returns the same typed 413', async () => {
    const bomb = bombJpeg(SIDE_UNDER_NATIVE_DEFAULT, SIDE_UNDER_NATIVE_DEFAULT);
    const res = await legacyConvertPost(uploadRequest('http://localhost/api/convert', bomb, 'bomb.jpg', 'png'));
    expect(res.status).toBe(HTTP_PAYLOAD_TOO_LARGE);
    const problem = await res.json();
    expect(problem.type).toBe(PAYLOAD_TOO_LARGE_PROBLEM);
    expect(problem.error).toContain(`${EXPECTED_DEFAULT_LIMIT} pixels`);
  });
});
