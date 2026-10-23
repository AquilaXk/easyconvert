import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { skipUnless } from './helpers/strict-skip';

/**
 * The libvips build of the worker image (docs/policy-decisions.md, entry 81): the download check the upstream build runs
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
  function fetch(args: string[], served: string): { status: number; stdout: string; refusals: string; log: string } {
    const dir = tempDir('fetch-pinned-');
    const downloader = path.join(dir, 'downloader');
    writeFileSync(path.join(dir, 'body'), served);
    writeFileSync(downloader, `#!/bin/sh\nwhile [ "$#" -gt 1 ]; do if [ "$1" = --output ]; then cp "${dir}/body" "$2"; fi; shift; done\n`);
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
    return { status: result.status ?? -1, stdout: result.stdout, refusals: readFileSync(path.join(dir, 'refused'), 'utf-8'), log: readFileSync(path.join(dir, 'served'), 'utf-8') };
  }
  const upstreamArgs = (url: string): string[] => ['--silent', '--location', '--retry', '3', '--retry-max-time', '30', url];

  withBash('writes the bytes of a pinned URL to standard output, as the upstream `curl ... | tar` reads them', () => {
    const result = fetch(upstreamArgs(PINNED), PINNED_BYTES);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(PINNED_BYTES);
    expect(result.refusals).toBe('');
    expect(result.log).toBe(`${PINNED}\n`);
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
    const copy = dockerfile.indexOf('COPY --from=sharplibvips --chown=easyconvert:easyconvert /node_modules/ ./node_modules/');
    expect(copy).toBeGreaterThan(dockerfile.indexOf('COPY --from=builder --chown=easyconvert:easyconvert /app/node_modules ./node_modules'));
    expect(dockerfile.indexOf('check-sharp.sh /app', copy)).toBeGreaterThan(copy);
  });
});
