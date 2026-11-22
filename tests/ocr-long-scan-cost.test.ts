import sharp from 'sharp';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { looksMisread, recognizePage, shutdownOcrWorkerPool } from '../src/lib/conversions/ocr';
import { locateLanguageData } from '../src/lib/conversions/ocr-language-data';
import { OSD_SUSPECT_QUALITY } from '../src/lib/conversions/ocr-osd';
import type { OcrResult } from '../src/lib/conversions/ocr-pdf-combiner';
import type { OcrRescueGate } from '../src/lib/conversions/ocr-work-budget';
import { skipUnless } from './helpers/strict-skip';

const engMissing = skipUnless('eng.traineddata (Tesseract English data)', locateLanguageData('eng') !== null);

/** A reading whose words all have `confidence`, as the page score of the reading is the mean of them. */
function readingAt(confidence: number): OcrResult {
  const word = { text: 'reading', bbox: { x: 0, y: 0, width: 80, height: 20 }, confidence };
  return {
    text: 'reading',
    confidence,
    calibrated: false,
    wordCount: 1,
    lines: ['reading'],
    lineBlocks: [{ text: 'reading', bbox: word.bbox, words: [word] }],
  } as OcrResult;
}

describe('the pages that orientation detection looks at', () => {
  it('leaves a dense upright page that reads at 0.76 alone, and still looks at a page that reads like a sideways one', () => {
    // `cc-7600350.pdf` page 31: 2,060 words read at 0.76 was judged turned by 180 degrees and read three times more for nothing.
    expect(OSD_SUSPECT_QUALITY).toBeLessThan(0.76);
    expect(looksMisread(readingAt(0.76))).toBe(false);
    expect(looksMisread(readingAt(0.7))).toBe(false);
    // The golden pages turned by a quarter or half turn score 0.62 and less, and the sideways slides of the same PDF 0.19 to 0.46.
    expect(looksMisread(readingAt(0.62))).toBe(true);
    expect(looksMisread(readingAt(0.46))).toBe(true);
  });
});

describe.skipIf(engMissing)('the second reading of a page by the ONNX engine', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });
  afterAll(async () => {
    await shutdownOcrWorkerPool();
  });

  it('does not decode the page to look for ink before the document has said whether it can afford the reading', async () => {
    // A page with a few marks that Tesseract reads nothing from scores 0 and asks for the second reading; the gate refuses it.
    const page = await sharp({ create: { width: 640, height: 400, channels: 3, background: '#fff' } })
      .composite([{ input: { create: { width: 90, height: 14, channels: 3, background: '#000' } }, left: 200, top: 190 }])
      .png()
      .toBuffer();
    const stats = vi.spyOn(sharp.prototype, 'stats');
    let statsBeforeGate = -1;
    let asked = 0;
    const refusing: OcrRescueGate = {
      run: async () => {
        asked++;
        statsBeforeGate = stats.mock.calls.length;
        return null;
      },
    };
    const callsBeforeReading = stats.mock.calls.length;
    const read = await recognizePage(page, 'eng', { detectOrientation: false, rescue: refusing });
    expect(read.enginePath).not.toBe('onnx');
    expect(asked).toBeGreaterThan(0);
    // Nothing decoded the page for its ink before the gate was asked, and nothing after the refusal either.
    expect(statsBeforeGate).toBe(callsBeforeReading);
    expect(stats.mock.calls.length).toBe(callsBeforeReading);
  }, 120_000);
});

