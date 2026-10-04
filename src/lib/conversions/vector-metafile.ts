import { Point3D, adaptiveTessellateCubicBezier, tessellateSvgArc } from './cad-nurbs';
import { CadGeometryUnavailableError } from '../types';

export interface RgbColor {
  r: number;
  g: number;
  b: number;
}

export interface SvgGeometryElement {
  subpaths: { x: number; y: number }[][];
  isClosed: boolean;
  fill: RgbColor | null;
  stroke: RgbColor | null;
  strokeWidth: number;
}

export interface ViewportTransform {
  minX: number;
  minY: number;
  vbWidth: number;
  vbHeight: number;
  width: number;
  height: number;
}

export interface ParsedSvgVectorDocument {
  width: number;
  height: number;
  elements: SvgGeometryElement[];
}

const NAMED_COLORS: Record<string, RgbColor> = {
  black: { r: 0, g: 0, b: 0 },
  white: { r: 255, g: 255, b: 255 },
  red: { r: 255, g: 0, b: 0 },
  green: { r: 0, g: 128, b: 0 },
  lime: { r: 0, g: 255, b: 0 },
  blue: { r: 0, g: 0, b: 255 },
  yellow: { r: 255, g: 255, b: 0 },
  cyan: { r: 0, g: 255, b: 255 },
  aqua: { r: 0, g: 255, b: 255 },
  magenta: { r: 255, g: 0, b: 255 },
  fuchsia: { r: 255, g: 0, b: 255 },
  gray: { r: 128, g: 128, b: 128 },
  grey: { r: 128, g: 128, b: 128 },
  lightgray: { r: 211, g: 211, b: 211 },
  lightgrey: { r: 211, g: 211, b: 211 },
  darkgray: { r: 169, g: 169, b: 169 },
  darkgrey: { r: 169, g: 169, b: 169 },
  orange: { r: 255, g: 165, b: 0 },
  purple: { r: 128, g: 0, b: 128 },
  navy: { r: 0, g: 0, b: 128 },
  teal: { r: 0, g: 128, b: 128 },
  maroon: { r: 128, g: 0, b: 0 },
  silver: { r: 192, g: 192, b: 192 },
};

function parseHexColor(hexStr: string): RgbColor | null {
  const hex = hexStr.substring(1);
  if (hex.length === 3 || hex.length === 4) {
    const r = Number.parseInt(hex[0] + hex[0], 16);
    const g = Number.parseInt(hex[1] + hex[1], 16);
    const b = Number.parseInt(hex[2] + hex[2], 16);
    return { r, g, b };
  }
  if (hex.length >= 6) {
    const r = Number.parseInt(hex.substring(0, 2), 16);
    const g = Number.parseInt(hex.substring(2, 4), 16);
    const b = Number.parseInt(hex.substring(4, 6), 16);
    return { r, g, b };
  }
  return null;
}

/**
 * Parses CSS / SVG color values into standard RGB components.
 */
export function parseCssColor(colorStr: string | null | undefined): RgbColor | null {
  if (!colorStr) return null;
  const s = colorStr.trim().toLowerCase();
  if (s === 'none' || s === 'transparent' || s === '') return null;

  if (NAMED_COLORS[s]) {
    return { ...NAMED_COLORS[s] };
  }

  if (s.startsWith('#')) {
    const parsedHex = parseHexColor(s);
    if (parsedHex) return parsedHex;
  }

  const rgbRegex = /rgb\s*\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)/;
  const rgbMatch = rgbRegex.exec(s);
  if (rgbMatch) {
    return {
      r: Math.max(0, Math.min(255, Number.parseInt(rgbMatch[1], 10))),
      g: Math.max(0, Math.min(255, Number.parseInt(rgbMatch[2], 10))),
      b: Math.max(0, Math.min(255, Number.parseInt(rgbMatch[3], 10))),
    };
  }

  return { r: 0, g: 0, b: 0 };
}

/**
 * Parses SVG style attributes and direct styling attributes.
 */
function extractStyleMap(tagContent: string): Map<string, string> {
  const map = new Map<string, string>();

  const styleRegex = /style="([^"]*)"/i;
  const styleMatch = styleRegex.exec(tagContent);
  if (styleMatch) {
    const declarations = styleMatch[1].split(';');
    for (const decl of declarations) {
      const colonIdx = decl.indexOf(':');
      if (colonIdx > 0) {
        const key = decl.substring(0, colonIdx).trim().toLowerCase();
        const val = decl.substring(colonIdx + 1).trim();
        if (key && val) map.set(key, val);
      }
    }
  }

  const attrRegex = /\b(fill|stroke|stroke-width)\s*=\s*"([^"]*)"/gi;
  let m: RegExpExecArray | null;
  while ((m = attrRegex.exec(tagContent)) !== null) {
    map.set(m[1].toLowerCase(), m[2].trim());
  }

  return map;
}

/**
 * Resolves element styling into fill, stroke, and strokeWidth.
 */
function resolveElementStyle(
  tagContent: string,
  isClosedShape: boolean
): { fill: RgbColor | null; stroke: RgbColor | null; strokeWidth: number } {
  const styles = extractStyleMap(tagContent);

  const fillStr = styles.get('fill');
  let fill: RgbColor | null = null;
  if (fillStr !== undefined) {
    fill = parseCssColor(fillStr);
  } else if (isClosedShape) {
    fill = { r: 0, g: 0, b: 0 };
  }

  const strokeStr = styles.get('stroke');
  let stroke: RgbColor | null = null;
  if (strokeStr !== undefined) {
    stroke = parseCssColor(strokeStr);
  } else if (!isClosedShape) {
    stroke = { r: 0, g: 0, b: 0 };
  }

  const swStr = styles.get('stroke-width');
  const strokeWidth = swStr ? Math.max(0.5, Number.parseFloat(swStr) || 1.0) : 1.0;

  return { fill, stroke, strokeWidth };
}

function parseViewBoxParams(attrs: string): { minX: number; minY: number; vbWidth: number; vbHeight: number } | null {
  const vbRegex = /viewBox\s*=\s*"([^"]*)"/i;
  const vbMatch = vbRegex.exec(attrs);
  if (!vbMatch) return null;
  const parts = vbMatch[1].trim().split(/[\s,]+/).map((v) => Number.parseFloat(v));
  if (parts.length >= 4 && parts[2] > 0 && parts[3] > 0) {
    return { minX: parts[0], minY: parts[1], vbWidth: parts[2], vbHeight: parts[3] };
  }
  return null;
}

function parseSvgDimensions(svgContent: string): ViewportTransform {
  let width = 800;
  let height = 600;
  let minX = 0;
  let minY = 0;
  let vbWidth = 800;
  let vbHeight = 600;

  const svgTagRegex = /<svg\b([^>]*)>/i;
  const svgTagMatch = svgTagRegex.exec(svgContent);
  if (svgTagMatch) {
    const attrs = svgTagMatch[1];
    const vb = parseViewBoxParams(attrs);
    if (vb) {
      minX = vb.minX;
      minY = vb.minY;
      vbWidth = vb.vbWidth;
      vbHeight = vb.vbHeight;
      width = vbWidth;
      height = vbHeight;
    }

    const wRegex = /\bwidth\s*=\s*"([^"]*)"/i;
    const wMatch = wRegex.exec(attrs);
    if (wMatch) {
      const parsedW = Number.parseFloat(wMatch[1]);
      if (parsedW > 0) width = parsedW;
    }

    const hRegex = /\bheight\s*=\s*"([^"]*)"/i;
    const hMatch = hRegex.exec(attrs);
    if (hMatch) {
      const parsedH = Number.parseFloat(hMatch[1]);
      if (parsedH > 0) height = parsedH;
    }
  }

  return { width, height, minX, minY, vbWidth, vbHeight };
}

function mapPoint(x: number, y: number, vp: ViewportTransform): { x: number; y: number } {
  const tx = vp.vbWidth > 0 ? ((x - vp.minX) / vp.vbWidth) * vp.width : x;
  const ty = vp.vbHeight > 0 ? ((y - vp.minY) / vp.vbHeight) * vp.height : y;
  return { x: tx, y: ty };
}

interface PathState {
  currentX: number;
  currentY: number;
  lastCpX: number;
  lastCpY: number;
}

function handleMoveTo(tokens: string[], i: number, isRel: boolean, state: PathState, currentSubpath: Point3D[]): number {
  if (i + 1 >= tokens.length) return i;
  const x = Number.parseFloat(tokens[i]);
  const y = Number.parseFloat(tokens[i + 1]);
  state.currentX = isRel ? state.currentX + x : x;
  state.currentY = isRel ? state.currentY + y : y;
  state.lastCpX = state.currentX;
  state.lastCpY = state.currentY;
  currentSubpath.push({ x: state.currentX, y: state.currentY, z: 0 });
  return i + 2;
}

function handleLineTo(tokens: string[], i: number, isRel: boolean, state: PathState, currentSubpath: Point3D[]): number {
  if (i + 1 >= tokens.length) return i;
  const x = Number.parseFloat(tokens[i]);
  const y = Number.parseFloat(tokens[i + 1]);
  state.currentX = isRel ? state.currentX + x : x;
  state.currentY = isRel ? state.currentY + y : y;
  state.lastCpX = state.currentX;
  state.lastCpY = state.currentY;
  currentSubpath.push({ x: state.currentX, y: state.currentY, z: 0 });
  return i + 2;
}

function handleHorizLine(tokens: string[], i: number, isRel: boolean, state: PathState, currentSubpath: Point3D[]): number {
  if (i >= tokens.length) return i;
  const x = Number.parseFloat(tokens[i]);
  state.currentX = isRel ? state.currentX + x : x;
  state.lastCpX = state.currentX;
  currentSubpath.push({ x: state.currentX, y: state.currentY, z: 0 });
  return i + 1;
}

function handleVertLine(tokens: string[], i: number, isRel: boolean, state: PathState, currentSubpath: Point3D[]): number {
  if (i >= tokens.length) return i;
  const y = Number.parseFloat(tokens[i]);
  state.currentY = isRel ? state.currentY + y : y;
  state.lastCpY = state.currentY;
  currentSubpath.push({ x: state.currentX, y: state.currentY, z: 0 });
  return i + 1;
}

function handleCubicCurve(
  tokens: string[],
  i: number,
  isRel: boolean,
  state: PathState,
  currentSubpath: Point3D[],
  tolerance: number
): number {
  if (i + 5 >= tokens.length) return i;
  const x1 = Number.parseFloat(tokens[i]);
  const y1 = Number.parseFloat(tokens[i + 1]);
  const x2 = Number.parseFloat(tokens[i + 2]);
  const y2 = Number.parseFloat(tokens[i + 3]);
  const x = Number.parseFloat(tokens[i + 4]);
  const y = Number.parseFloat(tokens[i + 5]);

  const p0: Point3D = { x: state.currentX, y: state.currentY, z: 0 };
  const p1: Point3D = { x: isRel ? state.currentX + x1 : x1, y: isRel ? state.currentY + y1 : y1, z: 0 };
  const p2: Point3D = { x: isRel ? state.currentX + x2 : x2, y: isRel ? state.currentY + y2 : y2, z: 0 };
  const p3: Point3D = { x: isRel ? state.currentX + x : x, y: isRel ? state.currentY + y : y, z: 0 };

  const curvePts = adaptiveTessellateCubicBezier(p0, p1, p2, p3, tolerance);
  for (let k = 1; k < curvePts.length; k++) {
    currentSubpath.push(curvePts[k]);
  }

  state.currentX = p3.x;
  state.currentY = p3.y;
  state.lastCpX = p2.x;
  state.lastCpY = p2.y;
  return i + 6;
}

function handleSmoothCubic(
  tokens: string[],
  i: number,
  isRel: boolean,
  state: PathState,
  currentSubpath: Point3D[],
  cmd: string,
  tolerance: number
): number {
  if (i + 3 >= tokens.length) return i;
  const isPreviousCubic = ['C', 'c', 'S', 's'].includes(cmd);
  const p1X = isPreviousCubic ? 2 * state.currentX - state.lastCpX : state.currentX;
  const p1Y = isPreviousCubic ? 2 * state.currentY - state.lastCpY : state.currentY;
  const x2 = Number.parseFloat(tokens[i]);
  const y2 = Number.parseFloat(tokens[i + 1]);
  const x = Number.parseFloat(tokens[i + 2]);
  const y = Number.parseFloat(tokens[i + 3]);

  const p0: Point3D = { x: state.currentX, y: state.currentY, z: 0 };
  const p1: Point3D = { x: p1X, y: p1Y, z: 0 };
  const p2: Point3D = { x: isRel ? state.currentX + x2 : x2, y: isRel ? state.currentY + y2 : y2, z: 0 };
  const p3: Point3D = { x: isRel ? state.currentX + x : x, y: isRel ? state.currentY + y : y, z: 0 };

  const curvePts = adaptiveTessellateCubicBezier(p0, p1, p2, p3, tolerance);
  for (let k = 1; k < curvePts.length; k++) {
    currentSubpath.push(curvePts[k]);
  }

  state.currentX = p3.x;
  state.currentY = p3.y;
  state.lastCpX = p2.x;
  state.lastCpY = p2.y;
  return i + 4;
}

function handleQuadCurve(
  tokens: string[],
  i: number,
  isRel: boolean,
  state: PathState,
  currentSubpath: Point3D[],
  tolerance: number
): number {
  if (i + 3 >= tokens.length) return i;
  const x1 = Number.parseFloat(tokens[i]);
  const y1 = Number.parseFloat(tokens[i + 1]);
  const x = Number.parseFloat(tokens[i + 2]);
  const y = Number.parseFloat(tokens[i + 3]);

  const p0: Point3D = { x: state.currentX, y: state.currentY, z: 0 };
  const cp: Point3D = { x: isRel ? state.currentX + x1 : x1, y: isRel ? state.currentY + y1 : y1, z: 0 };
  const p2: Point3D = { x: isRel ? state.currentX + x : x, y: isRel ? state.currentY + y : y, z: 0 };

  const p1: Point3D = { x: p0.x + (2 / 3) * (cp.x - p0.x), y: p0.y + (2 / 3) * (cp.y - p0.y), z: 0 };
  const pCubic2: Point3D = { x: p2.x + (2 / 3) * (cp.x - p2.x), y: p2.y + (2 / 3) * (cp.y - p2.y), z: 0 };

  const curvePts = adaptiveTessellateCubicBezier(p0, p1, pCubic2, p2, tolerance);
  for (let k = 1; k < curvePts.length; k++) {
    currentSubpath.push(curvePts[k]);
  }

  state.currentX = p2.x;
  state.currentY = p2.y;
  state.lastCpX = cp.x;
  state.lastCpY = cp.y;
  return i + 4;
}

function handleArcCurve(
  tokens: string[],
  i: number,
  isRel: boolean,
  state: PathState,
  currentSubpath: Point3D[]
): number {
  if (i + 6 >= tokens.length) return i;
  const rx = Number.parseFloat(tokens[i]);
  const ry = Number.parseFloat(tokens[i + 1]);
  const rot = Number.parseFloat(tokens[i + 2]);
  const largeArc = Number.parseFloat(tokens[i + 3]) !== 0;
  const sweep = Number.parseFloat(tokens[i + 4]) !== 0;
  const x = Number.parseFloat(tokens[i + 5]);
  const y = Number.parseFloat(tokens[i + 6]);
  const targetX = isRel ? state.currentX + x : x;
  const targetY = isRel ? state.currentY + y : y;

  const arcPoints = tessellateSvgArc(
    state.currentX,
    state.currentY,
    rx,
    ry,
    rot,
    largeArc,
    sweep,
    targetX,
    targetY
  );

  for (const pt of arcPoints) {
    currentSubpath.push(pt);
  }

  state.currentX = targetX;
  state.currentY = targetY;
  state.lastCpX = state.currentX;
  state.lastCpY = state.currentY;
  return i + 7;
}

/**
 * Parses SVG path 'd' attribute commands into adaptive polyline vertices.
 */
export function parseSvgPathToPoints(d: string, tolerance: number = 0.25): Point3D[][] {
  const subpaths: Point3D[][] = [];
  let currentSubpath: Point3D[] = [];
  const state: PathState = { currentX: 0, currentY: 0, lastCpX: 0, lastCpY: 0 };
  let lastCmd = '';

  const regex = /[MmLlHhVvCcSsQqTtAaZz]|[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g;
  let match: RegExpExecArray | null;
  const tokens: string[] = [];
  while ((match = regex.exec(d)) !== null) {
    tokens.push(match[0]);
  }

  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i];
    if (/^[MmLlHhVvCcSsQqTtAaZz]$/.test(token)) {
      lastCmd = token;
      i++;
    } else if (!lastCmd) {
      i++;
      continue;
    }

    const cmd = lastCmd;
    const isRel = cmd === cmd.toLowerCase();
    const upper = cmd.toUpperCase();

    if (upper === 'M') {
      if (currentSubpath.length > 0) {
        subpaths.push(currentSubpath);
        currentSubpath = [];
      }
      i = handleMoveTo(tokens, i, isRel, state, currentSubpath);
      lastCmd = isRel ? 'l' : 'L';
    } else if (upper === 'L') {
      i = handleLineTo(tokens, i, isRel, state, currentSubpath);
    } else if (upper === 'H') {
      i = handleHorizLine(tokens, i, isRel, state, currentSubpath);
    } else if (upper === 'V') {
      i = handleVertLine(tokens, i, isRel, state, currentSubpath);
    } else if (upper === 'C') {
      i = handleCubicCurve(tokens, i, isRel, state, currentSubpath, tolerance);
    } else if (upper === 'S') {
      i = handleSmoothCubic(tokens, i, isRel, state, currentSubpath, cmd, tolerance);
    } else if (upper === 'Q') {
      i = handleQuadCurve(tokens, i, isRel, state, currentSubpath, tolerance);
    } else if (upper === 'A') {
      i = handleArcCurve(tokens, i, isRel, state, currentSubpath);
    } else if (upper === 'Z') {
      if (currentSubpath.length > 1) {
        const first = currentSubpath[0];
        currentSubpath.push({ x: first.x, y: first.y, z: first.z });
        state.currentX = first.x;
        state.currentY = first.y;
      }
      subpaths.push(currentSubpath);
      currentSubpath = [];
    } else {
      i++;
    }
  }

  if (currentSubpath.length > 0) {
    subpaths.push(currentSubpath);
  }

  return subpaths;
}

export function parseSvgPathToBezierPoints(d: string, tolerance: number = 0.25): Point3D[][] {
  return parseSvgPathToPoints(d, tolerance);
}

function parsePathElements(svgContent: string, vp: ViewportTransform): SvgGeometryElement[] {
  const elements: SvgGeometryElement[] = [];
  const pathRegex = /<path\b([^>]*?)\/?>/gi;
  let pMatch: RegExpExecArray | null;
  while ((pMatch = pathRegex.exec(svgContent)) !== null) {
    const tag = pMatch[1];
    const dRegex = /\bd="([^"]*)"/i;
    const dMatch = dRegex.exec(tag);
    if (!dMatch) continue;
    const dAttr = dMatch[1];
    const { fill, stroke, strokeWidth } = resolveElementStyle(tag, true);
    const rawSubpaths = parseSvgPathToPoints(dAttr, 0.25);
    const subpaths: { x: number; y: number }[][] = [];

    for (const sub of rawSubpaths) {
      if (sub.length < 2) continue;
      subpaths.push(sub.map((pt) => mapPoint(pt.x, pt.y, vp)));
    }

    if (subpaths.length > 0) {
      const isClosed = /[zZ]/.test(dAttr);
      elements.push({ subpaths, isClosed, fill, stroke, strokeWidth });
    }
  }
  return elements;
}

function parseRectElements(svgContent: string, vp: ViewportTransform): SvgGeometryElement[] {
  const elements: SvgGeometryElement[] = [];
  const rectRegex = /<rect\b([^>]*?)\/?>/gi;
  let rMatch: RegExpExecArray | null;
  while ((rMatch = rectRegex.exec(svgContent)) !== null) {
    const tag = rMatch[1];
    const xRegex = /\bx="([^"]*)"/i;
    const yRegex = /\by="([^"]*)"/i;
    const wRegex = /\bwidth="([^"]*)"/i;
    const hRegex = /\bheight="([^"]*)"/i;
    const xMatch = xRegex.exec(tag);
    const yMatch = yRegex.exec(tag);
    const wMatch = wRegex.exec(tag);
    const hMatch = hRegex.exec(tag);
    if (!wMatch || !hMatch) continue;

    const x = xMatch ? Number.parseFloat(xMatch[1]) || 0 : 0;
    const y = yMatch ? Number.parseFloat(yMatch[1]) || 0 : 0;
    const w = Number.parseFloat(wMatch[1]) || 0;
    const h = Number.parseFloat(hMatch[1]) || 0;
    if (w <= 0 || h <= 0) continue;

    const { fill, stroke, strokeWidth } = resolveElementStyle(tag, true);
    const corners = [
      mapPoint(x, y, vp),
      mapPoint(x + w, y, vp),
      mapPoint(x + w, y + h, vp),
      mapPoint(x, y + h, vp),
      mapPoint(x, y, vp),
    ];

    elements.push({ subpaths: [corners], isClosed: true, fill, stroke, strokeWidth });
  }
  return elements;
}

/** Polyline segments used to approximate circles and ellipses. */
const ELLIPSE_SEGMENTS = 36;

function parseCircleElements(svgContent: string, vp: ViewportTransform): SvgGeometryElement[] {
  const elements: SvgGeometryElement[] = [];
  const circleRegex = /<circle\b([^>]*?)\/?>/gi;
  let cMatch: RegExpExecArray | null;
  while ((cMatch = circleRegex.exec(svgContent)) !== null) {
    const tag = cMatch[1];
    const cxRegex = /\bcx="([^"]*)"/i;
    const cyRegex = /\bcy="([^"]*)"/i;
    const rRegex = /\br="([^"]*)"/i;
    const cxMatch = cxRegex.exec(tag);
    const cyMatch = cyRegex.exec(tag);
    const rMatch = rRegex.exec(tag);
    if (!rMatch) continue;

    const cx = cxMatch ? Number.parseFloat(cxMatch[1]) || 0 : 0;
    const cy = cyMatch ? Number.parseFloat(cyMatch[1]) || 0 : 0;
    const r = Number.parseFloat(rMatch[1]) || 0;
    if (r <= 0) continue;

    const { fill, stroke, strokeWidth } = resolveElementStyle(tag, true);
    const pts: { x: number; y: number }[] = [];
    const steps = ELLIPSE_SEGMENTS;
    for (let k = 0; k <= steps; k++) {
      const theta = (k / steps) * 2 * Math.PI;
      pts.push(mapPoint(cx + r * Math.cos(theta), cy + r * Math.sin(theta), vp));
    }

    elements.push({ subpaths: [pts], isClosed: true, fill, stroke, strokeWidth });
  }
  return elements;
}

function parseEllipseElements(svgContent: string, vp: ViewportTransform): SvgGeometryElement[] {
  const elements: SvgGeometryElement[] = [];
  const ellipseRegex = /<ellipse\b([^>]*?)\/?>/gi;
  let eMatch: RegExpExecArray | null;
  while ((eMatch = ellipseRegex.exec(svgContent)) !== null) {
    const tag = eMatch[1];
    const cxRegex = /\bcx="([^"]*)"/i;
    const cyRegex = /\bcy="([^"]*)"/i;
    const rxRegex = /\brx="([^"]*)"/i;
    const ryRegex = /\bry="([^"]*)"/i;
    const cxMatch = cxRegex.exec(tag);
    const cyMatch = cyRegex.exec(tag);
    const rxMatch = rxRegex.exec(tag);
    const ryMatch = ryRegex.exec(tag);
    if (!rxMatch || !ryMatch) continue;

    const cx = cxMatch ? Number.parseFloat(cxMatch[1]) || 0 : 0;
    const cy = cyMatch ? Number.parseFloat(cyMatch[1]) || 0 : 0;
    const rx = Number.parseFloat(rxMatch[1]) || 0;
    const ry = Number.parseFloat(ryMatch[1]) || 0;
    if (rx <= 0 || ry <= 0) continue;

    const { fill, stroke, strokeWidth } = resolveElementStyle(tag, true);
    const pts: { x: number; y: number }[] = [];
    const steps = ELLIPSE_SEGMENTS;
    for (let k = 0; k <= steps; k++) {
      const theta = (k / steps) * 2 * Math.PI;
      pts.push(mapPoint(cx + rx * Math.cos(theta), cy + ry * Math.sin(theta), vp));
    }

    elements.push({ subpaths: [pts], isClosed: true, fill, stroke, strokeWidth });
  }
  return elements;
}

function parseLineElements(svgContent: string, vp: ViewportTransform): SvgGeometryElement[] {
  const elements: SvgGeometryElement[] = [];
  const lineRegex = /<line\b([^>]*?)\/?>/gi;
  let lMatch: RegExpExecArray | null;
  while ((lMatch = lineRegex.exec(svgContent)) !== null) {
    const tag = lMatch[1];
    const x1Regex = /\bx1="([^"]*)"/i;
    const y1Regex = /\by1="([^"]*)"/i;
    const x2Regex = /\bx2="([^"]*)"/i;
    const y2Regex = /\by2="([^"]*)"/i;
    const x1Match = x1Regex.exec(tag);
    const y1Match = y1Regex.exec(tag);
    const x2Match = x2Regex.exec(tag);
    const y2Match = y2Regex.exec(tag);
    if (!x1Match || !y1Match || !x2Match || !y2Match) continue;

    const x1 = Number.parseFloat(x1Match[1]) || 0;
    const y1 = Number.parseFloat(y1Match[1]) || 0;
    const x2 = Number.parseFloat(x2Match[1]) || 0;
    const y2 = Number.parseFloat(y2Match[1]) || 0;

    const { stroke, strokeWidth } = resolveElementStyle(tag, false);
    const p1 = mapPoint(x1, y1, vp);
    const p2 = mapPoint(x2, y2, vp);

    elements.push({ subpaths: [[p1, p2]], isClosed: false, fill: null, stroke, strokeWidth });
  }
  return elements;
}

function parsePolyElements(svgContent: string, vp: ViewportTransform): SvgGeometryElement[] {
  const elements: SvgGeometryElement[] = [];
  const polyRegex = /<(polyline|polygon)\b([^>]*?)\/?>/gi;
  let plMatch: RegExpExecArray | null;
  while ((plMatch = polyRegex.exec(svgContent)) !== null) {
    const isPolyClosed = plMatch[1].toLowerCase() === 'polygon';
    const tag = plMatch[2];
    const ptsRegex = /\bpoints="([^"]*)"/i;
    const ptsMatch = ptsRegex.exec(tag);
    if (!ptsMatch) continue;

    const coords = ptsMatch[1].trim().split(/[\s,]+/).map((v) => Number.parseFloat(v));
    const pts: { x: number; y: number }[] = [];
    for (let k = 0; k + 1 < coords.length; k += 2) {
      if (!Number.isNaN(coords[k]) && !Number.isNaN(coords[k + 1])) {
        pts.push(mapPoint(coords[k], coords[k + 1], vp));
      }
    }
    if (pts.length < 2) continue;

    if (isPolyClosed) {
      pts.push({ x: pts[0].x, y: pts[0].y });
    }

    const { fill, stroke, strokeWidth } = resolveElementStyle(tag, isPolyClosed);
    elements.push({ subpaths: [pts], isClosed: isPolyClosed, fill, stroke, strokeWidth });
  }
  return elements;
}

/**
 * Parses SVG XML into an array of geometry elements with flattened polylines.
 */
export function parseSvgGeometries(svgContent: string): ParsedSvgVectorDocument {
  const vp = parseSvgDimensions(svgContent);
  const elements: SvgGeometryElement[] = [
    ...parsePathElements(svgContent, vp),
    ...parseRectElements(svgContent, vp),
    ...parseCircleElements(svgContent, vp),
    ...parseEllipseElements(svgContent, vp),
    ...parseLineElements(svgContent, vp),
    ...parsePolyElements(svgContent, vp),
  ];

  return { width: vp.width, height: vp.height, elements };
}

const SVG_ROOT_PATTERN = /<svg\b/i;

/**
 * Parses the SVG input for a metafile encoder and fails closed when there is
 * nothing to encode: empty input, a non-SVG payload, or no drawable geometry.
 */
function parseDrawableSvg(svgBuffer: Buffer, targetLabel: string): ParsedSvgVectorDocument {
  if (!svgBuffer || svgBuffer.length === 0) {
    throw new CadGeometryUnavailableError(`${targetLabel} encoding failed: SVG buffer is empty.`);
  }
  const svgText = svgBuffer.toString('utf-8');
  if (!SVG_ROOT_PATTERN.test(svgText)) {
    throw new CadGeometryUnavailableError(`${targetLabel} encoding failed: input is not an SVG document.`);
  }
  const doc = parseSvgGeometries(svgText);
  const hasDrawable = doc.elements.some((el) => el.subpaths.some((sub) => sub.length >= 2));
  if (!hasDrawable) {
    throw new CadGeometryUnavailableError(`${targetLabel} encoding failed: SVG contains no drawable vector geometry.`);
  }
  return doc;
}

// ============================================================================
// EMF ENCODER (MS-EMF Enhanced Metafile)
// ============================================================================

// MS-EMF 2.1.1 RecordType values
const EMR_HEADER = 1;
const EMR_EOF = 14;
const EMR_SETMAPMODE = 17;
const EMR_SETBKMODE = 18;
const EMR_SETPOLYFILLMODE = 19;
const EMR_SELECTOBJECT = 37;
const EMR_CREATEPEN = 38;
const EMR_CREATEBRUSHINDIRECT = 39;
const EMR_DELETEOBJECT = 40;
const EMR_POLYGON16 = 86;
const EMR_POLYLINE16 = 87;
const EMF_MM_TEXT = 1;
const EMF_BK_TRANSPARENT = 1;
const EMF_POLYFILL_WINDING = 2;
const EMF_STOCK_NULL_BRUSH = 0x80000005;
const EMF_STOCK_NULL_PEN = 0x80000008;
const EMF_HEADER_SIZE = 88;
const EMF_EOF_SIZE = 20;
const EMF_VERSION_1_0 = 0x00010000;
/** Object table: index 0 is reserved, the pen uses 1 and the brush 2. */
const EMF_PEN_HANDLE = 1;
const EMF_BRUSH_HANDLE = 2;
const EMF_HANDLE_COUNT = EMF_BRUSH_HANDLE + 1;
/** Reference resolution: CSS pixels at 96 DPI, frame in 0.01 mm units. */
const CSS_PX_PER_INCH = 96;
const MM_PER_INCH = 25.4;
const HUNDREDTHS_MM_PER_PX = (MM_PER_INCH * 100) / CSS_PX_PER_INCH;
const INT16_MAX = 32767;

function clampInt16(value: number): number {
  return Math.max(-INT16_MAX, Math.min(INT16_MAX, Math.round(value)));
}

function createEmfStateRecords(): Buffer[] {
  const mapModeRec = Buffer.alloc(12);
  mapModeRec.writeUInt32LE(EMR_SETMAPMODE, 0);
  mapModeRec.writeUInt32LE(12, 4);
  mapModeRec.writeUInt32LE(EMF_MM_TEXT, 8);

  const bkModeRec = Buffer.alloc(12);
  bkModeRec.writeUInt32LE(EMR_SETBKMODE, 0);
  bkModeRec.writeUInt32LE(12, 4);
  bkModeRec.writeUInt32LE(EMF_BK_TRANSPARENT, 8);

  const fillModeRec = Buffer.alloc(12);
  fillModeRec.writeUInt32LE(EMR_SETPOLYFILLMODE, 0);
  fillModeRec.writeUInt32LE(12, 4);
  fillModeRec.writeUInt32LE(EMF_POLYFILL_WINDING, 8);

  return [mapModeRec, bkModeRec, fillModeRec];
}

function computeBounds(pts: { x: number; y: number }[]): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const pt of pts) {
    if (pt.x < minX) minX = pt.x;
    if (pt.y < minY) minY = pt.y;
    if (pt.x > maxX) maxX = pt.x;
    if (pt.y > maxY) maxY = pt.y;
  }
  return { minX, minY, maxX, maxY };
}

/** MS-EMF 2.1.25 PenStyle: geometric pen type, required for widths other than 1 (LogPen 2.2.19). */
const EMF_PS_GEOMETRIC = 0x00010000;
const EMF_PS_SOLID = 0x00000000;

function encodeEmfPenRecords(stroke: RgbColor | null, strokeWidth: number, outRecords: Buffer[]): boolean {
  if (stroke) {
    const penRec = Buffer.alloc(28);
    penRec.writeUInt32LE(EMR_CREATEPEN, 0);
    penRec.writeUInt32LE(28, 4);
    penRec.writeUInt32LE(EMF_PEN_HANDLE, 8);
    penRec.writeUInt32LE(EMF_PS_GEOMETRIC | EMF_PS_SOLID, 12);
    penRec.writeUInt32LE(Math.max(1, Math.round(strokeWidth)), 16);
    penRec.writeUInt32LE(0, 20);
    penRec.writeUInt32LE((stroke.b << 16) | (stroke.g << 8) | stroke.r, 24);
    outRecords.push(penRec);

    const selPenRec = Buffer.alloc(12);
    selPenRec.writeUInt32LE(EMR_SELECTOBJECT, 0);
    selPenRec.writeUInt32LE(12, 4);
    selPenRec.writeUInt32LE(EMF_PEN_HANDLE, 8);
    outRecords.push(selPenRec);
    return true;
  }

  const selNullPen = Buffer.alloc(12);
  selNullPen.writeUInt32LE(EMR_SELECTOBJECT, 0);
  selNullPen.writeUInt32LE(12, 4);
  selNullPen.writeUInt32LE(EMF_STOCK_NULL_PEN, 8);
  outRecords.push(selNullPen);
  return false;
}

function encodeEmfBrushRecords(fill: RgbColor | null, isClosed: boolean, outRecords: Buffer[]): boolean {
  if (fill && isClosed) {
    const brushRec = Buffer.alloc(24);
    brushRec.writeUInt32LE(EMR_CREATEBRUSHINDIRECT, 0);
    brushRec.writeUInt32LE(24, 4);
    brushRec.writeUInt32LE(EMF_BRUSH_HANDLE, 8);
    brushRec.writeUInt32LE(0, 12); // BS_SOLID
    brushRec.writeUInt32LE((fill.b << 16) | (fill.g << 8) | fill.r, 16);
    brushRec.writeUInt32LE(0, 20); // BrushHatch = 0
    outRecords.push(brushRec);

    const selBrushRec = Buffer.alloc(12);
    selBrushRec.writeUInt32LE(EMR_SELECTOBJECT, 0);
    selBrushRec.writeUInt32LE(12, 4);
    selBrushRec.writeUInt32LE(EMF_BRUSH_HANDLE, 8);
    outRecords.push(selBrushRec);
    return true;
  }

  const selNullBrush = Buffer.alloc(12);
  selNullBrush.writeUInt32LE(EMR_SELECTOBJECT, 0);
  selNullBrush.writeUInt32LE(12, 4);
  selNullBrush.writeUInt32LE(EMF_STOCK_NULL_BRUSH, 8);
  outRecords.push(selNullBrush);
  return false;
}

function encodeEmfDrawRecord(subpath: { x: number; y: number }[], isClosed: boolean): Buffer {
  const bounds = computeBounds(subpath);
  const cpts = subpath.length;
  const recType = isClosed ? EMR_POLYGON16 : EMR_POLYLINE16;
  const recSize = 28 + 4 * cpts;
  const drawRec = Buffer.alloc(recSize);
  drawRec.writeUInt32LE(recType, 0);
  drawRec.writeUInt32LE(recSize, 4);
  drawRec.writeInt32LE(Math.round(bounds.minX), 8);
  drawRec.writeInt32LE(Math.round(bounds.minY), 12);
  drawRec.writeInt32LE(Math.round(bounds.maxX), 16);
  drawRec.writeInt32LE(Math.round(bounds.maxY), 20);
  drawRec.writeUInt32LE(cpts, 24);

  for (let pIdx = 0; pIdx < cpts; pIdx++) {
    const pt = subpath[pIdx];
    drawRec.writeInt16LE(clampInt16(pt.x), 28 + pIdx * 4);
    drawRec.writeInt16LE(clampInt16(pt.y), 28 + pIdx * 4 + 2);
  }
  return drawRec;
}

function deleteEmfObject(handle: number): Buffer {
  const delRec = Buffer.alloc(12);
  delRec.writeUInt32LE(EMR_DELETEOBJECT, 0);
  delRec.writeUInt32LE(12, 4);
  delRec.writeUInt32LE(handle, 8);
  return delRec;
}

function encodeEmfElement(el: SvgGeometryElement, outRecords: Buffer[]) {
  for (const subpath of el.subpaths) {
    if (subpath.length < 2) continue;

    const createdPen = encodeEmfPenRecords(el.stroke, el.strokeWidth, outRecords);
    const createdBrush = encodeEmfBrushRecords(el.fill, el.isClosed, outRecords);

    outRecords.push(encodeEmfDrawRecord(subpath, el.isClosed));

    if (createdPen) outRecords.push(deleteEmfObject(EMF_PEN_HANDLE));
    if (createdBrush) outRecords.push(deleteEmfObject(EMF_BRUSH_HANDLE));
  }
}

/** MS-EMF 2.1.14 FormatSignature ENHMETA_SIGNATURE: the ASCII string " EMF" read as a little-endian UInt32. */
const EMF_ENHMETA_SIGNATURE = 0x464d4520;

function buildEmfHeader(width: number, height: number, totalFileSize: number, totalRecordCount: number): Buffer {
  const headerRec = Buffer.alloc(EMF_HEADER_SIZE);
  headerRec.writeUInt32LE(EMR_HEADER, 0);
  headerRec.writeUInt32LE(EMF_HEADER_SIZE, 4);
  headerRec.writeInt32LE(0, 8); // rclBounds
  headerRec.writeInt32LE(0, 12);
  headerRec.writeInt32LE(width, 16);
  headerRec.writeInt32LE(height, 20);
  headerRec.writeInt32LE(0, 24); // rclFrame
  headerRec.writeInt32LE(0, 28);
  headerRec.writeInt32LE(Math.round(width * HUNDREDTHS_MM_PER_PX), 32);
  headerRec.writeInt32LE(Math.round(height * HUNDREDTHS_MM_PER_PX), 36);
  headerRec.writeUInt32LE(EMF_ENHMETA_SIGNATURE, 40);
  headerRec.writeUInt32LE(EMF_VERSION_1_0, 44);
  headerRec.writeUInt32LE(totalFileSize, 48);
  headerRec.writeUInt32LE(totalRecordCount, 52);
  headerRec.writeUInt16LE(EMF_HANDLE_COUNT, 56);
  headerRec.writeUInt16LE(0, 58);
  headerRec.writeUInt32LE(0, 60);
  headerRec.writeUInt32LE(0, 64);
  headerRec.writeUInt32LE(0, 68);
  headerRec.writeUInt32LE(width, 72);
  headerRec.writeUInt32LE(height, 76);
  headerRec.writeUInt32LE(Math.max(1, Math.round((width * MM_PER_INCH) / CSS_PX_PER_INCH)), 80);
  headerRec.writeUInt32LE(Math.max(1, Math.round((height * MM_PER_INCH) / CSS_PX_PER_INCH)), 84);
  return headerRec;
}

/**
 * Encodes an SVG document into a genuine Win32 Enhanced Metafile (EMF) binary buffer.
 */
export function encodeEmf(svgBuffer: Buffer): Buffer {
  const doc = parseDrawableSvg(svgBuffer, 'EMF');
  const width = Math.max(1, Math.round(doc.width));
  const height = Math.max(1, Math.round(doc.height));

  const records: Buffer[] = [...createEmfStateRecords()];

  for (const el of doc.elements) {
    encodeEmfElement(el, records);
  }

  // EMR_EOF
  const eofRec = Buffer.alloc(EMF_EOF_SIZE);
  eofRec.writeUInt32LE(EMR_EOF, 0);
  eofRec.writeUInt32LE(EMF_EOF_SIZE, 4);
  eofRec.writeUInt32LE(0, 8);
  eofRec.writeUInt32LE(0, 12);
  eofRec.writeUInt32LE(EMF_EOF_SIZE, 16); // nSizeLast
  records.push(eofRec);

  let bodySize = 0;
  for (const r of records) bodySize += r.length;
  const headerRec = buildEmfHeader(width, height, EMF_HEADER_SIZE + bodySize, records.length + 1);

  return Buffer.concat([headerRec, ...records]);
}

// ============================================================================
// WMF ENCODER (MS-WMF Windows Metafile with Aldus Placeable Header)
// ============================================================================

// MS-WMF 2.1.1.1 RecordType values
const META_EOF = 0x0000;
const META_SETWINDOWORG = 0x020b;
const META_SETWINDOWEXT = 0x020c;
const META_SELECTOBJECT = 0x012d;
const META_DELETEOBJECT = 0x01f0;
const META_CREATEPENINDIRECT = 0x02fa;
const META_CREATEBRUSHINDIRECT = 0x02fc;
const META_POLYGON = 0x0324;
const META_POLYLINE = 0x0325;
const WMF_PS_SOLID = 0;
const WMF_PS_NULL = 5;
const WMF_BS_SOLID = 0;
const WMF_BS_HOLLOW = 1;
/** Object table slots: the pen takes 0 and the brush 1 for every shape. */
const WMF_PEN_SLOT = 0;
const WMF_BRUSH_SLOT = 1;
const WMF_OBJECT_COUNT = 2;
const WMF_PLACEABLE_KEY = 0x9ac6cdd7;
const WMF_PLACEABLE_CHECKSUM_WORDS = 10;
const WMF_MEMORY_METAFILE = 1;
const WMF_HEADER_WORDS = 9;
const WMF_VERSION_3_0 = 0x0300;

function encodeWmfPen(stroke: RgbColor | null, strokeWidth: number, outRecords: Buffer[]): number {
  const penRec = Buffer.alloc(16);
  penRec.writeUInt32LE(8, 0);
  penRec.writeUInt16LE(META_CREATEPENINDIRECT, 4);
  if (stroke) {
    penRec.writeUInt16LE(WMF_PS_SOLID, 6);
    penRec.writeUInt16LE(Math.max(1, Math.round(strokeWidth)), 8);
    penRec.writeUInt16LE(0, 10);
    penRec.writeUInt32LE((stroke.b << 16) | (stroke.g << 8) | stroke.r, 12);
  } else {
    penRec.writeUInt16LE(WMF_PS_NULL, 6);
    penRec.writeUInt16LE(0, 8);
    penRec.writeUInt16LE(0, 10);
    penRec.writeUInt32LE(0, 12);
  }
  outRecords.push(penRec);

  const selPen = Buffer.alloc(8);
  selPen.writeUInt32LE(4, 0);
  selPen.writeUInt16LE(META_SELECTOBJECT, 4);
  selPen.writeUInt16LE(WMF_PEN_SLOT, 6);
  outRecords.push(selPen);
  return 8;
}

function encodeWmfBrush(fill: RgbColor | null, isClosed: boolean, outRecords: Buffer[]): number {
  const brushRec = Buffer.alloc(14);
  brushRec.writeUInt32LE(7, 0);
  brushRec.writeUInt16LE(META_CREATEBRUSHINDIRECT, 4);
  if (fill && isClosed) {
    brushRec.writeUInt16LE(WMF_BS_SOLID, 6);
    brushRec.writeUInt32LE((fill.b << 16) | (fill.g << 8) | fill.r, 8);
    brushRec.writeUInt16LE(0, 12);
  } else {
    brushRec.writeUInt16LE(WMF_BS_HOLLOW, 6);
    brushRec.writeUInt32LE(0, 8);
    brushRec.writeUInt16LE(0, 12);
  }
  outRecords.push(brushRec);

  const selBrush = Buffer.alloc(8);
  selBrush.writeUInt32LE(4, 0);
  selBrush.writeUInt16LE(META_SELECTOBJECT, 4);
  selBrush.writeUInt16LE(WMF_BRUSH_SLOT, 6);
  outRecords.push(selBrush);
  return 7;
}

/** META_POLYGON / META_POLYLINE NumberOfPoints is a signed 16-bit field. */
const WMF_MAX_POLY_POINTS = INT16_MAX;

function encodeWmfDraw(subpath: { x: number; y: number }[], isClosed: boolean, outRecords: Buffer[]): number {
  const cpts = subpath.length;
  if (cpts > WMF_MAX_POLY_POINTS) {
    throw new CadGeometryUnavailableError(
      `WMF encoding failed: sub-path has ${cpts} points, above the ${WMF_MAX_POLY_POINTS}-point record limit.`
    );
  }
  const fnCode = isClosed ? META_POLYGON : META_POLYLINE;
  const recWords = 4 + cpts * 2;
  const drawRec = Buffer.alloc(recWords * 2);
  drawRec.writeUInt32LE(recWords, 0);
  drawRec.writeUInt16LE(fnCode, 4);
  drawRec.writeInt16LE(cpts, 6);

  for (let pIdx = 0; pIdx < cpts; pIdx++) {
    const pt = subpath[pIdx];
    drawRec.writeInt16LE(clampInt16(pt.x), 8 + pIdx * 4);
    drawRec.writeInt16LE(clampInt16(pt.y), 8 + pIdx * 4 + 2);
  }
  outRecords.push(drawRec);
  return recWords;
}

function deleteWmfObject(index: number): Buffer {
  const del = Buffer.alloc(8);
  del.writeUInt32LE(4, 0);
  del.writeUInt16LE(META_DELETEOBJECT, 4);
  del.writeUInt16LE(index, 6);
  return del;
}

function encodeWmfElement(el: SvgGeometryElement, outRecords: Buffer[]): void {
  for (const subpath of el.subpaths) {
    if (subpath.length < 2) continue;

    encodeWmfPen(el.stroke, el.strokeWidth, outRecords);
    encodeWmfBrush(el.fill, el.isClosed, outRecords);
    encodeWmfDraw(subpath, el.isClosed, outRecords);

    outRecords.push(deleteWmfObject(WMF_PEN_SLOT), deleteWmfObject(WMF_BRUSH_SLOT));
  }
}

function buildAldusHeader(width: number, height: number): Buffer {
  const aldusHeader = Buffer.alloc(22);
  aldusHeader.writeUInt32LE(WMF_PLACEABLE_KEY, 0);
  aldusHeader.writeUInt16LE(0, 4); // Handle
  aldusHeader.writeInt16LE(0, 6); // Left
  aldusHeader.writeInt16LE(0, 8); // Top
  aldusHeader.writeInt16LE(clampInt16(width), 10); // Right
  aldusHeader.writeInt16LE(clampInt16(height), 12); // Bottom
  aldusHeader.writeUInt16LE(CSS_PX_PER_INCH, 14); // Inch: logical units per inch
  aldusHeader.writeUInt32LE(0, 16); // Reserved

  let checksum = 0;
  for (let off = 0; off < WMF_PLACEABLE_CHECKSUM_WORDS * 2; off += 2) {
    checksum ^= aldusHeader.readUInt16LE(off);
  }
  aldusHeader.writeUInt16LE(checksum, 20);
  return aldusHeader;
}

/**
 * Encodes an SVG document into a genuine Windows Metafile (WMF) binary buffer.
 */
export function encodeWmf(svgBuffer: Buffer): Buffer {
  const doc = parseDrawableSvg(svgBuffer, 'WMF');
  const width = Math.max(1, Math.round(doc.width));
  const height = Math.max(1, Math.round(doc.height));

  const records: Buffer[] = [];

  // Window Org & Ext
  const setOrg = Buffer.alloc(10);
  setOrg.writeUInt32LE(5, 0);
  setOrg.writeUInt16LE(META_SETWINDOWORG, 4);
  setOrg.writeInt16LE(0, 6);
  setOrg.writeInt16LE(0, 8);

  const setExt = Buffer.alloc(10);
  setExt.writeUInt32LE(5, 0);
  setExt.writeUInt16LE(META_SETWINDOWEXT, 4);
  setExt.writeInt16LE(clampInt16(height), 6);
  setExt.writeInt16LE(clampInt16(width), 8);

  records.push(setOrg, setExt);

  for (const el of doc.elements) {
    encodeWmfElement(el, records);
  }

  const eofRec = Buffer.alloc(6);
  eofRec.writeUInt32LE(3, 0);
  eofRec.writeUInt16LE(META_EOF, 4);
  records.push(eofRec);

  let stdBytes = 0;
  let maxRecordWords = 0;
  for (const r of records) {
    stdBytes += r.length;
    // META_HEADER.MaxRecord: size in WORDs of the largest record actually written
    maxRecordWords = Math.max(maxRecordWords, r.readUInt32LE(0));
  }
  const stdWords = Math.floor((WMF_HEADER_WORDS * 2 + stdBytes) / 2);

  const stdHeader = Buffer.alloc(WMF_HEADER_WORDS * 2);
  stdHeader.writeUInt16LE(WMF_MEMORY_METAFILE, 0);
  stdHeader.writeUInt16LE(WMF_HEADER_WORDS, 2);
  stdHeader.writeUInt16LE(WMF_VERSION_3_0, 4);
  stdHeader.writeUInt32LE(stdWords, 6); // FileSize in words
  stdHeader.writeUInt16LE(WMF_OBJECT_COUNT, 10);
  stdHeader.writeUInt32LE(maxRecordWords, 12);
  stdHeader.writeUInt16LE(0, 16);

  const aldusHeader = buildAldusHeader(width, height);
  return Buffer.concat([aldusHeader, stdHeader, ...records]);
}

// ============================================================================
// CGM ENCODER (ISO/IEC 8632 Clear-Text Encoding)
// ============================================================================

const CGM_STRING_DELIMITER = '"';

/** Quotes a clear-text CGM string; the delimiter is escaped by doubling it (ISO/IEC 8632-4). */
function quoteCgmString(str: string): string {
  const flattened = str.replace(/[\r\n]+/g, ' ').trim();
  const escaped = flattened.split(CGM_STRING_DELIMITER).join(CGM_STRING_DELIMITER + CGM_STRING_DELIMITER);
  return `${CGM_STRING_DELIMITER}${escaped}${CGM_STRING_DELIMITER}`;
}

function formatCgmPoints(points: { x: number; y: number }[]): string {
  return points.map((p) => `(${Math.round(p.x)},${Math.round(p.y)})`).join(' ');
}

/** Direct colour specifier: three colour components separated by spaces. */
function formatCgmColour(c: RgbColor): string {
  return `${c.r} ${c.g} ${c.b}`;
}

function formatCgmElement(el: SvgGeometryElement, lines: string[]) {
  if (el.stroke) {
    lines.push(
      `LINECOLR ${formatCgmColour(el.stroke)};`,
      `LINEWIDTH ${Math.max(1, Math.round(el.strokeWidth))};`
    );
  }

  const isFilled = el.isClosed && el.fill !== null;
  if (isFilled && el.fill) {
    lines.push(`FILLCOLR ${formatCgmColour(el.fill)};`);
  }

  for (const sub of el.subpaths) {
    if (sub.length < 2) continue;
    const ptStr = formatCgmPoints(sub);

    if (isFilled) {
      lines.push(`POLYGON ${ptStr};`);
      if (el.stroke) {
        lines.push(`POLYLINE ${ptStr} (${Math.round(sub[0].x)},${Math.round(sub[0].y)});`);
      }
    } else if (el.stroke) {
      lines.push(`POLYLINE ${ptStr};`);
    }
  }
}

/**
 * Encodes an SVG document into standard ISO 8632 clear-text Computer Graphics Metafile (CGM).
 */
export function encodeCgm(svgBuffer: Buffer, baseName: string = 'drawing'): Buffer {
  const doc = parseDrawableSvg(svgBuffer, 'CGM');
  const width = Math.max(1, Math.round(doc.width));
  const height = Math.max(1, Math.round(doc.height));
  const quotedName = quoteCgmString(baseName || 'drawing');

  // VDC space has its y axis pointing up; listing the bottom-left corner as
  // (0,height) and the top-right as (width,0) keeps SVG coordinates unmirrored.
  const lines: string[] = [
    `BEGMF ${quotedName};`,
    'MFVERSION 1;',
    `MFDESC ${quoteCgmString('Generated by EasyConvert Vector Engine')};`,
    `MFELEMLIST ${quoteCgmString('DRAWINGSET')};`,
    `BEGPIC ${quotedName};`,
    'COLRMODE DIRECT;',
    `VDCEXT (0,${height}) (${width},0);`,
    'BEGPICBODY;',
    'INTSTYLE SOLID;',
  ];

  for (const el of doc.elements) {
    formatCgmElement(el, lines);
  }

  lines.push('ENDPIC;', 'ENDMF;', '');
  return Buffer.from(lines.join('\n'), 'utf-8');
}
