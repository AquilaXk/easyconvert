import crypto from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { middleware } from '../src/middleware';
import { POST as logoutRoute } from '../src/app/api/auth/logout/route';
import { consumeOAuthSession, createOAuthSession, exchangeGoogleCode } from '../src/lib/auth/oauth';
import { redisUserStore } from '../src/lib/auth/redis-user-store';
import {
  clearSessionCookie,
  clearSessionCookies,
  createSessionCookie,
  createSessionToken,
  getSessionFromRequest,
  isSessionRevoked,
} from '../src/lib/auth/session';
import { HOST_SESSION_COOKIE_NAME, LEGACY_SESSION_COOKIE_NAME, sessionTokenFromCookieHeader } from '../src/lib/auth/session-cookie';
import { verifyJwt } from '../src/lib/auth/jwt';
import type { SessionPayload } from '../src/lib/auth/types';

/**
 * Hardening of the session cookie, the origin check of the edge middleware and the Google sign-in: the `__Host-` cookie name
 * with the plain name still read for a release, an `http:` origin never accepted in production, an OAuth state that two
 * callbacks cannot both consume, and an ID token that must carry the nonce of the sign-in.
 */

const HOST = 'convert.example.test';
const HTTP_FORBIDDEN = 403;

function uniqueEmail(): string {
  return `cookie_${Date.now()}_${crypto.randomBytes(4).toString('hex')}@test.com`;
}

describe('the name of the session cookie', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('is __Host- prefixed, Secure, Path=/ and without Domain in production', () => {
    vi.stubEnv('NODE_ENV', 'production');

    const cookie = createSessionCookie('tok');

    expect(cookie.startsWith(`${HOST_SESSION_COOKIE_NAME}=tok;`)).toBe(true);
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('Path=/');
    expect(cookie.toLowerCase()).not.toContain('domain=');
  });

  it('keeps the plain name outside production, where the prefix would be refused over HTTP', () => {
    expect(createSessionCookie('tok').startsWith(`${LEGACY_SESSION_COOKIE_NAME}=tok;`)).toBe(true);
    expect(clearSessionCookie().startsWith(`${LEGACY_SESSION_COOKIE_NAME}=;`)).toBe(true);
  });

  it('is cleared under both names in production, so a session issued before the prefix does not survive a sign-out', () => {
    vi.stubEnv('NODE_ENV', 'production');

    const cleared = clearSessionCookies();

    expect(cleared.map((header) => header.split('=')[0]).sort()).toEqual([HOST_SESSION_COOKIE_NAME, LEGACY_SESSION_COOKIE_NAME].sort());
    for (const header of cleared) expect(header).toContain('Max-Age=0');
  });

  it('is read under either name, the prefixed one first', () => {
    expect(sessionTokenFromCookieHeader(`a=1; ${LEGACY_SESSION_COOKIE_NAME}=old; b=2`)).toBe('old');
    expect(sessionTokenFromCookieHeader(`${LEGACY_SESSION_COOKIE_NAME}=old; ${HOST_SESSION_COOKIE_NAME}=new`)).toBe('new');
    expect(sessionTokenFromCookieHeader('other=1')).toBeNull();
    expect(sessionTokenFromCookieHeader(null)).toBeNull();
    // A cookie that merely contains the name is not it.
    expect(sessionTokenFromCookieHeader(`x${LEGACY_SESSION_COOKIE_NAME}=nope`)).toBeNull();
  });

  it('signs a request in with a cookie of either name, and signs a sign-out in with the plain one', async () => {
    const user = await redisUserStore.createUser({ email: uniqueEmail(), name: 'Cookie user' });
    const token = createSessionToken(redisUserStore.sanitizeUser(user));

    for (const name of [HOST_SESSION_COOKIE_NAME, LEGACY_SESSION_COOKIE_NAME]) {
      const session = await getSessionFromRequest(new Request('http://localhost/api/auth/me', { headers: { cookie: `${name}=${token}` } }));
      expect(session?.id, name).toBe(user.id);
    }

    const jti = verifyJwt<SessionPayload>(token)?.jti ?? '';
    await logoutRoute(new Request('http://localhost/api/auth/logout', { method: 'POST', headers: { cookie: `${LEGACY_SESSION_COOKIE_NAME}=${token}` } }));
    expect(await isSessionRevoked(jti)).toBe(true);
  });

  it('makes the edge CSRF check apply to the prefixed cookie too', async () => {
    const res = await middleware(new NextRequest('http://localhost:3000/api/keys', { method: 'POST', headers: { cookie: `${HOST_SESSION_COOKIE_NAME}=valid.session.token` } }));

    expect(res.status).toBe(HTTP_FORBIDDEN);
  });
});

describe('the origin of a cookie-authenticated mutation in production', () => {
  beforeEach(() => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('TRUSTED_PROXIES', 'none');
    vi.stubEnv('APP_ORIGIN', '');
    vi.stubEnv('NEXT_PUBLIC_APP_URL', '');
  });

  afterEach(() => vi.unstubAllEnvs());

  async function mutateWithOrigin(origin: string): Promise<number> {
    const res = await middleware(
      new NextRequest(`https://${HOST}/api/keys`, {
        method: 'POST',
        headers: { cookie: `${HOST_SESSION_COOKIE_NAME}=valid.session.token`, origin, host: HOST },
      })
    );
    return res.status;
  }

  it('accepts the https origin of the host', async () => {
    expect(await mutateWithOrigin(`https://${HOST}`)).not.toBe(HTTP_FORBIDDEN);
  });

  it('refuses the http origin of the same host: a plain-HTTP page of that host is not this site', async () => {
    expect(await mutateWithOrigin(`http://${HOST}`)).toBe(HTTP_FORBIDDEN);
  });

  it('refuses another host over https', async () => {
    expect(await mutateWithOrigin('https://evil.example.test')).toBe(HTTP_FORBIDDEN);
  });

  it('takes the configured origin as it is, so a deployment without TLS can name its own http origin', async () => {
    vi.stubEnv('APP_ORIGIN', `http://${HOST}`);

    expect(await mutateWithOrigin(`http://${HOST}`)).not.toBe(HTTP_FORBIDDEN);
  });
});

describe('the OAuth state', () => {
  it('can be consumed once', async () => {
    const session = await createOAuthSession();

    const results = await Promise.all([consumeOAuthSession(session.state), consumeOAuthSession(session.state)]);

    expect(results.filter((result) => result !== null)).toHaveLength(1);
  });

  it('reads and deletes in one Redis command, so two callbacks cannot both get it', async () => {
    const stored = new Map<string, string>();
    const calls: string[] = [];
    const client = {
      setex: async (key: string, _ttl: number, value: string) => void stored.set(key, value),
      get: async (key: string) => {
        calls.push('get');
        return stored.get(key) ?? null;
      },
      del: async (key: string) => {
        calls.push('del');
        return stored.delete(key) ? 1 : 0;
      },
      // Redis runs a command to the end before it starts the next: one callback gets the value, the other gets null.
      getdel: async (key: string) => {
        calls.push('getdel');
        const value = stored.get(key) ?? null;
        stored.delete(key);
        return value;
      },
    };
    redisUserStore.setRedisClient(client as never);
    try {
      const session = await createOAuthSession();

      const results = await Promise.all([consumeOAuthSession(session.state), consumeOAuthSession(session.state)]);

      expect(results.filter((result) => result !== null)).toHaveLength(1);
      expect(calls).toEqual(['getdel', 'getdel']);
    } finally {
      redisUserStore.setRedisClient(null);
    }
  });
});

describe('the ID token of the Google sign-in', () => {
  const CLIENT_ID = 'test-client-id';
  const NONCE = 'nonce-of-this-sign-in';
  const SUB = 'google-subject-1';
  let originalFetch: typeof fetch;

  function idToken(claims: Record<string, unknown>): string {
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    return `${encode({ alg: 'RS256' })}.${encode(claims)}.signature`;
  }

  function stubGoogle(tokenResponse: Record<string, unknown>): void {
    globalThis.fetch = (async (url: unknown) => {
      const text = String(url);
      if (text.includes('oauth2.googleapis.com/token')) return { ok: true, json: async () => ({ access_token: 'access', ...tokenResponse }) };
      return { ok: true, json: async () => ({ sub: SUB, email: 'person@example.test', email_verified: true, name: 'Person' }) };
    }) as typeof fetch;
  }

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    vi.stubEnv('GOOGLE_CLIENT_ID', CLIENT_ID);
    vi.stubEnv('GOOGLE_CLIENT_SECRET', 'test-secret');
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.unstubAllEnvs();
  });

  const exchange = (nonce: string | undefined = NONCE) => exchangeGoogleCode('code', 'http://localhost:3000/cb', 'verifier', nonce);

  it('is accepted when it carries the nonce, the client and the subject of the profile', async () => {
    stubGoogle({ id_token: idToken({ nonce: NONCE, aud: CLIENT_ID, sub: SUB }) });

    expect((await exchange()).email).toBe('person@example.test');
  });

  it.each([
    ['another nonce', { nonce: 'another', aud: CLIENT_ID, sub: SUB }, /nonce/],
    ['no nonce', { aud: CLIENT_ID, sub: SUB }, /nonce/],
    ['another client', { nonce: NONCE, aud: 'someone-else', sub: SUB }, /another client/],
    ['another account', { nonce: NONCE, aud: CLIENT_ID, sub: 'someone-else' }, /another account/],
  ])('is refused with %s', async (_name, claims, message) => {
    stubGoogle({ id_token: idToken(claims) });

    await expect(exchange()).rejects.toThrow(message);
  });

  it('is required when the sign-in expects a nonce, and a malformed one is refused', async () => {
    stubGoogle({});
    await expect(exchange()).rejects.toThrow(/no ID token/);

    stubGoogle({ id_token: 'not-a-jwt' });
    await expect(exchange()).rejects.toThrow(/malformed/);
  });
});
