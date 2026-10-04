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

    it('treats stroke-width 0 as no stroke', () => {
      expect(() => encodeEmf(svgDoc('<line x1="0" y1="5" x2="10" y2="5" stroke="#000" stroke-width="0"/>'))).toThrow(
        CadGeometryUnavailableError
      );
    });
  });
});
