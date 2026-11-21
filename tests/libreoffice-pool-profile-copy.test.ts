import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LibreOfficePoolManager } from '../src/worker/libreoffice-pool';

/**
 * A job of a pool slot starts from a profile made again (a copy of the template the readiness probe left, then the fixed settings), and the
 * copy is on the path of every small conversion: the suite converts a one-sheet workbook in 0.14 s, and `fs.promises.cp` of the template (about
 * 100 files, 0.2 MB) took 20 ms of it. The copy is measured against `fs.promises.cp` of the same tree, in the same run, so the check does not
 * depend on the speed of the disk (0.15 times on the Linux testbed's tmpfs, 0.5 on an APFS disk, where creating files is the cost) (docs/policy-decisions.md, entry 387).
 */

const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const FILE_COUNT = 100;

/** A template like the one the suite leaves: nested directories, small files of a few kilobytes, one link. */
function makeTemplate(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pool-profile-copy-'));
  scratch.push(root);
  const template = path.join(root, 'template');
  for (let i = 0; i < FILE_COUNT; i++) {
    const dir = path.join(template, 'user', `d${i % 10}`, `e${i % 3}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `f${i}.xcu`), `<item>${String(i).repeat(1800)}</item>`);
  }
  fs.symlinkSync('/nonexistent-target', path.join(template, 'user', 'link'));
  return template;
}

function poolWithTemplate(template: string): { reset: (dir: string) => Promise<void> } {
  const pool = new LibreOfficePoolManager({ maxWorkers: 1, minWorkers: 0, sofficePath: '/usr/bin/soffice', enabled: true, readinessProbe: false });
  const internals = pool as unknown as { profileTemplate: { sofficePath: string; dir: string } | null; resetProfile: (dir: string) => Promise<void> };
  internals.profileTemplate = { sofficePath: '/usr/bin/soffice', dir: template };
  return { reset: (dir) => internals.resetProfile(dir) };
}

describe('the copy of the profile template before a job', () => {
  it('puts every file, directory and link of the template into the profile of the slot', async () => {
    const template = makeTemplate();
    const profile = path.join(path.dirname(template), 'profile');
    fs.mkdirSync(profile);
    fs.writeFileSync(path.join(profile, 'left-by-the-last-job'), 'x');

    await poolWithTemplate(template).reset(profile);

    expect(fs.existsSync(path.join(profile, 'left-by-the-last-job'))).toBe(false);
    expect(fs.readlinkSync(path.join(profile, 'user', 'link'))).toBe('/nonexistent-target');
    expect(fs.readFileSync(path.join(profile, 'user', 'd7', 'e1', 'f7.xcu'), 'utf8')).toBe(`<item>${'7'.repeat(1800)}</item>`);
    expect(fs.readFileSync(path.join(profile, 'user', 'registrymodifications.xcu'), 'utf8')).toContain('DisableMacrosExecution');
  });

  it('does not go through fs.promises.cp, which costs a round trip to the thread pool for each of the files', async () => {
    const template = makeTemplate();
    const profile = path.join(path.dirname(template), 'profile');
    const calls: unknown[][] = [];
    const original = fs.promises.cp;
    fs.promises.cp = ((...args: Parameters<typeof fs.promises.cp>) => {
      calls.push(args);
      return original(...args);
    }) as typeof fs.promises.cp;
    try {
      await poolWithTemplate(template).reset(profile);
    } finally {
      fs.promises.cp = original;
    }

    expect(calls).toEqual([]);
    expect(fs.existsSync(path.join(profile, 'user', 'd0', 'e0', 'f0.xcu'))).toBe(true);
  });
});
