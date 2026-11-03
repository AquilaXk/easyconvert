import { describe, it, expect, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import JSZip from 'jszip';
import { POST as batchPost } from '../src/app/api/convert/batch/route';
import { POST as convertPost } from '../src/app/api/convert/route';
import { POST as v1ConvertPost } from '../src/app/api/v1/convert/route';
import { POST as v1JobsPost } from '../src/app/api/v1/jobs/route';
import { POST as queueJobsPost } from '../src/app/api/queue/jobs/route';
import { conversionQueue, processConversionJob } from '../src/lib/queue/conversion-queue';
import { processGraphNodeJob } from '../src/lib/queue/graph/node-executor';
import type { Job } from '../src/lib/queue/bullmq-engine';
import { s3Storage } from '../src/lib/storage/s3-storage';
import { redisKeyStore } from '../src/lib/api-keys/redis-key-store';
import { userStore } from '../src/lib/auth/user-store';
import type { ConversionJobData, ConversionJobResult } from '../src/lib/types';
import { buildBilevelTiff } from './helpers/tiff-builder';

/**
 * A multi-page conversion is the same for every caller on every route and queue path: a free account and an
 * anonymous caller convert every page of a document, as a pro account does (policy entry 16: no page limit).
 *
 * Oracle: the 60-page TIFFs come from the hand-written writer in tests/helpers/tiff-builder.ts; 60 is over the
 * 50 pages the free tier used to allow and under the guard every caller shares (500 pages, policy entry 44).
 */

const PAGES = 60;
const PAGE_SIDE = 8;
const HTTP_OK = 200;
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

/** Reads the ZIP of an answer: the body of `/api/convert`, or the data URI in the JSON of `/api/v1/convert`. */
async function zipOf(response: Response): Promise<JSZip> {
  expect(response.status).toBe(HTTP_OK);
  if (response.headers.get('content-type')?.includes('json')) {
    const body = await response.json();
    expect(body.mimeType).toBe('application/zip');
    expect(body.sourceFrameCount).toBe(PAGES);
    return JSZip.loadAsync(Buffer.from(String(body.dataUri).split(',')[1], 'base64'));
  }
  return JSZip.loadAsync(Buffer.from(await response.arrayBuffer()));
}

async function expectEveryPage(response: Response): Promise<void> {
  expect(Object.keys((await zipOf(response)).files)).toHaveLength(PAGES);
}

async function expectEveryPageInBatch(response: Response): Promise<void> {
  expect(response.status).toBe(HTTP_OK);
  const outer = await JSZip.loadAsync(Buffer.from(await response.arrayBuffer()));
  const names = Object.keys(outer.files);
  expect(names).toHaveLength(1);
  const inner = await JSZip.loadAsync(await outer.file(names[0])!.async('nodebuffer'));
  expect(Object.keys(inner.files)).toHaveLength(PAGES);
}

describe('synchronous routes convert every page of a document for every caller', () => {
  it.each([
    ['a free account', () => free.key],
    ['a pro account', () => pro.key],
  ])('POST /api/convert and /api/v1/convert, %s', async (_label, key) => {
    await expectEveryPage(await convertPost(form({ file: tiffBlob(), targetFormat: 'png' }, key())));
    await expectEveryPage(await v1ConvertPost(form({ file: tiffBlob(), targetFormat: 'png' }, key())));
  });

  it('POST /api/convert, anonymous', async () => {
    await expectEveryPage(await convertPost(form({ file: tiffBlob(), targetFormat: 'png' })));
  });

  it.each([
    ['a free account', () => free.key],
    ['a pro account', () => pro.key],
    ['an anonymous caller', () => undefined],
  ])('POST /api/convert/batch, %s', async (_label, key) => {
    await expectEveryPageInBatch(await batchPost(form({ files: tiffBlob(), targetFormats: JSON.stringify({ default: 'png' }) }, key())));
  });
});

describe('queued jobs convert every page for a free owner as for a pro owner', () => {
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
    const res = await queueJobsPost(form({ file: tiffBlob(), targetFormat: 'png' }, free.key));
    const { jobId } = await res.json();
    expect(await run(jobId)).toEqual({ outcome: 'completed', detail: '' });
  });

  it('/api/queue/jobs JSON branch', async () => {
    const { jobId } = await (await queueJobsPost(jsonJob(free.key, {}))).json();
    expect(await run(jobId)).toEqual({ outcome: 'completed', detail: '' });
  });

  it('/api/queue/jobs JSON branch for a pro owner', async () => {
    const { jobId } = await (await queueJobsPost(jsonJob(pro.key, {}))).json();
    expect(await run(jobId)).toEqual({ outcome: 'completed', detail: '' });
  });

  it('/api/v1/jobs', async () => {
    const request = new NextRequest('http://localhost/api/v1/jobs', {
      method: 'POST',
      headers: { Authorization: `Bearer ${free.key}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        filename: 'many.tif',
        targetFormat: 'png',
        inputBufferBase64: manyPages().toString('base64'),
        fileSize: manyPages().length,
      }),
    });
    const { jobId } = await (await v1JobsPost(request)).json();
    expect(await run(jobId)).toEqual({ outcome: 'completed', detail: '' });
  });

  it('a graph convert node converts every page for a free owner as for a pro owner', async () => {
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
          graphNode: { op: 'convert', targetFormat: 'png', options: {} },
          inputArtifacts: [key],
        },
        opts: { attempts: 1 },
        attemptsMade: 1,
        signal: new AbortController().signal,
        log: async () => {},
        updateProgress: async () => {},
      } as unknown as Job<ConversionJobData, ConversionJobResult>;
    };
    for (const owner of [free.id, pro.id]) {
      const result = await processGraphNodeJob(nodeJob(owner), undefined, s3Storage);
      expect(result.status).toBe('completed');
      const stored = s3Storage.getObject(result.resultKey);
      if (!stored) throw new Error(`The graph node stored no output under ${result.resultKey}`);
      expect(Object.keys((await JSZip.loadAsync(stored.buffer)).files)).toHaveLength(PAGES);
    }
  });
});
