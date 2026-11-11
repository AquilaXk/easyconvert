import fs from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * A thread inherits the execArgv of its parent, the `--import` of a TypeScript loader included. A bundled thread entry needs none, and
 * under a loader it would load each of its own modules through it, so the hosts of the CPU pool and of the RAW decode thread start a
 * bundle with an empty execArgv, as the PDF text thread does (tests/pdf-text-host.test.ts). A source entry registers its loader itself
 * and keeps the inherited arguments.
 */

const fake = vi.hoisted(() => {
  const state = { calls: [] as unknown[][] };
  class FakeWorker {
    constructor(...args: unknown[]) {
      state.calls.push(args);
    }
    on(): this {
      return this;
    }
    once(): this {
      return this;
    }
    unref(): void {}
    terminate(): Promise<number> {
      return Promise.resolve(0);
    }
  }
  return { FakeWorker, state };
});

vi.mock('node:worker_threads', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:worker_threads')>();
  return { ...actual, Worker: fake.FakeWorker };
});

import { spawnCpuWorker } from '../src/lib/workers/cpu-pool';
import { decodeRawInThread } from '../src/worker/raw-decode-host';

afterEach(() => {
  fake.state.calls.length = 0;
  vi.restoreAllMocks();
});

type Options = { execArgv?: string[]; eval?: boolean };

describe('the CPU pool thread', () => {
  it('starts a bundle without the execArgv of its parent', () => {
    spawnCpuWorker({ kind: 'compiled', file: '/app/dist/cpu-worker.js' });
    const [entry, options] = fake.state.calls[0] as [string, Options];
    expect(entry).toBe('/app/dist/cpu-worker.js');
    expect(options.execArgv).toEqual([]);
  });

  it('starts the source through the loader it registers, keeping the execArgv of its parent', () => {
    spawnCpuWorker({ kind: 'source', bootstrap: 'require("tsx").register();' });
    const [, options] = fake.state.calls[0] as [string, Options];
    expect(options.eval).toBe(true);
    expect(options).not.toHaveProperty('execArgv');
  });
});

describe('the RAW decode thread', () => {
  const startedWithBundleOnly = (): [string, Options] => {
    const real = fs.existsSync.bind(fs);
    vi.spyOn(fs, 'existsSync').mockImplementation((candidate) => {
      const name = String(candidate);
      if (!/raw-decode-worker\.(js|ts)$/.test(name)) return real(candidate);
      return name.endsWith('.js');
    });
    void decodeRawInThread('x3f', Buffer.from('FOVb')).catch(() => undefined);
    return fake.state.calls[0] as [string, Options];
  };

  it('starts a bundle without the execArgv of its parent', () => {
    const [entry, options] = startedWithBundleOnly();
    expect(entry).toMatch(/raw-decode-worker\.js$/);
    expect(options.execArgv).toEqual([]);
  });
});
