import { describe, expect, it } from 'vitest';
import { advanceUnits, placeWords } from '../src/lib/conversions/ocr-text-layer';
import type { OcrLineBlock, OcrResult, OcrWord } from '../src/lib/conversions/ocr-pdf-combiner';

/**
 * The engine's box of a word on a tilted line is the bounding box of the tilted rectangle of the word, wider along the
 * baseline than the word by the row height times sin(2 x tilt). `placeWords` writes the word as wide as the word without
 * any option (entry 371), and a level line is written as its box.
 */

const DEGREES_TO_RADIANS = Math.PI / 180;
const GLYPH_UNITS_PER_EM = 1000;
const PERCENT = 100;
const WORD_WIDTH_PX = 120;
const ROW_HEIGHT_PX = 30;
const WORDS_PER_LINE = 6;
const PAGE_SCALE = 72 / 300;
const PAGE_HEIGHT_PT = 792;

/** A line of words, each `WORD_WIDTH_PX` wide and `ROW_HEIGHT_PX` high, on a baseline tilted by `degrees` clockwise (y down), with the box an engine reports for each. */
function tiltedLine(degrees: number): OcrResult {
  const radians = degrees * DEGREES_TO_RADIANS;
  const [cos, sin] = [Math.cos(radians), Math.sin(radians)];
  const pitch = WORD_WIDTH_PX + 20;
  const originX = 100;
  const originY = 400;
  const words: OcrWord[] = Array.from({ length: WORDS_PER_LINE }, (_, i) => {
    // The corners of the word's rectangle: its start on the baseline, up the row height, along the word.
    const startX = originX + i * pitch * cos;
    const startY = originY + i * pitch * sin;
    const corners = [
      [startX, startY],
      [startX + WORD_WIDTH_PX * cos, startY + WORD_WIDTH_PX * sin],
      [startX + ROW_HEIGHT_PX * sin, startY - ROW_HEIGHT_PX * cos],
      [startX + WORD_WIDTH_PX * cos + ROW_HEIGHT_PX * sin, startY + WORD_WIDTH_PX * sin - ROW_HEIGHT_PX * cos],
    ];
    const xs = corners.map((corner) => corner[0]);
    const ys = corners.map((corner) => corner[1]);
    return { text: 'quarterly', bbox: { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) } };
  });
  const block: OcrLineBlock = {
    text: words.map((word) => word.text).join(' '),
    bbox: words[0].bbox,
    words,
    baseline: { x0: originX, y0: originY, x1: originX + WORDS_PER_LINE * pitch * cos, y1: originY + WORDS_PER_LINE * pitch * sin },
    rowHeight: ROW_HEIGHT_PX,
  };
  return { text: block.text, lineBlocks: [block], imageWidth: 1000, imageHeight: 800 } as OcrResult;
}

/** The length of a placed word along its baseline, in points. */
function lengthOf(word: { text: string; fontSize: number; horizontalScaling: number }): number {
  return (advanceUnits(word.text) / GLYPH_UNITS_PER_EM) * word.fontSize * (word.horizontalScaling / PERCENT);
}

describe('placeWords on a tilted line, with no option', () => {
  it.each([-10, -5, -3, -1, 1, 3, 5, 10])('writes each word of a line tilted by %d degrees as wide as the word', (degrees) => {
    const placed = placeWords(tiltedLine(degrees), PAGE_SCALE, PAGE_SCALE, PAGE_HEIGHT_PT);

    expect(placed).toHaveLength(WORDS_PER_LINE);
    for (const word of placed) expect(lengthOf(word)).toBeCloseTo(WORD_WIDTH_PX * PAGE_SCALE, 3);
  });

  it('writes the words of a level line as wide as their boxes, as before', () => {
    const level = tiltedLine(0);
    const placed = placeWords(level, PAGE_SCALE, PAGE_SCALE, PAGE_HEIGHT_PT);

    expect(placed.map(lengthOf).map((length) => Number(length.toFixed(6)))).toEqual(level.lineBlocks!.flatMap((block) => block.words.map((word) => Number((word.bbox.width * PAGE_SCALE).toFixed(6)))));
  });

  it('leaves the tilt an engine measures on a level page (0.1 degrees) as the box says, wider by the row height times sin(2 x tilt)', () => {
    const extra = ROW_HEIGHT_PX * Math.sin(2 * 0.1 * DEGREES_TO_RADIANS) * PAGE_SCALE;

    for (const word of placeWords(tiltedLine(0.1), PAGE_SCALE, PAGE_SCALE, PAGE_HEIGHT_PT)) {
      expect(lengthOf(word)).toBeCloseTo(WORD_WIDTH_PX * PAGE_SCALE + extra, 3);
    }
  });

  it('corrects a tilt of 0.3 degrees', () => {
    const placed = placeWords(tiltedLine(0.3), PAGE_SCALE, PAGE_SCALE, PAGE_HEIGHT_PT);

    for (const word of placed) expect(lengthOf(word)).toBeCloseTo(WORD_WIDTH_PX * PAGE_SCALE, 3);
  });
});
