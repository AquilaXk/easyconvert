import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The in-browser OCR path is bundled for the client, where Node built-ins do not exist. This walks the
 * conversion modules the OCR PDF combiner pulls in and lists every Node built-in one of them imports.
 * Shared modules outside `src/lib/conversions` (types, contracts) are left to the production build.
 */

const SRC_ROOT = path.join(process.cwd(), 'src');
const CONVERSIONS_DIR = path.join(SRC_ROOT, 'lib', 'conversions') + path.sep;
// The OCR PDF combiner is the part of the browser OCR path that builds the searchable PDF.
const BROWSER_ENTRY = path.join(SRC_ROOT, 'lib', 'conversions', 'ocr-pdf-combiner.ts');
const SOURCE_EXTENSIONS = ['.ts', '.tsx', '/index.ts', '/index.tsx'];
const NODE_BUILTINS = new Set([
  'assert', 'buffer', 'child_process', 'crypto', 'dns', 'events', 'fs', 'fs/promises', 'http', 'https',
  'net', 'os', 'path', 'stream', 'tls', 'url', 'util', 'worker_threads', 'zlib',
]);
// Value imports only: `import type` and `export type` are erased before bundling.
const IMPORT_PATTERN = /(?:^|\n)\s*(?:import|export)\s+(?!type\b)(?:[^'";]*?\sfrom\s+)?['"]([^'"]+)['"]/g;
const DYNAMIC_IMPORT_PATTERN = /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g;

function resolveLocal(fromFile: string, specifier: string): string | null {
  let base: string;
  if (specifier.startsWith('@/')) base = path.join(SRC_ROOT, specifier.slice(2));
  else if (specifier.startsWith('.')) base = path.resolve(path.dirname(fromFile), specifier);
  else return null;
  for (const extension of ['', ...SOURCE_EXTENSIONS]) {
    const candidate = base + extension;
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  throw new Error(`Unresolved import ${specifier} from ${fromFile}`);
}

function nodeBuiltinsReachableFrom(entry: string): string[] {
  const seen = new Set<string>();
  const found: string[] = [];
  const pending = [entry];
  while (pending.length > 0) {
    const file = pending.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    const source = fs.readFileSync(file, 'utf-8');
    const specifiers = [...source.matchAll(IMPORT_PATTERN), ...source.matchAll(DYNAMIC_IMPORT_PATTERN)].map((m) => m[1]);
    for (const specifier of specifiers) {
      const bare = specifier.replace(/^node:/, '');
      if (specifier.startsWith('node:') || NODE_BUILTINS.has(bare)) {
        found.push(`${path.relative(process.cwd(), file)} -> ${specifier}`);
        continue;
      }
      const local = resolveLocal(file, specifier);
      if (local?.startsWith(CONVERSIONS_DIR)) pending.push(local);
    }
  }
  return found.sort((a, b) => a.localeCompare(b));
}

describe('browser OCR bundle', () => {
  it('imports no Node built-in in the conversion modules of the OCR PDF combiner', () => {
    expect(nodeBuiltinsReachableFrom(BROWSER_ENTRY)).toEqual([]);
  });
});
