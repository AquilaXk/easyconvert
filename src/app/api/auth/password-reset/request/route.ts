import { NextRequest, NextResponse } from 'next/server';
import { codedRefusal } from '@/lib/api/problem-details';
import { readJsonObject } from '@/lib/api/json-body';
import { isPlainMailbox } from '@/lib/auth/mailbox';
import { isEmailVerified, isPasswordAccount, queueAccountMail } from '@/lib/auth/account-mail';
import { authRateLimitRefusal, consumeMailLinkRateLimit, resolveAuthClientIp } from '@/lib/auth/login-rate-limiter';
import { isAuthMailEnabled, mailLocale } from '@/lib/auth/mail-config';
import { holdUntil } from '@/lib/auth/opaque-response';
import { redisUserStore } from '@/lib/auth/redis-user-store';
import type { AuthErrorCode } from '@/lib/refusal-codes';

export const dynamic = 'force-dynamic';

const refusal = codedRefusal<AuthErrorCode>;

/**
 * Asks for a password reset mail. The answer is the same 202 and leaves after the same time whether or not the address has
 * an account, whether the account signs in with Google, and whether its address is verified: only an account that signs in
 * with a password and whose address is verified is mailed a link. A mail that cannot be sent is logged by its category
 * (src/lib/auth/auth-mail.ts) and changes nothing in the answer.
 */
export async function POST(req: NextRequest) {
  if (!isAuthMailEnabled()) return refusal(404, 'mail_unavailable', 'Password reset is not available.');
  const startedAt = performance.now();

  const body = await readJsonObject(req);
  if (!body) return refusal(400, 'invalid_json', 'Invalid JSON request payload.');
  const email = typeof body.email === 'string' ? body.email.trim() : '';
  if (!isPlainMailbox(email)) {
    return refusal(400, 'invalid_email', 'A valid email address is required.');
  }

  const resolvedIp = resolveAuthClientIp(req);
  if ('refused' in resolvedIp) return resolvedIp.refused;

  const limit = await consumeMailLinkRateLimit('reset-request', resolvedIp.clientIp, email);
  if (!limit.allowed) {
    return authRateLimitRefusal(
      limit.retryAfterSeconds,
      `Too many password reset requests. Please try again in ${limit.retryAfterSeconds} seconds.`,
      'mail_rate_limited'
    );
  }

  try {
    const record = await redisUserStore.findByEmail(email);
    if (record && isPasswordAccount(record) && isEmailVerified(record)) {
      await queueAccountMail('reset', record, mailLocale(body.locale));
    }
  } catch {
    console.warn('auth_mail_failure category=store');
  }

  await holdUntil(startedAt);
  return NextResponse.json({ success: true }, { status: 202 });
}
