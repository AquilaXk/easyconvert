import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { signJwt, verifyJwt, DEFAULT_JWT_ISSUER, DEFAULT_JWT_AUDIENCE } from '../src/lib/auth/jwt';
import {
  createSessionToken,
  getSessionFromRequest,
  revokeSession,
  isSessionRevoked,
  revokeAllUserSessions,
  createSessionCookie,
  SESSION_COOKIE_NAME,
} from '../src/lib/auth/session';
import { redisUserStore } from '../src/lib/auth/redis-user-store';
import {
  createPkcePair,
  createOAuthSession,
  consumeOAuthSession,
  getGoogleOAuthUrl,
  exchangeGoogleCode,
  getAppOrigin,
  OAUTH_STATE_COOKIE_NAME,
} from '../src/lib/auth/oauth';
import {
  checkLoginRateLimit,
  recordFailedLogin,
  resetLoginAttempts,
  resetLoginRateLimiterStore,
  LOGIN_MAX_FAILED_ATTEMPTS_PER_EMAIL,
  LOGIN_MAX_FAILED_ATTEMPTS_PER_IP,
} from '../src/lib/auth/login-rate-limiter';
import { GET as googleUrlHandler } from '../src/app/api/auth/google/url/route';
import { GET as googleCallbackHandler } from '../src/app/api/auth/google/callback/route';
import { POST as loginHandler } from '../src/app/api/auth/login/route';
import { POST as logoutHandler } from '../src/app/api/auth/logout/route';
import { hashPassword } from '../src/lib/auth/crypto';
import type { SessionPayload } from '../src/lib/auth/types';

describe('Phase 1-B: Session, OAuth PKCE, CSRF & Login Protection', () => {
  beforeEach(() => {
    redisUserStore.resetStore();
    resetLoginRateLimiterStore();
  });

  afterEach(() => {
    delete process.env.APP_ORIGIN;
    delete process.env.NEXT_PUBLIC_APP_URL;
    delete process.env.JWT_SECRET;
  });

  describe('JWT & Fail-Closed Secret Security', () => {
    it('fails closed when JWT_SECRET is missing in production environment', () => {
      const originalEnv = process.env.NODE_ENV;
      const originalSecret = process.env.JWT_SECRET;
      try {
        process.env.NODE_ENV = 'production';
        delete process.env.JWT_SECRET;

        expect(() => {
          signJwt({ sub: 'user-fail-closed' });
        }).toThrow(/JWT_SECRET environment variable is required in production/i);
      } finally {
        process.env.NODE_ENV = originalEnv;
        if (originalSecret) {
          process.env.JWT_SECRET = originalSecret;
        }
      }
    });

    it('attaches standard iss, aud, and cryptographically random jti to signed JWTs', () => {
      const payload = { sub: 'usr_enterprise_01', email: 'alice@example.com', tier: 'enterprise' as const };
      const token = signJwt(payload, 'test-signing-secret', 3600);

      const verified = verifyJwt<SessionPayload>(token, 'test-signing-secret');
      expect(verified).not.toBeNull();
      expect(verified?.iss).toBe(DEFAULT_JWT_ISSUER);
      expect(verified?.aud).toBe(DEFAULT_JWT_AUDIENCE);
      expect(typeof verified?.jti).toBe('string');
      expect(verified?.jti?.length).toBeGreaterThan(20);
      expect(verified?.sub).toBe('usr_enterprise_01');
    });

    it('verifies issuer and audience claims correctly when required', () => {
      const token = signJwt({ sub: 'usr_02' }, { secret: 'secret-key', issuer: 'custom-iss', audience: 'custom-aud' });

      // Valid matching claims
      const match = verifyJwt(token, { secret: 'secret-key', issuer: 'custom-iss', audience: 'custom-aud' });
      expect(match).not.toBeNull();

      // Mismatched issuer rejected
      const badIss = verifyJwt(token, { secret: 'secret-key', issuer: 'wrong-iss' });
      expect(badIss).toBeNull();

      // Mismatched audience rejected
      const badAud = verifyJwt(token, { secret: 'secret-key', audience: 'wrong-aud' });
      expect(badAud).toBeNull();
    });
  });

  describe('Session Revocation & Version Invalidation', () => {
    it('revokes session by JTI immediately in memory and Redis', async () => {
      const user = await redisUserStore.createUser({
        email: 'revocation.test@example.com',
        name: 'Revoke User',
        tier: 'pro',
      });

      const token = createSessionToken(user);
      const req = new NextRequest('http://localhost:3000/api/dashboard', {
        headers: {
          cookie: createSessionCookie(token),
        },
      });

      // Initially valid
      const initialUser = await getSessionFromRequest(req);
      expect(initialUser).not.toBeNull();
      expect(initialUser?.id).toBe(user.id);

      // Extract JTI and revoke
      const payload = verifyJwt<SessionPayload>(token);
      expect(payload?.jti).toBeDefined();
      const jti = payload!.jti!;

      expect(await isSessionRevoked(jti)).toBe(false);
      await revokeSession(jti, 3600);
      expect(await isSessionRevoked(jti)).toBe(true);

      // Session extraction now fails closed
      const postRevokeUser = await getSessionFromRequest(req);
      expect(postRevokeUser).toBeNull();
    });

    it('invalidates all previous user sessions when sessionVersion is incremented', async () => {
      const user = await redisUserStore.createUser({
        email: 'global.revoke@example.com',
        name: 'Global Revoke User',
        tier: 'free',
      });

      const token1 = createSessionToken(user);
      const req1 = new NextRequest('http://localhost:3000/api/dashboard', {
        headers: { cookie: createSessionCookie(token1) },
      });
      expect(await getSessionFromRequest(req1)).not.toBeNull();

      // Invalidate all active sessions for this user
      const nextVersion = await revokeAllUserSessions(user.id);
      expect(nextVersion).toBe(2);

      // Previous session token is now rejected
      expect(await getSessionFromRequest(req1)).toBeNull();

      // Newly minted session with the updated sessionVersion succeeds
      const updatedUserRecord = await redisUserStore.findById(user.id);
      expect(updatedUserRecord?.sessionVersion).toBe(2);
      const token2 = createSessionToken(redisUserStore.sanitizeUser(updatedUserRecord!));
      const req2 = new NextRequest('http://localhost:3000/api/dashboard', {
        headers: { cookie: createSessionCookie(token2) },
      });
      const resolvedUser2 = await getSessionFromRequest(req2);
      expect(resolvedUser2).not.toBeNull();
      expect(resolvedUser2?.id).toBe(user.id);
    });

    it('POST /api/auth/logout revokes the active session token JTI', async () => {
      const user = await redisUserStore.createUser({
        email: 'logout.user@example.com',
        name: 'Logout User',
        tier: 'free',
      });

      const token = createSessionToken(user);
      const payload = verifyJwt<SessionPayload>(token);
      expect(payload?.jti).toBeDefined();

      const logoutReq = new NextRequest('http://localhost:3000/api/auth/logout', {
        method: 'POST',
        headers: {
          cookie: createSessionCookie(token),
        },
      });

      const logoutRes = await logoutHandler(logoutReq);
      expect(logoutRes.status).toBe(200);

      // JTI must be revoked in the store
      const isRevoked = await isSessionRevoked(payload!.jti!);
      expect(isRevoked).toBe(true);

      // Replaying token fails
      const checkReq = new NextRequest('http://localhost:3000/api/dashboard', {
        headers: { cookie: createSessionCookie(token) },
      });
      expect(await getSessionFromRequest(checkReq)).toBeNull();
    });
  });

  describe('OAuth 2.0 PKCE & State Cookie CSRF Protection', () => {
    it('generates cryptographically secure RFC 7636 PKCE code_verifier and code_challenge', () => {
      const { codeVerifier, codeChallenge } = createPkcePair();
      expect(codeVerifier.length).toBeGreaterThanOrEqual(43);
      expect(codeVerifier.length).toBeLessThanOrEqual(128);
      expect(codeChallenge).toBeDefined();
      expect(codeChallenge.length).toBeGreaterThanOrEqual(43);
      expect(codeVerifier).not.toBe(codeChallenge);
    });

    it('persists and consumes OAuth session state atomically', async () => {
      const session = await createOAuthSession();
      expect(session.state).toBeDefined();
      expect(session.nonce).toBeDefined();
      expect(session.codeVerifier).toBeDefined();
      expect(session.codeChallenge).toBeDefined();

      // First consumption succeeds
      const consumed = await consumeOAuthSession(session.state);
      expect(consumed).not.toBeNull();
      expect(consumed?.state).toBe(session.state);
      expect(consumed?.codeVerifier).toBe(session.codeVerifier);

      // Second consumption returns null (one-time use)
      const secondConsumed = await consumeOAuthSession(session.state);
      expect(secondConsumed).toBeNull();
    });

    it('GET /api/auth/google/url issues OAuth URL and binds state in HttpOnly cookie', async () => {
      process.env.GOOGLE_CLIENT_ID = 'test-google-client-id-123';
      try {
        const req = new NextRequest('http://localhost:3000/api/auth/google/url');
        const res = await googleUrlHandler(req);
        expect(res.status).toBe(200);

        const json = await res.json();
        expect(json.success).toBe(true);
        expect(json.url).toContain('accounts.google.com');
        expect(json.url).toContain('code_challenge=');
        expect(json.url).toContain('code_challenge_method=S256');

        const setCookie = res.headers.get('set-cookie');
        expect(setCookie).not.toBeNull();
        expect(setCookie).toContain(OAUTH_STATE_COOKIE_NAME);
        expect(setCookie).toContain('HttpOnly');
        expect(setCookie).toContain('SameSite=Lax');
      } finally {
        delete process.env.GOOGLE_CLIENT_ID;
      }
    });

    it('GET /api/auth/google/callback rejects mismatched cookie state (Login CSRF defense)', async () => {
      const session = await createOAuthSession();
      const attackerState = 'attacker_forged_state_token_1234';

      const req = new NextRequest(
        `http://localhost:3000/api/auth/google/callback?code=mock_code_${session.state}&state=${session.state}`,
        {
          headers: {
            // Victim browser has a cookie from an attacker-initiated flow
            cookie: `${OAUTH_STATE_COOKIE_NAME}=${attackerState}`,
          },
        }
      );

      const res = await googleCallbackHandler(req);
      expect(res.status).toBe(307);
      const location = res.headers.get('location') || '';
      expect(location).toContain('error=invalid_oauth_state');
    });

    it('resolves canonical APP_ORIGIN and prevents Host header injection', () => {
      process.env.APP_ORIGIN = 'https://easyconvert.com';
      const maliciousReq = new NextRequest('http://attacker.example.com/api/auth/google/url', {
        headers: {
          host: 'attacker.example.com',
          'x-forwarded-host': 'malicious-proxy.net',
        },
      });

      const origin = getAppOrigin(maliciousReq);
      expect(origin).toBe('https://easyconvert.com');
    });
  });

  describe('OAuth Account Linking & Hijacking Safeguards', () => {
    it('rejects unverified Google accounts fail-closed', async () => {
      // Mock fetch to simulate Google userinfo returning email_verified: false
      const originalFetch = globalThis.fetch;
      try {
        globalThis.fetch = (async (url: string | URL | Request) => {
          const urlStr = url.toString();
          if (urlStr.includes('oauth2/v3/userinfo')) {
            return {
              ok: true,
              json: async () => ({
                sub: 'unverified_google_user',
                email: 'hacker@unverified.org',
                email_verified: false,
                name: 'Unverified User',
              }),
            } as any;
          }
          if (urlStr.includes('oauth2.googleapis.com/token')) {
            return {
              ok: true,
              json: async () => ({
                access_token: 'mock_access_token_123',
              }),
            } as any;
          }
          return originalFetch(url);
        }) as any;

        process.env.GOOGLE_CLIENT_ID = 'mock-id';
        process.env.GOOGLE_CLIENT_SECRET = 'mock-secret';

        await expect(
          exchangeGoogleCode('real_auth_code_xyz', 'http://localhost:3000/api/auth/google/callback')
        ).rejects.toThrow(/email is not verified/i);
      } finally {
        globalThis.fetch = originalFetch;
        delete process.env.GOOGLE_CLIENT_ID;
        delete process.env.GOOGLE_CLIENT_SECRET;
      }
    });


    it('requires explicit authenticated session to link Google to an existing email/password account', async () => {
      // 1. Create existing user with email/password
      const passwordData = await hashPassword('ExistingPassword123!');
      const existingUser = await redisUserStore.createUser({
        email: 'dev.sandbox@example.com',
        name: 'Existing User',
        provider: 'email',
        passwordHash: passwordData.hash,
        salt: passwordData.salt,
      });
      expect(existingUser.provider).toBe('email');

      // 2. An unauthenticated OAuth callback attempts to sign into this email
      const session = await createOAuthSession();
      const unauthReq = new NextRequest(
        `http://localhost:3000/api/auth/google/callback?code=mock_code_${session.state}&state=${session.state}`,
        {
          headers: {
            cookie: `${OAUTH_STATE_COOKIE_NAME}=${session.state}`,
          },
        }
      );

      const unauthRes = await googleCallbackHandler(unauthReq);
      expect(unauthRes.status).toBe(307);
      const location = unauthRes.headers.get('location') || '';
      // Pre-account takeover blocked
      expect(location).toContain('error=account_linking_required');

      // 3. An authenticated user linking their Google account succeeds
      const session2 = await createOAuthSession();
      const token = createSessionToken(redisUserStore.sanitizeUser(existingUser));
      const authReq = new NextRequest(
        `http://localhost:3000/api/auth/google/callback?code=mock_code_${session2.state}&state=${session2.state}`,
        {
          headers: {
            cookie: `${OAUTH_STATE_COOKIE_NAME}=${session2.state}; ${createSessionCookie(token)}`,
          },
        }
      );

      const authRes = await googleCallbackHandler(authReq);
      expect(authRes.status).toBe(307);
      expect(authRes.headers.get('location')).toContain('/dashboard');

      const updatedUser = await redisUserStore.findById(existingUser.id);
      expect(updatedUser?.provider).toBe('google');
    });
  });

  describe('Login Brute-Force Rate Limiting', () => {
    it('blocks rapid successive failed login attempts with HTTP 429 and Retry-After', async () => {
      const email = 'victim@example.com';
      const ip = '198.51.100.42';

      // Submit failed login attempts up to the threshold
      for (let i = 0; i < LOGIN_MAX_FAILED_ATTEMPTS_PER_EMAIL; i++) {
        const check = await checkLoginRateLimit(ip, email);
        expect(check.allowed).toBe(true);

        const req = new NextRequest('http://localhost:3000/api/auth/login', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-forwarded-for': ip,
          },
          body: JSON.stringify({ email, password: 'WrongPassword!' }),
        });

        const res = await loginHandler(req);
        expect(res.status).toBe(401);
      }

      // Next attempt exceeds rate limit threshold -> HTTP 429
      const lockedReq = new NextRequest('http://localhost:3000/api/auth/login', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-forwarded-for': ip,
        },
        body: JSON.stringify({ email, password: 'WrongPassword!' }),
      });

      const lockedRes = await loginHandler(lockedReq);
      expect(lockedRes.status).toBe(429);
      expect(lockedRes.headers.get('Retry-After')).toBeDefined();

      const errorPayload = await lockedRes.json();
      expect(errorPayload.status).toBe(429);
      expect(errorPayload.detail).toContain('Too many failed login attempts');
      expect(errorPayload.retryAfterSeconds).toBeGreaterThan(0);
    });

    it('resets failed attempt counters on successful login', async () => {
      const passwordData = await hashPassword('CorrectPassword123!');
      const user = await redisUserStore.createUser({
        email: 'reset.attempts@example.com',
        name: 'Reset Attempt User',
        passwordHash: passwordData.hash,
        salt: passwordData.salt,
      });

      const ip = '203.0.113.88';

      // 2 failed attempts
      for (let i = 0; i < 2; i++) {
        await recordFailedLogin(ip, user.email);
      }

      // Successful login
      const successReq = new NextRequest('http://localhost:3000/api/auth/login', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-forwarded-for': ip,
        },
        body: JSON.stringify({ email: user.email, password: 'CorrectPassword123!' }),
      });

      const successRes = await loginHandler(successReq);
      expect(successRes.status).toBe(200);

      // Attempts must be reset
      const check = await checkLoginRateLimit(ip, user.email);
      expect(check.allowed).toBe(true);
      expect(check.retryAfterSeconds).toBe(0);
    });
  });
});
