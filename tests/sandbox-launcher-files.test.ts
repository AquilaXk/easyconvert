import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs, { readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { launchSandboxedBinary, sandboxLauncherChildEntry, sandboxLauncherState, startSandboxLauncher, stopSandboxLauncher } from '../src/lib/security/sandbox-launcher';
import * as protocol from '../src/lib/security/sandbox-launcher-protocol';
import { canSpoolStdout, executeSandboxedBinary, SandboxedBufferLimitError, SandboxedProcessError, SandboxedTimeoutError } from '../src/lib/security/process-sandbox';
import { skipUnless } from './helpers/strict-skip';
import { expectNoHang } from './helpers/timing';

/**
 * A run that collects its output through a spool (`spoolStdout`) is started by the launcher helper with the output, and the
 * input, in files of this process that the helper opens by path (`/proc/<pid>/fd/<n>`): no byte of either crosses the pipes of
 * the helper. The oracle for "the helper ran it" is the parent process id the program reports about itself (`$PPID`); the oracle for
 * the bytes is the same run started directly, and the hash of what the program was asked to write.
 */

vi.mock('../src/lib/security/sandbox-launcher-protocol', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/lib/security/sandbox-launcher-protocol')>();
  return { ...original, helperFilePath: vi.fn(original.helperFilePath) };
});

const SH = '/bin/sh';
const MIB = 1024 * 1024;
const SPOOL_PREFIX = 'easyconvert-spool-';
const HAS_SPOOL = canSpoolStdout({ spoolStdout: true, maxBuffer: MIB });
const spoolLeftovers = (): string[] => readdirSync(os.tmpdir()).filter((name) => name.startsWith(SPOOL_PREFIX));
const shell = (script: string): string[] => ['-c', script];
const spooled = (options: Parameters<typeof launchSandboxedBinary>[2] = {}): Parameters<typeof launchSandboxedBinary>[2] => ({ networkIsolated: false, timeoutMs: 20_000, maxBuffer: 16 * MIB, spoolStdout: true, ...options });

describe.skipIf(skipUnless('Linux with prlimit, which bounds a spooled output', HAS_SPOOL))('launcher runs with their output and input in files', () => {
  beforeAll(async () => {
    // A worker's size, so that the helper is judged worth it whatever this test process holds.
    vi.spyOn(process.memoryUsage, 'rss').mockReturnValue(1024 * MIB);
    expect(await startSandboxLauncher()).toBe(true);
  }, 60_000);

  afterEach(async () => {
    vi.mocked(protocol.helperFilePath).mockClear();
    if (!sandboxLauncherState().ready) {
      stopSandboxLauncher();
      await startSandboxLauncher();
    }
  });

  afterAll(() => {
    vi.restoreAllMocks();
    stopSandboxLauncher();
  });

  it('starts the program from the helper, whatever the size of the output it leaves in the file', async () => {
    const before = sandboxLauncherState();
    const result = await launchSandboxedBinary(SH, shell('echo $PPID'), spooled());
    expect(Number.parseInt(result.stdout.toString('utf8').trim(), 10)).toBe(sandboxLauncherState().pid);
    expect(sandboxLauncherState().launched - before.launched).toBe(1);
    // The copy through the pipe of the helper is what makes a large output not worth a helper; with the output in a file it is.
    const size = 3 * MIB + 17;
    const large = await launchSandboxedBinary('/usr/bin/head', ['-c', String(size), '/dev/zero'], spooled({ maxBuffer: 512 * MIB }));
    expect(crypto.createHash('sha256').update(large.stdout).digest('hex')).toBe(crypto.createHash('sha256').update(Buffer.alloc(size)).digest('hex'));
    expect(sandboxLauncherState().launched - before.launched).toBe(2);
    expect(vi.mocked(protocol.helperFilePath)).toHaveBeenCalledTimes(2);
  });

  it('returns the bytes, the error text and the status of the same run started directly', async () => {
    const script = shell("head -c 700000 /dev/zero | tr '\\0' 'q'; printf warning >&2");
    const direct = await executeSandboxedBinary(SH, script, spooled());
    const launched = await launchSandboxedBinary(SH, script, spooled());
    expect(launched.stdout.equals(direct.stdout)).toBe(true);
    expect(launched.stderr.equals(direct.stderr)).toBe(true);
    expect(launched.exitCode).toBe(direct.exitCode);
    expect(launched.stdoutFrame).toBeUndefined();
  });

  it('leaves the head room and the tail room around the output in one buffer', async () => {
    const result = await launchSandboxedBinary(SH, shell("printf '%s' 'framed output'"), spooled({ stdoutHeadroomBytes: 5, stdoutTailroomBytes: 9 }));
    expect(result.stdout.toString('utf8')).toBe('framed output');
    expect(result.stdoutFrame!.length).toBe(5 + 'framed output'.length + 9);
    expect(result.stdout.buffer).toBe(result.stdoutFrame!.buffer);
    const empty = await launchSandboxedBinary(SH, shell('true'), spooled({ stdoutHeadroomBytes: 3, stdoutTailroomBytes: 5 }));
    expect(empty.stdout.length).toBe(0);
    expect(empty.stdoutFrame!.length).toBe(8);
  });

  it('gives the program its standard input as a file, and the bytes arrive whole', async () => {
    const input = crypto.randomBytes(3 * MIB + 5);
    const result = await launchSandboxedBinary('/bin/cat', [], spooled({ stdin: input }));
    expect(result.stdout.equals(input)).toBe(true);
    expect(await launchSandboxedBinary('/bin/cat', [], spooled({ stdin: Buffer.alloc(0) }))).toMatchObject({ stdout: Buffer.alloc(0) });
    const stdinIsAFile = await launchSandboxedBinary(SH, shell('[ -f /dev/stdin ] && echo file || echo other; echo $PPID'), spooled({ stdin: Buffer.from('x') }));
    expect(stdinIsAFile.stdout.toString('utf8')).toBe(`file\n${sandboxLauncherState().pid}\n`);
  });

  it('accepts an output of exactly maxBuffer bytes and refuses one more byte as a direct run does', async () => {
    const options = spooled({ maxBuffer: MIB });
    expect((await launchSandboxedBinary(SH, shell(`head -c ${MIB} /dev/zero`), options)).stdout.length).toBe(MIB);
    const before = sandboxLauncherState().launched;
    const limit = await launchSandboxedBinary(SH, shell(`exec head -c ${MIB + 1} /dev/zero`), options).catch((error: unknown) => error);
    expect(limit).toBeInstanceOf(SandboxedBufferLimitError);
    expect((limit as SandboxedBufferLimitError).kind).toBe('stdio');
    expect((limit as SandboxedBufferLimitError).limitBytes).toBe(MIB);
    expect(sandboxLauncherState().launched - before).toBe(1);
  });

  it('reports a failing program as SandboxedProcessError with its status and error text', async () => {
    const failure = await launchSandboxedBinary(SH, shell('printf partial; echo oops >&2; exit 3'), spooled()).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(SandboxedProcessError);
    expect((failure as SandboxedProcessError).exitCode).toBe(3);
    expect((failure as SandboxedProcessError).stderr).toBe('oops\n');
  });

  it('stops a program past its time limit and one the caller aborts, and leaves no file behind', async () => {
    const leftovers = spoolLeftovers();
    const slow = await launchSandboxedBinary(SH, shell('sleep 30'), spooled({ timeoutMs: 400 })).catch((error: unknown) => error);
    expect(slow).toBeInstanceOf(SandboxedTimeoutError);
    const controller = new AbortController();
    const aborted = launchSandboxedBinary(SH, shell('sleep 30'), spooled({ signal: controller.signal })).catch((error: unknown) => error);
    await new Promise((resolve) => setTimeout(resolve, 300));
    controller.abort(new Error('caller gave up'));
    expect(((await aborted) as Error).message).toBe('caller gave up');
    expect(spoolLeftovers()).toEqual(leftovers);
  });

  it('does not start the program of a caller that aborted while its input was being written', async () => {
    const controller = new AbortController();
    // The program sleeps 30 s: an answer within the hang guard shows it was never started.
    const aborted = expectNoHang('abort during the input write', () =>
      launchSandboxedBinary(SH, shell('sleep 30'), spooled({ stdin: Buffer.alloc(4 * MIB), signal: controller.signal, timeoutMs: 60_000 })).catch((error: unknown) => error)
    );
    controller.abort(new Error('caller gave up early'));
    expect(((await aborted) as Error).message).toBe('caller gave up early');
  });

  it('runs the program directly, with the same result, when the helper cannot open the files named for it', async () => {
    const before = sandboxLauncherState();
    // A path that is not a file of this process: the helper opens nothing else.
    vi.mocked(protocol.helperFilePath).mockReturnValueOnce('/etc/hostname');
    const result = await launchSandboxedBinary(SH, shell('echo $PPID; head -c 100000 /dev/zero | tr "\\0" z'), spooled());
    const lines = result.stdout.toString('utf8').split('\n');
    expect(Number.parseInt(lines[0], 10)).toBe(process.pid);
    expect(lines[1]).toBe('z'.repeat(100_000));
    const after = sandboxLauncherState();
    expect(after.launched).toBe(before.launched);
    expect(after.direct - before.direct).toBe(1);
    // The helper is still there for the next run.
    expect(after.ready).toBe(true);
    const next = await launchSandboxedBinary(SH, shell('echo $PPID'), spooled());
    expect(Number.parseInt(next.stdout.toString('utf8').trim(), 10)).toBe(sandboxLauncherState().pid);
  });

  it('refuses, at the helper, any path but a file of its parent, and any file that is not a regular one', async () => {
    const entry = sandboxLauncherChildEntry();
    expect(entry).not.toBeNull();
    const helper = spawn(entry!.binary, entry!.args, { stdio: ['pipe', 'pipe', 'ignore'], cwd: process.cwd() });
    const reader = new protocol.FrameReader<protocol.LauncherReply>();
    const replies: protocol.LauncherReply[] = [];
    helper.stdout.on('data', (chunk: Buffer) => {
      for (const frame of reader.push(chunk)) if (!protocol.isBadFrame(frame)) replies.push(frame.header);
    });
    const kinds = async (stdoutPath: string, id: number): Promise<string> => {
      const request: protocol.LauncherRequest = { type: 'run', id, binary: SH, args: shell('echo ran'), hasStdin: false, options: { strictIsolation: false, networkIsolated: false, maxBuffer: MIB, stdoutPath } };
      for (const part of protocol.encodeFrame(request)) helper.stdin.write(part);
      for (let waited = 0; waited < 200; waited++) {
        const reply = replies.find((candidate) => 'id' in candidate && candidate.id === id);
        if (reply) return reply.type === 'error' ? reply.error.kind : reply.type;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error('the helper did not answer');
    };
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'launcher-files-'));
    try {
      await new Promise((resolve) => setTimeout(resolve, 100));
      // A regular file the helper could open and write is still not a file of its parent.
      const ownFile = path.join(scratch, 'out');
      fs.writeFileSync(ownFile, '');
      expect(await kinds(ownFile, 1)).toBe('files');
      expect(fs.readFileSync(ownFile).length).toBe(0);
      // The parent's own descriptor 1 is a path the helper may open, but what it names here is not a regular file.
      expect(await kinds(`/proc/${process.pid}/fd/1`, 2)).toBe('files');
      expect(await kinds(`/proc/${process.pid}/fd/1/../../${process.pid}/fd/1`, 3)).toBe('files');
    } finally {
      helper.kill('SIGKILL');
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });
});

describe('the paths a helper opens for its parent', () => {
  it('are /proc/<pid>/fd/<n> of that process and nothing else', () => {
    expect(protocol.isHelperFilePath(protocol.helperFilePath(1234, 17), 1234)).toBe(true);
    for (const candidate of ['/proc/1234/fd/', '/proc/1234/fd/17/../18', '/proc/1234/fd/17x', '/proc/1235/fd/17', '/proc/1234/cwd', '/proc/1234/fd/1234567890', '/etc/passwd', '../proc/1234/fd/17']) {
      expect(protocol.isHelperFilePath(candidate, 1234), candidate).toBe(false);
    }
  });
});
