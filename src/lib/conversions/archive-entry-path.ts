import path from 'node:path';
import { archiveEntryNameError, type UnsafeArchiveError } from './archive-extraction-safety';

const PATH_DOT_CHAR_CODE = 0x2e;
const BACKSLASH_CHAR = '\\';

/** Joins the '/'-separated components except empty and '.' ones, without allocating arrays. */
function joinPathSegments(filename: string): string {
  let joined = '';
  let start = 0;
  while (start <= filename.length) {
    const slash = filename.indexOf('/', start);
    const end = slash === -1 ? filename.length : slash;
    const isDot = end - start === 1 && filename.charCodeAt(start) === PATH_DOT_CHAR_CODE;
    if (end > start && !isDot) {
      const segment = filename.slice(start, end);
      joined = joined === '' ? segment : `${joined}/${segment}`;
    }
    start = end + 1;
  }
  return joined;
}

/** The canonical spelling of a stored name that is a plain relative path, or null when it names the extraction root (`.`, `./`). */
export function canonicalArchivePath(filename: string): string | null {
  const normalized = joinPathSegments(filename.includes(BACKSLASH_CHAR) ? filename.replaceAll(BACKSLASH_CHAR, '/') : filename);
  return normalized === '' ? null : normalized;
}

export interface ValidatedEntryPath {
  /** The canonical spelling, null for the extraction root; the stored name itself when it is refused. */
  path: string | null;
  error: UnsafeArchiveError | null;
}

/**
 * The one place a stored entry name is validated and canonicalised: backslashes are separators, and empty and `.`
 * components are dropped. A name that is not a plain relative path (traversal, absolute, a drive path stored or
 * reached through `./`, a control character, lookalikes of those after Unicode folding; see `archiveEntryNameError`) comes
 * back with its error and is never repaired into another path. `path` is null for the extraction root (`.`, `./`).
 */
export function validateEntryPath(filename: string): ValidatedEntryPath {
  const error = archiveEntryNameError(filename);
  return error === null ? { path: canonicalArchivePath(filename), error: null } : { path: filename, error };
}

/**
 * {@link validateEntryPath} for the readers of an archive: an unsafe name throws its UnsafeArchiveError, which names
 * the entry. A caller whose names are not entries it read (the file names of an upload, written out by the writers)
 * uses {@link safeCanonicalArchivePath}.
 */
export function canonicalEntryPath(filename: string): string | null {
  const { path, error } = validateEntryPath(filename);
  if (error !== null) throw error;
  return path;
}

/** {@link canonicalArchivePath} for a caller that must not throw: null for an unsafe name as well as for the root. */
export function safeCanonicalArchivePath(filename: string): string | null {
  const { path, error } = validateEntryPath(filename);
  return error === null ? path : null;
}

/**
 * The name an uploaded file is staged under for the encrypted writers: its canonical spelling, or its leaf when that is not a
 * plain relative path. A name that cannot be written as a file (empty, a control character, `..`) is refused with a typed error.
 */
export function encryptedStagedName(uploadName: string): string {
  const staged = safeCanonicalArchivePath(uploadName) || path.basename(uploadName);
  const refusal = archiveEntryNameError(staged);
  if (refusal !== null) throw refusal;
  return staged;
}
