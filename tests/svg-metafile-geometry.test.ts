import { describe, it, expect } from 'vitest';
import { encodeEmf, encodeWmf, encodeCgm } from '../src/lib/conversions/vector-metafile';
import { CadGeometryUnavailableError, ConversionFailedError, UnsupportedOptionError } from '../src/lib/types';
import { convertFile } from '../src/lib/conversions';
import { parseEmfBinary, playbackEmf, playbackWmf, parseClearTextCgm, parseCgmPoints, parseCgmPolygonSet, type PlaybackShape } from './helpers/metafile-oracle';

function svgDoc(body: string, rootAttrs = 'width="100" height="100" viewBox="0 0 100 100"'): Buffer {
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" ${rootAttrs}>${body}</svg>`, 'utf-8');
}

function emfShapes(body: string, rootAttrs?: string): PlaybackShape[] {
  return playbackEmf(encodeEmf(svgDoc(body, rootAttrs)));
}

function wmfShapes(body: string, rootAttrs?: string): PlaybackShape[] {
  return playbackWmf(encodeWmf(svgDoc(body, rootAttrs)));
}

/** Distinct ring vertices, dropping a repeated closing point. */
function corners(ring: { x: number; y: number }[]): [number, number][] {
  const pts = ring.map((p) => [Math.round(p.x), Math.round(p.y)] as [number, number]);
  const last = pts[pts.length - 1];
  if (pts.length > 1 && last[0] === pts[0][0] && last[1] === pts[0][1]) pts.pop();
  return pts;
}

function filledShapes(shapes: PlaybackShape[]): PlaybackShape[] {
  return shapes.filter((s) => s.kind === 'polygon' && s.brush !== null);
}

describe('SVG document model for metafile encoders', () => {
  describe('style cascade and inheritance', () => {
    it('lets style="" declarations override presentation attributes', () => {
      const shapes = emfShapes('<rect x="10" y="10" width="20" height="20" fill="red" style="fill: #0000ff"/>');
      expect(filledShapes(shapes).map((s) => s.brush)).toEqual([0x0000ff]);
    });

    it('inherits fill, stroke and stroke-width from <g> ancestors', () => {
      const shapes = emfShapes(
        '<g fill="#ff0000" stroke="#00ff00" stroke-width="3"><g><rect x="10" y="10" width="20" height="20"/></g></g>'
      );
      const strokedOrFilled = shapes.filter((s) => s.brush !== null || s.pen !== null);
      expect(strokedOrFilled.some((s) => s.brush === 0xff0000)).toBe(true);
      expect(strokedOrFilled.some((s) => s.pen?.color === 0x00ff00 && s.pen.width === 3)).toBe(true);
    });

    it('lets a child override an inherited value', () => {
      const shapes = wmfShapes('<g fill="#ff0000"><rect x="10" y="10" width="20" height="20" fill="#123456"/></g>');
      expect(filledShapes(shapes).map((s) => s.brush)).toEqual([0x123456]);
    });

    it('skips display="none" subtrees and non-rendered <defs> content', () => {
      const shapes = emfShapes(
        '<defs><rect x="0" y="0" width="50" height="50" fill="#ff0000"/></defs>' +
          '<g display="none"><rect x="0" y="0" width="50" height="50" fill="#00ff00"/></g>' +
          '<rect x="60" y="60" width="10" height="10" fill="#0000ff"/>'
      );
      expect(filledShapes(shapes).map((s) => s.brush)).toEqual([0x0000ff]);
    });
  });

  describe('transforms', () => {
    const cases: [string, string, [number, number][]][] = [
      [
        'translate on <g> composed with scale on the shape',
        '<g transform="translate(10,20)"><rect x="0" y="0" width="10" height="10" transform="scale(2)"/></g>',
        [[10, 20], [30, 20], [30, 40], [10, 40]],
      ],
      [
        'translate then rotate(90)',
        '<rect x="0" y="0" width="10" height="5" transform="translate(50 50) rotate(90)"/>',
        [[50, 50], [50, 60], [45, 60], [45, 50]],
      ],
      [
        'rotate about a centre point',
        '<rect x="50" y="50" width="10" height="5" transform="rotate(90, 50, 50)"/>',
        [[50, 50], [50, 60], [45, 60], [45, 50]],
      ],
      [
        'matrix()',
        '<rect x="0" y="0" width="10" height="10" transform="matrix(2 0 0 3 5 7)"/>',
        [[5, 7], [25, 7], [25, 37], [5, 37]],
      ],
      [
        'skewX(45)',
        '<rect x="0" y="0" width="10" height="10" transform="translate(20,20) skewX(45)"/>',
        [[20, 20], [30, 20], [40, 30], [30, 30]],
      ],
      [
        'skewY(45)',
        '<rect x="0" y="0" width="10" height="10" transform="translate(20,20) skewY(45)"/>',
        [[20, 20], [30, 30], [30, 40], [20, 30]],
      ],
    ];

    for (const [label, body, expected] of cases) {
      it(`applies ${label} in EMF and WMF output`, () => {
        for (const shapes of [emfShapes(body), wmfShapes(body)]) {
          const filled = filledShapes(shapes);
          expect(filled).toHaveLength(1);
          expect(corners(filled[0].rings[0])).toEqual(expected);
        }
      });
    }

    it('applies transforms to CGM geometry', () => {
      const cgm = parseClearTextCgm(
        encodeCgm(svgDoc('<rect x="0" y="0" width="10" height="10" transform="translate(30 40) scale(2)" fill="#000"/>')).toString('utf-8')
      );
      const polygons = cgm.body
        .filter((e) => e.name === 'POLYGON' || e.name === 'POLYGONSET')
        .map((e) => parseCgmPoints(e.params.replace(/\b(CLOSE)?(VIS|INVIS)\b/g, '')));
      expect(polygons.map((p) => corners(p))).toContainEqual([[30, 40], [50, 40], [50, 60], [30, 60]]);
    });

    it('rejects a malformed transform instead of dropping it', () => {
      const bad = svgDoc('<rect x="0" y="0" width="10" height="10" transform="translate(10"/>');
      expect(() => encodeEmf(bad)).toThrow(CadGeometryUnavailableError);
      expect(() => encodeEmf(bad)).toThrow(/translate\(10/);
    });
  });

  describe('viewport', () => {
    function emfFor(rootAttrs: string, body: string) {
      const buf = encodeEmf(svgDoc(body, rootAttrs));
      return { header: parseEmfBinary(buf).header, shapes: playbackEmf(buf) };
    }

    it('derives the viewBox from width/height when none is given', () => {
      const { header, shapes } = emfFor('width="200" height="100"', '<rect x="150" y="50" width="40" height="40" fill="#000"/>');
      expect([header.bounds.right, header.bounds.bottom]).toEqual([200, 100]);
      expect(corners(filledShapes(shapes)[0].rings[0])).toEqual([[150, 50], [190, 50], [190, 90], [150, 90]]);
    });

    it('converts absolute length units to CSS pixels (96 per inch)', () => {
      const { header, shapes } = emfFor('width="2in" height="25.4mm"', '<rect x="0" y="0" width="192" height="96" fill="#000"/>');
      expect([header.bounds.right, header.bounds.bottom]).toEqual([192, 96]);
      // 2in x 25.4mm = 50.8mm x 25.4mm frame, in 0.01 mm
      expect([header.frame.right, header.frame.bottom]).toEqual([5080, 2540]);
      expect(corners(filledShapes(shapes)[0].rings[0])).toEqual([[0, 0], [192, 0], [192, 96], [0, 96]]);
    });

    it('uses the viewBox size when width/height are absent or relative', () => {
      for (const attrs of ['viewBox="0 0 300 150"', 'viewBox="0 0 300 150" width="100%" height="100%"']) {
        const { header } = emfFor(attrs, '<rect x="0" y="0" width="10" height="10" fill="#000"/>');
        expect([header.bounds.right, header.bounds.bottom]).toEqual([300, 150]);
      }
    });

    it('falls back to 800x600 only when neither viewBox nor width/height is given', () => {
      const { header, shapes } = emfFor('', '<rect x="700" y="500" width="50" height="50" fill="#000"/>');
      expect([header.bounds.right, header.bounds.bottom]).toEqual([800, 600]);
      expect(corners(filledShapes(shapes)[0].rings[0])).toEqual([[700, 500], [750, 500], [750, 550], [700, 550]]);
    });

    it('fits a viewBox of different aspect ratio with uniform scale, centred (xMidYMid meet)', () => {
      const { shapes } = emfFor('width="200" height="100" viewBox="0 0 100 100"', '<rect x="0" y="0" width="100" height="100" fill="#000"/>');
      expect(corners(filledShapes(shapes)[0].rings[0])).toEqual([[50, 0], [150, 0], [150, 100], [50, 100]]);
    });

    it('stretches non-uniformly when preserveAspectRatio="none"', () => {
      const { shapes } = emfFor(
        'width="200" height="100" viewBox="0 0 100 100" preserveAspectRatio="none"',
        '<rect x="0" y="0" width="100" height="100" fill="#000"/>'
      );
      expect(corners(filledShapes(shapes)[0].rings[0])).toEqual([[0, 0], [200, 0], [200, 100], [0, 100]]);
    });
  });

  describe('paint resolution', () => {
    function brushOf(fill: string, extra = ''): (number | null)[] {
      return emfShapes(`<rect x="10" y="10" width="20" height="20" fill="${fill}" ${extra}/>`)
        .filter((s) => s.kind === 'polygon')
        .map((s) => s.brush);
    }

    // Values from the CSS Color 4 named-colour table, authored independently of the encoder.
    const namedSamples: [string, number][] = [
      ['aliceblue', 0xf0f8ff],
      ['cornflowerblue', 0x6495ed],
      ['darkolivegreen', 0x556b2f],
      ['gainsboro', 0xdcdcdc],
      ['lightgoldenrodyellow', 0xfafad2],
      ['mediumspringgreen', 0x00fa9a],
      ['navajowhite', 0xffdead],
      ['papayawhip', 0xffefd5],
      ['rebeccapurple', 0x663399],
      ['ReBeCcAPurple', 0x663399],
      ['tomato', 0xff6347],
      ['yellowgreen', 0x9acd32],
    ];
    for (const [name, rgb] of namedSamples) {
      it(`resolves the named colour ${name}`, () => {
        expect(brushOf(name)).toEqual([rgb]);
      });
    }

    const functional: [string, number][] = [
      ['#0f8', 0x00ff88],
      ['#00FF88', 0x00ff88],
      ['#0f8f', 0x00ff88],
      ['rgb(10, 20, 30)', 0x0a141e],
      ['rgb(10 20 30)', 0x0a141e],
      ['rgb(100%, 0%, 50%)', 0xff0080],
      ['rgba(255, 0, 0, 1)', 0xff0000],
      ['hsl(120, 100%, 50%)', 0x00ff00],
      ['hsl(240deg 100% 50%)', 0x0000ff],
      ['hsl(0, 100%, 25%)', 0x800000],
      ['hsl(0.5turn, 100%, 50%)', 0x00ffff],
    ];
    for (const [value, rgb] of functional) {
      it(`resolves ${value}`, () => {
        expect(brushOf(value)).toEqual([rgb]);
      });
    }

    it('resolves currentColor from the inherited color property, initially black', () => {
      const shapes = emfShapes(
        '<g color="#ff8800"><rect x="0" y="0" width="10" height="10" fill="currentColor"/></g>' +
          '<rect x="20" y="0" width="10" height="10" fill="currentColor"/>'
      );
      expect(filledShapes(shapes).map((s) => s.brush)).toEqual([0xff8800, 0x000000]);
    });

    it('rejects url() paint servers with a typed error naming the value', async () => {
      const svg = svgDoc('<rect x="0" y="0" width="10" height="10" fill="url(#grad)"/>');
      expect(() => encodeEmf(svg)).toThrow(UnsupportedOptionError);
      expect(() => encodeWmf(svg)).toThrow(/url\(#grad\)/);
      await expect(convertFile(svg, 'svg', 'cgm', {}, 'g.svg')).rejects.toBeInstanceOf(ConversionFailedError);
    });

    it('rejects semi-transparent colours instead of dropping the alpha', () => {
      expect(() => encodeEmf(svgDoc('<rect x="0" y="0" width="10" height="10" fill="rgba(255,0,0,0.5)"/>'))).toThrow(
        UnsupportedOptionError
      );
    });

    it('treats an invalid fill as black and an invalid stroke as none', () => {
      const shapes = emfShapes('<rect x="0" y="0" width="10" height="10" fill="notacolor" stroke="alsobad"/>');
      expect(shapes.filter((s) => s.kind === 'polygon').map((s) => s.brush)).toEqual([0x000000]);
      expect(shapes.every((s) => s.pen === null)).toBe(true);
    });

    it('treats transparent and none as no paint', () => {
      const shapes = emfShapes(
        '<rect x="0" y="0" width="10" height="10" fill="transparent" stroke="#ff0000"/>' +
          '<rect x="20" y="0" width="10" height="10" fill="none" stroke="#00ff00"/>'
      );
      expect(shapes.every((s) => s.brush === null)).toBe(true);
      expect(shapes.map((s) => s.pen?.color)).toEqual([0xff0000, 0x00ff00]);
    });
  });

  describe('fill geometry', () => {
    const OUTER = 'M0 0 H100 V100 H0 Z';
    const INNER_REVERSED = 'M25 25 V75 H75 V25 Z';
    const INNER_SAME = 'M25 25 H75 V75 H25 Z';

    function cgmBody(body: string) {
      return parseClearTextCgm(encodeCgm(svgDoc(body)).toString('utf-8')).body;
    }

    it('fills open sub-paths, closing them implicitly', () => {
      for (const body of ['<path d="M10 10 L50 10 L50 50" fill="#ff0000"/>', '<polyline points="10,10 50,10 50,50" fill="#ff0000"/>']) {
        for (const shapes of [emfShapes(body), wmfShapes(body)]) {
          const filled = filledShapes(shapes);
          expect(filled.map((s) => s.brush)).toEqual([0xff0000]);
          expect(corners(filled[0].rings[0])).toEqual([[10, 10], [50, 10], [50, 50]]);
        }
        const polygons = cgmBody(body).filter((e) => e.name === 'POLYGON').map((e) => corners(parseCgmPoints(e.params)));
        expect(polygons).toEqual([[[10, 10], [50, 10], [50, 50]]]);
      }
    });

    it('emits a multi-ring path as one even-odd shape so holes stay holes', () => {
      const body = `<path fill-rule="evenodd" d="${OUTER} ${INNER_SAME}" fill="#0000ff"/>`;
      for (const shapes of [emfShapes(body), wmfShapes(body)]) {
        const filled = filledShapes(shapes);
        expect(filled).toHaveLength(1);
        expect(filled[0].fillMode).toBe(1); // ALTERNATE
        expect(filled[0].rings.map(corners)).toEqual([
          [[0, 0], [100, 0], [100, 100], [0, 100]],
          [[25, 25], [75, 25], [75, 75], [25, 75]],
        ]);
      }
      const sets = cgmBody(body).filter((e) => e.name === 'POLYGONSET');
      expect(sets).toHaveLength(1);
      expect(parseCgmPolygonSet(sets[0].params).map(corners)).toEqual([
        [[0, 0], [100, 0], [100, 100], [0, 100]],
        [[25, 25], [75, 25], [75, 75], [25, 75]],
      ]);
    });

    it('uses WINDING for fill-rule nonzero, inherited from a group', () => {
      const body = `<g fill-rule="nonzero"><path d="${OUTER} ${INNER_SAME}" fill="#0000ff"/></g>`;
      for (const shapes of [emfShapes(body), wmfShapes(body)]) {
        const filled = filledShapes(shapes);
        expect(filled).toHaveLength(1);
        expect(filled[0].fillMode).toBe(2);
        expect(filled[0].rings).toHaveLength(2);
      }
    });

    it('switches the polygon fill mode between shapes with different fill rules', () => {
      const body =
        `<path fill-rule="evenodd" d="${OUTER}" fill="#0000ff"/>` + `<path d="${OUTER}" fill="#00ff00"/>`;
      for (const shapes of [emfShapes(body), wmfShapes(body)]) {
        expect(filledShapes(shapes).map((s) => s.fillMode)).toEqual([1, 2]);
      }
    });

    it('accepts nonzero in CGM when even-odd gives the same result (opposite inner orientation)', () => {
      const sets = cgmBody(`<path d="${OUTER} ${INNER_REVERSED}" fill="#0000ff"/>`).filter((e) => e.name === 'POLYGONSET');
      expect(sets).toHaveLength(1);
      expect(parseCgmPolygonSet(sets[0].params)).toHaveLength(2);
    });

    it('rejects nonzero in CGM when even-odd would open a hole that nonzero fills', () => {
      const same = svgDoc(`<path d="${OUTER} ${INNER_SAME}" fill="#0000ff"/>`);
      expect(() => encodeCgm(same)).toThrow(CadGeometryUnavailableError);
      expect(() => encodeCgm(same)).toThrow(/nonzero/);
      const star = svgDoc('<polygon points="50,0 79,90 2,35 98,35 21,90" fill="#000"/>');
      expect(() => encodeCgm(star)).toThrow(/nonzero/);
      expect(() => encodeCgm(svgDoc('<polygon fill-rule="evenodd" points="50,0 79,90 2,35 98,35 21,90" fill="#000"/>'))).not.toThrow();
    });

    it('strokes every sub-path of a filled multi-ring path', () => {
      const shapes = emfShapes(`<path fill-rule="evenodd" d="${OUTER} ${INNER_SAME}" fill="#0000ff" stroke="#ff0000"/>`);
      const stroked = shapes.filter((s) => s.pen?.color === 0xff0000);
      const strokedRings = stroked.flatMap((s) => s.rings);
      expect(strokedRings).toHaveLength(2);
    });

    it('treats a shape with neither visible fill nor stroke as no drawable geometry', () => {
      expect(() => encodeEmf(svgDoc('<line x1="0" y1="0" x2="10" y2="10"/>'))).toThrow(CadGeometryUnavailableError);
    });
  });

  describe('stroke width', () => {
    function penWidths(body: string, rootAttrs?: string): number[] {
      return [emfShapes(body, rootAttrs), wmfShapes(body, rootAttrs)].map((shapes) => {
        const pens = shapes.filter((s) => s.pen !== null).map((s) => s.pen!.width);
        expect(new Set(pens).size).toBe(1);
        return pens[0];
      });
    }

    it('scales stroke widths by the viewBox-to-device scale', () => {
      expect(penWidths('<line x1="0" y1="5" x2="10" y2="5" stroke="#000" stroke-width="1"/>', 'width="100" height="100" viewBox="0 0 10 10"')).toEqual([10, 10]);
    });

    it('scales stroke widths by element transforms', () => {
      expect(penWidths('<g transform="scale(2)"><line x1="0" y1="5" x2="10" y2="5" stroke="#000" stroke-width="3"/></g>')).toEqual([6, 6]);
    });

    it('writes CGM line widths in VDC units (LINEWIDTHMODE ABS)', () => {
      const doc = parseClearTextCgm(
        encodeCgm(svgDoc('<line x1="0" y1="5" x2="10" y2="5" stroke="#000" stroke-width="1"/>', 'width="100" height="100" viewBox="0 0 10 10"')).toString('utf-8')
      );
      expect(doc.elements.find((e) => e.name === 'LINEWIDTHMODE')?.params).toBe('ABS');
      expect(doc.body.filter((e) => e.name === 'LINEWIDTH').map((e) => Number(e.params))).toEqual([10]);
    });

    it('treats stroke-width 0 as no stroke', () => {
      expect(() => encodeEmf(svgDoc('<line x1="0" y1="5" x2="10" y2="5" stroke="#000" stroke-width="0"/>'))).toThrow(
        CadGeometryUnavailableError
      );
    });
  });

  describe('16-bit coordinate range', () => {
    const BIG_ROOT = 'width="40000" height="20000"';
    const BIG_RECT = '<rect x="30000" y="10000" width="5000" height="5000" fill="#ff0000" stroke="#0000ff" stroke-width="100"/>';
    const EXPECTED = [[30000, 10000], [35000, 10000], [35000, 15000], [30000, 15000]];
    const TOLERANCE_PX = 2;

    function expectCornersNear(actual: [number, number][], expected: number[][]) {
      expect(actual).toHaveLength(expected.length);
      actual.forEach(([x, y], i) => {
        expect(Math.abs(x - expected[i][0])).toBeLessThanOrEqual(TOLERANCE_PX);
        expect(Math.abs(y - expected[i][1])).toBeLessThanOrEqual(TOLERANCE_PX);
      });
    }

    it('scales the EMF logical space uniformly instead of clamping, keeping the frame size', () => {
      const buf = encodeEmf(svgDoc(BIG_RECT, BIG_ROOT));
      const header = parseEmfBinary(buf).header;
      expect([header.bounds.right, header.bounds.bottom]).toEqual([40000, 20000]);
      expect(header.frame.right).toBe(Math.round((40000 * 2540) / 96));
      const filled = filledShapes(playbackEmf(buf));
      expectCornersNear(corners(filled[0].rings[0]), EXPECTED);
      expect(Math.abs(filled[0].pen!.width - 100)).toBeLessThanOrEqual(TOLERANCE_PX);
    });

    it('scales the WMF logical space via the placeable header units per inch', () => {
      const buf = encodeWmf(svgDoc(BIG_RECT, BIG_ROOT));
      const inch = buf.readUInt16LE(14);
      expect(inch).toBeLessThan(96);
      // Physical size is preserved: bbox / inch = 40000 px / 96 DPI
      expect(Math.abs(buf.readInt16LE(10) / inch - 40000 / 96)).toBeLessThan(0.02);
      const filled = filledShapes(playbackWmf(buf));
      expectCornersNear(corners(filled[0].rings[0]), EXPECTED);
      expect(Math.abs(filled[0].pen!.width - 100)).toBeLessThanOrEqual(TOLERANCE_PX);
    });

    it('scales CGM VDC coordinates into the 16-bit integer range', () => {
      const doc = parseClearTextCgm(encodeCgm(svgDoc(BIG_RECT, BIG_ROOT)).toString('utf-8'));
      const [lowerLeft, upperRight] = doc.vdcExtent;
      expect(lowerLeft.x).toBe(0);
      expect(upperRight.y).toBe(0);
      expect(upperRight.x).toBeLessThanOrEqual(32767);
      const scale = upperRight.x / 40000;
      expect(Math.abs(lowerLeft.y - 20000 * scale)).toBeLessThanOrEqual(1);
      const polygon = doc.body.find((e) => e.name === 'POLYGON')!;
      const pts = parseCgmPoints(polygon.params).map((p) => [Math.round(p.x / scale), Math.round(p.y / scale)] as [number, number]);
      expectCornersNear(corners(pts.map(([x, y]) => ({ x, y }))), EXPECTED);
    });

    it('keeps far off-canvas geometry in place rather than clamping it', () => {
      const shapes = emfShapes('<rect x="-50000" y="10" width="10" height="10" fill="#000"/><rect x="10" y="10" width="10" height="10" fill="#000"/>');
      expectCornersNear(corners(filledShapes(shapes)[0].rings[0]), [[-50000, 10], [-49990, 10], [-49990, 20], [-50000, 20]]);
    });

    it('rejects coordinates too large to represent with a typed error', () => {
      expect(() => encodeWmf(svgDoc('<rect x="0" y="0" width="1e9" height="10" fill="#000"/>'))).toThrow(CadGeometryUnavailableError);
    });
  });

  describe('path and shape fidelity', () => {
    it('rejects malformed path data with a typed error instead of looping or dropping it', () => {
      for (const d of ['M 10', 'M 10 10 L 20', '10 10 L 20 20', 'M 0 0 L 10 x']) {
        expect(() => encodeEmf(svgDoc(`<path d="${d}" stroke="#000"/>`)), d).toThrow(CadGeometryUnavailableError);
      }
    });

    it('continues from the sub-path start after Z without a new moveto', () => {
      const ring = filledShapes(emfShapes('<path d="M10 10 H50 V50 Z L 10 90 H 30 Z" fill="#000"/>'))[0].rings;
      expect(ring.map(corners)).toEqual([
        [[10, 10], [50, 10], [50, 50]],
        [[10, 10], [10, 90], [30, 90]],
      ]);
    });

    function strokePoints(body: string): { x: number; y: number }[] {
      return emfShapes(body).filter((s) => s.pen !== null).flatMap((s) => s.rings.flat());
    }

    it('draws smooth quadratic T segments instead of dropping them', () => {
      const pts = strokePoints('<path d="M10 10 Q 30 0 50 10 T 90 10" fill="none" stroke="#000"/>');
      expect(pts[pts.length - 1]).toEqual({ x: 90, y: 10 });
      // T reflects the control point (30,0) to (70,20): the second arc bulges downwards
      expect(Math.max(...pts.filter((p) => p.x > 60 && p.x < 80).map((p) => p.y))).toBeGreaterThan(12);
    });

    it('reflects the S control point only after a cubic segment', () => {
      // After Q the first S control point equals the current point (10,50); curve midpoint is (21.25, 31.25)
      const pts = strokePoints('<path d="M0 50 Q 5 0 10 50 S 30 0 40 50" fill="none" stroke="#000"/>');
      const nearest = Math.min(...pts.map((p) => Math.hypot(p.x - 21.25, p.y - 31.25)));
      expect(nearest).toBeLessThan(1.5);
    });

    it('rounds rect corners given rx/ry', () => {
      const ring = filledShapes(emfShapes('<rect x="0" y="0" width="40" height="40" rx="10" fill="#000"/>'))[0].rings[0];
      expect(ring.length).toBeGreaterThan(8);
      expect(ring.some((p) => p.x === 0 && p.y === 0)).toBe(false);
      // Straight edges start and end one radius away from each corner
      for (const [x, y] of [[10, 0], [30, 0], [40, 10], [40, 30], [30, 40], [10, 40], [0, 30], [0, 10]]) {
        expect(ring.some((p) => p.x === x && p.y === y), `vertex (${x},${y})`).toBe(true);
      }
    });
  });

  describe('unsupported content fails closed', () => {
    const RECT = '<rect x="0" y="0" width="10" height="10" fill="#000"/>';
    const unsupportedElements: [string, string][] = [
      ['text', '<text x="10" y="10">label</text>'],
      ['tspan', '<g><tspan>label</tspan></g>'],
      ['textPath', '<textPath href="#p">label</textPath>'],
      ['image', '<image href="data:image/png;base64,AAAA" width="10" height="10"/>'],
      ['foreignObject', '<foreignObject width="10" height="10"></foreignObject>'],
      ['switch', '<switch><rect width="5" height="5"/></switch>'],
      ['unknownElement', '<unknownElement/>'],
    ];
    for (const [name, markup] of unsupportedElements) {
      it(`rejects <${name}> with a typed error naming the element`, () => {
        for (const encode of [encodeEmf, encodeWmf, encodeCgm]) {
          const err = (() => {
            try {
              encode(svgDoc(RECT + markup));
              return null;
            } catch (e) {
              return e;
            }
          })();
          expect(err).toBeInstanceOf(UnsupportedOptionError);
          expect((err as Error).message).toContain(`<${name}>`);
        }
      });
    }

    const unsupportedReferences: [string, string][] = [
      ['clip-path', '<rect x="0" y="0" width="10" height="10" clip-path="url(#c)"/>'],
      ['mask', '<g mask="url(#m)">' + RECT + '</g>'],
      ['filter', '<rect x="0" y="0" width="10" height="10" style="filter: url(#f)"/>'],
      ['marker-end', '<line x1="0" y1="0" x2="10" y2="10" stroke="#000" marker-end="url(#a)"/>'],
    ];
    for (const [property, markup] of unsupportedReferences) {
      it(`rejects ${property} references with a typed error naming the property`, async () => {
        const svg = svgDoc(markup);
        expect(() => encodeEmf(svg)).toThrow(UnsupportedOptionError);
        expect(() => encodeEmf(svg)).toThrow(new RegExp(property));
        await expect(convertFile(svg, 'svg', 'wmf', {}, 'r.svg')).rejects.toBeInstanceOf(ConversionFailedError);
      });
    }

    it('accepts non-rendering defs, title, desc, metadata, style and editor namespaces', () => {
      const shapes = emfShapes(
        '<title>t</title><desc>d</desc><metadata><x/></metadata><style></style>' +
          '<defs><clipPath id="c"><rect width="1" height="1"/></clipPath><linearGradient id="g"><stop offset="0"/></linearGradient>' +
          '<filter id="f"><feGaussianBlur stdDeviation="1"/></filter><pattern id="p" width="1" height="1"><text>x</text></pattern></defs>' +
          '<sodipodi:namedview id="nv"/>' +
          '<rect x="10" y="10" width="20" height="20" fill="#00ff00"/>'
      );
      expect(filledShapes(shapes).map((s) => s.brush)).toEqual([0x00ff00]);
    });

    it('rejects mismatched closing tags instead of guessing the tree', () => {
      expect(() => encodeEmf(svgDoc('<g><rect width="5" height="5"/></rect></g>'))).toThrow(CadGeometryUnavailableError);
    });
  });

  describe('<use> references', () => {
    const SQUARE_DEF = '<defs><rect id="sq" x="0" y="0" width="10" height="10"/></defs>';

    it('instantiates a referenced shape with x/y translation and inherited style', () => {
      for (const shapes of [
        emfShapes(SQUARE_DEF + '<use href="#sq" x="20" y="30" fill="#ff0000"/>'),
        wmfShapes(SQUARE_DEF + '<use xlink:href="#sq" x="20" y="30" fill="#ff0000"/>', 'xmlns:xlink="http://www.w3.org/1999/xlink" width="100" height="100"'),
      ]) {
        const filled = filledShapes(shapes);
        expect(filled.map((s) => s.brush)).toEqual([0xff0000]);
        expect(corners(filled[0].rings[0])).toEqual([[20, 30], [30, 30], [30, 40], [20, 40]]);
      }
    });

    it('applies the use transform before x/y and the referenced element transform', () => {
      const shapes = emfShapes(
        '<defs><rect id="r" x="0" y="0" width="10" height="5" transform="scale(2)"/></defs>' +
          '<use href="#r" x="5" y="0" transform="translate(10 10)"/>'
      );
      expect(corners(filledShapes(shapes)[0].rings[0])).toEqual([[15, 10], [35, 10], [35, 20], [15, 20]]);
    });

    it('instantiates groups, nested uses and forward references, keeping the referenced element styles', () => {
      const shapes = emfShapes(
        '<use href="#pair" x="50" y="0"/>' +
          '<defs><g id="pair" fill="#0000ff"><rect x="0" y="0" width="5" height="5"/><use href="#dot" x="10"/></g>' +
          '<rect id="dot" x="0" y="0" width="5" height="5" fill="#00ff00"/></defs>'
      );
      const filled = filledShapes(shapes);
      expect(filled.map((s) => s.brush)).toEqual([0x0000ff, 0x00ff00]);
      expect(filled.map((s) => corners(s.rings[0])[0])).toEqual([[50, 0], [60, 0]]);
    });

    it('renders a referenced element that is itself visible in the tree twice', () => {
      const shapes = emfShapes('<rect id="a" x="0" y="0" width="5" height="5" fill="#000"/><use href="#a" x="10"/>');
      expect(filledShapes(shapes).map((s) => corners(s.rings[0])[0])).toEqual([[0, 0], [10, 0]]);
    });

    const failures: [string, string, RegExp][] = [
      ['a self reference', '<g id="loop"><use href="#loop"/></g>', /cycle/i],
      ['a reference cycle', '<defs><g id="a"><use href="#b"/></g><g id="b"><use href="#a"/></g></defs><use href="#a"/>', /cycle/i],
      ['a missing target', '<use href="#nope"/>', /#nope/],
      ['an external reference', '<use href="other.svg#shape"/>', /other\.svg#shape/],
      ['a use without href', '<use x="5"/>', /href/],
    ];
    for (const [label, body, message] of failures) {
      it(`fails closed with a typed error on ${label}`, () => {
        expect(() => encodeEmf(svgDoc(body))).toThrow(ConversionFailedError);
        expect(() => encodeEmf(svgDoc(body))).toThrow(message);
      });
    }

    it('caps exponential <use> expansion with a typed error', () => {
      let defs = '<rect id="l0" width="1" height="1"/>';
      for (let k = 1; k <= 20; k++) defs += `<g id="l${k}"><use href="#l${k - 1}"/><use href="#l${k - 1}"/></g>`;
      expect(() => encodeEmf(svgDoc(`<defs>${defs}</defs><use href="#l20"/>`))).toThrow(CadGeometryUnavailableError);
    });

    it('rejects references to non-rendering resources', () => {
      expect(() => encodeEmf(svgDoc('<defs><linearGradient id="g"/></defs><use href="#g"/>'))).toThrow(UnsupportedOptionError);
    });
  });

  describe('<style> stylesheets', () => {
    function brushes(css: string, body: string): (number | null)[] {
      return filledShapes(emfShapes(`<style>${css}</style>${body}`)).map((s) => s.brush);
    }
    const R = (attrs: string) => `<rect x="0" y="0" width="10" height="10" ${attrs}/>`;

    it('applies type, class, id, compound and comma-list selectors', () => {
      expect(brushes('rect { fill: #111111 }', R(''))).toEqual([0x111111]);
      expect(brushes('.a { fill: #ff0000 }', R('class="b a"'))).toEqual([0xff0000]);
      expect(brushes('#x { fill: #00ff00 }', R('id="x"'))).toEqual([0x00ff00]);
      expect(brushes('rect.a#x { fill: #0000ff }', R('id="x" class="a"') + R('class="a"'))).toEqual([0x0000ff, 0x000000]);
      expect(brushes('.p, .q { fill: #123456 }', R('class="p"') + R('class="q"'))).toEqual([0x123456, 0x123456]);
    });

    it('orders by specificity, then source order', () => {
      expect(brushes('#x { fill: #00ff00 } .a { fill: #ff0000 } rect { fill: #0000ff }', R('id="x" class="a"'))).toEqual([0x00ff00]);
      expect(brushes('.a { fill: #ff0000 } .b { fill: #0000ff }', R('class="a b"'))).toEqual([0x0000ff]);
    });

    it('sits above presentation attributes and below inline style, honouring !important', () => {
      expect(brushes('.a { fill: #ff0000 }', R('class="a" fill="#0000ff"'))).toEqual([0xff0000]);
      expect(brushes('.a { fill: #ff0000 }', R('class="a" style="fill: #0000ff"'))).toEqual([0x0000ff]);
      expect(brushes('.a { fill: #ff0000 !important }', R('class="a" style="fill: #0000ff"'))).toEqual([0xff0000]);
      expect(brushes('#x { fill: #00ff00 } .a { fill: #ff0000 !important }', R('id="x" class="a"'))).toEqual([0xff0000]);
    });

    it('inherits stylesheet values through groups and reads CDATA and comments', () => {
      expect(brushes('<![CDATA[ /* theme */ .g { fill: #abcdef; stroke: none } ]]>', `<g class="g">${R('')}</g>`)).toEqual([0xabcdef]);
      expect(brushes('', R('fill="#010203"'))).toEqual([0x010203]);
    });

    const rejected = ['g rect { fill: red }', 'g > rect { fill: red }', 'a + b { fill: red }', 'a ~ b { fill: red }', 'rect:hover { fill: red }',
      'rect::before { fill: red }', '[fill] { fill: red }', '@media print { rect { fill: red } }', '@import url(x.css);', '@font-face { font-family: x }',
      '.a { clip-path: url(#c) }'];
    for (const css of rejected) {
      it(`rejects the stylesheet rule "${css}" with a typed error naming it`, () => {
        const svg = svgDoc(`<style>${css}</style>${R('class="a"')}`);
        expect(() => encodeEmf(svg)).toThrow(UnsupportedOptionError);
        const head = css.split('{')[0].trim().split(' ')[0];
        expect(() => encodeEmf(svg)).toThrow(head);
      });
    }
  });
});
