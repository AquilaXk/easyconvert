import { NextRequest, NextResponse } from 'next/server';
import { verifyPassword } from '@/lib/auth/crypto';
import { redisUserStore } from '@/lib/auth/redis-user-store';
import { createSessionToken, createSessionCookie } from '@/lib/auth/session';
import { extractClientIp } from '@/lib/api-keys/ip-utils';
import { RATE_LIMITED_PROBLEM_TYPE, codedRefusal, serverFault } from '@/lib/api/problem-details';
import {
  CLIENT_IP_CONFIG_RETRY_AFTER_SECONDS,
  ClientIpError,
  UNATTRIBUTED_CLIENT_KEY,
  rateLimitKey,
} from '@/lib/security/client-ip';
import {
  checkLoginRateLimit,
  recordFailedLogin,
  resetLoginAttempts,
} from '@/lib/auth/login-rate-limiter';
import type { AuthErrorCode } from '@/lib/refusal-codes';

export const dynamic = 'force-dynamic';

const refusal = codedRefusal<AuthErrorCode>;

const HTTP_SERVICE_UNAVAILABLE = 503;
const CLIENT_IP_MALFORMED_MESSAGE = 'Client address could not be determined from the request headers.';
const CLIENT_IP_CONFIG_MESSAGE = "Server misconfiguration: the server's client-IP trust configuration is missing or invalid.";

// Static dummy hash/salt to prevent email enumeration timing attacks
const DUMMY_HASH = '0'.repeat(128);
const DUMMY_SALT = '0'.repeat(32);

export async function POST(req: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return refusal(400, 'invalid_json', 'Invalid JSON request payload.');
  }

  // null = unattributed client: no shared per-IP login counter (per-email lockout still applies).
  let clientIp: string | null;
  try {
    const resolvedIp = extractClientIp(req);
    clientIp = resolvedIp === UNATTRIBUTED_CLIENT_KEY ? null : rateLimitKey(resolvedIp);
  } catch (error) {
    if (!(error instanceof ClientIpError)) throw error;
    if (error.status === HTTP_SERVICE_UNAVAILABLE) {
      return refusal(error.status, 'client_ip_unconfigured', CLIENT_IP_CONFIG_MESSAGE, {}, {
        'Retry-After': String(CLIENT_IP_CONFIG_RETRY_AFTER_SECONDS),
      });
    }
    return refusal(error.status, 'client_address_unknown', CLIENT_IP_MALFORMED_MESSAGE);
  }

  try {
    const email = typeof body.email === 'string' ? body.email.trim() : '';
    const password = typeof body.password === 'string' ? body.password : '';

    if (!email || !password) {
      return refusal(400, 'missing_fields', 'Email and password are required strings.');
    }

    // 1. Enforce brute-force rate limit per IP and email identifier
    const rateLimit = await checkLoginRateLimit(clientIp, email);
    if (!rateLimit.allowed) {
      return NextResponse.json(
        {
          type: RATE_LIMITED_PROBLEM_TYPE,
          title: 'Too Many Requests',
          status: 429,
          code: 'login_locked',
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

