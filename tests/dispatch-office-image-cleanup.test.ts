import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dispatchConversion } from '../src/lib/conversions/dispatch';
import { InvalidPageRangeError } from '../src/lib/types';
import { skipWithoutTools } from './helpers/strict-skip';

const SAMPLE_DOCX = readFileSync(path.resolve(__dirname, 'fixtures', 'sample.docx'));
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
const CONVERT_TIMEOUT_MS = 120_000;
const OUT_OF_RANGE_PAGE = 999;

let privateTmp = '';
let previousTmpdir: string | undefined;

/** Files the worker left in its virtual-filesystem scratch directory under the private temp root. */
function leftoverVfsFiles(): string[] {
  const vfsDir = path.join(os.tmpdir(), 'easyconvert-vfs');
  return existsSync(vfsDir) ? readdirSync(vfsDir) : [];
}

beforeAll(() => {
  previousTmpdir = process.env.TMPDIR;
  privateTmp = mkdtempSync(path.join(previousTmpdir || '/tmp', 'dispatch-cleanup-'));
  process.env.TMPDIR = privateTmp;
});

afterAll(() => {
  if (previousTmpdir === undefined) {
    delete process.env.TMPDIR;
  } else {
    process.env.TMPDIR = previousTmpdir;
  }
  rmSync(privateTmp, { recursive: true, force: true });
});

describe.skipIf(skipWithoutTools('soffice', 'pdftoppm'))('office to image chain cleanup (needs soffice, pdftoppm)', () => {
  it('leaves no intermediate PDF behind after a successful docx to png conversion', async () => {
    const result = await dispatchConversion(SAMPLE_DOCX, 'docx', 'png', {}, 'sample.docx');
    expect(result.buffer.subarray(0, PNG_MAGIC.length)).toEqual(PNG_MAGIC);
    expect(leftoverVfsFiles()).toEqual([]);
  }, CONVERT_TIMEOUT_MS);

  it('leaves no intermediate PDF behind when rendering the pages fails', async () => {
    const run = dispatchConversion(SAMPLE_DOCX, 'docx', 'png', { page: OUT_OF_RANGE_PAGE }, 'sample.docx');
    await expect(run).rejects.toBeInstanceOf(InvalidPageRangeError);
    expect(leftoverVfsFiles()).toEqual([]);
  }, CONVERT_TIMEOUT_MS);
});
