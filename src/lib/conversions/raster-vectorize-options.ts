/**
 * Options of the raster to SVG tracer, shared by the request schema, the options dialog and the engine run. The names,
 * ranges and defaults are the engine's own: the clap definitions and `Config::from_preset` of the pinned vtracer
 * release (crates/vtracer-cli/src/main.rs and crates/vtracer/src/config.rs at 1.0.0-alpha.4). Each option is described
 * once, in VECTORIZE_OPTIONS, and the checks, the command line and the schema are derived from that table.
 */

/** Raster sources traced to SVG: exactly the inputs the reference converter serves with the same engine. */
export const VECTORIZE_SOURCES: ReadonlySet<string> = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'tif', 'tiff']);
const VECTORIZE_TARGET = 'svg';

export const VECTORIZE_PRESETS = ['bw', 'poster', 'photo'] as const;
export const VECTORIZE_MODES = ['spline', 'polygon', 'pixel'] as const;
type VectorizePreset = (typeof VECTORIZE_PRESETS)[number];
type VectorizeMode = (typeof VECTORIZE_MODES)[number];

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

export type VectorizeOptionKey = keyof VectorizeOptions;

export interface IntegerRange {
  readonly min: number;
  readonly max: number;
}

export const FILTER_SPECKLE_RANGE: IntegerRange = { min: 0, max: 128 };
export const COLOR_PRECISION_RANGE: IntegerRange = { min: 1, max: 8 };
/** A simplify tolerance must be above this (`parse_simplify_tolerance`). */
export const TOLERANCE_EXCLUSIVE_MINIMUM = 0;
export const DEFAULT_VECTORIZE_MODE: VectorizeMode = 'spline';

/** One option: its engine flag, the values it takes, what the schema says of it, and when the engine reads it. */
type OptionDescriptor = {
  readonly flag: string;
  readonly description: string;
  /** False when the engine ignores the option given the others; the dialog greys it out and does not keep it. */
  readonly applies?: (options: VectorizeOptions) => boolean;
} & (
  | { readonly kind: 'choice'; readonly choices: readonly string[] }
  | { readonly kind: 'integer'; readonly range: IntegerRange }
  | { readonly kind: 'tolerance' }
);

/** In schema order. `simplify` acts in spline mode only (`Config::simplify`); the `bw` preset clusters in two colours, so it has no colour precision. */
export const VECTORIZE_OPTIONS: { readonly [K in VectorizeOptionKey]-?: OptionDescriptor } = {
  preset: {
    flag: '--preset',
    kind: 'choice',
    choices: VECTORIZE_PRESETS,
    description: 'Start from settings tuned for the input: bw for black and white line art, poster for flat graphics with few colours, photo for photographs.',
  },
  mode: {
    flag: '--mode',
    kind: 'choice',
    choices: VECTORIZE_MODES,
    description: 'Curve fitting: spline (default) draws smooth curves, polygon straight edges, pixel keeps the pixel edges (for pixel art).',
  },
  filterSpeckle: {
    flag: '--filter-speckle',
    kind: 'integer',
    range: FILTER_SPECKLE_RANGE,
    description: 'Discard patches smaller than this size in pixels (0 to 128, default 4). Raise it to remove noise from scans and JPEG artefacts.',
  },
  colorPrecision: {
    flag: '--color-precision',
    kind: 'integer',
    range: COLOR_PRECISION_RANGE,
    description: 'Significant bits per RGB channel (1 to 8, default 6). Lower values give fewer colours and flatter shapes.',
    applies: (options) => options.preset !== 'bw',
  },
  simplify: {
    flag: '--simplify',
    kind: 'tolerance',
    description: 'Refit curves with the fewest segments that stay within this distance in pixels (try 1 to 2.5). Fewer nodes and a smaller file. Off by default.',
    applies: (options) => (options.mode ?? DEFAULT_VECTORIZE_MODE) === 'spline',
  },
};

const OPTION_ENTRIES = Object.entries(VECTORIZE_OPTIONS) as Array<[VectorizeOptionKey, OptionDescriptor]>;

/** What the engine uses for the values a request leaves out: its defaults, or those of the preset (`Config::from_preset`). */
interface VectorizeDefaults {
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

function isValid(option: OptionDescriptor, value: unknown): boolean {
  switch (option.kind) {
    case 'choice':
      return typeof value === 'string' && option.choices.includes(value);
    case 'integer':
      return Number.isInteger(value) && (value as number) >= option.range.min && (value as number) <= option.range.max;
    case 'tolerance':
      return typeof value === 'number' && Number.isFinite(value) && value > TOLERANCE_EXCLUSIVE_MINIMUM;
  }
}

function rule(option: OptionDescriptor): string {
  switch (option.kind) {
    case 'choice':
      return `must be one of ${option.choices.join(', ')}`;
    case 'integer':
      return `must be a whole number from ${option.range.min} to ${option.range.max}`;
    case 'tolerance':
      return `must be a finite number greater than ${TOLERANCE_EXCLUSIVE_MINIMUM}`;
  }
}

function schemaOf(option: OptionDescriptor): Record<string, unknown> {
  switch (option.kind) {
    case 'choice':
      return { type: 'string', enum: option.choices, description: option.description };
    case 'integer':
      return { type: 'integer', minimum: option.range.min, maximum: option.range.max, description: option.description };
    case 'tolerance':
      return { type: 'number', exclusiveMinimum: TOLERANCE_EXCLUSIVE_MINIMUM, description: option.description };
  }
}

/** The `vectorize` property of the request schema. */
export const VECTORIZE_OPTIONS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  description:
    'PNG, JPEG, WebP, GIF, BMP or TIFF to SVG: how the picture is traced into shapes. Only the values you set are sent to the tracer, and they override the preset. An animated GIF or WebP and a multi-page TIFF are traced from their first frame.',
  properties: Object.fromEntries(OPTION_ENTRIES.map(([key, option]) => [key, schemaOf(option)])),
} as const;

/** The first reason `raw` is not a valid `vectorize` option object, or null when it is one. */
export function vectorizeOptionsProblem(raw: unknown): string | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return 'vectorize must be an object';
  const fields = raw as Record<string, unknown>;
  const unknown = Object.keys(fields).find((key) => !Object.hasOwn(VECTORIZE_OPTIONS, key));
  if (unknown !== undefined) return `vectorize.${unknown} is not an option of the tracer`;
  const invalid = OPTION_ENTRIES.find(([key, option]) => fields[key] !== undefined && !isValid(option, fields[key]));
  return invalid === undefined ? null : `vectorize.${invalid[0]} ${rule(invalid[1])}`;
}

/** Whether the engine reads `key` given the other values of `options`. */
export function vectorizeOptionApplies(key: VectorizeOptionKey, options: VectorizeOptions): boolean {
  return VECTORIZE_OPTIONS[key].applies?.(options) ?? true;
}

/** The valid fields of `raw` the engine reads: what the options dialog keeps for a pair. */
export function sanitizeVectorizeOptions(raw: VectorizeOptions | undefined): VectorizeOptions | undefined {
  if (raw === undefined) return undefined;
  const valid = Object.fromEntries(OPTION_ENTRIES.filter(([key, option]) => isValid(option, raw[key])).map(([key]) => [key, raw[key]])) as VectorizeOptions;
  const kept = Object.fromEntries(Object.entries(valid).filter(([key]) => vectorizeOptionApplies(key as VectorizeOptionKey, valid))) as VectorizeOptions;
  return Object.keys(kept).length > 0 ? kept : undefined;
}

/** The engine flags of the options a request set, in schema order. Explicit flags override the preset, so only set values are sent. */
export function vectorizeArgs(options: VectorizeOptions): string[] {
  return OPTION_ENTRIES.filter(([key]) => options[key] !== undefined).flatMap(([key, option]) => [option.flag, String(options[key])]);
}
