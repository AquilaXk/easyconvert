/**
 * Options of the raster to SVG tracer, shared by the request schema, the options dialog and the engine run. The names,
 * ranges and defaults are the engine's own: the clap definitions and `Config::from_preset` of the pinned vtracer
 * release (crates/vtracer-cli/src/main.rs and crates/vtracer/src/config.rs at 1.0.0-alpha.4).
 */

/** Raster sources traced to SVG: exactly the inputs the reference converter serves with the same engine. */
export const VECTORIZE_SOURCES: ReadonlySet<string> = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'tif', 'tiff']);
export const VECTORIZE_TARGET = 'svg';

export const VECTORIZE_PRESETS = ['bw', 'poster', 'photo'] as const;
export const VECTORIZE_MODES = ['spline', 'polygon', 'pixel'] as const;
export type VectorizePreset = (typeof VECTORIZE_PRESETS)[number];
export type VectorizeMode = (typeof VECTORIZE_MODES)[number];

export interface VectorizeOptions {
  /** A starting point tuned for line art (`bw`), flat graphics (`poster`) or photographs (`photo`). */
  preset?: VectorizePreset;
  /** Curve fitting: smooth curves, straight edges, or the pixel edges themselves. */
  mode?: VectorizeMode;
  /** Patches smaller than this side length in pixels are dropped. */
  filterSpeckle?: number;
  /** Significant bits per RGB channel. */
  colorPrecision?: number;
  /** Curves are refitted with the fewest cubics that stay within this distance in pixels. */
  simplify?: number;
}

export interface IntegerRange {
  readonly min: number;
  readonly max: number;
}

export const FILTER_SPECKLE_RANGE: IntegerRange = { min: 0, max: 128 };
export const COLOR_PRECISION_RANGE: IntegerRange = { min: 1, max: 8 };
export const DEFAULT_VECTORIZE_MODE: VectorizeMode = 'spline';

/** What the engine uses for the values a request leaves out: its defaults, or those of the preset (`Config::from_preset`). */
export interface VectorizeDefaults {
  readonly filterSpeckle: number;
  readonly colorPrecision: number;
}

const ENGINE_DEFAULTS: VectorizeDefaults = { filterSpeckle: 4, colorPrecision: 6 };
const PRESET_DEFAULTS: Readonly<Record<VectorizePreset, VectorizeDefaults>> = {
  bw: ENGINE_DEFAULTS,
  poster: { filterSpeckle: 4, colorPrecision: 8 },
  photo: { filterSpeckle: 10, colorPrecision: 8 },
};

export function vectorizeDefaults(preset: VectorizePreset | undefined): VectorizeDefaults {
  return preset === undefined ? ENGINE_DEFAULTS : PRESET_DEFAULTS[preset];
}

export function isVectorizePair(sourceFormat: string, targetFormat: string): boolean {
  return targetFormat.toLowerCase() === VECTORIZE_TARGET && VECTORIZE_SOURCES.has(sourceFormat.toLowerCase());
}

const OPTION_KEYS: ReadonlySet<string> = new Set(['preset', 'mode', 'filterSpeckle', 'colorPrecision', 'simplify']);

function isOneOf<T extends string>(choices: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && (choices as readonly string[]).includes(value);
}

function isIntegerIn(range: IntegerRange, value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= range.min && (value as number) <= range.max;
}

function isTolerance(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/** The first reason `raw` is not a valid `vectorize` option object, or null when it is one. */
export function vectorizeOptionsProblem(raw: unknown): string | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return 'vectorize must be an object';
  const fields = raw as Record<string, unknown>;
  const unknown = Object.keys(fields).find((key) => !OPTION_KEYS.has(key));
  if (unknown !== undefined) return `vectorize.${unknown} is not an option of the tracer`;
  if (fields.preset !== undefined && !isOneOf(VECTORIZE_PRESETS, fields.preset)) return `vectorize.preset must be one of ${VECTORIZE_PRESETS.join(', ')}`;
  if (fields.mode !== undefined && !isOneOf(VECTORIZE_MODES, fields.mode)) return `vectorize.mode must be one of ${VECTORIZE_MODES.join(', ')}`;
  if (fields.filterSpeckle !== undefined && !isIntegerIn(FILTER_SPECKLE_RANGE, fields.filterSpeckle)) {
    return `vectorize.filterSpeckle must be a whole number from ${FILTER_SPECKLE_RANGE.min} to ${FILTER_SPECKLE_RANGE.max}`;
  }
  if (fields.colorPrecision !== undefined && !isIntegerIn(COLOR_PRECISION_RANGE, fields.colorPrecision)) {
    return `vectorize.colorPrecision must be a whole number from ${COLOR_PRECISION_RANGE.min} to ${COLOR_PRECISION_RANGE.max}`;
  }
  if (fields.simplify !== undefined && !isTolerance(fields.simplify)) return 'vectorize.simplify must be a finite number greater than 0';
  return null;
}

/** The valid fields of `raw`, without the ones the engine would reject: what the options dialog keeps for a pair. */
export function sanitizeVectorizeOptions(raw: VectorizeOptions | undefined): VectorizeOptions | undefined {
  if (raw === undefined) return undefined;
  const kept: VectorizeOptions = {};
  if (isOneOf(VECTORIZE_PRESETS, raw.preset)) kept.preset = raw.preset;
  if (isOneOf(VECTORIZE_MODES, raw.mode)) kept.mode = raw.mode;
  if (isIntegerIn(FILTER_SPECKLE_RANGE, raw.filterSpeckle)) kept.filterSpeckle = raw.filterSpeckle;
  if (isIntegerIn(COLOR_PRECISION_RANGE, raw.colorPrecision)) kept.colorPrecision = raw.colorPrecision;
  if (isTolerance(raw.simplify)) kept.simplify = raw.simplify;
  return Object.keys(kept).length > 0 ? kept : undefined;
}
