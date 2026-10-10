import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { GATE_FILES, takeBaseGate } from '../scripts/ci-parity-base-gate.mjs';

/**
 * A change cannot loosen the gate that judges it: the files that decide a speed row are taken from the base commit.
 */

const work = mkdtempSync(path.join(tmpdir(), 'ci-base-gate-'));
afterAll(() => rmSync(work, { recursive: true, force: true }));

function tree(name: string, files: Record<string, string>): string {
  const root = path.join(work, name);
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), text);
  }
  return root;
}

describe('taking the gate of the base', () => {
  it('names the files that decide a speed row and the inputs they read, and none that a family defines', () => {
    expect(GATE_FILES).toEqual(
      expect.arrayContaining([
        'bench/judge.ts',
        'bench/parity.ts',
        'bench/speed-config.ts',
        'bench/speed-timing.ts',
        'bench/speed-rows.ts',
        'bench/report-schema.ts',
        'bench/ab-config.ts',
        'bench/ab-speed.ts',
        'bench/ab-host.ts',
        'bench/stats.ts',
      ])
    );
    // What a family defines or a run is set up with stays the change's, so that a change can add a family or a row.
    const headOwned = [/^bench\/families\//, /^bench\/rows\.ts$/, /^bench\/config\.ts$/, /^bench\/report\.ts$/, /^bench\/context\.ts$/, /^bench\/run\.ts$/, /baseline\.json$/, /^bench\/corpus\//, /family-map/];
    for (const file of GATE_FILES) for (const pattern of headOwned) expect(file, `${file} ${pattern}`).not.toMatch(pattern);
    for (const file of GATE_FILES) expect(readFileSync(path.join(__dirname, '..', file), 'utf8').length, file).toBeGreaterThan(0);
  });

  it("puts the base's file over the change's, leaves a file the base does not have, and the rest of the tree alone", () => {
    const base = tree('base', { 'bench/ab-config.ts': 'export const AB_DEFAULT_REGRESSION = 0.1;\n', 'bench/parity.ts': 'same\n' });
    const change = tree('change', {
      'bench/ab-config.ts': 'export const AB_DEFAULT_REGRESSION = 0.9;\n',
      'bench/parity.ts': 'same\n',
      'bench/ab-speed.ts': 'the change introduces this file\n',
      'bench/families/pdf-ops.ts': 'the change adds a family\n',
    });
    const { replaced, missing } = takeBaseGate(base, change);
    expect(replaced).toEqual(['bench/ab-config.ts']);
    expect(readFileSync(path.join(change, 'bench/ab-config.ts'), 'utf8')).toBe('export const AB_DEFAULT_REGRESSION = 0.1;\n');
    expect(missing).toContain('bench/ab-speed.ts');
    expect(readFileSync(path.join(change, 'bench/ab-speed.ts'), 'utf8')).toBe('the change introduces this file\n');
    expect(readFileSync(path.join(change, 'bench/families/pdf-ops.ts'), 'utf8')).toBe('the change adds a family\n');
  });

  it('replaces nothing when the change did not touch the gate', () => {
    const base = tree('base2', { 'bench/parity.ts': 'a\n', 'bench/ab-config.ts': 'b\n' });
    const change = tree('change2', { 'bench/parity.ts': 'a\n', 'bench/ab-config.ts': 'b\n' });
    expect(takeBaseGate(base, change).replaced).toEqual([]);
  });
});

describe('what the gate files read', () => {
  const listed = new Set(GATE_FILES.map((file) => path.basename(file, '.ts')));
  /** The few things a gate file reads from the change's own files: a path, a type. */
  // The verdict reads which rows a quick run covers from the change's own bench/config.ts (data that grows with a family).
  const ALLOWED = new Map<string, string>([['judge', 'scope']]);

  it('stays inside the gate files at run time, so a change cannot reach the verdict through a file it owns', () => {
    for (const file of GATE_FILES) {
      const text = readFileSync(path.join(__dirname, '..', file), 'utf8');
      const name = path.basename(file, '.ts');
      // Runtime imports of a sibling: `import { a } from './x'` and `import { type A, b } from './x'`, not `import type`.
      for (const match of text.matchAll(/^import (?!type )[^;]*?from '\.\/([\w-]+)';/gms)) {
        const imported = match[1];
        expect(listed.has(imported) || ALLOWED.get(name) === imported, `${file} imports ./${imported} at run time`).toBe(true);
      }
    }
  });
});
