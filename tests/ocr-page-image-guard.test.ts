import { PDFDocument } from 'pdf-lib';
import { beforeAll, describe, expect, it } from 'vitest';
import { convertFile } from '../src/lib/conversions/index';
import { performSmartMultiPagePdfOcr, recognizeRenderedPdfPages } from '../src/lib/conversions/ocr';
import { PAGE_IMAGE_MAX_PAGES, assertPageImageCount } from '../src/lib/conversions/page-range';
import { readPdfForOffice } from '../src/lib/conversions/pdf-office';

/**
 * Every OCR entry that renders the pages of a PDF is held to the one page-image guard (policy entries 16 and 44): 413
 * `input_over_limit` with the text of `assertPageImageCount`, before any page is drawn.
 */

const PAGES = PAGE_IMAGE_MAX_PAGES + 1;
const TIMEOUT_MS = 120_000;

function guardMessage(pageCount: number): string {
  try {
    assertPageImageCount(pageCount);
  } catch (err) {
    return (err as Error).message;
  }
  throw new Error(`${pageCount} pages are within the guard`);
}

let longPdf: Buffer;
beforeAll(async () => {
  const doc = await PDFDocument.create();
  for (let index = 0; index < PAGES; index++) doc.addPage([200, 200]);
  longPdf = Buffer.from(await doc.save());
});

describe(`OCR of a PDF past ${PAGE_IMAGE_MAX_PAGES} pages`, () => {
  const refused = { name: 'PayloadLimitError', status: 413, refusalCode: 'input_over_limit' };

  it('is refused by the page recognizer with the shared guard text', async () => {
    const error = await recognizeRenderedPdfPages(longPdf, undefined, {}).catch((err: unknown) => err);
    expect(error).toMatchObject({ ...refused, message: guardMessage(PAGES) });
  }, TIMEOUT_MS);

  it('is refused for the selected pages when they are past the guard', async () => {
    const selected = new Set(Array.from({ length: PAGES }, (_, index) => index + 1));
    const error = await recognizeRenderedPdfPages(longPdf, selected, {}).catch((err: unknown) => err);
    expect(error).toMatchObject({ ...refused, message: guardMessage(PAGES) });
  }, TIMEOUT_MS);

  it('is refused by the searchable PDF entry', async () => {
    const error = await performSmartMultiPagePdfOcr(longPdf, { ocrMode: 'force' }).catch((err: unknown) => err);
    expect(error).toMatchObject({ ...refused, message: guardMessage(PAGES) });
  }, TIMEOUT_MS);

  it('is refused by the office reader when OCR is on', async () => {
    const error = await readPdfForOffice(longPdf, { ocrEnabled: true }).catch((err: unknown) => err);
    expect(error).toMatchObject({ ...refused, message: guardMessage(PAGES) });
  }, TIMEOUT_MS);

  it('is refused by the text conversion when OCR is on', async () => {
    const error = await convertFile(longPdf, 'pdf', 'txt', { ocrEnabled: true }, 'long.pdf').catch((err: unknown) => err);
    expect(error).toMatchObject({ ...refused, message: guardMessage(PAGES) });
  }, TIMEOUT_MS);
});
