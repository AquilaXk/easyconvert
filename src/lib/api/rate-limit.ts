import type { QuotaUsage } from '../api-keys/types';

const MIN_RETRY_AFTER_SECONDS = 1;

/** The `w` of `RateLimit-Policy`: a day, or the nominal month of 30 days (the reset header is the exact time left). */
const WINDOW_SECONDS = { day: 86_400, month: 2_592_000 } as const;

/**
 * Builds standard IETF Draft RateLimit headers (draft-ietf-httpapi-ratelimit-headers)
 * and legacy X-RateLimit headers for developer experience and cross-client compatibility.
 */
export function buildRateLimitHeaders(quota: QuotaUsage): Record<string, string> {
  const now = Date.now();
  const resetDeltaSeconds = Math.max(0, Math.ceil((quota.resetAt - now) / 1000));
  // The credits the account can spend in the period: the window's allowance and the package balance, which `remaining` counts too.
  const limitStr = Math.max(0, quota.dailyLimit + quota.packageCredits).toString();
  const remainingStr = Math.max(0, quota.remaining).toString();
  const resetStr = resetDeltaSeconds.toString();
  const policyStr = `${limitStr};w=${WINDOW_SECONDS[quota.period]};comment="${quota.tier} ${quota.period === 'month' ? 'monthly' : 'daily'} credits"`;

  const headers: Record<string, string> = {
    'RateLimit': `limit=${limitStr}, remaining=${remainingStr}, reset=${resetStr}`,
    'RateLimit-Limit': limitStr,
    'RateLimit-Remaining': remainingStr,
    'RateLimit-Reset': resetStr,
    'RateLimit-Policy': policyStr,
    'X-RateLimit-Limit': limitStr,
    'X-RateLimit-Remaining': remainingStr,
    'X-RateLimit-Reset': resetStr,
  };

  // RFC 9110 Retry-After (delay-seconds) once the quota of the period is exhausted.
  if (quota.remaining <= 0) {
    headers['Retry-After'] = Math.max(MIN_RETRY_AFTER_SECONDS, resetDeltaSeconds).toString();
  }

  return headers;
}
