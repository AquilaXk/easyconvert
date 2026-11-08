import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

/** By absolute path, not a PATH lookup: `/bin/ps` on macOS and the BSDs, where /proc is absent. */
const PS_BINARY = '/bin/ps';

/**
 * Whether a process still runs. A killed process stays in the process table as a zombie until its parent (or init, for
 * an orphan) calls wait(), and `kill(pid, 0)` succeeds on a zombie; on a loaded runner the reaping can lag by seconds, so a
 * check that only signals the pid reports a dead process as alive. A zombie holds no memory and runs nothing, so it counts
 * as stopped here. Linux is read from /proc/<pid>/stat, other systems from `ps -o stat=`.
 */
export function isProcessRunning(pid: number): boolean {
  if (fs.existsSync('/proc/self/stat')) return isRunningOnProc(pid);
  try {
    process.kill(pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
  return !psState(pid).startsWith('Z');
}

function isRunningOnProc(pid: number): boolean {
  let stat: string;
  try {
    stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf-8');
  } catch {
    return false;
  }
  // "pid (comm) S ...": the state letter follows the last closing parenthesis (comm itself may hold one).
  const close = stat.lastIndexOf(')');
  return stat.slice(close + 2, close + 3) !== 'Z';
}

function psState(pid: number): string {
  try {
    return execFileSync(PS_BINARY, ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf-8' }).trim();
  } catch {
    return '';
  }
}

export async function waitUntilStopped(pid: number, limitMs: number, pollMs = 25): Promise<boolean> {
  const deadline = Date.now() + limitMs;
  while (isProcessRunning(pid)) {
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  return true;
}

/**
 * A sleep interval no other test uses, for a stand-in tool that ends in `exec sleep <interval>`: the interval is then an argument of the
 * process that only this test started, which `processesWithArgument` finds. (The id a tool reads for itself with `$$` cannot name it when the
 * sandbox puts the tool in a PID namespace: there it is 2, which on the host is a kernel thread or another run's program.) The value is
 * far above any test's own limit, so the process lives until it is killed.
 */
export function uniqueSleepInterval(): string {
  return `${3000 + Math.floor(Math.random() * 600)}.${String(Math.floor(Math.random() * 1e9)).padStart(9, '0')}`;
}

/**
 * The ids, on this host, of the running processes (a zombie is not running, as for `isProcessRunning`) that have `argument` as one whole
 * argument of their command line, other than this process. A program the sandbox started in a PID namespace of its own is found by what
 * it was started with, never by the id it knows itself by.
 */
export function processesWithArgument(argument: string): number[] {
  if (fs.existsSync('/proc/self/stat')) {
    const found: number[] = [];
    for (const entry of fs.readdirSync('/proc')) {
      if (!/^\d+$/.test(entry) || Number(entry) === process.pid) continue;
      let words: string[];
      try {
        words = fs.readFileSync(`/proc/${entry}/cmdline`, 'utf-8').split('\0');
      } catch {
        continue;
      }
      if (words.includes(argument) && isRunningOnProc(Number(entry))) found.push(Number(entry));
    }
    return found;
  }
  const listing = execFileSync(PS_BINARY, ['-axo', 'pid=,stat=,command='], { encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 });
  return listing
    .split('\n')
    .map((line) => line.trim().split(/\s+/))
    .filter(([pid, stat, ...command]) => Number(pid) !== process.pid && !stat?.startsWith('Z') && command.includes(argument))
    .map(([pid]) => Number(pid));
}

/** Waits until a running process has `argument` as an argument; false when `limitMs` passed first. */
export async function waitUntilProcessWithArgument(argument: string, limitMs: number, pollMs = 25): Promise<boolean> {
  const deadline = Date.now() + limitMs;
  while (processesWithArgument(argument).length === 0) {
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  return true;
}

/** Waits until no running process has `argument` as an argument; false when `limitMs` passed first. */
export async function waitUntilNoProcessWithArgument(argument: string, limitMs: number, pollMs = 25): Promise<boolean> {
  const deadline = Date.now() + limitMs;
  while (processesWithArgument(argument).length > 0) {
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  return true;
}

/** The parent chain of a process on this host, nearest first (from /proc/<pid>/stat on Linux, from `ps` elsewhere). */
export function ancestorsOf(pid: number): number[] {
  const chain: number[] = [];
  let current = pid;
  for (;;) {
    const parent = parentOf(current);
    if (parent === null || parent <= 0 || chain.includes(parent)) return chain;
    chain.push(parent);
    current = parent;
  }
}

function parentOf(pid: number): number | null {
  try {
    if (fs.existsSync('/proc/self/stat')) {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf-8');
      return Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
    }
    const parent = Number(execFileSync(PS_BINARY, ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf-8' }).trim());
    return Number.isInteger(parent) ? parent : null;
  } catch {
    return null;
  }
}
