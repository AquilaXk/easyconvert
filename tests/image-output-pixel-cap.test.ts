import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { convertImage } from '../src/lib/conversions/image';
import { MAX_OUTPUT_DIMENSION, MAX_OUTPUT_PIXELS } from '../src/lib/conversions/image-limits';
import { POST as convertPost } from '../src/app/api/convert/route';
import { POST as batchPost } from '../src/app/api/convert/batch/route';
import { POST as v1ConvertPost } from '../src/app/api/v1/convert/route';
import { redisKeyStore } from '../src/lib/api-keys/redis-key-store';
import { userStore } from '../src/lib/auth/user-store';
import { COLOUR_TYPE, encodePng, rgbaImage } from './helpers/apng-builder';
import { captureError } from './helpers/capture-error';

/** Real engine, CLI or large-input work: the 5 s default fails on a loaded CI shard without any regression; 60 s only stops a hang. */
const ENGINE_TEST_TIMEOUT_MS = 60_000;
vi.setConfig({ testTimeout: ENGINE_TEST_TIMEOUT_MS });

/**
 * A resize is refused when a side is not a whole number between 1 and 65535, or when the output would hold
 * more than 100 million pixels (400 MB as RGBA), before sharp allocates anything. One-sided requests are
 * bounded by the aspect ratio they imply.
 *
 * Oracles: the PNGs come from the hand-built writer; the limits are the documented constants; a refusal must
 * be quick, since the failure mode being closed is a huge allocation.
 */

const SQUARE = encodePng(rgbaImage(16, 16, () => [10, 20, 30, 255]));
const WIDE = encodePng({ width: 100, height: 10, colourType: COLOUR_TYPE.gray, bitDepth: 8, pixels: Buffer.alloc(1000, 90) });
/** Hang guard only: the cap refusal takes milliseconds; rendering the image would take far longer. */
const REFUSAL_HANG_GUARD_MS = 30_000;
const HTTP_BAD_REQUEST = 400;
const HTTP_UNPROCESSABLE = 422;

describe('output size limits', () => {
  it('exposes the documented limits', () => {
    expect(MAX_OUTPUT_PIXELS).toBe(100_000_000);
    expect(MAX_OUTPUT_DIMENSION).toBe(65_535);
  });

  it.each([
    ['width 1e9', { width: 1e9 }],
    ['height 1e9', { height: 1e9 }],
    ['width 65536', { width: 65536 }],
    ['negative height', { height: -5 }],
    ['fractional width', { width: 10.5 }],
    ['NaN width', { width: Number.NaN }],
    ['text width', { width: 'wide' as unknown as number }],
    ['Infinity height', { height: Number.POSITIVE_INFINITY }],
  ])('rejects %s as an unsupported option, quickly', async (_label, options) => {
    const started = Date.now();
    const error = await captureError(() => convertImage(SQUARE, 'png', options, 'a.png', 'png'));
    expect(error.name).toBe('UnsupportedOptionError');
    expect(error.message).toMatch(/Unsupported (width|height)/);
    expect(Date.now() - started).toBeLessThan(REFUSAL_HANG_GUARD_MS);
  });

  it('rejects a box of more than 100 million pixels', async () => {
    const error = await captureError(() => convertImage(SQUARE, 'png', { width: 20000, height: 20000, fit: 'fill' }, 'a.png', 'png'));
    expect(error.name).toBe('ConversionFailedError');
    expect(error.message).toContain('400000000 pixels');
    expect(error.message).toContain('limit of 100000000 pixels');
  });

  it('bounds a one-sided resize by the aspect ratio of the source', async () => {
    const square = await captureError(() => convertImage(SQUARE, 'png', { width: 40000 }, 'a.png', 'png'));
    expect(square.message).toMatch(/\(1600000000 pixels\)/);
    // 100 x 10 scaled to 40000 wide is 40000 x 4000 = 160 Mpx.
    const wide = await captureError(() => convertImage(WIDE, 'png', { width: 40000 }, 'wide.png', 'png'));
    expect(wide.message).toMatch(/\(160000000 pixels\)/);
  });

  it('bounds the rotated source the same way', async () => {
    const tall = encodePng({ width: 10, height: 100, colourType: COLOUR_TYPE.gray, bitDepth: 8, pixels: Buffer.alloc(1000, 90) });
    const error = await captureError(() => convertImage(tall, 'png', { height: 40000 }, 'tall.png', 'png'));
    expect(error.message).toMatch(/\(160000000 pixels\)/);
  });

  it('still resizes within the limits', async () => {
    const result = await convertImage(SQUARE, 'png', { width: 32, height: 8, fit: 'fill' }, 'a.png', 'png');
    expect(result.buffer.readUInt32BE(16)).toBe(32);
    expect(result.buffer.readUInt32BE(20)).toBe(8);
  });
});

describe('every route refuses an oversized resize with a client error', () => {
  let key: string;

  beforeEach(async () => {
    const user = await userStore.createUser({
      name: 'pixel cap',
      email: `pixels_${Date.now()}_${Math.random().toString(36).slice(2)}@easyconvert.local`,
      tier: 'free',
    });
    key = (await redisKeyStore.generateApiKey(user.id, 'pixel cap', { scopes: ['convert:write', 'convert:read'] })).secretKey;
  });

  const request = (field: 'file' | 'files', options: Record<string, unknown>) => {
    const body = new FormData();
    body.append(field, new Blob([new Uint8Array(SQUARE)]), 'a.png');
    body.append('targetFormat', 'jpg');
    body.append('targetFormats', JSON.stringify({ default: 'jpg' }));
    body.append('options', JSON.stringify(options));
    return new NextRequest('http://localhost/api/test', { method: 'POST', headers: { Authorization: `Bearer ${key}` }, body });
  };

  it('POST /api/convert rejects it in the request schema', async () => {
    const response = await convertPost(request('file', { width: 1e9 }));
    expect(response.status).toBe(HTTP_BAD_REQUEST);
    const body = await response.json();
    expect(body.invalidParams).toEqual([{ name: 'width', reason: 'must be <= 65535' }]);
  });

  it('POST /api/convert refuses a box over the pixel limit that the schema allows', async () => {
    const response = await convertPost(request('file', { width: 20000, height: 20000, fit: 'fill' }));
    expect(response.status).toBe(HTTP_BAD_REQUEST);
    expect(JSON.stringify(await response.json())).toContain('limit of 100000000 pixels');
  });

  it('POST /api/convert/batch', async () => {
    const response = await batchPost(request('files', { width: 20000, height: 20000 }));
    expect(response.status).toBe(HTTP_BAD_REQUEST);
    expect(JSON.stringify(await response.json())).toContain('limit of 100000000 pixels');
  });

  it('POST /api/v1/convert rejects it in the request schema', async () => {
    const response = await v1ConvertPost(request('file', { width: 1e9 }));
    expect(response.status).toBe(HTTP_UNPROCESSABLE);
  });

  it('POST /api/v1/convert refuses a box over the pixel limit that the schema allows', async () => {
    const response = await v1ConvertPost(request('file', { width: 20000, height: 20000, fit: 'fill' }));
    expect(response.status).toBe(HTTP_BAD_REQUEST);
  });
});
