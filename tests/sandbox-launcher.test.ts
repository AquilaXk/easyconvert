import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  launchPays,
  launchSandboxedBinary,
  sandboxLauncherState,
  startSandboxLauncher,
  stopSandboxLauncher,
} from '../src/lib/security/sandbox-launcher';
import {
  SandboxedBufferLimitError,
  SandboxedProcessError,
  SandboxedTimeoutError,
} from '../src/lib/security/process-sandbox';
import { SandboxUnavailableError } from '../src/lib/types';

/**
 * The launcher runs a sandboxed binary from a small helper process, so the fork that starts it does not copy the
 * address space of a large worker. The oracle for "it ran in the helper" is the parent process id the program reports
 * about itself (`$PPID`), which no code of this module sets.
 */

const SH = '/bin/sh';

/** Whether this host lets an unprivileged process create a user and network namespace, which is what the network isolation of a program needs. */
const canIsolateNetwork = process.platform === 'linux' && spawnSync('unshare', ['-r', '-n', '--', 'true'], { stdio: 'ignore' }).status === 0;

/** These tests are about the helper, so they say the output is small: that is the case in which it pays. */
const launch: typeof launchSandboxedBinary = (binary, args, options = {}) => launchSandboxedBinary(binary, args, { expectedOutputBytes: 0, ...options });

function shell(script: string): string[] {
  return ['-c', script];
}

describe('sandbox launcher', () => {
  beforeAll(async () => {
    // A worker's size, so that the helper is judged worth it whatever this test process holds.
    vi.spyOn(process.memoryUsage, 'rss').mockReturnValue(1024 * 1024 * 1024);
    expect(await startSandboxLauncher()).toBe(true);
  }, 60_000);

  afterEach(async () => {
    // A test that stopped the helper, or killed it, leaves the next one a running one.
    if (!sandboxLauncherState().ready) {
      stopSandboxLauncher();
      await startSandboxLauncher();
    }
  });

  afterAll(() => {
    vi.restoreAllMocks();
    stopSandboxLauncher();
  });

  it('starts the program from the helper process, not from this one', async () => {
    const result = await launch(SH, shell('echo $PPID'), { networkIsolated: false });
    const parent = Number.parseInt(result.stdout.toString('utf8').trim(), 10);
    const state = sandboxLauncherState();
    expect(state.pid).toBeDefined();
    expect(parent).toBe(state.pid);
    expect(parent).not.toBe(process.pid);
  });

  it('returns standard output, standard error and the exit status of a program that succeeds', async () => {
    const result = await launch(SH, shell('printf out; printf err >&2'), { networkIsolated: false });
    expect(result.stdout.toString('utf8')).toBe('out');
    expect(result.stderr.toString('utf8')).toBe('err');
    expect(result.exitCode).toBe(0);
  });

  it('hands standard input to the program', async () => {
    const result = await launch('/bin/cat', [], { networkIsolated: false, stdin: Buffer.from('through the pipe') });
    expect(result.stdout.toString('utf8')).toBe('through the pipe');
  });

  it('keeps a large output intact (checked against the hash of the bytes the program was asked to write)', async () => {
    const size = 6 * 1024 * 1024;
    const result = await launch('/usr/bin/head', ['-c', String(size), '/dev/zero'], { networkIsolated: false, maxBuffer: size + 1024 });
    expect(result.stdout.length).toBe(size);
    expect(crypto.createHash('sha256').update(result.stdout).digest('hex')).toBe(crypto.createHash('sha256').update(Buffer.alloc(size)).digest('hex'));
  });

  it('reports a failing program as SandboxedProcessError with its status, stderr and stdout', async () => {
    const error = await launch(SH, shell('printf partial; printf boom >&2; exit 3'), { networkIsolated: false }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SandboxedProcessError);
    const failure = error as SandboxedProcessError;
    expect(failure.exitCode).toBe(3);
    expect(failure.stderr).toBe('boom');
    expect(failure.stdout).toBe('partial');
  });

  it('keeps a failing program\'s long stderr whole at both ends, and its neighbours unharmed', async () => {
    // 2 MiB of stderr between a recognisable head and tail, then a failure: far past the 1 MiB a frame header may hold.
    const noisy = launch(SH, shell("printf HEAD-MARK >&2; head -c 2097152 /dev/zero | tr '\\0' x >&2; printf TAIL-MARK >&2; exit 3"), { networkIsolated: false });
    const neighbour = launch(SH, shell('sleep 0.3; echo neighbour-done'), { networkIsolated: false });
    const [failure, fine] = await Promise.all([noisy.catch((e: unknown) => e), neighbour]);
    expect(fine.stdout.toString('utf8').trim()).toBe('neighbour-done');
    const error = failure as SandboxedProcessError;
    expect(error).toBeInstanceOf(SandboxedProcessError);
    expect(error.exitCode).toBe(3);
    expect(error.stderr.startsWith('HEAD-MARK')).toBe(true);
    expect(error.stderr.endsWith('TAIL-MARK')).toBe(true);
    expect(error.stderr.length).toBeLessThan(1024 * 1024);
    // The helper stayed up for the next request.
    expect(sandboxLauncherState().ready).toBe(true);
    const next = await launch(SH, shell('echo after-noise'), { networkIsolated: false });
    expect(next.stdout.toString('utf8').trim()).toBe('after-noise');
  });

  it('keeps the text a caller matches on in a short stderr exactly as the program wrote it', async () => {
    const error = (await launch(SH, shell("printf 'qpdf: in.pdf: invalid password' >&2; exit 2"), { networkIsolated: false }).catch((e: unknown) => e)) as SandboxedProcessError;
    expect(error.stderr).toBe('qpdf: in.pdf: invalid password');
    expect(error.message).toBe('qpdf: in.pdf: invalid password');
  });

  it('reports a program that does not exist as the typed 127 failure', async () => {
    const error = await launch('/nonexistent/program', [], { networkIsolated: false }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SandboxedProcessError);
    expect((error as SandboxedProcessError).exitCode).toBe(127);
  });

  it('stops a program that runs past its time limit and reports SandboxedTimeoutError', async () => {
    const started = Date.now();
    const error = await launch(SH, shell('sleep 30'), { networkIsolated: false, timeoutMs: 300 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SandboxedTimeoutError);
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('stops a program whose output passes the buffer limit and reports SandboxedBufferLimitError', async () => {
    const error = await launch('/usr/bin/head', ['-c', '2000000', '/dev/zero'], { networkIsolated: false, maxBuffer: 100_000 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SandboxedBufferLimitError);
    expect((error as SandboxedBufferLimitError).limitBytes).toBe(100_000);
  });

  it('kills the program and rejects with the signal reason when the caller aborts', async () => {
    const controller = new AbortController();
    const marker = `launcher-abort-${crypto.randomUUID()}`;
    const running = launch(SH, shell(`sleep 30; echo ${marker}`), { networkIsolated: false, signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 300));
    controller.abort(new Error('job cancelled'));
    await expect(running).rejects.toThrow('job cancelled');
    // `pgrep -f` matches the command line, which carries the marker: nothing may be left running.
    await new Promise((resolve) => setTimeout(resolve, 300));
    const { spawnSync } = await import('node:child_process');
    expect(spawnSync('/usr/bin/pgrep', ['-f', marker]).status).toBe(1);
  });

  it('rejects at once for a signal that is already aborted', async () => {
    const controller = new AbortController();
    controller.abort(new Error('already cancelled'));
    await expect(launch(SH, shell('echo never'), { networkIsolated: false, signal: controller.signal })).rejects.toThrow('already cancelled');
  });

  it('serves requests that overlap, each with its own output', async () => {
    const results = await Promise.all(Array.from({ length: 12 }, (_, index) => launch(SH, shell(`sleep 0.0${index % 3}; echo job-${index}`), { networkIsolated: false })));
    expect(results.map((result) => result.stdout.toString('utf8').trim())).toEqual(Array.from({ length: 12 }, (_, index) => `job-${index}`));
  });

  it('gives the program the sanitized environment, without the secrets of this process', async () => {
    process.env.LAUNCHER_TEST_SECRET_TOKEN = 'must-not-reach-the-program';
    try {
      const result = await launch('/usr/bin/env', [], { networkIsolated: false, env: { LAUNCHER_VISIBLE: 'yes', LAUNCHER_API_KEY: 'dropped-too' } });
      const lines = result.stdout.toString('utf8').split('\n');
      expect(lines).toContain('LAUNCHER_VISIBLE=yes');
      expect(lines.filter((line) => line.includes('must-not-reach-the-program') || line.includes('dropped-too'))).toEqual([]);
    } finally {
      delete process.env.LAUNCHER_TEST_SECRET_TOKEN;
    }
  });

  it('runs the program in the working directory it is given', async () => {
    const result = await launch('/bin/pwd', [], { networkIsolated: false, cwd: '/' });
    expect(result.stdout.toString('utf8').trim()).toBe('/');
  });

  // The interfaces of the network namespace of the process that reads /proc/net/dev (not /sys/class/net, which shows the namespace sysfs was mounted in).
  const INTERFACES_SCRIPT = "tail -n +3 /proc/net/dev | cut -d: -f1 | tr -d ' '";

  it('keeps the isolation of the network: an empty namespace where the host can make one, the typed refusal under strict isolation where it cannot', async () => {
    const hostInterfaces = spawnSync(SH, shell(INTERFACES_SCRIPT), { encoding: 'utf8' }).stdout.split('\n').filter(Boolean);
    const listed = (stdout: Buffer): string[] => stdout.toString('utf8').split('\n').filter(Boolean);
    if (canIsolateNetwork) {
      // The oracle: this host has an interface besides the loopback; a fresh namespace has the loopback alone.
      expect(hostInterfaces.length).toBeGreaterThan(1);
      const isolated = await launch(SH, shell(INTERFACES_SCRIPT), { networkIsolated: true, strictIsolation: true });
      expect(listed(isolated.stdout)).toEqual(['lo']);
      const open = await launch(SH, shell(INTERFACES_SCRIPT), { networkIsolated: false });
      expect(listed(open.stdout)).toEqual(hostInterfaces);
    } else {
      const error = (await launch(SH, shell('echo must-not-run'), { networkIsolated: true, strictIsolation: true }).catch((e: unknown) => e)) as Error;
      expect({ name: error.name, message: error.message }).toEqual({
        name: 'SandboxUnavailableError',
        message: expect.stringContaining('Strict network isolation failed'),
      });
    }
  });

  it('applies STRICT_SANDBOX of this process, which the helper does not inherit', async () => {
    process.env.STRICT_SANDBOX = 'true';
    try {
      const outcome = await launch(SH, shell(INTERFACES_SCRIPT), { networkIsolated: true }).then(
        (result) => ({ ran: true, interfaces: result.stdout.toString('utf8').split('\n').filter(Boolean) }),
        (error: Error) => ({ ran: false, name: error.name })
      );
      expect(outcome).toEqual(canIsolateNetwork ? { ran: true, interfaces: ['lo'] } : { ran: false, name: 'SandboxUnavailableError' });
    } finally {
      delete process.env.STRICT_SANDBOX;
    }
  });

  it('fails the requests in flight when the helper dies, and serves the next one', async () => {
    const running = launch(SH, shell('sleep 30'), { networkIsolated: false, timeoutMs: 60_000 });
    await new Promise((resolve) => setTimeout(resolve, 300));
    const pid = sandboxLauncherState().pid as number;
    process.kill(pid, 'SIGKILL');
    await expect(running).rejects.toBeInstanceOf(SandboxedProcessError);
    expect(sandboxLauncherState().ready).toBe(false);
    // A helper that ended by itself is not replaced at once: until the backoff is over (or the launcher is reset),
    // programs run directly and no new helper starts.
    expect(await startSandboxLauncher()).toBe(false);
    const launchedBefore = sandboxLauncherState().launched;
    const next = await launch(SH, shell('echo $PPID'), { networkIsolated: false });
    expect(Number.parseInt(next.stdout.toString('utf8').trim(), 10)).toBe(process.pid);
    expect(sandboxLauncherState()).toMatchObject({ ready: false, pid: undefined, launched: launchedBefore });
    stopSandboxLauncher();
    expect(await startSandboxLauncher()).toBe(true);
    expect(sandboxLauncherState().pid).not.toBe(pid);
  });

  it('ends the helper when it is stopped, and the program it still runs with it', async () => {
    const marker = `launcher-stop-${crypto.randomUUID()}`;
    const running = launch(SH, shell(`sleep 30; echo ${marker}`), { networkIsolated: false, timeoutMs: 60_000 });
    running.catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const pid = sandboxLauncherState().pid as number;
    stopSandboxLauncher();
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(() => process.kill(pid, 0)).toThrow();
    const { spawnSync } = await import('node:child_process');
    expect(spawnSync('/usr/bin/pgrep', ['-f', marker]).status).toBe(1);
  });

  it('runs a program directly while no helper is ready, with the same result', async () => {
    stopSandboxLauncher();
    expect(sandboxLauncherState().ready).toBe(false);
    const result = await launch(SH, shell('echo $PPID'), { networkIsolated: false });
    expect(Number.parseInt(result.stdout.toString('utf8').trim(), 10)).toBe(process.pid);
  });

  it('runs every program directly when the launcher is turned off', async () => {
    process.env.SANDBOX_LAUNCHER = 'off';
    try {
      expect(await startSandboxLauncher()).toBe(false);
      const result = await launch(SH, shell('echo $PPID'), { networkIsolated: false });
      expect(Number.parseInt(result.stdout.toString('utf8').trim(), 10)).toBe(process.pid);
    } finally {
      delete process.env.SANDBOX_LAUNCHER;
    }
  });

  it('runs a program with a large output directly, where the copy through the helper would cost more than the fork', async () => {
    const result = await launchSandboxedBinary(SH, shell('echo $PPID'), { networkIsolated: false, maxBuffer: 512 * 1024 * 1024 });
    expect(Number.parseInt(result.stdout.toString('utf8').trim(), 10)).toBe(process.pid);
  });

  it('starts a program through the helper only when the fork it saves costs more than the helper does', () => {
    const MIB = 1024 * 1024;
    // A worker of 300 MB forks about 0.8 ms slower than one at the baseline: a small PDF is worth sending to the helper, a 5 MB one is not.
    expect(launchPays(300 * MIB, 20 * 1024)).toBe(true);
    expect(launchPays(300 * MIB, 5 * MIB)).toBe(false);
    // At or below the baseline the helper saves nothing, however small the output.
    expect(launchPays(112 * MIB, 0)).toBe(false);
    expect(launchPays(60 * MIB, 0)).toBe(false);
    // A 445 KB output costs about 1 ms to bring back: it pays from about 370 MB.
    expect(launchPays(250 * MIB, 445 * 1024)).toBe(false);
    expect(launchPays(450 * MIB, 445 * 1024)).toBe(true);
    // The larger the process, the larger the output that still pays.
    expect(launchPays(4096 * MIB, 5 * MIB)).toBe(true);
  });

  it('counts the programs it started through the helper and those it started directly', async () => {
    const before = sandboxLauncherState();
    await launch(SH, shell('true'), { networkIsolated: false });
    await launchSandboxedBinary(SH, shell('true'), { networkIsolated: false, expectedOutputBytes: 1024 * 1024 * 1024 });
    const after = sandboxLauncherState();
    expect(after.launched - before.launched).toBe(1);
    expect(after.direct - before.direct).toBe(1);
  });
});
