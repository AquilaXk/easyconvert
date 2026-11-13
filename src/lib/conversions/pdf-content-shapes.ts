import { PDF_CONTENT_MAX_SHAPES_PER_PAGE, PDF_CONTENT_MAX_SHAPE_COORDINATES_PER_PAGE, type PdfContentItem, type PdfContentShape } from './pdf-text-types';

/**
 * The painted paths of a page that are not rules: filled rectangles and outlines with a fill, a stroke or both. The page's
 * operator list gives each painted path with the fill and stroke colour in force; a subpath is classified the way pdfminer.six
 * classifies the paths it paints (`PDFLayoutAnalyzer.paint_path`, MIT): two points are a line, a closed loop of four points
 * with axis-aligned sides is a rectangle and anything else is a curve, here a `path` shape. See docs/licensing.md.
 */

/** pdf.js path codes (its `DrawOPS`). */
export const MOVE_TO = 0;
export const LINE_TO = 1;
export const CURVE_TO = 2;
export const QUADRATIC_TO = 3;
export const CLOSE = 4;
const CURVE_COORDINATES = 6;
const QUADRATIC_COORDINATES = 4;
const POINT_COORDINATES = 2;
/** Coordinates that follow each path code. */
export const COORDINATES_OF: Readonly<Record<number, number>> = {
  [MOVE_TO]: POINT_COORDINATES,
  [LINE_TO]: POINT_COORDINATES,
  [CURVE_TO]: CURVE_COORDINATES,
  [QUADRATIC_TO]: QUADRATIC_COORDINATES,
  [CLOSE]: 0,
};
const RECTANGLE_POINTS = 4;
/** Points that count as one place. */
const COINCIDENT = 0.01;
/** A side this far (points) from the axis is not axis-aligned. */
const AXIS_TOLERANCE = 0.5;
/** A fill smaller than this (points) on both sides is a speck of the page. */
const SPECK = 0.5;
/** A white fill covering this share of the page is the paper. */
const PAPER_SHARE = 0.9;
const WHITE = 0xf0;
const CHANNEL_MASK = 0xff;
const GREEN_SHIFT = 8;
const RED_SHIFT = 16;

type Matrix = readonly [number, number, number, number, number, number];

export interface Point {
  x: number;
  y: number;
}

/** A subpath as the operator list gives it: its end points and, for a shape, its segments in user space. */
export interface Subpath {
  points: Point[];
  closed: boolean;
  /** Segment codes with their coordinates in user space, as pdf.js encodes them; kept only when shapes are read. */
  segments?: number[];
  /** A segment of the subpath is a curve. */
  curved?: boolean;
}

/** For each subpath of a painted path: whether a shape draws its fill, and whether one draws its stroke. */
export interface ShapesDrawn {
  fill: boolean[];
  stroke: boolean[];
}

/** What a path operator paints and with what. */
export interface Paint {
  fill: boolean;
  stroke: boolean;
}

export interface ShapeState {
  ctm: Matrix;
  /** Colours as 0xRRGGBB; null when a pattern or shading is in force. */
  fill: number | null;
  stroke: number | null;
  lineWidth: number;
  fillAlpha: number;
}

interface Viewport {
  width: number;
  height: number;
  convertToViewportPoint(x: number, y: number): [number, number];
}

/** Whether a colour is as light as paper on every channel: text in it is white text on a fill, and a fill in it is the paper. */
export function isLightColour(color: number): boolean {
  return ((color >> RED_SHIFT) & CHANNEL_MASK) >= WHITE && ((color >> GREEN_SHIFT) & CHANNEL_MASK) >= WHITE && (color & CHANNEL_MASK) >= WHITE;
}

/** The viewport points of a subpath's segments, with the number of coordinates they take. */
function pagePath(segments: readonly number[], to: (x: number, y: number) => Point): number[] {
  const out: number[] = [];
  const point = (at: number): void => {
    const p = to(segments[at], segments[at + 1]);
    out.push(p.x, p.y);
  };
  let at = 0;
  while (at < segments.length) {
    const code = segments[at++];
    out.push(code);
    const count = COORDINATES_OF[code] ?? 0;
    for (let i = 0; i < count; i += POINT_COORDINATES) point(at + i);
    at += count;
  }
  return out;
}

const same = (a: Point, b: Point): boolean => Math.abs(a.x - b.x) < COINCIDENT && Math.abs(a.y - b.y) < COINCIDENT;
const near = (a: number, b: number): boolean => Math.abs(a - b) <= AXIS_TOLERANCE;

/** Whether four corners are those of a rectangle with axis-aligned sides. */
function isRectangle(points: readonly Point[]): boolean {
  if (points.length !== RECTANGLE_POINTS) return false;
  const [a, b, c, d] = points;
  return (near(a.x, b.x) && near(b.y, c.y) && near(c.x, d.x) && near(d.y, a.y)) || (near(a.y, b.y) && near(b.x, c.x) && near(c.y, d.y) && near(d.x, a.x));
}

/** Three points on one axis-aligned line. */
const onOneLine = (a: Point, b: Point, c: Point): boolean => (near(a.x, b.x) && near(b.x, c.x)) || (near(a.y, b.y) && near(b.y, c.y));

/**
 * The corners of a closed outline: the points without a last point that repeats the first (a rectangle is drawn as four lines and
 * a line back), repeated points and the points in the middle of a straight side (a producer starts a rectangle half way along a side).
 */
function corners(points: readonly Point[]): Point[] {
  let kept = points.filter((p, i) => i === 0 || !same(p, points[i - 1]));
  if (kept.length > 1 && same(kept[0], kept[kept.length - 1])) kept = kept.slice(0, -1);
  let changed = kept.length > RECTANGLE_POINTS;
  while (changed) {
    changed = false;
    for (let i = 0; i < kept.length && kept.length > RECTANGLE_POINTS; i++) {
      const before = kept[(i + kept.length - 1) % kept.length];
      const after = kept[(i + 1) % kept.length];
      if (onOneLine(before, kept[i], after)) {
        kept = kept.filter((_, j) => j !== i);
        changed = true;
        break;
      }
    }
  }
  return kept;
}

function boxOf(points: readonly Point[]): { x0: number; y0: number; x1: number; y1: number } {
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
}

/** Whether two shapes are one path painted twice: the same box and the same first point (a closing line back to it may be there or not). */
function samePath(a: Omit<PdfContentShape, 'z'>, b: Omit<PdfContentShape, 'z'>): boolean {
  if (!a.path || !b.path) return false;
  const close = (x: number, y: number): boolean => Math.abs(x - y) < COINCIDENT;
  return close(a.x0, b.x0) && close(a.y0, b.y0) && close(a.x1, b.x1) && close(a.y1, b.y1) && close(a.path[1], b.path[1]) && close(a.path[2], b.path[2]);
}

/** Whether every segment of a path of straight lines is horizontal or vertical (a stepped line or a table border drawn as one path). */
function isAxisPolyline(points: readonly Point[], curved: boolean): boolean {
  if (curved) return false;
  return points.every((p, i) => i === 0 || near(p.x, points[i - 1].x) || near(p.y, points[i - 1].y));
}

/** Collects the shapes of one page; the rules of a page are the `RuleCollector`'s. */
export class ShapeCollector {
  readonly shapes: PdfContentShape[] = [];
  private coordinates = 0;

  constructor(private readonly viewport: Viewport) {}

  private toPage = (ctm: Matrix) => (x: number, y: number): Point => {
    const [vx, vy] = this.viewport.convertToViewportPoint(ctm[0] * x + ctm[2] * y + ctm[4], ctm[1] * x + ctm[3] * y + ctm[5]);
    return { x: vx, y: vy };
  };

  private full(): boolean {
    return this.shapes.length >= PDF_CONTENT_MAX_SHAPES_PER_PAGE || this.coordinates >= PDF_CONTENT_MAX_SHAPE_COORDINATES_PER_PAGE;
  }

  /** A fill that is the white paper of the page, not a shape drawn on it. */
  private isPaper(fill: number, box: { x0: number; y0: number; x1: number; y1: number }): boolean {
    return isLightColour(fill) && (box.x1 - box.x0) * (box.y1 - box.y0) >= PAPER_SHARE * this.viewport.width * this.viewport.height;
  }

  private add(shape: Omit<PdfContentShape, 'z'>, z: number): void {
    const previous = this.shapes[this.shapes.length - 1];
    if (previous && mergeInto(previous, shape)) return;
    this.shapes.push({ ...shape, z });
  }

  /**
   * Records the shapes of the subpaths a path operator paints. The result tells, for each subpath, whether a shape draws what the
   * rule collector would turn into rules (the sides of a thin rectangle that is filled, the pieces of a stroked outline that a path
   * shape strokes), so that the rule is not drawn twice.
   */
  paint(subpaths: readonly Subpath[], paint: Paint, state: ShapeState, z: number): ShapesDrawn {
    const to = this.toPage(state.ctm);
    const fill = paint.fill && state.fill !== null && state.fillAlpha > 0 ? state.fill : undefined;
    const drawn: ShapesDrawn = { fill: [], stroke: [] };
    for (const subpath of subpaths) {
      const [fillDrawn, strokeDrawn] = this.paintSubpath(subpath, paint, state, fill, z, to);
      drawn.fill.push(fillDrawn);
      drawn.stroke.push(strokeDrawn);
    }
    return drawn;
  }

  /** Records one subpath; tells whether a shape draws its fill and whether one draws its stroke. */
  private paintSubpath(subpath: Subpath, paint: Paint, state: ShapeState, fill: number | undefined, z: number, to: (x: number, y: number) => Point): [boolean, boolean] {
    if (!subpath.segments || subpath.points.length < RECTANGLE_POINTS - 1 || this.full()) return [false, false];
    const points = subpath.points.map((p) => to(p.x, p.y));
    const outline = corners(points);
    const loop = subpath.closed || paint.fill || same(points[0], points[points.length - 1]);
    const box = boxOf(points);
    if (isRectangle(outline) && subpath.curved !== true && loop) {
      // A rectangle's stroke is four rules.
      if (fill !== undefined) this.addRectangle(box, fill, state.fillAlpha, z);
      return [fill !== undefined, false];
    }
    const curved = subpath.curved === true;
    const stroke = paint.stroke && state.stroke !== null && !(fill === undefined && isAxisPolyline(outline, curved)) ? state.stroke : undefined;
    if (fill === undefined && stroke === undefined) return [false, false];
    if (fill !== undefined && this.isPaper(fill, box)) return [false, false];
    const path = pagePath(subpath.segments, to);
    this.coordinates += path.length;
    this.add(
      {
        kind: 'path',
        ...box,
        ...(fill === undefined ? {} : { fill }),
        ...(stroke === undefined ? {} : { stroke, strokeWidth: strokeWidthOf(state) }),
        ...(fill !== undefined && state.fillAlpha < 1 ? { alpha: state.fillAlpha } : {}),
        path: loop ? closed(path) : path,
      },
      z
    );
    return [false, stroke !== undefined];
  }

  private addRectangle(box: { x0: number; y0: number; x1: number; y1: number }, fill: number, alpha: number, z: number): void {
    if (box.x1 - box.x0 < SPECK && box.y1 - box.y0 < SPECK) return;
    if (this.isPaper(fill, box)) return;
    this.add({ kind: 'rect', ...box, fill, ...(alpha < 1 ? { alpha } : {}) }, z);
  }
}

/** Line width in points under the matrix (the viewport only rotates and flips). */
function strokeWidthOf(state: ShapeState): number {
  return state.lineWidth * Math.sqrt(Math.abs(state.ctm[0] * state.ctm[3] - state.ctm[1] * state.ctm[2]));
}

/** Rectangles that touch with the same fill and height (a producer cuts a highlight at every font change) are one. */
const TOUCH = 0.15;

/** Folds `shape` into the shape before it when they are one drawing: a path filled and then stroked, or two rectangles side by side. */
function mergeInto(previous: PdfContentShape, shape: Omit<PdfContentShape, 'z'>): boolean {
  if (previous.kind === 'path' && shape.kind === 'path' && samePath(previous, shape)) {
    if (previous.stroke === undefined && shape.stroke !== undefined && shape.fill === undefined) {
      previous.stroke = shape.stroke;
      previous.strokeWidth = shape.strokeWidth;
      return true;
    }
    if (previous.fill === undefined && shape.fill !== undefined && shape.stroke === undefined) {
      previous.fill = shape.fill;
      if (shape.alpha !== undefined) previous.alpha = shape.alpha;
      return true;
    }
    return false;
  }
  if (previous.kind !== 'rect' || shape.kind !== 'rect' || previous.fill !== shape.fill || previous.alpha !== shape.alpha) return false;
  if (Math.abs(previous.y0 - shape.y0) > TOUCH || Math.abs(previous.y1 - shape.y1) > TOUCH || shape.x0 > previous.x1 + TOUCH || shape.x1 < previous.x0 - TOUCH) return false;
  previous.x0 = Math.min(previous.x0, shape.x0);
  previous.x1 = Math.max(previous.x1, shape.x1);
  return true;
}

/** A path with its last segment closed (a filled path is closed by the painting operator). */
function closed(path: number[]): number[] {
  return path[path.length - 1] === CLOSE ? path : [...path, CLOSE];
}

/** A box in page points. */
export interface BoxLike {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** A rectangle holds a box when it reaches this far (points) short of its edges. */
const HOLD_SLACK = 3;
/** Fills with an opacity below this are tints over what is behind them, not the colour of the area. */
const MIN_FILL_ALPHA = 0.9;

/** The filled rectangles of a page, to tell which one lies behind a box of text. */
export class FillIndex {
  private readonly rectangles: PdfContentShape[];
  /** The rectangles that were the fill behind some text: a paragraph or cell carries them, so they are not drawn again. */
  readonly used = new Set<PdfContentShape>();

  constructor(shapes: readonly PdfContentShape[] | undefined) {
    this.rectangles = (shapes ?? []).filter((shape) => shape.kind === 'rect' && shape.fill !== undefined && (shape.alpha ?? 1) >= MIN_FILL_ALPHA);
  }

  /** The smallest rectangle that holds the box, the one nearest the text; undefined when none does. */
  rectangleBehind(box: BoxLike): PdfContentShape | undefined {
    let found: PdfContentShape | undefined;
    for (const rectangle of this.rectangles) {
      const holds = rectangle.x0 <= box.x0 + HOLD_SLACK && rectangle.x1 >= box.x1 - HOLD_SLACK && rectangle.y0 <= box.y0 + HOLD_SLACK && rectangle.y1 >= box.y1 - HOLD_SLACK;
      const smaller = !found || (rectangle.x1 - rectangle.x0) * (rectangle.y1 - rectangle.y0) <= (found.x1 - found.x0) * (found.y1 - found.y0);
      // Rectangles painted later lie over the ones before them, so the later of two of one size is the one seen.
      if (holds && smaller) found = rectangle;
    }
    return found;
  }

  /** The fill (0xRRGGBB) of the rectangle behind the box; the rectangle is noted as carried by the text unless `markUsed` is false or it is paper. */
  behind(box: BoxLike, markUsed = true): number | undefined {
    const found = this.rectangleBehind(box);
    if (found && markUsed && !isLightColour(found.fill ?? 0)) this.used.add(found);
    return found?.fill;
  }
}


/** Text in ink shares of the em above and below the baseline, to tell which rectangle holds a run. */
const ASCENT_EM = 0.8;
const DESCENT_EM = 0.2;

/**
 * Notes the fill behind each run of light text (white on a coloured band or badge) on the run itself: the fill that holds the run and
 * is not paper. A reader that cannot carry the fills of the page keeps the light colour only where the run has one.
 */
export function markFillBehindLightText(items: PdfContentItem[], shapes: readonly PdfContentShape[]): void {
  const fills = new FillIndex(shapes);
  for (const item of items) {
    if (!item.colors?.some((stretch) => isLightColour(stretch.color))) continue;
    const box = itemBox(item);
    const holder = fills.rectangleBehind(box);
    if (holder?.fill !== undefined && !isLightColour(holder.fill) && isHighlight(holder, box, item.size)) item.fill = holder.fill;
  }
}

/** The box of a run: its width, and the em above and below its baseline. */
export function itemBox(item: PdfContentItem): BoxLike {
  return { x0: item.x, y0: item.baseline - ASCENT_EM * item.size, x1: item.x + item.width, y1: item.baseline + DESCENT_EM * item.size };
}

/** A rectangle is a highlight of a run when it hugs it: no more than this many ems taller and wider than the run. */
const HIGHLIGHT_EXTRA_HEIGHT_EM = 1.5;
const HIGHLIGHT_EXTRA_WIDTH_EM = 4;

/** Whether a rectangle is the background of the run alone (a badge, a marker), and not a band or a panel that holds other things too. */
function isHighlight(rectangle: PdfContentShape, box: BoxLike, size: number): boolean {
  return rectangle.y1 - rectangle.y0 <= box.y1 - box.y0 + HIGHLIGHT_EXTRA_HEIGHT_EM * size && rectangle.x1 - rectangle.x0 <= box.x1 - box.x0 + HIGHLIGHT_EXTRA_WIDTH_EM * size;
}
