import { CadGeometryUnavailableError, UnsupportedOptionError } from '../types';

/**
 * Pen attributes of an SVG stroke, and what a geometry reader does with the ones its target cannot hold.
 *
 * `metafile`: the encoders for EMF, WMF and CGM draw a pen of one width, one colour and no pattern, so every attribute that
 * changes painted pixels is refused unless it has its neutral value. `centre-line`: the DXF writer takes the centre line of
 * every stroke as geometry and holds no width, paint or opacity, as the DXF exporters do (Inkscape's dxf_outlines.py
 * `process_shape` reads none of them; pstoedit's drvdxf.cpp writes the dash pattern only as a line type). Opacity and a pen
 * that is not uniform are dropped there, and a dash array is read and handed on for a line type.
 */
export type SvgPenMode = 'metafile' | 'centre-line';

/** SVG/CSS <number> grammar: no hex, no Infinity/NaN, no empty strings. */
export const SVG_NUMBER_PATTERN = /^[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?$/;

/**
 * The most lengths a dash array may hold, which is the most dash-length specifications one line type holds in AutoCAD
 * ("up to 12 dash-length specifications per linetype", the AutoCAD customization guide, Create Custom Linetypes). A reader
 * that follows it is safe for the readers that hold more (LibreOffice's DXF reader keeps 32: vcl/source/filter/idxf/dxftblrd.hxx
 * `DXF_MAX_DASH_COUNT`, and drops the rest). An odd list is repeated to an even one (SVG 1.1 section 11.4), so it counts twice.
 */
export const MAX_DASH_VALUES = 12;

const SVG_LINECAPS = new Set(['butt', 'round', 'square']);
const SVG_LINEJOINS = new Set(['miter', 'round', 'bevel']);
const VALUE_EXCERPT_CHARACTERS = 40;

function isOpaque(value: string): boolean {
  const v = value.trim();
  const isPercent = v.endsWith('%');
  const body = isPercent ? v.slice(0, -1) : v;
  if (!SVG_NUMBER_PATTERN.test(body)) return false;
  return Number(body) >= (isPercent ? 100 : 1);
}

/** Properties that change painted pixels (or whose value the writers must know) and are only representable at their neutral value. */
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

/** The properties a centre-line writer does not hold and does not need to know: they only change how a stroke is painted. */
const DROPPED_IN_CENTRE_LINE: ReadonlySet<string> = new Set(['opacity', 'fill-opacity', 'stroke-opacity', 'stroke-dasharray']);

export const NEUTRAL_ONLY_PROPERTY_NAMES: readonly string[] = Object.keys(NEUTRAL_ONLY_PROPERTIES);

function excerpt(value: string): string {
  return value.length > VALUE_EXCERPT_CHARACTERS ? `${value.slice(0, VALUE_EXCERPT_CHARACTERS)}...` : value;
}

/** Throws the typed refusal for the first declared property that the mode cannot hold at its value. */
export function assertNeutralPaintProperties(declared: ReadonlyMap<string, string>, mode: SvgPenMode): void {
  for (const [prop, isNeutral] of Object.entries(NEUTRAL_ONLY_PROPERTIES)) {
    if (mode === 'centre-line' && DROPPED_IN_CENTRE_LINE.has(prop)) continue;
    const raw = declared.get(prop);
    if (raw === undefined || raw.trim().toLowerCase() === 'inherit') continue;
    if (!isNeutral(raw.trim().toLowerCase().replace(/\s+/g, ' '))) {
      throw new UnsupportedOptionError(`SVG ${prop} "${raw.trim()}" is not supported by metafile encoders.`);
    }
  }
}

const CHAR_COMMA = 0x2c;
/** XML whitespace (space, tab, line feed, carriage return) and the form feed CSS adds. */
const WHITESPACE = new Set([0x20, 0x09, 0x0a, 0x0d, 0x0c]);

function dashRefusal(value: string, reason: string): UnsupportedOptionError {
  return new UnsupportedOptionError(`SVG stroke-dasharray "${excerpt(value)}" ${reason}.`);
}

/**
 * The entries of a dash array: numbers separated by whitespace, a comma or both. One pass that stops at the first entry past
 * the limit, so an array of a million lengths costs a few characters, and so does a value padded with millions of separators.
 */
function dashEntries(value: string): string[] {
  const entries: string[] = [];
  const end = value.length;
  let at = 0;
  const skipWhitespace = (): void => {
    while (at < end && WHITESPACE.has(value.charCodeAt(at))) at++;
  };
  skipWhitespace();
  while (at < end) {
    let entryEnd = at;
    while (entryEnd < end && !WHITESPACE.has(value.charCodeAt(entryEnd)) && value.charCodeAt(entryEnd) !== CHAR_COMMA) entryEnd++;
    if (entryEnd === at) throw dashRefusal(value, 'has an empty entry');
    entries.push(value.slice(at, entryEnd));
    if (entries.length > MAX_DASH_VALUES) throw dashRefusal(value, `holds more than ${MAX_DASH_VALUES} lengths, at most ${MAX_DASH_VALUES} fit one DXF line type`);
    at = entryEnd;
    skipWhitespace();
    if (value.charCodeAt(at) === CHAR_COMMA) {
      at++;
      skipWhitespace();
      if (at >= end) throw dashRefusal(value, 'ends with a comma');
    }
  }
  return entries;
}

/**
 * The lengths of a `stroke-dasharray` in user units, an even number of them (dash, gap, ...), or null for a solid line
 * (`none`, or lengths that add up to zero, SVG 1.1 section 11.4). Negative, non-numeric and relative lengths and more
 * lengths than a line type holds are refused.
 */
export function parseDashArray(value: string): readonly number[] | null {
  const text = value.trim();
  if (text.toLowerCase() === 'none') return null;
  const lengths = dashEntries(text).map((entry) => {
    if (!SVG_NUMBER_PATTERN.test(entry)) throw dashRefusal(value, `holds "${excerpt(entry)}", which is not a plain number of user units`);
    const length = Number(entry);
    if (!Number.isFinite(length)) throw dashRefusal(value, `holds "${excerpt(entry)}", which is not a finite number`);
    if (length < 0) throw dashRefusal(value, 'holds a negative length');
    return length === 0 ? 0 : length;
  });
  const repeated = lengths.length % 2 === 1 ? [...lengths, ...lengths] : lengths;
  if (repeated.length > MAX_DASH_VALUES) throw dashRefusal(value, `repeats to more than ${MAX_DASH_VALUES} lengths, at most ${MAX_DASH_VALUES} fit one DXF line type`);
  return repeated.some((length) => length > 0) ? repeated : null;
}

interface DashRun {
  dash: boolean;
  length: number;
}

/** Appends a run, joining it to the one before when both are dashes or both are gaps. */
function appendRun(runs: DashRun[], run: DashRun): void {
  const last = runs[runs.length - 1];
  if (last?.dash === run.dash) last.length += run.length;
  else runs.push(run);
}

/**
 * The dash array of a stroke as a device pattern: dash and gap lengths in turn, starting with a dash, or null for a solid line.
 * A line type starts at a dash and holds no phase, so the pattern is the array scaled by `scale` and put in its simplest form:
 * a gap of no length joins the dashes around it, a dash of no length is a dot where the cap draws one (`drawsDots`) and
 * nothing where it does not, and a pattern that starts with a gap starts at its next dash (ezdxf entities/ltype.py
 * `compile_line_pattern` moves a leading gap to the end the same way). A pattern whose dashes all draw nothing is refused.
 */
export function devicePattern(array: readonly number[], scale: number, drawsDots: boolean): readonly number[] | null {
  const runs: DashRun[] = [];
  array.forEach((length, index) => {
    const scaled = length * scale;
    if (!Number.isFinite(scaled)) throw new CadGeometryUnavailableError(`SVG stroke-dasharray length ${length} is not a finite number on the page.`);
    const dash = index % 2 === 0;
    if (scaled > 0 || (dash && drawsDots)) appendRun(runs, { dash, length: scaled });
  });
  if (!runs.some((run) => run.dash)) throw new UnsupportedOptionError('SVG stroke-dasharray draws nothing: every dash has no length and the line cap does not draw one.');
  if (!runs.some((run) => !run.dash)) return null;
  const leadingGap = runs[0].dash ? undefined : runs.shift();
  if (leadingGap) appendRun(runs, leadingGap);
  const trailingDash = runs.length > 1 && runs[runs.length - 1].dash ? runs.pop() : undefined;
  if (trailingDash) runs[0].length += trailingDash.length;
  return runs.map((run) => {
    if (!Number.isFinite(run.length)) throw new CadGeometryUnavailableError('SVG stroke-dasharray adds up to a length that is not a finite number on the page.');
    return run.length;
  });
}
