import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mail = vi.hoisted(() => ({
  sendMail: vi.fn(async (_message: { from: string; to: string; subject: string; text: string }) => ({ messageId: 'fixture' })),
}));
vi.mock('nodemailer', () => ({
  createTransport: () => ({ sendMail: mail.sendMail, close: vi.fn() }),
}));

import { POST as requestReset } from '../src/app/api/auth/password-reset/request/route';
import { POST as confirmReset } from '../src/app/api/auth/password-reset/confirm/route';
import { POST as confirmVerification } from '../src/app/api/auth/email-verification/confirm/route';
import { applyEmailConfirmation } from '../scripts/confirm-account-email';
import { WebhookDlqStore } from '../src/lib/api-keys/webhook-dlq-store';
import { webhookDispatcher } from '../src/lib/api-keys/webhook-dispatcher';
import { getWebhookSecretStore } from '../src/lib/api-keys/webhook-secret-store';
import { redisKeyStore } from '../src/lib/api-keys/redis-key-store';
import type { WebhookDlqEntry } from '../src/lib/api-keys/types';
import { issueAuthToken, resetAuthTokenMemory } from '../src/lib/auth/auth-email-token-store';
import { resetLoginRateLimiterStore } from '../src/lib/auth/login-rate-limiter';
import { redisUserStore } from '../src/lib/auth/redis-user-store';
import { credentialsVault } from '../src/lib/storage/credentials-vault';
import { jsonPost, passwordAccount, stubMailConfig, tokenOfMail } from './helpers/auth-mail-fixtures';

/**
 * A squatter registers the address of someone else, makes keys with the password they know, and the owner confirms the address with
 * the link of the verification mail. Confirming alone changes nothing the squatter holds, so the owner's reset of the password later
 * deletes what was made before the confirmation (`verifiedAt`) and keeps what was made since. docs/policy-decisions.md, entry 362.
 */

const NEW_PASSWORD = 'Owner chose this 1!';
const T0 = Date.UTC(2026, 10, 1, 12, 0, 0);
const HOUR = 3_600_000;
/** The fake clock keeps running with the real one, so a time the code wrote is a few milliseconds after the time that was set. */
const SLACK_MS = 60_000;
function expectAbout(actual: number | undefined, set: number): void {
  expect(actual).toBeGreaterThanOrEqual(set);
  expect(actual).toBeLessThan(set + SLACK_MS);
}

beforeEach(() => {
  redisUserStore.resetStore();
  redisKeyStore.resetStore();
  resetAuthTokenMemory();
  resetLoginRateLimiterStore();
  mail.sendMail.mockClear();
  stubMailConfig();
  vi.useFakeTimers({ toFake: ['Date'], now: T0 });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

async function confirmByLink(record: { id: string; email: string }) {
  const token = await issueAuthToken('verify', { userId: record.id, email: record.email });
  return confirmVerification(jsonPost('/api/auth/email-verification/confirm', { token }));
}

async function resetThrough(email: string) {
  await requestReset(jsonPost('/api/auth/password-reset/request', { email }));
  await vi.waitFor(() => expect(mail.sendMail).toHaveBeenCalledTimes(1));
  const token = tokenOfMail(mail.sendMail.mock.calls[0][0].text);
  mail.sendMail.mockClear();
  return confirmReset(jsonPost('/api/auth/password-reset/confirm', { token, password: NEW_PASSWORD }));
}

describe('verifiedAt, the time the address was first confirmed', () => {
  it('is written by the link of the verification mail, once', async () => {
    const record = await passwordAccount('linked');
    expect(record.verifiedAt).toBeUndefined();

    expect((await confirmByLink(record)).status).toBe(200);
    const confirmed = await redisUserStore.findById(record.id);
    expect(confirmed?.emailVerified).toBe(true);
    expectAbout(confirmed?.verifiedAt, T0);
    const first = confirmed?.verifiedAt;

    vi.setSystemTime(T0 + 5 * HOUR);
    expect((await confirmByLink(record)).status).toBe(200);
    expect((await redisUserStore.findById(record.id))?.verifiedAt).toBe(first);
  });

  it('is not written for an account confirmed before it was recorded', async () => {
    const record = await passwordAccount('legacy', { emailVerified: true });
    expect((await confirmByLink(record)).status).toBe(200);
    expect((await redisUserStore.findById(record.id))?.verifiedAt).toBeUndefined();
  });

  it('is written by a reset of an unverified account, and by the operator tool', async () => {
    const reset = await passwordAccount('reset');
    expect((await resetThrough(reset.email)).status).toBe(200);
    expectAbout((await redisUserStore.findById(reset.id))?.verifiedAt, T0);

    const tool = await passwordAccount('tool');
    await applyEmailConfirmation({ userId: tool.id, email: tool.email });
    expectAbout((await redisUserStore.findById(tool.id))?.verifiedAt, T0);
  });

  it('is not shown in the user the sessions and the API carry', async () => {
    const record = await passwordAccount('hidden');
    await confirmByLink(record);
    const stored = await redisUserStore.findById(record.id);
    expectAbout(stored?.verifiedAt, T0);
    expect(redisUserStore.sanitizeUser(stored!)).not.toHaveProperty('verifiedAt');
  });
});

describe('a reset of an account the owner confirmed by link', () => {
  it('deletes the keys, webhook secrets and credentials made before the confirmation, and keeps those made since', async () => {
    const record = await passwordAccount('squatted');
    const squatterKey = await redisKeyStore.generateApiKey(record.id, 'squatter key', { scopes: ['*'], webhookUrl: 'https://squatter.example.test/hook', webhookSecret: 'whsec_squatter' });
    await getWebhookSecretStore().setPrimarySecret(record.id, squatterKey.key.id, 'whsec_squatter');
    const squatterCredential = await credentialsVault.store(record.id, { type: 'http', bearerToken: 'squatter-bearer' });

    vi.setSystemTime(T0 + HOUR);
    expect((await confirmByLink(record)).status).toBe(200);

    vi.setSystemTime(T0 + 2 * HOUR);
    const ownerKey = await redisKeyStore.generateApiKey(record.id, 'owner key', { scopes: ['convert:write'] });
    const ownerCredential = await credentialsVault.store(record.id, { type: 'http', bearerToken: 'owner-bearer' });

    vi.setSystemTime(T0 + 3 * HOUR);
    expect((await resetThrough(record.email)).status).toBe(200);

    expect((await redisKeyStore.verifyApiKey(squatterKey.secretKey)).valid).toBe(false);
    expect(await getWebhookSecretStore().getSecretRecord(record.id, squatterKey.key.id)).toBeNull();
    expect(await credentialsVault.get(squatterCredential, record.id)).toBeNull();
    expect((await redisKeyStore.listApiKeys(record.id)).map((key) => key.id)).toEqual([ownerKey.key.id]);
    expect((await redisKeyStore.verifyApiKey(ownerKey.secretKey)).valid).toBe(true);
    expect(await credentialsVault.listByUser(record.id)).toEqual([ownerCredential]);
    expectAbout((await redisUserStore.findById(record.id))?.verifiedAt, T0 + HOUR);
  });

  it('asks the dispatcher to clear only the failed deliveries from before the confirmation', async () => {
    const record = await passwordAccount('dlq');
    vi.setSystemTime(T0 + HOUR);
    await confirmByLink(record);
    const clearDlq = vi.spyOn(webhookDispatcher, 'clearDlq');

    expect((await resetThrough(record.email)).status).toBe(200);

    const confirmedAt = (await redisUserStore.findById(record.id))!.verifiedAt;
    expectAbout(confirmedAt, T0 + HOUR);
    expect(clearDlq).toHaveBeenCalledWith(record.id, { strict: true, failedBefore: confirmedAt });
  });

  it('ends every session, those from before the confirmation too', async () => {
    const record = await passwordAccount('sessions');
    const before = await redisUserStore.getSessionVersion(record.id);
    await confirmByLink(record);
    expect((await resetThrough(record.email)).status).toBe(200);
    expect(await redisUserStore.getSessionVersion(record.id)).toBeGreaterThan(before);
  });

  it('can be run again after a step failed: the confirmation time stays, so a second reset cleans again', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const record = await passwordAccount('retry');
    const squatterKey = await redisKeyStore.generateApiKey(record.id, 'squatter key', { scopes: ['*'] });
    vi.setSystemTime(T0 + HOUR);
    await confirmByLink(record);
    vi.setSystemTime(T0 + 2 * HOUR);
    vi.spyOn(redisKeyStore, 'deleteApiKey').mockRejectedValueOnce(new Error('the store went away'));

    expect((await resetThrough(record.email)).status).toBe(500);
    expect((await redisKeyStore.verifyApiKey(squatterKey.secretKey)).valid).toBe(true);

    expect((await resetThrough(record.email)).status).toBe(200);
    expect((await redisKeyStore.verifyApiKey(squatterKey.secretKey)).valid).toBe(false);
  });

  it('leaves everything of an account confirmed before verifiedAt was recorded: nothing says what is older', async () => {
    const record = await passwordAccount('legacy', { emailVerified: true });
    const key = await redisKeyStore.generateApiKey(record.id, 'a key', { scopes: ['*'] });
    const credential = await credentialsVault.store(record.id, { type: 'http', bearerToken: 'bearer' });

    expect((await resetThrough(record.email)).status).toBe(200);

    expect((await redisKeyStore.verifyApiKey(key.secretKey)).valid).toBe(true);
    expect(await credentialsVault.listByUser(record.id)).toEqual([credential]);
  });
});

describe('the failed deliveries of the dead letter store, cleared by time', () => {
  function letter(id: string, failedAt: number): WebhookDlqEntry {
    return { id, originalDeliveryId: `wh_${id}`, targetUrl: 'https://93.184.215.14/hook', event: 'job.failed', payload: {}, secret: 'sealed', failedAt, retryCount: 3, status: 'failed', ownerUserId: 'owner-a' };
  }

  it('removes the entries of the owner that failed before the time, and no other', async () => {
    const memory = new Map<string, WebhookDlqEntry>();
    const store = new WebhookDlqStore(memory, () => null, 30 * 24 * HOUR);
    await store.put(letter('old', T0 - HOUR));
    await store.put(letter('same-ms', T0));
    await store.put(letter('new', T0 + HOUR));
    await store.put({ ...letter('other', T0 - HOUR), ownerUserId: 'owner-b' });

    await store.clear('owner-a', { failedBefore: T0 });

    expect([...memory.keys()].sort()).toEqual(['new', 'other', 'same-ms']);
  });
});
