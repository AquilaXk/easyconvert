import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

/*
 * psutil, BSD 3-Clause License
 *
 * Copyright (c) 2009, Jay Loden, Dave Daeschler, Giampaolo Rodola
 * All rights reserved.
 *
 * Redistribution and use in source and binary forms, with or without modification,
 * are permitted provided that the following conditions are met:
 *
 *  * Redistributions of source code must retain the above copyright notice, this
 *    list of conditions and the following disclaimer.
 *
 *  * Redistributions in binary form must reproduce the above copyright notice,
 *    this list of conditions and the following disclaimer in the documentation
 *    and/or other materials provided with the distribution.
 *
 *  * Neither the name of the psutil authors nor the names of its contributors
 *    may be used to endorse or promote products derived from this software without
 *    specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
 * ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
 * WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
 * DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT OWNER OR CONTRIBUTORS BE LIABLE FOR
 * ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
 * (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
 * LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON
 * ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
 * (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
 * SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */

/**
 * The processes a run started, for the resident-memory watch of the sandbox (docs/policy-decisions.md, entry 308).
 *
 * `descendantPids` is a TypeScript translation of the traversal of `Process.children(recursive=True)` in `psutil/__init__.py` of
 * giampaolo/psutil (tag v7.2.2, commit 9eea97dd6f1d16ea33f5144c8925f1ce7a0688e1), BSD-3-Clause, Copyright (c) 2009, Jay Loden, Dave
 * Daeschler, Giampaolo Rodola (NOTICE and docs/licensing.md carry the licence text): a stack of pids and a set of the pids seen, so that a
 * cycle in a process table read while pids are reused ends the walk. psutil builds a map of parent to children from the whole process table;
 * on Linux the children of a process are read where the kernel lists them (`/proc/<pid>/task/<tid>/children`, which `memoryWatchPid` reads
 * too), so a run is not paid for the other processes of the host. Elsewhere (a development host) one `ps` call gives the map.
 */

const PS_TIMEOUT_MS = 1000;
/**
 * Most processes the walk visits for one run. A real run of a program with helper processes (a browser) has tens; a tree past this is a fork
 * bomb or a program the limits were not made for, and the walk would cost the worker more every tick the longer it grew. A tree over the cap is
 * reported as over any memory limit (the run is stopped), not walked on.
 */
export const MAX_TREE_PIDS = 4096;
const KIB_PER_MIB = 1024;

/** The pid and its descendants: the pids reached from `rootPid` through `childrenOf`, the root first; null when more than `maxPids` are reached. */
export function descendantPids(rootPid: number, childrenOf: (pid: number) => readonly number[], maxPids = MAX_TREE_PIDS): number[] | null {
  const seen = new Set<number>();
  const stack = [rootPid];
  while (stack.length > 0) {
    const pid = stack.pop() as number;
    // Pids can be reused while the table is read, so a cycle is possible; a pid is visited once.
    if (seen.has(pid)) continue;
    seen.add(pid);
    if (seen.size > maxPids) return null;
    for (const child of childrenOf(pid)) stack.push(child);
  }
  return [...seen];
}

/** The children of a process on Linux: every thread of the process lists the children it started. */
function linuxChildren(pid: number): number[] {
  const children: number[] = [];
  let tasks: string[];
  try {
    tasks = fs.readdirSync(`/proc/${pid}/task`);
  } catch {
    return children;
  }
  for (const task of tasks) {
    try {
      for (const field of fs.readFileSync(`/proc/${pid}/task/${task}/children`, 'utf-8').trim().split(/\s+/)) {
        const child = Number(field);
        if (Number.isInteger(child) && child > 0) children.push(child);
      }
    } catch {
      // The thread ended between the listing and the read.
    }
  }
  return children;
}

/** The sum of the resident sizes of the pids, in MB; null when the root's own size cannot be read. */
function sumResidentMb(pids: readonly number[], residentMb: (pid: number) => number | null): number | null {
  if (residentMb(pids[0]) === null) return null;
  let total = 0;
  for (const pid of pids) total += residentMb(pid) ?? 0;
  return total;
}

/** The resident size of a process and all its descendants through one `ps` call, for a host without /proc; null when `ps` fails. */
function psTreeMb(pid: number, maxPids: number): number | null {
  let out: string;
  try {
    out = execFileSync('ps', ['-axo', 'pid=,ppid=,rss='], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], timeout: PS_TIMEOUT_MS, env: { PATH: '/bin:/usr/bin', NODE_ENV: process.env.NODE_ENV ?? 'production' } as NodeJS.ProcessEnv });
  } catch {
    return null;
  }
  const children = new Map<number, number[]>();
  const rssKb = new Map<number, number>();
  for (const line of out.trim().split('\n')) {
    const [id, parent, rss] = line.trim().split(/\s+/).map(Number);
    if (![id, parent, rss].every(Number.isFinite)) continue;
    rssKb.set(id, rss);
    children.set(parent, [...(children.get(parent) ?? []), id]);
  }
  if (!rssKb.has(pid)) return null;
  const tree = descendantPids(pid, (id) => children.get(id) ?? [], maxPids);
  return tree === null ? Number.POSITIVE_INFINITY : tree.reduce((sum, id) => sum + (rssKb.get(id) ?? 0), 0) / KIB_PER_MIB;
}

/**
 * The resident memory of a process and everything it started, in MB. A program that keeps a renderer or a worker in a child (a browser, a
 * Python program with helper processes) is held to its limit by the sum, not by the size of the parent alone. A tree of more than `maxPids`
 * processes answers infinity, so the caller stops the run (it fails closed). Shared pages count once for
 * each process that maps them, so the sum is an upper bound.
 */
export function getProcessTreeRssMb(pid: number, residentMb: (pid: number) => number | null, maxPids = MAX_TREE_PIDS): number | null {
  if (process.platform !== 'linux') return psTreeMb(pid, maxPids);
  const tree = descendantPids(pid, linuxChildren, maxPids);
  return tree === null ? Number.POSITIVE_INFINITY : sumResidentMb(tree, residentMb);
}
