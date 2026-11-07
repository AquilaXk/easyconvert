import type { NextResponse } from 'next/server';
import { HTTP_SERVICE_UNAVAILABLE } from '../refusal-codes';
import { EngineMissingError, typedFailureOf } from '../types';
import { createEngineUnavailableResponse, createProblemDetailsResponse } from './problem-details';

const HTTP_INTERNAL_SERVER_ERROR = 500;
const INTERNAL_ERROR_DETAIL = 'Internal conversion error';

/**
 * The problem+json answer of an error no named branch of a convert route handles. A typed failure is answered with the status and
 * code its class declares (the file is intact but encrypted or coded with a method no engine here decodes: 422), and a missing tool
 * with 503. A fault of the server, a 5xx a class declares or an untyped error, gets a generic detail, since it can carry sandbox
 * paths; the outcome line carries the error.
 */
export function typedFailureProblem(error: unknown, instanceUri: string, headers?: Record<string, string>): NextResponse {
  const typed = typedFailureOf(error);
  if (typed && error instanceof EngineMissingError && typed.status === HTTP_SERVICE_UNAVAILABLE) return createEngineUnavailableResponse(error, instanceUri, headers);
  if (typed && typed.status < HTTP_INTERNAL_SERVER_ERROR) {
    const detail = error instanceof Error ? error.message : String(error);
    return createProblemDetailsResponse(typed.status, detail, instanceUri, undefined, undefined, headers, undefined, { code: typed.code });
  }
  return createProblemDetailsResponse(typed?.status ?? HTTP_INTERNAL_SERVER_ERROR, INTERNAL_ERROR_DETAIL, instanceUri, undefined, undefined, headers);
}
