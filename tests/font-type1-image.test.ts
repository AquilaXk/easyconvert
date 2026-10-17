import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseDockerfile } from './helpers/dockerfile';

/**
 * How the worker image and CI get FontForge (PostScript Type 1 input, src/lib/conversions/font-fontforge.ts): the unmodified Debian package
 * fontforge-nox, installed in the runner stage without its recommended packages, started once at build time, and checked again inside the
 * sandbox by the container check. CI installs the same package, so a test runs against the program the image ships.
 */

const ROOT = path.resolve(__dirname, '..');
const stages = parseDockerfile(readFileSync(path.join(ROOT, 'Dockerfile.worker'), 'utf-8'));
const runnerRuns = (stages.find((stage) => stage.name === 'runner')?.instructions ?? []).filter((instruction) => instruction.keyword === 'RUN').map((instruction) => instruction.argument);

describe('FontForge in the worker image', () => {
  it('installs fontforge-nox, the package without the graphical interface, in the runner stage with no recommended packages', () => {
    const install = runnerRuns.find((argument) => /apt-get install/.test(argument)) ?? '';
    expect(install).toMatch(/--no-install-recommends/);
    expect(install).toMatch(/\bfontforge-nox\b/);
    expect(install).not.toMatch(/\bfontforge\b(?!-nox)/);
  });

  it('fails the build when the program does not start', () => {
    expect(runnerRuns).toContain("fontforge -lang=ff -c 'Print($version)' 2>/dev/null | grep -Eq '^[0-9]{8}$'");
  });

  it('is installed in CI from the same package, so the suites that convert Type 1 fonts run instead of skipping', () => {
    const ciPackages = readFileSync(path.join(ROOT, '.github', 'actions', 'ci-setup', 'apt-packages.txt'), 'utf-8').split('\n');
    expect(ciPackages).toContain('fontforge-nox');
  });

  it('is run by the container check on a Type 1 font inside the sandbox', () => {
    const script = readFileSync(path.join(ROOT, 'scripts', 'verify-worker-container.sh'), 'utf-8');
    expect(script).toContain("fontforge -lang=ff -c 'Open($1); Generate($2)'");
    expect(script).toContain('"OTTO"');
    expect(script).toContain('fontforge converted a Type 1 font to an OpenType font inside the sandbox');
  });
});
