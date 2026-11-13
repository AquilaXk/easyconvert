import type { NextResponse } from 'next/server';
import { codedRefusal } from '../api/problem-details';
import type { AuthErrorCode } from '../refusal-codes';
import { mailBudgetLeft } from './mail-budget';
import { authRateLimitRefusal, consumeEmailCodeRateLimit } from './login-rate-limiter';

const HTTP_SERVICE_UNAVAILABLE = 503;
/** What `Retry-After` says when the day's mail budget is used up: the budget counts a UTC day, so an hour is a poll, not a promise. */
const BUDGET_RETRY_AFTER_SECONDS = 3600;

/**
 * The refusal that stands in front of every mail of a code, or null when the mail may be made: the limit per address and
 * client (and per address), then the mail budget of the day. Both are checked whether or not the address has an account, so
 * neither tells anything about accounts.
 */
export async function refuseCodeMail(clientIp: string | null, email: string): Promise<NextResponse | null> {
  const limit = await consumeEmailCodeRateLimit(clientIp, email);
  if (!limit.allowed) {
    return authRateLimitRefusal(
      limit.retryAfterSeconds,
      `Too many requests. Please try again in ${limit.retryAfterSeconds} seconds.`,
      'mail_rate_limited'
    );
  }
  if (!(await mailBudgetLeft())) {
    return codedRefusal<AuthErrorCode>(
      HTTP_SERVICE_UNAVAILABLE,
      'mail_temporarily_unavailable',
      'Verification codes cannot be sent right now. Please try again later.',
      {},
      { 'Retry-After': String(BUDGET_RETRY_AFTER_SECONDS) }
    );
  }
  return null;
}
