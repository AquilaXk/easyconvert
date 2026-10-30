import { afterAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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
  shell?: string;
  env?: Record<string, string>;
  with?: Record<string, string | boolean>;
}

interface WorkflowJob {
  needs?: string | string[];
  permissions?: Record<string, string>;
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

  it('runs in parallel with the other jobs, after the libvips build it copies, and is required by the verify aggregate', () => {
    expect(container.needs).toBe('sharp-libvips');
    expect(container['timeout-minutes']).toBeLessThanOrEqual(CONTAINER_JOB_MAX_MINUTES);
    expect(workflow.jobs.verify.needs).toEqual(['changes', 'sharp-libvips', 'checks', 'tests', 'conformance', 'integration', 'container', 'parity-quality']);
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
      'Log in to the container registry',
      'Find the layer cache',
      'Compute the cache key of the libvips build',
      'Restore the libvips build',
      'Check the libvips build',
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

  it('builds Dockerfile.worker with buildx and loads the image', () => {
    const buildx = container.steps.find((step) => step.uses?.startsWith('docker/setup-buildx-action@'));
    expect(buildx).toBeDefined();
    const build = container.steps.find((step) => step.uses?.startsWith('docker/build-push-action@'));
    expect(build?.with?.file).toBe('Dockerfile.worker');
    expect(build?.with?.load).toBe(true);
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

/**
 * The layer cache of the worker image (decided 2026-10-17, epic 763): kept in the container registry of the repository under
 * a `buildcache` tag, written only by a push to main, read by every run, and no longer in the Actions cache, whose 10 GB limit
 * the image layers filled. The expected strings are written out from that decision.
 */
describe('layer cache of the container job', () => {
  const build = container.steps.find((step) => step.uses?.startsWith('docker/build-push-action@'));
  const find = container.steps.find((step) => step.id === 'layer-cache');
  const login = container.steps.find((step) => step.uses?.startsWith('docker/login-action@'));
  const bash = spawnSync('bash', ['--version'], { encoding: 'utf-8' });
  const git = spawnSync('git', ['--version'], { encoding: 'utf-8' });
  const temps: string[] = [];

  afterAll(() => {
    for (const dir of temps) rmSync(dir, { recursive: true, force: true });
  });

  it('keeps the Actions cache out of the image build', () => {
    const workflowText = readFileSync(path.join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf-8');
    expect(workflowText.match(/type=gha/g)).toBeNull();
    expect(String(build?.with?.['cache-from']).match(/gha/)).toBeNull();
    expect(String(build?.with?.['cache-to']).match(/gha/)).toBeNull();
  });

  it('reads the registry cache on every run that finds one, and writes it with every layer only on a push', () => {
    expect(String(build?.with?.['cache-from'])).toBe("${{ steps.layer-cache.outputs.found == 'true' && format('type=registry,ref={0}', steps.layer-cache.outputs.ref) || '' }}");
    expect(String(build?.with?.['cache-to'])).toBe("${{ github.event_name == 'push' && format('type=registry,ref={0},mode=max', steps.layer-cache.outputs.ref) || '' }}");
    expect(build?.if).toBe("steps.changes.outputs.relevant == 'true'");
  });

  it('logs in with the workflow token on pushes only, and no other step uses the token', () => {
    expect(login?.if).toBe("steps.changes.outputs.relevant == 'true' && github.event_name == 'push'");
    expect(login?.with).toEqual({ registry: 'ghcr.io', username: '${{ github.actor }}', password: '${{ secrets.GITHUB_TOKEN }}' });
    const users = container.steps.filter((step) => JSON.stringify(step).includes('GITHUB_TOKEN'));
    expect(users).toEqual([login]);
    expect(login?.uses).toMatch(/^docker\/login-action@[0-9a-f]{40}$/);
  });

  it('asks for the right to write packages in the container job alone', () => {
    expect(container.permissions).toEqual({ contents: 'read', packages: 'write' });
    for (const [name, job] of Object.entries(workflow.jobs)) {
      if (name !== 'container') expect(JSON.stringify(job.permissions ?? {}), name).not.toContain('packages');
    }
  });

  /** Runs the step that finds the cache with a stand-in `docker` that answers the inspection with the given status. */
  function findCache(inspectStatus: number, repository: string): Record<string, string> {
    const dir = mkdtempSync(path.join(tmpdir(), 'layer-cache-'));
    temps.push(dir);
    mkdirSync(path.join(dir, 'bin'));
    writeFileSync(path.join(dir, 'bin', 'docker'), `#!/bin/sh\necho "$@" > "${dir}/docker-arguments"\nexit ${inspectStatus}\n`);
    chmodSync(path.join(dir, 'bin', 'docker'), 0o755);
    const output = path.join(dir, 'output');
    writeFileSync(output, '');
    const result = spawnSync('bash', ['-c', find?.run ?? 'false'], { encoding: 'utf-8', env: { ...process.env, PATH: `${path.join(dir, 'bin')}:${process.env.PATH ?? ''}`, GITHUB_REPOSITORY: repository, GITHUB_OUTPUT: output } });
    expect(result.status, result.stderr).toBe(0);
    const inspected = readFileSync(path.join(dir, 'docker-arguments'), 'utf-8').trim();
    return { ...Object.fromEntries(readFileSync(output, 'utf-8').trim().split('\n').map((line) => line.split('='))), inspected };
  }

  it.skipIf(skipUnless('bash', bash.status === 0))('names the cache in lower case after the repository and uses it when the registry has it', () => {
    const found = findCache(0, 'AquilaXk/EasyConvert');
    expect(found.ref).toBe('ghcr.io/aquilaxk/easyconvert-worker:buildcache');
    expect(found.found).toBe('true');
    expect(found.inspected).toBe('buildx imagetools inspect ghcr.io/aquilaxk/easyconvert-worker:buildcache');
  });

  it.skipIf(skipUnless('bash', bash.status === 0))('builds without a cache, and does not fail, when the registry has none or the package is private', () => {
    const missing = findCache(1, 'AquilaXk/EasyConvert');
    expect(missing.found).toBe('false');
    expect(missing.ref).toBe('ghcr.io/aquilaxk/easyconvert-worker:buildcache');
  });

  describe('on a push to main', () => {
    const changes = container.steps.find((step) => step.id === 'changes');

    /** The container checks' decision for a push that changes `files`; the base is the commit before the push. */
    function relevantAfterPush(files: string[]): string {
      const origin = mkdtempSync(path.join(tmpdir(), 'container-origin-'));
      const checkout = mkdtempSync(path.join(tmpdir(), 'container-checkout-'));
      temps.push(origin, checkout);
      const run = (args: string[], cwd: string, env: Record<string, string> = {}): string => {
        const result = spawnSync('git', args, { cwd, encoding: 'utf-8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', ...env } });
        if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
        return result.stdout.trim();
      };
      const identity = ['-c', 'user.name=ci', '-c', 'user.email=ci@example.invalid'];
      run(['init', '-q', '-b', 'main'], origin);
      run(['config', 'uploadpack.allowAnySHA1InWant', 'true'], origin);
      writeFileSync(path.join(origin, 'README.md'), 'base\n');
      run(['add', 'README.md'], origin);
      run([...identity, 'commit', '-q', '-m', 'base'], origin);
      const before = run(['rev-parse', 'HEAD'], origin);
      run(['clone', '-q', origin, checkout], origin);
      for (const file of files) {
        mkdirSync(path.dirname(path.join(checkout, file)), { recursive: true });
        writeFileSync(path.join(checkout, file), `${file}\n`);
        run(['add', file], checkout);
      }
      run([...identity, 'commit', '-q', '-m', 'change', '--allow-empty'], checkout);
      const output = path.join(checkout, 'github-output.txt');
      writeFileSync(output, '');
      const result = spawnSync('bash', ['-c', changes?.run ?? 'false'], { cwd: checkout, encoding: 'utf-8', env: { ...process.env, ...container.env, EVENT_NAME: 'push', PUSH_BEFORE_SHA: before, PR_BASE_SHA: '', GITHUB_OUTPUT: output, GIT_CONFIG_GLOBAL: '/dev/null' } });
      expect(result.status, result.stderr).toBe(0);
      return readFileSync(output, 'utf-8').trim();
    }

    it.skipIf(skipUnless('git and bash', bash.status === 0 && git.status === 0))('runs the build, so the cache is written, when the push changes the image or this workflow', () => {
      expect(relevantAfterPush(['Dockerfile.worker'])).toBe('relevant=true');
      expect(relevantAfterPush(['.github/workflows/ci.yml'])).toBe('relevant=true');
    });

    it.skipIf(skipUnless('git and bash', bash.status === 0 && git.status === 0))('skips the build for a push that changes neither', () => {
      expect(relevantAfterPush(['docs/guide.md'])).toBe('relevant=false');
    });
  });
});

describe('Dockerfile.worker', () => {
  it('installs libcap2-bin so the verification script can run capsh', () => {
    const dockerfile = readFileSync(path.join(ROOT, 'Dockerfile.worker'), 'utf-8');
    const runner = dockerfile.slice(dockerfile.indexOf('AS runner'));
    expect(runner).toMatch(/^\s+libcap2-bin \\$/m);
  });

  it('installs the LibreOffice Draw application, which imports Visio and CorelDRAW drawings', () => {
    const dockerfile = readFileSync(path.join(ROOT, 'Dockerfile.worker'), 'utf-8');
    const runner = dockerfile.slice(dockerfile.indexOf('AS runner'));
    expect(runner).toMatch(/^\s+libreoffice-draw-nogui \\$/m);
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
