import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { skipUnless } from './helpers/strict-skip';

/**
 * native/tmpfile-redirect: a program that calls tmpfile() (as FontForge does to read a Type 1 font) gets its file in TMPDIR, so it works under the file
 * confinement of pid-init, where /tmp may not be written. The program is a few lines of C compiled here; the control runs it without the library.
 */

const C_COMPILER = process.env.CC ?? 'cc';
const RUN_HANG_GUARD_MS = 20_000;
const hasCompiler = spawnSync(C_COMPILER, ['--version'], { stdio: 'ignore' }).status === 0;
const hasNamespaces = process.platform === 'linux' && spawnSync('unshare', ['-r', '-n', '--', 'true'], { stdio: 'ignore' }).status === 0;
const scratch = hasCompiler && hasNamespaces ? fs.mkdtempSync(path.join(os.tmpdir(), 'tmpfile-redirect-')) : '';
const library = path.join(scratch, 'libtmpfile.so');
const pidInit = path.join(scratch, 'pid-init');
const probe = path.join(scratch, 'probe');
const job = path.join(scratch, 'job');

function prepare(): boolean {
  if (scratch === '') return false;
  const here = process.cwd();
  const built = [
    spawnSync(path.join(here, 'native', 'tmpfile-redirect', 'build.sh'), [library], { encoding: 'utf8' }),
    spawnSync(path.join(here, 'native', 'pid-init', 'build.sh'), [pidInit], { encoding: 'utf8' }),
  ];
  for (const build of built) if (build.status !== 0) throw new Error(`a build failed: ${build.stderr}${build.stdout}`);
  fs.writeFileSync(
    path.join(scratch, 'probe.c'),
    '#include <stdio.h>\nint main(void){FILE *f=tmpfile();if(!f){puts("tmpfile failed");return 1;}fputs("data",f);rewind(f);char b[8]={0};fread(b,1,4,f);puts(b);return 0;}\n'
  );
  const compiled = spawnSync(C_COMPILER, ['-o', probe, path.join(scratch, 'probe.c')], { encoding: 'utf8' });
  if (compiled.status !== 0) throw new Error(`the probe did not compile: ${compiled.stderr}`);
  fs.mkdirSync(job);
  return spawnSync('unshare', ['-r', '-n', '--', pidInit, '--check', '--confine'], { timeout: RUN_HANG_GUARD_MS }).status === 0;
}

const confines = prepare();

afterAll(() => {
  if (scratch !== '') fs.rmSync(scratch, { recursive: true, force: true });
});

const confined = (environment: Record<string, string>) =>
  spawnSync('unshare', ['-r', '-n', '--', pidInit, '--confine', '--write', job, '--read', library, '--read', probe, '--', 'env', ...Object.entries(environment).map(([k, v]) => `${k}=${v}`), probe], {
    encoding: 'utf8',
    timeout: RUN_HANG_GUARD_MS,
  });

// skip-ok: the confinement needs Landlock version 3 (Linux 6.2); skipUnless fails the run under ORACLE_STRICT_MODE=1 without it.
describe.skipIf(skipUnless('a C compiler, unprivileged namespaces and Landlock version 3 for tmpfile-redirect', confines))('the tmpfile() redirect', () => {
  it('control: under the file confinement a program that calls tmpfile() fails, because the file would be made in /tmp', () => {
    const run = confined({ TMPDIR: job });
    expect({ status: run.status, out: run.stdout.trim() }).toEqual({ status: 1, out: 'tmpfile failed' });
  });

  it('makes the file in TMPDIR, so the same program works, and leaves no name behind', () => {
    const run = confined({ TMPDIR: job, LD_PRELOAD: library });
    expect({ status: run.status, out: run.stdout.trim() }).toEqual({ status: 0, out: 'data' });
    expect(fs.readdirSync(job)).toEqual([]);
  });
});
