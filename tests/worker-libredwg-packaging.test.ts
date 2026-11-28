import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { parseDockerfile } from './helpers/dockerfile';

/**
 * The worker image carries the DWG reader and writer. LibreDWG is GPL-3.0-or-later and Debian ships no package of it, so the image
 * builds the pinned release archive in a stage of its own and copies two statically linked programs, with their licence text
 * and the note that names the archive, into the runner. The expectations are written out from the licence terms (the corresponding source
 * of the binary must be nameable, the licence text must ship with it) and from the install script's own pin.
 */

const ROOT = path.resolve(__dirname, '..');
const DOCKERFILE = fs.readFileSync(path.join(ROOT, 'Dockerfile.worker'), 'utf-8');
const INSTALL = fs.readFileSync(path.join(ROOT, 'scripts', 'install-libredwg.sh'), 'utf-8');
const stages = parseDockerfile(DOCKERFILE);
const stage = stages.find((candidate) => candidate.name === 'libredwg');
const runner = stages[stages.length - 1];

describe('the libredwg stage of the worker image', () => {
  it('exists, builds on the same base as the runner and runs the pinned install script into /opt/libredwg', () => {
    expect(stage).toBeDefined();
    expect(stage?.baseImage).toBe(runner.baseImage);
    const run = stage?.instructions.filter((instruction) => instruction.keyword === 'RUN').map((instruction) => instruction.argument) ?? [];
    expect(run.some((argument) => argument.includes('build-essential'))).toBe(true);
    expect(run).toContain('/tmp/install-libredwg.sh /opt/libredwg');
    const copies = stage?.instructions.filter((instruction) => instruction.keyword === 'COPY').map((instruction) => instruction.argument) ?? [];
    expect(copies).toContain('scripts/install-libredwg.sh /tmp/install-libredwg.sh');
  });

  it('puts only the two programs, their licence text and their source note into the runner, and checks that they start', () => {
    const instructions = (keyword: string) => runner.instructions.filter((instruction) => instruction.keyword === keyword).map((instruction) => instruction.argument);
    expect(instructions('COPY').filter((argument) => argument.includes('libredwg'))).toEqual([
      '--from=libredwg /opt/libredwg/bin/dwg2dxf /usr/local/bin/dwg2dxf',
      '--from=libredwg /opt/libredwg/bin/dxf2dwg /usr/local/bin/dxf2dwg',
      '--from=libredwg /opt/libredwg/share/doc/libredwg /usr/share/doc/libredwg',
    ]);
    // The notices step collects every /usr/share/doc/*/copyright into /licenses; the source note is copied beside them.
    expect(instructions('RUN').filter((argument) => argument.includes('libredwg') || argument.startsWith('dwg2dxf'))).toEqual([
      'dwg2dxf --version && dxf2dwg --version',
      'cp /usr/share/doc/libredwg/SOURCE /licenses/libredwg.SOURCE',
    ]);
  });

  it('is installed before the privileges are dropped, so that the unprivileged account only runs it', () => {
    const copy = runner.instructions.find((instruction) => instruction.argument.includes('/usr/local/bin/dwg2dxf'));
    const user = runner.instructions.find((instruction) => instruction.keyword === 'USER');
    expect(copy).toBeDefined();
    expect(user).toBeDefined();
    expect((copy?.index ?? Infinity) < (user?.index ?? -Infinity)).toBe(true);
  });
});

describe('the install script of the reader', () => {
  it('pins a published release from 0.15 on, which has the complete fix of the R2004 decompressor overflow and the writer of every DWG version', () => {
    const version = /^LIBREDWG_VERSION="(\d+)\.(\d+)(?:\.(\d+))?"$/m.exec(INSTALL);
    expect(version).not.toBeNull();
    const [major, minor] = [Number(version?.[1]), Number(version?.[2])];
    expect(major * 1000 + minor).toBeGreaterThanOrEqual(15);
    expect(INSTALL).toMatch(/^LIBREDWG_SHA256="[0-9a-f]{64}"$/m);
  });

  it('builds the unmodified archive, writer included, as statically linked programs', () => {
    for (const flag of ['--disable-shared', '--enable-static', '--disable-bindings']) expect(INSTALL).toContain(flag);
    // --enable-release needs GNU plotutils since 0.15, and a tarball is built as a release without it; the writer is the default.
    expect(INSTALL).not.toContain('--disable-write');
    expect(INSTALL).not.toMatch(/\bpatch\b|\bgit apply\b|\bsed -i\b/);
    expect(INSTALL).toContain('install -m 0755 programs/dwg2dxf');
    expect(INSTALL).toContain('install -m 0755 programs/dxf2dwg');
  });

  it('names the archive it built from in a note that ships with the licence text', () => {
    expect(INSTALL).toMatch(/install -m 0644 COPYING "\$INSTALL_DIR\/share\/doc\/libredwg\/copyright"/);
    expect(INSTALL).toMatch(/printf '[^']*%s[^']*' "\$LIBREDWG_VERSION" "\$LIBREDWG_URL" "\$LIBREDWG_SHA256" > "\$INSTALL_DIR\/share\/doc\/libredwg\/SOURCE"/);
  });
});
