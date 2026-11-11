import fs from 'node:fs';
import path from 'node:path';

/** The `src/` files each compiled worker bundles, read once per process from the metafile its build wrote next to it. */
const bundledSources = new Map<string, string[] | undefined>();

function metafilePath(compiled: string): string {
  return compiled.replace(/\.js$/, '.meta.json');
}

/** The sources named by the build's metafile (`esbuild --metafile`), or undefined when the build left none. */
function readBundledSources(compiled: string): string[] | undefined {
  const metafile = metafilePath(compiled);
  if (!fs.existsSync(metafile)) return undefined;
  const { inputs } = JSON.parse(fs.readFileSync(metafile, 'utf-8')) as { inputs: Record<string, unknown> };
  return Object.keys(inputs)
    .filter((input) => input.startsWith('src/'))
    .map((input) => path.resolve(input));
}

function bundledSourcesOf(compiled: string): string[] | undefined {
  if (!bundledSources.has(compiled)) bundledSources.set(compiled, readBundledSources(compiled));
  return bundledSources.get(compiled);
}

/**
 * True when `compiled` (a build under `dist/` or next to a module) is older than `source`, the TypeScript file it was built from, or than
 * any other source file the build bundled (listed in its `.meta.json`; a build without one is compared with `source` alone). A
 * stale build must not stand in for the source that is there to run: a `dist/` left from last week made local tests run last week's code.
 * Production has no source beside its build, or no loader to run it, and keeps the build.
 */
export function olderThanSource(compiled: string, source: string | undefined): boolean {
  if (source === undefined) return false;
  const files = [source, ...(bundledSourcesOf(compiled) ?? [])].filter((file) => fs.existsSync(file));
  const builtAt = fs.statSync(compiled).mtimeMs;
  return files.some((file) => fs.statSync(file).mtimeMs > builtAt);
}
