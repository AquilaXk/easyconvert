import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { skipUnless } from './helpers/strict-skip';

/**
 * The CI workflows are read as YAML; the rules they must follow (one run per pull request, a timeout on every
 * job, no timing suites in the pull request gate, pinned actions, a nightly run that reports its failures) are
 * written out here, not taken from the files under test. The two shell steps that decide what runs (the
 * documentation filter and the `verify` gate) are executed against real git repositories and result sets.
 */

interface Step {
  id?: string;
  name?: string;
  if?: string;
  uses?: string;
  run?: string;
  shell?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
}

interface Job {
  name?: string;
  needs?: string | string[];
  if?: string;
  'timeout-minutes'?: number;
  env?: Record<string, string>;
  permissions?: Record<string, string>;
  strategy?: { matrix?: Record<string, unknown[]> };
  steps: Step[];
}

interface Workflow {
  on: Record<string, unknown>;
  concurrency?: { group?: string; 'cancel-in-progress'?: string | boolean };
  permissions?: Record<string, string>;
  jobs: Record<string, Job>;
}

const ROOT = path.resolve(__dirname, '..');
const WORKFLOWS = path.join(ROOT, '.github', 'workflows');
const SETUP_ACTION = path.join(ROOT, '.github', 'actions', 'ci-setup', 'action.yml');
const read = (file: string): string => readFileSync(file, 'utf-8');
const ciText = read(path.join(WORKFLOWS, 'ci.yml'));
const nightlyText = read(path.join(WORKFLOWS, 'nightly.yml'));
const setupText = read(SETUP_ACTION);
const ci = parse(ciText) as Workflow;
const nightly = parse(nightlyText) as Workflow;
const setup = parse(setupText) as { runs: { steps: Step[] } };

/** The longest a job may be allowed to run: a hung job must not hold a runner for hours. */
const MAX_JOB_TIMEOUT_MINUTES = 60;
const FULL_SHA = /^[0-9a-f]{40}$/;
const SHA_PINNED_COMMENT = /^uses:\s*\S+@[0-9a-f]{40}\s+#\s*v\d+(\.\d+)*\s*$/;

function stepsOf(workflow: Workflow): Array<{ job: string; step: Step }> {
  return Object.entries(workflow.jobs).flatMap(([job, definition]) => definition.steps.map((step) => ({ job, step })));
}

function stepRun(workflow: Workflow, job: string, id: string): string {
  const step = workflow.jobs[job].steps.find((candidate) => candidate.id === id || candidate.name === id);
  if (!step?.run) throw new Error(`no run step ${id} in ${job}`);
  return step.run;
}

describe('concurrency and triggers of ci.yml', () => {
  it('keys the group on the pull request number and cancels only pull request runs', () => {
    expect(ci.concurrency?.group).toBe('${{ github.workflow }}-${{ github.event.pull_request.number || github.ref }}');
    expect(ci.concurrency?.['cancel-in-progress']).toBe("${{ github.event_name == 'pull_request' }}");
  });

  it('runs on pushes to main only, so a pull request commit is not built twice', () => {
    expect(ci.on.push).toEqual({ branches: ['main'] });
    expect(ci.on.pull_request).toEqual({ branches: ['main'] });
  });

  it('reads the repository and nothing else', () => {
    expect(ci.permissions).toEqual({ contents: 'read' });
  });
});

describe.each([
  ['ci.yml', ci],
  ['nightly.yml', nightly],
])('jobs of %s', (_name, workflow) => {
  it('has a timeout-minutes on every job', () => {
    for (const [name, job] of Object.entries(workflow.jobs)) {
      const minutes = job['timeout-minutes'];
      expect(typeof minutes, `${name} needs timeout-minutes`).toBe('number');
      expect(minutes, name).toBeGreaterThan(0);
      expect(minutes, name).toBeLessThanOrEqual(MAX_JOB_TIMEOUT_MINUTES);
    }
  });
});

describe('the pull request workflow', () => {
  it('does not run the timing suites', () => {
    for (const { job, step } of stepsOf(ci)) {
      expect(step.run ?? '', `${job}: ${step.name}`).not.toMatch(/\.perf\.test|perf suites|--no-file-parallelism/i);
      expect(step.name ?? '', job).not.toMatch(/performance/i);
    }
  });

  it('runs the conformance gate in parts and the other suites in duration-balanced shards', () => {
    expect(ci.jobs.tests.strategy?.matrix?.shard).toEqual([1, 2, 3, 4, 5, 6]);
    expect(ci.jobs.conformance.strategy?.matrix?.part).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const run = stepRun(ci, 'tests', 'Run unit and integration tests');
    expect(run).toContain('scripts/ci-test-shards.mjs');
    expect(run).not.toContain('--shard');
  });

  it('does not install the test tools for the static gates', () => {
    const uses = ci.jobs.checks.steps.map((step) => step.uses ?? '');
    expect(uses).not.toContain('./.github/actions/ci-setup');
    expect(ci.jobs.checks.steps.map((step) => step.run)).toEqual(
      expect.arrayContaining(['npm run guard:anti-cheat', 'npm run lint', 'npm run build'])
    );
  });

  it('gives the heavy jobs a dependency on the change filter and gates them on its verdict', () => {
    for (const name of ['checks', 'tests', 'conformance', 'integration']) {
      expect(ci.jobs[name].needs, name).toBe('changes');
      expect(ci.jobs[name].if, name).toBe("needs.changes.outputs.code == 'true'");
    }
  });

  it('makes verify wait for every other job', () => {
    const others = Object.keys(ci.jobs).filter((name) => name !== 'verify');
    expect([...(ci.jobs.verify.needs as string[])].sort()).toEqual([...others].sort());
    expect(ci.jobs.verify.if).toBe('always()');
  });
});

describe('the nightly workflow', () => {
  it('is scheduled once a day at an off-peak minute, and can be started by hand', () => {
    const schedule = nightly.on.schedule as Array<{ cron: string }>;
    expect(schedule).toHaveLength(1);
    const [minute, hour, dayOfMonth, month, dayOfWeek] = schedule[0].cron.split(' ');
    expect(Number(minute)).toBeGreaterThan(0);
    expect(Number(minute)).not.toBe(30);
    expect(Number(hour)).toBeGreaterThanOrEqual(0);
    expect([dayOfMonth, month, dayOfWeek]).toEqual(['*', '*', '*']);
    expect('workflow_dispatch' in nightly.on).toBe(true);
  });

  it('runs the timing suites one file at a time in strict oracle mode', () => {
    const step = nightly.jobs.perf.steps.find((candidate) => candidate.name === 'Run performance suites');
    expect(step?.run).toBe('npx --no-install vitest run --no-file-parallelism .perf.test.ts');
    expect(step?.env?.ORACLE_STRICT_MODE).toBe('1');
  });

  it('runs the benchmark and the licence gate only when their scripts exist, and says so when they do not', () => {
    const guarded = (script: string, skipped: string): string =>
      `if node -e "process.exit(require('./package.json').scripts?.['${script}'] ? 0 : 1)"; then\n  npm run ${script}\nelse\n  echo "skipped: ${skipped}"\nfi\n`;
    const bench = nightly.jobs.bench.steps.find((step) => step.name === 'Run the quality benchmark');
    expect(bench?.run).toBe(guarded('bench:quality', 'package.json has no bench:quality script'));
    const licences = nightly.jobs.licenses.steps.find((step) => step.name === 'Check dependency licences');
    expect(licences?.run).toBe(guarded('licenses:check', 'package.json has no licenses:check script yet'));
  });

  it('opens or updates one nightly-regression issue when a job fails, with the permissions to do it', () => {
    const report = nightly.jobs.report;
    expect([...(report.needs as string[])].sort()).toEqual(['bench', 'licenses', 'perf']);
    expect(report.if).toBe("always() && contains(needs.*.result, 'failure')");
    expect(report.permissions).toEqual({ actions: 'read', contents: 'read', issues: 'write' });
    const script = String(report.steps[0].with?.script);
    expect(script).toContain("const label = 'nightly-regression'");
    expect(script).toContain('github.rest.issues.create(');
    expect(script).toContain('github.rest.issues.createComment(');
    expect(script).toContain('actions/runs/${context.runId}');
    expect(script).toContain('job.html_url');
  });

  it('never queues two nightly runs on top of each other', () => {
    expect(nightly.concurrency).toEqual({ group: 'nightly', 'cancel-in-progress': false });
  });
});

describe('third-party actions', () => {
  const all = [
    ...stepsOf(ci).map(({ job, step }) => ({ where: `ci.yml ${job}`, uses: step.uses })),
    ...stepsOf(nightly).map(({ job, step }) => ({ where: `nightly.yml ${job}`, uses: step.uses })),
    ...setup.runs.steps.map((step) => ({ where: 'ci-setup', uses: step.uses })),
  ].filter((entry): entry is { where: string; uses: string } => typeof entry.uses === 'string' && !entry.uses.startsWith('./'));

  it('are used somewhere', () => {
    expect(all.length).toBeGreaterThan(10);
  });

  it.each(all.map((entry) => [entry.where, entry.uses] as const))('%s pins %s by a full commit SHA', (_where, uses) => {
    const [, ref] = uses.split('@');
    expect(ref, uses).toMatch(FULL_SHA);
  });

  it('carry the version they pin in a comment', () => {
    for (const text of [ciText, nightlyText, setupText]) {
      const pinned = text.split('\n').map((line) => line.trim().replace(/^- /, '')).filter((line) => line.startsWith('uses:') && !line.startsWith('uses: ./'));
      expect(pinned.length).toBeGreaterThan(0);
      for (const line of pinned) expect(line).toMatch(SHA_PINNED_COMMENT);
    }
  });
});

describe('the tool setup', () => {
  it('caches the package files and the veraPDF install, keyed on what they were built from', () => {
    const caches = setup.runs.steps.filter((step) => step.uses?.startsWith('actions/cache@'));
    const keys = caches.map((step) => String(step.with?.key));
    expect(keys.some((key) => key.includes('apt-debs') && key.includes('steps.image.outputs.version') && key.includes('apt-packages.txt'))).toBe(true);
    expect(keys.some((key) => key.includes('verapdf') && key.includes('scripts/install-verapdf.sh'))).toBe(true);
  });

  it('keeps the unprivileged user namespace step first', () => {
    const commands = (setup.runs.steps[0].run ?? '')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '' && !line.startsWith('#'));
    expect(commands).toEqual([
      'if [ -e /proc/sys/kernel/apparmor_restrict_unprivileged_userns ]; then',
      'sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0',
      'fi',
      'unshare -r -n -p --fork true',
    ]);
  });
});

describe('the documentation filter of ci.yml', () => {
  const git = spawnSync('git', ['--version'], { encoding: 'utf-8' });
  const bash = spawnSync('bash', ['--version'], { encoding: 'utf-8' });
  const available = git.status === 0 && bash.status === 0;
  const script = stepRun(ci, 'changes', 'filter');
  const filterEnv = ci.jobs.changes.env ?? {};
  const temps: string[] = [];

  afterAll(() => {
    for (const dir of temps) rmSync(dir, { recursive: true, force: true });
  });

  function run(command: string, args: string[], cwd: string, env: Record<string, string> = {}): string {
    const result = spawnSync(command, args, { cwd, encoding: 'utf-8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', ...env } });
    if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed: ${result.stderr}`);
    return result.stdout.trim();
  }

  /** A pull request that adds `files` to a base commit; returns what the filter step wrote to GITHUB_OUTPUT. */
  function verdict(files: string[], event = 'pull_request'): string {
    const base = mkdtempSync(path.join(tmpdir(), 'ci-filter-origin-'));
    const checkout = mkdtempSync(path.join(tmpdir(), 'ci-filter-checkout-'));
    temps.push(base, checkout);
    const identity = ['-c', 'user.name=ci', '-c', 'user.email=ci@example.invalid'];
    run('git', ['init', '-q', '-b', 'main'], base);
    run('git', ['config', 'uploadpack.allowAnySHA1InWant', 'true'], base);
    writeFileSync(path.join(base, 'README.md'), 'base\n');
    run('git', ['add', '.'], base);
    run('git', [...identity, 'commit', '-q', '-m', 'base'], base);
    const baseSha = run('git', ['rev-parse', 'HEAD'], base);
    run('git', ['clone', '-q', base, checkout], base);
    for (const file of files) {
      mkdirSync(path.dirname(path.join(checkout, file)), { recursive: true });
      writeFileSync(path.join(checkout, file), `${file}\n`);
    }
    if (files.length > 0) {
      run('git', ['add', '.'], checkout);
      run('git', [...identity, 'commit', '-q', '-m', 'change'], checkout);
    }
    const output = path.join(checkout, 'github-output.txt');
    writeFileSync(output, '');
    run('bash', ['-c', script], checkout, { ...filterEnv, EVENT_NAME: event, PR_BASE_SHA: baseSha, GITHUB_OUTPUT: output });
    return readFileSync(output, 'utf-8').trim();
  }

  it.skipIf(skipUnless('git and bash', available))('skips the heavy jobs for documentation-only changes', () => {
    expect(verdict(['docs/guide.md'])).toBe('code=false');
    expect(verdict(['README.md', 'docs/deep/page.md', 'CHANGELOG.md'])).toBe('code=false');
    expect(verdict(['docs/diagram.png'])).toBe('code=false');
  });

  it.skipIf(skipUnless('git and bash', available))('runs them as soon as one changed file is not documentation', () => {
    expect(verdict(['docs/guide.md', 'src/lib/registry.ts'])).toBe('code=true');
    expect(verdict(['package.json'])).toBe('code=true');
    expect(verdict(['.github/workflows/ci.yml'])).toBe('code=true');
  });

  it.skipIf(skipUnless('git and bash', available))('treats Markdown that tests, scripts and the benchmark read as code', () => {
    for (const file of ['tests/fixtures/sample.md', 'src/lib/templates/mail.md', 'bench/corpus/PROVENANCE.md', 'scripts/notes.md']) {
      expect(verdict([file]), file).toBe('code=true');
    }
  });

  it.skipIf(skipUnless('git and bash', available))('fails open: an empty diff and any event but a pull request run everything', () => {
    expect(verdict([])).toBe('code=true');
    expect(verdict(['docs/guide.md'], 'push')).toBe('code=true');
  });
});

describe('the verify gate of ci.yml', () => {
  const bash = spawnSync('bash', ['--version'], { encoding: 'utf-8' });
  const script = stepRun(ci, 'verify', 'Require every job to pass, or to be skipped for a documentation-only change');

  function gate(code: string, results: Partial<Record<'changes' | 'checks' | 'tests' | 'conformance' | 'integration' | 'container', string>>): number {
    const all = { changes: 'success', checks: 'success', tests: 'success', conformance: 'success', integration: 'success', container: 'success', ...results };
    const result = spawnSync('bash', ['-c', script], {
      encoding: 'utf-8',
      env: {
        ...process.env,
        CODE_CHANGED: code,
        CHANGES_RESULT: all.changes,
        CHECKS_RESULT: all.checks,
        TESTS_RESULT: all.tests,
        CONFORMANCE_RESULT: all.conformance,
        INTEGRATION_RESULT: all.integration,
        CONTAINER_RESULT: all.container,
      },
    });
    return result.status ?? -1;
  }

  const skippedHeavy = { checks: 'skipped', tests: 'skipped', conformance: 'skipped', integration: 'skipped' };

  it.skipIf(skipUnless('bash', bash.status === 0))('passes when every job succeeded', () => {
    expect(gate('true', {})).toBe(0);
  });

  it.skipIf(skipUnless('bash', bash.status === 0))('passes a documentation-only change whose heavy jobs were skipped', () => {
    expect(gate('false', skippedHeavy)).toBe(0);
  });

  it.skipIf(skipUnless('bash', bash.status === 0))('fails when a heavy job was skipped although code changed', () => {
    expect(gate('true', { tests: 'skipped' })).toBe(1);
    expect(gate('true', skippedHeavy)).toBe(1);
  });

  it.skipIf(skipUnless('bash', bash.status === 0))('fails when a heavy job ran after a documentation-only verdict', () => {
    expect(gate('false', { ...skippedHeavy, conformance: 'success' })).toBe(1);
  });

  it.skipIf(skipUnless('bash', bash.status === 0))('fails on any failed or cancelled job', () => {
    for (const result of ['failure', 'cancelled']) {
      for (const job of ['checks', 'tests', 'conformance', 'integration', 'container', 'changes'] as const) {
        expect(gate('true', { [job]: result }), `${job} ${result}`).toBe(1);
      }
    }
    expect(gate('false', { ...skippedHeavy, container: 'failure' })).toBe(1);
  });

  it.skipIf(skipUnless('bash', bash.status === 0))('fails when the change filter did not produce a verdict', () => {
    expect(gate('', {})).toBe(1);
    expect(gate('false', { ...skippedHeavy, changes: 'failure' })).toBe(1);
  });
});
