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
/** Calls of an in-process conversion timed back to back per sample, so a conversion of milliseconds is not decided by scheduler jitter. */
export const IN_PROCESS_REPEATS = 5;
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

/**
 * Reference-parity gate (`--parity`). A conversion change merges only when every benchmarked row is at or above the
 * reference tool: quality rows by their deterministic measurement, speed rows by a confidence interval of the speed
 * ratio measured in the same job.
 */

/** Share of the reference speed ours may lose and still pass: the measurement allowance of a speed row. */
export const SPEED_PARITY_TOLERANCE = 0.03;
/** Two-sided confidence level of the speed-ratio interval. */
export const SPEED_CONFIDENCE_LEVEL = 0.95;
/**
 * Smallest number of paired runs whose order-statistic interval reaches SPEED_CONFIDENCE_LEVEL: the interval
 * [min, max] of n runs has confidence 1 - 2 / 2^n, which first exceeds 0.95 at n = 6.
 */
export const SPEED_MIN_PAIRS = 6;
/** Paired runs a light row starts with, and the most it may collect before an unstable result counts as a failure. */
export const SPEED_LIGHT_INITIAL_PAIRS = 7;
export const SPEED_LIGHT_MAX_PAIRS = 25;
/** The same for video, OCR and office rows, which take seconds per run. */
export const SPEED_HEAVY_INITIAL_PAIRS = 6;
export const SPEED_HEAVY_MAX_PAIRS = 12;
/** Paired runs added each time the interval straddles the pass line. */
export const SPEED_PAIRS_STEP = 4;
/**
 * Untimed rounds of both sides before the timed pairs. Our side runs in-process, so the engine's JIT tiers up over its
 * first calls: a one-round warm-up left it 20% slower than the same code after five (zstd decode of the mixed corpus,
 * median speed ratio 0.99 against 1.20), which is a measurement artefact, not a property of the code. A server that
 * handles requests runs warm. Heavy rows take seconds per run and use the single round the other modes use.
 */
export const SPEED_LIGHT_WARMUP_ROUNDS = 5;
export const SPEED_HEAVY_WARMUP_ROUNDS = 1;

/**
 * Shortest time one timed sample of either side may take. A side whose single call is shorter is timed over enough
 * back-to-back calls that the sample lasts at least this long (the sample is the mean per call), so timer resolution
 * and scheduler jitter of a few milliseconds are a small share of every sample. Calibrated once per row, before the
 * timed pairs.
 */
export const SPEED_MIN_SAMPLE_MS = 50;
/** Most back-to-back calls a calibrated sample holds, so a near-instant call cannot make a sample run away. */
export const SPEED_MAX_SAMPLE_REPEATS = 1000;

/**
 * Tracked gaps (bench/parity-gaps.json) keep the speed ratios of the latest CI-measured runs per row. A tracked row
 * fails when its median speed ratio is below what that history predicts (the lower edge of a one-sided Student's t
 * prediction bound, bench/speed-history.ts) or below a fixed share of its latest recorded median, whichever is higher.
 */
export const SPEED_HISTORY_MAX_POINTS = 10;
/** Fewer points than this and there is no prediction bound; the fixed share of the latest median is the only limit. */
export const SPEED_HISTORY_MIN_POINTS = 3;
/** One-sided confidence of the prediction bound. The t quantiles in bench/speed-history.ts are for this level only. */
export const SPEED_HISTORY_CONFIDENCE = 0.99;
/**
 * A tracked row fails when its median falls below this share of its latest recorded median, whatever the spread of its
 * history. The prediction bound alone admits a large slowdown once a history spans a step or a noisy week; this floor is
 * the limit of the damage. The spread of CI runs of unchanged code is about 7 percent (standard deviation of the log
 * ratio of one run, 0.10 between two runs over 32 rows of two nightly runs), and no row of those two runs fell by more
 * than 6.2 percent, so a drop of 15 percent is outside what the runner does to unchanged code on most nights.
 */
export const SPEED_GAP_FLOOR = 0.85;
/**
 * Smallest spread (standard deviation of the log ratios) the step test assumes of a history, so a history of near-equal
 * points does not call every small rise a step. It is the per-run spread measured on the runner (see SPEED_GAP_FLOOR).
 */
export const SPEED_HISTORY_MIN_LOG_SPREAD = 0.07;
/**
 * A run this many times above the geometric mean of a history is a step: a speed-up that landed on main, after which the
 * older points describe code that no longer exists. The largest rise between two runs of unchanged code was 1.33 times.
 */
export const SPEED_STEP_FACTOR = 1.4;
/** Branch whose nightly and push runs may extend a speed history. */
export const DEFAULT_BRANCH = 'main';
/** Workflow events of the default branch that may extend a speed history. */
export const SPEED_REFRESH_EVENTS: ReadonlySet<string> = new Set(['schedule', 'workflow_dispatch', 'push']);

/** Reference-side measurements of the quality rows are cached here (git-ignored; CI restores it between runs). */
export const REF_CACHE_DIR = path.join(REPO_ROOT, '.bench-cache');
export const REF_CACHE_SCHEMA_VERSION = 1;
/** A cache entry above this size is treated as corrupt: a measurement is a handful of numbers or a page of text. */
export const MAX_CACHE_ENTRY_BYTES = 1024 * 1024;

export const PARITY_GAPS_PATH = path.join(__dirname, 'parity-gaps.json');
export const FAMILY_MAP_PATH = path.join(__dirname, 'family-map.json');
export const PARITY_VERDICT_FILE = 'parity-verdict.json';
export const PARITY_SCHEMA_VERSION = 1;
/** Gap entries a gaps file may hold. */
export const MAX_GAP_ENTRIES = 500;

/**
 * Cases `--quick` measures per family, for the per-push quality gate; `null` measures every case of the family. The
 * subsets reach every target format and every encoder path once (tests/bench-quick-subset.test.ts keeps it so). Image: a
 * photographic JPEG to WebP, a lossless photographic PNG to AVIF (4:2:0, the hardest AVIF input), graphics to AVIF at
 * 4:4:4 and grey line art to AVIF at 4:0:0, and a graphic source to JPEG. Audio: both sources with one lossy and the
 * lossless target. Video: two of the three codecs (HEVC differs only in the encoder binary). Compression, OCR and
 * document: every case, which are seconds each. The nightly run measures all of them.
 */
export const QUICK_SUBSET: Readonly<Record<string, readonly string[] | null>> = {
  image: ['photo-a.jpg->webp', 'photo-b.png->avif', 'screenshot.png->avif', 'lineart.png->avif', 'lineart.png->jpg', 'lineart.png->webp'],
  video: ['clip.mp4->h264', 'clip.mp4->vp9'],
  audio: ['music.wav->opus', 'speech.wav->aac', 'music.wav->flac'],
  ocr: null,
  document: null,
  compression: null,
};
