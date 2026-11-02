import type { NextResponse } from 'next/server';
import { createProblemDetailsResponse } from './problem-details';
import {
  ANONYMOUS_OPEN_UPLOADS_MAX,
  HELD_IMPORT_RETRY_AFTER_MS,
  budgetRefusalDetail,
  dailyBudgetBytes,
  largerThanLeftDetail,
  type BudgetRefusal,
} from '../api-keys/anonymous-upload-budget';
import { HTTP_SERVICE_UNAVAILABLE, HTTP_TOO_MANY_REQUESTS } from '../refusal-codes';
import type { Plan } from '../plan-limits';

/** The problem type of a request the byte budget of its caller refuses (docs/policy-decisions.md, entries 15 and 137). */
export const UPLOAD_BUDGET_PROBLEM_TYPE = 'https://api.easyconvert.io/problems/upload-budget-exceeded';
const TRUST_UNCONFIGURED_PROBLEM_TYPE = 'https://api.easyconvert.io/problems/client-ip-trust-unconfigured';
const MS_PER_SECOND = 1000;

const UNATTRIBUTED_DETAIL =
  'Uploads and link imports without an account are off until this server can tell visitors apart: set TRUSTED_PROXIES to the proxies in front of it. Sign in meanwhile.';

/** The daily byte limit a refusal names, as fields beside the English detail; an account's names its plan. */
function dailyLimitFacts(plan: Plan): Record<string, number | string> {
  return plan === 'anonymous' ? { limitBytes: dailyBudgetBytes(plan) } : { limitBytes: dailyBudgetBytes(plan), plan };
}

/** The 429 of the budget of a caller of `plan`, with `facts` beside the English `detail`. */
function budgetRefusal(detail: string, instanceUri: string, facts: Record<string, number | string>, headers?: Record<string, string>): NextResponse {
  return createProblemDetailsResponse(HTTP_TOO_MANY_REQUESTS, detail, instanceUri, 'Too Many Requests', UPLOAD_BUDGET_PROBLEM_TYPE, headers, undefined, facts);
}

/**
 * The 429 of an upload or a link import the budget of a caller of `plan` refuses, naming the bound and its number. A
 * refusal while other transfers hold the rest of the day says when to try again (`Retry-After`), since they end.
 */
export function uploadBudgetRefusalResponse(refusal: BudgetRefusal, instanceUri: string, plan: Plan = 'anonymous'): NextResponse {
  const facts = refusal === 'open-uploads' ? { limit: ANONYMOUS_OPEN_UPLOADS_MAX } : dailyLimitFacts(plan);
  const headers = refusal === 'held' ? { 'Retry-After': String(Math.ceil(HELD_IMPORT_RETRY_AFTER_MS / MS_PER_SECOND)) } : undefined;
  return budgetRefusal(budgetRefusalDetail(refusal, plan), instanceUri, { refusal, ...facts }, headers);
}

/** The 429 of a link import whose file is larger than the `leftBytes` the day of a caller of `plan` has left for it. */
export function importLargerThanLeftResponse(leftBytes: number, instanceUri: string, plan: Plan): NextResponse {
  return budgetRefusal(largerThanLeftDetail(leftBytes), instanceUri, { refusal: 'larger-than-left', leftBytes, ...dailyLimitFacts(plan) });
}

/**
 * The 503 for an anonymous caller while no client can be attributed: every visitor would share one budget, which one
 * of them could use up for all, so anonymous uploads and link imports stay off until the proxies are declared
 * (docs/client-ip-trust.md).
 */
export function unattributedTransferRefusal(instanceUri: string): NextResponse {
  return createProblemDetailsResponse(HTTP_SERVICE_UNAVAILABLE, UNATTRIBUTED_DETAIL, instanceUri, 'Service Unavailable', TRUST_UNCONFIGURED_PROBLEM_TYPE);
}
