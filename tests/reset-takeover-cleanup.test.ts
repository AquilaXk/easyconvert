import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mail = vi.hoisted(() => ({
  sendMail: vi.fn(async (_message: { from: string; to: string; subject: string; text: string }) => ({ messageId: 'fixture' })),
}));
vi.mock('nodemailer', () => ({
  createTransport: () => ({ sendMail: mail.sendMail, close: vi.fn() }),
}));

import { POST as requestReset } from '../src/app/api/auth/password-reset/request/route';
import { POST as confirmReset } from '../src/app/api/auth/password-reset/confirm/route';
import { webhookDispatcher } from '../src/lib/api-keys/webhook-dispatcher';
import { getWebhookSecretStore } from '../src/lib/api-keys/webhook-secret-store';
import { redisKeyStore } from '../src/lib/api-keys/redis-key-store';
import { resetAuthTokenMemory } from '../src/lib/auth/auth-email-token-store';
import { isEmailVerified } from '../src/lib/auth/account-mail';
import { resetLoginRateLimiterStore } from '../src/lib/auth/login-rate-limiter';
import { redisUserStore } from '../src/lib/auth/redis-user-store';
import { credentialsVault } from '../src/lib/storage/credentials-vault';
import { jsonPost, passwordAccount, stubMailConfig, tokenOfMail } from './helpers/auth-mail-fixtures';

/**
 * A password reset that turns an unverified address into a verified one hands the account to the owner of the mailbox. What the
 * registrant made with the account before (API keys, their webhooks, saved storage credentials) must not go with it.
 * docs/policy-decisions.md, entry 288.
 */

const NEW_PASSWORD = 'Owner chose this 1!';

beforeEach(() => {
  redisUserStore.resetStore();
  redisKeyStore.resetStore();
  resetAuthTokenMemory();
  resetLoginRateLimiterStore();
  mail.sendMail.mockClear();
  stubMailConfig();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

/** What a registrant could have set up with the account: a `*` key that calls a webhook of theirs, and a saved credential. */
async function registrantsSetup(userId: string) {
  const first = await redisKeyStore.generateApiKey(userId, 'squatter key', {
    scopes: ['*'],
    webhookUrl: 'https://squatter.example.test/hook',
    webhookSecret: 'whsec_squatter_secret',
  });
  const second = await redisKeyStore.generateApiKey(userId, 'second key', { scopes: ['convert:write'] });
  await getWebhookSecretStore().setPrimarySecret(userId, first.key.id, 'whsec_squatter_secret');
  const credentialRef = await credentialsVault.store(userId, { type: 'http', bearerToken: 'squatter-bearer' });
  return { first, second, credentialRef };
}

async function resetThrough(email: string) {
  await requestReset(jsonPost('/api/auth/password-reset/request', { email }));
  await vi.waitFor(() => expect(mail.sendMail).toHaveBeenCalledTimes(1));
  const token = tokenOfMail(mail.sendMail.mock.calls[0][0].text);
  return confirmReset(jsonPost('/api/auth/password-reset/confirm', { token, password: NEW_PASSWORD }));
}

describe('a reset that takes an unverified account back for the owner of its address', () => {
  it('deletes its API keys with their webhook addresses and secrets, its saved storage credentials and its waiting failed deliveries', async () => {
    const record = await passwordAccount('squatted');
    const { first, second, credentialRef } = await registrantsSetup(record.id);
    const clearDlq = vi.spyOn(webhookDispatcher, 'clearDlq');
    expect((await redisKeyStore.listApiKeys(record.id)).map((key) => key.id).sort()).toEqual([first.key.id, second.key.id].sort());

    const response = await resetThrough(record.email);

    expect(response.status).toBe(200);
    expect(isEmailVerified((await redisUserStore.findById(record.id))!)).toBe(true);
    expect(await redisKeyStore.listApiKeys(record.id)).toEqual([]);
    expect((await redisKeyStore.verifyApiKey(first.secretKey)).valid).toBe(false);
    expect((await redisKeyStore.verifyApiKey(second.secretKey)).valid).toBe(false);
    expect(await getWebhookSecretStore().getSecretRecord(record.id, first.key.id)).toBeNull();
    expect(await credentialsVault.listByUser(record.id)).toEqual([]);
    expect(await credentialsVault.get(credentialRef, record.id)).toBeNull();
    expect(clearDlq).toHaveBeenCalledWith(record.id, { strict: true });
  });

  it('can be done again after a cleanup step failed: the account stays unverified until its keys are gone, so a second reset cleans up', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const record = await passwordAccount('squatted');
    const { first } = await registrantsSetup(record.id);
    vi.spyOn(redisKeyStore, 'deleteApiKey').mockRejectedValueOnce(new Error('the store went away'));

    const failed = await resetThrough(record.email);
    expect(failed.status).toBe(500);
    // The token is spent and the owner's password is set, but the address is not confirmed and the keys are still there.
    expect(isEmailVerified((await redisUserStore.findById(record.id))!)).toBe(false);
    expect((await redisKeyStore.verifyApiKey(first.secretKey)).valid).toBe(true);

    mail.sendMail.mockClear();
    const retried = await resetThrough(record.email);
    expect(retried.status).toBe(200);
    expect(isEmailVerified((await redisUserStore.findById(record.id))!)).toBe(true);
    expect(await redisKeyStore.listApiKeys(record.id)).toEqual([]);
    expect((await redisKeyStore.verifyApiKey(first.secretKey)).valid).toBe(false);
    expect(await credentialsVault.listByUser(record.id)).toEqual([]);
  });

  it('leaves the keys, credentials and webhooks of an account whose address was verified alone: an ordinary reset', async () => {
    const record = await passwordAccount('ordinary', { emailVerified: true });
    const { first, credentialRef } = await registrantsSetup(record.id);
    const clearDlq = vi.spyOn(webhookDispatcher, 'clearDlq');

    const response = await resetThrough(record.email);

    expect(response.status).toBe(200);
    expect(await redisKeyStore.listApiKeys(record.id)).toHaveLength(2);
    expect((await redisKeyStore.verifyApiKey(first.secretKey)).valid).toBe(true);
    expect(await credentialsVault.listByUser(record.id)).toEqual([credentialRef]);
    expect(clearDlq).not.toHaveBeenCalled();
  });

  it('touches nothing of the account when the link is not valid', async () => {
    const record = await passwordAccount('squatted');
    await registrantsSetup(record.id);
    const response = await confirmReset(jsonPost('/api/auth/password-reset/confirm', { token: 'A'.repeat(43), password: NEW_PASSWORD }));
    expect(response.status).toBe(400);
    expect(await redisKeyStore.listApiKeys(record.id)).toHaveLength(2);
    expect(isEmailVerified((await redisUserStore.findById(record.id))!)).toBe(false);
  });
});
