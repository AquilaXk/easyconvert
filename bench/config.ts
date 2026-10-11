import path from 'node:path';

/** Named limits and defaults of the benchmark harness. */

/** What judges a speed row (bench/speed-config.ts) is part of the gate that the base commit supplies; it is re-exported so that the harness keeps one place to import from. */
export * from './speed-config';

export const REPO_ROOT = path.resolve(__dirname, '..');
export const CORPUS_DIR = path.join(__dirname, 'corpus');
/** The public sample sets fetched at run time (digest-pinned; see bench/corpora.ts). */
export const REMOTE_MANIFEST_PATH = path.join(CORPUS_DIR, 'remote-manifest.json');
/** Verified downloads, content-addressed; git-ignored, and CI restores it with `actions/cache` keyed on the manifest's hash. */
export const REMOTE_CACHE_DIR = process.env.BENCH_CORPUS_CACHE ? path.resolve(process.env.BENCH_CORPUS_CACHE) : path.join(__dirname, '..', '.bench-corpora');
/** Authored documents the document family converts (their provenance and hand-written structure live with the tests). */
export const DOCUMENT_FIXTURES_DIR = path.join(REPO_ROOT, 'tests', 'fixtures', 'document');
export const HWP_FIXTURES_DIR = path.join(REPO_ROOT, 'tests', 'fixtures', 'hwp');
export const BASELINE_PATH = path.join(__dirname, 'baseline.json');
export const RESULTS_DIR = path.join(REPO_ROOT, 'bench-results');

/** Interleaved timing runs per throughput row, and the ceiling a command line may ask for. */
export const DEFAULT_RUNS = 5;
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

/** Bjontegaard fits a cubic, so it needs four points; more are fitted by least squares. */
export const BD_MIN_POINTS = 4;
export const BD_MAX_POINTS = 16;

/** PSNR of identical pictures is infinite; JSON cannot hold it, so lossless results are recorded at this value. */
export const PSNR_CAP_DB = 100;
/** SSIM is mapped to decibels as -10 log10(1 - SSIM); this floor on 1 - SSIM bounds the result for identical pictures. */
export const SSIM_DISTANCE_FLOOR = 1e-6;

export const BITS_PER_BYTE = 8;
export const BITS_PER_KILOBIT = 1_000;

/**
 * Reference-parity gate (`--parity`). A conversion change merges only when every benchmarked row is at or above the
 * reference tool: quality rows by their deterministic measurement, speed rows by a confidence interval of the speed
 * ratio measured in the same job.
 */

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

/**
 * Cases `--quick` measures per family, for the per-push quality gate; `null` measures every case of the family. The
 * subsets reach every target format and every encoder path once (tests/bench-quick-subset.test.ts keeps it so). Image: a
 * photographic JPEG to WebP, a lossless photographic PNG to AVIF (4:2:0, the hardest AVIF input), graphics to AVIF at
 * 4:4:4 and grey line art to AVIF at 4:0:0, and a graphic source to JPEG. Audio: both sources with one lossy and the
 * lossless target. Video: two of the three codecs (HEVC differs only in the encoder binary). Compression, OCR, PDF
 * operations, document, data, ebook and font: every case, which are seconds each. The nightly run measures all of them.
 * These lists name the cases of the generated corpus (bench/corpus/); QUICK_PUBLIC_SUBSET names those of the public sets.
 */
export const QUICK_SUBSET: Readonly<Record<string, readonly string[] | null>> = {
  image: ['photo-a.jpg->webp', 'photo-b.png->avif', 'screenshot.png->avif', 'lineart.png->avif', 'lineart.png->jpg', 'lineart.png->webp'],
  video: ['clip.mp4->h264', 'clip.mp4->vp9'],
  audio: ['music.wav->opus', 'speech.wav->aac', 'music.wav->flac'],
  ocr: null,
  document: null,
  compression: null,
  'pdf-ops': null,
  data: null,
  ebook: null,
  font: null,
};

/**
 * The cases of the public sample sets (bench/corpus/remote-manifest.json) that `--quick` measures: a few samples of each
 * content class on the targets the pull request gate must not leave unmeasured. The per-class rows (`class-<class>-><target>`)
 * average every sample of a class and are therefore nightly-only. A family absent here measures none of them quickly.
 */
export const QUICK_PUBLIC_SUBSET: Readonly<Record<string, readonly string[]>> = {
  image: ['kodim23.png->avif', 'kodim03.png->webp', 'wm-screen-history.png->avif', 'wm-screen-history.png->webp', 'wm-lineart-family-tree.png->jpg', 'wm-alpha-graph.png->webp', 'wm-deep-xray.png->webp', 'clic-paul-itkin-46101.png->avif'],
  video: ['aom-fourpeople-270p.y4m->h264', 'aom-touchdown-360p.y4m->vp9', 'aom-debugging-1080p.y4m->h264'],
  audio: ['sqam-49-speech-en-f.flac->aac', 'sqam-27-castanets.flac->opus', 'sqam-65-orchestra-strauss.flac->flac', 'pteraxys-part1.flac->opus', 'edge-surround-5.1.wav->opus'],
  compression: [
    ...['tar->zst', 'tar->7z', 'tar->zip', 'tar->gz', 'tar->tar.bz2', 'zst->tar', 'xz->tar', '7z->tar', 'zip->tar', 'gz->tar', 'bz2->tar', 'rar->tar'].map((pair) => `silesia-xml.${pair}`),
    ...['tar->zst', 'tar->7z', 'tar->zip'].map((pair) => `wm-tmax100-grain.jpg.${pair}`),
  ],
};

/**
 * Public samples whose throughput rows the nightly run measures, per family. Quality is measured on every sample; speed
 * depends on the code path and the size of the input more than on the picture, so a few samples of each class stand for the
 * rest, which keeps the timing job inside its budget. A pull request measures none of them (BENCH_CORPUS_TIER=pr).
 */
export const PUBLIC_SPEED_SAMPLES: Readonly<Record<string, readonly string[]>> = {
  image: ['kodim23.png', 'clic-paul-itkin-46101.png', 'wm-screen-history.png', 'wm-lineart-family-tree.png', 'wm-alpha-graph.png', 'wm-deep-dart.png'],
  video: ['aom-fourpeople-270p.y4m', 'aom-touchdown-360p.y4m', 'aom-debugging-1080p.y4m'],
  audio: ['sqam-49-speech-en-f.flac', 'sqam-27-castanets.flac', 'sqam-65-orchestra-strauss.flac', 'pteraxys-part1.flac', 'edge-surround-5.1.wav'],
  compression: ['silesia-xml', 'silesia-ooffice'],
};

/**
 * Which public samples a run without `--quick` measures. `full` (the default, the nightly run and a local run) measures all of
 * them. `pr` measures none: the pull request speed jobs time the generated corpus only, because their paired sequential
 * sampling over every public sample would multiply the wall-clock time of a pull request.
 */
export const CORPUS_TIER_ENV = 'BENCH_CORPUS_TIER';
