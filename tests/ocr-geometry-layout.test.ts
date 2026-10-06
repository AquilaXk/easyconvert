import { describe, expect, it } from 'vitest';
import { mapOcrResultToSource, type OcrGeometry } from '../src/lib/conversions/ocr-geometry';
import type { OcrLayoutGroup, OcrLineBlock, OcrResult } from '../src/lib/conversions/ocr-pdf-combiner';

/**
 * Page preparation can scale the page before recognition, so every geometric field of a line comes
 * back in prepared-image pixels: the line and word boxes, the block and paragraph boxes, the
 * baseline points and the row measures. The expected values below are worked by hand for a page
 * scaled up by exactly 2 with no turn, so each source value is half the prepared one.
 */

const DOUBLED: OcrGeometry = {
  sourceWidth: 500,
  sourceHeight: 400,
  scaledWidth: 1000,
  scaledHeight: 800,
  outputWidth: 1000,
  outputHeight: 800,
  rotationDegrees: 0,
};

function line(text: string, y: number, block: OcrLayoutGroup, paragraph: OcrLayoutGroup): OcrLineBlock {
  return {
    text,
    bbox: { x: 100, y, width: 600, height: 60 },
    words: [{ text, confidence: 90, bbox: { x: 100, y, width: 200, height: 60 } }],
    block,
    paragraph,
    baseline: { x0: 100, y0: y + 48, x1: 700, y1: y + 52 },
    rowHeight: 40,
    ascenders: 14,
    descenders: 10,
  };
}

function prepared(): OcrResult {
  const block: OcrLayoutGroup = { bbox: { x: 80, y: 180, width: 700, height: 220 }, language: 'eng' };
  const paragraph: OcrLayoutGroup = { bbox: { x: 90, y: 190, width: 680, height: 200 } };
  return {
    text: 'one\ntwo',
    confidence: 0.9,
    wordCount: 2,
    lines: ['one', 'two'],
    lineBlocks: [line('one', 200, block, paragraph), line('two', 300, block, paragraph)],
    imageWidth: 1000,
    imageHeight: 800,
  };
}

describe('mapping recognized layout back to the source page', () => {
  const mapped = mapOcrResultToSource(prepared(), DOUBLED);
  const [first, second] = mapped.lineBlocks ?? [];

  it('halves the block and paragraph boxes of a page scaled by 2', () => {
    expect(first.block?.bbox).toEqual({ x: 40, y: 90, width: 350, height: 110 });
    expect(first.paragraph?.bbox).toEqual({ x: 45, y: 95, width: 340, height: 100 });
    expect(first.block?.language).toBe('eng');
  });

  it('keeps one shared block and paragraph object for lines of the same group', () => {
    expect(second.block).toBe(first.block);
    expect(second.paragraph).toBe(first.paragraph);
  });

  it('halves the baseline points', () => {
    expect(first.baseline).toEqual({ x0: 50, y0: 124, x1: 350, y1: 126 });
    expect(second.baseline).toEqual({ x0: 50, y0: 174, x1: 350, y1: 176 });
  });

  it('halves the row height, ascenders and descenders', () => {
    expect(first.rowHeight).toBe(20);
    expect(first.ascenders).toBe(7);
    expect(first.descenders).toBe(5);
  });

  it('halves the line and word boxes and reports the source page size', () => {
    expect(first.bbox).toEqual({ x: 50, y: 100, width: 300, height: 30 });
    expect(first.words[0].bbox).toEqual({ x: 50, y: 100, width: 100, height: 30 });
    expect([mapped.imageWidth, mapped.imageHeight]).toEqual([500, 400]);
  });
});
