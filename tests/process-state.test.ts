import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { isProcessRunning, waitUntilStopped } from './helpers/process-state';

/** Hang guard of a wait for a state the test caused: the state arrives in milliseconds, this only ends a wait that never would. */
const WAIT_LIMIT_MS = 10_000;

/** Signals the pid without regard to its state: a zombie still answers. */
function answersSignal(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Reads lines from `stream` until `count` have arrived; a stream that ends first, or a stall past `limitMs`, fails the wait. */
function readLines(stream: NodeJS.ReadableStream, count: number, limitMs: number): Promise<string[]> {
  return new Promise((resolve, reject) => {
    let text = '';
    const finish = (settle: () => void): void => {
      clearTimeout(timer);
      stream.off('data', onData);
      stream.off('end', onEnd);
      settle();
    };
    const onData = (chunk: Buffer): void => {
      text += chunk.toString();
      const lines = text.split('\n');
      if (lines.length > count) finish(() => resolve(lines.slice(0, count)));
    };
    const onEnd = (): void => finish(() => reject(new Error(`the stream ended after ${text.length} characters`)));
    const timer = setTimeout(() => finish(() => reject(new Error(`${count} lines did not arrive within ${limitMs} ms`))), limitMs);
    stream.on('data', onData);
    stream.once('end', onEnd);
  });
}

describe('whether a process is running', () => {
  /** Above the two waits of the zombie case, so that a wait's own message ends a stalled case: vitest's default test timeout is 5 s. */
  const ZOMBIE_TEST_TIMEOUT_MS = 3 * WAIT_LIMIT_MS;

  it('counts a zombie as stopped although it still answers a signal, and a live process as running', async () => {
    // The shell starts a sleeper and replaces itself with cat, which never waits for a child: a sleeper that is killed
    // stays a zombie for as long as cat runs. cat echoes the line the test sends, so the echo shows the shell has been replaced.
    const parent = spawn('/bin/sh', ['-c', 'sleep 60 & echo $!; exec cat'], { stdio: ['pipe', 'pipe', 'ignore'], detached: true });
    const group = -(parent.pid as number);
    try {
      parent.stdin.write('replaced\n');
      const [sleeper, echo] = await readLines(parent.stdout, 2, WAIT_LIMIT_MS);
      expect(echo).toBe('replaced');
      const pid = Number(sleeper);
      expect(isProcessRunning(pid)).toBe(true);
      process.kill(pid, 'SIGKILL');
      expect(await waitUntilStopped(pid, WAIT_LIMIT_MS)).toBe(true);
      expect(answersSignal(pid)).toBe(true);
      expect(isProcessRunning(parent.pid as number)).toBe(true);
    } finally {
      // The shell and its sleeper share one process group, so one signal ends both wherever the case stopped, and no pid is reused.
      if (answersSignal(group)) process.kill(group, 'SIGKILL');
    }
  }, ZOMBIE_TEST_TIMEOUT_MS);

  it('counts a pid that no process holds as stopped', async () => {
    const child = spawn('/bin/sh', ['-c', 'exit 0']);
    const pid = child.pid as number;
    await new Promise((resolve) => child.once('exit', resolve));
    expect(isProcessRunning(pid)).toBe(false);
  });
});

describe('waiting for a process to stop', () => {
  it('reports a process that keeps running as not stopped once the limit passes, and a killed one as stopped', async () => {
    const child = spawn('/bin/sh', ['-c', 'exec cat'], { stdio: ['pipe', 'ignore', 'ignore'] });
    const pid = child.pid as number;
    try {
      expect(await waitUntilStopped(pid, 200)).toBe(false);
      child.kill('SIGKILL');
      expect(await waitUntilStopped(pid, 10_000)).toBe(true);
    } finally {
      child.kill('SIGKILL');
    }
  });
});
