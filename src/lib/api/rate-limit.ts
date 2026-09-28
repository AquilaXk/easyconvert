import type { QuotaUsage } from '../api-keys/types';

/**
 * Builds standard IETF Draft RateLimit headers (draft-ietf-httpapi-ratelimit-headers)
 * and legacy X-RateLimit headers for developer experience and cross-client compatibility.
 */
export function buildRateLimitHeaders(quota: QuotaUsage): Record<string, string> {
  const now = Date.now();
  const resetDeltaSeconds = Math.max(0, Math.ceil((quota.resetAt - now) / 1000));
  const limitStr = Math.max(0, quota.dailyLimit).toString();
  const remainingStr = Math.max(0, quota.remaining).toString();
  const resetStr = resetDeltaSeconds.toString();
  const policyStr = `${limitStr};w=86400;comment="${quota.tier} daily quota"`;

  return {
    'RateLimit-Limit': limitStr,
    'RateLimit-Remaining': remainingStr,
    'RateLimit-Reset': resetStr,
    'RateLimit-Policy': policyStr,
    'X-RateLimit-Limit': limitStr,
    'X-RateLimit-Remaining': remainingStr,
    'X-RateLimit-Reset': resetStr,
  };
}
