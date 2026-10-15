import dns from 'node:dns';
import { describe, it, expect, beforeEach, afterEach, vi, type MockInstance } from 'vitest';
import { NextRequest } from 'next/server';
import { POST as createJob } from '../src/app/api/v1/jobs/route';
import { GET as getJob } from '../src/app/api/v1/jobs/[id]/route';
import { Queue, Worker } from '../src/lib/queue/bullmq-engine';
import { graphScheduler } from '../src/lib/queue/graph';
import { MAX_SEALED_HEADERS, MAX_SEALED_HEADER_VALUE_CHARS, MAX_SEALED_URL_CHARS } from '../src/lib/queue/graph/sealed-nodes';
import { MAX_REDACTION_DEPTH, MAX_REDACTION_NODES } from '../src/lib/security/redact';
import { SecretSealError } from '../src/lib/security/job-secret-seal';
import { webhookDispatcher } from '../src/lib/api-keys/webhook-dispatcher';
import { toPublicDlqEntry } from '../src/lib/api-keys/public-views';
import { redisKeyStore } from '../src/lib/api-keys/redis-key-store';
import { userStore } from '../src/lib/auth/user-store';
import { s3Storage } from '../src/lib/storage/s3-storage';
import type { User } from '../src/lib/auth/types';
import type { WebhookDlqEntry } from '../src/lib/api-keys/types';

/**
 * Anything the API accepts must be storable and showable: structures beyond the redaction limits
 * and secrets beyond the sealing limits are refused with a typed 400 before any job exists, and
 * the response paths that run after work has started never throw.
 */
const BASE_URL = 'https://easyconvert.app';
const PUBLIC_IP = '93.184.215.14';
const LEAF_SECRET = 'password=hunter2-leaf';
const HEADER_COUNT_OVER_LIMIT = MAX_SEALED_HEADERS + 1;

function nested(levels: number): Record<string, unknown> {
  let value: Record<string, unknown> = { leaf: LEAF_SECRET };
  for (let i = 0; i < levels; i++) {
    value = { child: value };
  }
  return value;
}

describe('submission limits', () => {
  let user: User;
  let authHeaders: Record<string, string>;
  let storageKey: string;
  let initGraph: MockInstance<typeof graphScheduler.initGraph>;

  beforeEach(async () => {
    vi.spyOn(dns.promises, 'lookup').mockImplementation((async () => [{ address: PUBLIC_IP, family: 4 }]) as never);
    const email = `limits_${Date.now()}_${Math.random().toString(36).slice(2)}@limits.test`;
    user = userStore.sanitizeUser(await userStore.createUser({ email, name: 'limits', tier: 'pro' }));
    const { secretKey } = await redisKeyStore.generateApiKey(user.id, 'limits', { scopes: ['convert:read', 'convert:write'] });
    authHeaders = { Authorization: `Bearer ${secretKey}`, 'Content-Type': 'application/json' };
    storageKey = `uploads/${user.id}/limits.csv`;
    s3Storage.saveObject(storageKey, Buffer.from('a,b\n1,2\n'), 'text/csv', 'limits.csv');
    initGraph = vi.spyOn(graphScheduler, 'initGraph');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function post(body: Record<string, unknown>) {
    const quotaBefore = JSON.stringify(await redisKeyStore.getQuotaUsage(user.id));
    const res = await createJob(
      new NextRequest(`${BASE_URL}/api/v1/jobs`, { method: 'POST', headers: authHeaders, body: JSON.stringify(body) })
    );
    const text = await res.text();
    const quotaAfter = JSON.stringify(await redisKeyStore.getQuotaUsage(user.id));
    return { status: res.status, text, json: JSON.parse(text), quotaUnchanged: quotaBefore === quotaAfter };
  }

  function urlGraph(node: Record<string, unknown>) {
    return {
      graph: {
        nodes: {
          in: { op: 'import.url', ...node },
          out: { op: 'export.internal', input: 'in' },
        },
      },
      targetFormat: 'csv',
      filename: 'data.csv',
    };
  }

  function expectRefused(result: Awaited<ReturnType<typeof post>>, path: string) {
    expect(result.status, result.text).toBe(400);
    expect(result.json.invalidParams.map((p: { name: string }) => p.name)).toContain(path);
    expect(initGraph).not.toHaveBeenCalled();
    expect(result.quotaUnchanged).toBe(true);
    expect(result.text).not.toContain(LEAF_SECRET);
  }

  const convertGraph = (options: unknown) => ({
    graph: {
      nodes: {
        up: { op: 'import.upload', storageKey },
        conv: { op: 'convert', input: 'up', targetFormat: 'json', options },
        out: { op: 'export.internal', input: 'conv' },
      },
    },
    storageKey,
    filename: 'limits.csv',
  });

  it('refuses options nested beyond the redaction depth, creates no graph and leaves the quota alone', async () => {
    const result = await post(convertGraph({ extra: nested(MAX_REDACTION_DEPTH + 8) }));
    expectRefused(result, 'graph');
  });

  it('refuses a graph with more values than the redaction limit', async () => {
    const result = await post(convertGraph({ extra: new Array(MAX_REDACTION_NODES + 1).fill(0) }));
    expectRefused(result, 'graph');
  });

  it('refuses linear tasks nested beyond the limits', async () => {
    const result = await post({
      tasks: [{ name: 'c', operation: 'convert', targetFormat: 'json', options: { extra: nested(MAX_REDACTION_DEPTH + 8) } }],
      storageKey,
      filename: 'limits.csv',
    });
    expectRefused(result, 'tasks');
  });

  it('refuses a URL longer than the sealing limit', async () => {
    const result = await post(urlGraph({ url: `https://files.example.org/data.csv?sig=${'a'.repeat(MAX_SEALED_URL_CHARS)}` }));
    expectRefused(result, 'graph.nodes.in.url');
  });

  it('refuses more headers than the sealing limit', async () => {
    const headers = Object.fromEntries(Array.from({ length: HEADER_COUNT_OVER_LIMIT }, (_, i) => [`x-h-${i}`, 'v']));
    const result = await post(urlGraph({ url: 'https://files.example.org/data.csv', headers }));
    expectRefused(result, 'graph.nodes.in.headers');
  });

  it('refuses a header value longer than the sealing limit', async () => {
    const headers = { 'x-big': 'v'.repeat(MAX_SEALED_HEADER_VALUE_CHARS + 1) };
    const result = await post(urlGraph({ url: 'https://files.example.org/data.csv', headers }));
    expectRefused(result, 'graph.nodes.in.headers.x-big');
  });

  it('refuses secrets that are small one by one but too large together', async () => {
    const headers = Object.fromEntries(Array.from({ length: MAX_SEALED_HEADERS }, (_, i) => [`x-h-${i}`, 'v'.repeat(MAX_SEALED_HEADER_VALUE_CHARS)]));
    const result = await post(urlGraph({ url: 'https://files.example.org/data.csv', headers }));
    expectRefused(result, 'graph.nodes.in');
  });

  it('refuses an export URL of a linear task longer than the sealing limit', async () => {
    const result = await post({
      tasks: [{ name: 'upload', operation: 'export/url', url: `https://dav.example.org/o?sig=${'a'.repeat(MAX_SEALED_URL_CHARS)}` }],
      storageKey,
      filename: 'limits.csv',
    });
    expectRefused(result, 'tasks.0.url');
  });

  it('answers 400 and rolls the quota back when sealing still reports an oversized secret', async () => {
    initGraph.mockRejectedValueOnce(new SecretSealError('PLAINTEXT_TOO_LARGE', '[JobSecretSeal] Secret is larger than the limit.'));
    const result = await post(urlGraph({ url: 'https://files.example.org/data.csv' }));
    expect(result.status, result.text).toBe(400);
    expect(result.quotaUnchanged).toBe(true);
  });

  it('still accepts a graph at the limits', async () => {
    const headers = Object.fromEntries(Array.from({ length: 4 }, (_, i) => [`x-h-${i}`, 'v'.repeat(1024)]));
    const result = await post({
      ...urlGraph({ url: `https://files.example.org/data.csv?sig=${'a'.repeat(MAX_SEALED_URL_CHARS - 64)}`, headers }),
    });
    expect(result.status, result.text).toBe(202);
    await graphScheduler.cancelGraph(result.json.jobId, 'test cleanup');
  });
});

describe('output paths never throw on oversized structures', () => {
  it('GET stays stable for a graph and tasks stored beyond the redaction limits', async () => {
    const email = `limits_get_${Date.now()}_${Math.random().toString(36).slice(2)}@limits.test`;
    const user = userStore.sanitizeUser(await userStore.createUser({ email, name: 'limits', tier: 'pro' }));
    const { secretKey } = await redisKeyStore.generateApiKey(user.id, 'limits', { scopes: ['convert:read', 'convert:write'] });
    const graphId = `g_deep_${Date.now()}`;
    // Reaches the scheduler without the API's checks, as a graph stored by an older version would.
    await graphScheduler.initGraph(
      graphId,
      {
        nodes: {
          up: { op: 'import.upload', storageKey: `uploads/${user.id}/x.csv` },
          conv: { op: 'convert', input: 'up', targetFormat: 'json', options: { extra: nested(MAX_REDACTION_DEPTH + 8) } as never },
          out: { op: 'export.internal', input: 'conv' },
        },
      },
      { ownerUserId: user.id, tasks: [{ name: 'c', options: nested(MAX_REDACTION_DEPTH + 8) }] }
    );

    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await getJob(
        new NextRequest(`${BASE_URL}/api/v1/jobs/${graphId}`, { headers: { Authorization: `Bearer ${secretKey}` } }),
        { params: { id: graphId } }
      );
      const text = await res.text();
      expect(res.status, text).toBe(200);
      expect(text).not.toContain('hunter2-leaf');
      expect(JSON.parse(text).graph.nodes.conv.targetFormat).toBe('json');
      expect(JSON.parse(text).tasks[0].name).toBe('c');
      expect(text).toContain('"***"');
    }
    await graphScheduler.cancelGraph(graphId, 'test cleanup');
  });

  it('a dead-letter view of a payload beyond the limits is masked, not thrown', () => {
    const entry: WebhookDlqEntry = {
      id: 'dlq_deep',
      originalDeliveryId: 'wh_deep',
      targetUrl: 'https://93.184.215.14/hook',
      event: 'job.failed',
      payload: nested(MAX_REDACTION_DEPTH + 8),
      secret: 's',
      failedAt: 1,
      retryCount: 1,
      status: 'failed',
    };
    const view = toPublicDlqEntry(entry);
    expect(view.id).toBe('dlq_deep');
    expect(view.targetUrl).toBe('https://93.184.215.14/hook');
    expect(JSON.stringify(view)).not.toContain('hunter2-leaf');
    expect(JSON.stringify(view.payload)).toContain('"***"');
  });

  it('a webhook delivery of a payload beyond the limits is sent masked', async () => {
    const bodies: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      bodies.push(String((init as RequestInit).body));
      return new Response('ok', { status: 200 });
    });
    const result = await webhookDispatcher.dispatch('https://93.184.215.14/hook', 'job.failed', { jobId: 'j', deep: nested(MAX_REDACTION_DEPTH + 8) }, 'sec', {
      maxRetries: 1,
      skipDlq: true,
    });
    expect(result.success).toBe(true);
    expect(bodies[0]).not.toContain('hunter2-leaf');
    expect(JSON.parse(bodies[0]).data.jobId).toBe('j');
    vi.restoreAllMocks();
  });

  it('a dead-letter entry of a job with data beyond the limits keeps the rest of the data', async () => {
    const queue = new Queue<Record<string, unknown>, string>(`limits-dlq-${Date.now()}`);
    const worker = new Worker<Record<string, unknown>, string>(
      [queue],
      async () => {
        throw new Error('boom');
      },
      { concurrency: 1 }
    );
    const failed = new Promise<void>((resolve) => worker.once('failed', () => resolve()));
    await queue.add('convert', { keep: 'me', deep: nested(MAX_REDACTION_DEPTH + 8) }, { attempts: 1 });
    await failed;
    await worker.close();

    const entries = await queue.getDlqEntries!();
    expect(entries).toHaveLength(1);
    expect(entries[0].data.keep).toBe('me');
    expect(JSON.stringify(entries[0])).not.toContain('hunter2-leaf');
  });
});
