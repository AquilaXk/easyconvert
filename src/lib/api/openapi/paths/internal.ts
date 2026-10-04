import {
  CONVERT_FORM_PROPERTIES,
  PUBLIC_ACCESS,
  SESSION_ONLY,
  createErrorResponse,
  createJsonResponse,
  createPathParameter,
  createProblemResponse,
  multipartBody,
  requireScope,
} from '../shared';

/**
 * Routes that serve the web application. They are documented for completeness and
 * marked `x-internal` so generated SDKs and public reference docs leave them out.
 */

const INTERNAL = { 'x-internal': true };

const ANONYMOUS_OR_SCOPE = (scope: string) => [...requireScope(scope), {}];

const binaryResponse = (description: string, mediaType = 'application/octet-stream') => ({
  description,
  content: { [mediaType]: { schema: { type: 'string', format: 'binary' } } },
});

const credentialsBody = (extra: Record<string, unknown> = {}) => ({
  required: true,
  content: {
    'application/json': {
      schema: {
        type: 'object',
        required: ['email', 'password'],
        properties: {
          email: { type: 'string', format: 'email' },
          password: { type: 'string', minLength: 8, maxLength: 1024 },
          ...extra,
        },
      },
    },
  },
});

const sessionCookieHeader = {
  'Set-Cookie': { schema: { type: 'string' }, description: 'HttpOnly session cookie.' },
};

const sessionUserResponse = (description: string) => ({
  ...createJsonResponse(description, {
    success: { type: 'boolean' },
    user: { type: 'object' },
    token: { type: 'string' },
  }),
  headers: sessionCookieHeader,
});

const redirectResponse = (description: string) => ({
  description,
  headers: { Location: { schema: { type: 'string' } } },
});

const openApiDocumentResponse = {
  '200': {
    description: 'OpenAPI 3.1 document.',
    content: { 'application/json': { schema: { type: 'object' } } },
  },
};

export const internalPaths = {
  '/api/account/files': {
    get: {
      ...INTERNAL,
      summary: 'List Account Files',
      description: 'Lists the caller\'s retained conversion outputs with their remaining lifetime.',
      operationId: 'listAccountFiles',
      security: requireScope('storage:download'),
      responses: {
        '200': createJsonResponse('Retained files.', {
          success: { type: 'boolean' },
          files: { type: 'array', items: { type: 'object' } },
        }),
        '401': createErrorResponse('Authentication required.'),
      },
    },
  },
  '/api/account/files/{id}': {
    delete: {
      ...INTERNAL,
      summary: 'Delete Account File',
      description: 'Deletes one of the caller\'s retained conversion outputs.',
      operationId: 'deleteAccountFile',
      security: requireScope('storage:download'),
      parameters: [createPathParameter('id', 'File record identifier.')],
      responses: {
        '200': createJsonResponse('File deleted.', { success: { type: 'boolean' }, message: { type: 'string' } }),
        '400': createErrorResponse('Missing identifier.'),
        '401': createErrorResponse('Authentication required.'),
        '404': createErrorResponse('File not found or owned by another user.'),
      },
    },
  },
  '/api/auth/google/url': {
    get: {
      ...INTERNAL,
      summary: 'Start OAuth Sign-In',
      description: 'Returns the authorization URL and binds the OAuth state to the browser with an HttpOnly cookie.',
      operationId: 'getOAuthAuthorizationUrl',
      security: PUBLIC_ACCESS,
      responses: {
        '200': {
          ...createJsonResponse('Authorization URL.', { success: { type: 'boolean' }, url: { type: 'string' } }),
          headers: { 'Set-Cookie': { schema: { type: 'string' }, description: 'OAuth state cookie.' } },
        },
        '500': createErrorResponse('OAuth is not configured.'),
      },
    },
  },
  '/api/auth/google/callback': {
    get: {
      ...INTERNAL,
      summary: 'Complete OAuth Sign-In',
      description: 'Verifies the OAuth state cookie, exchanges the code, and redirects to the dashboard with a session cookie, or to `/auth?error=...`.',
      operationId: 'completeOAuthSignIn',
      security: PUBLIC_ACCESS,
      parameters: [
        { name: 'code', in: 'query', required: false, schema: { type: 'string' } },
        { name: 'state', in: 'query', required: false, schema: { type: 'string' } },
      ],
      responses: {
        '307': redirectResponse('Redirect to the dashboard on success or to the sign-in page with an error code.'),
      },
    },
  },
  '/api/auth/login': {
    post: {
      ...INTERNAL,
      summary: 'Sign In',
      operationId: 'login',
      security: PUBLIC_ACCESS,
      requestBody: credentialsBody(),
      responses: {
        '200': sessionUserResponse('Signed in.'),
        '400': createErrorResponse('Invalid JSON or missing credentials.'),
        '401': createErrorResponse('Invalid email address or password.'),
        '429': {
          description: 'Too many failed attempts; see `Retry-After`.',
          headers: { 'Retry-After': { schema: { type: 'integer' } } },
        },
        '500': createErrorResponse('Sign-in failed.'),
      },
    },
  },
  '/api/auth/logout': {
    post: {
      ...INTERNAL,
      summary: 'Sign Out',
      description: 'Revokes the current session token, if any, and clears the session cookie.',
      operationId: 'logout',
      security: PUBLIC_ACCESS,
      responses: {
        '200': {
          ...createJsonResponse('Signed out.', { success: { type: 'boolean' }, message: { type: 'string' } }),
          headers: sessionCookieHeader,
        },
      },
    },
  },
  '/api/auth/me': {
    get: {
      ...INTERNAL,
      summary: 'Get Current User',
      operationId: 'getCurrentUser',
      security: SESSION_ONLY,
      responses: {
        '200': createJsonResponse('Signed-in user.', { success: { type: 'boolean' }, user: { type: 'object' } }),
        '401': createErrorResponse('Not signed in.'),
      },
    },
  },
  '/api/auth/register': {
    post: {
      ...INTERNAL,
      summary: 'Register Account',
      operationId: 'register',
      security: PUBLIC_ACCESS,
      requestBody: credentialsBody({ name: { type: 'string' } }),
      responses: {
        '200': sessionUserResponse('Account created and signed in.'),
        '400': createErrorResponse('Invalid JSON, email, or password.'),
        '409': createErrorResponse('Email address already registered.'),
        '500': createErrorResponse('Registration failed.'),
      },
    },
  },
  '/api/convert': {
    post: {
      ...INTERNAL,
      summary: 'Convert File (Web Application)',
      description: 'Converts one file and streams the result without retaining it. Anonymous callers use the IP quota.',
      operationId: 'convertFileInternal',
      security: ANONYMOUS_OR_SCOPE('convert:write'),
      requestBody: multipartBody(CONVERT_FORM_PROPERTIES, ['file', 'targetFormat']),
      responses: {
        '200': binaryResponse('Converted file.'),
        '400': createErrorResponse('Invalid input, unsupported conversion, or spoofed file.'),
        '401': createProblemResponse('Authentication required.'),
        '422': createErrorResponse('Page count exceeds the tier limit.'),
        '429': createProblemResponse('Quota exhausted.'),
        '500': createErrorResponse('Conversion failed.'),
      },
    },
  },
  '/api/convert/batch': {
    post: {
      ...INTERNAL,
      summary: 'Convert Files in Batch (Web Application)',
      description: 'Converts several files and returns them as one ZIP archive.',
      operationId: 'convertBatchInternal',
      security: ANONYMOUS_OR_SCOPE('convert:write'),
      requestBody: multipartBody({
        files: { type: 'array', items: { type: 'string', format: 'binary' }, description: 'Up to 100 MB in total.' },
        targetFormats: { type: 'string', description: 'JSON map of filename to target format; `default` applies to the rest.' },
        options: { type: 'string', description: 'JSON-serialized conversion options.' },
      }, ['files']),
      responses: {
        '200': binaryResponse('ZIP archive of converted files.', 'application/zip'),
        '400': createErrorResponse('No files, invalid input, or nothing could be converted.'),
        '401': createProblemResponse('Authentication required.'),
        '429': createProblemResponse('Quota exhausted.'),
        '500': createErrorResponse('Conversion failed.'),
      },
    },
  },
  '/api/fetch-url': {
    post: {
      ...INTERNAL,
      summary: 'Fetch Remote File',
      description: 'Downloads a public HTTP(S) file for conversion. Every redirect hop is checked against private address ranges.',
      operationId: 'fetchRemoteFile',
      security: ANONYMOUS_OR_SCOPE('convert:write'),
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: { type: 'object', required: ['url'], properties: { url: { type: 'string', format: 'uri' } } },
          },
        },
      },
      responses: {
        '200': binaryResponse('Remote file content; `X-Filename` holds the URI-encoded name.'),
        '400': createErrorResponse('Missing or invalid URL, or the remote server returned 4xx.'),
        '401': createProblemResponse('Authentication required.'),
        '403': createErrorResponse('URL resolves to a private address.'),
        '413': createErrorResponse('Remote file exceeds 100 MB.'),
        '502': createErrorResponse('Redirect failure, remote 5xx, or empty body.'),
      },
    },
  },
  '/api/health': {
    get: {
      ...INTERNAL,
      summary: 'Health Check',
      operationId: 'getHealth',
      security: PUBLIC_ACCESS,
      responses: {
        '200': createJsonResponse('Service is running.', {
          status: { type: 'string' },
          service: { type: 'string' },
          version: { type: 'string' },
          timestamp: { type: 'string' },
          supportedFormatsCount: { type: 'integer' },
          domainsCount: { type: 'integer' },
          features: { type: 'object' },
        }),
      },
    },
  },
  '/api/queue/jobs': {
    post: {
      ...INTERNAL,
      summary: 'Enqueue Conversion Job (Web Application)',
      operationId: 'enqueueJobInternal',
      security: ANONYMOUS_OR_SCOPE('convert:write'),
      requestBody: {
        required: true,
        content: {
          'multipart/form-data': {
            schema: {
              type: 'object',
              required: ['targetFormat'],
              properties: {
                file: { type: 'string', format: 'binary' },
                targetFormat: { type: 'string' },
                options: { type: 'string' },
                storageKey: { type: 'string' },
              },
            },
          },
          'application/json': {
            schema: {
              type: 'object',
              required: ['targetFormat'],
              properties: {
                filename: { type: 'string' },
                targetFormat: { type: 'string' },
                options: { type: 'object' },
                storageKey: { type: 'string' },
                inputBufferBase64: { type: 'string' },
                fileSize: { type: 'integer' },
              },
            },
          },
        },
      },
      responses: {
        '200': createJsonResponse('Job enqueued.', {
          success: { type: 'boolean' },
          jobId: { type: 'string' },
          status: { type: 'string' },
          progress: { type: 'number' },
          createdAt: { type: 'number' },
          queue: { type: 'string' },
        }),
        '400': createErrorResponse('Missing target format or invalid input.'),
        '401': createErrorResponse('Authentication required.'),
        '404': createErrorResponse('Storage object not found or not usable by the caller.'),
        '500': createErrorResponse('Enqueue failed.'),
      },
    },
    get: {
      ...INTERNAL,
      summary: 'List Queue Jobs (Web Application)',
      operationId: 'listJobsInternal',
      security: requireScope('convert:read'),
      parameters: [
        {
          name: 'status',
          in: 'query',
          required: false,
          schema: { type: 'string', enum: ['waiting', 'active', 'completed', 'failed', 'delayed', 'cancelled'] },
        },
      ],
      responses: {
        '200': createJsonResponse('Up to 50 jobs.', {
          success: { type: 'boolean' },
          total: { type: 'integer' },
          jobs: { type: 'array', items: { type: 'object' } },
        }),
        '400': createErrorResponse('Invalid status filter.'),
        '401': createErrorResponse('Authentication required.'),
      },
    },
  },
  '/api/queue/jobs/{id}': {
    get: {
      ...INTERNAL,
      summary: 'Get Queue Job (Web Application)',
      description: 'Returns job state, or a Server-Sent Events stream with `?stream=true` or `Accept: text/event-stream`.',
      operationId: 'getJobInternal',
      security: ANONYMOUS_OR_SCOPE('convert:read'),
      parameters: [
        createPathParameter('id', 'Job identifier.'),
        { name: 'stream', in: 'query', required: false, schema: { type: 'string', enum: ['true'] } },
      ],
      responses: {
        '200': {
          description: 'Job state, or an event stream that closes on a terminal state.',
          content: {
            'application/json': { schema: { type: 'object' } },
            'text/event-stream': { schema: { type: 'string' } },
          },
        },
        '404': createErrorResponse('Job not found or owned by another user.'),
      },
    },
    delete: {
      ...INTERNAL,
      summary: 'Cancel Queue Job (Web Application)',
      operationId: 'cancelJobInternal',
      security: ANONYMOUS_OR_SCOPE('convert:write'),
      parameters: [createPathParameter('id', 'Job identifier.')],
      responses: {
        '200': createJsonResponse('Job cancelled.', { success: { type: 'boolean' }, message: { type: 'string' } }),
        '404': createErrorResponse('Job not found or owned by another user.'),
        '409': createErrorResponse('Job can no longer be cancelled.'),
      },
    },
  },
  '/api/queue/stats': {
    get: {
      ...INTERNAL,
      summary: 'Get Queue Statistics',
      operationId: 'getQueueStats',
      security: PUBLIC_ACCESS,
      responses: {
        '200': createJsonResponse('Queue counts and process statistics.', {
          success: { type: 'boolean' },
          queue: { type: 'string' },
          counts: { type: 'object' },
          storage: { type: 'object' },
          system: { type: 'object' },
        }),
      },
    },
  },
  '/api/storage/multipart': {
    post: {
      ...INTERNAL,
      summary: 'Legacy Multipart Upload',
      description:
        'Web application upload flow selected by `action`: `initiate`, `chunk` (raw body with `x-upload-id` and `x-part-number`), `complete`, `abort`, or `presign`. Public clients use `/api/v1/uploads`.',
      operationId: 'legacyMultipartUpload',
      security: requireScope('convert:write'),
      parameters: [
        {
          name: 'action',
          in: 'query',
          required: false,
          schema: { type: 'string', enum: ['initiate', 'chunk', 'complete', 'abort', 'presign'], default: 'initiate' },
        },
      ],
      requestBody: {
        required: true,
        content: {
          'application/json': { schema: { type: 'object' } },
          'application/octet-stream': { schema: { type: 'string', format: 'binary' } },
        },
      },
      responses: {
        '200': createJsonResponse('Action result.', { success: { type: 'boolean' } }),
        '400': createProblemResponse('Unknown action or invalid input.'),
        '401': createProblemResponse('Authentication required.'),
        '404': createProblemResponse('Upload not found or owned by another user.'),
        '413': createProblemResponse('Part or total size exceeds the limit.'),
      },
    },
  },
  '/api/openapi.json': {
    get: {
      ...INTERNAL,
      summary: 'Get OpenAPI Document',
      operationId: 'getOpenApiDocument',
      security: PUBLIC_ACCESS,
      responses: openApiDocumentResponse,
    },
  },
  '/api/v1/openapi': {
    get: {
      ...INTERNAL,
      summary: 'Get OpenAPI Document (Alias)',
      operationId: 'getOpenApiDocumentV1',
      security: PUBLIC_ACCESS,
      responses: openApiDocumentResponse,
    },
  },
  '/api/v1/openapi.json': {
    get: {
      ...INTERNAL,
      summary: 'Get OpenAPI Document (JSON Alias)',
      operationId: 'getOpenApiDocumentJsonV1',
      security: PUBLIC_ACCESS,
      responses: openApiDocumentResponse,
    },
  },
};
