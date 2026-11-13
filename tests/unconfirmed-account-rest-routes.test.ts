import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { POST as v1ConvertRoute } from '../src/app/api/v1/convert/route';
import { POST as v1JobsRoute } from '../src/app/api/v1/jobs/route';
import { redisKeyStore } from '../src/lib/api-keys/redis-key-store';
import { redisUserStore } from '../src/lib/auth/redis-user-store';
import { createSessionToken, SESSION_COOKIE_NAME } from '../src/lib/auth/session';
import { storageProvider } from '../src/lib/storage';
import { freshClientIp, passwordAccount, stubMailConfig } from './helpers/auth-mail-fixtures';

/**
 * The REST routes authenticate with no units and reserve their conversions afterwards, so the rule that an account whose
 * address was never confirmed has no daily allowance of its own has to hold at the reservation. N unconfirmed accounts must
 * never be N allowances, whether the request comes with a session or with an API key. docs/policy-decisions.md, entry 288.
 */

const CSV = 'name,score\nAlice,100\nBob,95\n';

beforeEach(() => {
  redisUserStore.resetStore();
  redisKeyStore.resetStore();
  stubMailConfig();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

async function caller(record: Awaited<ReturnType<typeof passwordAccount>>) {
  const { secretKey } = await redisKeyStore.generateApiKey(record.id, 'rest key', { scopes: ['convert:write'] });
  const ip = freshClientIp();
  const cookie = `${SESSION_COOKIE_NAME}=${createSessionToken(redisUserStore.sanitizeUser(record))}`;
  return {
    ip,
    withKey: { authorization: `Bearer ${secretKey}`, 'x-forwarded-for': ip },
    withSession: { cookie, 'x-forwarded-for': ip },
    usedToday: async () => (await redisKeyStore.getQuotaUsage(record.id)).usedToday,
    visitorUsed: async () => (await redisKeyStore.getQuotaUsage(`anon:${ip}`)).usedToday,
  };
}

function convert(headers: Record<string, string>) {
  const form = new FormData();
  form.append('file', new File([CSV], 'scores.csv'));
  form.append('targetFormat', 'json');
  return v1ConvertRoute(new NextRequest('http://localhost/api/v1/convert', { method: 'POST', headers, body: form }));
}

async function submitJob(headers: Record<string, string>) {
  const storageKey = `uploads/unconfirmed-${Date.now()}-${Math.random().toString(16).slice(2)}/scores.csv`;
  await storageProvider.saveObject(storageKey, Buffer.from(CSV), 'text/csv', 'scores.csv', 60 * 60 * 1000);
  return v1JobsRoute(
    new NextRequest('http://localhost/api/v1/jobs', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ storageKey, tasks: [{ name: 'c', operation: 'convert', targetFormat: 'json' }] }),
    })
  );
}

describe('/api/v1/convert for an account whose address was never confirmed', () => {
  it('refuses it with 403 by API key and by session, and charges neither its own counter nor any visitor bucket', async () => {
    const account = await caller(await passwordAccount('unconfirmed'));
    for (const headers of [account.withKey, account.withSession]) {
      const response = await convert(headers);
      expect(response.status).toBe(403);
      expect((await response.json()).detail).toContain('open the link in the mail');
    }
    expect(await account.usedToday()).toBe(0);
    expect(await account.visitorUsed()).toBe(0);
  });

  it('has no more allowance with ten such accounts than with none: not one of them converts', async () => {
    const statuses: number[] = [];
    for (let index = 0; index < 10; index++) {
      const account = await caller(await passwordAccount(`bulk${index}`));
      statuses.push((await convert(account.withKey)).status);
      expect(await account.usedToday()).toBe(0);
    }
    expect(statuses).toEqual(Array(10).fill(403));
  });

  it('converts, from its own allowance, once the address is confirmed', async () => {
    const record = await passwordAccount('soon.confirmed');
    const account = await caller(record);
    expect((await convert(account.withKey)).status).toBe(403);
    await redisUserStore.updateUser(record.id, { emailVerified: true });
    expect((await convert(account.withKey)).status).toBe(200);
    expect(await account.usedToday()).toBe(1);
  });
});

describe('/api/v1/jobs for an account whose address was never confirmed', () => {
  it('refuses it with 403 by API key and by session, and charges no counter', async () => {
    const account = await caller(await passwordAccount('unconfirmed'));
    for (const headers of [account.withKey, account.withSession]) {
      const response = await submitJob(headers);
      expect(response.status).toBe(403);
      expect((await response.json()).detail).toContain('open the link in the mail');
    }
    expect(await account.usedToday()).toBe(0);
    expect(await account.visitorUsed()).toBe(0);
  });

  it('takes a job from the same account once the address is confirmed', async () => {
    const record = await passwordAccount('soon.confirmed');
    const account = await caller(record);
    expect((await submitJob(account.withKey)).status).toBe(403);
    await redisUserStore.updateUser(record.id, { emailVerified: true });
    expect((await submitJob(account.withKey)).status).toBe(202);
  });
});
