import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { AbHost, AbHostError, BaseRowError } from '../bench/ab-host';

/**
 * The process that measures the base of a change, started for real in a checkout of its own with `tsx`: it times what
 * it is asked to, row by row in the order of the benchmark, reports a row it cannot run, and ends when told to.
 */

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-ab-host-'));
afterAll(() => fs.rmSync(work, { recursive: true, force: true }));
const STUB = path.join(__dirname, 'helpers', 'ab-child-stub.ts');

describe('the base process', () => {
  it('times one call and a sample of calls on request, row after row, and ends on request', async () => {
    const host = await AbHost.start({ baseRoot: work, families: ['compression'], quick: false, script: STUB });
    try {
      await host.row();
      const side = host.side();
      expect(await side.call()).toBeGreaterThanOrEqual(7);
      const mean = await side.sample(3);
      expect(mean).toBeGreaterThanOrEqual(7);
      expect(mean).toBeLessThan(200);
      host.next();
      // The second row cannot run on this version: the error carries what the version said, with its own root.
      await host.row();
      const failure = await host.side().call().catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(BaseRowError);
      expect((failure as Error).message).toContain(`root ${work}`);
      host.next();
      await host.row();
      expect(await host.side().sample(2)).toBeGreaterThanOrEqual(1);
      host.next();
    } finally {
      await host.stop();
    }
  }, 60_000);

  it('fails when the benchmark asks for a row the process does not have: the two are out of step', async () => {
    const host = await AbHost.start({ baseRoot: work, families: ['compression'], quick: false, script: STUB });
    try {
      for (let row = 0; row < 3; row++) {
        await host.row();
        host.next();
      }
      await expect(host.row()).rejects.toThrow(AbHostError);
    } finally {
      await host.stop();
    }
  }, 60_000);

  it('reports a process that ends by itself, and refuses to start one that is not there', async () => {
    const host = await AbHost.start({ baseRoot: work, families: ['compression'], quick: false, script: STUB });
    await host.stop();
    expect(() => host.next()).toThrow(AbHostError);
    await expect(AbHost.start({ baseRoot: path.join(work, 'missing'), families: ['compression'], quick: false, script: STUB })).rejects.toThrow(AbHostError);
  }, 60_000);
});
