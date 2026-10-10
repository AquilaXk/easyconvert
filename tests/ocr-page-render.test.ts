import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PDFDocument, StandardFonts, degrees } from 'pdf-lib';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { InputPixelLimitError } from '../src/lib/conversions/image-input-limits';
import { assembleCombinedOcrResult, performSmartMultiPagePdfOcr, recognizeRenderedPdfPages } from '../src/lib/conversions/ocr';
import { pxToPdfUserSpace, type PdfPageFrame } from '../src/lib/conversions/pdf-page-geometry';
import { OCR_MAX_RENDERED_PAGES } from '../src/lib/conversions/pdf-page-render';
import { OCR_DEFAULT_DPI, OCR_MAX_DPI } from '../src/lib/conversions/ocr-dpi';
import { OcrEngineUnavailableError, PayloadLimitError, UnsupportedOptionError } from '../src/lib/types';
import { getOracleToolPath, OracleToolMissingError } from './helpers/differential-oracle';
import { MAGICK_BINARY, requireMagick } from './helpers/imagemagick';
import { requireTessdata, requireTesseract } from './helpers/ocr-fixtures';
import { oracleTest } from './helpers/oracle-test';
import { wordIous, type PdfWord } from './helpers/pdftotext-bbox';

/**
 * PDF pages are recognized as displayed. Oracles: Poppler's `pdftoppm` renders the page, the tesseract command line
 * reads that render (positions and text), and `pdftotext -bbox` reads the searchable PDF back; the mapping from
 * pixels to PDF user space is worked out by hand from ISO 32000-1 (CropBox, /Rotate) in the unit cases. None of it
 * comes from the code under test.
 */

const REFERENCE_TIMEOUT_MS = 60_000;
const TEST_TIMEOUT_MS = 240_000;
const RENDER_DPI = 300;
const POINTS_PER_INCH = 72;
const MIN_MEAN_IOU = 0.5;
const MIN_WORDS_COMPARED = 20;
const TSV_WORD_LEVEL = '5';
const TSV_LEFT = 6;
const TSV_TOP = 7;
const TSV_WIDTH = 8;
const TSV_HEIGHT = 9;
const TSV_CONF = 10;
const TSV_TEXT = 11;

let workDir: string;
beforeAll(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-page-render-'));
});
afterAll(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('pxToPdfUserSpace', () => {
  // A 540 x 720 pt page whose CropBox starts at (36, 36), drawn at 72 dpi so that a pixel is a point. The same box
  // of pixels, 100 across and 50 down from the top left, 40 wide and 20 tall, lands in a different place of the page
  // for each /Rotate. The cases are worked out by hand from the way each turn shows the page:
  //   0   x = 36 + u            y = 756 - v          (u across, v down; 756 is the top of the CropBox)
  //   90  the page's bottom-left corner is at the top left:   x = 36 + v        y = 36 + u
  //   180 the page's top-right corner is at the top left:     x = 36 + 540 - u  y = 36 + v
  //   270 the page's top-right corner is at the bottom left:  x = 36 + 540 - v  y = 756 - u
  const CROP_BOX = { x0: 36, y0: 36, x1: 576, y1: 756 };
  const BOX = { x: 100, y: 50, width: 40, height: 20 };
  const size = (rotation: 0 | 90 | 180 | 270): { widthPx: number; heightPx: number } =>
    rotation === 90 || rotation === 270 ? { widthPx: 720, heightPx: 540 } : { widthPx: 540, heightPx: 720 };
  const page = (rotation: 0 | 90 | 180 | 270, dpi = 72) => ({ frame: { cropBox: CROP_BOX, rotation } as PdfPageFrame, dpi, ...size(rotation) });

  it.each([
    [0, { x0: 136, y0: 686, x1: 176, y1: 706 }],
    [90, { x0: 86, y0: 136, x1: 106, y1: 176 }],
    [180, { x0: 436, y0: 86, x1: 476, y1: 106 }],
    [270, { x0: 506, y0: 616, x1: 526, y1: 656 }],
  ] as const)('maps a box on a page turned %i degrees with a CropBox that starts at (36, 36)', (rotation, expected) => {
    expect(pxToPdfUserSpace(BOX, page(rotation))).toEqual(expected);
  });

  it('scales by 72 / dpi: the same page at 144 dpi has twice the pixels and maps to the same points', () => {
    const doubled = { frame: { cropBox: CROP_BOX, rotation: 90 } as PdfPageFrame, dpi: 144, widthPx: 1440, heightPx: 1080 };
    expect(pxToPdfUserSpace({ x: 200, y: 100, width: 80, height: 40 }, doubled)).toEqual({ x0: 86, y0: 136, x1: 106, y1: 176 });
  });

  it('is the identity apart from the y flip for an unrotated page at the origin', () => {
    const origin = { frame: { cropBox: { x0: 0, y0: 0, x1: 612, y1: 792 }, rotation: 0 } as PdfPageFrame, dpi: 72, widthPx: 612, heightPx: 792 };
    expect(pxToPdfUserSpace({ x: 10, y: 20, width: 30, height: 40 }, origin)).toEqual({ x0: 10, y0: 732, x1: 40, y1: 772 });
  });
});

describe('the invented OCR defaults are gone', () => {
  const FILES = [
    'src/lib/conversions/ocr.ts',
    'src/lib/conversions/ocr-export.ts',
    'src/lib/conversions/ocr-import.ts',
    'src/lib/conversions/document.ts',
    'src/lib/conversions/pdf-text-geometry.ts',
  ];
  // A confidence written as a literal (a fallback or a constant 1), and the US Letter page size used as a default.
  const INVENTED = /\?\?\s*0\.9\b|:\s*0\.9\b|\bconfidence:\s*1(?:\.0)?\b|\|\|\s*(?:612|792)\b|,\s*612\s*,\s*792\b|imageWidth:\s*612|imageHeight:\s*792/;

  it('writes no confidence or page size literal as a fallback in the OCR code', () => {
    for (const file of FILES) {
      const lines = fs.readFileSync(path.join(__dirname, '..', file), 'utf-8').split('\n');
      const hits = lines.map((line, index) => ({ line, index })).filter(({ line }) => INVENTED.test(line) && !line.trim().startsWith('*') && !line.trim().startsWith('//'));
      expect(hits.map(({ line, index }) => `${file}:${index + 1}: ${line.trim()}`), file).toEqual([]);
    }
  });

  it('reports no confidence and no page size when nothing was analysed, and no confidence for a page that kept its text', () => {
    const empty = assembleCombinedOcrResult(new Map(), [], 'plain text');
    expect(empty.confidence).toBeNull();
    expect(empty.imageWidth).toBeUndefined();
    expect(empty.imageHeight).toBeUndefined();

    const analysed = assembleCombinedOcrResult(new Map(), [{ pageNumber: 1, width: 595, height: 842, charCount: 5, wordCount: 1, hasTextLayer: true, text: 'Hello' }]);
    expect(analysed.confidence).toBeNull();
    expect(analysed.pages?.[0]).toMatchObject({ confidence: null, source: 'text-layer', width: 595, height: 842 });
  });
});

describe('what a PDF render is allowed to cost', () => {
  async function blankPdf(pageCount: number, size: [number, number] = [612, 792]): Promise<Buffer> {
    const doc = await PDFDocument.create();
    for (let i = 0; i < pageCount; i++) doc.addPage(size);
    return Buffer.from(await doc.save());
  }

  it('refuses a resolution above the maximum or below the minimum before rendering anything', async () => {
    const pdf = await blankPdf(1);
    for (const dpi of [OCR_MAX_DPI + 1, 10, Number.NaN, -300]) {
      await expect(recognizeRenderedPdfPages(pdf, undefined, { dpi }), String(dpi)).rejects.toThrow(UnsupportedOptionError);
    }
    expect(OCR_DEFAULT_DPI).toBe(300);
    expect(OCR_MAX_DPI).toBe(600);
  });

  it('refuses a page whose render would exceed the pixel limit with a 413 before drawing it', async () => {
    const pdf = await blankPdf(1, [20_000, 20_000]);
    const refused = recognizeRenderedPdfPages(pdf, undefined, {});
    await expect(refused).rejects.toBeInstanceOf(InputPixelLimitError);
    // 20000 pt at 300 dpi is ceil(20000 x 300 / 72) = 83334 pixels a side.
    await expect(refused).rejects.toMatchObject({ name: 'InputPixelLimitError', status: 413, width: 83334, height: 83334 });
  });

  it(`refuses more than ${OCR_MAX_RENDERED_PAGES} pages with a 413`, async () => {
    const pdf = await blankPdf(OCR_MAX_RENDERED_PAGES + 1);
    const refused = recognizeRenderedPdfPages(pdf, undefined, {});
    await expect(refused).rejects.toBeInstanceOf(PayloadLimitError);
    await expect(refused).rejects.toMatchObject({ name: 'PayloadLimitError', status: 413 });
  });

  it('answers 503 and reads no image objects in their place when pdftoppm is not installed', async () => {
    const pdf = await blankPdf(1);
    const exists = fs.existsSync.bind(fs);
    vi.spyOn(fs, 'existsSync').mockImplementation((candidate) => (String(candidate).includes('pdftoppm') ? false : exists(candidate)));
    vi.stubEnv('PDFTOPPM_PATH', '');
    const refused = recognizeRenderedPdfPages(pdf, undefined, {});
    await expect(refused).rejects.toBeInstanceOf(OcrEngineUnavailableError);
    await expect(refused).rejects.toMatchObject({
      name: 'OcrEngineUnavailableError',
      message: 'Rendering PDF pages for OCR needs Poppler pdftoppm, which is not installed on this server.',
    });
    vi.unstubAllEnvs();
  });
});

/** Two strips of text on a page that is shown turned 90 degrees and cropped, each drawn turned the other way. */
async function twoStripRotatedPdf(): Promise<Buffer> {
  const strips = [
    ['Notes on the harbour survey of the northern shore.', 'The survey began at dawn, when the tide was low.', 'Each crew member carried a measuring rod.'],
    ['Wind from the west brought rain, so the final', 'sketches were finished indoors.', 'The harbour master offered the logbooks.'],
  ];
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  page.setCropBox(36, 36, 540, 720);
  page.setRotation(degrees(90));
  const STRIP_X = [300, 500];
  for (const [index, lines] of strips.entries()) {
    const file = path.join(workDir, `strip-${index}.png`);
    execFileSync(requireMagick(), [
      '-size', '1300x260', 'xc:white', '-font', 'DejaVu-Sans', '-pointsize', '30', '-fill', 'black', '-interline-spacing', '8',
      '-annotate', '+20+45', lines.join('\n'), '-colorspace', 'Gray', '-depth', '8', '-strip', file,
    ]);
    const image = await doc.embedPng(fs.readFileSync(file));
    // Drawn a quarter turn counterclockwise, so that the page's own clockwise /Rotate shows it upright.
    page.drawImage(image, { x: STRIP_X[index], y: 100, width: 520, height: 104, rotate: degrees(90) });
  }
  return Buffer.from(await doc.save());
}

describe('the searchable PDF of a rotated, cropped page with two image strips', () => {
  oracleTest(
    'places its words where Poppler renders them, mean IoU of at least 0.5 against the engine reading the render',
    ['tesseract', 'pdftoppm', 'pdftotext'],
    async () => {
      requireTessdata('eng');
      if (!MAGICK_BINARY) throw new OracleToolMissingError('magick', 'ImageMagick is not installed');
      const input = await twoStripRotatedPdf();
      const inputPath = path.join(workDir, 'rotated.pdf');
      fs.writeFileSync(inputPath, input);

      // The reference: Poppler's render of the page as displayed and the engine's reading of it, in points.
      const renderBase = path.join(workDir, 'reference');
      execFileSync(getOracleToolPath('pdftoppm') as string, ['-png', '-gray', '-cropbox', '-singlefile', '-r', String(RENDER_DPI), inputPath, renderBase], { timeout: REFERENCE_TIMEOUT_MS });
      const tsv = execFileSync(requireTesseract(), [`${renderBase}.png`, 'stdout', '-l', 'eng', '--psm', '3', '--oem', '1', 'tsv'], {
        encoding: 'utf-8',
        timeout: REFERENCE_TIMEOUT_MS,
        env: { ...process.env, OMP_THREAD_LIMIT: '1' },
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      const scale = POINTS_PER_INCH / RENDER_DPI;
      const reference = tsv
        .split('\n')
        .slice(1)
        .map((row) => row.split('\t'))
        .filter((fields) => fields[0] === TSV_WORD_LEVEL && Number(fields[TSV_CONF]) >= 0 && fields[TSV_TEXT]?.trim())
        .map((fields) => ({
          text: fields[TSV_TEXT].trim(),
          x0: Number(fields[TSV_LEFT]) * scale,
          y0: Number(fields[TSV_TOP]) * scale,
          x1: (Number(fields[TSV_LEFT]) + Number(fields[TSV_WIDTH])) * scale,
          y1: (Number(fields[TSV_TOP]) + Number(fields[TSV_HEIGHT])) * scale,
        }));
      expect(reference.length).toBeGreaterThanOrEqual(MIN_WORDS_COMPARED);

      const { buffer, pageDecisions } = await performSmartMultiPagePdfOcr(input, {});
      expect(pageDecisions[0]).toMatchObject({ pageNumber: 1, skipped: false, reason: 'no_text' });
      const outputPath = path.join(workDir, 'searchable.pdf');
      fs.writeFileSync(outputPath, buffer);
      // Poppler reports the words of a turned page in the page as displayed, from its top left.
      const bbox = execFileSync(getOracleToolPath('pdftotext') as string, ['-cropbox', '-bbox-layout', '-enc', 'UTF-8', outputPath, '-'], {
        encoding: 'utf-8',
        timeout: REFERENCE_TIMEOUT_MS,
        maxBuffer: 64 * 1024 * 1024,
      });
      const actual: PdfWord[] = [...bbox.matchAll(/<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">([^<]*)<\/word>/g)].map((m) => ({
        xMin: Number(m[1]),
        yMin: Number(m[2]),
        xMax: Number(m[3]),
        yMax: Number(m[4]),
        text: m[5],
      }));
      const ious = wordIous(reference, actual);
      const mean = ious.reduce((sum, value) => sum + value, 0) / ious.length;
      expect(mean, `mean IoU over ${ious.length} words`).toBeGreaterThanOrEqual(MIN_MEAN_IOU);
      // A text layer that ignored the rotation or the CropBox would put no word near its reference box.
      expect(ious.filter((value) => value >= MIN_MEAN_IOU).length).toBeGreaterThanOrEqual(Math.floor(ious.length * 0.8));
    },
    TEST_TIMEOUT_MS
  );
});

describe('a page of vector text with a small logo', () => {
  oracleTest(
    'is not recognized in skip_text mode, and the file comes back byte for byte',
    ['tesseract', 'pdftotext'],
    async () => {
      if (!MAGICK_BINARY) throw new OracleToolMissingError('magick', 'ImageMagick is not installed');
      const logo = path.join(workDir, 'logo.png');
      execFileSync(requireMagick(), ['-size', '60x30', 'xc:navy', '-fill', 'white', '-pointsize', '14', '-annotate', '+8+20', 'ACME', '-depth', '8', logo]);
      const doc = await PDFDocument.create();
      const page = doc.addPage([612, 792]);
      const font = await doc.embedFont(StandardFonts.Helvetica);
      const body = 'The committee reviewed the quarterly report and approved the budget for the regional water project this year.';
      for (let i = 0; i < 10; i++) page.drawText(`${body} Line ${i + 1}.`, { x: 40, y: 740 - i * 20, size: 10, font });
      page.drawImage(await doc.embedPng(fs.readFileSync(logo)), { x: 500, y: 740, width: 60, height: 30 });
      const input = Buffer.from(await doc.save());

      const result = await performSmartMultiPagePdfOcr(input, {});
      expect(result.pageDecisions).toEqual([expect.objectContaining({ pageNumber: 1, skipped: true, reason: 'has_text' })]);
      expect(result.ocrResults.size).toBe(0);
      expect(Buffer.compare(result.buffer, input)).toBe(0);
      expect(result.combinedOcrResult.confidence).toBeNull();
      expect(result.combinedOcrResult.pages?.[0].source).toBe('text-layer');
    },
    TEST_TIMEOUT_MS
  );
});
