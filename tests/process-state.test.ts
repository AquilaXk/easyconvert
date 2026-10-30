import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { isProcessRunning, waitUntilStopped } from './helpers/process-state';

/** Hang guard of a wait for a state the test caused: the state arrives in milliseconds, this only ends a wait that never would. */
const STOP_LIMIT_MS = 10_000;

/** Signals the pid without regard to its state: a zombie still answers. */
function answersSignal(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Reads lines from `stream` until `count` have arrived; a stream that ends first fails the wait. */
function readLines(stream: NodeJS.ReadableStream, count: number): Promise<string[]> {
  return new Promise((resolve, reject) => {
    let text = '';
    const onData = (chunk: Buffer): void => {
      text += chunk.toString();
      const lines = text.split('\n');
      if (lines.length > count) {
        stream.off('data', onData);
        resolve(lines.slice(0, count));
      }
    };
    stream.on('data', onData);
    stream.once('end', () => reject(new Error(`the stream ended after ${text.length} characters`)));
  });
}

describe('whether a process is running', () => {
  it('counts a zombie as stopped although it still answers a signal, and a live process as running', async () => {
    // The shell starts a sleeper and replaces itself with cat, which never waits for a child: a sleeper that is killed
    // stays a zombie for as long as cat runs. cat echoes the line the test sends, so the echo shows the shell has been replaced.
    const parent = spawn('/bin/sh', ['-c', 'sleep 60 & echo $!; exec cat'], { stdio: ['pipe', 'pipe', 'ignore'] });
    let pid = 0;
    try {
      parent.stdin.write('replaced\n');
      const [sleeper, echo] = await readLines(parent.stdout, 2);
      expect(echo).toBe('replaced');
      pid = Number(sleeper);
      expect(isProcessRunning(pid)).toBe(true);
      process.kill(pid, 'SIGKILL');
      expect(await waitUntilStopped(pid, STOP_LIMIT_MS)).toBe(true);
      expect(answersSignal(pid)).toBe(true);
      expect(isProcessRunning(parent.pid as number)).toBe(true);
    } finally {
      // The sleeper first, while its parent still holds the pid: after the parent is gone init reaps it and the pid can be reused.
      if (pid > 0 && answersSignal(pid)) process.kill(pid, 'SIGKILL');
      parent.kill('SIGKILL');
    }
  });

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
