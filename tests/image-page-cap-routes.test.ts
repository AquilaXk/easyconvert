import { describe, it, expect, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import JSZip from 'jszip';
import { POST as batchPost } from '../src/app/api/convert/batch/route';
import { POST as convertPost } from '../src/app/api/convert/route';
import { POST as v1ConvertPost } from '../src/app/api/v1/convert/route';
import { POST as v1JobsPost } from '../src/app/api/v1/jobs/route';
import { POST as queueJobsPost } from '../src/app/api/queue/jobs/route';
import { convertImage } from '../src/lib/conversions/image';
import { TIER_PAGE_CAP } from '../src/lib/conversions/page-range';
import { conversionQueue, processConversionJob } from '../src/lib/queue/conversion-queue';
import { processGraphNodeJob } from '../src/lib/queue/graph/node-executor';
import type { Job } from '../src/lib/queue/bullmq-engine';
import { s3Storage } from '../src/lib/storage/s3-storage';
import { redisKeyStore } from '../src/lib/api-keys/redis-key-store';
import { userStore } from '../src/lib/auth/user-store';
import type { ConversionJobData, ConversionJobResult } from '../src/lib/types';
import { buildBilevelTiff } from './helpers/tiff-builder';
import { captureError } from './helpers/capture-error';

/**
 * The page limit of a multi-page conversion comes from the caller's tier on every route and queue path; a
 * `maxPages` sent in the request is never read. A malformed server-side limit is a typed error, and the
 * limit can never exceed the largest tier's.
 *
 * Oracles: the 60-page TIFFs come from the hand-written writer in tests/helpers/tiff-builder.ts (60 is
 * over the free limit of 50 and under the pro limit of 500); the limits are the documented tier values.
 */

const PAGES = 60;
const FREE_LIMIT_MESSAGE = 'limit of 50 pages';
const HUGE_CLIENT_LIMIT = 100000;
const PAGE_SIDE = 8;
const HTTP_OK = 200;
const ABSOLUTE_PAGE_LIMIT = 2000;
const ONE_HOUR_MS = 60 * 60 * 1000;

const manyPages = (count = PAGES) => buildBilevelTiff(Array.from({ length: count }, () => ({ width: PAGE_SIDE, height: PAGE_SIDE })));

interface Account {
  id: string;
  key: string;
}

let free: Account;
let pro: Account;

async function account(tier: 'free' | 'pro'): Promise<Account> {
  const user = await userStore.createUser({
    name: `cap ${tier}`,
    email: `cap_${tier}_${Date.now()}_${Math.random().toString(36).slice(2)}@easyconvert.local`,
    tier,
  });
  const key = await redisKeyStore.generateApiKey(user.id, `cap ${tier}`, { scopes: ['convert:write', 'convert:read'] });
  return { id: user.id, key: key.secretKey };
}

beforeEach(async () => {
  free = await account('free');
  pro = await account('pro');
});

function form(fields: Record<string, string | Blob>, key?: string): NextRequest {
  const body = new FormData();
  for (const [name, value] of Object.entries(fields)) {
    if (value instanceof Blob) body.append(name, value, 'many.tif');
    else body.append(name, value);
  }
  return new NextRequest('http://localhost/api/test', {
    method: 'POST',
    headers: key ? { Authorization: `Bearer ${key}` } : {},
    body,
  });
}

const tiffBlob = () => new Blob([new Uint8Array(manyPages())]);
const CLIENT_OPTIONS = JSON.stringify({ maxPages: HUGE_CLIENT_LIMIT });

async function expectFreeLimit(response: Response): Promise<void> {
  expect(response.status).toBe(400);
  expect(JSON.stringify(await response.json())).toContain(FREE_LIMIT_MESSAGE);
}

describe('synchronous routes ignore a client maxPages', () => {
  it('POST /api/convert', async () => {
    await expectFreeLimit(await convertPost(form({ file: tiffBlob(), targetFormat: 'png', options: CLIENT_OPTIONS }, free.key)));
  });

  it('POST /api/v1/convert', async () => {
    await expectFreeLimit(await v1ConvertPost(form({ file: tiffBlob(), targetFormat: 'png', options: CLIENT_OPTIONS }, free.key)));
  });

  it('POST /api/convert/batch, authenticated as a free account', async () => {
    const response = await batchPost(form({ files: tiffBlob(), targetFormats: JSON.stringify({ default: 'png' }), options: CLIENT_OPTIONS }, free.key));
    await expectFreeLimit(response);
  });

  it('POST /api/convert/batch, anonymous', async () => {
    const response = await batchPost(form({ files: tiffBlob(), targetFormats: JSON.stringify({ default: 'png' }), options: CLIENT_OPTIONS }));
    await expectFreeLimit(response);
  });

  it('POST /api/convert/batch, pro account converts every page', async () => {
    const response = await batchPost(form({ files: tiffBlob(), targetFormats: JSON.stringify({ default: 'png' }) }, pro.key));
    expect(response.status).toBe(HTTP_OK);
    const outer = await JSZip.loadAsync(Buffer.from(await response.arrayBuffer()));
    const names = Object.keys(outer.files);
    expect(names).toHaveLength(1);
    const inner = await JSZip.loadAsync(await outer.file(names[0])!.async('nodebuffer'));
    expect(Object.keys(inner.files)).toHaveLength(PAGES);
  });
});

describe('queued jobs take the limit from the job owner, not from the request', () => {
  async function run(jobId: string): Promise<{ outcome: 'completed' | 'failed'; detail: string }> {
    const job = (await conversionQueue.getJob(jobId)) as Job<ConversionJobData, ConversionJobResult>;
    try {
      await processConversionJob(job);
      return { outcome: 'completed', detail: '' };
    } catch (error) {
      return { outcome: 'failed', detail: error instanceof Error ? error.message : String(error) };
    }
  }

  const jsonJob = (key: string, options: Record<string, unknown>) =>
    new NextRequest('http://localhost/api/queue/jobs', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        filename: 'many.tif',
        targetFormat: 'png',
        options,
        inputBufferBase64: manyPages().toString('base64'),
        fileSize: manyPages().length,
      }),
    });

  it('/api/queue/jobs multipart branch', async () => {
    const res = await queueJobsPost(form({ file: tiffBlob(), targetFormat: 'png', options: CLIENT_OPTIONS }, free.key));
    const { jobId } = await res.json();
    const result = await run(jobId);
    expect(result.outcome).toBe('failed');
    expect(result.detail).toContain(FREE_LIMIT_MESSAGE);
  });

  it('/api/queue/jobs JSON branch', async () => {
    const { jobId } = await (await queueJobsPost(jsonJob(free.key, { maxPages: HUGE_CLIENT_LIMIT }))).json();
    const result = await run(jobId);
    expect(result.outcome).toBe('failed');
    expect(result.detail).toContain(FREE_LIMIT_MESSAGE);
  });

  it('/api/queue/jobs JSON branch for a pro owner converts every page', async () => {
    const { jobId } = await (await queueJobsPost(jsonJob(pro.key, {}))).json();
    expect((await run(jobId)).outcome).toBe('completed');
  });

  it('/api/v1/jobs', async () => {
    const request = new NextRequest('http://localhost/api/v1/jobs', {
      method: 'POST',
      headers: { Authorization: `Bearer ${free.key}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        filename: 'many.tif',
        targetFormat: 'png',
        options: { maxPages: HUGE_CLIENT_LIMIT },
        inputBufferBase64: manyPages().toString('base64'),
        fileSize: manyPages().length,
      }),
    });
    const { jobId } = await (await v1JobsPost(request)).json();
    const result = await run(jobId);
    expect(result.outcome).toBe('failed');
    expect(result.detail).toContain(FREE_LIMIT_MESSAGE);
  });

  it('a graph convert node takes the limit from its owner, not from its options', async () => {
    const key = `tests/page-cap/${Date.now()}_many.tif`;
    s3Storage.saveObject(key, manyPages(), 'image/tiff', 'many.tif', ONE_HOUR_MS);
    const nodeJob = (userId: string): Job<ConversionJobData, ConversionJobResult> => {
      const graphId = `g_cap_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      return {
        id: `${graphId}:n1`,
        data: {
          jobId: `${graphId}:n1`,
          sourceFormat: 'tiff',
          targetFormat: 'png',
          fileSize: 1,
          options: {},
          userId,
          graphId,
          graphNodeId: 'n1',
          graphNode: { op: 'convert', targetFormat: 'png', options: { maxPages: HUGE_CLIENT_LIMIT } },
          inputArtifacts: [key],
        },
        opts: { attempts: 1 },
        attemptsMade: 1,
        signal: new AbortController().signal,
        log: async () => {},
        updateProgress: async () => {},
      } as unknown as Job<ConversionJobData, ConversionJobResult>;
    };
    const error = await captureError(() => processGraphNodeJob(nodeJob(free.id), undefined, s3Storage));
    expect(error.message).toContain(FREE_LIMIT_MESSAGE);
    const proResult = await processGraphNodeJob(nodeJob(pro.id), undefined, s3Storage);
    expect(proResult.status).toBe('completed');
    const stored = s3Storage.getObject(proResult.resultKey);
    if (!stored) throw new Error(`The graph node stored no output under ${proResult.resultKey}`);
    const zip = await JSZip.loadAsync(stored.buffer);
    expect(Object.keys(zip.files)).toHaveLength(PAGES);
  });
});

describe('the engine reads only the server-side limit', () => {
  it('a maxPages in the options is not read', async () => {
    const error = await captureError(() => convertImage(manyPages(), 'png', { maxPages: HUGE_CLIENT_LIMIT } as never, 'many.tif', 'tiff'));
    expect(error.message).toContain(FREE_LIMIT_MESSAGE);
  });

  it.each([0, -3, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '10' as unknown as number])(
    'a server-side limit of %s is a typed error',
    async (limit) => {
      const options = { [TIER_PAGE_CAP]: limit };
      const error = await captureError(() => convertImage(manyPages(3), 'png', options as never, 'many.tif', 'tiff'));
      expect(error.name).toBe('InvalidPageRangeError');
      expect(error.message).toMatch(/Invalid page limit/);
    }
  );

  it('a server-side limit above the largest tier is held to it', async () => {
    const options = { [TIER_PAGE_CAP]: HUGE_CLIENT_LIMIT };
    const error = await captureError(() => convertImage(manyPages(ABSOLUTE_PAGE_LIMIT + 1), 'png', options as never, 'many.tif', 'tiff'));
    expect(error.message).toContain(`limit of ${ABSOLUTE_PAGE_LIMIT} pages`);
  });
});
