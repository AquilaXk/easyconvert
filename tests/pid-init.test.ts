import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isProcessRunning, processesWithArgument, uniqueSleepInterval, waitUntilNoProcessWithArgument } from './helpers/process-state';
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
/** Starts that are killed at a random moment of their first milliseconds; the window the test aims at is a few microseconds, and a start takes about a millisecond. */
const EARLY_KILL_STARTS = 400;
const EARLY_KILL_MAX_DELAY_MS = 6;
/** Hang guard of the wait for a killed start to leave nothing behind: it is gone within milliseconds, this only ends a wait that never would. */
const LEFTOVER_HANG_GUARD_MS = 10_000;

/** Hang guard of one run of a program that takes milliseconds: it only ends a run that would never end. */
const RUN_HANG_GUARD_MS = 20_000;

/** Whether the kernel's caches can be dropped by this test: it runs as root, or sudo asks for no password. */
function canDropCaches(): boolean {
  if (process.platform !== 'linux') return false;
  return spawnSync('sudo', ['-n', 'true'], { stdio: 'ignore' }).status === 0;
}

let scratch = '';
let pidInit = '';
let denyBinary = '';

/** `unshare -r -n -- pid-init [options] -- <command>`, the way the sandbox starts a program. */
function inNamespace(command: string[], input?: string, options: string[] = [], prefix: string[] = []) {
  return spawnSync('unshare', ['-r', '-n', '--', ...prefix, pidInit, ...options, '--', ...command], { encoding: 'utf8', input, timeout: RUN_HANG_GUARD_MS });
}

describe.skipIf(compilerMissing || namespacesMissing)('pid-init', () => {
  beforeAll(() => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'pid-init-test-'));
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

  it('leaves nothing running when the process outside is killed at any moment of the start', async () => {
    // PID 1 asks for its signal of the death of its parent after the fork. A parent that died in between would leave PID 1 and the program running with nobody
    // to report to; PID 1 sees the closed pipe and ends. Killing at random moments in the first milliseconds reaches that window now and then.
    const interval = uniqueSleepInterval();
    try {
      for (let start = 0; start < EARLY_KILL_STARTS; start++) {
        const child = spawn('unshare', ['-r', '-n', '--', pidInit, '--', 'sleep', interval], { stdio: 'ignore' });
        const ended = new Promise((resolve) => child.once('exit', resolve));
        setTimeout(() => child.kill('SIGKILL'), Math.random() * EARLY_KILL_MAX_DELAY_MS);
        await ended;
      }
      expect(await waitUntilNoProcessWithArgument(interval, LEFTOVER_HANG_GUARD_MS)).toBe(true);
    } finally {
      for (const pid of processesWithArgument(interval)) process.kill(pid, 'SIGKILL');
    }
  }, 60_000);
  describe('the /proc entries of other processes', () => {
    /** A process outside the namespace that stands for another run: it is not the program's own, and its command line holds a marker. */
    let sibling: ReturnType<typeof spawn> | undefined;

    beforeAll(() => {
      sibling = spawn('sleep', [uniqueSleepInterval()], { stdio: 'ignore' });
    });

    afterAll(() => {
      sibling?.kill('SIGKILL');
    });

    /** What a program reports about a sibling and about itself: the first line of each file, or the error. */
    const REPORT = [
      'for file in "/proc/$0/cmdline" "/proc/$0/status"; do',
      '  if ( : < "$file" ) 2>/dev/null; then echo "read $file"; else echo "denied $file"; fi',
      'done',
      'if echo 1000 > "/proc/$0/oom_score_adj" 2>/dev/null; then echo "wrote oom_score_adj"; else echo "denied oom_score_adj"; fi',
      'read -r own < /proc/self/status && echo "own status"',
      'read -r total < /proc/meminfo && echo "meminfo"',
      ': < /proc/sys/kernel/pid_max && echo "sysctl"',
      'ls /proc/self/task > /dev/null && echo "own tasks"',
      'kill -CONT "$0" 2>/dev/null && echo "can signal" || echo "cannot signal"',
    ].join('\n');

    const report = (options: string[], prefix: string[] = []) => {
      const run = inNamespace(['sh', '-c', REPORT, String(sibling!.pid)], undefined, options, prefix);
      return { status: run.status, lines: run.stdout.trim().split('\n') };
    };
    const target = () => String(sibling!.pid);

    it('control: with --keep-proc the program reads the command line and the status of another process and writes its OOM score', () => {
      expect(report(['--keep-proc'])).toEqual({
        status: 0,
        lines: [`read /proc/${target()}/cmdline`, `read /proc/${target()}/status`, 'wrote oom_score_adj', 'own status', 'meminfo', 'sysctl', 'own tasks', 'cannot signal'],
      });
    });

    it('refuses the command line, the status and the OOM score of another process, and leaves the program its own and the system-wide entries', () => {
      expect(report([])).toEqual({
        status: 0,
        lines: [`denied /proc/${target()}/cmdline`, `denied /proc/${target()}/status`, 'denied oom_score_adj', 'own status', 'meminfo', 'sysctl', 'own tasks', 'cannot signal'],
      });
    });

    it('hides them without a PID namespace too (--no-pid-namespace), and runs the program in place', () => {
      const hidden = report(['--no-pid-namespace']);
      expect(hidden.lines).toEqual([`denied /proc/${target()}/cmdline`, `denied /proc/${target()}/status`, 'denied oom_score_adj', 'own status', 'meminfo', 'sysctl', 'own tasks', 'can signal']);
      // In place: no PID 1 stands between, so the parent of the program is the `unshare` it was started through, in the namespace of the caller.
      const parent = inNamespace(['sh', '-c', 'echo "$PPID"'], undefined, ['--no-pid-namespace']);
      expect(Number(parent.stdout.trim())).toBeGreaterThan(1);
    });

    it('keeps /proc/self for the program, which the PID namespace names by the number outside it', () => {
      const run = inNamespace(['sh', '-c', 'read -r name < /proc/self/status && echo "$name" && read -r stat < /proc/self/stat && echo stat']);
      expect({ status: run.status, out: run.stdout.trim().split('\n') }).toEqual({ status: 0, out: ['Name:\tsh', 'stat'] });
    });

    it('--check exits 0 when the ruleset can be made and 3 when the kernel call is refused', () => {
      expect(spawnSync('unshare', ['-r', '-n', '--', pidInit, '--check'], { encoding: 'utf8', timeout: RUN_HANG_GUARD_MS }).status).toBe(0);
      const refused = spawnSync(denyBinary, ['landlock_create_ruleset', '/usr/bin/unshare', '-r', '-n', '--', pidInit, '--check'], { encoding: 'utf8', timeout: RUN_HANG_GUARD_MS });
      expect(refused.status).toBe(3);
    });

    it('runs the program without the ruleset where the kernel call is refused', () => {
      const refused = spawnSync(
        denyBinary,
        ['landlock_create_ruleset', '/usr/bin/unshare', '-r', '-n', '--', pidInit, '--', 'sh', '-c', REPORT, String(sibling!.pid)],
        { encoding: 'utf8', timeout: RUN_HANG_GUARD_MS }
      );
      expect({ status: refused.status, lines: refused.stdout.trim().split('\n').slice(0, 3) }).toEqual({
        status: 0,
        lines: [`read /proc/${target()}/cmdline`, `read /proc/${target()}/status`, 'wrote oom_score_adj'],
      });
      // It says so, on the first line of the standard error of the program, which the worker takes off and logs.
      expect(refused.stderr.split('\n')[0]).toBe('pid-init: /proc not hidden: the kernel has no Landlock');
    });

    it('says nothing on the standard error when the ruleset is in force or --keep-proc leaves /proc alone', () => {
      expect(inNamespace(['sh', '-c', 'echo "$0" >&2', 'program-stderr']).stderr).toBe('program-stderr\n');
      expect(inNamespace(['sh', '-c', 'echo "$0" >&2', 'program-stderr'], undefined, ['--keep-proc']).stderr).toBe('program-stderr\n');
    });

    /** Moves a file and links one between two directories with the calls themselves (a shell's mv falls back to copying on EXDEV). */
    const MOVE_SCRIPT = [
      "const fs = require('node:fs'), path = require('node:path');",
      'const [a, b] = [process.argv[1], process.argv[2]];',
      "fs.mkdirSync(a); fs.mkdirSync(b); fs.writeFileSync(path.join(a, 'f'), 'x');",
      "fs.linkSync(path.join(a, 'f'), path.join(b, 'link'));",
      "fs.renameSync(path.join(a, 'f'), path.join(b, 'f'));",
      "console.log(fs.readFileSync(path.join(b, 'f'), 'utf8') + fs.readFileSync(path.join(b, 'link'), 'utf8'));",
    ].join('\n');

    it.each([
      ['in a PID namespace', []],
      ['without one', ['--no-pid-namespace']],
    ])('lets the program rename and link files between directories %s (a ruleset that did not handle moves would refuse them with EXDEV)', (_name, options) => {
      const dir = fs.mkdtempSync(path.join(scratch, 'move-'));
      const run = inNamespace([process.execPath, '-e', MOVE_SCRIPT, path.join(dir, 'from'), path.join(dir, 'to')], undefined, options);
      expect({ status: run.status, out: run.stdout.trim(), err: run.stderr }).toEqual({ status: 0, out: 'xx', err: '' });
    });

    it('keeps the /proc entries of the ruleset open: in PID 1 of the namespace, and in the program itself when it has none', () => {
      /** The descriptors a program lists for itself (`ls` is the program), as [number, target], without the directory `ls` is reading. */
      const held = (options: string[]): Array<[number, string]> =>
        [...inNamespace(['ls', '-l', '/proc/self/fd'], undefined, options).stdout.matchAll(/ (\d+) -> (\S+)$/gm)]
          .map((match): [number, string] => [Number(match[1]), match[2]])
          .filter(([, target]) => target.startsWith('/proc/') && !target.endsWith('/fd'));
      const alone = held(['--no-pid-namespace']);
      expect(alone.length).toBeGreaterThan(10);
      expect(alone.every(([fd]) => fd >= 200)).toBe(true);
      // In a PID namespace PID 1 holds them and the program carries none.
      expect(held([])).toEqual([]);
    });

    // skip-ok: forcing the kernel to drop its cached /proc entries needs root (drop_caches); CI has passwordless sudo, and skipUnless fails the run under ORACLE_STRICT_MODE=1 without it.
    describe.skipIf(skipUnless('root or passwordless sudo for drop_caches', canDropCaches()))('after the kernel dropped its cached /proc entries', () => {
      it.each([
        ['in a PID namespace', []],
        ['without one', ['--no-pid-namespace']],
      ])('the program still reads its own and the system-wide /proc entries %s', async (_name, options) => {
        const script = [
          'check() { if read -r line < "$1"; then echo "$1 ok"; else echo "$1 denied"; fi; }',
          'echo ready',
          'read go',
          'for file in /proc/self/status /proc/thread-self/stat /proc/meminfo /proc/cpuinfo /proc/net/dev /proc/mounts /proc/uptime; do check "$file"; done',
        ].join('\n');
        const child = spawn('unshare', ['-r', '-n', '--', pidInit, ...options, '--', 'sh', '-c', script], { stdio: ['pipe', 'pipe', 'pipe'] });
        let out = '';
        child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString()));
        const ended = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)));
        const deadline = Date.now() + RUN_HANG_GUARD_MS;
        while (!out.includes('ready') && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, POLL_MS));
        // Twice, as one pass leaves some entries behind.
        for (let pass = 0; pass < 2; pass++) execFileSync('sudo', ['-n', 'sh', '-c', 'echo 3 > /proc/sys/vm/drop_caches']);
        child.stdin.end('go\n');
        expect(await ended).toBe(0);
        const lines = out.trim().split('\n').slice(1);
        expect(lines).toEqual(['/proc/self/status ok', '/proc/thread-self/stat ok', '/proc/meminfo ok', '/proc/cpuinfo ok', '/proc/net/dev ok', '/proc/mounts ok', '/proc/uptime ok']);
      }, 40_000);
    });
  });
});
