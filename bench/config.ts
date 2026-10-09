import path from 'node:path';

/** Named limits and defaults of the benchmark harness. */

export const REPO_ROOT = path.resolve(__dirname, '..');
export const CORPUS_DIR = path.join(__dirname, 'corpus');
/** Authored documents the document family converts (their provenance and hand-written structure live with the tests). */
export const DOCUMENT_FIXTURES_DIR = path.join(REPO_ROOT, 'tests', 'fixtures', 'document');
export const HWP_FIXTURES_DIR = path.join(REPO_ROOT, 'tests', 'fixtures', 'hwp');
export const BASELINE_PATH = path.join(__dirname, 'baseline.json');
export const RESULTS_DIR = path.join(REPO_ROOT, 'bench-results');

export const SCHEMA_VERSION = 1;

/** Interleaved timing runs per throughput row, and the ceiling a command line may ask for. */
export const DEFAULT_RUNS = 5;
export const MAX_RUNS = 25;
/** Slow encoders (video, office) use at most this many timing runs so the whole benchmark stays short. */
export const HEAVY_RUNS_CAP = 3;
/** Untimed runs before the measured ones, so module loading and worker start-up are not in the first sample. */
export const WARMUP_RUNS = 1;

/** A reference tool that has not finished in this time is hung, not slow. */
export const TOOL_TIMEOUT_MS = 300_000;
/** Output a reference tool may write to stdout or stderr before the harness treats it as runaway. */
export const TOOL_MAX_BUFFER_BYTES = 128 * 1024 * 1024;
/** Report and baseline files above this size are rejected before parsing. */
export const MAX_JSON_BYTES = 8 * 1024 * 1024;
/** Rows a report or baseline may hold. */
export const MAX_ROWS = 5_000;

/** Bjontegaard fits a cubic, so it needs four points; more are fitted by least squares. */
export const BD_MIN_POINTS = 4;
export const BD_MAX_POINTS = 16;

/** PSNR of identical pictures is infinite; JSON cannot hold it, so lossless results are recorded at this value. */
export const PSNR_CAP_DB = 100;
/** SSIM is mapped to decibels as -10 log10(1 - SSIM); this floor on 1 - SSIM bounds the result for identical pictures. */
export const SSIM_DISTANCE_FLOOR = 1e-6;

export const BYTES_PER_MB = 1_000_000;
export const BITS_PER_BYTE = 8;
export const BITS_PER_KILOBIT = 1_000;
export const MS_PER_SECOND = 1_000;

/** Two floating point results closer than this are equal for the regression gate. */
export const GATE_EPSILON = 1e-9;
