import { beforeEach, describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';
import type { OcrResult } from '../src/lib/conversions/ocr-pdf-combiner';
import type { PdfPageAnalysis } from '../src/lib/types';

/**
 * The recognition language travels with the result so exports can tag paragraphs: through the
 * combined multi-page result and through the in-browser (edge) recognizer.
 */

const createWorker = vi.fn();
vi.mock('tesseract.js', () => ({ default: { createWorker }, createWorker }));
vi.mock('../src/lib/conversions/ocr-pdf-combiner', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/conversions/ocr-pdf-combiner')>();
  return { ...actual, parseTesseractBlocks: vi.fn(actual.parseTesseractBlocks) };
});

import { assembleCombinedOcrResult } from '../src/lib/conversions/ocr';
import { parseTesseractBlocks } from '../src/lib/conversions/ocr-pdf-combiner';
import { runClientEdgeOcr } from '../src/lib/edge-ocr';

function ocrPage(language: string | undefined): OcrResult {
  return {
    text: 'hello',
    confidence: 0.9,
    wordCount: 1,
    lines: ['hello'],
    lineBlocks: [],
    imageWidth: 100,
    imageHeight: 200,
    language,
  };
}

function analysis(pageNumber: number): PdfPageAnalysis {
  return { pageNumber, width: 100, height: 200, text: 'native', wordCount: 1 } as PdfPageAnalysis;
}

describe('assembleCombinedOcrResult', () => {
  it('copies the recognition language to each recognized page and to the combined result', () => {
    const combined = assembleCombinedOcrResult(
      new Map([
        [1, ocrPage('kor')],
        [3, ocrPage('eng')],
      ]),
      [analysis(1), analysis(2), analysis(3)]
    );
    expect(combined.pages?.map((p) => [p.pageNumber, p.language])).toEqual([
      [1, 'kor'],
      [2, undefined],
      [3, 'eng'],
    ]);
    expect(combined.language).toBe('kor');
  });

  it('leaves the language unset when no page was recognized', () => {
    const combined = assembleCombinedOcrResult(new Map(), [analysis(1)]);
    expect(combined.language).toBeUndefined();
    expect(combined.pages?.[0].language).toBeUndefined();
  });
});

describe('edge recognizer', () => {
  beforeEach(() => {
    createWorker.mockReset();
    vi.mocked(parseTesseractBlocks).mockClear();
  });

  it.each([
    ['ko', 'kor'],
    ['auto', 'eng'],
    ['zh', 'chi_sim'],
    [undefined, 'eng'],
  ])('passes the engine language of ocrLanguage %s (%s) to the block parser', async (ocrLanguage, expected) => {
    const blocks = [
      {
        paragraphs: [
          {
            lines: [
              {
                text: 'word',
                bbox: { x0: 5, y0: 5, x1: 45, y1: 25 },
                words: [{ text: 'word', confidence: 90, bbox: { x0: 5, y0: 5, x1: 45, y1: 25 } }],
              },
            ],
          },
        ],
      },
    ];
    createWorker.mockResolvedValue({
      recognize: vi.fn(async () => ({ data: { text: 'word', confidence: 90, blocks } })),
      terminate: vi.fn(async () => undefined),
    });
    const png = await sharp({ create: { width: 60, height: 40, channels: 3, background: '#ffffff' } }).png().toBuffer();
    const file = new File([new Uint8Array(png)], 'scan.png', { type: 'image/png' });

    await runClientEdgeOcr(file, { ocrEnabled: true, ocrLanguage });

    expect(createWorker).toHaveBeenCalledWith(expected, 1, expect.anything());
    expect(vi.mocked(parseTesseractBlocks).mock.calls[0][3]).toBe(expected);
    expect(vi.mocked(parseTesseractBlocks).mock.calls[0][0]).toBe(blocks);
  });
});
