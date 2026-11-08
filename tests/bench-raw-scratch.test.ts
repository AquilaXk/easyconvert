import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createContext, type ContextInit } from '../bench/context';
import { withSampleScratch } from '../bench/families/raw';

/**
 * The RAW family develops every camera file to a 16-bit TIFF (up to 270 MB each) and encodes it at four quality points. Left in the run's
 * scratch directory until the run ends, these files filled the 10 GB of free disk of a CI-sized machine near the 40th sample; the next
 * `dcraw_emu` write then failed without an exit code, and the product (correctly) refused the short TIFF it had written. A sample's files
 * must therefore be gone when the sample is done.
 */

let work: string;
beforeEach(() => {
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'raw-scratch-test-'));
});
afterEach(() => {
  fs.rmSync(work, { recursive: true, force: true });
});

const contextOver = (dir: string) => createContext({ work: dir, log: () => undefined } as unknown as ContextInit);

describe('the scratch of a RAW sample', () => {
  it('is removed when the sample is measured', async () => {
    const ctx = contextOver(work);
    let written = '';
    await withSampleScratch(ctx, 'sample', async (scratch) => {
      written = scratch('developed.tiff');
      fs.writeFileSync(written, Buffer.alloc(1024));
      fs.writeFileSync(`${written}.png`, Buffer.alloc(1024));
      expect(fs.existsSync(written)).toBe(true);
    });
    expect(fs.existsSync(written)).toBe(false);
    expect(fs.readdirSync(work)).toEqual([]);
  });

  it('is removed when the sample fails', async () => {
    const ctx = contextOver(work);
    await expect(
      withSampleScratch(ctx, 'sample', async (scratch) => {
        fs.writeFileSync(scratch('developed.tiff'), Buffer.alloc(1024));
        throw new Error('the encoder failed');
      })
    ).rejects.toThrow('the encoder failed');
    expect(fs.readdirSync(work)).toEqual([]);
  });

  it('keeps the files of two samples apart and returns what the measurement returns', async () => {
    const ctx = contextOver(work);
    const paths = await Promise.all(
      ['one', 'two'].map((name) => withSampleScratch(ctx, name, async (scratch) => scratch('developed.tiff')))
    );
    expect(new Set(paths).size).toBe(2);
  });
});
