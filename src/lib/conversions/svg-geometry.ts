import { Point3D, adaptiveTessellateCubicBezier, tessellateSvgArc } from './cad-nurbs';
import { CadGeometryUnavailableError, UnsupportedOptionError } from '../types';
import { CSS_NAMED_COLORS } from './svg-named-colors';

export interface RgbColor {
  r: number;
  g: number;
  b: number;
}

export type SvgFillRule = 'nonzero' | 'evenodd';

export type SvgLinecap = 'butt' | 'round' | 'square';
export type SvgLinejoin = 'miter' | 'round' | 'bevel';

export interface SvgGeometryElement {
  subpaths: { x: number; y: number }[][];
  isClosed: boolean;
  /** False for shapes without an interior (line). */
  fillable: boolean;
  fill: RgbColor | null;
  fillRule: SvgFillRule;
  stroke: RgbColor | null;
  strokeWidth: number;
  strokeLinecap: SvgLinecap;
  strokeLinejoin: SvgLinejoin;
  /** SVG stroke-miterlimit (ratio of miter length to stroke width, at least 1). */
  strokeMiterlimit: number;
}

export interface ParsedSvgVectorDocument {
  width: number;
  height: number;
  elements: SvgGeometryElement[];
}

// ============================================================================
// CSS colours and SVG paint (CSS Color 4, SVG 1.1 section 11.2)
// ============================================================================

const RGB_MAX = 255;
const PERCENT = 100;
const HEX_SHORT_LENGTHS = new Set([3, 4]);
const HEX_LONG_LENGTHS = new Set([6, 8]);
const HUE_UNITS_IN_DEGREES: Record<string, number> = { '': 1, deg: 1, grad: 0.9, rad: 180 / Math.PI, turn: 360 };
const FULL_CIRCLE_DEGREES = 360;
const HUE_SECTOR_DEGREES = 30;
const HUE_SECTORS = 12;
const CSS_NUMBER = String.raw`[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?`;
const COLOR_FUNCTION_PATTERN = /^(rgba?|hsla?)\(\s*([^()]*)\)$/;
const NUMBER_WITH_UNIT_PATTERN = new RegExp(`^(${CSS_NUMBER})([a-z%]*)$`);

/** A parsed colour: an opaque RGB value, fully transparent, or invalid. */
type ParsedColor = RgbColor | 'transparent' | undefined;

function clampChannel(v: number): number {
  return Math.max(0, Math.min(RGB_MAX, Math.round(v)));
}

function fromAlpha(rgb: RgbColor, alpha: number, source: string): ParsedColor {
  if (alpha <= 0) return 'transparent';
  if (alpha < 1) {
    throw new UnsupportedOptionError(`Semi-transparent SVG colour "${source}" is not supported by metafile encoders.`);
  }
  return rgb;
}

function parseHexColor(hex: string, source: string): ParsedColor {
  if (!/^[0-9a-f]+$/.test(hex)) return undefined;
  if (HEX_SHORT_LENGTHS.has(hex.length)) {
    const ch = (i: number) => Number.parseInt(hex[i] + hex[i], 16);
    const alpha = hex.length === 4 ? ch(3) / RGB_MAX : 1;
    return fromAlpha({ r: ch(0), g: ch(1), b: ch(2) }, alpha, source);
  }
  if (HEX_LONG_LENGTHS.has(hex.length)) {
    const ch = (i: number) => Number.parseInt(hex.substring(i * 2, i * 2 + 2), 16);
    const alpha = hex.length === 8 ? ch(3) / RGB_MAX : 1;
    return fromAlpha({ r: ch(0), g: ch(1), b: ch(2) }, alpha, source);
  }
  return undefined;
}

/** Splits functional-notation arguments (legacy commas or modern spaces with "/ alpha"). */
function splitColorArgs(body: string): { channels: string[]; alpha: string | undefined } | undefined {
  const [main, alphaPart, ...extra] = body.split('/');
  if (extra.length > 0) return undefined;
  const channels = main.includes(',')
    ? main.split(',').map((p) => p.trim())
    : main.trim().split(/\s+/);
  let alpha: string | undefined = alphaPart?.trim();
  if (main.includes(',') && channels.length === 4 && alpha === undefined) {
    alpha = channels.pop();
  }
  if (channels.length !== 3 || channels.some((c) => c === '')) return undefined;
  return { channels, alpha };
}

function parseNumberWithUnit(token: string): { value: number; unit: string } | undefined {
  const m = NUMBER_WITH_UNIT_PATTERN.exec(token);
  if (!m) return undefined;
  return { value: Number.parseFloat(m[1]), unit: m[2] };
}

function parseAlphaValue(token: string | undefined): number | undefined {
  if (token === undefined) return 1;
  const n = parseNumberWithUnit(token);
  if (!n) return undefined;
  if (n.unit === '%') return n.value / PERCENT;
  return n.unit === '' ? n.value : undefined;
}

function parseRgbFunction(channels: string[]): RgbColor | undefined {
  const values: number[] = [];
  for (const c of channels) {
    const n = parseNumberWithUnit(c);
    if (!n || (n.unit !== '' && n.unit !== '%')) return undefined;
    values.push(n.unit === '%' ? (n.value * RGB_MAX) / PERCENT : n.value);
  }
  return { r: clampChannel(values[0]), g: clampChannel(values[1]), b: clampChannel(values[2]) };
}

/** HSL to RGB per CSS Color 4 section 7.1. */
function parseHslFunction(channels: string[]): RgbColor | undefined {
  const hue = parseNumberWithUnit(channels[0]);
  const sat = parseNumberWithUnit(channels[1]);
  const light = parseNumberWithUnit(channels[2]);
  const hueFactor = hue ? HUE_UNITS_IN_DEGREES[hue.unit] : undefined;
  if (!hue || hueFactor === undefined || !sat || !light) return undefined;
  if ((sat.unit !== '%' && sat.unit !== '') || (light.unit !== '%' && light.unit !== '')) return undefined;
  const h = (((hue.value * hueFactor) % FULL_CIRCLE_DEGREES) + FULL_CIRCLE_DEGREES) % FULL_CIRCLE_DEGREES;
  const s = Math.max(0, Math.min(1, sat.value / PERCENT));
  const l = Math.max(0, Math.min(1, light.value / PERCENT));
  const channel = (n: number) => {
    const k = (n + h / HUE_SECTOR_DEGREES) % HUE_SECTORS;
    const a = s * Math.min(l, 1 - l);
    return clampChannel((l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))) * RGB_MAX);
  };
  return { r: channel(0), g: channel(8), b: channel(4) };
}

function parseColorValue(raw: string): ParsedColor {
  const s = raw.trim().toLowerCase();
  if (s === 'transparent') return 'transparent';
  const named = CSS_NAMED_COLORS.get(s);
  if (named !== undefined) {
    return { r: (named >> 16) & RGB_MAX, g: (named >> 8) & RGB_MAX, b: named & RGB_MAX };
  }
  if (s.startsWith('#')) return parseHexColor(s.substring(1), raw);
  const fn = COLOR_FUNCTION_PATTERN.exec(s);
  if (!fn) return undefined;
  const args = splitColorArgs(fn[2]);
  if (!args) return undefined;
  const alpha = parseAlphaValue(args.alpha);
  const rgb = fn[1].startsWith('rgb') ? parseRgbFunction(args.channels) : parseHslFunction(args.channels);
  if (!rgb || alpha === undefined) return undefined;
  return fromAlpha(rgb, alpha, raw);
}

/**
 * Parses a CSS colour. Returns null for "none", "transparent", empty or
 * invalid input; throws for semi-transparent colours.
 */
export function parseCssColor(colorStr: string | null | undefined): RgbColor | null {
  if (!colorStr || colorStr.trim().toLowerCase() === 'none') return null;
  const parsed = parseColorValue(colorStr);
  return typeof parsed === 'object' ? parsed : null;
}

const BLACK: RgbColor = { r: 0, g: 0, b: 0 };

/**
 * Resolves an SVG paint value (SVG 1.1 section 11.2). Paint servers throw a
 * typed error; an invalid fill falls back to its initial value (black) and an
 * invalid stroke to its initial value (none).
 */
export function resolvePaint(value: string, currentColor: string, property: 'fill' | 'stroke'): RgbColor | null {
  const v = value.trim();
  const lower = v.toLowerCase();
  if (lower === 'none') return null;
  if (lower.startsWith('url(')) {
    throw new UnsupportedOptionError(`SVG ${property} paint server "${v}" is not supported by metafile encoders.`);
  }
  const parsed = lower === 'currentcolor' ? parseColorValue(currentColor) ?? BLACK : parseColorValue(v);
  if (parsed === 'transparent') return null;
  if (parsed === undefined) return property === 'fill' ? { ...BLACK } : null;
  return parsed;
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
  prevUpper: string,
  tolerance: number
): number {
  if (i + 3 >= tokens.length) return i;
  const isPreviousCubic = prevUpper === 'C' || prevUpper === 'S';
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

function handleSmoothQuad(
  tokens: string[],
  i: number,
  isRel: boolean,
  state: PathState,
  currentSubpath: Point3D[],
  prevUpper: string,
  tolerance: number
): number {
  if (i + 1 >= tokens.length) return i;
  const isPreviousQuad = prevUpper === 'Q' || prevUpper === 'T';
  const cp: Point3D = {
    x: isPreviousQuad ? 2 * state.currentX - state.lastCpX : state.currentX,
    y: isPreviousQuad ? 2 * state.currentY - state.lastCpY : state.currentY,
    z: 0,
  };
  const x = Number.parseFloat(tokens[i]);
  const y = Number.parseFloat(tokens[i + 1]);
  const p0: Point3D = { x: state.currentX, y: state.currentY, z: 0 };
  const p2: Point3D = { x: isRel ? state.currentX + x : x, y: isRel ? state.currentY + y : y, z: 0 };
  const p1: Point3D = { x: p0.x + (2 / 3) * (cp.x - p0.x), y: p0.y + (2 / 3) * (cp.y - p0.y), z: 0 };
  const pCubic2: Point3D = { x: p2.x + (2 / 3) * (cp.x - p2.x), y: p2.y + (2 / 3) * (cp.y - p2.y), z: 0 };
  const curvePts = adaptiveTessellateCubicBezier(p0, p1, pCubic2, p2, tolerance);
  for (let k = 1; k < curvePts.length; k++) currentSubpath.push(curvePts[k]);
  state.currentX = p2.x;
  state.currentY = p2.y;
  state.lastCpX = cp.x;
  state.lastCpY = cp.y;
  return i + 2;
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
const PATH_TOKEN_PATTERN = /[MmLlHhVvCcSsQqTtAaZz]|[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?|[\s,]+|./gy;
const PATH_SEPARATOR_PATTERN = /^[\s,]+$/;
const PATH_TOKEN_VALID = /^(?:[MmLlHhVvCcSsQqTtAaZz]|[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)$/;

/** Splits path data into commands and numbers; any other character fails closed. */
function tokenizePathData(d: string): string[] {
  const tokens: string[] = [];
  for (const m of d.matchAll(PATH_TOKEN_PATTERN)) {
    const tok = m[0];
    if (PATH_SEPARATOR_PATTERN.test(tok)) continue;
    if (!PATH_TOKEN_VALID.test(tok)) {
      throw new CadGeometryUnavailableError(`Malformed SVG path data "${d}": unexpected character "${tok}".`);
    }
    tokens.push(tok);
  }
  return tokens;
}

const PATH_NUMBER_PATTERN = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/;

export function parseSvgPathToPoints(d: string, tolerance: number = 0.25): Point3D[][] {
  const subpaths: Point3D[][] = [];
  let currentSubpath: Point3D[] = [];
  const state: PathState = { currentX: 0, currentY: 0, lastCpX: 0, lastCpY: 0 };
  let lastCmd = '';

  const tokens = tokenizePathData(d);

  let i = 0;
  let prevUpper = '';
  while (i < tokens.length) {
    const token = tokens[i];
    if (/^[MmLlHhVvCcSsQqTtAaZz]$/.test(token)) {
      lastCmd = token;
      i++;
    } else if (!lastCmd) {
      throw new CadGeometryUnavailableError(`Malformed SVG path data "${d}": coordinates before the first command.`);
    }

    const cmd = lastCmd;
    const isRel = cmd === cmd.toLowerCase();
    const upper = cmd.toUpperCase();
    const start = i;

    if (upper !== 'M' && upper !== 'Z' && currentSubpath.length === 0) {
      // A drawing command after Z continues from the closed sub-path's start point
      currentSubpath.push({ x: state.currentX, y: state.currentY, z: 0 });
    }

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
      i = handleSmoothCubic(tokens, i, isRel, state, currentSubpath, prevUpper, tolerance);
    } else if (upper === 'Q') {
      i = handleQuadCurve(tokens, i, isRel, state, currentSubpath, tolerance);
    } else if (upper === 'T') {
      i = handleSmoothQuad(tokens, i, isRel, state, currentSubpath, prevUpper, tolerance);
    } else if (upper === 'A') {
      i = handleArcCurve(tokens, i, isRel, state, currentSubpath);
    } else {
      // Z
      if (currentSubpath.length > 1) {
        const first = currentSubpath[0];
        currentSubpath.push({ x: first.x, y: first.y, z: first.z });
        state.currentX = first.x;
        state.currentY = first.y;
      }
      subpaths.push(currentSubpath);
      currentSubpath = [];
      lastCmd = '';
    }

    if (upper !== 'Z' && (i === start || tokens.slice(start, i).some((t) => !PATH_NUMBER_PATTERN.test(t)))) {
      throw new CadGeometryUnavailableError(`Malformed SVG path data "${d}": missing or invalid arguments for ${cmd}.`);
    }
    prevUpper = upper;
  }

  if (currentSubpath.length > 0) {
    subpaths.push(currentSubpath);
  }

  return subpaths;
}

export function parseSvgPathToBezierPoints(d: string, tolerance: number = 0.25): Point3D[][] {
  return parseSvgPathToPoints(d, tolerance);
}

// ============================================================================
// Affine transforms (SVG 1.1 section 7.4)
// ============================================================================

/** Affine matrix [a, b, c, d, e, f]: x' = a*x + c*y + e, y' = b*x + d*y + f. */
export type AffineMatrix = [number, number, number, number, number, number];

const IDENTITY_MATRIX: AffineMatrix = [1, 0, 0, 1, 0, 0];
const DEGREES_TO_RADIANS = Math.PI / 180;

function multiplyMatrix(m1: AffineMatrix, m2: AffineMatrix): AffineMatrix {
  return [
    m1[0] * m2[0] + m1[2] * m2[1],
    m1[1] * m2[0] + m1[3] * m2[1],
    m1[0] * m2[2] + m1[2] * m2[3],
    m1[1] * m2[2] + m1[3] * m2[3],
    m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
    m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
  ];
}

function applyMatrix(m: AffineMatrix, x: number, y: number): { x: number; y: number } {
  return { x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] };
}

const TRANSFORM_FUNCTION_PATTERN = /^\s*,?\s*(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^()]*)\)/;
const TRANSFORM_NUMBER_PATTERN = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/;

function transformFunctionMatrix(name: string, args: number[]): AffineMatrix | null {
  switch (name) {
    case 'matrix':
      return args.length === 6 ? (args as AffineMatrix) : null;
    case 'translate':
      if (args.length === 1) return [1, 0, 0, 1, args[0], 0];
      return args.length === 2 ? [1, 0, 0, 1, args[0], args[1]] : null;
    case 'scale':
      if (args.length === 1) return [args[0], 0, 0, args[0], 0, 0];
      return args.length === 2 ? [args[0], 0, 0, args[1], 0, 0] : null;
    case 'rotate': {
      if (args.length !== 1 && args.length !== 3) return null;
      const rad = args[0] * DEGREES_TO_RADIANS;
      const rotation: AffineMatrix = [Math.cos(rad), Math.sin(rad), -Math.sin(rad), Math.cos(rad), 0, 0];
      if (args.length === 1) return rotation;
      const [, cx, cy] = args;
      return multiplyMatrix(multiplyMatrix([1, 0, 0, 1, cx, cy], rotation), [1, 0, 0, 1, -cx, -cy]);
    }
    case 'skewX':
      return args.length === 1 ? [1, 0, Math.tan(args[0] * DEGREES_TO_RADIANS), 1, 0, 0] : null;
    case 'skewY':
      return args.length === 1 ? [1, Math.tan(args[0] * DEGREES_TO_RADIANS), 0, 1, 0, 0] : null;
    default:
      return null;
  }
}

/**
 * Parses an SVG transform list. A malformed list throws instead of being
 * dropped, since ignoring it would silently misplace geometry.
 */
export function parseSvgTransform(value: string): AffineMatrix {
  let rest = value.trim();
  let matrix: AffineMatrix = IDENTITY_MATRIX;
  while (rest.length > 0) {
    const fn = TRANSFORM_FUNCTION_PATTERN.exec(rest);
    const rawArgs = fn ? fn[2].trim().split(/\s*,\s*|\s+/).filter((a) => a.length > 0) : [];
    const valid = fn !== null && rawArgs.every((a) => TRANSFORM_NUMBER_PATTERN.test(a));
    const fnMatrix = valid ? transformFunctionMatrix(fn[1], rawArgs.map(Number)) : null;
    if (!fn || !fnMatrix) {
      throw new CadGeometryUnavailableError(`Unsupported or malformed SVG transform "${value}".`);
    }
    matrix = multiplyMatrix(matrix, fnMatrix);
    matrix.forEach((v) => requireFinite(v, `transform "${value}"`));
    rest = rest.slice(fn[0].length).trim();
  }
  return matrix;
}

// ============================================================================
// Minimal XML tag scanner
// ============================================================================

interface XmlTag {
  name: string;
  attrs: Map<string, string>;
  closing: boolean;
  selfClosing: boolean;
}

const XML_TOKEN_PATTERN =
  /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<![^>]*>|<\?[\s\S]*?\?>|<(\/?)([A-Za-z_][\w:.-]*)((?:\s+[^\s=/>]+(?:\s*=\s*(?:"[^"]*"|'[^']*'))?)*)\s*(\/?)>/g;
const XML_ATTR_PATTERN = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'))?/g;
const XML_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeXmlEntities(value: string): string {
  return value.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (whole, ent: string) => {
    if (ent.startsWith('#x')) return String.fromCodePoint(Number.parseInt(ent.slice(2), 16));
    if (ent.startsWith('#')) return String.fromCodePoint(Number.parseInt(ent.slice(1), 10));
    return XML_ENTITIES[ent] ?? whole;
  });
}

function* scanXmlTags(xml: string): Generator<XmlTag> {
  XML_TOKEN_PATTERN.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = XML_TOKEN_PATTERN.exec(xml)) !== null) {
    if (m[2] === undefined) continue; // comment, CDATA, doctype, processing instruction
    const attrs = new Map<string, string>();
    XML_ATTR_PATTERN.lastIndex = 0;
    let a: RegExpExecArray | null;
    while ((a = XML_ATTR_PATTERN.exec(m[3])) !== null) {
      attrs.set(a[1], decodeXmlEntities(a[2] ?? a[3] ?? ''));
    }
    yield { name: m[2].replace(/^svg:/, ''), attrs, closing: m[1] === '/', selfClosing: m[4] === '/' };
  }
}

// ============================================================================
// Style cascade (presentation attributes < style attribute, with inheritance)
// ============================================================================

interface StyleContext {
  fill: string;
  stroke: string;
  strokeWidth: string;
  fillRule: string;
  color: string;
  visibility: string;
  strokeLinecap: string;
  strokeLinejoin: string;
  strokeMiterlimit: string;
  ctm: AffineMatrix;
}

const INITIAL_STYLE: StyleContext = {
  fill: 'black',
  stroke: 'none',
  strokeWidth: '1',
  fillRule: 'nonzero',
  color: 'black',
  visibility: 'visible',
  strokeLinecap: 'butt',
  strokeLinejoin: 'miter',
  strokeMiterlimit: '4',
  ctm: IDENTITY_MATRIX,
};

/** Inherited presentation properties handled by the encoders, keyed by CSS name. */
const INHERITED_PROPERTIES: Record<string, keyof Omit<StyleContext, 'ctm'>> = {
  fill: 'fill',
  stroke: 'stroke',
  'stroke-width': 'strokeWidth',
  'fill-rule': 'fillRule',
  color: 'color',
  visibility: 'visibility',
  'stroke-linecap': 'strokeLinecap',
  'stroke-linejoin': 'strokeLinejoin',
  'stroke-miterlimit': 'strokeMiterlimit',
};

/**
 * Properties that change painted pixels but are only representable at their
 * neutral value; anything else throws (metafile brushes and pens are opaque,
 * solid and painted fill-then-stroke).
 */
const NEUTRAL_ONLY_PROPERTIES: Record<string, (value: string) => boolean> = {
  opacity: isOpaque,
  'fill-opacity': isOpaque,
  'stroke-opacity': isOpaque,
  'stroke-dasharray': (v) => v === 'none',
  'paint-order': (v) => v === 'normal' || v === 'fill' || v === 'fill stroke' || v === 'fill stroke markers',
  'vector-effect': (v) => v === 'none',
  'mix-blend-mode': (v) => v === 'normal',
  'stroke-miterlimit': (v) => Number(v) >= 1,
  'stroke-linecap': (v) => SVG_LINECAPS.has(v),
  'stroke-linejoin': (v) => SVG_LINEJOINS.has(v),
};

const SVG_LINECAPS = new Set(['butt', 'round', 'square']);
const SVG_LINEJOINS = new Set(['miter', 'round', 'bevel']);

function isOpaque(value: string): boolean {
  const v = value.trim();
  if (v.endsWith('%')) return Number(v.slice(0, -1)) >= 100;
  return Number(v) >= 1;
}

function assertNeutralPaintProperties(declared: Map<string, string>): void {
  for (const [prop, isNeutral] of Object.entries(NEUTRAL_ONLY_PROPERTIES)) {
    const raw = declared.get(prop);
    if (raw === undefined || raw.trim().toLowerCase() === 'inherit') continue;
    if (!isNeutral(raw.trim().toLowerCase().replace(/\s+/g, ' '))) {
      throw new UnsupportedOptionError(`SVG ${prop} "${raw.trim()}" is not supported by metafile encoders.`);
    }
  }
}

/** Elements whose content is never rendered directly. */
const NON_RENDERED_ELEMENTS = new Set([
  'defs',
  'symbol',
  'clipPath',
  'mask',
  'pattern',
  'marker',
  'linearGradient',
  'radialGradient',
  'filter',
  'style',
  'script',
  'title',
  'desc',
  'metadata',
]);

const SHAPE_ELEMENTS = new Set(['path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon']);

/** Properties that reference clipping, masking, filter or marker resources. */
const UNSUPPORTED_REFERENCE_PROPERTIES = ['clip-path', 'mask', 'filter', 'marker', 'marker-start', 'marker-mid', 'marker-end'];

interface CssDeclaration {
  value: string;
  important: boolean;
}

const IMPORTANT_SUFFIX = /\s*!\s*important\s*$/i;

function parseDeclarationList(style: string | undefined): Map<string, CssDeclaration> {
  const map = new Map<string, CssDeclaration>();
  if (!style) return map;
  for (const decl of style.split(';')) {
    const colonIdx = decl.indexOf(':');
    if (colonIdx > 0) {
      const key = decl.substring(0, colonIdx).trim().toLowerCase();
      const raw = decl.substring(colonIdx + 1);
      const important = IMPORTANT_SUFFIX.test(raw);
      const value = raw.replace(IMPORTANT_SUFFIX, '').trim();
      if (key && value) map.set(key, { value, important });
    }
  }
  return map;
}

function parseStyleDeclarations(style: string | undefined): Map<string, string> {
  return new Map([...parseDeclarationList(style)].map(([k, d]) => [k, d.value]));
}

// ============================================================================
// Minimal <style> stylesheet: type/.class/#id compound selectors, comma lists
// ============================================================================

interface CompoundSelector {
  type: string | null;
  classes: string[];
  id: string | null;
  /** [ids, classes, types] per CSS Selectors 4 section 17. */
  specificity: [number, number, number];
}

interface CssRule {
  selector: CompoundSelector;
  declarations: Map<string, CssDeclaration>;
  order: number;
}

const COMPOUND_SELECTOR_PATTERN = /^(\*|[A-Za-z][\w-]*)?((?:[.#][A-Za-z_-][\w-]*)*)$/;

function unsupportedRule(rule: string): UnsupportedOptionError {
  return new UnsupportedOptionError(`SVG stylesheet rule "${rule.trim()}" is not supported by metafile encoders.`);
}

function parseCompoundSelector(text: string, rule: string): CompoundSelector {
  const m = COMPOUND_SELECTOR_PATTERN.exec(text);
  if (!m || text === '') throw unsupportedRule(rule);
  const parts = m[2].match(/[.#][A-Za-z_-][\w-]*/g) ?? [];
  const ids = parts.filter((p) => p.startsWith('#')).map((p) => p.slice(1));
  if (ids.length > 1) throw unsupportedRule(rule);
  const classes = parts.filter((p) => p.startsWith('.')).map((p) => p.slice(1));
  const type = m[1] && m[1] !== '*' ? m[1] : null;
  return { type, classes, id: ids[0] ?? null, specificity: [ids.length, classes.length, type ? 1 : 0] };
}

/** Parses <style> text; anything beyond the supported subset throws, naming the rule. */
function parseStylesheet(css: string): CssRule[] {
  // CSS comments are dropped; CDO/CDC tokens (<!-- -->) are ignorable in a stylesheet.
  const text = css.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/<!--|-->/g, ' ');
  const rules: CssRule[] = [];
  let rest = text.trim();
  while (rest.length > 0) {
    if (rest.startsWith('@')) {
      const end = rest.search(/[;{]/);
      throw unsupportedRule(end === -1 ? rest : rest.slice(0, end));
    }
    const open = rest.indexOf('{');
    const close = rest.indexOf('}');
    if (open === -1 || close === -1 || close < open) throw unsupportedRule(rest);
    const prelude = rest.slice(0, open).trim();
    const body = rest.slice(open + 1, close);
    const ruleText = rest.slice(0, close + 1);
    if (body.includes('{')) throw unsupportedRule(ruleText);
    const declarations = parseDeclarationList(body);
    for (const prop of [...UNSUPPORTED_REFERENCE_PROPERTIES, 'transform']) {
      const d = declarations.get(prop);
      if (d && d.value.toLowerCase() !== 'none') throw unsupportedRule(ruleText);
    }
    for (const sel of prelude.split(',')) {
      rules.push({ selector: parseCompoundSelector(sel.trim(), ruleText), declarations, order: rules.length });
    }
    rest = rest.slice(close + 1).trim();
  }
  return rules;
}

/**
 * Scans markup in document order: XML comments and CDATA sections outside
 * <style> are consumed and ignored, so only real <style> elements count.
 */
const STYLE_SCAN_PATTERN =
  /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<style\b[^>]*?(?:\/>|>((?:<!\[CDATA\[[\s\S]*?\]\]>|<!--[\s\S]*?-->|[\s\S])*?)<\/style\s*>)/gi;
const STYLE_CONTENT_PATTERN = /<!\[CDATA\[([\s\S]*?)\]\]>|<!--[\s\S]*?-->/g;

/** Style element text content: CDATA sections unwrap, XML comments are dropped. */
function styleTextContent(raw: string): string {
  return raw.replace(STYLE_CONTENT_PATTERN, (_m, cdata: string | undefined) => cdata ?? ' ');
}

function extractStylesheets(svgContent: string): CssRule[] {
  const rules: CssRule[] = [];
  for (const m of svgContent.matchAll(STYLE_SCAN_PATTERN)) {
    if (!m[0].toLowerCase().startsWith('<style')) continue;
    for (const r of parseStylesheet(styleTextContent(m[1] ?? ''))) rules.push({ ...r, order: rules.length });
  }
  return rules;
}

function selectorMatches(sel: CompoundSelector, name: string, attrs: Map<string, string>): boolean {
  if (sel.type !== null && sel.type !== name) return false;
  if (sel.id !== null && attrs.get('id') !== sel.id) return false;
  if (sel.classes.length === 0) return true;
  const classList = new Set((attrs.get('class') ?? '').split(/\s+/).filter((c) => c));
  return sel.classes.every((c) => classList.has(c));
}

function compareRules(a: CssRule, b: CssRule): number {
  for (let k = 0; k < 3; k++) {
    const diff = a.selector.specificity[k] - b.selector.specificity[k];
    if (diff !== 0) return diff;
  }
  return a.order - b.order;
}

/**
 * Collects the element's own declared properties in cascade order:
 * presentation attributes < stylesheet < inline style < stylesheet !important
 * < inline !important.
 */
function declaredProperties(attrs: Map<string, string>, name = '', sheet: CssRule[] = []): Map<string, string> {
  const declared = new Map<string, string>();
  for (const prop of [...Object.keys(INHERITED_PROPERTIES), ...Object.keys(NEUTRAL_ONLY_PROPERTIES), 'display']) {
    const v = attrs.get(prop);
    if (v !== undefined && v.trim() !== '') declared.set(prop, v.trim());
  }
  const matching = sheet.filter((r) => selectorMatches(r.selector, name, attrs)).sort(compareRules);
  const inline = parseDeclarationList(attrs.get('style'));
  const layers: [Iterable<[string, CssDeclaration]>, boolean][] = [
    ...matching.map((r) => [r.declarations, false] as [Iterable<[string, CssDeclaration]>, boolean]),
    [inline, false],
    ...matching.map((r) => [r.declarations, true] as [Iterable<[string, CssDeclaration]>, boolean]),
    [inline, true],
  ];
  for (const [decls, importantLayer] of layers) {
    for (const [k, d] of decls) {
      if (d.important === importantLayer) declared.set(k, d.value);
    }
  }
  if (declared.has('transform')) {
    throw new CadGeometryUnavailableError(`CSS transform property "${declared.get('transform')}" is not supported; use the transform attribute.`);
  }
  return declared;
}

function deriveContext(parent: StyleContext, attrs: Map<string, string>, declared: Map<string, string>): StyleContext {
  const ctx: StyleContext = { ...parent };
  for (const [cssName, key] of Object.entries(INHERITED_PROPERTIES)) {
    const v = declared.get(cssName);
    if (v !== undefined && v !== 'inherit') ctx[key] = v;
  }
  const transform = attrs.get('transform');
  if (transform !== undefined && transform.trim() !== '') {
    ctx.ctm = multiplyMatrix(parent.ctm, parseSvgTransform(transform));
  }
  return ctx;
}

// ============================================================================
// Shape geometry in user units
// ============================================================================

const ELLIPSE_SEGMENTS = 36;

/** Throws unless the value is a finite number; NaN or overflow would yield dummy geometry. */
export function requireFinite(value: number, what: string): number {
  if (!Number.isFinite(value)) {
    throw new CadGeometryUnavailableError(`SVG ${what} is not a finite number.`);
  }
  return value;
}

function numberAttr(attrs: Map<string, string>, name: string): number {
  const v = attrs.get(name);
  if (v === undefined) return 0;
  return parseLength(v, `attribute ${name}`);
}

function ellipsePoints(cx: number, cy: number, rx: number, ry: number): { x: number; y: number }[] {
  const pts: { x: number; y: number }[] = [];
  for (let k = 0; k <= ELLIPSE_SEGMENTS; k++) {
    const theta = (k / ELLIPSE_SEGMENTS) * 2 * Math.PI;
    pts.push({ x: cx + rx * Math.cos(theta), y: cy + ry * Math.sin(theta) });
  }
  return pts;
}

function parsePointList(value: string | undefined): { x: number; y: number }[] {
  if (!value) return [];
  const coords = value
    .trim()
    .split(/[\s,]+/)
    .map((v) => requireFinite(Number(v), `points value "${v}"`));
  const pts: { x: number; y: number }[] = [];
  for (let k = 0; k + 1 < coords.length; k += 2) {
    pts.push({ x: coords[k], y: coords[k + 1] });
  }
  return pts;
}

interface UserShape {
  subpaths: { x: number; y: number }[][];
  isClosed: boolean;
}

/** Rounded-corner radii per SVG 1.1 section 9.2: a missing radius copies the other, clamped to half the side. */
function resolveRectRadii(attrs: Map<string, string>, w: number, h: number): { rx: number; ry: number } {
  const rxAttr = attrs.has('rx') ? numberAttr(attrs, 'rx') : undefined;
  const ryAttr = attrs.has('ry') ? numberAttr(attrs, 'ry') : undefined;
  const rx = Math.max(0, rxAttr ?? ryAttr ?? 0);
  const ry = Math.max(0, ryAttr ?? rxAttr ?? 0);
  return { rx: Math.min(rx, w / 2), ry: Math.min(ry, h / 2) };
}

function shapeGeometry(name: string, attrs: Map<string, string>): UserShape | null {
  switch (name) {
    case 'path': {
      const d = attrs.get('d');
      if (!d) return null;
      const subpaths = parseSvgPathToPoints(d, PATH_TOLERANCE).filter((s) => s.length >= 2);
      return { subpaths, isClosed: /[zZ]/.test(d) };
    }
    case 'rect': {
      const x = numberAttr(attrs, 'x');
      const y = numberAttr(attrs, 'y');
      const w = numberAttr(attrs, 'width');
      const h = numberAttr(attrs, 'height');
      if (w <= 0 || h <= 0) return null;
      const { rx, ry } = resolveRectRadii(attrs, w, h);
      if (rx > 0 && ry > 0) {
        const d =
          `M${x + rx},${y} H${x + w - rx} A${rx},${ry} 0 0 1 ${x + w},${y + ry} V${y + h - ry} ` +
          `A${rx},${ry} 0 0 1 ${x + w - rx},${y + h} H${x + rx} A${rx},${ry} 0 0 1 ${x},${y + h - ry} ` +
          `V${y + ry} A${rx},${ry} 0 0 1 ${x + rx},${y} Z`;
        return { subpaths: parseSvgPathToPoints(d, PATH_TOLERANCE), isClosed: true };
      }
      return { subpaths: [[{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }, { x, y }]], isClosed: true };
    }
    case 'circle': {
      const r = numberAttr(attrs, 'r');
      if (r <= 0) return null;
      return { subpaths: [ellipsePoints(numberAttr(attrs, 'cx'), numberAttr(attrs, 'cy'), r, r)], isClosed: true };
    }
    case 'ellipse': {
      const rx = numberAttr(attrs, 'rx');
      const ry = numberAttr(attrs, 'ry');
      if (rx <= 0 || ry <= 0) return null;
      return { subpaths: [ellipsePoints(numberAttr(attrs, 'cx'), numberAttr(attrs, 'cy'), rx, ry)], isClosed: true };
    }
    case 'line':
      return {
        subpaths: [
          [
            { x: numberAttr(attrs, 'x1'), y: numberAttr(attrs, 'y1') },
            { x: numberAttr(attrs, 'x2'), y: numberAttr(attrs, 'y2') },
          ],
        ],
        isClosed: false,
      };
    case 'polyline':
    case 'polygon': {
      const pts = parsePointList(attrs.get('points'));
      if (pts.length < 2) return null;
      if (name === 'polygon') pts.push({ ...pts[0] });
      return { subpaths: [pts], isClosed: name === 'polygon' };
    }
    default:
      return null;
  }
}

/** Flattening tolerance for curves, in user units. */
const PATH_TOLERANCE = 0.25;
const DEFAULT_STROKE_WIDTH = 1;

/**
 * Resolves stroke-width in user units: invalid values use the initial value 1;
 * zero or negative widths disable the stroke (returns 0).
 */
function resolveStrokeWidth(value: string): number {
  return Math.max(0, parseLength(value, 'stroke-width'));
}

/** Relative tolerance when deciding whether a transform scales uniformly. */
const UNIFORM_SCALE_TOLERANCE = 1e-9;

/** True when the linear part is a rotation/reflection times one uniform scale (no skew). */
function isUniformScale(m: AffineMatrix): boolean {
  const lenX = m[0] * m[0] + m[1] * m[1];
  const lenY = m[2] * m[2] + m[3] * m[3];
  const dot = m[0] * m[2] + m[1] * m[3];
  const tol = UNIFORM_SCALE_TOLERANCE * Math.max(lenX, lenY);
  return Math.abs(lenX - lenY) <= tol && Math.abs(dot) <= tol;
}

/** Uniform length scale of a transform: the square root of its determinant's magnitude. */
function matrixLengthScale(m: AffineMatrix): number {
  return Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]));
}

// ============================================================================
// Viewport
// ============================================================================

interface Viewport {
  width: number;
  height: number;
  matrix: AffineMatrix;
}

const DEFAULT_VIEWPORT_WIDTH = 800;
const DEFAULT_VIEWPORT_HEIGHT = 600;

function parseViewBox(value: string | undefined): [number, number, number, number] | null {
  if (!value) return null;
  const parts = value.trim().split(/[\s,]+/).map(Number);
  if (parts.length !== 4 || !parts.every(Number.isFinite) || parts[2] <= 0 || parts[3] <= 0) {
    throw new CadGeometryUnavailableError(`SVG viewBox "${value}" must be four finite numbers with positive width and height.`);
  }
  return [parts[0], parts[1], parts[2], parts[3]];
}

/** CSS absolute length units in CSS pixels (CSS Values 4: 1in = 96px). */
const CSS_PX_PER_INCH = 96;
const ABSOLUTE_LENGTH_UNITS: Record<string, number> = {
  '': 1,
  px: 1,
  in: CSS_PX_PER_INCH,
  cm: CSS_PX_PER_INCH / 2.54,
  mm: CSS_PX_PER_INCH / 25.4,
  q: CSS_PX_PER_INCH / 101.6,
  pt: CSS_PX_PER_INCH / 72,
  pc: CSS_PX_PER_INCH / 6,
};
const LENGTH_PATTERN = /^\s*([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)\s*([a-zA-Z%]*)\s*$/;

/**
 * Parses an SVG length in user units (px). Absolute units convert at 96 DPI;
 * relative units (%, em, ex, ...) and malformed values throw.
 */
function parseLength(value: string, what: string): number {
  const m = LENGTH_PATTERN.exec(value);
  const factor = m ? ABSOLUTE_LENGTH_UNITS[m[2].toLowerCase()] : undefined;
  if (!m || factor === undefined) {
    throw new CadGeometryUnavailableError(`SVG ${what} "${value}" is not an absolute length (px, in, cm, mm, pt, pc).`);
  }
  return requireFinite(Number.parseFloat(m[1]) * factor, `${what} "${value}"`);
}

/**
 * Root width/height: an absolute length, or a percentage that resolves
 * against the viewBox (returns null) when one is present.
 */
function parseRootLength(value: string | undefined, name: string, hasViewBox: boolean): number | null {
  if (value === undefined) return null;
  if (hasViewBox && /^\s*[-+]?(?:\d+\.?\d*|\.\d+)\s*%\s*$/.test(value)) return null;
  const px = parseLength(value, `root ${name}`);
  if (px <= 0) {
    throw new CadGeometryUnavailableError(`SVG root ${name} "${value}" must be positive.`);
  }
  return px;
}

const ALIGN_FACTORS: Record<string, number> = { min: 0, mid: 0.5, max: 1 };

/** Viewbox-to-viewport matrix per SVG 1.1 section 7.8 (preserveAspectRatio). */
function viewBoxMatrix(
  vb: [number, number, number, number],
  width: number,
  height: number,
  preserveAspectRatio: string | undefined
): AffineMatrix {
  const [minX, minY, vbWidth, vbHeight] = vb;
  let sx = width / vbWidth;
  let sy = height / vbHeight;
  const par = (preserveAspectRatio ?? 'xMidYMid meet').trim().split(/\s+/);
  const align = par[0] ?? 'xMidYMid';
  if (align === 'none') {
    return [sx, 0, 0, sy, -minX * sx, -minY * sy];
  }
  const alignMatch = /^x(Min|Mid|Max)Y(Min|Mid|Max)$/.exec(align);
  if (!alignMatch) {
    throw new CadGeometryUnavailableError(`Unsupported SVG preserveAspectRatio "${preserveAspectRatio}".`);
  }
  const uniform = par[1] === 'slice' ? Math.max(sx, sy) : Math.min(sx, sy);
  sx = uniform;
  sy = uniform;
  const tx = (width - vbWidth * uniform) * ALIGN_FACTORS[alignMatch[1].toLowerCase()];
  const ty = (height - vbHeight * uniform) * ALIGN_FACTORS[alignMatch[2].toLowerCase()];
  return [sx, 0, 0, sy, tx - minX * sx, ty - minY * sy];
}

/**
 * Resolves the outermost viewport. Without a viewBox the user space equals the
 * viewport (viewBox "0 0 width height"); 800x600 is used only when neither a
 * viewBox nor absolute width/height is present.
 */
function resolveViewport(attrs: Map<string, string>): Viewport {
  const vb = parseViewBox(attrs.get('viewBox'));
  const lengthW = parseRootLength(attrs.get('width'), 'width', vb !== null);
  const lengthH = parseRootLength(attrs.get('height'), 'height', vb !== null);

  if (!vb) {
    const width = lengthW ?? DEFAULT_VIEWPORT_WIDTH;
    const height = lengthH ?? DEFAULT_VIEWPORT_HEIGHT;
    return { width, height, matrix: IDENTITY_MATRIX };
  }

  const vbAspect = vb[2] / vb[3];
  let width = lengthW ?? vb[2];
  let height = lengthH ?? vb[3];
  if (lengthW !== null && lengthH === null) height = lengthW / vbAspect;
  if (lengthH !== null && lengthW === null) width = lengthH * vbAspect;
  return { width, height, matrix: viewBoxMatrix(vb, width, height, attrs.get('preserveAspectRatio')) };
}

// ============================================================================
// Document walk
// ============================================================================

/** Maximum element nesting, including <use> instantiation, before the input is rejected. */
const MAX_SVG_NESTING_DEPTH = 256;

function nestingTooDeep(): CadGeometryUnavailableError {
  return new CadGeometryUnavailableError(`SVG elements nest deeper than ${MAX_SVG_NESTING_DEPTH} levels.`);
}

interface SvgNode {
  name: string;
  attrs: Map<string, string>;
  children: SvgNode[];
}

/** Builds the element tree; mismatched or unclosed tags fail closed. */
function buildSvgTree(svgContent: string): SvgNode | null {
  const rootHolder: SvgNode = { name: '#document', attrs: new Map(), children: [] };
  const stack: SvgNode[] = [rootHolder];
  for (const tag of scanXmlTags(svgContent)) {
    if (tag.closing) {
      const open = stack[stack.length - 1];
      if (stack.length === 1 || open.name !== tag.name) {
        throw new CadGeometryUnavailableError(`Malformed SVG: unexpected closing tag </${tag.name}>.`);
      }
      stack.pop();
      continue;
    }
    const node: SvgNode = { name: tag.name, attrs: tag.attrs, children: [] };
    stack[stack.length - 1].children.push(node);
    if (!tag.selfClosing) {
      stack.push(node);
      if (stack.length > MAX_SVG_NESTING_DEPTH) throw nestingTooDeep();
    }
  }
  if (stack.length !== 1) {
    throw new CadGeometryUnavailableError(`Malformed SVG: <${stack[stack.length - 1].name}> is never closed.`);
  }
  return rootHolder.children.find((n) => n.name === 'svg') ?? null;
}

/** Containers rendered as groups. */
const GROUP_ELEMENTS = new Set(['g', 'a']);

/** Rendered SVG content the metafile encoders cannot represent. */
function unsupportedElementError(name: string): UnsupportedOptionError {
  return new UnsupportedOptionError(`SVG element <${name}> is not supported by metafile encoders.`);
}


function assertNoUnsupportedReferences(attrs: Map<string, string>): void {
  const style = parseStyleDeclarations(attrs.get('style'));
  for (const prop of UNSUPPORTED_REFERENCE_PROPERTIES) {
    const value = style.get(prop) ?? attrs.get(prop);
    if (value !== undefined && value.trim() !== '' && value.trim().toLowerCase() !== 'none') {
      throw new UnsupportedOptionError(`SVG ${prop} "${value.trim()}" is not supported by metafile encoders.`);
    }
  }
}

/** Elements in a foreign (editor) namespace, e.g. sodipodi:namedview, which SVG renderers ignore. */
function isForeignNamespaceElement(name: string): boolean {
  return name.includes(':');
}

interface RenderState {
  elements: SvgGeometryElement[];
  ids: Map<string, SvgNode>;
  /** ids of the <use> targets currently being instantiated, for cycle detection. */
  useChain: string[];
  renderedNodes: number;
  sheet: CssRule[];
  depth: number;
}

/** Upper bound on rendered nodes, so nested <use> fan-out cannot explode. */
const MAX_RENDERED_NODES = 100000;

function indexIds(node: SvgNode, ids: Map<string, SvgNode>): void {
  const id = node.attrs.get('id');
  if (id !== undefined && !ids.has(id)) ids.set(id, node);
  for (const child of node.children) indexIds(child, ids);
}

/**
 * Instantiates a <use> reference (SVG 1.1 section 5.6): the target renders as
 * a child of the use element, under transform(use) * translate(x, y).
 */
function renderUse(node: SvgNode, ctx: StyleContext, state: RenderState): void {
  const href = (node.attrs.get('href') ?? node.attrs.get('xlink:href') ?? '').trim();
  if (href === '') {
    throw new CadGeometryUnavailableError('SVG <use> element has no href reference.');
  }
  if (!href.startsWith('#')) {
    throw new UnsupportedOptionError(`External SVG <use> reference "${href}" is not supported by metafile encoders.`);
  }
  const id = href.slice(1);
  const target = state.ids.get(id);
  if (!target) {
    throw new CadGeometryUnavailableError(`SVG <use> reference "${href}" does not match any element.`);
  }
  if (state.useChain.includes(id)) {
    throw new CadGeometryUnavailableError(`SVG <use> reference cycle: ${[...state.useChain, id].map((x) => `#${x}`).join(' -> ')}.`);
  }
  const offset: AffineMatrix = [1, 0, 0, 1, numberAttr(node.attrs, 'x'), numberAttr(node.attrs, 'y')];
  const useCtx: StyleContext = { ...ctx, ctm: multiplyMatrix(ctx.ctm, offset) };
  state.useChain.push(id);
  if (target.name === 'symbol') {
    if (target.attrs.has('viewBox')) {
      throw new UnsupportedOptionError('SVG <symbol> with a viewBox is not supported by metafile encoders.');
    }
    renderChildren(target, useCtx, state);
  } else if (NON_RENDERED_ELEMENTS.has(target.name)) {
    throw new UnsupportedOptionError(`SVG <use> of non-rendering element <${target.name}> is not supported by metafile encoders.`);
  } else {
    renderNode(target, useCtx, state);
  }
  state.useChain.pop();
}

function renderChildren(node: SvgNode, ctx: StyleContext, state: RenderState): void {
  for (const child of node.children) renderNode(child, ctx, state);
}

function emitShape(node: SvgNode, ctx: StyleContext, state: RenderState): void {
  if (ctx.visibility !== 'visible') return;
  const shape = shapeGeometry(node.name, node.attrs);
  const strokeWidth = resolveStrokeWidth(ctx.strokeWidth);
  if (!shape || shape.subpaths.length === 0) return;
  const deviceSubpaths = shape.subpaths.map((sub) =>
    sub.map((p) => {
      const d = applyMatrix(ctx.ctm, p.x, p.y);
      requireFinite(d.x, `<${node.name}> device coordinate`);
      requireFinite(d.y, `<${node.name}> device coordinate`);
      return d;
    })
  );
  requireFinite(strokeWidth * matrixLengthScale(ctx.ctm), `<${node.name}> device stroke width`);
  const stroke = strokeWidth > 0 ? resolvePaint(ctx.stroke, ctx.color, 'stroke') : null;
  if (stroke && !isUniformScale(ctx.ctm)) {
    throw new UnsupportedOptionError(
      `Stroked SVG <${node.name}> under a non-uniform scale or skew is not supported: a metafile pen has one width.`
    );
  }
  state.elements.push({
    subpaths: deviceSubpaths,
    isClosed: shape.isClosed,
    fillable: node.name !== 'line',
    fill: resolvePaint(ctx.fill, ctx.color, 'fill'),
    fillRule: ctx.fillRule.trim() === 'evenodd' ? 'evenodd' : 'nonzero',
    stroke,
    strokeWidth: strokeWidth * matrixLengthScale(ctx.ctm),
    strokeLinecap: ctx.strokeLinecap.trim() as SvgLinecap,
    strokeLinejoin: ctx.strokeLinejoin.trim() as SvgLinejoin,
    strokeMiterlimit: Number(ctx.strokeMiterlimit.trim()),
  });
}

function renderNode(node: SvgNode, parent: StyleContext, state: RenderState): void {
  if (++state.depth > MAX_SVG_NESTING_DEPTH) throw nestingTooDeep();
  renderNodeAtDepth(node, parent, state);
  state.depth--;
}

function renderNodeAtDepth(node: SvgNode, parent: StyleContext, state: RenderState): void {
  if (NON_RENDERED_ELEMENTS.has(node.name) || isForeignNamespaceElement(node.name)) return;
  if (++state.renderedNodes > MAX_RENDERED_NODES) {
    throw new CadGeometryUnavailableError(`SVG expands to more than ${MAX_RENDERED_NODES} rendered elements.`);
  }
  if (node.name === 'svg') {
    throw new CadGeometryUnavailableError('Nested <svg> viewports are not supported by the metafile encoders.');
  }
  const isShape = SHAPE_ELEMENTS.has(node.name);
  const isUse = node.name === 'use';
  if (!isShape && !isUse && !GROUP_ELEMENTS.has(node.name)) throw unsupportedElementError(node.name);

  const declared = declaredProperties(node.attrs, node.name, state.sheet);
  assertNeutralPaintProperties(declared);
  if (declared.get('display') === 'none') return;
  assertNoUnsupportedReferences(node.attrs);
  const ctx = deriveContext(parent, node.attrs, declared);
  if (isShape) {
    emitShape(node, ctx, state);
  } else if (isUse) {
    renderUse(node, ctx, state);
  } else {
    renderChildren(node, ctx, state);
  }
}

/**
 * Parses SVG XML into geometry elements with flattened polylines in device
 * (viewport) coordinates, honouring the style cascade, inheritance from
 * container elements and transforms. Rendered content that cannot be
 * represented (text, images, clipping, ...) throws instead of being dropped.
 */
export function parseSvgGeometries(svgContent: string): ParsedSvgVectorDocument {
  const root = buildSvgTree(svgContent);
  if (!root) {
    return { width: DEFAULT_VIEWPORT_WIDTH, height: DEFAULT_VIEWPORT_HEIGHT, elements: [] };
  }
  const viewport = resolveViewport(root.attrs);
  const sheet = extractStylesheets(svgContent);
  const declared = declaredProperties(root.attrs, root.name, sheet);
  assertNeutralPaintProperties(declared);
  assertNoUnsupportedReferences(root.attrs);
  const rootCtx = deriveContext({ ...INITIAL_STYLE, ctm: viewport.matrix }, root.attrs, declared);
  const state: RenderState = { elements: [], ids: new Map(), useChain: [], renderedNodes: 0, sheet, depth: 0 };
  indexIds(root, state.ids);
  if (declared.get('display') !== 'none') renderChildren(root, rootCtx, state);
  return { width: viewport.width, height: viewport.height, elements: state.elements };
}
