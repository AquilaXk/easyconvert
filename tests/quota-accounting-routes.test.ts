import fs from 'node:fs';
import path from 'node:path';
import type Redis from 'ioredis';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('undici', async (importOriginal) => ({
  ...(await importOriginal<typeof import('undici')>()),
  fetch: vi.fn(),
}));
vi.mock('@/lib/security/ssrf', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/security/ssrf')>()),
  validateUrlForSsrf: vi.fn(async () => true),
  createSsrfSafeAgent: () => ({ close: async () => undefined }),
}));
vi.mock('@/lib/conversions/dispatch', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/conversions/dispatch')>();
  return { ...actual, dispatchConversion: vi.fn(actual.dispatchConversion) };
});

import { fetch as undiciFetch } from 'undici';
import { POST as convertRoute } from '../src/app/api/convert/route';
import { POST as batchRoute } from '../src/app/api/convert/batch/route';
import { POST as fetchUrlRoute } from '../src/app/api/fetch-url/route';
import { POST as v1ConvertRoute } from '../src/app/api/v1/convert/route';
import { POST as v1JobsRoute } from '../src/app/api/v1/jobs/route';
import { validateApiAccess } from '../src/lib/api-keys/guard';
import { redisKeyStore } from '../src/lib/api-keys/redis-key-store';
import { ANONYMOUS_DAILY_UPLOAD_BYTES, LINK_IMPORT_HOLD_GRACE_MS, bytesBroughtInToday, reserveLinkImport } from '../src/lib/api-keys/anonymous-upload-budget';
import { anonymousUserId } from '../src/lib/auth/anonymous-identity';
import { createSessionToken } from '../src/lib/auth/session';
import { redisUserStore } from '../src/lib/auth/redis-user-store';
import { userStore } from '../src/lib/auth/user-store';
import { dispatchConversion } from '../src/lib/conversions/dispatch';
import { InMemoryIdempotencyStore, setIdempotencyStore, type StoredResponse } from '../src/lib/api/idempotency';
import { acquireSyncSlot, type ConversionSlot } from '../src/lib/queue/concurrency-limit';
import { Worker } from '../src/lib/queue/bullmq-engine';
import { allConversionQueues, attachJobLifecycleListeners, processConversionJob } from '../src/lib/queue/conversion-queue';
import { graphScheduler } from '../src/lib/queue/graph';
import { storageProvider } from '../src/lib/storage';
import type { ConversionJobData, ConversionJobResult } from '../src/lib/types';
import { ANONYMOUS_DAILY_CONVERSIONS, URL_IMPORT_MAX_BYTES, getAnonymousDailyLimit, type Plan } from '../src/lib/plan-limits';
import { itNeedsOneUnitLeftForEveryCaller } from './helpers/unit-left-identities';
import { gzipRemote } from './helpers/gzip-remote';

/**
 * Only a successful conversion is charged (QA decision of 2026-11-02): a refusal, a failure and a link import leave the
 * day's remaining count where it was, and the anonymous allowance is the one the copy states.
 */

const HTTP_TOO_MANY_REQUESTS = 429;
const HTTP_GATEWAY_TIMEOUT = 504;
const HTTP_CLIENT_CLOSED_REQUEST = 499;
const FREE_CONCURRENCY = 5;
const QUOTA_EXCEEDED_PROBLEM = 'https://api.easyconvert.io/problems/quota-exceeded';
const UPLOAD_BUDGET_PROBLEM = 'https://api.easyconvert.io/problems/upload-budget-exceeded';
const CONCURRENCY_PROBLEM = 'https://api.easyconvert.io/problems/concurrency-limit';
const GRAPH_WITHOUT_CONVERSION_PROBLEM = 'https://api.easyconvert.io/problems/graph-without-conversion';
const CSV = 'name,score\nAlice,100\nBob,95\n';
/** The deadline of an import that spends bytes directly; its hold is settled at once. */
const IMPORT_DEADLINE_MS = 120_000;
/** The test configuration lifts the limit for every suite; this one counts against the real allowance. */
const DAY_ALLOWANCE = 25;
const NOT_A_PNG = 'this is plain text, not a PNG picture';
const MIB = 1024 * 1024;
const GIB = 1024 * MIB;
const TRUST_UNCONFIGURED_PROBLEM = 'https://api.easyconvert.io/problems/client-ip-trust-unconfigured';

let nextClient = 1;

/** A visitor behind a declared front proxy that reports the address it saw: a fresh anonymous identity per call. */
function visitor() {
  const ip = `203.0.113.${nextClient++}`;
  return {
    userId: anonymousUserId(ip),
    headers: { 'x-forwarded-for': ip },
    remaining: async () => (await redisKeyStore.getQuotaUsage(anonymousUserId(ip))).remaining,
    spend: async (units: number) => {
      for (let i = 0; i < units; i++) {
        const unit = await redisKeyStore.reserveQuota(anonymousUserId(ip), 1);
        await redisKeyStore.commitQuota(unit.reservationId as string);
      }
    },
  };
}

type Visitor = ReturnType<typeof visitor>;

function convertRequest(client: Visitor, fields: { name: string; content: string; target?: string; options?: string }, signal?: AbortSignal) {
  const form = new FormData();
  form.append('file', new File([fields.content], fields.name));
  if (fields.target) form.append('targetFormat', fields.target);
  if (fields.options) form.append('options', fields.options);
  return new NextRequest('http://localhost/api/convert', { method: 'POST', headers: client.headers, body: form, signal });
}

function batchRequest(client: Visitor, files: Array<{ name: string; content: string }>, targetFormats?: string) {
  const form = new FormData();
  for (const file of files) form.append('files', new File([file.content], file.name));
  if (targetFormats) form.append('targetFormats', targetFormats);
  return new NextRequest('http://localhost/api/convert/batch', { method: 'POST', headers: client.headers, body: form });
}

function importRequest(client: { headers: Record<string, string> }, signal?: AbortSignal) {
  return new NextRequest('http://localhost/api/fetch-url', {
    method: 'POST',
    headers: { ...client.headers, 'content-type': 'application/json' },
    body: JSON.stringify({ url: 'https://files.example.com/scores.csv' }),
    signal,
  });
}

/** A signed-in account of `tier`, sending its session cookie. */
async function account(tier: 'free' | 'pro') {
  const email = `import-budget-${tier}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@quota.test`;
  const user = userStore.sanitizeUser(await userStore.createUser({ email, name: 'Import Budget', tier }));
  return { userId: user.id, headers: { cookie: `easyconvert_session=${createSessionToken(user)}` } };
}

/** Uses `bytes` of the day's import budget of `userId`, as an import that received them would. */
async function spendImportBytes(userId: string, plan: Plan, bytes: number) {
  const held = await reserveLinkImport(userId, plan, IMPORT_DEADLINE_MS);
  if ('refusal' in held) throw new Error(`the import budget of ${userId} is already spent`);
  await held.reservation.settle(bytes);
}

/** A remote that sends `first`, then `afterAbort` a little after the import is aborted, then fails the body. */
function remoteCutOffMidBody(first: string, afterAbort: string, onStart: () => void = () => undefined) {
  vi.mocked(undiciFetch).mockImplementation(async (_url, init) => {
    const signal = (init as { signal?: AbortSignal } | undefined)?.signal;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(first));
        signal?.addEventListener('abort', () =>
          setTimeout(() => {
            controller.enqueue(new TextEncoder().encode(afterAbort));
            setTimeout(() => controller.error(signal.reason), 0);
          }, 20)
        );
        onStart();
      },
    });
    return new Response(body, { status: 200, headers: { 'content-type': 'text/csv' } }) as never;
  });
}

function remoteFile(content: string, contentType = 'text/csv') {
  vi.mocked(undiciFetch).mockImplementation(async () => new Response(content, { status: 200, headers: { 'content-type': contentType } }) as never);
}

/** A conversion that never ends on its own; `started` runs when the route has handed it the file. */
function endlessConversion(started: () => void = () => undefined) {
  vi.mocked(dispatchConversion).mockImplementationOnce(() => {
    started();
    return new Promise(() => undefined);
  });
}

async function holdEverySlot(userId: string): Promise<() => void> {
  const held: ConversionSlot[] = [];
  for (let i = 0; i < FREE_CONCURRENCY; i++) held.push(await acquireSyncSlot(userId, 'free'));
  return () => held.forEach((slot) => slot.granted && slot.release());
}

/** The suites count in this process: the stores keep their counters here even when REDIS_URL names a server. */
let redisClients: { keys: Redis | null; users: Redis | null };

beforeEach(() => {
  redisClients = { keys: redisKeyStore.getRedisClient(), users: redisUserStore.getRedisClient() };
  redisKeyStore.setRedisClient(null);
  redisUserStore.setRedisClient(null);
});

afterEach(() => {
  redisKeyStore.setRedisClient(redisClients.keys);
  redisUserStore.setRedisClient(redisClients.users);
});

describe('what a request is charged', () => {
  beforeEach(() => {
    vi.stubEnv('TRUSTED_PROXIES', '10.0.0.0/8');
    vi.stubEnv('ANONYMOUS_DAILY_LIMIT', String(DAY_ALLOWANCE));
    redisKeyStore.resetStore();
    vi.mocked(undiciFetch).mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe('the anonymous allowance', () => {
    it('is 25 conversions a day when nothing configures it', () => {
      vi.stubEnv('ANONYMOUS_DAILY_LIMIT', '');
      expect(getAnonymousDailyLimit()).toBe(25);
      expect(ANONYMOUS_DAILY_CONVERSIONS).toBe(25);
    });

    it('names the configured limit in the refusal, not a literal', async () => {
      vi.stubEnv('ANONYMOUS_DAILY_LIMIT', '3');
      const client = visitor();
      await client.spend(3);

      const res = await convertRoute(convertRequest(client, { name: 'scores.csv', content: CSV, target: 'json' }));

      expect(res.status).toBe(HTTP_TOO_MANY_REQUESTS);
      const body = await res.json();
      expect(body.detail ?? body.error).toContain('3 conversions per day');
    });
  });

  describe('a link import', () => {
    it('is free: the file comes back and the remaining count is unchanged', async () => {
      const client = visitor();
      const before = await client.remaining();
      remoteFile(CSV);

      const res = await fetchUrlRoute(importRequest(client));

      expect(res.status).toBe(200);
      expect(await client.remaining()).toBe(before);
    });

    it('followed by the conversion of the file costs exactly one conversion', async () => {
      const client = visitor();
      const before = await client.remaining();
      remoteFile(CSV);
      const imported = await fetchUrlRoute(importRequest(client));
      expect(imported.status).toBe(200);

      const converted = await convertRoute(
        convertRequest(client, { name: 'scores.csv', content: await imported.text(), target: 'json' })
      );

      expect(converted.status).toBe(200);
      expect(await client.remaining()).toBe(before - 1);
    });

    it('is free when the remote answers with an error', async () => {
      const client = visitor();
      const before = await client.remaining();
      vi.mocked(undiciFetch).mockResolvedValue(new Response('gone', { status: 404, statusText: 'Not Found' }) as never);

      const res = await fetchUrlRoute(importRequest(client));

      expect(res.status).toBe(400);
      expect(await client.remaining()).toBe(before);
    });

    it('is refused up front with the quota problem when the caller has no conversion left', async () => {
      const client = visitor();
      await client.spend(await client.remaining());
      remoteFile(CSV);

      const res = await fetchUrlRoute(importRequest(client));

      expect(res.status).toBe(HTTP_TOO_MANY_REQUESTS);
      expect((await res.json()).type).toBe(QUOTA_EXCEEDED_PROBLEM);
      expect(vi.mocked(undiciFetch)).not.toHaveBeenCalled();
    });

    it('counts the bytes it brings in against the daily byte budget and is refused once that is spent', async () => {
      const client = visitor();
      const before = await client.remaining();
      await spendImportBytes(client.userId, 'anonymous', ANONYMOUS_DAILY_UPLOAD_BYTES - Buffer.byteLength(CSV));
      remoteFile(CSV);

      expect((await fetchUrlRoute(importRequest(client))).status).toBe(200);
      const refused = await fetchUrlRoute(importRequest(client));

      expect(refused.status).toBe(HTTP_TOO_MANY_REQUESTS);
      expect(await refused.json()).toMatchObject({ type: UPLOAD_BUDGET_PROBLEM, refusal: 'daily-bytes' });
      expect(vi.mocked(undiciFetch)).toHaveBeenCalledTimes(1);
      expect(await client.remaining()).toBe(before);
    });

    it.each([
      ['free', 2 * GIB],
      ['pro', 10 * GIB],
    ] as const)('by a %s account is refused once the plan allowance of %d bytes is spent', async (tier, allowance) => {
      const caller = await account(tier);
      await spendImportBytes(caller.userId, tier, allowance - Buffer.byteLength(CSV));
      remoteFile(CSV);

      expect((await fetchUrlRoute(importRequest(caller))).status).toBe(200);
      const refused = await fetchUrlRoute(importRequest(caller));

      expect(refused.status).toBe(HTTP_TOO_MANY_REQUESTS);
      expect(await refused.json()).toMatchObject({ type: UPLOAD_BUDGET_PROBLEM, refusal: 'daily-bytes', limitBytes: allowance, plan: tier });
      expect(vi.mocked(undiciFetch)).toHaveBeenCalledTimes(1);
    });

    it('is refused to the shared identity of visitors no proxy attributes, as an upload is', async () => {
      vi.stubEnv('TRUSTED_PROXIES', 'none');
      remoteFile(CSV);

      const res = await fetchUrlRoute(importRequest({ headers: {} }));

      expect(res.status).toBe(503);
      expect((await res.json()).type).toBe(TRUST_UNCONFIGURED_PROBLEM);
      expect(vi.mocked(undiciFetch)).not.toHaveBeenCalled();
    });

    it('holds the bytes it may still read while it runs, so a second import beside it is refused as held, not as spent', async () => {
      const client = visitor();
      await spendImportBytes(client.userId, 'anonymous', ANONYMOUS_DAILY_UPLOAD_BYTES - Buffer.byteLength(CSV));
      let send: () => void = () => undefined;
      remoteFile(CSV);
      vi.mocked(undiciFetch).mockImplementationOnce(async () => {
        await new Promise<void>((resolve) => (send = resolve));
        return new Response(CSV, { status: 200, headers: { 'content-type': 'text/csv' } }) as never;
      });
      const first = fetchUrlRoute(importRequest(client));
      await vi.waitFor(() => expect(vi.mocked(undiciFetch)).toHaveBeenCalledTimes(1));

      const second = await fetchUrlRoute(importRequest(client));
      send();

      expect(second.status).toBe(HTTP_TOO_MANY_REQUESTS);
      expect((await second.json()).refusal).toBe('held');
      expect(vi.mocked(undiciFetch)).toHaveBeenCalledTimes(1);
      expect((await first).status).toBe(200);
    });

    /** A remote that sends `mebibytes` of body a mebibyte at a time, declaring its length when asked; it records a cancel. */
    function remoteOfMebibytes(mebibytes: number, options: { declared?: boolean } = {}) {
      const sent = { chunks: 0, cancelled: false };
      vi.mocked(undiciFetch).mockImplementation(async () => {
        const body = new ReadableStream<Uint8Array>({
          pull: (controller) => {
            if (sent.chunks++ < mebibytes) controller.enqueue(new Uint8Array(MIB));
            else controller.close();
          },
          cancel: () => {
            sent.cancelled = true;
          },
        });
        const headers = options.declared ? { 'content-length': String(mebibytes * MIB) } : undefined;
        return new Response(body, { status: 200, headers }) as never;
      });
      return sent;
    }

    /** A visitor whose day has `leftMebibytes` left after what it received, with `heldMebibytes` of that held by another import still running. */
    async function visitorWithDayLeft(leftMebibytes: number, heldMebibytes = 0) {
      const client = visitor();
      await spendImportBytes(client.userId, 'anonymous', ANONYMOUS_DAILY_UPLOAD_BYTES - leftMebibytes * MIB);
      if (heldMebibytes > 0) {
        const other = await reserveLinkImport(client.userId, 'anonymous', IMPORT_DEADLINE_MS, heldMebibytes * MIB, 'another-import');
        if ('refusal' in other) throw new Error('the other import was refused');
      }
      return client;
    }

    it.each([
      ['whose length it learns as it reads', false],
      ['whose declared length fits once the other import ends', true],
    ])('is told to wait for another import, not for tomorrow, when it holds part of a file %s', async (_label, declared) => {
      const client = await visitorWithDayLeft(150, 100);
      remoteOfMebibytes(60, { declared });

      const res = await fetchUrlRoute(importRequest(client));

      expect(res.status).toBe(HTTP_TOO_MANY_REQUESTS);
      expect(res.headers.get('retry-after')).toBe('2');
      expect(await res.json()).toMatchObject({ type: UPLOAD_BUDGET_PROBLEM, refusal: 'held' });
    });

    it('refuses a file that declares more than the day has left before reading a byte, and names what is left', async () => {
      const client = await visitorWithDayLeft(30);
      const remote = remoteOfMebibytes(40, { declared: true });

      const res = await fetchUrlRoute(importRequest(client));

      expect(res.status).toBe(HTTP_TOO_MANY_REQUESTS);
      expect(await res.json()).toMatchObject({ type: UPLOAD_BUDGET_PROBLEM, refusal: 'larger-than-left', leftBytes: 30 * MIB });
      expect(remote.cancelled).toBe(true);
      expect(await bytesBroughtInToday(client.userId)).toBe(ANONYMOUS_DAILY_UPLOAD_BYTES - 30 * MIB);
    });

    it('stops reading once the day passes its budget while it reads, refuses the file as spent for the day, and is charged at most one batch past the budget', async () => {
      const client = await visitorWithDayLeft(1);
      const remote = remoteOfMebibytes(64);

      const res = await fetchUrlRoute(importRequest(client));

      expect(res.status).toBe(HTTP_TOO_MANY_REQUESTS);
      expect(await res.json()).toMatchObject({ type: UPLOAD_BUDGET_PROBLEM, refusal: 'daily-bytes' });
      expect(remote.cancelled).toBe(true);
      const charged = await bytesBroughtInToday(client.userId);
      expect(charged).toBeGreaterThan(ANONYMOUS_DAILY_UPLOAD_BYTES);
      expect(charged).toBeLessThanOrEqual(ANONYMOUS_DAILY_UPLOAD_BYTES + 4 * MIB);
    });

    it('imports a gzipped file whose Content-Length is its compressed size whole, and is charged the bytes it decoded', async () => {
      const client = visitor();
      const csv = `name,score\n${'Alice,100\n'.repeat(2000)}`;
      const remote = await gzipRemote(csv);
      try {
        const res = await fetchUrlRoute(importRequest(client));

        expect(res.status).toBe(200);
        expect(await res.text()).toBe(csv);
        expect(remote.compressedBytes).toBeLessThan(Buffer.byteLength(csv));
        expect(await bytesBroughtInToday(client.userId)).toBe(Buffer.byteLength(csv));
      } finally {
        await remote.close();
      }
    });

    it('holds its bytes for the synchronous deadline and the grace after it, so an import that never stops reading gives them back then', async () => {
      const deadlineMs = 200;
      vi.stubEnv('SYNC_DEADLINE_MAX_MS', String(deadlineMs));
      const startedAt = Date.parse('2026-11-02T12:00:00.000Z');
      vi.useFakeTimers({ toFake: ['Date'], now: startedAt });
      let endBody: () => void = () => undefined;
      vi.mocked(undiciFetch).mockImplementation(async () => {
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('name,score\n'));
            endBody = () => controller.close();
          },
        });
        return new Response(body, { status: 200, headers: { 'content-type': 'text/csv' } }) as never;
      });
      const client = visitor();
      try {
        expect((await fetchUrlRoute(importRequest(client))).status).toBe(HTTP_GATEWAY_TIMEOUT);

        const holdEnds = startedAt + deadlineMs + LINK_IMPORT_HOLD_GRACE_MS;
        vi.setSystemTime(holdEnds - 1);
        expect(await bytesBroughtInToday(client.userId)).toBe(URL_IMPORT_MAX_BYTES);
        vi.setSystemTime(holdEnds);
        expect(await bytesBroughtInToday(client.userId)).toBe(0);
      } finally {
        endBody();
        vi.useRealTimers();
      }
    });

    describe('is charged the bytes it received, however it ends', () => {
      const ends: Array<[string, (client: AbortController) => void, number, number]> = [
        ['a file it imports (200)', () => remoteFile(CSV), 200, Buffer.byteLength(CSV)],
        [
          'a file over the import limit (413)',
          () => {
            const mebibyte = new Uint8Array(MIB);
            vi.mocked(undiciFetch).mockImplementation(async () => {
              const body = new ReadableStream<Uint8Array>({ pull: (controller) => controller.enqueue(mebibyte) });
              return new Response(body, { status: 200 }) as never;
            });
          },
          413,
          101 * MIB,
        ],
        [
          'a remote still sending at the deadline (504), the bytes read after it included',
          () => {
            vi.stubEnv('SYNC_DEADLINE_MAX_MS', '200');
            remoteCutOffMidBody('name,score\n', 'Alice,100\n');
          },
          HTTP_GATEWAY_TIMEOUT,
          21,
        ],
        [
          'a client that goes away mid-body (499)',
          (client) => remoteCutOffMidBody('name,score\n', 'Alice,100\n', () => setTimeout(() => client.abort(), 20)),
          HTTP_CLIENT_CLOSED_REQUEST,
          21,
        ],
        [
          'a remote error (502), whose body it never reads',
          () => vi.mocked(undiciFetch).mockImplementation(async () => new Response('upstream is down', { status: 503, statusText: 'Service Unavailable' }) as never),
          502,
          0,
        ],
      ];

      it.each(ends)('%s', async (_label, arrange, status, receivedBytes) => {
        const client = visitor();
        const clientConnection = new AbortController();
        arrange(clientConnection);

        const res = await fetchUrlRoute(importRequest(client, clientConnection.signal));

        expect(res.status).toBe(status);
        await vi.waitFor(async () => expect(await bytesBroughtInToday(client.userId)).toBe(receivedBytes));
      });
    });

    it.each([
      ['a redirect it follows', 302, { location: 'https://files.example.com/moved.csv' }, 200],
      ['an error answer', 503, {}, 502],
      ['a file whose declared length is over the import limit', 200, { 'content-length': String(101 * MIB) }, 413],
    ] as const)('stops the remote sending the body of %s', async (_label, remoteStatus, headers, status) => {
      let cancelled = false;
      const unread = new ReadableStream<Uint8Array>({
        start: (controller) => controller.enqueue(new TextEncoder().encode('a body the import does not read')),
        cancel: () => {
          cancelled = true;
        },
      });
      remoteFile(CSV);
      vi.mocked(undiciFetch).mockImplementationOnce(async () => new Response(unread, { status: remoteStatus, headers }) as never);

      const res = await fetchUrlRoute(importRequest(visitor()));

      expect(res.status).toBe(status);
      expect(cancelled).toBe(true);
    });

    it('is still allowed with one conversion left, which it leaves for the conversion', async () => {
      const client = visitor();
      await client.spend((await client.remaining()) - 1);
      remoteFile(CSV);

      const imported = await fetchUrlRoute(importRequest(client));

      expect(imported.status).toBe(200);
      expect(await client.remaining()).toBe(1);
    });
  });

  describe('a refusal of /api/convert after the unit was reserved', () => {
    const refusals: Array<[string, { name: string; content: string; target?: string; options?: string }, number]> = [
      ['a file that is not what its extension says', { name: 'picture.png', content: NOT_A_PNG, target: 'jpg' }, 400],
      ['no target format', { name: 'scores.csv', content: CSV }, 400],
      ['an unknown source extension', { name: 'scores.zzzz', content: CSV, target: 'json' }, 400],
      ['a pair no engine converts', { name: 'scores.csv', content: CSV, target: 'mp4' }, 400],
      ['options that are not JSON', { name: 'scores.csv', content: CSV, target: 'json', options: '{not json' }, 400],
      ['options that are not an object', { name: 'scores.csv', content: CSV, target: 'json', options: '[1]' }, 400],
    ];

    it.each(refusals)('charges nothing for %s', async (_, fields, status) => {
      const client = visitor();
      const before = await client.remaining();

      const res = await convertRoute(convertRequest(client, fields));

      expect(res.status).toBe(status);
      expect(await client.remaining()).toBe(before);
    });

    it('charges one conversion for the same request when it succeeds', async () => {
      const client = visitor();
      const before = await client.remaining();

      const res = await convertRoute(convertRequest(client, { name: 'scores.csv', content: CSV, target: 'json' }));

      expect(res.status).toBe(200);
      expect(await client.remaining()).toBe(before - 1);
    });
  });

  describe('a synchronous conversion that does not finish', () => {
    it('charges nothing when it runs past its deadline (504)', async () => {
      vi.stubEnv('SYNC_DEADLINE_MAX_MS', '50');
      const client = visitor();
      const before = await client.remaining();
      endlessConversion();

      const res = await convertRoute(convertRequest(client, { name: 'scores.csv', content: CSV, target: 'json' }));

      expect(res.status).toBe(HTTP_GATEWAY_TIMEOUT);
      expect(await client.remaining()).toBe(before);
    });

    it('charges nothing when the client goes away (499)', async () => {
      const client = visitor();
      const before = await client.remaining();
      const departure = new AbortController();
      endlessConversion(() => departure.abort());

      const res = await convertRoute(convertRequest(client, { name: 'scores.csv', content: CSV, target: 'json' }, departure.signal));

      expect(res.status).toBe(HTTP_CLIENT_CLOSED_REQUEST);
      expect(await client.remaining()).toBe(before);
    });

    it('charges nothing when the caller already has every conversion slot (429), on a single file or a batch', async () => {
      const client = visitor();
      const before = await client.remaining();
      const release = await holdEverySlot(client.userId);

      const single = await convertRoute(convertRequest(client, { name: 'scores.csv', content: CSV, target: 'json' }));
      const batch = await batchRoute(batchRequest(client, [{ name: 'scores.csv', content: CSV }], JSON.stringify({ default: 'json' })));
      release();

      expect([single.status, batch.status]).toEqual([HTTP_TOO_MANY_REQUESTS, HTTP_TOO_MANY_REQUESTS]);
      expect((await single.json()).type).toBe(CONCURRENCY_PROBLEM);
      expect(await client.remaining()).toBe(before);
    });
  });

  describe('a reservation', () => {
    it('rolled back after it was committed leaves the count charged', async () => {
      const client = visitor();
      const before = await client.remaining();
      const unit = await redisKeyStore.reserveQuota(client.userId, 1);
      await redisKeyStore.commitQuota(unit.reservationId as string);

      expect(await redisKeyStore.rollbackQuota(unit.reservationId as string)).toBe(false);
      expect(await client.remaining()).toBe(before - 1);
    });

    it('settled after it was rolled back changes nothing', async () => {
      const client = visitor();
      const before = await client.remaining();
      const unit = await redisKeyStore.reserveQuota(client.userId, 1);
      await redisKeyStore.rollbackQuota(unit.reservationId as string);

      expect((await redisKeyStore.settleQuota(unit.reservationId as string, 1)).success).toBe(false);
      expect(await client.remaining()).toBe(before);
    });

    it('is kept, however long its request runs that day, until the request gives it back', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      try {
        vi.setSystemTime(new Date('2026-11-02T00:00:05.000Z'));
        const client = visitor();
        const before = await client.remaining();
        const unit = await redisKeyStore.reserveQuota(client.userId, 1);

        vi.setSystemTime(new Date('2026-11-02T00:20:05.000Z'));
        expect(await client.remaining()).toBe(before - 1);
        expect(await redisKeyStore.rollbackQuota(unit.reservationId as string)).toBe(true);
        expect(await client.remaining()).toBe(before);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('a batch', () => {
    it('charges nothing when its target formats are not JSON', async () => {
      const client = visitor();
      const before = await client.remaining();

      const res = await batchRoute(batchRequest(client, [{ name: 'scores.csv', content: CSV }], '{not json'));

      expect(res.status).toBe(400);
      expect(await client.remaining()).toBe(before);
    });

    it('reserves only for the files it will convert, so a file it skips cannot use up the last conversion', async () => {
      const client = visitor();
      await client.spend((await client.remaining()) - 1);

      const res = await batchRoute(
        batchRequest(client, [{ name: 'scores.csv', content: CSV }, { name: 'other.zzzz', content: CSV }], JSON.stringify({ default: 'json' }))
      );

      expect(res.status).toBe(200);
      expect(await client.remaining()).toBe(0);
    });

    it('charges one conversion for each file that was converted, not for a file it had to skip', async () => {
      const client = visitor();
      const before = await client.remaining();

      const res = await batchRoute(
        batchRequest(
          client,
          [
            { name: 'scores.csv', content: CSV },
            { name: 'other.zzzz', content: CSV },
          ],
          JSON.stringify({ default: 'json' })
        )
      );

      expect(res.status).toBe(200);
      expect(await client.remaining()).toBe(before - 1);
    });
  });

  describe('/api/v1/convert', () => {
    /** An idempotency store that takes the lock of a key but cannot record an answer. */
    class StoreThatCannotRecord extends InMemoryIdempotencyStore {
      public override complete(_scopedKey: string, _fingerprint: string, _response: StoredResponse): Promise<boolean> {
        return Promise.reject(new Error('the idempotency store went away'));
      }
    }

    afterEach(() => setIdempotencyStore(null));

    it('answers a finished conversion and charges it once when its answer cannot be recorded', async () => {
      setIdempotencyStore(new StoreThatCannotRecord());
      const user = userStore.sanitizeUser(await userStore.createUser({ email: `v1-${Date.now()}@quota.test`, name: 'V1', tier: 'free' }));
      const { secretKey } = await redisKeyStore.generateApiKey(user.id, 'v1 key', { scopes: ['convert:write'] });
      const remaining = async () => (await redisKeyStore.getQuotaUsage(user.id)).remaining;
      const before = await remaining();
      const request = () => {
        const form = new FormData();
        form.append('file', new File([CSV], 'scores.csv'));
        form.append('targetFormat', 'json');
        return new NextRequest('http://localhost/api/v1/convert', {
          method: 'POST',
          headers: { authorization: `Bearer ${secretKey}`, 'idempotency-key': 'scores-once' },
          body: form,
        });
      };
      const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);

      const first = await v1ConvertRoute(request());
      const repeat = await v1ConvertRoute(request());
      errors.mockRestore();

      expect(first.status).toBe(200);
      expect(repeat.status).not.toBe(200);
      expect(await remaining()).toBe(before - 1);
    });
  });

  describe('/api/v1/jobs', () => {
    const FREE_DAY_ALLOWANCE = 25;
    let worker: Worker<ConversionJobData, ConversionJobResult> | undefined;

    afterEach(async () => {
      await worker?.close();
      worker = undefined;
    });

    async function apiCaller() {
      const user = userStore.sanitizeUser(await userStore.createUser({ email: `v1-jobs-${Date.now()}-${nextClient++}@quota.test`, name: 'V1 jobs', tier: 'free' }));
      const { secretKey } = await redisKeyStore.generateApiKey(user.id, 'v1 jobs key', { scopes: ['convert:write'] });
      return { userId: user.id, usedToday: async () => (await redisKeyStore.getQuotaUsage(user.id)).usedToday, authorization: `Bearer ${secretKey}` };
    }

    async function storedCsv(): Promise<string> {
      const storageKey = `uploads/quota-v1-jobs-${Date.now()}-${nextClient++}/scores.csv`;
      await storageProvider.saveObject(storageKey, Buffer.from(CSV), 'text/csv', 'scores.csv', 60 * 60 * 1000);
      return storageKey;
    }

    function submitJob(authorization: string, body: Record<string, unknown>) {
      return v1JobsRoute(
        new NextRequest('http://localhost/api/v1/jobs', {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization },
          body: JSON.stringify(body),
        })
      );
    }

    async function submitTasks(authorization: string, tasks: Array<{ name: string; operation: string; targetFormat: string }>) {
      return submitJob(authorization, { storageKey: await storedCsv(), tasks });
    }

    function submitGraph(authorization: string, graph: Record<string, unknown>) {
      return submitJob(authorization, { graph });
    }

    it('charges a tasks pipeline that imports, converts and exports one conversion', async () => {
      const caller = await apiCaller();
      worker = new Worker<ConversionJobData, ConversionJobResult>([...allConversionQueues] as never, processConversionJob, { concurrency: 2 });
      attachJobLifecycleListeners(worker);

      const submitted = await submitTasks(caller.authorization, [{ name: 'c', operation: 'convert', targetFormat: 'json' }]);
      expect(submitted.status).toBe(202);
      const { jobId } = (await submitted.json()) as { jobId: string };

      await vi.waitFor(async () => expect((await graphScheduler.getGraphState(jobId))?.status).toBe('completed'), { timeout: 20_000, interval: 100 });
      await vi.waitFor(async () => expect(await caller.usedToday()).toBe(1));
    }, 30_000);

    it('refuses up front a graph of three conversions when the caller has two left, and says how many it needs and has', async () => {
      const caller = await apiCaller();
      await redisKeyStore.recordUsage(caller.userId, FREE_DAY_ALLOWANCE - 2);

      const refused = await submitTasks(caller.authorization, [
        { name: 'a', operation: 'convert', targetFormat: 'tsv' },
        { name: 'b', operation: 'convert', targetFormat: 'csv' },
        { name: 'c', operation: 'convert', targetFormat: 'json' },
      ]);

      expect(refused.status).toBe(HTTP_TOO_MANY_REQUESTS);
      expect(refused.headers.get('RateLimit-Remaining')).toBe('2');
      const problem = await refused.json();
      expect(problem).toMatchObject({ type: QUOTA_EXCEEDED_PROBLEM, remaining: 2, requiredUnits: 3, dailyLimit: FREE_DAY_ALLOWANCE });
      expect(problem.detail).toContain('needs 3 conversions and 2 are left today');
      expect(await caller.usedToday()).toBe(FREE_DAY_ALLOWANCE - 2);
    });

    it('reserves a convert node one unit for each input it declares', async () => {
      const caller = await apiCaller();
      await redisKeyStore.recordUsage(caller.userId, FREE_DAY_ALLOWANCE - 1);

      const refused = await submitGraph(caller.authorization, {
        nodes: {
          first: { op: 'import.upload', storageKey: await storedCsv() },
          second: { op: 'import.upload', storageKey: await storedCsv() },
          conv: { op: 'convert', input: ['first', 'second'], targetFormat: 'json' },
          out: { op: 'export.internal', input: 'conv' },
        },
      });

      expect(refused.status, await refused.clone().text()).toBe(HTTP_TOO_MANY_REQUESTS);
      expect(await refused.json()).toMatchObject({ remaining: 1, requiredUnits: 2 });
      expect(await caller.usedToday()).toBe(FREE_DAY_ALLOWANCE - 1);
    });

    it('refuses a graph without a conversion with 422, before anything is reserved', async () => {
      const caller = await apiCaller();

      const refused = await submitGraph(caller.authorization, {
        nodes: { link: { op: 'import.url', url: 'https://files.example.com/scores.csv' }, out: { op: 'export.internal', input: 'link' } },
      });

      expect(refused.status).toBe(422);
      expect((await refused.json()).type).toBe(GRAPH_WITHOUT_CONVERSION_PROBLEM);
      expect(await caller.usedToday()).toBe(0);
      expect(vi.mocked(undiciFetch)).not.toHaveBeenCalled();
    });

    it('answers 503, not 429, when the quota store cannot reserve', async () => {
      const caller = await apiCaller();
      vi.spyOn(redisKeyStore, 'reserveQuota').mockResolvedValueOnce({ allowed: false, remaining: 0, serviceUnavailable: true, error: 'the quota store is offline' });

      const refused = await submitTasks(caller.authorization, [{ name: 'c', operation: 'convert', targetFormat: 'json' }]);

      expect(refused.status).toBe(503);
      expect(await caller.usedToday()).toBe(0);
    });
  });

  describe('a request that needs a conversion left but reserves none', () => {
    itNeedsOneUnitLeftForEveryCaller();
  });
});

describe('the anonymous allowance behind the production proxy', () => {
  const root = path.join(__dirname, '..');
  const compose = fs.readFileSync(path.join(root, 'docker-compose.prod.yml'), 'utf-8');
  /** The trust declaration the production stack starts with when the operator sets none. */
  const productionTrustedProxies = /TRUSTED_PROXIES: \$\{EASYCONVERT_TRUSTED_PROXIES:-([^}]+)\}/.exec(compose)?.[1] ?? '';

  beforeEach(() => {
    vi.stubEnv('TRUSTED_PROXIES', productionTrustedProxies);
    vi.stubEnv('ANONYMOUS_DAILY_LIMIT', String(DAY_ALLOWANCE));
    redisKeyStore.resetStore();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const anonymousRequest = (forwardedFor: string) =>
    new NextRequest('http://localhost/api/convert', { method: 'POST', headers: { 'x-forwarded-for': forwardedFor } });
  const reserve = (forwardedFor: string) =>
    validateApiAccess(anonymousRequest(forwardedFor), { requiredUnits: 1, allowAnonymous: true });

  it('starts with a trust declaration when the operator sets none', () => {
    expect(productionTrustedProxies).not.toBe('');
  });

  it('counts each visitor by the address the proxy reports, so one visitor using the allowance leaves another theirs', async () => {
    for (let i = 0; i < DAY_ALLOWANCE; i++) {
      const auth = await reserve('198.51.100.7');
      expect(auth.user?.id).toBe('anon:198.51.100.7');
      await redisKeyStore.commitQuota(auth.reservationId as string);
    }

    const sameVisitor = await reserve('198.51.100.7');
    const otherVisitor = await reserve('198.51.100.8');

    expect([sameVisitor.authorized, sameVisitor.status]).toEqual([false, HTTP_TOO_MANY_REQUESTS]);
    expect([otherVisitor.authorized, otherVisitor.user?.id]).toEqual([true, 'anon:198.51.100.8']);
  });

  it('ignores addresses a client wrote to the left of the one the proxy appended', async () => {
    const forged = await reserve('9.9.9.9, 198.51.100.7');
    expect(forged.user?.id).toBe('anon:198.51.100.7');
  });

  it('gives no per-visitor allowance when the operator declares TRUSTED_PROXIES=none, which is why the stack does not', async () => {
    vi.stubEnv('TRUSTED_PROXIES', 'none');
    const first = await reserve('198.51.100.7');
    const second = await reserve('198.51.100.8');
    expect([first.user?.id, second.user?.id]).toEqual(['anon:unattributed', 'anon:unattributed']);
    expect([first.reservationId, second.reservationId]).toEqual([undefined, undefined]);
  });
});
