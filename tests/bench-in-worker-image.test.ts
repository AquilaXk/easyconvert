import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { readBaseline } from '../bench/gate';
import { readGaps } from '../bench/parity-gaps';

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

  it('cannot fail the run until its baseline is recorded from its own report', () => {
    expect(job['continue-on-error']).toBe(true);
    expect(Object.keys(readBaseline(path.join(ROOT, 'bench', 'baseline-office-image.json')).entries)).toEqual([]);
    expect(readGaps(path.join(ROOT, 'bench', 'parity-gaps-office-image.json')).gaps).toEqual([]);
  });

  it('uploads the report, so that --baseline-from-report has a file to read', () => {
    const upload = job.steps.find((step) => step.uses?.startsWith('actions/upload-artifact@'));
    expect(upload?.with).toMatchObject({ name: 'bench-office-image-results', path: 'bench-results/' });
  });
});
