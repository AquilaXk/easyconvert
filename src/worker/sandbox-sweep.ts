import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isOwnedWorkerSandboxDir, touchOwnedWorkerSandboxDirs } from './sandbox';

/**
 * Removes the sandbox and LibreOffice profile directories that a worker killed without a clean exit left in the temporary directory
 * (docs/policy-decisions.md, entry 244). A worker that is stopped by SIGKILL (the memory limit of its container) runs no cleanup, and
 * the temporary directory of the production worker is a host directory that outlives the container, so nothing else removes them
 * before the host's scheduled sweep two hours later.
 *
 * Who is alive is not told by a process id: the replicas of a service share one temporary directory from separate process id
 * namespaces, where an id means another process or none. Every process refreshes the modification time of the directories it owns
 * each interval; a directory that nobody has refreshed for the stale age has no live owner and is removed, by whichever worker sweeps,
 * once the first sweep delay after its own start has passed (SANDBOX_FIRST_SWEEP_DELAY_MS).
 */

/** How often a worker refreshes its own directories and sweeps the others. */
export const SANDBOX_SWEEP_INTERVAL_MS = 60_000;
/**
 * A directory untouched for this long has no live owner: ten refresh intervals, longer than any pause of an event loop that is not
 * stuck (a stuck worker recycles itself first, JOB_STUCK_RECYCLE_MS).
 */
export const SANDBOX_STALE_AFTER_MS = 10 * SANDBOX_SWEEP_INTERVAL_MS;

/**
 * The first sweep waits this long after the worker starts. A rollout recreates every worker service at once while the old containers
 * drain for up to their `stop_grace_period` (120 s, docker-compose.prod.yml) in the same temporary directory, and an image from before
 * this sweep never refreshes the modification time of its directories: a sweep at start would remove the profile and work directories
 * of a draining worker's running jobs. Two and a half grace periods; the refresh of this process's own directories starts at once.
 */
export const SANDBOX_FIRST_SWEEP_DELAY_MS = 5 * 60_000;

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
/**
 * The names createWorkerSandboxDir gives: the default prefix, and the LibreOffice slot, probe and work directories
 * (src/worker/libreoffice-pool.ts); each ends in a random UUID.
 */
export const WORKER_SANDBOX_DIR_NAME = new RegExp(`^(?:easyconvert_worker_sandbox_|libreoffice_(?:probe_)?(?:profile|work)_[A-Za-z0-9-]+_)${UUID}$`);

export interface SandboxSweepOptions {
  directory?: string;
  now?: number;
  staleAfterMs?: number;
}

/** Removes the stale directories of other owners and returns their names. Never throws: a directory that cannot be removed waits for the next sweep. */
export function sweepWorkerSandboxDirs(options: SandboxSweepOptions = {}): string[] {
  const directory = options.directory ?? os.tmpdir();
  const now = options.now ?? Date.now();
  const staleAfterMs = options.staleAfterMs ?? SANDBOX_STALE_AFTER_MS;
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
  const removed: string[] = [];
  let names: string[];
  try {
    names = fs.readdirSync(directory);
  } catch {
    return removed;
  }
  for (const name of names) {
    if (!WORKER_SANDBOX_DIR_NAME.test(name)) continue;
    const full = path.join(directory, name);
    if (isOwnedWorkerSandboxDir(full)) continue;
    try {
      const stat = fs.lstatSync(full);
      if (!stat.isDirectory() || (uid !== undefined && stat.uid !== uid)) continue;
      if (now - stat.mtimeMs < staleAfterMs) continue;
      fs.rmSync(full, { recursive: true, force: true });
      removed.push(name);
    } catch {
      // gone already, or not ours to remove: the next sweep looks again
    }
  }
  return removed;
}

let sweepTimer: NodeJS.Timeout | null = null;

/**
 * Refreshes the directories of this process at once and every interval, and sweeps the stale ones of others every interval from
 * `firstSweepDelayMs` after the start, until stopWorkerSandboxSweep.
 */
export function startWorkerSandboxSweep(intervalMs: number = SANDBOX_SWEEP_INTERVAL_MS, firstSweepDelayMs: number = SANDBOX_FIRST_SWEEP_DELAY_MS): NodeJS.Timeout {
  if (sweepTimer) return sweepTimer;
  const sweepFrom = Date.now() + firstSweepDelayMs;
  const tick = (): void => {
    touchOwnedWorkerSandboxDirs();
    if (Date.now() < sweepFrom) return;
    const removed = sweepWorkerSandboxDirs();
    if (removed.length > 0) {
      console.warn(`[EasyConvert OCI Worker] Removed ${removed.length} sandbox director${removed.length === 1 ? 'y' : 'ies'} left by a worker that did not exit cleanly.`);
    }
  };
  tick();
  sweepTimer = setInterval(tick, intervalMs);
  sweepTimer.unref();
  return sweepTimer;
}

export function stopWorkerSandboxSweep(): void {
  if (sweepTimer) clearInterval(sweepTimer);
  sweepTimer = null;
}
