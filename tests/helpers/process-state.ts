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
