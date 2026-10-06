import { ALL_API_KEY_SCOPES } from '@/lib/api-keys/types';
import { FRAME_USED_HEADER, SOURCE_FRAMES_HEADER } from '@/lib/api/frame-headers';
import { PDFA_VALIDATION_PROBLEM_TYPE, PDF_POSTPROCESS_PROBLEM_TYPE } from '@/lib/api/problem-details';
import {
  DEFAULT_MAX_INPUT_PIXELS,
  MAX_INPUT_PIXELS_CEILING,
  MAX_INPUT_PIXELS_ENV,
} from '@/lib/conversions/image-input-limit-config';

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

/**
 * What a PDF/A request adds to the problems of a convert route: a 422 problem that carries the
 * requested profile and the failed veraPDF rule IDs, and a 503 when veraPDF is not installed.
 */
export const PDFA_PROBLEM_DESCRIPTION =
  `A PDF/A output failed validation (problem type \`${PDFA_VALIDATION_PROBLEM_TYPE}\`, with the requested \`profile\` and the veraPDF \`failedRules\`), ` +
  `or the PDF/A conversion could not complete on the document (problem type \`${PDF_POSTPROCESS_PROBLEM_TYPE}\`).`;
export const PDFA_ENGINE_NOTE = ' A PDF/A request also needs veraPDF, which validates every PDF/A output.';

const PDFA_PROBLEM_SCHEMA = {
  oneOf: [{ $ref: '#/components/schemas/ProblemDetails' }, { $ref: '#/components/schemas/PdfaValidationProblem' }],
};

/** Problem response whose body is a plain problem or the PDF/A validation problem. */
export const createPdfaProblemResponse = (description: string) => ({
  description,
  content: {
    'application/problem+json': { schema: PDFA_PROBLEM_SCHEMA },
    'application/json': { schema: PDFA_PROBLEM_SCHEMA },
  },
});
const PIXELS_PER_MEGAPIXEL = 1_000_000;

/** Description of the 413 answer for a picture that declares more pixels than the input limit. */
export const INPUT_PIXEL_LIMIT_DESCRIPTION = `Payload Too Large: an image (or an image inside the document) declares more than ${
  DEFAULT_MAX_INPUT_PIXELS / PIXELS_PER_MEGAPIXEL
} megapixels by default, or a lower limit of a conversion path that holds the whole picture in memory. The detail states the limit. Operators can change the default with ${MAX_INPUT_PIXELS_ENV} (at most ${MAX_INPUT_PIXELS_CEILING} pixels).`;

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

/** The `options` form field of the convert routes, with the document options spelled out. */
export const CONVERT_OPTIONS_DESCRIPTION =
  'JSON-serialized conversion options (e.g. quality, resolution, delimiter). Document options: ' +
  '`layout` (PDF to TXT: keep the physical layout), `imageDpi` and `jpegQuality` (Office to PDF: opt-in image compression), ' +
  'and `pdfa` or `pdfStandard` (PDF/A output, validated with veraPDF; a request that names no level is answered at pdfa-2b).';

/** Form fields of a single-file conversion request. */
export const CONVERT_FORM_PROPERTIES = {
  file: { type: 'string', format: 'binary', description: 'Source input file binary (up to 100 MB).' },
  targetFormat: { type: 'string', description: 'Target format extension or identifier (e.g., "pdf", "step", "webp").' },
  sourceFormat: { type: 'string', description: 'Explicit source format override. If omitted, inferred from filename.' },
  options: { type: 'string', description: CONVERT_OPTIONS_DESCRIPTION },
};
