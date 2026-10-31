import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseDockerfile } from './helpers/dockerfile';

/**
 * How the worker image and CI get libeot's eot2ttf (EOT fonts compressed with MicroType Express, src/lib/conversions/font-eot-mtx.ts): built
 * from the one commit that scripts/install-libeot.sh pins, not taken from the Debian package, whose 0.01 release writes six composite glyphs
 * of each corpus font with misplaced instruction bytes.
 */

const ROOT = path.resolve(__dirname, '..');
const DOCKERFILE = fs.readFileSync(path.join(ROOT, 'Dockerfile.worker'), 'utf-8');
const INSTALL = fs.readFileSync(path.join(ROOT, 'scripts', 'install-libeot.sh'), 'utf-8');
const TOOLS = fs.readFileSync(path.join(ROOT, '.github', 'actions', 'ci-setup', 'install-tools.sh'), 'utf-8');
const stages = parseDockerfile(DOCKERFILE);
const stage = stages.find((candidate) => candidate.name === 'libeot');
const runner = stages[stages.length - 1];

describe('the libeot stage of the worker image', () => {
  it('exists, builds on the same base as the runner and runs the pinned install script into /opt/libeot', () => {
    expect(stage).toBeDefined();
    expect(stage?.baseImage).toBe(runner.baseImage);
    const run = stage?.instructions.filter((instruction) => instruction.keyword === 'RUN').map((instruction) => instruction.argument) ?? [];
    expect(run.some((argument) => argument.includes('build-essential') && /\bgit\b/.test(argument))).toBe(true);
    expect(run).toContain('/tmp/install-libeot.sh /opt/libeot');
    const copies = stage?.instructions.filter((instruction) => instruction.keyword === 'COPY').map((instruction) => instruction.argument) ?? [];
    expect(copies).toContain('scripts/install-libeot.sh /tmp/install-libeot.sh');
  });

  it('puts only the program, its licence text and its source note into the runner, and checks that the program starts', () => {
    const instructions = (keyword: string) => runner.instructions.filter((instruction) => instruction.keyword === keyword).map((instruction) => instruction.argument);
    expect(instructions('COPY').filter((argument) => argument.includes('libeot'))).toEqual([
      '--from=libeot /opt/libeot/bin/eot2ttf /usr/local/bin/eot2ttf',
      '--from=libeot /opt/libeot/share/doc/libeot /usr/share/doc/libeot',
    ]);
    expect(instructions('RUN').filter((argument) => argument.includes('libeot') || argument.startsWith('eot2ttf'))).toEqual([
      "eot2ttf 2>&1 | grep -q '^Usage: '",
      'cp /usr/share/doc/libeot/SOURCE /licenses/libeot.SOURCE',
    ]);
  });

  it('does not install the Debian packages of libeot, whose release is the one with the damaged composite glyphs', () => {
    const install = runner.instructions.find((instruction) => /apt-get install/.test(instruction.argument))?.argument ?? '';
    expect(install).not.toMatch(/\b(eot2ttf|libeot0|libeot-dev)\b/);
  });

  it('is installed before the privileges are dropped, so that the unprivileged account only runs it', () => {
    const copy = runner.instructions.find((instruction) => instruction.argument.includes('/usr/local/bin/eot2ttf'));
    const user = runner.instructions.find((instruction) => instruction.keyword === 'USER');
    expect(copy).toBeDefined();
    expect(user).toBeDefined();
    expect((copy?.index ?? Infinity) < (user?.index ?? -Infinity)).toBe(true);
  });
});

describe('the install script of the decompressor', () => {
  it('pins a full commit hash and fails when what it fetched is another commit', () => {
    expect(INSTALL).toMatch(/^LIBEOT_COMMIT="[0-9a-f]{40}"$/m);
    expect(INSTALL).toMatch(/rev-parse FETCH_HEAD\)" = "\$LIBEOT_COMMIT" \] \|\| \{/);
  });

  it('builds the sources of the upstream Makefile.am with the assertions of the decoder on', () => {
    expect(INSTALL).toContain('-DDECOMPRESS_ON');
    expect(INSTALL).not.toContain('-DNDEBUG');
    for (const source of ['src/eot2ttf.c', 'src/ctf/parseCTF.c', 'src/lzcomp/lzcomp.c', 'src/lzcomp/ahuff.c', 'src/lzcomp/bitio.c', 'src/lzcomp/mtxmem.c']) {
      expect(INSTALL, source).toContain(source);
    }
  });

  it('installs the licence and patent notes where the image collects the notices, with a note of the commit it was built from', () => {
    expect(INSTALL).toMatch(/^cat LICENSE PATENTS > "\$work\/copyright"$/m);
    expect(INSTALL).toMatch(/^install -m 0644 "\$work\/copyright" "\$INSTALL_DIR\/share\/doc\/libeot\/copyright"$/m);
    expect(INSTALL).toMatch(/^printf '[^']*%s[^']*%s[^']*' "\$LIBEOT_COMMIT" "\$LIBEOT_REPOSITORY" > "\$INSTALL_DIR\/share\/doc\/libeot\/SOURCE"$/m);
  });
});

describe('CI', () => {
  it('builds eot2ttf from the same script in the apt task, so the suites that decompress MTX fonts run instead of skipping', () => {
    const task = TOOLS.slice(TOOLS.indexOf('task_apt() {'), TOOLS.indexOf('task_verapdf() {'));
    expect(task).toMatch(/^ {2}sudo "\$action_path\/\.\.\/\.\.\/\.\.\/scripts\/install-libeot\.sh" \/opt\/libeot \|\| return 1$/m);
  });
});
