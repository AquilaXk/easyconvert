import { describe, it, expect, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { POST as v1ConvertPost } from '../src/app/api/v1/convert/route';
import { POST as convertPost } from '../src/app/api/convert/route';
import { GET as getOpenApiSpec } from '../src/app/api/openapi.json/route';
import { processConversionJob } from '../src/lib/queue/conversion-queue';
import type { Job } from '../src/lib/queue/bullmq-engine';
import { redisKeyStore } from '../src/lib/api-keys/redis-key-store';
import { userStore } from '../src/lib/auth/user-store';
import type { ConversionJobData, ConversionJobResult } from '../src/lib/types';
import { FRAME_USED_HEADER, SOURCE_FRAMES_HEADER } from '../src/lib/api/frame-headers';
import { decodeRgba, runConvert, sampleAt, SKIP_WITHOUT_MAGICK, type Rgb } from './helpers/imagemagick';

/**
 * The frame metadata of a conversion (`sourceFrameCount`, `frameUsed`) reaches every response surface:
 * response headers of both convert endpoints, the JSON body of the keyed endpoint, the job result of the
 * queue worker, and the OpenAPI document.
 *
 * Oracles: fixtures are written by ImageMagick; returned pixels are decoded with ImageMagick.
 */

const WIDTH = 30;
const HEIGHT = 20;
const FRAME_COLOURS: readonly Rgb[] = [
  [255, 0, 0],
  [0, 255, 0],
  [0, 0, 255],
];
const COLOUR_TOLERANCE = 12;
const HTTP_OK = 200;

let secretKey: string;

beforeEach(async () => {
  const user = await userStore.createUser({
    name: 'Frame Tester',
    email: `frames_${Date.now()}_${Math.random().toString(36).slice(2)}@easyconvert.local`,
    tier: 'pro',
  });
  const key = await redisKeyStore.generateApiKey(user.id, 'Frame Test Key', { scopes: ['convert:write', 'convert:read'] });
  secretKey = key.secretKey;
});

function rgb([r, g, b]: Rgb): string {
  return `rgb(${r},${g},${b})`;
}

function buildFrames(container: 'gif' | 'tiff'): Buffer {
  const args = ['-size', `${WIDTH}x${HEIGHT}`];
  FRAME_COLOURS.forEach((colour) => args.push(...(container === 'gif' ? ['-delay', '10'] : []), `xc:${rgb(colour)}`));
  return runConvert([...args, `${container}:-`]);
}

function buildSingleFrameGif(): Buffer {
  return runConvert(['-size', `${WIDTH}x${HEIGHT}`, `xc:${rgb(FRAME_COLOURS[0])}`, 'gif:-']);
}

function multipart(url: string, file: Buffer, fileName: string, fields: Record<string, string>, headers: Record<string, string> = {}): NextRequest {
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(file)]), fileName);
  for (const [name, value] of Object.entries(fields)) form.append(name, value);
  return new NextRequest(url, { method: 'POST', headers: { Authorization: `Bearer ${secretKey}`, ...headers }, body: form });
}

function expectCentre(png: Buffer, expected: Rgb): void {
  const image = decodeRgba(png, 'png');
  const actual = sampleAt(image, image.width / 2, image.height / 2);
  expected.forEach((value, channel) => {
    expect(Math.abs(actual[channel] - value), `channel ${channel}: got ${actual[channel]}, expected ${value}`).toBeLessThanOrEqual(
      COLOUR_TOLERANCE
    );
  });
}

describe('POST /api/convert', () => {
  it.skipIf(SKIP_WITHOUT_MAGICK)('reports the frame count and frame 1 for an animated gif converted to png', async () => {
    const res = await convertPost(multipart('http://localhost/api/convert', buildFrames('gif'), 'anim.gif', { targetFormat: 'png' }));
    expect(res.status).toBe(HTTP_OK);
    expect(res.headers.get(SOURCE_FRAMES_HEADER)).toBe('3');
    expect(res.headers.get(FRAME_USED_HEADER)).toBe('1');
    expectCentre(Buffer.from(await res.arrayBuffer()), FRAME_COLOURS[0]);
  });

  it.skipIf(SKIP_WITHOUT_MAGICK)('page selects the frame and the header names it', async () => {
    const res = await convertPost(
      multipart('http://localhost/api/convert', buildFrames('gif'), 'anim.gif', { targetFormat: 'png', options: JSON.stringify({ page: 2 }) })
    );
    expect(res.status).toBe(HTTP_OK);
    expect(res.headers.get(FRAME_USED_HEADER)).toBe('2');
    expectCentre(Buffer.from(await res.arrayBuffer()), FRAME_COLOURS[1]);
  });

  it.skipIf(SKIP_WITHOUT_MAGICK)('a multi-page tiff comes back as a ZIP and only the page count is reported', async () => {
    const res = await convertPost(multipart('http://localhost/api/convert', buildFrames('tiff'), 'scan.tiff', { targetFormat: 'png' }));
    expect(res.status).toBe(HTTP_OK);
    expect(res.headers.get('content-type')).toBe('application/zip');
    expect(res.headers.get('content-disposition')).toContain('scan.zip');
    expect(res.headers.get(SOURCE_FRAMES_HEADER)).toBe('3');
    expect(res.headers.get(FRAME_USED_HEADER)).toBeNull();
  });

  it.skipIf(SKIP_WITHOUT_MAGICK)('sends no frame headers for a single-frame source', async () => {
    const res = await convertPost(multipart('http://localhost/api/convert', buildSingleFrameGif(), 'one.gif', { targetFormat: 'png' }));
    expect(res.status).toBe(HTTP_OK);
    expect(res.headers.get(SOURCE_FRAMES_HEADER)).toBeNull();
    expect(res.headers.get(FRAME_USED_HEADER)).toBeNull();
  });

  it.skipIf(SKIP_WITHOUT_MAGICK)('an out-of-range page is a client error', async () => {
    const res = await convertPost(
      multipart('http://localhost/api/convert', buildFrames('gif'), 'anim.gif', { targetFormat: 'png', options: JSON.stringify({ page: 9 }) })
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/out of range: the image has 3 frames/);
  });
});

describe('POST /api/v1/convert', () => {
  it.skipIf(SKIP_WITHOUT_MAGICK)('returns sourceFrameCount and frameUsed in the JSON body', async () => {
    const res = await v1ConvertPost(
      multipart('http://localhost/api/v1/convert', buildFrames('gif'), 'anim.gif', { targetFormat: 'png', options: JSON.stringify({ page: 3 }) })
    );
    expect(res.status).toBe(HTTP_OK);
    const body = await res.json();
    expect(body.sourceFrameCount).toBe(3);
    expect(body.frameUsed).toBe(3);
    expect(body.fileName).toBe('anim.png');
    expectCentre(Buffer.from(String(body.dataUri).split(',')[1], 'base64'), FRAME_COLOURS[2]);
  });

  it.skipIf(SKIP_WITHOUT_MAGICK)('sends the frame headers on a raw response', async () => {
    const res = await v1ConvertPost(
      multipart('http://localhost/api/v1/convert', buildFrames('gif'), 'anim.gif', { targetFormat: 'png' }, { Accept: 'application/octet-stream' })
    );
    expect(res.status).toBe(HTTP_OK);
    expect(res.headers.get(SOURCE_FRAMES_HEADER)).toBe('3');
    expect(res.headers.get(FRAME_USED_HEADER)).toBe('1');
  });

  it.skipIf(SKIP_WITHOUT_MAGICK)('names a per-page ZIP result .zip and omits frameUsed', async () => {
    const res = await v1ConvertPost(multipart('http://localhost/api/v1/convert', buildFrames('tiff'), 'scan.tiff', { targetFormat: 'png' }));
    expect(res.status).toBe(HTTP_OK);
    const body = await res.json();
    expect(body.fileName).toBe('scan.zip');
    expect(body.mimeType).toBe('application/zip');
    expect(body.sourceFrameCount).toBe(3);
    expect(body).not.toHaveProperty('frameUsed');
  });

  it.skipIf(SKIP_WITHOUT_MAGICK)('leaves the fields out for a single-frame source', async () => {
    const res = await v1ConvertPost(multipart('http://localhost/api/v1/convert', buildSingleFrameGif(), 'one.gif', { targetFormat: 'png' }));
    const body = await res.json();
    expect(body).not.toHaveProperty('sourceFrameCount');
    expect(body).not.toHaveProperty('frameUsed');
  });
});

describe('queue worker job result', () => {
  it.skipIf(SKIP_WITHOUT_MAGICK)('carries sourceFrameCount and frameUsed', async () => {
    const input = buildFrames('gif');
    const data: ConversionJobData = {
      jobId: `frames_${Date.now()}`,
      originalFilename: 'anim.gif',
      sourceFormat: 'gif',
      targetFormat: 'png',
      fileSize: input.length,
      options: { page: 2 },
      inputBufferBase64: input.toString('base64'),
    };
    const job = {
      id: data.jobId,
      data,
      opts: { attempts: 1 },
      attemptsMade: 1,
      signal: new AbortController().signal,
      log: async () => {},
      updateProgress: async () => {},
    } as unknown as Job<ConversionJobData, ConversionJobResult>;
    const result = await processConversionJob(job);
    expect(result.status).toBe('completed');
    expect(result.sourceFrameCount).toBe(3);
    expect(result.frameUsed).toBe(2);
  });
});

describe('OpenAPI document', () => {
  it('documents the headers and the response fields', async () => {
    const spec = await (await getOpenApiSpec()).json();
    for (const path of ['/api/v1/convert', '/api/convert']) {
      const headers = spec.paths[path].post.responses['200'].headers;
      expect(headers[SOURCE_FRAMES_HEADER].schema.type, `${path} ${SOURCE_FRAMES_HEADER}`).toBe('integer');
      expect(headers[FRAME_USED_HEADER].schema.type, `${path} ${FRAME_USED_HEADER}`).toBe('integer');
    }
    const response = spec.components.schemas.ConversionResponse.properties;
    expect(response.sourceFrameCount.type).toBe('integer');
    expect(response.frameUsed.type).toBe('integer');
    const jobResult = spec.components.schemas.JobResource.properties.result.properties;
    expect(jobResult.sourceFrameCount.type).toBe('integer');
    expect(jobResult.frameUsed.type).toBe('integer');
  });
});
