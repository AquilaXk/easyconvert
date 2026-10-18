import { describe, expect, it } from 'vitest';
import { dispatchConversion } from '../src/lib/conversions/dispatch';
import { buildPdf } from './helpers/pdf-craft';
import { skipWithoutTools } from './helpers/strict-skip';

/**
 * A PDF whose page tree has no page is readable by qpdf and refused by pdftotext ("Wrong page range", exit 99), whatever
 * password the request carries. The refusal must be the outcome of the in-process reader (a result or its typed 400), never a 503 for a missing engine.
 */

const toolsMissing = skipWithoutTools('qpdf', 'pdftotext');
const CATALOG_ID = 1;
const PAGES_ID = 2;

function pdfWithoutPages(): Buffer {
  return buildPdf(
    [
      { id: CATALOG_ID, dict: `/Type /Catalog /Pages ${PAGES_ID} 0 R` },
      { id: PAGES_ID, dict: '/Type /Pages /Kids [] /Count 0' },
    ],
    CATALOG_ID
  ).buffer;
}

describe.skipIf(toolsMissing)('a PDF without pages converted to text with a password', () => {
  it('is read by the in-process reader like the same request without a password, not refused as an unavailable engine', async () => {
    const pdf = pdfWithoutPages();
    const withoutPassword = await dispatchConversion(pdf, 'pdf', 'txt', {}, 'no-pages.pdf');
    const withPassword = await dispatchConversion(pdf, 'pdf', 'txt', { password: 'x' }, 'no-pages.pdf');
    expect(withPassword.buffer.toString('utf8')).toBe(withoutPassword.buffer.toString('utf8'));
    expect(withPassword.engine).toBe(withoutPassword.engine);
  });
});
