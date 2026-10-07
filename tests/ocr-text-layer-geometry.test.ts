import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { PDFArray, PDFDocument, PDFRawStream, decodePDFRawStream } from 'pdf-lib';
import { generateSearchablePdf, performOcr, recognizePage, shutdownOcrWorkerPool } from '../src/lib/conversions/ocr';
import { OCR_DEFAULT_DPI, readDeclaredDpi, resolveImageDpi } from '../src/lib/conversions/ocr-dpi';
import {
  createLosslessSandwichPdfFromImage,
  type OcrResult,
} from '../src/lib/conversions/ocr-pdf-combiner';
import {
  OCR_MAX_TEXT_LAYER_CHARS_PER_PAGE,
  OCR_MAX_WORDS_PER_PAGE,
  OcrGeometryUnavailableError,
  OcrTextLayerLimitError,
} from '../src/lib/conversions/ocr-text-layer';
import { OcrEngineUnavailableError } from '../src/lib/types';
import { oracleTest } from './helpers/oracle-test';
import { getOracleToolPath, OracleToolMissingError } from './helpers/differential-oracle';
import { engineTsvWords, fixtureImage, fixturePath, groundTruth, requireTessdata } from './helpers/ocr-fixtures';
import { characterErrorRatePercent, wordRecall } from './helpers/ocr-cer';
import { pdfWords, wordIous } from './helpers/pdftotext-bbox';
import { shownWords } from './helpers/pdf-shown-text';

/**
 * The searchable-PDF text layer sits where the words are on the scan. The page is as large as the
 * scan was (pixels x 72 / dpi), every word has its own text matrix on its baseline and a horizontal
 * scaling that is not clamped, and a result with no geometry is refused. Expected values are worked
 * out by hand from the inputs, read back with poppler (`pdfinfo`, `pdftotext -bbox-layout`) and
 * compared with the engine's own TSV boxes.
 */

const TEST_TIMEOUT_MS = 240_000;
const POINTS_PER_INCH = 72;
const LETTER_WIDTH_PX = 2550;
const LETTER_HEIGHT_PX = 3300;
const LETTER_WIDTH_PT = 612;
const LETTER_HEIGHT_PT = 792;
const MIN_MEAN_IOU = 0.55;
const MIN_SHARE_AT_HALF = 0.75;
const HALF = 0.5;

function pdfinfoPageSize(pdf: Buffer): string {
  const tool = getOracleToolPath('pdfinfo');
  if (!tool) throw new OracleToolMissingError('pdfinfo', 'pdfinfo is not installed');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-geometry-'));
  try {
    const file = path.join(dir, 'page.pdf');
    fs.writeFileSync(file, pdf);
    return /Page size:\s+(.+)/.exec(execFileSync(tool, [file], { encoding: 'utf-8' }))?.[1].trim() ?? '';
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function withPdf<T>(pdf: Buffer, run: (file: string) => T): T {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-geometry-'));
  try {
    const file = path.join(dir, 'page.pdf');
    fs.writeFileSync(file, pdf);
    return run(file);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function pageContent(doc: PDFDocument): string {
  const contents = doc.getPage(0).node.Contents();
  const streams = contents instanceof PDFArray ? contents.asArray() : [contents];
  return streams
    .map((ref) => Buffer.from(decodePDFRawStream(doc.context.lookup(ref) as PDFRawStream).decode()).toString('latin1'))
    .join('\n');
}

function oneLine(words: Array<{ text: string; x: number; width: number }>, extra: Partial<OcrResult['lineBlocks'] extends (infer L)[] | undefined ? L : never> = {}): OcrResult {
  const text = words.map((w) => w.text).join(' ');
  return {
    text,
    confidence: 0.9,
    wordCount: words.length,
    lines: [text],
    imageWidth: LETTER_WIDTH_PX,
    imageHeight: LETTER_HEIGHT_PX,
    lineBlocks: [
      {
        text,
        bbox: { x: words[0].x, y: 300, width: words[words.length - 1].x + words[words.length - 1].width - words[0].x, height: 50 },
        words: words.map((w) => ({ text: w.text, bbox: { x: w.x, y: 300, width: w.width, height: 50 } })),
        ...extra,
      },
    ],
  };
}

async function blankLetterPage(density?: number, format: 'png' | 'jpeg' = 'png'): Promise<Buffer> {
  let image = sharp({ create: { width: LETTER_WIDTH_PX, height: LETTER_HEIGHT_PX, channels: 3, background: '#ffffff' } });
  if (density !== undefined) image = image.withMetadata({ density });
  return format === 'png' ? image.png().toBuffer() : image.jpeg().toBuffer();
}

describe('page size', () => {
  oracleTest('a 2550x3300 px scan at 300 dpi is a 612 x 792 pt page (PNG pHYs)', ['pdfinfo'], async () => {
    const png = await blankLetterPage(300);
    const pdf = await createLosslessSandwichPdfFromImage(png, oneLine([{ text: 'Letter', x: 300, width: 200 }]));
    expect(pdfinfoPageSize(pdf)).toBe(`${LETTER_WIDTH_PT} x ${LETTER_HEIGHT_PT} pts (letter)`);
  });

  oracleTest('the page follows the declared resolution: 150 dpi doubles it (JPEG JFIF)', ['pdfinfo'], async () => {
    const jpeg = await blankLetterPage(150, 'jpeg');
    const pdf = await createLosslessSandwichPdfFromImage(jpeg, oneLine([{ text: 'Letter', x: 300, width: 200 }]));
    expect(pdfinfoPageSize(pdf)).toBe(`${LETTER_WIDTH_PT * 2} x ${LETTER_HEIGHT_PT * 2} pts`);
  });

  oracleTest('an image that declares no resolution is sized at the documented default', ['pdfinfo'], async () => {
    expect(OCR_DEFAULT_DPI).toBe(300);
    // libvips writes 1 pixel per millimetre into an image whose maker set none; that is not a resolution.
    const png = await blankLetterPage();
    const pdf = await createLosslessSandwichPdfFromImage(png, oneLine([{ text: 'Letter', x: 300, width: 200 }]));
    expect(pdfinfoPageSize(pdf)).toBe(`${LETTER_WIDTH_PT} x ${LETTER_HEIGHT_PT} pts (letter)`);
  });

  it('records the resolution on the OCR result, and whether it was assumed', async () => {
    expect(resolveImageDpi(await blankLetterPage(300))).toEqual({ dpi: 300, assumed: false });
    expect(resolveImageDpi(await blankLetterPage(200, 'jpeg'))).toEqual({ dpi: 200, assumed: false });
    expect(resolveImageDpi(await blankLetterPage())).toEqual({ dpi: OCR_DEFAULT_DPI, assumed: true });
  });

  oracleTest('performOcr reports the resolution of a golden page and the PDF is sized with it', ['pdfinfo', 'tesseract'], async () => {
    requireTessdata('eng');
    const png = fixtureImage('en_a', 'clean300');
    const result = await performOcr(png, 'eng');
    expect(result.imageDpi).toEqual({ dpi: 300, assumed: false });
    // en_a__clean300 is 2000 x 490 px at 300 dpi.
    expect(pdfinfoPageSize(await generateSearchablePdf(png, result))).toBe('480 x 117.6 pts');
  }, TEST_TIMEOUT_MS);
});

describe('declared resolution, read from the header', () => {
  const pngWith = (chunks: Buffer[]): Buffer =>
    Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), ...chunks]);
  const chunk = (type: string, body: Buffer): Buffer => {
    const header = Buffer.alloc(8);
    header.writeUInt32BE(body.length, 0);
    header.write(type, 4, 'ascii');
    return Buffer.concat([header, body, Buffer.alloc(4)]);
  };
  const phys = (x: number, y: number, unit: number): Buffer => {
    const body = Buffer.alloc(9);
    body.writeUInt32BE(x, 0);
    body.writeUInt32BE(y, 4);
    body.writeUInt8(unit, 8);
    return chunk('pHYs', body);
  };
  const jfif = (units: number, density: number): Buffer =>
    Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x02, units, density >> 8, density & 0xff, density >> 8, density & 0xff, 0, 0]);

  it('reads PNG pHYs in pixels per metre (11811 per metre is 300 dpi)', () => {
    expect(readDeclaredDpi(pngWith([chunk('IHDR', Buffer.alloc(13)), phys(11811, 11811, 1)]))).toBe(300);
    expect(readDeclaredDpi(pngWith([chunk('IHDR', Buffer.alloc(13)), phys(5906, 5906, 1)]))).toBe(150);
  });

  it('reads JFIF density in dots per inch and per centimetre', () => {
    expect(readDeclaredDpi(jfif(1, 200))).toBe(200);
    expect(readDeclaredDpi(jfif(2, 118))).toBeCloseTo(299.7, 1);
  });

  /** A JPEG that is only SOI and an Exif block holding XResolution and ResolutionUnit in the given byte order. */
  const exifJpeg = (little: boolean, numerator: number, denominator: number, unit: number): Buffer => {
    const u16 = (v: number): Buffer => {
      const b = Buffer.alloc(2);
      if (little) b.writeUInt16LE(v);
      else b.writeUInt16BE(v);
      return b;
    };
    const u32 = (v: number): Buffer => {
      const b = Buffer.alloc(4);
      if (little) b.writeUInt32LE(v);
      else b.writeUInt32BE(v);
      return b;
    };
    const entryCount = 2;
    const directoryAt = 8;
    const valueAt = directoryAt + 2 + entryCount * 12 + 4;
    const tiff = Buffer.concat([
      Buffer.from(little ? 'II' : 'MM', 'ascii'),
      u16(42),
      u32(directoryAt),
      u16(entryCount),
      u16(0x011a), u16(5), u32(1), u32(valueAt),
      u16(0x0128), u16(3), u32(1), Buffer.concat([u16(unit), Buffer.alloc(2)]),
      u32(0),
      u32(numerator), u32(denominator),
    ]);
    const body = Buffer.concat([Buffer.from('Exif\0\0', 'binary'), tiff]);
    const length = Buffer.alloc(2);
    length.writeUInt16BE(body.length + 2);
    return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe1]), length, body]);
  };

  it('reads the Exif XResolution of a JPEG in either byte order, per inch or per centimetre', () => {
    expect(readDeclaredDpi(exifJpeg(true, 300, 1, 2))).toBe(300);
    expect(readDeclaredDpi(exifJpeg(false, 600, 2, 2))).toBe(300);
    expect(readDeclaredDpi(exifJpeg(true, 118, 1, 3))).toBeCloseTo(299.7, 1);
    expect(readDeclaredDpi(exifJpeg(true, 300, 0, 2))).toBeNull();
    expect(readDeclaredDpi(exifJpeg(true, 300, 1, 1))).toBeNull();
  });

  it('treats an unknown unit, a placeholder or an absurd value as undeclared', () => {
    expect(readDeclaredDpi(pngWith([chunk('IHDR', Buffer.alloc(13)), phys(11811, 11811, 0)]))).toBeNull();
    expect(readDeclaredDpi(pngWith([chunk('IHDR', Buffer.alloc(13)), phys(1000, 1000, 1)]))).toBeNull();
    expect(readDeclaredDpi(pngWith([chunk('IHDR', Buffer.alloc(13)), phys(0xffffffff, 0xffffffff, 1)]))).toBeNull();
    expect(readDeclaredDpi(jfif(0, 1))).toBeNull();
    expect(readDeclaredDpi(jfif(1, 1))).toBeNull();
  });

  it('gives up on truncated or unrelated input instead of reading past it', () => {
    expect(readDeclaredDpi(new Uint8Array(0))).toBeNull();
    expect(readDeclaredDpi(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0xff, 0xff, 0x70, 0x48, 0x59, 0x73]))).toBeNull();
    expect(readDeclaredDpi(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00]))).toBeNull();
    expect(readDeclaredDpi(Buffer.from('GIF89a'))).toBeNull();
  });
});

describe('word placement, worked out by hand', () => {
  // A 2550 x 3300 px page at 300 dpi: 0.24 pt per pixel, 792 pt high.
  const SCALE = POINTS_PER_INCH / 300;

  async function layerOf(result: OcrResult): Promise<{ content: string; doc: PDFDocument }> {
    const pdf = await createLosslessSandwichPdfFromImage(await blankLetterPage(300), result);
    const doc = await PDFDocument.load(pdf);
    return { content: pageContent(doc), doc };
  }

  it('puts the origin on the baseline: x from the box, y from the baseline, in points with y up', async () => {
    const result = oneLine(
      [
        { text: 'ab', x: 300, width: 100 },
        { text: 'cd', x: 450, width: 100 },
      ],
      { baseline: { x0: 300, y0: 340, x1: 550, y1: 340 }, rowHeight: 50 }
    );
    const { content } = await layerOf(result);
    const matrices = [...content.matchAll(/1 0 0 1 ([\d.]+) ([\d.]+) Tm/g)].map((m) => [Number(m[1]), Number(m[2])]);
    expect(matrices).toHaveLength(2);
    expect(matrices[0][0]).toBeCloseTo(300 * SCALE, 3);
    expect(matrices[1][0]).toBeCloseTo(450 * SCALE, 3);
    for (const [, y] of matrices) expect(y).toBeCloseTo(LETTER_HEIGHT_PT - 340 * SCALE, 3);
  });

  it('sets the font size to the row height and scales each word to exactly the width of its box, unclamped', async () => {
    // "ab" is two Latin-1 glyphs: one em of advance. The row is 50 px = 12 pt, so a 100 px (24 pt) box
    // needs 200 percent, and a 10 px (2.4 pt) box needs 20 percent: both outside the old 70..130 clamp.
    const result = oneLine(
      [
        { text: 'ab', x: 300, width: 100 },
        { text: 'cd', x: 450, width: 10 },
      ],
      { baseline: { x0: 300, y0: 340, x1: 460, y1: 340 }, rowHeight: 50 }
    );
    const { content } = await layerOf(result);
    expect([...content.matchAll(/\/\S+ ([\d.]+) Tf/g)].map((m) => Number(m[1]))).toEqual([12, 12]);
    expect([...content.matchAll(/([\d.]+) Tz/g)].map((m) => Number(m[1]))).toEqual([200, 20]);
  });

  it('measures a CJK word by its full-width advance: two Hangul syllables are two ems', async () => {
    // 한글 is 2 em = 24 pt at 12 pt; a 100 px (24 pt) box needs exactly 100 percent.
    const result = oneLine([{ text: '한글', x: 300, width: 100 }], { baseline: { x0: 300, y0: 340, x1: 400, y1: 340 }, rowHeight: 50 });
    const { content } = await layerOf(result);
    expect([...content.matchAll(/([\d.]+) Tz/g)].map((m) => Number(m[1]))).toEqual([100]);
  });

  it('derives the row from the word box when the engine gave no baseline (the native tool reports none)', async () => {
    // Box 50 px tall at y 300: 12 pt font, baseline 77 percent of the way down (770 / 1000 ascent).
    const result = oneLine([{ text: 'ab', x: 300, width: 100 }]);
    const { content } = await layerOf(result);
    const [, y] = /1 0 0 1 [\d.]+ ([\d.]+) Tm/.exec(content) as RegExpExecArray;
    expect(Number(y)).toBeCloseTo(LETTER_HEIGHT_PT - (300 + 0.77 * 50) * SCALE, 3);
  });

  it('turns the text matrix with a line that is not horizontal, whether the baseline or the angle says so', async () => {
    const byBaseline = oneLine([{ text: 'ab', x: 300, width: 100 }], { baseline: { x0: 300, y0: 340, x1: 400, y1: 440 }, rowHeight: 50 });
    const byAngle = oneLine([{ text: 'ab', x: 300, width: 100 }], { angleDegrees: 45 });
    for (const result of [byBaseline, byAngle]) {
      const { content } = await layerOf(result);
      const matrix = /([-\d.]+) ([-\d.]+) ([-\d.]+) ([-\d.]+) [\d.]+ [\d.]+ Tm/.exec(content) as RegExpExecArray;
      expect(matrix.slice(1, 5).map(Number)).toEqual([0.707107, -0.707107, 0.707107, 0.707107]);
    }
  });

  it('writes the words invisibly (render mode 3), in reading order, with a space after all but the last of a line', async () => {
    const result = oneLine(
      [
        { text: 'one', x: 300, width: 100 },
        { text: 'two', x: 450, width: 100 },
        { text: 'three', x: 600, width: 150 },
      ],
      { baseline: { x0: 300, y0: 340, x1: 750, y1: 340 }, rowHeight: 50 }
    );
    const { content, doc } = await layerOf(result);
    expect(content).toContain('3 Tr');
    expect(shownWords(doc)).toEqual(['one', 'two', 'three']);
    // The first two carry a trailing space glyph (one more CID than their letters), the last does not.
    const hexLengths = [...content.matchAll(/<([0-9A-F]+)> Tj/g)].map((m) => m[1].length / 4);
    expect(hexLengths).toEqual(['one'.length + 1, 'two'.length + 1, 'three'.length]);
  });
});

describe('a result with no geometry', () => {
  const textOnly: OcrResult = { text: 'Invoice 42', confidence: 0.9, wordCount: 2, lines: ['Invoice 42'], imageWidth: 100, imageHeight: 100 };

  it('is refused with a typed 503-class error and no PDF is made', async () => {
    const png = await sharp({ create: { width: 100, height: 100, channels: 3, background: '#ffffff' } }).png().toBuffer();
    const failure = await createLosslessSandwichPdfFromImage(png, textOnly).then(
      () => null,
      (err: unknown) => err as Error
    );
    expect(failure).toBeInstanceOf(OcrGeometryUnavailableError);
    expect(failure).toBeInstanceOf(OcrEngineUnavailableError);
    expect(failure?.message).toBe(
      'The OCR result has text but no line or word boxes, so a text layer cannot be placed on the page.'
    );
  });

  it('refuses a line that has text but no word boxes instead of spacing its words evenly', async () => {
    const png = await sharp({ create: { width: 100, height: 100, channels: 3, background: '#ffffff' } }).png().toBuffer();
    const noWords: OcrResult = {
      ...textOnly,
      lineBlocks: [{ text: 'Invoice 42', bbox: { x: 10, y: 10, width: 80, height: 12 }, words: [] }],
    };
    await expect(createLosslessSandwichPdfFromImage(png, noWords)).rejects.toThrow(
      "The line 'Invoice 42' has no word boxes, so its text cannot be placed."
    );
  });

  it('writes a page without a text layer for a page that has no text', async () => {
    const png = await sharp({ create: { width: 100, height: 100, channels: 3, background: '#ffffff' } }).png().toBuffer();
    const blank: OcrResult = { text: '', confidence: null, wordCount: 0, lines: [], lineBlocks: [], imageWidth: 100, imageHeight: 100 };
    const doc = await PDFDocument.load(await createLosslessSandwichPdfFromImage(png, blank));
    expect(shownWords(doc)).toEqual([]);
  });
});

describe('hostile results are bounded', () => {
  const png = () => sharp({ create: { width: 100, height: 100, channels: 3, background: '#ffffff' } }).png().toBuffer();

  it(`refuses more than ${OCR_MAX_WORDS_PER_PAGE} words on one page`, async () => {
    const words = Array.from({ length: OCR_MAX_WORDS_PER_PAGE + 1 }, () => ({ text: 'w', bbox: { x: 1, y: 1, width: 5, height: 5 } }));
    const result: OcrResult = {
      text: 'w',
      confidence: 0.9,
      wordCount: words.length,
      lines: ['w'],
      imageWidth: 100,
      imageHeight: 100,
      lineBlocks: [{ text: 'w', bbox: { x: 1, y: 1, width: 5, height: 5 }, words }],
    };
    await expect(createLosslessSandwichPdfFromImage(await png(), result)).rejects.toThrow(OcrTextLayerLimitError);
  });

  it(`refuses more than ${OCR_MAX_TEXT_LAYER_CHARS_PER_PAGE} characters on one page`, async () => {
    const giant = 'x'.repeat(OCR_MAX_TEXT_LAYER_CHARS_PER_PAGE + 1);
    const result: OcrResult = {
      text: giant,
      confidence: 0.9,
      wordCount: 1,
      lines: [giant],
      imageWidth: 100,
      imageHeight: 100,
      lineBlocks: [{ text: giant, bbox: { x: 1, y: 1, width: 5, height: 5 }, words: [{ text: giant, bbox: { x: 1, y: 1, width: 5, height: 5 } }] }],
    };
    await expect(createLosslessSandwichPdfFromImage(await png(), result)).rejects.toThrow(OcrTextLayerLimitError);
  });
});

describe('words against the engine\'s own boxes', () => {
  const pages: Array<[string, string]> = [
    ['en_a', 'clean300'],
    ['twocol', 'clean300'],
  ];

  for (const [page, variant] of pages) {
    for (const enginePath of ['wasm', 'cli'] as const) {
      oracleTest(
        `${page}__${variant} (${enginePath}): pdftotext's word boxes match the engine's TSV boxes in points`,
        ['pdftotext', 'tesseract'],
        async () => {
          requireTessdata('eng');
          const image = fixtureImage(page, variant);
          const { result } = await recognizePage(image, 'eng', { enginePath, detectOrientation: false });
          const pdf = await generateSearchablePdf(image, result);
          const scale = POINTS_PER_INCH / (result.imageDpi?.dpi ?? OCR_DEFAULT_DPI);
          const reference = engineTsvWords(fixturePath(page, variant), 'eng').map((w) => ({
            text: w.text,
            x0: w.x0 * scale,
            y0: w.y0 * scale,
            x1: w.x1 * scale,
            y1: w.y1 * scale,
          }));
          const ious = withPdf(pdf, (file) => wordIous(reference, pdfWords(file)[0].words));
          const mean = ious.reduce((sum, value) => sum + value, 0) / ious.length;
          const share = ious.filter((value) => value >= HALF).length / ious.length;
          expect(mean).toBeGreaterThanOrEqual(MIN_MEAN_IOU);
          expect(share).toBeGreaterThanOrEqual(MIN_SHARE_AT_HALF);
        },
        TEST_TIMEOUT_MS
      );
    }
  }

  oracleTest(
    'the first word starts where the generator drew it, and lines are as far apart as it spaced them',
    ['pdftotext', 'tesseract'],
    async () => {
      requireTessdata('eng');
      // generate_golden.py draws the text block at x = 90 px, with a line pitch of int(46 * 1.35) = 62 px.
      const DRAWN_LEFT_PX = 90;
      const DRAWN_LINE_PITCH_PX = 62;
      const GLYPH_BEARING_TOLERANCE_PT = 1.5;
      const PITCH_TOLERANCE_PT = 1;
      const image = fixtureImage('en_a', 'clean300');
      const result = await performOcr(image, 'eng');
      const words = withPdf(await generateSearchablePdf(image, result), (file) => pdfWords(file)[0].words);
      const scale = POINTS_PER_INCH / 300;
      const leftmost = Math.min(...words.map((w) => w.xMin));
      expect(Math.abs(leftmost - DRAWN_LEFT_PX * scale)).toBeLessThanOrEqual(GLYPH_BEARING_TOLERANCE_PT);
      const lineTops = [...new Set(words.map((w) => Math.round(w.yMin * 10) / 10))].sort((a, b) => a - b);
      const firstLines = lineTops.slice(0, 3);
      expect(firstLines.length).toBeGreaterThanOrEqual(2);
      expect(Math.abs(firstLines[1] - firstLines[0] - DRAWN_LINE_PITCH_PX * scale)).toBeLessThanOrEqual(PITCH_TOLERANCE_PT);
    },
    TEST_TIMEOUT_MS
  );

  oracleTest(
    'a Korean page keeps its words whole in the text layer (word recall 0.95 or more)',
    ['pdftotext', 'tesseract'],
    async () => {
      requireTessdata('kor');
      const image = fixtureImage('ko_a', 'clean300');
      const result = await performOcr(image, 'kor');
      const text = withPdf(await generateSearchablePdf(image, result), (file) =>
        execFileSync(getOracleToolPath('pdftotext') as string, ['-enc', 'UTF-8', file, '-'], { encoding: 'utf-8' })
      );
      expect(wordRecall(groundTruth('ko_a').replace(/\s+/g, ' '), text)).toBeGreaterThanOrEqual(0.9);
      expect(characterErrorRatePercent(groundTruth('ko_a'), text)).toBeLessThanOrEqual(3);
    },
    TEST_TIMEOUT_MS
  );

  oracleTest(
    'a page scanned upside down gets a text layer on its own baselines (the image is not turned)',
    ['pdftotext', 'tesseract'],
    async () => {
      requireTessdata('eng');
      requireTessdata('osd');
      const upright = engineTsvWords(fixturePath('en_a', 'clean300'), 'eng');
      const WIDTH_PX = 2000;
      const HEIGHT_PX = 490;
      const turnedImage = await sharp(fixtureImage('en_a', 'clean300')).rotate(180).png().withMetadata({ density: 300 }).toBuffer();
      const result = await performOcr(turnedImage, 'eng');
      expect(result.orientation?.rotationApplied).toBe(180);
      const scale = POINTS_PER_INCH / 300;
      // Where the upright page's words are on the page after the scan was turned 180 degrees.
      const reference = upright.map((w) => ({
        text: w.text,
        x0: (WIDTH_PX - w.x1) * scale,
        y0: (HEIGHT_PX - w.y1) * scale,
        x1: (WIDTH_PX - w.x0) * scale,
        y1: (HEIGHT_PX - w.y0) * scale,
      }));
      const ious = withPdf(await generateSearchablePdf(turnedImage, result), (file) => wordIous(reference, pdfWords(file)[0].words));
      expect(ious.reduce((sum, value) => sum + value, 0) / ious.length).toBeGreaterThanOrEqual(MIN_MEAN_IOU);
      expect(ious.filter((value) => value >= HALF).length / ious.length).toBeGreaterThanOrEqual(MIN_SHARE_AT_HALF);
      await shutdownOcrWorkerPool();
    },
    TEST_TIMEOUT_MS
  );
});

describe('the clamp is gone', () => {
  it('has no 70..130 horizontal scaling clamp in the text layer writer', () => {
    const sources = ['ocr-pdf-combiner.ts', 'ocr-text-layer.ts'].map((file) =>
      fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'conversions', file), 'utf-8')
    );
    for (const source of sources) expect(source).not.toMatch(/Math\.min\(130/);
  });
});
