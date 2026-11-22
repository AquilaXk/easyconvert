import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseDockerfile } from './helpers/dockerfile';

/**
 * The worker image carries the converter of Markdown, plain text and HTML to LaTeX and of Markdown to reStructuredText: the pinned pandoc release
 * program (GPL-2.0-or-later), fetched in a stage of its own and copied with its licence text, its copyright notice and the note that names the
 * archive. The expectations come from the licence terms (the notice ships with the program, a statically linked library's notice with it) and
 * from the pins of the install script.
 */

const ROOT = path.resolve(__dirname, '..');
const DOCKERFILE = fs.readFileSync(path.join(ROOT, 'Dockerfile.worker'), 'utf-8');
const INSTALL = fs.readFileSync(path.join(ROOT, 'scripts', 'install-pandoc.sh'), 'utf-8');
const LICENSING = fs.readFileSync(path.join(ROOT, 'docs', 'licensing.md'), 'utf-8');
const stages = parseDockerfile(DOCKERFILE);
const stage = stages.find((candidate) => candidate.name === 'pandoc');
const runner = stages[stages.length - 1];
const SHA256 = /^[0-9a-f]{64}$/;

const pin = (name: string): string => {
  const match = new RegExp(`^${name}="([^"]+)"$`, 'm').exec(INSTALL);
  expect(match, name).not.toBeNull();
  return match?.[1] ?? '';
};

describe('the pandoc stage of the worker image', () => {
  it('exists, builds on the same base as the runner and runs the pinned install script into /opt/pandoc', () => {
    expect(stage).toBeDefined();
    expect(stage?.baseImage).toBe(stages[0].baseImage);
    const run = stage?.instructions.filter((instruction) => instruction.keyword === 'RUN').map((instruction) => instruction.argument) ?? [];
    expect(run).toContain('/tmp/install-pandoc.sh /opt/pandoc');
    const copies = stage?.instructions.filter((instruction) => instruction.keyword === 'COPY').map((instruction) => instruction.argument) ?? [];
    expect(copies).toEqual(['scripts/install-pandoc.sh /tmp/install-pandoc.sh', 'scripts/pandoc-notices/THIRD-PARTY-NOTICES /tmp/pandoc-notices/THIRD-PARTY-NOTICES']);
  });

  it('copies the program and its licence directory into the runner, and the note and the copyright notice into the licence directory', () => {
    expect(runner.instructions.filter((instruction) => instruction.keyword === 'COPY').map((instruction) => instruction.argument).filter((argument) => argument.includes('pandoc'))).toEqual([
      '--from=pandoc /opt/pandoc/bin/pandoc /usr/local/bin/pandoc',
      '--from=pandoc /opt/pandoc/share/doc/pandoc /usr/share/doc/pandoc',
    ]);
    const runs = runner.instructions.filter((instruction) => instruction.keyword === 'RUN').map((instruction) => instruction.argument);
    expect(runs.filter((run) => run.startsWith('cp /usr/share/doc/pandoc/'))).toEqual([
      'cp /usr/share/doc/pandoc/SOURCE /licenses/pandoc.SOURCE',
      'cp /usr/share/doc/pandoc/COPYRIGHT /licenses/pandoc.COPYRIGHT',
      'cp /usr/share/doc/pandoc/THIRD-PARTY-NOTICES /licenses/pandoc.THIRD-PARTY-NOTICES',
    ]);
  });

  it('fails the build unless the program converts a Markdown file under the options of the worker route', () => {
    const check = runner.instructions.find((instruction) => instruction.keyword === 'RUN' && instruction.argument.includes('pandoc --sandbox --from markdown --to latex'));
    expect(check?.argument).toMatch(/pandoc --sandbox --from markdown --to latex \/tmp\/pandoc-check\.md \| head -n 1\)" = '\\section\{Title\}\\label\{title\}'/);
  });
});

describe('the install script of pandoc', () => {
  it('pins the release, both architectures, the licence text and the copyright notice by SHA-256, from the tagged commit and not a branch', () => {
    expect(pin('PANDOC_VERSION')).toBe('3.1.11');
    expect(pin('PANDOC_COMMIT')).toMatch(/^[0-9a-f]{40}$/);
    for (const name of ['PANDOC_SHA256_AARCH64', 'PANDOC_SHA256_X86_64', 'PANDOC_LICENSE_SHA256', 'PANDOC_COPYRIGHT_SHA256']) expect(pin(name), name).toMatch(SHA256);
    expect(INSTALL).toContain('raw.githubusercontent.com/jgm/pandoc/${PANDOC_COMMIT}');
    expect(INSTALL).toContain('releases/download/${PANDOC_VERSION}/pandoc-${PANDOC_VERSION}-linux-${target}.tar.gz');
    expect(INSTALL).toContain('target="arm64"');
    expect(INSTALL).toContain('target="amd64"');
  });

  it('checks every download against its digest before anything is installed, and installs the licence, the copyright notice and the source note', () => {
    expect(INSTALL.match(/sha256sum --check --strict/g)?.length).toBeGreaterThanOrEqual(2);
    expect(INSTALL).toMatch(/install -m 0644 "\$work\/COPYING\.md-\$\{PANDOC_COMMIT\}" "\$INSTALL_DIR\/share\/doc\/pandoc\/copyright"/);
    expect(INSTALL).toMatch(/install -m 0644 "\$work\/COPYRIGHT-\$\{PANDOC_COMMIT\}" "\$INSTALL_DIR\/share\/doc\/pandoc\/COPYRIGHT"/);
    expect(INSTALL).toMatch(/> "\$INSTALL_DIR\/share\/doc\/pandoc\/SOURCE"/);
  });

  it('extracts the program alone from the archive, not the links to it', () => {
    expect(INSTALL).toMatch(/^tar -xzf [^\n]*"pandoc-\$\{PANDOC_VERSION\}\/bin\/pandoc"$/m);
  });

  it('refuses a host that is not Linux, and an architecture it has no pin for, before it downloads anything', () => {
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'pandoc-install-'));
    try {
      fs.writeFileSync(path.join(bin, 'uname'), '#!/bin/sh\nif [ "$1" = "-s" ]; then echo Linux; else echo riscv64; fi\n', { mode: 0o755 });
      fs.writeFileSync(path.join(bin, 'curl'), '#!/bin/sh\necho curl-was-called >&2\nexit 1\n', { mode: 0o755 });
      const run = spawnSync('bash', [path.join(ROOT, 'scripts', 'install-pandoc.sh'), path.join(bin, 'install')], { env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` }, encoding: 'utf-8' });
      expect(run.status).not.toBe(0);
      expect(run.stderr).toContain('no pinned pandoc build for riscv64');
      expect(run.stderr).not.toContain('curl-was-called');
    } finally {
      fs.rmSync(bin, { recursive: true, force: true });
    }
  });
});

describe('the licence notice of pandoc', () => {
  it('names the program, its licence, its separate-process use and the files the image carries', () => {
    const section = LICENSING.slice(LICENSING.indexOf('### 2.28 pandoc'), LICENSING.indexOf('## 3. LGPL Relinking'));
    expect(section).toContain('GPL-2.0-or-later');
    expect(section).toContain('separate process');
    for (const file of ['/licenses/pandoc.copyright', '/licenses/pandoc.COPYRIGHT', '/licenses/pandoc.SOURCE']) expect(section, file).toContain(file);
  });
});
