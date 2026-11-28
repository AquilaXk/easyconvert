import type { AffineMatrix } from './svg-geometry';

/**
 * Clip paths that clip nothing. An office suite clips the page it exports to the page rectangle, and Poppler writes that as
 * a `clip-path` in the SVG of the page. The geometry readers refuse clipping, because dropping a clip draws what it hides;
 * a clip that is one axis-aligned rectangle covering the whole page hides nothing, so it is the one clip they drop.
 */

interface Point {
  x: number;
  y: number;
}

export interface ClipNode {
  name: string;
  attrs: Map<string, string>;
  children: readonly ClipNode[];
}

/**
 * How far a page-sized clip rectangle may fall short of the page on each side, in device pixels: one point of an SVG sized
 * in points (96 pixels to the inch, 72 points). Poppler's clip for a LibreOffice page falls short by at most 0.76 point
 * (right edge 0.76, bottom 0.59, top 0.46, left none, measured on the real samples), which is 1.01 pixel in the SVG of
 * Poppler 26 (sized in points) and 0.76 in that of Poppler 24 (sized in pixels). A clip that cuts more is a real clip.
 */
export const PAGE_CLIP_TOLERANCE_PIXELS = 96 / 72;
/** A page rectangle is written in a few dozen characters; a longer path is not one, and is not parsed. */
export const MAX_PAGE_CLIP_PATH_CHARS = 512;
const CLIP_URL_PATTERN = /^url\(\s*#([^)\s"']+)\s*\)$/;
const RECTANGLE_CORNERS = 4;
const CORNER_EPSILON = 1e-6;
/** Attributes that change what a clip or its shape clips, or how: any of them makes the clip a real one. */
const CLIP_EFFECT_ATTRIBUTES = ['transform', 'clip-path', 'clipPathUnits', 'style', 'class', 'display', 'visibility'];

/** The only child of a plain `<clipPath>` when it is a short `<path>` or a `<rect>`; no attribute of either may change the clip. */
function plainClipShape(clip: ClipNode | undefined): ClipNode | null {
  if (clip === undefined || clip.name !== 'clipPath' || clip.children.length !== 1) return null;
  const [shape] = clip.children;
  const hasEffect = (node: ClipNode): boolean => CLIP_EFFECT_ATTRIBUTES.some((name) => node.attrs.has(name));
  if (hasEffect(clip) || hasEffect(shape)) return null;
  if (shape.name === 'path') return (shape.attrs.get('d')?.length ?? 0) <= MAX_PAGE_CLIP_PATH_CHARS ? shape : null;
  return shape.name === 'rect' ? shape : null;
}

/** The four corners of a closed outline that is exactly one rectangle with sides parallel to the axes, or null. */
function axisAlignedCorners(points: Point[]): Point[] | null {
  const closed = points.length > 1 && Math.hypot(points[0].x - points[points.length - 1].x, points[0].y - points[points.length - 1].y) < CORNER_EPSILON;
  const corners = closed ? points.slice(0, -1) : points;
  if (corners.length !== RECTANGLE_CORNERS) return null;
  const xs = corners.map((p) => p.x);
  const ys = corners.map((p) => p.y);
  const [minX, maxX, minY, maxY] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const onBoundsCorner = (p: Point): boolean =>
    (Math.abs(p.x - minX) < CORNER_EPSILON || Math.abs(p.x - maxX) < CORNER_EPSILON) &&
    (Math.abs(p.y - minY) < CORNER_EPSILON || Math.abs(p.y - maxY) < CORNER_EPSILON);
  const distinct = new Set(corners.map((p) => `${p.x > minX + CORNER_EPSILON}:${p.y > minY + CORNER_EPSILON}`));
  return corners.every(onBoundsCorner) && distinct.size === RECTANGLE_CORNERS ? corners : null;
}

/**
 * Builds the check for a document: whether `clip-path: url(#id)` on an element drawn under a matrix is one axis-aligned
 * rectangle that reaches within PAGE_CLIP_TOLERANCE_PIXELS of every side of the page. A smaller rectangle, a rounded one,
 * a curve, several shapes, a transformed or styled clip, a long path and a reference to a missing clip stay refused.
 * `outlineOf` parses a clip's shape into user-space subpaths (charging the document's vertex budget); it runs once per clip
 * id however many elements refer to it, so the work does not grow with the number of references.
 */
export function createPageClipCheck(
  ids: ReadonlyMap<string, ClipNode>,
  page: { width: number; height: number },
  outlineOf: (shape: ClipNode) => Point[][] | null
): (value: string, ctm: AffineMatrix) => boolean {
  const cornersOfClip = new Map<string, Point[] | null>();

  const userSpaceCorners = (id: string): Point[] | null => {
    const known = cornersOfClip.get(id);
    if (known !== undefined) return known;
    const shape = plainClipShape(ids.get(id));
    const subpaths = shape === null ? null : outlineOf(shape);
    const corners = subpaths !== null && subpaths.length === 1 ? axisAlignedCorners(subpaths[0]) : null;
    cornersOfClip.set(id, corners);
    return corners;
  };

  return (value, ctm) => {
    const reference = CLIP_URL_PATTERN.exec(value);
    const corners = reference ? userSpaceCorners(reference[1]) : null;
    if (corners === null) return false;
    const device = axisAlignedCorners(corners.map((p) => ({ x: ctm[0] * p.x + ctm[2] * p.y + ctm[4], y: ctm[1] * p.x + ctm[3] * p.y + ctm[5] })));
    if (device === null) return false;
    const xs = device.map((p) => p.x);
    const ys = device.map((p) => p.y);
    return (
      Math.min(...xs) <= PAGE_CLIP_TOLERANCE_PIXELS &&
      Math.max(...xs) >= page.width - PAGE_CLIP_TOLERANCE_PIXELS &&
      Math.min(...ys) <= PAGE_CLIP_TOLERANCE_PIXELS &&
      Math.max(...ys) >= page.height - PAGE_CLIP_TOLERANCE_PIXELS
    );
  };
}
