import { describe, expect, it } from 'vitest';
import { PDFDocument, StandardFonts, degrees, type PDFFont, type PDFPage } from 'pdf-lib';
import { convertFile } from '../src/lib/conversions/index';
import { ConversionFailedError } from '../src/lib/types';
import { oracleTest } from './helpers/oracle-test';
import { hocrWords, matchedIou, popplerWords } from './helpers/poppler-words';
import { validateAlto44, xmlWellFormed, xpathAttributes, xpathCount } from './helpers/xml-oracle';

/**
 * hOCR and ALTO export of PDFs whose pages carry digital text. Word geometry comes from the PDF's own
 * text layer; the independent oracle is `pdftotext -bbox-layout` (poppler), and the expected line,
 * paragraph and block structure is worked out by hand from the baselines the PDFs are drawn with.
 */

const MIN_WORD_IOU = 0.7;
const TEST_TIMEOUT_MS = 120_000;
const OCR_OPTIONS = { ocrEnabled: true, ocrMode: 'skip_text' } as const;
const AREA = "//*[@class='ocr_carea']";
const PAR = "//*[@class='ocr_par']";
const LINE = "//*[@class='ocr_line']";
const WORD = "//*[@class='ocrx_word']";

interface Drawer {
  page: PDFPage;
  font: PDFFont;
}

async function build(draw: (doc: PDFDocument, font: PDFFont) => void | Promise<void>): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  await draw(doc, font);
  return Buffer.from(await doc.save());
}

function text(d: Drawer, value: string, x: number, y: number, size: number): void {
  d.page.drawText(value, { x, y, size, font: d.font });
}

/** One page: a title, a two-paragraph block and a distant third block. */
function structuredPdf(): Promise<Buffer> {
  return build((doc, font) => {
    const d = { page: doc.addPage([595, 842]), font };
    text(d, 'Quarterly Report 2026', 50, 800, 24);
    // Body: baselines 16 pt apart (1.33 em) are one paragraph; a 34 pt step (2.8 em) starts a new one in the same block.
    text(d, 'The committee reviewed the budget, ililil WWWWW 12345.', 50, 760, 12);
    text(d, 'Delays at the northern station were attributed to shortages.', 50, 744, 12);
    text(d, 'The contractor expects to finish before October ends.', 50, 728, 12);
    text(d, 'Second paragraph starts here with fresh words.', 50, 694, 12);
    text(d, 'And it continues on a second line.', 50, 678, 12);
    // 134 pt further down: a separate block.
    text(d, 'Footer note: all figures are provisional.', 50, 560, 12);
  });
}

/** Two columns drawn on the same baselines, a page rotated by /Rotate, and glyphs rotated on the page. */
function layoutPdf(): Promise<Buffer> {
  return build((doc, font) => {
    const columns = { page: doc.addPage([595, 842]), font };
    text(columns, 'Left column first line', 50, 700, 12);
    text(columns, 'Right column first line', 320, 700, 12);
    text(columns, 'Left column second line', 50, 684, 12);
    text(columns, 'Right column second line', 320, 684, 12);

    const rotatedPage = doc.addPage([500, 800]);
    rotatedPage.drawText('Standard vertical portrait document text', { x: 50, y: 700, size: 14, font });
    rotatedPage.setRotation(degrees(90));

    const rotatedText = doc.addPage([500, 800]);
    rotatedText.drawText('Rotated glyphs drawn sideways', { x: 100, y: 100, size: 14, font, rotate: degrees(90) });
  });
}

function mixedOrientationPdf(): Promise<Buffer> {
  return build((doc, font) => {
    doc.addPage([1000, 500]).drawText('Wide landscape legal banner text with significant horizontal width across the entire layout', {
      x: 50,
      y: 400,
      size: 18,
      font,
    });
    doc.addPage([500, 800]).drawText('Standard vertical portrait document text', { x: 50, y: 700, size: 14, font });
  });
}

async function hocrOf(pdf: Buffer): Promise<string> {
  return (await convertFile(pdf, 'pdf', 'hocr', OCR_OPTIONS, 'digital.pdf')).buffer.toString('utf-8');
}

async function altoOf(pdf: Buffer): Promise<string> {
  return (await convertFile(pdf, 'pdf', 'alto', OCR_OPTIONS, 'digital.pdf')).buffer.toString('utf-8');
}

function expectWordsMatchPoppler(pdf: Buffer, hocr: string): void {
  const reference = popplerWords(pdf);
  const mine = hocrWords(hocr);
  expect(reference.length).toBeGreaterThan(0);
  expect(mine).toHaveLength(reference.length);
  const ious = matchedIou(reference, mine);
  reference.forEach((word, index) => {
    expect(ious[index], `page ${word.page} word '${word.text}'`).toBeGreaterThanOrEqual(MIN_WORD_IOU);
  });
}

describe('pdf to hOCR and ALTO for digital-text pages', () => {
  oracleTest(
    'word boxes overlap the reference extractor on a generated multi-page PDF, with the hand-worked structure',
    ['pdftotext', 'xmllint'],
    async () => {
      const pdf = await structuredPdf();
      const hocr = await hocrOf(pdf);
      expect(xmlWellFormed(hocr).stderr).toBe('');
      expectWordsMatchPoppler(pdf, hocr);
      expect(xpathAttributes(hocr, "//*[@class='ocr_page']/@title").map((t) => /bbox 0 0 (\d+) (\d+)/.exec(t)?.slice(1).join('x'))).toEqual([
        '595x842',
      ]);
      // Title | two-paragraph body | footer: 3 blocks, 4 paragraphs, 7 lines.
      expect(xpathCount(hocr, AREA)).toBe(3);
      expect(xpathCount(hocr, PAR)).toBe(4);
      expect(xpathCount(hocr, LINE)).toBe(7);
    },
    TEST_TIMEOUT_MS
  );

  oracleTest(
    'ALTO validates against the 4.4 schema, with real baselines and no invented confidence',
    ['pdftotext', 'xmllint'],
    async () => {
      const pdf = await structuredPdf();
      const alto = await altoOf(pdf);
      expect(validateAlto44(alto).stderr.trim()).toBe('- validates');
      expect(xpathCount(alto, "//*[local-name()='ComposedBlock']")).toBe(3);
      expect(xpathCount(alto, "//*[local-name()='TextBlock']")).toBe(4);
      expect(xpathCount(alto, "//*[local-name()='TextLine']")).toBe(7);
      expect(xpathCount(alto, "//*[local-name()='String'][@WC]")).toBe(0);
      // The title is drawn on baseline y=800 of an 842 pt page: 42 pt from the top, from x=50 to the end of its last word.
      const [firstBaseline] = xpathAttributes(alto, "//*[local-name()='TextLine']/@BASELINE");
      const titleEnd = Math.max(...popplerWords(pdf).filter((w) => w.page === 1 && w.y0 < 60).map((w) => w.x1));
      const [start, end] = firstBaseline.split(' ').map((pair) => pair.split(',').map(Number));
      expect(start).toEqual([50, 42]);
      expect(end[1]).toBe(42);
      expect(Math.abs(end[0] - titleEnd)).toBeLessThanOrEqual(1);
      const hocr = await hocrOf(pdf);
      expect(xpathCount(hocr, "//*[@class='ocrx_word'][contains(@title, 'x_wconf')]")).toBe(0);
      expect(xpathAttributes(hocr, `(${LINE})[1]/@title`)[0]).toMatch(/^bbox 50 \d+ \d+ \d+; baseline 0 -\d+$/);
    },
    TEST_TIMEOUT_MS
  );

  oracleTest(
    'the mixed landscape and portrait PDF keeps each page size and matches the reference extractor',
    ['pdftotext', 'xmllint'],
    async () => {
      const pdf = await mixedOrientationPdf();
      const hocr = await hocrOf(pdf);
      expectWordsMatchPoppler(pdf, hocr);
      expect(xpathAttributes(hocr, "//*[@class='ocr_page']/@title").map((t) => /bbox 0 0 (\d+) (\d+)/.exec(t)?.slice(1).join('x'))).toEqual([
        '1000x500',
        '500x800',
      ]);
      const alto = await altoOf(pdf);
      expect(validateAlto44(alto).stderr.trim()).toBe('- validates');
      expect(xpathAttributes(alto, "//*[local-name()='Page']/@WIDTH")).toEqual(['1000', '500']);
    },
    TEST_TIMEOUT_MS
  );

  oracleTest(
    'columns on one baseline are separate lines and blocks; /Rotate pages and rotated glyphs get correct boxes',
    ['pdftotext', 'xmllint'],
    async () => {
      const pdf = await layoutPdf();
      const hocr = await hocrOf(pdf);
      expectWordsMatchPoppler(pdf, hocr);
      // Page 1: left and right column, each of two lines.
      expect(xpathCount(hocr, "//*[@class='ocr_page'][1]//*[@class='ocr_carea']")).toBe(2);
      expect(xpathCount(hocr, "//*[@class='ocr_page'][1]//*[@class='ocr_line']")).toBe(4);
      // Page 2 is rotated by /Rotate 90: the page is 800 wide and 500 tall as displayed.
      expect(xpathAttributes(hocr, "//*[@class='ocr_page']/@title").map((t) => /bbox 0 0 (\d+) (\d+)/.exec(t)?.slice(1).join('x'))).toEqual([
        '595x842',
        '800x500',
        '500x800',
      ]);
      // Vertical lines have no usable left-to-right baseline, so none is written for them.
      const lineTitles = xpathAttributes(hocr, `${LINE}/@title`);
      expect(lineTitles.filter((t) => t.includes('baseline'))).toHaveLength(4);
      const alto = await altoOf(pdf);
      expect(validateAlto44(alto).stderr.trim()).toBe('- validates');
    },
    TEST_TIMEOUT_MS
  );
});

describe('text geometry extraction fails closed', () => {
  it('rejects a document pdfjs cannot read with a typed error', async () => {
    const { extractPdfTextLayerPages, PdfTextGeometryError } = await import('../src/lib/conversions/pdf-text-geometry');
    const failure = await extractPdfTextLayerPages(Buffer.from('%PDF-1.4 this is not a pdf'), new Set([1])).then(
      () => null,
      (err: unknown) => err
    );
    expect(failure).toBeInstanceOf(PdfTextGeometryError);
    expect(failure).toBeInstanceOf(ConversionFailedError);
    expect((failure as Error).message).toMatch(/^PDF text geometry could not be read: /);
  });

  it('rejects a page number the document does not have', async () => {
    const { extractPdfTextLayerPages, PdfTextGeometryError } = await import('../src/lib/conversions/pdf-text-geometry');
    const pdf = await mixedOrientationPdf();
    const failure = await extractPdfTextLayerPages(pdf, new Set([3])).then(
      () => null,
      (err: unknown) => err
    );
    expect(failure).toBeInstanceOf(PdfTextGeometryError);
    expect((failure as Error).message).toBe('PDF page 3 does not exist; the document has 2 pages.');
  });

  it('returns an empty page, not invented boxes, for a page without text', async () => {
    const { extractPdfTextLayerPages } = await import('../src/lib/conversions/pdf-text-geometry');
    const pdf = await build((doc) => {
      doc.addPage([300, 200]);
    });
    const pages = await extractPdfTextLayerPages(pdf, new Set([1]));
    const blank = pages.get(1);
    expect([blank?.text, blank?.lineBlocks, blank?.imageWidth, blank?.imageHeight]).toEqual(['', [], 300, 200]);
  });

  it('returns nothing for no requested pages', async () => {
    const { extractPdfTextLayerPages } = await import('../src/lib/conversions/pdf-text-geometry');
    const pdf = await mixedOrientationPdf();
    const pages = await extractPdfTextLayerPages(pdf, new Set());
    expect([...pages.keys()]).toEqual([]);
  });
});
