import fs from 'node:fs';

/**
 * True when `compiled` (a build under `dist/` or next to a module) is older than `source`, the TypeScript file it was built from. A
 * stale build must not stand in for the source that is there to run: a `dist/` left from last week made local tests run last week's code.
 * Production has no source beside its build, or no loader to run it, and keeps the build.
 */
export function olderThanSource(compiled: string, source: string | undefined): boolean {
  return source !== undefined && fs.statSync(compiled).mtimeMs < fs.statSync(source).mtimeMs;
}
