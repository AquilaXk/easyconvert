import { NextRequest, NextResponse } from 'next/server';
import { verifyPassword } from '@/lib/auth/crypto';
import { redisUserStore } from '@/lib/auth/redis-user-store';
import { createSessionToken, createSessionCookie } from '@/lib/auth/session';
import { codedRefusal, serverFault } from '@/lib/api/problem-details';
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

    const userRecord = await redisUserStore.findByEmail(email);
    const hashToVerify = userRecord?.passwordHash ?? DUMMY_HASH;
    const saltToVerify = userRecord?.salt ?? DUMMY_SALT;

    const isValid = await verifyPassword(password, hashToVerify, saltToVerify);
    if (!userRecord?.passwordHash || !userRecord?.salt || !isValid) {
      await recordFailedLogin(clientIp, email);
      return refusal(401, 'invalid_credentials', 'Invalid email address or password.');
    }

    // Reset attempt counters on successful login
    await resetLoginAttempts(clientIp, email);

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
    return serverFault('auth/login', err, 'Sign-in failed on the server.');
  }
}

