import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Next.js compiles src/instrumentation.ts for the Node and the Edge runtime. The Edge bundler
 * rejects `node:` imports, and it only drops the storage import when the import sits inside a
 * positive `NEXT_RUNTIME === 'nodejs'` check; an early `return` for any other runtime leaves it in
 * and `next build` fails with "UnhandledSchemeError: Reading from node:crypto" (seen in CI on the
 * object-storage change). The full proof is `npm run build`; this keeps the shape that makes it pass.
 */

const source = fs.readFileSync(path.join(__dirname, '../src/instrumentation.ts'), 'utf-8');
const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

describe('src/instrumentation.ts', () => {
  it('loads the storage selection only inside a positive Node runtime check', () => {
    const guarded = /if \(process\.env\.NEXT_RUNTIME === 'nodejs'\) \{\s*await import\('\.\/lib\/storage\/selected-storage'\);\s*\}/;
    expect(code.match(guarded)?.length).toBe(1);
  });

  it('does not guard the import with an early return that the Edge bundler cannot remove', () => {
    expect(code.includes("NEXT_RUNTIME !== 'nodejs'")).toBe(false);
    expect(code.match(/import\('\.\/lib\/storage\/selected-storage'\)/g)?.length).toBe(1);
  });
});
