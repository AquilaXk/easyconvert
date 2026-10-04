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
  ctm: AffineMatrix;
}

const INITIAL_STYLE: StyleContext = {
  fill: 'black',
  stroke: 'none',
  strokeWidth: '1',
  fillRule: 'nonzero',
  color: 'black',
  visibility: 'visible',
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
};

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

function parseStyleDeclarations(style: string | undefined): Map<string, string> {
  const map = new Map<string, string>();
  if (!style) return map;
  for (const decl of style.split(';')) {
    const colonIdx = decl.indexOf(':');
    if (colonIdx > 0) {
      const key = decl.substring(0, colonIdx).trim().toLowerCase();
      const val = decl.substring(colonIdx + 1).replace(/!important\s*$/i, '').trim();
      if (key && val) map.set(key, val);
    }
  }
  return map;
}

/** Collects the element's own declared properties; the style attribute wins over attributes. */
function declaredProperties(attrs: Map<string, string>): Map<string, string> {
  const declared = new Map<string, string>();
  for (const name of [...Object.keys(INHERITED_PROPERTIES), 'display']) {
    const v = attrs.get(name);
    if (v !== undefined && v.trim() !== '') declared.set(name, v.trim());
  }
  for (const [k, v] of parseStyleDeclarations(attrs.get('style'))) {
    declared.set(k, v);
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

function numberAttr(attrs: Map<string, string>, name: string): number {
  const v = attrs.get(name);
  if (v === undefined) return 0;
  const n = Number.parseFloat(v);
  return Number.isFinite(n) ? n : 0;
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
  const coords = value.trim().split(/[\s,]+/).map((v) => Number.parseFloat(v));
  const pts: { x: number; y: number }[] = [];
  for (let k = 0; k + 1 < coords.length; k += 2) {
    if (Number.isFinite(coords[k]) && Number.isFinite(coords[k + 1])) {
      pts.push({ x: coords[k], y: coords[k + 1] });
    }
  }
  return pts;
}

interface UserShape {
  subpaths: { x: number; y: number }[][];
  isClosed: boolean;
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
const MIN_STROKE_WIDTH = 0.5;
const DEFAULT_STROKE_WIDTH = 1;

function resolveStrokeWidth(value: string): number {
  const n = Number.parseFloat(value);
  return Math.max(MIN_STROKE_WIDTH, n || DEFAULT_STROKE_WIDTH);
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
  const parts = value.trim().split(/[\s,]+/).map((v) => Number.parseFloat(v));
  if (parts.length >= 4 && parts[2] > 0 && parts[3] > 0) return [parts[0], parts[1], parts[2], parts[3]];
  return null;
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

/** Parses an absolute length to CSS px; relative units (%, em, ...) yield null. */
function parseAbsoluteLength(value: string | undefined): number | null {
  if (value === undefined) return null;
  const m = LENGTH_PATTERN.exec(value);
  if (!m) return null;
  const factor = ABSOLUTE_LENGTH_UNITS[m[2].toLowerCase()];
  if (factor === undefined) return null;
  const px = Number.parseFloat(m[1]) * factor;
  return px > 0 ? px : null;
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
  const lengthW = parseAbsoluteLength(attrs.get('width'));
  const lengthH = parseAbsoluteLength(attrs.get('height'));

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

/**
 * Parses SVG XML into geometry elements with flattened polylines in device
 * (viewport) coordinates, honouring the style cascade, inheritance from
 * container elements and transforms.
 */
export function parseSvgGeometries(svgContent: string): ParsedSvgVectorDocument {
  const elements: SvgGeometryElement[] = [];
  const stack: { name: string; ctx: StyleContext }[] = [];
  let viewport: Viewport | null = null;
  let skipDepth = 0;

  for (const tag of scanXmlTags(svgContent)) {
    if (tag.closing) {
      if (skipDepth > 0) {
        skipDepth--;
      } else {
        const idx = stack.map((s) => s.name).lastIndexOf(tag.name);
        if (idx >= 0) stack.length = idx;
      }
      continue;
    }
    if (skipDepth > 0) {
      if (!tag.selfClosing) skipDepth++;
      continue;
    }

    if (tag.name === 'svg' && viewport !== null) {
      throw new CadGeometryUnavailableError('Nested <svg> viewports are not supported by the metafile encoders.');
    }
    if (tag.name === 'svg') {
      viewport = resolveViewport(tag.attrs);
    }
    if (viewport === null) continue;

    const parent = stack.length > 0 ? stack[stack.length - 1].ctx : { ...INITIAL_STYLE, ctm: viewport.matrix };
    const declared = declaredProperties(tag.attrs);
    if (NON_RENDERED_ELEMENTS.has(tag.name) || declared.get('display') === 'none') {
      if (!tag.selfClosing) skipDepth = 1;
      continue;
    }
    const ctx = deriveContext(parent, tag.attrs, declared);

    if (SHAPE_ELEMENTS.has(tag.name) && ctx.visibility === 'visible') {
      const shape = shapeGeometry(tag.name, tag.attrs);
      if (shape && shape.subpaths.length > 0) {
        elements.push({
          subpaths: shape.subpaths.map((sub) => sub.map((p) => applyMatrix(ctx.ctm, p.x, p.y))),
          isClosed: shape.isClosed,
          fill: parseCssColor(ctx.fill),
          stroke: parseCssColor(ctx.stroke),
          strokeWidth: resolveStrokeWidth(ctx.strokeWidth),
        });
      }
    }

    if (!tag.selfClosing) stack.push({ name: tag.name, ctx });
  }

  if (viewport === null) {
    return { width: DEFAULT_VIEWPORT_WIDTH, height: DEFAULT_VIEWPORT_HEIGHT, elements };
  }
  return { width: viewport.width, height: viewport.height, elements };
}
