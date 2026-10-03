import { NextRequest, NextResponse } from 'next/server';
import { verifyPassword } from '@/lib/auth/crypto';
import { redisUserStore } from '@/lib/auth/redis-user-store';
import { createSessionToken, createSessionCookie } from '@/lib/auth/session';
import { extractClientIp } from '@/lib/api-keys/ip-utils';
import {
  checkLoginRateLimit,
  recordFailedLogin,
  resetLoginAttempts,
} from '@/lib/auth/login-rate-limiter';

export const dynamic = 'force-dynamic';

// Static dummy hash/salt to prevent email enumeration timing attacks
const DUMMY_HASH = '0'.repeat(128);
const DUMMY_SALT = '0'.repeat(32);

export async function POST(req: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { success: false, error: 'Invalid JSON request payload.' },
      { status: 400 }
    );
  }

  const clientIp = extractClientIp(req);

  try {
    const email = typeof body.email === 'string' ? body.email.trim() : '';
    const password = typeof body.password === 'string' ? body.password : '';

    if (!email || !password) {
      return NextResponse.json(
        { success: false, error: 'Email and password are required strings.' },
        { status: 400 }
      );
    }

    // 1. Enforce brute-force rate limit per IP and email identifier
    const rateLimit = await checkLoginRateLimit(clientIp, email);
    if (!rateLimit.allowed) {
      return NextResponse.json(
        {
          type: 'https://easyconvert.app/errors/rate-limited',
          title: 'Too Many Requests',
          status: 429,
          detail: `Too many failed login attempts. Please try again in ${rateLimit.retryAfterSeconds} seconds.`,
          retryAfterSeconds: rateLimit.retryAfterSeconds,
        },
        {
          status: 429,
          headers: {
            'Retry-After': String(rateLimit.retryAfterSeconds),
          },
        }
      );
    }

    const userRecord = await redisUserStore.findByEmail(email);
    const hashToVerify = userRecord?.passwordHash ?? DUMMY_HASH;
    const saltToVerify = userRecord?.salt ?? DUMMY_SALT;

    const isValid = await verifyPassword(password, hashToVerify, saltToVerify);
    if (!userRecord?.passwordHash || !userRecord?.salt || !isValid) {
      await recordFailedLogin(clientIp, email);
      return NextResponse.json(
        { success: false, error: 'Invalid email address or password.' },
        { status: 401 }
      );
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
    const message = err instanceof Error ? err.message : 'Login failed';
    return NextResponse.json(
      { success: false, error: message },
      { status: 500 }
    );
  }
}

