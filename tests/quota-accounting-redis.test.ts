import crypto from 'node:crypto';
import Redis from 'ioredis';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('undici', async (importOriginal) => ({
  ...(await importOriginal<typeof import('undici')>()),
  fetch: vi.fn(),
}));
vi.mock('@/lib/security/ssrf', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/security/ssrf')>()),
  validateUrlForSsrf: vi.fn(async () => true),
  createSsrfSafeAgent: () => ({ close: async () => undefined }),
}));

import { fetch as undiciFetch } from 'undici';
import { POST as convertRoute } from '../src/app/api/convert/route';
import { POST as fetchUrlRoute } from '../src/app/api/fetch-url/route';
import { DistributedBullMQAdapter, STALLED_SWEEP_INTERVAL_MS, Worker } from '../src/lib/queue/bullmq-engine';
import { attachJobLifecycleListeners } from '../src/lib/queue/conversion-queue';
import { POST as batchRoute } from '../src/app/api/convert/batch/route';
import { RedisKeyStore, redisKeyStore } from '../src/lib/api-keys/redis-key-store';
import { anonymousUserId } from '../src/lib/auth/anonymous-identity';
import type { ConversionJobData, ConversionJobResult } from '../src/lib/types';

/**
 * The quota is Lua scripts over real keys, so what a request is charged is checked on a real Redis server, through the
 * routes and the worker listeners that reserve and settle it. Like the other Redis suites it runs when REDIS_URL is set
 * (for example `REDIS_URL=redis://127.0.0.1:6379`).
 */
const REDIS_URL = process.env.REDIS_URL;
const HTTP_TOO_MANY_REQUESTS = 429;
const CSV = 'name,score\nAlice,100\nBob,95\n';
const NOT_A_PNG = 'this is plain text, not a PNG picture';
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JOB_TIMEOUT_MS = 300;
const JOB_RUNS_FOR_MS = 5000;
const DAY_ALLOWANCE = 25;

interface QuotaJob {
  userId: string;
  reservationId?: string;
}

// skip-ok: mode selection. The shards run without REDIS_URL; the Redis-mode CI step (npm run test:redis) sets it and runs this file.
describe.skipIf(!REDIS_URL)('what a request is charged, on a real Redis server', () => {
  let admin: Redis;
  let client: { ip: string; userId: string; headers: Record<string, string> };
  let keyPrefix: string;
  const adapters: Array<{ close(): Promise<void> }> = [];

  const remaining = async () => (await redisKeyStore.getQuotaUsage(client.userId)).remaining;

  function connect(queueName: string): DistributedBullMQAdapter<QuotaJob, string> {
    const adapter = new DistributedBullMQAdapter<QuotaJob, string>(queueName, {
      redisClient: new Redis(REDIS_URL as string, { maxRetriesPerRequest: 1 }),
      keyPrefix,
    });
    adapters.push(adapter);
    return adapter;
  }

  function convertRequest(file: { name: string; content: BlobPart; target?: string }) {
    const form = new FormData();
    form.append('file', new File([file.content], file.name));
    if (file.target) form.append('targetFormat', file.target);
    return new NextRequest('http://localhost/api/convert', { method: 'POST', headers: client.headers, body: form });
  }

  function importRequest() {
    return new NextRequest('http://localhost/api/fetch-url', {
      method: 'POST',
      headers: { ...client.headers, 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://files.example.com/scores.csv' }),
    });
  }

  const convertCsv = () => convertRoute(convertRequest({ name: 'scores.csv', content: CSV, target: 'json' }));

  /** Reserves a unit as a route does, and puts a job that carries it on a queue. */
  async function queueJobWithUnit(queue: DistributedBullMQAdapter<QuotaJob, string>, options: { attempts: number; timeout?: number }) {
    const unit = await redisKeyStore.reserveQuota(client.userId, 1);
    expect(unit.allowed).toBe(true);
    expect(await remaining()).toBe(DAY_ALLOWANCE - 1);
    return queue.add('convert', { userId: client.userId, reservationId: unit.reservationId }, options);
  }

  function settledBy(worker: Worker<QuotaJob, string>, event: 'completed' | 'failed') {
    return new Promise<void>((resolve) => worker.once(event, () => resolve()));
  }

  function listenedTo(worker: Worker<QuotaJob, string>) {
    attachJobLifecycleListeners(worker as unknown as Worker<ConversionJobData, ConversionJobResult>);
    return worker;
  }

  beforeEach(() => {
    const octet = () => crypto.randomInt(1, 255);
    const ip = `198.51.${octet()}.${octet()}`;
    client = { ip, userId: anonymousUserId(ip), headers: { 'x-forwarded-for': ip } };
    keyPrefix = `quota-accounting-${crypto.randomBytes(6).toString('hex')}:`;
    admin = new Redis(REDIS_URL as string, { maxRetriesPerRequest: 1 });
    vi.stubEnv('TRUSTED_PROXIES', '10.0.0.0/8');
    vi.stubEnv('ANONYMOUS_DAILY_LIMIT', '');
    vi.mocked(undiciFetch).mockReset();
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    while (adapters.length > 0) await adapters.pop()!.close();
    const keys = [...(await admin.keys(`*${client.userId}*`)), ...(await admin.keys(`${keyPrefix}*`))];
    if (keys.length > 0) await admin.del(...keys);
    await admin.quit();
  });

  it('a link import followed by a successful conversion charges exactly one conversion', async () => {
    expect(await remaining()).toBe(DAY_ALLOWANCE);
    vi.mocked(undiciFetch).mockResolvedValue(new Response(CSV, { status: 200, headers: { 'content-type': 'text/csv' } }) as never);

    const imported = await fetchUrlRoute(importRequest());
    expect(imported.status).toBe(200);
    expect(await remaining()).toBe(DAY_ALLOWANCE);

    const converted = await convertRoute(
      convertRequest({ name: 'scores.csv', content: await imported.text(), target: 'json' })
    );
    expect(converted.status).toBe(200);
    expect(await remaining()).toBe(DAY_ALLOWANCE - 1);
  });

  it('a conversion that fails charges nothing', async () => {
    const res = await convertRoute(convertRequest({ name: 'picture.png', content: Buffer.concat([PNG_SIGNATURE, Buffer.from(NOT_A_PNG)]), target: 'jpg' }));

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await remaining()).toBe(DAY_ALLOWANCE);
  });

  it('a file that is not what its extension says charges nothing', async () => {
    const res = await convertRoute(convertRequest({ name: 'picture.png', content: NOT_A_PNG, target: 'jpg' }));

    expect(res.status).toBe(400);
    expect(await remaining()).toBe(DAY_ALLOWANCE);
  });

  it('a reservation made by the web process is given back by a worker process that has only its id', async () => {
    const unit = await redisKeyStore.reserveQuota(client.userId, 1);
    expect(await remaining()).toBe(DAY_ALLOWANCE - 1);

    const otherProcess = new RedisKeyStore({ redisClient: new Redis(REDIS_URL as string, { maxRetriesPerRequest: 1 }), isolated: true });
    expect(await otherProcess.rollbackQuota(unit.reservationId as string)).toBe(true);

    expect(await remaining()).toBe(DAY_ALLOWANCE);
  });

  it('a batch is charged one conversion for each file it converted', async () => {
    const form = new FormData();
    form.append('files', new File([CSV], 'scores.csv'));
    form.append('files', new File([CSV], 'other.zzzz'));
    form.append('targetFormats', JSON.stringify({ default: 'json' }));

    const res = await batchRoute(new NextRequest('http://localhost/api/convert/batch', { method: 'POST', headers: client.headers, body: form }));

    expect(res.status).toBe(200);
    expect(await remaining()).toBe(DAY_ALLOWANCE - 1);
  });

  it('a job past its deadline charges nothing, and one that completes charges one conversion', async () => {
    const queue = connect('quota-deadline');
    const timedOut = listenedTo(new Worker(queue, async () => new Promise<string>((resolve) => setTimeout(resolve, JOB_RUNS_FOR_MS)), { concurrency: 1 }));
    const failed = settledBy(timedOut, 'failed');
    await queueJobWithUnit(queue, { attempts: 1, timeout: JOB_TIMEOUT_MS });
    await failed;
    await vi.waitFor(async () => expect(await remaining()).toBe(DAY_ALLOWANCE));
    await timedOut.close();

    const done = listenedTo(new Worker(queue, async () => 'converted', { concurrency: 1 }));
    const completed = settledBy(done, 'completed');
    await queueJobWithUnit(queue, { attempts: 1 });
    await completed;
    await vi.waitFor(async () => expect(await remaining()).toBe(DAY_ALLOWANCE - 1));
    await done.close();
  }, 15000);

  it('a job whose worker was lost charges nothing once the stalled sweep fails it', async () => {
    const lostWorkerSide = connect('quota-stalled');
    const job = await queueJobWithUnit(lostWorkerSide, { attempts: 1 });
    await lostWorkerSide._popNextWaiting();
    await admin.del(`${keyPrefix}{quota-stalled}:heartbeat:${job.id}`);

    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const worker = listenedTo(new Worker(connect('quota-stalled'), async () => 'never runs', { concurrency: 1 }));
    const failed = settledBy(worker, 'failed');
    await vi.advanceTimersByTimeAsync(STALLED_SWEEP_INTERVAL_MS);
    await failed;
    vi.useRealTimers();

    await vi.waitFor(async () => expect(await remaining()).toBe(DAY_ALLOWANCE));
    await worker.close();
  }, 15000);

  it('refuses the 26th anonymous conversion of the day and not the 25th', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < DAY_ALLOWANCE + 1; i++) statuses.push((await convertCsv()).status);

    expect(statuses.slice(0, DAY_ALLOWANCE)).toEqual(new Array(DAY_ALLOWANCE).fill(200));
    expect(statuses[DAY_ALLOWANCE]).toBe(HTTP_TOO_MANY_REQUESTS);
    expect(await remaining()).toBe(0);
  }, 60000);

  it('keeps a link import and an unrelated refusal from using the last conversion', async () => {
    for (let i = 0; i < DAY_ALLOWANCE - 1; i++) expect((await convertCsv()).status).toBe(200);
    vi.mocked(undiciFetch).mockResolvedValue(new Response(CSV, { status: 200, headers: { 'content-type': 'text/csv' } }) as never);
    expect((await fetchUrlRoute(importRequest())).status).toBe(200);
    expect((await convertRoute(convertRequest({ name: 'picture.png', content: NOT_A_PNG, target: 'jpg' }))).status).toBe(400);

    expect(await remaining()).toBe(1);
    expect((await convertCsv()).status).toBe(200);
    expect((await fetchUrlRoute(importRequest())).status).toBe(HTTP_TOO_MANY_REQUESTS);
  }, 60000);
});
