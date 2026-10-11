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
}

function draw(frame: Frame): Raster {
  const rgb = Buffer.alloc(frame.width * frame.height * 3, 255);
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
});
