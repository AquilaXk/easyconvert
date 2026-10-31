import { describe, expect, it } from 'vitest';
import { BitmapGlyphs } from '../src/lib/conversions/svg-bitmap-glyph';
import { parseSvgGeometries } from '../src/lib/conversions/svg-geometry';
import { MAX_ACTIVE_CLIPS, MAX_CLIP_EDGES } from '../src/lib/conversions/svg-clip-region';
import { PAGE_CLIP_TOLERANCE_PIXELS } from '../src/lib/conversions/svg-page-clip';
import { encodeSvgPageToDxf } from '../src/lib/conversions/vector-dxf';
import { readDxf, type DxfDocument } from './helpers/dxf-reader';
import { DEFAULT_HANG_GUARD_MS, expectWithinHangGuard } from './helpers/timing';

/**
 * A clip path that is not the page. The DXF writer (which writes the centre lines of the drawing and holds no clip) drops it
 * when nothing it hides is more than one point outside it, measured on the flattened device-space vertices against the clip
 * region (policy 79). Past that, a clip of one convex polygon cuts the lines at its edges, and a clip of any other region is
 * refused, because dropping it draws what it hides.
 */

const PAGE_WIDTH = 200;
const PAGE_HEIGHT = 100;
/** The hostile cases take up to 0.3 s on a fast core; the guard stops a hang, and the refusal each case expects is what pins the limit. */
const HOSTILE_GUARD = { guardMs: DEFAULT_HANG_GUARD_MS, expectedLocalMs: 300 };
/** One point of the page in device pixels (96 per inch against 72), the most a clip may hide. */
const TOLERANCE = PAGE_CLIP_TOLERANCE_PIXELS;

function svgOf(body: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${PAGE_WIDTH}" height="${PAGE_HEIGHT}" viewBox="0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}">${body}</svg>`;
}

const clipOf = (children: string, attributes = ''): string => `<clipPath id="c" ${attributes}>${children}</clipPath>`;
const pathClip = (d: string, rule = 'nonzero'): string => clipOf(`<path clip-rule="${rule}" d="${d}"/>`);
const BOX = 'M 50 20 L 150 20 L 150 80 L 50 80 Z M 50 20';
const stroke = (d: string): string => `<path fill="none" stroke="#000" d="${d}"/>`;
const clipped = (clip: string, drawn: string, attributes = ''): string => svgOf(`<defs>${clip}</defs><g clip-path="url(#c)" ${attributes}>${drawn}</g>`);

function dxfOf(svg: string): DxfDocument {
  return readDxf(encodeSvgPageToDxf(Buffer.from(svg)).toString('utf-8'));
}

const refusal = (svg: string): string => {
  try {
    encodeSvgPageToDxf(Buffer.from(svg));
    return 'converted';
  } catch (error) {
    return `${(error as Error).name}: ${(error as Error).message}`;
  }
};

const CLIP_REFUSAL = /^ConversionFailedError: The page cannot be written as DXF: SVG clip-path "url\(#c\)" is not supported: /;
const NOT_CONVEX = /, and only a clip of one convex polygon is cut\.$/;

/** The vertices of each entity, x and y rounded to 4 decimals. */
const linesOf = (svg: string): number[][][] => dxfOf(svg).entities.map((entity) => entity.points.map((p) => [round(p.x), round(p.y)]));
const round = (value: number): number => Math.round(value * 1e4) / 1e4;

describe('a rectangular clip', () => {
  it('is dropped when everything it clips is inside', () => {
    const dxf = dxfOf(clipped(pathClip(BOX), stroke('M 60 30 L 140 70')));
    expect(dxf.entities.map((entity) => entity.points.map((p) => [p.x, p.y]))).toEqual([
      [
        [60, 70],
        [140, 30],
      ],
    ]);
  });

  it('is dropped when a vertex is within a point of it on the outside, and cuts the line at its edge past that', () => {
    expect(linesOf(clipped(pathClip(BOX), stroke('M 60 30 L 151 30')))).toEqual([
      [
        [60, 70],
        [151, 70],
      ],
    ]);
    expect(dxfOf(clipped(pathClip(BOX), stroke(`M 60 30 L ${150 + TOLERANCE - 0.01} 30`))).entities).toHaveLength(1);
    expect(linesOf(clipped(pathClip(BOX), stroke('M 60 30 L 152 30')))).toEqual([
      [
        [60, 70],
        [150, 70],
      ],
    ]);
  });

  it('measures the distance to the region, not to the sides, and cuts a line that leaves past a corner where it crosses the edge', () => {
    expect(linesOf(clipped(pathClip(BOX), stroke('M 60 30 L 151.2 30')))).toEqual([
      [
        [60, 70],
        [151.2, 70],
      ],
    ]);
    // The line from (60, 30) to (151, 81) crosses y = 80 at x = 60 + 91 * 50 / 51.
    expect(linesOf(clipped(pathClip(BOX), stroke('M 60 30 L 151 81')))).toEqual([
      [
        [60, 70],
        [round(60 + (91 * 50) / 51), 20],
      ],
    ]);
  });

  it('applies to a clip on the shape itself and to a clip in a style', () => {
    expect(dxfOf(svgOf(`<defs>${pathClip(BOX)}</defs><path clip-path="url(#c)" fill="none" stroke="#000" d="M 60 30 L 140 30"/>`)).entities).toHaveLength(1);
    expect(linesOf(svgOf(`<defs>${pathClip(BOX)}</defs><path style="clip-path:url(#c)" fill="none" stroke="#000" d="M 60 30 L 190 30"/>`))).toEqual([
      [
        [60, 70],
        [150, 70],
      ],
    ]);
  });

  it('cuts a filled outline as its line, a closed outline joined through its first point, and a flattened curve', () => {
    expect(dxfOf(clipped(pathClip(BOX), '<rect x="60" y="30" width="80" height="40" fill="#f00"/>')).entities).toHaveLength(1);
    expect(linesOf(clipped(pathClip(BOX), '<rect x="60" y="30" width="95" height="40" fill="#f00"/>'))).toEqual([
      [
        [150, 30],
        [60, 30],
        [60, 70],
        [150, 70],
      ],
    ]);
    const curve = linesOf(clipped(pathClip(BOX), stroke('M 60 30 C 100 -40 120 -40 140 30')));
    expect(curve).toHaveLength(2);
    expect(curve.flat().every(([x, y]) => x >= 50 && x <= 150 && y >= 20 && y <= 80)).toBe(true);
    expect(curve.flatMap((line) => [line[0][1], line.at(-1)?.[1]])).toEqual([70, 80, 80, 70]);
  });

  it('is read in the user space of the clipped element: its transform scales the clip and the tolerance stays in device pixels', () => {
    const half = pathClip('M 25 10 L 75 10 L 75 40 L 25 40 Z');
    expect(linesOf(clipped(half, stroke('M 30 15 L 75.6 15'), 'transform="scale(2)"'))).toEqual([
      [
        [60, 70],
        [151.2, 70],
      ],
    ]);
    expect(linesOf(clipped(half, stroke('M 30 15 L 75.8 15'), 'transform="scale(2)"'))).toEqual([
      [
        [60, 70],
        [150, 70],
      ],
    ]);
  });

  it('is moved by a transform on the <clipPath> and on its shape', () => {
    const atRightEdge = [
      [
        [60, 70],
        [150, 70],
      ],
    ];
    const moved = clipOf(`<path d="M -50 20 L 50 20 L 50 80 L -50 80 Z" transform="translate(100 0)"/>`);
    expect(linesOf(clipped(moved, stroke('M 60 30 L 150 30')))).toEqual(atRightEdge);
    expect(linesOf(clipped(moved, stroke('M 60 30 L 155 30')))).toEqual(atRightEdge);
    const outer = clipOf(`<rect x="-50" y="20" width="100" height="60"/>`, 'transform="translate(100 0)"');
    expect(linesOf(clipped(outer, stroke('M 60 30 L 150 30')))).toEqual(atRightEdge);
    expect(linesOf(clipped(outer, stroke('M 60 30 L 155 30')))).toEqual(atRightEdge);
  });

  it('is a rotated polygon in device space when its shape is rotated, and cuts at its slanted edge', () => {
    const diamond = clipOf(`<rect x="-20" y="-20" width="40" height="40" transform="translate(100 50) rotate(45)"/>`);
    expect(dxfOf(clipped(diamond, stroke('M 100 25 L 100 75 L 120 50'))).entities).toHaveLength(1);
    const [[start, end], ...rest] = linesOf(clipped(diamond, stroke('M 100 25 L 120 70')));
    expect(rest).toEqual([]);
    expect(start).toEqual([100, 75]);
    // The edge from (128.28, 50) to (100, 78.28) is x + y = 178.28 in SVG space; the line meets it at t = 0.7298.
    const half = 20 * Math.SQRT2;
    const t = (100 + half - 100 + 50 - 25) / (20 + 45);
    expect(end).toEqual([round(100 + 20 * t), round(100 - (25 + 45 * t))]);
    expect(Math.abs(end[0] - 100) + Math.abs(100 - end[1] - 50)).toBeCloseTo(half, 3);
  });
});

describe('a clip of any other shape', () => {
  const L_SHAPE = 'M 0 0 L 100 0 L 100 40 L 40 40 L 40 80 L 0 80 Z';

  it('measures a vertex in the notch of a concave path to the nearest edge, and refuses it past a point, since only a convex clip is cut', () => {
    expect(dxfOf(clipped(pathClip(L_SHAPE), stroke('M 10 10 L 90 10 L 90 30 L 30 30 L 30 70'))).entities).toHaveLength(1);
    const refused = refusal(clipped(pathClip(L_SHAPE), stroke('M 10 10 L 80 60')));
    expect(refused).toMatch(/reaches 20 pixels past it, more than the 1\.33 pixels \(one point\) a clip may hide/);
    expect(refused).toMatch(NOT_CONVEX);
  });

  it('finds a segment that leaves a concave clip between two vertices inside it', () => {
    expect(refusal(clipped(pathClip(L_SHAPE), stroke('M 30 70 L 90 30')))).toMatch(CLIP_REFUSAL);
  });

  it('measures the farthest point of a piece of a segment outside the clip, not only its middle', () => {
    const frame = 'M 0 0 H 200 V 100 H 0 Z M 20 10 H 180 V 90 H 20 Z';
    const across = stroke('M 10 50 L 190 50');
    expect(refusal(clipped(pathClip(`${frame} M 99 10 H 101 L 100 49.5 Z`, 'evenodd'), across)), 'needle on the edge of the hole').toMatch(CLIP_REFUSAL);
    expect(refusal(clipped(pathClip(`${frame} M 99 10.5 H 101 L 100 49.5 Z`, 'evenodd'), across)), 'needle in the hole').toMatch(/reaches 40 pixels past it/);
    expect(dxfOf(clipped(pathClip(L_SHAPE), stroke('M 39 41.5 L 41.5 39'))).entities, 'a corner cut by 0.35 pixels').toHaveLength(1);
  });

  it('follows clip-rule: a hole drawn the same way is filled by nonzero and empty for evenodd', () => {
    const holed = 'M 0 0 L 100 0 L 100 80 L 0 80 Z M 30 20 L 70 20 L 70 60 L 30 60 Z';
    expect(dxfOf(clipped(pathClip(holed, 'nonzero'), stroke('M 50 40 L 51 41'))).entities).toHaveLength(1);
    expect(refusal(clipped(pathClip(holed, 'evenodd'), stroke('M 50 40 L 51 41')))).toMatch(/reaches 20 pixels past it/);
    const reversed = 'M 0 0 L 100 0 L 100 80 L 0 80 Z M 30 20 L 30 60 L 70 60 L 70 20 Z';
    expect(refusal(clipped(pathClip(reversed, 'nonzero'), stroke('M 50 40 L 51 41')))).toMatch(CLIP_REFUSAL);
  });

  it('takes clip-rule from the shape, its style, its <clipPath> or the nonzero default', () => {
    const holed = 'M 0 0 L 100 0 L 100 80 L 0 80 Z M 30 20 L 70 20 L 70 60 L 30 60 Z';
    const inHole = stroke('M 50 40 L 51 41');
    expect(refusal(clipped(clipOf(`<path style="clip-rule:evenodd" d="${holed}"/>`), inHole))).toMatch(CLIP_REFUSAL);
    expect(refusal(clipped(clipOf(`<path d="${holed}"/>`, 'clip-rule="evenodd"'), inHole))).toMatch(CLIP_REFUSAL);
    expect(dxfOf(clipped(clipOf(`<path d="${holed}"/>`), inHole)).entities).toHaveLength(1);
  });

  it('inherits clip-rule from the ancestors of the <clipPath> and through inherit, not from the clipped element', () => {
    const holed = 'M 0 0 L 100 0 L 100 80 L 0 80 Z M 30 20 L 70 20 L 70 60 L 30 60 Z';
    const inHole = stroke('M 50 40 L 51 41');
    const plain = clipOf(`<path d="${holed}"/>`);
    expect(refusal(clipped(plain, inHole).replace('<svg ', '<svg clip-rule="evenodd" ')), 'evenodd on the root').toMatch(CLIP_REFUSAL);
    expect(refusal(svgOf(`<defs clip-rule="evenodd">${plain}</defs><g clip-path="url(#c)">${inHole}</g>`)), 'evenodd on <defs>').toMatch(CLIP_REFUSAL);
    expect(refusal(clipped(clipOf(`<path clip-rule="inherit" d="${holed}"/>`, 'clip-rule="evenodd"'), inHole)), 'inherit').toMatch(CLIP_REFUSAL);
    expect(dxfOf(clipped(clipOf(`<path clip-rule="nonzero" d="${holed}"/>`, 'clip-rule="evenodd"'), inHole)).entities, 'its own value first').toHaveLength(1);
    expect(dxfOf(clipped(plain, inHole, 'clip-rule="evenodd"')).entities, 'the clipped element').toHaveLength(1);
  });

  it('inherits a hidden visibility from the ancestors of the <clipPath> and through inherit, unless a shape is visible again', () => {
    const rect = (attributes = ''): string => `<rect x="40" y="20" width="120" height="60" ${attributes}/>`;
    const drawn = stroke('M 60 30 L 140 30');
    expect(refusal(svgOf(`<defs visibility="hidden">${clipOf(rect())}</defs><g clip-path="url(#c)">${drawn}</g>`)), 'hidden <defs>').toMatch(/hides everything/);
    expect(refusal(clipped(clipOf(rect('visibility="inherit"'), 'visibility="hidden"'), drawn)), 'inherit').toMatch(/hides everything/);
    expect(dxfOf(svgOf(`<defs visibility="hidden">${clipOf(rect('visibility="visible"'))}</defs><g clip-path="url(#c)">${drawn}</g>`)).entities, 'visible again').toHaveLength(1);
  });

  it('is the union of its shapes', () => {
    const two = clipOf('<rect x="0" y="0" width="50" height="100"/><rect x="100" y="0" width="50" height="100"/>');
    expect(dxfOf(clipped(two, `${stroke('M 10 10 L 40 10')}${stroke('M 110 10 L 140 10')}`)).entities).toHaveLength(2);
    expect(refusal(clipped(two, stroke('M 10 10 L 75 10')))).toMatch(/reaches 25 pixels past it/);
  });

  it('can be a polygon, which cuts when it is convex', () => {
    const triangle = clipOf('<polygon points="60,10 140,10 100,90"/>');
    expect(dxfOf(clipped(triangle, stroke('M 100 20 L 100 89'))).entities).toHaveLength(1);
    expect(linesOf(clipped(triangle, stroke('M 100 20 L 100 93')))).toEqual([
      [
        [100, 80],
        [100, 10],
      ],
    ]);
  });

  it.each([
    ['a circle', '<circle cx="100" cy="50" r="40"/>'],
    ['an ellipse', '<ellipse cx="100" cy="50" rx="40" ry="20"/>'],
    ['a rounded rect', '<rect x="60" y="10" width="80" height="80" rx="20"/>'],
    ['a path of cubic curves', '<path d="M 60 50 C 60 0 140 0 140 50 C 140 100 60 100 60 50 Z"/>'],
    ['a path of quadratic curves', '<path d="M 60 50 Q 100 -30 140 50 Q 100 130 60 50 Z"/>'],
    ['a path of arcs', '<path d="M 60 50 A 40 40 0 1 1 140 50 A 40 40 0 1 1 60 50 Z"/>'],
  ])('is refused when it is %s, whose flattened outline is off the curve by an error the region would not hold', (_name, shape) => {
    const refused = refusal(clipped(clipOf(shape), stroke('M 100 45 L 101 45')));
    expect(refused).toMatch(CLIP_REFUSAL);
    expect(refused).toMatch(/curve/);
  });

  it('leaves out a hidden curve, which adds nothing to the region, instead of refusing the clip for it', () => {
    const clip = clipOf('<circle cx="100" cy="50" r="40" display="none"/><rect x="40" y="20" width="120" height="60"/>');
    expect(dxfOf(clipped(clip, stroke('M 60 30 L 140 30'))).entities).toHaveLength(1);
  });

  it('is refused when a curve of it is flattened past a point under the scale of the clipped element', () => {
    const k = 0.5523;
    const circle = (cx: number, cy: number, r: number): string =>
      `M ${cx + r} ${cy} C ${cx + r} ${cy + k * r} ${cx + k * r} ${cy + r} ${cx} ${cy + r} C ${cx - k * r} ${cy + r} ${cx - r} ${cy + k * r} ${cx - r} ${cy} ` +
      `C ${cx - r} ${cy - k * r} ${cx - k * r} ${cy - r} ${cx} ${cy - r} C ${cx + k * r} ${cy - r} ${cx + r} ${cy - k * r} ${cx + r} ${cy} Z`;
    const frameWithRoundHole = pathClip(`M 0 0 L 10 0 L 10 5 L 0 5 Z ${circle(5, 2.5, 2)}`, 'evenodd');
    const inTheHoleOnAChord = stroke('M 6.7071 3.2071 L 6.7739 3.2348');
    expect(refusal(clipped(frameWithRoundHole, inTheHoleOnAChord, 'transform="scale(20)"')), 'hidden by 3 pixels, measured inside').toMatch(CLIP_REFUSAL);
  });
});

describe('clips inside one another', () => {
  const nested = (outer: string, inner: string, drawn: string): string =>
    svgOf(
      `<defs><clipPath id="a"><path d="${outer}"/></clipPath><clipPath id="b"><path d="${inner}"/></clipPath></defs>` +
        `<g clip-path="url(#a)"><g clip-path="url(#b)">${drawn}</g></g>`
    );

  it('each cut: a line is cut at every clip it reaches past', () => {
    const outer = 'M 0 0 L 100 0 L 100 100 L 0 100 Z';
    const inner = 'M 50 0 L 200 0 L 200 100 L 50 100 Z';
    expect(dxfOf(nested(outer, inner, stroke('M 60 10 L 99 10'))).entities).toHaveLength(1);
    expect(linesOf(nested(outer, inner, stroke('M 60 10 L 110 10'))), 'past the outer').toEqual([
      [
        [60, 90],
        [100, 90],
      ],
    ]);
    expect(linesOf(nested(outer, inner, stroke('M 40 10 L 110 10'))), 'past both').toEqual([
      [
        [50, 90],
        [100, 90],
      ],
    ]);
  });

  it('cut to their intersection with no tolerance, since the distance to an intersection has no bound', () => {
    const below = 'M 0 0 L 200 0 L 200 50 L 0 50 Z';
    const above = 'M 0 50.8 L 200 50.8 L 200 100 L 0 100 Z';
    const between = stroke('M 10 50.4 L 190 50.4');
    expect(dxfOf(svgOf(`<defs>${pathClip(below)}</defs><g clip-path="url(#c)">${between}</g>`)).entities, 'one clip').toHaveLength(1);
    expect(refusal(nested(below, above, between)), 'an empty intersection hides the line').toMatch(/draws no vector geometry/);
    const outer = 'M 0 0 L 100 0 L 100 100 L 0 100 Z';
    const inner = 'M 50 0 L 200 0 L 200 100 L 50 100 Z';
    expect(linesOf(nested(outer, inner, stroke('M 60 10 L 100.5 10')))).toEqual([
      [
        [60, 90],
        [100, 90],
      ],
    ]);
  });

  it('refuse a line that reaches past a nested clip that is not convex', () => {
    const lShape = 'M 0 0 L 100 0 L 100 40 L 40 40 L 40 80 L 0 80 Z';
    expect(refusal(nested('M 0 0 L 190 0 L 190 100 L 0 100 Z', lShape, stroke('M 10 10 L 80 60')))).toMatch(
      /clip-path "url\(#b\)" is not supported: a drawn path reaches 20 pixels past it, and a path under more than one clip must be inside each of them, and only a clip of one convex polygon is cut\.$/
    );
  });

  it('end with their element: what is drawn after the group is not clipped', () => {
    const svg = svgOf(`<defs>${pathClip(BOX)}</defs><g clip-path="url(#c)">${stroke('M 60 30 L 140 30')}</g>${stroke('M 10 90 L 190 90')}`);
    expect(dxfOf(svg).entities).toHaveLength(2);
  });

  it(`are at most ${MAX_ACTIVE_CLIPS} deep`, () => {
    const depth = (n: number): string =>
      svgOf(`<defs>${pathClip('M 0 0 L 190 0 L 190 100 L 0 100 Z')}</defs>${'<g clip-path="url(#c)">'.repeat(n)}${stroke('M 10 10 L 20 10')}${'</g>'.repeat(n)}`);
    expect(dxfOf(depth(MAX_ACTIVE_CLIPS)).entities).toHaveLength(1);
    expect(refusal(depth(MAX_ACTIVE_CLIPS + 1))).toMatch(/nested more than/);
  });
});

describe('a clip that cannot be computed exactly', () => {
  const drawn = stroke('M 60 30 L 140 30');
  const cases: [string, string, RegExp][] = [
    ['objectBoundingBox units', clipOf('<rect x="0" y="0" width="1" height="1"/>', 'clipPathUnits="objectBoundingBox"'), /objectBoundingBox/],
    ['a clip on a shape of the clip', clipOf('<rect x="0" y="0" width="200" height="100" clip-path="url(#d)"/>'), /clip-path/],
    ['a clip on the <clipPath>', clipOf('<rect x="0" y="0" width="200" height="100"/>', 'clip-path="url(#d)"'), /clip-path/],
    ['a <text> shape', clipOf('<text x="0" y="50">A</text>'), /<text>/],
    ['a <use> shape', clipOf('<use href="#d"/>'), /<use>/],
    ['a group in the clip', clipOf('<g><rect x="0" y="0" width="200" height="100"/></g>'), /<g>/],
  ];

  it.each(cases)('stays refused: %s', (_name, clip, reason) => {
    const refused = refusal(clipped(clip, drawn));
    expect(refused).toMatch(CLIP_REFUSAL);
    expect(refused).toMatch(reason);
  });

  it('stays refused when the clip is missing, is not a <clipPath> or is not a URL reference', () => {
    expect(refusal(svgOf(`<g clip-path="url(#c)">${drawn}</g>`))).toMatch(CLIP_REFUSAL);
    expect(refusal(svgOf(`<rect id="c" width="200" height="100"/><g clip-path="url(#c)">${drawn}</g>`))).toMatch(/is not a <clipPath>/);
    expect(refusal(svgOf(`<g clip-path="inset(10px)">${drawn}</g>`))).toMatch(/clip-path "inset\(10px\)" is not supported/);
  });

  it('stays refused for the root element', () => {
    expect(refusal(svgOf(`<defs>${pathClip(BOX)}</defs><g clip-path="url(#c)">${drawn}</g>`).replace('<svg ', '<svg clip-path="url(#c)" '))).toMatch(/clip-path/);
  });

  it('hides everything when it holds no shape, a hidden shape or a shape with no area', () => {
    for (const clip of [clipOf(''), clipOf('<rect x="0" y="0" width="200" height="100" display="none"/>'), pathClip('M 10 50 L 190 50 L 100 50 Z'), pathClip('M 10 50 L 190 50')]) {
      expect(refusal(clipped(clip, drawn)), clip).toMatch(/hides everything|reaches/);
    }
  });

  it('is refused when two of its edges lie on one another, since such an edge may border nothing and the nearest edge is not then the region', () => {
    const spike = 'M 0 0 H 200 V 50 H 120 V 95 V 50 H 0 Z';
    expect(refusal(clipped(pathClip(spike), stroke('M 120.5 60 L 120.5 90'))), 'zero-width spike').toMatch(CLIP_REFUSAL);
    const doubled = `${BOX} ${BOX}`;
    expect(refusal(clipped(pathClip(doubled, 'evenodd'), stroke('M 60 21 L 140 21'))), 'a path drawn twice under evenodd').toMatch(CLIP_REFUSAL);
  });

  it('keeps a polygon of no area that still fills: a bow tie under nonzero cuts its reversed half out of a rectangle', () => {
    const rectangleAndBowTie = 'M 0 0 L 200 0 L 200 100 L 0 100 Z M 60 30 L 140 70 L 140 30 L 60 70 Z';
    expect(refusal(clipped(pathClip(rectangleAndBowTie), stroke('M 65 50 L 135 50')))).toMatch(CLIP_REFUSAL);
  });

  it('hides nothing when nothing is drawn under it', () => {
    const svg = svgOf(`<defs>${clipOf('')}</defs><g clip-path="url(#c)"></g>${stroke('M 10 90 L 190 90')}`);
    expect(dxfOf(svg).entities).toHaveLength(1);
  });
});

describe('a bitmap glyph under a clip', () => {
  const glyphPage = (x: number): string =>
    svgOf(
      `<defs>${pathClip(BOX)}<image id="s" x="0" y="0" width="8" height="10" href="data:image/png;base64,AA=="/><mask id="m"><use href="#s"/></mask></defs>` +
        `<g clip-path="url(#c)"><g transform="translate(${x} 60)"><rect x="0" y="-10" width="8" height="10" mask="url(#m)"/></g></g>`
    );

  it('is set aside when its extent is inside the clip and refused when it is not', () => {
    const inside = new BitmapGlyphs(true);
    parseSvgGeometries(glyphPage(60), inside, 'centre-line');
    expect(inside.marks).toHaveLength(1);
    expect(() => parseSvgGeometries(glyphPage(160), new BitmapGlyphs(true), 'centre-line')).toThrow(/clip-path "url\(#c\)" is not supported/);
  });
});

describe('hostile clips', () => {
  const timed = (svg: string): { result: string; ms: number } => {
    const start = performance.now();
    const result = refusal(svg);
    return { result, ms: performance.now() - start };
  };

  it('a clip path of a million vertices is refused inside the budget of the vertex limit', () => {
    const { result, ms } = timed(clipped(pathClip(`M 0 0${'L1,1'.repeat(1_000_000)}Z`), stroke('M 10 10 L 20 10')));
    expect(result).toMatch(/^CadGeometryUnavailableError: SVG expands to more than 500000 vertices/);
    expectWithinHangGuard('hostile clip', ms, HOSTILE_GUARD);
  });

  it(`a clip path of more than ${MAX_CLIP_EDGES} edges is refused without being measured`, () => {
    const points = Array.from({ length: MAX_CLIP_EDGES + 1 }, (_, i) => `L ${100 + 90 * Math.cos(i)} ${50 + 40 * Math.sin(i)}`).join(' ');
    const { result, ms } = timed(clipped(pathClip(`M 0 0 ${points} Z`), stroke('M 10 10 L 20 10')));
    expect(result).toMatch(CLIP_REFUSAL);
    expect(result).toMatch(/more than 1024 edges/);
    expectWithinHangGuard('hostile clip', ms, HOSTILE_GUARD);
  });

  it('a clip referenced by 30,000 elements is read once and measured for each', () => {
    const drawn = Array.from({ length: 30_000 }, (_, i) => `<g clip-path="url(#c)">${stroke(`M ${60 + (i % 80)} 30 L ${61 + (i % 80)} 31`)}</g>`).join('');
    const start = performance.now();
    const dxf = dxfOf(svgOf(`<defs>${pathClip(BOX)}</defs>${drawn}`));
    expect(dxf.entities).toHaveLength(30_000);
    expectWithinHangGuard('hostile clip', performance.now() - start, HOSTILE_GUARD);
  });

  it('a clip placed under an element is charged for every point it moves, also where a singular matrix leaves it no edge', () => {
    const ring = Array.from({ length: MAX_CLIP_EDGES - 1 }, (_, i) => `L ${100 + 90 * Math.cos(i * 0.006)} ${50 + 40 * Math.sin(i * 0.006)}`).join(' ');
    const placements = '<g clip-path="url(#c)"></g>'.repeat(80_000);
    const svg = svgOf(`<defs>${pathClip(`M 100 0 ${ring} Z`)}</defs><g transform="matrix(1 0 0 0 0 0)">${placements}</g>${stroke('M 10 90 L 190 90')}`);
    const { result, ms } = timed(svg);
    expect(result).toMatch(/^CadGeometryUnavailableError: SVG clip-path work exceeds/);
    expectWithinHangGuard('hostile clip', ms, HOSTILE_GUARD);
  });

  it('a refusal quotes at most 40 characters of a value', () => {
    const long = 'x'.repeat(100_000);
    for (const svg of [svgOf(`<g clip-path="url(#${long})">${stroke('M 60 30 L 140 30')}</g>`), clipped(clipOf('<rect x="40" y="20" width="120" height="60"/>', `clipPathUnits="${long}"`), stroke('M 60 30 L 140 30'))]) {
      const result = refusal(svg);
      expect(result).toMatch(/^ConversionFailedError: The page cannot be written as DXF: SVG clip-path "url\(#(c\)|x{35}\.\.\.)" is not supported: /);
      expect(result.length).toBeLessThan(400);
    }
  });

  it('a clip of the most edges against the most vertices stops at the work limit', () => {
    const clip = pathClip(`M 100 0 ${Array.from({ length: MAX_CLIP_EDGES - 1 }, (_, i) => `L ${100 + 90 * Math.cos(i * 0.006)} ${50 + 40 * Math.sin(i * 0.006)}`).join(' ')} Z`);
    const line = `M 100 50${' L 100 51 L 101 51'.repeat(500)}`;
    const drawn = Array.from({ length: 400 }, () => stroke(line)).join('');
    const { result, ms } = timed(clipped(clip, drawn));
    expect(result).toMatch(/^CadGeometryUnavailableError: SVG clip-path work exceeds/);
    expectWithinHangGuard('hostile clip', ms, HOSTILE_GUARD);
  });

  it('a page with as many edge tests as the heaviest real page needed is written, not stopped at the work limit', () => {
    const notched = Array.from({ length: 134 }, (_, i) => {
      const [radiusX, radiusY] = i % 2 === 0 ? [90, 40] : [40, 15];
      const angle = (i * 2 * Math.PI) / 134;
      return `${100 + radiusX * Math.sin(angle)} ${50 - radiusY * Math.cos(angle)}`;
    });
    const dxf = dxfOf(clipped(pathClip(`M ${notched.join(' L ')} Z`), stroke(`M 100 50${' L 100 51 L 101 51'.repeat(4500)}`)));
    expect(dxf.entities).toHaveLength(1);
  });

  it.each([
    ['a NaN coordinate', pathClip('M NaN 0 L 10 0 L 10 10 Z')],
    ['an Infinity coordinate', pathClip('M Infinity 0 L 10 0 L 10 10 Z')],
    ['an overflowing coordinate', pathClip('M 0 0 L 1e999 0 L 10 10 Z')],
    ['an overflowing rect', clipOf('<rect x="0" y="0" width="1e999" height="10"/>')],
    ['an overflowing transform', clipOf('<rect x="0" y="0" width="10" height="10" transform="scale(1e308)"/>')],
    ['a zero matrix', clipOf('<rect x="0" y="0" width="10" height="10" transform="matrix(0 0 0 0 0 0)"/>')],
  ])('%s is refused', (_name, clip) => {
    const { result, ms } = timed(clipped(clip, stroke('M 60 30 L 140 30')));
    expect(result).not.toBe('converted');
    expectWithinHangGuard('hostile clip', ms, HOSTILE_GUARD);
  });

  it('a clip and a drawing past a billion device pixels are refused, where their distance would be NaN', () => {
    const huge = clipOf('<rect x="10" y="10" width="1e200" height="1e200"/>');
    const { result, ms } = timed(clipped(huge, stroke('M -1e150 1e150 L -1e150 1.5e150')));
    expect(result).toMatch(/^CadGeometryUnavailableError: SVG clip-path .*1000000000 device pixels/);
    expectWithinHangGuard('hostile clip', ms, HOSTILE_GUARD);
    expect(refusal(clipped(pathClip(BOX), stroke('M 60 30 L 2e9 30')))).not.toBe('converted');
  });

  it('a line that crosses a cutting clip at every vertex is cut inside the time limit, and refused when its pieces pass the vertex limit', () => {
    const zigzag = (count: number): string => stroke(`M 60 30${Array.from({ length: count }, (_, i) => ` L ${i % 2 === 0 ? 160 : 140} ${30 + (i % 40) / 1000}`).join('')}`);
    const within = timed(clipped(pathClip(BOX), zigzag(150_000)));
    expect(within.result).toBe('converted');
    expectWithinHangGuard('hostile clip', within.ms, HOSTILE_GUARD);
    expect(dxfOf(clipped(pathClip(BOX), zigzag(1001))).entities).toHaveLength(501);
    const past = timed(clipped(pathClip(BOX), zigzag(400_000)));
    expect(past.result).toMatch(/^CadGeometryUnavailableError: SVG expands to more than 500000 vertices/);
    expectWithinHangGuard('hostile clip', past.ms, HOSTILE_GUARD);
  });

  it('a cut is charged to the work limit as its vertices times the edges of the clip', () => {
    const ring = Array.from({ length: 1000 }, (_, i) => `${100 + 40 * Math.cos((i * 2 * Math.PI) / 1000)} ${50 + 40 * Math.sin((i * 2 * Math.PI) / 1000)}`);
    const clip = pathClip(`M ${ring.join(' L ')} Z`);
    const line = stroke(`M 100 50${' L 100 51 L 101 51'.repeat(2500)} L 190 50`);
    const { result, ms } = timed(clipped(clip, line));
    expect(result).toMatch(/^CadGeometryUnavailableError: SVG clip-path work exceeds/);
    expectWithinHangGuard('hostile clip', ms, HOSTILE_GUARD);
    expect(refusal(clipped(clip, stroke('M 100 50 L 100 51 L 190 50')))).toBe('converted');
  });

  it(`${MAX_ACTIVE_CLIPS} nested clips that each cut leave the line inside all of them`, () => {
    const ids = Array.from({ length: MAX_ACTIVE_CLIPS }, (_, i) => i);
    const defs = ids.map((i) => `<clipPath id="n${i}"><rect x="${10 + i * 5}" y="0" width="${180 - i * 10}" height="100"/></clipPath>`).join('');
    const opening = ids.map((i) => `<g clip-path="url(#n${i})">`).join('');
    const svg = svgOf(`<defs>${defs}</defs>${opening}${stroke('M 0 50 L 200 50')}${'</g>'.repeat(MAX_ACTIVE_CLIPS)}`);
    const start = performance.now();
    expect(linesOf(svg)).toEqual([
      [
        [10 + (MAX_ACTIVE_CLIPS - 1) * 5, 50],
        [190 - (MAX_ACTIVE_CLIPS - 1) * 5, 50],
      ],
    ]);
    expectWithinHangGuard('hostile clip', performance.now() - start, HOSTILE_GUARD);
  });

  it('a clipped element under a transform that overflows is refused', () => {
    expect(refusal(clipped(pathClip(BOX), stroke('M 60 30 L 140 30'), 'transform="scale(1e308)"'))).not.toBe('converted');
  });
});
