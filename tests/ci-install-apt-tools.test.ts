import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { skipUnless } from './helpers/strict-skip';

/**
 * .github/actions/ci-setup/install-apt-tools.sh decides between installing the cached .deb files and downloading
 * them. It is run here with `sudo` replaced by a recorder (the package manager itself is not available to a test),
 * so what is asserted is which commands the script issues and in which order, for each state of the cache.
 */

const ROOT = path.resolve(__dirname, '..');
const ACTION_DIR = path.join(ROOT, '.github', 'actions', 'ci-setup');
const SCRIPT = path.join(ACTION_DIR, 'install-apt-tools.sh');
const bash = spawnSync('bash', ['--version'], { encoding: 'utf-8' });
const available = bash.status === 0;
const temps: string[] = [];

afterAll(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

/**
 * A `sudo` that records the command line and runs only what is safe in a test: file commands run for real,
 * `apt-get install` drops one .deb into the archive directory it was given, `dpkg -i` can be made to fail.
 */
const SUDO_STUB = `#!/bin/bash
echo "$*" >> "$STUB_LOG"
case "$1" in
  dpkg) if [ -n "\${STUB_DPKG_FAILS:-}" ]; then echo "dpkg: error" >&2; exit 1; fi; exit 0 ;;
  chown) exit 0 ;;
  apt-get)
    if [ "$2" = install ]; then
      for arg in "$@"; do
        case "$arg" in Dir::Cache::archives=*) dir="\${arg#Dir::Cache::archives=}"; mkdir -p "$dir/partial"; touch "$dir/lock" "$dir/fetched.deb" ;; esac
      done
    fi
    exit 0 ;;
  *) exec "$@" ;;
esac
`;

interface Outcome {
  status: number | null;
  stdout: string;
  stderr: string;
  commands: string[];
  debs: string;
}

function runScript(options: { hit: boolean; cached?: string[]; list?: string; dpkgFails?: boolean }): Outcome {
  const work = mkdtempSync(path.join(tmpdir(), 'ci-apt-'));
  temps.push(work);
  const bin = path.join(work, 'bin');
  mkdirSync(bin);
  writeFileSync(path.join(bin, 'sudo'), SUDO_STUB);
  chmodSync(path.join(bin, 'sudo'), 0o755);
  const debs = path.join(work, 'apt-debs');
  if (options.cached) {
    mkdirSync(debs);
    for (const name of options.cached) writeFileSync(path.join(debs, name), 'deb');
  }
  const list = path.join(work, 'apt-packages.txt');
  writeFileSync(list, options.list ?? '# comment\nffmpeg\n\n  # indented comment\n7zip\nlibreoffice-calc\n');
  const log = path.join(work, 'sudo.log');
  writeFileSync(log, '');
  const result = spawnSync('bash', [SCRIPT, debs, list, String(options.hit)], {
    encoding: 'utf-8',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, STUB_LOG: log, STUB_DPKG_FAILS: options.dpkgFails ? '1' : '' },
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    commands: readFileSync(log, 'utf-8').split('\n').filter(Boolean),
    debs,
  };
}

describe('install-apt-tools.sh', () => {
  it.skipIf(skipUnless('bash', available))('installs the cached files and never touches the network on a cache hit', () => {
    const outcome = runScript({ hit: true, cached: ['a_1.deb', 'b_2.deb'] });
    expect(outcome.status).toBe(0);
    expect(outcome.commands).toEqual([`dpkg -i ${outcome.debs}/a_1.deb ${outcome.debs}/b_2.deb`]);
  });

  it.skipIf(skipUnless('bash', available))('downloads on a miss: update, then one install of every listed package into the cache directory', () => {
    const outcome = runScript({ hit: false });
    expect(outcome.status).toBe(0);
    expect(outcome.commands).toEqual([
      `rm -rf ${outcome.debs}`,
      `mkdir -p ${outcome.debs}`,
      'apt-get update',
      `apt-get install -y --no-install-recommends -o Dir::Cache::archives=${outcome.debs} ffmpeg 7zip libreoffice-calc`,
      `rm -rf ${outcome.debs}/partial ${outcome.debs}/lock`,
      expect.stringMatching(/^chown -R \d+:\d+ /),
    ]);
    expect(readdirSync(outcome.debs)).toEqual(['fetched.deb']);
  });

  it.skipIf(skipUnless('bash', available))('discards stale files left in the directory when it has to download', () => {
    const outcome = runScript({ hit: false, cached: ['stale_0.deb'] });
    expect(outcome.status).toBe(0);
    expect(readdirSync(outcome.debs)).toEqual(['fetched.deb']);
  });

  it.skipIf(skipUnless('bash', available))('downloads when the cache was reported as a hit but holds no package files', () => {
    const outcome = runScript({ hit: true, cached: [] });
    expect(outcome.status).toBe(0);
    expect(outcome.commands).toContain('apt-get update');
    expect(outcome.commands.some((command) => command.startsWith('dpkg'))).toBe(false);
  });

  it.skipIf(skipUnless('bash', available))('falls back to the download, with a warning, when the cached files cannot be installed', () => {
    const outcome = runScript({ hit: true, cached: ['a_1.deb'], dpkgFails: true });
    expect(outcome.status).toBe(0);
    expect(outcome.stdout).toContain('::warning::the cached packages could not be installed');
    expect(outcome.commands[0]).toMatch(/^dpkg -i /);
    expect(outcome.commands).toContain('apt-get update');
    expect(readdirSync(outcome.debs)).toEqual(['fetched.deb']);
  });

  it.skipIf(skipUnless('bash', available))('fails when the package list has no packages', () => {
    const outcome = runScript({ hit: false, list: '# nothing\n\n' });
    expect(outcome.status).toBe(1);
    expect(outcome.stderr).toContain('no packages in');
    expect(outcome.commands).toEqual([]);
  });

  it.skipIf(skipUnless('bash', available))('requires its three arguments', () => {
    const result = spawnSync('bash', [SCRIPT], { encoding: 'utf-8' });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('deb directory');
  });
});

describe('the committed package list and scripts', () => {
  const names = readFileSync(path.join(ACTION_DIR, 'apt-packages.txt'), 'utf-8')
    .split('\n')
    .filter((line) => line.trim() !== '' && !line.trim().startsWith('#'));

  it('holds unique Debian package names, one per line', () => {
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) expect(name, name).toMatch(/^[a-z0-9][a-z0-9+.-]+$/);
  });

  it('still installs every tool family the oracle suites call', () => {
    for (const required of ['ffmpeg', '7zip', 'poppler-utils', 'zstd', 'libreoffice-writer', 'imagemagick', 'tesseract-ocr', 'qpdf', 'unrar', 'flac', 'libraw-bin', 'python3-fitz']) {
      expect(names, required).toContain(required);
    }
  });

  it.skipIf(skipUnless('bash', available))('parses with bash -n', () => {
    for (const script of ['install-apt-tools.sh', 'install-tools.sh']) {
      const result = spawnSync('bash', ['-n', path.join(ACTION_DIR, script)], { encoding: 'utf-8' });
      expect(result.stderr, script).toBe('');
      expect(result.status, script).toBe(0);
    }
  });

  it('starts every part of the setup in the background and fails the step when any part failed', () => {
    const script = readFileSync(path.join(ACTION_DIR, 'install-tools.sh'), 'utf-8');
    expect(script).toContain('tasks=(apt pip verapdf epubcheck raw s3)');
    expect(script).toContain('"task_$task" > "$logs/$task.log" 2>&1 &');
    expect(script).toContain('failed+=("$task")');
    expect(script).toMatch(/if \[ "\$\{#failed\[@\]\}" -gt 0 \]; then[\s\S]*exit 1/);
    expect(existsSync(path.join(ROOT, 'scripts', 'install-verapdf.sh'))).toBe(true);
  });

  it('installs the EPUB validator from a pinned archive over HTTPS only and checks its digest first', () => {
    const script = readFileSync(path.join(ACTION_DIR, 'install-tools.sh'), 'utf-8');
    expect(script).toMatch(/^EPUBCHECK_VERSION=5\.2\.1$/m);
    expect(script).toMatch(/^EPUBCHECK_SHA256=[0-9a-f]{64}$/m);
    expect(script).toContain('curl -fsSL --proto =https --proto-redir =https');
    const check = script.indexOf('sha256sum -c -');
    expect(check).toBeGreaterThan(-1);
    expect(check).toBeLessThan(script.indexOf('unzip -q "$archive"'));
  });
});
