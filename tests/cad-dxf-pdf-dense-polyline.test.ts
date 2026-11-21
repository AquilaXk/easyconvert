import zlib from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { renderDxfDrawingToPdf, type DxfDrawing } from '../src/lib/conversions/cad-dxf';

/**
 * A spline or a hatch reaches the PDF writer as a polyline of tens of thousands of points, far denser than the page can show: the page is 576 points
 * long, so a drawing of the size of a plate puts 200,000 points of one DWG sample within 0.003 point of each other. Every point is a `lineTo`
 * of the PDF library (115 ms of the 230 ms the sample took; docs/policy-decisions.md, entry 388). The writer keeps the points that differ at the
 * hundredth of a point, the resolution it writes them at, and the polyline keeps its first and last point.
 */

/** The page content of the first (and only) page of a PDF written with a compressed stream. */
function pageContent(pdf: Buffer): string {
  const text = pdf.toString('latin1');
  const streams: string[] = [];
  for (const match of text.matchAll(/stream\r?\n/g)) {
    const start = (match.index ?? 0) + match[0].length;
    const end = text.indexOf('endstream', start);
    try {
      streams.push(zlib.inflateSync(pdf.subarray(start, end)).toString('latin1'));
    } catch {
      // Not a deflate stream (a font program, an image): not the page.
    }
  }
  return streams.find((stream) => / l\n/.test(stream) || /\bl\b/.test(stream)) ?? '';
}

function drawingWithDensePolyline(pointCount: number): DxfDrawing {
  const points: Array<[number, number]> = [];
  for (let i = 0; i < pointCount; i++) points.push([50 + 0.0001 * Math.sin(i), 50 + 0.0001 * Math.cos(i * 0.7)]);
  return {
    strokes: [
      { kind: 'line', a: [0, 0], b: [100, 100] },
      { kind: 'poly', points, closed: false },
    ],
    texts: [],
    extents: { minX: 0, minY: 0, maxX: 100, maxY: 100 },
  };
}

function lineOperators(content: string): number {
  return content.split('\n').filter((line) => /^-?[\d.]+ -?[\d.]+ l$/.test(line)).length;
}

describe('the PDF of a drawing with a polyline denser than the page', () => {
  it('writes the points that differ at the hundredth of a point, not one per input point', async () => {
    const content = pageContent(await renderDxfDrawingToPdf(drawingWithDensePolyline(50_000)));
    expect(lineOperators(content)).toBeLessThan(1_000);
  });

  it('keeps the start and the end of the polyline and its line, with the scale of the page', async () => {
    const drawing = drawingWithDensePolyline(50_000);
    const content = pageContent(await renderDxfDrawingToPdf(drawing));
    const poly = drawing.strokes[1];
    if (poly.kind !== 'poly') throw new Error('stroke 1 is the polyline');
    const margin = 576 * 0.02;
    const scale = 576 / 100;
    const at = (p: readonly number[]): [number, number] => [margin + p[0] * scale, margin + (100 - p[1]) * scale];
    const [startX, startY] = at(poly.points[0]);
    const [endX, endY] = at(poly.points[poly.points.length - 1]);
    const round = (n: number): string => String(Math.round(n * 100) / 100);
    expect(content).toContain(`${round(startX)} ${round(startY)} m`);
    expect(content).toContain(`${round(endX)} ${round(endY)} l`);
  });

  it('writes a polyline whose points all differ as the points it was given', async () => {
    const points: Array<[number, number]> = [];
    for (let i = 0; i <= 200; i++) points.push([i * 0.5, 20 * Math.sin(i / 10) + 50]);
    const drawing: DxfDrawing = {
      strokes: [{ kind: 'poly', points, closed: false }],
      texts: [],
      extents: { minX: 0, minY: 30, maxX: 100, maxY: 70 },
    };
    const content = pageContent(await renderDxfDrawingToPdf(drawing));
    expect(lineOperators(content)).toBe(200);
  });
});
