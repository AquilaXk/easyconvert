import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { GATE_FILES, takeBaseGate } from '../scripts/ci-base-gate.mjs';

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
  it('names the files that decide a speed row: the verdict, the thresholds and the A/B machinery, and none that a family measures', () => {
    expect(GATE_FILES).toEqual(expect.arrayContaining(['bench/parity.ts', 'bench/ab-config.ts', 'bench/ab-speed.ts', 'bench/ab-host.ts', 'bench/speed-parity.ts']));
    for (const file of GATE_FILES) expect(file, file).not.toMatch(/families\/|rows\.ts|baseline|corpus|family-map|^bench\/config\.ts$/);
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
