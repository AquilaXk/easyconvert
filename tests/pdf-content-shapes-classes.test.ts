import { describe, expect, it } from 'vitest';
import { CLOSE, CURVE_TO, LINE_TO, MOVE_TO, ShapeCollector, type ShapeState, type Subpath } from '../src/lib/conversions/pdf-content-shapes';

/**
 * What the shape collector makes of a subpath: `paint_path` of pdfminer.six (src/lib/conversions/pdfminer-paint-path.ts) sorts it into a
 * line, a rectangle or a curve, and the collector draws a rectangle as a `rect` shape, a curve as a `path` shape and leaves a line to the
 * rules. The page is 100 by 100 points and the viewport flips its y axis, as pdf.js's does.
 */

const viewport = { width: 100, height: 100, convertToViewportPoint: (x: number, y: number): [number, number] => [x, 100 - y] };
const state: ShapeState = { ctm: [1, 0, 0, 1, 0, 0], fill: 0x336699, stroke: 0x112233, lineWidth: 1, fillAlpha: 1 };

/** A subpath from segments written as `[code, ...coordinates]`. */
function subpath(...segments: number[][]): Subpath {
  const points = segments.filter((s) => s[0] !== CLOSE).map((s) => ({ x: s[s.length - 2], y: s[s.length - 1] }));
  return { points, closed: segments.some((s) => s[0] === CLOSE), segments: segments.flat(), curved: segments.some((s) => s[0] === CURVE_TO) };
}

function shapesOf(paths: Subpath[], paint = { fill: true, stroke: false }) {
  const collector = new ShapeCollector(viewport);
  const drawn = collector.paint(paths, paint, state, 0);
  return { shapes: collector.shapes, drawn };
}

describe('the shapes of the subpaths pdfminer.six sorts', () => {
  const square = subpath([MOVE_TO, 10, 10], [LINE_TO, 40, 10], [LINE_TO, 40, 40], [LINE_TO, 10, 40], [CLOSE]);

  it('draws a closed square as a rectangle with the fill it is painted with', () => {
    const { shapes, drawn } = shapesOf([square]);
    expect(shapes).toMatchObject([{ kind: 'rect', x0: 10, y0: 60, x1: 40, y1: 90, fill: 0x336699 }]);
    expect(drawn).toEqual({ fill: [true], stroke: [false] });
  });

  it('leaves a line to the rules, painted or not', () => {
    const line = subpath([MOVE_TO, 10, 10], [LINE_TO, 90, 10]);
    expect(shapesOf([line], { fill: false, stroke: true })).toEqual({ shapes: [], drawn: { fill: [false], stroke: [false] } });
  });

  it('draws a quadrilateral with one slanted side as a path shape (pdfminer.six: a curve)', () => {
    const slanted = subpath([MOVE_TO, 10, 10], [LINE_TO, 40, 10], [LINE_TO, 40, 30], [LINE_TO, 10, 40], [CLOSE]);
    const { shapes } = shapesOf([slanted]);
    expect(shapes).toMatchObject([{ kind: 'path', fill: 0x336699, path: [MOVE_TO, 10, 90, LINE_TO, 40, 90, LINE_TO, 40, 70, LINE_TO, 10, 60, CLOSE] }]);
  });

  it('draws a stroked curve as a path shape that carries its stroke', () => {
    const arc = subpath([MOVE_TO, 10, 10], [CURVE_TO, 20, 30, 30, 30, 40, 10]);
    const { shapes, drawn } = shapesOf([arc], { fill: false, stroke: true });
    expect(shapes).toMatchObject([{ kind: 'path', stroke: 0x112233, strokeWidth: 1 }]);
    expect(drawn).toEqual({ fill: [false], stroke: [true] });
  });
});
