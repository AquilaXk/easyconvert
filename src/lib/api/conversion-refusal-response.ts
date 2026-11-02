import type { NextResponse } from 'next/server';
import type { ConversionRefusal } from '../api-keys/guard';
import { PROBLEM_TYPE_BASE } from '../refusal-codes';
import { createProblemDetailsResponse } from './problem-details';
import { buildRateLimitHeaders } from './rate-limit';

const HTTP_TOO_MANY_REQUESTS = 429;
const HTTP_SERVICE_UNAVAILABLE = 503;
const QUOTA_EXCEEDED_PROBLEM_TYPE = `${PROBLEM_TYPE_BASE}quota-exceeded`;
const SERVICE_UNAVAILABLE_PROBLEM_TYPE = `${PROBLEM_TYPE_BASE}service-unavailable`;

/**
 * The answer of every route that reserves conversions when the guard refused them: 503 while the quota store is offline,
 * else 429 with the day's count in the rate limit headers and, beside the English detail, the numbers it states (the
 * daily limit, the conversions left, and those the request needs), so a graph that needs more than is left is told both.
 */
export function conversionRefusalResponse(refusal: ConversionRefusal, instanceUri: string): NextResponse {
  if (refusal.reason === 'offline') {
    return createProblemDetailsResponse(HTTP_SERVICE_UNAVAILABLE, refusal.error, instanceUri, 'Service Unavailable', SERVICE_UNAVAILABLE_PROBLEM_TYPE);
  }
  const { usage, requiredUnits } = refusal;
  return createProblemDetailsResponse(
    HTTP_TOO_MANY_REQUESTS,
    refusal.error,
    instanceUri,
    'Too Many Requests',
    QUOTA_EXCEEDED_PROBLEM_TYPE,
    buildRateLimitHeaders(usage),
    undefined,
    { dailyLimit: usage.dailyLimit, remaining: usage.remaining, requiredUnits }
  );
}
