import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import type { ErrorObject, SchemaValidateFunction } from 'ajv/dist/types';
import { NextResponse } from 'next/server';
import { createProblemDetailsResponse, ProblemDetails } from '../problem-details';
import {
  ConversionOptionsSchema,
  PipelineTaskSchema,
  NamedTaskSchema,
  TaskReportSchema,
  JobGraphSchema,
  JobCreateRequestSchema,
  ProblemDetailsSchema,
  JobResourceSchema,
  IdempotencyKeyHeaderSchema,
  WebhookSecretRotateRequestSchema,
  WebhookSecretRotateResponseSchema,
  OcrLanguageEntrySchema,
  OcrLanguagesResponseSchema,
} from './schemas';
import { SERVER_ONLY_KEYWORD, SERVER_ONLY_REASON } from './server-only-options';

/** Reason named in `invalidParams` for a key that a property copy would turn into an object's prototype. */
export const PROTOTYPE_KEY_REASON = 'prototype_key';

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

// Refuses an object that carries a key only server code may set, naming each such key.
const validateServerOnlyKeys: SchemaValidateFunction = (keys: readonly string[], data: Record<string, unknown>) => {
  const present = keys.filter((key) => Object.hasOwn(data, key));
  validateServerOnlyKeys.errors = present.map((key) => ({
    keyword: SERVER_ONLY_KEYWORD,
    message: SERVER_ONLY_REASON,
    params: { serverOnlyProperty: key },
  }));
  return present.length === 0;
};

ajv.addKeyword({
  keyword: SERVER_ONLY_KEYWORD,
  type: 'object',
  schemaType: 'array',
  errors: true,
  validate: validateServerOnlyKeys,
});

// Register SSOT schemas with Ajv
ajv.addSchema(ConversionOptionsSchema);
ajv.addSchema(PipelineTaskSchema);
ajv.addSchema(NamedTaskSchema);
ajv.addSchema(TaskReportSchema);
ajv.addSchema(JobGraphSchema);
ajv.addSchema(JobCreateRequestSchema);
ajv.addSchema(ProblemDetailsSchema);
ajv.addSchema(JobResourceSchema);
ajv.addSchema(IdempotencyKeyHeaderSchema);
ajv.addSchema(WebhookSecretRotateRequestSchema);
ajv.addSchema(WebhookSecretRotateResponseSchema);
ajv.addSchema(OcrLanguageEntrySchema);
ajv.addSchema(OcrLanguagesResponseSchema);

/** A key as one segment of a JSON pointer, escaped as RFC 6901 and Ajv's `instancePath` escape it. */
function pointerSegment(key: string): string {
  return key.replace(/~/g, '~0').replace(/\//g, '~1');
}

/**
 * JSON pointers of the keys in `document` that a property copy would turn into a prototype: an own `__proto__` key,
 * and an own `constructor` that holds an object with an own `prototype`. JSON.parse keeps such a key as plain data,
 * so no schema keyword sees it; `target[key] = value` in a later copy then sets the prototype, and every key under it
 * is inherited unchecked. The rule and the breadth-first walk (no recursion, so no nesting depth overflows the stack)
 * follow secure-json-parse `filter` (index.js 59-98, BSD-3-Clause) with both actions set to `error`. Unlike there, a
 * `constructor` that is `null` is data, not a TypeError. The walk visits each value of the parsed body once.
 */
function prototypeKeyPointers(document: unknown): string[] {
  const found: string[] = [];
  let level: Array<{ node: unknown; pointer: string }> = [{ node: document, pointer: '' }];
  while (level.length > 0) {
    const next: typeof level = [];
    for (const { node, pointer } of level) {
      if (typeof node !== 'object' || node === null) continue;
      const record = node as Record<string, unknown>;
      if (Object.hasOwn(record, '__proto__')) found.push(`${pointer}/__proto__`);
      const ctor = Object.hasOwn(record, 'constructor') ? record.constructor : undefined;
      if (typeof ctor === 'object' && ctor !== null && Object.hasOwn(ctor, 'prototype')) found.push(`${pointer}/constructor`);
      for (const key of Object.keys(record)) next.push({ node: record[key], pointer: `${pointer}/${pointerSegment(key)}` });
    }
    level = next;
  }
  return found;
}

/** A JSON pointer as the dotted name `invalidParams` uses. */
function paramName(pointer: string): string {
  return pointer.replace(/^\//, '').replace(/\//g, '.');
}

/**
 * Drops, for each `oneOf` that failed, the "wrong type" errors of its branches and its summary "must match exactly one schema"
 * error when some branch took the value by type and failed on its content (an error at the value or below it that is not a type
 * error of a branch), so only the errors of the branch that fits the value remain. A value no branch takes by type keeps every
 * error.
 */
function withoutUnionNoise(errors: readonly ErrorObject[]): ErrorObject[] {
  const noise = new Set<ErrorObject>();
  for (const union of errors.filter((e) => e.keyword === 'oneOf')) {
    const typeMisses = errors.filter((e) => e.keyword === 'type' && e.instancePath === union.instancePath && /\/oneOf\/\d+\/type$/.test(e.schemaPath));
    const contentErrors = errors.filter(
      (e) => e !== union && !typeMisses.includes(e) && (e.instancePath === union.instancePath || e.instancePath.startsWith(`${union.instancePath}/`))
    );
    if (typeMisses.length === 0 || contentErrors.length === 0) continue;
    noise.add(union);
    for (const miss of typeMisses) noise.add(miss);
  }
  return errors.filter((e) => !noise.has(e));
}

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

  const prototypeKeys = prototypeKeyPointers(data);
  if (prototypeKeys.length > 0) {
    return validationProblem(
      prototypeKeys.map((pointer) => ({ name: paramName(pointer), reason: PROTOTYPE_KEY_REASON })),
      false,
      instanceUri
    );
  }

  const isValid = validator(data);
  if (isValid) {
    return { ok: true, data: data as T };
  }

  const errors = withoutUnionNoise(validator.errors || []);
  let isPlannedOption = false;

  const invalidParams: Array<{ name: string; reason: string }> = errors.map((err) => {
    const isPlanned =
      err.keyword === 'x-easyconvert-status' ||
      err.message === 'option_not_supported' ||
      (err.params as any)?.code === 'option_not_supported';
    if (isPlanned) {
      isPlannedOption = true;
    }

    let fieldPath = paramName(err.instancePath);
    const missingProp = (err.params as any)?.missingProperty;
    const keyParams = err.params as { additionalProperty?: string; serverOnlyProperty?: string };
    const additionalProp = keyParams.additionalProperty ?? keyParams.serverOnlyProperty;

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

  return validationProblem(invalidParams, isPlannedOption, instanceUri);
}

/** The 422 that refuses a request, naming each offending field. */
function validationProblem(
  invalidParams: Array<{ name: string; reason: string }>,
  isPlannedOption: boolean,
  instanceUri: string
): { ok: false; problem: ProblemDetails; response: NextResponse } {
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
