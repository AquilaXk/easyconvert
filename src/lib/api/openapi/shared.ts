import { ALL_API_KEY_SCOPES } from '@/lib/api-keys/types';
import { FRAME_USED_HEADER, SOURCE_FRAMES_HEADER } from '@/lib/api/frame-headers';

/** Assignable API key scopes, including the admin wildcard. */
export const API_KEY_SCOPES = [...ALL_API_KEY_SCOPES, '*'];

/** Response headers describing the frames of a multi-frame image source (animated GIF/WebP/APNG, multi-page TIFF/HEIF). */
export const FRAME_RESPONSE_HEADERS = {
  [SOURCE_FRAMES_HEADER]: {
    description:
      'Number of frames or pages the source image holds. Sent only when the source has more than one. A still output of an animated source uses frame 1 unless `page` selects another; a multi-page source converted to a still target is packaged as a ZIP with one image per page.',
    schema: { type: 'integer', minimum: 2 },
  },
  [FRAME_USED_HEADER]: {
    description: '1-based frame or page a single-image output was taken from. Sent only when one frame was chosen.',
    schema: { type: 'integer', minimum: 1 },
  },
} as const;

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

export const IDEMPOTENCY_KEY_PARAMETER = {
  name: 'Idempotency-Key',
  in: 'header',
  required: false,
  description: 'Optional 1-255 character printable ASCII idempotency key for safe retries.',
  schema: { $ref: '#/components/schemas/IdempotencyKeyHeader' },
};

type SchemaProperties = Record<string, unknown>;

const objectSchema = (properties: SchemaProperties, required?: string[]) => ({
  type: 'object',
  ...(required ? { required } : {}),
  properties,
});

/** Required multipart/form-data request body with an object schema. */
export const multipartBody = (properties: SchemaProperties, required?: string[]) => ({
  required: true,
  content: { 'multipart/form-data': { schema: objectSchema(properties, required) } },
});

/** Required JSON request body with an object schema. */
export const jsonBody = (properties: SchemaProperties, required?: string[]) => ({
  required: true,
  content: { 'application/json': { schema: objectSchema(properties, required) } },
});

/** Raw binary request body of the given media type. */
export const binaryBody = (mediaType: string, required: boolean) => ({
  required,
  content: { [mediaType]: { schema: { type: 'string', format: 'binary' } } },
});

/** Form fields of a single-file conversion request. */
export const CONVERT_FORM_PROPERTIES = {
  file: { type: 'string', format: 'binary', description: 'Source input file binary (up to 100 MB).' },
  targetFormat: { type: 'string', description: 'Target format extension or identifier (e.g., "pdf", "step", "webp").' },
  sourceFormat: { type: 'string', description: 'Explicit source format override. If omitted, inferred from filename.' },
  options: { type: 'string', description: 'JSON-serialized conversion options (e.g. quality, resolution, delimiter).' },
};
