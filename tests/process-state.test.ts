import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { isProcessRunning, waitUntilStopped } from './helpers/process-state';

const SETTLE_MS = 300;
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Signals the pid without regard to its state: a zombie still answers. */
function answersSignal(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('whether a process is running', () => {
  it('counts a zombie as stopped although it still answers a signal, and a live process as running', async () => {
    // The shell starts `sleep 0` in the background, prints its pid and execs into `cat`, which never calls wait(), so the
    // finished `sleep 0` stays a zombie until `cat` exits. `cat` ends when its stdin closes (the kill below, or the test
    // process dying), not on a timer: with `sleep 5` a stall of 5 s in the test process, which a busy CI shard has, let the
    // parent exit and init reap the zombie before the assertions ran.
    const parent = spawn('/bin/sh', ['-c', 'sleep 0 & echo $!; exec cat'], { stdio: ['pipe', 'pipe', 'ignore'] });
    try {
      const zombie = await new Promise<number>((resolve) => parent.stdout.once('data', (chunk: Buffer) => resolve(Number(chunk.toString().trim()))));
      await pause(SETTLE_MS);
      expect(answersSignal(zombie)).toBe(true);
      expect(isProcessRunning(zombie)).toBe(false);
      expect(isProcessRunning(parent.pid as number)).toBe(true);
    } finally {
      parent.kill('SIGKILL');
    }
  });

  it('counts a pid that no process holds as stopped', async () => {
    const child = spawn('/bin/sh', ['-c', 'exit 0']);
    const pid = child.pid as number;
    await new Promise((resolve) => child.once('exit', resolve));
    await pause(SETTLE_MS);
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
