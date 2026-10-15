import dns from 'node:dns';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { POST as createJob, GET as listJobs } from '../src/app/api/v1/jobs/route';
import { GET as getJob } from '../src/app/api/v1/jobs/[id]/route';
import { GET as getQueueJob } from '../src/app/api/queue/jobs/[id]/route';
import { GET as listDlq } from '../src/app/api/webhooks/dlq/route';
import { GET as getDlqEntry } from '../src/app/api/webhooks/dlq/[id]/route';
import { POST as replayDlq } from '../src/app/api/webhooks/dlq/[id]/replay/route';
import { webhookDispatcher } from '../src/lib/api-keys/webhook-dispatcher';
import { redisKeyStore } from '../src/lib/api-keys/redis-key-store';
import { userStore } from '../src/lib/auth/user-store';
import { createSessionToken } from '../src/lib/auth/session';
import { conversionQueue } from '../src/lib/queue/conversion-queue';
import { graphScheduler } from '../src/lib/queue/graph';
import { s3Storage } from '../src/lib/storage/s3-storage';
import type { User } from '../src/lib/auth/types';

/**
 * What the HTTP API and webhooks show about a job must never contain the bearer secrets it was
 * submitted with, nor secrets that an error message or an old log row happens to quote. Goldens
 * are written by hand from the masking contract.
 */
const BASE_URL = 'https://easyconvert.app';
const PUBLIC_IP = '93.184.215.14';
const WEBHOOK_URL = `https://${PUBLIC_IP}/hooks/easyconvert`;

const SIGNATURE = 'sig-b91f0a6d3c85e247';
const BEARER = 'bt-77c20e5b1a94d6f3';
const API_KEY = 'ak-91b7c3e5d2f0a4b8';
const PASSWORD = 'pw-4e8a1c7d93b2';
const WEBHOOK_SECRET = 'whsec-2d61f9b08e3a47c5';
const HOOK_TOKEN = 'hk-5c0e7d21b94a68f3';
const SECRETS = [SIGNATURE, BEARER, API_KEY, PASSWORD, WEBHOOK_SECRET, HOOK_TOKEN];
const LEAKY = `upstream rejected https://deploy:${PASSWORD}@h.example/obj?X-Amz-Signature=${SIGNATURE} with Authorization: Bearer ${BEARER}`;
const MASKED = 'upstream rejected https://***@h.example/obj?*** with Authorization: ***';
const PRESIGNED_RESULT_URL = 'https://downloads.example/results/out.json?X-Amz-Expires=3600&X-Amz-Signature=0123abcd';

function expectNoSecrets(label: string, text: string): void {
  for (const secret of SECRETS) {
    expect(text.includes(secret), `${label} leaks "${secret}"`).toBe(false);
  }
}

async function createUser(label: string): Promise<User> {
  const email = `${label}_${Date.now()}_${Math.random().toString(36).slice(2)}@mask.test`;
  return userStore.sanitizeUser(await userStore.createUser({ email, name: label, tier: 'pro' }));
}

describe('job API responses', () => {
  let user: User;
  let authHeaders: Record<string, string>;
  const graphIds: string[] = [];

  beforeEach(async () => {
    vi.spyOn(dns.promises, 'lookup').mockImplementation((async () => [{ address: PUBLIC_IP, family: 4 }]) as never);
    user = await createUser('mask_api');
    const { secretKey } = await redisKeyStore.generateApiKey(user.id, 'mask', { scopes: ['convert:read', 'convert:write'] });
    authHeaders = { Authorization: `Bearer ${secretKey}`, 'Content-Type': 'application/json' };
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const id of graphIds.splice(0)) {
      await graphScheduler.cancelGraph(id, 'test cleanup');
    }
  });

  async function submitGraph(body: Record<string, unknown>) {
    const res = await createJob(
      new NextRequest(`${BASE_URL}/api/v1/jobs`, { method: 'POST', headers: authHeaders, body: JSON.stringify(body) })
    );
    const text = await res.text();
    expect(res.status, text).toBe(202);
    const json = JSON.parse(text);
    graphIds.push(json.jobId);
    return { text, json };
  }

  const secretGraph = {
    failurePolicy: 'fail_fast',
    nodes: {
      in: {
        op: 'import.url',
        url: `https://files.example.org/in/data.csv?X-Amz-Signature=${SIGNATURE}`,
        headers: { Authorization: `Bearer ${BEARER}`, 'X-Api-Key': API_KEY },
      },
      conv: { op: 'convert', input: 'in', targetFormat: 'json' },
      out: {
        op: 'export.url',
        input: 'conv',
        url: `https://deploy:${PASSWORD}@dav.example.org/out/result.json`,
        method: 'PUT',
        headers: { 'X-Api-Key': API_KEY },
      },
    },
  };

  it('does not echo URL secrets or headers in the POST or GET response of a graph job', async () => {
    const { text: created, json } = await submitGraph({ graph: secretGraph, webhookUrl: WEBHOOK_URL, webhookSecret: WEBHOOK_SECRET });
    expectNoSecrets('POST /api/v1/jobs', created);
    expect(json.graph.nodes.in).toEqual({ id: 'in', op: 'import.url', sealed: '***' });
    expect(json.graph.nodes.out).toEqual({ id: 'out', op: 'export.url', input: 'conv', method: 'PUT', sealed: '***' });

    const res = await getJob(new NextRequest(`${BASE_URL}/api/v1/jobs/${json.jobId}`, { headers: authHeaders }), {
      params: { id: json.jobId },
    });
    const fetched = await res.text();
    expect(res.status).toBe(200);
    expectNoSecrets('GET /api/v1/jobs/:id', fetched);
    expect(JSON.parse(fetched).graph.nodes.in).toEqual({ id: 'in', op: 'import.url', sealed: '***' });
  });

  it('masks task records of a linear submission', async () => {
    s3Storage.saveObject(`uploads/${user.id}/mask.csv`, Buffer.from('a,b\n1,2\n'), 'text/csv', 'mask.csv');
    const tasks = [
      { name: 'to-json', operation: 'convert', targetFormat: 'json' },
      { name: 'upload', operation: 'export/url', url: `https://deploy:${PASSWORD}@dav.example.org/out/result.json?sig=${SIGNATURE}` },
    ];
    const { text, json } = await submitGraph({ tasks, storageKey: `uploads/${user.id}/mask.csv`, filename: 'mask.csv' });
    expectNoSecrets('POST with tasks', text);

    const res = await getJob(new NextRequest(`${BASE_URL}/api/v1/jobs/${json.jobId}`, { headers: authHeaders }), {
      params: { id: json.jobId },
    });
    const body = await res.json();
    expect(body.tasks[1]).toEqual({
      name: 'upload',
      operation: 'export/url',
      url: 'https://***@dav.example.org/out/result.json?***',
    });
    expectNoSecrets('GET with tasks', JSON.stringify(body));
  });

  it('masks failure reasons, logs, tasks and graph of a queued job, and keeps the result link', async () => {
    const job = await conversionQueue.add(
      'convert',
      {
        jobId: '',
        originalFilename: 'a.csv',
        sourceFormat: 'csv',
        targetFormat: 'json',
        fileSize: 8,
        options: {},
        userId: user.id,
        webhookSecret: WEBHOOK_SECRET,
        tasks: [{ name: 'upload', operation: 'export/url', url: `https://dav.example.org/o?sig=${SIGNATURE}` }],
      },
      { attempts: 1 }
    );
    // Rows written before masking existed: the API must not trust what storage holds.
    job.logs.push(`[2026-10-05T00:00:00.000Z] ${LEAKY}`);
    job.failedReason = LEAKY;
    job.returnvalue = {
      jobId: job.id,
      status: 'completed',
      resultKey: 'results/out.json',
      downloadUrl: PRESIGNED_RESULT_URL,
      filename: 'out.json',
      mimeType: 'application/json',
      size: 3,
      durationMs: 5,
    };

    const res = await getJob(new NextRequest(`${BASE_URL}/api/v1/jobs/${job.id}`, { headers: authHeaders }), {
      params: { id: job.id },
    });
    const text = await res.text();
    expect(res.status).toBe(200);
    const body = JSON.parse(text);
    expect(body.failedReason).toBe(MASKED);
    expect(body.logs).toEqual([`[2026-10-05T00:00:00.000Z] ${MASKED}`]);
    expect(body.tasks[0].url).toBe('https://dav.example.org/o?***');
    expectNoSecrets('GET /api/v1/jobs/:id', text);
    // The link minted for the owner's result is not a secret to hide from that owner.
    expect(body.result.downloadUrl).toBe(PRESIGNED_RESULT_URL);

    const list = await listJobs(new NextRequest(`${BASE_URL}/api/v1/jobs?status=waiting`, { headers: authHeaders }));
    const listText = await list.text();
    expect(JSON.parse(listText).jobs.find((j: { jobId: string }) => j.jobId === job.id).failedReason).toBe(MASKED);
    expectNoSecrets('GET /api/v1/jobs', listText);

    const legacy = await getQueueJob(new NextRequest(`${BASE_URL}/api/queue/jobs/${job.id}`, { headers: authHeaders }), {
      params: { id: job.id },
    });
    const legacyText = await legacy.text();
    expect(legacy.status).toBe(200);
    expect(JSON.parse(legacyText).failedReason).toBe(MASKED);
    expect(JSON.parse(legacyText).logs).toEqual([`[2026-10-05T00:00:00.000Z] ${MASKED}`]);
    expectNoSecrets('GET /api/queue/jobs/:id', legacyText);

    await conversionQueue.cancelJob(job.id, 'test cleanup');
  });
});

describe('webhook payloads and dead-letter entries', () => {
  let user: User;

  beforeEach(async () => {
    user = await createUser('mask_webhook');
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await webhookDispatcher.clearDlq(user.id);
  });

  function sessionRequest(pathName: string, method = 'GET'): NextRequest {
    return new NextRequest(`${BASE_URL}${pathName}`, {
      method,
      headers: { Cookie: `easyconvert_session=${createSessionToken(user)}` },
    });
  }

  const payload = {
    jobId: 'job_1',
    status: 'failed',
    error: LEAKY,
    downloadUrl: PRESIGNED_RESULT_URL,
    nodes: { in: { status: 'failed', error: LEAKY } },
    graph: { nodes: { out: { op: 'export.url', headers: { Authorization: `Bearer ${BEARER}` } } } },
    webhookSecret: WEBHOOK_SECRET,
  };
  const maskedPayload = {
    jobId: 'job_1',
    status: 'failed',
    error: MASKED,
    downloadUrl: PRESIGNED_RESULT_URL,
    nodes: { in: { status: 'failed', error: MASKED } },
    graph: { nodes: { out: { op: 'export.url', headers: '***' } } },
    webhookSecret: '***',
  };

  it('sends a masked body and keeps the owner result link', async () => {
    const bodies: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      bodies.push(String((init as RequestInit).body));
      return new Response('ok', { status: 200 });
    });

    const result = await webhookDispatcher.dispatch(WEBHOOK_URL, 'job.failed', payload, 'signing-secret', {
      maxRetries: 1,
      ownerUserId: user.id,
    });

    expect(result.success).toBe(true);
    expect(bodies).toHaveLength(1);
    expectNoSecrets('webhook body', bodies[0]);
    expect(JSON.parse(bodies[0]).data).toEqual(maskedPayload);
  });

  it('stores a masked payload in the dead-letter queue and shows masked entries through the API', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('down', { status: 503 }));
    const hook = `${WEBHOOK_URL}?token=${HOOK_TOKEN}`;

    const failed = await webhookDispatcher.dispatch(hook, 'job.failed', payload, 'signing-secret', {
      maxRetries: 1,
      initialDelayMs: 1,
      ownerUserId: user.id,
    });
    expect(failed.success).toBe(false);

    const stored = await webhookDispatcher.getDlqEntry(`dlq_${failed.id}`, user.id);
    expectNoSecrets('stored dead-letter payload', JSON.stringify(stored?.payload));
    expect((stored?.payload as { data: unknown }).data).toEqual(maskedPayload);

    const listRes = await listDlq(sessionRequest('/api/webhooks/dlq'));
    const listText = await listRes.text();
    expectNoSecrets('GET /api/webhooks/dlq', listText);
    expect(JSON.parse(listText).entries[0].targetUrl).toBe(`${WEBHOOK_URL}?***`);

    const oneRes = await getDlqEntry(sessionRequest(`/api/webhooks/dlq/dlq_${failed.id}`), {
      params: { id: `dlq_${failed.id}` },
    });
    const oneText = await oneRes.text();
    expectNoSecrets('GET /api/webhooks/dlq/:id', oneText);
    expect(JSON.parse(oneText).entry.targetUrl).toBe(`${WEBHOOK_URL}?***`);

    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('ok', { status: 200 }));
    const replayRes = await replayDlq(sessionRequest(`/api/webhooks/dlq/dlq_${failed.id}/replay`, 'POST'), {
      params: { id: `dlq_${failed.id}` },
    });
    const replayText = await replayRes.text();
    expect(replayRes.status).toBe(200);
    expectNoSecrets('POST /api/webhooks/dlq/:id/replay', replayText);
    expect(JSON.parse(replayText).url).toBe(`${WEBHOOK_URL}?***`);
  });
});
