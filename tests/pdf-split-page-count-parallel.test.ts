import { randomBytes } from 'node:crypto';
import JSZip from 'jszip';
import { PDFDocument } from 'pdf-lib';
import { describe, expect, it, vi } from 'vitest';
import { splitPdfPages } from '../src/lib/conversions/pdf-postprocess';
import * as qpdfRun from '../src/lib/conversions/pdf-postprocess/qpdf-run';
import { skipWithoutTools } from './helpers/strict-skip';

/**
 * A split of a document of 256 KB or more counts its pages first, so that a split into too many parts is refused. The count is a qpdf run
 * of its own (3 ms of the 11 ms a split of a 5-page report took), and it runs beside the cut instead of before it: the cut starts at once,
 * and the answer of the count stops it (the part count of the page limit is the same) or lets it run on.
 */

const toolsMissing = skipWithoutTools('qpdf');
const PAGES = 12;
const COUNT_PAUSE_MS = 150;

async function largeDocument(pages: number): Promise<Buffer> {
  const doc = await PDFDocument.create();
  for (let page = 0; page < pages; page++) doc.addPage([100, 100]);
  // Random bytes do not deflate: the file is large enough for the page count to be asked for.
  await doc.attach(randomBytes(300 * 1024), 'padding.bin', { mimeType: 'application/octet-stream' });
  return Buffer.from(await doc.save());
}

describe.skipIf(toolsMissing)('the page count of a split', () => {
  it('runs beside the cut, which does not wait for it', async () => {
    const original = qpdfRun.runQpdf;
    const events: string[] = [];
    const spy = vi.spyOn(qpdfRun, 'runQpdf').mockImplementation(async (workspace, invocation) => {
      const kind = invocation.args.includes('--show-npages') ? 'count' : 'cut';
      events.push(`${kind} starts`);
      try {
        const result = await original(workspace, invocation);
        if (kind === 'count') await new Promise((resolve) => setTimeout(resolve, COUNT_PAUSE_MS));
        return result;
      } finally {
        events.push(`${kind} ends`);
      }
    });
    try {
      const zip = await JSZip.loadAsync(await splitPdfPages(await largeDocument(PAGES), {}, {}, 'book'));
      expect(Object.keys(zip.files)).toHaveLength(PAGES);
    } finally {
      spy.mockRestore();
    }
    expect(events.indexOf('cut starts')).toBeLessThan(events.indexOf('count ends'));
    expect(events).toContain('count starts');
  });

  it('still refuses a split into more than 1000 parts, with the counts in the message, and returns no part', async () => {
    const pdf = await largeDocument(1100);
    const error = await splitPdfPages(pdf, { everyNPages: 1 }).then(
      () => null,
      (reason: unknown) => reason as Error
    );
    expect(error).toMatchObject({ name: 'UnsupportedOptionError', message: expect.stringMatching(/at most 1000.*1100 pages.*1100 parts/s) });
  });
});
