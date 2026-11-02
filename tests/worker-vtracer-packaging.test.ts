import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { parseDockerfile } from './helpers/dockerfile';

/**
 * The worker image carries the raster to SVG tracer: the pinned vtracer release program, fetched in a stage of its own and copied
 * with its licence text and the note that names the archive into the runner, where the build traces a PNG once. The expectations come
 * from the licence terms (MIT: the notice ships with the program) and from the pins of the install script, which are checked against
 * the release the engine module was measured with.
 */

const ROOT = path.resolve(__dirname, '..');
const DOCKERFILE = fs.readFileSync(path.join(ROOT, 'Dockerfile.worker'), 'utf-8');
const INSTALL = fs.readFileSync(path.join(ROOT, 'scripts', 'install-vtracer.sh'), 'utf-8');
const stages = parseDockerfile(DOCKERFILE);
const stage = stages.find((candidate) => candidate.name === 'vtracer');
const runner = stages[stages.length - 1];
const SHA256 = /^[0-9a-f]{64}$/;

const pin = (name: string): string => {
  const match = new RegExp(`^${name}="([^"]+)"$`, 'm').exec(INSTALL);
  expect(match, name).not.toBeNull();
  return match?.[1] ?? '';
};

describe('the vtracer stage of the worker image', () => {
  it('exists, builds on the same base as the runner and runs the pinned install script into /opt/vtracer', () => {
    expect(stage).toBeDefined();
    expect(stage?.baseImage).toBe(runner.baseImage);
    const run = stage?.instructions.filter((instruction) => instruction.keyword === 'RUN').map((instruction) => instruction.argument) ?? [];
    expect(run).toContain('/tmp/install-vtracer.sh /opt/vtracer');
    const copies = stage?.instructions.filter((instruction) => instruction.keyword === 'COPY').map((instruction) => instruction.argument) ?? [];
    expect(copies).toContain('scripts/install-vtracer.sh /tmp/install-vtracer.sh');
  });

  it('puts only the program, its licence text and its source note into the runner, and traces a PNG with it during the build', () => {
    const instructions = (keyword: string) => runner.instructions.filter((instruction) => instruction.keyword === keyword).map((instruction) => instruction.argument);
    expect(instructions('COPY').filter((argument) => argument.includes('vtracer'))).toEqual([
      '--from=vtracer /opt/vtracer/bin/vtracer /usr/local/bin/vtracer',
      '--from=vtracer /opt/vtracer/share/doc/vtracer /usr/share/doc/vtracer',
    ]);
    const runs = instructions('RUN').filter((argument) => argument.includes('vtracer'));
    expect(runs).toHaveLength(2);
    expect(runs[0]).toMatch(/printf '\\211PNG[^']*IEND[^']*' > "\$dir\/in\.png"/);
    expect(runs[0]).toContain('vtracer --input "$dir/in.png" --output "$dir/out.svg"');
    expect(runs[0]).toContain(`grep -q '<path d="M' "$dir/out.svg"`);
    expect(runs[1]).toBe('cp /usr/share/doc/vtracer/SOURCE /licenses/vtracer.SOURCE');
  });

  it('is installed before the privileges are dropped, so that the unprivileged account only runs it', () => {
    const copy = runner.instructions.find((instruction) => instruction.argument.includes('/usr/local/bin/vtracer'));
    const user = runner.instructions.find((instruction) => instruction.keyword === 'USER');
    expect((copy?.index ?? Infinity) < (user?.index ?? -Infinity)).toBe(true);
  });
});

describe('the install script of the tracer', () => {
  it('pins the release the engine was measured with, at the commit its tag names, by digest for each architecture and for the licence', () => {
    expect(pin('VTRACER_VERSION')).toBe('1.0.0-alpha.4');
    expect(pin('VTRACER_COMMIT')).toMatch(/^[0-9a-f]{40}$/);
    for (const name of ['VTRACER_SHA256_AARCH64', 'VTRACER_SHA256_X86_64', 'VTRACER_LICENSE_SHA256']) expect(pin(name)).toMatch(SHA256);
    expect(INSTALL).toContain('raw.githubusercontent.com/visioncortex/vtracer/${VTRACER_COMMIT}/LICENSE');
  });

  it('checks each digest before the archive is unpacked or the licence copied, and installs the program unmodified', () => {
    const order = ['sha256sum --check --strict', 'tar -xzf', 'install -m 0755'].map((step) => INSTALL.indexOf(step));
    expect(order.every((at) => at > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(INSTALL.match(/sha256sum --check --strict/g)).toHaveLength(2);
    expect(INSTALL).not.toMatch(/\bpatch\b|\bgit apply\b|\bsed -i\b|cargo/);
  });

  it('names the archive and its digest in a note that ships with the licence text', () => {
    expect(INSTALL).toMatch(/install -m 0644 "\$work\/LICENSE" "\$INSTALL_DIR\/share\/doc\/vtracer\/copyright"/);
    expect(INSTALL).toMatch(/"\$VTRACER_VERSION" "\$VTRACER_URL" "\$digest" "\$VTRACER_COMMIT" > "\$INSTALL_DIR\/share\/doc\/vtracer\/SOURCE"/);
  });
});
