import {
  createJsonResponse,
  createPathParameter,
  createProblemResponse,
  jsonBody,
  requireScope,
} from '../shared';
import type { StorageProviderType } from '@/lib/storage/credentials-vault';
import { UNAVAILABLE_STORAGE_PROVIDERS } from '@/lib/storage/adapters';

/** Every credential provider type; the Record type makes the compiler flag a missing one. */
const ALL_STORAGE_PROVIDER_TYPES: Record<StorageProviderType, true> = {
  s3: true,
  gcs: true,
  'azure-blob': true,
  sftp: true,
  webdav: true,
  http: true,
};

/** Provider types that can be registered: unavailable providers are refused by the route. */
const STORAGE_PROVIDER_TYPES = Object.keys(ALL_STORAGE_PROVIDER_TYPES).filter(
  (type) => !UNAVAILABLE_STORAGE_PROVIDERS.has(type)
);

const BYOS_PROVIDER_UNAVAILABLE_TYPE = 'https://api.easyconvert.io/problems/byos-provider-unavailable';
const HTTP_BAD_REQUEST = 400;

const providerUnavailableExample = {
  summary: 'Storage provider unavailable',
  value: {
    type: BYOS_PROVIDER_UNAVAILABLE_TYPE,
    title: 'Storage Provider Unavailable',
    status: HTTP_BAD_REQUEST,
    detail: 'Storage provider "<providerType>" is not available for customer storage yet.',
    instance: '/api/v1/storage/credentials',
  },
};

const providerUnavailableContent = {
  schema: { $ref: '#/components/schemas/ProblemDetails' },
  examples: { providerUnavailable: providerUnavailableExample },
};

const registerBadRequestResponse = {
  description: `Invalid JSON, missing fields, or provider type mismatch. A provider type without a working adapter is refused with problem type \`${BYOS_PROVIDER_UNAVAILABLE_TYPE}\`.`,
  content: {
    'application/problem+json': providerUnavailableContent,
    'application/json': providerUnavailableContent,
  },
};

/** Stored object download and upload operations. */
export const storagePaths = {
  '/api/storage/file/{key}': {
    get: {
      summary: 'Download Stored File',
      description:
        'Downloads a stored file by the key in a `downloadUrl`. Outputs owned by a user (`conversions/{userId}/...` keys and results of jobs created with credentials) are served only to that user through a session or an API key with the "storage:download" scope; any other caller gets 404 so keys cannot be probed. Anonymous job results keep capability-URL access. Every file response is sent with `Cache-Control: private, no-store` and `X-Content-Type-Options: nosniff`. A single byte range is supported; multi-range requests return the full file.',
      operationId: 'downloadStoredFile',
      security: [...requireScope('storage:download'), {}],
      parameters: [
        createPathParameter('key', 'URL-encoded storage key, as returned in `downloadUrl`.'),
        {
          name: 'Range',
          in: 'header',
          required: false,
          schema: { type: 'string', example: 'bytes=0-1023' },
          description: 'One RFC 9110 byte range: `bytes=first-last`, `bytes=first-`, or suffix `bytes=-length`.',
        },
      ],
      responses: {
        '200': {
          description: 'Full file content.',
          headers: {
            'Content-Disposition': {
              schema: { type: 'string' },
              description: 'Attachment with an ASCII `filename` and a UTF-8 `filename*`.',
            },
            ETag: { schema: { type: 'string' } },
            'Cache-Control': { schema: { type: 'string', example: 'private, no-store' } },
          },
          content: {
            'application/octet-stream': { schema: { type: 'string', format: 'binary' } },
          },
        },
        '206': {
          description: 'Requested byte range.',
          headers: {
            'Content-Range': { schema: { type: 'string', example: 'bytes 0-1023/4096' } },
          },
          content: {
            'application/octet-stream': { schema: { type: 'string', format: 'binary' } },
          },
        },
        '403': {
          description: 'The owner\'s API key lacks the "storage:download" scope.',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } },
        },
        '404': {
          description: 'Object not found, expired, owned by another user, or a job result whose job cannot be read.',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } },
        },
        '416': {
          description: 'Malformed or unsatisfiable range.',
          headers: {
            'Content-Range': { schema: { type: 'string', example: 'bytes */4096' } },
          },
          content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } },
        },
        '429': {
          description: 'The owner\'s API key exceeded its burst rate limit; see `Retry-After`.',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } },
        },
      },
    },
  },
  '/api/v1/storage/credentials': {
    post: {
      summary: 'Register Storage Credentials',
      description:
        'Stores customer storage credentials encrypted at rest and returns a `credentialRef` for import and export tasks. Raw credentials are never returned.',
      operationId: 'createStorageCredentialV1',
      security: requireScope('convert:write'),
      requestBody: jsonBody({
        providerType: { type: 'string', enum: STORAGE_PROVIDER_TYPES },
        credentials: {
          type: 'object',
          required: ['type'],
          additionalProperties: true,
          properties: { type: { type: 'string', enum: STORAGE_PROVIDER_TYPES } },
          description: 'Provider-specific credentials; `type` must equal `providerType`.',
        },
        name: { type: 'string' },
        ttlSeconds: { type: 'integer', minimum: 1 },
      }, ['providerType', 'credentials']),
      responses: {
        '201': createJsonResponse('Credentials stored.', {
          success: { type: 'boolean' },
          credentialRef: { type: 'string', pattern: '^cred_' },
          providerType: { type: 'string' },
          name: { type: 'string' },
          expiresAt: { type: 'number' },
        }),
        '400': registerBadRequestResponse,
        '401': createProblemResponse('Authentication required.'),
        '500': createProblemResponse('Credentials could not be stored.'),
      },
    },
    get: {
      summary: 'List Storage Credentials',
      description: 'Lists the caller\'s stored credential references without secret material.',
      operationId: 'listStorageCredentialsV1',
      security: requireScope('convert:read'),
      responses: {
        '200': createJsonResponse('Credential references.', {
          success: { type: 'boolean' },
          credentials: { type: 'array', items: { type: 'object' } },
        }),
        '401': createProblemResponse('Authentication required.'),
        '500': createProblemResponse('Credentials could not be listed.'),
      },
    },
  },
  '/api/v1/storage/credentials/{id}': {
    delete: {
      summary: 'Delete Storage Credentials',
      description: 'Deletes one of the caller\'s stored credentials.',
      operationId: 'deleteStorageCredentialV1',
      security: requireScope('convert:write'),
      parameters: [createPathParameter('id', 'Credential reference (`cred_...`).')],
      responses: {
        '204': { description: 'Credentials deleted.' },
        '400': createProblemResponse('Identifier is not a credential reference.'),
        '401': createProblemResponse('Authentication required.'),
        '404': createProblemResponse('Credentials not found or owned by another user.'),
      },
    },
  },
};
