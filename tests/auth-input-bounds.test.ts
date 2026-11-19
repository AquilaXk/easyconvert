import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mail = vi.hoisted(() => ({
  sendMail: vi.fn(async (_message: { to: string; subject: string }) => ({ messageId: 'fixture' })),
}));
vi.mock('nodemailer', () => ({
  createTransport: () => ({ sendMail: mail.sendMail, close: vi.fn() }),
}));

const slots = vi.hoisted(() => ({
  acquire: vi.fn(async (_userId: string, _tier: string | undefined) => ({ granted: true as const, release: () => undefined })),
}));
vi.mock('../src/lib/queue/concurrency-limit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/queue/concurrency-limit')>()),
  acquireSyncSlot: slots.acquire,
}));

import { POST as register } from '../src/app/api/auth/register/route';
import { POST as login } from '../src/app/api/auth/login/route';
import { POST as createKey } from '../src/app/api/keys/route';
import { PATCH as updateKey } from '../src/app/api/keys/[id]/route';
import { POST as postCredentials, GET as getCredentials } from '../src/app/api/v1/storage/credentials/route';
import { POST as bundlePost } from '../src/app/api/storage/bundle/route';
import { queueAccountMail } from '../src/lib/auth/account-mail';
import { sha256 } from '../src/lib/auth/crypto';
import {
  REGISTER_MAX_ATTEMPTS_PER_IP,
  REGISTER_WINDOW_SECONDS,
  checkLoginRateLimit,
  loginEmailAttemptsKey,
  recordFailedLogin,
  resetLoginAttempts,
  resetLoginRateLimiterStore,
} from '../src/lib/auth/login-rate-limiter';
import { MAIL_DAILY_HARD_CAP, MAIL_DAILY_VERIFY_CAP, mailSentToday, reserveMailSend, resetMailBudgetMemory } from '../src/lib/auth/mail-budget';
import { resetAuthTokenMemory } from '../src/lib/auth/auth-email-token-store';
import { redisKeyStore } from '../src/lib/api-keys/redis-key-store';
import { redisUserStore } from '../src/lib/auth/redis-user-store';
import { userStore } from '../src/lib/auth/user-store';
import { createSessionToken } from '../src/lib/auth/session';
import { credentialsVault } from '../src/lib/storage';
import { TERMS_VERSION } from '../src/lib/legal/documents';
import {
  MAX_ALLOWED_IPS,
  MAX_DISPLAY_NAME_LENGTH,
  MAX_KEY_NAME_LENGTH,
  MAX_STORAGE_CREDENTIAL_JSON_BYTES,
  MAX_STORAGE_CREDENTIAL_NAME_LENGTH,
  MAX_WEBHOOK_URL_LENGTH,
} from '../src/lib/api/field-limits';
import { GOOD_PASSWORD, freshClientIp, jsonPost, passwordAccount, stubMailConfig } from './helpers/auth-mail-fixtures';

/**
 * The texts a caller sends and a route stores have a length limit, a sign-in builds no key from an address of any length, a reset mail to
 * an unverified address draws on the verification share of the mail budget, and a visitor holds a slot for a bundle.
 * docs/policy-decisions.md, entry 343.
 */

const ORIGIN = 'http://localhost:3000';
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

beforeEach(() => {
  redisUserStore.resetStore();
  userStore.resetStore();
  redisKeyStore.resetStore();
  resetAuthTokenMemory();
  resetLoginRateLimiterStore();
  resetMailBudgetMemory();
  mail.sendMail.mockClear();
  slots.acquire.mockClear();
  stubMailConfig();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('the display name of an account', () => {
  const signUp = (name: string) =>
    register(jsonPost('/api/auth/register', { email: `bounds.${name.length}@fixture.test`, password: GOOD_PASSWORD, name, acceptedTermsVersion: TERMS_VERSION }));

  it('refuses a name over the limit with 400 invalid_name and makes no account', async () => {
    const response = await signUp('x'.repeat(MAX_DISPLAY_NAME_LENGTH + 1));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ success: false, code: 'invalid_name' });
    expect(await redisUserStore.findByEmail(`bounds.${MAX_DISPLAY_NAME_LENGTH + 1}@fixture.test`)).toBeNull();
  });

  it('refuses a name of a megabyte before it reaches the store', async () => {
    const response = await signUp('y'.repeat(1_000_000));
    expect(response.status).toBe(400);
    expect((await response.json()).code).toBe('invalid_name');
  });

  it('takes a name of exactly the limit', async () => {
    expect((await signUp('z'.repeat(MAX_DISPLAY_NAME_LENGTH))).status).toBe(202);
    expect((await redisUserStore.findByEmail(`bounds.${MAX_DISPLAY_NAME_LENGTH}@fixture.test`))?.name).toHaveLength(MAX_DISPLAY_NAME_LENGTH);
  });

  it('is held by the store itself, on a create and on an update, for the name and the avatar address', async () => {
    const base = { email: 'store.bounds@fixture.test', provider: 'google' as const };
    await expect(redisUserStore.createUser({ ...base, name: 'n'.repeat(MAX_DISPLAY_NAME_LENGTH + 1) })).rejects.toThrow('name must be at most');
    await expect(redisUserStore.createUser({ ...base, name: 'ok', avatarUrl: `https://a.test/${'p'.repeat(2048)}` })).rejects.toThrow('avatarUrl must be at most');
    const record = await redisUserStore.createUser({ ...base, name: 'ok' });
    await expect(redisUserStore.updateUser(record.id, { name: 'n'.repeat(MAX_DISPLAY_NAME_LENGTH + 1) })).rejects.toThrow('name must be at most');
    await expect(redisUserStore.updateUser(record.id, { avatarUrl: `https://a.test/${'p'.repeat(2048)}` })).rejects.toThrow('avatarUrl must be at most');
    expect(await redisUserStore.findById(record.id)).toMatchObject({ name: 'ok' });
    expect((await redisUserStore.updateUser(record.id, { name: 'n'.repeat(MAX_DISPLAY_NAME_LENGTH) }))?.name).toHaveLength(MAX_DISPLAY_NAME_LENGTH);
  });
});

describe('sign-ups per client', () => {
  it('allows 5 in an hour and tells the sixth to wait for the rest of the hour', async () => {
    expect(REGISTER_MAX_ATTEMPTS_PER_IP).toBe(5);
    expect(REGISTER_WINDOW_SECONDS).toBe(3600);
    const ip = freshClientIp();
    // Together, since each accepted sign-up answers after the floor of an opaque answer.
    const responses = await Promise.all(
      Array.from({ length: REGISTER_MAX_ATTEMPTS_PER_IP + 1 }, (_, attempt) =>
        register(jsonPost('/api/auth/register', { email: `hour.${attempt}@fixture.test`, password: GOOD_PASSWORD, name: 'Hour', acceptedTermsVersion: TERMS_VERSION }, { ip }))
      )
    );
    expect(responses.map((response) => response.status).sort()).toEqual([202, 202, 202, 202, 202, 429]);
    const refused = responses.find((response) => response.status === 429)!;
    expect(Number(refused.headers.get('Retry-After'))).toBeGreaterThan(3000);
  });
});

describe('a sign-in with an address of any length', () => {
  const recorder = () => {
    const calls: string[] = [];
    const client = {
      get: vi.fn(async (key: string) => (calls.push(key), null)),
      ttl: vi.fn(async (key: string) => (calls.push(key), -1)),
      del: vi.fn(async (key: string) => (calls.push(key), 1)),
      eval: vi.fn(async (_script: string, _count: number, key: string) => (calls.push(key), [1, 300])),
    };
    vi.spyOn(redisUserStore, 'getRedisClient').mockReturnValue(client as never);
    return calls;
  };

  it('answers an address over 254 characters as a wrong password and touches no store', async () => {
    const calls = recorder();
    const findByEmail = vi.spyOn(redisUserStore, 'findByEmail');
    const response = await login(jsonPost('/api/auth/login', { email: `${'a'.repeat(300)}@fixture.test`, password: GOOD_PASSWORD }));
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ code: 'invalid_credentials', error: 'Invalid email address or password.' });
    expect(calls).toEqual([]);
    expect(findByEmail).not.toHaveBeenCalled();
  });

  it('answers a wrong password for an address that is not an account in the same words', async () => {
    const unknown = await login(jsonPost('/api/auth/login', { email: 'nobody@fixture.test', password: GOOD_PASSWORD }));
    const long = await login(jsonPost('/api/auth/login', { email: `${'b'.repeat(1000)}@fixture.test`, password: GOOD_PASSWORD }));
    expect(long.status).toBe(unknown.status);
    expect(await long.json()).toEqual(await unknown.json());
  });

  it('names the counter of an address by the hash of the lower-cased address', async () => {
    const calls = recorder();
    const email = ' Victim@Fixture.Test ';
    await recordFailedLogin('10.0.0.9', email);
    await checkLoginRateLimit('10.0.0.9', email);
    await resetLoginAttempts(email);
    const emailKeys = calls.filter((key) => key.includes('login_attempts:email:'));
    expect(emailKeys.length).toBeGreaterThanOrEqual(3);
    for (const key of emailKeys) {
      expect(key).toBe(`${redisUserStore.getKeyPrefix()}login_attempts:email:${sha256('victim@fixture.test')}`);
      expect(key).not.toContain('ictim');
    }
    expect(loginEmailAttemptsKey('VICTIM@fixture.test')).toBe(emailKeys[0]);
  });

  it('still locks an address after its failed attempts, whatever the case it is typed in', async () => {
    await passwordAccount('locked', { emailVerified: true });
    const ip = freshClientIp();
    for (let attempt = 0; attempt < 5; attempt++) {
      const response = await login(jsonPost('/api/auth/login', { email: attempt % 2 ? 'LOCKED@fixture.test' : 'locked@fixture.test', password: 'wrong password!' }, { ip: freshClientIp() }));
      expect(response.status).toBe(401);
    }
    const refused = await login(jsonPost('/api/auth/login', { email: 'locked@fixture.test', password: GOOD_PASSWORD }, { ip }));
    expect(refused.status).toBe(429);
  });

  it('sends the session in the cookie only', async () => {
    await passwordAccount('cookie', { emailVerified: true });
    const response = await login(jsonPost('/api/auth/login', { email: 'cookie@fixture.test', password: GOOD_PASSWORD }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ success: true, user: { email: 'cookie@fixture.test' } });
    expect(body).not.toHaveProperty('token');
    expect(response.headers.get('set-cookie')).toContain('HttpOnly');
  });
});

describe('the reserve of the mail budget', () => {
  it('is not drawn on by the reset mail of an unverified address, and is by that of a verified one', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const unverified = await passwordAccount('unverified');
    const verified = await passwordAccount('verified', { emailVerified: true });
    for (let sent = 0; sent < MAIL_DAILY_VERIFY_CAP; sent++) await reserveMailSend('verify');

    await queueAccountMail('reset', unverified, 'en');
    await settle();
    expect(mail.sendMail).not.toHaveBeenCalled();
    expect(warn.mock.calls.some(([line]) => line === 'auth_mail_failure category=budget')).toBe(true);
    expect(await mailSentToday()).toBe(MAIL_DAILY_VERIFY_CAP);

    await queueAccountMail('reset', verified, 'en');
    await vi.waitFor(() => expect(mail.sendMail).toHaveBeenCalledTimes(1));
    expect(mail.sendMail.mock.calls[0][0].to).toBe('verified@fixture.test');
    expect(await mailSentToday()).toBe(MAIL_DAILY_VERIFY_CAP + 1);
  });

  it('counts the reset mail of an unverified address in the verification share while it has room', async () => {
    const unverified = await passwordAccount('room');
    for (let sent = 0; sent < MAIL_DAILY_VERIFY_CAP - 1; sent++) await reserveMailSend('verify');
    await queueAccountMail('reset', unverified, 'en');
    await vi.waitFor(() => expect(mail.sendMail).toHaveBeenCalledTimes(1));
    expect(await mailSentToday()).toBe(MAIL_DAILY_VERIFY_CAP);
    // The share is full now: the next such mail is refused, and the reserve up to the hard cap is untouched.
    await queueAccountMail('reset', unverified, 'en');
    await settle();
    expect(mail.sendMail).toHaveBeenCalledTimes(1);
    expect(MAIL_DAILY_HARD_CAP - (await mailSentToday())).toBe(MAIL_DAILY_HARD_CAP - MAIL_DAILY_VERIFY_CAP);
  });
});

describe('the texts of an API key', () => {
  const keyRequest = (path: string, method: string, cookie: string, body: unknown) =>
    new NextRequest(`${ORIGIN}${path}`, { method, headers: { Origin: ORIGIN, Cookie: cookie }, body: JSON.stringify(body) });
  const params = (id: string) => ({ params: Promise.resolve({ id }) });
  let cookie: string;
  let keyId: string;

  beforeEach(async () => {
    const user = userStore.sanitizeUser(await userStore.createUser({ email: 'keys.bounds@example.com', name: 'Keys' }));
    cookie = `easyconvert_session=${createSessionToken(user)}`;
    keyId = (await redisKeyStore.generateApiKey(user.id, 'Existing', { scopes: ['convert:read'] })).key.id;
  });

  const create = (body: Record<string, unknown>) => createKey(keyRequest('/api/keys', 'POST', cookie, { acceptedTermsVersion: TERMS_VERSION, ...body }));
  const update = (body: Record<string, unknown>) => updateKey(keyRequest(`/api/keys/${keyId}`, 'PATCH', cookie, body), params(keyId));
  const invalidSettings = async (response: Response) => {
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ success: false, code: 'invalid_key_settings' });
  };

  it.each([
    ['a name', { name: 'n'.repeat(MAX_KEY_NAME_LENGTH + 1) }],
    ['more allowed addresses than the limit', { allowedIps: Array.from({ length: MAX_ALLOWED_IPS + 1 }, (_, i) => `203.0.113.${i % 250}`) }],
    ['an allowed address that is too long', { allowedIps: ['1'.repeat(65)] }],
    ['a webhook address', { webhookUrl: `https://hooks.example.com/${'p'.repeat(MAX_WEBHOOK_URL_LENGTH)}`, webhookSecret: 's' }],
    ['a webhook secret', { webhookUrl: 'https://hooks.example.com/in', webhookSecret: 's'.repeat(513) }],
  ])('refuses %s over its limit on a create and on an update', async (_what, body) => {
    await invalidSettings(await create(body));
    await invalidSettings(await update(body));
  });

  it('takes the values at their limits', async () => {
    const response = await create({
      name: 'n'.repeat(MAX_KEY_NAME_LENGTH),
      allowedIps: Array.from({ length: MAX_ALLOWED_IPS }, (_, i) => `203.0.113.${i}`),
    });
    expect(response.status).toBe(200);
    expect((await update({ name: 'm'.repeat(MAX_KEY_NAME_LENGTH) })).status).toBe(200);
  });
});

describe('the saved storage credentials', () => {
  let headers: Record<string, string>;
  let userId: string;

  beforeEach(async () => {
    const user = await userStore.createUser({ email: `cred.bounds.${Math.random().toString(36).slice(2)}@example.com`, name: 'Cred', tier: 'paid' });
    userId = user.id;
    const { secretKey } = await redisKeyStore.generateApiKey(userId, 'cred', { scopes: ['convert:write', 'convert:read'] });
    headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${secretKey}` };
  });

  const post = (body: Record<string, unknown>) =>
    postCredentials(new NextRequest(`${ORIGIN}/api/v1/storage/credentials`, { method: 'POST', headers, body: JSON.stringify(body) }));
  const s3 = (extra: Record<string, unknown> = {}) => ({ type: 's3', bucket: 'customer-bucket', accessKeyId: 'AKIA_X', secretAccessKey: 'SECRET_X', ...extra });

  it('refuses a name over the limit, and a name that is not a string, and stores nothing', async () => {
    for (const name of ['n'.repeat(MAX_STORAGE_CREDENTIAL_NAME_LENGTH + 1), 42]) {
      const response = await post({ providerType: 's3', credentials: s3(), name });
      expect(response.status).toBe(400);
      expect((await response.json()).detail).toContain('"name"');
    }
    expect(await credentialsVault.list(userId)).toEqual([]);
  });

  it('refuses credentials over the size limit and stores nothing', async () => {
    const response = await post({ providerType: 's3', credentials: s3({ secretAccessKey: 'k'.repeat(MAX_STORAGE_CREDENTIAL_JSON_BYTES) }) });
    expect(response.status).toBe(400);
    expect((await response.json()).detail).toContain('"credentials"');
    expect(await credentialsVault.list(userId)).toEqual([]);
  });

  it('answers an error it did not classify with a fixed sentence, on a save and on a listing', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(credentialsVault, 'list').mockRejectedValue(new Error('connect ECONNREFUSED /var/run/redis.sock'));
    const listing = await getCredentials(new NextRequest(`${ORIGIN}/api/v1/storage/credentials`, { headers }));
    expect(listing.status).toBe(500);
    expect(JSON.stringify(await listing.json())).not.toContain('ECONNREFUSED');
    expect(error.mock.calls.some((call) => String(call[1]).includes('ECONNREFUSED'))).toBe(true);

    vi.spyOn(credentialsVault, 'store').mockRejectedValue(new Error('EACCES: permission denied, open /srv/vault/key'));
    const saved = await post({ providerType: 'sftp', credentials: { type: 'sftp', host: 'files.example.com', username: 'u', password: 'p', basePath: '/' } });
    expect(saved.status).toBe(500);
    const body = JSON.stringify(await saved.json());
    expect(body).not.toContain('EACCES');
    expect(body).toContain('Failed to register credentials.');
  });
});

describe('the bundle of a caller without an account', () => {
  const bundle = (headers: Record<string, string> = {}) =>
    bundlePost(
      new NextRequest(`${ORIGIN}/api/storage/bundle`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify({ files: [{ key: 'conversions/nobody/1_missing.pdf', name: 'missing.pdf' }] }),
      })
    );

  it('holds a slot under its address bucket, and releases it when the request ends', async () => {
    const release = vi.fn();
    slots.acquire.mockResolvedValueOnce({ granted: true, release });
    const response = await bundle({ 'x-forwarded-for': '198.51.100.7' });
    expect(response.status).toBe(404);
    expect(slots.acquire).toHaveBeenCalledTimes(1);
    const [owner, tier] = slots.acquire.mock.calls[0];
    expect(owner).toMatch(/^anon:/);
    expect(tier).toBe('free');
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('is told to wait when its slots are in use', async () => {
    slots.acquire.mockResolvedValueOnce({ granted: false as never, limit: 5 } as never);
    const response = await bundle();
    expect(response.status).toBe(429);
    expect((await response.json()).limit).toBe(5);
  });

  it('keeps a signed-in caller on the slot of its account', async () => {
    const user = userStore.sanitizeUser(await userStore.createUser({ email: 'bundle.owner@example.com', name: 'Bundle' }));
    await bundle({ cookie: `easyconvert_session=${createSessionToken(user)}` });
    expect(slots.acquire.mock.calls[0][0]).toBe(user.id);
  });
});
