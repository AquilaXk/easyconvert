import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

/** Each case spawns the guard as a subprocess (about 1.3 s idle); the 5 s default fails on a loaded CI shard. */
const GUARD_SUBPROCESS_TEST_TIMEOUT_MS = 60_000;
vi.setConfig({ testTimeout: GUARD_SUBPROCESS_TEST_TIMEOUT_MS });

describe('Anti-Cheat Guard AST Rules & Ratchet Baseline Engine (#252)', () => {
  const guardScript = path.resolve('scripts/guard-anti-cheat.ts');

  function runGuardSubprocess(
    targetDir: string,
    extraArgs: string[] = []
  ): { status: number; stdout: string; stderr: string } {
    try {
      const output = execFileSync(
        'npx',
        ['tsx', guardScript, '--target', targetDir, ...extraArgs],
        {
          encoding: 'utf-8',
          stdio: ['pipe', 'pipe', 'pipe'],
          env: { ...process.env, GUARD_ROOT: targetDir },
        }
      );
      return { status: 0, stdout: output, stderr: '' };
    } catch (err: any) {
      return {
        status: err.status ?? 1,
        stdout: err.stdout?.toString() || '',
        stderr: err.stderr?.toString() || '',
      };
    }
  }

  function withTempDir(fn: (dir: string) => void) {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-test-'));
    try {
      fn(tempDir);
    } finally {
      if (fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    }
  }

  // =========================================================================
  // 1. G2b: Positive-Guard Skip Rule
  // =========================================================================
  describe('Rule G2b: Positive-guard skip detection', () => {
    it('detects positive tool check without else wrapping verifications (positive case)', () => {
      withTempDir((dir) => {
        const testsDir = path.join(dir, 'tests');
        fs.mkdirSync(testsDir, { recursive: true });

        fs.writeFileSync(
          path.join(testsDir, 'positive-guard.test.ts'),
          `
import { it, expect } from 'vitest';
it('bypasses test when tool missing', () => {
  if (isOracleToolAvailable('ffmpeg')) {
    expect(1).toBe(1);
  }
});
          `
        );

        const res = runGuardSubprocess(dir, ['--strict']);
        expect(res.status).not.toBe(0);
        expect(res.stderr + res.stdout).toContain('G2b-POSITIVE-GUARD-SKIP');
      });
    });

    it('permits clean oracleTest or fail-closed patterns (negative case)', () => {
      withTempDir((dir) => {
        const testsDir = path.join(dir, 'tests');
        fs.mkdirSync(testsDir, { recursive: true });

        fs.writeFileSync(
          path.join(testsDir, 'clean-oracle.test.ts'),
          `
import { it, expect } from 'vitest';
oracleTest('runs with proper oracle wrapper', ['ffmpeg'], () => {
  expect(2 + 2).toBe(4);
});
          `
        );

        const res = runGuardSubprocess(dir, ['--strict']);
        expect(res.status).toBe(0);
        expect(res.stderr + res.stdout).not.toContain('G2b-POSITIVE-GUARD-SKIP');
      });
    });
  });

  // =========================================================================
  // 2. G3b: Truncation Rule
  // =========================================================================
  describe('Rule G3b: Truncation detection in conversion generators', () => {
    it('detects fixed literal .slice(0, N) in generator functions (positive case)', () => {
      withTempDir((dir) => {
        const srcDir = path.join(dir, 'src', 'lib', 'conversions');
        fs.mkdirSync(srcDir, { recursive: true });

        fs.writeFileSync(
          path.join(srcDir, 'cad.ts'),
          `
export function encodeStep(model: any): Buffer {
  const vertices = model.vertices.slice(0, 100);
  return Buffer.from(vertices);
}
          `
        );

        const res = runGuardSubprocess(dir, ['--strict']);
        expect(res.status).not.toBe(0);
        expect(res.stderr + res.stdout).toContain('G3b-TRUNCATION');
      });
    });

    it('permits non-generator functions or dynamic slicing (negative case)', () => {
      withTempDir((dir) => {
        const srcDir = path.join(dir, 'src', 'lib', 'conversions');
        fs.mkdirSync(srcDir, { recursive: true });

        fs.writeFileSync(
          path.join(srcDir, 'cad.ts'),
          `
export function encodeStep(model: any): Buffer {
  const len = model.vertices.length;
  const vertices = model.vertices.slice(0, len);
  return Buffer.from(vertices);
}
          `
        );

        const res = runGuardSubprocess(dir, ['--strict']);
        expect(res.status).toBe(0);
        expect(res.stderr + res.stdout).not.toContain('G3b-TRUNCATION');
      });
    });
  });

  // =========================================================================
  // 3. G3c: Ignored Input Rule
  // =========================================================================
  describe('Rule G3c: Ignored first parameter detection in exported generators', () => {
    it('detects unreferenced first parameter in exported generator (positive case)', () => {
      withTempDir((dir) => {
        const srcDir = path.join(dir, 'src', 'lib', 'conversions');
        fs.mkdirSync(srcDir, { recursive: true });

        fs.writeFileSync(
          path.join(srcDir, 'vector.ts'),
          `
export function encodeWmf(svgBuffer: Buffer): Buffer {
  return Buffer.from([0x01, 0x00, 0x09, 0x00]);
}
          `
        );

        const res = runGuardSubprocess(dir, ['--strict']);
        expect(res.status).not.toBe(0);
        expect(res.stderr + res.stdout).toContain('G3c-IGNORED-INPUT');
      });
    });

    it('permits exported functions that authentically consume first parameter (negative case)', () => {
      withTempDir((dir) => {
        const srcDir = path.join(dir, 'src', 'lib', 'conversions');
        fs.mkdirSync(srcDir, { recursive: true });

        fs.writeFileSync(
          path.join(srcDir, 'vector.ts'),
          `
export function encodeWmf(svgBuffer: Buffer): Buffer {
  const header = Buffer.from([0x01, 0x00]);
  return Buffer.concat([header, svgBuffer]);
}
          `
        );

        const res = runGuardSubprocess(dir, ['--strict']);
        expect(res.status).toBe(0);
        expect(res.stderr + res.stdout).not.toContain('G3c-IGNORED-INPUT');
      });
    });
  });

  // =========================================================================
  // 4. G4b: Weak-Only Assertions Rule
  // =========================================================================
  describe('Rule G4b: Weak-only assertions detection in tests', () => {
    it('detects tests with only weak assertions (positive case)', () => {
      withTempDir((dir) => {
        const testsDir = path.join(dir, 'tests');
        fs.mkdirSync(testsDir, { recursive: true });

        fs.writeFileSync(
          path.join(testsDir, 'weak.test.ts'),
          `
import { it, expect } from 'vitest';
it('checks weakly', () => {
  const obj = { active: true, name: 'easyconvert' };
  expect(obj).toBeDefined();
  expect(obj.active).toBeTruthy();
  expect(obj.name).toContain('easy');
});
          `
        );

        const res = runGuardSubprocess(dir, ['--strict']);
        expect(res.status).not.toBe(0);
        expect(res.stderr + res.stdout).toContain('G4b-WEAK-ONLY-ASSERTIONS');
      });
    });

    it('permits tests containing at least one substantive assertion (negative case)', () => {
      withTempDir((dir) => {
        const testsDir = path.join(dir, 'tests');
        fs.mkdirSync(testsDir, { recursive: true });

        fs.writeFileSync(
          path.join(testsDir, 'substantive.test.ts'),
          `
import { it, expect } from 'vitest';
it('checks substantive properties', () => {
  const obj = { count: 42, active: true };
  expect(obj).toBeDefined();
  expect(obj.count).toBe(42);
});
          `
        );

        const res = runGuardSubprocess(dir, ['--strict']);
        expect(res.status).toBe(0);
        expect(res.stderr + res.stdout).not.toContain('G4b-WEAK-ONLY-ASSERTIONS');
      });
    });
  });

  // =========================================================================
  // 4b. G4c: toBeDefined() on lookups that answer null
  // =========================================================================
  describe('Rule G4c: toBeDefined() on a lookup that returns null', () => {
    function guardOutputFor(source: string): { status: number; output: string } {
      let result = { status: -1, output: '' };
      withTempDir((dir) => {
        const testsDir = path.join(dir, 'tests');
        fs.mkdirSync(testsDir, { recursive: true });
        fs.writeFileSync(path.join(testsDir, 'lookup.test.ts'), source);
        const res = runGuardSubprocess(dir, ['--strict']);
        result = { status: res.status, output: res.stderr + res.stdout };
      });
      return result;
    }

    it('flags a JSZip entry and a Headers value checked only with toBeDefined (positive case)', () => {
      const { status, output } = guardOutputFor(`
import { it, expect } from 'vitest';
it('checks an archive entry', async () => {
  const zip = await JSZip.loadAsync(new Uint8Array());
  expect(zip.file('word/document.xml')).toBeDefined();
  expect(await zip.file('word/document.xml')!.async('string')).toBe('<w:document/>');
});
it('checks a response header', () => {
  const res = new Response('', { headers: { 'X-Limit': '5' } });
  expect(res.headers.get('X-Limit')).toBeDefined();
  expect(res.status).toBe(200);
});
          `);
      expect(status).not.toBe(0);
      expect(output.match(/G4c-HOLLOW-NULL-CHECK/g)).toHaveLength(2);
      expect(output).toContain("expect(zip.file('word/document.xml')).toBeDefined()");
      expect(output).toContain("expect(res.headers.get('X-Limit')).toBeDefined()");
    });

    it('follows a local variable bound to the lookup (positive case)', () => {
      const { status, output } = guardOutputFor(`
import { it, expect } from 'vitest';
it('checks a bound header', () => {
  const location = new Response('', { headers: { Location: '/x' } }).headers.get('Location');
  expect(location).toBeDefined();
  expect(location).toMatch(/^\\//);
});
          `);
      expect(status).not.toBe(0);
      expect(output).toContain('G4c-HOLLOW-NULL-CHECK');
      expect(output).toContain('expect(location).toBeDefined()');
    });

    it('follows an alias of the headers object and a Headers built in the test (positive case)', () => {
      const { status, output } = guardOutputFor(`
import { it, expect } from 'vitest';
it('checks a header through an alias', () => {
  const res = new Response('', { headers: { ETag: '"abc"' } });
  const h = res.headers;
  expect(h.get('etag')).toBeDefined();
  expect(res.status).toBe(200);
});
it('checks a header through two aliases', () => {
  const res = new Response('', { headers: { ETag: '"abc"' } });
  const first = res.headers;
  const second = first;
  expect(second.get('etag')).toBeDefined();
});
it('checks a Headers object built in the test', () => {
  const sent = new Headers({ 'X-Limit': '5' });
  expect(sent.get('x-limit')).toBeDefined();
});
it('checks a bound value read through an alias', () => {
  const res = new Response('', { headers: { Location: '/x' } });
  const h = res.headers;
  const location = h.get('Location');
  expect(location).toBeDefined();
});
          `);
      expect(status).not.toBe(0);
      expect(output.match(/G4c-HOLLOW-NULL-CHECK/g)).toHaveLength(4);
      expect(output).toContain("expect(h.get('etag')).toBeDefined()");
      expect(output).toContain("expect(second.get('etag')).toBeDefined()");
      expect(output).toContain("expect(sent.get('x-limit')).toBeDefined()");
      expect(output).toContain('expect(location).toBeDefined()');
    });

    it('permits an alias of a Map, which answers undefined for a missing key (negative case)', () => {
      const { status, output } = guardOutputFor(`
import { it, expect } from 'vitest';
it('checks a Map through an alias', () => {
  const registry = new Map([['a', 1]]);
  const alias = registry;
  expect(alias.get('a')).toBeDefined();
  expect(alias.get('a')).toBe(1);
});
it('checks a Headers value strictly', () => {
  const h = new Headers({ ETag: '"abc"' });
  expect(h.get('etag')).not.toBeNull();
  expect(h.get('etag')).toBe('"abc"');
});
          `);
      expect(output).not.toContain('G4c-HOLLOW-NULL-CHECK');
      expect(status).toBe(0);
    });

    it('permits not.toBeNull(), Map.get and an undefined-returning lookup (negative case)', () => {
      const { status, output } = guardOutputFor(`
import { it, expect } from 'vitest';
it('checks an archive entry strictly', async () => {
  const zip = await JSZip.loadAsync(new Uint8Array());
  expect(zip.file('word/document.xml')).not.toBeNull();
  expect(await zip.file('word/document.xml')!.async('string')).toBe('<w:document/>');
});
it('checks a Map lookup, which answers undefined for a missing key', () => {
  const registry = new Map([['a', 1]]);
  expect(registry.get('a')).toBeDefined();
  expect(registry.get('a')).toBe(1);
});
          `);
      expect(output).not.toContain('G4c-HOLLOW-NULL-CHECK');
      expect(status).toBe(0);
    });
  });

  // =========================================================================
  // 4c. G2c: skips that stay silent under ORACLE_STRICT_MODE=1
  // =========================================================================
  describe('Rule G2c: a skip must fail under ORACLE_STRICT_MODE=1', () => {
    /** `helperFiles` are written to tests/helpers/ of the scanned tree, for conditions that import a constant. */
    function guardOutputFor(source: string, helperFiles: Record<string, string> = {}): { status: number; output: string } {
      let result = { status: -1, output: '' };
      withTempDir((dir) => {
        const testsDir = path.join(dir, 'tests');
        fs.mkdirSync(path.join(testsDir, 'helpers'), { recursive: true });
        for (const [name, text] of Object.entries(helperFiles)) fs.writeFileSync(path.join(testsDir, 'helpers', name), text);
        fs.writeFileSync(path.join(testsDir, 'skips.test.ts'), source);
        const res = runGuardSubprocess(dir, ['--strict']);
        result = { status: res.status, output: res.stderr + res.stdout };
      });
      return result;
    }

    it('flags a skip on a missing tool, an unconditional skip and a context skip (positive case)', () => {
      const { status, output } = guardOutputFor(`
import { it, describe } from 'vitest';
const HAS_BZIP2 = true;
it.skipIf(!HAS_BZIP2)('round-trips through bzip2', () => {});
describe.runIf(process.env.PERF_BENCH === '1')('benchmark', () => {});
it.skip('retired', () => {});
it('skips from inside', (ctx) => {
  if (!HAS_BZIP2) ctx.skip();
});
          `);
      expect(status).not.toBe(0);
      expect(output.match(/G2c-SKIP-SILENT-UNDER-STRICT/g)).toHaveLength(4);
      expect(output).toContain('it.skipIf(!HAS_BZIP2)');
      expect(output).toContain('permanently skipped test');
    });

    it('follows a constant to the strict-aware helper it is built from (negative case)', () => {
      const { status, output } = guardOutputFor(`
import { it, describe } from 'vitest';
import { skipUnless, skipWithoutTools, skipWithoutRawSamples } from './helpers/strict-skip';
const SKIP = skipWithoutTools('bzip2');
const SKIP_WITHOUT_X = skipUnless('x', false);
const NEEDS_SAMPLES = skipWithoutRawSamples('x3f');
it.skipIf(SKIP)('uses a helper constant', () => {});
it.skipIf(SKIP_WITHOUT_X)('uses another helper constant', () => {});
describe.skipIf(NEEDS_SAMPLES)('samples', () => {});
          `);
      expect(output).not.toContain('G2c-SKIP-SILENT-UNDER-STRICT');
      expect(status).toBe(0);
    });

    it('permits strict-flag, platform and explained skips (negative case)', () => {
      const { status, output } = guardOutputFor(`
import { it, describe } from 'vitest';
const STRICT_MODE = process.env.ORACLE_STRICT_MODE === '1';
const ENABLED = STRICT_MODE || Boolean(process.env.SAMPLES);
it.skipIf(!ENABLED)('runs under strict mode', () => {});
// skip-ok: platform capability: reads /proc, CI runs Linux.
it.skipIf(process.platform !== 'linux')('reads /proc', () => {});
// skip-ok: the Redis-mode CI step sets REDIS_URL and runs this file.
describe.skipIf(!process.env.REDIS_URL)('redis', () => {});
it('opts out on a slow runner', (ctx) => {
  // skip-ok: explicit opt-out, never set in CI.
  if (process.env.SLOW === '1') ctx.skip();
});
it('throws when strict, skips otherwise', (ctx) => {
  if (!process.env.TOOL) {
    if (process.env.ORACLE_STRICT_MODE === '1') throw new Error('tool required');
    ctx.skip();
  }
});
          `);
      expect(output).not.toContain('G2c-SKIP-SILENT-UNDER-STRICT');
      expect(status).toBe(0);
    });

    it('flags conditions that merely mention the strict flag, or a helper that is not the strict-aware one (positive case)', () => {
      const { status, output } = guardOutputFor(`
import { it, describe } from 'vitest';
const STRICT_MODE = process.env.ORACLE_STRICT_MODE === '1';
const HAS_TOOL = Boolean(process.env.TOOL);
function skipUnless(what: string, available: boolean): boolean {
  return !available;
}
it.skipIf(!HAS_TOOL || STRICT_MODE)('skips when the tool is missing, and also when strict', () => {});
it.skipIf(STRICT_MODE && !HAS_TOOL)('skips only under strict mode', () => {});
it.skipIf(!HAS_TOOL && process.platform === 'linux')('a platform test is not a strict-mode test', () => {});
it.skipIf(skipUnless('tool', HAS_TOOL))('a local function of the same name does not throw', () => {});
it.runIf(HAS_TOOL)('runs only when the tool is present', () => {});
it.runIf(!STRICT_MODE)('runs only when not strict', () => {});
it('skips with a condition argument', (ctx) => {
  ctx.skip(!HAS_TOOL);
});
it('skips with a condition argument that skips under strict mode', (ctx) => {
  ctx.skip(!HAS_TOOL || STRICT_MODE, 'tool missing');
});
it('names the flag in a comment only', (ctx) => {
  // ORACLE_STRICT_MODE and STRICT_MODE are handled by the CI preflight, not here.
  if (!HAS_TOOL) ctx.skip();
});
it('names the flag in a string only', (ctx) => {
  const note = 'throws when ORACLE_STRICT_MODE=1';
  if (!HAS_TOOL) ctx.skip();
});
it('throws only on a branch that strict mode may not take', (ctx) => {
  if (process.env.TOOL_NAME) throw new Error('named tool is broken');
  if (!HAS_TOOL) ctx.skip();
});
          `);
      expect(status).not.toBe(0);
      expect(output.match(/G2c-SKIP-SILENT-UNDER-STRICT/g)).toHaveLength(11);
      expect(output).toContain('it.skipIf(!HAS_TOOL || STRICT_MODE)');
      expect(output).toContain('ctx.skip(!HAS_TOOL)');
      expect(output).toContain('ctx.skip(!HAS_TOOL || STRICT_MODE, \'tool missing\')');
      expect(output).toContain('it.skipIf(skipUnless(\'tool\', HAS_TOOL))');
    });

    it('accepts a strict-aware helper call, or a conjunct that needs strict mode off, however the condition is spelled (negative case)', () => {
      const { status, output } = guardOutputFor(`
import { it, describe } from 'vitest';
import * as strict from './helpers/strict-skip';
import { skipUnless as requireOrSkip, skipWithoutTools, isStrictMode } from './helpers/strict-skip';
import { SKIP_WITHOUT_BINARY } from './helpers/skip-flags';
const STRICT_MODE = process.env.ORACLE_STRICT_MODE === '1';
const HAS_TOOL = Boolean(process.env.TOOL);
const missing = (name: string) => !STRICT_MODE && !HAS_TOOL;
it.skipIf(!HAS_TOOL && !STRICT_MODE)('conjunct of a negated flag', () => {});
it.skipIf(!HAS_TOOL && !isStrictMode())('conjunct of a negated call', () => {});
it.skipIf((!HAS_TOOL && process.env.TOOL_DIR === undefined) && process.env.ORACLE_STRICT_MODE !== '1')('conjunct on the environment', () => {});
it.skipIf(requireOrSkip('tool', HAS_TOOL))('a helper imported under another name', () => {});
it.skipIf(strict.skipUnless('tool', HAS_TOOL) || skipWithoutTools('ffmpeg'))('namespace and named helpers', () => {});
it.skipIf(SKIP_WITHOUT_BINARY)('a constant defined in another helper', () => {});
it.skipIf(missing('sample'))('a local arrow function', () => {});
it.runIf(STRICT_MODE)('runs under strict mode', () => {});
it.runIf(!requireOrSkip('tool', HAS_TOOL))('a helper, negated for runIf', () => {});
it('skips with a condition that needs strict mode off', (ctx) => {
  ctx.skip(!HAS_TOOL && !STRICT_MODE);
});
it('throws before skipping when strict', (ctx) => {
  if (!HAS_TOOL) {
    if (isStrictMode()) throw new Error('tool required');
    ctx.skip();
  }
});
it('skips only in the branch strict mode does not take', (ctx) => {
  if (!STRICT_MODE) {
    ctx.skip();
  }
});
          `, {
        'skip-flags.ts': `export const SKIP_WITHOUT_BINARY = !Boolean(process.env.BINARY) && process.env.ORACLE_STRICT_MODE !== '1';\n`,
      });
      expect(output).not.toContain('G2c-SKIP-SILENT-UNDER-STRICT');
      expect(status).toBe(0);
    });
  });

  // =========================================================================
  // 5. Ratchet Baseline Enforcement
  // =========================================================================
  describe('Ratchet Baseline Mechanism', () => {
    it('allows known violations when covered by baseline (ratchet lock)', () => {
      withTempDir((dir) => {
        const srcDir = path.join(dir, 'src', 'lib', 'conversions');
        fs.mkdirSync(srcDir, { recursive: true });

        fs.writeFileSync(
          path.join(srcDir, 'cad.ts'),
          `
export function encodeStep(model: any): Buffer {
  const vertices = model.vertices.slice(0, 100);
  return Buffer.from(vertices);
}
          `
        );

        const baselinePath = path.join(dir, 'anti-cheat-baseline.json');
        const baseline = [
          {
            rule: 'G3b-TRUNCATION',
            file: 'src/lib/conversions/cad.ts',
            symbol: 'encodeStep',
            reason: 'Temporary truncation pending WP-46',
            owningWP: 'WP-46',
          },
        ];
        fs.writeFileSync(baselinePath, JSON.stringify(baseline, null, 2), 'utf-8');

        const res = runGuardSubprocess(dir, ['--baseline', baselinePath]);
        expect(res.status).toBe(0);
        expect(res.stdout).toContain('Zero un-baselined violations detected');
      });
    });

    it('fails closed when a baseline entry is no longer observed (ratchet down required)', () => {
      withTempDir((dir) => {
        const srcDir = path.join(dir, 'src', 'lib', 'conversions');
        fs.mkdirSync(srcDir, { recursive: true });

        // Clean file without truncation
        fs.writeFileSync(
          path.join(srcDir, 'cad.ts'),
          `
export function encodeStep(model: any): Buffer {
  return Buffer.from(model.vertices);
}
          `
        );

        const baselinePath = path.join(dir, 'anti-cheat-baseline.json');
        const baseline = [
          {
            rule: 'G3b-TRUNCATION',
            file: 'src/lib/conversions/cad.ts',
            symbol: 'encodeStep',
            reason: 'Temporary truncation pending WP-46',
            owningWP: 'WP-46',
          },
        ];
        fs.writeFileSync(baselinePath, JSON.stringify(baseline, null, 2), 'utf-8');

        const res = runGuardSubprocess(dir, ['--baseline', baselinePath]);
        expect(res.status).not.toBe(0);
        expect(res.stderr + res.stdout).toContain('RATCHET VIOLATION');
      });
    });
  });
  // =========================================================================
  // G5 / G6: Governance rules
  // =========================================================================
  describe('Rules G5 and G6: external navigation and built-in import specifiers', () => {
    function writeScript(dir: string, name: string, body: string) {
      const scriptsDir = path.join(dir, 'scripts');
      fs.mkdirSync(scriptsDir, { recursive: true });
      fs.writeFileSync(path.join(scriptsDir, name), body);
    }

    it('flags automation that navigates to an external host (positive case)', () => {
      withTempDir((dir) => {
        writeScript(dir, 'scrape.mjs', `await page.goto('https://third-party-service.dev/pricing');\n`);
        const res = runGuardSubprocess(dir, ['--strict']);
        expect(res.status).not.toBe(0);
        expect(res.stderr + res.stdout).toContain('G5-EXTERNAL-NAVIGATION');
        expect(res.stderr + res.stdout).toContain('third-party-service.dev');
      });
    });

    it('permits automation against the local app (negative case)', () => {
      withTempDir((dir) => {
        writeScript(
          dir,
          'capture.mjs',
          `await page.goto('http://localhost:3000/');\nawait fetch('http://127.0.0.1:3000/api/health');\n`
        );
        const res = runGuardSubprocess(dir, ['--strict']);
        expect(res.status).toBe(0);
        expect(res.stderr + res.stdout).not.toContain('G5-EXTERNAL-NAVIGATION');
      });
    });

    /** Parses strict-mode output into `file -> symbol` entries for a single rule. */
    function ruleHits(output: string, rule: string): Array<{ file: string; symbol: string }> {
      // eslint-disable-next-line no-control-regex
      const plain = output.replace(/\x1b\[[0-9;]*m/g, '');
      const pattern = new RegExp(String.raw`^\s*(\S+):\d+ \[${rule}\] \((.*?)\)`, 'gm');
      return [...plain.matchAll(pattern)].map((m) => ({ file: path.basename(m[1]), symbol: m[2] }));
    }

    it('flags external hosts reached through constants, templates, and request helpers (positive case)', () => {
      withTempDir((dir) => {
        const cases: Record<string, string> = {
          'concat.mjs': `const BASE = 'https://third-party.dev';\nawait page.goto(BASE + '/pricing');\n`,
          'template-ident.mjs': "const BASE = 'https://third-party.dev';\nawait page.goto(`${BASE}/pricing`);\n",
          'template-host.mjs': 'await page.goto(`https://third.party/items/${id}`);\n',
          'const-ident.mjs': `const API = 'https://third-party.dev/api';\nawait fetch(API);\n`,
          'page-request.mjs': `await page.request.get('https://third-party.dev/api');\n`,
          'request-post.mjs': `await request.post('https://third-party.dev/api', { data: 1 });\n`,
          'axios-get.mjs': `await axios.get('https://third-party.dev/api');\n`,
        };
        for (const [name, body] of Object.entries(cases)) writeScript(dir, name, body);
        const res = runGuardSubprocess(dir, ['--strict']);
        expect(res.status).not.toBe(0);
        const hits = ruleHits(res.stderr + res.stdout, 'G5-EXTERNAL-NAVIGATION');
        const flagged = new Map(hits.map((h) => [h.file, h.symbol]));
        expect([...flagged.keys()].sort()).toEqual(Object.keys(cases).sort());
        expect(flagged.get('template-host.mjs')).toBe('third.party');
        expect(flagged.get('concat.mjs')).toBe('third-party.dev');
        expect(flagged.get('template-ident.mjs')).toBe('third-party.dev');
      });
    });

    it('permits local hosts, unresolved bases, comments, and non-request getters (negative case)', () => {
      withTempDir((dir) => {
        writeScript(
          dir,
          'local.mjs',
          [
            `const BASE = 'http://localhost:3000';`,
            `const DOCS = 'https://third-party.dev/docs';`,
            `// await page.goto('https://third-party.dev/commented');`,
            `/* axios.get('https://third-party.dev/block'); */`,
            `await page.goto(BASE + '/convert');`,
            'await page.goto(`${BASE}/convert`);',
            'await page.goto(`${process.env.BASE_URL}/convert`);',
            'await page.goto(`http://${host}:3000/convert`);',
            `await page.request.get('http://127.0.0.1:3000/api/health');`,
            `await axios.post('https://api.example.com/v1', {});`,
            `const cached = cache.get(DOCS);`,
            `console.log(DOCS, cached);`,
          ].join('\n') + '\n'
        );
        const res = runGuardSubprocess(dir, ['--strict']);
        expect(ruleHits(res.stderr + res.stdout, 'G5-EXTERNAL-NAVIGATION')).toEqual([]);
        expect(res.status).toBe(0);
      });
    });

    /** Writes one script per case and returns the G5 `file -> host` hits plus the exit status. */
    function runG5Cases(cases: Record<string, string>): { status: number; flagged: Map<string, string> } {
      let result = { status: 0, flagged: new Map<string, string>() };
      withTempDir((dir) => {
        for (const [name, body] of Object.entries(cases)) writeScript(dir, name, body);
        const res = runGuardSubprocess(dir, ['--strict']);
        const hits = ruleHits(res.stderr + res.stdout, 'G5-EXTERNAL-NAVIGATION');
        result = { status: res.status, flagged: new Map(hits.map((h) => [h.file, h.symbol])) };
      });
      return result;
    }

    function expectAllFlagged(cases: Record<string, string>, host: string) {
      const { status, flagged } = runG5Cases(cases);
      expect(status).not.toBe(0);
      expect([...flagged.keys()].sort()).toEqual(Object.keys(cases).sort());
      expect([...new Set(flagged.values())]).toEqual([host]);
    }

    function expectNoneFlagged(cases: Record<string, string>) {
      const { status, flagged } = runG5Cases(cases);
      expect([...flagged.entries()]).toEqual([]);
      expect(status).toBe(0);
    }

    it('resolves in-scope constants through as const, satisfies, and nested scopes (positive case)', () => {
      expectAllFlagged(
        {
          'as-const.ts': `const API = 'https://third-party.dev/api' as const;\nawait fetch(API);\n`,
          'satisfies.ts': `const API = 'https://third-party.dev/api' satisfies string;\nawait fetch(API);\n`,
          'nested-const.ts': [
            `const BASE = 'https://third-party.dev';`,
            'export async function load(page: { goto(u: string): Promise<void> }) {',
            '  const TARGET = `${BASE}/pricing`;',
            '  await page.goto(TARGET);',
            '}',
          ].join('\n'),
          'block-const.mjs': `{\n  const API = 'https://third-party.dev/v1';\n  await fetch(API);\n}\n`,
        },
        'third-party.dev'
      );
    });

    it('does not resolve a shadowing parameter or local to the outer constant (negative case)', () => {
      expectNoneFlagged({
        'shadow-param.ts': [
          `const BASE = 'https://third-party.dev';`,
          'export async function open(page: { goto(u: string): Promise<void> }, BASE: string) {',
          `  await page.goto(BASE + '/convert');`,
          '}',
          'console.log(BASE);',
        ].join('\n'),
        'shadow-local.mjs': [
          `const BASE = 'https://third-party.dev';`,
          `{`,
          `  const BASE = 'http://localhost:3000';`,
          `  await page.goto(BASE + '/convert');`,
          `}`,
          `console.log(BASE);`,
        ].join('\n'),
        'shadow-arrow.mjs': [
          `const API = 'https://third-party.dev/api';`,
          `const call = (API) => fetch(API);`,
          `console.log(API, call);`,
        ].join('\n'),
        'out-of-scope.mjs': [
          `function a() { const HIDDEN = 'https://third-party.dev'; return HIDDEN; }`,
          `function b() { return fetch(HIDDEN); }`,
          `console.log(a, b);`,
        ].join('\n'),
      });
    });

    it('flags URL-position arguments and axios url/baseURL properties (positive case)', () => {
      expectAllFlagged(
        {
          'axios-config.mjs': `await axios({ url: 'https://third-party.dev/api', method: 'post' });\n`,
          'axios-base.mjs': `const BASE = 'https://third-party.dev';\nawait axios({ baseURL: BASE, url: '/api' });\n`,
          'axios-shorthand.mjs': `const url = 'https://third-party.dev/api';\nawait axios({ url });\n`,
          'axios-request.mjs': `await axios.request({ url: 'https://third-party.dev/api' });\n`,
          'axios-call-url.mjs': `await axios('https://third-party.dev/api', { method: 'get' });\n`,
        },
        'third-party.dev'
      );
    });

    it('ignores external strings in bodies, headers, and other non-URL arguments (negative case)', () => {
      expectNoneFlagged({
        'request-body.mjs': `await request.post('/api/convert', { data: { source: 'https://third-party.dev/file.pdf' } });\n`,
        'fetch-init.mjs': [
          `await fetch('/api/convert', {`,
          `  method: 'POST',`,
          `  body: JSON.stringify({ url: 'https://third-party.dev/file.pdf' }),`,
          `  headers: { Referer: 'https://third-party.dev/' },`,
          `});`,
        ].join('\n'),
        'goto-second-arg.mjs': `await context.newPage();\nawait page.goto(url, 'https://third-party.dev/ref');\n`,
        'axios-post-body.mjs': `await axios.post('/api/import', 'https://third-party.dev/file.pdf');\n`,
        'axios-config-data.mjs': `await axios({ url: '/api', data: { link: 'https://third-party.dev/x' } });\n`,
        'page-request-data.mjs': `await page.request.put('/api/x', { data: 'https://third-party.dev/y' });\n`,
      });
    });

    it('flags a known external host followed by an unknown path (positive case)', () => {
      expectAllFlagged(
        {
          'tpl-path.mjs': 'await page.goto(`https://third-party.dev/${path}`);\n',
          'concat-path.mjs': `await fetch('https://third-party.dev/' + path);\n`,
          'concat-chain.mjs': `const BASE = 'https://third-party.dev';\nawait fetch(BASE + '/' + id + '/raw');\n`,
          'tpl-port.mjs': 'await page.goto(`https://third-party.dev:8443/${path}`);\n',
          'tpl-unknown-port.mjs': 'await page.goto(`https://third-party.dev:${port}/x`);\n',
          'tpl-query.mjs': 'await fetch(`https://third-party.dev?q=${encodeURIComponent(q)}`);\n',
        },
        'third-party.dev'
      );
    });

    it('flags the host after userinfo even when the credentials are unknown (positive case)', () => {
      expectAllFlagged(
        {
          'userinfo-template.mjs': 'await fetch(`https://api:${process.env.KEY}@third-party.dev/v3`);\n',
          'userinfo-concat.mjs': `await fetch('https://deploy:' + token + '@third-party.dev');\n`,
          'userinfo-new-url.mjs': `await fetch(new URL(path, 'https://api:' + key + '@third-party.dev'));\n`,
          'userinfo-literal.mjs': `await fetch('https://api:secret@third-party.dev/v3');\n`,
        },
        'third-party.dev'
      );
    });

    it('flags conservatively when a single label before ":" may be userinfo for an unknown host (positive case)', () => {
      const { status, flagged } = runG5Cases({
        'unknown-password.mjs': 'await fetch(`https://api:${process.env.KEY}`);\n',
        'userinfo-unknown-host.mjs': `await fetch('https://api:' + key + '@' + host);\n`,
        'userinfo-hole.mjs': 'await fetch(`https://api:${key}@${host}/v3`);\n',
        'ws-unknown-host.mjs': `const socket = new WebSocket('wss://deploy:' + token);\n`,
      });
      expect(status).not.toBe(0);
      expect([...flagged.keys()].sort()).toEqual([
        'unknown-password.mjs',
        'userinfo-hole.mjs',
        'userinfo-unknown-host.mjs',
        'ws-unknown-host.mjs',
      ]);
      expect([...new Set(flagged.values())]).toEqual(['<unknown host>']);
    });

    it('flags a literal host or external suffix next to an unknown value without a port (positive case)', () => {
      const { status, flagged } = runG5Cases({
        'dotted-host-suffix.mjs': 'await fetch(`https://third-party.dev${path}`);\n',
        'const-base-suffix.mjs': `const BASE = 'https://third-party.dev';\nawait fetch(BASE + path);\n`,
        'label-host-suffix.mjs': 'await fetch(`https://third-party${tld}/x`);\n',
        'unknown-subdomain.mjs': 'await page.goto(`https://${sub}.third-party.dev/x`);\n',
      });
      expect(status).not.toBe(0);
      expect(Object.fromEntries(flagged)).toEqual({
        'dotted-host-suffix.mjs': 'third-party.dev',
        'const-base-suffix.mjs': 'third-party.dev',
        'label-host-suffix.mjs': '<unknown host>',
        'unknown-subdomain.mjs': '*.third-party.dev',
      });
    });

    it('does not flag a prefix whose host is incomplete (negative case)', () => {
      expectNoneFlagged({
        'tpl-host.mjs': 'await page.goto(`https://${host}`);\n',
        'concat-host.mjs': `await fetch('https://' + host);\n`,
        'local-host-suffix.mjs': 'await fetch(`https://localhost${p}`);\n',
        'loopback-host-suffix.mjs': 'await fetch(`http://127.0.0.1${p}`);\n',
        'local-subdomain.mjs': 'await fetch(`http://${sub}.localhost:3000/x`);\n',
        'env-base-suffix.mjs': `await fetch(process.env.BASE_URL + path);\n`,
        'userinfo-local.mjs': 'await fetch(`https://api:${process.env.KEY}@localhost:3000/v3`);\n',
        'local-unknown-port.mjs': 'await page.goto(`http://localhost:${port}/convert`);\n',
        'loopback-unknown-port.mjs': `await fetch('http://127.0.0.1:' + port + '/api');\n`,
        'env-host-port.mjs': 'await fetch(`http://${process.env.HOST}:${process.env.PORT}/api`);\n',
      });
    });

    it('resolves new URL bases, URL objects, and baseURL options (positive case)', () => {
      expectAllFlagged(
        {
          'new-url-base.mjs': `const BASE = 'https://third-party.dev';\nawait page.goto(new URL('/pricing', BASE));\n`,
          'new-url-unknown-path.mjs': `const BASE = 'https://third-party.dev';\nawait fetch(new URL(path, BASE));\n`,
          'url-object.mjs': `const TARGET = new URL('https://third-party.dev/api');\nawait fetch(TARGET);\n`,
          'url-object-base.mjs': `const TARGET = new URL('/api', 'https://third-party.dev');\nawait page.goto(TARGET);\n`,
          'new-context.mjs': `const ctx = await request.newContext({ baseURL: 'https://third-party.dev' });\n`,
          'new-context-const.mjs': `const OPTIONS = { baseURL: 'https://third-party.dev/' };\nawait browser.newContext(OPTIONS);\n`,
        },
        'third-party.dev'
      );
    });

    it('permits new URL with a local base or an absolute local path (negative case)', () => {
      expectNoneFlagged({
        'new-url-local.mjs': `await page.goto(new URL('/convert', 'http://localhost:3000'));\n`,
        'new-url-override.mjs': `const BASE = 'https://third-party.dev';\nawait fetch(new URL('http://localhost:3000/api', BASE));\n`,
        'new-context-env.mjs': [
          `await request.newContext({`,
          `  baseURL: process.env.BASE_URL,`,
          `  extraHTTPHeaders: { Referer: 'https://third-party.dev/' },`,
          `});`,
        ].join('\n'),
      });
    });

    it('flags node http clients, WebSocket, Request, and axios/test baseURL options (positive case)', () => {
      expectAllFlagged(
        {
          'https-get.mjs': `import https from 'node:https';\nhttps.get('https://third-party.dev/feed', (res) => res.resume());\n`,
          'http-get.mjs': `import http from 'node:http';\nhttp.get('http://third-party.dev/feed');\n`,
          'http-request.mjs': `import http from 'node:http';\nhttp.request('http://third-party.dev/feed', { method: 'POST' }).end();\n`,
          'websocket.mjs': `const socket = new WebSocket('wss://third-party.dev/stream');\n`,
          'websocket-const.mjs': "const BASE = 'third-party.dev';\nconst socket = new WebSocket(`wss://${BASE}/stream`);\n",
          'fetch-request.mjs': `await fetch(new Request('https://third-party.dev/api'));\n`,
          'axios-create.mjs': `const client = axios.create({ baseURL: 'https://third-party.dev' });\n`,
          'axios-get-base.mjs': `await axios.get('/api', { baseURL: 'https://third-party.dev' });\n`,
          'axios-post-base.mjs': `await axios.post('/api', { name: 'x' }, { baseURL: 'https://third-party.dev' });\n`,
          'test-use.ts': `import { test } from '@playwright/test';\ntest.use({ baseURL: 'https://third-party.dev' });\n`,
        },
        'third-party.dev'
      );
    });

    it('flags EventSource, node http option hosts, named node http imports, and slashless schemes (positive case)', () => {
      expectAllFlagged(
        {
          'event-source.mjs': `const events = new EventSource('https://third-party.dev/events');\n`,
          'https-options.mjs': `import https from 'node:https';\nhttps.get({ hostname: 'third-party.dev', path: '/feed' });\n`,
          'http-options-host.mjs': `import http from 'node:http';\nhttp.request({ host: 'third-party.dev', port: 80 }).end();\n`,
          'named-get.mjs': `import { get } from 'node:https';\nget('https://third-party.dev/feed');\n`,
          'named-request.mjs': `import { request as send } from 'node:http';\nsend({ hostname: 'third-party.dev' }).end();\n`,
          'slashless-scheme.mjs': `await fetch('https:third-party.dev/api');\n`,
        },
        'third-party.dev'
      );
      expectNoneFlagged({
        'http-options-local.mjs': `import http from 'node:http';\nhttp.request({ host: 'localhost', port: 3000, headers: { Referer: 'https://third-party.dev/' } }).end();\n`,
        'named-get-other.mjs': `import { get } from 'lodash';\nget({ hostname: 'third-party.dev' }, 'hostname');\n`,
        'event-source-local.mjs': `const events = new EventSource('http://localhost:3000/events');\n`,
      });
    });

    it('ignores non-URL arguments of node http clients, WebSocket, and axios (negative case)', () => {
      expectNoneFlagged({
        'http-local.mjs': `import http from 'node:http';\nhttp.get('http://localhost:3000/health', { headers: { Referer: 'https://third-party.dev/' } });\n`,
        'websocket-local.mjs': `const socket = new WebSocket('ws://localhost:3000/ws', 'https://third-party.dev/protocol');\n`,
        'request-init.mjs': `await fetch(new Request('/api', { body: 'https://third-party.dev/file.pdf', method: 'POST' }));\n`,
        'axios-post-data.mjs': `await axios.post('/api', { baseURL: 'https://third-party.dev' });\n`,
        'axios-create-headers.mjs': `axios.create({ baseURL: 'http://localhost:3000', headers: { Origin: 'https://third-party.dev' } });\n`,
        'test-use-local.ts': `import { test } from '@playwright/test';\ntest.use({ baseURL: 'http://localhost:3000', extraHTTPHeaders: { Referer: 'https://third-party.dev/' } });\n`,
        'map-get.mjs': `const cache = new Map();\ncache.get('https://third-party.dev/key');\n`,
      });
    });

    it('treats tagged templates like template literals', () => {
      expectAllFlagged(
        {
          'tagged-raw.mjs': 'await fetch(String.raw`https://third-party.dev/a`);\n',
          'tagged-path.mjs': 'await page.goto(url`https://third-party.dev/${path}`);\n',
        },
        'third-party.dev'
      );
      expectNoneFlagged({ 'tagged-local.mjs': 'await page.goto(String.raw`http://localhost:3000/`);\n' });
    });

    it('treats loopback, docker, and reserved names as local (negative case)', () => {
      const hosts = [
        'http://127.0.0.2:3000/',
        'http://127.255.255.254/',
        'http://0.0.0.0:3000/',
        'http://[::1]:3000/',
        'http://app.localhost:3000/',
        'http://host.docker.internal:3000/',
        'http://redis:6379/',
        'http://worker:3000/health',
        'https://svc.test/',
        'https://site.example/',
        'https://nowhere.invalid/',
        'https://api.example.com/',
      ];
      expectNoneFlagged({ 'local-hosts.mjs': hosts.map((h) => `await fetch('${h}');`).join('\n') });
    });

    it('keeps public hosts that resemble local names flagged (positive case)', () => {
      const { status, flagged } = runG5Cases({
        'ip-128.mjs': `await fetch('http://128.0.0.1/');\n`,
        'localhost-prefix.mjs': `await fetch('https://localhost.third-party.dev/');\n`,
        'test-label.mjs': `await fetch('https://test.third-party.dev/');\n`,
        'docker-lookalike.mjs': `await fetch('https://host.docker.internal.third-party.dev/');\n`,
        'example-tld.mjs': `await fetch('https://example.dev/');\n`,
      });
      expect(status).not.toBe(0);
      expect(Object.fromEntries(flagged)).toEqual({
        'ip-128.mjs': '128.0.0.1',
        'localhost-prefix.mjs': 'localhost.third-party.dev',
        'test-label.mjs': 'test.third-party.dev',
        'docker-lookalike.mjs': 'host.docker.internal.third-party.dev',
        'example-tld.mjs': 'example.dev',
      });
    });

    it('flags import-equals and dynamic import of un-prefixed built-ins (positive case)', () => {
      withTempDir((dir) => {
        writeScript(
          dir,
          'legacy-forms.ts',
          `import zlib = require('zlib');\nconst os = await import('os');\nconst fs = require('fs');\nexport { zlib, os, fs };\n`
        );
        const res = runGuardSubprocess(dir, ['--strict']);
        expect(res.status).not.toBe(0);
        const symbols = ruleHits(res.stderr + res.stdout, 'G6-NODE-PREFIX').map((h) => h.symbol);
        expect(symbols.sort()).toEqual(['fs', 'os', 'zlib']);
      });
    });

    it('flags built-in imports without the node: prefix (positive case)', () => {
      withTempDir((dir) => {
        writeScript(dir, 'legacy.ts', `import fs from 'fs';\nconst cp = require('child_process');\nexport { fs, cp };\n`);
        const res = runGuardSubprocess(dir, ['--strict']);
        expect(res.status).not.toBe(0);
        const output = res.stderr + res.stdout;
        expect(output.match(/G6-NODE-PREFIX/g)?.length).toBe(2);
      });
    });

    it('permits node:-prefixed built-ins and package imports (negative case)', () => {
      withTempDir((dir) => {
        writeScript(dir, 'modern.ts', `import fs from 'node:fs';\nimport ts from 'typescript';\nexport { fs, ts };\n`);
        const res = runGuardSubprocess(dir, ['--strict']);
        expect(res.status).toBe(0);
        expect(res.stderr + res.stdout).not.toContain('G6-NODE-PREFIX');
      });
    });
  });
});
