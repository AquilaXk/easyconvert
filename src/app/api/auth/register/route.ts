import { NextRequest, NextResponse } from 'next/server';
import { hashPassword } from '@/lib/auth/crypto';
import { isEmailCodeShape, verifyEmailCode } from '@/lib/auth/email-code-store';
import { isPlainMailbox } from '@/lib/auth/mailbox';
import { isAuthMailEnabled } from '@/lib/auth/mail-config';
import { redisUserStore } from '@/lib/auth/redis-user-store';
import { createSessionToken, createSessionCookie } from '@/lib/auth/session';
import { codedRefusal, serverFault } from '@/lib/api/problem-details';
import { readJsonObject } from '@/lib/api/json-body';
import {
  authRateLimitRefusal,
  consumeRegistrationRateLimit,
  resolveAuthClientIp,
} from '@/lib/auth/login-rate-limiter';
import type { AuthErrorCode } from '@/lib/refusal-codes';
import { TERMS_VERSION, termsRefusal, termsRefusalText } from '@/lib/legal/documents';

export const dynamic = 'force-dynamic';

const refusal = codedRefusal<AuthErrorCode>;

/**
 * The second step of a password sign-up: makes the account from the six-digit code that `POST /api/auth/register/code` mailed to
 * the address, a password, a name and the acceptance of the terms. The code proves the address, so the account is created
 * verified; an account whose address nobody confirmed is never created. The checks of the form come before the code is
 * tried, so a short password does not use up one of its few guesses.
 */
export async function POST(req: NextRequest) {
  if (!isAuthMailEnabled()) return refusal(404, 'mail_unavailable', 'Sign-up by email is not available on this server.');

  const body = await readJsonObject(req);
  if (!body) {
    return refusal(400, 'invalid_json', 'Invalid JSON request payload.');
  }

  const resolvedIp = resolveAuthClientIp(req);
  if ('refused' in resolvedIp) return resolvedIp.refused;
  const { clientIp } = resolvedIp;

  try {
    const email = typeof body.email === 'string' ? body.email.trim() : '';
    const password = typeof body.password === 'string' ? body.password : '';
    const name = typeof body.name === 'string' ? body.name.trim() : '';

    if (!isPlainMailbox(email)) {
      return refusal(400, 'invalid_email', 'A valid email address is required.');
    }

    if (!isEmailCodeShape(body.code)) {
      return refusal(400, 'invalid_code', 'The code is not valid or has expired.');
    }

    if (!password || password.length < 8 || password.length > 1024) {
      return refusal(400, 'password_length', 'Password must be between 8 and 1024 characters in length.');
    }

    const termsRefused = termsRefusal(body.acceptedTermsVersion);
    if (termsRefused) return refusal(400, termsRefused, termsRefusalText(termsRefused));

    const rateLimit = await consumeRegistrationRateLimit(clientIp);
    if (!rateLimit.allowed) {
      return authRateLimitRefusal(
        rateLimit.retryAfterSeconds,
        `Too many registration attempts. Please try again in ${rateLimit.retryAfterSeconds} seconds.`
      );
    }

    // A wrong, expired, used or burned code, and an address that was never sent one, answer alike.
    if (!(await verifyEmailCode('signup', email, body.code))) {
      return refusal(400, 'invalid_code', 'The code is not valid or has expired.');
    }

    const displayName = name || email.split('@')[0];

    // Past the code the address is proven to be the caller's, so saying that it has an account tells nothing to a stranger.
    const existingUser = await redisUserStore.findByEmail(email);
    if (existingUser) {
      return refusal(409, 'account_exists', 'An account with this email address already exists.');
    }

    const { hash, salt } = await hashPassword(password);
    const userRecord = await redisUserStore.createUser({
      email,
      name: displayName,
      tier: 'free',
      provider: 'email',
      passwordHash: hash,
      salt,
      emailVerified: true,
      acceptedTermsVersion: TERMS_VERSION,
    });

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
    return serverFault('auth/register', err, 'Registration failed on the server.');
  }
}
