import { NextRequest, NextResponse } from 'next/server';
import { authStoreUnavailableRefusal, codedRefusal, serverFault } from '@/lib/api/problem-details';
import { AuthStoreUnavailableError } from '@/lib/auth/store-unavailable';
import { readJsonObject } from '@/lib/api/json-body';
import { confirmationFields } from '@/lib/auth/email-verified';
import { consumeAuthToken, isAuthTokenShape } from '@/lib/auth/auth-email-token-store';
import { authRateLimitRefusal, consumeMailLinkRateLimit, resolveAuthClientIp } from '@/lib/auth/login-rate-limiter';
import { isAuthMailEnabled } from '@/lib/auth/mail-config';
import { redisUserStore } from '@/lib/auth/redis-user-store';
import type { AuthErrorCode } from '@/lib/refusal-codes';

export const dynamic = 'force-dynamic';

const refusal = codedRefusal<AuthErrorCode>;

/** Confirms the address of an account with the token of its verification mail. The token works once and needs no session. */
export async function POST(req: NextRequest) {
  if (!isAuthMailEnabled()) return refusal(404, 'mail_unavailable', 'Email verification is not available.');

  const body = await readJsonObject(req);
  if (!body) return refusal(400, 'invalid_json', 'Invalid JSON request payload.');

  const resolvedIp = resolveAuthClientIp(req);
  if ('refused' in resolvedIp) return resolvedIp.refused;

  try {
    const limit = await consumeMailLinkRateLimit('verify-confirm', resolvedIp.clientIp, null);
    if (!limit.allowed) {
      return authRateLimitRefusal(
        limit.retryAfterSeconds,
        `Too many attempts. Please try again in ${limit.retryAfterSeconds} seconds.`,
        'mail_rate_limited'
      );
    }

    const subject = isAuthTokenShape(body.token) ? await consumeAuthToken('verify', body.token) : null;
    const record = subject ? await redisUserStore.findById(subject.userId) : null;
    if (!subject || !record || record.email !== subject.email) {
      return refusal(400, 'invalid_token', 'This link is not valid or has expired.');
    }
    // `null` is an account that was erased since the token was made.
    if (!(await redisUserStore.updateUser(record.id, confirmationFields(record)))) {
      return refusal(400, 'invalid_token', 'This link is not valid or has expired.');
    }
    return NextResponse.json({ success: true });
  } catch (err: unknown) {
    if (err instanceof AuthStoreUnavailableError) return authStoreUnavailableRefusal(err);
    return serverFault('auth/email-verification', err, 'Email verification failed on the server.');
  }
}
