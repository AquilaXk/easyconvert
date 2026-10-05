import { ConversionFailedError } from '../types';

/**
 * SVG path data parser for SVG font glyphs (SVG 1.1 section 8.3 grammar).
 *
 * Reads the commands M L H V C S Q T A Z in absolute and relative form and returns closed-shape
 * subpaths made of lines, exact quadratic curves and cubic curves. Arcs are converted to cubic
 * curves with the endpoint to center parameterization of the SVG implementation notes (F.6.5 and
 * F.6.6). Anything the grammar does not allow throws SvgPathDataError: nothing is skipped or
 * repaired, because a dropped command would silently change the glyph shape.
 *
 * This module has no dependency on the rest of the font engine.
 */

export interface SvgPoint {
  x: number;
  y: number;
}

export type SvgSegment =
  | { kind: 'line'; to: SvgPoint }
  | { kind: 'quad'; c: SvgPoint; to: SvgPoint }
  | { kind: 'cubic'; c1: SvgPoint; c2: SvgPoint; to: SvgPoint };

export interface SvgSubpath {
  start: SvgPoint;
  segments: SvgSegment[];
  /** The subpath ended with a closepath command (it is filled as closed either way). */
  closed: boolean;
}

export interface SvgPathOptions {
  /** Largest distance in path units that an arc may deviate from the true ellipse. */
  arcTolerance: number;
  /** Commands allowed in the path, counting every implicit repetition. */
  maxCommands?: number;
}

/** Upper bound on path commands per glyph; a glyph with more is rejected, not truncated. */
export const MAX_SVG_PATH_COMMANDS_PER_GLYPH = 4096;

/** The path data is malformed, or exceeds the command limit. */
export class SvgPathDataError extends ConversionFailedError {
  constructor(message: string) {
    super(message);
    this.name = 'SvgPathDataError';
  }
}

const CODE_0 = 48;
const CODE_9 = 57;
const CODE_PLUS = 43;
const CODE_MINUS = 45;
const CODE_DOT = 46;
const CODE_COMMA = 44;
const CHAR_FLAG_OFF = '0';
const CHAR_FLAG_ON = '1';
const WHITESPACE = new Set([' ', '\t', '\n', '\r', '\f']);
const EXPONENT_MARKS = new Set(['e', 'E']);
const COMMAND_LETTERS = new Set(['M', 'L', 'H', 'V', 'C', 'S', 'Q', 'T', 'A', 'Z']);

const DEGREES_TO_RADIANS = Math.PI / 180;
const FULL_TURN = 2 * Math.PI;
/** A cubic fits an arc best up to a quarter turn; longer arcs are split before tolerance is considered. */
const ARC_MAX_PIECE_ANGLE = Math.PI / 2;
const ARC_MAX_PIECES = 256;
/** Maximum radial error of the cubic that replaces a circular arc of angle a is (2/27) r sin^6(a/4) / cos^2(a/4). */
const ARC_ERROR_COEFFICIENT = 2 / 27;
const ARC_ERROR_ANGLE_DIVISOR = 4;
const ARC_CONTROL_ANGLE_DIVISOR = 4;
const ARC_CONTROL_FACTOR = 4 / 3;

function isDigit(code: number): boolean {
  return code >= CODE_0 && code <= CODE_9;
}

function isLetter(ch: string): boolean {
  return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z');
}

function isFinitePoint(p: SvgPoint): boolean {
  return Number.isFinite(p.x) && Number.isFinite(p.y);
}

function reflect(point: SvgPoint, about: SvgPoint): SvgPoint {
  return { x: 2 * about.x - point.x, y: 2 * about.y - point.y };
}

function arcPieceError(angle: number, radius: number): number {
  const quarter = angle / ARC_ERROR_ANGLE_DIVISOR;
  return (ARC_ERROR_COEFFICIENT * radius * Math.sin(quarter) ** 6) / Math.cos(quarter) ** 2;
}

/**
 * Converts an elliptical arc to cubic segments (SVG 1.1 F.6.5 endpoint to center conversion).
 * Zero radii give a straight line; identical end points give no segment at all.
 */
function arcToSegments(
  from: SvgPoint,
  radiusX: number,
  radiusY: number,
  rotationDegrees: number,
  largeArc: boolean,
  sweep: boolean,
  to: SvgPoint,
  tolerance: number
): SvgSegment[] {
  if (from.x === to.x && from.y === to.y) return [];
  let rx = Math.abs(radiusX);
  let ry = Math.abs(radiusY);
  if (rx === 0 || ry === 0) return [{ kind: 'line', to }];

  const phi = rotationDegrees * DEGREES_TO_RADIANS;
  const cosPhi = Math.cos(phi);
  const sinPhi = Math.sin(phi);
  const halfDx = (from.x - to.x) / 2;
  const halfDy = (from.y - to.y) / 2;
  const x1p = cosPhi * halfDx + sinPhi * halfDy;
  const y1p = -sinPhi * halfDx + cosPhi * halfDy;

  // The F.6.5 formulas are evaluated on the end point offsets measured in radii (u = x1' / rx,
  // v = y1' / ry), so squaring huge or tiny radii and coordinates can neither overflow nor underflow.
  // With h = |(u, v)| (half the chord of the unit circle the ellipse maps to):
  //   F.6.6: h > 1 means the radii cannot span the end points; scaling them by h makes h = 1.
  //   F.6.5: the center lies at distance q = sqrt(1 - h^2) from the chord, on the side picked by the flags.
  let u = x1p / rx;
  let v = y1p / ry;
  let h = Math.hypot(u, v);
  if (h === 0) {
    // The chord vanishes next to the radii at double precision: a minor arc is a point-like line, but a
    // large arc would be a full circle of unknown orientation, which cannot be drawn.
    if (largeArc) throw new SvgPathDataError('Cannot convert an elliptical arc: its end points are indistinguishable but it is a large arc.');
    return [{ kind: 'line', to }];
  }
  if (h > 1) {
    rx *= h;
    ry *= h;
    u /= h;
    v /= h;
    h = 1;
  }
  if (!Number.isFinite(rx) || !Number.isFinite(ry)) {
    throw new SvgPathDataError('Cannot convert an elliptical arc: its scaled radii are not finite.');
  }
  const q = h < 1 ? Math.sqrt((1 - h) * (1 + h)) : 0;
  const side = largeArc === sweep ? -1 : 1;
  const chordU = u / h;
  const chordV = v / h;
  // Center in the rotated frame (F.6.5 step 2) and the angles of both end points around it (step 4).
  const cxp = side * q * chordV * rx;
  const cyp = -side * q * chordU * ry;
  const cx = cosPhi * cxp - sinPhi * cyp + (from.x + to.x) / 2;
  const cy = sinPhi * cxp + cosPhi * cyp + (from.y + to.y) / 2;

  const startAngle = Math.atan2(v + side * q * chordU, u - side * q * chordV);
  // Angle between the two radius vectors, formed from q and h directly: the vectors differ by only
  // h in the unit circle, so the cross and dot products of the vectors themselves would cancel.
  let sweepAngle = Math.atan2(2 * side * q * h, q * q - h * h);
  if (sweep && sweepAngle < 0) sweepAngle += FULL_TURN;
  if (!sweep && sweepAngle > 0) sweepAngle -= FULL_TURN;
  if (!Number.isFinite(startAngle) || !Number.isFinite(sweepAngle)) {
    throw new SvgPathDataError('Cannot convert an elliptical arc: its angles are not finite.');
  }

  const radius = Math.max(rx, ry);
  let pieces = Math.max(1, Math.ceil(Math.abs(sweepAngle) / ARC_MAX_PIECE_ANGLE));
  // Written so that a NaN error also counts as exceeding the tolerance.
  while (!(arcPieceError(Math.abs(sweepAngle) / pieces, radius) <= tolerance)) {
    pieces++;
    if (pieces > ARC_MAX_PIECES) {
      throw new SvgPathDataError(
        `Cannot convert an elliptical arc within tolerance ${tolerance}: more than ${ARC_MAX_PIECES} cubic pieces would be needed.`
      );
    }
  }

  const pieceAngle = sweepAngle / pieces;
  const handle = ARC_CONTROL_FACTOR * Math.tan(pieceAngle / ARC_CONTROL_ANGLE_DIVISOR);
  const onEllipse = (angle: number): SvgPoint => ({
    x: cx + rx * Math.cos(angle) * cosPhi - ry * Math.sin(angle) * sinPhi,
    y: cy + rx * Math.cos(angle) * sinPhi + ry * Math.sin(angle) * cosPhi,
  });
  const tangent = (angle: number): SvgPoint => ({
    x: -rx * Math.sin(angle) * cosPhi - ry * Math.cos(angle) * sinPhi,
    y: -rx * Math.sin(angle) * sinPhi + ry * Math.cos(angle) * cosPhi,
  });

  const segments: SvgSegment[] = [];
  let pieceStart = from;
  for (let i = 0; i < pieces; i++) {
    const a0 = startAngle + i * pieceAngle;
    const a1 = a0 + pieceAngle;
    const isLast = i === pieces - 1;
    const end = isLast ? to : onEllipse(a1);
    const d0 = tangent(a0);
    const d1 = tangent(a1);
    segments.push({
      kind: 'cubic',
      c1: { x: pieceStart.x + handle * d0.x, y: pieceStart.y + handle * d0.y },
      c2: { x: end.x - handle * d1.x, y: end.y - handle * d1.y },
      to: end,
    });
    pieceStart = end;
  }
  return segments;
}

class PathReader {
  private pos = 0;

  constructor(private readonly text: string) {}

  atEnd(): boolean {
    return this.pos >= this.text.length;
  }

  peek(): string {
    return this.text[this.pos];
  }

  advance(): void {
    this.pos++;
  }

  position(): number {
    return this.pos;
  }

  skipWhitespace(): void {
    while (this.pos < this.text.length && WHITESPACE.has(this.text[this.pos])) this.pos++;
  }

  private fail(message: string): never {
    throw new SvgPathDataError(`Invalid SVG path data at position ${this.pos}: ${message}`);
  }

  failAt(message: string): never {
    return this.fail(message);
  }

  private skipSeparator(allowComma: boolean): void {
    this.skipWhitespace();
    if (allowComma && this.text.charCodeAt(this.pos) === CODE_COMMA) {
      this.pos++;
      this.skipWhitespace();
    }
  }

  private scanDigits(): number {
    const begin = this.pos;
    while (this.pos < this.text.length && isDigit(this.text.charCodeAt(this.pos))) this.pos++;
    return this.pos - begin;
  }

  /** Reads one number: [sign] digits [. digits] [e [sign] digits], optionally preceded by a comma. */
  number(allowComma: boolean): number {
    this.skipSeparator(allowComma);
    const begin = this.pos;
    const sign = this.text.charCodeAt(this.pos);
    if (sign === CODE_PLUS || sign === CODE_MINUS) this.pos++;
    let digits = this.scanDigits();
    if (this.text.charCodeAt(this.pos) === CODE_DOT) {
      this.pos++;
      digits += this.scanDigits();
    }
    if (digits === 0) this.fail('expected a number');
    if (EXPONENT_MARKS.has(this.text[this.pos])) {
      this.pos++;
      const exponentSign = this.text.charCodeAt(this.pos);
      if (exponentSign === CODE_PLUS || exponentSign === CODE_MINUS) this.pos++;
      if (this.scanDigits() === 0) this.fail('invalid number: the exponent has no digits');
    }
    const value = Number(this.text.slice(begin, this.pos));
    if (!Number.isFinite(value)) this.fail('number is not finite');
    return value;
  }

  /** Reads an arc flag: a single 0 or 1 character that needs no separator after it. */
  flag(): boolean {
    this.skipSeparator(true);
    const ch = this.text[this.pos];
    if (ch !== CHAR_FLAG_OFF && ch !== CHAR_FLAG_ON) this.fail('expected an arc flag (0 or 1)');
    this.pos++;
    return ch === CHAR_FLAG_ON;
  }

  /** True when the next token can start an implicit repetition of the current command. */
  nextStartsNumber(): boolean {
    this.skipWhitespace();
    if (this.atEnd()) return false;
    const code = this.text.charCodeAt(this.pos);
    return isDigit(code) || code === CODE_PLUS || code === CODE_MINUS || code === CODE_DOT || code === CODE_COMMA;
  }
}

/**
 * Parses SVG path data into subpaths. Throws SvgPathDataError for malformed data or when the path
 * has more than `maxCommands` commands, and ConversionFailedError for an unusable tolerance.
 */
export function parseSvgPathData(d: string, options: SvgPathOptions): SvgSubpath[] {
  const { arcTolerance } = options;
  const maxCommands = options.maxCommands ?? MAX_SVG_PATH_COMMANDS_PER_GLYPH;
  if (!Number.isFinite(arcTolerance) || arcTolerance <= 0) {
    throw new ConversionFailedError('Cannot parse SVG path data: the arc tolerance must be a positive finite number.');
  }
  if (!Number.isInteger(maxCommands) || maxCommands < 1) {
    throw new ConversionFailedError('Cannot parse SVG path data: the command limit must be a positive integer.');
  }

  const reader = new PathReader(d);
  const subpaths: SvgSubpath[] = [];
  const open: { subpath: SvgSubpath | null } = { subpath: null };
  let cursor: SvgPoint = { x: 0, y: 0 };
  let subpathStart: SvgPoint = { x: 0, y: 0 };
  let lastCubicControl: SvgPoint | null = null;
  let lastQuadControl: SvgPoint | null = null;
  let command: string | null = null;
  let commandCount = 0;
  let started = false;

  const finishSubpath = (): void => {
    if (open.subpath !== null && open.subpath.segments.length > 0) subpaths.push(open.subpath);
    open.subpath = null;
  };
  const checked = (p: SvgPoint): SvgPoint => {
    if (!isFinitePoint(p)) reader.failAt('coordinate is not finite');
    return p;
  };
  const target = (relative: boolean, x: number, y: number): SvgPoint =>
    checked(relative ? { x: cursor.x + x, y: cursor.y + y } : { x, y });
  const draw = (segment: SvgSegment): void => {
    if (open.subpath === null) open.subpath = { start: cursor, segments: [], closed: false };
    open.subpath.segments.push(segment);
    cursor = segment.to;
  };
  const countCommand = (): void => {
    commandCount++;
    if (commandCount > maxCommands) {
      throw new SvgPathDataError(`SVG path data has too many commands: the limit is ${maxCommands} per glyph.`);
    }
  };
  const readPair = (first: boolean): SvgPoint => {
    const x = reader.number(!first);
    const y = reader.number(true);
    return { x, y };
  };

  let afterLetter = false;
  for (;;) {
    reader.skipWhitespace();
    if (reader.atEnd()) break;
    const ch = reader.peek();
    const upperLetter = ch.toUpperCase();
    if (isLetter(ch) && COMMAND_LETTERS.has(upperLetter)) {
      if (!started && upperLetter !== 'M') reader.failAt('path data must start with a moveto command (M or m)');
      command = ch;
      afterLetter = true;
      reader.advance();
      if (upperLetter === 'Z') {
        countCommand();
        if (open.subpath !== null && open.subpath.segments.length > 0) open.subpath.closed = true;
        finishSubpath();
        cursor = subpathStart;
        lastCubicControl = null;
        lastQuadControl = null;
        continue;
      }
    } else if (isLetter(ch)) {
      reader.failAt(`unknown path command '${ch}'`);
    } else if (command === null) {
      reader.failAt('path data must start with a moveto command (M or m)');
    } else if (command.toUpperCase() === 'Z') {
      reader.failAt('unexpected number after a closepath command; start a new command first');
    } else if (reader.nextStartsNumber()) {
      afterLetter = false;
    } else {
      reader.failAt(`unexpected character '${ch}'`);
    }

    countCommand();
    const letter = command as string;
    const relative = letter !== letter.toUpperCase();
    const kind = letter.toUpperCase();
    const first = afterLetter;
    afterLetter = false;
    switch (kind) {
      case 'M': {
        const p = readPair(first);
        const to = target(relative, p.x, p.y);
        finishSubpath();
        started = true;
        cursor = to;
        subpathStart = to;
        // Further coordinate pairs after a moveto are implicit lineto commands.
        command = relative ? 'l' : 'L';
        lastCubicControl = null;
        lastQuadControl = null;
        break;
      }
      case 'L': {
        const p = readPair(first);
        draw({ kind: 'line', to: target(relative, p.x, p.y) });
        lastCubicControl = null;
        lastQuadControl = null;
        break;
      }
      case 'H': {
        const x = reader.number(!first);
        draw({ kind: 'line', to: checked({ x: relative ? cursor.x + x : x, y: cursor.y }) });
        lastCubicControl = null;
        lastQuadControl = null;
        break;
      }
      case 'V': {
        const y = reader.number(!first);
        draw({ kind: 'line', to: checked({ x: cursor.x, y: relative ? cursor.y + y : y }) });
        lastCubicControl = null;
        lastQuadControl = null;
        break;
      }
      case 'C': {
        const a = readPair(first);
        const b = readPair(false);
        const c = readPair(false);
        const c1 = target(relative, a.x, a.y);
        const c2 = target(relative, b.x, b.y);
        const to = target(relative, c.x, c.y);
        draw({ kind: 'cubic', c1, c2, to });
        lastCubicControl = c2;
        lastQuadControl = null;
        break;
      }
      case 'S': {
        const b = readPair(first);
        const c = readPair(false);
        const c1: SvgPoint = lastCubicControl === null ? cursor : reflect(lastCubicControl, cursor);
        const c2 = target(relative, b.x, b.y);
        const to = target(relative, c.x, c.y);
        draw({ kind: 'cubic', c1, c2, to });
        lastCubicControl = c2;
        lastQuadControl = null;
        break;
      }
      case 'Q': {
        const a = readPair(first);
        const b = readPair(false);
        const c = target(relative, a.x, a.y);
        const to = target(relative, b.x, b.y);
        draw({ kind: 'quad', c, to });
        lastQuadControl = c;
        lastCubicControl = null;
        break;
      }
      case 'T': {
        const b = readPair(first);
        const c: SvgPoint = lastQuadControl === null ? cursor : reflect(lastQuadControl, cursor);
        const to = target(relative, b.x, b.y);
        draw({ kind: 'quad', c, to });
        lastQuadControl = c;
        lastCubicControl = null;
        break;
      }
      case 'A': {
        // rx ry x-axis-rotation large-arc-flag sweep-flag x y
        const rx = reader.number(!first);
        const ry = reader.number(true);
        const rotation = reader.number(true);
        const largeArc = reader.flag();
        const sweep = reader.flag();
        const p = readPair(false);
        const to = target(relative, p.x, p.y);
        const from = cursor;
        for (const segment of arcToSegments(from, rx, ry, rotation, largeArc, sweep, to, arcTolerance)) {
          if (segment.kind === 'cubic') {
            checked(segment.c1);
            checked(segment.c2);
          }
          checked(segment.to);
          draw(segment);
        }
        cursor = to;
        lastCubicControl = null;
        lastQuadControl = null;
        break;
      }
      default:
        reader.failAt(`unknown path command '${kind}'`);
    }
  }
  finishSubpath();
  return subpaths;
}
