import { describe, expect, it } from 'vitest';
import { convertFile } from '../src/lib/conversions/index';
import { extractPdfTextLayerPages, PdfTextGeometryError } from '../src/lib/conversions/pdf-text-geometry';
import { oracleTest } from './helpers/oracle-test';
import { hocrWords, matchedIou, popplerWords } from './helpers/poppler-words';
import { rawPdf, run } from './helpers/raw-pdf';
import { htmlToPdf } from './helpers/soffice-pdf';
import { xpathCount } from './helpers/xml-oracle';

/**
 * Reading order, ligatures, superscripts, justified lines and invisible text in PDF text-layer geometry.
 * Hand-written PDFs place every run, so the expected lines and order are worked out from the drawing
 * positions; `pdftotext -bbox-layout` is the oracle for boxes.
 */

const TEST_TIMEOUT_MS = 120_000;
const OCR_OPTIONS = { ocrEnabled: true, ocrMode: 'skip_text' } as const;
const STRICT_IOU = 0.9;

async function hocrOf(pdf: Buffer): Promise<string> {
  return (await convertFile(pdf, 'pdf', 'hocr', OCR_OPTIONS, 'layout.pdf')).buffer.toString('utf-8');
}

describe('reading order', () => {
  /** Two columns drawn row by row (left, right, left, right), the way a word processor emits them. */
  const twoColumns = (): Buffer =>
    rawPdf([
      {
        width: 595,
        height: 300,
        content: [
          run('Left column first line', 50, 250, 12),
          run('Right column first line', 320, 250, 12),
          run('Left column second line', 50, 234, 12),
          run('Right column second line', 320, 234, 12),
        ].join(''),
      },
    ]);

  it(
    'lists the left column completely before the right one, in lines, text and the extracted text',
    async () => {
      const pdf = twoColumns();
      const page = (await extractPdfTextLayerPages(pdf, new Set([1]))).get(1);
      const expected = ['Left column first line', 'Left column second line', 'Right column first line', 'Right column second line'];
      expect(page?.lines).toEqual(expected);
      expect(page?.lineBlocks?.map((block) => block.text)).toEqual(expected);
      expect(page?.text).toBe(expected.join('\n'));
      const converted = await convertFile(pdf, 'pdf', 'hocr', OCR_OPTIONS, 'columns.pdf');
      expect(converted.ocrExtractedText).toBe(expected.join('\n'));
    },
    TEST_TIMEOUT_MS
  );
});

describe('ligatures', () => {
  oracleTest(
    'words after ligature glyphs keep their positions: "and", "more" and "words" overlap the reference at 0.9 or better',
    ['pdftotext', 'xmllint', 'soffice'],
    async () => {
      const pdf = htmlToPdf('<p>ﬁnal oﬃce ﬂow and more words</p><p>final office flow and more words</p>');
      const hocr = await hocrOf(pdf);
      const reference = popplerWords(pdf);
      const mine = hocrWords(hocr);
      expect(mine).toHaveLength(reference.length);
      const ious = matchedIou(reference, mine);
      reference.forEach((word, index) => {
        expect(ious[index], `page ${word.page} '${word.text}'`).toBeGreaterThanOrEqual(STRICT_IOU);
      });
    },
    TEST_TIMEOUT_MS
  );
});

describe('superscripts and justified lines', () => {
  it(
    'keeps a superscript and a footnote marker in the line they belong to, in left-to-right order',
    async () => {
      const pdf = rawPdf([
        {
          width: 400,
          height: 200,
          content: [
            run('Energy mc', 50, 100, 12),
            // Superscript 2: 8 pt, raised 5 pt, directly after "mc".
            run('2', 100, 105, 8),
            run(' is conserved', 105, 100, 12),
            // Footnote marker 1 after "conserved": 7 pt, raised 5 pt.
            run('1', 178, 105, 7),
          ].join(''),
        },
      ]);
      const page = (await extractPdfTextLayerPages(pdf, new Set([1]))).get(1);
      expect(page?.lineBlocks?.map((block) => block.words.map((w) => w.text))).toEqual([['Energy', 'mc', '2', 'is', 'conserved', '1']]);
      expect(page?.lines).toEqual(['Energy mc 2 is conserved 1']);
    },
    TEST_TIMEOUT_MS
  );

  it(
    'does not split a justified line with wide word spacing into one-word lines',
    async () => {
      // Tw 30 adds 30 pt to every space: gaps of about 33 pt are far beyond a plain word gap but regular on this line.
      const pdf = rawPdf([
        {
          width: 595,
          height: 200,
          content: [
            run('alpha beta gamma delta epsilon zeta', 50, 150, 12, '30 Tw'),
            run('Second line is ordinary text here', 50, 134, 12),
          ].join(''),
        },
      ]);
      const page = (await extractPdfTextLayerPages(pdf, new Set([1]))).get(1);
      expect(page?.lines).toEqual(['alpha beta gamma delta epsilon zeta', 'Second line is ordinary text here']);
    },
    TEST_TIMEOUT_MS
  );

  it('still separates columns that sit far apart on one baseline', async () => {
    const pdf = rawPdf([
      {
        width: 595,
        height: 200,
        content: [run('alpha beta gamma', 50, 150, 12), run('delta epsilon zeta', 350, 150, 12)].join(''),
      },
    ]);
    const page = (await extractPdfTextLayerPages(pdf, new Set([1]))).get(1);
    expect(page?.lines).toEqual(['alpha beta gamma', 'delta epsilon zeta']);
  });

  oracleTest(
    'justified words match the reference extractor and stay on one line',
    ['pdftotext', 'xmllint'],
    async () => {
      const pdf = rawPdf([
        {
          width: 595,
          height: 200,
          content: [
            run('alpha beta gamma delta epsilon zeta', 50, 150, 12, '30 Tw'),
            run('Second line is ordinary text here', 50, 134, 12),
          ].join(''),
        },
      ]);
      const hocr = await hocrOf(pdf);
      const reference = popplerWords(pdf);
      const ious = matchedIou(reference, hocrWords(hocr));
      reference.forEach((word, index) => {
        expect(ious[index], `'${word.text}'`).toBeGreaterThanOrEqual(STRICT_IOU);
      });
      expect(xpathCount(hocr, "//*[@class='ocr_line']")).toBe(2);
    },
    TEST_TIMEOUT_MS
  );
});

describe('invisible text', () => {
  const invisible = (text: string, x: number, y: number): string => run(text, x, y, 12, '0 Tz');

  it('skips zero-scale text but keeps the visible words around it', async () => {
    const pdf = rawPdf([{ width: 300, height: 200, content: run('visible words here today', 20, 100, 12) + invisible('hidden text should vanish', 20, 60) }]);
    const page = (await extractPdfTextLayerPages(pdf, new Set([1]))).get(1);
    expect(page?.lines).toEqual(['visible words here today']);
  });

  it('refuses a page whose text yields no geometry instead of returning an empty page', async () => {
    const pdf = rawPdf([{ width: 300, height: 200, content: invisible('only hidden text on this page', 20, 100) }]);
    const err = await extractPdfTextLayerPages(pdf, new Set([1])).then(
      () => null,
      (e: unknown) => e
    );
    expect(err).toBeInstanceOf(PdfTextGeometryError);
    expect((err as Error).message).toBe('PDF page 1 has text but no usable word geometry.');
  });

  it('still returns an empty page when the page has no text at all', async () => {
    const pdf = rawPdf([{ width: 300, height: 200, content: '' }]);
    const page = (await extractPdfTextLayerPages(pdf, new Set([1]))).get(1);
    expect([page?.text, page?.lineBlocks]).toEqual(['', []]);
  });
});
