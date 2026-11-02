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
import { ANONYMOUS_DAILY_UPLOAD_BYTES, bytesBroughtInToday, reserveLinkImport } from '../src/lib/api-keys/anonymous-upload-budget';
import { anonymousUserId } from '../src/lib/auth/anonymous-identity';
import { createSessionToken } from '../src/lib/auth/session';
import { userStore } from '../src/lib/auth/user-store';
import type { Plan } from '../src/lib/plan-limits';
import { acquireSyncSlot, syncSlotsInUse, type ConversionSlot } from '../src/lib/queue/concurrency-limit';
import type { ConversionJobData, ConversionJobResult } from '../src/lib/types';
import { itNeedsOneUnitLeftForEveryCaller } from './helpers/unit-left-identities';
import { itChargesAGraphOnlyThroughItsScheduler } from './helpers/graph-charge-cases';

/**
 * The quota is Lua scripts over real keys, so what a request is charged is checked on a real Redis server, through the
 * routes and the worker listeners that reserve and settle it. Like the other Redis suites it runs when REDIS_URL is set
 * (for example `REDIS_URL=redis://127.0.0.1:6379`).
 */
const REDIS_URL = process.env.REDIS_URL;
const HTTP_TOO_MANY_REQUESTS = 429;
const CSV = 'name,score\nAlice,100\nBob,95\n';
/** The deadline of an import that spends bytes directly; its hold is settled at once. */
const IMPORT_DEADLINE_MS = 120_000;
const NOT_A_PNG = 'this is plain text, not a PNG picture';
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JOB_TIMEOUT_MS = 300;
const JOB_RUNS_FOR_MS = 5000;
const DAY_ALLOWANCE = 25;
const FREE_CONCURRENCY = 5;
const UPLOAD_BUDGET_PROBLEM = 'https://api.easyconvert.io/problems/upload-budget-exceeded';
const CONCURRENCY_PROBLEM = 'https://api.easyconvert.io/problems/concurrency-limit';
/** A little past the 15 minutes a reservation used to live. */
const PAST_OLD_RESERVATION_LIFETIME_MS = 901_000;
const EARLY_IN_A_UTC_DAY = new Date('2026-11-02T00:00:05.000Z');
const FREE_DAILY_IMPORT_BYTES = 2 * 1024 * 1024 * 1024;

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

  function importRequest(headers: Record<string, string> = client.headers) {
    return new NextRequest('http://localhost/api/fetch-url', {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://files.example.com/scores.csv' }),
    });
  }

  /** Uses `bytes` of the day's import budget of `userId`, as an import that received them would. */
  async function spendImportBytes(userId: string, plan: Plan, bytes: number) {
    const held = await reserveLinkImport(userId, plan, IMPORT_DEADLINE_MS);
    if ('refusal' in held) throw new Error(`the import budget of ${userId} is already spent`);
    await held.reservation.settle(bytes);
  }

  const convertCsv = () => convertRoute(convertRequest({ name: 'scores.csv', content: CSV, target: 'json' }));

  /** Every fetch of the link answers `content`, a new response each time. */
  function remoteFile(content: string) {
    vi.mocked(undiciFetch).mockImplementation(async () => new Response(content, { status: 200, headers: { 'content-type': 'text/csv' } }) as never);
  }

  /** A link whose server sends the first bytes of the body and then nothing, until the request is aborted. */
  function stalledRemoteFile() {
    vi.mocked(undiciFetch).mockImplementation(async (_url, init) => {
      const signal = (init as { signal?: AbortSignal } | undefined)?.signal;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('name,score\n'));
          signal?.addEventListener('abort', () => controller.error(signal.reason));
        },
      });
      return new Response(body, { status: 200, headers: { 'content-type': 'text/csv' } }) as never;
    });
  }

  /**
   * The keys of the client as Redis sees them `ms` later: each key's time to live shrinks by `ms`, and a key whose time
   * runs out is gone. Redis has no clock to move, so this stands in for waiting.
   */
  async function advanceKeyClock(ms: number) {
    for (const key of await admin.keys(`*${client.userId}*`)) {
      const left = await admin.pttl(key);
      if (left < 0) continue;
      if (left <= ms) await admin.del(key);
      else await admin.pexpire(key, left - ms);
    }
  }

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

  const otherUsers: string[] = [];

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
    const owners = [client.userId, ...otherUsers.splice(0)];
    const keys = [...(await Promise.all(owners.map((owner) => admin.keys(`*${owner}*`)))).flat(), ...(await admin.keys(`${keyPrefix}*`))];
    if (keys.length > 0) await admin.del(...keys);
    await admin.quit();
  });

  it('a link import followed by a successful conversion charges exactly one conversion', async () => {
    expect(await remaining()).toBe(DAY_ALLOWANCE);
    remoteFile(CSV);

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
    remoteFile(CSV);
    expect((await fetchUrlRoute(importRequest())).status).toBe(200);
    expect((await convertRoute(convertRequest({ name: 'picture.png', content: NOT_A_PNG, target: 'jpg' }))).status).toBe(400);

    expect(await remaining()).toBe(1);
    expect((await convertCsv()).status).toBe(200);
    expect((await fetchUrlRoute(importRequest())).status).toBe(HTTP_TOO_MANY_REQUESTS);
  }, 60000);

  describe('a link import', () => {
    it('counts the bytes it brings in against the daily byte budget, is refused once that is spent, and leaves the conversion count alone', async () => {
      await spendImportBytes(client.userId, 'anonymous', ANONYMOUS_DAILY_UPLOAD_BYTES - 1);
      remoteFile(CSV);

      expect((await fetchUrlRoute(importRequest())).status).toBe(200);
      const refused = await fetchUrlRoute(importRequest());

      expect(refused.status).toBe(HTTP_TOO_MANY_REQUESTS);
      expect(await refused.json()).toMatchObject({ type: UPLOAD_BUDGET_PROBLEM, refusal: 'daily-bytes', limitBytes: ANONYMOUS_DAILY_UPLOAD_BYTES });
      expect(vi.mocked(undiciFetch)).toHaveBeenCalledTimes(1);
      expect(await remaining()).toBe(DAY_ALLOWANCE);
    });

    it('by a free account is refused once the plan allowance is spent, in a budget keyed by the account', async () => {
      const user = userStore.sanitizeUser(await userStore.createUser({ email: `import-${crypto.randomBytes(6).toString('hex')}@quota.test`, name: 'Import', tier: 'free' }));
      otherUsers.push(user.id);
      const session = { cookie: `easyconvert_session=${createSessionToken(user)}` };
      await spendImportBytes(user.id, 'free', FREE_DAILY_IMPORT_BYTES - 1);
      remoteFile(CSV);

      expect((await fetchUrlRoute(importRequest(session))).status).toBe(200);
      expect(await bytesBroughtInToday(user.id)).toBe(FREE_DAILY_IMPORT_BYTES - 1 + Buffer.byteLength(CSV));
      const refused = await fetchUrlRoute(importRequest(session));

      expect(refused.status).toBe(HTTP_TOO_MANY_REQUESTS);
      expect(await refused.json()).toMatchObject({ type: UPLOAD_BUDGET_PROBLEM, refusal: 'daily-bytes', limitBytes: FREE_DAILY_IMPORT_BYTES, plan: 'free' });
      expect(await admin.keys(`*upload-budget*${user.id}*`)).toHaveLength(1);
    });

    it('stops at the synchronous deadline when the remote sends the body too slowly, and frees its slot', async () => {
      vi.stubEnv('SYNC_DEADLINE_MAX_MS', '200');
      stalledRemoteFile();

      const res = await fetchUrlRoute(importRequest());

      expect(res.status).toBe(504);
      expect((await res.json()).code).toBe('fetch_timeout');
      expect(syncSlotsInUse()).toBe(0);
      expect(await remaining()).toBe(DAY_ALLOWANCE);
    }, 5000);

    it('is refused while the caller holds every conversion slot, and frees its slot however it ends', async () => {
      const held: ConversionSlot[] = [];
      for (let i = 0; i < FREE_CONCURRENCY; i++) held.push(await acquireSyncSlot(client.userId, 'free'));
      const crowded = await fetchUrlRoute(importRequest());
      for (const slot of held) if (slot.granted) slot.release();
      expect(crowded.status).toBe(HTTP_TOO_MANY_REQUESTS);
      expect((await crowded.json()).type).toBe(CONCURRENCY_PROBLEM);

      const ends: Array<[() => void, number]> = [
        [() => remoteFile(CSV), 200],
        [() => vi.mocked(undiciFetch).mockImplementation(async () => new Response('gone', { status: 404 }) as never), 400],
        [() => vi.mocked(undiciFetch).mockRejectedValue(new Error('socket hang up')), 500],
      ];
      for (const [arrange, status] of ends) {
        arrange();
        expect((await fetchUrlRoute(importRequest())).status).toBe(status);
        expect(syncSlotsInUse()).toBe(0);
      }
      expect(await remaining()).toBe(DAY_ALLOWANCE);
    });
  });

  describe('a reservation', () => {
    it('is given back by a job that fails more than 15 minutes after it was made, and kept by one that completes', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(EARLY_IN_A_UTC_DAY);
      const queue = connect('quota-late');

      await queueJobWithUnit(queue, { attempts: 1 });
      await advanceKeyClock(PAST_OLD_RESERVATION_LIFETIME_MS);
      const failing = listenedTo(new Worker(queue, async () => { throw new Error('the engine failed'); }, { concurrency: 1 }));
      const failed = settledBy(failing, 'failed');
      await failed;
      await vi.waitFor(async () => expect(await remaining()).toBe(DAY_ALLOWANCE));
      await failing.close();

      await queueJobWithUnit(queue, { attempts: 1 });
      await advanceKeyClock(PAST_OLD_RESERVATION_LIFETIME_MS);
      const done = listenedTo(new Worker(queue, async () => 'converted', { concurrency: 1 }));
      const completed = settledBy(done, 'completed');
      await completed;
      await vi.waitFor(async () => expect(await remaining()).toBe(DAY_ALLOWANCE - 1));
      await done.close();
    }, 15000);

    it('rolled back after it was committed leaves the count charged', async () => {
      const unit = await redisKeyStore.reserveQuota(client.userId, 1);
      expect(await redisKeyStore.commitQuota(unit.reservationId as string)).toBe(true);

      expect(await redisKeyStore.rollbackQuota(unit.reservationId as string)).toBe(false);
      expect(await remaining()).toBe(DAY_ALLOWANCE - 1);
    });

    it('is given back once however often it is rolled back', async () => {
      const unit = await redisKeyStore.reserveQuota(client.userId, 1);

      expect(await redisKeyStore.rollbackQuota(unit.reservationId as string)).toBe(true);
      expect(await redisKeyStore.rollbackQuota(unit.reservationId as string)).toBe(false);
      expect(await remaining()).toBe(DAY_ALLOWANCE);
    });

    it('settled after it was rolled back or committed changes nothing', async () => {
      const rolledBack = await redisKeyStore.reserveQuota(client.userId, 1);
      await redisKeyStore.rollbackQuota(rolledBack.reservationId as string);
      expect((await redisKeyStore.settleQuota(rolledBack.reservationId as string, 1)).success).toBe(false);
      expect(await remaining()).toBe(DAY_ALLOWANCE);

      const committed = await redisKeyStore.reserveQuota(client.userId, 1);
      await redisKeyStore.commitQuota(committed.reservationId as string);
      expect((await redisKeyStore.settleQuota(committed.reservationId as string, 3)).success).toBe(false);
      expect(await remaining()).toBe(DAY_ALLOWANCE - 1);
    });

    it('settles to the units the request used', async () => {
      const unit = await redisKeyStore.reserveQuota(client.userId, 3);

      expect(await redisKeyStore.settleQuota(unit.reservationId as string, 1)).toEqual({ success: true, difference: -2 });
      expect(await remaining()).toBe(DAY_ALLOWANCE - 1);
    });

    it("rolled back after its day's count expired leaves no count behind", async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(EARLY_IN_A_UTC_DAY);
      const unit = await redisKeyStore.reserveQuota(client.userId, 1);
      for (const key of await admin.keys(`*usage*${client.userId}*`)) await admin.del(key);

      await redisKeyStore.rollbackQuota(unit.reservationId as string);

      expect(await remaining()).toBe(DAY_ALLOWANCE);
    });

    it('made across midnight is charged and given back on the day it was made', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-11-02T23:59:59.500Z'));
      const connection = new Redis(REDIS_URL as string, { maxRetriesPerRequest: 1 });
      // Midnight passes while each script runs: what the store computes after the reply falls on the next day.
      const midnightDuringScripts = new Proxy(connection, {
        get(target, property) {
          if (property === 'eval') {
            return async (...args: Parameters<Redis['eval']>) => {
              const reply = await target.eval(...args);
              vi.setSystemTime(new Date('2026-11-03T00:00:00.500Z'));
              return reply;
            };
          }
          const value = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      const store = new RedisKeyStore({ redisClient: midnightDuringScripts, isolated: true });
      try {
        const unit = await store.reserveQuota(client.userId, 1);
        await store.rollbackQuota(unit.reservationId as string);

        vi.setSystemTime(new Date('2026-11-02T12:00:00.000Z'));
        expect((await store.getQuotaUsage(client.userId)).remaining).toBe(DAY_ALLOWANCE);
        vi.setSystemTime(new Date('2026-11-03T12:00:00.000Z'));
        expect((await store.getQuotaUsage(client.userId)).remaining).toBe(DAY_ALLOWANCE);
      } finally {
        await connection.quit();
      }
    });
  });

  describe('a request that needs a conversion left but reserves none', () => {
    itNeedsOneUnitLeftForEveryCaller((userId) => otherUsers.push(userId));
  });

  describe('a queued graph', () => {
    itChargesAGraphOnlyThroughItsScheduler((userId) => otherUsers.push(userId));
  });
});
