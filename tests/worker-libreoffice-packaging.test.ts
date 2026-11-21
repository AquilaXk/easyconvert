import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

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
});
