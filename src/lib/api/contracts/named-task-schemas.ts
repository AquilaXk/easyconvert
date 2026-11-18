import { NAMED_TASK_OPERATIONS } from '@/lib/jobs/named-tasks';

const TASK_NAME_RULE = 'A name starts with a lowercase letter and holds lowercase letters, digits, `-` and `_`, up to 64 characters.';

export const NamedTaskSchema = {
  $id: 'https://easyconvert.local/schemas/named-task.json',
  type: 'object',
  required: ['operation'],
  additionalProperties: false,
  description:
    'One task of a job made of named tasks. Each operation takes only its own fields: a field that does not belong to it answers 422.',
  properties: {
    operation: {
      type: 'string',
      enum: NAMED_TASK_OPERATIONS,
      description:
        '`import/url` and `import/upload` bring a file in; `convert`, `ocr`, `optimize`, `thumbnail`, `media.package`, `watermark`, `merge`, `metadata` (reads the metadata of its input into `metadata.json`), `metadata/write` (writes `options.metadata.set` into a JPEG, a PNG or a PDF), `capture/website` (only where the server has it on, see `GET /api/formats`; otherwise a 422 with the code `capture_unavailable`; draws the page at `url` as a PDF, a PNG or a JPEG, with `output_format` and `options.capture`; it takes no input and counts as a conversion), `archive/create`, `archive/extract` and the `pdf.*` page operations work on it; `export/url` ends a branch: with `url` it sends the files there, without it keeps them for download and lists their download URLs in the task result. `import/{s3,gcs,azure-blob,sftp,webdav}` bring files in from the customer\'s own bucket/container/server, and `export/{s3,gcs,azure-blob,sftp,webdav}` write files there and list where each went in the task result; they take a saved credential (`credential_ref`) or inline `credentials`. A job needs at least one task that converts.',
    },
    input: {
      description: 'The name of the task whose output this task reads, or a list of names. Every task but an import needs one. A `merge` needs at least 2 distinct names.',
      oneOf: [
        { type: 'string' },
        { type: 'array', items: { type: 'string' }, minItems: 1 },
      ],
    },
    output_format: {
      type: 'string',
      description: 'Format extension the task produces. Required by `convert`, `merge` and `archive/create`; `thumbnail` also takes it (`jpg` or `png`).',
    },
    options: {
      $ref: 'https://easyconvert.local/schemas/conversion-options.json',
      description: 'Options of the operation, as for `POST /api/v1/convert`, including `engine` and `engineVersion` for `convert`.',
    },
    url: {
      type: 'string',
      format: 'uri',
      description: 'The file to fetch (`import/url`), the destination that receives the files (`export/url`), or the public page that `capture/website` draws.',
    },
    headers: {
      type: 'object',
      additionalProperties: { type: 'string' },
      description: 'HTTP headers of the request to `url`. Stored sealed and never returned.',
    },
    method: {
      type: 'string',
      enum: ['PUT', 'POST'],
      description: 'HTTP method of an `export/url` with a `url`. Defaults to `PUT`.',
    },
    upload_id: {
      type: 'string',
      description: 'Completed upload (`import/upload`), from the direct multipart or resumable upload API. Name `upload_id` or `storage_key`.',
    },
    storage_key: {
      type: 'string',
      description: 'Key of a stored object the caller may use (`import/upload`), as `storageKey` of the job.',
    },
    entries: {
      type: 'array',
      items: { type: 'string' },
      description: 'Glob patterns of the entries `archive/extract` unpacks; all when left out.',
    },
    credential_ref: {
      type: 'string',
      pattern: '^cred_[a-f0-9]{32}$',
      description: '`import/{s3,gcs,azure-blob,sftp,webdav}`, `export/{s3,gcs,azure-blob,sftp,webdav}`: a credential saved for the account (`credentialRef`), which only its owner can use. Name this or `credentials`, not both. An unknown, expired, or mismatched reference answers 422.',
    },
    credentials: {
      type: 'object',
      writeOnly: true,
      description: 'The credentials sent with the task, in place of `credential_ref`: sealed when the job is accepted, opened only by the worker that runs the task, never returned or logged. Matches the credential payload without `type` for S3, GCS, Azure Blob, SFTP, or WebDAV.',
    },
    key: { type: 'string', description: '`import/{s3,gcs,azure-blob}`: the one object to bring in. Name `key` or `prefix`. Relative: no leading `/`, no `.` or `..` segment, at most 1024 bytes.' },
    prefix: {
      type: 'string',
      description: '`import/{s3,gcs,azure-blob}`: bring in objects whose key starts with it (at most `max_objects`). `export/{s3,gcs,azure-blob}`: literal prefix put before each file name; bucket/container root when left out.',
    },
    path: { type: 'string', description: '`import/{sftp,webdav}`: the one file to bring in, relative to `basePath`. Name `path` or `directory`.' },
    directory: {
      type: 'string',
      description: '`import/{sftp,webdav}`: bring in files of this directory (at most `max_objects`). `export/{sftp,webdav}`: target directory, relative to `basePath`.',
    },
    max_objects: {
      type: 'integer',
      minimum: 1,
      maximum: 100,
      default: 20,
      description: '`import/{s3,gcs,azure-blob}` with `prefix`, `import/{sftp,webdav}` with `directory`: the most files to bring in. A listing with more fails the task with `storage_too_many_objects`; nothing is cut short.',
    },
  },
} as const;

/** The `tasks` of a job made of named tasks; its keys are the task names. */
export const NamedTaskMapSchema = {
  type: 'object',
  minProperties: 1,
  description: `The tasks of the job by name, each reading the tasks it names in \`input\`; the tasks run as a graph, in parallel where they do not read each other. ${TASK_NAME_RULE} The most tasks is 8 on the free plan, 24 on pro and 32 on the largest plan; the same name twice, a name that is not found in an \`input\`, and tasks that read each other in a loop are refused with their own problem type. One conversion unit is charged for each file a converting task makes, as in a graph. If a task fails the job fails: the tasks that read it report \`failed\` with the code \`dependency_failed\`, the others that did not end \`cancelled\`.`,
  additionalProperties: { $ref: 'https://easyconvert.local/schemas/named-task.json' },
} as const;

/** What a job made of named tasks says of one task, under its name in `tasks` of the job, the job list and the graph webhooks. */
export const TaskReportSchema = {
  $id: 'https://easyconvert.local/schemas/task-report.json',
  type: 'object',
  required: ['operation', 'status'],
  properties: {
    operation: { type: 'string', enum: NAMED_TASK_OPERATIONS, description: 'The operation the task was sent with.' },
    status: {
      type: 'string',
      enum: ['waiting', 'active', 'completed', 'failed', 'cancelled'],
      description:
        '`waiting` until the tasks it reads have completed, then `active`, then `completed` or `failed`. A task that did not run because a task it reads failed is `failed` too, with the code `dependency_failed`; a task the job stopped (after a failure elsewhere, or a cancel) that reads no failed task is `cancelled`.',
    },
    input: { type: 'array', items: { type: 'string' }, description: 'The names of the tasks it reads.' },
    startedAt: { type: 'number', description: 'When a worker took the task, in epoch milliseconds.' },
    finishedAt: { type: 'number', description: 'When the task ended, in epoch milliseconds.' },
    result: {
      type: 'object',
      description: 'The files an `export/url` task without a `url` kept for download, or the files an `export/s3` or `export/sftp` task wrote to the customer\'s store, once it completed. The other tasks hand their files to the tasks that read them and have no result of their own.',
      required: ['files', 'fileCount'],
      properties: {
        files: {
          type: 'array',
          description: 'At most 100 files.',
          items: {
            type: 'object',
            required: ['filename'],
            properties: {
              filename: { type: 'string' },
              downloadUrl: { type: 'string', description: '`export/url` without a `url`: the path of the file; send it to `GET /api/storage/file/{key}` with the key.' },
              destination: { type: 'string', description: '`export/s3` and `export/sftp`: where the file was written, as a key in the bucket or a path under the directory of the task.' },
            },
          },
        },
        fileCount: { type: 'integer', description: 'How many files the task kept, which may be more than `files` lists.' },
      },
    },
    error: {
      type: 'object',
      description: 'Why the task failed.',
      required: ['code', 'message'],
      properties: {
        code: {
          type: 'string',
          description: 'The cause of the failure when it names one (for example `unsupported_pair`, `malformed_input` or `timeout`), else `task_failed`; `dependency_failed` for a task that did not run because a task it reads failed.',
        },
        message: { type: 'string', description: 'The reason, in English, with credentials and server paths masked.' },
        task: { type: 'string', description: 'For `dependency_failed`: the name of the failed task that this one reads, directly or through other tasks.' },
      },
    },
  },
} as const;
