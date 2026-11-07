import { NextRequest, NextResponse } from 'next/server';
import { queueAccountMail } from '@/lib/auth/account-mail';
import { hashPassword } from '@/lib/auth/crypto';
import { isPlainMailbox } from '@/lib/auth/mailbox';
import { isAuthMailEnabled, mailLocale } from '@/lib/auth/mail-config';
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

export async function POST(req: NextRequest) {
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

    const displayName = name || email.split('@')[0];

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
      acceptedTermsVersion: TERMS_VERSION,
    });

    // The mail that confirms the address is sent in the background; a failure of it never fails the sign-up.
    if (isAuthMailEnabled()) {
      await queueAccountMail('verify', userRecord, mailLocale(body.locale)).catch(() => {
        console.warn('auth_mail_failure category=store');
      });
    }

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
