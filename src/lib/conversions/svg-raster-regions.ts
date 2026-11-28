import type { UnsupportedOptionError } from '../types';
import type { SvgGeometryElement } from './svg-geometry';

/**
 * The parts of a page that a metafile writer cannot draw, kept as rectangles the page's picture stands for instead. This is the
 * analysis half of the fallback that cairo's paginated surfaces use for a vector target that lacks an operation: the operations
 * the target cannot take add their extents to an unsupported region, the rest is written natively, and the region is painted last as
 * an image of the page cut to it (`cairo-analysis-surface.c` `_add_operation`, `cairo-paginated-surface.c` `_paint_page`).
 */

/** A rectangle in device pixels of the page (96 per inch, origin at the top left); `x1` and `y1` are the far edges. */
export interface PixelRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** What a reader refused, as far as it decides how the office suite would have drawn it. */
export type RefusalKind = 'clip' | 'mask' | 'filter' | 'paint-server' | 'picture' | 'dash' | 'transparency' | 'pen' | 'other';

const REFUSAL_KIND_PATTERNS: readonly (readonly [RegExp, RefusalKind])[] = [
  [/^SVG clip-path /, 'clip'],
  [/^SVG mask /, 'mask'],
  [/^SVG filter /, 'filter'],
  [/paint server/, 'paint-server'],
  [/^SVG element <image> /, 'picture'],
  [/^SVG stroke-dasharray /, 'dash'],
  [/^Semi-transparent SVG colour |^SVG (?:opacity|fill-opacity|stroke-opacity) /, 'transparency'],
  [/^Stroked SVG <|^(?:EMF|WMF|CGM) cannot reproduce an SVG miter|^SVG stroke-line(?:cap|join) /, 'pen'],
];

/** The kind of a refusal of the SVG readers, by what their message names. */
export function refusalKindOf(error: UnsupportedOptionError): RefusalKind {
  return REFUSAL_KIND_PATTERNS.find(([pattern]) => pattern.test(error.message))?.[1] ?? 'other';
}

/** Regions beyond this many are joined, the two whose union adds the least area first: each is a bitmap record and a render of its own. */
export const MAX_RASTER_REGIONS = 24;
/** Regions closer than this (device pixels) are one: a gap that small holds a seam of the two bitmaps and nothing worth a vector. */
const MERGE_GAP_PX = 2;
/** Room, in device pixels, added to every side so the edge pixels of a shape are in its bitmap. */
const EDGE_PX = 1;

function area(rect: PixelRect): number {
  return (rect.x1 - rect.x0) * (rect.y1 - rect.y0);
}

function union(a: PixelRect, b: PixelRect): PixelRect {
  return { x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) };
}

function touches(a: PixelRect, b: PixelRect): boolean {
  return a.x0 <= b.x1 + MERGE_GAP_PX && b.x0 <= a.x1 + MERGE_GAP_PX && a.y0 <= b.y1 + MERGE_GAP_PX && b.y0 <= a.y1 + MERGE_GAP_PX;
}

/** The rectangle of a device extent grown by a pen's reach, cut to the page and put on whole pixels; null when nothing of it is on the page. */
export function pageRect(extent: PixelRect, page: { width: number; height: number }): PixelRect | null {
  const rect = {
    x0: Math.max(0, Math.floor(extent.x0 - EDGE_PX)),
    y0: Math.max(0, Math.floor(extent.y0 - EDGE_PX)),
    x1: Math.min(Math.ceil(page.width), Math.ceil(extent.x1 + EDGE_PX)),
    y1: Math.min(Math.ceil(page.height), Math.ceil(extent.y1 + EDGE_PX)),
  };
  return rect.x1 > rect.x0 && rect.y1 > rect.y0 ? rect : null;
}

/** The rectangles of a page that its readers refused, joined as they come so no more than `MAX_RASTER_REGIONS` are ever kept. */
export class RasterRegions {
  private readonly pending: PixelRect[] = [];
  readonly kinds = new Set<RefusalKind>();

  private page = { width: 0, height: 0 };

  /** Sets the page the regions are cut to; the reader calls it once it knows the page's size. */
  start(page: { width: number; height: number }): void {
    this.page = page;
  }

  get rects(): readonly PixelRect[] {
    return this.pending;
  }

  /** Adds the extent of a refused element; `undefined` is an extent the reader could not measure, which stands for the whole page. */
  add(extent: PixelRect | undefined, refusal: UnsupportedOptionError): void {
    this.kinds.add(refusalKindOf(refusal));
    const rect = pageRect(extent ?? { x0: 0, y0: 0, x1: this.page.width, y1: this.page.height }, this.page);
    if (!rect) return;
    this.joinInto(rect);
    while (this.pending.length > MAX_RASTER_REGIONS) this.joinCheapestPair();
  }

  /** Puts `rect` among the pending ones, joined with every one it touches. */
  private joinInto(rect: PixelRect): void {
    let merged = rect;
    for (let i = this.pending.length - 1; i >= 0; i--) {
      if (!touches(merged, this.pending[i])) continue;
      merged = union(merged, this.pending[i]);
      this.pending.splice(i, 1);
      i = this.pending.length;
    }
    this.pending.push(merged);
  }

  private joinCheapestPair(): void {
    let best = { cost: Infinity, i: 0, j: 1 };
    for (let i = 0; i < this.pending.length; i++) {
      for (let j = i + 1; j < this.pending.length; j++) {
        const cost = area(union(this.pending[i], this.pending[j])) - area(this.pending[i]) - area(this.pending[j]);
        if (cost < best.cost) best = { cost, i, j };
      }
    }
    const joined = union(this.pending[best.i], this.pending[best.j]);
    this.pending.splice(best.j, 1);
    this.pending.splice(best.i, 1);
    this.joinInto(joined);
  }
}

/** The extent of the points added to it; a mutable box so a walk over a subtree can grow it. */
export class ExtentBox {
  box: PixelRect | undefined;

  include(x: number, y: number, reach = 0): void {
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(reach)) throw new RangeError('The extent of a drawing is not a finite number.');
    const point = { x0: x - reach, y0: y - reach, x1: x + reach, y1: y + reach };
    this.box = this.box ? union(this.box, point) : point;
  }
}

/** How many half widths a pen is taken to reach past a vertex when an element is tested against a region: a bevel, round or square join, a square cap. */
const PEN_REACH_HALF_WIDTHS = 2;

/** The device extent of a drawn element, with the reach of its pen; `undefined` for an element with no point. */
export function elementExtent(element: Pick<SvgGeometryElement, 'subpaths' | 'stroke' | 'strokeWidth'>): PixelRect | undefined {
  const box = new ExtentBox();
  const reach = element.stroke ? (element.strokeWidth * PEN_REACH_HALF_WIDTHS) / 2 : 0;
  for (const sub of element.subpaths) for (const p of sub) box.include(p.x, p.y, reach);
  return box.box;
}

/** Whether `inner` lies wholly inside one of `regions`: what the regions' picture draws, so the element's own records add nothing. */
export function coveredByRegion(inner: PixelRect, regions: readonly PixelRect[]): boolean {
  return regions.some((r) => inner.x0 >= r.x0 && inner.y0 >= r.y0 && inner.x1 <= r.x1 && inner.y1 <= r.y1);
}

const COMPLEXITY_PATTERNS: readonly RegExp[] = [
  /^SVG input exceeds the \d+-character limit/,
  /^SVG expands to more than \d+ (?:rendered elements|vertices)/,
  /^SVG clip-path work exceeds /,
  /does not fit the (?:metafile's \d+-limited field|16-bit metafile range)/,
  /is too large for the 16-bit metafile coordinate range/,
  /^(?:EMF|WMF|CGM) output would exceed \d+ bytes/,
];

/** Whether a refusal says the page has more in it than the vector writers read or hold (not that it is malformed): a picture of the whole page then stands for it. */
export function isTooComplexToDraw(error: Error): boolean {
  return COMPLEXITY_PATTERNS.some((pattern) => pattern.test(error.message));
}

const POINTS_ROOT = /<svg\b[^>]*?\swidth="([-+]?[\d.]+(?:e[-+]?\d+)?)pt"\sheight="([-+]?[\d.]+(?:e[-+]?\d+)?)pt"/i;
const ROOT_SEARCH_CHARS = 4096;
const CSS_PX_PER_POINT = 96 / 72;

/** The size of a page in device pixels from the root of a Poppler SVG (`pageInPoints` has given it points), without reading the rest of the file; undefined when the root does not say. */
export function pageSizeFromRoot(svg: Buffer): { width: number; height: number } | undefined {
  const root = POINTS_ROOT.exec(svg.toString('latin1', 0, ROOT_SEARCH_CHARS));
  const width = Number(root?.[1]) * CSS_PX_PER_POINT;
  const height = Number(root?.[2]) * CSS_PX_PER_POINT;
  return width > 0 && height > 0 && Number.isFinite(width) && Number.isFinite(height) ? { width, height } : undefined;
}
