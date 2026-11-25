import { parseColour, type Rgb } from './pdf-content-colours';
import { PDF_CONTENT_MAX_GRADIENT_STOPS, type PdfGradientStop, type PdfLinearGradient } from './pdf-text-types';

export type Matrix = [number, number, number, number, number, number];

export interface Point {
  x: number;
  y: number;
}

export interface RectBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface ClipBox extends RectBox {
  /** True when the clip equals an axis-aligned rectangle (or intersection of rectangles). */
  exactRect: boolean;
}

export interface ShadingRef {
  objId: string;
  matrix: Matrix | null;
}

export type ResolvedShading =
  | { kind: 'gradient'; gradient: PdfLinearGradient }
  | { kind: 'solid'; color: Rgb; alpha: number };

const MATRIX_LEN = 6;
const BBOX_LEN = 4;
const CLIP_EPSILON = 0.1;
const CLIP_OVERLAP_TOL = 0.5;
const AXIS_TOLERANCE = 0.5;
const BOUNDARY_TRANSPARENT_POS = 0.001;
const BOUNDARY_SOLID_POS = 0.002;
const MAX_RAW_STOPS = 4_096;

interface RawStop {
  t: number;
  color: Rgb;
  alpha: number;
  transparent: boolean;
}

function isArrayLikeNumbers(value: unknown, expectedLength: number): value is ArrayLike<number> {
  if (value === null || typeof value !== 'object') return false;
  const arr = value as ArrayLike<unknown>;
  if (arr.length !== expectedLength) return false;
  for (let i = 0; i < expectedLength; i++) {
    const v = arr[i];
    if (typeof v !== 'number' || !Number.isFinite(v)) return false;
  }
  return true;
}

export function matrixFromList(value: unknown): Matrix | null {
  if (!isArrayLikeNumbers(value, MATRIX_LEN)) return null;
  return [value[0], value[1], value[2], value[3], value[4], value[5]];
}

export function boxFromList(value: unknown): [number, number, number, number] | null {
  if (!isArrayLikeNumbers(value, BBOX_LEN)) return null;
  return [value[0], value[1], value[2], value[3]];
}

export function isEmptyClip(clip: ClipBox | null): boolean {
  return clip !== null && (clip.x1 - clip.x0 <= CLIP_EPSILON || clip.y1 - clip.y0 <= CLIP_EPSILON);
}

export function intersectClip(a: ClipBox | null, b: ClipBox): ClipBox {
  if (a === null) return b;
  const x0 = Math.max(a.x0, b.x0);
  const y0 = Math.max(a.y0, b.y0);
  const x1 = Math.max(x0, Math.min(a.x1, b.x1));
  const y1 = Math.max(y0, Math.min(a.y1, b.y1));
  return { x0, y0, x1, y1, exactRect: a.exactRect && b.exactRect };
}

export function transformBBoxToClip(bbox: readonly [number, number, number, number], toPage: (p: Point) => Point): ClipBox | null {
  const [bx0, by0, bx1, by1] = bbox;
  const corners = [toPage({ x: bx0, y: by0 }), toPage({ x: bx1, y: by0 }), toPage({ x: bx1, y: by1 }), toPage({ x: bx0, y: by1 })];
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const pt of corners) {
    if (!Number.isFinite(pt.x) || !Number.isFinite(pt.y)) return null;
    if (pt.x < x0) x0 = pt.x;
    if (pt.y < y0) y0 = pt.y;
    if (pt.x > x1) x1 = pt.x;
    if (pt.y > y1) y1 = pt.y;
  }
  return { x0, y0, x1, y1, exactRect: isAxisAlignedQuad(corners) };
}

function isAxisAlignedQuad(pts: readonly Point[]): boolean {
  if (pts.length !== 4) return false;
  for (let i = 0; i < 4; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % 4];
    const c = pts[(i + 2) % 4];
    const abHoriz = Math.abs(b.y - a.y) <= AXIS_TOLERANCE && Math.abs(b.x - a.x) > CLIP_EPSILON;
    const abVert = Math.abs(b.x - a.x) <= AXIS_TOLERANCE && Math.abs(b.y - a.y) > CLIP_EPSILON;
    const bcHoriz = Math.abs(c.y - b.y) <= AXIS_TOLERANCE && Math.abs(c.x - b.x) > CLIP_EPSILON;
    const bcVert = Math.abs(c.x - b.x) <= AXIS_TOLERANCE && Math.abs(c.y - b.y) > CLIP_EPSILON;
    if (abHoriz && bcVert) continue;
    if (abVert && bcHoriz) continue;
    return false;
  }
  return true;
}

function uniqueCornerLoop(pts: readonly Point[]): Point[] {
  const out: Point[] = [];
  for (const pt of pts) {
    const prev = out[out.length - 1];
    if (!prev || Math.abs(prev.x - pt.x) > 1e-3 || Math.abs(prev.y - pt.y) > 1e-3) out.push(pt);
  }
  if (out.length > 1) {
    const first = out[0];
    const last = out[out.length - 1];
    if (Math.abs(first.x - last.x) <= 1e-3 && Math.abs(first.y - last.y) <= 1e-3) out.pop();
  }
  return out;
}

function segmentCoordinateCount(code: number): number {
  if (code === 0 || code === 1) return 2;
  if (code === 2) return 6;
  if (code === 3) return 4;
  return 0;
}

export function clipBoxOfSubpaths(
  subpaths: readonly { points: readonly Point[]; closed: boolean; curved?: boolean; segments?: readonly number[] }[],
  toPage: (p: Point) => Point
): ClipBox | null {
  if (subpaths.length === 0) return null;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  const firstTransformed: Point[] = [];
  const includePoint = (raw: Point, recordFirst: boolean): boolean => {
    const pt = toPage(raw);
    if (!Number.isFinite(pt.x) || !Number.isFinite(pt.y)) return false;
    if (recordFirst) firstTransformed.push(pt);
    if (pt.x < x0) x0 = pt.x;
    if (pt.y < y0) y0 = pt.y;
    if (pt.x > x1) x1 = pt.x;
    if (pt.y > y1) y1 = pt.y;
    return true;
  };
  for (let s = 0; s < subpaths.length; s++) {
    const sp = subpaths[s];
    if (sp.curved && sp.segments && sp.segments.length > 0) {
      let at = 0;
      while (at < sp.segments.length) {
        const count = segmentCoordinateCount(sp.segments[at++]);
        for (let i = 0; i + 1 < count; i += 2) {
          if (!includePoint({ x: sp.segments[at + i], y: sp.segments[at + i + 1] }, false)) return null;
        }
        at += count;
      }
      continue;
    }
    for (const raw of sp.points) {
      if (!includePoint(raw, s === 0)) return null;
    }
  }
  if (!Number.isFinite(x0)) return null;
  const singleRect =
    subpaths.length === 1 && !subpaths[0].curved && (subpaths[0].closed || firstTransformed.length >= 4) && isAxisAlignedQuad(uniqueCornerLoop(firstTransformed));
  return { x0, y0, x1, y1, exactRect: singleRect };
}

export function boxDisjointFromClip(box: RectBox, clip: ClipBox | null): boolean {
  if (clip === null) return false;
  if (isEmptyClip(clip)) return true;
  if (box.x1 - box.x0 <= CLIP_EPSILON) {
    return box.x0 < clip.x0 - CLIP_OVERLAP_TOL || box.x0 > clip.x1 + CLIP_OVERLAP_TOL || box.y1 <= clip.y0 + 1e-3 || box.y0 >= clip.y1 - 1e-3;
  }
  if (box.y1 - box.y0 <= CLIP_EPSILON) {
    return box.y0 < clip.y0 - CLIP_OVERLAP_TOL || box.y0 > clip.y1 + CLIP_OVERLAP_TOL || box.x1 <= clip.x0 + 1e-3 || box.x0 >= clip.x1 - 1e-3;
  }
  return box.x1 <= clip.x0 + 1e-3 || box.x0 >= clip.x1 - 1e-3 || box.y1 <= clip.y0 + 1e-3 || box.y0 >= clip.y1 - 1e-3;
}

export function clampBoxToClip(box: RectBox, clip: ClipBox | null): RectBox | null {
  if (clip === null) return box;
  const x0 = Math.max(box.x0, clip.x0);
  const y0 = Math.max(box.y0, clip.y0);
  const x1 = Math.min(box.x1, clip.x1);
  const y1 = Math.min(box.y1, clip.y1);
  if (x1 - x0 <= CLIP_EPSILON || y1 - y0 <= CLIP_EPSILON) return null;
  return { x0, y0, x1, y1 };
}

export function clipRule(x0: number, y0: number, x1: number, y1: number, clip: ClipBox | null, minLength: number): [number, number, number, number] | null {
  if (clip === null) return [x0, y0, x1, y1];
  if (isEmptyClip(clip)) return null;
  const horizontal = Math.abs(y1 - y0) <= AXIS_TOLERANCE;
  if (horizontal) {
    if (y1 < clip.y0 - AXIS_TOLERANCE || y0 > clip.y1 + AXIS_TOLERANCE) return null;
    const cx0 = Math.max(x0, clip.x0);
    const cx1 = Math.min(x1, clip.x1);
    return cx1 - cx0 >= minLength ? [cx0, y0, cx1, y1] : null;
  }
  if (x1 < clip.x0 - AXIS_TOLERANCE || x0 > clip.x1 + AXIS_TOLERANCE) return null;
  const cy0 = Math.max(y0, clip.y0);
  const cy1 = Math.min(y1, clip.y1);
  return cy1 - cy0 >= minLength ? [x0, cy0, x1, cy1] : null;
}

export function shadingViewportBox(
  ir: unknown,
  clip: ClipBox | null,
  pageWidth: number,
  pageHeight: number,
  toPage: (p: Point) => Point
): RectBox | null {
  let box: ClipBox = { x0: 0, y0: 0, x1: pageWidth, y1: pageHeight, exactRect: true };
  if (clip !== null) box = intersectClip(box, clip);
  if (Array.isArray(ir)) {
    const bbox = boxFromList(ir[2]);
    if (bbox !== null) {
      const transformed = transformBBoxToClip(bbox, toPage);
      if (transformed === null) return null;
      box = intersectClip(box, transformed);
    }
  }
  if (box.x1 - box.x0 <= CLIP_OVERLAP_TOL || box.y1 - box.y0 <= CLIP_OVERLAP_TOL) return null;
  return { x0: box.x0, y0: box.y0, x1: box.x1, y1: box.y1 };
}

function parseRawStops(rawStops: unknown, fillAlpha: number): RawStop[] {
  if (!Array.isArray(rawStops) || rawStops.length === 0) return [];
  const count = Math.min(rawStops.length, MAX_RAW_STOPS);
  const parsed: RawStop[] = [];
  for (let i = 0; i < count; i++) {
    const entry = rawStops[i];
    if (!Array.isArray(entry) || typeof entry[0] !== 'number' || !Number.isFinite(entry[0])) continue;
    const t = Math.min(1, Math.max(0, entry[0]));
    if (entry[1] === 'transparent') {
      parsed.push({ t, color: 0, alpha: 0, transparent: true });
    } else {
      const rgb = parseColour(entry[1]);
      if (rgb !== null) parsed.push({ t, color: rgb, alpha: fillAlpha, transparent: false });
    }
  }
  parsed.sort((a, b) => a.t - b.t);
  return trimBoundaryTransparent(parsed);
}

function trimBoundaryTransparent(stops: RawStop[]): RawStop[] {
  if (stops.length >= 2 && stops[0].transparent && stops[0].t <= BOUNDARY_TRANSPARENT_POS && !stops[1].transparent && stops[1].t <= BOUNDARY_SOLID_POS) {
    stops.shift();
    stops[0] = { ...stops[0], t: 0 };
  }
  if (stops.length >= 2) {
    const last = stops[stops.length - 1];
    const prev = stops[stops.length - 2];
    if (last.transparent && last.t >= 1 - BOUNDARY_TRANSPARENT_POS && !prev.transparent && prev.t >= 1 - BOUNDARY_SOLID_POS) {
      stops.pop();
      stops[stops.length - 1] = { ...stops[stops.length - 1], t: 1 };
    }
  }
  // Resolve RGB of any true fade-to-transparent stop from its nearest opaque neighbour so DrawingML never fades through black.
  for (let i = 0; i < stops.length; i++) {
    if (!stops[i].transparent) continue;
    const fallback = nearestSolidColour(stops, i);
    if (fallback === null) return [];
    stops[i] = { ...stops[i], color: fallback };
  }
  return stops;
}

function nearestSolidColour(stops: readonly RawStop[], index: number): Rgb | null {
  for (let delta = 1; delta < stops.length; delta++) {
    const right = index + delta;
    if (right < stops.length && !stops[right].transparent) return stops[right].color;
    const left = index - delta;
    if (left >= 0 && !stops[left].transparent) return stops[left].color;
  }
  return null;
}

function lerpChannel(a: number, b: number, k: number, shift: number): number {
  const ca = (a >> shift) & 0xff;
  const cb = (b >> shift) & 0xff;
  return Math.round(ca + (cb - ca) * k) & 0xff;
}

function sampleStopsAt(stops: readonly RawStop[], t: number): PdfGradientStop {
  if (t <= stops[0].t) return { pos: 0, color: stops[0].color, ...(stops[0].alpha < 1 ? { alpha: stops[0].alpha } : {}) };
  const last = stops[stops.length - 1];
  if (t >= last.t) return { pos: 1, color: last.color, ...(last.alpha < 1 ? { alpha: last.alpha } : {}) };
  for (let i = 0; i < stops.length - 1; i++) {
    const a = stops[i];
    const b = stops[i + 1];
    if (t <= b.t) {
      const span = b.t - a.t;
      const k = span > 1e-6 ? (t - a.t) / span : 0;
      const r = lerpChannel(a.color, b.color, k, 16);
      const g = lerpChannel(a.color, b.color, k, 8);
      const bl = lerpChannel(a.color, b.color, k, 0);
      const alpha = a.alpha + (b.alpha - a.alpha) * k;
      return { pos: 0, color: (r << 16) | (g << 8) | bl, ...(alpha < 1 - 1e-4 ? { alpha: Number(alpha.toFixed(4)) } : {}) };
    }
  }
  return { pos: 1, color: last.color, ...(last.alpha < 1 ? { alpha: last.alpha } : {}) };
}

function remapStopsToBox(stops: readonly RawStop[], sMin: number, sMax: number): PdfGradientStop[] {
  const span = sMax - sMin;
  const mapped: PdfGradientStop[] = [];
  const cropStart = sMin > 1e-4;
  const cropEnd = sMax < 1 - 1e-4;
  if (cropStart) mapped.push({ ...sampleStopsAt(stops, sMin), pos: 0 });
  for (const s of stops) {
    if (cropStart && s.t <= sMin + 1e-5) continue;
    if (cropEnd && s.t >= sMax - 1e-5) continue;
    const pos = Math.min(1, Math.max(0, (s.t - sMin) / span));
    const entry: PdfGradientStop = { pos: Number(pos.toFixed(5)), color: s.color, ...(s.alpha < 1 - 1e-4 ? { alpha: Number(s.alpha.toFixed(4)) } : {}) };
    const prev = mapped[mapped.length - 1];
    if (prev && Math.abs(prev.pos - entry.pos) <= 1e-5 && prev.color === entry.color && prev.alpha === entry.alpha) continue;
    mapped.push(entry);
  }
  if (cropEnd) {
    const endSample = { ...sampleStopsAt(stops, sMax), pos: 1 };
    const prev = mapped[mapped.length - 1];
    if (!prev || Math.abs(prev.pos - 1) > 1e-5 || prev.color !== endSample.color || prev.alpha !== endSample.alpha) mapped.push(endSample);
  }
  if (mapped.length > 0 && mapped[0].pos > 1e-4) mapped.unshift({ ...mapped[0], pos: 0 });
  if (mapped.length > 0 && mapped[mapped.length - 1].pos < 1 - 1e-4) mapped.push({ ...mapped[mapped.length - 1], pos: 1 });
  if (mapped.length <= PDF_CONTENT_MAX_GRADIENT_STOPS) return mapped;
  const reduced: PdfGradientStop[] = [];
  const maxIdx = PDF_CONTENT_MAX_GRADIENT_STOPS - 1;
  for (let i = 0; i <= maxIdx; i++) {
    reduced.push(mapped[Math.round((i / maxIdx) * (mapped.length - 1))]);
  }
  return reduced;
}

function solidFromSample(sample: PdfGradientStop): ResolvedShading | null {
  const alpha = sample.alpha ?? 1;
  return alpha <= 0 ? null : { kind: 'solid', color: sample.color, alpha };
}

function gradientNormal(
  dx: number,
  dy: number,
  vp0: Point,
  vp1: Point,
  toViewport: (p: Point) => Point
): { wx: number; wy: number } | null {
  const d2 = dx * dx + dy * dy;
  if (!Number.isFinite(d2) || d2 < 1e-6) return null;
  const o = toViewport({ x: 0, y: 0 });
  const ex = toViewport({ x: 1, y: 0 });
  const ey = toViewport({ x: 0, y: 1 });
  const a = ex.x - o.x;
  const b = ex.y - o.y;
  const c = ey.x - o.x;
  const d = ey.y - o.y;
  const det = a * d - b * c;
  if (Number.isFinite(det) && Math.abs(det) >= 1e-9) {
    const wx = (d * dx - b * dy) / (det * d2);
    const wy = (-c * dx + a * dy) / (det * d2);
    if (Number.isFinite(wx) && Number.isFinite(wy) && Math.hypot(wx, wy) >= 1e-9) return { wx, wy };
  }
  const vx = vp1.x - vp0.x;
  const vy = vp1.y - vp0.y;
  const len2 = vx * vx + vy * vy;
  if (!Number.isFinite(len2) || len2 < 1e-6) return null;
  return { wx: vx / len2, wy: vy / len2 };
}

export function axialShadingGradient(
  ir: unknown,
  box: RectBox,
  toViewport: (p: Point) => Point,
  fillAlpha: number
): ResolvedShading | null {
  if (!Array.isArray(ir) || ir[0] !== 'RadialAxial' || ir[1] !== 'axial') return null;
  if (fillAlpha <= 0) return null;
  const stops = parseRawStops(ir[3], Math.min(1, Math.max(0, fillAlpha)));
  if (stops.length === 0) return null;
  if (!isArrayLikeNumbers(ir[4], 2) || !isArrayLikeNumbers(ir[5], 2)) return null;
  const vp0 = toViewport({ x: ir[4][0], y: ir[4][1] });
  const vp1 = toViewport({ x: ir[5][0], y: ir[5][1] });
  if (!Number.isFinite(vp0.x) || !Number.isFinite(vp0.y) || !Number.isFinite(vp1.x) || !Number.isFinite(vp1.y)) return null;
  const normal = gradientNormal(ir[5][0] - ir[4][0], ir[5][1] - ir[4][1], vp0, vp1, toViewport);
  if (normal === null) {
    const last = stops[stops.length - 1];
    return last.alpha <= 0 ? null : { kind: 'solid', color: last.color, alpha: last.alpha };
  }
  const { wx, wy } = normal;
  const sMin = ((wx >= 0 ? box.x0 : box.x1) - vp0.x) * wx + ((wy >= 0 ? box.y0 : box.y1) - vp0.y) * wy;
  const sMax = ((wx >= 0 ? box.x1 : box.x0) - vp0.x) * wx + ((wy >= 0 ? box.y1 : box.y0) - vp0.y) * wy;
  if (!Number.isFinite(sMin) || !Number.isFinite(sMax)) return null;
  if (sMax <= 0) return solidFromSample(sampleStopsAt(stops, 0));
  if (sMin >= 1) return solidFromSample(sampleStopsAt(stops, 1));
  if (sMax - sMin < 1e-6) return solidFromSample(sampleStopsAt(stops, Math.min(1, Math.max(0, sMin))));
  const boxStops = remapStopsToBox(stops, sMin, sMax);
  if (boxStops.length === 0) return null;
  const first = boxStops[0];
  if (boxStops.every((s) => s.color === first.color && s.alpha === first.alpha)) return solidFromSample(first);
  const angleDeg = Number((((Math.atan2(wy, wx) * 180) / Math.PI + 360) % 360).toFixed(3));
  return { kind: 'gradient', gradient: { kind: 'linear', angleDeg, stops: boxStops } };
}
