import { describe, it, expect, onTestFinished } from 'vitest';
import { existsSync } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { PDFDocument } from 'pdf-lib';
import { generateSearchablePdf, performOcr } from '../src/lib/conversions/ocr';

/**
 * The OCR worker's image reader accepts fewer formats than the image decoder used for
 * validation. Images it cannot read (TIFF, AVIF, SVG) used to raise an uncaught exception from
 * the worker message handler, which can crash the process, and were never recognized.
 */

const TESSDATA_DIRS = [
  ...(process.env.TESSDATA_PREFIX ? [process.env.TESSDATA_PREFIX] : []),
  process.cwd(),
  '/usr/share/tesseract-ocr/5/tessdata',
  '/usr/share/tesseract-ocr/4.00/tessdata',
  '/usr/share/tessdata',
];
const HAS_ENG = TESSDATA_DIRS.some(
  (dir) => existsSync(path.join(dir, 'eng.traineddata')) || existsSync(path.join(dir, 'eng.traineddata.gz'))
);

const WORD = 'HARBOR';
const TEXT_SVG = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="160">' +
    '<rect width="480" height="160" fill="#ffffff"/>' +
    `<text x="40" y="105" font-family="DejaVu Sans, sans-serif" font-size="72" fill="#000000">${WORD}</text></svg>`,
  'utf-8'
);

function captureUncaught(): Error[] {
  const captured: Error[] = [];
  const listener = (err: Error) => captured.push(err);
  process.on('uncaughtException', listener);
  onTestFinished(() => {
    process.off('uncaughtException', listener);
  });
  return captured;
}

async function encodings(): Promise<Record<string, Buffer>> {
  return {
    tiff: await sharp(TEXT_SVG).flatten({ background: '#ffffff' }).tiff().toBuffer(),
    avif: await sharp(TEXT_SVG).flatten({ background: '#ffffff' }).avif({ quality: 90 }).toBuffer(),
    svg: TEXT_SVG,
  };
}

describe.skipIf(!HAS_ENG)('OCR worker error containment (needs eng.traineddata)', () => {
  it('recognizes decodable images the OCR reader cannot open natively, without uncaught errors', async () => {
    const uncaught = captureUncaught();
    for (const [format, buffer] of Object.entries(await encodings())) {
      const result = await performOcr(buffer, 'eng');
      expect(result.text.toUpperCase(), format).toContain(WORD);
      expect(result.imageWidth, format).toBe(480);
      expect(result.imageHeight, format).toBe(160);
    }
    // Let any late worker messages surface before checking.
    await new Promise((resolve) => setImmediate(resolve));
    expect(uncaught.map((e) => e.message)).toEqual([]);
  }, 120_000);
});

/** EXIF orientation 6: the stored pixels must be rotated 90° clockwise to display upright. */
const EXIF_ROTATE_90_CW = 6;
const STORED_COUNTER_CLOCKWISE_DEGREES = 270;

async function rotatedPhotoJpeg(): Promise<Buffer> {
  const upright = await sharp(TEXT_SVG).flatten({ background: '#ffffff' }).png().toBuffer();
  return sharp(upright)
    .rotate(STORED_COUNTER_CLOCKWISE_DEGREES)
    .jpeg({ quality: 95 })
    .withMetadata({ orientation: EXIF_ROTATE_90_CW })
    .toBuffer();
}

describe.skipIf(!HAS_ENG)('OCR of EXIF-rotated photos (needs eng.traineddata)', () => {
  it('recognizes text in the displayed orientation and reports upright dimensions', async () => {
    const photo = await rotatedPhotoJpeg();
    const stored = await sharp(photo).metadata();
    expect([stored.width, stored.height, stored.orientation]).toEqual([160, 480, EXIF_ROTATE_90_CW]);

    const result = await performOcr(photo, 'eng');
    expect(result.text.toUpperCase()).toContain(WORD);
    expect([result.imageWidth, result.imageHeight]).toEqual([480, 160]);
  }, 120_000);

  it('embeds the upright image so the searchable page matches the text layer', async () => {
    const photo = await rotatedPhotoJpeg();
    const result = await performOcr(photo, 'eng');
    const pdf = await PDFDocument.load(await generateSearchablePdf(photo, result));
    const { width, height } = pdf.getPage(0).getSize();
    expect([width, height]).toEqual([480, 160]);
  }, 120_000);
});
