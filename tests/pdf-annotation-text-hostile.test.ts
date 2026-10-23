import { describe, expect, it, vi } from 'vitest';
import { convertFile } from '../src/lib/conversions/index';
import { inspectPdfPagesTextDensity } from '../src/lib/conversions/ocr';
import { MAX_PDF_ANNOTATIONS, MAX_PDF_APPEARANCE_STATES, MAX_PDF_CONTENT_STREAMS, MAX_PDF_FORM_DEPTH, PdfStructureError } from '../src/lib/conversions/pdf-document';
import { runPdfTextJob } from '../src/lib/conversions/pdf-text-geometry';
import { PDF_CONTENT_MAX_STATE_DEPTH, PDF_TEXT_MAX_ITEM_CHARS, PDF_TEXT_MAX_ITEMS_PER_DOCUMENT, PDF_TEXT_MAX_ITEMS_PER_PAGE, PdfTextGeometryError } from '../src/lib/conversions/pdf-text-types';
import { DecompressionLimitError, PayloadLimitError, type PdfPageAnalysis } from '../src/lib/types';
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

/** A one-page document: `page` and `pages` are further entries of the page and of its /Pages node, `objects` further objects. */
function pageTree(objects: CraftObject[], { page = '', pages = '' }: { page?: string; pages?: string } = {}): Buffer {
  return buildPdf(
    [
      { id: 1, dict: '/Type /Catalog /Pages 2 0 R' },
      { id: 2, dict: `/Type /Pages /Kids [3 0 R] /Count 1 ${pages}` },
      { id: 3, dict: `/Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R ${FONT_RESOURCES} ${page}` },
      { id: 4, dict: '/Filter /FlateDecode', stream: flate('') },
      { id: 5, raw: HELVETICA_FONT },
      ...objects,
    ],
    1
  ).buffer;
}

/** Push button widgets with object numbers from `first`, each drawing the appearance `appearanceId`. */
function widgets(count: number, appearanceId: number, first = FIRST_ANNOTATION): CraftObject[] {
  return Array.from({ length: count }, (_, i) => ({
    id: first + i,
    dict: `/Type /Annot /Subtype /Widget /FT /Btn /Ff 65536 /T (f${i}) /Rect [72 600 272 620] /AP << /N ${appearanceId} 0 R >>`,
  }));
}

const references = (count: number, first = FIRST_ANNOTATION): string => Array.from({ length: count }, (_, i) => `${first + i} 0 R`).join(' ');

/** A page whose annotations (object numbers from FIRST_ANNOTATION) all draw the form `appearance`; `extra` are further objects. */
function pageWithAnnotations(count: number, appearance: Omit<CraftObject, 'id'>, extra: CraftObject[] = []): Buffer {
  return pageTree([{ id: SHARED_APPEARANCE, ...appearance }, ...extra, ...widgets(count, SHARED_APPEARANCE)], { page: `/Annots [${references(count)}]` });
}

const showing = (content: string): Omit<CraftObject, 'id'> => ({ dict: `${FORM} ${FONT_RESOURCES}`, stream: Buffer.from(content, 'latin1') });

async function refusal(label: string, pdf: Buffer): Promise<unknown> {
  const { largeResult } = await expectNoHangOnInput(label, attempt, pdf, HANG_GUARD_MS);
  if (largeResult.ok) throw new Error(`${label} was accepted`);
  return largeResult.error;
}

describe('annotations are counted', () => {
  it('refuses a page with more annotations than the cap before pdf.js builds any of their operator lists', async () => {
    const error = await refusal('annotations past the cap', pageWithAnnotations(MAX_PDF_ANNOTATIONS + 1, showing('BT /F1 12 Tf 2 5 Td (a) Tj ET')));
    expect(error).toBeInstanceOf(PdfStructureError);
    expect((error as Error).message).toBe(`PDF lists more than ${MAX_PDF_ANNOTATIONS} annotations.`);
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

/**
 * The guard sees the annotations pdf.js reads. pdf.js takes /Annots as an inheritable property (`Page.annotations`, through
 * `getInheritableProperty`: the page's own, else the nearest one up its /Parent chain), draws whichever state stream /AS
 * names without looking at its /Subtype (`Annotation.setAppearance`), builds an annotation for every entry of /Annots,
 * repeated or not, and builds them for every job that reads the page, the density test of OCR included.
 */
const REFUSAL_BOUND_MS = 15_000;
const RSS_BOUND_MB = 512;
const RSS_SAMPLE_MS = 20;
const BYTES_PER_MB = 1e6;
const DENSITY_THRESHOLD = 15;
const WIDGET = 7;
const APPEARANCE = 8;
const OFF_TREE_PAGES = 9;
const REPEATED_REFERENCES = 3000;
const STATES_OF_THE_PROBE = 100 * 1000;
const HIGHLIGHT_REFERENCES = 20;
const HIGHLIGHT_QUADS = 50 * 1000;
const STATE_SHARERS = 4000;
const PAGES_SHARING_ANNOTATIONS = 3;

let bombBytes: Buffer | null = null;
/** 128 MiB of spaces after a run of text, deflated once for the file. */
const bomb = (): Buffer => (bombBytes ??= flate(Buffer.concat([Buffer.from('BT /F1 12 Tf 2 5 Td (bomb) Tj ET '), Buffer.alloc(128 * MIB, 0x20)])));
const bombAppearance = (subtype = 'Form'): Omit<CraftObject, 'id'> => ({
  dict: `/Type /XObject /Subtype /${subtype} /Width 1 /Height 1 /BitsPerComponent 8 /ColorSpace /DeviceGray /BBox [0 0 200 20] ${FONT_RESOURCES} /Filter /FlateDecode`,
  stream: bomb(),
});
const widget = (appearance: string): CraftObject => ({
  id: WIDGET,
  dict: `/Type /Annot /Subtype /Widget /FT /Btn /T (w) /F 4 /AS /Yes /Rect [72 600 272 620] /AP << /N ${appearance} >>`,
});

const textJob = (pdf: Buffer): Promise<unknown> => convertFile(pdf, 'pdf', 'txt', {}, 'hostile.pdf');
const densityJob = (pdf: Buffer): Promise<unknown> => inspectPdfPagesTextDensity(pdf, DENSITY_THRESHOLD);
const geometryJob = (pdf: Buffer): Promise<unknown> => runPdfTextJob(pdf, { geometry: [1] });

/** Runs a job that must be refused; the refusal comes within REFUSAL_BOUND_MS and the process grows by less than RSS_BOUND_MB. */
async function boundedRefusal(label: string, run: (pdf: Buffer) => Promise<unknown>, pdf: Buffer): Promise<unknown> {
  const before = process.memoryUsage().rss;
  let peak = before;
  const sampler = setInterval(() => {
    peak = Math.max(peak, process.memoryUsage().rss);
  }, RSS_SAMPLE_MS);
  const started = performance.now();
  const settled = await run(pdf).then(
    () => ({ ok: true as const }),
    (error: unknown) => ({ ok: false as const, error })
  );
  clearInterval(sampler);
  const elapsed = performance.now() - started;
  const grownMb = (Math.max(peak, process.memoryUsage().rss) - before) / BYTES_PER_MB;
  if (settled.ok) throw new Error(`${label} was accepted`);
  expect(elapsed, `${label}: milliseconds to the refusal`).toBeLessThan(REFUSAL_BOUND_MS);
  expect(grownMb, `${label}: MB the process grew by`).toBeLessThan(RSS_BOUND_MB);
  return settled.error;
}

function expectStructureRefusal(error: unknown, message: string): void {
  expect(error).toBeInstanceOf(PdfStructureError);
  expect((error as Error).message).toBe(message);
}

function expectBombRefusal(error: unknown): void {
  expect(error).toBeInstanceOf(DecompressionLimitError);
  expect((error as DecompressionLimitError).status).toBe(HTTP_PAYLOAD_TOO_LARGE);
}

describe('every state stream an annotation names is decoded under the budgets', () => {
  it('refuses a check box state that is a Flate bomb marked as an image, with a typed 413', async () => {
    const pdf = pageTree([widget(`<< /Yes ${APPEARANCE} 0 R >>`), { id: APPEARANCE, ...bombAppearance('Image') }], { page: `/Annots [${WIDGET} 0 R]` });
    expectBombRefusal(await boundedRefusal('image-marked state bomb', textJob, pdf));
  });
});

describe('/Annots is read as pdf.js reads it, inherited up the /Parent chain', () => {
  const small = showing('BT /F1 12 Tf 2 5 Td (inherited) Tj ET');

  it('reads the text of an annotation listed only on the /Pages node, as pdf.js does', async () => {
    const pdf = pageTree([widget(`${APPEARANCE} 0 R`), { id: APPEARANCE, ...small }], { pages: `/Annots [${WIDGET} 0 R]` });
    expect(await textOf(pdf)).toBe('inherited');
  });

  it('refuses an appearance bomb on an annotation listed only on the /Pages node, with a typed 413', async () => {
    const pdf = pageTree([widget(`${APPEARANCE} 0 R`), { id: APPEARANCE, ...bombAppearance() }], { pages: `/Annots [${WIDGET} 0 R]` });
    expectBombRefusal(await boundedRefusal('inherited appearance bomb', textJob, pdf));
  });

  it('refuses an appearance bomb listed on a /Parent that is not in the page tree, with a typed 413', async () => {
    const pdf = pageTree(
      [widget(`${APPEARANCE} 0 R`), { id: APPEARANCE, ...bombAppearance() }, { id: OFF_TREE_PAGES, dict: `/Type /Pages /Annots [${WIDGET} 0 R]` }],
      { page: `/Parent ${OFF_TREE_PAGES} 0 R` }
    );
    expectBombRefusal(await boundedRefusal('appearance bomb on an off-tree parent', textJob, pdf));
  });

  it('counts the annotations a /Pages node lists against the cap', async () => {
    const count = MAX_PDF_ANNOTATIONS + 1;
    const pdf = pageTree([{ id: SHARED_APPEARANCE, ...small }, ...widgets(count, SHARED_APPEARANCE)], { pages: `/Annots [${references(count)}]` });
    expectStructureRefusal(await boundedRefusal('inherited annotations past the cap', textJob, pdf), `PDF lists more than ${MAX_PDF_ANNOTATIONS} annotations.`);
  });
});

describe('annotation entries are bounded as they are collected', () => {
  const repeated = (times: number, annotation: CraftObject, extra: CraftObject[] = []): Buffer =>
    pageTree([annotation, ...extra], { page: `/Annots [${Array.from({ length: times }, () => `${annotation.id} 0 R`).join(' ')}]` });

  it('refuses a page that lists one annotation twice', async () => {
    const pdf = repeated(2, widget(`${APPEARANCE} 0 R`), [{ id: APPEARANCE, ...showing('BT /F1 12 Tf 2 5 Td (twice) Tj ET') }]);
    expectStructureRefusal(await boundedRefusal('an annotation listed twice', textJob, pdf), `PDF page lists annotation ${WIDGET} more than once.`);
  });

  it('refuses 3,000 references to one widget with 100,000 states before it collects them', async () => {
    const states = Array.from({ length: STATES_OF_THE_PROBE }, (_, i) => `/s${i} ${APPEARANCE} 0 R`).join(' ');
    const pdf = repeated(REPEATED_REFERENCES, widget(`<< ${states} >>`), [{ id: APPEARANCE, ...showing('q Q') }]);
    expectStructureRefusal(await boundedRefusal('repeated widget with many states', textJob, pdf), `PDF page lists annotation ${WIDGET} more than once.`);
  });

  it('refuses 20 references to one highlight of 50,000 quadrilaterals in the density test of OCR', async () => {
    const quads = Array.from({ length: HIGHLIGHT_QUADS }, () => '10 20 30 20 10 10 30 10').join(' ');
    const highlight = { id: WIDGET, dict: `/Type /Annot /Subtype /Highlight /F 4 /C [1 1 0] /Rect [0 0 600 700] /QuadPoints [${quads}]` };
    const error = await boundedRefusal('repeated highlight', densityJob, repeated(HIGHLIGHT_REFERENCES, highlight));
    expectStructureRefusal(error, `PDF page lists annotation ${WIDGET} more than once.`);
  });

  it('reads an annotation with as many appearance states as the cap allows', async () => {
    const states = Array.from({ length: MAX_PDF_APPEARANCE_STATES - 1 }, (_, i) => `/s${i} ${APPEARANCE} 0 R`).join(' ');
    const pdf = pageTree([widget(`<< ${states} /Yes ${APPEARANCE} 0 R >>`), { id: APPEARANCE, ...showing('BT /F1 12 Tf 2 5 Td (checked) Tj ET') }], {
      page: `/Annots [${WIDGET} 0 R]`,
    });
    expect(await textOf(pdf)).toBe('checked');
  });

  it('refuses an annotation with more appearance states than the cap', async () => {
    const states = Array.from({ length: MAX_PDF_APPEARANCE_STATES + 1 }, (_, i) => `/s${i} ${APPEARANCE} 0 R`).join(' ');
    const pdf = pageTree([widget(`<< ${states} >>`), { id: APPEARANCE, ...showing('q Q') }], { page: `/Annots [${WIDGET} 0 R]` });
    const error = await boundedRefusal('states past the cap', textJob, pdf);
    expectStructureRefusal(error, `PDF annotation has more than ${MAX_PDF_APPEARANCE_STATES} appearance states.`);
  });

  it('counts each state stream as it is collected against the content-stream cap', async () => {
    const states = Array.from({ length: MAX_PDF_APPEARANCE_STATES }, (_, i) => `/s${i} ${APPEARANCE} 0 R`).join(' ');
    const sharers = Array.from({ length: STATE_SHARERS }, (_, i) => ({
      id: FIRST_ANNOTATION + i,
      dict: `/Type /Annot /Subtype /Widget /FT /Btn /T (c${i}) /Rect [0 0 10 10] /AP << /N ${OFF_TREE_PAGES} 0 R >>`,
    }));
    expect(STATE_SHARERS * MAX_PDF_APPEARANCE_STATES).toBeGreaterThan(MAX_PDF_CONTENT_STREAMS);
    const pdf = pageTree([{ id: APPEARANCE, ...showing('q Q') }, { id: OFF_TREE_PAGES, raw: `<< ${states} >>` }, ...sharers], {
      page: `/Annots [${references(STATE_SHARERS)}]`,
    });
    const error = await boundedRefusal('state streams past the content-stream cap', textJob, pdf);
    expectStructureRefusal(error, `PDF draws more than ${MAX_PDF_CONTENT_STREAMS} content streams.`);
  });
});

describe('jobs that do not read the page content still guard the annotations they read', () => {
  const bombPage = (): Buffer => pageWithAnnotations(1, bombAppearance());

  it('refuses an appearance bomb in the density test of OCR, with a typed 413', async () => {
    expectBombRefusal(await boundedRefusal('appearance bomb, density', densityJob, bombPage()));
  });

  it('refuses an appearance bomb in a word-geometry job, with a typed 413', async () => {
    expectBombRefusal(await boundedRefusal('appearance bomb, geometry', geometryJob, bombPage()));
  });

  it('refuses annotations past the cap in the density test of OCR', async () => {
    const pdf = pageWithAnnotations(MAX_PDF_ANNOTATIONS + 1, showing('BT /F1 12 Tf 2 5 Td (a) Tj ET'));
    expectStructureRefusal(await boundedRefusal('annotations past the cap, density', densityJob, pdf), `PDF lists more than ${MAX_PDF_ANNOTATIONS} annotations.`);
  });

  it('still reads the caption of a widget in the density test of OCR', async () => {
    const [analysis] = await densityJob(pageWithAnnotations(1, showing('BT /F1 12 Tf 2 5 Td (a caption long enough for the density test) Tj ET'))) as PdfPageAnalysis[];
    expect(analysis.hasTextLayer).toBe(true);
  });
});

describe('the annotations of a document are counted together', () => {
  it('refuses pages that share one list of annotations once their sum passes the cap', async () => {
    const perPage = Math.ceil((MAX_PDF_ANNOTATIONS + 1) / PAGES_SHARING_ANNOTATIONS);
    const pageIds = Array.from({ length: PAGES_SHARING_ANNOTATIONS }, (_, i) => 10 + i);
    const objects: CraftObject[] = [
      { id: 1, dict: '/Type /Catalog /Pages 2 0 R' },
      { id: 2, dict: `/Type /Pages /Count ${pageIds.length} /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}]` },
      { id: 5, raw: HELVETICA_FONT },
      { id: SHARED_APPEARANCE, ...showing('BT /F1 12 Tf 2 5 Td (shared) Tj ET') },
      { id: APPEARANCE, raw: `[${references(perPage)}]` },
      ...pageIds.map((id) => ({ id, dict: `/Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ${FONT_RESOURCES} /Annots ${APPEARANCE} 0 R` })),
      ...widgets(perPage, SHARED_APPEARANCE),
    ];
    expect(perPage).toBeLessThan(MAX_PDF_ANNOTATIONS);
    const error = await boundedRefusal('annotations of the document past the cap', textJob, buildPdf(objects, 1).buffer);
    expectStructureRefusal(error, `PDF lists more than ${MAX_PDF_ANNOTATIONS} annotations.`);
  });
});
