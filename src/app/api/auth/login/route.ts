import { NextRequest, NextResponse } from 'next/server';
import { isEmailVerified, isPasswordAccount, queueEmailCode } from '@/lib/auth/account-mail';
import { verifyPassword } from '@/lib/auth/crypto';
import { isEmailCodeShape, verifyEmailCode } from '@/lib/auth/email-code-store';
import { refuseCodeMail } from '@/lib/auth/email-code-guard';
import { isAuthMailEnabled, mailLocale } from '@/lib/auth/mail-config';
import type { UserRecord } from '@/lib/auth/types';
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

/**
 * An email account made before sign-up asked for a code may have an address nobody confirmed. Its password is right, but the
 * session waits for a six-digit code mailed to the address: without a `code` one is sent and the answer is 403
 * `email_verification_required`; with one it is checked, and a right one confirms the address for good. A server that cannot mail
 * issues the session as before, and such an account counts as anonymous for conversions until its address is confirmed.
 * Returns the refusal to send, or the account to issue the session for (its address confirmed by now).
 */
async function confirmAddressFirst(record: UserRecord, code: unknown, clientIp: string | null, locale: unknown): Promise<NextResponse | UserRecord> {
  if (!isPasswordAccount(record) || isEmailVerified(record) || !isAuthMailEnabled()) return record;
  if (code === undefined || code === null || code === '') {
    const refused = await refuseCodeMail(clientIp, record.email);
    if (refused) return refused;
    await queueEmailCode('login', record.email, mailLocale(locale));
    return refusal(403, 'email_verification_required', 'Confirm your email address with the code that was sent to it.');
  }
  if (!isEmailCodeShape(code) || !(await verifyEmailCode('login', record.email, code))) {
    return refusal(400, 'invalid_code', 'The code is not valid or has expired.');
  }
  return (await redisUserStore.updateUser(record.id, { emailVerified: true })) ?? record;
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

    const userRecord = await redisUserStore.findByEmail(email);
    const hashToVerify = userRecord?.passwordHash ?? DUMMY_HASH;
    const saltToVerify = userRecord?.salt ?? DUMMY_SALT;

    const isValid = await verifyPassword(password, hashToVerify, saltToVerify);
    if (!userRecord?.passwordHash || !userRecord?.salt || !isValid) {
      await recordFailedLogin(clientIp, email);
      return refusal(401, 'invalid_credentials', 'Invalid email address or password.');
    }

    const confirmed = await confirmAddressFirst(userRecord, body.code, clientIp, body.locale);
    if (confirmed instanceof NextResponse) return confirmed;

    // Reset attempt counters on successful login
    await resetLoginAttempts(clientIp, email);

    const user = redisUserStore.sanitizeUser(confirmed);
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

