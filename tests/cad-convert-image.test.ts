import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseDockerfile } from './helpers/dockerfile';

/**
 * How the worker image gets `cad-convert` (STEP and IGES, native/cad-convert): built in its own stage against the development
 * packages of the Open CASCADE libraries, run in the runner stage with only the five runtime library packages the program links,
 * without the sample data and resource files of occt-misc, and checked at build time. The expectations are written out here.
 */

const ROOT = path.resolve(__dirname, '..');
const stages = parseDockerfile(readFileSync(path.join(ROOT, 'Dockerfile.worker'), 'utf-8'));
const stage = (name: string) => stages.find((candidate) => candidate.name === name);
const argumentsOf = (name: string, keyword: string): string[] => (stage(name)?.instructions ?? []).filter((i) => i.keyword === keyword).map((i) => i.argument);

const DEV_PACKAGES = ['libocct-data-exchange-dev', 'libocct-ocaf-dev', 'libocct-modeling-algorithms-dev', 'libocct-modeling-data-dev', 'libocct-foundation-dev'];
const RUNTIME_PACKAGES = ['libocct-data-exchange-7.8', 'libocct-ocaf-7.8', 'libocct-modeling-algorithms-7.8', 'libocct-modeling-data-7.8', 'libocct-foundation-7.8'];

describe('the cad-convert stage of Dockerfile.worker', () => {
  it('builds native/cad-convert with the development packages of the five Open CASCADE libraries it links', () => {
    const build = stage('cadconvert');
    expect(build?.baseImage).toBe('${NODE_IMAGE}');
    const install = argumentsOf('cadconvert', 'RUN').find((argument) => /apt-get install/.test(argument)) ?? '';
    for (const pkg of DEV_PACKAGES) expect(install, pkg).toMatch(new RegExp(`\\b${pkg}\\b`));
    expect(install).toMatch(/\sg\+\+\s/);
    expect(argumentsOf('cadconvert', 'COPY')).toContain('native/cad-convert/ /src/cad-convert/');
    expect(argumentsOf('cadconvert', 'RUN')).toContain('/src/cad-convert/build.sh /usr/local/bin/cad-convert');
  });

  it('installs only the five runtime library packages in the runner, keeps the files of occt-misc out and copies the binary', () => {
    const runnerRuns = argumentsOf('runner', 'RUN');
    const install = runnerRuns.find((argument) => /apt-get install/.test(argument)) ?? '';
    for (const pkg of RUNTIME_PACKAGES) expect(install, pkg).toMatch(new RegExp(`\\b${pkg}\\b`));
    expect(install).not.toMatch(/occt-misc|libocct-draw|libocct-visualization|-dev\b/);
    // The exclusion is written before the install, or dpkg would unpack the data first.
    const exclusion = install.indexOf('path-exclude=/usr/share/opencascade/*');
    expect(exclusion).toBeGreaterThan(-1);
    expect(exclusion).toBeLessThan(install.indexOf('apt-get install'));
    expect(argumentsOf('runner', 'COPY')).toContain('--from=cadconvert /usr/local/bin/cad-convert /usr/local/bin/cad-convert');
  });

  it('fails the build when the binary has an unresolved library or does not start', () => {
    const check = argumentsOf('runner', 'RUN').find((argument) => argument.includes('/usr/local/bin/cad-convert')) ?? '';
    expect(check).toBe("! ldd /usr/local/bin/cad-convert | grep -q 'not found' && cad-convert 2>&1 | grep -q 'usage: cad-convert'");
  });

  it('is built against the same development packages as CI, so a test runs against the program the image ships', () => {
    const ciPackages = readFileSync(path.join(ROOT, '.github', 'actions', 'ci-setup', 'apt-packages.txt'), 'utf-8').split('\n');
    for (const pkg of DEV_PACKAGES) expect(ciPackages, pkg).toContain(pkg);
  });
});
