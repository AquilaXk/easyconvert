import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { skipUnless } from './helpers/strict-skip';

/**
 * The libvips build of the worker image (docs/policy-decisions.md, entry 84): the download check the upstream build runs
 * under, the cache key CI builds it by, how a speed comparison gives its base its own library, and the jobs that use the
 * build. The scripts run against files written here; the rules are written out from the entry, not read from the files.
 */

interface Step {
  id?: string;
  name?: string;
  if?: string;
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
}
interface Job {
  uses?: string;
  needs?: string | string[];
  steps: Step[];
}
interface Workflow {
  on: Record<string, unknown>;
  jobs: Record<string, Job>;
}

const ROOT = path.resolve(__dirname, '..');
const BUILD_DIR = path.join(ROOT, 'docker', 'sharp-libvips');
const read = (...parts: string[]): string => readFileSync(path.join(ROOT, ...parts), 'utf-8');
const workflow = (name: string): Workflow => parse(read('.github', 'workflows', name)) as Workflow;
const ci = workflow('ci.yml');
const nightly = workflow('nightly.yml');
const reusable = workflow('sharp-libvips.yml');
const action = parse(read('.github', 'actions', 'sharp-libvips', 'action.yml')) as { runs: { steps: Step[] } };
const dockerfile = read('Dockerfile.worker');

const bash = spawnSync('bash', ['--version'], { encoding: 'utf-8' });
const withBash = it.skipIf(skipUnless('bash', bash.status === 0));
const temps: string[] = [];
afterAll(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});
function tempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}
const sha256 = (data: string): string => createHash('sha256').update(data).digest('hex');

describe('fetch-pinned.sh, the curl of the upstream build', () => {
  const PINNED = 'https://example.org/libwebp-1.6.0.tar.gz';
  const PINNED_BYTES = 'the pinned archive\n';

  /** Runs the wrapper with a stand-in downloader that writes `served` for any URL, as curl --output would. */
  function fetch(args: string[], served: string): { status: number; stdout: string; refusals: string; log: string; downloaderArgs: string[] } {
    const dir = tempDir('fetch-pinned-');
    const downloader = path.join(dir, 'downloader');
    writeFileSync(path.join(dir, 'body'), served);
    writeFileSync(path.join(dir, 'args'), '');
    writeFileSync(downloader, `#!/bin/sh\nprintf '%s\\n' "$@" > "${dir}/args"\nwhile [ "$#" -gt 1 ]; do if [ "$1" = --output ]; then cp "${dir}/body" "$2"; fi; shift; done\n`);
    chmodSync(downloader, 0o755);
    writeFileSync(path.join(dir, 'sources.sha256'), `# a comment\n${sha256(PINNED_BYTES)}  ${PINNED}\n`);
    writeFileSync(path.join(dir, 'refused'), '');
    writeFileSync(path.join(dir, 'served'), '');
    const result = spawnSync('bash', [path.join(BUILD_DIR, 'fetch-pinned.sh'), ...args], {
      encoding: 'utf-8',
      env: {
        ...process.env,
        SHARP_LIBVIPS_REAL_CURL: downloader,
        SHARP_LIBVIPS_SOURCES: path.join(dir, 'sources.sha256'),
        SHARP_LIBVIPS_REFUSALS: path.join(dir, 'refused'),
        SHARP_LIBVIPS_SERVED: path.join(dir, 'served'),
      },
    });
    return {
      status: result.status ?? -1,
      stdout: result.stdout,
      refusals: readFileSync(path.join(dir, 'refused'), 'utf-8'),
      log: readFileSync(path.join(dir, 'served'), 'utf-8'),
      downloaderArgs: readFileSync(path.join(dir, 'args'), 'utf-8').split('\n'),
    };
  }
  const upstreamArgs = (url: string): string[] => ['--silent', '--location', '--retry', '3', '--retry-max-time', '30', url];

  withBash('writes the bytes of a pinned URL to standard output, as the upstream `curl ... | tar` reads them', () => {
    const result = fetch(upstreamArgs(PINNED), PINNED_BYTES);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(PINNED_BYTES);
    expect(result.refusals).toBe('');
    expect(result.log).toBe(`${PINNED}\n`);
  });

  withBash('downloads over HTTPS only, and follows redirects only to HTTPS', () => {
    const { downloaderArgs } = fetch(upstreamArgs(PINNED), PINNED_BYTES);
    const value = (flag: string): string | undefined => downloaderArgs[downloaderArgs.indexOf(flag) + 1];
    expect(value('--proto')).toBe('=https');
    expect(value('--proto-redir')).toBe('=https');
  });

  withBash('refuses bytes that do not have the pinned SHA-256, writes none of them, and records the refusal', () => {
    const result = fetch(upstreamArgs(PINNED), 'a changed archive\n');
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe('');
    expect(result.refusals).toContain(PINNED);
    expect(result.log).toBe('');
  });

  withBash('refuses a URL that is not pinned, and records it, so a `| patch -p1` that reads nothing still stops the build', () => {
    const result = fetch(upstreamArgs('https://example.org/floating.patch'), PINNED_BYTES);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe('');
    expect(result.refusals).toContain('https://example.org/floating.patch');
  });

  withBash('refuses arguments the upstream script does not pass, such as writing to a file', () => {
    for (const args of [['-O', PINNED], ['--insecure', PINNED], ['http://example.org/libwebp-1.6.0.tar.gz'], [PINNED, PINNED]]) {
      const result = fetch(args, PINNED_BYTES);
      expect(result.status, args.join(' ')).not.toBe(0);
      expect(result.refusals, args.join(' ')).not.toBe('');
    }
  });
});

/** `uname` that answers for the platform of the process, so env.sh picks the settings the scripts below run with. */
function platformStub(): string {
  const bin = tempDir('uname-');
  writeFileSync(path.join(bin, 'uname'), `#!/bin/sh\necho ${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}\n`);
  chmodSync(path.join(bin, 'uname'), 0o755);
  return bin;
}
const NPM_ARCH = process.arch === 'arm64' ? 'arm64' : 'x64';
const VIPS_VERSION = /^VIPS_VERSION=(\S+)$/m.exec(read('docker', 'sharp-libvips', 'env.sh'))?.[1] ?? '';
const LIBRARY = `libvips-cpp.so.${VIPS_VERSION}`;

describe('the downloads the build does not make through curl', () => {
  withBash('env.sh keeps Meson from downloading wraps: every `meson setup` of posix.sh runs with ${MESON}', () => {
    const result = spawnSync('bash', ['-c', `source "${path.join(BUILD_DIR, 'env.sh')}" && export_compiler_settings && printf '%s' "$MESON"`], {
      encoding: 'utf-8',
      env: { ...process.env, PATH: `${platformStub()}:${process.env.PATH ?? ''}` },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.split(' ')).toContain('--wrap-mode=nodownload');
    expect(result.stdout.split(' ')).toContain('--cross-file=/root/meson.ini');
  });

  /** Runs git-local-only.sh with a stand-in for the real git that records what it was asked. */
  function git(args: string[]): { status: number; refusals: string; reached: string } {
    const dir = tempDir('git-local-only-');
    const real = path.join(dir, 'real-git');
    writeFileSync(real, `#!/bin/sh\nprintf '%s\\n' "$*" > "${dir}/reached"\n`);
    chmodSync(real, 0o755);
    writeFileSync(path.join(dir, 'refused'), '');
    writeFileSync(path.join(dir, 'reached'), '');
    const result = spawnSync('bash', [path.join(BUILD_DIR, 'git-local-only.sh'), ...args], {
      encoding: 'utf-8',
      env: { ...process.env, SHARP_LIBVIPS_REAL_GIT: real, SHARP_LIBVIPS_REFUSALS: path.join(dir, 'refused') },
    });
    return { status: result.status ?? -1, refusals: readFileSync(path.join(dir, 'refused'), 'utf-8'), reached: readFileSync(path.join(dir, 'reached'), 'utf-8').trim() };
  }

  withBash.each([
    ['clone', ['clone', '--depth', '1', 'https://gitlab.gnome.org/GNOME/gvdb.git']],
    ['fetch', ['fetch', 'origin', 'main']],
    ['submodule update', ['submodule', 'update', '--init']],
    ['ls-remote', ['ls-remote', 'https://example.org/repo.git']],
    ['a clone behind the git-dir option', ['--git-dir=/deps/aom/.git', 'clone', 'https://example.org/repo.git']],
    ['a clone that follows describe in the arguments', ['clone', 'describe']],
    ['no subcommand', []],
  ])('git-local-only.sh refuses %s, and records it for the check build.sh makes after the script', (_what, args) => {
    const result = git(args);
    expect(result.status).not.toBe(0);
    expect(result.reached).toBe('');
    expect(result.refusals).toBe(`git ${args.join(' ')}\n`);
  });

  withBash.each([
    ['the version probe of CMake', ['--version']],
    ['the version of libxml2', ['describe']],
    ['the version of aom', ['--git-dir=/deps/aom/.git', 'describe', '--match=v[0-9]*']],
  ])('git-local-only.sh passes %s to the real git, as a query that reads no network', (_what, args) => {
    const result = git(args);
    expect(result.status).toBe(0);
    expect(result.reached).toBe(args.join(' '));
    expect(result.refusals).toBe('');
  });

  it('is installed by build.sh as the git of the script, beside the curl, and copied into the stage by Dockerfile.worker', () => {
    const build = read('docker', 'sharp-libvips', 'build.sh');
    expect(build).toContain('install -m 0755 "$here/git-local-only.sh" "$fetches/git"');
    expect(build).toContain('PATH="$fetches:$PATH" bash build/posix.sh');
    expect(dockerfile).toMatch(/^COPY docker\/sharp-libvips\/build\.sh [^\n]* docker\/sharp-libvips\/git-local-only\.sh /m);
  });
});

describe('the libwebp thread patch', () => {
  const libvipsPatch = path.join(BUILD_DIR, 'libvips-webp-thread-level.patch');
  const hookPatch = path.join(BUILD_DIR, 'webp-thread-level.patch');

  /** The lines of webpsave.c (libvips 8.18.7, vips_foreign_save_webp_init_config) around the setting the patch adds. */
  const WEBPSAVE_CONFIG = [
    'static int',
    'vips_foreign_save_webp_init_config(VipsForeignSaveWebp *webp)',
    '{',
    '\t/* Init WebP config.',
    '\t */',
    '\tWebPMemoryWriterInit(&webp->memory_writer);',
    '\tif (!WebPConfigInit(&webp->config)) {',
    '',
    '\twebp->config.lossless = webp->lossless || webp->near_lossless;',
    '\twebp->config.exact = webp->exact;',
    '\twebp->config.alpha_quality = webp->alpha_q;',
    '\twebp->config.method = webp->effort;',
    '\twebp->config.target_size = webp->target_size;',
    '\twebp->config.pass = webp->passes;',
    '',
    '\tif (webp->lossless)',
    '\t\twebp->config.quality = webp->Q;',
    '',
  ].join('\n');
  /** The lines of posix.sh (sharp-libvips ebb95f8) around the point where the libvips sources are patched. */
  const POSIX_VIPS_STEP = [
    'cd ${DEPS}/vips',
    '# Use version number in SONAME',
    '$CURL https://gist.githubusercontent.com/lovell/313a6901e9db1bf285f2a1f1180499e4/raw/3988223c7dfa4d22745d9392034b0117abef1446/libvips-cpp-soversion.patch | patch -p1',
    '# Link libvips.so statically into libvips-cpp.so',
    "sed -i'.bak' \"s/library('vips'/static_&/\" libvips/meson.build",
    "sed -i'.bak' \"/version: library_version/{N;d;}\" libvips/meson.build",
    '',
  ].join('\n');

  const webpsave = (dir: string): string => path.join(dir, 'vips', 'libvips', 'foreign', 'webpsave.c');

  /** A directory with the libvips sources in `vips`, where posix.sh stands when it patches them. */
  function workDir(): string {
    const dir = tempDir('webp-thread-');
    mkdirSync(path.join(dir, 'vips', 'libvips', 'foreign'), { recursive: true });
    writeFileSync(webpsave(dir), WEBPSAVE_CONFIG);
    writeFileSync(path.join(dir, 'vips', 'libvips', 'meson.build'), "library('vips'\nversion: library_version\n\n");
    return dir;
  }
  const applyLibvipsPatch = (dir: string): number | null =>
    spawnSync('patch', ['-p1', '--forward', '-i', libvipsPatch], { cwd: path.join(dir, 'vips'), encoding: 'utf-8' }).status;

  withBash('sets thread_level once in the WebP config of webpsave.c, for a picture with an alpha band only', () => {
    const dir = workDir();
    expect(applyLibvipsPatch(dir)).toBe(0);
    const patched = readFileSync(webpsave(dir), 'utf-8');
    expect(patched.match(/config\.thread_level = 1;/g)).toHaveLength(1);
    expect(patched).toContain('\tif (save->ready->Bands == 4)\n\t\twebp->config.thread_level = 1;');
    expect(patched.indexOf('VipsForeignSave *save = (VipsForeignSave *) webp;')).toBeLessThan(patched.indexOf('WebPMemoryWriterInit'));
    expect(patched.indexOf('config.pass = webp->passes;')).toBeLessThan(patched.indexOf('config.thread_level = 1;'));
  });

  withBash('fails on a webpsave.c that is not the one it was written for, so a moved source stops the build', () => {
    const dir = workDir();
    const file = webpsave(dir);
    writeFileSync(file, readFileSync(file, 'utf-8').replace('webp->passes', 'webp->pass_count'));
    expect(applyLibvipsPatch(dir)).not.toBe(0);
  });

  withBash('is applied by the line webp-thread-level.patch adds to posix.sh, which fails when the patch file is missing', () => {
    const dir = workDir();
    const script = path.join(dir, 'build', 'posix.sh');
    mkdirSync(path.dirname(script), { recursive: true });
    writeFileSync(script, POSIX_VIPS_STEP);
    expect(spawnSync('patch', ['-p1', '--forward', '-i', hookPatch], { cwd: dir, encoding: 'utf-8' }).status).toBe(0);
    const run = (patchFile: string) =>
      spawnSync('bash', ['-c', `set -e; CURL=true; DEPS=${dir}; source ${script}`], {
        cwd: dir,
        encoding: 'utf-8',
        env: { ...process.env, SHARP_LIBVIPS_WEBP_THREAD_PATCH: patchFile },
      });
    expect(run(path.join(dir, 'missing.patch')).status).not.toBe(0);
    const applied = run(libvipsPatch);
    expect(applied.status, applied.stderr).toBe(0);
    expect(readFileSync(webpsave(dir), 'utf-8'), applied.stderr).toContain('config.thread_level = 1;');
  });

  it('is installed by build.sh, which names the libvips patch for posix.sh, and both files are copied into the stage by Dockerfile.worker', () => {
    const build = read('docker', 'sharp-libvips', 'build.sh');
    expect(build).toContain('patch -p1 --forward < "$here/webp-thread-level.patch"');
    expect(build).toContain('export SHARP_LIBVIPS_WEBP_THREAD_PATCH="$here/libvips-webp-thread-level.patch"');
    expect(readFileSync(hookPatch, 'utf-8')).toContain('"$SHARP_LIBVIPS_WEBP_THREAD_PATCH"');
    expect(dockerfile).toMatch(/^COPY [^\n]* docker\/sharp-libvips\/webp-thread-level\.patch docker\/sharp-libvips\/libvips-webp-thread-level\.patch /m);
  });
});

describe('check-build-output.sh, the one check of what the sharplibvips stage hands over', () => {
  const BYTES = 'the rebuilt library\n';

  /** A build output of the stage: the library and its digest file, changed by `mutate`. */
  function output(mutate: (dir: string) => void = () => undefined): string {
    const dir = tempDir('build-output-');
    writeFileSync(path.join(dir, LIBRARY), BYTES);
    writeFileSync(path.join(dir, `${LIBRARY}.sha256`), `${sha256(BYTES)}  ${LIBRARY}\n`);
    mutate(dir);
    return dir;
  }
  function check(dir: string): { status: number; stdout: string; stderr: string } {
    const result = spawnSync('bash', [path.join(BUILD_DIR, 'check-build-output.sh'), dir], {
      encoding: 'utf-8',
      env: { ...process.env, PATH: `${platformStub()}:${process.env.PATH ?? ''}` },
    });
    return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
  }

  withBash('passes the library and its digest file alone, and prints the digest', () => {
    const result = check(output());
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe(sha256(BYTES));
  });

  withBash.each([
    ['a file beside them, such as a swapped addon', (dir: string) => writeFileSync(path.join(dir, 'sharp-linux-x64.node'), 'addon')],
    ['a directory of files, as node_modules is laid out', (dir: string) => {
      mkdirSync(path.join(dir, 'node_modules', 'sharp-linux-x64'), { recursive: true });
      writeFileSync(path.join(dir, 'node_modules', 'sharp-linux-x64', 'sharp.node'), 'addon');
    }],
    ['a hidden file', (dir: string) => writeFileSync(path.join(dir, '.extra'), 'x')],
    ['a symlink beside them', (dir: string) => symlinkSync('/etc/passwd', path.join(dir, 'passwd'))],
  ])('fails for %s', (_what, mutate) => {
    const result = check(output(mutate));
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('nothing else');
  });

  withBash('fails when the library is a symlink, even to a file with the digest', () => {
    const elsewhere = path.join(tempDir('build-output-target-'), 'real');
    writeFileSync(elsewhere, BYTES);
    const result = check(output((dir) => {
      rmSync(path.join(dir, LIBRARY));
      symlinkSync(elsewhere, path.join(dir, LIBRARY));
    }));
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('is not a regular file');
  });

  withBash('fails when the digest file is a symlink, when the library is not the one it describes, and when either is missing', () => {
    const digestFile = path.join(tempDir('build-output-target-'), 'real');
    writeFileSync(digestFile, `${sha256(BYTES)}  ${LIBRARY}\n`);
    const linked = check(output((dir) => {
      rmSync(path.join(dir, `${LIBRARY}.sha256`));
      symlinkSync(digestFile, path.join(dir, `${LIBRARY}.sha256`));
    }));
    expect(linked.status).not.toBe(0);
    expect(linked.stderr).toContain('is not a regular file');
    expect(check(output((dir) => writeFileSync(path.join(dir, LIBRARY), 'a swapped library\n'))).status).not.toBe(0);
    expect(check(output((dir) => rmSync(path.join(dir, `${LIBRARY}.sha256`)))).status).not.toBe(0);
    expect(check(output((dir) => rmSync(path.join(dir, LIBRARY)))).status).not.toBe(0);
  });

  it('is the check of the cache restore in the container job and of the build that fills the cache, and is run by use-libvips.sh and by the image', () => {
    const script = 'docker/sharp-libvips/check-build-output.sh';
    expect(ci.jobs.container.steps.find((step) => step.name === 'Check the libvips build')?.run).toContain(script);
    expect(reusable.jobs.build.steps.find((step) => step.name === 'Check the build')?.run).toContain(script);
    const names = (job: Job): string[] => job.steps.map((step) => step.name ?? '');
    const container = names(ci.jobs.container);
    expect(container.indexOf('Check the libvips build')).toBeGreaterThan(container.indexOf('Restore the libvips build'));
    expect(container.indexOf('Check the libvips build')).toBeLessThan(container.indexOf('Build the worker image'));
    const saveAt = reusable.jobs.build.steps.findIndex((step) => step.uses?.startsWith('actions/cache/save@'));
    expect(reusable.jobs.build.steps.findIndex((step) => step.name === 'Check the build')).toBeLessThan(saveAt);
    expect(read('docker', 'sharp-libvips', 'use-libvips.sh')).toContain('check-build-output.sh');
  });
});

describe('use-libvips.sh and check-sharp.sh, the library that is installed and the one that is loaded', () => {
  const BYTES = 'the rebuilt library\n';

  /** An app root with the npm package's library, and a build output of the stage. */
  function layout(): { root: string; build: string; library: string; bin: string } {
    const dir = tempDir('use-libvips-');
    const root = path.join(dir, 'app');
    const build = path.join(dir, 'build');
    const library = path.join(root, 'node_modules', '@img', `sharp-libvips-linux-${NPM_ARCH}`, 'lib', LIBRARY);
    mkdirSync(path.dirname(library), { recursive: true });
    writeFileSync(library, 'the library of the npm package\n');
    mkdirSync(build);
    writeFileSync(path.join(build, LIBRARY), BYTES);
    writeFileSync(path.join(build, `${LIBRARY}.sha256`), `${sha256(BYTES)}  ${LIBRARY}\n`);
    const bin = path.join(dir, 'bin');
    mkdirSync(bin);
    writeFileSync(path.join(bin, 'uname'), `#!/bin/sh\necho ${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}\n`);
    writeFileSync(path.join(bin, 'node'), `#!/bin/sh\nprintf '%s' "$EXPECTED_SHA256" > "${dir}/expected"\n`);
    for (const name of ['uname', 'node']) chmodSync(path.join(bin, name), 0o755);
    return { root, build, library, bin };
  }
  function use(setup: { root: string; build: string; bin: string }): { status: number; stderr: string } {
    const result = spawnSync('bash', [path.join(BUILD_DIR, 'use-libvips.sh'), setup.root, setup.build], {
      encoding: 'utf-8',
      env: { ...process.env, PATH: `${setup.bin}:${process.env.PATH ?? ''}` },
    });
    return { status: result.status ?? -1, stderr: result.stderr };
  }

  withBash('puts the built library over the npm package one and hands the digest of the build to check-sharp.sh', () => {
    const setup = layout();
    const result = use(setup);
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(setup.library, 'utf-8')).toBe(BYTES);
    expect(readFileSync(path.join(path.dirname(setup.root), 'expected'), 'utf-8')).toBe(sha256(BYTES));
    expect(use(setup).status).toBe(0);
    expect(readFileSync(setup.library, 'utf-8')).toBe(BYTES);
  });

  withBash('leaves node_modules as the npm package installed it when the build output holds anything else', () => {
    const setup = layout();
    writeFileSync(path.join(setup.build, 'sharp-linux-x64.node'), 'addon');
    expect(use(setup).status).not.toBe(0);
    expect(readFileSync(setup.library, 'utf-8')).toBe('the library of the npm package\n');
    expect(existsSync(path.join(path.dirname(setup.root), 'expected'))).toBe(false);
  });

  const procMaps = existsSync('/proc/self/maps');
  const withProc = it.skipIf(skipUnless('/proc/self/maps, which check-sharp.sh reads', procMaps));

  /** An app root whose sharp is a stand-in that encodes a WebP, with the library the package installed. */
  function app(libraryBytes: string): string {
    const root = tempDir('check-sharp-');
    const release = /^SHARP_LIBVIPS_VERSION=(\S+)$/m.exec(read('docker', 'sharp-libvips', 'env.sh'))?.[1] ?? '';
    const name = `@img/sharp-libvips-linux-${process.arch}`;
    mkdirSync(path.join(root, 'node_modules', name, 'lib'), { recursive: true });
    mkdirSync(path.join(root, 'node_modules', 'sharp'), { recursive: true });
    writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify({ packages: { [`node_modules/${name}`]: { version: release } } }));
    writeFileSync(path.join(root, 'node_modules', name, 'package.json'), JSON.stringify({ version: release }));
    writeFileSync(path.join(root, 'node_modules', name, 'lib', LIBRARY), libraryBytes);
    writeFileSync(path.join(root, 'node_modules', 'sharp', 'package.json'), JSON.stringify({ name: 'sharp', version: '0.0.0', main: 'index.js' }));
    writeFileSync(
      path.join(root, 'node_modules', 'sharp', 'index.js'),
      `const webp = Buffer.from('RIFF\\0\\0\\0\\0WEBP');
       const sharp = () => ({ webp() { return this; }, toBuffer: () => Promise.resolve(webp) });
       sharp.versions = { vips: '${VIPS_VERSION}' };
       module.exports = sharp;`
    );
    return root;
  }
  function checkSharp(root: string, expected?: string): string {
    const result = spawnSync('bash', [path.join(BUILD_DIR, 'check-sharp.sh'), root, ...(expected === undefined ? [] : [expected])], {
      encoding: 'utf-8',
      env: { ...process.env, PATH: `${platformStub()}:${process.env.PATH ?? ''}` },
    });
    return result.stderr;
  }

  withProc('check-sharp.sh fails when the library it loads is not the one that was built', () => {
    const root = app(BYTES);
    expect(checkSharp(root, sha256('another library\n'))).toContain(`the build of the sharplibvips stage has ${sha256('another library\n')}`);
    expect(checkSharp(root, sha256(BYTES))).not.toContain('the build of the sharplibvips stage has');
    expect(checkSharp(root)).not.toContain('the build of the sharplibvips stage has');
  });
});

describe('cache-key.sh, the key of the CI build', () => {
  const STAGE = [
    'FROM rockylinux/rockylinux:8-ubi-init@sha256:0000 AS sharplibvips-build',
    'COPY docker/sharp-libvips/build.sh docker/sharp-libvips/option-f.patch /src/sharp-libvips/',
    'RUN bash /src/sharp-libvips/build.sh /out',
    'FROM scratch AS sharplibvips',
    'COPY --from=sharplibvips-build /out/ /',
  ].join('\n');

  function checkout(dockerfileText: string, files: Record<string, string>): string {
    const dir = tempDir('cache-key-');
    writeFileSync(path.join(dir, 'Dockerfile.worker'), dockerfileText);
    mkdirSync(path.join(dir, 'docker', 'sharp-libvips'), { recursive: true });
    for (const [name, text] of Object.entries(files)) writeFileSync(path.join(dir, 'docker', 'sharp-libvips', name), text);
    return dir;
  }
  function key(dir: string): string {
    const result = spawnSync('bash', [path.join(BUILD_DIR, 'cache-key.sh'), dir], { encoding: 'utf-8' });
    expect(result.status, result.stderr).toBe(0);
    return result.stdout.trim();
  }
  const files = { 'build.sh': 'build\n', 'option-f.patch': 'patch\n' };

  withBash('names the x64 build and stays the same for the same inputs', () => {
    const first = key(checkout(`FROM node AS builder\n${STAGE}\nFROM node AS runner\n`, files));
    expect(first).toMatch(/^sharp-libvips-linux-x64-[0-9a-f]{64}$/);
    expect(key(checkout(`FROM node AS builder\n${STAGE}\nFROM node AS runner\n`, files))).toBe(first);
  });

  withBash('changes with any file the stage copies and with any line of the stage, and not with the other files of the directory', () => {
    const base = key(checkout(`${STAGE}\n`, files));
    expect(key(checkout(`${STAGE}\n`, { ...files, 'option-f.patch': 'another patch\n' }))).not.toBe(base);
    expect(key(checkout(`${STAGE.replace('sha256:0000', 'sha256:1111')}\n`, files))).not.toBe(base);
    expect(key(checkout(`${STAGE}\n`, { ...files, 'check-sharp.sh': 'a check the image runs later\n' }))).toBe(base);
  });

  withBash('does not change when another stage of the worker image changes', () => {
    expect(key(checkout(`FROM node AS builder\nRUN npm ci\n${STAGE}\n`, files))).toBe(key(checkout(`FROM node AS builder\nRUN npm ci --omit=dev\n${STAGE}\n`, files)));
  });

  withBash('fails when the worker image has no such stage', () => {
    const result = spawnSync('bash', [path.join(BUILD_DIR, 'cache-key.sh'), checkout('FROM node AS runner\n', files)], { encoding: 'utf-8' });
    expect(result.status).not.toBe(0);
  });
});

describe('ab-base-dependencies.sh, the dependencies of the base of a speed comparison', () => {
  /** A head checkout with an ab-base beside it; `baseBuild` false gives a base from before the libvips build. */
  function layout(options: { sameLock: boolean; baseBuild: 'same' | 'other' | false; restored?: boolean }): { dir: string; status: number; stdout: string } {
    const dir = tempDir('ab-base-');
    const writeCheckout = (root: string, lock: string, build: string | false): void => {
      mkdirSync(root, { recursive: true });
      writeFileSync(path.join(root, 'package-lock.json'), lock);
      writeFileSync(path.join(root, 'Dockerfile.worker'), 'FROM rocky AS sharplibvips-build\nCOPY docker/sharp-libvips/option-f.patch /src/\nFROM scratch AS sharplibvips\nCOPY --from=sharplibvips-build /out/ /\n');
      if (build === false) return;
      mkdirSync(path.join(root, 'docker', 'sharp-libvips'), { recursive: true });
      cpSync(path.join(BUILD_DIR, 'cache-key.sh'), path.join(root, 'docker', 'sharp-libvips', 'cache-key.sh'));
      writeFileSync(path.join(root, 'docker', 'sharp-libvips', 'option-f.patch'), build);
    };
    writeCheckout(dir, '{"lock":"head"}\n', 'head build\n');
    mkdirSync(path.join(dir, 'node_modules', 'sharp'), { recursive: true });
    writeFileSync(path.join(dir, 'node_modules', 'sharp', 'package.json'), '{"name":"sharp"}\n');
    const base = path.join(dir, 'ab-base');
    writeCheckout(base, options.sameLock ? '{"lock":"head"}\n' : '{"lock":"base"}\n', options.baseBuild === false ? false : options.baseBuild === 'same' ? 'head build\n' : 'base build\n');
    if (options.restored) mkdirSync(path.join(base, 'node_modules', 'restored'), { recursive: true });
    const bin = path.join(dir, 'bin');
    mkdirSync(bin);
    writeFileSync(path.join(bin, 'npm'), '#!/bin/sh\nmkdir -p node_modules/installed\n');
    chmodSync(path.join(bin, 'npm'), 0o755);
    const result = spawnSync('bash', [path.join(ROOT, 'scripts', 'ab-base-dependencies.sh'), options.restored ? 'true' : 'false'], {
      cwd: dir,
      encoding: 'utf-8',
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` },
    });
    return { dir, status: result.status ?? -1, stdout: result.stdout.trim() };
  }
  const modules = (dir: string): string => path.join(dir, 'ab-base', 'node_modules');

  withBash('shares the head node_modules only when the lock file and the libvips build are both the same', () => {
    const shared = layout({ sameLock: true, baseBuild: 'same' });
    expect(shared.status).toBe(0);
    expect(lstatSync(modules(shared.dir)).isSymbolicLink()).toBe(true);
    expect(shared.stdout).toBe('own-libvips=false');
  });

  withBash('copies the head node_modules for a base with the same lock file and another libvips build, and gives it its own library', () => {
    const other = layout({ sameLock: true, baseBuild: 'other' });
    expect(other.status).toBe(0);
    expect(lstatSync(modules(other.dir)).isSymbolicLink()).toBe(false);
    expect(existsSync(path.join(modules(other.dir), 'sharp', 'package.json'))).toBe(true);
    expect(other.stdout).toBe('own-libvips=true');
  });

  withBash('copies them for a base from before the libvips build, which keeps the npm package library', () => {
    const before = layout({ sameLock: true, baseBuild: false });
    expect(lstatSync(modules(before.dir)).isSymbolicLink()).toBe(false);
    expect(before.stdout).toBe('own-libvips=false');
  });

  withBash('installs the base own dependencies for another lock file, and keeps the ones restored from the cache', () => {
    const installed = layout({ sameLock: false, baseBuild: 'same' });
    expect(existsSync(path.join(modules(installed.dir), 'installed'))).toBe(true);
    expect(installed.stdout).toBe('own-libvips=true');
    const restored = layout({ sameLock: true, baseBuild: 'same', restored: true });
    expect(existsSync(path.join(modules(restored.dir), 'restored'))).toBe(true);
    expect(existsSync(path.join(modules(restored.dir), 'installed'))).toBe(false);
    expect(restored.stdout).toBe('own-libvips=true');
  });
});

describe('the jobs that convert pictures', () => {
  const USE = './.github/actions/sharp-libvips';
  /** Every job whose results depend on the image library: the test suites, the conformance gate and the benchmarks. */
  const CONSUMERS: Array<[string, Workflow, string]> = [
    ...['tests', 'conformance', 'parity-quality', 'parity-speed'].map((job): [string, Workflow, string] => ['ci.yml', ci, job]),
    ...['perf', 'bench', 'bench-parity-quality', 'bench-parity-speed', 'bench-ab-speed', 'realworld'].map((job): [string, Workflow, string] => ['nightly.yml', nightly, job]),
  ];
  const converts = (step: Step): boolean => /vitest run|bench:quality|bench:realworld/.test(step.run ?? '');

  it.each(CONSUMERS)('%s %s waits for the build and puts it into node_modules after the install and before any conversion', (_file, flow, name) => {
    const job = flow.jobs[name];
    expect([job.needs].flat(), name).toContain('sharp-libvips');
    const index = (predicate: (step: Step) => boolean): number => job.steps.findIndex(predicate);
    const use = index((step) => step.uses === USE && step.with?.root === undefined);
    expect(use, `${name} uses the build`).toBeGreaterThan(index((step) => step.run === 'npm ci --ignore-scripts'));
    expect(use, `${name} before converting`).toBeLessThan(index(converts));
  });

  it.each([['ci.yml', ci, 'parity-speed', 'base-install'], ['nightly.yml', nightly, 'bench-ab-speed', 'base']] as const)(
    '%s %s gives the base of the comparison its dependencies before the head gets its library, and the base its own when it has one',
    (_file, flow, name, baseStep) => {
      const steps = flow.jobs[name].steps;
      const install = steps.findIndex((step) => step.id === baseStep);
      expect(steps[install].run).toContain('scripts/ab-base-dependencies.sh');
      const head = steps.findIndex((step) => step.uses === USE && step.with?.root === undefined);
      const base = steps.findIndex((step) => step.uses === USE && step.with?.root === 'ab-base');
      expect(install).toBeLessThan(head);
      expect(head).toBeLessThan(base);
      expect(String(steps[base].if)).toContain(`steps.${baseStep}.outputs.own-libvips == 'true'`);
    }
  );

  it('builds the worker image in CI from the cached build of the stage, which is not there to be built again', () => {
    const steps = ci.jobs.container.steps;
    expect(ci.jobs.container.needs).toBe('sharp-libvips');
    const restore = steps.find((step) => step.uses?.startsWith('actions/cache/restore@'));
    expect(restore?.with?.['fail-on-cache-miss']).toBe(true);
    const build = steps.find((step) => step.uses?.startsWith('docker/build-push-action@'));
    expect(build?.with?.['build-contexts']).toBe(`sharplibvips=${String(restore?.with?.path)}`);
  });

  it('is fed by one reusable workflow that both workflows call, and whose failure fails the run', () => {
    expect(ci.jobs['sharp-libvips'].uses).toBe('./.github/workflows/sharp-libvips.yml');
    expect(nightly.jobs['sharp-libvips'].uses).toBe('./.github/workflows/sharp-libvips.yml');
    expect(ci.jobs.verify.needs).toContain('sharp-libvips');
    expect(nightly.jobs.report.needs).toContain('sharp-libvips');
    expect(Object.keys(reusable.on)).toEqual(['workflow_call']);
  });
});

describe('the CI build of the stage', () => {
  const steps = reusable.jobs.build.steps;
  const lookup = steps.find((step) => step.id === 'cache');
  const build = steps.find((step) => (step.run ?? '').includes('docker buildx build'));
  const save = steps.find((step) => step.uses?.startsWith('actions/cache/save@'));
  const restore = action.runs.steps.find((step) => step.uses?.startsWith('actions/cache/restore@'));

  it('builds the stage of Dockerfile.worker for linux/amd64 only when its key is not in the cache, and saves it under that key', () => {
    expect(lookup?.with?.['lookup-only']).toBe(true);
    expect(build?.run).toContain('--file Dockerfile.worker --target sharplibvips --platform linux/amd64');
    for (const step of [build, save]) expect(step?.if).toBe("steps.cache.outputs.cache-hit != 'true'");
    expect(save?.with?.key).toBe(lookup?.with?.key);
  });

  it('is restored from the same path it is saved from (the path is part of the cache version), or the job fails', () => {
    expect(restore?.with?.path).toBe(save?.with?.path);
    expect(restore?.with?.['fail-on-cache-miss']).toBe(true);
    expect(restore?.with?.['restore-keys']).toBeUndefined();
  });

  it('is the stage the worker image copies from, built in the pinned build container', () => {
    expect(dockerfile).toMatch(/^FROM rockylinux\/rockylinux:8-ubi-init@sha256:[0-9a-f]{64} AS sharplibvips-build$/m);
    expect(dockerfile).toContain('FROM scratch AS sharplibvips\nCOPY --from=sharplibvips-build /out/ /\n');
    const use = dockerfile.indexOf('RUN --mount=type=bind,from=sharplibvips,target=/mnt/sharplibvips');
    expect(use).toBeGreaterThan(dockerfile.indexOf('COPY --from=builder --chown=easyconvert:easyconvert /app/node_modules ./node_modules'));
    expect(dockerfile.indexOf('bash /mnt/sharp-libvips/use-libvips.sh /app /mnt/sharplibvips', use)).toBeGreaterThan(use);
    expect(dockerfile).not.toMatch(/COPY --from=sharplibvips /);
  });
});
