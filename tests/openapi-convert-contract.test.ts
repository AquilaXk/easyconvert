import { describe, expect, it } from 'vitest';
import { GET as getOpenApiSpec } from '../src/app/api/openapi.json/route';
import { buildRateLimitHeaders } from '../src/lib/api/rate-limit';
import { conversionRefusalResponse } from '../src/lib/api/conversion-refusal-response';
import { concurrencyLimitResponse } from '../src/lib/queue/concurrency-limit';
import { PROBLEM_TYPE_BASE, QUOTA_EXCEEDED_PROBLEM_TYPE } from '../src/lib/refusal-codes';
import { RATE_LIMITED_PROBLEM_TYPE } from '../src/lib/api/problem-details';
import { typedFailureCodesByStatus } from './helpers/typed-failure-statuses';

/**
 * The OpenAPI document of the convert routes against the code it describes. The oracles are the error classes under src/ (read
 * with the TypeScript compiler API, tests/helpers/typed-failure-statuses.ts) for the 400, 422 and 503 `code` values, and the
 * answers the 429 builders actually produce for the headers and the body.
 */

const V1_CONVERT = '/api/v1/convert';
const WEB_CONVERT = '/api/convert';
const BATCH_CONVERT = '/api/convert/batch';
const CONVERT_ROUTES = [V1_CONVERT, WEB_CONVERT, BATCH_CONVERT];
const HTTP_BAD_REQUEST = 400;
const HTTP_UNPROCESSABLE = 422;
const HTTP_UNAVAILABLE = 503;
const HTTP_TOO_MANY = 429;

/** A 422 the routes answer for a typed failure but without its `code` (the collision branch builds a plain problem). */
const UNCODED_422 = ['archive_entry_collision'];
/** The page range check of `/api/convert` answers its own `invalid_pages` refusal with 422 (the other routes leave it to the class's 400). */
const WEB_ONLY_422 = ['invalid_pages'];
const CONCURRENCY_LIMIT_PROBLEM_TYPE = `${PROBLEM_TYPE_BASE}concurrency-limit`;

interface SchemaPart {
  allOf?: SchemaPart[];
  oneOf?: SchemaPart[];
  properties?: Record<string, { enum?: string[] }>;
}

type Spec = { paths: Record<string, { post: { responses: Record<string, { description: string; headers?: Record<string, unknown>; content: Record<string, { schema: SchemaPart }> }> } }> };

async function loadSpec(): Promise<Spec> {
  return (await getOpenApiSpec()).json();
}

/** Every `code` enum in the schemas of a response, whichever media type carries it (the PDF/A branch of a oneOf carries none). */
function documentedCodes(spec: Spec, route: string, status: number): string[] {
  const schemas = Object.values(spec.paths[route].post.responses[String(status)].content).map((media) => media.schema);
  const parts = schemas.flatMap((schema) => [schema, ...(schema.oneOf ?? [])]).flatMap((part) => part.allOf ?? [part]);
  return [...new Set(parts.flatMap((part) => part.properties?.code?.enum ?? []))].sort();
}

const derived = (status: number): string[] => typedFailureCodesByStatus().get(status) ?? [];
const sorted = (...lists: string[][]): string[] => [...new Set(lists.flat())].sort();

describe('the code values of the convert routes follow the error classes', () => {
  it.each([V1_CONVERT, BATCH_CONVERT])('%s lists the code of every typed 400, 422 and 503', async (route) => {
    const spec = await loadSpec();
    expect(documentedCodes(spec, route, HTTP_BAD_REQUEST)).toEqual(derived(HTTP_BAD_REQUEST));
    expect(sorted(documentedCodes(spec, route, HTTP_UNPROCESSABLE), UNCODED_422)).toEqual(derived(HTTP_UNPROCESSABLE));
    expect(documentedCodes(spec, route, HTTP_UNAVAILABLE)).toEqual(derived(HTTP_UNAVAILABLE));
  });

  it('/api/convert lists every typed 422 and 503, and the 400 codes of the classes among its own', async () => {
    const spec = await loadSpec();
    expect(documentedCodes(spec, WEB_CONVERT, HTTP_UNPROCESSABLE)).toEqual(sorted(derived(HTTP_UNPROCESSABLE), WEB_ONLY_422));
    expect(documentedCodes(spec, WEB_CONVERT, HTTP_UNAVAILABLE)).toEqual(derived(HTTP_UNAVAILABLE));
    expect(documentedCodes(spec, WEB_CONVERT, HTTP_BAD_REQUEST)).toEqual(expect.arrayContaining(derived(HTTP_BAD_REQUEST)));
  });

  it('knows the 422 classes it was written for', () => {
    expect(derived(HTTP_UNPROCESSABLE)).toEqual(expect.arrayContaining(['password_required', 'encrypted_input', 'archive_entry_collision', 'missing_volume']));
  });
});

describe('the 429 of the convert routes is the answer the code sends', () => {
  const exhausted = { tier: 'free' as const, dailyLimit: 10, usedToday: 10, remaining: 0, resetAt: Date.now() + 3_600_000 };

  it.each(CONVERT_ROUTES)('%s documents every header of a refused day, and the problem types by name', async (route) => {
    const spec = await loadSpec();
    const response = spec.paths[route].post.responses[String(HTTP_TOO_MANY)];
    expect(Object.keys(response.headers ?? {}).sort()).toEqual(Object.keys(buildRateLimitHeaders(exhausted)).sort());
    for (const type of [RATE_LIMITED_PROBLEM_TYPE, QUOTA_EXCEEDED_PROBLEM_TYPE, CONCURRENCY_LIMIT_PROBLEM_TYPE]) {
      expect(response.description).toContain(type);
    }
  });

  it('sends no Retry-After while conversions are left, which the document says', async () => {
    expect(buildRateLimitHeaders({ ...exhausted, remaining: 3 })['Retry-After']).toBeUndefined();
    const spec = await loadSpec();
    const retryAfter = spec.paths[V1_CONVERT].post.responses[String(HTTP_TOO_MANY)].headers?.['Retry-After'] as { description: string };
    expect(retryAfter.description).toMatch(/except a `quota-exceeded` that leaves some conversions/);
  });

  it('documents the numbers of a quota refusal and the limit of a concurrency refusal', async () => {
    const quota = await conversionRefusalResponse({ reason: 'used-up', error: 'used up', usage: exhausted, requiredUnits: 1 }, V1_CONVERT).json();
    const concurrency = await concurrencyLimitResponse(5, V1_CONVERT).json();
    const spec = await loadSpec();
    const schema = spec.paths[V1_CONVERT].post.responses[String(HTTP_TOO_MANY)].content['application/problem+json'].schema;
    const documented = Object.keys(schema.allOf?.find((part) => part.properties)?.properties ?? {});
    const extensions = (body: Record<string, unknown>) => Object.keys(body).filter((key) => !['type', 'title', 'status', 'detail', 'instance', 'success', 'error'].includes(key));
    expect(extensions(quota).every((key) => documented.includes(key))).toBe(true);
    expect(extensions(concurrency).every((key) => documented.includes(key))).toBe(true);
    expect(quota.type).toBe(QUOTA_EXCEEDED_PROBLEM_TYPE);
    expect(concurrency.type).toBe(CONCURRENCY_LIMIT_PROBLEM_TYPE);
  });

  it('documents the Retry-After of the concurrency refusal as the code sends it', async () => {
    const retryAfter = concurrencyLimitResponse(5, V1_CONVERT).headers.get('Retry-After');
    expect(retryAfter).toBe('5');
    const spec = await loadSpec();
    expect(spec.paths[V1_CONVERT].post.responses[String(HTTP_TOO_MANY)].description).toContain('`Retry-After` 5');
  });
});
