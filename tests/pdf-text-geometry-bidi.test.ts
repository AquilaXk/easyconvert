import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import PDFDocument from 'pdfkit';
import sharp from 'sharp';
import { convertFile } from '../src/lib/conversions/index';
import { extractPdfTextLayerPages, PdfTextGeometryError } from '../src/lib/conversions/pdf-text-geometry';
import { oracleTest } from './helpers/oracle-test';
import { OracleToolMissingError, requireOracleTool } from './helpers/differential-oracle';
import { hocrWords, intersectionOverUnion, matchedIou, popplerWords, type WordBox } from './helpers/poppler-words';
import { htmlToPdf } from './helpers/soffice-pdf';
import { xpathAttributes } from './helpers/xml-oracle';

/**
 * Right-to-left, mixed-direction and vertical text. Boxes are compared with `pdftotext -bbox-layout`
 * (right-to-left words are matched on their reversed drawn text); vertical text, whose reference boxes
 * the extractor offsets from where the page renders it, is compared with the rendered ink instead.
 */

const TEST_TIMEOUT_MS = 180_000;
const STRICT_IOU = 0.9;
const VERTICAL_IOU = 0.7;
const OCR_OPTIONS = { ocrEnabled: true, ocrMode: 'skip_text' } as const;
const DEJAVU = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf';
const RENDER_DPI = 72;
const INK_THRESHOLD = 128;

const HEBREW = 'זהו משפט קצר בעברית שנכתב מימין לשמאל כדי לבדוק את מיקום המילים בעמוד';
const ARABIC = 'هذه جملة قصيرة باللغة العربية تكتب من اليمين إلى اليسار لفحص مواضع الكلمات';

async function hocrOf(pdf: Buffer): Promise<string> {
  return (await convertFile(pdf, 'pdf', 'hocr', OCR_OPTIONS, 'bidi.pdf')).buffer.toString('utf-8');
}

function expectOverlap(pdf: Buffer, hocr: string, minimum: number): void {
  const reference = popplerWords(pdf);
  const mine = hocrWords(hocr);
  expect(reference.length).toBeGreaterThan(0);
  expect(mine).toHaveLength(reference.length);
  const ious = matchedIou(reference, mine);
  reference.forEach((word, index) => {
    expect(ious[index], `page ${word.page} '${word.text}'`).toBeGreaterThanOrEqual(minimum);
  });
}

/** Texts of the words on the given line of page 1, in the order the document lists them. */
function lineWords(hocr: string, line: number): string[] {
  const ids = xpathAttributes(hocr, "//*[@class='ocrx_word']/@id");
  return hocrWords(hocr)
    .filter((_, index) => ids[index].startsWith(`word_1_${line}_`))
    .map((word) => word.text);
}

describe('right-to-left text', () => {
  oracleTest(
    'Hebrew, Arabic and mixed lines made by LibreOffice: word boxes overlap the reference and words read in logical order',
    ['pdftotext', 'xmllint', 'soffice'],
    async () => {
      const pdf = htmlToPdf(
        `<p dir="rtl" lang="he">${HEBREW}</p><p dir="rtl" lang="ar">${ARABIC}</p><p>Hello שלום עולם world end</p><p dir="rtl" lang="he">שלום Hello עולם 2026 world</p>`
      );
      const hocr = await hocrOf(pdf);
      expectOverlap(pdf, hocr, STRICT_IOU);
      expect(lineWords(hocr, 1).join(' ')).toBe(HEBREW);
      expect(lineWords(hocr, 2).join(' ')).toBe(ARABIC);
      expect(lineWords(hocr, 3).join(' ')).toBe('Hello שלום עולם world end');
    },
    TEST_TIMEOUT_MS
  );

  oracleTest(
    'the first word of a right-to-left line is its rightmost word',
    ['soffice'],
    async () => {
      const pdf = htmlToPdf(`<p dir="rtl" lang="he">${HEBREW}</p>`);
      const page = (await extractPdfTextLayerPages(pdf, new Set([1]))).get(1);
      const words = page?.lineBlocks?.[0].words ?? [];
      expect(words.map((word) => word.text).join(' ')).toBe(HEBREW);
      const xs = words.map((word) => word.bbox.x);
      expect(xs).toEqual([...xs].sort((a, b) => b - a));
    },
    TEST_TIMEOUT_MS
  );
});

/** A PDF whose text is drawn left to right in the order given, as a producer that lays out visually does. */
async function visualOrderPdf(lines: Array<[string, number]>, vertical = false): Promise<Buffer> {
  if (!fs.existsSync(DEJAVU)) throw new OracleToolMissingError('DejaVuSans', `${DEJAVU} is not installed`);
  const doc = new PDFDocument({ size: [300, 400], margin: 0, compress: false });
  const chunks: Buffer[] = [];
  doc.on('data', (chunk: Buffer) => chunks.push(chunk));
  doc.registerFont('dejavu', DEJAVU);
  doc.font('dejavu').fontSize(16);
  lines.forEach(([text, y]) => doc.text(text, vertical ? 200 : 50, y, { lineBreak: false }));
  doc.end();
  await new Promise((resolve) => doc.on('end', resolve));
  const source = Buffer.concat(chunks).toString('latin1');
  const out = vertical ? source.replace('/Encoding /Identity-H', '/Encoding /Identity-V') : source;
  return Buffer.from(out, 'latin1');
}

describe('mixed-direction text in one text item', () => {
  oracleTest(
    'resolves visual positions from the glyph order so each word box is where it is drawn',
    ['pdftotext', 'xmllint'],
    async () => {
      // Drawn order: the Hebrew run is already reversed, so the stream reads Hello םלוע םולש world end.
      const pdf = await visualOrderPdf([['Hello םלוע םולש world end', 100]]);
      const hocr = await hocrOf(pdf);
      expectOverlap(pdf, hocr, STRICT_IOU);
      expect(lineWords(hocr, 1)).toEqual(['Hello', 'שלום', 'עולם', 'world', 'end']);
    },
    TEST_TIMEOUT_MS
  );

  it(
    'throws a typed error instead of emitting wrong boxes when the visual order cannot be resolved exactly',
    async () => {
      // A mirrored bracket pair around the right-to-left run: the drawn glyphs do not match any reordering of the text.
      const pdf = await visualOrderPdf([['abc )םולש( def', 100]]);
      const err = await extractPdfTextLayerPages(pdf, new Set([1])).then(
        () => null,
        (e: unknown) => e
      );
      expect(err).toBeInstanceOf(PdfTextGeometryError);
      expect((err as Error).message).toBe('PDF page 1 has mixed-direction text whose visual order cannot be resolved exactly.');
    },
    TEST_TIMEOUT_MS
  );
});

describe('vertical writing', () => {
  /** Ink bounding boxes of the runs of dark rows in the rendered page, split where a gap is wider than `gap` rows. */
  async function inkRuns(pdf: Buffer, left: number, right: number, gap: number): Promise<WordBox[]> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vertical-ink-'));
    try {
      fs.writeFileSync(path.join(dir, 'in.pdf'), pdf);
      execFileSync(requireOracleTool('pdftoppm'), ['-r', String(RENDER_DPI), '-gray', '-png', path.join(dir, 'in.pdf'), path.join(dir, 'page')]);
      const png = fs.readdirSync(dir).find((name) => name.startsWith('page') && name.endsWith('.png'));
      const { data, info } = await sharp(path.join(dir, png ?? '')).raw().toBuffer({ resolveWithObject: true });
      const rows: number[] = [];
      for (let y = 0; y < info.height; y++) {
        for (let x = left; x < right; x++) {
          if (data[y * info.width + x] < INK_THRESHOLD) {
            rows.push(y);
            break;
          }
        }
      }
      const runs: WordBox[] = [];
      let start = -1;
      let previous = -1;
      const flush = (): void => {
        if (start < 0) return;
        let x0 = info.width;
        let x1 = 0;
        for (let y = start; y <= previous; y++) {
          for (let x = left; x < right; x++) {
            if (data[y * info.width + x] < INK_THRESHOLD) {
              x0 = Math.min(x0, x);
              x1 = Math.max(x1, x + 1);
            }
          }
        }
        runs.push({ page: 1, text: '', x0, y0: start, x1, y1: previous + 1 });
      };
      for (const y of rows) {
        if (start >= 0 && y - previous > gap) {
          flush();
          start = -1;
        }
        if (start < 0) start = y;
        previous = y;
      }
      flush();
      return runs;
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  oracleTest(
    'Identity-V text: word boxes lie on the rendered ink, run down the page and carry no baseline',
    ['pdftoppm', 'xmllint'],
    async () => {
      const pdf = await visualOrderPdf([['HIDE HOLE SIDE HOLD', 40]], true);
      const hocr = await hocrOf(pdf);
      const mine = hocrWords(hocr);
      expect(mine.map((word) => word.text)).toEqual(['HIDE', 'HOLE', 'SIDE', 'HOLD']);
      // Four words of four glyphs, a space between each: the ink falls into four runs, a blank em apart.
      const ink = await inkRuns(pdf, 150, 260, 6);
      expect(ink).toHaveLength(4);
      ink.forEach((expected, index) => {
        expect(intersectionOverUnion(expected, mine[index]), `word ${mine[index].text}`).toBeGreaterThanOrEqual(VERTICAL_IOU);
      });
      mine.slice(1).forEach((word, index) => expect(word.y0).toBeGreaterThanOrEqual(mine[index].y1 - 1));
      const titles = xpathAttributes(hocr, "//*[@class='ocr_line']/@title");
      expect(titles).toHaveLength(1);
      expect(titles[0]).not.toContain('baseline');
    },
    TEST_TIMEOUT_MS
  );
});
