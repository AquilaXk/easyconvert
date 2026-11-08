import { NextRequest, NextResponse } from 'next/server';
import { codedRefusal, serverFault } from '@/lib/api/problem-details';
import { readJsonObject } from '@/lib/api/json-body';
import { isPasswordAccount } from '@/lib/auth/account-mail';
import { consumeAuthToken, isAuthTokenShape } from '@/lib/auth/auth-email-token-store';
import { hashPassword } from '@/lib/auth/crypto';
import {
  authRateLimitRefusal,
  consumeMailLinkRateLimit,
  resetLoginAttempts,
  resolveAuthClientIp,
} from '@/lib/auth/login-rate-limiter';
import { isAuthMailEnabled } from '@/lib/auth/mail-config';
import { redisUserStore } from '@/lib/auth/redis-user-store';
import { clearSessionCookie, revokeAllUserSessions } from '@/lib/auth/session';
import type { AuthErrorCode } from '@/lib/refusal-codes';

export const dynamic = 'force-dynamic';

const refusal = codedRefusal<AuthErrorCode>;

/**
 * Sets a new password with the token of a reset mail. The password follows the rules of registration. The token is used
 * up by the request that presents it, so it works once; a password that breaks the rules is refused before the token is
 * touched, so a typo does not cost the link. Every session of the account ends, this one included.
 */
export async function POST(req: NextRequest) {
  if (!isAuthMailEnabled()) return refusal(404, 'mail_unavailable', 'Password reset is not available.');

  const body = await readJsonObject(req);
  if (!body) return refusal(400, 'invalid_json', 'Invalid JSON request payload.');

  const resolvedIp = resolveAuthClientIp(req);
  if ('refused' in resolvedIp) return resolvedIp.refused;
  const { clientIp } = resolvedIp;

  const password = typeof body.password === 'string' ? body.password : '';
  if (password.length < 8 || password.length > 1024) {
    return refusal(400, 'password_length', 'Password must be between 8 and 1024 characters in length.');
  }

  const limit = await consumeMailLinkRateLimit('reset-confirm', clientIp, null);
  if (!limit.allowed) {
    return authRateLimitRefusal(
      limit.retryAfterSeconds,
      `Too many attempts. Please try again in ${limit.retryAfterSeconds} seconds.`,
      'mail_rate_limited'
    );
  }

  try {
    const subject = isAuthTokenShape(body.token) ? await consumeAuthToken('reset', body.token) : null;
    const record = subject ? await redisUserStore.findById(subject.userId) : null;
    if (!subject || !record || record.email !== subject.email || !isPasswordAccount(record)) {
      return refusal(400, 'invalid_token', 'This link is not valid or has expired.');
    }

    const { hash, salt } = await hashPassword(password);
    if (!(await redisUserStore.updateUser(record.id, { passwordHash: hash, salt }))) {
      return refusal(400, 'invalid_token', 'This link is not valid or has expired.');
    }
    await revokeAllUserSessions(record.id);
    await resetLoginAttempts(clientIp, record.email);

    const response = NextResponse.json({ success: true });
    response.headers.set('Set-Cookie', clearSessionCookie());
    return response;
  } catch (err: unknown) {
    return serverFault('auth/password-reset', err, 'Password reset failed on the server.');
  }
}
