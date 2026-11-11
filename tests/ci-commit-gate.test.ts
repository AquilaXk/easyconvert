import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';

/**
 * scripts/ci-commit-gate.sh: what the deploy workflow asks of a commit and of an image. `gh` and `docker` are stubs that answer from
 * files; git is real, in a temporary repository, so the pathspecs that decide which commits share their image contents are the
 * ones that run in the workflow.
 */

const ROOT = path.resolve(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'ci-commit-gate.sh');
const WEB = 'ghcr.io/example/web';
const WORKER = 'ghcr.io/example/worker';
const sandboxes: string[] = [];

afterAll(() => {
  for (const dir of sandboxes) rmSync(dir, { recursive: true, force: true });
});

interface Sandbox {
  repo: string;
  bin: string;
  ci: string;
  images: string;
}

function makeSandbox(): Sandbox {
  const dir = mkdtempSync(path.join(tmpdir(), 'ci-commit-gate-'));
  sandboxes.push(dir);
  const sandbox = { repo: path.join(dir, 'repo'), bin: path.join(dir, 'bin'), ci: path.join(dir, 'ci'), images: path.join(dir, 'images') };
  for (const directory of Object.values(sandbox)) mkdirSync(directory);
  // `gh api repos/<repo>/commits/<sha>/check-runs?...` answers with ci/<sha>.json, or an empty list. Each call is counted, and a file
  // ci/<sha>.then.json replaces the answer from the second call on, which is how a check run that finishes while it is waited for is made.
  writeFileSync(
    path.join(sandbox.bin, 'gh'),
    `#!/usr/bin/env bash
[ "$1" = api ] || exit 64
sha="$(printf '%s' "$2" | sed -E 's#.*/commits/([0-9a-f]{40})/check-runs.*#\\1#')"
printf '.' >> "$STUB_CI/$sha.calls"
printf '%s' "$2" > "$STUB_CI/last-url"
calls="$(wc -c < "$STUB_CI/$sha.calls" | tr -d ' ')"
if [ "$calls" -gt 1 ] && [ -f "$STUB_CI/$sha.then.json" ]; then cat "$STUB_CI/$sha.then.json"; exit 0; fi
if [ -f "$STUB_CI/$sha.json" ]; then cat "$STUB_CI/$sha.json"; else echo '{"check_runs":[]}'; fi
`
  );
  // `docker buildx imagetools inspect --format {{json .Image}} <repo>:<ref>` answers with images/<repo with / and : as _>.json.
  writeFileSync(
    path.join(sandbox.bin, 'docker'),
    `#!/usr/bin/env bash
[ "$1 $2 $3 $4 $5" = "buildx imagetools inspect --format {{json .Image}}" ] || exit 64
file="$STUB_IMAGES/$(printf '%s' "$6" | tr '/:' '__').json"
[ -f "$file" ] && cat "$file" || { echo "no such image $6" >&2; exit 1; }
`
  );
  chmodSync(path.join(sandbox.bin, 'gh'), 0o755);
  chmodSync(path.join(sandbox.bin, 'docker'), 0o755);
  return sandbox;
}

function git(sandbox: Sandbox, ...args: string[]): string {
  const result = spawnSync('git', ['-C', sandbox.repo, '-c', 'user.name=t', '-c', 'user.email=t@example.test', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf-8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}

/** Commits one file change and returns the commit. */
function commit(sandbox: Sandbox, file: string, content: string): string {
  mkdirSync(path.dirname(path.join(sandbox.repo, file)), { recursive: true });
  writeFileSync(path.join(sandbox.repo, file), content);
  git(sandbox, 'add', '--', file);
  git(sandbox, 'commit', '-q', '-m', `change ${file}`);
  return git(sandbox, 'rev-parse', 'HEAD');
}

type Verdict = 'success' | 'failure' | 'in_progress' | 'none';

function recordCheck(sandbox: Sandbox, sha: string, verdict: Verdict, file: 'json' | 'then.json' = 'json'): void {
  if (verdict === 'none') return;
  const run =
    verdict === 'in_progress'
      ? { name: 'verify', status: 'in_progress', conclusion: null, started_at: '2026-11-11T07:00:00Z', app: { slug: 'github-actions' } }
      : { name: 'verify', status: 'completed', conclusion: verdict, started_at: '2026-11-11T07:00:00Z', app: { slug: 'github-actions' } };
  writeFileSync(path.join(sandbox.ci, `${sha}.${file}`), JSON.stringify({ total_count: 1, check_runs: [run] }));
}

function recordImage(sandbox: Sandbox, repo: string, ref: string, labels: Record<string, string> | null): void {
  writeFileSync(path.join(sandbox.images, `${repo}:${ref}`.replace(/[/:]/g, '_') + '.json'), JSON.stringify({ architecture: 'arm64', config: labels === null ? {} : { Labels: labels } }));
}

function run(sandbox: Sandbox, args: string[], env: Record<string, string> = {}) {
  return spawnSync('bash', [SCRIPT, ...args], {
    cwd: sandbox.repo,
    encoding: 'utf-8',
    timeout: 20_000,
    env: {
      PATH: `${sandbox.bin}:${process.env.PATH ?? ''}`,
      HOME: sandbox.repo,
      GITHUB_REPOSITORY: 'example/repo',
      STUB_CI: sandbox.ci,
      STUB_IMAGES: sandbox.images,
      GATE_POLL_SECONDS: '0',
      ...env,
    } as unknown as NodeJS.ProcessEnv,
  });
}

let sandbox: Sandbox;
let base: string;

beforeEach(() => {
  sandbox = makeSandbox();
  git(sandbox, 'init', '-q', '-b', 'main');
  commit(sandbox, 'README.md', 'x');
  base = commit(sandbox, 'src/a.ts', 'a');
});

describe('state', () => {
  it.each([
    ['success', 'success'],
    ['failure', 'failure'],
    ['in_progress', 'pending'],
    ['none', 'none'],
  ] as const)('reports a %s check run as %s', (verdict, expected) => {
    recordCheck(sandbox, base, verdict);
    const result = run(sandbox, ['state', base]);
    expect(result.stderr).toBe('');
    expect(result.stdout.trim()).toBe(expected);
  });

  it('takes the latest check run of GitHub Actions and ignores a check of another app that has the same name', () => {
    writeFileSync(
      path.join(sandbox.ci, `${base}.json`),
      JSON.stringify({
        check_runs: [
          { name: 'verify', status: 'completed', conclusion: 'failure', started_at: '2026-11-11T07:00:00Z', app: { slug: 'github-actions' } },
          { name: 'verify', status: 'completed', conclusion: 'success', started_at: '2026-11-11T08:00:00Z', app: { slug: 'github-actions' } },
          { name: 'verify', status: 'completed', conclusion: 'failure', started_at: '2026-11-11T09:00:00Z', app: { slug: 'another-app' } },
        ],
      })
    );
    expect(run(sandbox, ['state', base]).stdout.trim()).toBe('success');
  });

  it('asks for the check named verify of the commit, newest run per name', () => {
    run(sandbox, ['state', base]);
    expect(readFileSync(path.join(sandbox.ci, 'last-url'), 'utf-8')).toBe(`repos/example/repo/commits/${base}/check-runs?check_name=verify&filter=latest&per_page=100`);
  });

  it('refuses anything but a full commit', () => {
    const result = run(sandbox, ['state', 'main']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("'main' is not a full 40 character commit");
  });
});

describe('wait', () => {
  it('returns at once for a successful check', () => {
    recordCheck(sandbox, base, 'success');
    const result = run(sandbox, ['wait', base]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('succeeded');
  });

  it('fails, without waiting, for a failed check, so nothing is promoted', () => {
    recordCheck(sandbox, base, 'failure');
    const result = run(sandbox, ['wait', base], { GATE_TIMEOUT_SECONDS: '3600' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('did not succeed: nothing is promoted');
  });

  it('keeps asking while the check runs and passes when it succeeds', () => {
    recordCheck(sandbox, base, 'in_progress');
    recordCheck(sandbox, base, 'success', 'then.json');
    const result = run(sandbox, ['wait', base], { GATE_TIMEOUT_SECONDS: '3600' });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('is pending; waiting');
    expect(readFileSync(path.join(sandbox.ci, `${base}.calls`), 'utf-8')).toHaveLength(2);
  });

  it('keeps asking while no check run exists yet, and gives up at the timeout without promoting', () => {
    const result = run(sandbox, ['wait', base], { GATE_TIMEOUT_SECONDS: '0' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('was still none after 0s: run this job again once CI has finished');
  });
});

describe('image-commit', () => {
  it('prints the revision label of the image', () => {
    recordImage(sandbox, WEB, 'main', { 'org.opencontainers.image.revision': base });
    expect(run(sandbox, ['image-commit', WEB, 'main']).stdout.trim()).toBe(base);
  });

  it.each([
    ['has no labels', null],
    ['has labels without a revision', { 'easyconvert.smoke-probe': '/api/health/conversion' }],
  ])('prints nothing for an image that %s', (_name, labels) => {
    recordImage(sandbox, WEB, 'main', labels);
    const result = run(sandbox, ['image-commit', WEB, 'main']);
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('');
  });

  it('refuses a ref that is neither main nor a commit tag', () => {
    expect(run(sandbox, ['image-commit', WEB, 'latest']).status).toBe(1);
  });
});

describe('verified-by', () => {
  // history: base (src), docs, tests, source (src): the middle two build no image, so they share its contents with base
  let docs: string;
  let tests: string;
  let source: string;
  beforeEach(() => {
    docs = commit(sandbox, 'docs/notes.md', 'n');
    tests = commit(sandbox, 'tests/a.test.ts', 't');
    source = commit(sandbox, 'src/a.ts', 'changed');
  });

  it('is the commit itself when its check succeeded', () => {
    recordCheck(sandbox, base, 'success');
    expect(run(sandbox, ['verified-by', base]).stdout.trim()).toBe(base);
  });

  it('accepts a later commit that changed only documentation and tests when the commit itself failed: the fix of a failing test builds no image', () => {
    recordCheck(sandbox, base, 'failure');
    recordCheck(sandbox, tests, 'success');
    const result = run(sandbox, ['verified-by', base]);
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(tests);
  });

  it('does not accept a later commit that changed the image, even when its check succeeded', () => {
    recordCheck(sandbox, base, 'failure');
    recordCheck(sandbox, docs, 'failure');
    recordCheck(sandbox, tests, 'failure');
    recordCheck(sandbox, source, 'success');
    expect(run(sandbox, ['verified-by', base]).status).toBe(1);
  });

  it('does not accept a commit whose check has not finished', () => {
    recordCheck(sandbox, base, 'in_progress');
    expect(run(sandbox, ['verified-by', base]).status).toBe(1);
  });

  it('reads at most GATE_MAX_LOOKUPS check runs', () => {
    // base, tests and docs are read in that order; the commit that changed the image is skipped without a read
    recordCheck(sandbox, docs, 'success');
    expect(run(sandbox, ['verified-by', base], { GATE_MAX_LOOKUPS: '2' }).status).toBe(1);
    expect(run(sandbox, ['verified-by', base], { GATE_MAX_LOOKUPS: '3' }).stdout.trim()).toBe(docs);
  });

  it('names a commit that is not in the clone', () => {
    const result = run(sandbox, ['verified-by', 'e'.repeat(40)]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('is not in this clone');
  });

  /**
   * The files an image is built from are the `paths` of the push trigger of the deploy workflow. The script holds the same list as
   * git pathspecs: a commit that changes one file must share its image contents with the commit before it exactly when GitHub would
   * not build an image for that push.
   */
  describe('against the paths filter of the push trigger', () => {
    const workflow = parse(readFileSync(path.join(ROOT, '.github', 'workflows', 'deploy-oci.yml'), 'utf-8')) as { on: { push: { paths: string[] } } };
    const pattern = (glob: string): RegExp => {
      const source = glob.replace(/\*\*\/|\*\*|\*|\?|[.+^${}()|[\]\\]/g, (token) => {
        if (token === '**/') return '(?:.*/)?';
        if (token === '**') return '.*';
        if (token === '*') return '[^/]*';
        if (token === '?') return '[^/]';
        return `\\${token}`;
      });
      return new RegExp(`^${source}$`);
    };
    const builds = (file: string): boolean =>
      workflow.on.push.paths.reduce((included, glob) => {
        const negated = glob.startsWith('!');
        return pattern(negated ? glob.slice(1) : glob).test(file) ? !negated : included;
      }, false);
    const FILES = [
      'Dockerfile.worker',
      'src/app/page.tsx',
      'scripts/install-ffmpeg.sh',
      'native/qpdf-runner/qpdf-runner.c',
      'docker/imagemagick/policy.xml',
      '.github/workflows/deploy-oci.yml',
      '.dockerignore',
      'deploy/oci/deploy.sh',
      'docker-compose.prod.yml',
      'THIRD_PARTY_NOTICES.md',
      'docs/deploy-oci.md',
      'docs/legal/notice.txt',
      'tests/oci-deploy.test.ts',
      'tests/fixtures/sample.bin',
      'README.md',
      'CHANGELOG.md',
      'native/qpdf-runner/README.md',
      'src/lib/notes.md',
    ];

    it.each(FILES)('treats a change to %s as the push trigger does', (file) => {
      const before = git(sandbox, 'rev-parse', 'HEAD');
      const after = commit(sandbox, file, `changed ${file}`);
      recordCheck(sandbox, before, 'failure');
      recordCheck(sandbox, after, 'success');
      const sharesImage = run(sandbox, ['verified-by', before]).status === 0;
      expect(sharesImage, file).toBe(!builds(file));
    });
  });
});

describe('deploy-commit', () => {
  const REVISION = 'org.opencontainers.image.revision';
  const SHA_REF = (commitId: string): string => `sha-${commitId}`;

  it('takes the commit of the label of main, and the commit whose check vouches for it', () => {
    recordCheck(sandbox, base, 'success');
    recordImage(sandbox, WEB, 'main', { [REVISION]: base });
    recordImage(sandbox, WORKER, 'main', { [REVISION]: base });
    const result = run(sandbox, ['deploy-commit', WEB, WORKER, 'main']);
    expect(result.stderr).toBe('');
    expect(result.stdout).toBe(`commit=${base}\nverified_by=${base}\n`);
  });

  it('refuses main whose images predate the label', () => {
    recordCheck(sandbox, base, 'success');
    recordImage(sandbox, WEB, 'main', null);
    recordImage(sandbox, WORKER, 'main', null);
    const result = run(sandbox, ['deploy-commit', WEB, WORKER, 'main']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('records no commit');
    expect(result.stderr).toContain('deploy it as sha-<commit>');
  });

  it('refuses main when the web and worker images come from different commits, as when the promotion was cut off between the two tags', () => {
    const other = commit(sandbox, 'src/b.ts', 'b');
    recordCheck(sandbox, base, 'success');
    recordCheck(sandbox, other, 'success');
    recordImage(sandbox, WEB, 'main', { [REVISION]: other });
    recordImage(sandbox, WORKER, 'main', { [REVISION]: base });
    const result = run(sandbox, ['deploy-commit', WEB, WORKER, 'main']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`built from ${other} but the worker image main from ${base}`);
  });

  it('deploys a commit tag only when CI succeeded for its commit: a build whose CI failed is refused', () => {
    recordCheck(sandbox, base, 'failure');
    recordImage(sandbox, WEB, SHA_REF(base), { [REVISION]: base });
    recordImage(sandbox, WORKER, SHA_REF(base), { [REVISION]: base });
    const result = run(sandbox, ['deploy-commit', WEB, WORKER, SHA_REF(base)]);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain(`no successful verify check covers the image built from ${base}`);
  });

  it('deploys the commit tag of a failed build once a later commit that changed only tests has a successful check, and ships the files of the image commit', () => {
    recordCheck(sandbox, base, 'failure');
    const fix = commit(sandbox, 'tests/fix.test.ts', 'fix');
    recordCheck(sandbox, fix, 'success');
    recordImage(sandbox, WEB, SHA_REF(base), { [REVISION]: base });
    recordImage(sandbox, WORKER, SHA_REF(base), { [REVISION]: base });
    const result = run(sandbox, ['deploy-commit', WEB, WORKER, SHA_REF(base)]);
    expect(result.stdout).toBe(`commit=${base}\nverified_by=${fix}\n`);
  });

  it('refuses a commit tag whose image records another commit: the tag was moved', () => {
    const other = commit(sandbox, 'src/b.ts', 'b');
    recordCheck(sandbox, base, 'success');
    recordImage(sandbox, WEB, SHA_REF(base), { [REVISION]: other });
    recordImage(sandbox, WORKER, SHA_REF(base), { [REVISION]: base });
    const result = run(sandbox, ['deploy-commit', WEB, WORKER, SHA_REF(base)]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`records the commit ${other}: the tag was moved`);
  });

  it('still deploys a commit tag of an image that predates the label, by the commit its tag names', () => {
    recordCheck(sandbox, base, 'success');
    recordImage(sandbox, WEB, SHA_REF(base), null);
    recordImage(sandbox, WORKER, SHA_REF(base), null);
    expect(run(sandbox, ['deploy-commit', WEB, WORKER, SHA_REF(base)]).stdout).toBe(`commit=${base}\nverified_by=${base}\n`);
  });

  it('refuses a ref that is neither main nor a commit tag', () => {
    expect(run(sandbox, ['deploy-commit', WEB, WORKER, 'latest']).status).toBe(1);
  });
});

describe('is-behind', () => {
  it('is true for an earlier commit of the same history, and false for the same commit, a later one and another history', () => {
    const later = commit(sandbox, 'src/b.ts', 'b');
    expect(run(sandbox, ['is-behind', base, later]).status).toBe(0);
    expect(run(sandbox, ['is-behind', later, base]).status).toBe(1);
    expect(run(sandbox, ['is-behind', base, base]).status).toBe(1);
  });
});
