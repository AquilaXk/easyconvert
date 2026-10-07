import crypto from 'node:crypto';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { POST as convertRoute } from '../src/app/api/convert/route';
import { POST as queueJobsRoute } from '../src/app/api/queue/jobs/route';
import { conversionQueue } from '../src/lib/queue/conversion-queue';
import { storageProvider } from '../src/lib/storage';
import { redisKeyStore } from '../src/lib/api-keys/redis-key-store';
import { userStore } from '../src/lib/auth/user-store';

/**
 * The legacy routes answer the web application and older clients. They validate a request the way
 * /api/v1 does: a source format the registry does not know is a 400 (never the raw extension or
 * "bin"), and options must satisfy ConversionOptionsSchema. A rejected request leaves nothing behind:
 * no queued job, no stored upload.
 */

const BASE_URL = 'http://localhost:3000';
const HTTP_OK = 200;
const HTTP_BAD_REQUEST = 400;
const CSV_INPUT = 'name,score\nAlice,100\nBob,95\n';
const JPEG_SOI = Buffer.from([0xff, 0xd8, 0xff]);
// 1x1 RGB PNG (IHDR, IDAT, IEND); the zlib stream and CRCs come from a PNG encoder, not from this project.
const PNG_1X1 = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108020000009077' +
    '53de0000000c4944415408d763f8cfc000000301010018dd8db00000000049454e44ae426082',
  'hex'
);
/** Largest `quality` the schema accepts, plus one. */
const QUALITY_OVER_MAXIMUM = 101;

let apiKey = '';

beforeEach(async () => {
  const email = `legacy_${Date.now()}_${crypto.randomBytes(6).toString('hex')}@legacy-validation.test`;
  const user = await userStore.createUser({ email, name: 'Legacy Tester', tier: 'pro' });
  apiKey = (await redisKeyStore.generateApiKey(user.id, 'Legacy Key', { scopes: ['convert:write', 'convert:read'] })).secretKey;
});

afterEach(() => {
  vi.restoreAllMocks();
});

function multipart(url: string, form: FormData): NextRequest {
  return new NextRequest(`${BASE_URL}${url}`, { method: 'POST', headers: { Authorization: `Bearer ${apiKey}` }, body: form });
}

function jsonRequest(url: string, body: unknown): NextRequest {
  return new NextRequest(`${BASE_URL}${url}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function convertForm(file: File, targetFormat: string, options?: unknown): FormData {
  const form = new FormData();
  form.append('file', file);
  form.append('targetFormat', targetFormat);
  if (options !== undefined) form.append('options', JSON.stringify(options));
  return form;
}

const csvFile = (name = 'scores.csv') => new File([CSV_INPUT], name, { type: 'text/csv' });
const pngFile = () => new File([new Uint8Array(PNG_1X1)], 'pixel.png', { type: 'image/png' });

describe('POST /api/convert', () => {
  it('answers 400 for a file whose extension no format owns', async () => {
    const res = await convertRoute(multipart('/api/convert', convertForm(csvFile('file.unknownext'), 'json')));
    expect(res.status).toBe(HTTP_BAD_REQUEST);
    expect((await res.json()).success).toBe(false);
  });

  it('answers 400 for a file without any extension', async () => {
    const res = await convertRoute(multipart('/api/convert', convertForm(csvFile('scores'), 'json')));
    expect(res.status).toBe(HTTP_BAD_REQUEST);
  });

  it.each([
    ['a number above its maximum', { quality: QUALITY_OVER_MAXIMUM }, 'quality'],
    ['a string where an integer is required', { quality: 'high' }, 'quality'],
    ['a planned option the engines do not read yet', { aspectRatio: '16:9' }, 'aspectRatio'],
  ])('answers 400 with the offending option named for %s', async (_label, options, name) => {
    const res = await convertRoute(multipart('/api/convert', convertForm(pngFile(), 'jpg', options)));
    expect(res.status).toBe(HTTP_BAD_REQUEST);
    expect(res.headers.get('content-type')).toBe('application/problem+json');
    const body = await res.json();
    expect(body.status).toBe(HTTP_BAD_REQUEST);
    expect(body.success).toBe(false);
    expect(body.invalidParams.map((p: { name: string }) => p.name)).toContain(name);
  });

  it('still converts with options that satisfy the schema', async () => {
    const res = await convertRoute(multipart('/api/convert', convertForm(pngFile(), 'jpg', { quality: 80 })));
    expect(res.status).toBe(HTTP_OK);
    expect(res.headers.get('content-type')).toBe('image/jpeg');
    expect(Buffer.from(await res.arrayBuffer()).subarray(0, JPEG_SOI.length)).toEqual(JPEG_SOI);
  });
});

describe('POST /api/queue/jobs', () => {
  function spyOnEffects() {
    return {
      enqueue: vi.spyOn(conversionQueue, 'add'),
      upload: vi.spyOn(storageProvider, 'initiateMultipartUpload'),
    };
  }

  it('answers 400 for a multipart file with an unknown extension, before storing or queueing anything', async () => {
    const effects = spyOnEffects();
    const res = await queueJobsRoute(multipart('/api/queue/jobs', convertForm(csvFile('file.unknownext'), 'json')));
    expect(res.status).toBe(HTTP_BAD_REQUEST);
    expect((await res.json()).success).toBe(false);
    expect(effects.upload).not.toHaveBeenCalled();
    expect(effects.enqueue).not.toHaveBeenCalled();
  });

  it('answers 400 for a JSON body whose filename has an unknown extension', async () => {
    const effects = spyOnEffects();
    const res = await queueJobsRoute(
      jsonRequest('/api/queue/jobs', {
        filename: 'file.unknownext',
        targetFormat: 'json',
        inputBufferBase64: Buffer.from(CSV_INPUT).toString('base64'),
      })
    );
    expect(res.status).toBe(HTTP_BAD_REQUEST);
    expect(effects.enqueue).not.toHaveBeenCalled();
  });

  it('answers 400 for a JSON body without a filename instead of queueing a "bin" source', async () => {
    const effects = spyOnEffects();
    const res = await queueJobsRoute(
      jsonRequest('/api/queue/jobs', {
        targetFormat: 'json',
        inputBufferBase64: Buffer.from(CSV_INPUT).toString('base64'),
      })
    );
    expect(res.status).toBe(HTTP_BAD_REQUEST);
    expect(effects.enqueue).not.toHaveBeenCalled();
  });

  it.each([
    ['a number above its maximum', { quality: QUALITY_OVER_MAXIMUM }, 'quality'],
    ['a planned option the engines do not read yet', { aspectRatio: '16:9' }, 'aspectRatio'],
  ])('answers 400 with the offending option named for %s (JSON body)', async (_label, options, name) => {
    const effects = spyOnEffects();
    const res = await queueJobsRoute(
      jsonRequest('/api/queue/jobs', {
        filename: 'pixel.png',
        targetFormat: 'jpg',
        inputBufferBase64: PNG_1X1.toString('base64'),
        options,
      })
    );
    expect(res.status).toBe(HTTP_BAD_REQUEST);
    const body = await res.json();
    expect(body.invalidParams.map((p: { name: string }) => p.name)).toContain(name);
    expect(effects.enqueue).not.toHaveBeenCalled();
  });

  it('answers 400 for options that break the schema in a multipart request, before storing the upload', async () => {
    const effects = spyOnEffects();
    const res = await queueJobsRoute(multipart('/api/queue/jobs', convertForm(pngFile(), 'jpg', { quality: QUALITY_OVER_MAXIMUM })));
    expect(res.status).toBe(HTTP_BAD_REQUEST);
    expect(effects.upload).not.toHaveBeenCalled();
    expect(effects.enqueue).not.toHaveBeenCalled();
  });

  it('queues a known source with the registry extension and the validated options', async () => {
    const effects = spyOnEffects();
    const res = await queueJobsRoute(
      jsonRequest('/api/queue/jobs', {
        filename: 'scores.csv',
        targetFormat: 'json',
        inputBufferBase64: Buffer.from(CSV_INPUT).toString('base64'),
        options: {},
      })
    );
    expect(res.status).toBe(HTTP_OK);
    expect((await res.json()).success).toBe(true);
    expect(effects.enqueue).toHaveBeenCalledTimes(1);
    expect(effects.enqueue.mock.calls[0][1]).toMatchObject({ sourceFormat: 'csv', targetFormat: 'json', originalFilename: 'scores.csv' });
  });
});
