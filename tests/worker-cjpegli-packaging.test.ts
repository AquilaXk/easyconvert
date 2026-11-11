import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseDockerfile } from './helpers/dockerfile';
import { CJPEGLI_CANDIDATES } from '../src/lib/conversions/jpegli-cli';

/**
 * The worker image carries a JPEG encoder built from pinned sources: cjpegli (jpegli) with the SIMD library highway and the colour
 * management skcms it is built with, each archive pinned by SHA-256, built in a stage of its own and copied with its licence texts and the note that
 * names the sources into the runner, where the build encodes a picture once. The image library's own encoder is the fallback. The expectations
 * come from the licence terms (BSD: the notice ships with the program) and from the pins of the install script.
 */

const ROOT = path.resolve(__dirname, '..');
const DOCKERFILE = fs.readFileSync(path.join(ROOT, 'Dockerfile.worker'), 'utf-8');
const INSTALL = fs.readFileSync(path.join(ROOT, 'scripts', 'install-cjpegli.sh'), 'utf-8');
const SOURCE = fs.readFileSync(path.join(ROOT, 'scripts', 'cjpegli', 'SOURCE'), 'utf-8');
const stages = parseDockerfile(DOCKERFILE);
const stage = stages.find((candidate) => candidate.name === 'cjpegli');
const runner = stages[stages.length - 1];
const SHA256 = /^[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;

const pin = (name: string): string => {
  const match = new RegExp(`^${name}="([^"]+)"$`, 'm').exec(INSTALL);
  expect(match, name).not.toBeNull();
  return match?.[1] ?? '';
};

const PINNED_ARCHIVES = ['CMAKE_SHA256_AARCH64', 'CMAKE_SHA256_X86_64', 'JPEGLI_SHA256', 'HWY_SHA256', 'LJT_SHA256', 'SKCMS_SHA256'];
const PINNED_COMMITS = ['JPEGLI_COMMIT', 'HWY_COMMIT', 'LJT_COMMIT', 'SKCMS_COMMIT'];

describe('the cjpegli stage of the worker image', () => {
  it('exists, builds on the same base as the runner and runs the install script into /opt/cjpegli', () => {
    expect(stage).toBeDefined();
    expect(stage?.baseImage).toBe(runner.baseImage);
    const run = stage?.instructions.filter((instruction) => instruction.keyword === 'RUN').map((instruction) => instruction.argument) ?? [];
    expect(run).toContain('/tmp/install-cjpegli.sh /opt/cjpegli');
    const copies = stage?.instructions.filter((instruction) => instruction.keyword === 'COPY').map((instruction) => instruction.argument) ?? [];
    expect(copies).toEqual(['scripts/install-cjpegli.sh /tmp/install-cjpegli.sh', 'scripts/cjpegli/SOURCE /tmp/cjpegli/SOURCE']);
  });

  it('puts the program, its licence texts and its source note into the runner, and encodes a picture with it during the build', () => {
    const instructions = (keyword: string) => runner.instructions.filter((instruction) => instruction.keyword === keyword).map((instruction) => instruction.argument);
    expect(instructions('COPY').filter((argument) => argument.includes('cjpegli'))).toEqual([
      '--from=cjpegli /opt/cjpegli/bin/cjpegli /usr/local/bin/cjpegli-pinned',
      '--from=cjpegli /opt/cjpegli/share/doc/cjpegli /usr/share/doc/cjpegli',
    ]);
    const runs = instructions('RUN').filter((argument) => argument.includes('cjpegli'));
    expect(runs).toHaveLength(2);
    expect(runs[0]).toContain(`printf 'P6\\n8 8\\n255\\n'`);
    expect(runs[0]).toContain('cjpegli-pinned - "$dir/out.jpg" -q 70 --quiet');
    expect(runs[0]).toContain(`grep -q 'ff d8 ff'`);
    // Every licence text and the note the install script writes next to the program is copied into /licenses, jpegli's own as <dir>.copyright.
    for (const file of ['SOURCE', 'PATENTS', 'LICENSE.highway', 'LICENSE.skcms', 'LICENSE.libjpeg-turbo', 'README.ijg']) {
      expect(runs[1], file).toContain(file);
      expect(INSTALL, file).toContain(`"$doc/${file}"`);
    }
    expect(INSTALL).toContain('"$doc/copyright"');
  });

  it('is installed before the privileges are dropped, so that the unprivileged account only runs it', () => {
    const copy = runner.instructions.find((instruction) => instruction.argument.includes('/usr/local/bin/cjpegli-pinned'));
    const user = runner.instructions.find((instruction) => instruction.keyword === 'USER');
    expect((copy?.index ?? Infinity) < (user?.index ?? -Infinity)).toBe(true);
  });

  it('is the only program the worker looks for, found where the runner puts it', () => {
    expect(CJPEGLI_CANDIDATES).toEqual(['/usr/local/bin/cjpegli-pinned']);
  });
});

describe('the install script of the encoder', () => {
  it('pins every archive by SHA-256 and every source tree by the commit its archive records, and checks each digest before anything in the archive is unpacked or run', () => {
    for (const name of PINNED_ARCHIVES) expect(pin(name), name).toMatch(SHA256);
    for (const name of PINNED_COMMITS) expect(pin(name), name).toMatch(COMMIT);
    const unpack = /^unpack\(\) \{\n[\s\S]*?\n\}$/m.exec(INSTALL)?.[0] ?? '';
    expect(unpack.indexOf('sha256sum --check --strict')).toBeGreaterThan(0);
    expect(unpack.indexOf('sha256sum --check --strict')).toBeLessThan(unpack.indexOf('tar -xf'));
    expect(unpack).toContain('comment=$commit');
    // Every download goes through unpack: no other command fetches or pipes anything.
    expect(INSTALL.match(/^\s*unpack [a-z/_-]+ "https:\/\//gm)).toHaveLength(5);
    expect(INSTALL.match(/\bcurl --/g)).toHaveLength(1);
    expect(INSTALL).not.toMatch(/\bgit (clone|fetch)\b|\bwget\b|\| *(ba)?sh\b/);
    expect(INSTALL).toContain('TARGET=cjpegli build jpegli');
  });

  it('builds only what encodes: the input codecs other than the PNM family and the libjpeg replacement library are off', () => {
    for (const flag of ['-DCMAKE_DISABLE_FIND_PACKAGE_PNG=ON', '-DCMAKE_DISABLE_FIND_PACKAGE_GIF=ON', '-DCMAKE_DISABLE_FIND_PACKAGE_JPEG=ON', '-DJPEGLI_ENABLE_SJPEG=OFF', '-DJPEGLI_ENABLE_OPENEXR=OFF', '-DJPEGLI_ENABLE_JPEGLI_LIBJPEG=OFF']) {
      expect(INSTALL, flag).toContain(flag);
    }
  });

  it('records the pinned sources in the note that ships with the program', () => {
    for (const name of [...PINNED_ARCHIVES, ...PINNED_COMMITS]) expect(SOURCE, name).toContain(pin(name));
    expect(SOURCE).toContain(pin('CMAKE_VERSION'));
  });

  it('installs nothing on a system other than Linux, before it downloads anything', () => {
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'cjpegli-install-'));
    try {
      const fetched = path.join(bin, 'fetched');
      fs.writeFileSync(path.join(bin, 'uname'), '#!/bin/sh\ncase "$1" in -s) echo Darwin;; *) echo arm64;; esac\n', { mode: 0o755 });
      fs.writeFileSync(path.join(bin, 'curl'), `#!/bin/sh\ntouch '${fetched}'\nexit 1\n`, { mode: 0o755 });
      const run = spawnSync('bash', [path.join(ROOT, 'scripts', 'install-cjpegli.sh'), path.join(bin, 'install')], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, encoding: 'utf8' });
      expect(run.status).toBe(1);
      expect(run.stderr).toContain('for Linux, not Darwin');
      expect(fs.existsSync(fetched)).toBe(false);
      expect(fs.existsSync(path.join(bin, 'install'))).toBe(false);
    } finally {
      fs.rmSync(bin, { recursive: true, force: true });
    }
  });

  it('downloads over HTTPS only, redirects included, and asks curl to refuse a download announced past its size bound', () => {
    expect(INSTALL).toMatch(/curl --proto '=https' --proto-redir '=https' --tlsv1\.2 --max-filesize "\$MAX_DOWNLOAD_BYTES"/);
  });

  describe('the bound on a download', () => {
    const fetchFunction = /^fetch\(\) \{\n[\s\S]*?\n\}$/m.exec(INSTALL)?.[0] ?? '';
    const stubbedCurl = `curl() {
      local target=""
      while [ $# -gt 0 ]; do case "$1" in -o|--output) target="$2"; shift;; esac; shift; done
      if [ "$target" = "-" ]; then head -c "$STUB_BYTES" /dev/zero; else head -c "$STUB_BYTES" /dev/zero > "$target"; fi
    }`;

    function download(bytesServed: number): { status: number | null; stderr: string; saved: number } {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cjpegli-fetch-'));
      try {
        const target = path.join(dir, 'archive');
        const script = ['set -euo pipefail', 'MAX_DOWNLOAD_BYTES=1000', stubbedCurl, fetchFunction, `fetch '${target}' https://example.invalid/archive`].join('\n');
        const run = spawnSync('bash', ['-c', script], { env: { ...process.env, STUB_BYTES: String(bytesServed) }, encoding: 'utf8' });
        return { status: run.status, stderr: run.stderr, saved: fs.existsSync(target) ? fs.statSync(target).size : 0 };
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }

    it('keeps a download inside the bound', () => {
      expect(fetchFunction).not.toBe('');
      expect(download(1000)).toMatchObject({ status: 0, saved: 1000 });
    });

    it('stops a download that passes the bound while it is read, whether or not curl was told its size', () => {
      const run = download(5000);
      expect(run.status).toBe(1);
      expect(run.stderr).toContain('is larger than 1000 bytes');
      expect(run.saved).toBeLessThanOrEqual(1001);
    });
  });
});
