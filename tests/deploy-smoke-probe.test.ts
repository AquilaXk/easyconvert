import type Redis from 'ioredis';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/conversions/dispatch', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/conversions/dispatch')>();
  return { ...actual, dispatchConversion: vi.fn(actual.dispatchConversion) };
});

import { readFileSync } from 'node:fs';
import path from 'node:path';
vi.mock('@/lib/queue/concurrency-limit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/queue/concurrency-limit')>();
  return { ...actual, acquireSyncSlot: vi.fn(actual.acquireSyncSlot) };
});

import { GET as smokeProbe } from '../src/app/api/health/conversion/route';
import { POST as convertRoute } from '../src/app/api/convert/route';
import { resetSmokeVerdict } from '../src/lib/health/smoke-conversion';
import { JobTimeoutError } from '../src/lib/types';
import { redisKeyStore } from '../src/lib/api-keys/redis-key-store';
import { anonymousUserId } from '../src/lib/auth/anonymous-identity';
import { dispatchConversion } from '../src/lib/conversions/dispatch';
import { getAnonymousDailyLimit } from '../src/lib/plan-limits';
import { acquireSyncSlot, syncSlotsInUse } from '../src/lib/queue/concurrency-limit';
import { getUnshareCapability } from '../src/lib/security/process-sandbox';
import { MAGICK_BINARY } from './helpers/imagemagick';
import { skipUnless } from './helpers/strict-skip';

/**
 * The deploy's smoke conversion (deploy/oci/deploy.sh) against the anonymous allowance. On the host, deploy.sh calls the loopback
 * port of the web container directly, and the framework fills X-Forwarded-For with the socket peer it saw, the bridge gateway, when
 * the request carries none. The trust list is the one docker-compose.prod.yml gives the web service.
 */

const PROD_TRUSTED_PROXIES = '127.0.0.1/32,172.16.0.0/12';
const BRIDGE_GATEWAY = '172.18.0.1';
const PUBLIC_CLIENT = '203.0.113.7';
const HTTP_OK = 200;
const HTTP_BAD_REQUEST = 400;
/** The probe's own deadline, as the OpenAPI document states it. */
const SMOKE_DEADLINE_MS = 30_000;
const HTTP_TOO_MANY_REQUESTS = 429;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const IHDR_WIDTH_OFFSET = 16;
const IHDR_HEIGHT_OFFSET = 20;
const HTTP_INTERNAL_SERVER_ERROR = 500;
const HTTP_GATEWAY_TIMEOUT = 504;
const HTTP_CLIENT_CLOSED_REQUEST = 499;
/** Inside this window a verdict is reused; after the longer one it is not ("a few seconds"). */
const VERDICT_REUSED_WITHIN_MS = 1_000;
const VERDICT_GONE_AFTER_MS = 60_000;
const CONCURRENT_CALLERS = 3;

/** The probe runs ImageMagick in the conversion sandbox, which on Linux needs unprivileged namespaces (unshare -r -n). */
const sandboxMissing =
  skipUnless('ImageMagick (magick or convert)', MAGICK_BINARY !== null) ||
  skipUnless('unprivileged namespaces (unshare -r -n)', process.platform !== 'linux' || getUnshareCapability().available);

/** Headers a public caller could send to look like the host: the proxy overwrites only X-Forwarded-For, so the rest arrive as sent. */
const FORGED_HEADERS = {
  'x-real-ip': '127.0.0.1',
  'cf-connecting-ip': '127.0.0.1',
  forwarded: 'for=127.0.0.1',
  'x-deploy-smoke': '1',
  'x-internal': 'true',
  host: '127.0.0.1:8090',
};

function smokeRequest(headers: Record<string, string> = { 'x-forwarded-for': BRIDGE_GATEWAY }, query = '') {
  return new NextRequest(`http://127.0.0.1:8090/api/health/conversion${query}`, { method: 'GET', headers });
}

function convertRequest(headers: Record<string, string>) {
  const form = new FormData();
  form.append('file', new File(['name,score\nAlice,100\n'], 'scores.csv'));
  form.append('targetFormat', 'json');
  return new NextRequest('http://127.0.0.1:8090/api/convert', { method: 'POST', headers, body: form });
}

async function spendAllowance(ip: string): Promise<void> {
  for (let i = 0; i < getAnonymousDailyLimit(); i++) {
    const unit = await redisKeyStore.reserveQuota(anonymousUserId(ip), 1);
    expect(unit.allowed).toBe(true);
    await redisKeyStore.commitQuota(unit.reservationId as string);
  }
}

const usedToday = async (ip: string) => (await redisKeyStore.getQuotaUsage(anonymousUserId(ip))).usedToday;

async function expectOnePixelPng(res: Response): Promise<void> {
  expect(res.status).toBe(HTTP_OK);
  expect(res.headers.get('content-type')).toBe('image/png');
  const body = Buffer.from(await res.arrayBuffer());
  expect(body.subarray(0, PNG_SIGNATURE.length)).toEqual(PNG_SIGNATURE);
  expect(body.readUInt32BE(IHDR_WIDTH_OFFSET)).toBe(1);
  expect(body.readUInt32BE(IHDR_HEIGHT_OFFSET)).toBe(1);
}

let keysClient: Redis | null;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  resetSmokeVerdict();
  keysClient = redisKeyStore.getRedisClient();
  redisKeyStore.setRedisClient(null);
  redisKeyStore.resetStore();
  vi.stubEnv('TRUSTED_PROXIES', PROD_TRUSTED_PROXIES);
  vi.stubEnv('ANONYMOUS_DAILY_LIMIT', '10');
  vi.mocked(dispatchConversion).mockClear();
  vi.mocked(acquireSyncSlot).mockClear();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  redisKeyStore.setRedisClient(keysClient);
});

describe('the deploy smoke through /api/convert', () => {
  it('spends the allowance of the bridge gateway, so the 11th start of a day is refused', async () => {
    await spendAllowance(BRIDGE_GATEWAY);
    expect((await convertRoute(convertRequest({ 'x-forwarded-for': BRIDGE_GATEWAY }))).status).toBe(HTTP_TOO_MANY_REQUESTS);
  });
});

describe.skipIf(sandboxMissing)('the deploy smoke conversion', () => {
  it('passes on every start after the allowance of its address is spent, converts each time and charges nothing', async () => {
    await spendAllowance(BRIDGE_GATEWAY);
    const starts = getAnonymousDailyLimit() + 2;
    for (let i = 0; i < starts; i++) {
      await expectOnePixelPng(await smokeProbe(smokeRequest()));
      vi.setSystemTime(Date.now() + VERDICT_GONE_AFTER_MS);
    }
    expect(dispatchConversion).toHaveBeenCalledTimes(starts);
    expect(await usedToday(BRIDGE_GATEWAY)).toBe(getAnonymousDailyLimit());
  }, 60_000);

  it('converts its own one-pixel PPM to PNG through the conversion dispatcher, the engine path of /api/convert', async () => {
    await expectOnePixelPng(await smokeProbe(smokeRequest()));
    expect(dispatchConversion).toHaveBeenCalledTimes(1);
    const [input, source, target] = vi.mocked(dispatchConversion).mock.calls[0];
    expect([source, target]).toEqual(['ppm', 'png']);
    expect((input as Buffer).subarray(0, 11).toString('latin1')).toBe('P6\n1 1\n255\n');
  });
});

describe.skipIf(sandboxMissing)('a public caller', () => {
  it('gets no conversion of its own from the probe, whatever it sends', async () => {
    const res = await smokeProbe(smokeRequest({ 'x-forwarded-for': PUBLIC_CLIENT, ...FORGED_HEADERS }, '?targetFormat=pdf&url=https%3A%2F%2Fexample.com%2Fa.docx'));
    await expectOnePixelPng(res);
    const [input, source, target] = vi.mocked(dispatchConversion).mock.calls[0];
    expect([source, target]).toEqual(['ppm', 'png']);
    expect((input as Buffer).length).toBe(14);
  });

  it('is still refused by /api/convert once its allowance is spent, with any header that names the host', async () => {
    await spendAllowance(PUBLIC_CLIENT);
    const res = await convertRoute(convertRequest({ 'x-forwarded-for': PUBLIC_CLIENT, ...FORGED_HEADERS }));
    expect(res.status).toBe(HTTP_TOO_MANY_REQUESTS);
    expect(await usedToday(PUBLIC_CLIENT)).toBe(getAnonymousDailyLimit());
  });
});

describe.skipIf(sandboxMissing)('callers that come at once or one after another', () => {
  it('share one conversion when they call at once, and each gets the one-pixel PNG', async () => {
    const answers = await Promise.all(Array.from({ length: CONCURRENT_CALLERS }, () => smokeProbe(smokeRequest())));
    for (const res of answers) await expectOnePixelPng(res);
    expect(dispatchConversion).toHaveBeenCalledTimes(1);
  });

  it('reuse the verdict for a few seconds and convert again after it is gone', async () => {
    await expectOnePixelPng(await smokeProbe(smokeRequest()));
    vi.setSystemTime(Date.now() + VERDICT_REUSED_WITHIN_MS);
    await expectOnePixelPng(await smokeProbe(smokeRequest()));
    expect(dispatchConversion).toHaveBeenCalledTimes(1);
    vi.setSystemTime(Date.now() + VERDICT_GONE_AFTER_MS);
    await expectOnePixelPng(await smokeProbe(smokeRequest()));
    expect(dispatchConversion).toHaveBeenCalledTimes(2);
  });

  it('keep the conversion going for the others when one caller goes away, which gets 499', async () => {
    const actual = await vi.importActual<typeof import('../src/lib/conversions/dispatch')>('../src/lib/conversions/dispatch');
    let open!: () => void;
    const gate = new Promise<void>((resolve) => (open = resolve));
    vi.mocked(dispatchConversion).mockImplementationOnce(async (...args) => {
      await gate;
      return actual.dispatchConversion(...args);
    });
    const leaving = new AbortController();
    const first = smokeProbe(new NextRequest('http://127.0.0.1:8090/api/health/conversion', { signal: leaving.signal }));
    const second = smokeProbe(smokeRequest());
    leaving.abort();
    expect((await first).status).toBe(HTTP_CLIENT_CLOSED_REQUEST);
    open();
    await expectOnePixelPng(await second);
    expect(dispatchConversion).toHaveBeenCalledTimes(1);
  });
});

describe.skipIf(sandboxMissing)('a verdict that failed', () => {
  it('expires, so the next start after it converts again', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.mocked(dispatchConversion).mockRejectedValueOnce(new Error('the engine failed'));
    expect((await smokeProbe(smokeRequest())).status).toBe(HTTP_INTERNAL_SERVER_ERROR);
    vi.setSystemTime(Date.now() + VERDICT_REUSED_WITHIN_MS);
    expect((await smokeProbe(smokeRequest())).status).toBe(HTTP_INTERNAL_SERVER_ERROR);
    expect(dispatchConversion).toHaveBeenCalledTimes(1);
    vi.setSystemTime(Date.now() + VERDICT_GONE_AFTER_MS);
    await expectOnePixelPng(await smokeProbe(smokeRequest()));
    expect(dispatchConversion).toHaveBeenCalledTimes(2);
  });
});

describe('a smoke conversion that does not stop at its deadline', () => {
  const canned = { buffer: Buffer.from('png'), mimeType: 'image/png', filename: 'smoke.png', size: 3, engineUsed: 'stub' } as Awaited<ReturnType<typeof dispatchConversion>>;

  it('is aborted at the deadline, and keeps its place until it ends: no second conversion starts on top of it', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    let signal!: AbortSignal;
    let end!: () => void;
    vi.mocked(dispatchConversion).mockImplementationOnce((_input, _source, _target, options) => {
      signal = (options as { signal: AbortSignal }).signal;
      return new Promise((resolve) => (end = () => resolve(canned)));
    });
    const first = smokeProbe(smokeRequest());
    await vi.advanceTimersByTimeAsync(SMOKE_DEADLINE_MS);
    expect((await first).status).toBe(HTTP_GATEWAY_TIMEOUT);
    expect(signal.aborted).toBe(true);
    expect(signal.reason).toBeInstanceOf(JobTimeoutError);

    await vi.advanceTimersByTimeAsync(VERDICT_GONE_AFTER_MS);
    expect((await smokeProbe(smokeRequest())).status).toBe(HTTP_GATEWAY_TIMEOUT);
    expect(dispatchConversion).toHaveBeenCalledTimes(1);

    end();
    await vi.advanceTimersByTimeAsync(VERDICT_GONE_AFTER_MS);
    vi.mocked(dispatchConversion).mockResolvedValueOnce(canned);
    expect((await smokeProbe(smokeRequest())).status).toBe(HTTP_OK);
    expect(dispatchConversion).toHaveBeenCalledTimes(2);
  });
});

describe('the deploy check of the convert route', () => {
  /** The form deploy.sh posts: the options field is the one the route refuses, after its parser, guard, reservation and slot. */
  const deploySh = readFileSync(path.join(__dirname, '..', 'deploy', 'oci', 'deploy.sh'), 'utf-8');
  const checkOptions = /^SMOKE_ROUTE_OPTIONS='([^']*)'$/m.exec(deploySh)?.[1];

  function routeCheckRequest(headers: Record<string, string> = { 'x-forwarded-for': BRIDGE_GATEWAY }) {
    expect(checkOptions).toBeTruthy();
    const form = new FormData();
    form.append('file', new File([Buffer.from('P6\n1 1\n255\n\xff\x00\x00', 'latin1')], 'smoke.ppm'));
    form.append('targetFormat', 'png');
    form.append('options', checkOptions as string);
    return new NextRequest('http://127.0.0.1:8090/api/convert', { method: 'POST', headers, body: form });
  }

  it('is refused with invalid_options once the route has parsed the upload, reserved a unit and taken a slot, and converts nothing', async () => {
    const reserve = vi.spyOn(redisKeyStore, 'reserveQuota');
    const rollback = vi.spyOn(redisKeyStore, 'rollbackQuota');
    const commit = vi.spyOn(redisKeyStore, 'commitQuota');
    const res = await convertRoute(routeCheckRequest());
    expect(res.status).toBe(HTTP_BAD_REQUEST);
    // deploy.sh matches the compact JSON text of the code field with grep, so the raw body is what is checked.
    const checkCode = /^SMOKE_ROUTE_CODE='([^']*)'$/m.exec(deploySh)?.[1];
    expect(checkCode).toBe('invalid_options');
    expect(await res.text()).toContain(`"code":"${checkCode}"`);
    expect(reserve).toHaveBeenCalledTimes(1);
    expect(rollback).toHaveBeenCalledTimes(1);
    expect(commit).not.toHaveBeenCalled();
    expect(acquireSyncSlot).toHaveBeenCalledTimes(1);
    expect(syncSlotsInUse()).toBe(0);
    expect(dispatchConversion).not.toHaveBeenCalled();
  });

  it('charges nothing: the unit of the last conversion of the day is still there after twelve checks', async () => {
    const limit = getAnonymousDailyLimit();
    for (let i = 0; i < limit - 1; i++) {
      const unit = await redisKeyStore.reserveQuota(anonymousUserId(BRIDGE_GATEWAY), 1);
      await redisKeyStore.commitQuota(unit.reservationId as string);
    }
    for (let i = 0; i < limit + 2; i++) expect((await convertRoute(routeCheckRequest())).status).toBe(HTTP_BAD_REQUEST);
    expect(await usedToday(BRIDGE_GATEWAY)).toBe(limit - 1);
    expect((await convertRoute(convertRequest({ 'x-forwarded-for': BRIDGE_GATEWAY }))).status).not.toBe(HTTP_TOO_MANY_REQUESTS);
  });

  it('gives a public caller nothing the guard would not: it is metered and refused like any upload once its allowance is spent', async () => {
    await spendAllowance(PUBLIC_CLIENT);
    const res = await convertRoute(routeCheckRequest({ 'x-forwarded-for': PUBLIC_CLIENT, ...FORGED_HEADERS }));
    expect(res.status).toBe(HTTP_TOO_MANY_REQUESTS);
  });
});

describe('a failed smoke conversion', () => {
  it('answers 500 and keeps that verdict for the next caller too', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.mocked(dispatchConversion).mockRejectedValueOnce(new Error('the engine failed'));
    expect((await smokeProbe(smokeRequest())).status).toBe(HTTP_INTERNAL_SERVER_ERROR);
    vi.setSystemTime(Date.now() + VERDICT_REUSED_WITHIN_MS);
    expect((await smokeProbe(smokeRequest())).status).toBe(HTTP_INTERNAL_SERVER_ERROR);
    expect(dispatchConversion).toHaveBeenCalledTimes(1);
  });

  it('answers 504 when the conversion does not finish within its 30 seconds', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    vi.mocked(dispatchConversion).mockImplementationOnce(() => new Promise(() => undefined));
    const pending = smokeProbe(smokeRequest());
    await vi.advanceTimersByTimeAsync(SMOKE_DEADLINE_MS);
    expect((await pending).status).toBe(HTTP_GATEWAY_TIMEOUT);
  });
});
