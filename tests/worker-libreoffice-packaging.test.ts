import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  checkBackportsPolicy,
  MAX_DOCKERFILE_BYTES,
  parseAptCachePolicy,
  readDockerfileBackportsSpec,
} from '../scripts/check-libreoffice-backports.mjs';

/**
 * The worker image installs LibreOffice from trixie-backports at one exact version (docs/policy-decisions.md, "LibreOffice 26.8 from
 * trixie-backports"). The image is not built by the test run, so these checks read what the build is told: the version is pinned in two
 * ARGs, the suite is added as its own source with the Debian keyring, the pin raises only the packages of the source `libreoffice`, every
 * office package is installed at the pinned version, and the container job of CI converts a file with the result.
 */

const ROOT = path.resolve(__dirname, '..');
const DOCKERFILE = fs.readFileSync(path.join(ROOT, 'Dockerfile.worker'), 'utf-8');
const RUNNER = DOCKERFILE.slice(DOCKERFILE.indexOf(' AS runner'));
const LICENSING = fs.readFileSync(path.join(ROOT, 'docs', 'licensing.md'), 'utf-8');

const arg = (name: string): string => {
  const match = new RegExp(`^ARG ${name}=(\\S+)$`, 'm').exec(RUNNER);
  expect(match, name).not.toBeNull();
  return match?.[1] ?? '';
};

describe('LibreOffice in the worker image', () => {
  it('is pinned to a trixie-backports build of release 26 by an epoch version and a backport revision', () => {
    expect(arg('LIBREOFFICE_VERSION')).toMatch(/^4:26\.\d+\.\d+\.\d+-\d+~bpo13\+\d+$/);
    expect(arg('LIBORCUS_VERSION')).toMatch(/^\d+\.\d+\.\d+-\d+~bpo13\+\d+$/);
  });

  it('adds trixie-backports as a source signed by the Debian archive keyring, and raises only the packages of the source libreoffice', () => {
    expect(RUNNER).toContain('Suites: trixie-backports');
    expect(RUNNER).toContain('Signed-By: /usr/share/keyrings/debian-archive-keyring.pgp');
    expect(RUNNER).toContain('Package: src:libreoffice\\nPin: release n=trixie-backports\\nPin-Priority: 990');
    expect(RUNNER).not.toMatch(/Package: \*/);
    expect(RUNNER).not.toMatch(/-t trixie-backports/);
  });

  it('installs every office package at the pinned version, the five applications and their shared files', () => {
    for (const name of ['calc', 'draw', 'impress', 'core', 'writer']) {
      expect(RUNNER, name).toMatch(new RegExp(`^\\s+libreoffice-${name}-nogui=\\$\\{LIBREOFFICE_VERSION\\} \\\\$`, 'm'));
    }
    expect(RUNNER).toMatch(/^\s+libreoffice-common=\$\{LIBREOFFICE_VERSION\} \\$/m);
    expect(RUNNER).toMatch(/^\s+liborcus-0\.21-0=\$\{LIBORCUS_VERSION\} \\$/m);
    expect(RUNNER).toMatch(/^\s+liborcus-parser-0\.21-0=\$\{LIBORCUS_VERSION\} \\$/m);
    const unpinned = RUNNER.split('\n').filter((line) => /^\s+libreoffice-[a-z-]+ \\$/.test(line));
    expect(unpinned).toEqual([]);
  });

  it('is named with its release in the licensing notes', () => {
    expect(LICENSING).toMatch(/### 2\.4 LibreOffice \(MPL 2\.0\)[\s\S]*?26\.8/);
  });

  const buildPolicySample = (
    spec: ReturnType<typeof readDockerfileBackportsSpec>,
    overrides: Partial<Record<string, { amd64?: string[]; arm64?: string[]; candidate?: string }>> = {},
    nativeArch: 'amd64' | 'arm64' = 'arm64'
  ): string => {
    const foreignArch = nativeArch === 'amd64' ? 'arm64' : 'amd64';
    const blocks: string[] = [];
    const formatBlock = (header: string, candidate: string, versions: Array<{ version: string; originArch: string }>) => {
      const lines = [`${header}:`, '  Installed: (none)', `  Candidate: ${candidate}`, '  Version table:'];
      for (const { version, originArch } of versions) {
        lines.push(`     ${version} 990`, `        100 http://deb.debian.org/debian trixie-backports/main ${originArch} Packages`);
      }
      blocks.push(lines.join('\n'));
    };

    for (const pkgSpec of spec.packages) {
      const custom = overrides[pkgSpec.name];
      const amd64Versions = custom?.amd64 ?? [pkgSpec.expected];
      const arm64Versions = custom?.arm64 ?? [pkgSpec.expected];
      const nativeCandidate = custom?.candidate ?? pkgSpec.expected;
      if (pkgSpec.archIndependent) {
        formatBlock(pkgSpec.name, nativeCandidate, [
          ...arm64Versions.map((version) => ({ version, originArch: 'arm64' })),
          ...amd64Versions.map((version) => ({ version, originArch: 'amd64' })),
        ]);
        continue;
      }
      const nativeList = nativeArch === 'arm64' ? arm64Versions : amd64Versions;
      const foreignList = foreignArch === 'arm64' ? arm64Versions : amd64Versions;
      formatBlock(
        pkgSpec.name,
        nativeCandidate,
        nativeList.map((version) => ({ version, originArch: nativeArch }))
      );
      formatBlock(
        `${pkgSpec.name}:${foreignArch}`,
        foreignList[0] ?? '(none)',
        foreignList.map((version) => ({ version, originArch: foreignArch }))
      );
    }
    return blocks.join('\n');
  };

  it('extracts pinned versions and package names from Dockerfile.worker and refuses malformed or oversized files', () => {
    const spec = readDockerfileBackportsSpec(DOCKERFILE);
    expect(spec.nodeImage).toMatch(/^docker\.io\/library\/node:24\.\d+\.\d+-trixie-slim@sha256:[0-9a-f]{64}$/);
    expect(spec.libreofficeVersion).toBe(arg('LIBREOFFICE_VERSION'));
    expect(spec.orcusVersion).toBe(arg('LIBORCUS_VERSION'));
    expect(spec.packages.map((entry) => entry.name)).toEqual([
      'libreoffice-calc-nogui',
      'libreoffice-draw-nogui',
      'libreoffice-impress-nogui',
      'libreoffice-core-nogui',
      'libreoffice-writer-nogui',
      'libreoffice-common',
      'liborcus-0.21-0',
      'liborcus-parser-0.21-0',
    ]);
    expect(() => readDockerfileBackportsSpec('')).toThrow(/non-empty/);
    expect(() => readDockerfileBackportsSpec('x'.repeat(MAX_DOCKERFILE_BYTES + 1))).toThrow(/exceeds/);
    expect(() => readDockerfileBackportsSpec('FROM node:24\n')).toThrow(/runner stage/);
  });

  it('accepts current trixie-backports policy on both amd64 and arm64', () => {
    const spec = readDockerfileBackportsSpec(DOCKERFILE);
    for (const nativeArch of ['amd64', 'arm64'] as const) {
      const sample = buildPolicySample(spec, {}, nativeArch);
      const parsed = parseAptCachePolicy(sample, nativeArch);
      const result = checkBackportsPolicy(spec, parsed, nativeArch);
      expect(result.ok, nativeArch).toBe(true);
      expect(result.faults).toEqual([]);
      expect(result.warnings).toEqual([]);
      expect(result.summary).toContain('| `libreoffice-core-nogui` |');
    }
  });

  it('fails closed on single-architecture backports rollover, missing liborcus SONAME, or mismatched native candidate', () => {
    const spec = readDockerfileBackportsSpec(DOCKERFILE);
    const rollover = parseAptCachePolicy(
      buildPolicySample(spec, { 'libreoffice-core-nogui': { amd64: ['4:26.8.3.2-1~bpo13+1'] } }, 'amd64'),
      'amd64'
    );
    const rolloverResult = checkBackportsPolicy(spec, rollover, 'amd64');
    expect(rolloverResult.ok).toBe(false);
    expect(rolloverResult.faults.some((f) => f.includes('amd64') && f.includes('4:26.8.3.2-1~bpo13+1') && f.includes(spec.libreofficeVersion))).toBe(true);

    const missingOrcus = parseAptCachePolicy(
      buildPolicySample(spec, { 'liborcus-0.21-0': { amd64: [], arm64: [] } }, 'amd64'),
      'amd64'
    );
    const missingResult = checkBackportsPolicy(spec, missingOrcus, 'amd64');
    expect(missingResult.ok).toBe(false);
    expect(missingResult.faults.every((f) => f.includes('LIBREOFFICE_VERSION') && f.includes('LIBORCUS_VERSION'))).toBe(true);
    expect(missingResult.faults.some((f) => f.includes('liborcus-0.21-0'))).toBe(true);

    const badCandidate = parseAptCachePolicy(
      buildPolicySample(spec, { 'libreoffice-writer-nogui': { candidate: '4:25.2.3-2+deb13u12' } }, 'amd64'),
      'amd64'
    );
    const badCandidateResult = checkBackportsPolicy(spec, badCandidate, 'amd64');
    expect(badCandidateResult.ok).toBe(false);
    expect(badCandidateResult.faults).toEqual([
      `libreoffice-writer-nogui (amd64): apt candidate is 4:25.2.3-2+deb13u12 instead of pinned ${spec.libreofficeVersion}`,
    ]);
  });

  it('warns without failing when trixie-backports temporarily lists both pinned and newer versions', () => {
    const spec = readDockerfileBackportsSpec(DOCKERFILE);
    const transitional = parseAptCachePolicy(
      buildPolicySample(
        spec,
        { 'libreoffice-common': { amd64: ['4:26.8.3.2-1~bpo13+1', spec.libreofficeVersion] } },
        'amd64'
      ),
      'amd64'
    );
    const result = checkBackportsPolicy(spec, transitional, 'amd64');
    expect(result.ok).toBe(true);
    expect(result.faults).toEqual([]);
    expect(result.warnings).toEqual([
      `libreoffice-common (amd64): trixie-backports lists 4:26.8.3.2-1~bpo13+1, ${spec.libreofficeVersion} alongside pinned ${spec.libreofficeVersion}`,
    ]);
  });
});
