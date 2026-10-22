import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { policyNumberingFaults } from '../scripts/guard-policy-decisions.mjs';

const ROOT = path.resolve(__dirname, '..');
const GUARD = path.join(ROOT, 'scripts', 'guard-policy-decisions.mjs');
const POLICY = readFileSync(path.join(ROOT, 'docs', 'policy-decisions.md'), 'utf-8');
const ci = readFileSync(path.join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf-8');

const temps: string[] = [];
afterAll(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

function edited(from: string, to: string): string {
  expect(POLICY.split(from).length - 1, `"${from}" appears once in the document`).toBe(1);
  return POLICY.replace(from, to);
}

const HEADING_63 = '## 63. Flaky unit tests of the shard run';
const HEADING_67 = '## 67. Page images of a document';
const ROW_66 = '66. [Opus from a source';
const ROW_67 = '67. [Page images of a document';

describe('the numbering of the policy decisions', () => {
  it('holds in the committed document', () => {
    expect(policyNumberingFaults(POLICY)).toEqual([]);
  });

  it('refuses a heading that takes a number another heading has', () => {
    const faults = policyNumberingFaults(edited(HEADING_67, '## 66. Page images of a document'));
    expect(faults).toContainEqual(expect.stringMatching(/entry number 66 is already used by the heading on line \d+/));
  });

  it('refuses a heading that has no row in the contents', () => {
    const faults = policyNumberingFaults(`${POLICY}\n## 900. An entry added without its row\n`);
    expect(faults).toContainEqual(expect.stringMatching(/entry 900 has no row in the contents/));
  });

  it('refuses a row whose heading is gone', () => {
    const faults = policyNumberingFaults(edited(HEADING_67, '## 901. Page images of a document'));
    expect(faults).toContainEqual(expect.stringMatching(/the contents list 67 but no heading has that number/));
    expect(faults).toContainEqual(expect.stringMatching(/entry 901 has no row in the contents/));
  });

  it('refuses the same number in two rows of the contents', () => {
    const faults = policyNumberingFaults(edited(ROW_67, `66. [Page images of a document`).replace('(#67-', '(#66-'));
    expect(faults).toContainEqual(expect.stringMatching(/the contents list 66 twice/));
  });

  it('refuses a row whose title or link differs from its heading', () => {
    const faults = policyNumberingFaults(edited(ROW_67, '67. [Page images, renamed in the heading only'));
    expect(faults).toContainEqual(expect.stringMatching(/the row for 67 reads "Page images, renamed in the heading only/));
  });

  it('refuses rows out of numeric order within a group, and lets the groups follow each other in any order', () => {
    const lines = POLICY.split('\n');
    const first = lines.findIndex((line) => line.startsWith(ROW_66));
    const second = lines.findIndex((line) => line.startsWith(ROW_67));
    expect(second).toBe(first + 1);
    [lines[first], lines[second]] = [lines[second], lines[first]];
    expect(policyNumberingFaults(lines.join('\n'))).toContainEqual(expect.stringMatching(/row 66 follows row 67 in the group/));
  });

  it('exits non-zero from the command line with the faults named, and zero on a sound document', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'policy-numbering-'));
    temps.push(dir);
    const broken = path.join(dir, 'broken.md');
    writeFileSync(broken, edited(HEADING_63, '## 62. Flaky unit tests of the shard run'));
    const refused = spawnSync(process.execPath, [GUARD, broken], { encoding: 'utf-8' });
    expect(refused.status).toBe(1);
    expect(refused.stderr).toMatch(/entry number 62 is already used/);
    const accepted = spawnSync(process.execPath, [GUARD], { encoding: 'utf-8' });
    expect(accepted.status, accepted.stderr).toBe(0);
  });

  it('runs in the CI job that every pull request starts, documentation-only ones included', () => {
    const changesJob = ci.slice(ci.indexOf('\n  changes:'), ci.indexOf('\n  checks:'));
    const step = /- name: Check the numbering of docs\/policy-decisions\.md\n\s+run: (.+)/.exec(changesJob);
    expect(step?.[1]).toBe('node scripts/guard-policy-decisions.mjs');
  });
});
