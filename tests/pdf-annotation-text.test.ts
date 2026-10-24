import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { dispatchConversion } from '../src/lib/conversions/dispatch';
import { convertFile } from '../src/lib/conversions/index';
import { extractPdfDocument } from '../src/lib/conversions/pdf-text-document';
import { PdfTextUnmappedError } from '../src/lib/conversions/pdf-text-types';
import { captureError } from './helpers/capture-error';
import { requireOracleTool } from './helpers/differential-oracle';
import { docxWords } from './helpers/document-words';
import {
  FLAG_HIDDEN,
  FLAG_INVISIBLE,
  FLAG_NO_VIEW,
  FLAG_PRINT,
  annotatedPdf,
  checkBoxPdf,
  damagedAppearancePdf,
  textFieldPdf,
  type AnnotationSpec,
} from './helpers/pdf-annotation-craft';
import { type CraftObject, buildPdf, flate, HELVETICA_FONT } from './helpers/pdf-craft';
import { requireRealworldSample } from './helpers/realworld-sample';
import { skipWithoutTools } from './helpers/strict-skip';

/**
 * Text drawn by annotation appearance streams. The readers are the oracles: Poppler's `pdftotext` draws every annotation
 * whose Hidden and NoView bits are clear (Annot::isVisible and Page::displaySlice, poppler/Annot.cc and Page.cc) and pdf.js
 * draws the same ones through its operator list (Annotation.mustBeViewed, src/core/annotation.js). Real files by
 * their corpus name, and hand-written pages for the flags and the subtypes.
 */

const toolsMissing = skipWithoutTools('pdftotext');
const TEST_TIMEOUT_MS = 120_000;
vi.setConfig({ testTimeout: TEST_TIMEOUT_MS });
const MAX_TOOL_OUTPUT_BYTES = 64 * 1024 * 1024;

const tempDirs: string[] = [];
afterAll(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function pdftotext(bytes: Buffer): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-annotation-'));
  tempDirs.push(dir);
  const file = path.join(dir, 'in.pdf');
  fs.writeFileSync(file, bytes);
  return execFileSync(requireOracleTool('pdftotext'), ['-q', '-enc', 'UTF-8', file, '-'], { encoding: 'utf8', maxBuffer: MAX_TOOL_OUTPUT_BYTES });
}

const readerText = async (bytes: Buffer): Promise<string> => (await extractPdfDocument(bytes, { onUnmapped: 'omit' })).text;

const wordsOf = (text: string): string[] => text.normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];

/** Share of the reference's words (as a multiset) that the hypothesis has. */
function wordRecall(reference: string, hypothesis: string): number {
  const available = new Map<string, number>();
  for (const word of wordsOf(hypothesis)) available.set(word, (available.get(word) ?? 0) + 1);
  const expected = wordsOf(reference);
  let found = 0;
  for (const word of expected) {
    const left = available.get(word) ?? 0;
    if (left > 0) {
      found++;
      available.set(word, left - 1);
    }
  }
  return found / expected.length;
}

describe.skipIf(toolsMissing)('annotation appearance text of real files', () => {
  it('pdfjs-sechandler.pdf: the caption of a push button widget is read, and pdf to txt, rtf and docx carry it', async (ctx) => {
    const { bytes } = await requireRealworldSample(ctx, 'pdfjs-sechandler.pdf');
    expect(wordsOf(pdftotext(bytes))).toEqual(['security', 'handler']);
    expect(wordsOf(await readerText(bytes))).toEqual(['security', 'handler']);
    const rtf = (await dispatchConversion(bytes, 'pdf', 'rtf', {}, 'pdfjs-sechandler.pdf')).buffer.toString('latin1');
    expect(rtf).toContain('Security Handler');
    const docx = (await dispatchConversion(bytes, 'pdf', 'docx', {}, 'pdfjs-sechandler.pdf')).buffer;
    expect((await docxWords(docx)).join(' ').toLowerCase()).toContain('security handler');
  });

  it('pdfjs-sechandler.pdf: pdf to pdf no longer stops at OCR for a page whose only text is a widget appearance', async (ctx) => {
    const { bytes } = await requireRealworldSample(ctx, 'pdfjs-sechandler.pdf');
    const result = await dispatchConversion(bytes, 'pdf', 'pdf', {}, 'pdfjs-sechandler.pdf');
    expect(result.buffer.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });

  // Each file has annotations whose appearance streams hold text that Poppler prints; the floor is what the reader reaches.
  const RECALL_FLOORS: ReadonlyArray<readonly [string, number]> = [
    ['pdf-pdfbox-annotations.pdf', 0.9],
    ['pdf-pdfbox-pdfbox3812-acrobat-multiline-auto.pdf', 0.9],
    ['pdf-pdfjs-annotation-choice-widget.pdf', 0.9],
    ['pdf-pdfjs-rotated_freetexts.pdf', 0.9],
    ['pdf-qpdf-form-filled-by-acrobat.pdf', 0.99],
    ['govdocs1-002997.pdf', 0.998],
    ['pdfjs-bug1815476.pdf', 0.99],
  ];
  for (const [id, floor] of RECALL_FLOORS) {
    it(`${id}: has at least ${floor} of the words Poppler prints`, async (ctx) => {
      const { bytes } = await requireRealworldSample(ctx, id);
      expect(wordRecall(pdftotext(bytes), await readerText(bytes))).toBeGreaterThanOrEqual(floor);
    });
  }

  it('pdfjs-issue17069.pdf: reads a text field, a free text note and a rotated watermark stamp (Poppler scatters the rotated letters)', async (ctx) => {
    const { bytes } = await requireRealworldSample(ctx, 'pdfjs-issue17069.pdf');
    const words = wordsOf(await readerText(bytes));
    for (const word of ['comment', 'value', 'watermark', 'sandbox']) expect(words).toContain(word);
  });
});

describe.skipIf(toolsMissing)('annotation appearance text against Poppler (hand-written pages)', () => {
  const specs: AnnotationSpec[] = [
    { subtype: 'Widget', text: 'WidgetCaption', y: 600 },
    { subtype: 'FreeText', text: 'FreeTextNote', y: 560 },
    { subtype: 'Stamp', text: 'StampApproved', y: 520 },
    { subtype: 'Widget', text: 'HiddenField', flags: FLAG_HIDDEN, y: 480 },
    { subtype: 'Widget', text: 'NoViewField', flags: FLAG_NO_VIEW, y: 440 },
    { subtype: 'Widget', text: 'PrintFlagOnly', flags: FLAG_PRINT, y: 400 },
    { subtype: 'Highlight', y: 320 },
    { subtype: 'Link', y: 280 },
  ];

  it('reads widget, free text and stamp appearances and leaves out the hidden and no-view ones, as Poppler does', async () => {
    const pdf = annotatedPdf(specs, 'Page body text');
    const poppler = wordsOf(pdftotext(pdf));
    expect(poppler).toEqual(['page', 'body', 'text', 'widgetcaption', 'freetextnote', 'stampapproved', 'printflagonly']);
    expect(wordsOf(await readerText(pdf))).toEqual(poppler);
  });

  it('puts annotation text where it lies on the page: below the body text after it, above it before it', async () => {
    const below = annotatedPdf([{ subtype: 'Widget', text: 'Below', y: 600 }], 'Body');
    const above = annotatedPdf([{ subtype: 'Widget', text: 'Above', y: 740 }], 'Body');
    expect(wordsOf(await readerText(below))).toEqual(wordsOf(pdftotext(below)));
    expect(wordsOf(await readerText(above))).toEqual(wordsOf(pdftotext(above)));
    expect(wordsOf(await readerText(above))).toEqual(['above', 'body']);
  });

  it('reads a page whose only text is an annotation as a page with text', async () => {
    const pdf = annotatedPdf([{ subtype: 'FreeText', text: 'Only annotation text' }]);
    expect(wordsOf(await readerText(pdf))).toEqual(['only', 'annotation', 'text']);
  });

  it('leaves the text of a page without annotations as it was', async () => {
    const pdf = annotatedPdf([], 'Just the body');
    expect(wordsOf(await readerText(pdf))).toEqual(['just', 'the', 'body']);
  });

  it('keeps the Invisible bit out of the verdict for widgets, which pdf.js and Poppler both draw', async () => {
    const pdf = annotatedPdf([{ subtype: 'Widget', text: 'InvisibleBitWidget', flags: FLAG_INVISIBLE }]);
    expect(wordsOf(pdftotext(pdf))).toEqual(['invisiblebitwidget']);
    expect(wordsOf(await readerText(pdf))).toEqual(['invisiblebitwidget']);
  });

  it('reads the value of a text field that the form asks viewers to draw (NeedAppearances), as Poppler does', async () => {
    const pdf = textFieldPdf('Typed value here', true);
    expect(wordsOf(pdftotext(pdf))).toEqual(['typed', 'value', 'here']);
    expect(wordsOf(await readerText(pdf))).toEqual(['typed', 'value', 'here']);
  });

  it('reads the state of a check box that /AS selects and not the other', async () => {
    for (const [state, drawn, hidden] of [['Yes', 'checkedstate', 'uncheckedstate'], ['Off', 'uncheckedstate', 'checkedstate']] as const) {
      const pdf = checkBoxPdf(state);
      expect(wordsOf(pdftotext(pdf))).toEqual([drawn]);
      const words = wordsOf(await readerText(pdf));
      expect(words).toEqual([drawn]);
      expect(words).not.toContain(hidden);
    }
  });

  it('draws the other annotations of a page when one appearance stream is damaged, as pdf.js does', async () => {
    const pdf = damagedAppearancePdf('Survivor');
    expect(wordsOf(pdftotext(pdf))).toEqual(['survivor']);
    expect(wordsOf(await readerText(pdf))).toEqual(['survivor']);
  });
});

/** A FreeText note: its rectangle on the page, and its appearance's box, matrix-free content and extra resources. */
interface Note {
  rect: readonly [number, number, number, number];
  bbox: readonly [number, number, number, number];
  content: string;
  xobjects?: string;
}

const NOTE_FIRST_OBJECT = 10;
/** A Helvetica whose /Differences name glyphs no list maps at codes 4 and 5, as in tests/pdf-text-unmapped-glyphs.test.ts. */
const UNMAPPED_FONT = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding << /Type /Encoding /BaseEncoding /WinAnsiEncoding /Differences [4 /ornamentone /ornamenttwo] >> >>';

/** One page (font F1 Helvetica, F2 the unmapped font) that draws `pageContent` and carries `notes`; `extra` objects start at 900. */
function notesPdf(pageContent: string, notes: readonly Note[], extra: CraftObject[] = []): Buffer {
  const objects: CraftObject[] = [];
  const references: string[] = [];
  notes.forEach((note, index) => {
    const annotation = NOTE_FIRST_OBJECT + index * 2;
    const resources = `/Resources << /Font << /F1 5 0 R >> ${note.xobjects ?? ''} >>`;
    objects.push({ id: annotation, dict: `/Type /Annot /Subtype /FreeText /F 4 /Rect [${note.rect.join(' ')}] /AP << /N ${annotation + 1} 0 R >>` });
    objects.push({ id: annotation + 1, dict: `/Type /XObject /Subtype /Form /BBox [${note.bbox.join(' ')}] ${resources}`, stream: Buffer.from(note.content, 'latin1') });
    references.push(`${annotation} 0 R`);
  });
  return buildPdf(
    [
      { id: 1, dict: '/Type /Catalog /Pages 2 0 R' },
      { id: 2, dict: '/Type /Pages /Kids [3 0 R] /Count 1' },
      { id: 3, dict: `/Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> /Annots [${references.join(' ')}]` },
      { id: 4, dict: '/Filter /FlateDecode', stream: flate(pageContent) },
      { id: 5, raw: HELVETICA_FONT },
      { id: 6, raw: UNMAPPED_FONT },
      ...objects,
      ...extra,
    ],
    1
  ).buffer;
}

const BODY = 'BT /F1 12 Tf 72 700 Td (Body) Tj ET';

describe.skipIf(toolsMissing)('where the text matrix and the forms of an appearance put its text, against Poppler', () => {
  it('places text drawn after Tm where the matrix puts it: above the body text and below it', async () => {
    // The appearance boxes are in page space, as office producers write them (cc-0400651.pdf), so the text matrix alone places the words.
    const note = (y: number, word: string): Note => ({ rect: [72, y, 192, y + 20], bbox: [72, y, 192, y + 20], content: `BT /F1 12 Tf 1 0 0 1 74 ${y + 5} Tm (${word}) Tj ET` });
    const pdf = notesPdf(BODY, [note(740, 'Above'), note(600, 'Below')]);
    expect(wordsOf(pdftotext(pdf))).toEqual(['above', 'body', 'below']);
    expect(wordsOf(await readerText(pdf))).toEqual(['above', 'body', 'below']);
  });

  it('applies the /Matrix of a form XObject the appearance draws', async () => {
    // The note spans 560 to 760; its form lifts the word from 565 (below the body) to 745 (above it).
    const lifted: Note = { rect: [72, 560, 192, 760], bbox: [0, 0, 120, 200], content: '/Fm1 Do', xobjects: '/XObject << /Fm1 900 0 R >>' };
    const form: CraftObject = {
      id: 900,
      dict: '/Type /XObject /Subtype /Form /BBox [0 0 120 200] /Matrix [1 0 0 1 0 180] /Resources << /Font << /F1 5 0 R >> >>',
      stream: Buffer.from('BT /F1 12 Tf 2 5 Td (Lifted) Tj ET', 'latin1'),
    };
    const pdf = notesPdf(BODY, [lifted], [form]);
    expect(wordsOf(pdftotext(pdf))).toEqual(['lifted', 'body']);
    expect(wordsOf(await readerText(pdf))).toEqual(['lifted', 'body']);
  });
});

/** Twelve glyphs of the unmapped font: more than the eight letters of the note, so the page's own text is left out. */
const UNMAPPED_PAGE = 'BT /F2 14 Tf 20 100 Td (\\004\\005\\004\\005\\004\\005\\004\\005\\004\\005\\004\\005) Tj ET';
const keptNote = (y = 600, text = 'Kept note'): Note => ({ rect: [72, y, 192, y + 20], bbox: [0, 0, 120, 20], content: `BT /F1 12 Tf 2 5 Td (${text}) Tj ET` });
const LEFT_OUT_KEPT = 'Left out the page text of page 1 and kept the text of its annotations: more of its glyphs have no Unicode mapping than have one.';

describe.skipIf(toolsMissing)('annotation text on a page whose own glyphs mostly have no Unicode mapping', () => {
  it('keeps the annotation text, as Poppler prints it, and leaves out the glyphs without a mapping, where the document was refused', async () => {
    const pdf = notesPdf(UNMAPPED_PAGE, [keptNote()]);
    expect(wordsOf(pdftotext(pdf))).toContain('kept');
    const result = await convertFile(pdf, 'pdf', 'txt', {}, 'note.pdf');
    expect(wordsOf(result.buffer.toString('utf8'))).toEqual(['kept', 'note']);
    expect(result.metadata?.warnings).toEqual([LEFT_OUT_KEPT]);
  });

  it('hands the whole page to OCR when OCR may read it, so the annotation text is not read twice', async () => {
    const read = await extractPdfDocument(notesPdf(UNMAPPED_PAGE, [keptNote()]), { onUnmapped: 'omit' });
    expect(read.unmappedPages).toEqual([1]);
    expect(read.text.trim()).toBe('');
  });

  it('still refuses a document whose only page has no annotation text and no glyph that maps', async () => {
    const error = await captureError(() => extractPdfDocument(notesPdf(UNMAPPED_PAGE, [])));
    expect(error).toBeInstanceOf(PdfTextUnmappedError);
    expect((error as PdfTextUnmappedError).pages).toEqual([1]);
  });

  it('keeps the text of 10,000 notes on a page whose own 50,000 glyphs have no mapping, each note once', async () => {
    const NOTES = 10_000;
    const texts = Array.from({ length: NOTES }, (_, index) => `n${index}`);
    const unmapped = `BT /F2 14 Tf 20 100 Td (${'\\004\\005'.repeat(25_000)}) Tj ET`;
    const notes = texts.map((text, index) => keptNote(20 + (index % 700), text));
    const started = performance.now();
    const read = await extractPdfDocument(notesPdf(unmapped, notes));
    expect(performance.now() - started).toBeLessThan(TEST_TIMEOUT_MS / 4);
    expect(read.pages[0].items.map((item) => item.text).sort()).toEqual([...texts].sort());
  });

  it('cc-0400651.pdf: reads the free text notes in non-embedded JSGothic-Md (90ms-RKSJ-H, Adobe-Japan1) that Poppler prints', async (ctx) => {
    const { bytes } = await requireRealworldSample(ctx, 'cc-0400651.pdf');
    // Poppler also prints the 22 private-use characters the page's own MS PMincho subset maps to, which are no text.
    const poppler = wordsOf(pdftotext(bytes));
    expect(poppler).toEqual(['中止', '別途変更あり', '別途変更あり']);
    const result = await convertFile(bytes, 'pdf', 'txt', {}, 'cc-0400651.pdf');
    expect(wordsOf(result.buffer.toString('utf8'))).toEqual(poppler);
    expect(result.metadata?.warnings).toEqual([LEFT_OUT_KEPT]);
  });
});
