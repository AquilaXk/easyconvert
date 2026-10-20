import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseDockerfile } from './helpers/dockerfile';

/**
 * How the worker image and CI get `qpdf-runner` (native/qpdf-runner): built in its own stage with a C compiler only (libqpdf is opened at
 * run time, so no development files of qpdf are needed), copied to the runner stage, and checked at build time by loading the library of
 * the qpdf package that the runner stage installs. The expectations are written out here.
 */

const ROOT = path.resolve(__dirname, '..');
const stages = parseDockerfile(readFileSync(path.join(ROOT, 'Dockerfile.worker'), 'utf-8'));
const stage = (name: string) => stages.find((candidate) => candidate.name === name);
const argumentsOf = (name: string, keyword: string): string[] => (stage(name)?.instructions ?? []).filter((i) => i.keyword === keyword).map((i) => i.argument);

describe('the qpdf-runner stage of Dockerfile.worker', () => {
  it('builds native/qpdf-runner with a C compiler and nothing of qpdf', () => {
    expect(stage('qpdfrunner')?.baseImage).toBe('${NODE_IMAGE}');
    const install = argumentsOf('qpdfrunner', 'RUN').find((argument) => /apt-get install/.test(argument)) ?? '';
    expect(install).toMatch(/\bgcc\b/);
    expect(install).not.toMatch(/qpdf/);
    expect(argumentsOf('qpdfrunner', 'COPY')).toContain('native/qpdf-runner/ /src/qpdf-runner/');
    expect(argumentsOf('qpdfrunner', 'RUN')).toContain('/src/qpdf-runner/build.sh /usr/local/bin/qpdf-runner');
  });

  it('copies the binary to the runner stage after the qpdf package is installed, and fails the build when the library cannot be loaded', () => {
    const runs = argumentsOf('runner', 'RUN');
    const qpdfInstalledAt = runs.findIndex((argument) => /apt-get install[^&]*\bqpdf\b/.test(argument));
    const instructions = stage('runner')?.instructions ?? [];
    const copied = instructions.find((i) => i.keyword === 'COPY' && i.argument === '--from=qpdfrunner /usr/local/bin/qpdf-runner /usr/local/bin/qpdf-runner');
    expect(qpdfInstalledAt).toBeGreaterThan(-1);
    expect(copied).toBeDefined();
    const installInstruction = instructions.filter((i) => i.keyword === 'RUN')[qpdfInstalledAt];
    expect(copied!.index).toBeGreaterThan(installInstruction.index);
    expect(runs).toContain("qpdf-runner --check | grep -Eq '^[0-9]+\\.[0-9]+\\.[0-9]+$'");
  });

  it('is built by CI before the tests that need it run, and checked the same way', () => {
    const lines = readFileSync(path.join(ROOT, '.github', 'actions', 'ci-setup', 'install-tools.sh'), 'utf-8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.includes('qpdf-runner') && !line.startsWith('#'));
    expect(lines).toEqual([
      'sudo "$action_path/../../../native/qpdf-runner/build.sh" /usr/local/bin/qpdf-runner || return 1',
      "qpdf-runner --check | grep -Eq '^[0-9]+\\.[0-9]+\\.[0-9]+$' || { echo \"qpdf-runner does not load libqpdf\" >&2; return 1; }",
    ]);
  });

  it('is part of the worker container check, which runs one isolated job', () => {
    const lines = readFileSync(path.join(ROOT, 'scripts', 'verify-worker-container.sh'), 'utf-8').split('\n');
    expect(lines.filter((line) => line.includes('qpdf-runner --self-test') && !line.startsWith('#'))).toEqual(['  runner_output="$(qpdf-runner --self-test 2>&1)"']);
  });
});
