import type { NextResponse } from 'next/server';
import { ConversionOptionsSchema, validateOrProblem } from './contracts';
import { createProblemDetailsResponse } from './problem-details';

const HTTP_BAD_REQUEST = 400;

/**
 * Checks conversion options against the SSOT ConversionOptionsSchema, as /api/v1 does. The legacy
 * routes keep their historical status for a rejected request, 400 where /api/v1 answers 422, and
 * name the offending options in `invalidParams`. Returns null when the options are valid.
 */
export function legacyOptionsProblem(options: unknown, instanceUri: string): NextResponse | null {
  const validation = validateOrProblem(ConversionOptionsSchema, options, instanceUri);
  if (validation.ok) return null;
  return createProblemDetailsResponse(
    HTTP_BAD_REQUEST,
    validation.problem.detail,
    instanceUri,
    undefined,
    undefined,
    undefined,
    validation.problem.invalidParams
  );
}
