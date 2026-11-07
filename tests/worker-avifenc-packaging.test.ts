import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseDockerfile } from './helpers/dockerfile';
import { AVIFENC_CANDIDATES } from '../src/lib/conversions/avif-cli';

/**
 * The worker image carries an AVIF encoder built from pinned sources: avifenc (libavif) with the AV1 encoder libaom and the libraries it
 * reads pictures with, each archive pinned by SHA-256, built in a stage of its own and copied with its licence texts and the note that
 * names the sources into the runner, where the build encodes a picture once. The distribution's package stays installed as the fallback.
 * The expectations come from the licence terms (BSD: the notice ships with the program) and from the pins of the install script.
 */

const ROOT = path.resolve(__dirname, '..');
const DOCKERFILE = fs.readFileSync(path.join(ROOT, 'Dockerfile.worker'), 'utf-8');
const INSTALL = fs.readFileSync(path.join(ROOT, 'scripts', 'install-avifenc.sh'), 'utf-8');
const SOURCE = fs.readFileSync(path.join(ROOT, 'scripts', 'avifenc', 'SOURCE'), 'utf-8');
const stages = parseDockerfile(DOCKERFILE);
const stage = stages.find((candidate) => candidate.name === 'avifenc');
const runner = stages[stages.length - 1];
const SHA256 = /^[0-9a-f]{64}$/;

const pin = (name: string): string => {
  const match = new RegExp(`^${name}="([^"]+)"$`, 'm').exec(INSTALL);
  expect(match, name).not.toBeNull();
  return match?.[1] ?? '';
};

const PINNED_ARCHIVES = ['CMAKE_SHA256_AARCH64', 'CMAKE_SHA256_X86_64', 'NASM_SHA256', 'AVIF_SHA256', 'AOM_SHA256', 'YUV_SHA256', 'PNG_SHA256', 'ZLIBNG_SHA256', 'JPEG_SHA256'];

describe('the avifenc stage of the worker image', () => {
  it('exists, builds on the same base as the runner and runs the install script into /opt/avifenc', () => {
    expect(stage).toBeDefined();
    expect(stage?.baseImage).toBe(runner.baseImage);
    const run = stage?.instructions.filter((instruction) => instruction.keyword === 'RUN').map((instruction) => instruction.argument) ?? [];
    expect(run).toContain('/tmp/install-avifenc.sh /opt/avifenc');
    const copies = stage?.instructions.filter((instruction) => instruction.keyword === 'COPY').map((instruction) => instruction.argument) ?? [];
    expect(copies).toEqual(['scripts/install-avifenc.sh /tmp/install-avifenc.sh', 'scripts/avifenc/SOURCE /tmp/avifenc/SOURCE']);
  });

  it('puts the program, its licence texts and its source note into the runner, and encodes a PNG with it during the build', () => {
    const instructions = (keyword: string) => runner.instructions.filter((instruction) => instruction.keyword === keyword).map((instruction) => instruction.argument);
    expect(instructions('COPY').filter((argument) => argument.includes('avifenc'))).toEqual([
      '--from=avifenc /opt/avifenc/bin/avifenc /usr/local/bin/avifenc-pinned',
      '--from=avifenc /opt/avifenc/share/doc/avifenc /usr/share/doc/avifenc',
    ]);
    const runs = instructions('RUN').filter((argument) => argument.includes('avifenc'));
    expect(runs).toHaveLength(2);
    expect(runs[0]).toMatch(/printf '\\211PNG[^']*IEND[^']*' > "\$dir\/in\.png"/);
    expect(runs[0]).toContain('avifenc-pinned -q 70 -s 6 "$dir/in.png" -o "$dir/out.avif"');
    expect(runs[0]).toContain(`grep -q 'ftypavif'`);
    // Every licence text and the note the install script writes next to the program is copied into /licenses, libavif's own as <dir>.copyright.
    for (const file of ['SOURCE', 'LICENSE.libaom', 'PATENTS.libaom', 'LICENSE.libyuv', 'PATENTS.libyuv', 'LICENSE.libpng', 'LICENSE.zlib-ng', 'LICENSE.libjpeg-turbo', 'README.ijg']) {
      expect(runs[1], file).toContain(file);
      expect(INSTALL, file).toContain(`"$doc/${file}"`);
    }
    expect(INSTALL).toContain('"$doc/copyright"');
  });

  it('is installed before the privileges are dropped, so that the unprivileged account only runs it', () => {
    const copy = runner.instructions.find((instruction) => instruction.argument.includes('/usr/local/bin/avifenc-pinned'));
    const user = runner.instructions.find((instruction) => instruction.keyword === 'USER');
    expect((copy?.index ?? Infinity) < (user?.index ?? -Infinity)).toBe(true);
  });

  it('keeps the distribution package, which the worker uses when the pinned program is absent', () => {
    const install = runner.instructions.find((instruction) => /apt-get install/.test(instruction.argument));
    expect(install?.argument).toMatch(/\blibavif-bin\b/);
    expect(AVIFENC_CANDIDATES.indexOf('/usr/local/bin/avifenc-pinned')).toBe(0);
    expect(AVIFENC_CANDIDATES).toContain('/usr/bin/avifenc');
  });
});

describe('the install script of the encoder', () => {
  it('builds the releases the Debian 13 package is built from', () => {
    expect(pin('AVIF_VERSION')).toBe('1.2.1');
    expect(pin('AVIF_COMMIT')).toMatch(/^[0-9a-f]{40}$/);
    expect(pin('AOM_VERSION')).toBe('3.12.1');
    expect(pin('YUV_VERSION')).toBe('1904.20250204');
  });

  it('pins every archive by SHA-256 and checks each digest before anything in the archive is unpacked or run', () => {
    for (const name of PINNED_ARCHIVES) expect(pin(name), name).toMatch(SHA256);
    const unpack = /^unpack\(\) \{\n[\s\S]*?\n\}$/m.exec(INSTALL)?.[0] ?? '';
    expect(unpack.indexOf('sha256sum --check --strict')).toBeGreaterThan(0);
    expect(unpack.indexOf('sha256sum --check --strict')).toBeLessThan(unpack.indexOf('tar -xf'));
    // Every download goes through unpack: no other command fetches or pipes anything.
    expect(INSTALL.match(/^\s*unpack [a-z]+ "https:\/\//gm)).toHaveLength(8);
    expect(INSTALL.match(/\bcurl --/g)).toHaveLength(1);
    expect(INSTALL).not.toMatch(/\bgit (clone|fetch)\b|\bwget\b|\| *(ba)?sh\b/);
  });

  it('records the pinned sources in the note that ships with the program', () => {
    for (const name of ['AVIF_COMMIT', 'AVIF_SHA256', 'AOM_SHA256', 'YUV_SHA256', 'PNG_SHA256', 'ZLIBNG_SHA256', 'JPEG_SHA256']) expect(SOURCE, name).toContain(pin(name));
    for (const version of ['AVIF_VERSION', 'AOM_VERSION', 'PNG_VERSION', 'ZLIBNG_VERSION', 'JPEG_VERSION', 'CMAKE_VERSION']) expect(SOURCE, version).toContain(pin(version));
  });

  it('installs nothing on a system other than Linux, before it downloads anything', () => {
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'avifenc-install-'));
    try {
      const fetched = path.join(bin, 'fetched');
      fs.writeFileSync(path.join(bin, 'uname'), '#!/bin/sh\ncase "$1" in -s) echo Darwin;; *) echo arm64;; esac\n', { mode: 0o755 });
      fs.writeFileSync(path.join(bin, 'curl'), `#!/bin/sh\ntouch '${fetched}'\nexit 1\n`, { mode: 0o755 });
      const run = spawnSync('bash', [path.join(ROOT, 'scripts', 'install-avifenc.sh'), path.join(bin, 'install')], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, encoding: 'utf8' });
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
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'avifenc-fetch-'));
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
