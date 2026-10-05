import { describe, expect, it } from 'vitest';
import {
  MAX_SVG_PATH_COMMANDS_PER_GLYPH,
  SvgPathDataError,
  parseSvgPathData,
  type SvgSegment,
  type SvgSubpath,
} from '../src/lib/conversions/font-svg-path';
import { ConversionFailedError } from '../src/lib/types';
import type { Pt } from './helpers/font-oracles';

/**
 * SVG 1.1 path data grammar (section 8.3) and the arc implementation notes (appendix F.6).
 * Expected values are worked out by hand for each path; the arc checks sample the produced cubic
 * chains and compare them with the circle or ellipse the arc is defined to lie on.
 */

const ARC_TOLERANCE = 0.01;
const CIRCLE_RADIUS_TOLERANCE = 0.02;
const COORDINATE_TOLERANCE = 1e-9;

function parse(d: string, maxCommands?: number): SvgSubpath[] {
  return parseSvgPathData(d, { arcTolerance: ARC_TOLERANCE, maxCommands });
}

function line(x: number, y: number): SvgSegment {
  return { kind: 'line', to: { x, y } };
}

function expectSegmentsClose(actual: SvgSegment[], expected: SvgSegment[]): void {
  expect(actual).toHaveLength(expected.length);
  actual.forEach((segment, i) => {
    const wanted = expected[i];
    expect(segment.kind).toBe(wanted.kind);
    const pairs: Array<[Pt, Pt]> = [[segment.to, wanted.to]];
    if (segment.kind === 'quad' && wanted.kind === 'quad') pairs.push([segment.c, wanted.c]);
    if (segment.kind === 'cubic' && wanted.kind === 'cubic') {
      pairs.push([segment.c1, wanted.c1], [segment.c2, wanted.c2]);
    }
    for (const [got, want] of pairs) {
      expect(Math.abs(got.x - want.x)).toBeLessThan(COORDINATE_TOLERANCE);
      expect(Math.abs(got.y - want.y)).toBeLessThan(COORDINATE_TOLERANCE);
    }
  });
}

function cubicPoint(a: Pt, c1: Pt, c2: Pt, b: Pt, t: number): Pt {
  const u = 1 - t;
  return {
    x: u * u * u * a.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * b.x,
    y: u * u * u * a.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * b.y,
  };
}

/** Samples every cubic of the subpath densely, starting from the subpath start. */
function sampleSubpath(subpath: SvgSubpath): Pt[] {
  const samples: Pt[] = [subpath.start];
  let from = subpath.start;
  for (const segment of subpath.segments) {
    if (segment.kind !== 'cubic') throw new Error(`expected only cubic segments, got ${segment.kind}`);
    for (let i = 1; i <= 50; i++) samples.push(cubicPoint(from, segment.c1, segment.c2, segment.to, i / 50));
    from = segment.to;
  }
  return samples;
}

describe('SVG path data: commands', () => {
  it('reads absolute and relative lines, H and V to the same segments', () => {
    const absolute = parse('M10 20 L30 40 H50 V60 Z');
    const relative = parse('m10 20 l20 20 h20 v20 z');
    const expected = [line(30, 40), line(50, 40), line(50, 60)];
    for (const [subpaths] of [[absolute], [relative]]) {
      expect(subpaths).toHaveLength(1);
      expect(subpaths[0].start).toEqual({ x: 10, y: 20 });
      expect(subpaths[0].closed).toBe(true);
      expectSegmentsClose(subpaths[0].segments, expected);
    }
  });

  it('treats extra coordinate pairs after M and m as implicit L and l', () => {
    const [absolute] = parse('M0 0 10 10 20 0');
    expectSegmentsClose(absolute.segments, [line(10, 10), line(20, 0)]);
    const [relative] = parse('m5 5 10 10 10 -10');
    expect(relative.start).toEqual({ x: 5, y: 5 });
    expectSegmentsClose(relative.segments, [line(15, 15), line(25, 5)]);
  });

  it('repeats a command when more argument groups follow', () => {
    const [path] = parse('M0 0 L10 0 20 0 30 0 h5 5 v-5 -5');
    expectSegmentsClose(path.segments, [line(10, 0), line(20, 0), line(30, 0), line(35, 0), line(40, 0), line(40, -5), line(40, -10)]);
  });

  it('reads C and c with absolute and relative control points', () => {
    const [absolute] = parse('M0 0 C0 10 10 20 20 20');
    const [relative] = parse('M0 0 c0 10 10 20 20 20');
    const wanted: SvgSegment = { kind: 'cubic', c1: { x: 0, y: 10 }, c2: { x: 10, y: 20 }, to: { x: 20, y: 20 } };
    expectSegmentsClose(absolute.segments, [wanted]);
    expectSegmentsClose(relative.segments, [wanted]);
  });

  it('reflects the previous second control point for S and uses the current point after other commands', () => {
    const [chained] = parse('M0 0 C0 10 10 20 20 20 S40 10 40 0');
    expectSegmentsClose(chained.segments, [
      { kind: 'cubic', c1: { x: 0, y: 10 }, c2: { x: 10, y: 20 }, to: { x: 20, y: 20 } },
      // reflection of (10, 20) about (20, 20) is (30, 20)
      { kind: 'cubic', c1: { x: 30, y: 20 }, c2: { x: 40, y: 10 }, to: { x: 40, y: 0 } },
    ]);
    const [afterLine] = parse('M0 0 L20 20 S40 10 40 0');
    expectSegmentsClose(afterLine.segments, [
      line(20, 20),
      { kind: 'cubic', c1: { x: 20, y: 20 }, c2: { x: 40, y: 10 }, to: { x: 40, y: 0 } },
    ]);
    const [relativeS] = parse('M0 0 C0 10 10 20 20 20 s20 -10 20 -20');
    expect(relativeS.segments[1]).toMatchObject({ kind: 'cubic', c1: { x: 30, y: 20 }, c2: { x: 40, y: 10 }, to: { x: 40, y: 0 } });
  });

  it('keeps Q and q as exact quadratics and reflects the control point for T and t', () => {
    const [path] = parse('M0 0 Q10 20 20 0 T40 0');
    expectSegmentsClose(path.segments, [
      { kind: 'quad', c: { x: 10, y: 20 }, to: { x: 20, y: 0 } },
      // reflection of (10, 20) about (20, 0) is (30, -20)
      { kind: 'quad', c: { x: 30, y: -20 }, to: { x: 40, y: 0 } },
    ]);
    const [relative] = parse('m0 0 q10 20 20 0 t20 0');
    expectSegmentsClose(relative.segments, path.segments);
    const [afterLine] = parse('M0 0 L10 0 T30 0');
    expectSegmentsClose(afterLine.segments, [line(10, 0), { kind: 'quad', c: { x: 10, y: 0 }, to: { x: 30, y: 0 } }]);
  });

  it('starts the next subpath at the initial point after Z, and splits subpaths at M', () => {
    const subpaths = parse('M10 10 L20 10 L20 20 Z L5 5 M50 50 l10 0 l0 10 z');
    expect(subpaths).toHaveLength(3);
    expect(subpaths[0].start).toEqual({ x: 10, y: 10 });
    expect(subpaths[1].start).toEqual({ x: 10, y: 10 });
    expectSegmentsClose(subpaths[1].segments, [line(5, 5)]);
    expect(subpaths[1].closed).toBe(false);
    expect(subpaths[2].start).toEqual({ x: 50, y: 50 });
    expectSegmentsClose(subpaths[2].segments, [line(60, 50), line(60, 60)]);
  });

  it('drops a subpath that has no segments and accepts an empty string', () => {
    expect(parse('')).toEqual([]);
    expect(parse('  \n ')).toEqual([]);
    expect(parse('M5 5 M10 10 L20 20')).toHaveLength(1);
    expect(parse('M5 5 Z')).toEqual([]);
  });

  it('accepts every number spelling of the grammar and separators', () => {
    const [path] = parse('M.5.5L1e1,-2.5E-1 +3 4M1-2');
    expect(path.start).toEqual({ x: 0.5, y: 0.5 });
    expectSegmentsClose(path.segments, [line(10, -0.25), line(3, 4)]);
    const subpaths = parse('M.5.5L1e1,-2.5E-1 +3 4M1-2L3 4');
    expect(subpaths[1].start).toEqual({ x: 1, y: -2 });
  });

  it('reads arc flags that are written without separators', () => {
    const [compact] = parse('M0 0a40 40 0 1150 0');
    const [spaced] = parse('M0 0a40 40 0 1 1 50 0');
    expect(compact.segments).toEqual(spaced.segments);
    const [commaSeparated] = parse('M0 0a40,40,0,1,1,50,0');
    expect(commaSeparated.segments).toEqual(spaced.segments);
  });
});

describe('SVG path data: arcs become cubic Bezier curves (implementation notes F.6)', () => {
  it('draws a semicircle that bulges to y < 0 for sweep-flag 1 and y > 0 for sweep-flag 0', () => {
    for (const [sweep, bulge] of [[1, -50], [0, 50]] as const) {
      const [path] = parse(`M0 0 A50 50 0 0 ${sweep} 100 0`);
      const samples = sampleSubpath(path);
      for (const pt of samples) {
        expect(Math.abs(Math.hypot(pt.x - 50, pt.y) - 50)).toBeLessThan(CIRCLE_RADIUS_TOLERANCE);
      }
      const extreme = samples.reduce((best, pt) => (Math.abs(pt.y) > Math.abs(best.y) ? pt : best));
      expect(extreme.y).toBeCloseTo(bulge, 1);
      expect(extreme.x).toBeCloseTo(50, 1);
      expect(path.segments[path.segments.length - 1].to).toEqual({ x: 100, y: 0 });
    }
  });

  it('picks the center on the right side for the large-arc and sweep flags', () => {
    // Chord (10,0)-(90,0), radius 50: the two candidate centers are (50, 30) and (50, -30).
    const small = parse('M10 0 A50 50 0 0 1 90 0')[0];
    const large = parse('M10 0 A50 50 0 1 1 90 0')[0];
    for (const pt of sampleSubpath(small)) {
      expect(Math.abs(Math.hypot(pt.x - 50, pt.y - 30) - 50)).toBeLessThan(CIRCLE_RADIUS_TOLERANCE);
    }
    for (const pt of sampleSubpath(large)) {
      expect(Math.abs(Math.hypot(pt.x - 50, pt.y + 30) - 50)).toBeLessThan(CIRCLE_RADIUS_TOLERANCE);
    }
    const smallApex = Math.min(...sampleSubpath(small).map((p) => p.y));
    const largeApex = Math.min(...sampleSubpath(large).map((p) => p.y));
    expect(smallApex).toBeCloseTo(-20, 1);
    expect(largeApex).toBeCloseTo(-80, 1);
  });

  it('honours the x-axis rotation of an elliptical arc', () => {
    // Radii 100 x 50 rotated by 90 degrees: the ellipse is 50 wide and 100 tall around (0, 100).
    const [path] = parse('M0 0 A100 50 90 0 1 50 100');
    const samples = sampleSubpath(path);
    for (const pt of samples) {
      const normalized = (pt.x / 50) ** 2 + ((pt.y - 100) / 100) ** 2;
      expect(Math.abs(normalized - 1)).toBeLessThan(0.01);
    }
    const nearMiddle = samples.reduce((best, pt) =>
      Math.hypot(pt.x - 35.355, pt.y - 29.289) < Math.hypot(best.x - 35.355, best.y - 29.289) ? pt : best
    );
    expect(Math.hypot(nearMiddle.x - 35.355, nearMiddle.y - 29.289)).toBeLessThan(0.5);
  });

  it('scales radii that are too small up to the smallest ellipse through both end points', () => {
    const [path] = parse('M0 0 A10 10 0 0 1 100 0');
    for (const pt of sampleSubpath(path)) {
      expect(Math.abs(Math.hypot(pt.x - 50, pt.y) - 50)).toBeLessThan(CIRCLE_RADIUS_TOLERANCE);
    }
  });

  it('makes a straight line when a radius is zero and skips an arc with identical end points', () => {
    const [flat] = parse('M0 0 A0 50 0 0 1 30 40');
    expectSegmentsClose(flat.segments, [line(30, 40)]);
    const [nothing] = parse('M5 5 A20 20 0 0 1 5 5 L9 9');
    expectSegmentsClose(nothing.segments, [line(9, 9)]);
  });

  it('splits long arcs into pieces that stay within the tolerance of the circle', () => {
    // Three quarters of a radius 1000 circle around (1000, -1000): a 0.01 tolerance needs more
    // than the three quarter-turn pieces.
    const [path] = parse('M1000 0 A1000 1000 0 1 0 0 -1000');
    expect(path.segments.length).toBeGreaterThan(3);
    for (const pt of sampleSubpath(path)) {
      expect(Math.abs(Math.hypot(pt.x - 1000, pt.y + 1000) - 1000)).toBeLessThan(ARC_TOLERANCE);
    }
    expect(path.segments[path.segments.length - 1].to).toEqual({ x: 0, y: -1000 });
  });

  it('uses more pieces when the tolerance is tighter', () => {
    const loose = parseSvgPathData('M0 0 A500 500 0 0 1 1000 0', { arcTolerance: 5 })[0].segments.length;
    const tight = parseSvgPathData('M0 0 A500 500 0 0 1 1000 0', { arcTolerance: 0.0001 })[0].segments.length;
    expect(tight).toBeGreaterThan(loose);
  });
});

describe('SVG path data: malformed input is rejected with a typed error', () => {
  const MALFORMED: Array<[string, string, RegExp]> = [
    ['a path that does not start with M', 'L10 10', /moveto|start/i],
    ['an unknown command letter', 'M0 0 X5 5', /command/i],
    ['too few arguments', 'M0 0 L10', /number|argument/i],
    ['a missing argument group before the next command', 'M0 0 L Z', /number|argument/i],
    ['numbers after Z', 'M0 0 L1 1 Z 5 5', /command|number|unexpected/i],
    ['an arc flag that is not 0 or 1', 'M0 0 A5 5 0 2 0 1 1', /flag/i],
    ['a number without digits', 'M0 0 L- 5', /number/i],
    ['an exponent without digits', 'M0 0 L1e 5', /number/i],
    ['a number that overflows to infinity', 'M0 0 L1e999 0', /finite|number/i],
    ['a comma directly after the command letter', 'M,0 0', /number|comma/i],
    ['a doubled comma', 'M0,,0', /number|comma/i],
    ['a trailing comma', 'M0 0 L1 1,', /comma|number/i],
    ['stray punctuation', 'M0 0 L1 1 #', /command|unexpected/i],
  ];

  it.each(MALFORMED)('rejects %s', (_name, d, pattern) => {
    let caught: unknown;
    try {
      parse(d);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(SvgPathDataError);
    expect(caught).toBeInstanceOf(ConversionFailedError);
    expect((caught as Error).message).toMatch(pattern);
  });

  it('rejects more commands than the per-glyph limit, counting implicit repeats', () => {
    const atLimit = `M0 0${' L1 1'.repeat(MAX_SVG_PATH_COMMANDS_PER_GLYPH - 1)}`;
    expect(parse(atLimit)[0].segments).toHaveLength(MAX_SVG_PATH_COMMANDS_PER_GLYPH - 1);
    const overLimit = `M0 0${' L1 1'.repeat(MAX_SVG_PATH_COMMANDS_PER_GLYPH)}`;
    expect(() => parse(overLimit)).toThrow(SvgPathDataError);
    const implicit = `M0 0 L${'1 1 '.repeat(MAX_SVG_PATH_COMMANDS_PER_GLYPH)}`;
    expect(() => parse(implicit)).toThrow(/limit|too many/i);
  });

  it('rejects an invalid arc tolerance', () => {
    expect(() => parseSvgPathData('M0 0', { arcTolerance: 0 })).toThrow(ConversionFailedError);
    expect(() => parseSvgPathData('M0 0', { arcTolerance: Number.NaN })).toThrow(ConversionFailedError);
  });
});
