import { createJsonResponse, createPathParameter, createProblemResponse, requireScope } from '../shared';

const TUS_VERSION = '1.0.0';

const tusResumableHeader = {
  name: 'Tus-Resumable',
  in: 'header',
  required: false,
  schema: { type: 'string', const: TUS_VERSION },
  description: 'Protocol version; any other value returns 412.',
};

const headerSchema = (description: string, schema: Record<string, unknown> = { type: 'string' }) => ({
  schema,
  description,
});

const tusPlainText = (description: string) => ({
  description,
  content: { 'text/plain': { schema: { type: 'string' } } },
});

const uploadIdParameter = createPathParameter('id', 'Upload session identifier from the `Location` header.');

const directPartSchema = {
  type: 'object',
  required: ['partNumber', 'etag'],
  properties: {
    partNumber: { type: 'integer', minimum: 1, maximum: 10000 },
    etag: { type: 'string' },
  },
};

/** Resumable (tus 1.0.0) and presigned direct multipart uploads. */
export const uploadPaths = {
  '/api/v1/uploads': {
    options: {
      summary: 'Discover Resumable Upload Capabilities',
      description: 'Returns the supported tus protocol version, extensions, maximum upload size, and checksum algorithm.',
      operationId: 'getUploadCapabilitiesV1',
      security: [],
      responses: {
        '204': {
          description: 'Capabilities are in the response headers.',
          headers: {
            'Tus-Resumable': headerSchema('Protocol version.', { type: 'string', const: TUS_VERSION }),
            'Tus-Version': headerSchema('Supported protocol versions.'),
            'Tus-Extension': headerSchema('`creation,creation-with-upload,termination,expiration,checksum`.'),
            'Tus-Max-Size': headerSchema('Maximum upload size in bytes.', { type: 'integer' }),
            'Tus-Checksum-Algorithm': headerSchema('Supported `Upload-Checksum` algorithms (`sha256`).'),
          },
        },
      },
    },
    post: {
      summary: 'Create Resumable Upload',
      description:
        'Creates a tus upload session. A request body sent with `Content-Type: application/offset+octet-stream` is stored as the first chunk (creation-with-upload). When the upload is complete, the response carries the storage key to use as `storageKey` in job requests. The `action` query parameter selects a legacy local multipart flow that is not part of the public contract.',
      operationId: 'createUploadV1',
      security: requireScope('convert:write'),
      parameters: [
        tusResumableHeader,
        {
          name: 'Upload-Length',
          in: 'header',
          required: true,
          schema: { type: 'integer', minimum: 0 },
          description: 'Total upload size in bytes; deferred length is not supported.',
        },
        {
          name: 'Upload-Metadata',
          in: 'header',
          required: false,
          schema: { type: 'string' },
          description: 'Comma-separated `key base64value` pairs, e.g. `filename`, `filetype`.',
        },
        {
          name: 'Upload-Checksum',
          in: 'header',
          required: false,
          schema: { type: 'string', example: 'sha256 47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=' },
          description: 'Checksum of the first chunk sent with creation-with-upload.',
        },
      ],
      requestBody: {
        required: false,
        content: { 'application/offset+octet-stream': { schema: { type: 'string', format: 'binary' } } },
      },
      responses: {
        '201': {
          description: 'Upload created.',
          headers: {
            Location: headerSchema('URL of the upload session.'),
            'Upload-Offset': headerSchema('Bytes received so far.', { type: 'integer' }),
            'Upload-Expires': headerSchema('RFC 9110 date after which the session expires.'),
            'EasyConvert-Storage-Key': headerSchema('Storage key, present once the upload is complete.'),
          },
        },
        '400': createProblemResponse('Missing or invalid `Upload-Length`, malformed checksum header, or body longer than the declared length.'),
        '401': createProblemResponse('Authentication required.'),
        '403': createProblemResponse('API key lacks the "convert:write" scope.'),
        '412': tusPlainText('Unsupported `Tus-Resumable` version.'),
        '413': createProblemResponse('`Upload-Length` exceeds `Tus-Max-Size`.'),
        '460': tusPlainText('First chunk does not match `Upload-Checksum`.'),
      },
    },
  },
  '/api/v1/uploads/{id}': {
    head: {
      summary: 'Get Resumable Upload Offset',
      description: 'Returns how many bytes the server has received, so an interrupted upload can resume.',
      operationId: 'getUploadOffsetV1',
      security: requireScope('convert:read'),
      parameters: [uploadIdParameter, tusResumableHeader],
      responses: {
        '200': {
          description: 'Current upload state.',
          headers: {
            'Upload-Offset': headerSchema('Bytes received so far.', { type: 'integer' }),
            'Upload-Length': headerSchema('Declared total size.', { type: 'integer' }),
            'Upload-Expires': headerSchema('RFC 9110 date after which the session expires.'),
            'Cache-Control': headerSchema('Always `no-store`.'),
          },
        },
        '401': createProblemResponse('Authentication required.'),
        '404': tusPlainText('Upload not found, expired, or owned by another user.'),
        '412': tusPlainText('Unsupported `Tus-Resumable` version.'),
      },
    },
    patch: {
      summary: 'Append Resumable Upload Chunk',
      description: 'Appends bytes at `Upload-Offset`. The chunk is streamed to storage without buffering it in memory.',
      operationId: 'appendUploadChunkV1',
      security: requireScope('convert:write'),
      parameters: [
        uploadIdParameter,
        tusResumableHeader,
        {
          name: 'Upload-Offset',
          in: 'header',
          required: true,
          schema: { type: 'integer', minimum: 0 },
          description: 'Must equal the current server offset.',
        },
        {
          name: 'Upload-Checksum',
          in: 'header',
          required: false,
          schema: { type: 'string' },
          description: '`sha256 <base64>` of this chunk; a mismatch discards the chunk.',
        },
      ],
      requestBody: {
        required: true,
        content: { 'application/offset+octet-stream': { schema: { type: 'string', format: 'binary' } } },
      },
      responses: {
        '204': {
          description: 'Chunk stored.',
          headers: {
            'Upload-Offset': headerSchema('New offset.', { type: 'integer' }),
            'Upload-Expires': headerSchema('RFC 9110 date after which the session expires.'),
            'EasyConvert-Storage-Key': headerSchema('Storage key, present once the upload is complete.'),
          },
        },
        '400': createProblemResponse('Missing or invalid `Upload-Offset`, or a failed write.'),
        '401': createProblemResponse('Authentication required.'),
        '404': tusPlainText('Upload not found, expired, or owned by another user.'),
        '409': tusPlainText('`Upload-Offset` does not match; the response `Upload-Offset` holds the expected value.'),
        '412': tusPlainText('Unsupported `Tus-Resumable` version.'),
        '415': tusPlainText('Content type is not `application/offset+octet-stream`.'),
        '460': tusPlainText('Chunk does not match `Upload-Checksum`.'),
      },
    },
    delete: {
      summary: 'Terminate Resumable Upload',
      description: 'Deletes the upload session and its partial data. Also accepts `direct/{uploadId}` to abort a direct upload.',
      operationId: 'terminateUploadV1',
      security: requireScope('convert:write'),
      parameters: [uploadIdParameter, tusResumableHeader],
      responses: {
        '204': { description: 'Upload terminated.' },
        '401': createProblemResponse('Authentication required.'),
        '404': tusPlainText('Upload not found, expired, or owned by another user.'),
        '412': tusPlainText('Unsupported `Tus-Resumable` version.'),
      },
    },
  },
  '/api/v1/uploads/direct': {
    post: {
      summary: 'Start Direct Multipart Upload',
      description: 'Creates a multipart upload and returns a presigned PUT URL for every part. Part URLs expire after 15 minutes.',
      operationId: 'createDirectUploadV1',
      security: requireScope('convert:write'),
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['filename', 'totalSize'],
              properties: {
                filename: { type: 'string' },
                totalSize: { type: 'integer', minimum: 0, description: 'Total size in bytes (at most 10 GiB).' },
                mimeType: { type: 'string', default: 'application/octet-stream' },
                partSize: { type: 'integer', description: 'Requested part size in bytes; at most 10,000 parts are allowed.' },
              },
            },
          },
        },
      },
      responses: {
        '200': createJsonResponse('Upload created with presigned part URLs.', {
          uploadId: { type: 'string' },
          key: { type: 'string' },
          partSize: { type: 'integer' },
          totalParts: { type: 'integer' },
          expiresAt: { type: 'number' },
          parts: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                partNumber: { type: 'integer' },
                uploadUrl: { type: 'string' },
                expiresAt: { type: 'number' },
              },
            },
          },
        }),
        '400': createProblemResponse('Missing filename or invalid size.'),
        '401': createProblemResponse('Authentication required.'),
        '413': createProblemResponse('Upload exceeds the size or part-count limit.'),
      },
    },
  },
  '/api/v1/uploads/direct/part': {
    put: {
      summary: 'Upload Direct Multipart Part',
      description: 'Uploads one part to a presigned URL from `createDirectUploadV1`. The URL signature authorizes the request; no API key is sent.',
      operationId: 'uploadDirectPartV1',
      security: [],
      parameters: [
        { name: 'uploadId', in: 'query', required: true, schema: { type: 'string' } },
        { name: 'partNumber', in: 'query', required: true, schema: { type: 'integer', minimum: 1, maximum: 10000 } },
        { name: 'key', in: 'query', required: false, schema: { type: 'string' } },
      ],
      requestBody: {
        required: true,
        content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } },
      },
      responses: {
        '200': {
          description: 'Part stored; keep the `ETag` for completion.',
          headers: { ETag: headerSchema('Part entity tag.') },
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  success: { type: 'boolean' },
                  partNumber: { type: 'integer' },
                  size: { type: 'integer' },
                  etag: { type: 'string' },
                },
              },
            },
          },
        },
        '400': createProblemResponse('Missing or invalid query parameters, or a failed write.'),
        '403': createProblemResponse('Missing, expired, or invalid URL signature.'),
        '404': createProblemResponse('Upload not found.'),
      },
    },
  },
  '/api/v1/uploads/direct/complete': {
    post: {
      summary: 'Complete Direct Multipart Upload',
      description: 'Assembles the parts, verifies their entity tags, and checks the file signature against the declared format.',
      operationId: 'completeDirectUploadV1',
      security: requireScope('convert:write'),
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['uploadId', 'parts'],
              properties: {
                uploadId: { type: 'string' },
                parts: { type: 'array', minItems: 1, items: directPartSchema },
              },
            },
          },
        },
      },
      responses: {
        '200': createJsonResponse('Upload assembled.', {
          location: { type: 'string' },
          key: { type: 'string' },
          size: { type: 'integer' },
          etag: { type: 'string' },
          storageKey: { type: 'string', description: 'Use as `storageKey` in job requests.' },
        }),
        '400': createProblemResponse('Invalid parts list or entity tag mismatch.'),
        '401': createProblemResponse('Authentication required.'),
        '404': createProblemResponse('Upload not found or owned by another user.'),
        '422': createProblemResponse('File content does not match its declared format; the object is deleted.'),
        '500': createProblemResponse('Assembled object is unavailable.'),
      },
    },
  },
  '/api/v1/uploads/direct/{id}': {
    delete: {
      summary: 'Abort Direct Multipart Upload',
      description: 'Aborts a direct multipart upload and deletes its parts.',
      operationId: 'abortDirectUploadV1',
      security: requireScope('convert:write'),
      parameters: [createPathParameter('id', 'Upload identifier.')],
      responses: {
        '204': { description: 'Upload aborted.' },
        '400': createProblemResponse('Missing upload identifier.'),
        '401': createProblemResponse('Authentication required.'),
        '404': createProblemResponse('Upload not found or owned by another user.'),
      },
    },
  },
};
