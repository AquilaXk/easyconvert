import { beforeEach, describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { POST as batchConvertPost } from '../src/app/api/convert/batch/route';
import { GET as getOpenApiSpec } from '../src/app/api/openapi.json/route';
import { redisKeyStore } from '../src/lib/api-keys/redis-key-store';
import { userStore } from '../src/lib/auth/user-store';
import { bombPng } from './helpers/image-bombs';
import { cbzWithImages } from './helpers/embedded-image-docs';

const HTTP_PAYLOAD_TOO_LARGE = 413;
const PAYLOAD_TOO_LARGE_PROBLEM = 'https://api.easyconvert.io/problems/payload-too-large';
const EXPECTED_DEFAULT_LIMIT = 100_000_000;
const OVER_LIMIT_SIDE = 15_000;
const SMALL_SIDE = 16;

describe('POST /api/convert/batch answers 413 for an image over the input limit', () => {
  let secretKey: string;

  beforeEach(async () => {
    const user = await userStore.createUser({
      name: 'Batch Pixel Limit',
      email: `batch_pixel_${Date.now()}_${Math.random().toString(36).slice(2)}@easyconvert.local`,
      tier: 'pro',
    });
    const key = await redisKeyStore.generateApiKey(user.id, 'Batch Pixel Key', { scopes: ['convert:write'] });
    secretKey = key.secretKey;
  });

  function batchRequest(files: Array<{ name: string; data: Buffer }>, targets: Record<string, string> = { default: 'jpg' }): NextRequest {
    const form = new FormData();
    for (const file of files) form.append('files', new Blob([new Uint8Array(file.data)]), file.name);
    form.append('targetFormats', JSON.stringify(targets));
    return new NextRequest('http://localhost/api/convert/batch', {
      method: 'POST',
      headers: { Authorization: `Bearer ${secretKey}` },
      body: form,
    });
  }

  it('refuses the whole batch with a payload-too-large problem that states the limit', async () => {
    const res = await batchConvertPost(batchRequest([{ name: 'bomb.png', data: bombPng(OVER_LIMIT_SIDE, OVER_LIMIT_SIDE) }]));
    expect(res.status).toBe(HTTP_PAYLOAD_TOO_LARGE);
    const problem = await res.json();
    expect(problem).toMatchObject({ status: HTTP_PAYLOAD_TOO_LARGE, type: PAYLOAD_TOO_LARGE_PROBLEM, success: false });
    expect(problem.detail).toContain(`over the input limit of ${EXPECTED_DEFAULT_LIMIT} pixels`);
  });

  it('refuses a batch whose later file is an archive holding an over-limit page', async () => {
    const comic = await cbzWithImages([{ name: '1.png', data: bombPng(OVER_LIMIT_SIDE, OVER_LIMIT_SIDE) }]);
    const res = await batchConvertPost(batchRequest([{ name: 'comic.cbz', data: comic }], { 'comic.cbz': 'pdf' }));
    expect(res.status).toBe(HTTP_PAYLOAD_TOO_LARGE);
    expect((await res.json()).type).toBe(PAYLOAD_TOO_LARGE_PROBLEM);
  });
});

describe('OpenAPI document lists the 413 answer of the conversion routes', () => {
  it.each(['/api/v1/convert', '/api/convert', '/api/convert/batch'])('declares 413 for POST %s', async (route) => {
    const spec = await (await getOpenApiSpec()).json();
    const response = spec.paths[route].post.responses['413'];
    expect(response.description).toContain('100 megapixels');
    expect(response.description).toContain('EASYCONVERT_MAX_INPUT_PIXELS');
    expect(response.content['application/problem+json'].schema.$ref).toBe('#/components/schemas/ProblemDetails');
  });

  it('keeps a small image converting through the batch route', async () => {
    const user = await userStore.createUser({
      name: 'Batch Small',
      email: `batch_small_${Date.now()}_${Math.random().toString(36).slice(2)}@easyconvert.local`,
      tier: 'pro',
    });
    const key = await redisKeyStore.generateApiKey(user.id, 'Batch Small Key', { scopes: ['convert:write'] });
    const sharp = (await import('sharp')).default;
    const png = await sharp({ create: { width: SMALL_SIDE, height: SMALL_SIDE, channels: 3, background: '#112233' } }).png().toBuffer();
    const form = new FormData();
    form.append('files', new Blob([new Uint8Array(png)]), 'small.png');
    form.append('targetFormats', JSON.stringify({ default: 'jpg' }));
    const res = await batchConvertPost(
      new NextRequest('http://localhost/api/convert/batch', { method: 'POST', headers: { Authorization: `Bearer ${key.secretKey}` }, body: form })
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/zip');
    expect(Buffer.from(await res.arrayBuffer()).subarray(0, 4).toString('hex')).toBe('504b0304');
  });
});
