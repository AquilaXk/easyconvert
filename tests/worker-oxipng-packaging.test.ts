import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { NOTICES_FILE, OXIPNG_COMMIT, OXIPNG_VERSION, pinnedLinkedCrates, readPinned, UPSTREAM_DIGESTS, UPSTREAM_DIR } from '../scripts/generate-oxipng-notices';
import { sha256 } from '../scripts/generate-vtracer-notices';
import { parseDockerfile } from './helpers/dockerfile';

/**
 * The worker image carries the lossless PNG optimiser: the pinned oxipng release program (MIT), fetched in a stage of its own and copied
 * with its licence text, the notices of the crates linked into it and the note that names the archive. The expectations come from the licence
 * terms (the notice ships with the program, a statically linked crate's licence with it) and from the pins of the install script.
 */

const ROOT = path.resolve(__dirname, '..');
const DOCKERFILE = fs.readFileSync(path.join(ROOT, 'Dockerfile.worker'), 'utf-8');
const INSTALL = fs.readFileSync(path.join(ROOT, 'scripts', 'install-oxipng.sh'), 'utf-8');
const stages = parseDockerfile(DOCKERFILE);
const stage = stages.find((candidate) => candidate.name === 'oxipng');
const runner = stages[stages.length - 1];
const notices = fs.readFileSync(NOTICES_FILE);
const noticesText = notices.toString('utf8');
const SHA256 = /^[0-9a-f]{64}$/;

const pin = (name: string): string => {
  const match = new RegExp(`^${name}="([^"]+)"$`, 'm').exec(INSTALL);
  expect(match, name).not.toBeNull();
  return match?.[1] ?? '';
};

describe('the oxipng stage of the worker image', () => {
  it('exists, builds on the same base as the runner and runs the pinned install script into /opt/oxipng', () => {
    expect(stage).toBeDefined();
    expect(stage?.baseImage).toBe(stages[0].baseImage);
    const run = stage?.instructions.filter((instruction) => instruction.keyword === 'RUN').map((instruction) => instruction.argument) ?? [];
    expect(run).toContain('/tmp/install-oxipng.sh /opt/oxipng');
    const copies = stage?.instructions.filter((instruction) => instruction.keyword === 'COPY').map((instruction) => instruction.argument) ?? [];
    expect(copies).toEqual(['scripts/install-oxipng.sh /tmp/install-oxipng.sh', 'scripts/oxipng-notices/THIRD-PARTY-NOTICES /tmp/oxipng-notices/THIRD-PARTY-NOTICES']);
  });

  it('copies the program, its licence directory and the notices into the runner and the licence directory', () => {
    expect(runner.instructions.filter((instruction) => instruction.keyword === 'COPY').map((instruction) => instruction.argument).filter((argument) => argument.includes('oxipng'))).toEqual([
      '--from=oxipng /opt/oxipng/bin/oxipng /usr/local/bin/oxipng',
      '--from=oxipng /opt/oxipng/share/doc/oxipng /usr/share/doc/oxipng',
    ]);
    const runs = runner.instructions.filter((instruction) => instruction.keyword === 'RUN').map((instruction) => instruction.argument);
    expect(runs.filter((run) => run.includes('/usr/share/doc/oxipng'))).toEqual([
      'cp /usr/share/doc/oxipng/SOURCE /licenses/oxipng.SOURCE',
      'cp /usr/share/doc/oxipng/THIRD-PARTY-NOTICES /licenses/oxipng.THIRD-PARTY-NOTICES',
    ]);
    expect(runs).toContain('oxipng --version');
  });
});

describe('the install script of oxipng', () => {
  it('pins the release, both architectures and the licence text by SHA-256, from the tagged commit and not a branch', () => {
    expect(pin('OXIPNG_VERSION')).toBe(OXIPNG_VERSION);
    expect(pin('OXIPNG_COMMIT')).toBe(OXIPNG_COMMIT);
    for (const name of ['OXIPNG_SHA256_AARCH64', 'OXIPNG_SHA256_X86_64', 'OXIPNG_LICENSE_SHA256', 'OXIPNG_NOTICES_SHA256']) expect(pin(name), name).toMatch(SHA256);
    expect(INSTALL).toContain('raw.githubusercontent.com/oxipng/oxipng/${OXIPNG_COMMIT}/LICENSE');
    expect(INSTALL).toContain('releases/download/v${OXIPNG_VERSION}/oxipng-${OXIPNG_VERSION}-${target}.tar.gz');
    expect(INSTALL).toContain('aarch64-unknown-linux-musl');
    expect(INSTALL).toContain('x86_64-unknown-linux-musl');
  });

  it('checks every download against its digest before anything is installed, and installs the licence, the notices and the source note', () => {
    expect(INSTALL.match(/sha256sum --check --strict/g)?.length).toBeGreaterThanOrEqual(3);
    expect(INSTALL).toMatch(/install -m 0644 "\$work\/LICENSE" "\$INSTALL_DIR\/share\/doc\/oxipng\/copyright"/);
    expect(INSTALL).toMatch(/install -m 0644 "\$notices" "\$INSTALL_DIR\/share\/doc\/oxipng\/THIRD-PARTY-NOTICES"/);
    expect(INSTALL).toMatch(/> "\$INSTALL_DIR\/share\/doc\/oxipng\/SOURCE"/);
  });

  it('refuses a host that is not Linux, and an architecture it has no pin for, before it downloads anything', () => {
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'oxipng-install-'));
    try {
      const uname = path.join(bin, 'uname');
      fs.writeFileSync(uname, '#!/bin/sh\nif [ "$1" = "-s" ]; then echo Linux; else echo riscv64; fi\n', { mode: 0o755 });
      const curl = path.join(bin, 'curl');
      fs.writeFileSync(curl, '#!/bin/sh\necho curl-was-called >&2\nexit 1\n', { mode: 0o755 });
      const run = spawnSync('bash', [path.join(ROOT, 'scripts', 'install-oxipng.sh'), path.join(bin, 'install')], { env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` }, encoding: 'utf-8' });
      expect(run.status).not.toBe(0);
      expect(run.stderr).toContain('no pinned oxipng build for riscv64');
      expect(run.stderr).not.toContain('curl-was-called');
    } finally {
      fs.rmSync(bin, { recursive: true, force: true });
    }
  });
});

describe('the third-party notices of the oxipng program', () => {
  it('come from the upstream files of the commit the install script pins', () => {
    for (const [file, digest] of Object.entries(UPSTREAM_DIGESTS)) expect(sha256(readPinned(file)), file).toBe(digest);
  });

  it('name every crate of the Cargo.lock dependency graph of the program, and no development dependency', () => {
    const names = pinnedLinkedCrates().map((crate) => `${crate.name} ${crate.version}`);
    expect(names).toContain('libdeflater 1.26.0');
    expect(names).toContain('zopfli 0.8.3');
    expect(names.some((name) => name.startsWith('serde_json '))).toBe(false);
    const lines = noticesText.split('\n');
    const start = lines.findIndex((line) => /^Crates \(\d+\):$/.test(line)) + 1;
    const listed = lines.slice(start, lines.indexOf('', start)).map((line) => line.replace(/ \(.*\)$/, ''));
    expect(listed).toEqual(names);
  });

  it('carry the licence of libdeflate, which libdeflate-sys builds from the C source it ships, and the Apache-2.0 text', () => {
    expect(noticesText).toMatch(/Shipped by: [^\n]*libdeflate-sys 1\.26\.0 \(libdeflate\/COPYING\)/);
    expect(noticesText).toMatch(/Copyright 2016 Eric Biggers/);
    expect(noticesText).toMatch(/Apache License\s+Version 2\.0, January 2004/);
  });

  it('are pinned by digest in the install script, checked before any download', () => {
    expect(pin('OXIPNG_NOTICES_SHA256')).toBe(sha256(notices));
    const check = INSTALL.indexOf('OXIPNG_NOTICES_SHA256}  $notices"');
    expect(check).toBeGreaterThan(-1);
    expect(check).toBeLessThan(INSTALL.indexOf('\ncached_fetch '));
  });

  it('keep their bytes in any checkout, so the pinned digests hold', () => {
    const files = [NOTICES_FILE, ...Object.keys(UPSTREAM_DIGESTS).map((file) => path.join(UPSTREAM_DIR, `${file}.pinned`))].map((file) => path.relative(ROOT, file));
    const attributes = execFileSync('git', ['check-attr', 'text', '--', ...files], { cwd: ROOT, encoding: 'utf8' }).trim().split('\n');
    expect(attributes).toHaveLength(files.length);
    for (const attribute of attributes) expect(attribute.endsWith(': text: unset'), attribute).toBe(true);
  });
});
