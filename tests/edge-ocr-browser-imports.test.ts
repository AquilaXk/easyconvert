import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC_ROOT = path.join(process.cwd(), 'src');
const EDGE_OCR_DIR = path.join(SRC_ROOT, 'lib', 'edge-ocr') + path.sep;
const CONVERSIONS_DIR = path.join(SRC_ROOT, 'lib', 'conversions') + path.sep;
const EDGE_OCR_ENTRY = path.join(SRC_ROOT, 'lib', 'edge-ocr', 'index.ts');
const COMBINER_ENTRY = path.join(SRC_ROOT, 'lib', 'conversions', 'ocr-pdf-combiner.ts');
const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.json', '/index.ts', '/index.tsx'];
const NODE_BUILTINS = new Set([
  'assert', 'buffer', 'child_process', 'crypto', 'dns', 'events', 'fs', 'fs/promises', 'http', 'https',
  'net', 'os', 'path', 'stream', 'tls', 'url', 'util', 'worker_threads', 'zlib',
]);
const SERVER_ONLY_PACKAGES = new Set(['sharp', 'ioredis', 'pdfkit', 'harfbuzzjs']);
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

function forbiddenImportsReachableFrom(entry: string): string[] {
  const seen = new Set<string>();
  const found: string[] = [];
  const pending = [entry];
  while (pending.length > 0) {
    const file = pending.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    if (file.endsWith('.json')) continue;
    const source = fs.readFileSync(file, 'utf-8');
    const specifiers = [...source.matchAll(IMPORT_PATTERN), ...source.matchAll(DYNAMIC_IMPORT_PATTERN)].map((m) => m[1]);
    for (const specifier of specifiers) {
      const bare = specifier.replace(/^node:/, '');
      if (specifier.startsWith('node:') || NODE_BUILTINS.has(bare) || SERVER_ONLY_PACKAGES.has(specifier)) {
        found.push(`${path.relative(process.cwd(), file)} -> ${specifier}`);
        continue;
      }
      const local = resolveLocal(file, specifier);
      if (local && (local.startsWith(EDGE_OCR_DIR) || local.startsWith(CONVERSIONS_DIR))) {
        pending.push(local);
      }
    }
  }
  return found.sort((a, b) => a.localeCompare(b));
}

describe('browser OCR bundle', () => {
  it('imports no Node built-in or server-only package in modules reachable from src/lib/edge-ocr/index.ts', () => {
    expect(forbiddenImportsReachableFrom(EDGE_OCR_ENTRY)).toEqual([]);
  });

  it('imports no Node built-in or server-only package in modules reachable from src/lib/conversions/ocr-pdf-combiner.ts', () => {
    expect(forbiddenImportsReachableFrom(COMBINER_ENTRY)).toEqual([]);
  });
});
