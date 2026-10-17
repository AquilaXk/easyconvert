import { UnsupportedOptionError } from '../types';
import { CSS_NAMED_COLORS } from './svg-named-colors';

export interface RgbColor {
  r: number;
  g: number;
  b: number;
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
export function assertValidPaintDeclarations(declared: Map<string, string>): void {
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

