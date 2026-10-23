import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { dispatchConversion } from '../src/lib/conversions/dispatch';
import { extractPdfDocument } from '../src/lib/conversions/pdf-text-document';
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
