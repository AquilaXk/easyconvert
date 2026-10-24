import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { parseDockerfile } from './helpers/dockerfile';

/**
 * The worker image carries the XPS renderer. GhostXPS is part of GhostPDL (AGPL-3.0-or-later) and Debian ships no package of
 * it, so the image builds the pinned release archive in a stage of its own and copies one program, with its licence text and
 * the note that names the archive, into the runner. The expectations are written out from the licence terms (the
 * corresponding source of the binary must be nameable, the licence text must ship with it, the program is not modified) and
 * from the install script's own pin.
 */

const ROOT = path.resolve(__dirname, '..');
const DOCKERFILE = fs.readFileSync(path.join(ROOT, 'Dockerfile.worker'), 'utf-8');
const INSTALL = fs.readFileSync(path.join(ROOT, 'scripts', 'install-ghostxps.sh'), 'utf-8');
const stages = parseDockerfile(DOCKERFILE);
const stage = stages.find((candidate) => candidate.name === 'ghostxps');
const runner = stages[stages.length - 1];

describe('the ghostxps stage of the worker image', () => {
  it('exists, builds on the same base as the runner and runs the pinned install script into /opt/ghostxps', () => {
    expect(stage).toBeDefined();
    expect(stage?.baseImage).toBe(runner.baseImage);
    const run = stage?.instructions.filter((instruction) => instruction.keyword === 'RUN').map((instruction) => instruction.argument) ?? [];
    expect(run.some((argument) => argument.includes('build-essential'))).toBe(true);
    expect(run).toContain('/tmp/install-ghostxps.sh /opt/ghostxps');
    const copies = stage?.instructions.filter((instruction) => instruction.keyword === 'COPY').map((instruction) => instruction.argument) ?? [];
    expect(copies).toContain('scripts/install-ghostxps.sh /tmp/install-ghostxps.sh');
  });

  it('puts only the program, its licence text and its source note into the runner, and checks that the program starts', () => {
    const instructions = (keyword: string) => runner.instructions.filter((instruction) => instruction.keyword === keyword).map((instruction) => instruction.argument);
    expect(instructions('COPY').filter((argument) => argument.includes('ghostxps'))).toEqual([
      '--from=ghostxps /opt/ghostxps/bin/gxps /usr/local/bin/gxps',
      '--from=ghostxps /opt/ghostxps/share/doc/ghostxps /usr/share/doc/ghostxps',
    ]);
    expect(instructions('RUN').filter((argument) => argument.includes('ghostxps') || argument.startsWith('gxps'))).toEqual([
      'gxps -v',
      'cp /usr/share/doc/ghostxps/SOURCE /licenses/ghostxps.SOURCE',
    ]);
  });

  it('is installed before the privileges are dropped, so that the unprivileged account only runs it', () => {
    const copy = runner.instructions.find((instruction) => instruction.argument.includes('/usr/local/bin/gxps'));
    const user = runner.instructions.find((instruction) => instruction.keyword === 'USER');
    expect(copy).toBeDefined();
    expect(user).toBeDefined();
    expect((copy?.index ?? Infinity) < (user?.index ?? -Infinity)).toBe(true);
  });
});

describe('the install script of the renderer', () => {
  it('downloads one GhostPDL release archive over HTTPS and checks its SHA-256 before unpacking it', () => {
    expect(INSTALL).toMatch(/^GHOSTPDL_SHA256="[0-9a-f]{64}"$/m);
    expect(INSTALL).toMatch(/^GHOSTPDL_URL="https:\/\/github\.com\/ArtifexSoftware\/ghostpdl-downloads\/releases\/download\/\$\{GHOSTPDL_TAG\}\/ghostpdl-\$\{GHOSTPDL_VERSION\}\.tar\.xz"$/m);
    const check = INSTALL.indexOf('sha256sum --check --strict');
    const unpack = INSTALL.indexOf('tar -xJf');
    expect(check).toBeGreaterThan(0);
    expect(unpack).toBeGreaterThan(check);
  });

  it('builds the unmodified archive into the gxps program only, with no part that reaches outside the process', () => {
    for (const flag of ['--without-x', '--disable-cups', '--disable-gtk', '--disable-fontconfig', '--disable-dbus', '--without-ijs', '--without-tesseract']) expect(INSTALL).toContain(flag);
    expect(INSTALL).toMatch(/make -j"\$jobs" gxps /);
    expect(INSTALL).not.toMatch(/\bpatch\b|\bgit apply\b|\bsed -i\b/);
    expect(INSTALL).toContain('install -m 0755 bin/gxps');
  });

  it('builds a position independent executable with a read-only relocation table and immediate binding, and fails the build when the program lacks one', () => {
    expect(INSTALL).toMatch(/^hardening_cflags="[^"]*-fstack-protector-strong -fstack-clash-protection -fPIE"$/m);
    expect(INSTALL).toMatch(/^hardening_ldflags="-Wl,-z,relro,-z,now -pie"$/m);
    expect(INSTALL).toContain('CFLAGS="$hardening_cflags"');
    expect(INSTALL).toContain('LDFLAGS="$hardening_ldflags"');
    const build = INSTALL.indexOf('make -j"$jobs" gxps');
    const checks = ['readelf -h bin/gxps', 'readelf -lW -d bin/gxps', "'Type:[[:space:]]*DYN'", 'GNU_RELRO', 'BIND_NOW'].map((check) => INSTALL.indexOf(check));
    for (const position of checks) expect(position).toBeGreaterThan(build);
    expect(Math.max(...checks)).toBeLessThan(INSTALL.indexOf('install -m 0755 bin/gxps'));
  });

  it('names the archive it built from in a note that ships with the licence text', () => {
    expect(INSTALL).toMatch(/install -m 0644 LICENSE "\$INSTALL_DIR\/share\/doc\/ghostxps\/copyright"/);
    expect(INSTALL).toMatch(/printf '[^']*%s[^']*' "\$GHOSTPDL_VERSION" "\$GHOSTPDL_URL" "\$GHOSTPDL_SHA256" > "\$INSTALL_DIR\/share\/doc\/ghostxps\/SOURCE"/);
  });
});
