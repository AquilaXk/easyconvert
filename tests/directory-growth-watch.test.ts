import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { directoryGrowth, watchDirectoryGrowth } from '../src/worker/directory-growth-watch';

/** The watch of a job directory (docs/policy-decisions.md, entry 307): the bytes of the files and the number of entries, links not followed. */

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'growth-watch-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('directoryGrowth', () => {
  it('counts the bytes of the files and the entries of the whole tree', () => {
    fs.mkdirSync(path.join(dir, 'a', 'b'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'one'), Buffer.alloc(1000));
    fs.writeFileSync(path.join(dir, 'a', 'b', 'two'), Buffer.alloc(2000));
    expect(directoryGrowth(dir, { maxBytes: 1e9, maxEntries: 1e6 })).toEqual({ bytes: 3000, entries: 4, exceeded: false });
  });

  it('reports a passed byte limit and a passed entry limit', () => {
    fs.writeFileSync(path.join(dir, 'big'), Buffer.alloc(5000));
    expect(directoryGrowth(dir, { maxBytes: 4000, maxEntries: 1e6 }).exceeded).toBe(true);
    for (let i = 0; i < 10; i++) fs.writeFileSync(path.join(dir, `f${i}`), '');
    expect(directoryGrowth(dir, { maxBytes: 1e9, maxEntries: 5 }).exceeded).toBe(true);
  });

  it('does not follow a link, so a link to a large file or to the directory itself adds nothing', () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'growth-outside-'));
    try {
      fs.writeFileSync(path.join(outside, 'large'), Buffer.alloc(100_000));
      fs.symlinkSync(path.join(outside, 'large'), path.join(dir, 'link-to-file'));
      fs.symlinkSync(dir, path.join(dir, 'link-to-self'));
      expect(directoryGrowth(dir, { maxBytes: 1e9, maxEntries: 1e6 })).toEqual({ bytes: 0, entries: 2, exceeded: false });
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe('watchDirectoryGrowth', () => {
  it('calls back once when the limit is passed, and not after it is stopped', async () => {
    let calls = 0;
    const stop = watchDirectoryGrowth(dir, { maxBytes: 1000, maxEntries: 100 }, () => (calls += 1));
    fs.writeFileSync(path.join(dir, 'big'), Buffer.alloc(5000));
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(calls).toBe(1);
    stop();
    const stopped = watchDirectoryGrowth(dir, { maxBytes: 10, maxEntries: 100 }, () => (calls += 1));
    stopped();
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(calls).toBe(1);
  });
});
