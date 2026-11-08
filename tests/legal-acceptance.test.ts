import { beforeEach, describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { POST as register } from '../src/app/api/auth/register/route';
import { GET as googleUrl } from '../src/app/api/auth/google/url/route';
import { GET as googleCallback } from '../src/app/api/auth/google/callback/route';
import { GET as listKeys, POST as createKey } from '../src/app/api/keys/route';
import { OAUTH_STATE_COOKIE_NAME } from '../src/lib/auth/oauth';
import { redisUserStore } from '../src/lib/auth/redis-user-store';
import { createSessionToken } from '../src/lib/auth/session';
import { keyStore } from '../src/lib/api-keys/key-store';
import { TERMS_VERSION } from '../src/lib/legal/documents';

/**
 * Sign-up and API key creation record which version of the terms was accepted (issue #901). The version is the date the
 * terms page shows; an account is created only with the version in force, and a key records it when it is made.
 */

const ORIGIN = 'http://localhost:3000';
const SANDBOX_EMAIL = 'dev.sandbox@example.com';

function signUp(body: Record<string, unknown>) {
  return register(
    new NextRequest(`${ORIGIN}/api/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'reader@legal.test', password: 'LongEnough1', ...body }),
    })
  );
}

/** Starts a sign-in with Google from `query` and follows the sandbox provider back to the callback; the redirect target. */
async function signInWithGoogle(query: string): Promise<string> {
  const started = await googleUrl(new NextRequest(`${ORIGIN}/api/auth/google/url${query}`));
  const { url } = (await started.json()) as { url: string };
  const state = new URL(url).searchParams.get('state');
  const back = await googleCallback(new NextRequest(url, { headers: { cookie: `${OAUTH_STATE_COOKIE_NAME}=${state}` } }));
  const location = new URL(back.headers.get('location')!);
  return `${location.pathname}${location.search}`;
}

beforeEach(() => {
  redisUserStore.resetStore();
  keyStore.resetStore();
});

describe('sign-up records the accepted terms version', () => {
  it('stores the version in force on the new account', async () => {
    const answer = await signUp({ acceptedTermsVersion: TERMS_VERSION });
    expect(answer.status).toBe(200);
    const stored = await redisUserStore.findByEmail('reader@legal.test');
    expect(stored?.acceptedTermsVersion).toBe(TERMS_VERSION);
  });

  it.each([
    ['without a version', {}, 'terms_not_accepted'],
    ['with a version that is not text', { acceptedTermsVersion: true }, 'terms_not_accepted'],
    ['with a version that is no date', { acceptedTermsVersion: 'yes' }, 'terms_not_accepted'],
    ['with an earlier version, from a page loaded before the terms changed', { acceptedTermsVersion: '2020-01-01' }, 'terms_outdated'],
  ])('refuses a sign-up %s and creates no account', async (_, body, code) => {
    const answer = await signUp(body);
    expect(answer.status).toBe(400);
    expect((await answer.json()).code).toBe(code);
    expect(await redisUserStore.findByEmail('reader@legal.test')).toBeNull();
  });

  it('stores the version a sign-up with Google accepted', async () => {
    expect(await signInWithGoogle(`?acceptedTermsVersion=${TERMS_VERSION}`)).toBe('/dashboard');
    expect((await redisUserStore.findByEmail(SANDBOX_EMAIL))?.acceptedTermsVersion).toBe(TERMS_VERSION);
  });

  it('sends a new Google account without accepted terms back to sign-up, in its language', async () => {
    expect(await signInWithGoogle('?locale=ko')).toBe('/ko/auth?tab=register&error=terms_required');
    expect(await redisUserStore.findByEmail(SANDBOX_EMAIL)).toBeNull();
  });

  it('answers a Google start with an earlier version with terms_outdated, so the page asks for a reload', async () => {
    const started = await googleUrl(new NextRequest(`${ORIGIN}/api/auth/google/url?acceptedTermsVersion=2020-01-01`));
    expect(started.status).toBe(400);
    expect((await started.json()).code).toBe('terms_outdated');
  });

  it('creates no Google account from a start whose version is not one', async () => {
    expect(await signInWithGoogle('?acceptedTermsVersion=yes')).toBe('/auth?tab=register&error=terms_required');
    expect(await redisUserStore.findByEmail(SANDBOX_EMAIL)).toBeNull();
  });

  it('signs in an existing Google account without asking again', async () => {
    await redisUserStore.createUser({ email: SANDBOX_EMAIL, name: 'Existing', provider: 'google', acceptedTermsVersion: TERMS_VERSION });
    expect(await signInWithGoogle('')).toBe('/dashboard');
  });
});

describe('API key creation records the terms version the request accepted', () => {
  async function keyOwnerCookie(): Promise<string> {
    const user = redisUserStore.sanitizeUser(await redisUserStore.createUser({ email: 'keys@legal.test', name: 'Keys' }));
    return `easyconvert_session=${createSessionToken(user)}`;
  }

  function createKeyWith(cookie: string, body: Record<string, unknown>) {
    return createKey(new NextRequest(`${ORIGIN}/api/keys`, { method: 'POST', headers: { cookie }, body: JSON.stringify({ name: 'CI', ...body }) }));
  }

  it('stores the version in force on the new key', async () => {
    const cookie = await keyOwnerCookie();
    const created = await createKeyWith(cookie, { acceptedTermsVersion: TERMS_VERSION });
    expect(created.status).toBe(200);
    expect((await created.json()).key.acceptedTermsVersion).toBe(TERMS_VERSION);

    const listed = await (await listKeys(new NextRequest(`${ORIGIN}/api/keys`, { headers: { cookie } }))).json();
    expect(listed.keys[0].acceptedTermsVersion).toBe(TERMS_VERSION);
  });

  it.each([
    ['without a version', {}, 'terms_not_accepted'],
    ['with an earlier version', { acceptedTermsVersion: '2020-01-01' }, 'terms_outdated'],
  ])('refuses a key %s and creates none', async (_, body, code) => {
    const cookie = await keyOwnerCookie();
    const answer = await createKeyWith(cookie, body);
    expect(answer.status).toBe(400);
    expect((await answer.json()).code).toBe(code);

    const listed = await (await listKeys(new NextRequest(`${ORIGIN}/api/keys`, { headers: { cookie } }))).json();
    expect(listed.keys).toEqual([]);
  });
});
