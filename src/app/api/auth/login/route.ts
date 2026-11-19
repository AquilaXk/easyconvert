import { NextRequest, NextResponse } from 'next/server';
import { hashPassword, iterationsOf, passwordNeedsUpgrade, verifyPassword } from '@/lib/auth/crypto';
import { redisUserStore } from '@/lib/auth/redis-user-store';
import { createSessionToken, createSessionCookie } from '@/lib/auth/session';
import { authStoreUnavailableRefusal, codedRefusal, serverFault } from '@/lib/api/problem-details';
import { AuthStoreUnavailableError } from '@/lib/auth/store-unavailable';
import { readJsonObject } from '@/lib/api/json-body';
import {
  authRateLimitRefusal,
  checkLoginRateLimit,
  recordFailedLogin,
  resetLoginAttempts,
  resolveAuthClientIp,
} from '@/lib/auth/login-rate-limiter';
import type { AuthErrorCode } from '@/lib/refusal-codes';

export const dynamic = 'force-dynamic';

const refusal = codedRefusal<AuthErrorCode>;

// Static dummy hash/salt to prevent email enumeration timing attacks
const DUMMY_HASH = '0'.repeat(128);
const DUMMY_SALT = '0'.repeat(32);
const MAX_PASSWORD_LENGTH = 1024;

/**
 * Replaces the hash a sign-in just checked by one with the current iterations (the `setter` of Django's `check_password`). The store
 * does it only while the stored hash is still the one that was checked, so a password changed in between stays. A sign-in does
 * not fail for it: the next one tries again.
 */
async function upgradePasswordHash(userId: string, checkedHash: string, password: string): Promise<void> {
  try {
    const { hash, salt, iterations } = await hashPassword(password);
    await redisUserStore.replacePasswordHash(userId, checkedHash, { passwordHash: hash, salt, passwordIterations: iterations });
  } catch (err: unknown) {
    console.error('[auth/login] The password hash was not upgraded; the next sign-in tries again:', err);
  }
}

export async function POST(req: NextRequest) {
  const body = await readJsonObject(req);
  if (!body) {
    return refusal(400, 'invalid_json', 'Invalid JSON request payload.');
  }

  // null = unattributed client: no shared per-IP login counter (per-email lockout still applies).
  const resolvedIp = resolveAuthClientIp(req);
  if ('refused' in resolvedIp) return resolvedIp.refused;
  const { clientIp } = resolvedIp;

  try {
    const email = typeof body.email === 'string' ? body.email.trim() : '';
    const password = typeof body.password === 'string' ? body.password : '';

    if (!email || !password) {
      return refusal(400, 'missing_fields', 'Email and password are required strings.');
    }

    // 1. Enforce brute-force rate limit per IP and email identifier
    const rateLimit = await checkLoginRateLimit(clientIp, email);
    if (!rateLimit.allowed) {
      return authRateLimitRefusal(
        rateLimit.retryAfterSeconds,
        `Too many failed login attempts. Please try again in ${rateLimit.retryAfterSeconds} seconds.`
      );
    }

    if (password.length > MAX_PASSWORD_LENGTH) {
      await verifyPassword('invalid-length', DUMMY_HASH, DUMMY_SALT);
      await recordFailedLogin(clientIp, email);
      return refusal(401, 'invalid_credentials', 'Invalid email address or password.');
    }

    const userRecord = await redisUserStore.findByEmail(email);
    // `||`: an emptied hash or salt (a Google sign-in took the account over) must cost the key derivation too, or its answer is faster.
    const hashToVerify = userRecord?.passwordHash || DUMMY_HASH;
    const saltToVerify = userRecord?.salt || DUMMY_SALT;

    // A hash with no iterations noted is one of an earlier release; an unknown address and the dummy hash cost the current ones.
    const isValid = await verifyPassword(password, hashToVerify, saltToVerify, userRecord?.passwordHash ? iterationsOf(userRecord) : undefined);
    if (!userRecord?.passwordHash || !userRecord?.salt || !isValid) {
      await recordFailedLogin(clientIp, email);
      return refusal(401, 'invalid_credentials', 'Invalid email address or password.');
    }

    if (typeof userRecord.suspendedAt === 'number') {
      return codedRefusal(403, undefined, 'Forbidden: account is suspended.');
    }

    // Reset attempt counters on successful login
    await resetLoginAttempts(email);
    if (passwordNeedsUpgrade(iterationsOf(userRecord))) await upgradePasswordHash(userRecord.id, userRecord.passwordHash, password);

    const user = redisUserStore.sanitizeUser(userRecord);
    const token = createSessionToken(user);
    const cookieHeader = createSessionCookie(token);

    const response = NextResponse.json({
      success: true,
      user,
      token,
    });

    response.headers.set('Set-Cookie', cookieHeader);
    return response;
  } catch (err: unknown) {
    if (err instanceof AuthStoreUnavailableError) return authStoreUnavailableRefusal(err);
    return serverFault('auth/login', err, 'Sign-in failed on the server.');
  }
}

