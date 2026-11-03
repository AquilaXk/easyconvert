import { beforeEach, describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { GET as googleUrl } from '../src/app/api/auth/google/url/route';
import { GET as googleCallback } from '../src/app/api/auth/google/callback/route';
import { OAUTH_STATE_COOKIE_NAME } from '../src/lib/auth/oauth';
import { redisUserStore } from '../src/lib/auth/redis-user-store';
import { TERMS_VERSION } from '../src/lib/legal/documents';

/**
 * Sign-in with Google comes back in the language it started in: the sign-in page sends its locale to the URL route, the
 * route keeps it with the OAuth state on the server, and the callback's redirects carry its prefix. The flow runs end to
 * end through the local sandbox of the provider (no client id), which sends the browser straight to the callback.
 */

const ORIGIN = 'http://localhost:3000';

async function signInFrom(query: string): Promise<string> {
  const started = await googleUrl(new NextRequest(`${ORIGIN}/api/auth/google/url${query}`));
  const { url } = (await started.json()) as { url: string };
  const state = new URL(url).searchParams.get('state');
  const back = await googleCallback(new NextRequest(url, { headers: { cookie: `${OAUTH_STATE_COOKIE_NAME}=${state}` } }));
  expect(back.status).toBe(307);
  const location = new URL(back.headers.get('location')!);
  return `${location.pathname}${location.search}`;
}

beforeEach(() => {
  redisUserStore.resetStore();
});

describe('the Google sign-in keeps the language it started in', () => {
  const accepted = `acceptedTermsVersion=${TERMS_VERSION}`;

  it('lands on the Korean dashboard after starting on /ko', async () => {
    expect(await signInFrom(`?locale=ko&${accepted}`)).toBe('/ko/dashboard');
  });

  it('lands on the English dashboard without a locale or with one the site does not offer', async () => {
    expect(await signInFrom(`?${accepted}`)).toBe('/dashboard');
    expect(await signInFrom(`?locale=en&${accepted}`)).toBe('/dashboard');
    expect(await signInFrom(`?locale=xx&${accepted}`)).toBe('/dashboard');
    expect(await signInFrom(`?locale=//evil.example&${accepted}`)).toBe('/dashboard');
  });

  it('sends a refusal back to the sign-in page of that language', async () => {
    await redisUserStore.createUser({ email: 'dev.sandbox@example.com', name: 'Existing', tier: 'free', provider: 'email' });
    expect(await signInFrom('?locale=ko')).toBe('/ko/auth?error=account_linking_required&email=dev.sandbox%40example.com');
  });

  it('answers a missing code of a known state on the sign-in page of its language', async () => {
    const started = await googleUrl(new NextRequest(`${ORIGIN}/api/auth/google/url?locale=ko`));
    const state = new URL(((await started.json()) as { url: string }).url).searchParams.get('state');
    const back = await googleCallback(
      new NextRequest(`${ORIGIN}/api/auth/google/callback?state=${state}`, { headers: { cookie: `${OAUTH_STATE_COOKIE_NAME}=${state}` } })
    );
    expect(new URL(back.headers.get('location')!).pathname + new URL(back.headers.get('location')!).search).toBe('/ko/auth?error=oauth_code_missing');
  });

  it('answers a callback with neither state nor code on the English sign-in page, since no language is known yet', async () => {
    const back = await googleCallback(new NextRequest(`${ORIGIN}/api/auth/google/callback`));
    expect(back.status).toBe(307);
    const location = new URL(back.headers.get('location')!);
    expect(`${location.pathname}${location.search}`).toBe('/auth?error=invalid_oauth_state');
  });
});
