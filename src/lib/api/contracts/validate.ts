import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { NextResponse } from 'next/server';
import { createProblemDetailsResponse, ProblemDetails } from '../problem-details';
import {
  ConversionOptionsSchema,
  PipelineTaskSchema,
  JobCreateRequestSchema,
  ProblemDetailsSchema,
  JobResourceSchema,
} from './schemas';

export const ajv = new Ajv2020({
  strict: true,
  allErrors: true,
  coerceTypes: false,
  removeAdditional: false,
});

addFormats(ajv);

// Add custom keyword for tracking and rejecting planned options
ajv.addKeyword({
  keyword: 'x-easyconvert-status',
  validate: function validatePlannedStatus(schemaVal: any, data: any) {
    if (schemaVal === 'planned' && data !== undefined) {
      return false;
    }
    return true;
  },
  error: {
    message: () => 'option_not_supported',
  },
});

// Register SSOT schemas with Ajv
ajv.addSchema(ConversionOptionsSchema);
ajv.addSchema(PipelineTaskSchema);
ajv.addSchema(JobCreateRequestSchema);
ajv.addSchema(ProblemDetailsSchema);
ajv.addSchema(JobResourceSchema);

export type ValidateResult<T> =
  | { ok: true; data: T; problem?: never; response?: never }
  | { ok: false; data?: never; problem: ProblemDetails; response: NextResponse };

/**
 * Validates arbitrary payload data against a JSON Schema contract.
 * Returns { ok: true, data } on success, or { ok: false, problem, response } with HTTP 422
 * and an RFC 9457 compliant ProblemDetails structure on failure.
 */
export function validateOrProblem<T = unknown>(
  schema: any,
  data: unknown,
  instanceUri: string = '/api/v1/jobs'
): ValidateResult<T> {
  let validator;
  if (typeof schema === 'string') {
    validator = ajv.getSchema(schema);
  } else if (schema?.$id) {
    validator = ajv.getSchema(schema.$id) ?? ajv.compile(schema);
  } else {
    validator = ajv.compile(schema);
  }

  if (!validator) {
    const detail = 'Internal validation schema configuration error.';
    const problem: ProblemDetails = {
      type: 'https://api.easyconvert.io/problems/internal-server-error',
      title: 'Internal Server Error',
      status: 500,
      detail,
      instance: instanceUri,
      success: false,
      error: detail,
    };
    return {
      ok: false,
      problem,
      response: createProblemDetailsResponse(500, detail, instanceUri),
    };
  }

  const isValid = validator(data);
  if (isValid) {
    return { ok: true, data: data as T };
  }

  const errors = validator.errors || [];
  let isPlannedOption = false;

  const invalidParams: Array<{ name: string; reason: string }> = errors.map((err) => {
    const isPlanned =
      err.keyword === 'x-easyconvert-status' ||
      err.message === 'option_not_supported' ||
      (err.params as any)?.code === 'option_not_supported';
    if (isPlanned) {
      isPlannedOption = true;
    }

    let fieldPath = err.instancePath ? err.instancePath.replace(/^\//, '').replace(/\//g, '.') : '';
    const missingProp = (err.params as any)?.missingProperty;
    const additionalProp = (err.params as any)?.additionalProperty;

    if (missingProp) {
      fieldPath = fieldPath ? `${fieldPath}.${missingProp}` : missingProp;
    } else if (additionalProp) {
      fieldPath = fieldPath ? `${fieldPath}.${additionalProp}` : additionalProp;
    } else if (!fieldPath) {
      fieldPath = 'payload';
    }

    const reason = isPlanned ? 'option_not_supported' : err.message || 'validation failed';
    return { name: fieldPath, reason };
  });

  const status = 422;
  const type = isPlannedOption
    ? 'https://api.easyconvert.io/problems/option-not-supported'
    : 'https://api.easyconvert.io/problems/unprocessable-entity';
  const title = isPlannedOption ? 'Option Not Supported' : 'Unprocessable Entity';

  const detail = isPlannedOption
    ? `Requested option is planned but not currently supported: option_not_supported (${invalidParams.map((p) => p.name).join(', ')})`
    : `Request validation failed: ${invalidParams.map((p) => `${p.name} ${p.reason}`).join('; ')}`;

  const problem: ProblemDetails = {
    type,
    title,
    status,
    detail,
    instance: instanceUri,
    invalidParams,
    success: false,
    error: detail,
  };

  const response = createProblemDetailsResponse(
    status,
    detail,
    instanceUri,
    title,
    type,
    undefined,
    invalidParams
  );

  return {
    ok: false,
    problem,
    response,
  };
}
