import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';
import { skipUnless } from './helpers/strict-skip';

/**
 * The container CI job and the script it runs are read as plain text and YAML; the expected paths, flags and
 * acceptance checks are written out from issue 567, not taken from the files under test.
 */

interface WorkflowStep {
  id?: string;
  name?: string;
  if?: string;
  uses?: string;
  run?: string;
  with?: Record<string, string | boolean>;
}

interface WorkflowJob {
  needs?: string[];
  env?: Record<string, string>;
  steps: WorkflowStep[];
  'timeout-minutes'?: number;
}

interface Workflow {
  jobs: Record<string, WorkflowJob>;
}

const ROOT = path.resolve(__dirname, '..');
const workflow = parse(readFileSync(path.join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf-8')) as Workflow;
const container = workflow.jobs.container;
const SCRIPT_PATH = path.join(ROOT, 'scripts', 'verify-worker-container.sh');
const script = readFileSync(SCRIPT_PATH, 'utf-8');
const CONTAINER_JOB_MAX_MINUTES = 20;

const RELEVANT_PATHS = [
  'Dockerfile.worker',
  'docker/seccomp-worker.json',
  'docker/AIRGAP.md',
  'docker-compose.yml',
  'docker-compose.prod.yml',
  'scripts/verify-worker-container.sh',
  'src/lib/security/process-sandbox.ts',
  '.github/workflows/ci.yml',
  '.github/actions/ci-setup/action.yml',
];
const UNRELATED_PATHS = [
  'src/lib/security/process-sandbox.test.ts',
  'src/lib/conversions/archive.ts',
  'scripts/install-verapdf.sh',
  'tests/compose-hardening.test.ts',
  'docs/docker/notes.md',
  '.github/workflows/claude.yml',
  'subdir/Dockerfile.worker',
  'subdir/docker-compose.yml',
];

describe('container job in .github/workflows/ci.yml', () => {
  const pathPattern = new RegExp(container.env?.CONTAINER_PATHS ?? '$^');
  const changeStep = container.steps.find((step) => step.id === 'changes');

  it('runs in parallel with the other jobs and is required by the verify aggregate', () => {
    expect(container.needs).toBeUndefined();
    expect(container['timeout-minutes']).toBeLessThanOrEqual(CONTAINER_JOB_MAX_MINUTES);
    expect(workflow.jobs.verify.needs).toEqual(['changes', 'checks', 'tests', 'conformance', 'integration', 'container']);
    const verifyScript = workflow.jobs.verify.steps.map((step) => step.run ?? '').join('\n');
    expect(verifyScript).toContain('"$CONTAINER_RESULT" != success');
  });

  it.each(RELEVANT_PATHS)('treats a change to %s as relevant', (file) => {
    expect(pathPattern.test(file)).toBe(true);
  });

  it.each(UNRELATED_PATHS)('treats a change to %s as unrelated', (file) => {
    expect(pathPattern.test(file)).toBe(false);
  });

  it('prints the skip message and gates every build and verification step on the result', () => {
    expect(changeStep?.run).toContain('skipped: no container changes');
    const gated = container.steps.filter((step) => step.id !== 'changes' && !step.uses?.startsWith('actions/checkout@'));
    expect(gated.map((step) => step.name)).toEqual([
      'Allow unprivileged user namespaces',
      'Set up Docker Buildx',
      'Build the worker image',
      'Start Redis',
      'Verify the hardened worker container',
      'Publish the verification output',
      'Show container state after a failure',
      'Stop Redis',
    ]);
    for (const step of gated) {
      expect(step.if, step.name).toContain("steps.changes.outputs.relevant == 'true'");
    }
  });

  it('builds Dockerfile.worker with buildx and the GitHub Actions layer cache', () => {
    const buildx = container.steps.find((step) => step.uses?.startsWith('docker/setup-buildx-action@'));
    expect(buildx).toBeDefined();
    const build = container.steps.find((step) => step.uses?.startsWith('docker/build-push-action@'));
    expect(build?.with?.file).toBe('Dockerfile.worker');
    expect(build?.with?.load).toBe(true);
    expect(String(build?.with?.['cache-from'])).toContain('type=gha');
    expect(String(build?.with?.['cache-to'])).toContain('type=gha');
  });

  it('lifts the user-namespace restriction before the container runs', () => {
    const names = container.steps.map((step) => step.run ?? '');
    const lift = names.findIndex((run) => run.includes('apparmor_restrict_unprivileged_userns'));
    const verify = names.findIndex((run) => run.includes('verify-worker-container.sh'));
    expect(lift).toBeGreaterThanOrEqual(0);
    expect(verify).toBeGreaterThan(lift);
  });

  it('runs the script in the compose worker service against a real Redis, with a pipe that keeps its exit status', () => {
    const verifyStep = container.steps.find((step) => step.run?.includes('verify-worker-container.sh'));
    expect(verifyStep?.run).toContain('docker compose');
    expect(verifyStep?.run).toContain('run --rm --no-deps');
    expect(verifyStep?.run).toContain('VERIFY_REDIS_HOST');
    expect(verifyStep?.run).toContain('tee ');
    expect((verifyStep as WorkflowStep & { shell?: string }).shell).toBe('bash');
    const redisStep = container.steps.find((step) => step.run?.includes('up -d redis'));
    expect(redisStep?.run).toContain('redis-cli ping');
  });
});

describe('Dockerfile.worker', () => {
  it('installs libcap2-bin so the verification script can run capsh', () => {
    const dockerfile = readFileSync(path.join(ROOT, 'Dockerfile.worker'), 'utf-8');
    const runner = dockerfile.slice(dockerfile.indexOf('AS runner'));
    expect(runner).toMatch(/^\s+libcap2-bin \\$/m);
  });
});

describe('scripts/verify-worker-container.sh', () => {
  const bash = spawnSync('bash', ['--version'], { encoding: 'utf-8' });

  it.skipIf(skipUnless('bash', bash.status === 0))('parses with bash -n', () => {
    const result = spawnSync('bash', ['-n', SCRIPT_PATH], { encoding: 'utf-8' });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });

  it('asserts each acceptance criterion of the issue and exits non-zero on any failure', () => {
    expect(script).toContain('Read-only file system');
    expect(script).toContain('Permission denied');
    expect(script).toContain('cap_sys_admin');
    expect(script).toContain('capsh --print');
    expect(script).toContain('unshare -r -n');
    expect(script).toContain('pdftotext');
    expect(script).toMatch(/failures=\$\(\(failures \+ 1\)\)/);
    expect(script).toMatch(/exit 1\s*$/);
  });
});
