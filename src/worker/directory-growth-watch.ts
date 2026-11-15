import fs from 'node:fs';
import path from 'node:path';

/**
 * Watches how much a running program writes into its job directory. The per-file size limit of a sandboxed run (RLIMIT_FSIZE) bounds one file,
 * not the number of files or their sum, so a program that unpacks a hostile container (a CHM of many files of 500 MiB each) could fill the disk
 * of the worker. The watch walks the directory a few times a second, without following links, and calls `onExceeded` once when the files hold
 * more bytes or the tree more entries than the limits.
 */

const POLL_MS = 200;

export interface DirectoryGrowthLimits {
  maxBytes: number;
  maxEntries: number;
}

/** The bytes and entries below `root`, counted until a limit is passed. Directories and files count as entries; a link counts as one and is not followed. */
export function directoryGrowth(root: string, limits: DirectoryGrowthLimits): { bytes: number; entries: number; exceeded: boolean } {
  let bytes = 0;
  let entries = 0;
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop() as string;
    let names: string[];
    try {
      names = fs.readdirSync(current);
    } catch {
      continue;
    }
    for (const name of names) {
      entries += 1;
      try {
        const stat = fs.lstatSync(path.join(current, name));
        if (stat.isDirectory()) pending.push(path.join(current, name));
        else if (stat.isFile()) bytes += stat.size;
      } catch {
        // The program removed it between the listing and the read.
      }
      if (bytes > limits.maxBytes || entries > limits.maxEntries) return { bytes, entries, exceeded: true };
    }
  }
  return { bytes, entries, exceeded: false };
}

/** Starts the watch; the returned function stops it. `onExceeded` runs at most once. */
export function watchDirectoryGrowth(root: string, limits: DirectoryGrowthLimits, onExceeded: () => void): () => void {
  let fired = false;
  const timer = setInterval(() => {
    if (fired || !directoryGrowth(root, limits).exceeded) return;
    fired = true;
    onExceeded();
  }, POLL_MS);
  timer.unref();
  return () => clearInterval(timer);
}
