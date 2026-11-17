/**
 * Single-pass post-processing for SVGs produced by `vtracer` / `vtracer-pixels`:
 * responsive `viewBox` injection, XML/comment header stripping, O(1) hex/keyword fill
 * shortening, and division-free collinear cubic-to-line (`H`/`V`/`Z`) path compaction.
 *
 * Reference implementations & licences (3-step evaluation: full AST `svgo` allocates
 * large object graphs on 10-32 MiB traced SVGs; ported as a streaming O(n) pass with
 * static lookup tables and division/sqrt-free integer/float predicates):
 * 1. `svg/svgo` (MIT, Copyright (c) Kir Belevich; commit `31194fb4b3b592d7a65956f8f3b343b9fd6b80a6`):
 *    - `plugins/removeXMLProcInst.js` & `plugins/removeComments.js`
 *    - `plugins/convertColors.js:181-194` & `plugins/_collections.js:2348-2381` (`colorsShortNames`)
 *    - `plugins/convertPathData.js:663-676, 749-778, 885-899, 1136-1155` (`isCurveStraightLine`, `convertToZ`)
 * 2. `visioncortex/vtracer` (MIT OR Apache-2.0; commit `2500df76b5aea0ac22d15296b22722442f825c5b`,
 *    `webapp/app/index.js:365`): `viewBox="0 0 ${width} ${height}"` on `<svg>`.
 */

/** Exact short colour names from `svg/svgo/plugins/_collections.js:2348-2381` (strictly shorter than `#rrggbb`). */
const SVGO_SHORT_COLOR_NAMES: ReadonlyMap<string, string> = new Map([
  ['#f0ffff', 'azure'],
  ['#f5f5dc', 'beige'],
  ['#ffe4c4', 'bisque'],
  ['#a52a2a', 'brown'],
  ['#ff7f50', 'coral'],
  ['#ffd700', 'gold'],
  ['#808080', 'gray'],
  ['#008000', 'green'],
  ['#4b0082', 'indigo'],
  ['#fffff0', 'ivory'],
  ['#f0e68c', 'khaki'],
  ['#faf0e6', 'linen'],
  ['#800000', 'maroon'],
  ['#000080', 'navy'],
  ['#808000', 'olive'],
  ['#ffa500', 'orange'],
  ['#da70d6', 'orchid'],
  ['#cd853f', 'peru'],
  ['#ffc0cb', 'pink'],
  ['#dda0dd', 'plum'],
  ['#800080', 'purple'],
  ['#ff0000', 'red'],
  ['#fa8072', 'salmon'],
  ['#a0522d', 'sienna'],
  ['#c0c0c0', 'silver'],
  ['#fffafa', 'snow'],
  ['#d2b48c', 'tan'],
  ['#008080', 'teal'],
  ['#ff6347', 'tomato'],
  ['#ee82ee', 'violet'],
  ['#f5deb3', 'wheat'],
]);

const STRAIGHT_TOLERANCE_SQ = 1e-6;
const COORD_EPSILON = 1e-6;
const DEFAULT_COORD_PRECISION = 2;

interface Point2D {
  x: number;
  y: number;
}

type Cmd =
  | { kind: 'M'; x: number; y: number }
  | { kind: 'L'; x: number; y: number }
  | { kind: 'C'; x1: number; y1: number; x2: number; y2: number; x: number; y: number }
  | { kind: 'Z' };

/** Shortens a `#RRGGBB` or `#RGB` fill attribute value using O(1) lookup + nibble comparison. */
export function compactHexColor(hex: string): string {
  if (hex.length === 7 && hex.charCodeAt(0) === 0x23) {
    const lower = hex.toLowerCase();
    const named = SVGO_SHORT_COLOR_NAMES.get(lower);
    if (named !== undefined) return named;
    if (lower[1] === lower[2] && lower[3] === lower[4] && lower[5] === lower[6]) {
      return `#${lower[1]}${lower[3]}${lower[5]}`;
    }
    return lower;
  }
  if (hex.length === 4 && hex.charCodeAt(0) === 0x23) {
    const lower = hex.toLowerCase();
    return lower === '#f00' ? 'red' : lower;
  }
  return hex;
}

/**
 * Division-free and `Math.sqrt`-free collinearity + monotonicity check for a cubic Bézier
 * (`start -> c1 -> c2 -> end`), optimising `isCurveStraightLine` from `svg/svgo/plugins/convertPathData.js:1136-1155`.
 */
function isCubicCollinearSegment(start: Point2D, c1: Point2D, c2: Point2D, end: Point2D): boolean {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq <= 1e-12) {
    const d1 = (c1.x - start.x) ** 2 + (c1.y - start.y) ** 2;
    const d2 = (c2.x - start.x) ** 2 + (c2.y - start.y) ** 2;
    return d1 <= STRAIGHT_TOLERANCE_SQ && d2 <= STRAIGHT_TOLERANCE_SQ;
  }
  const rx1 = c1.x - start.x;
  const ry1 = c1.y - start.y;
  const cross1 = dx * ry1 - dy * rx1;
  if (cross1 * cross1 > STRAIGHT_TOLERANCE_SQ * lenSq) return false;

  const rx2 = c2.x - start.x;
  const ry2 = c2.y - start.y;
  const cross2 = dx * ry2 - dy * rx2;
  if (cross2 * cross2 > STRAIGHT_TOLERANCE_SQ * lenSq) return false;

  const dot1 = dx * rx1 + dy * ry1;
  if (dot1 < -COORD_EPSILON || dot1 > lenSq + COORD_EPSILON) return false;
  const dot2 = dx * rx2 + dy * ry2;
  return dot2 >= -COORD_EPSILON && dot2 <= lenSq + COORD_EPSILON;
}

function areLinesCollinearForward(a: Point2D, b: Point2D, c: Point2D): boolean {
  const ux = b.x - a.x;
  const uy = b.y - a.y;
  const vx = c.x - b.x;
  const vy = c.y - b.y;
  const uSq = ux * ux + uy * uy;
  const vSq = vx * vx + vy * vy;
  if (uSq <= 1e-12 || vSq <= 1e-12) return true;
  if (ux * vx + uy * vy < 0) return false;
  const cross = ux * vy - uy * vx;
  return cross * cross <= STRAIGHT_TOLERANCE_SQ * (uSq + vSq);
}

function isCommandByte(code: number): boolean {
  return (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a);
}

function isSeparatorByte(code: number): boolean {
  return code === 0x2c || code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d;
}

function advanceDigits(d: string, len: number, from: number): number {
  let i = from;
  while (i < len && d.charCodeAt(i) >= 0x30 && d.charCodeAt(i) <= 0x39) i++;
  return i;
}

/** Parses one SVG path number starting at `cursor.pos`. Returns `NaN` on invalid syntax. */
function readPathNumber(d: string, len: number, cursor: { pos: number }): number {
  let i = cursor.pos;
  while (i < len && isSeparatorByte(d.charCodeAt(i))) i++;
  if (i >= len) return Number.NaN;
  const start = i;
  if (d.charCodeAt(i) === 0x2d || d.charCodeAt(i) === 0x2b) i++;
  const afterInt = advanceDigits(d, len, i);
  let digits = afterInt - i;
  i = afterInt;
  if (i < len && d.charCodeAt(i) === 0x2e) {
    const afterFrac = advanceDigits(d, len, i + 1);
    digits += afterFrac - (i + 1);
    i = afterFrac;
  }
  if (digits === 0) return Number.NaN;
  if (i < len && (d.charCodeAt(i) === 0x65 || d.charCodeAt(i) === 0x45)) {
    i++;
    if (i < len && (d.charCodeAt(i) === 0x2d || d.charCodeAt(i) === 0x2b)) i++;
    const afterExp = advanceDigits(d, len, i);
    if (afterExp === i) return Number.NaN;
    i = afterExp;
  }
  cursor.pos = i;
  return Number(d.slice(start, i));
}

function formatCompactNumber(v: number, precision: number): string {
  const factor = 10 ** precision;
  const rounded = Math.round(v * factor) / factor;
  if (rounded === 0) return '0';
  let s = rounded.toFixed(precision);
  if (precision > 0) {
    let end = s.length;
    while (end > 0 && s.charCodeAt(end - 1) === 0x30) end--;
    if (end > 0 && s.charCodeAt(end - 1) === 0x2e) end--;
    s = s.slice(0, end);
  }
  if (s.startsWith('0.')) return s.slice(1);
  if (s.startsWith('-0.')) return `-${s.slice(2)}`;
  return s;
}

function joinTokens(op: string, nums: readonly string[]): string {
  let out = op;
  for (let i = 0; i < nums.length; i++) {
    const token = nums[i];
    if (i > 0 && token.charCodeAt(0) !== 0x2d) out += ',';
    out += token;
  }
  return out;
}

function shortestCandidate(candidates: readonly string[]): string {
  let best = candidates[0];
  for (let i = 1; i < candidates.length; i++) {
    if (candidates[i].length < best.length) best = candidates[i];
  }
  return best;
}

function encodeLineCmd(cmd: { x: number; y: number }, cur: Point2D, precision: number): string {
  const candidates: string[] = [];
  if (Math.abs(cmd.y - cur.y) < COORD_EPSILON) {
    candidates.push(`H${formatCompactNumber(cmd.x, precision)}`, `h${formatCompactNumber(cmd.x - cur.x, precision)}`);
  }
  if (Math.abs(cmd.x - cur.x) < COORD_EPSILON) {
    candidates.push(`V${formatCompactNumber(cmd.y, precision)}`, `v${formatCompactNumber(cmd.y - cur.y, precision)}`);
  }
  candidates.push(
    joinTokens('L', [formatCompactNumber(cmd.x, precision), formatCompactNumber(cmd.y, precision)]),
    joinTokens('l', [formatCompactNumber(cmd.x - cur.x, precision), formatCompactNumber(cmd.y - cur.y, precision)])
  );
  return shortestCandidate(candidates);
}

function encodeCubicCmd(
  cmd: { x1: number; y1: number; x2: number; y2: number; x: number; y: number },
  cur: Point2D,
  prevC2: Point2D | null,
  precision: number
): string {
  const ax2 = formatCompactNumber(cmd.x2, precision);
  const ay2 = formatCompactNumber(cmd.y2, precision);
  const ax = formatCompactNumber(cmd.x, precision);
  const ay = formatCompactNumber(cmd.y, precision);
  const rx2 = formatCompactNumber(cmd.x2 - cur.x, precision);
  const ry2 = formatCompactNumber(cmd.y2 - cur.y, precision);
  const rx = formatCompactNumber(cmd.x - cur.x, precision);
  const ry = formatCompactNumber(cmd.y - cur.y, precision);
  const candidates: string[] = [];
  if (prevC2 !== null) {
    const reflX = 2 * cur.x - prevC2.x;
    const reflY = 2 * cur.y - prevC2.y;
    if (Math.abs(reflX - cmd.x1) < COORD_EPSILON && Math.abs(reflY - cmd.y1) < COORD_EPSILON) {
      candidates.push(joinTokens('S', [ax2, ay2, ax, ay]), joinTokens('s', [rx2, ry2, rx, ry]));
    }
  }
  candidates.push(
    joinTokens('C', [formatCompactNumber(cmd.x1, precision), formatCompactNumber(cmd.y1, precision), ax2, ay2, ax, ay]),
    joinTokens('c', [
      formatCompactNumber(cmd.x1 - cur.x, precision),
      formatCompactNumber(cmd.y1 - cur.y, precision),
      rx2,
      ry2,
      rx,
      ry,
    ])
  );
  return shortestCandidate(candidates);
}

function serializeCommands(cmds: readonly Cmd[], precision: number): string {
  let out = '';
  let cur: Point2D = { x: 0, y: 0 };
  let sub: Point2D = { x: 0, y: 0 };
  let started = false;
  let prevC2: Point2D | null = null;

  for (const cmd of cmds) {
    if (cmd.kind === 'M') {
      const abs = joinTokens('M', [formatCompactNumber(cmd.x, precision), formatCompactNumber(cmd.y, precision)]);
      if (!started) {
        out += abs;
        started = true;
      } else {
        const rel = joinTokens('m', [formatCompactNumber(cmd.x - cur.x, precision), formatCompactNumber(cmd.y - cur.y, precision)]);
        out += rel.length < abs.length ? rel : abs;
      }
      cur = { x: cmd.x, y: cmd.y };
      sub = { x: cmd.x, y: cmd.y };
      prevC2 = null;
    } else if (cmd.kind === 'Z') {
      out += 'Z';
      cur = { x: sub.x, y: sub.y };
      prevC2 = null;
    } else if (cmd.kind === 'L') {
      out += encodeLineCmd(cmd, cur, precision);
      cur = { x: cmd.x, y: cmd.y };
      prevC2 = null;
    } else {
      out += encodeCubicCmd(cmd, cur, prevC2, precision);
      cur = { x: cmd.x, y: cmd.y };
      prevC2 = { x: cmd.x2, y: cmd.y2 };
    }
  }
  return out;
}

interface PathCompactState {
  pos: number;
  cmds: Cmd[];
  cur: Point2D;
  anchor: Point2D;
  sub: Point2D;
  prevC2: Point2D | null;
  simplified: boolean;
  op: string;
}

function pushLineToState(st: PathCompactState, nx: number, ny: number): void {
  if (Math.abs(nx - st.cur.x) < COORD_EPSILON && Math.abs(ny - st.cur.y) < COORD_EPSILON) return;
  const last = st.cmds.at(-1);
  if (last?.kind === 'L' && areLinesCollinearForward(st.anchor, st.cur, { x: nx, y: ny })) {
    last.x = nx;
    last.y = ny;
    st.cur = { x: nx, y: ny };
    return;
  }
  st.cmds.push({ kind: 'L', x: nx, y: ny });
  st.anchor = { ...st.cur };
  st.cur = { x: nx, y: ny };
}

function closeSubpathInState(st: PathCompactState): void {
  const last = st.cmds.at(-1);
  if (
    last?.kind === 'L' &&
    Math.abs(last.x - st.sub.x) < COORD_EPSILON &&
    Math.abs(last.y - st.sub.y) < COORD_EPSILON &&
    st.cmds.length >= 3
  ) {
    st.cmds.pop();
    st.simplified = true;
  }
  st.cmds.push({ kind: 'Z' });
  st.cur = { ...st.sub };
  st.anchor = { ...st.sub };
  st.prevC2 = null;
  st.op = '';
}

function stepMoveCommand(d: string, len: number, st: PathCompactState, rel: boolean): boolean {
  let x = readPathNumber(d, len, st);
  let y = readPathNumber(d, len, st);
  if (Number.isNaN(x) || Number.isNaN(y)) return false;
  if (rel) {
    x += st.cur.x;
    y += st.cur.y;
  }
  st.cmds.push({ kind: 'M', x, y });
  st.cur = { x, y };
  st.anchor = { x, y };
  st.sub = { x, y };
  st.prevC2 = null;
  st.op = rel ? 'l' : 'L';
  return true;
}

function stepLineCommand(d: string, len: number, st: PathCompactState, upper: string, rel: boolean): boolean {
  if (upper === 'L') {
    const dx = readPathNumber(d, len, st);
    const dy = readPathNumber(d, len, st);
    if (Number.isNaN(dx) || Number.isNaN(dy)) return false;
    pushLineToState(st, rel ? st.cur.x + dx : dx, rel ? st.cur.y + dy : dy);
  } else if (upper === 'H') {
    const dx = readPathNumber(d, len, st);
    if (Number.isNaN(dx)) return false;
    pushLineToState(st, rel ? st.cur.x + dx : dx, st.cur.y);
  } else {
    const dy = readPathNumber(d, len, st);
    if (Number.isNaN(dy)) return false;
    pushLineToState(st, st.cur.x, rel ? st.cur.y + dy : dy);
  }
  st.prevC2 = null;
  return true;
}

function resolveFirstControlPoint(d: string, len: number, st: PathCompactState, upper: string, rel: boolean): Point2D | null {
  if (upper === 'C') {
    const x1 = readPathNumber(d, len, st);
    const y1 = readPathNumber(d, len, st);
    if (Number.isNaN(x1) || Number.isNaN(y1)) return null;
    return rel ? { x: st.cur.x + x1, y: st.cur.y + y1 } : { x: x1, y: y1 };
  }
  if (st.prevC2 !== null) {
    return { x: 2 * st.cur.x - st.prevC2.x, y: 2 * st.cur.y - st.prevC2.y };
  }
  return { ...st.cur };
}

function stepCubicCommand(d: string, len: number, st: PathCompactState, upper: string, rel: boolean): boolean {
  const c1 = resolveFirstControlPoint(d, len, st, upper, rel);
  if (c1 === null) return false;
  let x2 = readPathNumber(d, len, st);
  let y2 = readPathNumber(d, len, st);
  let x = readPathNumber(d, len, st);
  let y = readPathNumber(d, len, st);
  if (Number.isNaN(x2) || Number.isNaN(y2) || Number.isNaN(x) || Number.isNaN(y)) return false;
  if (rel) {
    x2 += st.cur.x;
    y2 += st.cur.y;
    x += st.cur.x;
    y += st.cur.y;
  }
  const c2 = { x: x2, y: y2 };
  const end = { x, y };
  if (isCubicCollinearSegment(st.cur, c1, c2, end)) {
    st.simplified = true;
    pushLineToState(st, x, y);
    st.prevC2 = null;
  } else {
    st.cmds.push({ kind: 'C', x1: c1.x, y1: c1.y, x2, y2, x, y });
    st.anchor = { ...st.cur };
    st.cur = end;
    st.prevC2 = c2;
  }
  return true;
}

function dispatchPathStep(d: string, len: number, st: PathCompactState): boolean {
  const rel = st.op >= 'a' && st.op <= 'z';
  const upper = st.op.toUpperCase();
  if (upper === 'M') return stepMoveCommand(d, len, st, rel);
  if (upper === 'L' || upper === 'H' || upper === 'V') return stepLineCommand(d, len, st, upper, rel);
  if (upper === 'C' || upper === 'S') return stepCubicCommand(d, len, st, upper, rel);
  return false;
}

function hasCubicCommand(d: string): boolean {
  return d.includes('C') || d.includes('c') || d.includes('S') || d.includes('s');
}

/**
 * Collapses collinear straight cubic Béziers in `d` to lines (`H`/`V`/`L`) and drops closing segments
 * landing on `subpathStart` right before `Z`. Paths without cubic curves return immediately untouched.
 */
export function compactSplinePathData(d: string, precision = DEFAULT_COORD_PRECISION): string {
  if (!hasCubicCommand(d)) return d;

  const len = d.length;
  const st: PathCompactState = {
    pos: 0,
    cmds: [],
    cur: { x: 0, y: 0 },
    anchor: { x: 0, y: 0 },
    sub: { x: 0, y: 0 },
    prevC2: null,
    simplified: false,
    op: '',
  };

  while (st.pos < len) {
    while (st.pos < len && isSeparatorByte(d.charCodeAt(st.pos))) st.pos++;
    if (st.pos >= len) break;

    if (isCommandByte(d.charCodeAt(st.pos))) {
      st.op = d[st.pos];
      st.pos++;
      if (st.op === 'Z' || st.op === 'z') {
        closeSubpathInState(st);
        continue;
      }
    } else if (st.op === '') {
      return d;
    }

    if (!dispatchPathStep(d, len, st)) return d;
  }

  if (!st.simplified) return d;
  const serialized = serializeCommands(st.cmds, precision);
  return serialized.length > 0 && serialized.length < d.length ? serialized : d;
}

const SVG_DIM_ATTR = /\bwidth="(\d+(?:\.\d+)?)"[^>]*\bheight="(\d+(?:\.\d+)?)"|\bheight="(\d+(?:\.\d+)?)"[^>]*\bwidth="(\d+(?:\.\d+)?)"/;

function stripPrologue(svg: string): string {
  let pos = 0;
  const len = svg.length;
  while (pos < len) {
    while (pos < len && isSeparatorByte(svg.charCodeAt(pos))) pos++;
    if (svg.startsWith('<?xml', pos)) {
      const close = svg.indexOf('?>', pos + 5);
      if (close === -1) break;
      pos = close + 2;
      continue;
    }
    if (svg.startsWith('<!--', pos)) {
      const close = svg.indexOf('-->', pos + 4);
      if (close === -1) break;
      pos = close + 3;
      continue;
    }
    break;
  }
  return pos === 0 ? svg : svg.slice(pos);
}

function normalizeRootSvgTag(openTag: string, stripVersion: boolean): string {
  let tag = stripVersion ? openTag.replace(/\s+version="1\.1"/, '') : openTag;
  if (!/\bviewBox\s*=/i.test(tag)) {
    const dims = SVG_DIM_ATTR.exec(tag);
    const width = dims?.[1] ?? dims?.[4];
    const height = dims?.[2] ?? dims?.[3];
    if (width !== undefined && height !== undefined && Number(width) > 0 && Number(height) > 0) {
      const selfClosing = tag.endsWith('/>');
      const head = selfClosing ? tag.slice(0, -2) : tag.slice(0, -1);
      tag = `${head} viewBox="0 0 ${width} ${height}"${selfClosing ? '/>' : '>'}`;
    }
  }
  return tag;
}

function compactElementLine(line: string, pathPrecision: number): string {
  const trimmed = line.trim();
  if (trimmed === '') return '';

  if (trimmed.startsWith('<g fill="') && trimmed.endsWith('">')) {
    return `<g fill="${compactHexColor(trimmed.slice(9, -2))}">`;
  }

  if (trimmed.startsWith('<path d="')) {
    const dEnd = trimmed.indexOf('"', 9);
    if (dEnd > 9) {
      const nextD = compactSplinePathData(trimmed.slice(9, dEnd), pathPrecision);
      const tail = trimmed.slice(dEnd + 1);
      if (tail.startsWith(' fill="')) {
        const fillEnd = tail.indexOf('"', 7);
        if (fillEnd > 7) {
          return `<path d="${nextD}" fill="${compactHexColor(tail.slice(7, fillEnd))}"${tail.slice(fillEnd + 1)}`;
        }
      }
      return `<path d="${nextD}"${tail}`;
    }
  }

  return trimmed;
}

/**
 * Normalizes a traced SVG document:
 * - Always strips leading XML declaration and generator comment and injects `viewBox="0 0 W H"`.
 * - At `optimizeLevel >= 2`, compacts `#RRGGBB` fills (`#rgb` / short CSS names), folds collinear
 *   straight cubic Béziers into `H`/`V`/`L`/`Z`, and removes inter-element newlines in a single pass.
 */
export function compactTracedSvg(svg: string, optimizeLevel = 2, pathPrecision = DEFAULT_COORD_PRECISION): string {
  const body = stripPrologue(svg);
  const svgStart = body.indexOf('<svg');
  if (svgStart === -1) return svg;
  const tagEnd = body.indexOf('>', svgStart);
  if (tagEnd === -1) return svg;

  const rootTag = normalizeRootSvgTag(body.slice(svgStart, tagEnd + 1), optimizeLevel >= 1);
  if (optimizeLevel < 2) {
    return `${body.slice(0, svgStart)}${rootTag}${body.slice(tagEnd + 1)}`;
  }

  const parts: string[] = [rootTag];
  let cursor = tagEnd + 1;
  const len = body.length;
  while (cursor < len) {
    const nl = body.indexOf('\n', cursor);
    const end = nl === -1 ? len : nl;
    const compacted = compactElementLine(body.slice(cursor, end), pathPrecision);
    if (compacted !== '') parts.push(compacted);
    cursor = nl === -1 ? len : nl + 1;
  }
  return parts.join('');
}
