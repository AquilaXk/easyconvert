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
import { RedisGraphScheduler } from '../src/lib/queue/graph/redis-scheduler';
import { CANCEL_GRAPH_LUA_SCRIPT } from '../src/lib/queue/graph/lua-scripts';
import { withReservedUnit } from '../src/lib/api-keys/guard';
import { POST as batchRoute } from '../src/app/api/convert/batch/route';
import { RedisKeyStore, redisKeyStore } from '../src/lib/api-keys/redis-key-store';
import { RESERVATION_LEASE, reservationIdOf } from '../src/lib/api-keys/reservation-ledger';
import { getUtcDateKey } from '../src/lib/api-keys/key-store';
import { webhookDispatcher } from '../src/lib/api-keys/webhook-dispatcher';
import { storageProvider } from '../src/lib/storage';
import {
  ANONYMOUS_DAILY_UPLOAD_BYTES,
  LINK_IMPORT_METER_BATCH_BYTES,
  bytesBroughtInToday,
  reserveAnonymousUpload,
  resumeUploadReservation,
  withLinkImportMeter,
} from '../src/lib/api-keys/anonymous-upload-budget';
import { spendImportBytes } from './helpers/import-budget';
import { anonymousUserId } from '../src/lib/auth/anonymous-identity';
import { createSessionToken } from '../src/lib/auth/session';
import { userStore } from '../src/lib/auth/user-store';
import { URL_IMPORT_MAX_BYTES, type Plan } from '../src/lib/plan-limits';
import { acquireSyncSlot, syncSlotsInUse, type ConversionSlot } from '../src/lib/queue/concurrency-limit';
import { QueueUnavailableError, type ConversionJobData, type ConversionJobResult } from '../src/lib/types';
import { itNeedsOneUnitLeftForEveryCaller } from './helpers/unit-left-identities';
import { itChargesAGraphOnlyThroughItsScheduler } from './helpers/graph-charge-cases';
import { itLeasesHandedOffWork, itLeasesReservations } from './helpers/reservation-lease-cases';
import { itRecoversAGraphStart } from './helpers/graph-start-recovery-cases';

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
const FREE_CONCURRENCY = 5;
const UPLOAD_BUDGET_PROBLEM = 'https://api.easyconvert.io/problems/upload-budget-exceeded';
const CONCURRENCY_PROBLEM = 'https://api.easyconvert.io/problems/concurrency-limit';
/** A little past the 15 minutes a reservation used to live. */
const PAST_OLD_RESERVATION_LIFETIME_MS = 901_000;
const EARLY_IN_A_UTC_DAY = new Date('2026-11-02T00:00:05.000Z');
const FREE_DAILY_IMPORT_BYTES = 2 * 1024 * 1024 * 1024;
/** The deadline of a link import of the synchronous route, its default. */
const SYNC_DEADLINE_MS = 120_000;

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
   * The keys of the client as Redis sees them `ms` later: each lease ends `ms` sooner, each key's time to live shrinks by
   * `ms`, and a key whose time runs out is gone. The scripts read the time of the Redis server, which no test can move, so
   * this stands in for waiting.
   */
  async function advanceKeyClock(ms: number) {
    for (const key of await admin.keys(`*${client.userId}*`)) {
      if ((await admin.type(key)) === 'zset') {
        const leases = await admin.zrange(key, '0', '-1', 'WITHSCORES');
        for (let i = 0; i < leases.length; i += 2) await admin.zadd(key, Number(leases[i + 1]) - ms, leases[i]);
      }
      const left = await admin.pttl(key);
      if (left < 0) continue;
      if (left <= ms) await admin.del(key);
      else await admin.pexpire(key, left - ms);
    }
  }

  /** Reserves a unit as a route does, hands its lease to a job that carries it, and puts the job on a queue. */
  async function queueJobWithUnit(queue: DistributedBullMQAdapter<QuotaJob, string>, options: { attempts: number; timeout?: number }) {
    const unit = await redisKeyStore.reserveQuota(client.userId, 1);
    expect(unit.allowed).toBe(true);
    expect(await redisKeyStore.renewReservation(unit.reservationId as string, RESERVATION_LEASE.handedOffMs)).toBe(true);
    expect(await remaining()).toBe(DAY_ALLOWANCE - 1);
    return queue.add('convert', { userId: client.userId, reservationId: unit.reservationId }, options);
  }

  /** Lets `ms` pass for the quota store: the clock, and the time to live of the client's keys. */
  async function advanceQuotaClock(ms: number) {
    vi.setSystemTime(Date.now() + ms);
    await advanceKeyClock(ms);
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
      await spendImportBytes(client.userId, 'anonymous', ANONYMOUS_DAILY_UPLOAD_BYTES - Buffer.byteLength(CSV));
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
      await spendImportBytes(user.id, 'free', FREE_DAILY_IMPORT_BYTES - Buffer.byteLength(CSV));
      remoteFile(CSV);

      expect((await fetchUrlRoute(importRequest(session))).status).toBe(200);
      expect(await bytesBroughtInToday(user.id)).toBe(FREE_DAILY_IMPORT_BYTES);
      const refused = await fetchUrlRoute(importRequest(session));

      expect(refused.status).toBe(HTTP_TOO_MANY_REQUESTS);
      expect(await refused.json()).toMatchObject({ type: UPLOAD_BUDGET_PROBLEM, refusal: 'daily-bytes', limitBytes: FREE_DAILY_IMPORT_BYTES, plan: 'free' });
      expect(await admin.keys(`*upload-budget*${user.id}*`)).toHaveLength(1);
    });

    it('is refused as spent for the day when the file it reads takes the day past its budget, and is charged what it read', async () => {
      await spendImportBytes(client.userId, 'anonymous', ANONYMOUS_DAILY_UPLOAD_BYTES - 1);
      remoteFile(CSV);

      const refused = await fetchUrlRoute(importRequest());

      expect(refused.status).toBe(HTTP_TOO_MANY_REQUESTS);
      expect(await refused.json()).toMatchObject({ type: UPLOAD_BUDGET_PROBLEM, refusal: 'daily-bytes', limitBytes: ANONYMOUS_DAILY_UPLOAD_BYTES });
      expect(await bytesBroughtInToday(client.userId)).toBe(ANONYMOUS_DAILY_UPLOAD_BYTES - 1 + Buffer.byteLength(CSV));
      expect(await remaining()).toBe(DAY_ALLOWANCE);
    });

    it('charges exactly what concurrent imports received while an upload of the same caller keeps changing the record', async () => {
      const IMPORTS = 6;
      const BATCHES = 3;
      const TAIL_BYTES = 7;
      const UPLOAD_BYTES = 1024 * 1024;
      const opened = await reserveAnonymousUpload(client.userId, UPLOAD_BYTES, Date.now() + 60_000);
      if ('refusal' in opened) throw new Error(`refused: ${opened.refusal}`);
      const uploadId = `upload_${crypto.randomBytes(6).toString('hex')}`;
      await opened.reservation.bind(uploadId, Date.now() + 60_000);
      const importAll = () =>
        withLinkImportMeter({ owner: client.userId, plan: 'anonymous', limitBytes: URL_IMPORT_MAX_BYTES, deadlineMs: SYNC_DEADLINE_MS }, async (meter) => {
          for (let batch = 0; batch < BATCHES; batch++) await meter.count(LINK_IMPORT_METER_BATCH_BYTES);
          await meter.count(TAIL_BYTES);
        });

      await Promise.all([
        ...Array.from({ length: IMPORTS }, importAll),
        ...Array.from({ length: IMPORTS * BATCHES }, () => resumeUploadReservation(uploadId)),
      ]);

      expect(await bytesBroughtInToday(client.userId)).toBe(UPLOAD_BYTES + IMPORTS * (BATCHES * LINK_IMPORT_METER_BATCH_BYTES + TAIL_BYTES));
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
      await advanceQuotaClock(PAST_OLD_RESERVATION_LIFETIME_MS);
      const failing = listenedTo(new Worker(queue, async () => { throw new Error('the engine failed'); }, { concurrency: 1 }));
      const failed = settledBy(failing, 'failed');
      await failed;
      await vi.waitFor(async () => expect(await remaining()).toBe(DAY_ALLOWANCE));
      await failing.close();

      await queueJobWithUnit(queue, { attempts: 1 });
      await advanceQuotaClock(PAST_OLD_RESERVATION_LIFETIME_MS);
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

    it('extended after the count of its day expired is reported gone, and writes no count', async () => {
      const unit = await redisKeyStore.reserveQuota(client.userId, 2);
      for (const key of await admin.keys(`*usage*${client.userId}*`)) await admin.del(key);

      expect(await redisKeyStore.extendQuota(unit.reservationId as string, 'conv', 3)).toEqual({ status: 'no-reservation' });
      expect(await admin.keys(`*usage*${client.userId}*`)).toEqual([]);
    });

    it('extended after it ended is reported gone, and changes no count', async () => {
      const unit = await redisKeyStore.reserveQuota(client.userId, 2);
      await redisKeyStore.rollbackQuota(unit.reservationId as string);

      expect(await redisKeyStore.extendQuota(unit.reservationId as string, 'conv', 3)).toEqual({ status: 'no-reservation' });
      expect(await remaining()).toBe(DAY_ALLOWANCE);
    });

    it('extended past the day is refused with the conversions left, and within it holds the units of each extension once', async () => {
      const unit = await redisKeyStore.reserveQuota(client.userId, DAY_ALLOWANCE - 3);

      expect(await redisKeyStore.extendQuota(unit.reservationId as string, 'conv', 4)).toEqual({ status: 'does-not-fit', remaining: 3 });
      expect(await redisKeyStore.extendQuota(unit.reservationId as string, 'conv', 2)).toEqual({ status: 'extended' });
      expect(await redisKeyStore.extendQuota(unit.reservationId as string, 'conv', 2)).toEqual({ status: 'extended' });
      expect(await remaining()).toBe(1);
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

  describe('the lease of a reservation', () => {
    itLeasesReservations({
      store: () => redisKeyStore,
      owner: () => client.userId,
      advance: advanceQuotaClock,
    });
    itLeasesHandedOffWork({ owner: () => client.userId, advance: advanceQuotaClock });

    it('counts a live lease for a caller whose clock runs two minutes ahead, as the clock of Redis decides when it ends', async () => {
      vi.useFakeTimers({ toFake: ['Date'], now: Date.now() });
      const unit = await redisKeyStore.reserveQuota(client.userId, 1);

      vi.setSystemTime(Date.now() + 120_000);
      expect(await remaining()).toBe(DAY_ALLOWANCE - 1);
      vi.setSystemTime(Date.now() - 120_000);
      expect(await redisKeyStore.commitQuota(unit.reservationId as string)).toBe(true);
      expect(await remaining()).toBe(DAY_ALLOWANCE - 1);
    });

    it('keeps what an extension holds for as long as the renewed lease, so the same extension never holds twice', async () => {
      vi.useFakeTimers({ toFake: ['Date'], now: Date.now() });
      const unit = await redisKeyStore.reserveQuota(client.userId, 1);
      expect(await redisKeyStore.extendQuota(unit.reservationId as string, 'conv', 2)).toEqual({ status: 'extended' });
      expect(await redisKeyStore.renewReservation(unit.reservationId as string, RESERVATION_LEASE.handedOffMs)).toBe(true);

      await advanceQuotaClock(RESERVATION_LEASE.provisionalMs + 60_000);

      expect(await redisKeyStore.extendQuota(unit.reservationId as string, 'conv', 2)).toEqual({ status: 'extended' });
      expect(await remaining()).toBe(DAY_ALLOWANCE - 3);
    });

    it.each([
      ['committed', (id: string) => redisKeyStore.commitQuota(id)],
      ['given back', (id: string) => redisKeyStore.rollbackQuota(id)],
      ['settled', (id: string) => redisKeyStore.settleQuota(id, 1)],
    ])('removes what the extensions of a reservation hold once it is %s', async (_label, end) => {
      const unit = await redisKeyStore.reserveQuota(client.userId, 1);
      const reservationId = unit.reservationId as string;
      expect(await redisKeyStore.extendQuota(reservationId, 'conv', 2)).toEqual({ status: 'extended' });
      const extensions = `${redisKeyStore.getPrefix()}res:{${client.userId}}:${reservationId}:ext`;
      expect(await admin.exists(extensions)).toBe(1);

      await end(reservationId);

      expect(await admin.exists(extensions)).toBe(0);
    });
  });

  describe('a reservation made before leases, during the day after the deploy', () => {
    /** Reserves `units` as the release before leases did: the count of the day and one key that holds the units. */
    async function reservedTheOldWay(units: number): Promise<string> {
      const reservationId = reservationIdOf(client.userId, getUtcDateKey());
      const prefix = redisKeyStore.getPrefix();
      await admin.incrby(`${prefix}usage:{${client.userId}}:${getUtcDateKey()}`, units);
      await admin.set(`${prefix}res:{${client.userId}}:${reservationId}`, String(units), 'EX', 3600);
      return reservationId;
    }

    it('is given back once by a rollback', async () => {
      const reservationId = await reservedTheOldWay(2);
      expect(await remaining()).toBe(DAY_ALLOWANCE - 2);

      expect(await redisKeyStore.rollbackQuota(reservationId)).toBe(true);
      expect(await redisKeyStore.rollbackQuota(reservationId)).toBe(false);
      expect(await remaining()).toBe(DAY_ALLOWANCE);
    });

    it('stays charged once committed, and changes nothing when rolled back after', async () => {
      const reservationId = await reservedTheOldWay(1);

      expect(await redisKeyStore.commitQuota(reservationId)).toBe(true);
      expect(await redisKeyStore.rollbackQuota(reservationId)).toBe(false);
      expect(await remaining()).toBe(DAY_ALLOWANCE - 1);
    });

    it('settles to the units used', async () => {
      const reservationId = await reservedTheOldWay(3);

      expect(await redisKeyStore.settleQuota(reservationId, 1)).toEqual({ success: true, difference: -2 });
      expect(await remaining()).toBe(DAY_ALLOWANCE - 1);
    });
  });

  describe('a request that needs a conversion left but reserves none', () => {
    itNeedsOneUnitLeftForEveryCaller((userId) => otherUsers.push(userId));
  });

  describe('a queued graph', () => {
    itChargesAGraphOnlyThroughItsScheduler((userId) => otherUsers.push(userId), {
      endDay: async (owner) => {
        for (const key of await admin.keys(`*usage*${owner}*`)) await admin.del(key);
      },
    });
  });

  describe('the start of a graph that failed', () => {
    itRecoversAGraphStart({
      scheduler: () => {
        let refusing = false;
        const cancelled: string[] = [];
        const enqueueNode = async () => {
          if (refusing) throw new QueueUnavailableError('light', 'the node job could not be stored');
        };
        const cancelNode = async (graphId: string, nodeId: string) => {
          cancelled.push(`${graphId}:${nodeId}`);
          return true;
        };
        return {
          scheduler: new RedisGraphScheduler({ redisClient: admin, keyPrefix, enqueueNode, cancelNode }),
          refuseNodeJobs: (refuse) => (refusing = refuse),
          cancelledNodeJobs: () => cancelled,
          loseTheNextCancelReply: () => {
            const evaluate = admin.eval.bind(admin) as (...args: unknown[]) => Promise<unknown>;
            let lost = false;
            vi.spyOn(admin, 'eval').mockImplementation((async (...args: unknown[]) => {
              const reply = await evaluate(...args);
              if (lost || args[0] !== CANCEL_GRAPH_LUA_SCRIPT) return reply;
              lost = true;
              throw new Error('the connection dropped before the reply');
            }) as never);
          },
        };
      },
      owner: () => client.userId,
      neverStored: 'unknown',
    });

    it('leaves a start whose state cannot be read after its outbox drained on the provisional lease, so its unit comes back when that ends', async () => {
      let drained = false;
      const unreadable = new Proxy(admin, {
        get(target, prop) {
          if (prop === 'hgetall' && drained) return async () => Promise.reject(new Error('the connection dropped'));
          const value: unknown = Reflect.get(target, prop, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      const enqueueNode = async () => {
        drained = true;
      };
      const scheduler = new RedisGraphScheduler({ redisClient: unreadable, keyPrefix, enqueueNode, cancelNode: async () => true });
      const graphId = `graph_unread_${crypto.randomBytes(6).toString('hex')}`;
      const graph = { failurePolicy: 'fail_fast' as const, nodes: { up: { op: 'import.upload' as const, storageKey: `uploads/${graphId}/a.csv` } } };
      const unit = await redisKeyStore.reserveQuota(client.userId, 1);

      const handedOff = withReservedUnit(unit.reservationId, (reserved) =>
        reserved.handOff({
          start: (reservationId) => scheduler.initGraph(graphId, graph, { ownerUserId: client.userId, reservationId }),
          recover: () => scheduler.recoverStart(graphId),
        })
      );

      await expect(handedOff).rejects.toBeInstanceOf(QueueUnavailableError);
      expect(await remaining()).toBe(DAY_ALLOWANCE - 1);
      await advanceKeyClock(RESERVATION_LEASE.provisionalMs + 1000);
      expect(await remaining()).toBe(DAY_ALLOWANCE);
    });
  });

  describe('the end of a graph', () => {
    const WEBHOOK = { webhookUrl: 'https://hooks.example.com/graph', webhookSecret: 'whsec_graph_end' };

    /** A scheduler whose next `lrange` fails once `failNextListRead` is set, as a dropped connection would. */
    function schedulerWithFlakyListRead(connection: Redis) {
      const control = { failNextListRead: false };
      const flaky = new Proxy(connection, {
        get(target, prop) {
          if (prop === 'lrange') {
            return async (...args: Parameters<Redis['lrange']>) => {
              if (control.failNextListRead) {
                control.failNextListRead = false;
                throw new Error('the connection dropped');
              }
              return target.lrange(...args);
            };
          }
          const value: unknown = Reflect.get(target, prop, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      return { scheduler: new RedisGraphScheduler({ redisClient: flaky, keyPrefix, enqueueNode: async () => undefined }), control };
    }

    it('settles the reservation, sends graph.completed once and removes the files when draining the outbox fails after the completion was recorded', async () => {
      const dispatched = vi.spyOn(webhookDispatcher, 'dispatch').mockResolvedValue({ success: true, totalAttempts: 1 } as never);
      const removed = vi.spyOn(storageProvider, 'deleteByPrefix').mockResolvedValue(undefined as never);
      const connection = new Redis(REDIS_URL as string, { maxRetriesPerRequest: 1 });
      try {
        const { scheduler, control } = schedulerWithFlakyListRead(connection);
        const unit = await redisKeyStore.reserveQuota(client.userId, 2);
        const graphId = `graph_end_${crypto.randomBytes(6).toString('hex')}`;
        const graph = { failurePolicy: 'fail_fast' as const, nodes: { up: { op: 'import.upload' as const, storageKey: 'uploads/graph-end/a.csv' } } };
        await scheduler.initGraph(graphId, graph, { ownerUserId: client.userId, reservationId: unit.reservationId, ...WEBHOOK });
        expect(await remaining()).toBe(DAY_ALLOWANCE - 2);

        control.failNextListRead = true;
        expect(await scheduler.onNodeCompleted(graphId, 'up', ['uploads/graph-end/a.csv'], 1)).toMatchObject({ graphCompleted: true, graphStatus: 'completed' });

        expect((await scheduler.getGraphState(graphId))?.status).toBe('completed');
        expect(await remaining()).toBe(DAY_ALLOWANCE - 1);
        expect(dispatched.mock.calls.map((call) => call[1])).toEqual(['graph.completed']);
        expect(removed).toHaveBeenCalledWith(`intermediate/${graphId}/`);
      } finally {
        await connection.quit();
      }
    });

    it('cancels the other node jobs of a failed graph with the state read again when its first read fails', async () => {
      vi.spyOn(webhookDispatcher, 'dispatch').mockResolvedValue({ success: true, totalAttempts: 1 } as never);
      const connection = new Redis(REDIS_URL as string, { maxRetriesPerRequest: 1 });
      const control = { failNextStateRead: false };
      const flaky = new Proxy(connection, {
        get(target, prop) {
          if (prop === 'hgetall') {
            return async (...args: Parameters<Redis['hgetall']>) => {
              if (control.failNextStateRead) {
                control.failNextStateRead = false;
                throw new Error('the connection dropped');
              }
              return target.hgetall(...args);
            };
          }
          const value: unknown = Reflect.get(target, prop, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      const cancelNode = vi.fn(async () => true);
      try {
        const scheduler = new RedisGraphScheduler({ redisClient: flaky, keyPrefix, enqueueNode: async () => undefined, cancelNode });
        const graphId = `graph_end_${crypto.randomBytes(6).toString('hex')}`;
        const graph = {
          failurePolicy: 'fail_fast' as const,
          nodes: { up: { op: 'import.upload' as const, storageKey: 'uploads/graph-end/a.csv' }, conv: { op: 'convert' as const, input: 'up', targetFormat: 'json' } },
        };
        await scheduler.initGraph(graphId, graph, { ownerUserId: client.userId, ...WEBHOOK });

        control.failNextStateRead = true;
        await scheduler.onNodeFailed(graphId, 'up', 'the upload is gone');

        expect(cancelNode).toHaveBeenCalledWith(graphId, 'conv', expect.objectContaining({ op: 'convert' }), 'Graph failed due to node up');
      } finally {
        await connection.quit();
      }
    });

    it('reports as cancelled only the node jobs whose cancel succeeded when a node fails its graph', async () => {
      vi.spyOn(webhookDispatcher, 'dispatch').mockResolvedValue({ success: true, totalAttempts: 1 } as never);
      const connection = new Redis(REDIS_URL as string, { maxRetriesPerRequest: 1 });
      const cancelNode = vi.fn(async (_graphId: string, nodeId: string) => {
        if (nodeId === 'left') throw new Error('the queue did not answer');
        return true;
      });
      try {
        const scheduler = new RedisGraphScheduler({ redisClient: connection, keyPrefix, enqueueNode: async () => undefined, cancelNode });
        const graphId = `graph_end_${crypto.randomBytes(6).toString('hex')}`;
        const graph = {
          failurePolicy: 'fail_fast' as const,
          nodes: {
            up: { op: 'import.upload' as const, storageKey: 'uploads/graph-end/a.csv' },
            left: { op: 'convert' as const, input: 'up', targetFormat: 'json' },
            right: { op: 'convert' as const, input: 'up', targetFormat: 'xml' },
          },
        };
        await scheduler.initGraph(graphId, graph, { ownerUserId: client.userId, ...WEBHOOK });

        const failure = await scheduler.onNodeFailed(graphId, 'up', 'the upload is gone');

        expect(failure.graphFailed).toBe(true);
        expect(cancelNode).toHaveBeenCalledTimes(2);
        expect(failure.cancelledJobIds).toEqual([`${graphId}:right`]);
      } finally {
        await connection.quit();
      }
    });

    it('settles a graph that ends after the provisional lease of its reservation would have', async () => {
      vi.useFakeTimers({ toFake: ['Date'], now: Date.now() });
      const scheduler = new RedisGraphScheduler({ redisClient: admin, keyPrefix, enqueueNode: async () => undefined });
      const unit = await redisKeyStore.reserveQuota(client.userId, 1);
      const graphId = `graph_end_${crypto.randomBytes(6).toString('hex')}`;
      const input = `uploads/${graphId}/a.csv`;
      await scheduler.initGraph(graphId, { failurePolicy: 'fail_fast', nodes: { up: { op: 'import.upload', storageKey: input } } }, { ownerUserId: client.userId, reservationId: unit.reservationId });

      await advanceQuotaClock(RESERVATION_LEASE.provisionalMs + 1000);

      expect(await scheduler.onNodeCompleted(graphId, 'up', [input], 1)).toMatchObject({ graphCompleted: true });
      expect(await remaining()).toBe(DAY_ALLOWANCE - 1);
    });

    it('fails the completion of a node that does not end its graph when draining the outbox fails, so the node is tried again', async () => {
      const dispatched = vi.spyOn(webhookDispatcher, 'dispatch').mockResolvedValue({ success: true, totalAttempts: 1 } as never);
      const connection = new Redis(REDIS_URL as string, { maxRetriesPerRequest: 1 });
      try {
        const { scheduler, control } = schedulerWithFlakyListRead(connection);
        const unit = await redisKeyStore.reserveQuota(client.userId, 2);
        const graphId = `graph_end_${crypto.randomBytes(6).toString('hex')}`;
        const graph = {
          failurePolicy: 'fail_fast' as const,
          nodes: { up: { op: 'import.upload' as const, storageKey: 'uploads/graph-end/a.csv' }, conv: { op: 'convert' as const, input: 'up', targetFormat: 'json' } },
        };
        await scheduler.initGraph(graphId, graph, { ownerUserId: client.userId, reservationId: unit.reservationId, ...WEBHOOK });

        control.failNextListRead = true;
        await expect(scheduler.onNodeCompleted(graphId, 'up', ['uploads/graph-end/a.csv'], 0)).rejects.toThrow('the connection dropped');

        expect((await scheduler.getGraphState(graphId))?.status).toBe('running');
        expect(await remaining()).toBe(DAY_ALLOWANCE - 2);
        expect(dispatched).not.toHaveBeenCalled();
      } finally {
        await connection.quit();
      }
    });
  });
});
