import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import JSZip from 'jszip';
import sharp from 'sharp';
import { PDFDocument } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { dispatchConversion } from '../src/lib/conversions/dispatch';
import { pdfTextFailure, pdfTextFailureKindOf } from '../src/lib/conversions/pdf-text-types';
import { readPdfDocument } from '../src/lib/conversions/pdf-text-document';
import { analyzePdfPagesInProcess } from '../src/lib/conversions/pdf-text-geometry';
import { PDF_TEXT_MAX_PAGES } from '../src/lib/conversions/pdf-text-types';
import { extractTextFromDoc, extractTextFromRtf } from '../src/lib/conversions/office';
import { readCfbfWorkbookSheets } from '../src/lib/conversions/office/xls-parse';
import { InvalidPageRangeError } from '../src/lib/types';
import { captureError } from './helpers/capture-error';
import { AES_256, plainPdf, qpdfEncrypt, withTempDir } from './helpers/encrypted-pdf-fixtures';
import { requireOracleTool } from './helpers/differential-oracle';
import { rawPdf, run } from './helpers/raw-pdf';
import { skipUnless, skipWithoutTools } from './helpers/strict-skip';
import { hasTesseractLanguage } from './helpers/tessdata';

/**
 * `pages` for PDF to TXT, DOCX, HTML, XLSX, XLS, PPTX, RTF and DOC: the readers take the pages a request selects, with the syntax, the limits and the
 * refusals of the page-image chains. The expected text of a selection is what Poppler's `pdftotext -f first -l last` reads from the
 * same file (an independent reader, run once for each run of selected pages); the pages of an output are told by a word that each
 * page of the document holds once, and by the sheets of a workbook.
 */

const SKIP = skipWithoutTools('pdftotext', 'pdfinfo', 'qpdf');
/** A PDF written to XLS starts the office suite, which takes seconds on a loaded runner; the default 5 s is for the in-process cases. */
const ENGINE_TEST_TIMEOUT_MS = 60_000;

/** One word per page of the six-page document: the page that holds a word is the page that has its index. */
const WORDS = ['APRICOT', 'BANANA', 'CHERRY', 'DAMSON', 'ELDERBERRY', 'FIGWORT'] as const;
const IN_PROCESS = { engine: 'easyconvert' } as const;

const MULTIPAGE = fs.readFileSync(path.join(__dirname, 'fixtures', 'pdf-text', 'multipage.pdf'));
const sixPages = (): Promise<Buffer> => plainPdf(WORDS.map((word, index) => `Page ${index + 1} holds ${word} only`));

/** The runs of consecutive pages of `pages`, each as the first and last page of a `pdftotext -f -l` run. */
function runsOf(pages: readonly number[]): [number, number][] {
  const runs: [number, number][] = [];
  for (const page of pages) {
    const last = runs.at(-1);
    if (last !== undefined && last[1] + 1 === page) last[1] = page;
    else runs.push([page, page]);
  }
  return runs;
}

/** What `pdftotext -f first -l last` reads from `pdf` for every run of `pages`, one after the other. */
function pdftotextOf(pdf: Buffer, pages: readonly number[], extra: string[] = []): string {
  return withTempDir((dir) => {
    const file = path.join(dir, 'in.pdf');
    fs.writeFileSync(file, pdf);
    return runsOf(pages)
      .map(([first, last]) => execFileSync(requireOracleTool('pdftotext'), ['-f', String(first), '-l', String(last), ...extra, file, '-'], { encoding: 'utf-8' }))
      .join('');
  });
}

const tokens = (text: string): string[] => text.split(/\s+/).filter(Boolean);
const wordsIn = (text: string): string[] => WORDS.filter((word) => text.includes(word));

async function parts(buffer: Buffer): Promise<JSZip> {
  return JSZip.loadAsync(buffer);
}

async function docxText(buffer: Buffer): Promise<string> {
  const xml = await (await parts(buffer)).file('word/document.xml')!.async('string');
  return xml.replace(/<\/w:p>/g, ' ').replace(/<[^>]+>/g, '');
}

/** The names of the sheets of a workbook, in order. */
async function sheetNames(buffer: Buffer): Promise<string[]> {
  const xml = await (await parts(buffer)).file('xl/workbook.xml')!.async('string');
  return [...xml.matchAll(/<sheet [^>]*name="([^"]*)"/g)].map((match) => match[1]);
}

/** The slides of a presentation, each as its text, in order. */
async function slideTexts(buffer: Buffer): Promise<string[]> {
  const zip = await parts(buffer);
  const names = Object.keys(zip.files).filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name)).sort((a, b) => Number(a.match(/\d+/)![0]) - Number(b.match(/\d+/)![0]));
  return Promise.all(names.map(async (name) => (await zip.file(name)!.async('string')).replace(/<[^>]+>/g, ' ')));
}

function htmlText(buffer: Buffer): string {
  return buffer.toString('utf-8').replace(/<(style|title)[\s\S]*?<\/\1>/g, ' ').replace(/<[^>]+>/g, ' ');
}

/** [spec, the pages it selects of a six-page document]: single pages, ranges, open ends, gaps and spaces. */
const SELECTIONS: [string, number[]][] = [
  ['3', [3]],
  ['2-4', [2, 3, 4]],
  ['-2', [1, 2]],
  ['5-', [5, 6]],
  ['1,3,5-6', [1, 3, 5, 6]],
  [' 1, 3-4 ,6 ', [1, 3, 4, 6]],
  ['4,2,2-3', [2, 3, 4]],
];

describe.skipIf(SKIP)('pages of a PDF converted to text, HTML, DOCX and XLSX', () => {
  describe.each(SELECTIONS)('pages %j', (spec, selected) => {
    it('TXT by pdftotext is the text pdftotext reads for those pages', async () => {
      const pdf = await sixPages();
      const result = await dispatchConversion(pdf, 'pdf', 'txt', { pages: spec }, 'doc.pdf');
      expect(result.engineUsed).toBe('native-poppler');
      expect(result.buffer.toString('utf-8')).toBe(pdftotextOf(pdf, selected));
    });

    it('TXT by the built-in reader holds the words pdftotext reads for those pages', async () => {
      const pdf = await sixPages();
      const result = await dispatchConversion(pdf, 'pdf', 'txt', { pages: spec, ...IN_PROCESS }, 'doc.pdf');
      expect(result.engineUsed).toBe('internal-fallback');
      expect(tokens(result.buffer.toString('utf-8'))).toEqual(tokens(pdftotextOf(pdf, selected)));
    });

    it('HTML holds the words of those pages and no other', async () => {
      const pdf = await sixPages();
      const result = await dispatchConversion(pdf, 'pdf', 'html', { pages: spec }, 'doc.pdf');
      const text = htmlText(result.buffer);
      expect(wordsIn(text)).toEqual(selected.map((page) => WORDS[page - 1]));
      expect(tokens(text)).toEqual(tokens(pdftotextOf(pdf, selected)));
    });

    it('DOCX holds the words of those pages and no other', async () => {
      const pdf = await sixPages();
      const result = await dispatchConversion(pdf, 'pdf', 'docx', { pages: spec }, 'doc.pdf');
      const text = await docxText(result.buffer);
      expect(wordsIn(text)).toEqual(selected.map((page) => WORDS[page - 1]));
      expect(tokens(text)).toEqual(tokens(pdftotextOf(pdf, selected)));
    });

    it('XLSX has one sheet for each of those pages, named after the page', async () => {
      const pdf = await sixPages();
      const result = await dispatchConversion(pdf, 'pdf', 'xlsx', { pages: spec }, 'doc.pdf');
      expect(await sheetNames(result.buffer)).toEqual(selected.map((page) => `Page ${page}`));
    });
  });

  it('keeps the layout option of pdftotext with a selection', async () => {
    const pdf = await sixPages();
    const result = await dispatchConversion(pdf, 'pdf', 'txt', { pages: '2,4', layout: true }, 'doc.pdf');
    expect(result.buffer.toString('utf-8')).toBe(pdftotextOf(pdf, [2, 4], ['-layout']));
  });

  it('reads a real multi-page PDF as pdftotext does, in every target', async () => {
    const expected = pdftotextOf(MULTIPAGE, [2, 3]);
    const txt = await dispatchConversion(MULTIPAGE, 'pdf', 'txt', { pages: '2-3' }, 'm.pdf');
    expect(txt.buffer.toString('utf-8')).toBe(expected);
    const html = await dispatchConversion(MULTIPAGE, 'pdf', 'html', { pages: '2-3' }, 'm.pdf');
    expect(tokens(htmlText(html.buffer))).toEqual(tokens(expected));
    const docx = await dispatchConversion(MULTIPAGE, 'pdf', 'docx', { pages: '2-3' }, 'm.pdf');
    expect(tokens(await docxText(docx.buffer))).toEqual(tokens(expected));
    const xlsx = await dispatchConversion(MULTIPAGE, 'pdf', 'xlsx', { pages: '2-3' }, 'm.pdf');
    expect(await sheetNames(xlsx.buffer)).toEqual(['Page 2', 'Page 3']);
  });

  it('takes the page option as the page the selection names', async () => {
    const pdf = await sixPages();
    for (const options of [{ page: 5 }, { page: 5, pages: '5' }, { page: null, pages: '5' }]) {
      const text = (await dispatchConversion(pdf, 'pdf', 'txt', options as never, 'doc.pdf')).buffer.toString('utf-8');
      expect(wordsIn(text)).toEqual(['ELDERBERRY']);
    }
  });

  it('reads every page when the selection is absent, null or blank', async () => {
    const pdf = await sixPages();
    for (const pages of [undefined, null, '', '  ']) {
      const result = await dispatchConversion(pdf, 'pdf', 'txt', { pages } as never, 'doc.pdf');
      expect(result.buffer.toString('utf-8')).toBe(pdftotextOf(pdf, [1, 2, 3, 4, 5, 6]));
    }
  });

  describe.each(['txt', 'html', 'docx', 'xlsx'])('a selection the document cannot satisfy, to %s', (target) => {
    it.each([
      ['a page past the end', '7', /Page number 7 exceeds document page count of 6\./],
      ['a range past the end', '5-9', /Range 5-9 exceeds document page count of 6\./],
      ['a backward range', '4-2', /cannot exceed range end/],
      ['text that is no page range', '1;2', /Invalid character in page range token/],
      ['page 0', '0', /Page numbers must be >= 1/],
    ])('refuses %s with InvalidPageRangeError (invalid_pages)', async (_what, pages, message) => {
      const pdf = await sixPages();
      for (const engine of [{}, IN_PROCESS]) {
        const error = await captureError(() => dispatchConversion(pdf, 'pdf', target, { pages, ...engine }, 'doc.pdf'));
        expect(error).toBeInstanceOf(InvalidPageRangeError);
        expect(error.message).toMatch(message);
        expect((error as InvalidPageRangeError).refusalCode).toBe('invalid_pages');
      }
    });

    it('refuses a page option past the end and a page and pages that name different pages', async () => {
      const pdf = await sixPages();
      const past = await captureError(() => dispatchConversion(pdf, 'pdf', target, { page: 9 }, 'doc.pdf'));
      expect(past).toBeInstanceOf(InvalidPageRangeError);
      const different = await captureError(() => dispatchConversion(pdf, 'pdf', target, { page: 2, pages: '3' }, 'doc.pdf'));
      expect(different.message).toMatch(/The "page" option \(2\) and the "pages" option \("3"\) select different pages/);
    });
  });

  it('refuses a specification longer than the limit of the page-image chains', async () => {
    const pdf = await sixPages();
    const error = await captureError(() => dispatchConversion(pdf, 'pdf', 'docx', { pages: `${'1,'.repeat(4500)}1` }, 'doc.pdf'));
    expect(error).toBeInstanceOf(InvalidPageRangeError);
    expect(error.message).toMatch(/longer than 8192 characters/);
  });

  it('reads the selected page only for hOCR, as entry 393 amends entry 373 for the targets it listed as unselected', async () => {
    const pdf = await sixPages();
    const hocr = await dispatchConversion(pdf, 'pdf', 'hocr', { pages: '2' }, 'doc.pdf');
    expect(wordsIn(hocr.buffer.toString('utf-8'))).toEqual(['BANANA']);
  });

  describe('a PDF with a password and owner restrictions', () => {
    const locked = async (): Promise<Buffer> =>
      qpdfEncrypt(await sixPages(), { variant: AES_256, userPassword: 'open-sesame', ownerPassword: 'owner-secret-1', modify: 'none' });

    it.each(['txt', 'html', 'docx', 'xlsx'])('is read to %s for the pages selected without editing rights being confirmed', async (target) => {
      const result = await dispatchConversion(await locked(), 'pdf', target, { pages: '2,5', password: 'open-sesame' }, 'doc.pdf');
      const text = target === 'xlsx' ? (await sheetNames(result.buffer)).join(' ') : target === 'docx' ? await docxText(result.buffer) : result.buffer.toString('utf-8');
      if (target === 'xlsx') expect(text).toBe('Page 2 Page 5');
      else expect(wordsIn(text)).toEqual(['BANANA', 'ELDERBERRY']);
    });

    it.each(['txt', 'docx'])('is refused for a wrong password to %s, with the pages selected', async (target) => {
      const error = await captureError(async () => dispatchConversion(await locked(), 'pdf', target, { pages: '2', password: 'wrong' }, 'doc.pdf'));
      expect(error.name).toMatch(/Password/);
    });
  });

  describe('the reader of the text layer', () => {
    it('reads the pages of a selection only: their analysis, their content and their geometry', async () => {
      const pdf = await sixPages();
      const read = await readPdfDocument(pdf, { densityThreshold: 5, geometry: 'text-pages', select: { pages: '2-3,6' } });
      expect(read.analyses.map((analysis) => analysis.pageNumber)).toEqual([2, 3, 6]);
      expect(read.extracted.pages.map((page) => page.pageNumber)).toEqual([2, 3, 6]);
      expect([...read.geometry.keys()]).toEqual([2, 3, 6]);
    });

    it('carries the refusal of a selection across the reader thread as InvalidPageRangeError', async () => {
      const error = await captureError(() => readPdfDocument(MULTIPAGE, { select: { pages: '4' } }));
      expect(error).toBeInstanceOf(InvalidPageRangeError);
      expect(pdfTextFailureKindOf(error)).toBe('invalid-pages');
      expect(pdfTextFailure('invalid-pages', 'x')).toBeInstanceOf(InvalidPageRangeError);
    });

    it('counts the pages a selection reads against the limit of the reader, not the pages of the document', async () => {
      const pages = Array.from({ length: PDF_TEXT_MAX_PAGES + 1 }, (_, at) => ({ width: 100, height: 100, content: run(`Page ${at + 1}`, 10, 50, 12) }));
      const big = rawPdf(pages);
      const read = await analyzePdfPagesInProcess(big, { geometry: 'none', content: true, select: { pages: '1-3,2001' } });
      expect(read.content.map((page) => page.pageNumber)).toEqual([1, 2, 3, 2001]);
      await expect(analyzePdfPagesInProcess(big, { geometry: 'none', content: true, select: { pages: '1-2001' } })).rejects.toMatchObject({
        name: 'PayloadLimitError',
        message: `The selection reads ${PDF_TEXT_MAX_PAGES + 1} pages; at most ${PDF_TEXT_MAX_PAGES} can be read.`,
      });
    }, 60_000);
  });
});

/** The pages of a six-page document that a conversion to `target` holds, told by the word each page has, or by the sheets of a workbook. */
async function pagesHeld(target: string, buffer: Buffer): Promise<string[]> {
  switch (target) {
    case 'xls':
      return readCfbfWorkbookSheets(buffer).map((sheet) => sheet.name ?? '');
    case 'pptx':
      return (await slideTexts(buffer)).map((text) => wordsIn(text).join(' '));
    case 'rtf':
      return wordsIn(extractTextFromRtf(buffer));
    default:
      return wordsIn(extractTextFromDoc(buffer));
  }
}

describe.skipIf(SKIP)('pages of a PDF converted to XLS, PPTX, RTF and DOC', () => {
  const heldBy = (target: string, selected: number[]): string[] =>
    target === 'xls' ? selected.map((page) => `Page ${page}`) : selected.map((page) => WORDS[page - 1]);

  describe.each(['xls', 'pptx', 'rtf', 'doc'])('to %s', (target) => {
    it.each(SELECTIONS)('pages %j holds those pages and no other', async (spec, selected) => {
      const result = await dispatchConversion(await sixPages(), 'pdf', target, { pages: spec }, 'doc.pdf');
      expect(await pagesHeld(target, result.buffer)).toEqual(heldBy(target, selected));
    }, ENGINE_TEST_TIMEOUT_MS);

    it('refuses a selection the document cannot satisfy, as the other targets do', async () => {
      const pdf = await sixPages();
      for (const [pages, message] of [['7', /Page number 7 exceeds document page count of 6\./], ['4-2', /cannot exceed range end/], ['1;2', /Invalid character in page range token/]] as const) {
        const error = await captureError(() => dispatchConversion(pdf, 'pdf', target, { pages }, 'doc.pdf'));
        expect(error).toBeInstanceOf(InvalidPageRangeError);
        expect(error.message).toMatch(message);
        expect((error as InvalidPageRangeError).refusalCode).toBe('invalid_pages');
      }
      const past = await captureError(() => dispatchConversion(pdf, 'pdf', target, { page: 9 }, 'doc.pdf'));
      expect(past).toBeInstanceOf(InvalidPageRangeError);
    }, ENGINE_TEST_TIMEOUT_MS);

    it('holds every page when the selection is absent', async () => {
      const result = await dispatchConversion(await sixPages(), 'pdf', target, {}, 'doc.pdf');
      expect(await pagesHeld(target, result.buffer)).toEqual(heldBy(target, [1, 2, 3, 4, 5, 6]));
    }, ENGINE_TEST_TIMEOUT_MS);
  });

  it('writes one slide for each selected page of a real multi-page PDF', async () => {
    const pptx = await dispatchConversion(MULTIPAGE, 'pdf', 'pptx', { pages: '2-3' }, 'm.pdf');
    expect(await slideTexts(pptx.buffer)).toHaveLength(2);
    const all = await dispatchConversion(MULTIPAGE, 'pdf', 'pptx', {}, 'm.pdf');
    expect(await slideTexts(all.buffer)).toHaveLength((await PDFDocument.load(MULTIPAGE)).getPageCount());
  });

  it('writes the selected pages only as PowerPoint 97-2003', async () => {
    const ppt = await dispatchConversion(await sixPages(), 'pdf', 'ppt', { pages: '2,5' }, 'doc.pdf');
    const text = (await dispatchConversion(ppt.buffer, 'ppt', 'txt', {}, 'doc.ppt')).buffer.toString('utf-8');
    expect(wordsIn(text)).toEqual(['BANANA', 'ELDERBERRY']);
  }, ENGINE_TEST_TIMEOUT_MS);

  it('names the sheets of a real multi-page PDF written as XLS after the selected pages', async () => {
    const xls = await dispatchConversion(MULTIPAGE, 'pdf', 'xls', { pages: '2-3' }, 'm.pdf');
    expect(readCfbfWorkbookSheets(xls.buffer).map((sheet) => sheet.name)).toEqual(['Page 2', 'Page 3']);
  }, ENGINE_TEST_TIMEOUT_MS);

  it.each(['rtf', 'doc'])('holds the words pdftotext reads for the pages of a real PDF written as %s', async (target) => {
    const result = await dispatchConversion(MULTIPAGE, 'pdf', target, { pages: '2-3' }, 'm.pdf');
    const text = target === 'rtf' ? extractTextFromRtf(result.buffer) : extractTextFromDoc(result.buffer);
    expect(tokens(text)).toEqual(tokens(pdftotextOf(MULTIPAGE, [2, 3])));
  }, ENGINE_TEST_TIMEOUT_MS);
});

const OCR_WORDS = ['HARBOR', 'MEADOW', 'ORCHID'] as const;
const OCR_PAGE = { width: 480, height: 160 };

/** A PDF of one image-only page for each word: pages with no text layer. */
async function scannedPages(): Promise<Buffer> {
  const doc = await PDFDocument.create();
  for (const word of OCR_WORDS) {
    const svg = Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${OCR_PAGE.width}" height="${OCR_PAGE.height}"><rect width="100%" height="100%" fill="#ffffff"/>` +
        `<text x="30" y="105" font-family="DejaVu Sans, sans-serif" font-size="72" fill="#000000">${word}</text></svg>`
    );
    const image = await doc.embedPng(await sharp(svg).flatten({ background: '#ffffff' }).png().toBuffer());
    doc.addPage([OCR_PAGE.width, OCR_PAGE.height]).drawImage(image, { x: 0, y: 0, ...OCR_PAGE });
  }
  return Buffer.from(await doc.save());
}

describe.skipIf(skipUnless('eng.traineddata (Tesseract English data)', hasTesseractLanguage('eng')) || skipWithoutTools('pdftotext', 'pdfinfo'))('pages of a scanned PDF', () => {
  const recognizedWords = (text: string): string[] => OCR_WORDS.filter((word) => text.toUpperCase().includes(word));

  it.each(['txt', 'html'])('are the only pages recognized when %s is written with OCR', async (target) => {
    const result = await dispatchConversion(await scannedPages(), 'pdf', target, { pages: '2', ocrEnabled: true }, 'scan.pdf');
    expect(recognizedWords(htmlText(result.buffer))).toEqual(['MEADOW']);
  }, 120_000);

  it('are the only pages recognized when a scan is read without OCR being asked for', async () => {
    const result = await dispatchConversion(await scannedPages(), 'pdf', 'txt', { pages: '1,3' }, 'scan.pdf');
    expect(recognizedWords(result.buffer.toString('utf-8'))).toEqual(['HARBOR', 'ORCHID']);
  }, 120_000);

  it('are the only pages recognized in a DOCX and an XLSX', async () => {
    const scan = await scannedPages();
    const docx = await dispatchConversion(scan, 'pdf', 'docx', { pages: '3', ocrEnabled: true }, 'scan.pdf');
    expect(recognizedWords(await docxText(docx.buffer))).toEqual(['ORCHID']);
    const xlsx = await dispatchConversion(scan, 'pdf', 'xlsx', { pages: '2-3', ocrEnabled: true }, 'scan.pdf');
    expect(await sheetNames(xlsx.buffer)).toEqual(['Page 2', 'Page 3']);
  }, 180_000);
});
