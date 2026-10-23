import { describe, expect, it, vi } from 'vitest';
import { convertFile } from '../src/lib/conversions/index';
import { MAX_PDF_ANNOTATIONS_PER_PAGE, MAX_PDF_FORM_DEPTH, PdfStructureError } from '../src/lib/conversions/pdf-document';
import { PDF_CONTENT_MAX_STATE_DEPTH, PDF_TEXT_MAX_ITEM_CHARS, PDF_TEXT_MAX_ITEMS_PER_DOCUMENT, PDF_TEXT_MAX_ITEMS_PER_PAGE, PdfTextGeometryError } from '../src/lib/conversions/pdf-text-types';
import { DecompressionLimitError, PayloadLimitError } from '../src/lib/types';
import { type CraftObject, buildPdf, flate, HELVETICA_FONT } from './helpers/pdf-craft';
import { expectNoHangOnInput, type Settled } from './helpers/timing';

/**
 * Hostile PDFs whose text is in annotation appearance streams: more annotations than a page can hold, appearances that
 * draw forms nested too deeply or themselves, appearances that inflate past the stream and document budgets, and
 * appearances with more runs or characters than a page or a document may hold. The limits are those the page's own content has
 * (pdf-stream-guard.ts, pdf-text-types.ts); the annotation cap is the reader's own, since neither pdf.js nor Poppler
 * has one. Each input runs once under a hang guard.
 */

const HANG_GUARD_MS = 60_000;
const TEST_TIMEOUT_MS = 180_000;
const HTTP_PAYLOAD_TOO_LARGE = 413;
const ANNOTATION_COUNT_SHARING_ONE_APPEARANCE = 20_000;
const FIRST_ANNOTATION = 100;
const SHARED_APPEARANCE = 6;
const MIB = 1024 * 1024;
const RUNS_PER_HOSTILE_PAGE = 90 * 1000;
const DOCUMENT_PAGES = 6;

vi.setConfig({ testTimeout: TEST_TIMEOUT_MS });

const FORM = '/Type /XObject /Subtype /Form /BBox [0 0 200 20]';
const FONT_RESOURCES = '/Resources << /Font << /F1 5 0 R >> >>';

async function attempt(pdf: Buffer): Promise<Settled<unknown>> {
  try {
    return { ok: true, value: await convertFile(pdf, 'pdf', 'txt', {}, 'hostile.pdf') };
  } catch (error) {
    return { ok: false, error };
  }
}

const textOf = async (pdf: Buffer): Promise<string> => (await convertFile(pdf, 'pdf', 'txt', {}, 'hostile.pdf')).buffer.toString('utf8');

/** A page whose annotations (object numbers from FIRST_ANNOTATION) all draw the form `appearance`; `extra` are further objects. */
function pageWithAnnotations(count: number, appearance: Omit<CraftObject, 'id'>, extra: CraftObject[] = []): Buffer {
  const annotations = Array.from({ length: count }, (_, i) => `${FIRST_ANNOTATION + i} 0 R`).join(' ');
  const objects: CraftObject[] = [
    { id: 1, dict: '/Type /Catalog /Pages 2 0 R' },
    { id: 2, dict: '/Type /Pages /Kids [3 0 R] /Count 1' },
    { id: 3, dict: `/Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R ${FONT_RESOURCES} /Annots [${annotations}]` },
    { id: 4, dict: '/Filter /FlateDecode', stream: flate('') },
    { id: 5, raw: HELVETICA_FONT },
    { id: SHARED_APPEARANCE, ...appearance },
    ...extra,
  ];
  for (let i = 0; i < count; i++) {
    objects.push({ id: FIRST_ANNOTATION + i, dict: `/Type /Annot /Subtype /Widget /FT /Btn /Ff 65536 /T (f${i}) /Rect [72 600 272 620] /AP << /N ${SHARED_APPEARANCE} 0 R >>` });
  }
  return buildPdf(objects, 1).buffer;
}

const showing = (content: string): Omit<CraftObject, 'id'> => ({ dict: `${FORM} ${FONT_RESOURCES}`, stream: Buffer.from(content, 'latin1') });

async function refusal(label: string, pdf: Buffer): Promise<unknown> {
  const { largeResult } = await expectNoHangOnInput(label, attempt, pdf, HANG_GUARD_MS);
  if (largeResult.ok) throw new Error(`${label} was accepted`);
  return largeResult.error;
}

describe('annotations are counted', () => {
  it('refuses a page with more annotations than the cap before pdf.js builds any of their operator lists', async () => {
    const error = await refusal('annotations past the cap', pageWithAnnotations(MAX_PDF_ANNOTATIONS_PER_PAGE + 1, showing('BT /F1 12 Tf 2 5 Td (a) Tj ET')));
    expect(error).toBeInstanceOf(PdfStructureError);
    expect((error as Error).message).toBe(`PDF page lists more than ${MAX_PDF_ANNOTATIONS_PER_PAGE} annotations.`);
  });

  it('reads many annotations that share one appearance, which draw the same text once', async () => {
    const pdf = pageWithAnnotations(ANNOTATION_COUNT_SHARING_ONE_APPEARANCE, showing('BT /F1 12 Tf 2 5 Td (shared) Tj ET'));
    const { largeResult } = await expectNoHangOnInput('shared appearance', textOf, pdf, HANG_GUARD_MS);
    expect(largeResult).toBe('shared');
  });
});

describe('appearance streams are bounded like page content', () => {
  const formChain = (depth: number): { appearance: Omit<CraftObject, 'id'>; extra: CraftObject[] } => {
    const extra: CraftObject[] = [];
    for (let level = 1; level <= depth; level++) {
      const inner = level === depth ? 'BT /F1 12 Tf 2 5 Td (deepest) Tj ET' : `/Fm${level + 1} Do`;
      const next = level === depth ? '' : `/XObject << /Fm${level + 1} ${SHARED_APPEARANCE + level + 1} 0 R >>`;
      extra.push({ id: SHARED_APPEARANCE + level, dict: `${FORM} /Resources << /Font << /F1 5 0 R >> ${next} >>`, stream: Buffer.from(inner, 'latin1') });
    }
    return { appearance: { dict: `${FORM} /Resources << /Font << /F1 5 0 R >> /XObject << /Fm1 ${SHARED_APPEARANCE + 1} 0 R >> >>`, stream: Buffer.from('/Fm1 Do', 'latin1') }, extra };
  };

  it('reads an appearance whose forms nest right up to the limit', async () => {
    const { appearance, extra } = formChain(MAX_PDF_FORM_DEPTH);
    expect(await textOf(pageWithAnnotations(1, appearance, extra))).toBe('deepest');
  });

  it('refuses an appearance whose forms nest past the limit', async () => {
    const { appearance, extra } = formChain(MAX_PDF_FORM_DEPTH + 1);
    const error = await refusal('nested appearance forms', pageWithAnnotations(1, appearance, extra));
    expect(error).toBeInstanceOf(PdfStructureError);
    expect((error as Error).message).toBe('PDF form XObjects are nested too deeply.');
  });

  it('refuses an appearance that draws itself', async () => {
    const appearance = { dict: `${FORM} /Resources << /Font << /F1 5 0 R >> /XObject << /Fm0 ${SHARED_APPEARANCE} 0 R >> >>`, stream: Buffer.from('BT /F1 12 Tf (x) Tj ET /Fm0 Do', 'latin1') };
    const error = await refusal('self-drawing appearance', pageWithAnnotations(1, appearance));
    expect(error).toBeInstanceOf(PdfStructureError);
    expect((error as Error).message).toBe('PDF form XObject draws itself.');
  });

  it('refuses an appearance that nests the graphics state past the limit', async () => {
    const error = await refusal('q nesting in an appearance', pageWithAnnotations(1, showing(`${'q '.repeat(100 * 1000)}BT (a) Tj ET`)));
    expect(error).toBeInstanceOf(PdfStructureError);
    expect((error as Error).message).toBe(`A content stream nests the graphics state deeper than ${PDF_CONTENT_MAX_STATE_DEPTH} levels`);
  });

  it('refuses an appearance that inflates past the stream cap, with a typed 413', async () => {
    const bomb = { dict: `${FORM} ${FONT_RESOURCES} /Filter /FlateDecode`, stream: flate(Buffer.alloc(128 * MIB, 0x20)) };
    const error = await refusal('appearance bomb', pageWithAnnotations(1, bomb));
    expect(error).toBeInstanceOf(DecompressionLimitError);
    expect((error as DecompressionLimitError).status).toBe(HTTP_PAYLOAD_TOO_LARGE);
  });

  it('counts the bytes of a shared appearance once per annotation that draws it', async () => {
    // Seven annotations draw one 40 MiB appearance: 280 MiB pass the 256 MiB document budget, though no one stream is over its cap.
    const wide = { dict: `${FORM} ${FONT_RESOURCES} /Filter /FlateDecode`, stream: flate(Buffer.alloc(40 * MIB, 0x20)) };
    const error = await refusal('shared wide appearance', pageWithAnnotations(7, wide));
    expect(error).toBeInstanceOf(DecompressionLimitError);
    expect((error as DecompressionLimitError).status).toBe(HTTP_PAYLOAD_TOO_LARGE);
  });
});

describe('annotation text counts against the text limits', () => {
  const runs = (count: number): string => `BT /F1 12 Tf ${'(a) Tj 1 0 Td '.repeat(count)} ET`;

  it('refuses a page whose annotations draw more text items than the page cap, with a typed 400', async () => {
    const error = await refusal('annotation items past the page cap', pageWithAnnotations(1, showing(runs(PDF_TEXT_MAX_ITEMS_PER_PAGE + 1))));
    expect(error).toBeInstanceOf(PdfTextGeometryError);
    expect((error as PdfTextGeometryError).status).toBe(400);
    expect((error as Error).message).toBe(`PDF page 1 has more than ${PDF_TEXT_MAX_ITEMS_PER_PAGE} text items.`);
  });

  it('refuses a text item of an annotation longer than the item cap', async () => {
    const error = await refusal('annotation item past the item cap', pageWithAnnotations(1, showing(`BT /F1 12 Tf (${'a'.repeat(PDF_TEXT_MAX_ITEM_CHARS + 1)}) Tj ET`)));
    expect(error).toBeInstanceOf(PdfTextGeometryError);
    expect((error as Error).message).toBe(`PDF page 1 has a text item longer than ${PDF_TEXT_MAX_ITEM_CHARS} characters.`);
  });

  it('counts the items of the annotations of all pages together, with a typed 413', async () => {
    const objects: CraftObject[] = [
      { id: 1, dict: '/Type /Catalog /Pages 2 0 R' },
      { id: 2, dict: `/Type /Pages /Count ${DOCUMENT_PAGES} /Kids [${Array.from({ length: DOCUMENT_PAGES }, (_, i) => `${10 + i} 0 R`).join(' ')}]` },
      { id: 5, raw: HELVETICA_FONT },
    ];
    for (let i = 0; i < DOCUMENT_PAGES; i++) {
      objects.push({ id: 10 + i, dict: `/Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ${FONT_RESOURCES} /Annots [${20 + i} 0 R]` });
      objects.push({ id: 20 + i, dict: `/Type /Annot /Subtype /Widget /FT /Btn /Ff 65536 /T (p${i}) /Rect [72 600 272 620] /AP << /N ${30 + i} 0 R >>` });
      objects.push({ id: 30 + i, dict: `${FORM} ${FONT_RESOURCES} /Filter /FlateDecode`, stream: flate(runs(RUNS_PER_HOSTILE_PAGE)) });
    }
    expect(DOCUMENT_PAGES * RUNS_PER_HOSTILE_PAGE).toBeGreaterThan(PDF_TEXT_MAX_ITEMS_PER_DOCUMENT);
    const error = await refusal('annotation items past the document cap', buildPdf(objects, 1).buffer);
    expect(error).toBeInstanceOf(PayloadLimitError);
    expect((error as PayloadLimitError).status).toBe(HTTP_PAYLOAD_TOO_LARGE);
    expect((error as Error).message).toMatch(/document limit of 500000 text items/);
  });
});
