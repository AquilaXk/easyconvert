import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pinnedWoff2Program } from './helpers/woff2-programs';
import { parseDockerfile } from './helpers/dockerfile';
import { skipUnless } from './helpers/strict-skip';

/**
 * The worker image carries the WOFF2 programs of google/woff2: built in a stage of their own from the sources the install script pins
 * by commit and SHA-256, copied with their licence texts and the note that names the archives into the runner, where the build turns
 * a font into a WOFF2 file and back. The expectations come from the licence terms (MIT: the notice ships with the programs) and from
 * the pins of the install script.
 */

const ROOT = path.resolve(__dirname, '..');
const DOCKERFILE = fs.readFileSync(path.join(ROOT, 'Dockerfile.worker'), 'utf-8');
const INSTALL = fs.readFileSync(path.join(ROOT, 'scripts', 'install-woff2.sh'), 'utf-8');
const stages = parseDockerfile(DOCKERFILE);
const stage = stages.find((candidate) => candidate.name === 'woff2');
const runner = stages[stages.length - 1];
const SHA256 = /^[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;

const pin = (name: string): string => {
  const match = new RegExp(`^${name}="([^"]+)"$`, 'm').exec(INSTALL);
  expect(match, name).not.toBeNull();
  return match?.[1] ?? '';
};

describe('the woff2 stage of the worker image', () => {
  it('exists, builds on the same base as the runner and runs the pinned install script into /opt/woff2', () => {
    expect(stage).toBeDefined();
    expect(stage?.baseImage).toBe(runner.baseImage);
    const run = stage?.instructions.filter((instruction) => instruction.keyword === 'RUN').map((instruction) => instruction.argument) ?? [];
    expect(run).toContain('/tmp/install-woff2.sh /opt/woff2');
    expect(run.join('\n')).toContain('build-essential');
    const copies = stage?.instructions.filter((instruction) => instruction.keyword === 'COPY').map((instruction) => instruction.argument) ?? [];
    expect(copies).toEqual(['scripts/install-woff2.sh /tmp/install-woff2.sh', 'scripts/woff2/ /tmp/woff2/']);
  });

  it('copies the encoder and the licence texts into the runner, builds a WOFF2 file, and keeps the note of the sources', () => {
    const instructions = (keyword: string) => runner.instructions.filter((instruction) => instruction.keyword === keyword).map((instruction) => instruction.argument);
    expect(instructions('COPY').filter((argument) => argument.includes('woff2'))).toEqual([
      '--from=woff2 /opt/woff2/bin/woff2_compress /usr/local/bin/woff2_compress',
      '--from=woff2 /opt/woff2/share/doc/woff2 /usr/share/doc/woff2',
    ]);
    const runs = instructions('RUN').filter((argument) => argument.includes('woff2'));
    expect(runs).toHaveLength(2);
    expect(runs[0]).toMatch(/printf '%s' '[A-Za-z0-9+/=]+' \| base64 -d > "\$dir\/font\.ttf"/);
    expect(runs[0]).toContain('woff2_compress "$dir/font.ttf"');
    expect(runs[0]).toContain('test "$(head -c 4 "$dir/font.woff2")" = wOF2');
    expect(runs[1]).toBe('cp /usr/share/doc/woff2/SOURCE /licenses/woff2.SOURCE');
  });

  it('is installed before the privileges are dropped, so that the unprivileged account only runs the programs', () => {
    const copy = runner.instructions.find((instruction) => instruction.argument.includes('/usr/local/bin/woff2_compress'));
    const user = runner.instructions.find((instruction) => instruction.keyword === 'USER');
    expect((copy?.index ?? Infinity) < (user?.index ?? -Infinity)).toBe(true);
  });

  const program = pinnedWoff2Program('woff2_compress');
  it.skipIf(skipUnless('the pinned woff2_compress', program !== null))('runs the check of the image with the program it installs, under a POSIX shell', () => {
    const check = runner.instructions.find((instruction) => instruction.keyword === 'RUN' && instruction.argument.startsWith('dir="$(mktemp -d)"') && instruction.argument.includes('woff2_compress'));
    expect(check).toBeDefined();
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'woff2-image-check-'));
    try {
      fs.symlinkSync(program!, path.join(bin, 'woff2_compress'));
      const run = spawnSync('sh', ['-c', check!.argument], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, TMPDIR: bin }, encoding: 'utf8' });
      expect(run.status, run.stderr).toBe(0);
    } finally {
      fs.rmSync(bin, { recursive: true, force: true });
    }
  });
});

describe('the install script of the WOFF2 programs', () => {
  it('pins the woff2 commit and the Brotli commit it takes, each with the SHA-256 of its archive', () => {
    expect(pin('WOFF2_COMMIT')).toMatch(COMMIT);
    expect(pin('WOFF2_SHA256')).toMatch(SHA256);
    expect(pin('BROTLI_COMMIT')).toMatch(COMMIT);
    expect(pin('BROTLI_SHA256')).toMatch(SHA256);
    expect(pin('BROTLI_VERSION')).toMatch(/^\d+\.\d+\.\d+$/);
    expect(INSTALL).toContain('github.com/google/woff2/archive/${WOFF2_COMMIT}.tar.gz');
    expect(INSTALL).toContain('github.com/google/brotli/archive/${BROTLI_COMMIT}.tar.gz');
  });

  it('checks both digests before an archive is unpacked, builds with the make rules of the tree and patches nothing', () => {
    const order = ['sha256sum --check --strict', 'tar -xzf', 'make -j', 'install -m 0755'].map((step) => INSTALL.indexOf(step));
    expect(order.every((at) => at > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(INSTALL.match(/sha256sum --check --strict/g)).toHaveLength(2);
    expect(INSTALL.lastIndexOf('sha256sum --check --strict')).toBeLessThan(INSTALL.indexOf('tar -xzf'));
    expect(INSTALL).not.toMatch(/\bpatch\b|\bgit apply\b|\bsed -i\b/);
  });

  it('puts the files of the repository over the files of the same names in the tree, after the digests are checked and before the build', () => {
    const order = ['sha256sum --check --strict', 'tar -xzf', 'install -m 0644 "$copy"', 'make -j'].map((step) => INSTALL.indexOf(step));
    expect(order.every((at) => at > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(fs.readdirSync(path.join(ROOT, 'scripts', 'woff2', 'src')).sort()).toEqual(['woff2_compress.cc', 'woff2_decompress.cc', 'woff2_enc.cc']);
  });

  it('names in the SOURCE note of the tools the pinned commit, the digest of the licence text and the digest of each upstream file', () => {
    const source = fs.readFileSync(path.join(ROOT, 'scripts', 'woff2', 'SOURCE'), 'utf-8');
    expect(source).toContain(`Commit:     ${pin('WOFF2_COMMIT')}`);
    const license = createHash('sha256').update(fs.readFileSync(path.join(ROOT, 'scripts', 'woff2', 'LICENSE'))).digest('hex');
    expect(source).toContain(`SHA-256 ${license}`);
    expect(fs.readFileSync(path.join(ROOT, 'scripts', 'woff2', 'LICENSE'), 'utf-8')).toMatch(/^Copyright \(c\) 2013-2017 by the WOFF2 Authors\./);
    for (const tool of ['woff2_compress', 'woff2_decompress', 'woff2_enc']) expect(source).toMatch(new RegExp(`src/${tool}\\.cc +-> src/${tool}\\.cc +SHA-256 of the upstream file [0-9a-f]{64}`));
  });

  it('installs nothing on a system other than Linux, before it downloads anything', () => {
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'woff2-install-'));
    try {
      const fetched = path.join(bin, 'fetched');
      fs.writeFileSync(path.join(bin, 'uname'), '#!/bin/sh\ncase "$1" in -s) echo Darwin;; *) echo arm64;; esac\n', { mode: 0o755 });
      fs.writeFileSync(path.join(bin, 'curl'), `#!/bin/sh\ntouch '${fetched}'\nexit 1\n`, { mode: 0o755 });
      const run = spawnSync('bash', [path.join(ROOT, 'scripts', 'install-woff2.sh'), path.join(bin, 'install')], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, encoding: 'utf8' });
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
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'woff2-fetch-'));
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

  it('ships both licence texts in the copyright file and names the archives and their digests in a note', () => {
    expect(INSTALL).toContain('cat "$src/LICENSE"');
    expect(INSTALL).toContain('cat "$src/brotli/LICENSE"');
    expect(INSTALL).toMatch(/> "\$INSTALL_DIR\/share\/doc\/woff2\/copyright"/);
    expect(INSTALL).toMatch(/"\$WOFF2_URL" "\$WOFF2_SHA256" "\$BROTLI_URL" "\$BROTLI_SHA256" > "\$INSTALL_DIR\/share\/doc\/woff2\/SOURCE"/);
  });
});
