import type { NextResponse } from 'next/server';
import { authErrorHeaders, type ApiAuthResult } from '@/lib/api-keys/guard';
import type { DashboardRefusalCode } from '@/lib/refusal-codes';
import { codedRefusal } from './problem-details';

const HTTP_UNAUTHORIZED = 401;

/** What each status of the access check (`validateApiAccess`) stands for; its other answers (a 400 for an unreadable client address) carry no code. */
const ACCESS_REFUSAL_CODES: Readonly<Partial<Record<number, DashboardRefusalCode>>> = {
  401: 'sign_in_required',
  403: 'forbidden',
  429: 'rate_limited',
  503: 'service_unavailable',
};

/** The answer to a caller the access check turned away: its status, the code that status stands for there, and `Retry-After`. */
export function accessRefusal(
  auth: Pick<ApiAuthResult, 'error' | 'status' | 'retryAfterSeconds'>,
  defaultError: string
): NextResponse {
  const status = auth.status ?? HTTP_UNAUTHORIZED;
  return codedRefusal<DashboardRefusalCode>(status, ACCESS_REFUSAL_CODES[status], auth.error ?? defaultError, {}, authErrorHeaders(auth));
}
