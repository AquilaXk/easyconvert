import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
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
    expect(run).toContain('/tmp/install-vtracer-pixels.sh /opt/vtracer-pixels');
    const copies = stage?.instructions.filter((instruction) => instruction.keyword === 'COPY').map((instruction) => instruction.argument) ?? [];
    expect(copies).toContain('scripts/install-vtracer.sh /tmp/install-vtracer.sh');
  });

  it('puts only the program, its licence texts and its source note into the runner, and traces a PNG with it during the build', () => {
    const instructions = (keyword: string) => runner.instructions.filter((instruction) => instruction.keyword === keyword).map((instruction) => instruction.argument);
    expect(instructions('COPY').filter((argument) => argument.includes('vtracer'))).toEqual([
      '--from=vtracer /opt/vtracer/bin/vtracer /usr/local/bin/vtracer',
      '--from=vtracer /opt/vtracer/share/doc/vtracer /usr/share/doc/vtracer',
      '--from=vtracer /opt/vtracer-pixels/bin/vtracer-pixels /usr/local/bin/vtracer-pixels',
      '--from=vtracer /opt/vtracer-pixels/share/doc/vtracer-pixels /usr/share/doc/vtracer-pixels',
    ]);
    const runs = instructions('RUN').filter((argument) => argument.includes('vtracer'));
    expect(runs).toHaveLength(7);
    expect(runs[0]).toMatch(/printf '\\211PNG[^']*IEND[^']*' > "\$dir\/in\.png"/);
    expect(runs[0]).toContain('vtracer --input "$dir/in.png" --output "$dir/out.svg"');
    expect(runs[0]).toContain(`grep -q '<path d="M' "$dir/out.svg"`);
    expect(runs[1]).toContain('vtracer-pixels --input "$dir/in.rgba" --output "$dir/out.svg"');
    expect(runs[1]).toContain(`grep -q '<path d="M' "$dir/out.svg"`);
    expect(runs.slice(2)).toEqual([
      'cp /usr/share/doc/vtracer/SOURCE /licenses/vtracer.SOURCE',
      'cp /usr/share/doc/vtracer/THIRD-PARTY-NOTICES /licenses/vtracer.THIRD-PARTY-NOTICES',
      'cp /usr/share/doc/vtracer-pixels/SOURCE /licenses/vtracer-pixels.SOURCE',
      'cp /usr/share/doc/vtracer-pixels/THIRD-PARTY-NOTICES /licenses/vtracer-pixels.THIRD-PARTY-NOTICES',
      'cp /usr/share/doc/vtracer-pixels/NOTICE-mimalloc /licenses/vtracer-pixels.NOTICE-mimalloc',
    ]);
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

  it('checks each digest before the archive is unpacked or a licence text copied, and installs the program unmodified', () => {
    const order = ['sha256sum --check --strict', 'tar -xzf', 'install -m 0755'].map((step) => INSTALL.indexOf(step));
    expect(order.every((at) => at > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(INSTALL.match(/sha256sum --check --strict/g)).toHaveLength(3);
    expect(INSTALL).not.toMatch(/\bpatch\b|\bgit apply\b|\bsed -i\b|cargo/);
  });

  it('installs nothing on a system other than Linux, before it downloads anything', () => {
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'vtracer-install-'));
    try {
      const fetched = path.join(bin, 'fetched');
      fs.writeFileSync(path.join(bin, 'uname'), '#!/bin/sh\ncase "$1" in -s) echo Darwin;; *) echo arm64;; esac\n', { mode: 0o755 });
      fs.writeFileSync(path.join(bin, 'curl'), `#!/bin/sh\ntouch '${fetched}'\nexit 1\n`, { mode: 0o755 });
      const run = spawnSync('bash', [path.join(ROOT, 'scripts', 'install-vtracer.sh'), path.join(bin, 'install')], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, encoding: 'utf8' });
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
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vtracer-fetch-'));
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

  it('names the archive and its digest in a note that ships with the licence text', () => {
    expect(INSTALL).toMatch(/install -m 0644 "\$work\/LICENSE" "\$INSTALL_DIR\/share\/doc\/vtracer\/copyright"/);
    expect(INSTALL).toMatch(/"\$VTRACER_VERSION" "\$VTRACER_URL" "\$digest" "\$VTRACER_COMMIT" > "\$INSTALL_DIR\/share\/doc\/vtracer\/SOURCE"/);
  });
});
