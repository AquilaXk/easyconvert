/**
 * Options of the raster to SVG tracer, shared by the request schema, the options dialog and the engine run. The names,
 * ranges and defaults come from the clap definitions and `Config::from_preset` of the pinned vtracer 1.0.0-alpha.4
 * release (`crates/vtracer-cli/src/main.rs` and `crates/vtracer/src/config.rs`, MIT OR Apache-2.0), with bounded caps on
 * `pathPrecision` (`0..=8`) and `watershedDetail` (`0..=255`) and `--optimize 2` enabled by default. Each option is
 * described once in `VECTORIZE_OPTIONS`, and validation (via O(1) lookup sets), CLI serialisation and OpenAPI schema
 * derive from that single table.
 */

/** Raster sources traced to SVG: still-image formats decoded in-process or via sandboxed helpers to 8-bit sRGB RGBA. */
export const VECTORIZE_SOURCES: ReadonlySet<string> = new Set([
  'png',
  'jpg',
  'jpeg',
  'jfif',
  'webp',
  'avif',
  'gif',
  'bmp',
  'tif',
  'tiff',
  'ico',
  'cur',
  'icns',
  'heic',
  'heif',
  'jxl',
  'psd',
  'tga',
  'pnm',
  'pbm',
  'pgm',
  'ppm',
]);
const VECTORIZE_TARGET = 'svg';

export const VECTORIZE_PRESETS = ['bw', 'poster', 'photo'] as const;
export const VECTORIZE_CLUSTERINGS = ['color-cluster', 'bw', 'watershed'] as const;
export const VECTORIZE_HIERARCHICALS = ['stacked', 'cutout'] as const;
export const VECTORIZE_MODES = ['spline', 'polygon', 'pixel'] as const;

export type VectorizePreset = (typeof VECTORIZE_PRESETS)[number];
export type VectorizeClustering = (typeof VECTORIZE_CLUSTERINGS)[number];
export type VectorizeHierarchical = (typeof VECTORIZE_HIERARCHICALS)[number];
export type VectorizeMode = (typeof VECTORIZE_MODES)[number];

export interface VectorizeOptions {
  /** A starting point tuned for line art (`bw`), flat graphics (`poster`) or photographs (`photo`). */
  preset?: VectorizePreset;
  /** Region-forming segmentation engine (`color-cluster`, `bw`, or Cousty/Najman `watershed`). */
  clustering?: VectorizeClustering;
  /** Layer composition: painter's `stacked` layers (default) or seam-free `cutout` topological mosaic. */
  hierarchical?: VectorizeHierarchical;
  /** Curve fitting: smooth curves, straight edges, or the pixel edges themselves. */
  mode?: VectorizeMode;
  /** Patches smaller than this side length in pixels are dropped (`0..=128`). */
  filterSpeckle?: number;
  /** Significant bits per RGB channel (`1..=8`). */
  colorPrecision?: number;
  /** Colour difference between hierarchical gradient layers (`0..=255`). */
  gradientStep?: number;
  /** Watershed hierarchy cut level (`0..=255`, default `128`). */
  watershedDetail?: number;
  /** Curves are refitted with the fewest cubics that stay within this distance in pixels (`> 0`). */
  simplify?: number;
  /** Decimal places in SVG path coordinates (`0..=8`, default `2`). */
  pathPrecision?: number;
  /** Area-weighted median-cut palette cap in OKLab (`1..=256`). */
  maxColors?: number;
  /** Fixed hex palette (`#RRGGBB` entries, `1..=64`), snapped in OKLab. */
  palette?: readonly string[];
  /** Bradley–Roth integral-image adaptive binary thresholding for unevenly lit scans. */
  adaptive?: boolean;
  /** Fixed binary intensity cutoff (`0..=255`, default `128`) when `adaptive` is off. */
  threshold?: number;
  /** Output optimisation level: `0` = raw, `1` = quantize + cleanup, `2` = `<g fill>` + `H`/`V`/`S` + SVGO compaction (default `2`). */
  optimize?: number;
}

export type VectorizeOptionKey = keyof VectorizeOptions;

export interface IntegerRange {
  readonly min: number;
  readonly max: number;
}

export const FILTER_SPECKLE_RANGE: IntegerRange = { min: 0, max: 128 };
export const COLOR_PRECISION_RANGE: IntegerRange = { min: 1, max: 8 };
export const GRADIENT_STEP_RANGE: IntegerRange = { min: 0, max: 255 };
export const WATERSHED_DETAIL_RANGE: IntegerRange = { min: 0, max: 255 };
export const PATH_PRECISION_RANGE: IntegerRange = { min: 0, max: 8 };
export const MAX_COLORS_RANGE: IntegerRange = { min: 1, max: 256 };
export const THRESHOLD_RANGE: IntegerRange = { min: 0, max: 255 };
export const OPTIMIZE_RANGE: IntegerRange = { min: 0, max: 2 };
export const PALETTE_MAX_COLORS = 64;
/** A simplify tolerance must be above this (`parse_simplify_tolerance`). */
export const TOLERANCE_EXCLUSIVE_MINIMUM = 0;

export const DEFAULT_VECTORIZE_MODE: VectorizeMode = 'spline';
export const DEFAULT_VECTORIZE_HIERARCHICAL: VectorizeHierarchical = 'stacked';
export const DEFAULT_VECTORIZE_OPTIMIZE = 2;
export const DEFAULT_PATH_PRECISION = 2;
export const DEFAULT_BINARY_THRESHOLD = 128;
export const DEFAULT_WATERSHED_DETAIL = 128;

/** What the engine uses for the values a request leaves out: its defaults, or those of the preset (`Config::from_preset`). */
export interface VectorizeDefaults {
  readonly filterSpeckle: number;
  readonly colorPrecision: number;
  readonly gradientStep: number;
  readonly pathPrecision: number;
}

const ENGINE_DEFAULTS: VectorizeDefaults = {
  filterSpeckle: 4,
  colorPrecision: 6,
  gradientStep: 16,
  pathPrecision: DEFAULT_PATH_PRECISION,
};

const PRESET_DEFAULTS: Readonly<Record<VectorizePreset, VectorizeDefaults>> = {
  bw: ENGINE_DEFAULTS,
  poster: { ...ENGINE_DEFAULTS, colorPrecision: 8 },
  photo: { ...ENGINE_DEFAULTS, filterSpeckle: 10, colorPrecision: 8, gradientStep: 48 },
};

export function vectorizeDefaults(preset: VectorizePreset | undefined): VectorizeDefaults {
  return preset === undefined ? ENGINE_DEFAULTS : PRESET_DEFAULTS[preset];
}

/** Resolves the active region-forming engine the way `build_config` in `main.rs` resolves it (`--clustering` overrides `--preset`). */
export function effectiveVectorizeClustering(options: VectorizeOptions): VectorizeClustering {
  if (options.clustering !== undefined) return options.clustering;
  return options.preset === 'bw' ? 'bw' : 'color-cluster';
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
  /** Custom CLI argument emitter (for boolean flags or comma-joined lists). */
  readonly toArgs?: (flag: string, value: T) => string[];
}

function choiceOf<T extends string>(choices: readonly T[], description: string): OptionKind<T> {
  const allowed: ReadonlySet<string> = new Set(choices);
  return {
    isValid: (value): value is T => typeof value === 'string' && allowed.has(value),
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

function booleanFlag(description: string): OptionKind<boolean> {
  return {
    isValid: (value): value is boolean => typeof value === 'boolean',
    rule: 'must be a boolean (true or false)',
    schema: { type: 'boolean', description },
  };
}

const HEX_COLOR_PATTERN = /^#[0-9A-Fa-f]{6}$/;

function hexPaletteOf(description: string): OptionKind<readonly string[]> {
  return {
    isValid: (value): value is readonly string[] =>
      Array.isArray(value) &&
      value.length >= 1 &&
      value.length <= PALETTE_MAX_COLORS &&
      value.every((entry) => typeof entry === 'string' && HEX_COLOR_PATTERN.test(entry)),
    rule: `must be an array of 1 to ${PALETTE_MAX_COLORS} #RRGGBB hex colors`,
    schema: {
      type: 'array',
      minItems: 1,
      maxItems: PALETTE_MAX_COLORS,
      items: { type: 'string', pattern: '^#[0-9A-Fa-f]{6}$' },
      description,
    },
  };
}

/** In schema order. Each applicability predicate mirrors `Config::build` in `crates/vtracer/src/config.rs`. */
export const VECTORIZE_OPTIONS: { readonly [K in VectorizeOptionKey]-?: OptionDescriptor<NonNullable<VectorizeOptions[K]>> } = {
  preset: {
    flag: '--preset',
    ...choiceOf(VECTORIZE_PRESETS, 'Start from settings tuned for the input: bw for black and white line art, poster for flat graphics with few colours, photo for photographs.'),
  },
  clustering: {
    flag: '--clustering',
    ...choiceOf(VECTORIZE_CLUSTERINGS, 'Region segmentation algorithm: color-cluster (default), bw (binary line art), or watershed (volume-extinction hierarchy).'),
  },
  hierarchical: {
    flag: '--hierarchical',
    ...choiceOf(VECTORIZE_HIERARCHICALS, 'Layer composition: stacked (default) overlaps layers bottom-to-top; cutout builds a seam-free gapless topological mosaic.'),
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
    applies: (options) => effectiveVectorizeClustering(options) === 'color-cluster',
  },
  gradientStep: {
    flag: '--gradient-step',
    ...integerIn(
      GRADIENT_STEP_RANGE,
      `Colour difference between gradient layers (${GRADIENT_STEP_RANGE.min} to ${GRADIENT_STEP_RANGE.max}, default ${ENGINE_DEFAULTS.gradientStep}). Higher values merge subtle gradients into fewer layers.`
    ),
    applies: (options) => effectiveVectorizeClustering(options) === 'color-cluster',
  },
  watershedDetail: {
    flag: '--watershed-detail',
    ...integerIn(
      WATERSHED_DETAIL_RANGE,
      `Watershed hierarchy cut level (${WATERSHED_DETAIL_RANGE.min} to ${WATERSHED_DETAIL_RANGE.max}, default ${DEFAULT_WATERSHED_DETAIL}). Higher values keep finer regions.`
    ),
    applies: (options) => effectiveVectorizeClustering(options) === 'watershed',
  },
  simplify: {
    flag: '--simplify',
    ...toleranceOf('Refit curves with the fewest segments that stay within this distance in pixels (try 1 to 2.5). Fewer nodes and a smaller file. Off by default.'),
    applies: (options) => (options.mode ?? DEFAULT_VECTORIZE_MODE) === 'spline',
  },
  pathPrecision: {
    flag: '--path-precision',
    ...integerIn(
      PATH_PRECISION_RANGE,
      `Decimal places in SVG path coordinates (${PATH_PRECISION_RANGE.min} to ${PATH_PRECISION_RANGE.max}, default ${DEFAULT_PATH_PRECISION}).`
    ),
  },
  maxColors: {
    flag: '--max-colors',
    ...integerIn(
      MAX_COLORS_RANGE,
      `Quantize the traced regions to at most this many colours in OKLab (${MAX_COLORS_RANGE.min} to ${MAX_COLORS_RANGE.max}) and merge adjacent same-colour layers.`
    ),
    applies: (options) => effectiveVectorizeClustering(options) !== 'bw' && options.palette === undefined,
  },
  palette: {
    flag: '--palette',
    ...hexPaletteOf(`Snap traced regions in OKLab to this fixed list of #RRGGBB hex colours (up to ${PALETTE_MAX_COLORS} entries) and merge adjacent same-colour layers.`),
    applies: (options) => effectiveVectorizeClustering(options) !== 'bw',
    toArgs: (flag, value) => [flag, value.join(',')],
  },
  adaptive: {
    flag: '--adaptive',
    ...booleanFlag('Use Bradley–Roth integral-image adaptive binary thresholding to preserve strokes under uneven lighting and shadows.'),
    applies: (options) => effectiveVectorizeClustering(options) === 'bw',
    toArgs: (flag, value) => (value ? [flag] : []),
  },
  threshold: {
    flag: '--threshold',
    ...integerIn(
      THRESHOLD_RANGE,
      `Fixed binary intensity cutoff (${THRESHOLD_RANGE.min} to ${THRESHOLD_RANGE.max}, default ${DEFAULT_BINARY_THRESHOLD}) when adaptive thresholding is off.`
    ),
    applies: (options) => effectiveVectorizeClustering(options) === 'bw' && options.adaptive !== true,
  },
  optimize: {
    flag: '--optimize',
    ...integerIn(
      OPTIMIZE_RANGE,
      `Output optimisation level (${OPTIMIZE_RANGE.min} to ${OPTIMIZE_RANGE.max}, default ${DEFAULT_VECTORIZE_OPTIMIZE}): 0 raw absolute paths, 1 quantize and cleanup, 2 <g fill> grouping, H/V/S shorthands and SVGO path/colour compaction.`
    ),
  },
};

/** The option names in schema order, plus an O(1) lookup set for request validation. */
const OPTION_KEYS = Object.keys(VECTORIZE_OPTIONS) as VectorizeOptionKey[];
const OPTION_KEY_SET: ReadonlySet<string> = new Set(OPTION_KEYS);

export function isVectorizePair(sourceFormat: string, targetFormat: string): boolean {
  return targetFormat.toLowerCase() === VECTORIZE_TARGET && VECTORIZE_SOURCES.has(sourceFormat.toLowerCase());
}

/** The `vectorize` property of the request schema. */
export const VECTORIZE_OPTIONS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  description:
    'Raster image to SVG vector tracing options. Only the values you set are sent to the tracer (overriding the preset), with --optimize 2 enabled by default. Animated GIF/WebP and multi-page TIFF/ICO/PSD files are traced from their primary/first frame.',
  properties: Object.fromEntries(OPTION_KEYS.map((key) => [key, VECTORIZE_OPTIONS[key].schema])),
} as const;

/** The first reason `raw` is not a valid `vectorize` option object, or null when it is one. */
export function vectorizeOptionsProblem(raw: unknown): string | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return 'vectorize must be an object';
  const fields = raw as Record<string, unknown>;
  for (const key of Object.keys(fields)) {
    if (!OPTION_KEY_SET.has(key)) return `vectorize.${key} is not an option of the tracer`;
  }
  for (const key of OPTION_KEYS) {
    const value = fields[key];
    if (value !== undefined && !VECTORIZE_OPTIONS[key].isValid(value)) {
      return `vectorize.${key} ${VECTORIZE_OPTIONS[key].rule}`;
    }
  }
  return null;
}

/** Whether the engine reads `key` given the other values of `options`. */
export function vectorizeOptionApplies(key: VectorizeOptionKey, options: VectorizeOptions): boolean {
  return VECTORIZE_OPTIONS[key].applies?.(options) ?? true;
}

/** The fields of `options` that hold a value and pass `keep`, in schema order, or undefined when none is left. */
export function pickVectorizeFields(options: VectorizeOptions, keep: (key: VectorizeOptionKey) => boolean = () => true): VectorizeOptions | undefined {
  const picked: VectorizeOptions = {};
  for (const key of OPTION_KEYS) {
    if (options[key] !== undefined && keep(key)) {
      Object.assign(picked, { [key]: options[key] });
    }
  }
  return Object.keys(picked).length > 0 ? picked : undefined;
}

/** The valid fields of `raw` the engine reads: what a queue item keeps for a pair. */
export function sanitizeVectorizeOptions(raw: VectorizeOptions | undefined): VectorizeOptions | undefined {
  if (raw === undefined) return undefined;
  const valid = pickVectorizeFields(raw, (key) => VECTORIZE_OPTIONS[key].isValid(raw[key])) ?? {};
  return pickVectorizeFields(valid, (key) => vectorizeOptionApplies(key, valid) && !(key === 'adaptive' && valid.adaptive === false));
}

/** The engine flags of the options a request set, in schema order, defaulting `--optimize` to `2` when unset. */
export function vectorizeArgs(options: VectorizeOptions): string[] {
  const out: string[] = [];
  for (const key of OPTION_KEYS) {
    const value = options[key];
    if (value === undefined) continue;
    const descriptor = VECTORIZE_OPTIONS[key] as OptionDescriptor<unknown>;
    if (descriptor.toArgs !== undefined) {
      out.push(...descriptor.toArgs(descriptor.flag, value));
    } else {
      out.push(descriptor.flag, String(value));
    }
  }
  if (options.optimize === undefined) {
    out.push('--optimize', String(DEFAULT_VECTORIZE_OPTIMIZE));
  }
  return out;
}
