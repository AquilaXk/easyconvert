import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { QUANTIZR_MAX_PIXELS } from '../src/lib/conversions/png-palette-quantizer';
import { parseDockerfile } from './helpers/dockerfile';

/**
 * The worker image carries the palette quantiser of the compress page: quantizr-pixels, a program of the project around the quantizr crate,
 * built from scripts/quantizr-pixels in a stage of its own and copied with its licence text and source note into the runner, where the
 * build runs it once. The expectations come from the licence terms (MIT: the notice ships with the program), from the pins of the install
 * script, which repeats the toolchain pins of install-vtracer-pixels.sh, and from the lockfile.
 */

const ROOT = path.resolve(__dirname, '..');
const read = (...parts: string[]): string => fs.readFileSync(path.join(ROOT, ...parts), 'utf-8');
const INSTALL = read('scripts', 'install-quantizr-pixels.sh');
const VTRACER_INSTALL = read('scripts', 'install-vtracer-pixels.sh');
const stages = parseDockerfile(read('Dockerfile.worker'));
const stage = stages.find((candidate) => candidate.name === 'quantizr');
const runner = stages[stages.length - 1];
const instructions = (from: typeof runner | undefined, keyword: string): string[] =>
  from?.instructions.filter((instruction) => instruction.keyword === keyword).map((instruction) => instruction.argument) ?? [];

const pins = (script: string): string[] => [
  ...script.matchAll(/^(?:RUST_VERSION|(?:RUSTC|CARGO|RUST_STD|RUST_STD_MUSL)_SHA256_(?:AARCH64|X86_64))="([^"]+)"$/gm),
].map((match) => match[0]);

describe('the quantizr stage of the worker image', () => {
  it('builds on the same base as the runner and runs the install script into /opt/quantizr-pixels', () => {
    expect(stage).toBeDefined();
    expect(stage?.baseImage).toBe(runner.baseImage);
    expect(instructions(stage, 'RUN')).toContain('/tmp/install-quantizr-pixels.sh /opt/quantizr-pixels');
    expect(instructions(stage, 'COPY')).toEqual([
      'scripts/install-quantizr-pixels.sh /tmp/install-quantizr-pixels.sh',
      'scripts/vtracer-notices/THIRD-PARTY-NOTICES /tmp/vtracer-notices/THIRD-PARTY-NOTICES',
      'scripts/quantizr-pixels/ /tmp/quantizr-pixels/',
    ]);
  });

  it('puts the program, its licence texts and its source note into the runner and runs it once during the build', () => {
    expect(instructions(runner, 'COPY').filter((argument) => argument.includes('quantizr'))).toEqual([
      '--from=quantizr /opt/quantizr-pixels/bin/quantizr-pixels /usr/local/bin/quantizr-pixels',
      '--from=quantizr /opt/quantizr-pixels/share/doc/quantizr-pixels /usr/share/doc/quantizr-pixels',
    ]);
    const runs = instructions(runner, 'RUN').filter((argument) => argument.includes('quantizr'));
    expect(runs).toHaveLength(3);
    expect(runs[0]).toContain('quantizr-pixels < "$dir/in.rgba" > "$dir/out.bin"');
    expect(runs[0]).toContain('-eq 76'); // the count, two entries of four bytes, and 8 x 8 indices
    expect(runs.slice(1)).toEqual([
      'cp /usr/share/doc/quantizr-pixels/SOURCE /licenses/quantizr-pixels.SOURCE',
      'cp /usr/share/doc/quantizr-pixels/THIRD-PARTY-NOTICES /licenses/quantizr-pixels.THIRD-PARTY-NOTICES',
    ]);
  });
});

describe('the install script', () => {
  it('pins the same toolchain as the vtracer-pixels install script, digest for digest', () => {
    expect(pins(INSTALL)).toHaveLength(9);
    expect(pins(INSTALL)).toEqual(pins(VTRACER_INSTALL));
  });

  it('builds with the lockfile for the musl target, after it has checked every archive against its digest', () => {
    expect(INSTALL).toContain('cargo build --release --locked');
    expect(INSTALL).toContain('--target "$target"');
    expect(INSTALL).toMatch(/target="(?:aarch64|x86_64)-unknown-linux-musl"/);
    expect(INSTALL.indexOf('sha256sum --check')).toBeLessThan(INSTALL.indexOf('install.sh"'));
  });
});

describe('the program sources', () => {
  const lock = read('scripts', 'quantizr-pixels', 'Cargo.lock');
  const source = read('scripts', 'quantizr-pixels', 'SOURCE');
  const licence = fs.readFileSync(path.join(ROOT, 'scripts', 'quantizr-pixels', 'LICENSE'));

  it('depends on quantizr at one version and no other crate, by the checksum of the lockfile', () => {
    expect(read('scripts', 'quantizr-pixels', 'Cargo.toml')).toMatch(/^\[dependencies\]\nquantizr = "=1\.4\.3"\n*$/m);
    const packages = [...lock.matchAll(/^name = "([^"]+)"$/gm)].map((match) => match[1]);
    expect(packages).toEqual(['quantizr', 'quantizr-pixels']);
    const checksum = /name = "quantizr"\nversion = "1\.4\.3"\nsource = "registry\+https:\/\/github\.com\/rust-lang\/crates\.io-index"\nchecksum = "([0-9a-f]{64})"/.exec(lock)?.[1];
    expect(checksum).toBeDefined();
    expect(source).toContain(checksum);
  });

  it('ships the MIT text of the tagged commit, with its digest and its provenance recorded', () => {
    expect(licence.toString('utf-8')).toContain('MIT License');
    expect(licence.toString('utf-8')).toContain('Copyright (c) 2017 Sergey Alexandrovich');
    expect(source).toContain(createHash('sha256').update(licence).digest('hex'));
    expect(source).toContain('cfb26aaf3039ac1179d42a66cc7988c8c6feeba9');
    expect(source).toContain('v1.4.3');
  });

  it('refuses the pictures the worker does not send: the bound of the program is the bound of the wrapper', () => {
    const main = read('scripts', 'quantizr-pixels', 'src', 'main.rs');
    const bound = /^const MAX_PIXELS: usize = ([0-9_]+);$/m.exec(main)?.[1];
    expect(Number(bound?.replaceAll('_', ''))).toBe(QUANTIZR_MAX_PIXELS);
  });
});
