import { afterEach, describe, expect, it } from 'vitest';
import { extractPdfTextLayerPages, PdfTextGeometryError } from '../src/lib/conversions/pdf-text-geometry';
import { extraObjectNumber, rawPdf, run, type RawPage } from './helpers/raw-pdf';

/** A document that never finishes must be stopped by the wall-clock deadline, not by the test runner. */

const TEST_TIMEOUT_MS = 120_000;
const DEADLINE_ENV = 'EASYCONVERT_PDF_TEXT_DEADLINE_MS';
const SHORT_DEADLINE_MS = 3_000;
/** The deadline plus time to start the worker thread and report the failure. */
const DEADLINE_SLACK_MS = 12_000;

afterEach(() => {
  delete process.env[DEADLINE_ENV];
});

async function failure(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => null,
    (err: unknown) => err
  );
}

describe('wall-clock deadline', () => {
  /** Form XObjects nested `depth` deep, each invoking the next four times: effectively endless work. */
  function nestedForms(depth: number): Buffer {
    const first = extraObjectNumber(1);
    const forms: string[] = [];
    for (let level = 0; level <= depth; level++) {
      const next = first + level + 1;
      const body =
        level === depth
          ? 'BT /F1 12 Tf 10 10 Td (deep) Tj ET'
          : `/X${level + 1} Do /X${level + 1} Do /X${level + 1} Do /X${level + 1} Do`;
      const xobject = level === depth ? '' : `/XObject << /X${level + 1} ${next} 0 R >>`;
      forms.push(
        `<< /Type /XObject /Subtype /Form /BBox [0 0 100 100] /Resources << /Font << /F1 3 0 R >> ${xobject} >> /Length ${body.length} >>\nstream\n${body}\nendstream`
      );
    }
    const page: RawPage = { width: 100, height: 100, content: '/X0 Do', resources: `/XObject << /X0 ${first} 0 R >>` };
    return rawPdf([page], forms);
  }

  it(
    'stops a document whose nested forms never finish and reports a typed error within the deadline',
    async () => {
      process.env[DEADLINE_ENV] = String(SHORT_DEADLINE_MS);
      const started = Date.now();
      const err = await failure(extractPdfTextLayerPages(nestedForms(16), new Set([1])));
      expect(err).toBeInstanceOf(PdfTextGeometryError);
      expect((err as Error).message).toBe(`PDF text extraction exceeded its ${SHORT_DEADLINE_MS} ms limit.`);
      expect(Date.now() - started).toBeLessThan(SHORT_DEADLINE_MS + DEADLINE_SLACK_MS);
    },
    TEST_TIMEOUT_MS
  );

  it(
    'reads an ordinary document in the worker thread within the deadline',
    async () => {
      process.env[DEADLINE_ENV] = String(TEST_TIMEOUT_MS);
      const pdf = rawPdf([{ width: 200, height: 100, content: run('Plain words here', 10, 50, 12) }]);
      const pages = await extractPdfTextLayerPages(pdf, new Set([1]));
      expect(pages.get(1)?.lines).toEqual(['Plain words here']);
    },
    TEST_TIMEOUT_MS
  );
});

