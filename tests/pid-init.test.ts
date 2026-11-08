import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isProcessRunning } from './helpers/process-state';
import { skipUnless } from './helpers/strict-skip';

/**
 * pid-init (native/pid-init) as a program: the exit status or the signal of what it runs is its own, the program is PID 2 of a PID
 * namespace and its parent is PID 1, and what the program leaves behind ends with it. Every claim is read by the program itself or from
 * outside by this test, in the user namespace `unshare -r -n` makes, as the worker starts it.
 */

const C_COMPILER = process.env.CC ?? 'cc';
const compilerMissing = skipUnless('a C compiler (cc)', spawnSync(C_COMPILER, ['--version'], { stdio: 'ignore' }).status === 0);
const namespacesMissing = skipUnless(
  'unprivileged user and network namespaces (unshare -r -n)',
  process.platform === 'linux' && spawnSync('unshare', ['-r', '-n', '--', 'true'], { stdio: 'ignore' }).status === 0
);
const SIGNAL_NAME: Record<number, NodeJS.Signals> = { 9: 'SIGKILL', 11: 'SIGSEGV', 25: 'SIGXFSZ' };
const POLL_MS = 25;

let scratch = '';
let pidInit = '';

/** `unshare -r -n -- pid-init -- <command>`, the way the sandbox starts a program. */
function inNamespace(command: string[], input?: string) {
  return spawnSync('unshare', ['-r', '-n', '--', pidInit, '--', ...command], { encoding: 'utf8', input, timeout: 20_000 });
}

describe.skipIf(compilerMissing || namespacesMissing)('pid-init', () => {
  beforeAll(() => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'pid-init-test-'));
    pidInit = path.join(scratch, 'pid-init');
    const build = spawnSync(path.join(process.cwd(), 'native', 'pid-init', 'build.sh'), [pidInit], { encoding: 'utf8' });
    expect({ status: build.status, output: build.stderr + build.stdout }).toEqual({ status: 0, output: '' });
  });

  afterAll(() => {
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  it('runs the program as PID 2 of a PID namespace whose PID 1 is its parent', () => {
    const run = inNamespace(['sh', '-c', 'echo "$$ $PPID"']);
    expect({ status: run.status, out: run.stdout.trim() }).toEqual({ status: 0, out: '2 1' });
  });

  it('gives the program its standard input and output and its arguments', () => {
    const run = inNamespace(['sh', '-c', 'cat; echo "$1"', 'sh', 'argument'], 'from stdin\n');
    expect(run.stdout).toBe('from stdin\nargument\n');
  });

  it('ends with the exit status of the program', () => {
    expect(inNamespace(['sh', '-c', 'exit 3']).status).toBe(3);
    expect(inNamespace(['true']).status).toBe(0);
  });

  it.each([9, 11])('ends with signal %i when the program dies of it, as the program would outside a namespace', (signal) => {
    const run = inNamespace(['sh', '-c', `kill -${signal} $$`]);
    expect({ status: run.status, signal: run.signal }).toEqual({ status: null, signal: SIGNAL_NAME[signal] });
  });

  it('ends with SIGXFSZ when the program writes past its file size limit; the signal is not ignored as it is for PID 1', () => {
    const run = inNamespace(['sh', '-c', 'ulimit -f 1; exec head -c 100000 /dev/zero > "$0"', path.join(scratch, 'big')]);
    expect({ status: run.status, signal: run.signal }).toEqual({ status: null, signal: SIGNAL_NAME[25] });
  });

  it('says why a program cannot be run, with the status a shell uses', () => {
    const missing = inNamespace([path.join(scratch, 'no-such-program')]);
    expect({ status: missing.status, stderr: missing.stderr }).toEqual({ status: 127, stderr: expect.stringContaining('failed to execute') });
    const notExecutable = path.join(scratch, 'not-a-program');
    fs.writeFileSync(notExecutable, 'not a program', { mode: 0o644 });
    expect(inNamespace([notExecutable]).status).toBe(126);
  });

  it('refuses a command line without a program', () => {
    const run = spawnSync(pidInit, ['--'], { encoding: 'utf8' });
    expect({ status: run.status, stderr: run.stderr }).toEqual({ status: 2, stderr: expect.stringContaining('usage: pid-init') });
  });

  it('ends what the program left running when the program ends', async () => {
    const marker = path.join(scratch, 'left-running.pid');
    const run = inNamespace(['sh', '-c', `sleep 30 & echo $! > ${marker}`]);
    expect(run.status).toBe(0);
    // The id the program wrote belongs to the namespace; nothing outside it may be named by it, and no sleep of this run is left outside.
    expect(Number(fs.readFileSync(marker, 'utf8'))).toBe(3);
    expect(execFileSync('ps', ['-eo', 'args']).toString().split('\n').filter((line) => line.includes('sleep 30') && line.includes(scratch))).toEqual([]);
  });

  it('ends the program when it is killed with its process group, and when only the process outside the namespace is killed', async () => {
    const pidFile = path.join(scratch, 'victim.pid');
    // A shell that is the program: its own id inside the namespace is written, and the host id is found as the child of PID 1 below.
    const child = spawn('unshare', ['-r', '-n', '--', pidInit, '--', 'sh', '-c', `echo ready > ${pidFile}; exec sleep 60`], { stdio: 'ignore', detached: true });
    const deadline = Date.now() + 10_000;
    while (!fs.existsSync(pidFile) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    const children = (pid: number): number[] =>
      fs.readFileSync(`/proc/${pid}/task/${pid}/children`, 'utf8').trim().split(/\s+/).filter(Boolean).map(Number);
    const [init] = children(child.pid!);
    const [program] = children(init);
    expect(fs.readFileSync(`/proc/${program}/cmdline`, 'utf8')).toContain('sleep');
    process.kill(child.pid!, 'SIGKILL');
    // A killed process that nobody has reaped yet is a zombie, not a running one: the helper reads its state instead of signalling it.
    const alive = isProcessRunning;
    const end = Date.now() + 5000;
    while ((alive(init) || alive(program)) && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    expect({ init: alive(init), program: alive(program) }).toEqual({ init: false, program: false });
  });
});
