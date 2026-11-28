import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { skipUnless } from './helpers/strict-skip';

/**
 * `pid-init --userns-net` and `--rlimit` (native/pid-init): the launcher makes the user and network namespaces and sets the limits itself, in the place of
 * `unshare -r -n` and `prlimit`. Every claim is read by the program itself (a shell that `exec`s `cat` of its own /proc files, so that /proc/self is the
 * program) and, where the chain made the same thing before, compared with what `unshare -r -n -- pid-init -- prlimit` gives.
 */

const C_COMPILER = process.env.CC ?? 'cc';
const compilerMissing = skipUnless('a C compiler (cc)', spawnSync(C_COMPILER, ['--version'], { stdio: 'ignore' }).status === 0);
const namespacesMissing = skipUnless(
  'unprivileged user and network namespaces (unshare -r -n)',
  process.platform === 'linux' && spawnSync('unshare', ['-r', '-n', '--', 'true'], { stdio: 'ignore' }).status === 0
);
/** Hang guard of one run of a program that takes milliseconds: it only ends a run that would never end. */
const RUN_HANG_GUARD_MS = 20_000;
const MIB = 1024 * 1024;
const LIMIT_LINE = /^Max (cpu time|file size|core file size|processes|address space)\s+(\S+)\s+(\S+)/;

let scratch = '';
let pidInit = '';
let denyBinary = '';

/** `pid-init --userns-net [options] -- <command>`, started by this process directly: no `unshare` in front of it. */
function launched(command: string[], options: string[] = []) {
  return spawnSync(pidInit, ['--userns-net', ...options, '--', ...command], { encoding: 'utf8', timeout: RUN_HANG_GUARD_MS });
}

/** The program reads a file of /proc/self: it is the program, not a child of a shell, because a child has a /proc directory the ruleset does not name. */
function readsOwn(file: string): string[] {
  return ['sh', '-c', `exec cat /proc/self/${file}`];
}

/** The soft and the hard limit of the five resources, by name, as the program reads them. */
function limitsOf(output: string): Record<string, string> {
  return Object.fromEntries(output.split('\n').flatMap((line) => { const match = LIMIT_LINE.exec(line); return match ? [[match[1], `${match[2]}:${match[3]}`]] : []; }));
}

const LIMITS = ['--rlimit', `as=${1024 * MIB}:${1024 * MIB}`, '--rlimit', 'fsize=1000000:1000000', '--rlimit', 'nproc=200:200', '--rlimit', 'cpu=60:60', '--rlimit', 'core=0:0'];
const PRLIMITS = [`--as=${1024 * MIB}`, '--fsize=1000000', '--nproc=200', '--cpu=60', '--core=0'];
const EXPECTED_LIMITS = { 'address space': `${1024 * MIB}:${1024 * MIB}`, 'file size': '1000000:1000000', processes: '200:200', 'cpu time': '60:60', 'core file size': '0:0' };

describe.skipIf(compilerMissing || namespacesMissing)('pid-init --userns-net and --rlimit', () => {
  beforeAll(() => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'pid-init-userns-'));
    pidInit = path.join(scratch, 'pid-init');
    const build = spawnSync(path.join(process.cwd(), 'native', 'pid-init', 'build.sh'), [pidInit], { encoding: 'utf8' });
    expect({ status: build.status, output: build.stderr + build.stdout }).toEqual({ status: 0, output: '' });
    denyBinary = path.join(scratch, 'seccomp-deny');
    const deny = spawnSync(C_COMPILER, ['-O2', '-o', denyBinary, path.join(process.cwd(), 'tests', 'helpers', 'seccomp-deny.c')], { encoding: 'utf8' });
    expect({ status: deny.status, output: deny.stderr }).toEqual({ status: 0, output: '' });
  });

  afterAll(() => {
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  it('maps the user and the group of the caller to root, as unshare -r does, and denies setgroups', () => {
    const outside = { uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0 };
    expect(launched(['id', '-u']).stdout.trim()).toBe('0');
    expect(launched(['id', '-g']).stdout.trim()).toBe('0');
    const maps = (name: string) => launched(readsOwn(name)).stdout.trim().split(/\s+/).join(' ');
    expect(maps('uid_map')).toBe(`0 ${outside.uid} 1`);
    expect(maps('gid_map')).toBe(`0 ${outside.gid} 1`);
    expect(maps('setgroups')).toBe('deny');
    const chain = spawnSync('unshare', ['-r', '-n', '--', pidInit, '--', ...readsOwn('uid_map')], { encoding: 'utf8', timeout: RUN_HANG_GUARD_MS });
    expect(maps('uid_map')).toBe(chain.stdout.trim().split(/\s+/).join(' '));
  });

  it('gives the program a network namespace of its own that has the loopback interface and no other', () => {
    const run = launched(readsOwn('net/dev'));
    expect(run.status).toBe(0);
    const interfaces = run.stdout.split('\n').slice(2).map((line) => line.split(':')[0].trim()).filter(Boolean);
    expect(interfaces).toEqual(['lo']);
  });

  it('runs the program as PID 2 of a PID namespace, as it is when unshare and pid-init start it', () => {
    const run = launched(['sh', '-c', 'echo "$$ $PPID"']);
    expect({ status: run.status, out: run.stdout.trim() }).toEqual({ status: 0, out: '2 1' });
  });

  it('sets the limits on the program: what /proc/self/limits shows is what prlimit sets in the chain', () => {
    const run = launched(readsOwn('limits'), LIMITS);
    expect(run.status).toBe(0);
    expect(limitsOf(run.stdout)).toEqual(EXPECTED_LIMITS);
    const chain = spawnSync('unshare', ['-r', '-n', '--', pidInit, '--', 'prlimit', ...PRLIMITS, '--', ...readsOwn('limits')], { encoding: 'utf8', timeout: RUN_HANG_GUARD_MS });
    expect(limitsOf(chain.stdout)).toEqual(limitsOf(run.stdout));
  });

  it('sets the limits on the program alone: PID 1 of the namespace and the process outside it fork before the limit is there', () => {
    // A launcher that held the task limit itself could not fork PID 1 and the program; the program starts, and a process of its own is then refused.
    expect(launched(['true'], ['--rlimit', 'nproc=1:1']).status).toBe(0);
    const forks = launched(['sh', '-c', '/bin/true; exit $?'], ['--rlimit', 'nproc=1:1']);
    expect(forks.status).not.toBe(0);
    expect(launched(['sh', '-c', '/bin/true; exit $?']).status).toBe(0);
  });

  it('takes `unlimited` and a soft limit below the hard one', () => {
    const run = launched(readsOwn('limits'), ['--rlimit', 'core=unlimited:unlimited', '--rlimit', 'cpu=30:90']);
    expect(limitsOf(run.stdout)).toMatchObject({ 'core file size': 'unlimited:unlimited', 'cpu time': '30:90' });
  });

  it('does not start the program when a limit cannot be set, and says which', () => {
    const marker = path.join(scratch, 'must-not-exist');
    const run = launched(['sh', '-c', `echo ran > ${marker}`], ['--rlimit', 'as=100:50']);
    expect({ status: run.status, stderr: run.stderr }).toEqual({ status: 125, stderr: expect.stringContaining('pid-init: cannot set the as limit') });
    expect(fs.existsSync(marker)).toBe(false);
  });

  it.each([['an unknown resource', 'stack=1:1'], ['one limit only', 'as=1'], ['a sign', 'as=-1:-1'], ['an empty limit', 'as=:1'], ['a word', 'as=big:big'], ['no resource', '=1:1']])('refuses %s of --rlimit with the usage status', (_name, spec) => {
    const run = launched(['true'], ['--rlimit', spec]);
    expect({ status: run.status, stderr: run.stderr }).toEqual({ status: 2, stderr: expect.stringContaining('--rlimit takes') });
  });

  it('refuses more --rlimit options than it has room for', () => {
    const many = Array.from({ length: 17 }, () => ['--rlimit', 'core=0:0']).flat();
    expect(launched(['true'], many).status).toBe(2);
  });

  it('says it cannot make the namespaces, with the refusal status, and starts nothing, when the host denies unshare', () => {
    const marker = path.join(scratch, 'must-not-exist-either');
    const refused = spawnSync(denyBinary, ['unshare', pidInit, '--userns-net', '--', 'sh', '-c', `echo ran > ${marker}`], { encoding: 'utf8', timeout: RUN_HANG_GUARD_MS });
    expect({ status: refused.status, stderr: refused.stderr }).toEqual({ status: 125, stderr: expect.stringContaining('pid-init: cannot make a user and network namespace') });
    expect(fs.existsSync(marker)).toBe(false);
  });

  it('works with --no-pid-namespace: the program is root in the namespaces and is not PID 2', () => {
    const run = launched(['sh', '-c', 'echo "$(id -u) $$"'], ['--no-pid-namespace', '--rlimit', 'core=0:0']);
    const [uid, pid] = run.stdout.trim().split(' ');
    expect({ status: run.status, uid }).toEqual({ status: 0, uid: '0' });
    expect(Number(pid)).toBeGreaterThan(2);
    expect(limitsOf(launched(readsOwn('limits'), ['--no-pid-namespace', ...LIMITS]).stdout)).toEqual(EXPECTED_LIMITS);
  });

  it('keeps the confinement and the hiding of /proc: the program reads no other process', () => {
    const work = path.join(scratch, 'work');
    fs.mkdirSync(work);
    const run = launched(['sh', '-c', 'cat /proc/1/cmdline; echo "status $?"'], ['--confine', '--require', '--write', work, '--rlimit', 'core=0:0']);
    expect(run.stdout + run.stderr).toMatch(/Permission denied/);
    const outside = launched(['sh', '-c', `echo x > ${path.join(scratch, 'outside')}`], ['--confine', '--require', '--write', work]);
    expect(outside.status).not.toBe(0);
    expect(fs.existsSync(path.join(scratch, 'outside'))).toBe(false);
  });

  it('ends with the exit status and the signal of the program, and says why one cannot be run', () => {
    expect(launched(['sh', '-c', 'exit 3']).status).toBe(3);
    const killed = launched(['sh', '-c', 'kill -11 $$']);
    expect({ status: killed.status, signal: killed.signal }).toEqual({ status: null, signal: 'SIGSEGV' });
    const missing = launched([path.join(scratch, 'no-such-program')]);
    expect({ status: missing.status, stderr: missing.stderr }).toEqual({ status: 127, stderr: expect.stringContaining('failed to execute') });
  });

  it('asks whether the rulesets can be made from inside the namespaces it makes: --check with --userns-net', () => {
    expect([0, 3]).toContain(spawnSync(pidInit, ['--userns-net', '--check'], { encoding: 'utf8', timeout: RUN_HANG_GUARD_MS }).status);
    expect(spawnSync(pidInit, ['--userns-net', '--check', '--', 'true'], { encoding: 'utf8', timeout: RUN_HANG_GUARD_MS }).status).toBe(2);
  });

  it('is not understood by a launcher that predates it, which says its usage and exits 2, so the probe falls back to the chain', () => {
    // The existing chain stays valid with the new binary: nothing of the old command line changed.
    const chain = spawnSync('unshare', ['-r', '-n', '--', pidInit, '--', 'sh', '-c', 'echo "$$ $(id -u)"'], { encoding: 'utf8', timeout: RUN_HANG_GUARD_MS });
    expect({ status: chain.status, out: chain.stdout.trim() }).toEqual({ status: 0, out: '2 0' });
  });
});
