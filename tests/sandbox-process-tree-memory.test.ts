import { spawn, type ChildProcess } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { executeSandboxedBinary, getProcessRssMb, SandboxedMemoryLimitError } from '../src/lib/security/process-sandbox';
import { descendantPids, getProcessTreeRssMb } from '../src/lib/security/process-tree';
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
const HOLD_MEMORY = `const held = Buffer.alloc(${CHILD_MB} * 1024 * 1024, 0x42); setInterval(() => held.length, 1000);`;
const PARENT_WITH_CHILD = (depth: number): string => `
  const { spawn } = require('node:child_process');
  const script = ${JSON.stringify(HOLD_MEMORY)};
  const nest = (n) => n === 0 ? script : "require('node:child_process').spawn(process.execPath, ['-e', " + JSON.stringify(nest(n - 1)) + "], { stdio: 'ignore' }); setInterval(() => 0, 1000);";
  spawn(process.execPath, ['-e', nest(${depth}) ], { stdio: 'ignore' });
  setTimeout(() => process.exit(0), 4000);
`;

const started: ChildProcess[] = [];
afterEach(() => {
  for (const child of started.splice(0)) child.kill('SIGKILL');
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
    const parent = spawn(process.execPath, ['-e', `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(HOLD_MEMORY)}], { stdio: 'ignore' }); setInterval(() => 0, 1000);`], { stdio: 'ignore' });
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
    const pids = descendantPids(1, (pid) => children.get(pid) ?? []);
    expect(pids[0]).toBe(1);
    expect([...pids].sort()).toEqual([1, 2, 3, 4]);
  });
});
