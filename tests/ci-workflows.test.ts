import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { listShardedTests } from '../scripts/ci-test-shards.mjs';
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
  'runs-on'?: unknown;
  uses?: string;
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
const regressionText = read(path.join(WORKFLOWS, 'regression-corpus.yml'));
const reportText = read(path.join(WORKFLOWS, 'report-failure.yml'));
const setupText = read(SETUP_ACTION);
const ci = parse(ciText) as Workflow;
const nightly = parse(nightlyText) as Workflow;
const regression = parse(regressionText) as Workflow;
const reportFailure = parse(reportText) as Workflow & { jobs: Record<string, Job> };
const setup = parse(setupText) as { inputs?: Record<string, { default?: string; required?: boolean }>; runs: { steps: Step[] } };

/** The longest a job may be allowed to run: a hung job must not hold a runner for hours. */
const MAX_JOB_TIMEOUT_MINUTES = 60;
const FULL_SHA = /^[0-9a-f]{40}$/;
const SHA_PINNED_COMMENT = /^uses:\s*\S+@[0-9a-f]{40}\s+#\s*v\d+(\.\d+)*\s*$/;

function stepsOf(workflow: Workflow): Array<{ job: string; step: Step }> {
  return Object.entries(workflow.jobs).flatMap(([job, definition]) => (definition.steps ?? []).map((step) => ({ job, step })));
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
    // Labels decide two verdicts (the automerge label starts speed parity, the security label excuses parity), so a
    // label change needs a fresh run; no other event type is added.
    expect(ci.on.pull_request).toEqual({ branches: ['main'], types: ['opened', 'synchronize', 'reopened', 'labeled', 'unlabeled'] });
  });

  it('reads the repository and nothing else', () => {
    expect(ci.permissions).toEqual({ contents: 'read' });
  });
});

describe.each([
  ['ci.yml', ci],
  ['nightly.yml', nightly],
  ['regression-corpus.yml', regression],
  ['report-failure.yml', reportFailure],
])('jobs of %s', (_name, workflow) => {
  it('has a timeout-minutes on every job that runs steps (a job that calls a workflow gets its limit from the called one)', () => {
    for (const [name, job] of Object.entries(workflow.jobs)) {
      if (job.uses !== undefined) continue;
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

  it('runs the Parquet writer conformance in strict mode on a Node.js with zstd in node:zlib (22.15 or newer), and in no shard', () => {
    const file = 'tests/parquet-writer-conformance.test.ts';
    expect(listShardedTests(), 'the strict-mode run is the only run of the ZSTD rows').not.toContain(file);
    const steps = ci.jobs.integration.steps;
    const at = steps.findIndex((step) => (step.run ?? '').includes(file));
    expect(at, 'a step of the integration job runs the file').toBeGreaterThan(-1);
    expect(steps[at].env?.ORACLE_STRICT_MODE).toBe('1');
    const nodeSteps = steps.slice(0, at).filter((step) => String(step.uses ?? '').startsWith('actions/setup-node@'));
    expect(nodeSteps, 'one Node.js setup serves every step of the job, the worker runtime').toHaveLength(1);
    expect(Number(nodeSteps[0]?.with?.['node-version']), 'the Node.js setup before the step').toBeGreaterThanOrEqual(22);
  });

  it('does not install the test tools for the static gates', () => {
    const uses = ci.jobs.checks.steps.map((step) => step.uses ?? '');
    expect(uses).not.toContain('./.github/actions/ci-setup');
    expect(ci.jobs.checks.steps.map((step) => step.run)).toEqual(
      expect.arrayContaining(['npm run guard:anti-cheat', 'npm run guard:code-smells', 'npm run lint', 'npm run build'])
    );
  });

  it('gives the heavy jobs a dependency on the change filter and gates them on its verdict', () => {
    for (const name of ['checks', 'integration']) expect(ci.jobs[name].needs, name).toBe('changes');
    // The suites that convert pictures also wait for the libvips build of the worker image.
    for (const name of ['tests', 'conformance']) expect(ci.jobs[name].needs, name).toEqual(['changes', 'sharp-libvips']);
    for (const name of ['checks', 'tests', 'conformance', 'integration']) {
      expect(ci.jobs[name].if, name).toBe("needs.changes.outputs.code == 'true'");
    }
  });

  it('makes verify wait for every other job', () => {
    const others = Object.keys(ci.jobs).filter((name) => name !== 'verify');
    expect([...(ci.jobs.verify.needs as string[])].sort()).toEqual([...others].sort());
    expect(ci.jobs.verify.if).toBe('always()');
  });

  it('fetches the real-world test files, cached by manifest digest, before any step that runs vitest', () => {
    const prefetch = 'npm run prefetch:test-samples';
    const runsVitest = (step: Step): boolean => (step.run ?? '').includes('vitest run');
    // A job that calls a workflow has no steps of its own.
    const jobsRunningVitest = Object.entries(ci.jobs).filter(([, job]) => (job.steps ?? []).some(runsVitest));
    expect(jobsRunningVitest.map(([name]) => name).sort()).toEqual(['conformance', 'integration', 'tests']);
    for (const [name, job] of jobsRunningVitest) {
      const prefetchAt = job.steps.findIndex((step) => step.run === prefetch);
      expect(prefetchAt, `${name} prefetches`).toBeGreaterThan(-1);
      expect(prefetchAt, `${name} prefetches before vitest`).toBeLessThan(job.steps.findIndex(runsVitest));
      expect(job.steps[prefetchAt].env?.ORACLE_STRICT_MODE, `${name} prefetch is strict`).toBe('1');
      const cache = job.steps.slice(0, prefetchAt).find((step) => String(step.uses).startsWith('actions/cache@'));
      expect(cache?.with?.path, `${name} cache path`).toBe('~/.cache/easyconvert-realworld');
      expect(cache?.with?.key, `${name} cache key`).toBe("test-samples-${{ hashFiles('bench/realworld/manifest.json') }}");
    }
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

  it('fetches the real-world test files, cached by manifest digest, before the timing suites read them', () => {
    const steps = nightly.jobs.perf.steps;
    const vitestAt = steps.findIndex((step) => (step.run ?? '').includes('vitest run'));
    const prefetchAt = steps.findIndex((step) => step.run === 'npm run prefetch:test-samples');
    expect(prefetchAt, 'perf prefetches').toBeGreaterThan(-1);
    expect(prefetchAt, 'perf prefetches before vitest').toBeLessThan(vitestAt);
    expect(steps[prefetchAt].env?.ORACLE_STRICT_MODE, 'perf prefetch is strict').toBe('1');
    const cache = steps.slice(0, prefetchAt).find((step) => String(step.uses).startsWith('actions/cache@'));
    expect(cache?.with?.path).toBe('~/.cache/easyconvert-realworld');
    expect(cache?.with?.key).toBe("test-samples-${{ hashFiles('bench/realworld/manifest.json') }}");
  });

  it('opens or updates one nightly-regression issue when a job fails, through the workflow it shares with the regression corpus run', () => {
    const report = nightly.jobs.report;
    expect([...(report.needs as string[])].sort()).toEqual(['bench', 'bench-parity-quality', 'bench-parity-speed', 'licenses', 'perf', 'realworld', 'realworld-gate', 'sharp-libvips']);
    expect(report.if).toBe("always() && contains(needs.*.result, 'failure')");
    expect(report.permissions).toEqual({ actions: 'read', contents: 'read', issues: 'write' });
    expect(report.uses).toBe('./.github/workflows/report-failure.yml');
    expect(report.steps).toBeUndefined();
  });

  it('keeps the issue reporting in one reusable workflow with the permissions to do it', () => {
    expect(reportFailure.on).toEqual({ workflow_call: null });
    const report = reportFailure.jobs.report;
    expect(report.permissions).toEqual({ actions: 'read', contents: 'read', issues: 'write' });
    expect(report['timeout-minutes']).toBe(10);
    const script = String(report.steps[0].with?.script);
    expect(script).toContain("const label = 'nightly-regression'");
    expect(script).toContain("const title = 'Nightly regression'");
    expect(script).toContain('github.rest.issues.create(');
    expect(script).toContain('github.rest.issues.createComment(');
    expect(script).toContain('actions/runs/${context.runId}');
    expect(script).toContain('job.html_url');
    expect(Object.keys(reportFailure.jobs)).toEqual(['report']);
  });

  it('runs the real-world corpus in ten cached shards and gates on their merged report', () => {
    const run = nightly.jobs.realworld;
    expect(run.strategy?.matrix?.shard).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const steps = run.steps.map((step) => step.run ?? step.uses ?? '');
    expect(steps).toContain('npm run bench:realworld -- run --shard ${{ matrix.shard }}/10 --out realworld-shard-${{ matrix.shard }}.json');
    const cache = run.steps.find((step) => String(step.uses).startsWith('actions/cache@'));
    expect(cache?.with?.key).toBe("realworld-${{ matrix.shard }}-${{ hashFiles('bench/realworld/manifest.json') }}");
    const gate = nightly.jobs['realworld-gate'];
    expect(gate.needs).toEqual(['realworld']);
    expect(gate.if).toBe('always()');
    expect(gate.steps.map((step) => step.run ?? '')).toContain('npm run bench:realworld -- merge --out realworld-results realworld-shards/*.json');
  });

  it('never queues two nightly runs on top of each other', () => {
    expect(nightly.concurrency).toEqual({ group: 'nightly', 'cancel-in-progress': false });
  });
});

describe('third-party actions', () => {
  const all = [
    ...stepsOf(ci).map(({ job, step }) => ({ where: `ci.yml ${job}`, uses: step.uses })),
    ...stepsOf(nightly).map(({ job, step }) => ({ where: `nightly.yml ${job}`, uses: step.uses })),
    ...stepsOf(regression).map(({ job, step }) => ({ where: `regression-corpus.yml ${job}`, uses: step.uses })),
    ...stepsOf(reportFailure).map(({ job, step }) => ({ where: `report-failure.yml ${job}`, uses: step.uses })),
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
    for (const text of [ciText, nightlyText, regressionText, reportText, setupText]) {
      const pinned = text.split('\n').map((line) => line.trim().replace(/^- /, '')).filter((line) => line.startsWith('uses:') && !line.startsWith('uses: ./'));
      expect(pinned.length).toBeGreaterThan(0);
      for (const line of pinned) expect(line).toMatch(SHA_PINNED_COMMENT);
    }
  });
});

describe('the runner image of every workflow job', () => {
  const RUNNER_IMAGE = 'ubuntu-24.04';
  const jobs = readdirSync(WORKFLOWS)
    .filter((file) => /\.ya?ml$/.test(file))
    .sort()
    .flatMap((file) => {
      const workflow = parse(read(path.join(WORKFLOWS, file))) as Workflow;
      return Object.entries(workflow.jobs).map(([id, job]) => ({ where: `${file} ${id}`, job }));
    });

  it('reads every job of every workflow file: 28 on a runner and 4 that call a reusable workflow', () => {
    expect(jobs).toHaveLength(32);
    expect(jobs.filter(({ job }) => job['runs-on'] !== undefined)).toHaveLength(28);
    expect(jobs.filter(({ job }) => job.uses !== undefined)).toHaveLength(4);
  });

  it('gives every job exactly one of a runner and a reusable workflow to call', () => {
    const neither = jobs
      .filter(({ job }) => (job['runs-on'] !== undefined) === (job.uses !== undefined))
      .map(({ where, job }) => `${where}: runs-on ${JSON.stringify(job['runs-on'])}, uses ${JSON.stringify(job.uses)}`);
    expect(neither).toEqual([]);
  });

  it('keeps every reusable workflow a job calls inside this repository', () => {
    const outside = jobs
      .filter(({ job }) => job.uses !== undefined)
      .filter(({ job }) => !String(job.uses).startsWith('./.github/workflows/'))
      .map(({ where, job }) => `${where}: ${job.uses}`);
    expect(outside).toEqual([]);
  });

  it(`runs every job that names a runner on ${RUNNER_IMAGE}, so that no gate moves with the hosted latest image`, () => {
    const onOtherImage = jobs
      .filter(({ job }) => job['runs-on'] !== undefined)
      .filter(({ job }) => job['runs-on'] !== RUNNER_IMAGE)
      .map(({ where, job }) => `${where}: ${JSON.stringify(job['runs-on'])}`);
    expect(onOtherImage).toEqual([]);
  });
});

describe('the tool setup', () => {
  it('caches the package files and the veraPDF install, keyed on what they were built from', () => {
    const caches = setup.runs.steps.filter((step) => step.uses?.startsWith('actions/cache@'));
    const keys = caches.map((step) => String(step.with?.key));
    expect(keys.some((key) => key.includes('apt-debs') && key.includes('steps.image.outputs.version') && key.includes('apt-packages.txt'))).toBe(true);
    expect(keys.some((key) => key.includes('verapdf') && key.includes('scripts/install-verapdf.sh'))).toBe(true);
  });

  it('caches the Python wheels by image version and pin file, and installs from them without the network', () => {
    const cache = setup.runs.steps.find((step) => step.name === 'Restore the cached Python wheels');
    expect(cache?.uses?.startsWith('actions/cache@')).toBe(true);
    expect(cache?.with?.path).toBe('${{ runner.temp }}/pip-wheels');
    expect(cache?.with?.key).toBe(
      "pip-wheels-${{ runner.os }}-${{ runner.arch }}-${{ steps.image.outputs.version }}-${{ hashFiles('.github/actions/ci-setup/pip-packages.txt') }}",
    );
    const install = setup.runs.steps.find((step) => step.name === 'Install the tools and start the S3 test server');
    expect(install?.env?.PIP_WHEELS).toBe('${{ runner.temp }}/pip-wheels');
    const script = read(path.join(ROOT, '.github', 'actions', 'ci-setup', 'install-tools.sh'));
    const task = script.slice(script.indexOf('task_pip() {'), script.indexOf('task_apt() {'));
    expect(task).toContain('python3 -m pip download --only-binary=:all: --dest "$pip_wheels" "${pins[@]}"');
    expect(task).toContain('sudo python3 -m pip install --no-index --find-links "$pip_wheels" --break-system-packages --ignore-installed "${pins[@]}"');
    expect(task, 'the download runs as the runner user, so the cache can save the directory').not.toMatch(/sudo python3 -m pip download/);
    expect(task, 'no install path reaches the network').not.toContain('--no-cache-dir');
    expect(task.match(/pip install/g)).toHaveLength(1);
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

describe('the S3 test server', () => {
  const SETUP_USE = './.github/actions/ci-setup';
  const S3_VARIABLES = ['STORAGE_TEST_S3_ENDPOINT', 'STORAGE_TEST_S3_ACCESS_KEY_ID', 'STORAGE_TEST_S3_SECRET_ACCESS_KEY', 'STORAGE_TEST_S3_BUCKET'];
  const PIN_FILE = '.github/actions/ci-setup/s3-test-server-image.txt';
  const IMAGE_PIN = /^[a-z0-9./_-]+:[A-Za-z0-9._-]+@sha256:[0-9a-f]{64}$/;

  /** Jobs whose ci-setup step turns the server on, per workflow. */
  function jobsWithServer(workflow: Workflow): string[] {
    return Object.entries(workflow.jobs)
      .filter(([, job]) => (job.steps ?? []).some((step) => step.uses === SETUP_USE && step.with?.['s3-test-server'] === 'true'))
      .map(([name]) => name);
  }

  const setupStep = (name: string): Step => {
    const found = setup.runs.steps.find((step) => step.name === name);
    if (!found) throw new Error(`no step ${name} in the setup action`);
    return found;
  };

  it('is off unless a job asks for it, and the switch takes only the strings true and false', () => {
    expect(setup.inputs?.['s3-test-server']?.default).toBe('false');
    expect(setup.inputs?.['s3-test-server']?.required).toBe(false);
    const install = setupStep('Install the tools and start the S3 test server');
    expect(install.env?.S3_TEST_SERVER).toBe('${{ inputs.s3-test-server }}');
    expect(install.env?.S3_IMAGE_CACHE_DIR).toBe('${{ runner.temp }}/s3-test-server-image');
  });

  it('is started by the integration job of the pull request workflow and by no other job', () => {
    expect(jobsWithServer(ci)).toEqual(['integration']);
    expect(jobsWithServer(nightly)).toEqual([]);
  });

  it('gives a job the server settings exactly when it starts the server', () => {
    for (const [file, workflow] of [['ci.yml', ci], ['nightly.yml', nightly]] as const) {
      const starting = jobsWithServer(workflow);
      for (const [name, job] of Object.entries(workflow.jobs)) {
        const declared = S3_VARIABLES.filter((variable) => job.env?.[variable] !== undefined);
        expect(declared, `${file} ${name}`).toEqual(starting.includes(name) ? S3_VARIABLES : []);
      }
    }
  });

  it('runs every test file that reads the server in a job that starts it, in strict mode, and in no shard', () => {
    const readers = readdirSync(path.join(ROOT, 'tests'))
      .filter((file) => file.endsWith('.test.ts'))
      .filter((file) => /^\} from '\.\/helpers\/s3-test-server';$|^import .* from '\.\/helpers\/s3-test-server';$/m.test(read(path.join(ROOT, 'tests', file))))
      .map((file) => `tests/${file}`)
      .sort();
    expect(readers.length).toBeGreaterThan(0);
    const sharded = new Set(listShardedTests());
    for (const file of readers) expect(sharded.has(file), `${file} must not be in a shard`).toBe(false);
    const [jobName] = jobsWithServer(ci);
    const steps = ci.jobs[jobName].steps.filter((step) => readers.every((file) => (step.run ?? '').includes(file)));
    expect(steps, 'one step of the integration job runs all of them').toHaveLength(1);
    expect(steps[0].env?.ORACLE_STRICT_MODE).toBe('1');
    expect(steps[0].run).toMatch(/^npx --no-install vitest run /);
  });

  it('caches the image keyed on the pinned digest, only for the jobs that start the server', () => {
    const cache = setupStep('Restore the cached S3 test server image');
    expect(cache.if).toBe("inputs.s3-test-server == 'true'");
    expect(String(cache.uses)).toMatch(/^actions\/cache@[0-9a-f]{40}$/);
    expect(cache.with?.path).toBe('${{ runner.temp }}/s3-test-server-image');
    expect(cache.with?.key).toBe(`s3-test-server-image-\${{ runner.os }}-\${{ runner.arch }}-\${{ hashFiles('${PIN_FILE}') }}`);
    const pin = read(path.join(ROOT, PIN_FILE)).trim();
    expect(pin).toMatch(IMAGE_PIN);
    expect(read(path.join(ROOT, PIN_FILE))).toBe(`${pin}\n`);
  });

  it('keeps the pin in one place, not in the action or the script', () => {
    const pin = read(path.join(ROOT, PIN_FILE)).trim();
    const [repository] = pin.split(':');
    expect(setupText).not.toContain(repository);
    expect(read(path.join(ROOT, '.github', 'actions', 'ci-setup', 'install-tools.sh'))).not.toContain(repository);
  });

  it('restores the image cache before the tools are installed', () => {
    const names = setup.runs.steps.map((step) => step.name);
    expect(names.indexOf('Restore the cached S3 test server image')).toBeGreaterThan(-1);
    expect(names.indexOf('Restore the cached S3 test server image')).toBeLessThan(names.indexOf('Install the tools and start the S3 test server'));
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

  it.skipIf(skipUnless('git and bash', available))('treats generated documents that drift tests check as code', () => {
    for (const file of ['THIRD_PARTY_NOTICES.md', 'docs/configuration.md', 'docs/configuration.example.env', 'docs/licensing.md']) {
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

  type JobName = 'changes' | 'sharp-libvips' | 'checks' | 'tests' | 'conformance' | 'integration' | 'container';
  /** A pull request that changes no conversion family: the parity jobs are skipped (quality) or say there is nothing to measure (speed). */
  const NO_BENCH = { EVENT_NAME: 'pull_request', BENCH_CHANGED: 'false', HAS_AUTOMERGE_LABEL: 'false', PARITY_QUALITY_RESULT: 'skipped', PARITY_SPEED_RESULT: 'success' };

  function gate(code: string, results: Partial<Record<JobName, string>>, parity: Record<string, string> = NO_BENCH): number {
    const all = { changes: 'success', 'sharp-libvips': 'success', checks: 'success', tests: 'success', conformance: 'success', integration: 'success', container: 'success', ...results };
    const result = spawnSync('bash', ['-c', script], {
      encoding: 'utf-8',
      env: {
        ...process.env,
        ...parity,
        CODE_CHANGED: code,
        CHANGES_RESULT: all.changes,
        SHARP_LIBVIPS_RESULT: all['sharp-libvips'],
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
      for (const job of ['checks', 'tests', 'conformance', 'integration', 'container', 'changes', 'sharp-libvips'] as const) {
        expect(gate('true', { [job]: result }), `${job} ${result}`).toBe(1);
      }
    }
    expect(gate('false', { ...skippedHeavy, container: 'failure' })).toBe(1);
    expect(gate('false', { ...skippedHeavy, 'sharp-libvips': 'failure' })).toBe(1);
  });

  it.skipIf(skipUnless('bash', bash.status === 0))('fails when the change filter did not produce a verdict', () => {
    expect(gate('', {})).toBe(1);
    expect(gate('false', { ...skippedHeavy, changes: 'failure' })).toBe(1);
  });
});

describe('the automerge workflow', () => {
  const automerge = parse(read(path.join(WORKFLOWS, 'automerge.yml'))) as Workflow;
  const step = automerge.jobs.enable.steps.find((s) => s.name === 'Enable squash auto-merge');

  it('passes the title and body through the environment, not into the script', () => {
    expect(step?.env?.PR_TITLE).toBe('${{ github.event.pull_request.title }}');
    expect(step?.env?.PR_BODY).toBe('${{ github.event.pull_request.body }}');
    expect(step?.run ?? '').not.toContain('github.event.pull_request');
  });

  it.skipIf(skipUnless('bash', spawnSync('bash', ['--version']).status === 0))(
    'squashes with the PR title and a body without tool attribution lines',
    () => {
      const dir = mkdtempSync(path.join(tmpdir(), 'automerge-'));
      const bin = path.join(dir, 'bin');
      mkdirSync(bin);
      // A stand-in gh records its arguments and the body file it was given.
      writeFileSync(path.join(bin, 'gh'), '#!/bin/sh\nprintf "%s\\n" "$@" > "$RUNNER_TEMP/args"\nwhile [ $# -gt 0 ]; do [ "$1" = "--body-file" ] && cp "$2" "$RUNNER_TEMP/body"; shift; done\n', { mode: 0o755 });
      const body = [
        '## Summary',
        '',
        '- Fix the reader.',
        'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>',
        'Claude-Session: https://claude.ai/code/session_x',
        '🤖 Generated with [Claude Code](https://claude.com/claude-code)',
        'https://claude.ai/code/session_x',
        'Co-authored-by: Jane Doe <jane@example.org>',
        '',
        '---',
        '_Generated by [Claude Code](https://claude.ai/code/session_x)_',
        '',
        '---',
        '_Generated by [Claude Code](https://claude.ai/code)_',
      ].join('\n');
      const result = spawnSync('bash', ['-e', '-c', step?.run ?? ''], {
        env: { PATH: `${bin}:/usr/bin:/bin`, RUNNER_TEMP: dir, PR_NUMBER: '42', PR_TITLE: 'Fix the reader', PR_BODY: body, GITHUB_REPOSITORY: 'o/r' },
        encoding: 'utf-8',
      });
      expect(result.status, result.stderr).toBe(0);
      const args = readFileSync(path.join(dir, 'args'), 'utf-8').split('\n');
      expect(args.slice(0, 6)).toEqual(['pr', 'merge', '42', '--repo', 'o/r', '--auto']);
      expect(args).toContain('--squash');
      expect(args[args.indexOf('--subject') + 1]).toBe('Fix the reader (#42)');
      expect(readFileSync(path.join(dir, 'body'), 'utf-8')).toBe('## Summary\n\n- Fix the reader.\nCo-authored-by: Jane Doe <jane@example.org>\n\n\n');
      rmSync(dir, { recursive: true, force: true });
    }
  );
});

describe('the pinned 7-Zip the corpus and the speed rows run the product with', () => {
  const PINNED_ACTION = './.github/actions/pinned-7zip';
  const actionText = read(path.join(ROOT, '.github', 'actions', 'pinned-7zip', 'action.yml'));
  const action = parse(actionText) as { inputs: Record<string, { default?: string }>; runs: { steps: Step[] } };
  const actionStep = action.runs.steps[0];
  const dockerArg = (name: string): string => {
    const match = new RegExp(`^ARG ${name}=(\\S+)$`, 'm').exec(read(path.join(ROOT, 'Dockerfile.worker')));
    if (!match) throw new Error(`Dockerfile.worker has no ARG ${name}`);
    return match[1];
  };
  const pinnedStepIndex = (workflow: Workflow, job: string): number => {
    const index = workflow.jobs[job].steps.findIndex((step) => step.uses === PINNED_ACTION);
    if (index < 0) throw new Error(`no step uses ${PINNED_ACTION} in ${job}`);
    return index;
  };

  it('is the build the worker image ships (it has the RAR decoders the distribution package lacks): same version and digest as Dockerfile.worker', () => {
    const env = actionStep.env as Record<string, string>;
    for (const key of ['SEVEN_ZIP_VERSION', 'SEVEN_ZIP_RELEASE', 'SEVEN_ZIP_SHA256_X64']) {
      expect(env[key], key).toBe(dockerArg(key));
    }
  });

  it('is verified against its digest and its RAR decoder, and exports P7ZIP_PATH only when asked', () => {
    const script = actionStep.run ?? '';
    expect(script).toContain('sha256sum --check --strict');
    expect(script).toContain("grep -q ' Rar5 '");
    expect(script).toMatch(/if \[ "\$\{EXPORT_ENV\}" = "true" \]; then echo "P7ZIP_PATH=.*" >> "\$\{GITHUB_ENV\}"; fi/);
    expect(action.inputs['export-env'].default).toBe('false');
    for (const { step } of stepsOf(ci)) expect(step.env ?? {}, step.name).not.toHaveProperty('SEVEN_ZIP_SHA256_X64');
    for (const { step } of stepsOf(nightly)) expect(step.env ?? {}, step.name).not.toHaveProperty('SEVEN_ZIP_SHA256_X64');
  });

  it('is installed and exported before the corpus runs and before every speed row is timed', () => {
    const jobs: Array<[Workflow, string, string]> = [
      [nightly, 'realworld', 'Run the corpus shard'],
      [nightly, 'bench-parity-speed', 'Run the speed parity benchmark'],
      [nightly, 'bench-ab-speed', 'Measure the speed rows against that commit'],
    ];
    for (const [workflow, job, runName] of jobs) {
      const install = pinnedStepIndex(workflow, job);
      expect(workflow.jobs[job].steps[install].with?.['export-env'], job).toBe('true');
      expect(install, job).toBeLessThan(workflow.jobs[job].steps.findIndex((step) => step.name === runName));
    }
    const prSpeed = ci.jobs['parity-speed'];
    const install = pinnedStepIndex(ci, 'parity-speed');
    expect(prSpeed.steps[install].with?.['export-env']).toBe('true');
    const firstBench = prSpeed.steps.findIndex((step) => (step.run ?? '').includes('bench:quality -- --parity --speed-only'));
    expect(firstBench).toBeGreaterThan(-1);
    expect(install).toBeLessThan(firstBench);
  });

  it('runs the archive suites of the integration job with that build through P7ZIP_PATH only for that step', () => {
    const steps = ci.jobs.integration.steps;
    const install = pinnedStepIndex(ci, 'integration');
    const archive = steps.findIndex((step) => step.name === 'Run archive tests against pinned 7-Zip');
    expect(install).toBeLessThan(archive);
    expect(steps[install].with?.['export-env'] ?? 'false').toBe('false');
    expect((steps[archive].env as Record<string, string>).P7ZIP_PATH).toBe(`\${{ steps.${steps[install].id}.outputs.path }}`);
  });
});

describe('files of the base that a pull request job compares with', () => {
  const MERGE_PARENT = `parent="$(git cat-file -p HEAD | sed -n 's/^parent //p' | head -1)"`;

  it('are read from the first parent of the tested merge, never from the base branch as it is now', () => {
    const readers = stepsOf(ci).filter(({ step }) => /git show "[^"]*:/.test(step.run ?? ''));
    expect(readers.map(({ step }) => step.name)).toEqual(
      expect.arrayContaining(['Check the code-smell baseline does not grow against the base branch', 'Read the gap file and the baseline of the base'])
    );
    for (const { job, step } of readers) {
      const script = step.run ?? '';
      expect(script, `${job}: ${step.name}`).toContain(MERGE_PARENT);
      expect(script, `${job}: ${step.name}`).not.toMatch(/git show "origin\//);
    }
  });
});
