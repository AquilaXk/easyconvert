import { describe, expect, it } from 'vitest';
import { cutAreasAtRegion, engineWork, GRID_UNITS_PER_PIXEL, holeVertices, polygonRegion, type RegionShape } from '../src/lib/conversions/svg-clip-polygons';
import { DEFAULT_HANG_GUARD_MS, expectWithinHangGuard } from './helpers/timing';

/**
 * The cut of a filled area at a region that is not one convex polygon (policy 473): the polygons of a clip shape joined by their
 * fill rule, the area of a fill cut at them, the holes a fill can cover, and the work the clipper is charged.
 */

interface Point {
  x: number;
  y: number;
}

const box = (x0: number, y0: number, x1: number, y1: number, reversed = false): Point[] => {
  const corners = [
    { x: x0, y: y0 },
    { x: x1, y: y0 },
    { x: x1, y: y1 },
    { x: x0, y: y1 },
  ];
  return reversed ? corners.reverse() : corners;
};
const polygon = (rule: RegionShape['rule'], ...polygons: Point[][]): RegionShape => ({ rule, polygons });
const circle = (cx: number, cy: number, r: number, sides = 36): Point[] =>
  Array.from({ length: sides }, (_, i) => ({ x: cx + r * Math.cos((2 * Math.PI * i) / sides), y: cy + r * Math.sin((2 * Math.PI * i) / sides) }));
const areaOf = (ring: readonly Point[]): number => ring.reduce((total, a, i) => total + a.x * ring[(i + 1) % ring.length].y - ring[(i + 1) % ring.length].x * a.y, 0) / 2;
/** The area of what is filled: outlines positive, holes negative, as the clipper gives them. */
const filledArea = (rings: readonly (readonly Point[])[]): number => rings.reduce((total, ring) => total + areaOf(ring), 0);

describe('the region of a clip', () => {
  it('is a polygon with a hole when the second polygon lies inside the first under evenodd, or turns the other way under nonzero', () => {
    for (const shape of [polygon('evenodd', box(0, 0, 100, 100), box(20, 20, 80, 80)), polygon('nonzero', box(0, 0, 100, 100), box(20, 20, 80, 80, true))]) {
      const region = polygonRegion([shape]);
      expect(region.paths).toHaveLength(2);
      expect(filledArea(region.paths.map((path) => path.map((p) => ({ x: p.x / GRID_UNITS_PER_PIXEL, y: p.y / GRID_UNITS_PER_PIXEL }))))).toBeCloseTo(10000 - 3600, 6);
    }
  });

  it('is filled through a second polygon that turns the same way under nonzero', () => {
    const region = polygonRegion([polygon('nonzero', box(0, 0, 100, 100), box(20, 20, 80, 80))]);
    expect(region.paths).toHaveLength(1);
  });

  it('is the union of its shapes, each by its own rule, and has no hole where one shape covers the hole of another', () => {
    const frame = polygon('evenodd', box(0, 0, 100, 100), box(20, 20, 80, 80));
    const plug = polygon('nonzero', box(10, 10, 90, 90));
    expect(holeVertices(polygonRegion([frame]))).toHaveLength(1);
    expect(holeVertices(polygonRegion([frame, plug]))).toHaveLength(0);
    expect(polygonRegion([polygon('nonzero', box(0, 0, 10, 10)), polygon('nonzero', box(20, 0, 30, 10))]).paths).toHaveLength(2);
  });

  it('is empty when a clip has no shape or its shapes fill nothing', () => {
    expect(polygonRegion([]).paths).toEqual([]);
    expect(polygonRegion([polygon('nonzero')]).paths).toEqual([]);
  });

  it('has one vertex for each hole, in device pixels', () => {
    const region = polygonRegion([polygon('evenodd', box(0, 0, 100, 100), box(20, 20, 40, 40), box(60, 60, 80, 80))]);
    const holes = holeVertices(region);
    expect(holes).toHaveLength(2);
    for (const hole of holes) expect([20, 40, 60, 80]).toContain(hole.x);
  });
});

describe('a filled area cut at a region', () => {
  it('keeps the part inside a concave region as one polygon with its corners where it crosses the edges', () => {
    const lShape = polygonRegion([polygon('nonzero', [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 40 }, { x: 40, y: 40 }, { x: 40, y: 80 }, { x: 0, y: 80 }])]);
    const rings = cutAreasAtRegion(lShape, [box(10, 10, 90, 90)], 'nonzero');
    expect(rings).toHaveLength(1);
    expect(new Set(rings[0].slice(0, -1).map((p) => `${p.x},${p.y}`))).toEqual(new Set(['10,10', '90,10', '90,40', '40,40', '40,80', '10,80']));
    expect(rings[0][0]).toEqual(rings[0][rings[0].length - 1]);
  });

  it('gives a hole where the area covers a hole of the region', () => {
    const framed = polygonRegion([polygon('evenodd', box(0, 0, 100, 100), box(20, 20, 80, 80))]);
    const rings = cutAreasAtRegion(framed, [box(10, 10, 90, 90)], 'nonzero');
    expect(rings).toHaveLength(2);
    expect(filledArea(rings.map((ring) => ring.slice(0, -1)))).toBeCloseTo(6400 - 3600, 6);
  });

  it('reads the fill by its own rule: a ring drawn twice is filled by nonzero and empty by evenodd', () => {
    const everything = polygonRegion([polygon('nonzero', box(0, 0, 100, 100))]);
    const twice = [box(10, 10, 50, 50), box(10, 10, 50, 50)];
    expect(filledArea(cutAreasAtRegion(everything, twice, 'nonzero').map((ring) => ring.slice(0, -1)))).toBeCloseTo(1600, 6);
    expect(cutAreasAtRegion(everything, twice, 'evenodd')).toEqual([]);
  });

  it('keeps the winding of a self-crossing outline, so a bow tie is cut by its own rule', () => {
    const everything = polygonRegion([polygon('nonzero', box(0, 0, 100, 100))]);
    const bowTie: Point[] = [{ x: 10, y: 10 }, { x: 90, y: 90 }, { x: 90, y: 10 }, { x: 10, y: 90 }];
    const rings = cutAreasAtRegion(everything, [bowTie], 'nonzero');
    expect(rings).toHaveLength(2);
    expect(Math.abs(filledArea(rings.map((ring) => ring.slice(0, -1))))).toBeCloseTo(2 * 0.5 * 80 * 40, 6);
  });

  it('draws nothing of an area outside the region, and the whole of one inside it', () => {
    const disc = polygonRegion([polygon('nonzero', circle(50, 50, 30))]);
    expect(cutAreasAtRegion(disc, [box(200, 200, 210, 210)], 'nonzero')).toEqual([]);
    const inside = cutAreasAtRegion(disc, [box(40, 40, 60, 60)], 'nonzero');
    expect(inside).toHaveLength(1);
    expect(inside[0]).toHaveLength(5);
  });

  it('cuts a rectangle to the polygon of a curve, the area of its flattened outline', () => {
    const disc = polygonRegion([polygon('nonzero', circle(50, 50, 30))]);
    const [ring] = cutAreasAtRegion(disc, [box(0, 0, 100, 100)], 'nonzero');
    // A thousandth of a pixel of rounding on each of 36 corners moves the area by about 0.05.
    expect(Math.abs(areaOf(ring.slice(0, -1)))).toBeCloseTo(areaOf(circle(50, 50, 30)), 0);
  });

  it('keeps an area that lies on the edge of the region whole, since the same flattened curve rounds to the same units', () => {
    const outline = circle(512.123456789, 300.987654321, 100);
    const [ring] = cutAreasAtRegion(polygonRegion([polygon('nonzero', outline)]), [outline], 'nonzero');
    expect(ring).toHaveLength(outline.length + 1);
    for (const point of ring) expect(Math.round(point.x * GRID_UNITS_PER_PIXEL)).toBe(point.x * GRID_UNITS_PER_PIXEL);
  });
});

describe('the work charged for a cut', () => {
  it('is a few edge tests for a small area at a small region and grows with the edges on one scanline, not with their product', () => {
    const disc = polygonRegion([polygon('nonzero', circle(50, 50, 30))]);
    const small = engineWork(disc, [box(10, 10, 30, 30)]);
    expect(small).toBeGreaterThan(0);
    expect(small).toBeLessThan(100);
    const coast = (sides: number): Point[] =>
      Array.from({ length: sides }, (_, i) => {
        const angle = (2 * Math.PI * i) / sides;
        const radius = 40 + 10 * Math.sin(angle * 37) + Math.sin(angle * 901);
        return { x: 50 + radius * Math.cos(angle), y: 50 + radius * Math.sin(angle) };
      });
    expect(engineWork(disc, [coast(20_000)])).toBeLessThan(20_000 * 36);
  });

  it('is the product of the edges when every edge of a zigzag is on every scanline, which is where the clipper takes quadratic time', () => {
    const comb = polygonRegion([polygon('nonzero', [...Array.from({ length: 100 }, (_, i) => ({ x: i * 10, y: i % 2 === 0 ? 0 : 50 })), { x: 1000, y: -100 }, { x: 0, y: -100 }])]);
    const zigzag = (count: number): Point[] => Array.from({ length: count }, (_, i) => ({ x: (i / count) * 1000, y: i % 2 === 0 ? -40 : 90 }));
    const [few, many] = [engineWork(comb, [zigzag(1000)]), engineWork(comb, [zigzag(4000)])];
    expect(many / few).toBeGreaterThan(10);
  });

  it('stops a hostile zigzag in time: the work is large enough to be refused, and is measured without running the clipper', () => {
    const comb = polygonRegion([polygon('nonzero', box(0, 0, 100, 100))]);
    const zigzag = Array.from({ length: 400_000 }, (_, i) => ({ x: (i / 400_000) * 100, y: i % 2 === 0 ? -40 : 140 }));
    const started = performance.now();
    const work = engineWork(comb, [zigzag]);
    expectWithinHangGuard('engine work of a hostile zigzag', performance.now() - started, { guardMs: DEFAULT_HANG_GUARD_MS, expectedLocalMs: 300 });
    expect(work).toBeGreaterThan(1 << 23);
  });
});
