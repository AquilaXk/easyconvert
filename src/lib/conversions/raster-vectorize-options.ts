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

/** What a kind of option checks and says: which values it takes, the rule a refused value breaks, and its request schema. */
interface OptionKind<T> {
  readonly isValid: (value: unknown) => value is T;
  readonly rule: string;
  readonly schema: Readonly<Record<string, unknown>>;
}

interface OptionDescriptor<T> extends OptionKind<T> {
  readonly flag: string;
  /** False when the engine ignores the option given the others; the dialog greys it out, and the queue does not keep it. */
  readonly applies?: (options: VectorizeOptions) => boolean;
}

function choiceOf<T extends string>(choices: readonly T[], description: string): OptionKind<T> {
  return {
    isValid: (value): value is T => typeof value === 'string' && (choices as readonly string[]).includes(value),
    rule: `must be one of ${choices.join(', ')}`,
    schema: { type: 'string', enum: choices, description },
  };
}

function integerIn(range: IntegerRange, description: string): OptionKind<number> {
  return {
    isValid: (value): value is number => typeof value === 'number' && Number.isInteger(value) && value >= range.min && value <= range.max,
    rule: `must be a whole number from ${range.min} to ${range.max}`,
    schema: { type: 'integer', minimum: range.min, maximum: range.max, description },
  };
}

function toleranceOf(description: string): OptionKind<number> {
  return {
    isValid: (value): value is number => typeof value === 'number' && Number.isFinite(value) && value > TOLERANCE_EXCLUSIVE_MINIMUM,
    rule: `must be a finite number greater than ${TOLERANCE_EXCLUSIVE_MINIMUM}`,
    schema: { type: 'number', exclusiveMinimum: TOLERANCE_EXCLUSIVE_MINIMUM, description },
  };
}

/** In schema order. `simplify` acts in spline mode only (`Config::simplify`); the `bw` preset clusters in two colours, so it has no colour precision. */
export const VECTORIZE_OPTIONS: { readonly [K in VectorizeOptionKey]-?: OptionDescriptor<NonNullable<VectorizeOptions[K]>> } = {
  preset: {
    flag: '--preset',
    ...choiceOf(VECTORIZE_PRESETS, 'Start from settings tuned for the input: bw for black and white line art, poster for flat graphics with few colours, photo for photographs.'),
  },
  mode: {
    flag: '--mode',
    ...choiceOf(VECTORIZE_MODES, 'Curve fitting: spline (default) draws smooth curves, polygon straight edges, pixel keeps the pixel edges (for pixel art).'),
  },
  filterSpeckle: {
    flag: '--filter-speckle',
    ...integerIn(
      FILTER_SPECKLE_RANGE,
      `Discard patches smaller than this size in pixels (${FILTER_SPECKLE_RANGE.min} to ${FILTER_SPECKLE_RANGE.max}, default ${ENGINE_DEFAULTS.filterSpeckle}). Raise it to remove noise from scans and JPEG artefacts.`
    ),
  },
  colorPrecision: {
    flag: '--color-precision',
    ...integerIn(
      COLOR_PRECISION_RANGE,
      `Significant bits per RGB channel (${COLOR_PRECISION_RANGE.min} to ${COLOR_PRECISION_RANGE.max}, default ${ENGINE_DEFAULTS.colorPrecision}). Lower values give fewer colours and flatter shapes.`
    ),
    applies: (options) => options.preset !== 'bw',
  },
  simplify: {
    flag: '--simplify',
    ...toleranceOf('Refit curves with the fewest segments that stay within this distance in pixels (try 1 to 2.5). Fewer nodes and a smaller file. Off by default.'),
    applies: (options) => (options.mode ?? DEFAULT_VECTORIZE_MODE) === 'spline',
  },
};

/** The option names in schema order. */
const OPTION_KEYS = Object.keys(VECTORIZE_OPTIONS) as VectorizeOptionKey[];

export function isVectorizePair(sourceFormat: string, targetFormat: string): boolean {
  return targetFormat.toLowerCase() === VECTORIZE_TARGET && VECTORIZE_SOURCES.has(sourceFormat.toLowerCase());
}

/** The `vectorize` property of the request schema. */
export const VECTORIZE_OPTIONS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  description:
    'PNG, JPEG, WebP, GIF, BMP or TIFF to SVG: how the picture is traced into shapes. Only the values you set are sent to the tracer, and they override the preset. An animated GIF or WebP and a multi-page TIFF are traced from their first frame.',
  properties: Object.fromEntries(OPTION_KEYS.map((key) => [key, VECTORIZE_OPTIONS[key].schema])),
} as const;

/** The first reason `raw` is not a valid `vectorize` option object, or null when it is one. */
export function vectorizeOptionsProblem(raw: unknown): string | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return 'vectorize must be an object';
  const fields = raw as Record<string, unknown>;
  const unknown = Object.keys(fields).find((key) => !Object.hasOwn(VECTORIZE_OPTIONS, key));
  if (unknown !== undefined) return `vectorize.${unknown} is not an option of the tracer`;
  const invalid = OPTION_KEYS.find((key) => fields[key] !== undefined && !VECTORIZE_OPTIONS[key].isValid(fields[key]));
  return invalid === undefined ? null : `vectorize.${invalid} ${VECTORIZE_OPTIONS[invalid].rule}`;
}

/** Whether the engine reads `key` given the other values of `options`. */
export function vectorizeOptionApplies(key: VectorizeOptionKey, options: VectorizeOptions): boolean {
  return VECTORIZE_OPTIONS[key].applies?.(options) ?? true;
}

/** The fields of `options` that hold a value and pass `keep`, in schema order, or undefined when none is left. */
export function pickVectorizeFields(options: VectorizeOptions, keep: (key: VectorizeOptionKey) => boolean = () => true): VectorizeOptions | undefined {
  const picked: VectorizeOptions = {};
  for (const key of OPTION_KEYS) if (options[key] !== undefined && keep(key)) Object.assign(picked, { [key]: options[key] });
  return Object.keys(picked).length > 0 ? picked : undefined;
}

/** The valid fields of `raw` the engine reads: what a queue item keeps for a pair. */
export function sanitizeVectorizeOptions(raw: VectorizeOptions | undefined): VectorizeOptions | undefined {
  if (raw === undefined) return undefined;
  const valid = pickVectorizeFields(raw, (key) => VECTORIZE_OPTIONS[key].isValid(raw[key])) ?? {};
  return pickVectorizeFields(valid, (key) => vectorizeOptionApplies(key, valid));
}

/** The engine flags of the options a request set, in schema order. Explicit flags override the preset, so only set values are sent. */
export function vectorizeArgs(options: VectorizeOptions): string[] {
  return OPTION_KEYS.filter((key) => options[key] !== undefined).flatMap((key) => [VECTORIZE_OPTIONS[key].flag, String(options[key])]);
}
