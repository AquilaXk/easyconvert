import { CadGeometryUnavailableError } from '../types';

/** The lengths of the SVG geometry reader (svg-geometry.ts), in CSS pixels: the user units of a document without a viewBox. */

/** Throws unless the value is a finite number; NaN or overflow would yield dummy geometry. */
export function requireFinite(value: number, what: string): number {
  if (!Number.isFinite(value)) {
    throw new CadGeometryUnavailableError(`SVG ${what} is not a finite number.`);
  }
  return value;
}

/** CSS absolute length units in CSS pixels (CSS Values 4: 1in = 96px). */
const CSS_PX_PER_INCH = 96;
export const ABSOLUTE_LENGTH_UNITS: Record<string, number> = {
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
export function parseLength(value: string, what: string): number {
  const m = LENGTH_PATTERN.exec(value);
  const factor = m ? ABSOLUTE_LENGTH_UNITS[m[2].toLowerCase()] : undefined;
  if (!m || factor === undefined) {
    throw new CadGeometryUnavailableError(`SVG ${what} "${value}" is not an absolute length (px, in, cm, mm, pt, pc).`);
  }
  return requireFinite(Number.parseFloat(m[1]) * factor, `${what} "${value}"`);
}

/** CSS pixels in the unit the root's width, else height, names: 1 when neither names one, or it is a percentage. */
export function rootUnitPx(attrs: Map<string, string>): number {
  const units = ['width', 'height'].map((name) => LENGTH_PATTERN.exec(attrs.get(name) ?? '')?.[2].toLowerCase() ?? '');
  return ABSOLUTE_LENGTH_UNITS[units.find((unit) => unit !== '') ?? ''] ?? 1;
}
