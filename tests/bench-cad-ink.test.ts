import { describe, expect, it } from 'vitest';
import { type CadTruth, scoreInk } from '../bench/cad-ink';
import type { Raster } from '../bench/vector-raster';

/**
 * The geometric score of a rendered CAD drawing (bench/cad-ink.ts): a drawing that is the truth in another page, scale and
 * line weight scores 1; a missing entity costs recall, a stray mark costs precision, a stretched or mirrored page shows
 * in the extent error. The rasters are drawn here from the truth with a plain line brush, not by any converter.
 */

const TRUTH: CadTruth = {
  strokes: [
    [[0, 0], [100, 0], [100, 60], [0, 60], [0, 0]],
    [[20, 30], [80, 30]],
    [[50, 10], [50, 50]],
    [[60, 45], [90, 55]],
    Array.from({ length: 73 }, (_, i): [number, number] => [50 + 12 * Math.cos((i * 5 * Math.PI) / 180), 30 + 12 * Math.sin((i * 5 * Math.PI) / 180)]),
  ],
  textBoxes: [[10, 40, 40, 52]],
  words: [],
};

interface Frame {
  width: number;
  height: number;
  scaleX: number;
  scaleY: number;
  left: number;
  top: number;
  brush: number;
  flipY?: boolean;
  skip?: (index: number) => boolean;
  extra?: Array<[number, number, number, number]>;
  colour?: [number, number, number];
  /** Page colour; white when absent. */
  background?: [number, number, number];
}

function draw(frame: Frame): Raster {
  const rgb = Buffer.alloc(frame.width * frame.height * 3, 255);
  if (frame.background) for (let i = 0; i < frame.width * frame.height; i++) rgb.set(frame.background, i * 3);
  const dot = (x: number, y: number, colour: [number, number, number]): void => {
    for (let dy = -frame.brush; dy <= frame.brush; dy++) {
      for (let dx = -frame.brush; dx <= frame.brush; dx++) {
        const px = Math.round(x) + dx;
        const py = Math.round(y) + dy;
        if (px < 0 || py < 0 || px >= frame.width || py >= frame.height) continue;
        rgb.set(colour, (py * frame.width + px) * 3);
      }
    }
  };
  const line = (x0: number, y0: number, x1: number, y1: number, colour: [number, number, number]): void => {
    const steps = Math.ceil(Math.hypot(x1 - x0, y1 - y0));
    for (let s = 0; s <= steps; s++) dot(x0 + ((x1 - x0) * s) / steps, y0 + ((y1 - y0) * s) / steps, colour);
  };
  const toPixel = (x: number, y: number): [number, number] => [frame.left + x * frame.scaleX, frame.top + (frame.flipY ? y : 60 - y) * frame.scaleY];
  const colour = frame.colour ?? [0, 0, 0];
  TRUTH.strokes.forEach((stroke, index) => {
    if (frame.skip?.(index)) return;
    for (let i = 1; i < stroke.length; i++) {
      const [x0, y0] = toPixel(...stroke[i - 1]);
      const [x1, y1] = toPixel(...stroke[i]);
      line(x0, y0, x1, y1, colour);
    }
  });
  for (const [x0, y0, x1, y1] of frame.extra ?? []) line(x0, y0, x1, y1, colour);
  return { width: frame.width, height: frame.height, rgb };
}

const SAME: Frame = { width: 700, height: 500, scaleX: 5, scaleY: 5, left: 100, top: 80, brush: 1 };

describe('scoreInk', () => {
  it('scores the truth itself, in any page position, scale and line weight, as complete', () => {
    for (const frame of [SAME, { ...SAME, width: 1400, height: 900, scaleX: 10, scaleY: 10, left: 300, top: 200, brush: 3 }, { ...SAME, colour: [255, 255, 0] as [number, number, number] }]) {
      const score = scoreInk(draw(frame), TRUTH);
      expect(score.recall).toBeGreaterThan(0.99);
      expect(score.precision).toBeGreaterThan(0.99);
      expect(score.extentError).toBeLessThan(0.02);
    }
  });

  it('loses recall for an outline that is not drawn, and no precision', () => {
    const score = scoreInk(draw({ ...SAME, skip: (index) => index === 4 }), TRUTH);
    expect(score.recall).toBeLessThan(0.9);
    expect(score.recall).toBeGreaterThan(0.6);
    expect(score.precision).toBeGreaterThan(0.99);
  });

  it('loses precision for marks that are not in the truth, and no recall', () => {
    const score = scoreInk(draw({ ...SAME, extra: [[150, 120, 520, 120], [150, 160, 520, 360], [200, 140, 200, 360]] }), TRUTH);
    expect(score.precision).toBeLessThan(0.9);
    expect(score.recall).toBeGreaterThan(0.99);
  });

  it('does not count ink inside the text boxes against precision', () => {
    const inText = [[100 + 15 * 5, 80 + (60 - 46) * 5, 100 + 35 * 5, 80 + (60 - 46) * 5]] as Array<[number, number, number, number]>;
    expect(scoreInk(draw({ ...SAME, extra: inText }), TRUTH).precision).toBeGreaterThan(0.99);
  });

  it('shows a stretched drawing in the extent error', () => {
    const score = scoreInk(draw({ ...SAME, scaleX: 5, scaleY: 8, height: 700 }), TRUTH);
    expect(score.extentError).toBeGreaterThan(0.3);
  });

  it('loses both recall and precision for a mirrored drawing, by the strokes that are not symmetric', () => {
    const score = scoreInk(draw({ ...SAME, flipY: true }), TRUTH);
    expect(score.recall).toBeLessThan(0.97);
    expect(score.precision).toBeLessThan(0.97);
  });

  it('scores a blank page as nothing drawn', () => {
    expect(scoreInk({ width: 50, height: 50, rgb: Buffer.alloc(50 * 50 * 3, 255) }, TRUTH)).toEqual({ precision: 0, recall: 0, extentError: 1 });
  });

  it('scores the same drawing alike in any palette, because ink is whatever differs from the page', () => {
    const reference = scoreInk(draw(SAME), TRUTH);
    const palettes: Array<Pick<Frame, 'colour' | 'background'>> = [
      { colour: [92, 107, 192] },
      { colour: [31, 35, 64] },
      { colour: [200, 40, 40] },
      { colour: [20, 160, 60] },
      { colour: [255, 255, 255], background: [0, 0, 0] },
      { colour: [250, 220, 40], background: [30, 30, 40] },
    ];
    for (const palette of palettes) {
      const score = scoreInk(draw({ ...SAME, ...palette }), TRUTH);
      expect(score.recall).toBeCloseTo(reference.recall, 2);
      expect(score.precision).toBeCloseTo(reference.precision, 2);
      expect(score.extentError).toBeCloseTo(reference.extentError, 2);
    }
  });

  it('still loses recall for a missing outline and precision for stray marks when the drawing is recoloured', () => {
    for (const palette of [{ colour: [92, 107, 192] as [number, number, number] }, { colour: [255, 255, 255] as [number, number, number], background: [0, 0, 0] as [number, number, number] }]) {
      const missing = scoreInk(draw({ ...SAME, ...palette, skip: (index) => index === 4 }), TRUTH);
      expect(missing.recall).toBeLessThan(0.9);
      expect(missing.recall).toBeGreaterThan(0.6);
      expect(missing.precision).toBeGreaterThan(0.99);
      const stray = scoreInk(draw({ ...SAME, ...palette, extra: [[150, 120, 520, 120], [150, 160, 520, 360], [200, 140, 200, 360]] }), TRUTH);
      expect(stray.precision).toBeLessThan(0.9);
      expect(stray.recall).toBeGreaterThan(0.99);
    }
  });

  it('finds the drawing when text of the same colour lies outside the strokes, because the frame is fitted to the strokes and not to all ink', () => {
    const base = draw(SAME);
    // Text above and below the drawing, drawn like the strokes: the box of all ink is 40% taller than the box of the strokes.
    for (const [top, bottom] of [[20, 70], [470, 495]]) {
      for (let y = top; y <= bottom; y++) {
        for (let x = 300; x <= 520; x += 3) base.rgb.set([0, 0, 0], (y * base.width + x) * 3);
      }
    }
    // The truth knows that text is there: in drawing units, above (y 61 to 70) and below (y -24 to -17) the strokes.
    const withText: CadTruth = { ...TRUTH, textBoxes: [...TRUTH.textBoxes, [40, 61, 100, 70], [40, -24, 100, -17]] };
    const score = scoreInk(base, withText);
    expect(score.recall).toBeGreaterThan(0.99);
    expect(score.precision).toBeGreaterThan(0.99);
    expect(score.extentError).toBeLessThan(0.02);
  });

  it('finds the drawing when a mark that is not in the truth stretches the box of all ink, and charges that mark to precision only', () => {
    const score = scoreInk(draw({ ...SAME, width: 900, extra: [[640, 250, 760, 250]] }), TRUTH);
    expect(score.recall).toBeGreaterThan(0.99);
    expect(score.extentError).toBeLessThan(0.02);
    expect(score.precision).toBeLessThan(0.98);
    expect(score.precision).toBeGreaterThan(0.85);
  });

  it('counts ink on a truth stroke inside a text box as drawn, and leaves other ink in the text box out of the share', () => {
    const everywhere: CadTruth = { ...TRUTH, textBoxes: [[0, 0, 100, 60]] };
    expect(scoreInk(draw(SAME), everywhere).precision).toBeGreaterThan(0.99);
    const withMark = draw({ ...SAME, extra: [[300, 200, 400, 210]] });
    expect(scoreInk(withMark, everywhere).precision).toBeGreaterThan(0.99);
  });
});
