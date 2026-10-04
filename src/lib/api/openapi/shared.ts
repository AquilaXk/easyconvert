import { ALL_API_KEY_SCOPES } from '@/lib/api-keys/types';

/** Assignable API key scopes, including the admin wildcard. */
export const API_KEY_SCOPES = [...ALL_API_KEY_SCOPES, '*'];

/** RFC 9457 problem details response; legacy clients may still request plain JSON. */
export const createProblemResponse = (description: string) => ({
  description,
  content: {
    'application/problem+json': { schema: { $ref: '#/components/schemas/ProblemDetails' } },
    'application/json': { schema: { $ref: '#/components/schemas/ProblemDetails' } },
  },
});

/** Plain `{ success: false, error }` response used by routes that predate problem details. */
export const createErrorResponse = (description: string) => ({
  description,
  content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } },
});

/** JSON response with an inline object schema. */
export const createJsonResponse = (description: string, properties: Record<string, unknown>) => ({
  description,
  content: { 'application/json': { schema: { type: 'object', properties } } },
});

export const createPathParameter = (name: string, description: string) => ({
  name,
  in: 'path',
  required: true,
  schema: { type: 'string' },
  description,
});

/** Security requirement accepted by both API key and bearer authentication. */
export const requireScope = (...scopes: string[]) => [
  { ApiKeyAuth: scopes },
  { BearerAuth: scopes },
];

export const SESSION_ONLY = [{ SessionCookie: [] }];
export const PUBLIC_ACCESS: Record<string, string[]>[] = [];
