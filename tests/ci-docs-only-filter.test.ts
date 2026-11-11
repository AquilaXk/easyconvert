import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';

/**
 * The step of ci.yml that decides whether a push changed code or documentation only, run on a real git history. A push that changes
 * documentation only skips every heavy job, and `verify` then succeeds with all of them skipped; a file that an image contains must
 * therefore never count as documentation, or the deploy gate (scripts/ci-commit-gate.sh) would see no code check for it.
 */

const ROOT = path.resolve(__dirname, '..');
const workflow = parse(readFileSync(path.join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf-8')) as {
  jobs: { changes: { env: Record<string, string>; steps: Array<{ id?: string; run?: string }> } };
};
const changes = workflow.jobs.changes;
const script = changes.steps.find((step) => step.id === 'filter')?.run ?? '';
const sandboxes: string[] = [];

afterAll(() => {
  for (const dir of sandboxes) rmSync(dir, { recursive: true, force: true });
});

function codeChangedBy(file: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'ci-docs-filter-'));
  sandboxes.push(dir);
  const git = (...args: string[]): string => {
    const result = spawnSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.test', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf-8' });
    if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
    return result.stdout.trim();
  };
  git('init', '-q', '-b', 'main');
  writeFileSync(path.join(dir, 'seed.txt'), 'seed');
  git('add', '--', 'seed.txt');
  git('commit', '-q', '-m', 'seed');
  const before = git('rev-parse', 'HEAD');
  mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  writeFileSync(path.join(dir, file), 'changed');
  git('add', '--', file);
  git('commit', '-q', '-m', `change ${file}`);
  git('remote', 'add', 'origin', dir);
  const output = path.join(dir, 'github-output.txt');
  writeFileSync(output, '');
  const result = spawnSync('bash', ['-c', script], {
    cwd: dir,
    encoding: 'utf-8',
    env: { PATH: process.env.PATH ?? '', HOME: dir, ...changes.env, EVENT_NAME: 'push', PUSH_BEFORE_SHA: before, PR_BASE_SHA: '', GITHUB_OUTPUT: output } as unknown as NodeJS.ProcessEnv,
  });
  expect(result.status, result.stderr).toBe(0);
  return /^code=(\w+)$/m.exec(readFileSync(output, 'utf-8'))?.[1] ?? '';
}

describe('the code filter of the changes job', () => {
  it.each(['docs/legal/privacy.en.md', 'docs/legal/terms.ko.md', 'docs/legal/SOURCES.md', 'THIRD_PARTY_NOTICES.md', 'docs/configuration.md', 'src/lib/notes.md', 'tests/fixtures/readme.md', 'src/app/page.tsx'])(
    'counts a change to %s as a change of code, so the heavy jobs run',
    (file) => {
      expect(codeChangedBy(file)).toBe('true');
    }
  );

  it.each(['docs/deploy-oci.md', 'docs/operations/notes.md', 'README.md', 'CHANGELOG.md', 'native/qpdf-runner/README.md'])('counts a change to %s as documentation only', (file) => {
    expect(codeChangedBy(file)).toBe('false');
  });
});
