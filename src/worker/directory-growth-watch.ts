import fs from 'node:fs';
import path from 'node:path';
import { PayloadLimitError } from '../lib/types';

/**
 * Watches how much a running program writes into its job directory. The per-file size limit of a sandboxed run (RLIMIT_FSIZE) bounds one file,
 * not the number of files or their sum, so a program that unpacks a hostile container (a CHM of many files of 500 MiB each) could fill the disk
 * of the worker. The watch walks the directory without following links and calls `onExceeded` once when the files hold more bytes or the tree
 * more entries than the limits.
 *
 * The walk runs in the worker's event loop, so it gives the loop back every `YIELD_EVERY_ENTRIES` entries, ends the moment a limit is passed, and
 * the next walk starts only after `max(POLL_MS, SLOWDOWN_FACTOR times the time the last one took)`: a tree of tens of thousands of entries costs
 * the loop short slices, not one long stall, and a slow disk is asked less often.
 */

const POLL_MS = 200;
const SLOWDOWN_FACTOR = 4;
const YIELD_EVERY_ENTRIES = 256;

export interface DirectoryGrowthLimits {
  maxBytes: number;
  maxEntries: number;
}

const yieldToLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** The bytes and entries below `root`, counted until a limit is passed. Directories and files count as entries; a link counts as one and is not followed. */
export async function directoryGrowth(root: string, limits: DirectoryGrowthLimits): Promise<{ bytes: number; entries: number; exceeded: boolean }> {
  let bytes = 0;
  let entries = 0;
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop() as string;
    let listing: fs.Dirent[];
    try {
      listing = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of listing) {
      entries += 1;
      if (entry.isDirectory()) pending.push(path.join(current, entry.name));
      else if (entry.isFile()) {
        try {
          bytes += fs.lstatSync(path.join(current, entry.name)).size;
        } catch {
          // The program removed it between the listing and the read.
        }
      }
      if (bytes > limits.maxBytes || entries > limits.maxEntries) return { bytes, entries, exceeded: true };
      if (entries % YIELD_EVERY_ENTRIES === 0) await yieldToLoop();
    }
  }
  return { bytes, entries, exceeded: false };
}

/** Starts the watch; the returned function stops it. `onExceeded` runs at most once. */
export function watchDirectoryGrowth(root: string, limits: DirectoryGrowthLimits, onExceeded: () => void): () => void {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  const schedule = (afterMs: number): void => {
    timer = setTimeout(() => void pass(), afterMs);
    timer.unref();
  };
  const pass = async (): Promise<void> => {
    const startedAt = Date.now();
    const growth = await directoryGrowth(root, limits);
    if (stopped) return;
    if (growth.exceeded) {
      stopped = true;
      onExceeded();
      return;
    }
    schedule(Math.max(POLL_MS, SLOWDOWN_FACTOR * (Date.now() - startedAt)));
  };
  schedule(POLL_MS);
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}

export interface DirectoryGrowthRunOptions {
  root: string;
  limits: DirectoryGrowthLimits;
  label: string;
  callerSignal?: AbortSignal;
}

/** Runs `action` while bounding disk growth in `root`; throws `PayloadLimitError` if breached. */
export async function runWithDirectoryGrowthWatch<T>(
  options: DirectoryGrowthRunOptions,
  action: (signal: AbortSignal) => Promise<T>
): Promise<T> {
  const growth = new AbortController();
  const signal = options.callerSignal ? AbortSignal.any([options.callerSignal, growth.signal]) : growth.signal;
  const stop = watchDirectoryGrowth(options.root, options.limits, () => growth.abort());
  try {
    const result = await action(signal);
    const finalGrowth = await directoryGrowth(options.root, options.limits);
    if (finalGrowth.exceeded) {
      throw new PayloadLimitError(
        `${options.label} exceeded temporary disk budget (${options.limits.maxBytes} bytes / ${options.limits.maxEntries} entries)`
      );
    }
    return result;
  } catch (err) {
    if (growth.signal.aborted && !options.callerSignal?.aborted) {
      throw new PayloadLimitError(
        `${options.label} exceeded temporary disk budget (${options.limits.maxBytes} bytes / ${options.limits.maxEntries} entries)`
      );
    }
    throw err;
  } finally {
    stop();
  }
}
