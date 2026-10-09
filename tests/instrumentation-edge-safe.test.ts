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

const GUARD = /if \(process\.env\.NEXT_RUNTIME === 'nodejs'\) \{([\s\S]*?)\n  \}/;
const NODE_ONLY_IMPORTS = ["import('./lib/config/web-startup')", "import('./lib/storage/selected-storage')"];

describe('src/instrumentation.ts', () => {
  it('loads the configuration check and the storage selection only inside a positive Node runtime check', () => {
    const guarded = GUARD.exec(code);
    expect(guarded?.[1].match(/import\('[^']+'\)/g)).toEqual(NODE_ONLY_IMPORTS);
    expect(code.replace(GUARD, '').match(/import\(/g)).toBeNull();
  });

  it('does not guard the imports with an early return that the Edge bundler cannot remove', () => {
    expect(code.includes("NEXT_RUNTIME !== 'nodejs'")).toBe(false);
    for (const nodeOnlyImport of NODE_ONLY_IMPORTS) {
      expect(code.split(nodeOnlyImport).length - 1, nodeOnlyImport).toBe(1);
    }
  });

  it('validates the configuration before the storage selection loads', () => {
    expect(code.indexOf("import('./lib/config/web-startup')")).toBeLessThan(code.indexOf("import('./lib/storage/selected-storage')"));
  });
});
