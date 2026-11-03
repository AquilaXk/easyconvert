import type Redis from 'ioredis';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/conversions/dispatch', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/conversions/dispatch')>();
  return { ...actual, dispatchConversion: vi.fn(actual.dispatchConversion) };
});

import { GET as smokeProbe } from '../src/app/api/health/conversion/route';
import { POST as convertRoute } from '../src/app/api/convert/route';
import { redisKeyStore } from '../src/lib/api-keys/redis-key-store';
import { anonymousUserId } from '../src/lib/auth/anonymous-identity';
import { dispatchConversion } from '../src/lib/conversions/dispatch';
import { getAnonymousDailyLimit } from '../src/lib/plan-limits';

/**
 * The deploy's smoke conversion (deploy/oci/deploy.sh) against the anonymous allowance. On the host, deploy.sh calls the loopback
 * port of the web container directly, and the framework fills X-Forwarded-For with the socket peer it saw, the bridge gateway, when
 * the request carries none. The trust list is the one docker-compose.prod.yml gives the web service.
 */

const PROD_TRUSTED_PROXIES = '127.0.0.1/32,172.16.0.0/12';
const BRIDGE_GATEWAY = '172.18.0.1';
const PUBLIC_CLIENT = '203.0.113.7';
const HTTP_OK = 200;
const HTTP_TOO_MANY_REQUESTS = 429;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const IHDR_WIDTH_OFFSET = 16;
const IHDR_HEIGHT_OFFSET = 20;

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
  keysClient = redisKeyStore.getRedisClient();
  redisKeyStore.setRedisClient(null);
  redisKeyStore.resetStore();
  vi.stubEnv('TRUSTED_PROXIES', PROD_TRUSTED_PROXIES);
  vi.stubEnv('ANONYMOUS_DAILY_LIMIT', '10');
  vi.mocked(dispatchConversion).mockClear();
});

afterEach(() => {
  vi.unstubAllEnvs();
  redisKeyStore.setRedisClient(keysClient);
});

describe('the deploy smoke conversion', () => {
  it('spends the allowance of the bridge gateway when it goes through /api/convert, so the 11th start of a day is refused', async () => {
    await spendAllowance(BRIDGE_GATEWAY);
    expect((await convertRoute(convertRequest({ 'x-forwarded-for': BRIDGE_GATEWAY }))).status).toBe(HTTP_TOO_MANY_REQUESTS);
  });

  it('passes on every start after the allowance of its address is spent, and charges nothing', async () => {
    await spendAllowance(BRIDGE_GATEWAY);
    const starts = getAnonymousDailyLimit() + 2;
    for (let i = 0; i < starts; i++) await expectOnePixelPng(await smokeProbe(smokeRequest()));
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

describe('a public caller', () => {
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
