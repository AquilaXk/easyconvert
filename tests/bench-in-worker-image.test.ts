import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { readBaseline } from '../bench/gate';
import { readGaps } from '../bench/parity-gaps';
import { skipUnless } from './helpers/strict-skip';

/**
 * The office rows of the benchmark run inside the worker image in the nightly workflow (docs/policy-decisions.md, entry 386), so both sides of
 * a row meet the LibreOffice of production. The container is not started by the test run: the script prints the command it would run, and
 * the workflow is read as YAML.
 */

const ROOT = path.resolve(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'bench-in-worker-image.sh');

function dryRun(args: string[], env: Record<string, string> = {}): string {
  const result = spawnSync('bash', [SCRIPT, 'example/worker:main', ...args], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', BENCH_IMAGE_DRY_RUN: '1', BENCH_IMAGE_PYTHON: '3.13', BENCH_IMAGE_ORACLES: '/tmp/oracles', ...env, NODE_ENV: 'test' },
  });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.trim();
}

describe('scripts/bench-in-worker-image.sh', () => {
  it('starts the container with the flags of the worker service: no capabilities, no new privileges, the repository seccomp profile', () => {
    const command = dryRun(['--parity', '--family', 'document']);
    expect(command).toContain('--cap-drop ALL');
    expect(command).toContain('no-new-privileges:true');
    expect(command).toContain(`seccomp=${path.join(ROOT, 'docker', 'seccomp-worker.json')}`);
    expect(command).toMatch(/--user \d+:\d+/);
  });

  it('mounts the checkout, and the oracles over the dist-packages of the image Python', () => {
    const command = dryRun(['--family', 'data']);
    expect(command).toContain(`-v ${ROOT}:/work`);
    expect(command).toContain('-v /tmp/oracles:/usr/local/lib/python3.13/dist-packages:ro');
  });

  it('runs the benchmark with the image node and without the NODE_ENV the image sets, and hands on its arguments as they are', () => {
    const command = dryRun(['--parity', '--family', 'document,data,cad', '--baseline', 'bench/baseline-office-image.json']);
    expect(command).toContain('unset\\ NODE_ENV');
    expect(command).toContain('node_modules/.bin/tsx\\ bench/run.ts');
    expect(command.replace(/\\,/g, ',').endsWith('bench --parity --family document,data,cad --baseline bench/baseline-office-image.json')).toBe(true);
  });

  it('passes the strict mode and the run that a report names, and nothing else of the environment', () => {
    const command = dryRun(['--family', 'data'], { ORACLE_STRICT_MODE: '1', GITHUB_SHA: 'abc', GITHUB_REF_NAME: 'main', GITHUB_EVENT_NAME: 'schedule', SECRET_TOKEN: 'x' });
    const passed = [...command.matchAll(/ -e (\w+)=(\S+)/g)].map((match) => `${match[1]}=${match[2]}`).sort();
    expect(passed).toEqual(['GITHUB_EVENT_NAME=schedule', 'GITHUB_REF_NAME=main', 'GITHUB_SHA=abc', 'HOME=/home/easyconvert', 'ORACLE_STRICT_MODE=1']);
  });

  it('asks for the wheels of the oracles that the families run here read their outputs back with, at the versions the runner installs', () => {
    const script = fs.readFileSync(SCRIPT, 'utf-8');
    const pins = fs.readFileSync(path.join(ROOT, '.github', 'actions', 'ci-setup', 'pip-packages.txt'), 'utf-8');
    const pattern = /oracle_pattern='\^\(([^)]*)\)=='/.exec(script)?.[1] ?? '';
    const names = pattern.split('|');
    expect(names).toEqual(expect.arrayContaining(['pyarrow', 'duckdb', 'openpyxl', 'olefile', 'xlrd', 'ezdxf', 'pymupdf', 'pytz']));
    for (const name of names) expect(pins, name).toMatch(new RegExp(`^${name}==`, 'm'));
  });
});

describe('the nightly job of the office rows', () => {
  const nightly = parse(fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'nightly.yml'), 'utf-8')) as {
    jobs: Record<string, { 'runs-on': string; permissions?: Record<string, string>; 'continue-on-error'?: boolean; env?: Record<string, string>; steps: Array<{ name?: string; run?: string; uses?: string; env?: Record<string, string>; with?: Record<string, string> }> }>;
  };
  const job = nightly.jobs['bench-parity-office-image'];

  it('runs on the arm runner, logs in with the workflow token and pulls the image main names (private, arm64 only) and builds nothing', () => {
    expect(job['runs-on']).toBe('ubuntu-24.04-arm');
    expect(job.permissions).toEqual({ contents: 'read', packages: 'read' });
    const login = job.steps.find((step) => step.uses?.startsWith('docker/login-action@'));
    expect(login?.with).toEqual({ registry: 'ghcr.io', username: '${{ github.actor }}', password: '${{ secrets.GITHUB_TOKEN }}' });
    const pull = job.steps.find((step) => step.name === 'Pull the worker image of main');
    expect(pull?.run).toContain('docker pull');
    expect(pull?.run).toContain('-worker:main');
    expect(pull?.run).toContain('RepoDigests');
    expect(pull?.run).toContain('for attempt in 1 2 3');
    expect(pull?.run).not.toContain('pinned="$image"');
    expect(job.steps.indexOf(login as never)).toBeLessThan(job.steps.indexOf(pull as never));
    expect(job.steps.some((step) => step.uses?.startsWith('docker/build-push-action'))).toBe(false);
  });

  it('runs the families that the suite decides, never vector, under the strict mode, against its own baseline and gap file', () => {
    expect(job.env?.OFFICE_IMAGE_FAMILIES).toBe('document,data,cad');
    const run = job.steps.find((step) => step.name === 'Run the parity benchmark in the worker image');
    expect(run?.env?.ORACLE_STRICT_MODE).toBe('1');
    expect(run?.run).toContain('scripts/bench-in-worker-image.sh');
    expect(run?.run).toContain('--parity');
    expect(run?.run).toContain('--baseline bench/baseline-office-image.json');
    expect(run?.run).toContain('--gaps bench/parity-gaps-office-image.json');
  });

  it('enforces the baseline recorded from its worker-image report without continue-on-error', () => {
    expect(job['continue-on-error']).toBeUndefined();
    const entries = Object.keys(readBaseline(path.join(ROOT, 'bench', 'baseline-office-image.json')).entries);
    expect(entries.length).toBe(1037);
    expect(entries.every((id) => /^(document|data|cad)\//.test(id))).toBe(true);
    for (const family of ['document/', 'data/', 'cad/']) {
      expect(entries.some((id) => id.startsWith(family))).toBe(true);
    }
    const gaps = readGaps(path.join(ROOT, 'bench', 'parity-gaps-office-image.json'));
    expect(gaps.gaps).toEqual([]);
    expect(gaps.acceptedSlowdowns).toEqual([]);
  });

  it('uploads the report, so that --baseline-from-report has a file to read', () => {
    const upload = job.steps.find((step) => step.uses?.startsWith('actions/upload-artifact@'));
    expect(upload?.with).toMatchObject({ name: 'bench-office-image-results', path: 'bench-results/' });
  });
});

describe('the worker image pull step', () => {
  const bash = spawnSync('bash', ['--version'], { encoding: 'utf-8' });
  const nightly = parse(fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'nightly.yml'), 'utf-8')) as {
    jobs: Record<string, { steps: Array<{ name?: string; run?: string }> }>;
  };
  const pull = nightly.jobs['bench-parity-office-image'].steps.find((step) => step.name === 'Pull the worker image of main');
  const temps: string[] = [];

  afterAll(() => {
    for (const dir of temps) fs.rmSync(dir, { recursive: true, force: true });
  });

  function runPull(options: { failPulls?: number; inspectFails?: boolean; digest?: string; repository?: string; nocasematch?: boolean } = {}) {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'office-pull-'));
    temps.push(work);
    const bin = path.join(work, 'bin');
    fs.mkdirSync(bin);
    const callsLog = path.join(work, 'calls.log');
    const attemptCount = path.join(work, 'attempts');
    fs.writeFileSync(callsLog, '');
    fs.writeFileSync(attemptCount, '0');
    const dockerStub = `#!/bin/bash
echo "docker $*" >> "$STUB_CALLS"
case "$1" in
  pull)
    n=$(cat "$STUB_ATTEMPTS")
    n=$((n + 1))
    echo "$n" > "$STUB_ATTEMPTS"
    if [ "$n" -le "\${STUB_FAIL_PULLS:-0}" ]; then
      echo "transient registry error" >&2
      exit 1
    fi
    exit 0 ;;
  image)
    if [ -n "\${STUB_INSPECT_FAILS:-}" ]; then
      echo "docker daemon error" >&2
      exit 1
    fi
    case "$*" in
      *RepoDigests*) if [ -n "\${STUB_DIGEST:-}" ]; then printf '%s\\n' "\$STUB_DIGEST"; fi ;;
      *revision*) echo "deadbeef" ;;
    esac
    exit 0 ;;
  run)
    echo "LibreOffice 26.8.2.2"
    exit 0 ;;
esac
exit 1
`;
    const sleepStub = `#!/bin/bash
echo "sleep $*" >> "$STUB_CALLS"
exit 0
`;
    fs.writeFileSync(path.join(bin, 'docker'), dockerStub, { mode: 0o755 });
    fs.writeFileSync(path.join(bin, 'sleep'), sleepStub, { mode: 0o755 });
    const output = path.join(work, 'github_output');
    const summary = path.join(work, 'github_summary');
    fs.writeFileSync(output, '');
    fs.writeFileSync(summary, '');
    const script = `${options.nocasematch ? 'shopt -s nocasematch\n' : ''}${pull?.run ?? 'false'}`;
    const result = spawnSync('bash', ['-c', script], {
      cwd: work,
      encoding: 'utf-8',
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        GITHUB_REPOSITORY: options.repository ?? 'AquilaXk/easyconvert',
        GITHUB_OUTPUT: output,
        GITHUB_STEP_SUMMARY: summary,
        STUB_CALLS: callsLog,
        STUB_ATTEMPTS: attemptCount,
        STUB_FAIL_PULLS: String(options.failPulls ?? 0),
        STUB_INSPECT_FAILS: options.inspectFails ? '1' : '',
        STUB_DIGEST: options.digest ?? 'ghcr.io/aquilaxk/easyconvert-worker@sha256:' + 'a'.repeat(64),
      },
    });
    return {
      status: result.status,
      stderr: result.stderr,
      output: fs.readFileSync(output, 'utf-8').trim(),
      summary: fs.readFileSync(summary, 'utf-8').trim(),
      calls: fs.readFileSync(callsLog, 'utf-8').trim().split('\n').filter(Boolean),
    };
  }

  it.skipIf(skipUnless('bash', bash.status === 0))('retries transient pulls, pins the pulled digest, and records it in outputs and summary', () => {
    const pinned = `ghcr.io/aquilaxk/easyconvert-worker@sha256:${'b'.repeat(64)}`;
    const res = runPull({ failPulls: 2, digest: pinned });
    expect(res.status, res.stderr).toBe(0);
    expect(res.output).toBe(`image=${pinned}`);
    expect(res.summary).toContain(pinned);
    expect(res.summary).toContain('deadbeef');
    expect(res.summary).toContain('LibreOffice 26.8.2.2');
    expect(res.calls.filter((c) => c.startsWith('docker pull'))).toHaveLength(3);
    expect(res.calls.filter((c) => c.startsWith('sleep '))).toEqual(['sleep 10', 'sleep 20']);
    expect(res.calls.some((c) => c.includes('org.opencontainers.image.revision') && c.endsWith(pinned))).toBe(true);
    expect(res.calls.some((c) => c.includes(`--entrypoint soffice ${pinned}`))).toBe(true);
  });

  it.skipIf(skipUnless('bash', bash.status === 0))('selects the matching repository digest from multi-entry RepoDigests and lowercases the repository prefix', () => {
    const pinned = `ghcr.io/aquilaxk/easyconvert-worker@sha256:${'c'.repeat(64)}`;
    const res = runPull({
      repository: 'AquilaXk/EasyConvert',
      digest: [`ghcr.io/other/repo@sha256:${'d'.repeat(64)}`, 'ghcr.io/aquilaxk/easyconvert-worker@sha256:bad', pinned].join('\n'),
    });
    expect(res.status, res.stderr).toBe(0);
    expect(res.output).toBe(`image=${pinned}`);
    expect(res.calls.some((c) => c.includes('org.opencontainers.image.revision') && c.endsWith(pinned))).toBe(true);
    expect(res.calls.some((c) => c.includes(`--entrypoint soffice ${pinned}`))).toBe(true);
  });

  it.skipIf(skipUnless('bash', bash.status === 0))('matches dots in the repository name literally rather than as regex wildcards', () => {
    const fakeMatch = `ghcr.io/myXorg/myXrepo-worker@sha256:${'e'.repeat(64)}`;
    const rejected = runPull({ repository: 'my.org/my.repo', digest: fakeMatch });
    expect(rejected.status).toBe(1);
    expect(rejected.stderr).toContain('::error::');
    expect(rejected.output).toBe('');

    const exact = `ghcr.io/my.org/my.repo-worker@sha256:${'e'.repeat(64)}`;
    const accepted = runPull({ repository: 'my.org/my.repo', digest: exact });
    expect(accepted.status, accepted.stderr).toBe(0);
    expect(accepted.output).toBe(`image=${exact}`);
  });

  it.skipIf(skipUnless('bash', bash.status === 0))('fails closed on uppercase sha256 even when nocasematch was previously enabled', () => {
    const upper = `ghcr.io/aquilaxk/easyconvert-worker@sha256:${'A'.repeat(64)}`;
    const res = runPull({ digest: upper, nocasematch: true });
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('::error::');
    expect(res.output).toBe('');
    expect(res.summary).toBe('');
    expect(res.calls.some((c) => c.startsWith('docker run'))).toBe(false);
  });

  it.skipIf(skipUnless('bash', bash.status === 0))('fails closed after three failed pulls, when docker image inspect errors, and when RepoDigests is empty', () => {
    const failedPull = runPull({ failPulls: 3 });
    expect(failedPull.status).toBe(1);
    expect(failedPull.stderr).toContain('could not pull');
    expect(failedPull.calls.filter((c) => c.startsWith('docker pull'))).toHaveLength(3);

    const failedInspect = runPull({ inspectFails: true });
    expect(failedInspect.status).not.toBe(0);
    expect(failedInspect.output).toBe('');

    const emptyDigests = runPull({ digest: '' });
    expect(emptyDigests.status).toBe(1);
    expect(emptyDigests.stderr).toContain('::error::');
    expect(emptyDigests.output).toBe('');
    expect(emptyDigests.summary).toBe('');
    expect(emptyDigests.calls.some((c) => c.startsWith('docker run'))).toBe(false);
  });

  it.skipIf(skipUnless('bash', bash.status === 0)).each([
    ['non-digest string', 'invalid'],
    ['mutable tag instead of digest', 'ghcr.io/aquilaxk/easyconvert-worker:main'],
    ['wrong repository prefix', `ghcr.io/other/repo@sha256:${'a'.repeat(64)}`],
    ['web repository instead of worker', `ghcr.io/aquilaxk/easyconvert-web@sha256:${'a'.repeat(64)}`],
    ['wrong registry host', `docker.io/aquilaxk/easyconvert-worker@sha256:${'a'.repeat(64)}`],
    ['non-sha256 algorithm', `ghcr.io/aquilaxk/easyconvert-worker@sha512:${'a'.repeat(64)}`],
    ['short sha256 hex', `ghcr.io/aquilaxk/easyconvert-worker@sha256:${'a'.repeat(63)}`],
    ['overlong sha256 hex', `ghcr.io/aquilaxk/easyconvert-worker@sha256:${'a'.repeat(65)}`],
    ['non-hex character in sha256', `ghcr.io/aquilaxk/easyconvert-worker@sha256:${'g'.repeat(64)}`],
    ['uppercase hex in sha256', `ghcr.io/aquilaxk/easyconvert-worker@sha256:${'A'.repeat(64)}`],
    ['trailing whitespace or token', `ghcr.io/aquilaxk/easyconvert-worker@sha256:${'a'.repeat(64)} extra`],
    ['leading whitespace', ` ghcr.io/aquilaxk/easyconvert-worker@sha256:${'a'.repeat(64)}`],
  ])('fails closed without falling back to mutable :main for %s', (_label, badDigest) => {
    const res = runPull({ digest: badDigest });
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('::error::');
    expect(res.output).toBe('');
    expect(res.summary).toBe('');
    expect(res.calls.some((c) => c.startsWith('docker run'))).toBe(false);
  });
});
