import { archiveEntryNameError, assertSafeArchiveEntryName } from './archive-extraction-safety';

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

/**
 * The canonical spelling of an archive entry's stored name, for the readers of an archive: backslashes are separators,
 * and empty and `.` components are dropped. A name that is not a plain relative path (traversal, absolute, drive path,
 * NUL, lookalikes of those; see `assertSafeArchiveEntryName`) throws an UnsafeArchiveError that names it, and is never
 * repaired into another path. Returns null for a name that is the extraction root itself. A caller whose names are not
 * entries it read (the file names of an upload, written out by the writers) uses {@link safeCanonicalArchivePath}.
 */
export function canonicalEntryPath(filename: string): string | null {
  assertSafeArchiveEntryName(filename);
  return canonicalArchivePath(filename);
}

/** {@link canonicalArchivePath} for a caller that must not throw: null for an unsafe name as well as for the root. */
export function safeCanonicalArchivePath(filename: string): string | null {
  return archiveEntryNameError(filename) === null ? canonicalArchivePath(filename) : null;
}
