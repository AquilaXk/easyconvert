import { UnsupportedOptionError } from '../types';
import { ClipType, FillRule, type Path64, type Paths64 } from './vendor/clipper2/Core';
import { Clipper64 } from './vendor/clipper2/Engine';

/**
 * The cut of a filled area at a clip that is not one convex polygon: a curved clip flattened to a polygon, a concave or holed
 * path, the union of several shapes. The sweep-line clipper of Clipper2 (Angus Johnson, Boost Software License 1.0; the
 * TypeScript port in `vendor/clipper2`) joins the shapes of the region into polygons that hold no overlap, and cuts the polygons
 * of a fill, each by its own fill rule, at them. The lines of a stroke are not cut here: Clipper2 drops some of the segments of
 * an open path that lie on the edge of the clip and keeps others (measured on a flattened circle and on a rectangle, 27 and 28 of
 * 36 and 3 of 4, by the direction of the path), where a stroke along the edge of its clip must stay (`svg-clip-region.ts`).
 *
 * Clipper2 works on integers, so a device pixel is cut into GRID_UNITS_PER_PIXEL units, a power of two so that scaling is exact:
 * a coordinate is rounded to a thousandth of a pixel on the way in and on the way out, far under the half pixel an SVG renders at.
 * The rounding also makes a polygon that lies on the edge of the clip, with the same flattened curve, coincide exactly with it
 * instead of falling a rounding error on either side.
 */

interface Point {
  x: number;
  y: number;
}

export type PolygonFillRule = 'nonzero' | 'evenodd';

/** What a clip shape gives the region: its closed polygons in device pixels and the rule that fills them. */
export interface RegionShape {
  rule: PolygonFillRule;
  polygons: readonly (readonly Point[])[];
}

/** The region of a clip as polygons of integer units that hold no overlap and no self-crossing, so that either fill rule reads them alike. */
export interface PolygonRegion {
  paths: Paths64;
  /** The edges of the paths. */
  edgeCount: number;
}

/** 2^10 units to the pixel: with the 10^9 pixels a coordinate may reach, 10^12 units, a product of two stays exact in the engine's integer checks. */
export const GRID_UNITS_PER_PIXEL = 1024;

const FILL_RULES: Readonly<Record<PolygonFillRule, FillRule>> = { nonzero: FillRule.NonZero, evenodd: FillRule.EvenOdd };

/** Units of `engineWork` that count as one edge test of the clip work: at its worst case (below, 7.6 ns a unit) the 2^23 tests of a document cost 0.25 s. */
const ENGINE_UNITS_PER_EDGE_TEST = 4;

function failed(what: string): UnsupportedOptionError {
  return new UnsupportedOptionError(`SVG clip-path cannot be cut: the polygon clipper stopped while it ${what}.`);
}

const toUnits = (points: readonly Point[]): Path64 => points.map((p) => ({ x: Math.round(p.x * GRID_UNITS_PER_PIXEL), y: Math.round(p.y * GRID_UNITS_PER_PIXEL) }));
const toPixels = (path: Path64): Point[] => path.map((p) => ({ x: p.x / GRID_UNITS_PER_PIXEL, y: p.y / GRID_UNITS_PER_PIXEL }));

/** The area that the polygons of one shape fill by its rule, as polygons with the holes reversed (a union of the shape with itself). */
function fillOf(shape: RegionShape): Paths64 {
  const solution: Paths64 = [];
  const clipper = new Clipper64();
  clipper.addSubject(shape.polygons.map(toUnits));
  if (!clipper.execute(ClipType.Union, FILL_RULES[shape.rule], solution)) throw failed('read the shape of the clip');
  return solution;
}

/** The region of a clip: the union of the areas of its shapes, each filled by its own `clip-rule`. */
export function polygonRegion(shapes: readonly RegionShape[]): PolygonRegion {
  const areas = shapes.map(fillOf);
  let paths = areas.length === 1 ? areas[0] : [];
  if (areas.length > 1) {
    const clipper = new Clipper64();
    for (const area of areas) clipper.addSubject(area);
    if (!clipper.execute(ClipType.Union, FillRule.NonZero, paths)) throw failed('joined the shapes of the clip');
  }
  return { paths, edgeCount: paths.reduce((total, path) => total + path.length, 0) };
}

/** The part of the polygons inside the region, each closed by its first point repeated; `rule` is how the polygons themselves are filled. */
export function cutAreasAtRegion(region: PolygonRegion, rings: readonly (readonly Point[])[], rule: PolygonFillRule): Point[][] {
  const solution: Paths64 = [];
  const clipper = new Clipper64();
  clipper.addSubject(rings.map(toUnits));
  clipper.addClip(region.paths);
  if (!clipper.execute(ClipType.Intersection, FILL_RULES[rule], solution)) throw failed('cut an area');
  return solution.filter((path) => path.length >= 3).map((path) => {
    const ring = toPixels(path);
    return [...ring, ring[0]];
  });
}

/**
 * What cutting the rings at the region costs, in the edge tests of the clip work. The sweep keeps the edges that cross the
 * scanline in a list, a new edge goes into it by a walk down the list, and an edge crosses only the edges that share a scanline
 * with it, so the cost is the edges of both times the most that are on one scanline at once. A smooth outline has a few hundred
 * on a scanline: 200,000 vertices cut at a 36-sided clip in 78 ms. A zigzag with all of its edges on every scanline is the worst
 * case: 50,000 vertices at a clip of 1,000 edges take 19.8 s, 7.6 ns for each edge times the most on one scanline (macOS host).
 */
export function engineWork(region: PolygonRegion, rings: readonly (readonly Point[])[]): number {
  const count = rings.reduce((total, ring) => total + ring.length, 0) + region.edgeCount;
  const [tops, bottoms] = [new Float64Array(count), new Float64Array(count)];
  let at = 0;
  const add = (a: number, b: number): void => {
    [tops[at], bottoms[at]] = a < b ? [a, b] : [b, a];
    at += a === b ? 0 : 1;
  };
  for (const ring of rings) ring.forEach((p, i) => add(Math.round(p.y * GRID_UNITS_PER_PIXEL), Math.round(ring[(i + 1) % ring.length].y * GRID_UNITS_PER_PIXEL)));
  for (const path of region.paths) path.forEach((p, i) => add(p.y, path[(i + 1) % path.length].y));
  tops.subarray(0, at).sort();
  bottoms.subarray(0, at).sort();
  let [active, most, ended] = [0, 0, 0];
  for (let started = 0; started < at; started++) {
    while (ended < started && bottoms[ended] <= tops[started]) [ended, active] = [ended + 1, active - 1];
    most = Math.max(most, ++active);
  }
  return Math.ceil((at * most) / ENGINE_UNITS_PER_EDGE_TEST);
}

/**
 * One vertex of each hole of the region (a polygon the clipper gives the opposite way round from the outlines, so with a negative
 * shoelace area), in device pixels. A fill whose outline lies inside the region but encloses a hole covers it, which no vertex
 * of the outline shows.
 */
export function holeVertices(region: PolygonRegion): Point[] {
  const twiceArea = (path: Path64): number => path.reduce((total, a, i) => total + a.x * path[(i + 1) % path.length].y - path[(i + 1) % path.length].x * a.y, 0);
  return region.paths.filter((path) => twiceArea(path) < 0).map((path) => toPixels([path[0]])[0]);
}
