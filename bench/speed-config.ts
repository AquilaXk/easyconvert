/**
 * The constants that judge a row: the tolerances of the baseline gate, the speed rules (pairs, caps, intervals, history, floors)
 * and the schema limits of reports and gap files. They are gate code: the `parity speed` job takes this file from the base
 * commit (scripts/ci-parity-base-gate.mjs), so a change cannot loosen what judges it. What a family measures, where its files
 * are and which cases a quick run covers stay in bench/config.ts.
 */

export const SCHEMA_VERSION = 1;

export const MAX_RUNS = 25;

/** Report and baseline files above this size are rejected before parsing. */
export const MAX_JSON_BYTES = 8 * 1024 * 1024;

/** Rows a report or baseline may hold. */
export const MAX_ROWS = 5_000;

export const MS_PER_SECOND = 1_000;

/** Two floating point results closer than this are equal for the regression gate. */
export const GATE_EPSILON = 1e-9;

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

/**
 * A row still undecided at its cap collects pairs up to this second cap (sequential sampling that stops as soon as the
 * interval decides). It is at most the 64 pairs the sign-test interval is exact for. Only rows whose interval straddles
 * the pass line at the first cap reach it, so a row that decides early costs nothing.
 */
export const SPEED_LIGHT_EXTENDED_MAX_PAIRS = 50;

export const SPEED_HEAVY_EXTENDED_MAX_PAIRS = 36;

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
 * prediction bound, bench/speed-history.ts) or below a fixed share of the median of that history, whichever is higher.
 */
export const SPEED_HISTORY_MAX_POINTS = 10;

/** Fewer points than this and there is no prediction bound; the fixed share of the median is the only limit. */
export const SPEED_HISTORY_MIN_POINTS = 3;

/** One-sided confidence of the prediction bound. The t quantiles in bench/speed-history.ts are for this level only. */
export const SPEED_HISTORY_CONFIDENCE = 0.99;

/**
 * A tracked row fails when its median falls below this share of the median of its history (since its last step), or of its
 * recorded ratio while it has no history, whatever the spread of that history. The prediction bound alone admits a large
 * slowdown once a history is noisy; this floor is the limit of the damage.
 *
 * It is set from the runner, not from a wish. Over three nightly runs of this branch (32 rows each, 64 consecutive
 * changes of rows whose code did not change) the log ratio moved by a standard deviation of 0.152 from one run to the next,
 * 0.108 for one run; the worst fall between two runs was 31 percent (0.69 times), the fifth percentile 24 percent, and
 * a whole run can be fast or slow together (the second run was 15 to 30 percent above both others on every CPU-bound row).
 * A first draft of 85 percent of the latest point failed 7 of 17 gated rows on the next run of unchanged code. 65 percent
 * lies under the worst fall seen against a history median, and still fails a halving of a speed.
 */
export const SPEED_GAP_FLOOR = 0.65;

/**
 * Smallest spread (standard deviation of the log ratios) the step test assumes of a history, so a history of near-equal
 * points does not call every small rise a step. It is the per-run spread measured on the runner (see SPEED_GAP_FLOOR).
 */
export const SPEED_HISTORY_MIN_LOG_SPREAD = 0.11;

/**
 * A run this many times above the geometric mean of a history is a step: a speed-up that landed on main, after which the
 * older points describe code that no longer exists. A run of unchanged code rose by as much as 1.33 times over the run
 * before and 1.53 times over the history it joined; the speed-ups that did land (AVIF through the reference library,
 * archive streaming, OCR in bands) were 1.65 times or more.
 */
export const SPEED_STEP_FACTOR = 1.6;

/**
 * A gap entry a pull request adds or changes must be backed by that pull request's own speed measurement: the recorded
 * ratio, and every history point the change adds, lie inside the measured interval of the row widened by this log
 * margin on each side (twice the run-to-run spread of a runner, SPEED_HISTORY_MIN_LOG_SPREAD, since the entry was
 * recorded in another run). A made-up entry far from what the pull request measures is refused.
 */
export const GAP_BACKING_LOG_MARGIN = 2 * SPEED_HISTORY_MIN_LOG_SPREAD;

export const PARITY_VERDICT_FILE = 'parity-verdict.json';

export const PARITY_SCHEMA_VERSION = 1;

/** Gap entries a gaps file may hold. */
export const MAX_GAP_ENTRIES = 500;

export const BYTES_PER_MB = 1_000_000;
