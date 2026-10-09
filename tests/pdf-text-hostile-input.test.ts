import { describe, expect, it, vi } from 'vitest';
import { convertFile } from '../src/lib/conversions/index';
import { graphicsStateDepth } from '../src/lib/conversions/pdf-stream-guard';
import { PDF_CONTENT_MAX_STATE_DEPTH, PDF_TEXT_MAX_ITEMS_PER_DOCUMENT, PDF_TEXT_MAX_ITEMS_PER_PAGE, PdfTextGeometryError } from '../src/lib/conversions/pdf-text-types';
import { PdfStructureError } from '../src/lib/conversions/pdf-document';
import { PayloadLimitError } from '../src/lib/types';
import { type CraftObject, buildPdf, flate, singlePagePdf } from './helpers/pdf-craft';
import { expectNoHangOnInput, type Settled } from './helpers/timing';

/**
 * Hostile PDFs against the text extractor: content streams with enormous operand runs, more text than a page or a
 * document may hold, form XObjects drawn many times or recursively, graphics-state nesting, and ToUnicode CMaps whose
 * ranges expand to billions of entries. Each runs once under a hang guard; the growth ratios of the same inputs are
 * measured by pdf-text-hostile-input.perf.test.ts. Operator semantics follow ISO 32000-1 sections 8.4 (graphics
 * state) and 9.4 (text objects); CMap syntax is Adobe Technical Note 5014. Expected values are written by hand.
 */

const HANG_GUARD_MS = 30_000;
const TEST_TIMEOUT_MS = 120_000;
const HTTP_PAYLOAD_TOO_LARGE = 413;
const OPERAND_RUN = 80 * 1000;
const FORM_BLOCKS = 1000;
const FORM_INVOCATIONS = 480;
const DOCUMENT_PAGES = 6;
const ITEMS_PER_HOSTILE_PAGE = 90 * 1000;
const UNTERMINATED_MARKERS = 100 * 1000;
const LINE = 'BT /F1 12 Tf (a) Tj ET\n';

vi.setConfig({ testTimeout: TEST_TIMEOUT_MS });

const pageWith = (content: string, extra: CraftObject[] = [], resources?: string): Buffer =>
  singlePagePdf(flate(content), extra, resources ? { resources } : {}).buffer;

const textOf = async (pdf: Buffer): Promise<string> => (await convertFile(pdf, 'pdf', 'txt', {}, 'hostile.pdf')).buffer.toString('utf8');

async function attempt(pdf: Buffer): Promise<Settled<unknown>> {
  try {
    return { ok: true, value: await convertFile(pdf, 'pdf', 'txt', {}, 'hostile.pdf') };
  } catch (error) {
    return { ok: false, error };
  }
}

describe('operator scanning terminates on a long content stream', () => {
  for (const [label, content] of [
    ['a digit run (Tm, Td operands)', `BT ${'1'.repeat(OPERAND_RUN)} ET`],
    ['a run of opening brackets (TJ)', `BT ${'['.repeat(OPERAND_RUN)} ET`],
    ['unterminated strings and hex strings', `BT ${'('.repeat(OPERAND_RUN)} Tj ${'<'.repeat(OPERAND_RUN)} Tj ET`],
  ] as const) {
    it(`reads ${label} and finds no text`, async () => {
      const { largeResult } = await expectNoHangOnInput(label, textOf, pageWith(content), HANG_GUARD_MS);
      expect(largeResult).toBe('');
    });
  }
});

describe('a document yields a bounded amount of text', () => {
  it('refuses a page with more text items than the cap, with a typed 400', async () => {
    const { largeResult } = await expectNoHangOnInput('items past the page cap', attempt, pageWith(LINE.repeat(PDF_TEXT_MAX_ITEMS_PER_PAGE + 1)), HANG_GUARD_MS);
    if (largeResult.ok) throw new Error('a page with more items than the cap was accepted');
    expect(largeResult.error).toBeInstanceOf(PdfTextGeometryError);
    expect((largeResult.error as PdfTextGeometryError).status).toBe(400);
    expect((largeResult.error as Error).message).toBe(`PDF page 1 has more than ${PDF_TEXT_MAX_ITEMS_PER_PAGE} text items.`);
  });

  it('counts the items of a form XObject once per drawing', async () => {
    // 480 drawings of a 1000-item form pass the 100,000 page cap; the count stops the extraction.
    const form: CraftObject = {
      id: 6,
      dict: '/Type /XObject /Subtype /Form /BBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >>',
      stream: Buffer.from(LINE.repeat(FORM_BLOCKS), 'latin1'),
    };
    const pdf = pageWith('/Fm0 Do\n'.repeat(FORM_INVOCATIONS), [form], '<< /Font << /F1 5 0 R >> /XObject << /Fm0 6 0 R >> >>');
    const { largeResult } = await expectNoHangOnInput('form drawings', attempt, pdf, HANG_GUARD_MS);
    if (largeResult.ok) throw new Error('the form drawings were accepted');
    expect(largeResult.error).toBeInstanceOf(PdfTextGeometryError);
    expect((largeResult.error as Error).message).toBe(`PDF page 1 has more than ${PDF_TEXT_MAX_ITEMS_PER_PAGE} text items.`);
  });

  it('counts the items of all pages together, with a typed 413', async () => {
    const objects: CraftObject[] = [
      { id: 1, dict: '/Type /Catalog /Pages 2 0 R' },
      { id: 2, dict: `/Type /Pages /Count ${DOCUMENT_PAGES} /Kids [${Array.from({ length: DOCUMENT_PAGES }, (_, i) => `${10 + i} 0 R`).join(' ')}]` },
      { id: 5, raw: '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>' },
    ];
    for (let i = 0; i < DOCUMENT_PAGES; i++) {
      objects.push({ id: 10 + i, dict: `/Type /Page /Parent 2 0 R /Contents ${100 + i} 0 R /Resources << /Font << /F1 5 0 R >> >>` });
      objects.push({ id: 100 + i, dict: '/Filter /FlateDecode', stream: flate(LINE.repeat(ITEMS_PER_HOSTILE_PAGE)) });
    }
    expect(DOCUMENT_PAGES * ITEMS_PER_HOSTILE_PAGE).toBeGreaterThan(PDF_TEXT_MAX_ITEMS_PER_DOCUMENT);
    const { largeResult } = await expectNoHangOnInput('items past the document cap', attempt, buildPdf(objects, 1).buffer, HANG_GUARD_MS);
    if (largeResult.ok) throw new Error('a document with more items than the cap was accepted');
    expect(largeResult.error).toBeInstanceOf(PayloadLimitError);
    expect((largeResult.error as PayloadLimitError).status).toBe(HTTP_PAYLOAD_TOO_LARGE);
    expect((largeResult.error as Error).message).toMatch(/document limit of 500000 text items/);
  });

  it('keeps a page of ordinary size, its lines read as one paragraph in order', async () => {
    const lines = Array.from({ length: 50 }, (_, i) => `BT /F1 12 Tf 72 ${700 - i * 14} Td (LINE-${i}) Tj ET\n`).join('');
    const text = await textOf(pageWith(lines));
    expect(text.trim()).toBe(Array.from({ length: 50 }, (_, i) => `LINE-${i}`).join(' '));
  });
});

describe('graphics-state nesting', () => {
  it('counts q operators by hand-worked cases and ignores those inside strings, names, comments and inline images', () => {
    expect(graphicsStateDepth('q q Q q')).toBe(2);
    expect(graphicsStateDepth('q q q Q Q Q Q q')).toBe(3);
    expect(graphicsStateDepth('BT (q q q) Tj ET')).toBe(0);
    expect(graphicsStateDepth('<7171> Tj /q q % q q\nq')).toBe(2);
    expect(graphicsStateDepth('BI /W 1 /H 1 ID q q q EI Q q')).toBe(1);
    expect(graphicsStateDepth('(a\\) q q) Tj q')).toBe(1);
  });

  it('refuses a stream that nests the state past the limit before the reader copies it quadratically', async () => {
    const { largeResult } = await expectNoHangOnInput('q nesting', attempt, pageWith('q '.repeat(100 * 1000) + 'BT (a) Tj ET'), HANG_GUARD_MS);
    if (largeResult.ok) throw new Error('the nested stream was accepted');
    expect(largeResult.error).toBeInstanceOf(PdfStructureError);
    expect((largeResult.error as Error).message).toBe(`A content stream nests the graphics state deeper than ${PDF_CONTENT_MAX_STATE_DEPTH} levels`);
  });

  it('reads a stream that nests right up to the limit', async () => {
    const content = `${'q '.repeat(PDF_CONTENT_MAX_STATE_DEPTH)}BT /F1 12 Tf (deep) Tj ET ${'Q '.repeat(PDF_CONTENT_MAX_STATE_DEPTH)}`;
    expect(await textOf(pageWith(content))).toBe('deep');
  });

  it('refuses a form XObject that draws itself', async () => {
    const form: CraftObject = {
      id: 6,
      dict: '/Type /XObject /Subtype /Form /BBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> /XObject << /Fm0 6 0 R >> >>',
      stream: Buffer.from('BT /F1 12 Tf (x) Tj ET /Fm0 Do', 'latin1'),
    };
    const pdf = pageWith('/Fm0 Do', [form], '<< /Font << /F1 5 0 R >> /XObject << /Fm0 6 0 R >> >>');
    const { largeResult } = await expectNoHangOnInput('self-drawing form', attempt, pdf, HANG_GUARD_MS);
    if (largeResult.ok) throw new Error('the recursive form was accepted');
    expect(largeResult.error).toBeInstanceOf(PdfStructureError);
    expect((largeResult.error as Error).message).toBe('PDF form XObject draws itself.');
  });
});

describe('ToUnicode CMaps that declare enormous ranges', () => {
  const wrap = (body: string): string => `/CIDInit /ProcSet findresource begin begincmap ${body} endcmap`;

  /** A page that shows code 1 of a font whose ToUnicode stream is `cmap`. */
  function pdfWithToUnicode(cmap: string): Buffer {
    const objects: CraftObject[] = [
      { id: 1, dict: '/Type /Catalog /Pages 2 0 R' },
      { id: 2, dict: '/Type /Pages /Kids [3 0 R] /Count 1' },
      { id: 3, dict: '/Type /Page /Parent 2 0 R /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >>' },
      { id: 4, dict: '/Filter /FlateDecode', stream: flate('BT /F1 12 Tf 10 700 Td <0001> Tj ET') },
      { id: 5, raw: '<< /Type /Font /Subtype /Type0 /BaseFont /Evil /Encoding /Identity-H /ToUnicode 6 0 R >>' },
      { id: 6, dict: '/Filter /FlateDecode', stream: flate(cmap) },
    ];
    return buildPdf(objects, 1).buffer;
  }

  const hostile: Array<[string, string]> = [
    ['a range 16 million wide', wrap('1 beginbfrange <00000000> <00FFFFFF> <0041> endbfrange')],
    ['a range 268 million wide', wrap('1 beginbfrange <00000000> <0FFFFFFF> <0041> endbfrange')],
    ['32 overlapping ranges of 65,536', wrap(`32 beginbfrange ${'<00010000> <0001FFFF> <0041>\n'.repeat(32)} endbfrange`)],
    ['an array range declared 4 billion wide', wrap('1 beginbfrange <00000000> <FFFFFFFF> [<0041> <0042>] endbfrange')],
    ['many unterminated beginbfchar markers', 'beginbfchar '.repeat(UNTERMINATED_MARKERS)],
    ['many unterminated beginbfrange markers', 'beginbfrange '.repeat(UNTERMINATED_MARKERS)],
    ['many unterminated begincidchar markers', 'begincidchar '.repeat(UNTERMINATED_MARKERS)],
    ['many unterminated array ranges', `beginbfrange ${'<0001> <0002> [ '.repeat(UNTERMINATED_MARKERS)}endbfrange`],
  ];
  for (const [label, cmap] of hostile) {
    it(`finishes on ${label} without expanding it, and returns no text for the unmapped glyph`, async () => {
      const { largeResult } = await expectNoHangOnInput(label, textOf, pdfWithToUnicode(cmap), HANG_GUARD_MS);
      expect(largeResult).toBe('');
    });
  }
});
