import crypto from 'node:crypto';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('../src/lib/conversions/dispatch', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/lib/conversions/dispatch')>();
  return { ...original, dispatchConversion: vi.fn() };
});

import { dispatchConversion } from '../src/lib/conversions/dispatch';
import { POST as convertRoute } from '../src/app/api/convert/route';
import { POST as v1ConvertRoute } from '../src/app/api/v1/convert/route';
import { POST as batchRoute } from '../src/app/api/convert/batch/route';
import { POST as queueJobsRoute } from '../src/app/api/queue/jobs/route';
import { POST as v1JobsRoute } from '../src/app/api/v1/jobs/route';
import { conversionQueue } from '../src/lib/queue/conversion-queue';
import {
  CONCURRENCY_LIMIT_ENV,
  CONCURRENCY_LIMIT_PROBLEM_TYPE,
  DEFAULT_FREE_CONCURRENCY,
  concurrencyLimitFor,
  syncSlotsInUse,
} from '../src/lib/queue/concurrency-limit';
import { redisKeyStore } from '../src/lib/api-keys/redis-key-store';
import { userStore } from '../src/lib/auth/user-store';
import { CONFIG_SCHEMA } from '../src/lib/config/schema';

/**
 * Anonymous and free callers may have at most five conversions in flight (queued plus running), counted on the
 * server: a sixth request is answered 429 and its quota unit is refunded. Paid tiers have no such limit. The limit
 * is one setting, CONVERSION_CONCURRENCY_FREE.
 */

const BASE_URL = 'http://localhost:3000';
const LIMIT = 5;
const HTTP_TOO_MANY = 429;
const CSV_INPUT = 'name,score\nAlice,100\nBob,95\n';
const dispatch = vi.mocked(dispatchConversion);

interface Account {
  id: string;
  key: string;
}

async function account(tier: 'free' | 'pro'): Promise<Account> {
  const user = await userStore.createUser({
    email: `conc_${tier}_${Date.now()}_${crypto.randomBytes(6).toString('hex')}@concurrency.test`,
    name: `Concurrency ${tier}`,
    tier,
  });
  const key = await redisKeyStore.generateApiKey(user.id, 'Concurrency Key', { scopes: ['convert:write', 'convert:read'] });
  return { id: user.id, key: key.secretKey };
}

function csvForm(): FormData {
  const form = new FormData();
  form.append('file', new File([CSV_INPUT], 'scores.csv', { type: 'text/csv' }));
  form.append('targetFormat', 'json');
  return form;
}

function batchForm(): FormData {
  const form = new FormData();
  form.append('files', new File([CSV_INPUT], 'scores.csv', { type: 'text/csv' }));
  form.append('targetFormats', JSON.stringify({ default: 'json' }));
  return form;
}

function request(path: string, form: FormData, key?: string): NextRequest {
  return new NextRequest(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: key ? { Authorization: `Bearer ${key}` } : {},
    body: form,
  });
}

function jsonRequest(path: string, key: string, body: unknown): NextRequest {
  return new NextRequest(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** Conversions that stay in flight until `releaseAll` is called. */
function holdConversions() {
  const waiting: Array<() => void> = [];
  let started = 0;
  dispatch.mockImplementation((async () => {
    started++;
    await new Promise<void>((resolve) => waiting.push(resolve));
    return { buffer: Buffer.from('[]'), size: 2, mimeType: 'application/json', filename: 'scores.json', engineUsed: 'internal-fallback' };
  }) as never);
  return {
    started: () => started,
    async untilStarted(count: number) {
      const stop = Date.now() + 5_000;
      while (started < count && Date.now() < stop) await new Promise((resolve) => setTimeout(resolve, 10));
      expect(started).toBe(count);
    },
    releaseAll() {
      for (const release of waiting.splice(0)) release();
    },
  };
}

beforeEach(() => {
  vi.stubEnv('REDIS_URL', '');
  vi.stubEnv('REDIS_HOST', '');
});

afterEach(() => {
  vi.restoreAllMocks();
  dispatch.mockReset();
  vi.unstubAllEnvs();
});

describe('the setting', () => {
  it('is one documented configuration variable with the default of five', () => {
    expect(CONCURRENCY_LIMIT_ENV).toBe('CONVERSION_CONCURRENCY_FREE');
    expect(DEFAULT_FREE_CONCURRENCY).toBe(LIMIT);
    const spec = CONFIG_SCHEMA.find((entry) => entry.name === CONCURRENCY_LIMIT_ENV);
    expect(spec?.default).toBe(LIMIT);
    expect(spec?.roles).toEqual(['web', 'worker']);
  });

  it('applies to free and anonymous callers only, and can be changed', () => {
    expect(concurrencyLimitFor('free')).toBe(LIMIT);
    expect(concurrencyLimitFor(undefined)).toBe(LIMIT);
    expect(concurrencyLimitFor('unknown-tier')).toBe(LIMIT);
    expect(concurrencyLimitFor('pro')).toBeUndefined();
    expect(concurrencyLimitFor('enterprise')).toBeUndefined();
    vi.stubEnv(CONCURRENCY_LIMIT_ENV, '2');
    expect(concurrencyLimitFor('free')).toBe(2);
  });

  it.each(['0', '-1', 'five', '2.5'])('refuses the malformed value %j instead of using the default', (value) => {
    vi.stubEnv(CONCURRENCY_LIMIT_ENV, value);
    expect(() => concurrencyLimitFor('free')).toThrow(CONCURRENCY_LIMIT_ENV);
  });
});

describe.each([
  ['POST /api/convert', '/api/convert', convertRoute, csvForm, true],
  ['POST /api/v1/convert', '/api/v1/convert', v1ConvertRoute, csvForm, false],
  ['POST /api/convert/batch', '/api/convert/batch', batchRoute, batchForm, true],
])('%s', (_label, path, route, form, allowsAnonymous) => {
  /** The key of a caller without an account where the route allows it; a fresh free account otherwise. */
  async function caller(): Promise<string | undefined> {
    return allowsAnonymous ? undefined : (await account('free')).key;
  }

  it('answers 429 to the sixth conversion in flight of an anonymous or free caller', async () => {
    const held = holdConversions();
    const key = await caller();
    const inFlight = Array.from({ length: LIMIT }, () => route(request(path, form(), key)));
    await held.untilStarted(LIMIT);

    const sixth = await route(request(path, form(), key));
    expect(sixth.status).toBe(HTTP_TOO_MANY);
    expect(sixth.headers.get('content-type')).toContain('application/problem+json');
    expect(sixth.headers.get('retry-after')).toBeTruthy();
    const body = await sixth.json();
    expect(body.type).toBe(CONCURRENCY_LIMIT_PROBLEM_TYPE);
    expect(body.limit).toBe(LIMIT);
    expect(held.started()).toBe(LIMIT);

    held.releaseAll();
    const answers = await Promise.all(inFlight);
    expect(answers.map((res) => res.status)).toEqual(Array(LIMIT).fill(200));
    expect(syncSlotsInUse()).toBe(0);
  });

  it('accepts the next request once one of the five has finished', async () => {
    const held = holdConversions();
    const key = await caller();
    const inFlight = Array.from({ length: LIMIT }, () => route(request(path, form(), key)));
    await held.untilStarted(LIMIT);
    held.releaseAll();
    await Promise.all(inFlight);
    const next = route(request(path, form(), key));
    await held.untilStarted(LIMIT + 1);
    held.releaseAll();
    expect((await next).status).toBe(200);
  });

  it('counts a free API-key caller on its own, apart from other callers, and does not limit a pro caller', async () => {
    const free = await account('free');
    const pro = await account('pro');
    const held = holdConversions();
    const freeFlight = Array.from({ length: LIMIT }, () => route(request(path, form(), free.key)));
    await held.untilStarted(LIMIT);

    expect((await route(request(path, form(), free.key))).status).toBe(HTTP_TOO_MANY);
    const proFlight = Array.from({ length: LIMIT + 1 }, () => route(request(path, form(), pro.key)));
    await held.untilStarted(LIMIT + LIMIT + 1);

    held.releaseAll();
    const answers = await Promise.all([...freeFlight, ...proFlight]);
    expect(answers.every((res) => res.status === 200)).toBe(true);
  });

  it('refunds the quota unit of the refused request', async () => {
    const free = await account('free');
    const held = holdConversions();
    const inFlight = Array.from({ length: LIMIT }, () => route(request(path, form(), free.key)));
    await held.untilStarted(LIMIT);
    const before = (await redisKeyStore.getQuotaUsage(free.id)).usedToday;
    const refused = await route(request(path, form(), free.key));
    expect(refused.status).toBe(HTTP_TOO_MANY);
    expect((await redisKeyStore.getQuotaUsage(free.id)).usedToday).toBe(before);
    held.releaseAll();
    await Promise.all(inFlight);
  });

  it('frees the slot when the conversion fails', async () => {
    dispatch.mockImplementation((async () => {
      throw new Error('engine failure');
    }) as never);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const key = await caller();
    for (let i = 0; i < LIMIT + 2; i++) {
      const res = await route(request(path, form(), key));
      expect(res.status).not.toBe(HTTP_TOO_MANY);
    }
    expect(syncSlotsInUse()).toBe(0);
  });
});

describe('queued jobs count as in flight', () => {
  const submissions = [
    ['POST /api/queue/jobs', '/api/queue/jobs', queueJobsRoute, 200],
    ['POST /api/v1/jobs', '/api/v1/jobs', v1JobsRoute, 202],
  ] as const;

  it.each(submissions)('%s refuses the sixth job of a free caller with 429 and accepts one again after a job leaves the queue', async (_label, path, route, accepted) => {
    const free = await account('free');
    const body = { filename: 'scores.csv', targetFormat: 'json', inputBufferBase64: Buffer.from(CSV_INPUT).toString('base64') };
    const jobIds: string[] = [];
    for (let i = 0; i < LIMIT; i++) {
      const res = await route(jsonRequest(path, free.key, body));
      expect(res.status).toBe(accepted);
      jobIds.push((await res.json()).jobId);
    }
    const before = (await redisKeyStore.getQuotaUsage(free.id)).usedToday;
    const sixth = await route(jsonRequest(path, free.key, body));
    expect(sixth.status).toBe(HTTP_TOO_MANY);
    expect((await sixth.json()).type).toBe(CONCURRENCY_LIMIT_PROBLEM_TYPE);
    expect((await redisKeyStore.getQuotaUsage(free.id)).usedToday).toBe(before);

    expect(await conversionQueue.cancelJob(jobIds[0], 'test')).toBe(true);
    const again = await route(jsonRequest(path, free.key, body));
    expect(again.status).toBe(accepted);
  });

  it.each(submissions)('%s does not limit a pro caller', async (_label, path, route, accepted) => {
    const pro = await account('pro');
    const body = { filename: 'scores.csv', targetFormat: 'json', inputBufferBase64: Buffer.from(CSV_INPUT).toString('base64') };
    for (let i = 0; i < LIMIT + 3; i++) {
      expect((await route(jsonRequest(path, pro.key, body))).status).toBe(accepted);
    }
  });

  it('counts the jobs of a caller together with its synchronous conversions', async () => {
    const free = await account('free');
    const body = { filename: 'scores.csv', targetFormat: 'json', inputBufferBase64: Buffer.from(CSV_INPUT).toString('base64') };
    for (let i = 0; i < LIMIT - 1; i++) {
      expect((await queueJobsRoute(jsonRequest('/api/queue/jobs', free.key, body))).status).toBe(200);
    }
    const held = holdConversions();
    const fifth = convertRoute(request('/api/convert', csvForm(), free.key));
    await held.untilStarted(1);
    expect((await convertRoute(request('/api/convert', csvForm(), free.key))).status).toBe(HTTP_TOO_MANY);
    expect((await queueJobsRoute(jsonRequest('/api/queue/jobs', free.key, body))).status).toBe(HTTP_TOO_MANY);
    held.releaseAll();
    expect((await fifth).status).toBe(200);
  });
});
