import { NextRequest, NextResponse } from 'next/server';
import { codedRefusal } from '@/lib/api/problem-details';
import { readJsonObject } from '@/lib/api/json-body';
import { isEmailVerified, isPasswordAccount, queueAccountMail } from '@/lib/auth/account-mail';
import { authRateLimitRefusal, consumeMailLinkRateLimit, resolveAuthClientIp } from '@/lib/auth/login-rate-limiter';
import { isAuthMailEnabled, mailLocale } from '@/lib/auth/mail-config';
import { holdUntil } from '@/lib/auth/opaque-response';
import { redisUserStore } from '@/lib/auth/redis-user-store';
import { readSessionOrRefusal } from '@/lib/auth/session-refusal';
import type { AuthErrorCode } from '@/lib/refusal-codes';

export const dynamic = 'force-dynamic';

const refusal = codedRefusal<AuthErrorCode>;

/** Sends the verification mail again to the signed-in account. An account that is verified, or has no password, answers as one that was mailed. */
export async function POST(req: NextRequest) {
  if (!isAuthMailEnabled()) return refusal(404, 'mail_unavailable', 'Email verification is not available.');
  const startedAt = performance.now();

  const session = await readSessionOrRefusal(req);
  if ('refused' in session) return session.refused;
  const { user } = session;
  if (!user) return refusal(401, undefined, 'Unauthorized: No active session found.');

  const resolvedIp = resolveAuthClientIp(req);
  if ('refused' in resolvedIp) return resolvedIp.refused;

  const limit = await consumeMailLinkRateLimit('verify-resend', resolvedIp.clientIp, user.id);
  if (!limit.allowed) {
    return authRateLimitRefusal(
      limit.retryAfterSeconds,
      `Too many requests. Please try again in ${limit.retryAfterSeconds} seconds.`,
      'mail_rate_limited'
    );
  }

  const body = await readJsonObject(req);
  try {
    const record = await redisUserStore.findById(user.id);
    if (record && isPasswordAccount(record) && !isEmailVerified(record)) {
      await queueAccountMail('verify', record, mailLocale(body?.locale));
    }
  } catch {
    console.warn('auth_mail_failure category=store');
  }

  await holdUntil(startedAt);
  return NextResponse.json({ success: true }, { status: 202 });
}
