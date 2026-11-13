import { NextRequest, NextResponse } from 'next/server';
import { codedRefusal, serverFault } from '@/lib/api/problem-details';
import { readJsonObject } from '@/lib/api/json-body';
import { queueEmailCode } from '@/lib/auth/account-mail';
import { isDisposableEmail } from '@/lib/auth/disposable-email';
import { refuseCodeMail } from '@/lib/auth/email-code-guard';
import { authRateLimitRefusal, consumeRegistrationRateLimit, resolveAuthClientIp } from '@/lib/auth/login-rate-limiter';
import { isAuthMailEnabled, mailLocale } from '@/lib/auth/mail-config';
import { isPlainMailbox } from '@/lib/auth/mailbox';
import { holdUntil } from '@/lib/auth/opaque-response';
import { redisUserStore } from '@/lib/auth/redis-user-store';
import type { AuthErrorCode } from '@/lib/refusal-codes';

export const dynamic = 'force-dynamic';

const refusal = codedRefusal<AuthErrorCode>;

/**
 * The first step of a password sign-up: mails a six-digit code to the address. No account exists until the second step
 * (`POST /api/auth/register`) presents the code, so no address that nobody confirmed ever has an account.
 *
 * An address with an account is sent nothing and is answered like any other: 202 after the same wait, so the answer does not
 * tell whether it has an account. The permissively licensed references answer the same way for the same reason: the
 * sign-up of supabase/auth sends no mail and returns an obfuscated success for an address that is confirmed already, and the
 * send route of the email OTP of better-auth answers `{ success: true }` whether or not it sent a code (docs/policy-decisions.md,
 * entry 288; docs/licensing.md, 2.24).
 */
export async function POST(req: NextRequest) {
  if (!isAuthMailEnabled()) return refusal(404, 'mail_unavailable', 'Sign-up by email is not available on this server.');
  const startedAt = performance.now();

  const body = await readJsonObject(req);
  if (!body) return refusal(400, 'invalid_json', 'Invalid JSON request payload.');

  const resolvedIp = resolveAuthClientIp(req);
  if ('refused' in resolvedIp) return resolvedIp.refused;
  const { clientIp } = resolvedIp;

  const email = typeof body.email === 'string' ? body.email.trim() : '';
  if (!isPlainMailbox(email)) return refusal(400, 'invalid_email', 'A valid email address is required.');
  // The domain, not the account, decides this, so it tells nothing about accounts.
  if (isDisposableEmail(email)) return refusal(400, 'disposable_email', 'Disposable email addresses cannot be used to sign up.');

  const rateLimit = await consumeRegistrationRateLimit(clientIp, 'code');
  if (!rateLimit.allowed) {
    return authRateLimitRefusal(rateLimit.retryAfterSeconds, `Too many registration attempts. Please try again in ${rateLimit.retryAfterSeconds} seconds.`);
  }
  const refused = await refuseCodeMail(clientIp, email);
  if (refused) return refused;

  try {
    if (!(await redisUserStore.findByEmail(email))) await queueEmailCode('signup', email, mailLocale(body.locale));
  } catch (err: unknown) {
    return serverFault('auth/register-code', err, 'Sending the code failed on the server.');
  }

  await holdUntil(startedAt);
  return NextResponse.json({ success: true }, { status: 202 });
}
