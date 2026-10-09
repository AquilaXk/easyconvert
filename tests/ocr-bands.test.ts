import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import {
  measureInk,
  mergeBandReadings,
  OCR_BAND_MAX_BANDS,
  planBands,
  sliceNetpbmRows,
  type OcrBand,
} from '../src/lib/conversions/ocr-bands';
import { ocrBandsAllowedFor } from '../src/lib/conversions/ocr-config';
import { preprocessOcrImage } from '../src/lib/conversions/ocr-preprocess';
import { encodePbm, encodePgm } from '../src/lib/conversions/pnm';
import { decodePnm, pnmGray } from './helpers/pnm-decode';
import { OcrPreprocessError } from '../src/lib/types';

/**
 * Cutting a page into bands. The pages here are drawn from rectangles whose rows are known, so every expected cut
 * row is worked out from the drawing and not from the code under test.
 */

const PAPER = 255;
const INK = 0;
const LINE_HEIGHT = 20;
const LINE_PITCH = 40;
const FIRST_LINE_TOP = 20;

interface Rect {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

function draw(width: number, height: number, rects: readonly Rect[]): Uint8Array {
  const gray = new Uint8Array(width * height).fill(PAPER);
  for (const r of rects) {
    for (let y = r.y0; y < r.y1; y++) gray.fill(INK, y * width + r.x0, y * width + r.x1);
  }
  return gray;
}

/** `count` text lines, each a solid bar LINE_HEIGHT rows tall, one every LINE_PITCH rows. */
function lineBars(count: number, x0 = 40, x1 = 560, extraGapAfter: ReadonlyMap<number, number> = new Map()): Rect[] {
  const bars: Rect[] = [];
  let top = FIRST_LINE_TOP;
  for (let i = 0; i < count; i++) {
    bars.push({ x0, x1, y0: top, y1: top + LINE_HEIGHT });
    top += LINE_PITCH + (extraGapAfter.get(i) ?? 0);
  }
  return bars;
}

function pageOf(rects: readonly Rect[], width = 600): { gray: Uint8Array; width: number; height: number } {
  const height = Math.max(...rects.map((r) => r.y1)) + FIRST_LINE_TOP;
  return { gray: draw(width, height, rects), width, height };
}

function plan(rects: readonly Rect[], maxBands: number, width = 600, lineHeight: number | null = LINE_HEIGHT): OcrBand[] | null {
  const page = pageOf(rects, width);
  return planBands(measureInk(page.gray, page.width, page.height), lineHeight, maxBands);
}

describe('measureInk', () => {
  it('counts the dark pixels of every row and column', () => {
    const width = 7;
    const gray = draw(width, 4, [
      { x0: 1, x1: 4, y0: 1, y1: 3 },
      { x0: 6, x1: 7, y0: 0, y1: 1 },
    ]);
    const ink = measureInk(gray, width, 4);
    expect(Array.from(ink.rows)).toEqual([1, 3, 3, 0]);
    expect(Array.from(ink.columns)).toEqual([0, 2, 2, 2, 0, 0, 1]);
  });

  it('rejects a buffer that does not fit the stated size', () => {
    expect(() => measureInk(new Uint8Array(5), 3, 2)).toThrow(OcrPreprocessError);
  });
});

describe('planBands', () => {
  // Nine bars: bar i spans rows [20 + 40i, 40 + 40i).
  const nine = lineBars(9);

  it('cuts in the middle of the gap between the lines that balance the bands', () => {
    // Three bands of three lines: after bar 2 (ends row 120, next starts 140) and after bar 5 (ends 240, next 260).
    const bands = plan(nine, 4);
    const height = FIRST_LINE_TOP + 8 * LINE_PITCH + LINE_HEIGHT + FIRST_LINE_TOP;
    expect(bands).toEqual([
      { top: 0, bottom: 130, paragraphBreakAfter: false },
      { top: 130, bottom: 250, paragraphBreakAfter: false },
      { top: 250, bottom: height, paragraphBreakAfter: false },
    ]);
  });

  it('uses as few bands as it is allowed', () => {
    // Two bands: round(9 / 2) = 5 lines above the cut, which falls between bar 4 (ends 200) and bar 5 (starts 220).
    const bands = plan(nine, 2);
    expect(bands?.map((band) => [band.top, band.bottom])).toEqual([
      [0, 210],
      [210, 380],
    ]);
  });

  it(`never makes more than ${OCR_BAND_MAX_BANDS} bands`, () => {
    expect(plan(lineBars(30), 64)).toHaveLength(OCR_BAND_MAX_BANDS);
  });

  it('keeps every band at three lines or more', () => {
    expect(plan(lineBars(5), 4)).toBeNull();
    expect(plan(lineBars(6), 4)).toHaveLength(2);
  });

  it('reads a page whole when there is nothing to cut, or no measure of its lines', () => {
    expect(plan(nine, 1)).toBeNull();
    expect(plan(nine, 4, 600, null)).toBeNull();
    expect(plan(nine, 4, 600, 0)).toBeNull();
  });

  it('reads a page with a gap between columns whole, and cuts one whose lines only have word gaps', () => {
    const twoColumns = lineBars(9, 40, 270).concat(lineBars(9, 330, 560));
    expect(plan(twoColumns, 4)).toBeNull();
    const wordGap = 12;
    const withWordGaps = lineBars(9, 40, 290).concat(lineBars(9, 290 + wordGap, 560));
    expect(plan(withWordGaps, 4)).toHaveLength(3);
  });

  it('does not cut between the dot and the stem of a line', () => {
    // Each line is a 3 row dot, 2 blank rows, then a 15 row body: the blank rows are not a gap between lines.
    const rects: Rect[] = [];
    for (let i = 0; i < 9; i++) {
      const top = FIRST_LINE_TOP + i * LINE_PITCH;
      rects.push({ x0: 40, x1: 560, y0: top, y1: top + 3 }, { x0: 40, x1: 560, y0: top + 5, y1: top + 20 });
    }
    const bands = plan(rects, 4);
    expect(bands).toHaveLength(3);
    for (const band of bands ?? []) {
      for (let i = 0; i < 9; i++) {
        const top = FIRST_LINE_TOP + i * LINE_PITCH;
        const insideLine = band.top > top && band.top < top + 20;
        expect(insideLine).toBe(false);
      }
    }
  });

  it('ignores a stray speck in a gap between lines', () => {
    const rects = lineBars(9).concat([{ x0: 100, x1: 101, y0: 125, y1: 126 }]);
    // 2000 wide: a row with two dark pixels or fewer is blank.
    const bands = plan(rects, 4, 2000);
    expect(bands?.map((band) => band.bottom)).toContain(130);
  });

  it('marks the cut that falls in a gap wider than a paragraph gap', () => {
    // The gap after bar 2 is 20 + 60 rows, the others 20: the median is 20, so a gap over 30 starts a paragraph.
    const bands = plan(lineBars(9, 40, 560, new Map([[2, 60]])), 4);
    expect(bands?.map((band) => band.paragraphBreakAfter)).toEqual([true, false, false]);
  });
});

describe('sliceNetpbmRows', () => {
  const width = 13;
  const height = 6;
  const pixels = Uint8Array.from({ length: width * height }, (_, i) => (i * 37) % 256);

  it('cuts rows out of a gray page as a gray page of their own', () => {
    const page = encodePgm(pixels, width, height);
    expect(sliceNetpbmRows(page, 2, 5).equals(encodePgm(pixels.subarray(2 * width, 5 * width), width, 3))).toBe(true);
  });

  it('cuts rows out of a bitonal page, whose rows are padded to whole bytes', () => {
    const bitonal = Uint8Array.from(pixels, (v) => (v < 128 ? 0 : 255));
    const page = encodePbm(bitonal, width, height);
    expect(sliceNetpbmRows(page, 1, 4).equals(encodePbm(bitonal.subarray(width, 4 * width), width, 3))).toBe(true);
  });

  it('refuses rows outside the page and data that is not a Netpbm page', () => {
    const page = encodePgm(pixels, width, height);
    expect(() => sliceNetpbmRows(page, 3, 7)).toThrow(OcrPreprocessError);
    expect(() => sliceNetpbmRows(page, 4, 4)).toThrow(OcrPreprocessError);
    expect(() => sliceNetpbmRows(Buffer.from('not a page'), 0, 1)).toThrow(OcrPreprocessError);
  });
});

describe('mergeBandReadings', () => {
  const word = (y0: number, y1: number) => ({
    text: 'w',
    bbox: { x0: 1, y0, x1: 9, y1 },
    symbols: [{ bbox: { x0: 1, y0, x1: 4, y1 } }],
  });
  const tree = (y0: number, y1: number) => [
    {
      bbox: { x0: 0, y0, x1: 10, y1 },
      paragraphs: [
        {
          bbox: { x0: 0, y0, x1: 10, y1 },
          lines: [{ bbox: { x0: 0, y0, x1: 10, y1 }, baseline: { x0: 0, y0: y1 - 2, x1: 10, y1: y1 - 2 }, words: [word(y0, y1)] }],
        },
      ],
    },
  ];
  const bands: OcrBand[] = [
    { top: 0, bottom: 100, paragraphBreakAfter: false },
    { top: 100, bottom: 200, paragraphBreakAfter: true },
    { top: 200, bottom: 300, paragraphBreakAfter: false },
  ];

  it('moves every box of a band down by the band top and joins the texts by the kind of cut', () => {
    const merged = mergeBandReadings(bands, [
      { text: 'a\nb\n\n', blocks: tree(5, 25) },
      { text: ' c\nd', blocks: tree(5, 25) },
      { text: 'e', blocks: tree(40, 60) },
    ]);
    expect(merged.text).toBe('a\nb\nc\nd\n\ne');
    const blocks = merged.blocks as ReturnType<typeof tree>;
    expect(blocks.map((block) => [block.bbox.y0, block.bbox.y1])).toEqual([
      [5, 25],
      [105, 125],
      [240, 260],
    ]);
    const third = blocks[2].paragraphs[0].lines[0];
    expect(third.baseline).toEqual({ x0: 0, y0: 258, x1: 10, y1: 258 });
    expect(third.words[0].bbox).toEqual({ x0: 1, y0: 240, x1: 9, y1: 260 });
    expect(third.words[0].symbols[0].bbox).toEqual({ x0: 1, y0: 240, x1: 4, y1: 260 });
  });

  it('skips the separator for a band that read nothing and tolerates a band without blocks', () => {
    const merged = mergeBandReadings(bands, [
      { text: 'a', blocks: tree(5, 25) },
      { text: '   ', blocks: null },
      { text: 'b', blocks: undefined },
    ]);
    expect(merged.text).toBe('a\n\nb');
    expect(merged.blocks).toHaveLength(1);
  });

  it('refuses readings that do not match the bands', () => {
    expect(() => mergeBandReadings(bands, [{ text: 'a', blocks: [] }])).toThrow(OcrPreprocessError);
  });
});

describe('ocrBandsAllowedFor', () => {
  it.each(['eng', 'eng+deu', 'fra', 'vie'])('allows the left-to-right Latin set %s', (languages) => {
    expect(ocrBandsAllowedFor(languages)).toBe(true);
  });

  it.each(['kor', 'jpn', 'chi_sim', 'eng+kor', 'jpn_vert', 'ara', 'rus', 'ell', 'not_a_language'])(
    'reads %s whole: its layout analysis needs the whole page',
    (languages) => {
      expect(ocrBandsAllowedFor(languages)).toBe(false);
    }
  );
});

describe('the ink profile of a prepared page', () => {
  const scan = fs.readFileSync(path.join(__dirname, '..', 'bench', 'corpus', 'scan.png'));

  it('is measured on the pixels handed to the recognizer, and cuts the scan into bands of whole lines', async () => {
    const prepared = await preprocessOcrImage(scan);
    const page = pnmGray(decodePnm(prepared.image));
    const [width, height] = [prepared.geometry.outputWidth, prepared.geometry.outputHeight];
    expect(prepared.ink?.profile.width).toBe(width);
    expect(prepared.ink?.profile.height).toBe(height);
    let dark = 0;
    for (const value of page) if (value < 128) dark++;
    expect(prepared.ink?.profile.rows.reduce((sum, count) => sum + count, 0)).toBe(dark);
    const bands = planBands(prepared.ink!.profile, prepared.ink!.lineHeightPx, OCR_BAND_MAX_BANDS);
    expect(bands).toHaveLength(3);
    // Every cut row is blank across the whole width.
    for (const band of (bands ?? []).slice(1)) {
      expect(prepared.ink?.profile.rows[band.top]).toBe(0);
    }
  });

  it('is left out for a colour page, which has no single gray level to measure', async () => {
    const colour = await sharp(scan).tint({ r: 255, g: 220, b: 220 }).png().toBuffer();
    expect((await preprocessOcrImage(colour, { rescale: false, deskew: false, binarize: false })).ink).toBeUndefined();
  });
});
