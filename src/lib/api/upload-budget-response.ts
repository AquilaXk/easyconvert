import type { NextResponse } from 'next/server';
import { createProblemDetailsResponse } from './problem-details';
import { ANONYMOUS_DAILY_UPLOAD_BYTES, ANONYMOUS_OPEN_UPLOADS_MAX, type BudgetRefusal } from '../api-keys/anonymous-upload-budget';
import { formatBytes } from '../format-bytes';

/** The problem type of a request the byte budget of an anonymous caller refuses (docs/policy-decisions.md, entry 137). */
export const UPLOAD_BUDGET_PROBLEM_TYPE = 'https://api.easyconvert.io/problems/upload-budget-exceeded';

const HTTP_TOO_MANY_REQUESTS = 429;

const BUDGET_REFUSAL_DETAIL: Readonly<Record<BudgetRefusal, string>> = {
  'open-uploads': `Up to ${ANONYMOUS_OPEN_UPLOADS_MAX} uploads may be open at once without an account. Finish or cancel one, then try again.`,
  'daily-bytes': `Without an account, uploads and link imports may total ${formatBytes(ANONYMOUS_DAILY_UPLOAD_BYTES)} a day. The limit resets at midnight UTC.`,
};

/** The limit each budget refusal names, as a field beside the English detail. */
const BUDGET_REFUSAL_FACTS: Readonly<Record<BudgetRefusal, Record<string, number>>> = {
  'open-uploads': { limit: ANONYMOUS_OPEN_UPLOADS_MAX },
  'daily-bytes': { limitBytes: ANONYMOUS_DAILY_UPLOAD_BYTES },
};

/** The 429 of an upload or a link import the budget refuses, naming the bound and its number. */
export function uploadBudgetRefusalResponse(refusal: BudgetRefusal, instanceUri: string): NextResponse {
  return createProblemDetailsResponse(
    HTTP_TOO_MANY_REQUESTS,
    BUDGET_REFUSAL_DETAIL[refusal],
    instanceUri,
    'Too Many Requests',
    UPLOAD_BUDGET_PROBLEM_TYPE,
    undefined,
    undefined,
    { refusal, ...BUDGET_REFUSAL_FACTS[refusal] }
  );
}
