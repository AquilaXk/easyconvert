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
        '`import/url` and `import/upload` bring a file in; `convert`, `ocr`, `optimize`, `thumbnail`, `media.package`, `watermark`, `merge`, `metadata`, `archive/create`, `archive/extract` and the `pdf.*` page operations work on it; `export/url` ends a branch: with `url` it sends the files there, without it keeps them for download and lists their download URLs in the task result. `import/s3` and `import/sftp` bring files in from the customer\'s own bucket or SFTP server, and `export/s3` and `export/sftp` write the files there and list where each went in the task result; they take a saved credential (`credential_ref`) or the credentials themselves (`credentials`). A job needs at least one task that converts.',
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
      description: 'The file to fetch (`import/url`), or the destination that receives the files (`export/url`).',
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
      description: '`import/s3`, `export/s3`, `import/sftp`, `export/sftp`: a credential saved for the account (the `credentialRef` that saving it answered), which only its owner can use. Name this or `credentials`, not both. A reference that is unknown, expired, of another account or of another kind answers 422.',
    },
    credentials: {
      type: 'object',
      writeOnly: true,
      description: 'The credentials sent with the task, in place of `credential_ref`: sealed when the job is accepted, opened only by the worker that runs the task, never returned or logged. The same fields as the `credentials` of a saved credential without `type`: an S3 task takes `bucket`, `accessKeyId`, `secretAccessKey` and optionally `sessionToken`, `region`, `endpoint` (https, public addresses only) and `forcePathStyle`; an SFTP task takes `host`, `username`, `privateKey` and optionally `port`, `passphrase`, `hostKey` and `basePath`.',
    },
    key: { type: 'string', description: '`import/s3`: the one object to bring in. Name `key` or `prefix`. Relative: no leading `/`, no `.` or `..` segment, at most 1024 bytes.' },
    prefix: {
      type: 'string',
      description: '`import/s3`: bring in the objects whose key starts with it (at most `max_objects`). `export/s3`: the text put before each file name, taken literally (`out/` is a folder); the bucket root when left out.',
    },
    path: { type: 'string', description: '`import/sftp`: the one file to bring in, relative to the `basePath` of the credentials. Name `path` or `directory`.' },
    directory: {
      type: 'string',
      description: '`import/sftp`: bring in the regular files of this directory (at most `max_objects`). `export/sftp`: the directory the files are written into, which must exist; the `basePath` when left out.',
    },
    max_objects: {
      type: 'integer',
      minimum: 1,
      maximum: 100,
      default: 20,
      description: '`import/s3` with `prefix`, `import/sftp` with `directory`: the most files to bring in. A listing with more fails the task with `storage_too_many_objects`; nothing is cut short.',
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
