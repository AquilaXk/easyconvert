import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { executeSandboxedBinary, getProcessRssMb, SandboxedMemoryLimitError } from '../src/lib/security/process-sandbox';
import { MAX_TREE_PIDS, descendantPids, getProcessTreeMemoryMb, getProcessTreeRssMb, parseSmapsRollup } from '../src/lib/security/process-tree';
import { skipUnless } from './helpers/strict-skip';
import { runWithoutFileConfinement } from './helpers/unconfined-files';

/**
 * The memory limit of a sandboxed run holds for the program and everything it started (docs/policy-decisions.md, entry 309): a program
 * that keeps the memory in a child (the renderer of a browser, a helper process) is stopped by the sum, not missed because the parent is small.
 */

runWithoutFileConfinement();

const CHILD_MB = 300;
const LIMIT_MB = 150;
/** The address space is wide so that only the resident-size watch can stop the run. */
const WIDE_ADDRESS_SPACE_BYTES = 64 * 1024 * 1024 * 1024;
const HOLD_MEMORY = `const held = Buffer.alloc(${CHILD_MB} * 1024 * 1024, 0x42); setInterval(() => held.length, 1000); setTimeout(() => process.exit(0), 20000);`;
const PARENT_WITH_CHILD = (depth: number): string => `
  const { spawn } = require('node:child_process');
  const script = ${JSON.stringify(HOLD_MEMORY)};
  const nest = (n) => n === 0 ? script : "require('node:child_process').spawn(process.execPath, ['-e', " + JSON.stringify(nest(n - 1)) + "], { stdio: 'ignore' }); setInterval(() => 0, 1000);";
  spawn(process.execPath, ['-e', nest(${depth}) ], { stdio: 'ignore' });
  setTimeout(() => process.exit(0), 4000);
`;

const started: ChildProcess[] = [];
afterEach(() => {
  for (const child of started.splice(0)) {
    // A detached parent leads a process group of its own, which ends with it, children included.
    try {
      process.kill(-(child.pid as number), 'SIGKILL');
    } catch {
      child.kill('SIGKILL');
    }
  }
});

describe('the resident-memory watch of a sandboxed run', () => {
  it.each([1, 2])('stops a program whose memory is in a descendant %s level(s) down, while the program itself stays small', async (depth) => {
    const failure = await executeSandboxedBinary(process.execPath, ['-e', PARENT_WITH_CHILD(depth - 1)], {
      memoryLimitMb: LIMIT_MB,
      rlimits: { asBytes: WIDE_ADDRESS_SPACE_BYTES },
      timeoutMs: 15_000,
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(SandboxedMemoryLimitError);
    expect((failure as SandboxedMemoryLimitError).message).toMatch(new RegExp(`${LIMIT_MB}`));
  }, 30_000);

  it('lets a program with small processes run to its end', async () => {
    const result = await executeSandboxedBinary(process.execPath, ['-e', "require('node:child_process').spawnSync(process.execPath, ['-e', '0']); console.log('done');"], {
      memoryLimitMb: 1024,
      rlimits: { asBytes: WIDE_ADDRESS_SPACE_BYTES },
      timeoutMs: 15_000,
    });
    expect(result.stdout.toString('utf-8').trim()).toBe('done');
  }, 30_000);
});

describe('the sum of the memory of a process tree', () => {
  it('counts a child that holds memory under a parent that holds none', async () => {
    const parent = spawn(process.execPath, ['-e', `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(HOLD_MEMORY)}], { stdio: 'ignore' }); setInterval(() => 0, 1000);`], { stdio: 'ignore', detached: true });
    started.push(parent);
    const pid = parent.pid as number;
    const deadline = Date.now() + 10_000;
    let tree = 0;
    while (Date.now() < deadline && tree < CHILD_MB) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      tree = getProcessTreeRssMb(pid, getProcessRssMb) ?? 0;
    }
    expect(tree).toBeGreaterThanOrEqual(CHILD_MB);
    expect(getProcessRssMb(pid) as number).toBeLessThan(CHILD_MB);
  }, 30_000);

  it('answers null for a process that does not exist', () => {
    expect(getProcessTreeRssMb(2 ** 22 - 3, getProcessRssMb)).toBeNull();
  });

  it('walks a tree once, also when the table names a cycle, and lists the root first', () => {
    const children = new Map<number, number[]>([[1, [2, 3]], [2, [4]], [3, []], [4, [1]]]);
    const pids = descendantPids(1, (pid) => children.get(pid) ?? []) as number[];
    expect(pids[0]).toBe(1);
    expect([...pids].sort()).toEqual([1, 2, 3, 4]);
  });

  it('answers null, not a partial list, when a tree has more pids than the cap', () => {
    const wide = (pid: number): number[] => (pid === 1 ? Array.from({ length: MAX_TREE_PIDS + 10 }, (_, index) => index + 2) : []);
    expect(descendantPids(1, wide)).toBeNull();
    expect(descendantPids(1, wide, MAX_TREE_PIDS + 11)).toHaveLength(MAX_TREE_PIDS + 11);
  });

  it('reports a tree over the cap as infinite, so that the caller stops the run', async () => {
    const children = 30;
    const parent = spawn(process.execPath, ['-e', `for (let i = 0; i < ${children}; i++) require('node:child_process').spawn('sleep', ['6'], { stdio: 'ignore' }); setInterval(() => 0, 1000);`], { stdio: 'ignore', detached: true });
    started.push(parent);
    const pid = parent.pid as number;
    const deadline = Date.now() + 10_000;
    let reported: number | null = 0;
    while (Date.now() < deadline && reported !== Number.POSITIVE_INFINITY) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      reported = getProcessTreeRssMb(pid, getProcessRssMb, children - 10);
    }
    expect(reported).toBe(Number.POSITIVE_INFINITY);
    expect(getProcessTreeRssMb(pid, getProcessRssMb) as number).toBeLessThan(Number.POSITIVE_INFINITY);
  }, 30_000);
});

/** The memory of a tree is its proportional set size, which counts a page that several processes map once (docs/policy-decisions.md, entry 329). */
const SMAPS_ROLLUP = `55d0c5a00000-7ffd5b3f9000 ---p 00000000 00:00 0                          [rollup]
Rss:              440616 kB
Pss:              120331 kB
Pss_Dirty:         98211 kB
Pss_Anon:          60102 kB
Pss_File:          14223 kB
Pss_Shmem:         46006 kB
Shared_Clean:      10012 kB
Shared_Dirty:     301000 kB
Private_Clean:      9000 kB
Private_Dirty:    120604 kB
Private_Hugetlb:    2048 kB
Referenced:       440000 kB
Swap:                512 kB
SwapPss:             100 kB
Locked:                0 kB
`;
const SHARED_MB = 400;
const SHARED_CHILDREN = 3;
/** A parent and its forked children map one anonymous shared region, each touching every page: every process has the region resident, and the pages exist once. */
const SHARED_REGION_TREE = `
import mmap, os, time
size = ${SHARED_MB} * 1024 * 1024
region = mmap.mmap(-1, size, flags=mmap.MAP_SHARED | mmap.MAP_ANONYMOUS)
for offset in range(0, size, 4096):
    region[offset] = 1
for _ in range(${SHARED_CHILDREN}):
    if os.fork() == 0:
        total = 0
        for offset in range(0, size, 4096):
            total += region[offset]
        time.sleep(4)
        os._exit(0)
time.sleep(4)
`;
const LINUX_PSS_READABLE = process.platform === 'linux' && fs.existsSync('/proc/self/smaps_rollup');
const PYTHON3 = spawnSync('python3', ['-c', 'import mmap'], { stdio: 'ignore' }).status === 0;

describe('the proportional memory of a process tree', () => {
  it('reads the unique, proportional and swapped bytes of a smaps_rollup the way psutil does', () => {
    expect(parseSmapsRollup(SMAPS_ROLLUP)).toEqual({ uss: (9000 + 120604 + 2048) * 1024, pss: 120331 * 1024, swap: 512 * 1024 });
    expect(parseSmapsRollup('')).toEqual({ uss: 0, pss: 0, swap: 0 });
  });

  it.skipIf(skipUnless('Linux with /proc/<pid>/smaps_rollup and python3 (the stand-in tree shares an anonymous mapping)', LINUX_PSS_READABLE && PYTHON3))(
    'reports far less for a tree that shares one region than the sum of its resident sizes',
    async () => {
      const parent = spawn('python3', ['-c', SHARED_REGION_TREE], { stdio: 'ignore', detached: true });
      started.push(parent);
      const pid = parent.pid as number;
      const processes = SHARED_CHILDREN + 1;
      const deadline = Date.now() + 15_000;
      let resident = 0;
      while (Date.now() < deadline && resident < SHARED_MB * processes * 0.9) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        resident = getProcessTreeRssMb(pid, getProcessRssMb) ?? 0;
      }
      const proportional = getProcessTreeMemoryMb(pid, getProcessRssMb, SHARED_MB) as number;
      expect(resident).toBeGreaterThanOrEqual(SHARED_MB * processes * 0.9);
      expect(proportional).toBeGreaterThanOrEqual(SHARED_MB);
      expect(proportional).toBeLessThan(SHARED_MB * 1.5);
    },
    30_000
  );

  it.skipIf(skipUnless('Linux with /proc/<pid>/smaps_rollup and python3 (the stand-in tree shares an anonymous mapping)', LINUX_PSS_READABLE && PYTHON3))(
    'does not stop a run whose processes share the memory that their resident sizes count once each',
    async () => {
      const result = await executeSandboxedBinary('python3', ['-c', SHARED_REGION_TREE], {
        memoryLimitMb: 2 * SHARED_MB,
        rlimits: { asBytes: WIDE_ADDRESS_SPACE_BYTES },
        timeoutMs: 20_000,
      }).catch((error: unknown) => error);
      // The four processes have the region resident: their sizes add up to 4 x 400 MB, past the 800 MB limit; the pages exist once.
      expect(result).not.toBeInstanceOf(SandboxedMemoryLimitError);
      expect(result).toHaveProperty('stdout');
    },
    40_000
  );

  it('counts the resident size of a process whose proportional size cannot be read', () => {
    const own = process.pid;
    const resident = getProcessRssMb(own) as number;
    expect(getProcessTreeMemoryMb(own, getProcessRssMb, 0, MAX_TREE_PIDS, () => null) as number).toBeGreaterThanOrEqual(resident);
  });

  it.skipIf(skipUnless('Linux (the proportional sizes are read from /proc)', process.platform === 'linux'))(
    'reads the proportional sizes of a tree only when its resident sum is over the limit',
    () => {
      let reads = 0;
      const proportional = (): number => {
        reads++;
        return 7;
      };
      const resident = (): number => 100;
      const within = getProcessTreeMemoryMb(process.pid, resident, 100 * 4096, MAX_TREE_PIDS, proportional) as number;
      expect(reads).toBe(0);
      expect(within % 100).toBe(0);
      const over = getProcessTreeMemoryMb(process.pid, resident, 0, MAX_TREE_PIDS, proportional) as number;
      expect(reads).toBeGreaterThan(0);
      expect(over).toBe(reads * 7);
    }
  );

  it('answers null for a process that does not exist', () => {
    expect(getProcessTreeMemoryMb(2 ** 22 - 3, getProcessRssMb, 1024)).toBeNull();
  });
});
