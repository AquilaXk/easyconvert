import { NextRequest, NextResponse } from 'next/server';
import { billingUnavailable, providerFailed } from '@/lib/api/billing-refusal';
import { readJsonObject } from '@/lib/api/json-body';
import { authStoreUnavailableRefusal, codedRefusal, serverFault } from '@/lib/api/problem-details';
import { isPasswordAccount } from '@/lib/auth/account-mail';
import { verifyPassword } from '@/lib/auth/crypto';
import { eraseAccount, planAccountErasure } from '@/lib/auth/erase-account';
import {
  authRateLimitRefusal,
  checkLoginRateLimit,
  recordFailedLogin,
  resolveAuthClientIp,
} from '@/lib/auth/login-rate-limiter';
import { redisUserStore } from '@/lib/auth/redis-user-store';
import { clearSessionCookies, createSessionCookie, createSessionToken } from '@/lib/auth/session';
import { readSessionOrRefusal } from '@/lib/auth/session-refusal';
import { AuthStoreUnavailableError } from '@/lib/auth/store-unavailable';
import type { UserRecord } from '@/lib/auth/types';
import { getBillingProvider } from '@/lib/billing';
import type { SubscriptionRecord } from '@/lib/billing/types';
import type { AuthErrorCode } from '@/lib/refusal-codes';

export const dynamic = 'force-dynamic';

const refusal = codedRefusal<AuthErrorCode>;
const DUMMY_HASH = '0'.repeat(128);
const DUMMY_SALT = '0'.repeat(32);
const MAX_PASSWORD_LENGTH = 1024;
const SELF_SERVE_DRAIN_MS = 500;

async function verifyAccountErasureAuth(
  record: UserRecord,
  body: Record<string, unknown>,
  clientIp: string | null
): Promise<NextResponse | null> {
  if (isPasswordAccount(record) && record.passwordHash && record.salt) {
    const password = typeof body.password === 'string' ? body.password : '';
    if (!password) return refusal(400, 'missing_fields', 'Your current password is required to delete the account.');

    const rateLimit = await checkLoginRateLimit(clientIp, record.email);
    if (!rateLimit.allowed) {
      return authRateLimitRefusal(
        rateLimit.retryAfterSeconds,
        `Too many failed attempts. Please try again in ${rateLimit.retryAfterSeconds} seconds.`
      );
    }
    if (password.length > MAX_PASSWORD_LENGTH) {
      await verifyPassword('invalid-length', DUMMY_HASH, DUMMY_SALT);
      await recordFailedLogin(clientIp, record.email);
      return refusal(401, 'invalid_credentials', 'Invalid password.');
    }
    const valid = await verifyPassword(password, record.passwordHash, record.salt);
    if (!valid) {
      await recordFailedLogin(clientIp, record.email);
      return refusal(401, 'invalid_credentials', 'Invalid password.');
    }
    return null;
  }

  const confirmEmail = typeof body.confirmEmail === 'string' ? body.confirmEmail.trim().toLowerCase() : '';
  if (!confirmEmail || confirmEmail !== record.email.trim().toLowerCase()) {
    return refusal(400, 'invalid_email', 'Confirm your account email address to delete the account.');
  }
  return null;
}

async function cancelActiveSubscriptionBeforeErasure(subscription: SubscriptionRecord | null): Promise<NextResponse | null> {
  if (!subscription || subscription.status === 'canceled') return null;
  const billing = getBillingProvider();
  if (!billing) return billingUnavailable();
  try {
    await billing.provider.cancelSubscription(subscription);
    return null;
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : 'provider_error';
    console.error(`[billing] account deletion subscription cancel failed: ${reason}`);
    return providerFailed();
  }
}

/**
 * Permanently erases the signed-in user's account, API keys, webhooks, stored files, jobs and quota records after
 * re-verifying credentials and immediately canceling any active recurring subscription at the payment provider.
 */
export async function DELETE(req: NextRequest) {
  const session = await readSessionOrRefusal(req);
  if ('refused' in session) return session.refused;
  if (!session.user) {
    return codedRefusal(401, undefined, 'Unauthorized: sign in to delete your account.');
  }

  const body = await readJsonObject(req);
  if (!body) return refusal(400, 'invalid_json', 'Invalid JSON request payload.');
  if (body.confirm !== 'DELETE') {
    return refusal(400, 'missing_fields', 'Set "confirm" to "DELETE" to permanently erase your account.');
  }

  const resolvedIp = resolveAuthClientIp(req);
  if ('refused' in resolvedIp) return resolvedIp.refused;

  try {
    const record = await redisUserStore.findById(session.user.id);
    if (!record) {
      const response = NextResponse.json({ success: true });
      for (const cleared of clearSessionCookies()) response.headers.append('Set-Cookie', cleared);
      return response;
    }

    const authDenied = await verifyAccountErasureAuth(record, body, resolvedIp.clientIp);
    if (authDenied) return authDenied;

    const plan = await planAccountErasure(record.id);
    if (plan) {
      const billingDenied = await cancelActiveSubscriptionBeforeErasure(plan.subscription);
      if (billingDenied) return billingDenied;

      const outcome = await eraseAccount(plan, { drainMs: SELF_SERVE_DRAIN_MS });
      if (outcome.runningJobIds.length > 0) {
        const conflict = codedRefusal(
          409,
          undefined,
          'Active conversions were cancelled and are stopping. Submit account deletion again in a few seconds.'
        );
        const refreshed = await redisUserStore.findById(record.id);
        if (refreshed) {
          conflict.headers.set('Set-Cookie', createSessionCookie(createSessionToken(redisUserStore.sanitizeUser(refreshed))));
        }
        return conflict;
      }
    }

    const response = NextResponse.json({ success: true });
    for (const cleared of clearSessionCookies()) response.headers.append('Set-Cookie', cleared);
    return response;
  } catch (err: unknown) {
    if (err instanceof AuthStoreUnavailableError) return authStoreUnavailableRefusal(err);
    return serverFault('auth/account', err, 'Account deletion failed on the server.');
  }
}
