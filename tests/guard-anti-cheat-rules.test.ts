import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

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
        writeScript(dir, 'scrape.mjs', `await page.goto('https://third-party-service.test/pricing');\n`);
        const res = runGuardSubprocess(dir, ['--strict']);
        expect(res.status).not.toBe(0);
        expect(res.stderr + res.stdout).toContain('G5-EXTERNAL-NAVIGATION');
        expect(res.stderr + res.stdout).toContain('third-party-service.test');
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
          'concat.mjs': `const BASE = 'https://third-party.test';\nawait page.goto(BASE + '/pricing');\n`,
          'template-ident.mjs': "const BASE = 'https://third-party.test';\nawait page.goto(`${BASE}/pricing`);\n",
          'template-host.mjs': 'await page.goto(`https://third.party/items/${id}`);\n',
          'const-ident.mjs': `const API = 'https://third-party.test/api';\nawait fetch(API);\n`,
          'page-request.mjs': `await page.request.get('https://third-party.test/api');\n`,
          'request-post.mjs': `await request.post('https://third-party.test/api', { data: 1 });\n`,
          'axios-get.mjs': `await axios.get('https://third-party.test/api');\n`,
          'second-arg.mjs': `await context.newPage();\nawait page.goto(url, 'https://third-party.test/ref');\n`,
        };
        for (const [name, body] of Object.entries(cases)) writeScript(dir, name, body);
        const res = runGuardSubprocess(dir, ['--strict']);
        expect(res.status).not.toBe(0);
        const hits = ruleHits(res.stderr + res.stdout, 'G5-EXTERNAL-NAVIGATION');
        const flagged = new Map(hits.map((h) => [h.file, h.symbol]));
        expect([...flagged.keys()].sort()).toEqual(Object.keys(cases).sort());
        expect(flagged.get('template-host.mjs')).toBe('third.party');
        expect(flagged.get('concat.mjs')).toBe('third-party.test');
        expect(flagged.get('template-ident.mjs')).toBe('third-party.test');
      });
    });

    it('permits local hosts, unresolved bases, comments, and non-request getters (negative case)', () => {
      withTempDir((dir) => {
        writeScript(
          dir,
          'local.mjs',
          [
            `const BASE = 'http://localhost:3000';`,
            `const DOCS = 'https://third-party.test/docs';`,
            `// await page.goto('https://third-party.test/commented');`,
            `/* axios.get('https://third-party.test/block'); */`,
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
