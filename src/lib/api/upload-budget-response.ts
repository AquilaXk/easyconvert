import type { NextResponse } from 'next/server';
import { createProblemDetailsResponse } from './problem-details';
import { ANONYMOUS_OPEN_UPLOADS_MAX, dailyBudgetBytes, type BudgetRefusal } from '../api-keys/anonymous-upload-budget';
import { formatBytes } from '../format-bytes';
import { PLAN_NAME, type Plan } from '../plan-limits';

/** The problem type of a request the byte budget of its caller refuses (docs/policy-decisions.md, entries 15 and 137). */
export const UPLOAD_BUDGET_PROBLEM_TYPE = 'https://api.easyconvert.io/problems/upload-budget-exceeded';
const TRUST_UNCONFIGURED_PROBLEM_TYPE = 'https://api.easyconvert.io/problems/client-ip-trust-unconfigured';

const HTTP_TOO_MANY_REQUESTS = 429;
const HTTP_SERVICE_UNAVAILABLE = 503;

const UNATTRIBUTED_DETAIL =
  'Uploads and link imports without an account are off until this server can tell visitors apart: set TRUSTED_PROXIES to the proxies in front of it. Sign in meanwhile.';

/** The English detail of a refusal: what the caller of `plan` may bring in, and when it may again. */
function refusalDetail(refusal: BudgetRefusal, plan: Plan): string {
  if (refusal === 'open-uploads') {
    return `Up to ${ANONYMOUS_OPEN_UPLOADS_MAX} uploads may be open at once without an account. Finish or cancel one, then try again.`;
  }
  const limit = formatBytes(dailyBudgetBytes(plan));
  if (refusal === 'held') {
    return `Link imports that are still running hold the rest of today's ${limit}. Try again when they finish; what they do not read is given back.`;
  }
  const allowance =
    plan === 'anonymous'
      ? `Without an account, uploads and link imports may total ${limit} a day.`
      : `On the ${PLAN_NAME[plan]} plan, link imports may total ${limit} a day.`;
  return `${allowance} The limit resets at midnight UTC.`;
}

/** The limit each refusal names, as fields beside the English detail; an account's names its plan. */
function refusalFacts(refusal: BudgetRefusal, plan: Plan): Record<string, number | string> {
  if (refusal === 'open-uploads') return { limit: ANONYMOUS_OPEN_UPLOADS_MAX };
  return plan === 'anonymous' ? { limitBytes: dailyBudgetBytes(plan) } : { limitBytes: dailyBudgetBytes(plan), plan };
}

/** The 429 of an upload or a link import the budget of a caller of `plan` refuses, naming the bound and its number. */
export function uploadBudgetRefusalResponse(refusal: BudgetRefusal, instanceUri: string, plan: Plan = 'anonymous'): NextResponse {
  return createProblemDetailsResponse(
    HTTP_TOO_MANY_REQUESTS,
    refusalDetail(refusal, plan),
    instanceUri,
    'Too Many Requests',
    UPLOAD_BUDGET_PROBLEM_TYPE,
    undefined,
    undefined,
    { refusal, ...refusalFacts(refusal, plan) }
  );
}

/**
 * The 503 for an anonymous caller while no client can be attributed: every visitor would share one budget, which one
 * of them could use up for all, so anonymous uploads and link imports stay off until the proxies are declared
 * (docs/client-ip-trust.md).
 */
export function unattributedTransferRefusal(instanceUri: string): NextResponse {
  return createProblemDetailsResponse(HTTP_SERVICE_UNAVAILABLE, UNATTRIBUTED_DETAIL, instanceUri, 'Service Unavailable', TRUST_UNCONFIGURED_PROBLEM_TYPE);
}
