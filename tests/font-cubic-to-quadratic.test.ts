import { describe, expect, it } from 'vitest';
import { cubicToQuadraticBezier } from '../src/lib/conversions/font';
import { ConversionFailedError } from '../src/lib/types';

/**
 * Regression coverage for cubicToQuadraticBezier (CFF cubic outlines -> TrueType quadratic
 * outlines). The oracle is an independent geometric sampler written in this file: it evaluates
 * the source cubic and the produced quadratic chain directly from the Bezier definitions and
 * measures the two-sided Hausdorff distance, so it does not depend on the converter's own
 * error estimate or its parametrisation of the pieces.
 */

interface Pt {
  x: number;
  y: number;
}

type QuadPiece = ReturnType<typeof cubicToQuadraticBezier>[number];

const UNITS_PER_EM = 1000;
const TOLERANCE_FONT_UNITS = 0.5;
// Dense-sampling error of the oracle itself (polyline chord sagitta), far below the tolerance.
const SAMPLING_SLACK = 0.01;
const CUBIC_SAMPLES = 2000;
const QUAD_SAMPLES_PER_PIECE = 600;
// Cubic control-point offset that approximates a quarter circle (4/3 * (sqrt(2) - 1)).
const QUARTER_CIRCLE_KAPPA = (4 / 3) * (Math.SQRT2 - 1);
// Largest radial error (font units) of the kappa cubic itself against the true circle at 1000 upm.
const KAPPA_CUBIC_RADIAL_ERROR = 0.3;
const MAX_PIECES_FOR_ROUND_GLYPH_QUARTER = 16;
/** The converter's documented default tolerance and piece cap (font units). */
const DEFAULT_TOLERANCE = 1.5;
const MAX_PIECES = 64;

function cubicAt(p0: Pt, c1: Pt, c2: Pt, p3: Pt, t: number): Pt {
  const u = 1 - t;
  const a = u * u * u;
  const b = 3 * u * u * t;
  const c = 3 * u * t * t;
  const d = t * t * t;
  return {
    x: a * p0.x + b * c1.x + c * c2.x + d * p3.x,
    y: a * p0.y + b * c1.y + c * c2.y + d * p3.y,
  };
}

function quadAt(p0: Pt, q: Pt, p2: Pt, t: number): Pt {
  const u = 1 - t;
  return {
    x: u * u * p0.x + 2 * u * t * q.x + t * t * p2.x,
    y: u * u * p0.y + 2 * u * t * q.y + t * t * p2.y,
  };
}

function chainPoints(start: Pt, chain: QuadPiece[]): Pt[] {
  const out: Pt[] = [];
  let from = start;
  for (const piece of chain) {
    for (let i = 0; i <= QUAD_SAMPLES_PER_PIECE; i++) {
      out.push(quadAt(from, piece.q, piece.p, i / QUAD_SAMPLES_PER_PIECE));
    }
    from = piece.p;
  }
  return out;
}

function distance(a: Pt, b: Pt): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function distanceToSegment(pt: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) return distance(pt, a);
  const t = Math.max(0, Math.min(1, ((pt.x - a.x) * dx + (pt.y - a.y) * dy) / lengthSquared));
  return distance(pt, { x: a.x + t * dx, y: a.y + t * dy });
}

/** Segments per bounding box of the index below. */
const INDEX_BLOCK = 16;
/** A box counts as farther than `best` only beyond this margin, so rounding in a distance can never make the skip differ from the full scan. */
const SKIP_MARGIN = 1e-9;

/** Smallest distance from `pt` to the segments `first`..`last - 1` of the polyline (segment i joins points i - 1 and i); a NaN distance is ignored, `Infinity` when there is none. */
function nearestInRange(pt: Pt, polyline: Pt[], first: number, last: number): number {
  let best = Infinity;
  for (let i = first; i < last; i++) {
    const d = distanceToSegment(pt, polyline[i - 1], polyline[i]);
    if (d < best) best = d;
  }
  return best;
}

/**
 * Largest distance from any point of `from` to the polyline through `polyline`, where the distance of a point is the exact
 * minimum over all segments (a NaN segment is ignored, no segment at all gives `Infinity`, as in the plain double loop kept
 * below as the reference of the tests). The polyline is cut into blocks of INDEX_BLOCK segments whose bounding boxes are
 * computed once; a block whose box is beyond the best distance found cannot hold a nearer segment and is not scanned. A
 * point starts with the block that held the nearest segment of the point before it (the points follow a curve), so the best
 * distance is tight from the start. A NaN coordinate makes its box NaN, and a NaN box is never skipped.
 */
function maxDistanceToPolyline(from: Pt[], polyline: Pt[]): number {
  const segments = Math.max(0, polyline.length - 1);
  const blocks = Math.ceil(segments / INDEX_BLOCK);
  const minX = new Float64Array(blocks).fill(Infinity);
  const maxX = new Float64Array(blocks).fill(-Infinity);
  const minY = new Float64Array(blocks).fill(Infinity);
  const maxY = new Float64Array(blocks).fill(-Infinity);
  for (let i = 1; i <= segments; i++) {
    const block = Math.floor((i - 1) / INDEX_BLOCK);
    const a = polyline[i - 1];
    const b = polyline[i];
    minX[block] = Math.min(minX[block], a.x, b.x);
    maxX[block] = Math.max(maxX[block], a.x, b.x);
    minY[block] = Math.min(minY[block], a.y, b.y);
    maxY[block] = Math.max(maxY[block], a.y, b.y);
  }
  const rangeOf = (block: number): [number, number] => [block * INDEX_BLOCK + 1, Math.min(segments, (block + 1) * INDEX_BLOCK) + 1];
  let worst = 0;
  let hint = 0;
  for (const pt of from) {
    let best = Infinity;
    let nearest = hint;
    if (hint < blocks) best = nearestInRange(pt, polyline, ...rangeOf(hint));
    let reach = best * (1 + SKIP_MARGIN);
    for (let block = 0; block < blocks; block++) {
      if (block === hint) continue;
      if (minX[block] - pt.x > reach || pt.x - maxX[block] > reach || minY[block] - pt.y > reach || pt.y - maxY[block] > reach) continue;
      const d = nearestInRange(pt, polyline, ...rangeOf(block));
      if (d < best) {
        best = d;
        nearest = block;
        reach = best * (1 + SKIP_MARGIN);
      }
    }
    hint = nearest;
    if (best > worst) worst = best;
  }
  return worst;
}

/** The plain double loop: the reference the indexed search above must equal, bit for bit, on every input. */
function maxDistanceToPolylineByScan(from: Pt[], polyline: Pt[]): number {
  let worst = 0;
  for (const pt of from) {
    let best = Infinity;
    for (let i = 1; i < polyline.length; i++) {
      const d = distanceToSegment(pt, polyline[i - 1], polyline[i]);
      if (d < best) best = d;
    }
    if (best > worst) worst = best;
  }
  return worst;
}

function hausdorff(p0: Pt, c1: Pt, c2: Pt, p3: Pt, chain: QuadPiece[]): number {
  const cubicPts: Pt[] = [];
  for (let i = 0; i <= CUBIC_SAMPLES; i++) {
    cubicPts.push(cubicAt(p0, c1, c2, p3, i / CUBIC_SAMPLES));
  }
  const quadPts = chainPoints(p0, chain);
  return Math.max(
    maxDistanceToPolyline(cubicPts, quadPts),
    maxDistanceToPolyline(quadPts, cubicPts)
  );
}

const R = UNITS_PER_EM / 2;
const QUARTER = {
  p0: { x: R, y: 0 },
  c1: { x: R, y: R * QUARTER_CIRCLE_KAPPA },
  c2: { x: R * QUARTER_CIRCLE_KAPPA, y: R },
  p3: { x: 0, y: R },
};
const S_CURVE = {
  p0: { x: 0, y: 0 },
  c1: { x: 600, y: 0 },
  c2: { x: 400, y: 1000 },
  p3: { x: 1000, y: 1000 },
};
const LOOP_CURVE = {
  p0: { x: 0, y: 0 },
  c1: { x: 1000, y: 800 },
  c2: { x: -200, y: 800 },
  p3: { x: 800, y: 0 },
};

/** A small seeded generator (mulberry32), so the random polylines of the tests are the same on every run. */
function seededRandom(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('the distance oracle', () => {
  const same = (from: Pt[], polyline: Pt[]): void => {
    expect(Object.is(maxDistanceToPolyline(from, polyline), maxDistanceToPolylineByScan(from, polyline))).toBe(true);
  };
  const SCALES = [1, 1000, 65535, 1e9, 1e15, 1e154, 1e-300];

  it('returns exactly the distance of the plain double loop on random polylines of every scale, including 1e154 where a squared distance overflows', () => {
    const random = seededRandom(12345);
    const uniform = (count: number, scale: number): Pt[] => Array.from({ length: count }, () => ({ x: (random() - 0.5) * scale, y: (random() - 0.5) * scale }));
    const walk = (count: number, scale: number): Pt[] => {
      const out: Pt[] = [{ x: 0, y: 0 }];
      for (let i = 1; i < count; i++) out.push({ x: out[i - 1].x + (random() - 0.5) * scale, y: out[i - 1].y + (random() - 0.5) * scale });
      return out;
    };
    const grid = (count: number, scale: number): Pt[] => Array.from({ length: count }, () => ({ x: Math.floor(random() * 4) * scale, y: Math.floor(random() * 4) * scale }));
    const offset = (count: number): Pt[] => Array.from({ length: count }, () => ({ x: 1e15 + Math.floor(random() * 8), y: -1e15 + Math.floor(random() * 8) }));
    for (let round = 0; round < 600; round++) {
      const scale = SCALES[round % SCALES.length];
      const make = [uniform, walk, grid][round % 3];
      same(make(1 + Math.floor(random() * 40), scale), make(2 + Math.floor(random() * 80), scale));
      same(offset(10), offset(40));
    }
  });

  it('returns exactly the distance of the plain double loop on the long curves the converter tests use', () => {
    const wave = (count: number, phase: number): Pt[] => Array.from({ length: count }, (_, i) => ({ x: 65535 * Math.cos(3 * (i / (count - 1)) + phase), y: 65535 * Math.sin(5 * (i / (count - 1))) }));
    same(wave(5000, 0), wave(2001, 1e-4));
    same(wave(2001, 1e-4), wave(5000, 0));
  });

  it('ignores a NaN segment as the plain loop does and reports a NaN sample as infinitely far, so a corrupt chain cannot read as zero', () => {
    const good = Array.from({ length: 50 }, (_, i) => ({ x: i * 3, y: (i % 5) * 2 }));
    const nanHead = [{ x: NaN, y: NaN }, ...good];
    same(good, nanHead);
    same(nanHead, good);
    expect(maxDistanceToPolyline(nanHead, good)).toBe(Infinity);
    const nanSample = [...good.slice(0, 10), { x: NaN, y: 0 }];
    same(nanSample, good);
    expect(maxDistanceToPolyline(nanSample, good)).toBe(Infinity);
    same(good, [{ x: 0, y: 0 }]);
    same(good, []);
    expect(maxDistanceToPolyline(good, [])).toBe(Infinity);
  });

  it('measures a chain whose first piece has a NaN control point as far from the curve', () => {
    const { p0, c1, c2, p3 } = S_CURVE;
    const chain = cubicToQuadraticBezier(p0, c1, c2, p3);
    const corrupt = [{ ...chain[0], q: { x: NaN, y: NaN } }, ...chain.slice(1)];
    expect(hausdorff(p0, c1, c2, p3, chain)).toBeLessThanOrEqual(DEFAULT_TOLERANCE + SAMPLING_SLACK);
    expect(hausdorff(p0, c1, c2, p3, corrupt)).toBeGreaterThan(DEFAULT_TOLERANCE + SAMPLING_SLACK);
  });
});

describe('cubicToQuadraticBezier', () => {
  it('measures a large deviation for the single-quadratic approximation of a quarter circle (oracle self-check)', () => {
    const { p0, c1, c2, p3 } = QUARTER;
    // Hand-built single quadratic using the converter's midpoint-matching control point formula.
    const q = {
      x: (3 * (c1.x + c2.x) - (p0.x + p3.x)) / 4,
      y: (3 * (c1.y + c2.y) - (p0.y + p3.y)) / 4,
    };
    const single: QuadPiece[] = [{ q, p: p3, p0, p2: p3 }];
    expect(hausdorff(p0, c1, c2, p3, single)).toBeGreaterThan(TOLERANCE_FONT_UNITS);
  });

  it.each([
    ['quarter circle', QUARTER],
    ['S curve', S_CURVE],
    ['self-crossing curve', LOOP_CURVE],
  ])('keeps the quadratic chain of the %s within tolerance of the cubic', (_name, curve) => {
    const { p0, c1, c2, p3 } = curve;
    const chain = cubicToQuadraticBezier(p0, c1, c2, p3, TOLERANCE_FONT_UNITS);
    expect(hausdorff(p0, c1, c2, p3, chain)).toBeLessThanOrEqual(
      TOLERANCE_FONT_UNITS + SAMPLING_SLACK
    );
  });

  it('subdivides a round quarter circle into several pieces instead of one pointed quadratic', () => {
    const { p0, c1, c2, p3 } = QUARTER;
    const chain = cubicToQuadraticBezier(p0, c1, c2, p3, TOLERANCE_FONT_UNITS);
    expect(chain.length).toBeGreaterThan(1);
    expect(chain.length).toBeLessThanOrEqual(MAX_PIECES_FOR_ROUND_GLYPH_QUARTER);
  });

  it('keeps every sampled point of the quarter-circle chain on the true circle', () => {
    const { p0, c1, c2, p3 } = QUARTER;
    const chain = cubicToQuadraticBezier(p0, c1, c2, p3, TOLERANCE_FONT_UNITS);
    const radii = chainPoints(p0, chain).map((pt) => Math.hypot(pt.x, pt.y));
    const worst = Math.max(...radii.map((r) => Math.abs(r - R)));
    expect(worst).toBeLessThanOrEqual(TOLERANCE_FONT_UNITS + KAPPA_CUBIC_RADIAL_ERROR);
  });

  it('forms a connected chain that starts and ends exactly on the cubic end points', () => {
    const { p0, c1, c2, p3 } = S_CURVE;
    const chain = cubicToQuadraticBezier(p0, c1, c2, p3, TOLERANCE_FONT_UNITS);
    expect(chain[0].p0).toEqual(p0);
    expect(chain[chain.length - 1].p).toEqual(p3);
    expect(chain[chain.length - 1].p2).toEqual(p3);
    for (let i = 1; i < chain.length; i++) {
      expect(chain[i].p0).toEqual(chain[i - 1].p);
    }
    for (const piece of chain) {
      expect(Number.isFinite(piece.q.x)).toBe(true);
      expect(Number.isFinite(piece.q.y)).toBe(true);
    }
  });

  it('produces an alternating off-curve/on-curve point sequence usable for a glyf contour', () => {
    const { p0, c1, c2, p3 } = QUARTER;
    const chain = cubicToQuadraticBezier(p0, c1, c2, p3, TOLERANCE_FONT_UNITS);
    const points = [{ ...p0, onCurve: true }];
    for (const piece of chain) {
      points.push({ ...piece.q, onCurve: false }, { ...piece.p, onCurve: true });
    }
    expect(points).toHaveLength(1 + 2 * chain.length);
    points.forEach((pt, i) => {
      expect(pt.onCurve).toBe(i % 2 === 0);
    });
    // Control points of a convex quarter arc stay inside the bounding box of the end points
    // extended by the tangent intersection (R, R).
    for (const piece of chain) {
      expect(piece.q.x).toBeGreaterThanOrEqual(0);
      expect(piece.q.x).toBeLessThanOrEqual(R);
      expect(piece.q.y).toBeGreaterThanOrEqual(0);
      expect(piece.q.y).toBeLessThanOrEqual(R);
    }
  });

  it('uses more pieces for a tighter tolerance and still honours it', () => {
    const { p0, c1, c2, p3 } = S_CURVE;
    const tight = 0.05;
    const loose = cubicToQuadraticBezier(p0, c1, c2, p3, 2);
    const strict = cubicToQuadraticBezier(p0, c1, c2, p3, tight);
    expect(strict.length).toBeGreaterThan(loose.length);
    expect(hausdorff(p0, c1, c2, p3, strict)).toBeLessThanOrEqual(tight + SAMPLING_SLACK);
  });

  it('returns a single exact quadratic when the cubic is a degree-elevated quadratic', () => {
    const q = { x: 50, y: 100 };
    const p0 = { x: 0, y: 0 };
    const p2 = { x: 100, y: 0 };
    const c1 = { x: p0.x + (2 / 3) * (q.x - p0.x), y: p0.y + (2 / 3) * (q.y - p0.y) };
    const c2 = { x: p2.x + (2 / 3) * (q.x - p2.x), y: p2.y + (2 / 3) * (q.y - p2.y) };
    const chain = cubicToQuadraticBezier(p0, c1, c2, p2, TOLERANCE_FONT_UNITS);
    expect(chain).toHaveLength(1);
    expect(chain[0].q.x).toBeCloseTo(q.x, 9);
    expect(chain[0].q.y).toBeCloseTo(q.y, 9);
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects the non-positive or non-finite tolerance %s with a typed error',
    (tolerance) => {
      const { p0, c1, c2, p3 } = S_CURVE;
      expect(() => cubicToQuadraticBezier(p0, c1, c2, p3, tolerance)).toThrow(
        ConversionFailedError
      );
    }
  );

  it('rejects non-finite control points with a typed error', () => {
    const { p0, c2, p3 } = S_CURVE;
    expect(() =>
      cubicToQuadraticBezier(p0, { x: Number.NaN, y: 0 }, c2, p3, TOLERANCE_FONT_UNITS)
    ).toThrow(ConversionFailedError);
  });

  it.each([
    ['collinear', { x: 0, y: 0 }, { x: 100, y: 100 }, { x: 200, y: 200 }, { x: 300, y: 300 }],
    ['all coincident', { x: 50, y: 50 }, { x: 50, y: 50 }, { x: 50, y: 50 }, { x: 50, y: 50 }],
  ])('returns one exact piece for a degenerate %s cubic', (_label, p0, c1, c2, p3) => {
    const chain = cubicToQuadraticBezier(p0, c1, c2, p3, TOLERANCE_FONT_UNITS);
    expect(chain).toHaveLength(1);
    expect(chain[0].p0).toEqual(p0);
    expect(chain[0].p).toEqual(p3);
    // For a degree-elevated straight line the midpoint-matching control point lies on the line.
    expect(chain[0].q).toEqual({ x: (p0.x + p3.x) / 2, y: (p0.y + p3.y) / 2 });
  });

  it('closes a loop whose end points coincide and stays within tolerance', () => {
    const p0 = { x: 0, y: 0 };
    const c1 = { x: 400, y: 0 };
    const c2 = { x: 400, y: 400 };
    const chain = cubicToQuadraticBezier(p0, c1, c2, p0, TOLERANCE_FONT_UNITS);
    expect(chain[0].p0).toEqual(p0);
    expect(chain[chain.length - 1].p).toEqual(p0);
    expect(hausdorff(p0, c1, c2, p0, chain)).toBeLessThanOrEqual(TOLERANCE_FONT_UNITS + SAMPLING_SLACK);
  });

  it('converts a curve spanning the full 16-bit coordinate range within the default tolerance and the piece cap', () => {
    const p0 = { x: -32768, y: -32768 };
    const c1 = { x: 32767, y: -32768 };
    const c2 = { x: -32768, y: 32767 };
    const p3 = { x: 32767, y: 32767 };
    const chain = cubicToQuadraticBezier(p0, c1, c2, p3);
    expect(chain.length).toBeLessThanOrEqual(MAX_PIECES);
    expect(hausdorff(p0, c1, c2, p3, chain)).toBeLessThanOrEqual(DEFAULT_TOLERANCE + SAMPLING_SLACK);
  });

  it('fails closed instead of truncating when the piece cap cannot meet the tolerance', () => {
    const { p0, c1, c2, p3 } = S_CURVE;
    expect(() => cubicToQuadraticBezier(p0, c1, c2, p3, 1e-9)).toThrow(ConversionFailedError);
  });
});
