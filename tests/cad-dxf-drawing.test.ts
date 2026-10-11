import { describe, expect, it } from 'vitest';
import { dxfDrawingToSvg, parseDxfDrawing, renderDxfDrawingToPdf, type DxfStroke } from '../src/lib/conversions/cad-dxf';
import { ConversionFailedError } from '../src/lib/types';

/**
 * What a DXF reader must draw, checked against closed forms and hand-computed geometry: a circular arc runs counter-clockwise,
 * a polyline bulge is tan(sweep / 4), a clamped cubic B-spline of four control points is the cubic Bezier curve of them,
 * an ellipse satisfies its own equation, and a block is placed by insert point, scale and rotation. The DXF text is written
 * here, pair by pair, in the layout of the DXF reference.
 */

const pairs = (...items: Array<[number, string | number]>): string => `${items.map(([code, value]) => `${String(code).padStart(3, ' ')}\n${value}`).join('\n')}\n`;
const section = (name: string, body: string): string => `${pairs([0, 'SECTION'], [2, name])}${body}${pairs([0, 'ENDSEC'])}`;
const dxf = (entities: string, blocks = '', tables = ''): string => `${tables ? section('TABLES', tables) : ''}${blocks ? section('BLOCKS', blocks) : ''}${section('ENTITIES', entities)}${pairs([0, 'EOF'])}`;
const near = (actual: number, expected: number, digits = 6): void => expect(actual).toBeCloseTo(expected, digits);

const polylines = (strokes: DxfStroke[]): Array<Extract<DxfStroke, { kind: 'poly' }>> => strokes.filter((s): s is Extract<DxfStroke, { kind: 'poly' }> => s.kind === 'poly');

describe('parseDxfDrawing', () => {
  it('keeps an ARC exact, counter-clockwise from its start angle to its end angle, and wraps an end angle below the start', () => {
    const drawing = parseDxfDrawing(dxf(pairs([0, 'ARC'], [10, 5], [20, 5], [40, 10], [50, 90], [51, 180]) + pairs([0, 'ARC'], [10, 0], [20, 0], [40, 1], [50, 270], [51, 90])));
    const [quarter, half] = drawing.strokes as Array<Extract<DxfStroke, { kind: 'arc' }>>;
    expect([quarter.kind, quarter.centre, quarter.radius]).toEqual(['arc', [5, 5], 10]);
    near(quarter.start, Math.PI / 2);
    near(quarter.end, Math.PI);
    near(half.end - half.start, Math.PI);
    // The extents hold the arcs' own extremes: the quarter from (5, 15) to (-5, 5) reaches x = -5 and y = 15 only, and the
    // half circle of radius 1 from 270 to 90 degrees reaches y = -1.
    const { minX, maxX, minY, maxY } = drawing.extents;
    [minX, maxX, minY, maxY].forEach((value, i) => near(value, [-5, 5, -1, 15][i], 9));
  });

  it('draws a polyline bulge as the circular arc of sweep 4 atan(bulge): a bulge of 1 between (0,0) and (2,0) is the lower half of the unit circle about (1,0)', () => {
    const [line] = polylines(
      parseDxfDrawing(dxf(pairs([0, 'LWPOLYLINE'], [90, 2], [70, 0], [10, 0], [20, 0], [42, 1], [10, 2], [20, 0]))).strokes
    );
    expect(line.points.length).toBeGreaterThan(60);
    expect(line.points[0]).toEqual([0, 0]);
    expect(line.points[line.points.length - 1]).toEqual([2, 0]);
    for (const [x, y] of line.points) {
      near(Math.hypot(x - 1, y), 1, 6);
      expect(y).toBeLessThanOrEqual(1e-9);
    }
    expect(Math.min(...line.points.map((p) => p[1]))).toBeCloseTo(-1, 6);
  });

  it('reads an old-style POLYLINE with its VERTEX records, closed, and skips a spline frame vertex', () => {
    const body =
      pairs([0, 'POLYLINE'], [70, 1]) +
      pairs([0, 'VERTEX'], [10, 0], [20, 0]) +
      pairs([0, 'VERTEX'], [10, 4], [20, 0]) +
      pairs([0, 'VERTEX'], [10, 99], [20, 99], [70, 16]) +
      pairs([0, 'VERTEX'], [10, 4], [20, 3]) +
      pairs([0, 'SEQEND']);
    const [shape] = polylines(parseDxfDrawing(dxf(body)).strokes);
    expect(shape.closed).toBe(true);
    expect(shape.points).toEqual([[0, 0], [4, 0], [4, 3], [0, 0]]);
  });

  it('samples an ELLIPSE on its own equation, rotated by its major axis', () => {
    const [curve] = polylines(parseDxfDrawing(dxf(pairs([0, 'ELLIPSE'], [10, 10], [20, 20], [11, 0], [21, 6], [40, 0.5], [41, 0], [42, 2 * Math.PI]))).strokes);
    // Major radius 6 along +y, minor radius 3 along -x: ((x - 10) / 3)^2 + ((y - 20) / 6)^2 = 1.
    for (const [x, y] of curve.points) near(((x - 10) / 3) ** 2 + ((y - 20) / 6) ** 2, 1, 9);
    near(Math.max(...curve.points.map((p) => p[1])), 26, 3);
    near(Math.min(...curve.points.map((p) => p[0])), 7, 3);
  });

  it('evaluates a clamped cubic SPLINE of four control points as their Bezier curve, and a weighted one with the rational form', () => {
    const control: Array<[number, number]> = [[0, 0], [1, 3], [4, 3], [5, 0]];
    const spline = (weights: number[]): string =>
      pairs([0, 'SPLINE'], [70, 8], [71, 3], [72, 8], [73, 4], ...[0, 0, 0, 0, 1, 1, 1, 1].map((k): [number, number] => [40, k]), ...weights.map((w): [number, number] => [41, w])) +
      control.map(([x, y]) => pairs([10, x], [20, y], [30, 0])).join('');
    const [plain] = polylines(parseDxfDrawing(dxf(spline([]))).strokes);
    const bezier = (t: number): [number, number] => {
      const b = [(1 - t) ** 3, 3 * t * (1 - t) ** 2, 3 * t * t * (1 - t), t ** 3];
      return [b.reduce((s, w, i) => s + w * control[i][0], 0), b.reduce((s, w, i) => s + w * control[i][1], 0)];
    };
    const last = plain.points.length - 1;
    plain.points.forEach((point, i) => {
      const expected = bezier(i / last);
      near(point[0], expected[0], 6);
      near(point[1], expected[1], 6);
    });
    expect(plain.points[last]).toEqual([5, 0]);
    // With weight 4 on the second control point the curve is pulled towards it: at t = 0.5 the rational point is
    // (0 + 3 * 4 * 1 + 3 * 1 * 4 + 5) / (1 + 12 + 3 + 1) ... evaluated from the definition below.
    const [pulled] = polylines(parseDxfDrawing(dxf(spline([1, 4, 1, 1]))).strokes);
    const t = 0.5;
    const basis = [(1 - t) ** 3, 3 * t * (1 - t) ** 2, 3 * t * t * (1 - t), t ** 3];
    const w = [1, 4, 1, 1];
    const denominator = basis.reduce((s, b, i) => s + b * w[i], 0);
    const expectedY = basis.reduce((s, b, i) => s + b * w[i] * control[i][1], 0) / denominator;
    near(pulled.points[Math.floor(last / 2)][1], expectedY, 6);
    expect(expectedY).toBeGreaterThan(bezier(0.5)[1]);
  });

  describe('blocks', () => {
    const block = (name: string, body: string, base: [number, number] = [0, 0]): string =>
      pairs([0, 'BLOCK'], [2, name], [10, base[0]], [20, base[1]]) + body + pairs([0, 'ENDBLK']);
    const unitSquare = pairs([0, 'LINE'], [10, 0], [20, 0], [11, 1], [21, 0]) + pairs([0, 'CIRCLE'], [10, 0], [20, 0], [40, 1]);

    it('places a block by insert point, scale and rotation, moving a circle and an arc exactly under a uniform scale', () => {
      const insert = pairs([0, 'INSERT'], [2, 'B'], [10, 10], [20, 20], [41, 2], [42, 2], [50, 90]);
      const drawing = parseDxfDrawing(dxf(insert, block('B', unitSquare)));
      const [line, circle] = drawing.strokes;
      expect(line.kind).toBe('line');
      const placed = line as Extract<DxfStroke, { kind: 'line' }>;
      near(placed.a[0], 10);
      near(placed.a[1], 20);
      // (1, 0) scaled by 2 and rotated by 90 degrees is (0, 2), placed at (10, 20).
      near(placed.b[0], 10);
      near(placed.b[1], 22);
      expect(circle).toMatchObject({ kind: 'circle', radius: 2 });
    });

    it('subtracts the base point of the block, and rotates the cells of an array with the block', () => {
      const insert = pairs([0, 'INSERT'], [2, 'B'], [10, 0], [20, 0], [70, 2], [71, 1], [44, 10], [45, 0], [50, 90]);
      const drawing = parseDxfDrawing(dxf(insert, block('B', pairs([0, 'LINE'], [10, 5], [20, 5], [11, 6], [21, 5]), [5, 5])));
      const lines = drawing.strokes as Array<Extract<DxfStroke, { kind: 'line' }>>;
      expect(lines).toHaveLength(2);
      near(lines[0].a[0], 0);
      near(lines[0].a[1], 0);
      near(lines[0].b[0], 0);
      near(lines[0].b[1], 1);
      // The second cell is 10 units along the rotated x axis, which now points up.
      near(lines[1].a[0], 0);
      near(lines[1].a[1], 10);
    });

    it('samples a circle under a mirror or a non-uniform scale instead of drawing it as a circle', () => {
      const drawing = parseDxfDrawing(dxf(pairs([0, 'INSERT'], [2, 'B'], [41, 3], [42, 1]), block('B', pairs([0, 'CIRCLE'], [10, 0], [20, 0], [40, 1]))));
      const [shape] = polylines(drawing.strokes);
      for (const [x, y] of shape.points) near((x / 3) ** 2 + y ** 2, 1, 9);
    });

    it('draws the anonymous block a DIMENSION names, and nested blocks', () => {
      const inner = block('INNER', pairs([0, 'LINE'], [10, 0], [20, 0], [11, 1], [21, 1]));
      const outer = block('OUTER', pairs([0, 'INSERT'], [2, 'INNER'], [10, 5], [20, 0]));
      const drawing = parseDxfDrawing(dxf(pairs([0, 'INSERT'], [2, 'OUTER']) + pairs([0, 'DIMENSION'], [2, 'INNER']), inner + outer));
      const lines = drawing.strokes as Array<Extract<DxfStroke, { kind: 'line' }>>;
      expect(lines.map((line) => [line.a, line.b])).toEqual([[[5, 0], [6, 1]], [[0, 0], [1, 1]]]);
    });

    it('fails closed on a block that inserts itself, and on a block array past the limit', () => {
      const loop = block('LOOP', pairs([0, 'INSERT'], [2, 'LOOP']) + pairs([0, 'LINE'], [10, 0], [20, 0], [11, 1], [21, 1]));
      expect(() => parseDxfDrawing(dxf(pairs([0, 'INSERT'], [2, 'LOOP']), loop))).toThrow(ConversionFailedError);
      const pyramid = block('A', pairs([0, 'INSERT'], [2, 'B'], [70, 100], [71, 100]) + '') + block('B', pairs([0, 'INSERT'], [2, 'C'], [70, 100], [71, 100])) + block('C', pairs([0, 'LINE'], [10, 0], [20, 0], [11, 1], [21, 1]));
      expect(() => parseDxfDrawing(dxf(pairs([0, 'INSERT'], [2, 'A']), pyramid))).toThrow(/limit/);
    });
  });

  describe('text and layers', () => {
    it('reads TEXT with its height and rotation and MTEXT without its formatting codes, one line per \\P', () => {
      const body =
        pairs([0, 'TEXT'], [10, 1], [20, 2], [40, 5], [50, 90], [1, 'PLATE']) +
        pairs([0, 'MTEXT'], [10, 3], [20, 4], [40, 2], [71, 1], [1, '{\\fArial|b0;NOTES\\P}\\C1;ALL \\Sone^two; IN MM']);
      const { texts } = parseDxfDrawing(dxf(body + pairs([0, 'LINE'], [10, 0], [20, 0], [11, 1], [21, 1])));
      expect(texts[0]).toMatchObject({ at: [1, 2], height: 5, lines: ['PLATE'], hangsFromTop: false });
      near(texts[0].rotation, Math.PI / 2);
      expect(texts[1].lines).toEqual(['NOTES', 'ALL one/two IN MM']);
      expect(texts[1].hangsFromTop).toBe(true);
    });

    it('does not draw entities of a layer that is off or frozen', () => {
      const tables = pairs([0, 'TABLE'], [2, 'LAYER']) + pairs([0, 'LAYER'], [2, 'FROZEN'], [70, 1], [62, 7]) + pairs([0, 'LAYER'], [2, 'OFF'], [70, 0], [62, -7]) + pairs([0, 'ENDTAB']);
      const line = (layer: string): string => pairs([0, 'LINE'], [8, layer], [10, 0], [20, 0], [11, 1], [21, 1]);
      const drawing = parseDxfDrawing(dxf(line('FROZEN') + line('OFF') + line('SHOWN'), '', tables));
      expect(drawing.strokes).toHaveLength(1);
    });

    it('refuses a drawing with nothing to draw instead of inventing an extent', () => {
      expect(() => parseDxfDrawing(dxf(pairs([0, 'POINT'], [10, 1], [20, 1])))).toThrow(ConversionFailedError);
    });
  });
});

describe('the outputs of a drawing', () => {
  const drawing = parseDxfDrawing(
    dxf(pairs([0, 'ARC'], [10, 0], [20, 0], [40, 10], [50, 0], [51, 90]) + pairs([0, 'LINE'], [10, 0], [20, 0], [11, 10], [21, 0]) + pairs([0, 'TEXT'], [10, 1], [20, 1], [40, 1], [1, 'A & B']))
  );

  it('writes an arc as an SVG elliptical arc with the sweep flag that keeps it counter-clockwise on the page, in an upright view box', () => {
    const svg = dxfDrawingToSvg(drawing, 'part');
    // From (10, 0) to (0, 10) counter-clockwise: on the page (y negated) from (10, 0) to (0, -10), sweep flag 0, small arc.
    expect(svg).toContain('<path d="M 10 0 A 10 10 0 0 0 0 -10" />');
    expect(svg).toContain('<title>part</title>');
    expect(svg).toContain('>A &amp; B</text>');
    const viewBox = /viewBox="([-\d. ]+)"/.exec(svg)?.[1].split(' ').map(Number) as number[];
    expect(viewBox[0]).toBeLessThan(0);
    expect(viewBox[1]).toBeLessThan(-10);
    expect(viewBox[2]).toBeGreaterThan(10);
  });

  it('writes one vector PDF page fitted to the drawing: no title, no frame, text as text', async () => {
    const pdf = (await renderDxfDrawingToPdf(drawing)).toString('latin1');
    const box = /\/MediaBox \[0 0 ([\d.]+) ([\d.]+)\]/.exec(pdf);
    expect(box).not.toBeNull();
    // Extents 10 by 10 plus the text box on top of the arc's y range: wider than tall by no more than the text allows.
    expect(Number(box?.[1])).toBeGreaterThan(500);
    expect(pdf).not.toContain('AutoCAD Vector Plot');
    expect(pdf.match(/ re\b/g) ?? []).toHaveLength(0);
    expect(pdf).toContain('/Type /Font');
  });
});
