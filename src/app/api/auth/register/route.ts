import { NextRequest, NextResponse } from 'next/server';
import { queueAccountMail } from '@/lib/auth/account-mail';
import { hashPassword } from '@/lib/auth/crypto';
import { isDisposableEmail } from '@/lib/auth/disposable-email';
import { isPlainMailbox } from '@/lib/auth/mailbox';
import { isAuthMailEnabled, mailLocale } from '@/lib/auth/mail-config';
import { mailBudgetLeft } from '@/lib/auth/mail-budget';
import { holdUntil } from '@/lib/auth/opaque-response';
import { redisUserStore } from '@/lib/auth/redis-user-store';
import { codedRefusal, serverFault } from '@/lib/api/problem-details';
import { readJsonObject } from '@/lib/api/json-body';
import {
  authRateLimitRefusal,
  consumeRegistrationRateLimit,
  consumeVerifyMailRateLimit,
  resolveAuthClientIp,
} from '@/lib/auth/login-rate-limiter';
import type { AuthErrorCode } from '@/lib/refusal-codes';
import { TERMS_VERSION, termsRefusal, termsRefusalText } from '@/lib/legal/documents';

export const dynamic = 'force-dynamic';

const refusal = codedRefusal<AuthErrorCode>;

const HTTP_SERVICE_UNAVAILABLE = 503;
/** What `Retry-After` says when the day's budget of verification mails is used up: it counts a UTC day, so an hour is a poll, not a promise. */
const BUDGET_RETRY_AFTER_SECONDS = 3600;

/**
 * Makes an account with an email address and a password, unverified, and mails the link that verifies the address (the page the
 * link opens confirms it with a button, `/api/auth/email-verification/confirm`). Until the link is used the account counts as an
 * anonymous visitor for conversions (docs/policy-decisions.md, entry 288), so a person cannot multiply the free daily allowance
 * with accounts of addresses they do not own.
 *
 * The answer is the same 202 after the same wait whether the address is new or has an account already, and it starts no
 * session: a session only for a new address would tell a stranger which addresses have accounts. An address with an account is
 * sent nothing and its account is not touched. (The permissively licensed references do the same: the sign-up of
 * supabase/auth returns an obfuscated user and sends no mail for a confirmed address, and better-auth with required
 * verification answers a synthetic user without a session; docs/licensing.md, 2.24.) A person who registered with an address
 * that was not theirs cannot keep it: the real owner resets the password, which proves the address and confirms it.
 */
export async function POST(req: NextRequest) {
  const startedAt = performance.now();
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

    // The domain, not the account, decides this, so it tells nothing about accounts.
    if (isDisposableEmail(email)) {
      return refusal(400, 'disposable_email', 'Disposable email addresses cannot be used to sign up.');
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

    const mailOn = isAuthMailEnabled();
    if (mailOn) {
      // Counted whether or not the address has an account, so neither limit tells anything about accounts.
      const mailLimit = await consumeVerifyMailRateLimit(clientIp, email);
      if (!mailLimit.allowed) {
        return authRateLimitRefusal(
          mailLimit.retryAfterSeconds,
          `Too many requests. Please try again in ${mailLimit.retryAfterSeconds} seconds.`,
          'mail_rate_limited'
        );
      }
      // No account is made while no link can be sent for it.
      if (!(await mailBudgetLeft('verify'))) {
        return refusal(
          HTTP_SERVICE_UNAVAILABLE,
          'mail_temporarily_unavailable',
          'Sign-up is unavailable for now. Please try again later.',
          {},
          { 'Retry-After': String(BUDGET_RETRY_AFTER_SECONDS) }
        );
      }
    }

    if (!(await redisUserStore.findByEmail(email))) {
      const { hash, salt } = await hashPassword(password);
      const userRecord = await redisUserStore
        .createUser({
          email,
          name: name || email.split('@')[0],
          tier: 'free',
          provider: 'email',
          passwordHash: hash,
          salt,
          emailVerified: false,
          acceptedTermsVersion: TERMS_VERSION,
        })
        // An account made between the check above and this write (a Google sign-up of the same address) is the existing-address case.
        .catch((error: unknown) => (error instanceof Error && error.message.includes('already exists') ? null : Promise.reject(error)));
      // The mail that confirms the address is sent in the background; a failure of it never fails the sign-up.
      if (userRecord && mailOn) {
        await queueAccountMail('verify', userRecord, mailLocale(body.locale)).catch(() => {
          console.warn('auth_mail_failure category=store');
        });
      }
    }

    await holdUntil(startedAt);
    return NextResponse.json({ success: true }, { status: 202 });
  } catch (err: unknown) {
    return serverFault('auth/register', err, 'Registration failed on the server.');
  }
}
