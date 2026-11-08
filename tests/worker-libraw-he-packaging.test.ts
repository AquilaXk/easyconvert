import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { parseDockerfile } from './helpers/dockerfile';

/**
 * The worker image and the CI setup carry a second `dcraw_emu`, built from one pinned commit of the LibRaw development branch, for Nikon
 * NEF files with High Efficiency compression. LibRaw is LGPL-2.1 or CDDL-1.0, and the program is built unmodified in a stage of its own,
 * used as a separate program and named so that the distribution's `dcraw_emu` (which every other camera file uses) is not replaced.
 * The expectations are written out from that design and from the install script's own pin.
 */

const ROOT = path.resolve(__dirname, '..');
const DOCKERFILE = fs.readFileSync(path.join(ROOT, 'Dockerfile.worker'), 'utf-8');
const INSTALL = fs.readFileSync(path.join(ROOT, 'scripts', 'install-libraw-he.sh'), 'utf-8');
const TOOLS = fs.readFileSync(path.join(ROOT, '.github', 'actions', 'ci-setup', 'install-tools.sh'), 'utf-8');
const ACTION = fs.readFileSync(path.join(ROOT, '.github', 'actions', 'ci-setup', 'action.yml'), 'utf-8');
const LICENSING = fs.readFileSync(path.join(ROOT, 'docs', 'licensing.md'), 'utf-8');
const stages = parseDockerfile(DOCKERFILE);
const stage = stages.find((candidate) => candidate.name === 'librawhe');
const runner = stages[stages.length - 1];
const COMMIT = /^LIBRAW_HE_COMMIT="([0-9a-f]{40})"$/m.exec(INSTALL)?.[1];

describe('the librawhe stage of the worker image', () => {
  it('exists, builds on the same base as the runner and runs the pinned install script into /opt/libraw-he', () => {
    expect(stage).toBeDefined();
    expect(stage?.baseImage).toBe(runner.baseImage);
    const run = stage?.instructions.filter((instruction) => instruction.keyword === 'RUN').map((instruction) => instruction.argument) ?? [];
    expect(run.some((argument) => argument.includes('build-essential') && /\bgit\b/.test(argument))).toBe(true);
    expect(run).toContain('/tmp/install-libraw-he.sh /opt/libraw-he');
    const copies = stage?.instructions.filter((instruction) => instruction.keyword === 'COPY').map((instruction) => instruction.argument) ?? [];
    expect(copies).toContain('scripts/install-libraw-he.sh /tmp/install-libraw-he.sh');
  });

  it('puts the program beside the distribution one under another name, with its licence texts and source note, and checks that it starts', () => {
    const instructions = (keyword: string) => runner.instructions.filter((instruction) => instruction.keyword === keyword).map((instruction) => instruction.argument);
    expect(instructions('COPY').filter((argument) => argument.includes('libraw-he'))).toEqual([
      '--from=librawhe /opt/libraw-he/bin/dcraw_emu /usr/local/bin/dcraw_emu_he',
      '--from=librawhe /opt/libraw-he/share/doc/libraw-he /usr/share/doc/libraw-he',
    ]);
    expect(instructions('RUN').filter((argument) => argument.includes('libraw-he') || argument.includes('dcraw_emu_he'))).toEqual([
      "{ dcraw_emu_he 2>&1 || true; } | grep -q 'almost complete dcraw emulator'",
      'cp /usr/share/doc/libraw-he/SOURCE /licenses/libraw-he.SOURCE',
    ]);
    // The distribution package stays the decoder of every other file.
    expect(instructions('RUN').some((argument) => /\blibraw-bin\b/.test(argument))).toBe(true);
  });

  it('is installed before the privileges are dropped, so that the unprivileged account only runs it', () => {
    const copy = runner.instructions.find((instruction) => instruction.argument.includes('/usr/local/bin/dcraw_emu_he'));
    const user = runner.instructions.find((instruction) => instruction.keyword === 'USER');
    expect(copy).toBeDefined();
    expect(user).toBeDefined();
    expect((copy?.index ?? Infinity) < (user?.index ?? -Infinity)).toBe(true);
  });
});

describe('the install script of the decoder', () => {
  it('pins one commit that holds the High Efficiency decoder (snapshot 202611 of 2026-11-04 or later), fetched by its hash and checked before the build', () => {
    expect(COMMIT).toMatch(/^[0-9a-f]{40}$/);
    expect(INSTALL).toContain('git -C "$source_dir" fetch --quiet --depth 1 "$LIBRAW_HE_URL" "$LIBRAW_HE_COMMIT"');
    expect(INSTALL).toMatch(/if \[ "\$fetched" != "\$LIBRAW_HE_COMMIT" \]; then[\s\S]*exit 1/);
    expect(INSTALL.indexOf('"$fetched" != "$LIBRAW_HE_COMMIT"')).toBeLessThan(INSTALL.indexOf('make -f Makefile.dist'));
    expect(INSTALL).toContain('test -f src/decoders/nikonhe.cpp');
    expect(INSTALL).toContain('LIBRAW_HE_URL="https://github.com/LibRaw/LibRaw.git"');
  });

  it('builds the unmodified source into one statically linked program and installs it with the licence texts and the source note', () => {
    expect(INSTALL).not.toMatch(/\bpatch\b|\bgit apply\b|\bsed -i\b/);
    expect(INSTALL).toContain('lib/libraw.a bin/dcraw_emu');
    expect(INSTALL).toContain('install -m 0755 bin/dcraw_emu "$INSTALL_DIR/bin/dcraw_emu"');
    expect(INSTALL).toContain('cat COPYRIGHT LICENSE.CDDL LICENSE.LGPL > "$INSTALL_DIR/share/doc/libraw-he/copyright"');
    expect(INSTALL).toMatch(/printf '[^']*%s[^']*%s[^']*' "\$LIBRAW_HE_COMMIT" "\$LIBRAW_HE_URL" > "\$INSTALL_DIR\/share\/doc\/libraw-he\/SOURCE"/);
  });

  it('is run by the CI setup, which caches the build by the script and links it under the name the worker looks for', () => {
    const task = TOOLS.slice(TOOLS.indexOf('task_libraw() {'));
    expect(task).toContain('scripts/install-libraw-he.sh');
    expect(task).toContain('/usr/local/bin/dcraw_emu_he');
    expect(TOOLS).toContain('[libraw]=300');
    expect(ACTION).toMatch(/key: libraw-he-\$\{\{ runner\.os \}\}-\$\{\{ runner\.arch \}\}-\$\{\{ hashFiles\('scripts\/install-libraw-he\.sh'\) \}\}/);
    expect(ACTION).toContain('LIBRAW_HE_CACHE_HIT: ${{ steps.libraw-he-cache.outputs.cache-hit }}');
  });
});

describe('the licensing notes of the decoder', () => {
  it('name both licences, the source location, the separate process and the files the image carries, and the image carries them', () => {
    const start = LICENSING.indexOf('### 2.16 LibRaw snapshot for Nikon High Efficiency NEF');
    expect(start).toBeGreaterThan(-1);
    const entry = LICENSING.slice(start, LICENSING.indexOf('\n---\n', start));
    for (const text of ['LGPL-2.1', 'CDDL-1.0', 'https://github.com/LibRaw/LibRaw', 'separate process', 'scripts/install-libraw-he.sh', '/licenses/libraw-he.copyright', '/licenses/libraw-he.SOURCE']) {
      expect(entry, text).toContain(text);
    }
    expect(fs.readFileSync(path.join(ROOT, 'scripts', 'install-libraw-he.sh'), 'utf-8')).toContain('LICENSE.CDDL LICENSE.LGPL');
  });
});
