import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { skipUnless } from './helpers/strict-skip';

/**
 * `pid-init --confine` (native/pid-init): the files of the program are confined to the directories it is given. Every claim is read from
 * inside the program, in the user namespace `unshare -r -n` makes, as the worker starts it; the control of each refusal is the same command
 * run without `--confine`.
 */

const C_COMPILER = process.env.CC ?? 'cc';
const compilerMissing = skipUnless('a C compiler (cc)', spawnSync(C_COMPILER, ['--version'], { stdio: 'ignore' }).status === 0);
const namespacesMissing = skipUnless(
  'unprivileged user and network namespaces (unshare -r -n)',
  process.platform === 'linux' && spawnSync('unshare', ['-r', '-n', '--', 'true'], { stdio: 'ignore' }).status === 0
);
const RUN_HANG_GUARD_MS = 20_000;

const toolsMissing = compilerMissing || namespacesMissing;
const scratch = toolsMissing ? '' : fs.mkdtempSync(path.join(os.tmpdir(), 'pid-init-confine-'));
const pidInit = path.join(scratch, 'pid-init');
const denyBinary = path.join(scratch, 'seccomp-deny');
const own = path.join(scratch, 'own');
const other = path.join(scratch, 'other');
const extra = path.join(scratch, 'extra');

/** `unshare -r -n -- pid-init [options] -- <command>`, the way the sandbox starts a program. */
function inNamespace(options: string[], command: string[]) {
  return spawnSync('unshare', ['-r', '-n', '--', pidInit, ...options, '--', ...command], { encoding: 'utf8', timeout: RUN_HANG_GUARD_MS });
}


/** What a shell does in the directories: one line each, `ok` or the error text of the failed command. */
const ATTEMPTS = `
attempt() { if out="$("$@" 2>&1 >/dev/null)"; then echo ok; else echo "$out" | head -n 1 | sed 's/.*: //'; fi; }
echo "read other: $(attempt cat "$OTHER/secret")"
echo "write other: $(attempt sh -c 'echo x > "$0/victim"' "$OTHER")"
echo "truncate other: $(attempt truncate -s 0 "$OTHER/victim")"
echo "remove other: $(attempt rm "$OTHER/victim")"
echo "create in other: $(attempt sh -c 'echo x > "$0/created"' "$OTHER")"
echo "list other: $(attempt ls "$OTHER")"
echo "write own: $(attempt sh -c 'echo x > "$0/out"' "$OWN")"
echo "truncate own: $(attempt truncate -s 0 "$OWN/out")"
echo "remove own: $(attempt rm "$OWN/out")"
echo "write extra: $(attempt sh -c 'echo x > "$0/out"' "$EXTRA")"
echo "read system: $(attempt cat /etc/passwd)"
echo "write system: $(attempt sh -c 'echo x > /etc/pid-init-confine-test')"
echo "dev null: $(attempt sh -c 'echo x > /dev/null')"
# The shell itself reads its own entry: a process it forks has an entry of its own that no rule can name beforehand (policy 208).
if read -r first < /proc/self/status 2>/dev/null; then echo "own proc: ok"; else echo "own proc: refused"; fi
echo "meminfo: $(attempt cat /proc/meminfo)"
`;

const lines = (output: string): string[] => output.trim().split('\n');
const run = (options: string[]) => inNamespace(options, ['env', `OTHER=${other}`, `OWN=${own}`, `EXTRA=${extra}`, 'sh', '-c', ATTEMPTS]);

const CONFINED = [
  'read other: Permission denied',
  'write other: Permission denied',
  'truncate other: Permission denied',
  'remove other: Permission denied',
  'create in other: Permission denied',
  'list other: Permission denied',
  'write own: ok',
  'truncate own: ok',
  'remove own: ok',
  'write extra: Permission denied',
  'read system: ok',
  expect.stringMatching(/^write system: (Permission denied|Read-only file system)$/),
  'dev null: ok',
  'own proc: ok',
  'meminfo: ok',
];

/** Builds the programs of the tests and reports whether this kernel can confine files (Landlock version 3, Linux 6.2); collected before the suite so that it can be skipped. */
function prepare(): boolean {
  if (toolsMissing) return false;
  const build = spawnSync(path.join(process.cwd(), 'native', 'pid-init', 'build.sh'), [pidInit], { encoding: 'utf8' });
  if (build.status !== 0) throw new Error(`pid-init did not build: ${build.stderr}${build.stdout}`);
  const deny = spawnSync(C_COMPILER, ['-O2', '-o', denyBinary, path.join(process.cwd(), 'tests', 'helpers', 'seccomp-deny.c')], { encoding: 'utf8' });
  if (deny.status !== 0) throw new Error(`seccomp-deny did not build: ${deny.stderr}`);
  for (const directory of [own, other, extra]) fs.mkdirSync(directory);
  fs.writeFileSync(path.join(other, 'secret'), 'secret');
  fs.writeFileSync(path.join(other, 'victim'), 'victim');
  return spawnSync('unshare', ['-r', '-n', '--', pidInit, '--check', '--confine'], { timeout: RUN_HANG_GUARD_MS }).status === 0;
}

const kernelConfines = prepare();

afterAll(() => {
  if (scratch !== '') fs.rmSync(scratch, { recursive: true, force: true });
});

// skip-ok: the confinement needs Landlock version 3 (Linux 6.2); skipUnless fails the run under ORACLE_STRICT_MODE=1 without it.
describe.skipIf(toolsMissing || skipUnless('Landlock version 3 (Linux 6.2 or later) for pid-init --confine', kernelConfines))('pid-init --confine', () => {
  it('--check --confine exits 0 here, and 3 with the reason when the kernel call is refused', () => {
    const refused = spawnSync(denyBinary, ['landlock_create_ruleset', '/usr/bin/unshare', '-r', '-n', '--', pidInit, '--check', '--confine'], { encoding: 'utf8', timeout: RUN_HANG_GUARD_MS });
    expect({ status: refused.status, stderr: refused.stderr.trim() }).toEqual({ status: 3, stderr: 'pid-init: files not confined: the kernel has no Landlock' });
  });

  it('control: without --confine the program reads, overwrites, truncates, creates in and lists the directory of another job', () => {
    const lines0 = lines(run([]).stdout);
    expect(lines0.slice(0, 6)).toEqual(['read other: ok', 'write other: ok', 'truncate other: ok', 'remove other: ok', 'create in other: ok', 'list other: ok']);
    // The next run needs what the control removed or emptied.
    fs.writeFileSync(path.join(other, 'secret'), 'secret');
    fs.writeFileSync(path.join(other, 'victim'), 'victim');
    fs.rmSync(path.join(other, 'created'), { force: true });
  });

  it.each([
    ['in a PID namespace', []],
    ['without one', ['--no-pid-namespace']],
  ])('refuses what is outside the directories, and allows the system, /dev, its own /proc and its directories %s', (_name, extraOptions) => {
    const result = run(['--confine', '--require', '--write', own, '--write', path.join(scratch, 'does-not-exist'), ...extraOptions]);
    expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: '' });
    expect(lines(result.stdout)).toEqual(CONFINED);
    expect(fs.readFileSync(path.join(other, 'secret'), 'utf8')).toBe('secret');
    expect(fs.readFileSync(path.join(other, 'victim'), 'utf8')).toBe('victim');
    expect(fs.readdirSync(other).sort()).toEqual(['secret', 'victim']);
  });

  it('writes below every --write directory and reads below --read ones (a file as well as a directory), and below nothing else', () => {
    const result = inNamespace(['--confine', '--write', own, '--write', extra, '--read', path.join(other, 'secret')], [
      'sh',
      '-c',
      'cat "$0/secret" && echo x > "$1/out" && echo x > "$2/out" && ! cat "$0/victim" 2>/dev/null && ! sh -c \'echo x > "$0/secret"\' "$0" 2>/dev/null && echo done',
      other,
      own,
      extra,
    ]);
    expect({ status: result.status, out: result.stdout }).toEqual({ status: 0, out: 'secretdone\n' });
  });

  it('lets the program move and link files between its directories, and refuses a link out of one it may not touch', () => {
    const result = inNamespace(['--confine', '--write', own], [
      process.execPath,
      '-e',
      "const fs = require('node:fs'), path = require('node:path'); const own = process.argv[1]; fs.mkdirSync(path.join(own, 'a')); fs.mkdirSync(path.join(own, 'b')); fs.writeFileSync(path.join(own, 'a', 'f'), 'x'); fs.linkSync(path.join(own, 'a', 'f'), path.join(own, 'b', 'link')); fs.renameSync(path.join(own, 'a', 'f'), path.join(own, 'b', 'f')); let refused = 'none'; try { fs.linkSync(process.argv[2], path.join(own, 'stolen')); } catch (err) { refused = err.code; } console.log(fs.readFileSync(path.join(own, 'b', 'f'), 'utf8') + fs.readFileSync(path.join(own, 'b', 'link'), 'utf8') + ' ' + refused);",
      own,
      path.join(other, 'secret'),
    ]);
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toMatch(/^xx (EACCES|EXDEV)$/);
  });

  it('with --keep-proc leaves /proc as it is and still confines the files', () => {
    const result = inNamespace(['--confine', '--keep-proc', '--write', own], ['sh', '-c', 'cat /proc/1/status > /dev/null && echo proc-ok; cat "$0/secret" 2>&1 | head -n 1', other]);
    expect(lines(result.stdout)).toEqual(['proc-ok', expect.stringContaining('Permission denied')]);
  });

  it('refuses to list /proc, which would name the other processes, and still reads its own entries', () => {
    const result = inNamespace(['--confine', '--write', own], ['sh', '-c', 'ls /proc > /dev/null 2>&1 && echo listed || echo not-listed; read -r first < /proc/self/status && echo own']);
    expect(lines(result.stdout)).toEqual(['not-listed', 'own']);
  });

  it('with --require does not start a program it cannot confine: status 125 and the reason, on the first line of the standard error', () => {
    const marker = path.join(own, 'ran');
    const refused = spawnSync(
      denyBinary,
      ['landlock_create_ruleset', '/usr/bin/unshare', '-r', '-n', '--', pidInit, '--confine', '--require', '--write', own, '--', 'sh', '-c', `echo ran > ${marker}`],
      { encoding: 'utf8', timeout: RUN_HANG_GUARD_MS }
    );
    expect({ status: refused.status, first: refused.stderr.split('\n')[0] }).toEqual({ status: 125, first: 'pid-init: cannot confine: the kernel has no Landlock' });
    expect(fs.existsSync(marker)).toBe(false);
  });

  it('without --require runs the program anyway, after one line for the files and one for /proc', () => {
    const result = spawnSync(
      denyBinary,
      ['landlock_create_ruleset', '/usr/bin/unshare', '-r', '-n', '--', pidInit, '--confine', '--write', own, '--', 'sh', '-c', 'echo ran >&2'],
      { encoding: 'utf8', timeout: RUN_HANG_GUARD_MS }
    );
    expect({ status: result.status, stderr: result.stderr.trim().split('\n') }).toEqual({
      status: 0,
      stderr: ['pid-init: files not confined: the kernel has no Landlock', 'pid-init: /proc not hidden: the kernel has no Landlock', 'ran'],
    });
  });

  it('says nothing when the program is confined, and refuses a --check with a program after it', () => {
    expect(inNamespace(['--confine', '--write', own], ['sh', '-c', 'echo program-stderr >&2']).stderr).toBe('program-stderr\n');
    const usage = spawnSync(pidInit, ['--check', '--', 'true'], { encoding: 'utf8' });
    expect({ status: usage.status, stderr: usage.stderr }).toEqual({ status: 2, stderr: expect.stringContaining('usage: pid-init --check') });
  });
});
