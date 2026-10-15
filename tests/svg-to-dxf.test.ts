import { describe, expect, it } from 'vitest';
import { convertFile } from '../src/lib/conversions';
import { convertVectorCad, svgToDxf } from '../src/lib/conversions/vector-cad';
import { CadGeometryUnavailableError, ConversionFailedError } from '../src/lib/types';
import { readDxf, type DxfEntityRecord } from './helpers/dxf-reader';

/**
 * SVG to DXF draws what the SVG draws, in DXF's upward Y axis, and nothing else. The DXF is read back with the
 * hand-written reader of tests/helpers/dxf-reader.ts (a stream of group-code pairs), never by the writer.
 */

const PAGE = 200;
const wrap = (body: string) => `<svg xmlns="http://www.w3.org/2000/svg" width="${PAGE}" height="${PAGE}">${body}</svg>`;
/** SVG y (down) to DXF y (up) on a page PAGE tall. */
const up = (y: number) => PAGE - y;

function polygonArea(points: Array<{ x: number; y: number }>): number {
  let twiceArea = 0;
  points.forEach((point, index) => {
    const next = points[(index + 1) % points.length];
    twiceArea += point.x * next.y - next.x * point.y;
  });
  return Math.abs(twiceArea) / 2;
}

describe('svgToDxf', () => {
  it('writes a line at its position with Y pointing up', () => {
    const { entities } = readDxf(svgToDxf(wrap('<line x1="10" y1="10" x2="100" y2="100" />')));
    expect(entities).toEqual<DxfEntityRecord[]>([
      { type: 'LINE', layer: '0', closed: false, points: [{ x: 10, y: up(10), z: 0 }, { x: 100, y: up(100), z: 0 }] },
    ]);
  });

  it('applies the transforms of the element and of its groups', () => {
    const svg = wrap(
      '<g transform="translate(100, 50)"><g transform="scale(2)"><line x1="0" y1="0" x2="10" y2="5" transform="translate(1 1)" /></g></g>'
    );
    // The line's own translate(1 1) comes first, then scale(2), then translate(100, 50): (0,0) -> (1,1) -> (2,2) -> (102,52).
    const { entities } = readDxf(svgToDxf(svg));
    expect(entities).toHaveLength(1);
    expect(entities[0].points.map(({ x, y }) => [x, y])).toEqual([
      [102, up(52)],
      [122, up(62)],
    ]);
  });

  it('writes a rectangle as a closed outline with its four corners', () => {
    const { entities } = readDxf(svgToDxf(wrap('<rect x="20" y="30" width="60" height="40" />')));
    expect(entities).toHaveLength(1);
    expect(entities[0].type).toBe('POLYLINE');
    expect(entities[0].closed).toBe(true);
    const corners = entities[0].points.map(({ x, y }) => [x, y]);
    expect(corners).toHaveLength(4);
    expect(new Set(corners.map((corner) => corner.join(',')))).toEqual(
      new Set([`20,${up(30)}`, `80,${up(30)}`, `80,${up(70)}`, `20,${up(70)}`])
    );
  });

  it('writes a circle as an outline whose vertices lie on the circle and whose area is its area', () => {
    const { entities } = readDxf(svgToDxf(wrap('<circle cx="50" cy="60" r="30" />')));
    expect(entities).toHaveLength(1);
    expect(entities[0].closed).toBe(true);
    const points = entities[0].points;
    for (const point of points) expect(Math.hypot(point.x - 50, point.y - up(60))).toBeCloseTo(30, 3);
    // A polygon inscribed in the circle with this many vertices holds nearly all of pi r^2.
    expect(polygonArea(points) / (Math.PI * 30 * 30)).toBeGreaterThan(0.99);
    expect(polygonArea(points)).toBeLessThanOrEqual(Math.PI * 30 * 30);
  });

  it('writes a path with curves as the flattened outline from its start to its end', () => {
    const { entities } = readDxf(svgToDxf(wrap('<path d="M 10 10 C 20 20, 40 20, 50 10" fill="none" />')));
    expect(entities).toHaveLength(1);
    const points = entities[0].points;
    expect([points[0].x, points[0].y]).toEqual([10, up(10)]);
    expect([points[points.length - 1].x, points[points.length - 1].y]).toEqual([50, up(10)]);
    expect(points.length).toBeGreaterThan(3);
    // The cubic's highest point is at t = 1/2: y = 10 * 1/8 + 20 * 3/8 + 20 * 3/8 + 10 * 1/8 = 17.5 (SVG y down).
    expect(Math.max(...points.map((point) => up(point.y)))).toBeCloseTo(17.5, 1);
  });

  it('refuses a drawing without geometry instead of inventing a line', () => {
    for (const empty of [wrap(''), wrap('<rect width="0" height="0" />')]) {
      expect(() => svgToDxf(empty)).toThrow(ConversionFailedError);
      expect(() => svgToDxf(empty)).toThrow(/draws no vector geometry/);
    }
    expect(() => svgToDxf('not an svg at all')).toThrow(/not an SVG document/);
  });

  it('refuses text, which has no outline in the drawing, with the reason', () => {
    const textOnly = wrap('<g><text x="5" y="5">no outline</text></g>');
    expect(() => svgToDxf(textOnly)).toThrow(ConversionFailedError);
    expect(() => svgToDxf(textOnly)).toThrow(/^The page cannot be written as DXF: /);
  });

  it('is what convertFile returns for svg to dxf, and refuses the empty drawing there too', async () => {
    const svg = wrap('<line x1="0" y1="0" x2="50" y2="0" />');
    const converted = await convertFile(Buffer.from(svg), 'svg', 'dxf', {}, 'plan.svg');
    expect(converted.filename).toBe('plan.dxf');
    expect(converted.buffer.toString('utf-8')).toBe(svgToDxf(svg));
    await expect(convertFile(Buffer.from(wrap('')), 'svg', 'dxf', {}, 'empty.svg')).rejects.toThrow(/draws no vector geometry/);
  });

  it('reports the missing DWG encoder with a typed error', async () => {
    const failure = await convertVectorCad(Buffer.from(wrap('<line x1="0" y1="0" x2="5" y2="5" />')), 'svg', 'dwg', {}, 'plan.svg').catch(
      (err: unknown) => err
    );
    expect(failure).toBeInstanceOf(CadGeometryUnavailableError);
    expect((failure as Error).message).toBe('Unsupported CAD format: DWG binary encoder unavailable');
  });
});
