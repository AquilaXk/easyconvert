import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { AbHost, AbHostError, BaseRowError } from '../bench/ab-host';
import { isProcessRunning } from './helpers/process-state';

/**
 * The process that measures the base of a change, started for real in a checkout of its own with `tsx`: it times what
 * it is asked to, row by row in the order of the benchmark, reports a row it cannot run, and ends when told to.
 */

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-ab-host-'));
afterAll(() => fs.rmSync(work, { recursive: true, force: true }));
const STUB = path.join(__dirname, 'helpers', 'ab-child-stub.ts');
/**
 * The first row of the stub sleeps 8 ms. A timer may fire a millisecond early against the clock that times it (a call read 6.977),
 * so what is asserted is that the call was timed in milliseconds and over the half of the sleep, not an exact floor.
 */
const FIRST_ROW_TIMED_AT_LEAST_MS = 4;

describe('the base process', () => {
  it('times one call and a sample of calls on request, row after row, and ends on request', async () => {
    const host = await AbHost.start({ root: work, families: ['compression'], quick: false, script: STUB });
    try {
      await host.row('compression/first/throughput');
      const side = host.side();
      expect(await side.call()).toBeGreaterThanOrEqual(FIRST_ROW_TIMED_AT_LEAST_MS);
      const mean = await side.sample(3);
      expect(mean).toBeGreaterThanOrEqual(FIRST_ROW_TIMED_AT_LEAST_MS);
      expect(mean).toBeLessThan(200);
      host.next();
      // The second row cannot run on this version: the error carries what the version said, with its own root.
      await host.row('compression/second/throughput');
      const failure = await host.side().call().catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(BaseRowError);
      expect((failure as Error).message).toContain(`root ${work}`);
      host.next();
      await host.row('compression/third/throughput');
      expect(await host.side().sample(2)).toBeGreaterThanOrEqual(1);
      host.next();
    } finally {
      await host.stop();
    }
  }, 60_000);

  it('keys rows by id: a row the process does not time is a row it cannot run, and the rows after it still match', async () => {
    const host = await AbHost.start({ root: work, families: ['compression'], quick: false, script: STUB });
    try {
      await host.row('compression/first/throughput');
      host.next();
      // The benchmark has a row (new in the head) that the process never times: the process is at its second row.
      const absent = await host.row('compression/new-in-head/throughput').catch((error: unknown) => error);
      expect(absent).toBeInstanceOf(BaseRowError);
      expect((absent as Error).message).toContain('compression/second/throughput');
      // Nothing is let go of for a row that was not matched, and the announced row is kept for the benchmark's next request.
      host.next();
      await host.row('compression/second/throughput');
      host.next();
      await host.row('compression/third/throughput');
      expect(await host.side().sample(2)).toBeGreaterThanOrEqual(1);
      host.next();
    } finally {
      await host.stop();
    }
  }, 60_000);

  it('never times a row the benchmark did not ask for: a row the process has and the benchmark skips is not measured in its place', async () => {
    const host = await AbHost.start({ root: work, families: ['compression'], quick: false, script: STUB });
    try {
      await host.row('compression/first/throughput');
      host.next();
      // The benchmark goes straight to the third row; the process is at its second.
      await expect(host.row('compression/third/throughput')).rejects.toThrow(BaseRowError);
      await expect(host.row('compression/third/throughput')).rejects.toThrow(BaseRowError);
      await host.row('compression/second/throughput');
      host.next();
    } finally {
      await host.stop();
    }
  }, 60_000);

  it('says that it has no row once it has timed all its rows, as a row it cannot run', async () => {
    const host = await AbHost.start({ root: work, families: ['compression'], quick: false, script: STUB });
    try {
      for (const id of ['first', 'second', 'third']) {
        await host.row(`compression/${id}/throughput`);
        host.next();
      }
      await expect(host.row('compression/fourth/throughput')).rejects.toThrow(BaseRowError);
      await expect(host.row('compression/fifth/throughput')).rejects.toThrow(BaseRowError);
      expect(() => host.next()).not.toThrow();
    } finally {
      await host.stop();
    }
  }, 60_000);

  it('fails when a row is asked for before the previous one is let go', async () => {
    const host = await AbHost.start({ root: work, families: ['compression'], quick: false, script: STUB });
    try {
      await host.row('compression/first/throughput');
      await expect(host.row('compression/second/throughput')).rejects.toThrow(AbHostError);
    } finally {
      await host.stop();
    }
  }, 60_000);

  it('reports a process that ends by itself, and refuses to start one that is not there', async () => {
    const host = await AbHost.start({ root: work, families: ['compression'], quick: false, script: STUB });
    await host.stop();
    expect(() => host.next()).toThrow(AbHostError);
    await expect(AbHost.start({ root: path.join(work, 'missing'), families: ['compression'], quick: false, script: STUB })).rejects.toThrow(AbHostError);
  }, 60_000);
});

describe('a process started for a confirmation', () => {
  const alive = (pid: number | undefined): boolean => pid !== undefined && isProcessRunning(pid);

  it('is another process of the same version, let through the rows already timed, and times the row asked for on its own', async () => {
    const host = await AbHost.start({ root: work, families: ['compression'], quick: false, script: STUB });
    let fresh: AbHost | null = null;
    try {
      await host.row('compression/first/throughput');
      host.next();
      // The benchmark is at the third row; the new process starts from the beginning and is let through the first two.
      fresh = await host.fresh('compression/third/throughput');
      expect(fresh.pid).toBeDefined();
      expect(fresh.pid).not.toBe(host.pid);
      expect(await fresh.side().sample(2)).toBeGreaterThanOrEqual(1);
      // The first process is untouched by it: still at its second row, and ends on its own request.
      await host.row('compression/second/throughput');
      host.next();
      await host.row('compression/third/throughput');
      expect(await host.side().sample(2)).toBeGreaterThanOrEqual(1);
      host.next();
    } finally {
      await fresh?.stop();
      await host.stop();
    }
  }, 60_000);

  it('is ended with the first process kept: stopping it leaves the other running', async () => {
    const host = await AbHost.start({ root: work, families: ['compression'], quick: false, script: STUB });
    try {
      const fresh = await host.fresh('compression/first/throughput');
      const pid = fresh.pid;
      expect(alive(pid)).toBe(true);
      await fresh.stop();
      expect(alive(pid)).toBe(false);
      expect(alive(host.pid)).toBe(true);
      await host.row('compression/first/throughput');
      expect(await host.side().call()).toBeGreaterThanOrEqual(FIRST_ROW_TIMED_AT_LEAST_MS);
      host.next();
    } finally {
      await host.stop();
    }
  }, 60_000);

  it('fails for a row the version does not have, and leaves no process behind', async () => {
    const host = await AbHost.start({ root: work, families: ['compression'], quick: false, script: STUB });
    try {
      const before = spawnSync('pgrep', ['-fc', 'ab-child-stub'], { encoding: 'utf8' }).stdout.trim();
      await expect(host.fresh('compression/fourth/throughput')).rejects.toThrow(BaseRowError);
      // The process that was started is reaped a moment after its exit is reported.
      let after = '';
      for (let attempt = 0; attempt < 20; attempt++) {
        after = spawnSync('pgrep', ['-fc', 'ab-child-stub'], { encoding: 'utf8' }).stdout.trim();
        if (after === before) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(after).toBe(before);
    } finally {
      await host.stop();
    }
  }, 60_000);
});

describe('ending the base process', () => {
  const BUSY = path.join(__dirname, 'helpers', 'ab-busy-stub.ts');
  const alive = (pid: number | undefined): boolean => pid !== undefined && isProcessRunning(pid);

  it('kills a process that is busy and cannot read the request to end, so nothing keeps loading the runner', async () => {
    const host = await AbHost.start({ root: work, families: ['compression'], quick: false, script: BUSY, stopGraceMs: 300 });
    const pid = host.pid;
    expect(alive(pid)).toBe(true);
    await host.stop();
    expect(alive(pid)).toBe(false);
  }, 60_000);

  it('does not leave a process that never said hello: the start fails and the process is gone', async () => {
    await expect(AbHost.start({ root: work, families: ['compression'], quick: false, script: path.join(__dirname, 'helpers', 'ab-silent-stub.ts'), helloTimeoutMs: 1500 })).rejects.toThrow(AbHostError);
    // The process is reaped a moment after its exit is reported; give it that.
    let left = '';
    for (let attempt = 0; attempt < 20; attempt++) {
      left = spawnSync('pgrep', ['-f', 'ab-silent-stub'], { encoding: 'utf8' }).stdout.trim();
      if (left === '') break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(left).toBe('');
  }, 60_000);
});
