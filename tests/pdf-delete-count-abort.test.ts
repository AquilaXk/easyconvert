import { afterEach, describe, expect, it, vi } from 'vitest';
import { deletePdfPages } from '../src/lib/conversions/pdf-postprocess';
import * as launcher from '../src/lib/security/sandbox-launcher';
import { plainPdf } from './helpers/encrypted-pdf-fixtures';
import { skipWithoutTools } from './helpers/strict-skip';

/**
 * Deleting pages counts the pages of the document beside the edit. When the edit fails, the count must not run on for the
 * time qpdf is allowed (it would read a file the failed job has removed): the run is stopped through its abort signal.
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

    await expect(deletePdfPages(pdf, '9')).rejects.toMatchObject({ name: 'InvalidPageRangeError' });
    const failedCount = launched.filter((run) => run.args.includes('--show-npages'));
    expect(failedCount).toHaveLength(1);
    expect(failedCount[0].signal?.aborted).toBe(true);

    launched.length = 0;
    await deletePdfPages(pdf, '2');
    const succeededCount = launched.filter((run) => run.args.includes('--show-npages'));
    expect(succeededCount).toHaveLength(1);
    expect(succeededCount[0].signal?.aborted).toBe(false);
  });
});
