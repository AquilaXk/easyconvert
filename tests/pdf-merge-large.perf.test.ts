import { describe, expect, it } from 'vitest';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { mergePdfBuffers } from '../src/lib/jobs/artifact-helpers';
import { addOutlines, bytesOf } from './helpers/pdf-merge-fixtures';
import { expectNoSlowerThanReference, SCALING_TEST_TIMEOUT_MS } from './helpers/timing';

/**
 * The cost of what the merge carries over (fields, bookmarks, destinations, page labels): 8 documents of 85 pages, as in the probe that
 * showed the old merge faster and smaller than the reference service's. The reference here is the merge this repository had before: pdf-lib
 * `copyPages` of every page. Timing ratios need a quiet machine, so this runs in the nightly performance workflow
 * (`npx vitest run --no-file-parallelism .perf.test.ts`) and not in the PR gate.
 */

const DOCUMENTS = 8;
const PAGES = 85;
const LINES_PER_PAGE = 40;
const MAX_RATIO = 1.1;
const LINE_HEIGHT = 14;

async function manualPdf(label: string): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let page = 0; page < PAGES; page += 1) {
    const sheet = doc.addPage([595, 842]);
    for (let line = 0; line < LINES_PER_PAGE; line += 1) {
      sheet.drawText(`${label} page ${page + 1} line ${line + 1} the quick brown fox jumps over the lazy dog`, { x: 40, y: 800 - line * LINE_HEIGHT, size: 10, font });
    }
  }
  addOutlines(doc, Array.from({ length: PAGES }, (_, page) => ({ title: `${label} section ${page + 1}`, page })));
  return bytesOf(doc);
}

async function copyPagesMerge(buffers: Buffer[]): Promise<Buffer> {
  const merged = await PDFDocument.create();
  for (const buffer of buffers) {
    const doc = await PDFDocument.load(buffer);
    for (const page of await merged.copyPages(doc, doc.getPageIndices())) merged.addPage(page);
  }
  return bytesOf(merged);
}

describe('a merge of 8 documents of 85 pages', () => {
  it(
    'takes no more than 10% longer and writes no more than 10% more bytes than a merge that only copies the pages',
    async () => {
      const inputs = await Promise.all(Array.from({ length: DOCUMENTS }, (_, index) => manualPdf(`doc${index}`)));
      const names = inputs.map((_, index) => `doc${index}.pdf`);
      const reference = await copyPagesMerge(inputs);
      const measurement = await expectNoSlowerThanReference(
        'merge of 8 x 85 pages',
        () => copyPagesMerge(inputs),
        () => mergePdfBuffers(inputs, { names }),
        { maxRatio: MAX_RATIO, passes: 9 }
      );
      expect((measurement.largeResult as Buffer).length).toBeLessThanOrEqual(reference.length * MAX_RATIO);
    },
    SCALING_TEST_TIMEOUT_MS
  );
});
