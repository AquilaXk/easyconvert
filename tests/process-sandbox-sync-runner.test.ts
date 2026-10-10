import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  SandboxedBufferLimitError,
  SandboxedProcessError,
  SandboxedTimeoutError,
  buildPrlimitArgs,
  runSandboxedBinarySync,
} from '../src/lib/security/process-sandbox';

/**
 * The typed outcomes of the synchronous sandbox runner, observed on real processes: a hanging spy, a flooding spy,
 * a failing spy and a signalled spy each end in the error class the asynchronous runner would have thrown.
 */

const SPY_MODE = 0o755;
const TIMEOUT_MS = 200;
const FLOOD_LIMIT_BYTES = 1000;
const NO_RLIMITS_CAPABILITY = { available: true, path: '/usr/bin/prlimit' };

let workDir = '';

function spy(name: string, body: string): string {
  const file = path.join(workDir, name);
  writeFileSync(file, `#!/bin/sh\n${body}\n`);
  chmodSync(file, SPY_MODE);
  return file;
}

function failureOf(run: () => unknown): unknown {
  try {
    run();
  } catch (err) {
    return err;
  }
  return null;
}

beforeAll(() => {
  workDir = mkdtempSync(path.join(os.tmpdir(), 'sandbox-sync-runner-'));
});

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe('runSandboxedBinarySync', () => {
  it('returns what the process wrote to stdout and stderr', () => {
    const quiet = spy('writes', `echo out\necho err >&2`);
    const { stdout, stderr } = runSandboxedBinarySync(quiet, []);
    expect(stdout.toString('utf-8')).toBe('out\n');
    expect(stderr.toString('utf-8')).toBe('err\n');
  });

  it('reports a process that outlives its time as a SandboxedTimeoutError that names the limit', () => {
    const hanging = spy('hangs', 'exec sleep 30');
    const failure = failureOf(() => runSandboxedBinarySync(hanging, [], { timeoutMs: TIMEOUT_MS }));
    expect(failure).toBeInstanceOf(SandboxedTimeoutError);
    expect(failure).not.toBeInstanceOf(SandboxedBufferLimitError);
    expect((failure as SandboxedTimeoutError).timeoutMs).toBe(TIMEOUT_MS);
    expect((failure as Error).message).toBe(`Process execution timed out after ${TIMEOUT_MS}ms`);
  });

  it('reports output past maxBuffer as a SandboxedBufferLimitError that names the limit', () => {
    const flood = spy('floods', 'exec head -c 3000000 /dev/zero');
    const failure = failureOf(() => runSandboxedBinarySync(flood, [], { maxBuffer: FLOOD_LIMIT_BYTES }));
    expect(failure).toBeInstanceOf(SandboxedBufferLimitError);
    expect(failure).not.toBeInstanceOf(SandboxedTimeoutError);
    expect((failure as SandboxedBufferLimitError).limitBytes).toBe(FLOOD_LIMIT_BYTES);
    expect((failure as Error).message).toBe(`Process output exceeded maximum buffer limit of ${FLOOD_LIMIT_BYTES} bytes`);
  });

  it('reports a non-zero exit as a SandboxedProcessError with the status, stderr and stdout', () => {
    const failing = spy('fails', `echo partial\necho broken >&2\nexit 3`);
    const failure = failureOf(() => runSandboxedBinarySync(failing, []));
    expect(failure).toBeInstanceOf(SandboxedProcessError);
    const error = failure as SandboxedProcessError;
    expect(error.exitCode).toBe(3);
    expect(error.signal).toBeNull();
    expect(error.stderr).toBe('broken\n');
    expect(error.stdout).toBe('partial\n');
    expect(error.message).toBe('broken');
  });

  it('reports a process killed by a signal with the signal name', () => {
    const killed = spy('killed', 'kill -TERM $$');
    const failure = failureOf(() => runSandboxedBinarySync(killed, []));
    expect(failure).toBeInstanceOf(SandboxedProcessError);
    expect((failure as SandboxedProcessError).signal).toBe('SIGTERM');
    expect((failure as Error).message).toBe('Process terminated by signal SIGTERM');
  });

  it('reports a binary that does not exist as the shell status 127', () => {
    const failure = failureOf(() => runSandboxedBinarySync(path.join(workDir, 'absent'), [], { networkIsolated: false }));
    expect(failure).toBeInstanceOf(SandboxedProcessError);
    expect((failure as SandboxedProcessError).exitCode).toBe(127);
  });

  it('starts nothing for a signal that was aborted, and rethrows its reason', () => {
    const marker = path.join(workDir, 'aborted-ran');
    const never = spy('never', `echo ran > '${marker}'`);
    const reason = new Error('client went away');
    expect(failureOf(() => runSandboxedBinarySync(never, [], { signal: AbortSignal.abort(reason) }))).toBe(reason);
    expect(failureOf(() => runSandboxedBinarySync(never, [], { signal: AbortSignal.abort() }))).toBeInstanceOf(Error);
    expect(() => runSandboxedBinarySync(spy('marker-check', `test ! -e '${marker}'`), [])).not.toThrow();
  });

  it('runs with a sanitized environment', () => {
    const env = spy('env', 'echo "[$SECRET_TOKEN][$HTTPS_PROXY]"');
    const { stdout } = runSandboxedBinarySync(env, [], { env: { SECRET_TOKEN: 'leak', OTHER: '1' } });
    expect(stdout.toString('utf-8')).toBe('[][http://127.0.0.1:0]\n');
  });

  it('can discard stderr, so noise on it neither fills the buffer nor reaches the error', () => {
    const noisy = spy('noisy', `head -c 5300 /dev/zero | tr '\\0' x >&2\necho answer`);
    const { stdout, stderr } = runSandboxedBinarySync(noisy, [], { maxBuffer: FLOOD_LIMIT_BYTES, discardStderr: true });
    expect(stdout.toString('utf-8')).toBe('answer\n');
    expect(stderr.length).toBe(0);
    expect(failureOf(() => runSandboxedBinarySync(noisy, [], { maxBuffer: FLOOD_LIMIT_BYTES }))).toBeInstanceOf(SandboxedBufferLimitError);
  });
});

describe('the open-file limit of prlimit', () => {
  it('is passed as --nofile, rounded', () => {
    expect(buildPrlimitArgs(NO_RLIMITS_CAPABILITY, { nofile: 256 })).toEqual(['--nofile=256']);
    expect(buildPrlimitArgs(NO_RLIMITS_CAPABILITY, { nofile: 256.6 })).toEqual(['--nofile=257']);
  });

  it.each([-1, 0, Number.NaN, Number.POSITIVE_INFINITY])('is left out for %s', (nofile) => {
    expect(buildPrlimitArgs(NO_RLIMITS_CAPABILITY, { nofile })).toEqual([]);
  });

  it('comes after the other limits and leaves them as they are', () => {
    expect(buildPrlimitArgs(NO_RLIMITS_CAPABILITY, { asBytes: 1000, cpuSeconds: 5, fsizeBytes: 7, nofile: 9 })).toEqual([
      '--as=1000',
      '--fsize=7',
      '--cpu=5',
      '--nofile=9',
    ]);
  });
});
