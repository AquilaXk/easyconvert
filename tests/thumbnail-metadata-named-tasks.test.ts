import crypto from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import sharp from 'sharp';
import { POST as createJob } from '../src/app/api/v1/jobs/route';
import { GET as readJob } from '../src/app/api/v1/jobs/[id]/route';
import { userStore } from '../src/lib/auth/user-store';
import { redisKeyStore } from '../src/lib/api-keys/redis-key-store';
import { graphScheduler } from '../src/lib/queue/graph';
import { Worker } from '../src/lib/queue/bullmq-engine';
import { allConversionQueues, attachJobLifecycleListeners } from '../src/lib/queue/conversion-queue';
import { processNodeJob } from '../src/lib/queue/node-processor';
import { s3Storage } from '../src/lib/storage/s3-storage';
import { NAMED_TASK_OPERATIONS, publicOperationName } from '../src/lib/jobs/named-tasks';
import { readMetadata } from '../src/lib/jobs/metadata/read';
import type { ConversionJobData, ConversionJobResult } from '../src/lib/types';

/**
 * The thumbnail and metadata tasks by their names in a job of named tasks, run end to end by the worker with the real engines:
 * the metadata is written into a PNG, read back, and the thumbnail of the written picture is made.
 */

const WAIT = { timeout: 20_000, interval: 50 };
const TTL_MS = 60 * 60 * 1000;

let worker: Worker<ConversionJobData, ConversionJobResult> | undefined;

afterEach(async () => {
  await worker?.close();
  worker = undefined;
  vi.restoreAllMocks();
});

async function caller() {
  const user = userStore.sanitizeUser(await userStore.createUser({ email: `tm-named-${Date.now()}-${crypto.randomBytes(4).toString('hex')}@named.test`, name: 'Named', tier: 'pro' }));
  const { secretKey } = await redisKeyStore.generateApiKey(user.id, 'named tasks', { scopes: ['convert:write', 'convert:read'] });
  return { authorization: `Bearer ${secretKey}`, usedToday: async () => (await redisKeyStore.getQuotaUsage(user.id)).usedToday };
}

async function storedPicture(): Promise<string> {
  const key = `uploads/tm-named-${Date.now()}-${crypto.randomBytes(4).toString('hex')}/photo.png`;
  const png = await sharp({ create: { width: 200, height: 100, channels: 3, background: '#2a6' } }).png().toBuffer();
  await s3Storage.saveObject(key, png, 'image/png', 'photo.png', TTL_MS);
  return key;
}

function fileOf(result: { files: Array<{ filename: string; downloadUrl: string }> }): { filename: string; buffer: Buffer } {
  const [file] = result.files;
  const stored = s3Storage.getObject(decodeURIComponent(file.downloadUrl.slice('/api/storage/file/'.length)));
  if (!stored) throw new Error(`File ${file.filename} is missing from storage`);
  return { filename: file.filename, buffer: stored.buffer };
}

describe('the names of the tasks', () => {
  it('spells metadata.write as metadata/write and answers with the spelling it was sent in', () => {
    expect(NAMED_TASK_OPERATIONS).toEqual(expect.arrayContaining(['metadata/write', 'metadata', 'thumbnail']));
    expect(NAMED_TASK_OPERATIONS).not.toContain('metadata.write');
    expect(publicOperationName('metadata.write')).toBe('metadata/write');
  });
});

describe('thumbnail and metadata tasks of one job', () => {
  it('writes metadata into a picture, reads it back, and makes its thumbnail, charging one unit for each', async () => {
    worker = new Worker<ConversionJobData, ConversionJobResult>([...allConversionQueues] as never, (job) => processNodeJob(job), { concurrency: 2 });
    attachJobLifecycleListeners(worker);
    const who = await caller();
    const tasks = {
      up: { operation: 'import/upload', storage_key: await storedPicture() },
      tag: { operation: 'metadata/write', input: 'up', options: { metadata: { set: { Artist: 'Ann', 'XMP:Title': 'Sunrise' } } } },
      read: { operation: 'metadata', input: 'tag' },
      thumb: { operation: 'thumbnail', input: 'tag', output_format: 'webp', options: { thumbnail: { width: 50, height: 50, fit: 'cover' } } },
      'out-tag': { operation: 'export/url', input: 'tag' },
      'out-read': { operation: 'export/url', input: 'read' },
      'out-thumb': { operation: 'export/url', input: 'thumb' },
    };

    const created = await (await createJob(new NextRequest('http://localhost/api/v1/jobs', { method: 'POST', headers: { 'content-type': 'application/json', authorization: who.authorization }, body: JSON.stringify({ tasks }) }))).json();
    expect(created.tasks.tag).toMatchObject({ operation: 'metadata/write', input: ['up'] });
    expect(created.tasks.read).toMatchObject({ operation: 'metadata', input: ['tag'] });

    await vi.waitFor(async () => expect(['completed', 'failed']).toContain((await graphScheduler.getGraphState(created.jobId))?.status), WAIT);
    const res = await readJob(new NextRequest(`http://localhost/api/v1/jobs/${created.jobId}`, { headers: { authorization: who.authorization } }), { params: Promise.resolve({ id: created.jobId }) });
    const body = await res.json();
    expect(body.status, JSON.stringify(body)).toBe('completed');

    const written = fileOf(body.tasks['out-tag'].result);
    expect(written.filename).toBe('photo.png');
    expect((await readMetadata(written.buffer, 'photo.png')).EXIF).toEqual({ Artist: 'Ann' });

    const report = JSON.parse(fileOf(body.tasks['out-read'].result).buffer.toString('utf8'));
    expect(report).toMatchObject({ schemaVersion: 1, File: { FileName: 'photo.png' }, Image: { ImageWidth: 200, ImageHeight: 100 }, EXIF: { Artist: 'Ann' }, XMP: { Title: 'Sunrise' } });

    const thumb = fileOf(body.tasks['out-thumb'].result);
    const meta = await sharp(thumb.buffer).metadata();
    expect([meta.format, meta.width, meta.height]).toEqual(['webp', 50, 50]);
    await vi.waitFor(async () => expect(await who.usedToday()).toBe(3), WAIT);
  }, 40_000);
});
