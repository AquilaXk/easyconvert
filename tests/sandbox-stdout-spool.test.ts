import { closeSync, fstatSync, mkdtempSync, openSync, readdirSync, readSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildPrlimitArgs, executeSandboxedBinary, getPrlimitCapability, SandboxedBufferLimitError, SandboxedProcessError } from '../src/lib/security/process-sandbox';
import { skipUnless } from './helpers/strict-skip';

/**
 * A run can collect its stdout through an anonymous file instead of a pipe (`spoolStdout`): the program never waits for the
 * reader, and the output is read once into a buffer of its exact size. The bound is RLIMIT_FSIZE, so it needs prlimit on Linux.
 */
const SHELL = '/bin/sh';
const MEBIBYTE = 1024 * 1024;
const SPOOL_PREFIX = 'easyconvert-spool-';
const HAS_SPOOL = process.platform === 'linux' && getPrlimitCapability().available;

const spoolLeftovers = (): string[] => readdirSync(os.tmpdir()).filter((name) => name.startsWith(SPOOL_PREFIX));

describe.skipIf(skipUnless('Linux with prlimit, which bounds a spooled output', HAS_SPOOL))('executeSandboxedBinary spooled stdout', () => {
  it('returns the same bytes as a pipe, whatever their size', async () => {
    const program = ['-c', `head -c ${3 * MEBIBYTE + 17} /dev/zero | tr '\\0' 'x'`];
    const options = { networkIsolated: false, timeoutMs: 20_000, maxBuffer: 8 * MEBIBYTE };
    const spooled = await executeSandboxedBinary(SHELL, program, { ...options, spoolStdout: true });
    const piped = await executeSandboxedBinary(SHELL, program, options);
    expect(spooled.stdout.length).toBe(3 * MEBIBYTE + 17);
    expect(spooled.stdout.equals(piped.stdout)).toBe(true);
    expect(spooled.stdoutFrame).toBeUndefined();
  });

  it('keeps the head room and the tail room around the output in one buffer', async () => {
    const result = await executeSandboxedBinary(SHELL, ['-c', "printf '%s' 'framed output'"], {
      networkIsolated: false,
      timeoutMs: 10_000,
      spoolStdout: true,
      stdoutHeadroomBytes: 5,
      stdoutTailroomBytes: 9,
    });
    expect(result.stdout.toString('utf8')).toBe('framed output');
    expect(result.stdoutFrame!.length).toBe(5 + 'framed output'.length + 9);
    expect(result.stdout.buffer).toBe(result.stdoutFrame!.buffer);
  });

  it('returns an empty output between its rooms', async () => {
    const result = await executeSandboxedBinary(SHELL, ['-c', 'true'], { networkIsolated: false, timeoutMs: 10_000, spoolStdout: true, stdoutHeadroomBytes: 3, stdoutTailroomBytes: 5 });
    expect(result.stdout.length).toBe(0);
    expect(result.stdoutFrame!.length).toBe(8);
  });

  it('feeds the program from stdin while the output is spooled', async () => {
    const input = Buffer.alloc(2 * MEBIBYTE, 0x61);
    const result = await executeSandboxedBinary('/bin/cat', [], { networkIsolated: false, timeoutMs: 10_000, spoolStdout: true, stdin: input, maxBuffer: 8 * MEBIBYTE });
    expect(result.stdout.equals(input)).toBe(true);
  });

  it('accepts an output of exactly maxBuffer bytes and refuses one more byte as a pipe does', async () => {
    const options = { networkIsolated: false, timeoutMs: 10_000, maxBuffer: MEBIBYTE, spoolStdout: true };
    const exact = await executeSandboxedBinary(SHELL, ['-c', `head -c ${MEBIBYTE} /dev/zero`], options);
    expect(exact.stdout.length).toBe(MEBIBYTE);
    const limit = await executeSandboxedBinary(SHELL, ['-c', `exec head -c ${MEBIBYTE + 1} /dev/zero`], options).catch((error: unknown) => error);
    expect(limit).toBeInstanceOf(SandboxedBufferLimitError);
    expect((limit as SandboxedBufferLimitError).kind).toBe('stdio');
    expect((limit as SandboxedBufferLimitError).limitBytes).toBe(MEBIBYTE);
  });

  it('writes no core file when the bound ends the program', async () => {
    const before = readdirSync(process.cwd()).filter((name) => name.startsWith('core'));
    await expect(executeSandboxedBinary(SHELL, ['-c', `exec head -c ${2 * MEBIBYTE} /dev/zero`], { networkIsolated: false, timeoutMs: 10_000, maxBuffer: MEBIBYTE, spoolStdout: true, cwd: process.cwd() })).rejects.toBeInstanceOf(SandboxedBufferLimitError);
    expect(readdirSync(process.cwd()).filter((name) => name.startsWith('core'))).toEqual(before);
  });

  it('reports a failure with what the program printed before it', async () => {
    const failure = await executeSandboxedBinary(SHELL, ['-c', 'printf partial; echo oops >&2; exit 3'], { networkIsolated: false, timeoutMs: 10_000, spoolStdout: true }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(SandboxedProcessError);
    expect((failure as SandboxedProcessError).exitCode).toBe(3);
    expect((failure as SandboxedProcessError).stdout).toBe('partial');
    expect((failure as SandboxedProcessError).stderr).toBe('oops\n');
  });

  it('collects the output through a pipe when the temporary directory cannot hold the spool', async () => {
    const saved = process.env.TMPDIR;
    process.env.TMPDIR = '/nonexistent-easyconvert-tmp';
    try {
      const result = await executeSandboxedBinary(SHELL, ['-c', "printf '%s' 'through a pipe'"], { networkIsolated: false, timeoutMs: 10_000, spoolStdout: true, cwd: '/' });
      expect(result.stdout.toString('utf8')).toBe('through a pipe');
    } finally {
      if (saved === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = saved;
    }
  });

  it('leaves nothing on disk, after a success, a failure, a bound and an abort', async () => {
    const before = spoolLeftovers();
    await executeSandboxedBinary(SHELL, ['-c', 'printf ok'], { networkIsolated: false, timeoutMs: 10_000, spoolStdout: true });
    await executeSandboxedBinary(SHELL, ['-c', 'exit 1'], { networkIsolated: false, timeoutMs: 10_000, spoolStdout: true }).catch(() => undefined);
    await executeSandboxedBinary(SHELL, ['-c', `exec head -c ${2 * MEBIBYTE} /dev/zero`], { networkIsolated: false, timeoutMs: 10_000, maxBuffer: MEBIBYTE, spoolStdout: true }).catch(() => undefined);
    const controller = new AbortController();
    const aborted = executeSandboxedBinary(SHELL, ['-c', 'sleep 30'], { networkIsolated: false, timeoutMs: 60_000, spoolStdout: true, signal: controller.signal });
    setTimeout(() => controller.abort(new Error('stop')), 100);
    await expect(aborted).rejects.toThrow('stop');
    expect(spoolLeftovers()).toEqual(before);
  });
});

describe.skipIf(skipUnless('Linux with prlimit, which bounds a spooled output', HAS_SPOOL))('executeSandboxedBinary with files opened by the caller', () => {
  /** The files are the caller's: the run writes to one and reads from the other, and closes neither. */
  function withFiles<T>(input: Buffer | null, body: (output: number, inputFd: number | undefined) => Promise<T>): Promise<T> {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'caller-files-'));
    const outputFd = openSync(path.join(dir, 'out'), 'w+');
    let inputFd: number | undefined;
    if (input !== null) {
      writeFileSync(path.join(dir, 'in'), input);
      inputFd = openSync(path.join(dir, 'in'), 'r');
    }
    return body(outputFd, inputFd).finally(() => {
      // Still open, so the run did not close them.
      expect(fstatSync(outputFd).isFile()).toBe(true);
      closeSync(outputFd);
      if (inputFd !== undefined) closeSync(inputFd);
      rmSync(dir, { recursive: true, force: true });
    });
  }
  const readAll = (fd: number): Buffer => {
    const out = Buffer.alloc(fstatSync(fd).size);
    readSync(fd, out, 0, out.length, 0);
    return out;
  };

  it('leaves the output in the file it was given and returns none of it', async () => {
    await withFiles(null, async (output) => {
      const result = await executeSandboxedBinary(SHELL, ['-c', `head -c ${MEBIBYTE + 3} /dev/zero | tr '\\0' 'k'`], { networkIsolated: false, timeoutMs: 10_000, maxBuffer: 4 * MEBIBYTE, stdoutFd: output });
      expect(result.stdout.length).toBe(0);
      expect(readAll(output).equals(Buffer.alloc(MEBIBYTE + 3, 'k'))).toBe(true);
    });
  });

  it('reads standard input from the file it was given', async () => {
    const input = Buffer.alloc(2 * MEBIBYTE, 0x62);
    await withFiles(input, async (output, inputFd) => {
      await executeSandboxedBinary('/bin/cat', [], { networkIsolated: false, timeoutMs: 10_000, maxBuffer: 4 * MEBIBYTE, stdoutFd: output, stdinFd: inputFd });
      expect(readAll(output).equals(input)).toBe(true);
    });
  });

  it('holds the file to the same bound as a spool of its own', async () => {
    await withFiles(null, async (output) => {
      const options = { networkIsolated: false, timeoutMs: 10_000, maxBuffer: MEBIBYTE, stdoutFd: output };
      await executeSandboxedBinary(SHELL, ['-c', `head -c ${MEBIBYTE} /dev/zero`], options);
      expect(fstatSync(output).size).toBe(MEBIBYTE);
    });
    await withFiles(null, async (output) => {
      const limit = await executeSandboxedBinary(SHELL, ['-c', `exec head -c ${MEBIBYTE + 1} /dev/zero`], { networkIsolated: false, timeoutMs: 10_000, maxBuffer: MEBIBYTE, stdoutFd: output }).catch((error: unknown) => error);
      expect(limit).toBeInstanceOf(SandboxedBufferLimitError);
      expect((limit as SandboxedBufferLimitError).limitBytes).toBe(MEBIBYTE);
    });
  });

  it('reports a failure with its status and error text, the output staying in the file', async () => {
    await withFiles(null, async (output) => {
      const failure = await executeSandboxedBinary(SHELL, ['-c', 'printf partial; echo oops >&2; exit 3'], { networkIsolated: false, timeoutMs: 10_000, stdoutFd: output }).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(SandboxedProcessError);
      expect((failure as SandboxedProcessError).exitCode).toBe(3);
      expect((failure as SandboxedProcessError).stderr).toBe('oops\n');
      expect(readAll(output).toString('utf8')).toBe('partial');
    });
  });
});

describe('prlimit arguments of the core file bound', () => {
  const capability = { available: true, path: '/usr/bin/prlimit' };

  it('passes a core size of zero, which writes no core file', () => {
    expect(buildPrlimitArgs(capability, { coreBytes: 0 })).toEqual(['--core=0']);
  });

  it('passes nothing for a core size that is not a whole non-negative number', () => {
    expect(buildPrlimitArgs(capability, { coreBytes: -1 })).toEqual([]);
    expect(buildPrlimitArgs(capability, { coreBytes: Number.NaN })).toEqual([]);
  });
});
