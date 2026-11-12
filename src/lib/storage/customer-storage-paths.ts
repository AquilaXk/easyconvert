/**
 * The object keys, key prefixes and directories a job names in the customer's own store. The store is flat for S3 and rooted at
 * the account's base path for SFTP, so one rule serves both: a name is relative, holds no `.` or `..` segment that could leave
 * the bucket or the base path, no control character, no backslash and no unpaired surrogate, and fits the 1024 bytes of an S3 key.
 * The adapters refuse the same names when they send them; this check answers at submission, before a job exists.
 */

/** The longest key an S3 store accepts, in UTF-8 bytes; an SFTP path is held to the same length. */
export const MAX_REMOTE_PATH_BYTES = 1024;

const FORBIDDEN_CHARACTER = /[\p{Cc}\p{Zl}\p{Zp}\\]/u;
const DOT_SEGMENTS: ReadonlySet<string> = new Set(['.', '..']);

/** Why `value` cannot name something in the customer's store, or undefined when it can. The reason repeats no part of the value. */
export function remotePathProblem(value: unknown, options: { allowEmpty?: boolean } = {}): string | undefined {
  if (typeof value !== 'string') return 'must be a string';
  if (value === '') return options.allowEmpty ? undefined : 'must not be empty';
  if (Buffer.byteLength(value, 'utf8') > MAX_REMOTE_PATH_BYTES) return `is longer than ${MAX_REMOTE_PATH_BYTES} bytes`;
  if (!value.isWellFormed()) return 'must be valid Unicode';
  if (FORBIDDEN_CHARACTER.test(value)) return 'must not hold a control character or a backslash';
  if (value.startsWith('/')) return 'must be relative: it may not start with "/"';
  if (value.split('/').some((segment) => DOT_SEGMENTS.has(segment))) return 'must not hold a "." or ".." segment';
  return undefined;
}

/** `directory` and `name` joined with one slash; an empty directory leaves the name alone. */
export function joinRemotePath(directory: string, name: string): string {
  if (directory === '') return name;
  return directory.endsWith('/') ? `${directory}${name}` : `${directory}/${name}`;
}
