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
const CSS_NUMBER = String.raw`[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?`;
const COLOR_FUNCTION_PATTERN = /^(rgba?|hsla?)\(([^()]*)\)$/;
const NUMBER_WITH_UNIT_PATTERN = new RegExp(`^(${CSS_NUMBER})([a-z%]*)$`);

/** A parsed colour: `rgb` is null for fully transparent; undefined means invalid. */
type ParsedColor = { rgb: RgbColor | null } | undefined;

const TRANSPARENT: ParsedColor = { rgb: null };

function clampChannel(v: number): number {
  return Math.max(0, Math.min(RGB_MAX, Math.round(v)));
}

function fromAlpha(rgb: RgbColor, alpha: number, source: string): ParsedColor {
  if (alpha <= 0) return TRANSPARENT;
  if (alpha < 1) {
    throw new UnsupportedOptionError(`Semi-transparent SVG colour "${source}" is not supported by metafile encoders.`);
  }
  return { rgb };
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
  const parts = body.split('/');
  if (parts.length > 2) return undefined;
  const main = parts[0];
  const channels = main.includes(',')
    ? main.split(',').map((p) => p.trim())
    : main.trim().split(/\s+/);
  let alpha: string | undefined;
  if (parts.length === 2) {
    alpha = parts[1].trim();
  } else if (main.includes(',') && channels.length === 4) {
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
  if (s === 'transparent') return TRANSPARENT;
  const named = CSS_NAMED_COLORS.get(s);
  if (named !== undefined) {
    return { rgb: { r: (named >> 16) & RGB_MAX, g: (named >> 8) & RGB_MAX, b: named & RGB_MAX } };
  }
  if (s.startsWith('#')) return parseHexColor(s.substring(1), raw);
  const fn = COLOR_FUNCTION_PATTERN.exec(s);
  if (!fn) return undefined;
  const args = splitColorArgs(fn[2].trimStart());
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
  return parseColorValue(colorStr)?.rgb ?? null;
}

const BLACK: RgbColor = { r: 0, g: 0, b: 0 };

const PAINT_KEYWORDS = new Set(['none', 'currentcolor', 'inherit']);
const COLOR_KEYWORDS = new Set(['currentcolor', 'inherit']);

function invalidPaint(property: string, value: string): UnsupportedOptionError {
  return new UnsupportedOptionError(`SVG ${property} value "${value}" is not a valid colour or paint.`);
}

/**
 * Rejects unparseable fill, stroke and color declarations wherever they come
 * from (attribute, inline style or stylesheet) instead of silently ignoring them.
 */
function assertValidPaintDeclarations(declared: Map<string, string>): void {
  for (const property of ['fill', 'stroke', 'color']) {
    const raw = declared.get(property);
    if (raw === undefined) continue;
    const v = raw.trim().toLowerCase();
    const keywords = property === 'color' ? COLOR_KEYWORDS : PAINT_KEYWORDS;
    if (keywords.has(v) || (property !== 'color' && v.startsWith('url('))) continue;
    if (parseColorValue(v) === undefined) throw invalidPaint(property, raw.trim());
  }
}

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
  const parsed = lower === 'currentcolor' ? parseColorValue(currentColor) ?? { rgb: BLACK } : parseColorValue(v);
  if (parsed === undefined) throw invalidPaint(property, v);
  return parsed.rgb ? { ...parsed.rgb } : null;
}

/**
 * Upper bound on device vertices per document (all shapes and <use> copies).
 * At 4 bytes per EMF/WMF point and about 12 characters per CGM point this
 * keeps outputs within a few megabytes (strokes may double that) and keeps
 * parsing and encoding well under a second, while leaving ample room for
 * detailed technical drawings.
 */
const MAX_DOCUMENT_VERTICES = 500_000;

/** Counts every emitted vertex of a document and fails as soon as the cap is crossed. */
export class VertexBudget {
  private used = 0;

  constructor(private readonly limit: number = MAX_DOCUMENT_VERTICES) {}

  charge(count = 1): void {
    this.used += count;
    if (this.used > this.limit) {
      throw new CadGeometryUnavailableError(
        `SVG expands to more than ${this.limit} vertices; the drawing is too complex to encode.`
      );
    }
  }
}

interface PathState {
  currentX: number;
  currentY: number;
  lastCpX: number;
  lastCpY: number;
}

/** Parser position plus the drawing state shared by all path command handlers. */
interface PathCursor {
  tokens: PathTokenStream;
  isRel: boolean;
  prevUpper: string;
  state: PathState;
  subpath: Point3D[];
  tolerance: number;
  budget: VertexBudget | undefined;
}

/** Appends one flattened vertex, charging the document's vertex budget first. */
function emitPoint(c: PathCursor, p: Point3D): void {
  c.budget?.charge();
  c.subpath.push(p);
}

/** Reads `count` numeric arguments, or returns null when the command is truncated or malformed. */
function readArgs(c: PathCursor, count: number): number[] | null {
  const args: number[] = [];
  for (let k = 0; k < count; k++) {
    const t = c.tokens.peek();
    if (t === undefined || !PATH_NUMBER_PATTERN.test(t)) return null;
    c.tokens.next();
    args.push(Number(t));
  }
  return args;
}

/** Resolves a coordinate pair, relative to the current point for lower-case commands. */
function resolvePoint(c: PathCursor, x: number, y: number): Point3D {
  return c.isRel ? { x: c.state.currentX + x, y: c.state.currentY + y, z: 0 } : { x, y, z: 0 };
}

function currentPoint(c: PathCursor): Point3D {
  return { x: c.state.currentX, y: c.state.currentY, z: 0 };
}

/** Moves the current point; `controlPoint` is remembered for smooth S/T reflection. */
function moveTo(c: PathCursor, p: Point3D, controlPoint: Point3D = p): void {
  c.state.currentX = p.x;
  c.state.currentY = p.y;
  c.state.lastCpX = controlPoint.x;
  c.state.lastCpY = controlPoint.y;
}

function reflectedControlPoint(c: PathCursor, previousCommands: ReadonlySet<string>): Point3D {
  if (!previousCommands.has(c.prevUpper)) return currentPoint(c);
  return { x: 2 * c.state.currentX - c.state.lastCpX, y: 2 * c.state.currentY - c.state.lastCpY, z: 0 };
}

function pushCubic(c: PathCursor, p1: Point3D, p2: Point3D, p3: Point3D): void {
  const curvePts = adaptiveTessellateCubicBezier(currentPoint(c), p1, p2, p3, c.tolerance);
  for (let k = 1; k < curvePts.length; k++) emitPoint(c, curvePts[k]);
}

/** Degree elevation: the cubic control points equivalent to a quadratic segment. */
function pushQuadratic(c: PathCursor, cp: Point3D, end: Point3D): void {
  const p0 = currentPoint(c);
  const twoThirds = 2 / 3;
  const p1: Point3D = { x: p0.x + twoThirds * (cp.x - p0.x), y: p0.y + twoThirds * (cp.y - p0.y), z: 0 };
  const p2: Point3D = { x: end.x + twoThirds * (cp.x - end.x), y: end.y + twoThirds * (cp.y - end.y), z: 0 };
  pushCubic(c, p1, p2, end);
}

const CUBIC_COMMANDS: ReadonlySet<string> = new Set(['C', 'S']);
const QUADRATIC_COMMANDS: ReadonlySet<string> = new Set(['Q', 'T']);

/** Command handlers (upper-case letter); each returns false on missing or invalid arguments. */
const PATH_HANDLERS: Record<string, (c: PathCursor) => boolean> = {
  L: (c) => {
    const a = readArgs(c, 2);
    if (!a) return false;
    const p = resolvePoint(c, a[0], a[1]);
    emitPoint(c, p);
    moveTo(c, p);
    return true;
  },
  H: (c) => {
    const a = readArgs(c, 1);
    if (!a) return false;
    const p: Point3D = { x: c.isRel ? c.state.currentX + a[0] : a[0], y: c.state.currentY, z: 0 };
    emitPoint(c, p);
    moveTo(c, p);
    return true;
  },
  V: (c) => {
    const a = readArgs(c, 1);
    if (!a) return false;
    const p: Point3D = { x: c.state.currentX, y: c.isRel ? c.state.currentY + a[0] : a[0], z: 0 };
    emitPoint(c, p);
    moveTo(c, p);
    return true;
  },
  C: (c) => {
    const a = readArgs(c, 6);
    if (!a) return false;
    const p2 = resolvePoint(c, a[2], a[3]);
    const p3 = resolvePoint(c, a[4], a[5]);
    pushCubic(c, resolvePoint(c, a[0], a[1]), p2, p3);
    moveTo(c, p3, p2);
    return true;
  },
  S: (c) => {
    const a = readArgs(c, 4);
    if (!a) return false;
    const p1 = reflectedControlPoint(c, CUBIC_COMMANDS);
    const p2 = resolvePoint(c, a[0], a[1]);
    const p3 = resolvePoint(c, a[2], a[3]);
    pushCubic(c, p1, p2, p3);
    moveTo(c, p3, p2);
    return true;
  },
  Q: (c) => {
    const a = readArgs(c, 4);
    if (!a) return false;
    const cp = resolvePoint(c, a[0], a[1]);
    const end = resolvePoint(c, a[2], a[3]);
    pushQuadratic(c, cp, end);
    moveTo(c, end, cp);
    return true;
  },
  T: (c) => {
    const a = readArgs(c, 2);
    if (!a) return false;
    const cp = reflectedControlPoint(c, QUADRATIC_COMMANDS);
    const end = resolvePoint(c, a[0], a[1]);
    pushQuadratic(c, cp, end);
    moveTo(c, end, cp);
    return true;
  },
  A: (c) => {
    const a = readArgs(c, 7);
    if (!a) return false;
    const [rx, ry, rot, largeArc, sweep] = a;
    const end = resolvePoint(c, a[5], a[6]);
    for (const p of tessellateSvgArc(c.state.currentX, c.state.currentY, rx, ry, rot, largeArc !== 0, sweep !== 0, end.x, end.y)) {
      emitPoint(c, p);
    }
    moveTo(c, end);
    return true;
  },
};

const PATH_TOKEN_PATTERN = /[MmLlHhVvCcSsQqTtAaZz]|[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?|[\s,]+|[^]/g;
const PATH_SEPARATOR_PATTERN = /^[\s,]+$/;
const PATH_TOKEN_VALID = /^(?:[MmLlHhVvCcSsQqTtAaZz]|[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?)$/;

/**
 * Lazily splits path data into commands and numbers, so a huge path is only
 * tokenized as far as it is parsed; any other character fails closed.
 */
class PathTokenStream {
  private readonly matches: IterableIterator<RegExpMatchArray>;
  private lookahead: string | undefined;

  constructor(private readonly d: string) {
    this.matches = d.matchAll(PATH_TOKEN_PATTERN);
    this.lookahead = this.pull();
  }

  private pull(): string | undefined {
    for (let r = this.matches.next(); !r.done; r = this.matches.next()) {
      const tok = r.value[0];
      if (PATH_SEPARATOR_PATTERN.test(tok)) continue;
      if (!PATH_TOKEN_VALID.test(tok)) {
        throw new CadGeometryUnavailableError(`Malformed SVG path data: unexpected character "${tok}".`);
      }
      return tok;
    }
    return undefined;
  }

  peek(): string | undefined {
    return this.lookahead;
  }

  next(): string | undefined {
    const tok = this.lookahead;
    this.lookahead = this.pull();
    return tok;
  }
}

const PATH_NUMBER_PATTERN = /^[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?$/;

const PATH_COMMAND_PATTERN = /^[MmLlHhVvCcSsQqTtAaZz]$/;

const PATH_EXCERPT_LENGTH = 80;

function malformedPath(d: string, reason: string): CadGeometryUnavailableError {
  const excerpt = d.length > PATH_EXCERPT_LENGTH ? `${d.slice(0, PATH_EXCERPT_LENGTH)}...` : d;
  return new CadGeometryUnavailableError(`Malformed SVG path data "${excerpt}": ${reason}.`);
}

/** Z: closes the sub-path back to its start point, which becomes the current point. */
function closeSubpath(c: PathCursor, subpaths: Point3D[][]): void {
  if (c.subpath.length > 1) {
    const first = c.subpath[0];
    emitPoint(c, { x: first.x, y: first.y, z: first.z });
    c.state.currentX = first.x;
    c.state.currentY = first.y;
  }
  subpaths.push(c.subpath);
  c.subpath = [];
}

/**
 * Parses SVG path 'd' data (SVG 1.1 section 8.3) into adaptive polyline
 * vertices, one array per sub-path.
 */
/** Runs one non-Z command; returns the command that applies to following implicit arguments. */
function runDrawingCommand(c: PathCursor, cmd: string, upper: string, subpaths: Point3D[][], d: string): string {
  if (upper === 'M' && c.subpath.length > 0) {
    subpaths.push(c.subpath);
    c.subpath = [];
  } else if (upper !== 'M' && c.subpath.length === 0) {
    // A drawing command after Z continues from the closed sub-path's start point
    emitPoint(c, currentPoint(c));
  }
  const handler = PATH_HANDLERS[upper === 'M' ? 'L' : upper];
  if (!handler(c)) throw malformedPath(d, `missing or invalid arguments for ${cmd}`);
  // Extra coordinate pairs after a moveto are implicit lineto commands
  if (upper !== 'M') return cmd;
  return c.isRel ? 'l' : 'L';
}

/** Consumes an explicit command letter, or keeps the current one for implicit repetition. */
function nextCommand(c: PathCursor, tok: string, cmd: string, d: string): string {
  if (PATH_COMMAND_PATTERN.test(tok)) {
    c.tokens.next();
    return tok;
  }
  if (!cmd) throw malformedPath(d, 'coordinates before the first command');
  return cmd;
}

export function parseSvgPathToPoints(d: string, tolerance: number = 0.25, budget?: VertexBudget): Point3D[][] {
  const subpaths: Point3D[][] = [];
  const c: PathCursor = {
    tokens: new PathTokenStream(d),
    isRel: false,
    prevUpper: '',
    state: { currentX: 0, currentY: 0, lastCpX: 0, lastCpY: 0 },
    subpath: [],
    tolerance,
    budget,
  };
  let cmd = '';
  for (let tok = c.tokens.peek(); tok !== undefined; tok = c.tokens.peek()) {
    cmd = nextCommand(c, tok, cmd, d);
    const upper = cmd.toUpperCase();
    c.isRel = cmd !== upper;
    if (upper === 'Z') {
      closeSubpath(c, subpaths);
      cmd = '';
    } else {
      cmd = runDrawingCommand(c, cmd, upper, subpaths, d);
    }
    c.prevUpper = upper;
  }
  if (c.subpath.length > 0) subpaths.push(c.subpath);
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
const TRANSFORM_NUMBER_PATTERN = /^[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?$/;

function rotationMatrix(args: number[]): AffineMatrix | null {
  if (args.length !== 1 && args.length !== 3) return null;
  const rad = args[0] * DEGREES_TO_RADIANS;
  const rotation: AffineMatrix = [Math.cos(rad), Math.sin(rad), -Math.sin(rad), Math.cos(rad), 0, 0];
  if (args.length === 1) return rotation;
  const [, cx, cy] = args;
  return multiplyMatrix(multiplyMatrix([1, 0, 0, 1, cx, cy], rotation), [1, 0, 0, 1, -cx, -cy]);
}

/** One- or two-argument functions where the second argument defaults from the first. */
function pairArgs(args: number[], defaultSecond: (first: number) => number): [number, number] | null {
  if (args.length === 1) return [args[0], defaultSecond(args[0])];
  return args.length === 2 ? [args[0], args[1]] : null;
}

/** SVG 1.1 section 7.6 transform functions; each returns null for a wrong argument count. */
const TRANSFORM_FUNCTIONS: Record<string, (args: number[]) => AffineMatrix | null> = {
  matrix: (args) => (args.length === 6 ? (args as AffineMatrix) : null),
  translate: (args) => {
    const p = pairArgs(args, () => 0);
    return p ? [1, 0, 0, 1, p[0], p[1]] : null;
  },
  scale: (args) => {
    const p = pairArgs(args, (first) => first);
    return p ? [p[0], 0, 0, p[1], 0, 0] : null;
  },
  rotate: rotationMatrix,
  skewX: (args) => (args.length === 1 ? [1, 0, Math.tan(args[0] * DEGREES_TO_RADIANS), 1, 0, 0] : null),
  skewY: (args) => (args.length === 1 ? [1, Math.tan(args[0] * DEGREES_TO_RADIANS), 0, 1, 0, 0] : null),
};

function transformFunctionMatrix(name: string, args: number[]): AffineMatrix | null {
  const build = TRANSFORM_FUNCTIONS[name];
  return build ? build(args) : null;
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
    // Every argument must be present: "translate(,5)" or a trailing comma is malformed.
    const rawArgs = fn ? fn[2].trim().split(/\s*,\s*|\s+/) : [];
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

const XML_NAME_PATTERN = /[A-Za-z_][\w:.-]*/y;
const XML_ATTR_PATTERN = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'))?/g;
const XML_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

const MAX_CODE_POINT = 0x10ffff;

function decodeXmlEntities(value: string): string {
  return value.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (whole, ent: string) => {
    if (ent.startsWith('#')) {
      const code = ent.startsWith('#x') ? Number.parseInt(ent.slice(2), 16) : Number.parseInt(ent.slice(1), 10);
      if (Number.isNaN(code) || code < 0 || code > MAX_CODE_POINT) {
        throw new CadGeometryUnavailableError(`Invalid XML character reference "${whole}".`);
      }
      return String.fromCodePoint(code);
    }
    return XML_ENTITIES[ent] ?? whole;
  });
}

/** Largest SVG text (and decompressed SVGZ payload) the parser accepts. */
export const MAX_SVG_INPUT_CHARS = 5 * 1024 * 1024;

function malformedXml(reason: string): CadGeometryUnavailableError {
  return new CadGeometryUnavailableError(`Malformed SVG: ${reason}.`);
}

/** Index just past the end of a markup declaration, or throws when it is never terminated. */
function endOfMarkup(xml: string, from: number, terminator: string, what: string): number {
  const end = xml.indexOf(terminator, from);
  if (end < 0) throw malformedXml(`unterminated ${what}`);
  return end + terminator.length;
}

const CHAR_GT = 0x3e;
const CHAR_DQUOTE = 0x22;
const CHAR_SQUOTE = 0x27;
const CHAR_SLASH = 0x2f;

/** Index of the `>` that closes the tag whose attribute text starts at `from`; quoted values may contain `>`. */
function endOfTag(xml: string, from: number): number {
  let i = from;
  while (i < xml.length) {
    const c = xml.charCodeAt(i);
    if (c === CHAR_GT) return i;
    if (c === CHAR_DQUOTE || c === CHAR_SQUOTE) {
      const close = xml.indexOf(c === CHAR_DQUOTE ? '"' : "'", i + 1);
      if (close < 0) throw malformedXml('unterminated attribute value');
      i = close + 1;
    } else {
      i++;
    }
  }
  throw malformedXml('unterminated tag');
}

/** Position after a comment, CDATA section, processing instruction or declaration starting at `lt`; -1 for an element. */
function skipNonElementMarkup(xml: string, lt: number): number {
  if (xml.startsWith('<!--', lt)) return endOfMarkup(xml, lt + 4, '-->', 'comment');
  if (xml.startsWith('<![CDATA[', lt)) return endOfMarkup(xml, lt + 9, ']]>', 'CDATA section');
  if (xml.startsWith('<?', lt)) return endOfMarkup(xml, lt + 2, '?>', 'processing instruction');
  if (xml.startsWith('<!', lt)) return endOfMarkup(xml, lt + 2, '>', 'declaration');
  return -1;
}

/** Single-pass, linear-time tokenizer; every scan advances past the text it consumed. */
function* scanXmlTags(xml: string): Generator<XmlTag> {
  let pos = 0;
  while (pos < xml.length) {
    const lt = xml.indexOf('<', pos);
    if (lt < 0) return;
    const after = skipNonElementMarkup(xml, lt);
    if (after >= 0) {
      pos = after;
      continue;
    }
    const closing = xml.charCodeAt(lt + 1) === CHAR_SLASH;
    const nameStart = closing ? lt + 2 : lt + 1;
    XML_NAME_PATTERN.lastIndex = nameStart;
    const nameMatch = XML_NAME_PATTERN.exec(xml);
    if (!nameMatch) {
      pos = lt + 1; // a bare "<" in character data
      continue;
    }
    const name = nameMatch[0];
    const attrStart = nameStart + name.length;
    const tagEnd = endOfTag(xml, attrStart);
    let attrText = xml.substring(attrStart, tagEnd).trimEnd();
    const selfClosing = attrText.endsWith('/');
    if (selfClosing) attrText = attrText.slice(0, -1);
    const attrs = new Map<string, string>();
    for (const a of attrText.matchAll(XML_ATTR_PATTERN)) {
      attrs.set(a[1], decodeXmlEntities(a[2] ?? a[3] ?? ''));
    }
    pos = tagEnd + 1;
    yield { name: name.replace(/^svg:/, ''), attrs, closing, selfClosing };
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
  'stroke-miterlimit': (v) => SVG_NUMBER_PATTERN.test(v) && Number(v) >= 1,
  'stroke-linecap': (v) => SVG_LINECAPS.has(v),
  'stroke-linejoin': (v) => SVG_LINEJOINS.has(v),
};

const SVG_LINECAPS = new Set(['butt', 'round', 'square']);
const SVG_LINEJOINS = new Set(['miter', 'round', 'bevel']);

function isOpaque(value: string): boolean {
  const v = value.trim();
  const isPercent = v.endsWith('%');
  const body = isPercent ? v.slice(0, -1) : v;
  if (!SVG_NUMBER_PATTERN.test(body)) return false;
  return Number(body) >= (isPercent ? 100 : 1);
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

const IMPORTANT_SUFFIX = /!\s*important$/i;

function parseDeclarationList(style: string | undefined): Map<string, CssDeclaration> {
  const map = new Map<string, CssDeclaration>();
  if (!style) return map;
  for (const decl of style.split(';')) {
    const colonIdx = decl.indexOf(':');
    if (colonIdx > 0) {
      const key = decl.substring(0, colonIdx).trim().toLowerCase();
      const raw = decl.substring(colonIdx + 1).trim();
      const important = IMPORTANT_SUFFIX.test(raw);
      const value = important ? raw.replace(IMPORTANT_SUFFIX, '').trim() : raw;
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

const STYLE_CLOSE_PATTERN = /<\/style\s*>/iy;
const STYLE_NAME_LENGTH = 'style'.length;
const CDATA_OPEN = '<![CDATA[';
const CDATA_CLOSE = ']]>';

/** Text of a <style> body starting at `from`: CDATA sections unwrap and comments drop; returns the text and the position after `</style>`. */
function readStyleBody(xml: string, from: number): { text: string; next: number } {
  let text = '';
  let p = from;
  for (;;) {
    const lt = xml.indexOf('<', p);
    if (lt < 0) throw malformedXml('<style> is never closed');
    if (xml.startsWith('<!--', lt)) {
      text += `${xml.substring(p, lt)} `;
      p = endOfMarkup(xml, lt + 4, '-->', 'comment');
    } else if (xml.startsWith(CDATA_OPEN, lt)) {
      const end = endOfMarkup(xml, lt + CDATA_OPEN.length, CDATA_CLOSE, 'CDATA section');
      text += xml.substring(p, lt) + xml.substring(lt + CDATA_OPEN.length, end - CDATA_CLOSE.length);
      p = end;
    } else {
      STYLE_CLOSE_PATTERN.lastIndex = lt;
      const close = STYLE_CLOSE_PATTERN.exec(xml);
      if (close) return { text: text + xml.substring(p, lt), next: lt + close[0].length };
      text += xml.substring(p, lt + 1);
      p = lt + 1;
    }
  }
}

/** Text contents of every real <style> element, in document order; comments and CDATA elsewhere are skipped. */
function extractStyleTexts(xml: string): string[] {
  const texts: string[] = [];
  let pos = 0;
  while (pos < xml.length) {
    const lt = xml.indexOf('<', pos);
    if (lt < 0) break;
    const after = skipNonElementMarkup(xml, lt);
    if (after >= 0) {
      pos = after;
      continue;
    }
    const nameStart = lt + 1;
    const isStyle = xml.substring(nameStart, nameStart + STYLE_NAME_LENGTH).toLowerCase() === 'style' && !/[\w:.-]/.test(xml.charAt(nameStart + STYLE_NAME_LENGTH));
    if (!isStyle) {
      pos = nameStart;
      continue;
    }
    const tagEnd = endOfTag(xml, nameStart + STYLE_NAME_LENGTH);
    pos = tagEnd + 1;
    if (xml.charCodeAt(tagEnd - 1) === CHAR_SLASH) continue;
    const body = readStyleBody(xml, pos);
    texts.push(body.text);
    pos = body.next;
  }
  return texts;
}

function extractStylesheets(svgContent: string): CssRule[] {
  const rules: CssRule[] = [];
  for (const text of extractStyleTexts(svgContent)) {
    for (const r of parseStylesheet(text)) rules.push({ ...r, order: rules.length });
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

/** SVG/CSS <number> grammar: no hex, no Infinity/NaN, no empty strings. */
const SVG_NUMBER_PATTERN = /^[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?$/;
const NUMBER_LIST_TOKEN_PATTERN = /[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?|[\s,]+|[^]/g;
const LIST_SEPARATOR_PATTERN = /^[\s,]+$/;

/** Parses one number in strict SVG grammar, throwing the typed error otherwise. */
export function parseSvgNumber(text: string, what: string): number {
  const t = text.trim();
  if (!SVG_NUMBER_PATTERN.test(t)) {
    throw new CadGeometryUnavailableError(`SVG ${what} "${text}" is not a valid number.`);
  }
  return requireFinite(Number(t), `${what} "${text}"`);
}

/** Parses a whitespace/comma separated number list (signs may also separate, as in "10-5"). */
function parseNumberList(value: string, what: string): number[] {
  const out: number[] = [];
  for (const m of value.matchAll(NUMBER_LIST_TOKEN_PATTERN)) {
    const tok = m[0];
    if (LIST_SEPARATOR_PATTERN.test(tok)) continue;
    out.push(parseSvgNumber(tok, what));
  }
  return out;
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

function parsePointList(value: string | undefined, budget: VertexBudget | undefined): { x: number; y: number }[] {
  if (!value) return [];
  const pts: { x: number; y: number }[] = [];
  let pendingX: number | null = null;
  for (const m of value.matchAll(NUMBER_LIST_TOKEN_PATTERN)) {
    if (LIST_SEPARATOR_PATTERN.test(m[0])) continue;
    const n = parseSvgNumber(m[0], 'points value');
    if (pendingX === null) {
      pendingX = n;
    } else {
      budget?.charge();
      pts.push({ x: pendingX, y: n });
      pendingX = null;
    }
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

/** Shapes whose parsers charge the vertex budget themselves, point by point. */
const SELF_CHARGING_SHAPES = new Set(['path', 'polyline', 'polygon']);

function shapeGeometry(name: string, attrs: Map<string, string>, budget?: VertexBudget): UserShape | null {
  const shape = buildShapeGeometry(name, attrs, budget);
  if (shape && budget && !SELF_CHARGING_SHAPES.has(name)) {
    budget.charge(shape.subpaths.reduce((n, sub) => n + sub.length, 0));
  }
  return shape;
}

function buildShapeGeometry(name: string, attrs: Map<string, string>, budget?: VertexBudget): UserShape | null {
  switch (name) {
    case 'path': {
      const d = attrs.get('d');
      if (!d) return null;
      const subpaths = parseSvgPathToPoints(d, PATH_TOLERANCE, budget).filter((s) => s.length >= 2);
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
      const pts = parsePointList(attrs.get('points'), budget);
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
  const parts = value.trim() === '' ? [] : value.trim().split(/\s*,\s*|\s+/).map((v) => parseSvgNumber(v, 'viewBox value'));
  if (parts.length !== 4 || parts[2] <= 0 || parts[3] <= 0) {
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
const LENGTH_PATTERN = /^\s*([-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?)\s*([a-zA-Z%]*)\s*$/;

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
  if (hasViewBox && /^\s*[-+]?(?:\d+(?:\.\d*)?|\.\d+)\s*%\s*$/.test(value)) return null;
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
  vertices: VertexBudget;
  /** User-space geometry per element, reused by every <use> copy. */
  shapeCache: Map<SvgNode, UserShape | null>;
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
  let shape = state.shapeCache.get(node);
  if (shape === undefined) {
    // Path and point-list parsing charge the budget per emitted vertex.
    shape = shapeGeometry(node.name, node.attrs, state.vertices);
    state.shapeCache.set(node, shape);
  } else if (shape) {
    // A <use> copy re-emits every cached vertex.
    state.vertices.charge(shape.subpaths.reduce((n, sub) => n + sub.length, 0));
  }
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
    strokeMiterlimit: parseSvgNumber(ctx.strokeMiterlimit, 'stroke-miterlimit'),
  });
}

function renderNode(node: SvgNode, parent: StyleContext, state: RenderState): void {
  if (++state.depth > MAX_SVG_NESTING_DEPTH) throw nestingTooDeep();
  renderNodeAtDepth(node, parent, state);
  state.depth--;
}

type RenderedKind = 'shape' | 'use' | 'group';

/** Classifies an element for rendering: null for non-rendering content, otherwise its kind; unsupported elements throw. */
function classifyElement(node: SvgNode): RenderedKind | null {
  if (NON_RENDERED_ELEMENTS.has(node.name) || isForeignNamespaceElement(node.name)) return null;
  if (node.name === 'svg') {
    throw new CadGeometryUnavailableError('Nested <svg> viewports are not supported by the metafile encoders.');
  }
  if (SHAPE_ELEMENTS.has(node.name)) return 'shape';
  if (node.name === 'use') return 'use';
  if (GROUP_ELEMENTS.has(node.name)) return 'group';
  throw unsupportedElementError(node.name);
}

function renderNodeAtDepth(node: SvgNode, parent: StyleContext, state: RenderState): void {
  const kind = classifyElement(node);
  if (kind === null) return;
  if (++state.renderedNodes > MAX_RENDERED_NODES) {
    throw new CadGeometryUnavailableError(`SVG expands to more than ${MAX_RENDERED_NODES} rendered elements.`);
  }
  const declared = declaredProperties(node.attrs, node.name, state.sheet);
  assertNeutralPaintProperties(declared);
  assertValidPaintDeclarations(declared);
  if (declared.get('display') === 'none') return;
  assertNoUnsupportedReferences(node.attrs);
  const ctx = deriveContext(parent, node.attrs, declared);
  if (kind === 'shape') {
    emitShape(node, ctx, state);
  } else if (kind === 'use') {
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
  if (svgContent.length > MAX_SVG_INPUT_CHARS) {
    throw new CadGeometryUnavailableError(`SVG input exceeds the ${MAX_SVG_INPUT_CHARS}-character limit.`);
  }
  const root = buildSvgTree(svgContent);
  if (!root) {
    return { width: DEFAULT_VIEWPORT_WIDTH, height: DEFAULT_VIEWPORT_HEIGHT, elements: [] };
  }
  const viewport = resolveViewport(root.attrs);
  const sheet = extractStylesheets(svgContent);
  const declared = declaredProperties(root.attrs, root.name, sheet);
  assertNeutralPaintProperties(declared);
  assertValidPaintDeclarations(declared);
  assertNoUnsupportedReferences(root.attrs);
  const rootCtx = deriveContext({ ...INITIAL_STYLE, ctm: viewport.matrix }, root.attrs, declared);
  const state: RenderState = { elements: [], ids: new Map(), useChain: [], renderedNodes: 0, vertices: new VertexBudget(), shapeCache: new Map(), sheet, depth: 0 };
  indexIds(root, state.ids);
  if (declared.get('display') !== 'none') renderChildren(root, rootCtx, state);
  return { width: viewport.width, height: viewport.height, elements: state.elements };
}
