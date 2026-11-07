import fs from 'node:fs';
import path from 'node:path';
import { PayloadLimitError } from '../lib/types';

/**
 * The most bytes the EPS pages of one request may hold together. Each page is its own file and the pages are bundled into one ZIP
 * in memory, so a deck of full-page pictures (a 34-page deck wrote 2.4 GB) ended in a 2 GiB file-size crash after ten minutes.
 */
export const POSTSCRIPT_PAGES_MAX_BYTES = 256 * 1024 * 1024;

/** Refuses a request whose EPS pages are already past the limit, so that the remaining pages are not written. */
export function assertPostScriptPagesWithinLimit(writtenBytes: number): void {
  if (writtenBytes > POSTSCRIPT_PAGES_MAX_BYTES) {
    throw new PayloadLimitError(
      `The pages written as EPS hold more than ${POSTSCRIPT_PAGES_MAX_BYTES} bytes together. Select pages with "pages" (for example "1-10"), or set "multiPageOutput" to "first" for the first page.`
    );
  }
}

/** Writes one EPS file for each page, as `page-<n>.eps` in `tempDir`, and stops at the first page that takes the pages past the limit. */
export async function writeEpsPages(
  pages: readonly number[],
  tempDir: string,
  inputPath: string,
  run: (tempDir: string, args: string[]) => Promise<unknown>
): Promise<void> {
  let writtenBytes = 0;
  for (const page of pages) {
    const pagePath = path.join(tempDir, `page-${page}.eps`);
    await run(tempDir, ['-eps', '-f', String(page), '-l', String(page), inputPath, pagePath]);
    writtenBytes += fs.statSync(pagePath).size;
    assertPostScriptPagesWithinLimit(writtenBytes);
  }
}
