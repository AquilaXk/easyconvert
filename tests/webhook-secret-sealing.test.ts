import crypto from 'node:crypto';
import Redis from 'ioredis';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { webhookDispatcher } from '../src/lib/api-keys/webhook-dispatcher';
import { InMemoryWebhookSecretStore, setWebhookSecretStore } from '../src/lib/api-keys/webhook-secret-store';
import { Queue, Worker } from '../src/lib/queue/bullmq-engine';
import { attachJobLifecycleListeners, conversionQueue } from '../src/lib/queue/conversion-queue';
import { enqueueConversionJob } from '../src/lib/queue/enqueue';
import { graphScheduler } from '../src/lib/queue/graph';
import { sealGraph } from '../src/lib/queue/graph/node-jobs';
import { SEALED_PREFIX, SecretSealError } from '../src/lib/security/job-secret-seal';
import { openWebhookSecret, sealWebhookSecret } from '../src/lib/security/sealed-webhook-secret';
import type { ConversionJobData, ConversionJobResult } from '../src/lib/types';

/**
 * The signing secret of a webhook is a bearer secret like the password of a job: the conversion job, the graph state and the
 * delivery job of the webhook queue hold it sealed, the process that signs a delivery opens it, and the graph keys and the
 * delivery jobs expire. The Redis half reads every key of the database for the plaintext.
 */

const HOOK_URL = 'https://93.184.215.14/hook';
const REDIS_URL = process.env.REDIS_URL;
const KEK = 'test-enterprise-kek-32-byte-secret-key-1234';

function uniqueSecret(label: string): string {
  return `whsec_${label}_${crypto.randomBytes(12).toString('hex')}`;
}

describe('sealing a webhook secret for a record', () => {
  it('opens only for the record it was sealed for', () => {
    const sealed = sealWebhookSecret('whsec_plain', 'job-1');
    expect(sealed).toMatch(new RegExp(`^${SEALED_PREFIX}`));
    expect(sealed).not.toContain('whsec_plain');
    expect(openWebhookSecret(sealed, 'job-1')).toBe('whsec_plain');
    expect(() => openWebhookSecret(sealed, 'job-2')).toThrow(SecretSealError);
  });

  it('leaves an empty secret and a secret queued before sealing existed as they are', () => {
    expect(sealWebhookSecret('', 'job-1')).toBe('');
    expect(sealWebhookSecret(undefined, 'job-1')).toBeUndefined();
    expect(openWebhookSecret('whsec_legacy_plain', 'job-1')).toBe('whsec_legacy_plain');
    expect(openWebhookSecret(undefined, 'job-1')).toBeUndefined();
  });
});

describe('the webhook secret of a conversion job', () => {
  let deliveries: Array<{ url: string; signature: string; body: string; id: string; timestamp: string }>;

  beforeEach(() => {
    vi.stubEnv('WEBHOOK_SECRET_KEK', KEK);
    setWebhookSecretStore(new InMemoryWebhookSecretStore());
    deliveries = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation((async (url: unknown, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      deliveries.push({
        url: String(url),
        signature: headers.get('webhook-signature') ?? '',
        body: String(init?.body),
        id: headers.get('webhook-id') ?? '',
        timestamp: headers.get('webhook-timestamp') ?? '',
      });
      return new Response('ok', { status: 200 });
    }) as typeof fetch);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    setWebhookSecretStore(null);
  });

  it('is stored sealed, and the worker signs the delivery with the plaintext', async () => {
    const secret = uniqueSecret('conv');
    const queue = new Queue<ConversionJobData, ConversionJobResult>(`sealed-hook-${crypto.randomBytes(4).toString('hex')}`);
    const worker = new Worker<ConversionJobData, ConversionJobResult>(
      queue,
      async () => ({ jobId: 'j', status: 'completed', resultKey: 'results/j/o.pdf', downloadUrl: '/d', filename: 'o.pdf', mimeType: 'application/pdf', size: 1, durationMs: 1 }),
      { concurrency: 1 }
    );
    attachJobLifecycleListeners(worker);
    try {
      const ended = new Promise<void>((resolve) => worker.on('completed', () => resolve()));
      const job = await enqueueConversionJob(
        queue,
        'convert',
        { jobId: '', originalFilename: 'a.txt', sourceFormat: 'txt', targetFormat: 'pdf', fileSize: 1, options: {}, webhookUrl: HOOK_URL, webhookSecret: secret },
        { attempts: 1 },
        {}
      );
      // The record a Redis queue stores is this data; the in-process queue keeps the same object.
      expect(JSON.stringify(job.data)).not.toContain(secret);
      expect(job.data.webhookSecret).toMatch(new RegExp(`^${SEALED_PREFIX}`));
      await ended;
      await vi.waitFor(() => expect(deliveries.length).toBeGreaterThan(0));
    } finally {
      await worker.close();
      await queue.close();
    }

    const delivery = deliveries[0];
    const expected = `v1,${crypto.createHmac('sha256', secret).update(`${delivery.id}.${delivery.timestamp}.${delivery.body}`).digest('base64')}`;
    expect(delivery.signature.split(' ')).toContain(expected);
  });

  it('sends no delivery, and logs without the value, when the sealed secret cannot be opened', async () => {
    const queue = new Queue<ConversionJobData, ConversionJobResult>(`sealed-hook-bad-${crypto.randomBytes(4).toString('hex')}`);
    const worker = new Worker<ConversionJobData, ConversionJobResult>(
      queue,
      async () => ({ jobId: 'j', status: 'completed', resultKey: 'results/j/o.pdf', downloadUrl: '/d', filename: 'o.pdf', mimeType: 'application/pdf', size: 1, durationMs: 1 }),
      { concurrency: 1 }
    );
    attachJobLifecycleListeners(worker);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const saveToDlq = vi.spyOn(webhookDispatcher, 'saveToDlq').mockResolvedValue(undefined as never);
    try {
      const ended = new Promise<void>((resolve) => worker.on('completed', () => resolve()));
      // A blob sealed for another job: it fails authentication here.
      await queue.add(
        'convert',
        { jobId: '', originalFilename: 'a.txt', sourceFormat: 'txt', targetFormat: 'pdf', fileSize: 1, options: {}, webhookUrl: HOOK_URL, webhookSecret: sealWebhookSecret('whsec_x', 'another-job') as string },
        { attempts: 1 }
      );
      await ended;
      await vi.waitFor(() => expect(saveToDlq).toHaveBeenCalled());
    } finally {
      await worker.close();
      await queue.close();
    }
    expect(deliveries).toEqual([]);
    expect(JSON.stringify(errors.mock.calls)).not.toContain('whsec_x');
  });
});

// skip-ok: mode selection. The shards run without REDIS_URL; the Redis-mode CI step (npm run test:redis) sets it and runs this file.
describe.skipIf(!REDIS_URL)('the webhook secret on a real Redis server', () => {
  let redis: Redis;

  beforeAll(() => {
    redis = new Redis(REDIS_URL as string, { maxRetriesPerRequest: 1 });
  });

  afterAll(async () => {
    await webhookDispatcher.getWorker().close();
    await webhookDispatcher.getQueue().close();
    await redis.quit();
  });

  beforeEach(() => {
    vi.stubEnv('WEBHOOK_SECRET_KEK', KEK);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  async function keysHolding(text: string): Promise<string[]> {
    const holding: string[] = [];
    let cursor = '0';
    do {
      const [next, keys] = await redis.scan(cursor, 'MATCH', '*', 'COUNT', 500);
      cursor = next;
      for (const key of keys) {
        const type = await redis.type(key);
        const value =
          type === 'string' ? await redis.get(key)
          : type === 'hash' ? JSON.stringify(await redis.hgetall(key))
          : type === 'list' ? JSON.stringify(await redis.lrange(key, 0, -1))
          : type === 'zset' ? JSON.stringify(await redis.zrange(key, '0', '-1', 'WITHSCORES'))
          : type === 'set' ? JSON.stringify(await redis.smembers(key))
          : '';
        if (value?.includes(text)) holding.push(key);
      }
    } while (cursor !== '0');
    return holding;
  }

  it('holds a queued conversion job with a sealed webhook secret only', async () => {
    const secret = uniqueSecret('redis-job');
    const job = await enqueueConversionJob(
      conversionQueue,
      'convert',
      { jobId: '', originalFilename: 'a.txt', sourceFormat: 'txt', targetFormat: 'pdf', fileSize: 1, options: {}, inputBufferBase64: Buffer.from('x').toString('base64'), webhookUrl: HOOK_URL, webhookSecret: secret },
      { attempts: 1 },
      {}
    );
    try {
      expect(await keysHolding(secret)).toEqual([]);
      expect(await keysHolding(SEALED_PREFIX)).not.toEqual([]);
    } finally {
      await conversionQueue.remove(job.id);
    }
  });

  it('holds a graph with a sealed webhook secret, gives every key of it a lifetime, and reads the plaintext back', async () => {
    const secret = uniqueSecret('redis-graph');
    const graphId = `sealed_graph_${crypto.randomBytes(6).toString('hex')}`;
    const graph = sealGraph(graphId, {
      failurePolicy: 'fail_fast',
      nodes: { in: { op: 'import.url', url: 'https://93.184.215.14/in.csv' }, out: { op: 'export.internal', input: 'in' } },
    });

    await graphScheduler.initGraph(graphId, graph, { ownerUserId: 'user-sealed-graph', webhookUrl: HOOK_URL, webhookSecret: secret });
    try {
      expect(await keysHolding(secret)).toEqual([]);
      expect((await graphScheduler.getGraphState(graphId))?.webhookSecret).toBe(secret);
      const graphKeys = await redis.keys(`*graph:{${graphId}}*`);
      expect(graphKeys.length).toBeGreaterThanOrEqual(4);
      for (const key of graphKeys) expect(await redis.pttl(key), key).toBeGreaterThan(0);
    } finally {
      await graphScheduler.deleteGraph(graphId);
    }
  });

  it('holds a queued webhook delivery with a sealed secret only, and gives the ended jobs a lifetime', async () => {
    const secret = uniqueSecret('redis-delivery');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('no', { status: 500 }));

    const job = await webhookDispatcher.enqueueDelivery(HOOK_URL, 'job.completed', { jobId: 'j' }, secret, { deliveryId: `wh_sealed_${crypto.randomBytes(4).toString('hex')}` });

    expect(job.opts?.removeOnComplete).toBeDefined();
    expect(job.opts?.removeOnFail).toBeDefined();
    expect(job.opts?.removeDataOnFinish).toContain('secret');
    // Wherever the job is by now (waiting, active, or delayed for the retry), no key holds the plaintext.
    expect(await keysHolding(secret)).toEqual([]);
  });
});
