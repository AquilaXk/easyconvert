import crypto from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { POST as jobsPost } from '../src/app/api/v1/jobs/route';
import { redisKeyStore } from '../src/lib/api-keys/redis-key-store';
import { WebhookDispatcher, webhookDispatcher } from '../src/lib/api-keys/webhook-dispatcher';
import { InMemoryWebhookSecretStore, setWebhookSecretStore } from '../src/lib/api-keys/webhook-secret-store';
import { userStore } from '../src/lib/auth/user-store';
import type { User } from '../src/lib/auth/types';
import { InMemoryGraphScheduler } from '../src/lib/queue/graph/in-memory-scheduler';
import { sealGraph } from '../src/lib/queue/graph/node-jobs';
import { attachJobLifecycleListeners, resourceQueues } from '../src/lib/queue/conversion-queue';
import { Queue, Worker } from '../src/lib/queue/bullmq-engine';
import { resolveEffectiveWebhook } from '../src/lib/security/ssrf';
import type { ConversionJobData, ConversionJobResult } from '../src/lib/types';

/**
 * A webhook that an API key owns is signed with the key's rotated secret: the job that carries the key's webhook names the
 * key as the target of its secret, so the dispatcher reads the rotation record, signs with the current secret, and adds the
 * previous one until its grace period ends.
 */

const HOOK_URL = 'https://93.184.215.14/hook';
const STALE_SECRET = 'whsec_issued_with_the_key';
const KEK = 'test-enterprise-kek-32-byte-secret-key-1234';

interface Delivery {
  deliveryId: string;
  timestamp: number;
  body: string;
  signature: string;
}

let user: User;
let keyId: string;
let currentSecret: string;
let deliveries: Delivery[];
let originalKek: string | undefined;

function signedWith(delivery: Delivery, secret: string): string {
  return `v1,${crypto.createHmac('sha256', secret).update(`${delivery.deliveryId}.${delivery.timestamp}.${delivery.body}`).digest('base64')}`;
}

beforeEach(async () => {
  originalKek = process.env.WEBHOOK_SECRET_KEK;
  process.env.WEBHOOK_SECRET_KEK = KEK;
  const store = new InMemoryWebhookSecretStore();
  setWebhookSecretStore(store);
  user = await userStore.createUser({ name: 'Hook Owner', email: `hook_${Date.now()}_${crypto.randomBytes(4).toString('hex')}@rotation.test`, tier: 'pro' });
  const created = await redisKeyStore.generateApiKey(user.id, 'Hook key', {
    scopes: ['convert:write'],
    webhookUrl: HOOK_URL,
    webhookSecret: STALE_SECRET,
  });
  keyId = created.key.id;
  // The secret issued with the key is the first one the rotation store holds; one rotation replaces it.
  await store.setPrimarySecret(user.id, keyId, STALE_SECRET);
  currentSecret = (await store.rotateSecret(user.id, keyId, 3600)).newSecret;
  deliveries = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation((async (_url: unknown, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    deliveries.push({
      deliveryId: headers.get('webhook-id') ?? '',
      timestamp: Number(headers.get('webhook-timestamp')),
      body: String(init?.body),
      signature: headers.get('webhook-signature') ?? '',
    });
    return new Response('ok', { status: 200 });
  }) as typeof fetch);
});

afterEach(async () => {
  vi.restoreAllMocks();
  setWebhookSecretStore(null);
  if (originalKek === undefined) delete process.env.WEBHOOK_SECRET_KEK;
  else process.env.WEBHOOK_SECRET_KEK = originalKek;
  await webhookDispatcher.clearDlq(user.id);
});

const result: ConversionJobResult = {
  jobId: 'j',
  status: 'completed',
  resultKey: 'results/j/out.pdf',
  downloadUrl: '/api/storage/file/results%2Fj%2Fout.pdf',
  filename: 'out.pdf',
  mimeType: 'application/pdf',
  size: 1,
  durationMs: 1,
};

/** Runs one job whose handler ends as `outcome` through a worker with the lifecycle listeners, and waits for its webhook. */
async function runJob(data: Partial<ConversionJobData>, outcome: 'completed' | 'failed'): Promise<void> {
  const queue = new Queue<ConversionJobData, ConversionJobResult>(`rotated-secret-${crypto.randomBytes(4).toString('hex')}`);
  const worker = new Worker<ConversionJobData, ConversionJobResult>(
    queue,
    async () => {
      if (outcome === 'failed') throw new Error('conversion failed');
      return result;
    },
    { concurrency: 1 }
  );
  attachJobLifecycleListeners(worker);
  try {
    const ended = new Promise<void>((resolve) => worker.on(outcome, () => resolve()));
    await queue.add(
      'convert',
      { jobId: '', originalFilename: 'a.txt', sourceFormat: 'txt', targetFormat: 'pdf', fileSize: 1, options: {}, userId: user.id, ...data },
      { attempts: 1 }
    );
    await ended;
    await vi.waitFor(() => expect(deliveries.length).toBeGreaterThan(0));
  } finally {
    await worker.close();
    await queue.close();
  }
}

describe('which webhook a job inherits from its API key', () => {
  it('names the key only when the webhook url and secret both come from it', () => {
    expect(resolveEffectiveWebhook(undefined, undefined, HOOK_URL, STALE_SECRET, 'key-1')).toEqual({ webhookUrl: HOOK_URL, webhookSecret: STALE_SECRET, webhookKeyId: 'key-1' });
    expect(resolveEffectiveWebhook('https://93.184.215.14/other', 'whsec_other', HOOK_URL, STALE_SECRET, 'key-1').webhookKeyId).toBeUndefined();
    expect(resolveEffectiveWebhook(undefined, 'whsec_other', HOOK_URL, STALE_SECRET, 'key-1').webhookKeyId).toBeUndefined();
    expect(resolveEffectiveWebhook(undefined, undefined, undefined, undefined, 'key-1').webhookKeyId).toBeUndefined();
  });

  it('is recorded on the job a key submits, and not on a job that brings its own webhook', async () => {
    const { secretKey } = await redisKeyStore.generateApiKey(user.id, 'Submitter', { scopes: ['convert:write'], webhookUrl: HOOK_URL, webhookSecret: STALE_SECRET });
    const submit = async (extra: Record<string, unknown>) => {
      const res = await jobsPost(
        new NextRequest('http://localhost/api/v1/jobs', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secretKey}` },
          body: JSON.stringify({ filename: 'a.txt', targetFormat: 'pdf', inputBufferBase64: Buffer.from('hello').toString('base64'), ...extra }),
        })
      );
      expect(res.status).toBe(202);
      const { jobId } = await res.json();
      for (const queue of Object.values(resourceQueues)) {
        const job = await queue.getJob(jobId);
        if (job) return job.data;
      }
      throw new Error(`job ${jobId} is in no queue`);
    };
    const submitted = (await redisKeyStore.listApiKeys(user.id)).find((key) => key.prefix === secretKey.slice(0, 12) + '...');

    expect((await submit({})).webhookKeyId).toBe(submitted?.id);
    expect((await submit({ webhookUrl: 'https://93.184.215.14/mine', webhookSecret: 'whsec_mine' })).webhookKeyId).toBeUndefined();
  });
});

describe('the webhook of a job that ends, after the key rotated its secret', () => {
  it.each(['completed', 'failed'] as const)('signs job.%s with the current secret and the previous one during the grace period', async (outcome) => {
    await runJob({ webhookUrl: HOOK_URL, webhookSecret: currentSecret, webhookKeyId: keyId }, outcome);

    const [delivery] = deliveries;
    expect(delivery.signature).toBe(`${signedWith(delivery, currentSecret)} ${signedWith(delivery, STALE_SECRET)}`);
    expect(WebhookDispatcher.verifyStandardSignature(delivery.deliveryId, delivery.timestamp, delivery.body, delivery.signature, currentSecret)).toBe(true);
  });

  it('signs a job queued before the rotation with the current secret too, not only with the one it was queued with', async () => {
    await runJob({ webhookUrl: HOOK_URL, webhookSecret: STALE_SECRET, webhookKeyId: keyId }, 'completed');

    const [delivery] = deliveries;
    expect(delivery.signature).toBe(`${signedWith(delivery, currentSecret)} ${signedWith(delivery, STALE_SECRET)}`);
  });

  it('keeps signing a job that names no key with the secret it carries, whatever the key rotated', async () => {
    await runJob({ webhookUrl: HOOK_URL, webhookSecret: STALE_SECRET }, 'completed');

    const [delivery] = deliveries;
    expect(delivery.signature).toBe(signedWith(delivery, STALE_SECRET));
  });
});

describe('the webhook of a graph that ends', () => {
  const graph = (graphId: string) =>
    sealGraph(graphId, {
      failurePolicy: 'fail_fast' as const,
      nodes: {
        upload: { op: 'import.upload' as const, storageKey: `uploads/${graphId}/in.csv` },
        json: { op: 'convert' as const, input: 'upload', targetFormat: 'json' },
      },
    });

  it('names the key that owns the webhook, so its rotated secret signs graph.failed', async () => {
    const dispatched = vi.spyOn(webhookDispatcher, 'dispatch').mockResolvedValue({ success: true, totalAttempts: 1 } as never);
    const scheduler = new InMemoryGraphScheduler();
    const graphId = `graph_rotated_${Date.now()}`;
    await scheduler.initGraph(graphId, graph(graphId), { ownerUserId: user.id, webhookUrl: HOOK_URL, webhookSecret: STALE_SECRET, webhookKeyId: keyId });

    await scheduler.onNodeFailed(graphId, 'upload', 'upload failed');

    expect(dispatched).toHaveBeenCalledTimes(1);
    expect(dispatched.mock.calls[0][1]).toBe('graph.failed');
    expect(dispatched.mock.calls[0][4]).toMatchObject({ ownerUserId: user.id, ownerKeyId: keyId });
  });

  it('names no key for a graph with a webhook of its own', async () => {
    const dispatched = vi.spyOn(webhookDispatcher, 'dispatch').mockResolvedValue({ success: true, totalAttempts: 1 } as never);
    const scheduler = new InMemoryGraphScheduler();
    const graphId = `graph_own_hook_${Date.now()}`;
    await scheduler.initGraph(graphId, graph(graphId), { ownerUserId: user.id, webhookUrl: HOOK_URL, webhookSecret: 'whsec_mine' });

    await scheduler.onNodeFailed(graphId, 'upload', 'upload failed');

    expect(dispatched.mock.calls[0][4]).toEqual({ ownerUserId: user.id, ownerKeyId: undefined });
  });
});
