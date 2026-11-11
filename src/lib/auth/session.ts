import { DEFAULT_JWT_AUDIENCE, DEFAULT_JWT_ISSUER, signJwt, verifyJwt } from './jwt';
import { redisUserStore } from './redis-user-store';
import type { SessionPayload, User } from './types';

export const SESSION_COOKIE_NAME = 'easyconvert_session';
const SESSION_MAX_AGE_SECONDS = 7 * 24 * 60 * 60; // 7 days

/**
 * Creates an RFC 7519 JWT session token for an authenticated user.
 */
export function createSessionToken(
  user: User,
  options?: { jti?: string; expiresInSeconds?: number }
): string {
  const payload: Omit<SessionPayload, 'iat' | 'exp'> = {
    sub: user.id,
    email: user.email,
    name: user.name,
    tier: user.tier,
    sessionVersion: user.sessionVersion ?? 1,
  };
  return signJwt(payload, {
    jti: options?.jti,
    expiresInSeconds: options?.expiresInSeconds ?? SESSION_MAX_AGE_SECONDS,
    sessionVersion: user.sessionVersion ?? 1,
  });
}

/**
 * Revokes a specific session by its JTI (JWT ID).
 */
export async function revokeSession(jti: string, remainingSeconds?: number): Promise<void> {
  const ttl = remainingSeconds ?? SESSION_MAX_AGE_SECONDS;
  await redisUserStore.revokeJti(jti, ttl);
}

/**
 * Checks whether a session JTI is revoked.
 */
export async function isSessionRevoked(jti: string): Promise<boolean> {
  return redisUserStore.isJtiRevoked(jti);
}

/**
 * Revokes all active sessions for a user by incrementing their sessionVersion.
 */
export async function revokeAllUserSessions(userId: string): Promise<number> {
  return redisUserStore.incrementSessionVersion(userId);
}

/**
 * Formats a Set-Cookie header string for the session token.
 */
export function createSessionCookie(token: string): string {
  const isProd = process.env.NODE_ENV === 'production';
  const cookieParts = [
    `${SESSION_COOKIE_NAME}=${token}`,
    'Path=/',
    `Max-Age=${SESSION_MAX_AGE_SECONDS}`,
    'HttpOnly',
    'SameSite=Lax',
  ];

  if (isProd) {
    cookieParts.push('Secure');
  }

  return cookieParts.join('; ');
}

/**
 * Formats a Set-Cookie header string to invalidate/clear the session cookie.
 */
export function clearSessionCookie(): string {
  const isProd = process.env.NODE_ENV === 'production';
  const cookieParts = [
    `${SESSION_COOKIE_NAME}=`,
    'Path=/',
    'Max-Age=0',
    'HttpOnly',
    'SameSite=Lax',
  ];

  if (isProd) {
    cookieParts.push('Secure');
  }

  return cookieParts.join('; ');
}

/**
 * Extracts and verifies the authenticated user from an incoming Request.
 * Supports HttpOnly session cookie and Authorization: Bearer <jwt> header.
 */
export async function getSessionFromRequest(request: Request): Promise<User | null> {
  if (!request?.headers || typeof request.headers.get !== 'function') {
    return null;
  }
  let token: string | null = null;

  // 1. Check Cookie header
  const cookieHeader = request.headers.get('cookie');
  if (cookieHeader) {
    const cookies = cookieHeader.split(';').map((c) => c.trim());
    for (const c of cookies) {
      if (c.startsWith(`${SESSION_COOKIE_NAME}=`)) {
        token = c.substring(SESSION_COOKIE_NAME.length + 1);
        break;
      }
    }
  }

  // 2. Check Authorization header
  if (!token) {
    const authHeader = request.headers.get('authorization');
    if (authHeader?.startsWith('Bearer ')) {
      token = authHeader.substring(7).trim();
    }
  }

  if (!token) {
    return null;
  }

  return getSessionFromToken(token);
}

/**
 * The signed-in user a session token stands for, or null when the token is invalid, expired, revoked, older than the
 * account's session version (or carries none), or the account is gone. A request's cookie and a server-rendered page's cookie
 * both end here.
 *
 * @throws AuthStoreUnavailableError when the session store cannot answer: a session is never accepted without its check.
 */
export async function getSessionFromToken(token: string): Promise<User | null> {
  const payload = verifyJwt<SessionPayload>(token, {
    issuer: DEFAULT_JWT_ISSUER,
    audience: DEFAULT_JWT_AUDIENCE,
  });
  if (!payload?.sub) {
    return null;
  }

  // Check if JTI is revoked
  if (payload.jti && (await isSessionRevoked(payload.jti))) {
    return null;
  }

  const userRecord = await redisUserStore.findById(payload.sub);
  if (!userRecord) {
    return null;
  }

  // A token older than the account's session version is a revoked session. A token without the claim is older than any
  // version (every token this server issues carries it), so it is refused instead of skipping the check.
  const currentVersion = userRecord.sessionVersion ?? 1;
  if ((payload.sessionVersion ?? 0) < currentVersion) {
    return null;
  }

  return redisUserStore.sanitizeUser(userRecord);
}

