import { afterAll, expect } from 'vitest';
import { shutdownPdfTextThreads } from '../src/lib/conversions/pdf-text-host';
import { executeWorkerConversion } from '../src/worker/engines';
import { htmlText, lostCharacters } from './helpers/html-pdf-oracle';
import { pdfFacts } from './helpers/corpus-facts';
import { oracleTest } from './helpers/oracle-test';
import { requireRealworldSample } from './helpers/realworld-sample';

/**
 * `govdocs1-001120.html` (145 tables) sends the office suite's Writer/Web layout into a loop at a page break: measured on LibreOffice
 * 25.2.3.2 (Debian 13), neither the page as it is nor the staged page ends after 90 s, and the loop depends on where the page breaks fall
 * (docs/policy-decisions.md entry 164). The stage time-out ends the run and the in-process renderer draws the page, which is the answer
 * whatever engine the page goes to: every letter and digit of its text is in the PDF. If a later suite finishes the layout, the test still holds.
 */

const LIBREOFFICE_TIMEOUT_MS = 240_000;

afterAll(() => shutdownPdfTextThreads());

oracleTest(
  'govdocs1-001120.html is converted with every letter and digit of its text, whichever engine draws it',
  ['soffice', 'pdftotext'],
  async (ctx) => {
    const { bytes } = await requireRealworldSample(ctx, 'govdocs1-001120.html');
    const result = await executeWorkerConversion(bytes, 'html', 'pdf', {}, 'govdocs1-001120.html');
    const facts = pdfFacts(result.buffer);
    expect({ pages: facts.pages > 0, lost: lostCharacters(htmlText(bytes.toString('latin1')), facts.text) }).toEqual({ pages: true, lost: 0 });
  },
  LIBREOFFICE_TIMEOUT_MS
);
