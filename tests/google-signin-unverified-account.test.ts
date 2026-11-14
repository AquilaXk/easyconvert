import { beforeEach, describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { GET as googleCallback } from '../src/app/api/auth/google/callback/route';
import { POST as login } from '../src/app/api/auth/login/route';
import { redisKeyStore } from '../src/lib/api-keys/redis-key-store';
import { getWebhookSecretStore } from '../src/lib/api-keys/webhook-secret-store';
import { resetLoginRateLimiterStore } from '../src/lib/auth/login-rate-limiter';
import { hashPassword } from '../src/lib/auth/crypto';
import { OAUTH_STATE_COOKIE_NAME, createOAuthSession } from '../src/lib/auth/oauth';
import { redisUserStore } from '../src/lib/auth/redis-user-store';
import { createSessionToken, getSessionFromRequest } from '../src/lib/auth/session';
import { TERMS_VERSION } from '../src/lib/legal/documents';
import { credentialsVault } from '../src/lib/storage/credentials-vault';

/**
 * Google vouches for the address it signs in (`exchangeGoogleCode` refuses an address it did not verify), and the mock sign-in of the
 * test environment answers `dev.sandbox@example.com`. An account of that address that was never verified is the registrant's squat
 * on it: the owner who signs in with Google takes it over. docs/policy-decisions.md, entry 297.
 */

const ADDRESS = 'dev.sandbox@example.com';
const SQUATTER_PASSWORD = 'squatter chose this 1!';

beforeEach(() => {
  redisUserStore.resetStore();
  redisKeyStore.resetStore();
  resetLoginRateLimiterStore();
});

/** The terms the squatter ticked when they registered: an earlier version than the one in force. */
const SQUATTERS_TERMS = '2020-01-01';

async function passwordAccountAt(emailVerified: boolean) {
  const { hash, salt } = await hashPassword(SQUATTER_PASSWORD);
  return redisUserStore.createUser({ email: ADDRESS, name: 'Squatter', provider: 'email', passwordHash: hash, salt, emailVerified, acceptedTermsVersion: SQUATTERS_TERMS });
}

/** A Google sign-in that carries the acceptance of the terms in force, as the register tab of the page sends it, unless `acceptedTermsVersion` says otherwise. */
async function signInWithGoogle(cookie = '', acceptedTermsVersion: string | null = TERMS_VERSION): Promise<Response> {
  const session = await createOAuthSession({ acceptedTermsVersion: acceptedTermsVersion ?? undefined });
  return googleCallback(
    new NextRequest(`http://localhost:3000/api/auth/google/callback?code=mock_code_${session.state}&state=${session.state}`, {
      headers: { cookie: `${OAUTH_STATE_COOKIE_NAME}=${session.state}${cookie ? `; ${cookie}` : ''}` },
    })
  );
}

function sessionCookieOf(response: Response): string {
  const cookie = response.headers.getSetCookie().find((entry) => entry.startsWith('easyconvert_session='));
  if (!cookie) throw new Error('no session cookie');
  return cookie.split(';')[0];
}

async function squattersSetup(userId: string) {
  const key = await redisKeyStore.generateApiKey(userId, 'squatter key', { scopes: ['*'], webhookUrl: 'https://squatter.example.test/hook', webhookSecret: 'whsec_squatter_secret' });
  await getWebhookSecretStore().setPrimarySecret(userId, key.key.id, 'whsec_squatter_secret');
  const credentialRef = await credentialsVault.store(userId, { type: 'http', bearerToken: 'squatter-bearer' });
  return { key, credentialRef };
}

describe('a Google sign-in for the address of an account that was never verified', () => {
  it('signs the owner in and takes the account over: verified, linked to Google, the squatter password gone', async () => {
    const squatter = await passwordAccountAt(false);

    const response = await signInWithGoogle();

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toContain('/dashboard');
    const record = (await redisUserStore.findById(squatter.id))!;
    expect(record).toMatchObject({ provider: 'google', emailVerified: true });
    expect(record.passwordHash || record.salt).toBeFalsy();
    expect((await getSessionFromRequest(new NextRequest('http://localhost:3000/x', { headers: { cookie: sessionCookieOf(response) } })))?.id).toBe(squatter.id);
  });

  it('records the terms the owner accepted with this sign-in, not the ones the squatter ticked', async () => {
    const squatter = await passwordAccountAt(false);

    await signInWithGoogle();

    expect((await redisUserStore.findById(squatter.id))?.acceptedTermsVersion).toBe(TERMS_VERSION);
  });

  it('sends the owner who did not accept the terms to sign-up, as a new Google account is, and takes nothing over', async () => {
    const squatter = await passwordAccountAt(false);
    const { key } = await squattersSetup(squatter.id);

    const response = await signInWithGoogle('', null);

    expect(response.headers.get('location')).toContain('/auth?tab=register&error=terms_required');
    expect(response.headers.getSetCookie().some((entry) => entry.startsWith('easyconvert_session='))).toBe(false);
    const record = (await redisUserStore.findById(squatter.id))!;
    expect(record).toMatchObject({ provider: 'email', passwordHash: squatter.passwordHash, acceptedTermsVersion: SQUATTERS_TERMS });
    expect(record.emailVerified).not.toBe(true);
    expect((await redisKeyStore.verifyApiKey(key.secretKey)).valid).toBe(true);
  });

  it('ends the sessions of the squatter and refuses their password', async () => {
    const squatter = await passwordAccountAt(false);
    const squattersCookie = `easyconvert_session=${createSessionToken(redisUserStore.sanitizeUser(squatter))}`;
    expect((await getSessionFromRequest(new NextRequest('http://localhost:3000/x', { headers: { cookie: squattersCookie } })))?.id).toBe(squatter.id);

    await signInWithGoogle();

    expect(await getSessionFromRequest(new NextRequest('http://localhost:3000/x', { headers: { cookie: squattersCookie } }))).toBeNull();
    const attempt = await login(
      new NextRequest('http://localhost:3000/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: ADDRESS, password: SQUATTER_PASSWORD }),
      })
    );
    expect(attempt.status).toBe(401);
  });

  it('deletes the API keys with their webhooks, the saved storage credentials and the waiting failed deliveries of the squatter', async () => {
    const squatter = await passwordAccountAt(false);
    const { key, credentialRef } = await squattersSetup(squatter.id);

    await signInWithGoogle();

    expect(await redisKeyStore.listApiKeys(squatter.id)).toEqual([]);
    expect((await redisKeyStore.verifyApiKey(key.secretKey)).valid).toBe(false);
    expect(await getWebhookSecretStore().getSecretRecord(squatter.id, key.key.id)).toBeNull();
    expect(await credentialsVault.listByUser(squatter.id)).toEqual([]);
    expect(await credentialsVault.get(credentialRef, squatter.id)).toBeNull();
  });

  it('can be done again after a step failed: the account stays unverified until the keys are gone', async () => {
    const squatter = await passwordAccountAt(false);
    const { key } = await squattersSetup(squatter.id);
    const original = redisKeyStore.deleteApiKey.bind(redisKeyStore);
    let fail = true;
    redisKeyStore.deleteApiKey = async (userId: string, keyId: string) => {
      if (fail) throw new Error('the store went away');
      return original(userId, keyId);
    };
    try {
      expect((await signInWithGoogle()).headers.get('location')).toContain('error=oauth_exchange_failed');
      expect((await redisUserStore.findById(squatter.id))?.emailVerified).not.toBe(true);
      expect((await redisKeyStore.verifyApiKey(key.secretKey)).valid).toBe(true);

      fail = false;
      expect((await signInWithGoogle()).headers.get('location')).toContain('/dashboard');
      expect(await redisKeyStore.listApiKeys(squatter.id)).toEqual([]);
    } finally {
      redisKeyStore.deleteApiKey = original;
    }
  });
});

describe('a Google sign-in for the address of a verified password account', () => {
  it('still asks the owner to sign in with the password first, and changes nothing', async () => {
    const account = await passwordAccountAt(true);
    const { key } = await squattersSetup(account.id);

    const response = await signInWithGoogle();

    expect(response.headers.get('location')).toContain('error=account_linking_required');
    expect(await redisUserStore.findById(account.id)).toMatchObject({ provider: 'email', passwordHash: account.passwordHash });
    expect((await redisKeyStore.verifyApiKey(key.secretKey)).valid).toBe(true);
  });
});
