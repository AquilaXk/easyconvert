import type { NextResponse } from 'next/server';
import type { ConversionRefusal } from '../api-keys/guard';
import { HTTP_SERVICE_UNAVAILABLE, HTTP_TOO_MANY_REQUESTS, QUOTA_EXCEEDED_PROBLEM_TYPE, SERVICE_UNAVAILABLE_PROBLEM_TYPE } from '../refusal-codes';
import { createProblemDetailsResponse, SERVICE_RETRY_AFTER_SECONDS } from './problem-details';
import { buildRateLimitHeaders } from './rate-limit';

const HTTP_FORBIDDEN = 403;

/**
 * The answer of every route that reserves conversions when the guard refused them: 403 for an account whose address is not
 * confirmed (it has no allowance of its own), 503 while the quota store is offline, else 429 with the period's count in the rate limit headers and, beside the English detail, the numbers it states (the
 * limit of the period, which `dailyLimit` names whatever the period is, and `period` itself, the conversions left, and those the request needs), so a graph that needs more than is left is told both.
 */
export function conversionRefusalResponse(refusal: ConversionRefusal, instanceUri: string): NextResponse {
  if (refusal.reason === 'offline') {
    return createProblemDetailsResponse(HTTP_SERVICE_UNAVAILABLE, refusal.error, instanceUri, 'Service Unavailable', SERVICE_UNAVAILABLE_PROBLEM_TYPE, {
      'Retry-After': String(SERVICE_RETRY_AFTER_SECONDS),
    });
  }
  if (refusal.reason === 'unconfirmed') {
    return createProblemDetailsResponse(HTTP_FORBIDDEN, refusal.error, instanceUri, 'Forbidden');
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
    { dailyLimit: usage.dailyLimit, period: usage.period, remaining: usage.remaining, requiredUnits }
  );
}
