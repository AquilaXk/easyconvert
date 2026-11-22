import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import JSZip from 'jszip';
import sharp from 'sharp';
import { PDFDocument } from 'pdf-lib';
import os from 'node:os';
import { describe, expect, it } from 'vitest';
import { convertFile } from '../src/lib/conversions/index';
import { dispatchConversion } from '../src/lib/conversions/dispatch';
import { InvalidPageRangeError } from '../src/lib/types';
import { convertWithCalibre } from '../src/worker/ebook-calibre';
import { calibreBinary, textOfCalibreTarget } from './helpers/calibre-books';
import { captureError } from './helpers/capture-error';
import { requireOracleTool } from './helpers/differential-oracle';
import { plainPdf, withTempDir } from './helpers/encrypted-pdf-fixtures';
import { requireRealworldSample } from './helpers/realworld-sample';
import { skipUnless, skipWithoutTools } from './helpers/strict-skip';
import { hasTesseractLanguage } from './helpers/tessdata';
import { runWithoutFileConfinement } from './helpers/unconfined-files';

// The stand-in program of this suite writes the EPUB it was given outside the job directory, which the file confinement refuses (policy 248).
runWithoutFileConfinement();

/**
 * `pages` for PDF to EPUB, the calibre e-book targets, hOCR and ALTO (policy entry 393), and for the PDF chain targets that already
 * took it. The expected words of a page are what Poppler's `pdftotext -f N -l N` reads from the source, an independent reader.
 */

const SKIP = skipWithoutTools('pdftotext', 'pdfinfo');
const CALIBRE_MISSING = skipUnless('ebook-convert', calibreBinary !== null);
const REAL_SAMPLE = 'govdocs1-000562.pdf';
const SELECTED = [2, 3];
const MIN_RECALL = 0.9;
const CALIBRE_TARGETS = ['azw3', 'mobi', 'lrf', 'oeb', 'pdb'] as const;
const CHAIN_TIMEOUT_MS = 120_000;

/** The words of six letters or more that Poppler reads on page `page` of `pdf`. */
function pageWords(pdf: Buffer, page: number): Set<string> {
  const text = withTempDir((dir) => {
    const file = path.join(dir, 'in.pdf');
    fs.writeFileSync(file, pdf);
    return execFileSync(requireOracleTool('pdftotext'), ['-f', String(page), '-l', String(page), file, '-'], { encoding: 'utf-8' });
  });
  return new Set((text.toLowerCase().match(/[a-z]{6,}/g) ?? []));
}

interface PageOracle {
  /** Words that stand on a selected page and on no other. */
  expected: string[];
  /** Words that stand on a page that was not selected and on none that was. */
  forbidden: string[];
}

function oracleOf(pdf: Buffer, pageCount: number, selected: readonly number[]): PageOracle {
  const byPage = new Map<number, Set<string>>();
  for (let page = 1; page <= pageCount; page++) byPage.set(page, pageWords(pdf, page));
  const inSelected = new Set<string>();
  const inOthers = new Set<string>();
  for (const [page, words] of byPage) for (const word of words) (selected.includes(page) ? inSelected : inOthers).add(word);
  return {
    expected: [...inSelected].filter((word) => !inOthers.has(word)),
    forbidden: [...inOthers].filter((word) => !inSelected.has(word)),
  };
}

function expectOnlySelected(text: string, oracle: PageOracle): void {
  const words = new Set(text.toLowerCase().match(/[a-z]+/g) ?? []);
  expect(oracle.expected.length).toBeGreaterThan(20);
  expect(oracle.forbidden.length).toBeGreaterThan(20);
  const found = oracle.expected.filter((word) => words.has(word)).length;
  expect(found / oracle.expected.length).toBeGreaterThanOrEqual(MIN_RECALL);
  expect(oracle.forbidden.filter((word) => words.has(word))).toEqual([]);
}

const markupText = (markup: string): string => markup.replace(/<[^>]*>/g, ' ');
const altoWords = (alto: string): string => [...alto.matchAll(/CONTENT="([^"]*)"/g)].map((match) => match[1]).join(' ');

/** The marker words (capitals, six letters or more) of a text, in order. */
const markers = (text: string): string[] => text.match(/[A-Z]{6,}/g) ?? [];

async function epubText(epub: Buffer): Promise<string> {
  const zip = await JSZip.loadAsync(epub);
  const names = Object.keys(zip.files).filter((name) => /\.x?html$/i.test(name) && !/nav\./i.test(name));
  return markupText((await Promise.all(names.map((name) => (zip.file(name) as JSZip.JSZipObject).async('string')))).join(' '));
}

describe.skipIf(SKIP)('pages for PDF to EPUB', () => {
  it('writes only the words of the selected pages of a real 10-page document', async (ctx) => {
    const { bytes } = await requireRealworldSample(ctx, REAL_SAMPLE);
    const epub = (await convertFile(bytes, 'pdf', 'epub', { pages: '2-3' }, REAL_SAMPLE)).buffer;
    expectOnlySelected(await epubText(epub), oracleOf(bytes, 10, SELECTED));
  });

  it('keeps the order of the document for a selection with a gap, and takes `page` as one page', async () => {
    const source = await plainPdf(['ALPHAONE', 'BRAVOTWO', 'CHARLIETHREE', 'DELTAFOUR', 'ECHOFIVE']);
    const gap = await epubText((await convertFile(source, 'pdf', 'epub', { pages: '2,4-5' }, 'a.pdf')).buffer);
    expect(markers(gap)).toEqual(['BRAVOTWO', 'DELTAFOUR', 'ECHOFIVE']);
    const single = await epubText((await convertFile(source, 'pdf', 'epub', { page: 3 }, 'a.pdf')).buffer);
    expect(markers(single)).toEqual(['CHARLIETHREE']);
  });

  it('writes every page when no page is named', async () => {
    const source = await plainPdf(['ALPHAONE', 'BRAVOTWO']);
    for (const options of [{}, { pages: '' }, { pages: '  ' }] as const) {
      const text = await epubText((await convertFile(source, 'pdf', 'epub', options, 'a.pdf')).buffer);
      expect(markers(text)).toEqual(['ALPHAONE', 'BRAVOTWO']);
    }
  });
});

describe.skipIf(SKIP)('pages for PDF to hOCR and ALTO', () => {
  for (const [target, textOf] of [['hocr', markupText], ['alto', altoWords]] as const) {
    it(`writes only the words of the selected pages of a real document to ${target}`, async (ctx) => {
      const { bytes } = await requireRealworldSample(ctx, REAL_SAMPLE);
      const xml = (await convertFile(bytes, 'pdf', target, { pages: '2-3' }, REAL_SAMPLE)).buffer.toString('utf-8');
      expectOnlySelected(textOf(xml), oracleOf(bytes, 10, SELECTED));
    });
  }

  it('numbers the pages of a hOCR file by their place in it, as Tesseract numbers the images it is given', async () => {
    const source = await plainPdf(['ALPHAONE', 'BRAVOTWO', 'CHARLIETHREE', 'DELTAFOUR', 'ECHOFIVE']);
    const hocr = (await convertFile(source, 'pdf', 'hocr', { pages: '2,4' }, 'a.pdf')).buffer.toString('utf-8');
    expect([...hocr.matchAll(/ppageno (\d+)/g)].map((match) => match[1])).toEqual(['0', '1']);
    expect(markers(markupText(hocr))).toEqual(['BRAVOTWO', 'DELTAFOUR']);
  });

  it('numbers the pages of an ALTO file by their place in it', async () => {
    const source = await plainPdf(['ALPHAONE', 'BRAVOTWO', 'CHARLIETHREE', 'DELTAFOUR', 'ECHOFIVE']);
    const alto = (await convertFile(source, 'pdf', 'alto', { pages: '2,4' }, 'a.pdf')).buffer.toString('utf-8');
    expect([...alto.matchAll(/PHYSICAL_IMG_NR="(\d+)"/g)].map((match) => match[1])).toEqual(['1', '2']);
    expect(altoWords(alto)).toBe('BRAVOTWO DELTAFOUR');
  });

  it('writes every page when no page is named', async () => {
    const source = await plainPdf(['ALPHAONE', 'BRAVOTWO']);
    for (const target of ['hocr', 'alto'] as const) {
      for (const options of [{}, { pages: '' }] as const) {
        const xml = (await convertFile(source, 'pdf', target, options, 'a.pdf')).buffer.toString('utf-8');
        expect(markers(target === 'alto' ? altoWords(xml) : markupText(xml))).toEqual(['ALPHAONE', 'BRAVOTWO']);
      }
    }
  });
});

describe.skipIf(SKIP)('pages for PDF to EPUB, hOCR and ALTO through the dispatcher', () => {
  it.each(['epub', 'hocr', 'alto'] as const)('%s keeps the selected page only', async (target) => {
    const source = await plainPdf(['ALPHAONE', 'BRAVOTWO', 'CHARLIETHREE']);
    const result = await dispatchConversion(source, 'pdf', target, { pages: '2' }, 'a.pdf');
    const text = target === 'epub' ? await epubText(result.buffer) : (target === 'alto' ? altoWords : markupText)(result.buffer.toString('utf-8'));
    expect(markers(text)).toEqual(['BRAVOTWO']);
  });

  it.each(['epub', 'hocr', 'alto'] as const)('%s refuses a page past the end with invalid_pages', async (target) => {
    const source = await plainPdf(['ALPHAONE', 'BRAVOTWO']);
    const error = await captureError(() => dispatchConversion(source, 'pdf', target, { pages: '3' }, 'a.pdf'));
    expect((error as InvalidPageRangeError).refusalCode).toBe('invalid_pages');
  });
});

describe.skipIf(SKIP)('a selection the document cannot satisfy is refused for the targets that take it', () => {
  it.each([
    ['epub', 'a page past the end', { pages: '9' }],
    ['epub', 'a backward range', { pages: '3-1' }],
    ['epub', 'a character that is no digit', { pages: '1-x' }],
    ['hocr', 'a page past the end', { pages: '9' }],
    ['hocr', 'a backward range', { pages: '3-1' }],
    ['alto', 'a page past the end', { pages: '9' }],
    ['alto', 'a `page` and a `pages` that differ', { page: 1, pages: '2' }],
  ] as const)('PDF to %s: %s is invalid_pages', async (target, _name, options) => {
    const source = await plainPdf(['ALPHAONE', 'BRAVOTWO', 'CHARLIETHREE']);
    const error = await captureError(() => convertFile(source, 'pdf', target, options, 'a.pdf'));
    expect(error).toBeInstanceOf(InvalidPageRangeError);
    expect((error as InvalidPageRangeError).refusalCode).toBe('invalid_pages');
  });
});

describe.skipIf(SKIP || CALIBRE_MISSING)('pages for PDF to the calibre e-book targets', () => {
  for (const target of CALIBRE_TARGETS) {
    it(`writes only the words of the selected pages of a real document to ${target}`, async (ctx) => {
      const { bytes } = await requireRealworldSample(ctx, REAL_SAMPLE);
      const result = await dispatchConversion(bytes, 'pdf', target, { pages: '2-3' }, REAL_SAMPLE);
      expect(result.engineUsed).toBe('native-calibre');
      expectOnlySelected(await textOfCalibreTarget(result.buffer, target), oracleOf(bytes, 10, SELECTED));
    }, CHAIN_TIMEOUT_MS);
  }

  it.each(CALIBRE_TARGETS)('refuses a page past the end for %s', async (target) => {
    const source = await plainPdf(['ALPHAONE', 'BRAVOTWO']);
    const error = await captureError(() => dispatchConversion(source, 'pdf', target, { pages: '5' }, 'a.pdf'));
    expect(error).toMatchObject({ refusalCode: 'invalid_pages' });
  }, CHAIN_TIMEOUT_MS);
});

describe.skipIf(skipWithoutTools('pdftops', 'pdftocairo', 'pdftoppm', 'pdfinfo'))('pages for the PDF targets of the native chains', () => {
  const SOURCE_TEXTS = ['ALPHAONE', 'BRAVOTWO', 'CHARLIETHREE', 'DELTAFOUR'];

  async function entryNames(target: string, options: Record<string, unknown>): Promise<string[]> {
    const result = await dispatchConversion(await plainPdf(SOURCE_TEXTS), 'pdf', target, options, 'doc.pdf');
    if (!result.filename.endsWith('.zip')) return [result.filename];
    return Object.keys((await JSZip.loadAsync(result.buffer)).files).sort();
  }

  it.each(['eps', 'dxf', 'odd'] as const)('%s holds one file for each selected page', async (target) => {
    expect(await entryNames(target, { pages: '2-3' })).toEqual([`doc-p002.${target}`, `doc-p003.${target}`]);
  }, CHAIN_TIMEOUT_MS);

  it('ps holds the selected run of pages in one file', async () => {
    const result = await dispatchConversion(await plainPdf(SOURCE_TEXTS), 'pdf', 'ps', { pages: '2-3' }, 'doc.pdf');
    expect(/%%Pages:\s*(\d+)/.exec(result.buffer.toString('latin1'))?.[1]).toBe('2');
  }, CHAIN_TIMEOUT_MS);
});

describe.skipIf(SKIP)('pages reach the EPUB that the calibre route stages', () => {
  it('stages an EPUB of the selected pages, for a stand-in program that keeps what it was given', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pages-calibre-stage-'));
    try {
      const staged = path.join(dir, 'staged.epub');
      const program = path.join(dir, 'ebook-convert');
      fs.writeFileSync(
        program,
        `#!${process.execPath}
const fs = require('node:fs');
const [input, output] = process.argv.slice(2);
fs.copyFileSync(input, ${JSON.stringify(staged)});
const book = Buffer.alloc(80);
book.write('BOOKMOBI', 60, 'latin1');
fs.writeFileSync(output, book);
`,
        { mode: 0o755 }
      );
      const source = await plainPdf(['ALPHAONE', 'BRAVOTWO', 'CHARLIETHREE']);
      const deps = {
        convert: (input: Buffer | { inputPath: string }, src: string, tgt: string, options: Record<string, unknown>, name: string) => convertFile(input as Buffer, src, tgt, options, name),
        discardOutput: () => undefined,
      };
      const result = await convertWithCalibre(deps as never, { input: source, src: 'pdf', tgt: 'mobi', options: { pages: '2-3' }, originalFilename: 'a.pdf' }, program);
      if (result.filePath) fs.rmSync(result.filePath, { force: true });
      const text = await epubText(fs.readFileSync(staged));
      expect(markers(text)).toEqual(['BRAVOTWO', 'CHARLIETHREE']);
      const refused = await captureError(() => convertWithCalibre(deps as never, { input: source, src: 'pdf', tgt: 'mobi', options: { pages: '9' }, originalFilename: 'a.pdf' }, program));
      expect(refused).toBeInstanceOf(InvalidPageRangeError);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, CHAIN_TIMEOUT_MS);
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

describe.skipIf(skipUnless('eng.traineddata (Tesseract English data)', hasTesseractLanguage('eng')) || SKIP)('pages of a scanned PDF for EPUB, hOCR and ALTO', () => {
  const recognizedWords = (text: string): string[] => OCR_WORDS.filter((word) => text.toUpperCase().includes(word));

  it.each(['epub', 'hocr', 'alto'] as const)('recognizes only the selected page when %s is written', async (target) => {
    const result = await dispatchConversion(await scannedPages(), 'pdf', target, { pages: '2', ocrEnabled: true }, 'scan.pdf');
    const text = target === 'epub' ? await epubText(result.buffer) : (target === 'alto' ? altoWords : markupText)(result.buffer.toString('utf-8'));
    expect(recognizedWords(text)).toEqual(['MEADOW']);
  }, 180_000);
});
