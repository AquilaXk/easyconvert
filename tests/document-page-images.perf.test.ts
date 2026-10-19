import { expect } from 'vitest';
import { dispatchConversion } from '../src/lib/conversions/dispatch';
import { OFFICE_PAGE_IMAGE_MAX_PAGES } from '../src/lib/conversions/page-range';
import { PayloadLimitError } from '../src/lib/types';
import { oracleTest } from './helpers/oracle-test';
import { requireRealworldSample } from './helpers/realworld-sample';
import { expectSamePixels, pdfPageCount, referencePages, suitePdf } from './helpers/suite-page-images';

/**
 * The real 8 MB report of the nightly corpus, `govdocs1-010383.rtf`, that prints 4,181 pages with LibreOffice 24.2 on macOS and 4,874
 * on Ubuntu 24.04 (nightly run 39316523318). The office suite lays it out for 30 s on an idle 4-core machine and 75 to 110 s next to 8 to 12
 * busy loops, and every conversion of it lays it out again, so the file is judged here, in the nightly performance workflow
 * (`npx vitest run --no-file-parallelism .perf.test.ts`), and not in a shard of the pull request gate, where that much CPU
 * for minutes slows the timing suites it shares the machine with. `document-page-images.test.ts` checks the same refusals in the gate on a
 * text and a presentation made for the test. One target is enough here: the page limit does not depend on the image format.
 * The oracles are not the converter: the office suite's own PDF of the file (page count, and the pixels of its first page drawn by `pdftoppm`).
 */

const TEST_TIMEOUT_MS = 900_000;
const TOOLS = ['soffice', 'pdfinfo', 'pdftoppm'] as const;
const LONG_DOCUMENT_ID = 'govdocs1-010383.rtf';

/** The refusal a conversion ends with, which must be the 413 `PayloadLimitError` of the page limit. */
async function refusalOf(input: Buffer, source: string, target: string, name: string): Promise<PayloadLimitError> {
  const refusal = await dispatchConversion(input, source, target, {}, name).catch((error: unknown) => error);
  expect(refusal).toBeInstanceOf(PayloadLimitError);
  return refusal as PayloadLimitError;
}

oracleTest(
  `${LONG_DOCUMENT_ID} of the nightly corpus is refused by name to JPEG, and its first page is the suite's page 1`,
  [...TOOLS],
  async (ctx) => {
    const sample = await requireRealworldSample(ctx, LONG_DOCUMENT_ID);
    const suite = suitePdf(sample.bytes, sample.format);
    const printedPages = pdfPageCount(suite);
    expect(printedPages).toBeGreaterThan(OFFICE_PAGE_IMAGE_MAX_PAGES);
    const refusal = await refusalOf(sample.bytes, sample.format, 'jpg', LONG_DOCUMENT_ID);
    expect(refusal.message).toContain(`${printedPages} pages`);
    expect(refusal.message).toContain(`at most ${OFFICE_PAGE_IMAGE_MAX_PAGES}`);
    const first = await dispatchConversion(sample.bytes, sample.format, 'png', { multiPageOutput: 'first' }, LONG_DOCUMENT_ID);
    await expectSamePixels(first.buffer, referencePages(suite, 1, 1)[0], `${LONG_DOCUMENT_ID} page 1`);
  },
  TEST_TIMEOUT_MS
);
