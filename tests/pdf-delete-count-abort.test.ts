import { afterEach, describe, expect, it, vi } from 'vitest';
import { deletePdfPages } from '../src/lib/conversions/pdf-postprocess';
import * as launcher from '../src/lib/security/sandbox-launcher';
import { plainPdf } from './helpers/encrypted-pdf-fixtures';
import { skipWithoutTools } from './helpers/strict-skip';

/**
 * Deleting pages counts the pages of the document beside the edit when the specification names page 1, the one page that
 * any document with a page has: a specification that leaves it leaves a page, and needs no count. When the edit fails,
 * the count must not run on for the time qpdf is allowed (it would read a file the failed job has removed): the run is
 * stopped through its abort signal.
 */

const toolsMissing = skipWithoutTools('qpdf');

describe.skipIf(toolsMissing)('deleting pages: the page count beside the edit', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('is stopped when the edit fails, and left to finish when it succeeds', async () => {
    const launched: Array<{ args: string[]; signal: AbortSignal | undefined }> = [];
    const real = launcher.launchSandboxedBinary;
    vi.spyOn(launcher, 'launchSandboxedBinary').mockImplementation((binary, args, options) => {
      launched.push({ args, signal: options?.signal });
      return real(binary, args, options);
    });
    const pdf = await plainPdf(['One', 'Two', 'Three']);

    await expect(deletePdfPages(pdf, '1,9')).rejects.toMatchObject({ name: 'InvalidPageRangeError' });
    const failedCount = launched.filter((run) => run.args.includes('--show-npages'));
    expect(failedCount).toHaveLength(1);
    expect(failedCount[0].signal?.aborted).toBe(true);

    launched.length = 0;
    await deletePdfPages(pdf, '1');
    const succeededCount = launched.filter((run) => run.args.includes('--show-npages'));
    expect(succeededCount).toHaveLength(1);
    expect(succeededCount[0].signal?.aborted).toBe(false);
  });

  it('is not run for a specification that leaves page 1: the edit is the only program', async () => {
    const launched: string[][] = [];
    const real = launcher.launchSandboxedBinary;
    vi.spyOn(launcher, 'launchSandboxedBinary').mockImplementation((binary, args, options) => {
      launched.push(args);
      return real(binary, args, options);
    });
    const pdf = await plainPdf(['One', 'Two', 'Three']);

    await deletePdfPages(pdf, '2-3');
    expect(launched).toHaveLength(1);
    expect(launched[0]).toContain('--pages');
    // A refusal of an emptied document still needs the count: every page named from page 1 on.
    launched.length = 0;
    await expect(deletePdfPages(pdf, '1-3')).rejects.toMatchObject({ name: 'PdfPostprocessError' });
    expect(launched.filter((args) => args.includes('--show-npages'))).toHaveLength(1);
  });
});
