import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { dispatchConversion } from '../src/lib/conversions/dispatch';
import { LIBREOFFICE_MAX_FILE_SIZE, LibreOfficePoolManager, libreOfficeDiskBudgetBytes, type SandboxedProcessRunner } from '../src/worker/libreoffice-pool';
import { PayloadLimitError } from '../src/lib/types';
import { requireRealworldSample } from './helpers/realworld-sample';
import { skipWithoutTools } from './helpers/strict-skip';

/**
 * The disk budget of a LibreOffice run (docs/policy-decisions.md, entry 377). A filter builds the output in a temporary stream file under
 * TMPDIR and copies it to the output path at the end, so for a moment the job directory holds both. A budget of the input plus one file of
 * the size limit refused `gd-374166.doc` to RTF (363,085,505 bytes of output, 717,662,526 bytes in the directory at the peak).
 */

const MIB = 1024 * 1024;
const TEST_DOCUMENT = 'hello';
const sofficeMissing = skipWithoutTools('soffice');
const made: string[] = [];
afterEach(() => {
  for (const file of made.splice(0)) fs.rmSync(file, { force: true });
});

describe('libreOfficeDiskBudgetBytes', () => {
  it('holds the input and two files of the size limit, the temporary stream and the output, and a margin', () => {
    expect(libreOfficeDiskBudgetBytes(0)).toBeGreaterThan(2 * LIBREOFFICE_MAX_FILE_SIZE);
    expect(libreOfficeDiskBudgetBytes(748_032) - libreOfficeDiskBudgetBytes(0)).toBe(748_032);
  });

  it('covers the peak that gd-374166.doc to RTF reached on the test VM', () => {
    const outputBytes = 363_085_505;
    expect(libreOfficeDiskBudgetBytes(748_032)).toBeGreaterThan(2 * outputBytes + 748_032);
  });
});

/**
 * An executor that answers the readiness probe with a small PDF and, for the document of the test, writes the temporary stream and the output
 * of `bytes` each (sparse), holds both across several polls of the watch, then drops the stream.
 */
function twoFileExecutor(bytes: number): SandboxedProcessRunner {
  return async (_binary, args, options) => {
    if (args.includes('--convert-to') && options?.cwd) {
      const input = args[args.length - 1];
      const output = path.join(options.cwd, `${path.basename(input, path.extname(input))}.pdf`);
      if (fs.readFileSync(input, 'utf8') !== TEST_DOCUMENT) {
        fs.writeFileSync(output, '%PDF-1.7\n');
      } else {
        const stream = path.join(options.cwd, 'lu1234abcd.tmp');
        for (const file of [stream, output]) {
          fs.writeFileSync(file, '');
          fs.truncateSync(file, bytes);
        }
        await new Promise((resolve) => setTimeout(resolve, 700));
        // A sandboxed run ends with an error when the watch aborts it; the stand-in does the same.
        if (options.signal?.aborted) throw new Error('aborted by the directory growth watch');
        fs.rmSync(stream);
      }
    }
    return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), exitCode: 0, durationMs: 1, sandboxed: true, sandboxType: 'host' };
  };
}

describe('a pooled LibreOffice run that holds the temporary stream and the output', () => {
  async function convertWith(bytes: number): Promise<{ filePath?: string }> {
    const pool = new LibreOfficePoolManager({ sofficePath: '/usr/bin/soffice', minWorkers: 1, maxWorkers: 1, enabled: true, readinessProbe: true, executor: twoFileExecutor(bytes) });
    try {
      const result = await pool.convert(Buffer.from(TEST_DOCUMENT), 'txt', 'pdf', {}, 'sample.txt');
      if (result?.filePath) made.push(result.filePath);
      return { filePath: result?.filePath };
    } finally {
      await pool.shutdown();
    }
  }

  it('is not refused when both are larger than the old budget of one file (2 x 300 MiB)', async () => {
    const { filePath } = await convertWith(300 * MIB);
    expect(fs.statSync(filePath as string).size).toBe(300 * MIB);
  }, 30_000);

  it('is still refused when they pass the budget (2 x 600 MiB, files the file-size limit would not allow)', async () => {
    const error = await convertWith(600 * MIB).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PayloadLimitError);
    expect((error as Error).message).toContain(`LibreOffice exceeded temporary disk budget (${libreOfficeDiskBudgetBytes(TEST_DOCUMENT.length)} bytes`);
  }, 30_000);
});

describe('gd-374166.doc to RTF through the office suite', () => {
  it.skipIf(sofficeMissing)('converts, though the suite holds a second copy of the 363 MB output while it writes', async (ctx) => {
    const sample = await requireRealworldSample(ctx, 'gd-374166.doc');
    const result = await dispatchConversion(sample.bytes, 'doc', 'rtf', {}, 'gd-374166.doc');
    expect(result.buffer.subarray(0, 6).toString('latin1')).toBe('{\\rtf1');
    expect(result.buffer.length).toBeGreaterThan(300 * MIB);
  }, 300_000);
});
