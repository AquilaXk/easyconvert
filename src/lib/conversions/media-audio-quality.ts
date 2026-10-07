import { execFileSync } from 'node:child_process';
import {
  AudioDither,
  AudioResampler,
  ConversionFailedError,
  EngineUnavailableError,
  InvalidMediaOptionError,
  LoudnessOptions,
  LoudnessPreset,
} from '../types';

/**
 * Audio quality controls for the ffmpeg transcode: EBU R128 loudness normalisation (ITU-R BS.1770-4
 * measurement, two passes), the high-precision soxr resampler and dither for 16-bit output. Everything
 * here is a pure function of the options, the probed measurement or the ffmpeg build's feature list.
 */

export interface LoudnessTarget {
  /** Integrated loudness in LUFS. */
  integrated: number;
  /** Maximum true peak in dBTP. */
  truePeak: number;
  /** Loudness range in LU. */
  lra: number;
}

/** EBU R128 broadcast target (EBU R 128 s1): -23 LUFS, true peak -1 dBTP, loudness range 7 LU. */
export const LOUDNORM_DEFAULTS: Readonly<LoudnessTarget> = { integrated: -23, truePeak: -1, lra: 7 };

/**
 * Named targets. `ebu-r128` is the default; the streaming and podcast values are the integrated levels
 * the common distribution platforms normalise to, with a -1 dBTP ceiling (-1.5 for the podcast level).
 */
export const LOUDNESS_PRESETS: Readonly<Record<LoudnessPreset, LoudnessTarget>> = {
  'ebu-r128': LOUDNORM_DEFAULTS,
  streaming: { integrated: -14, truePeak: -1, lra: 11 },
  podcast: { integrated: -16, truePeak: -1.5, lra: 11 },
};

export const LOUDNESS_INTEGRATED_RANGE_LUFS = { min: -70, max: -5 } as const;
export const LOUDNESS_TRUE_PEAK_RANGE_DBTP = { min: -9, max: 0 } as const;
export const LOUDNESS_LRA_RANGE_LU = { min: 1, max: 50 } as const;

function assertInRange(name: string, value: unknown, range: { min: number; max: number }, unit: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < range.min || value > range.max) {
    throw new InvalidMediaOptionError(`Invalid loudness ${name}: ${String(value)}. Allowed: ${range.min} to ${range.max} ${unit}.`);
  }
  return value;
}

/** The loudness target a request names: a preset (default `ebu-r128`), each value overridable and range-checked. */
export function resolveLoudnessTarget(options: LoudnessOptions): LoudnessTarget {
  const presetName = options.preset ?? 'ebu-r128';
  if (!Object.hasOwn(LOUDNESS_PRESETS, presetName)) {
    throw new InvalidMediaOptionError(`Unknown loudness preset "${String(presetName)}". Allowed: ${Object.keys(LOUDNESS_PRESETS).join(', ')}.`);
  }
  const preset = LOUDNESS_PRESETS[presetName];
  return {
    integrated: assertInRange('integrated', options.integrated ?? preset.integrated, LOUDNESS_INTEGRATED_RANGE_LUFS, 'LUFS'),
    truePeak: assertInRange('truePeak', options.truePeak ?? preset.truePeak, LOUDNESS_TRUE_PEAK_RANGE_DBTP, 'dBTP'),
    lra: assertInRange('lra', options.lra ?? preset.lra, LOUDNESS_LRA_RANGE_LU, 'LU'),
  };
}

/** What the measuring pass of the loudnorm filter reported about the input. */
export interface LoudnessMeasurement {
  inputI: number;
  inputTp: number;
  inputLra: number;
  inputThresh: number;
  targetOffset: number;
  /** Sample rate of the measured stream; loudnorm resamples to 192 kHz internally, so the output is pinned back to it. */
  sampleRate: number;
}

/** Raised when the measuring pass printed no usable result (silence, a failed run, a changed report format). */
export class LoudnessMeasurementError extends ConversionFailedError {
  constructor(message: string) {
    super(message);
    this.name = 'LoudnessMeasurementError';
  }
}

const MEASUREMENT_KEYS = ['input_i', 'input_tp', 'input_lra', 'input_thresh', 'target_offset'] as const;
type MeasurementKey = (typeof MEASUREMENT_KEYS)[number];
/** The loudnorm report is a flat JSON object; this bounds the text the parser looks at to its tail. */
const MAX_REPORT_SCAN_CHARS = 64 * 1024;
const REPORT_PATTERN = /\{[^{}]*"input_i"[^{}]*\}/g;

/**
 * Reads the JSON report loudnorm prints to stderr when run with `print_format=json`. Every key must be
 * present and numeric: a missing key, `-inf` (digital silence) or text that is not JSON throws
 * LoudnessMeasurementError instead of normalising with invented numbers.
 */
export function parseLoudnormMeasurement(stderr: string, sampleRate: number): LoudnessMeasurement {
  const tail = stderr.length > MAX_REPORT_SCAN_CHARS ? stderr.slice(-MAX_REPORT_SCAN_CHARS) : stderr;
  const blocks = tail.match(REPORT_PATTERN);
  if (!blocks) {
    throw new LoudnessMeasurementError('The loudness measuring pass printed no report.');
  }
  let report: Partial<Record<MeasurementKey, unknown>>;
  try {
    report = JSON.parse(blocks[blocks.length - 1]) as Partial<Record<MeasurementKey, unknown>>;
  } catch {
    throw new LoudnessMeasurementError('The loudness measuring pass printed a report that is not valid JSON.');
  }
  const read = (key: MeasurementKey): number => {
    const raw = report[key];
    const value = typeof raw === 'string' ? Number(raw) : Number.NaN;
    if (!Number.isFinite(value)) {
      throw new LoudnessMeasurementError(
        `The loudness report has no usable ${key} (${String(raw)}); the input may be silent or too short to measure.`
      );
    }
    return value;
  };
  return {
    inputI: read('input_i'),
    inputTp: read('input_tp'),
    inputLra: read('input_lra'),
    inputThresh: read('input_thresh'),
    targetOffset: read('target_offset'),
    sampleRate,
  };
}

/** Measuring pass: loudnorm at the target, reporting the input's loudness as JSON on stderr. */
export function loudnormMeasureFilter(target: LoudnessTarget): string {
  return `loudnorm=I=${target.integrated}:TP=${target.truePeak}:LRA=${target.lra}:print_format=json`;
}

/**
 * Applying pass: linear normalisation from the measured values. In linear mode loudnorm applies one gain
 * and leaves the dynamics alone; it falls back to dynamic mode only when that gain would breach the ceiling.
 */
export function loudnormApplyFilter(target: LoudnessTarget, measured: LoudnessMeasurement): string {
  return (
    `loudnorm=I=${target.integrated}:TP=${target.truePeak}:LRA=${target.lra}` +
    `:measured_I=${measured.inputI}:measured_TP=${measured.inputTp}:measured_LRA=${measured.inputLra}` +
    `:measured_thresh=${measured.inputThresh}:offset=${measured.targetOffset}:linear=true:print_format=summary`
  );
}

/** Soxr at its highest precision (28 bits); the default swresample filter is used when the build has no soxr. */
export const SOXR_PRECISION_BITS = 28;
const SOXR_FEATURE_FLAG = '--enable-libsoxr';
const FFMPEG_VERSION_TIMEOUT_MS = 3000;
const soxrCache = new Map<string, boolean>();

/** True when the ffmpeg build was configured with libsoxr. The probe runs once per binary. */
export function ffmpegHasSoxr(ffmpegBin: string): boolean {
  const cached = soxrCache.get(ffmpegBin);
  if (cached !== undefined) return cached;
  let present = false;
  try {
    const out = execFileSync(ffmpegBin, ['-hide_banner', '-version'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: FFMPEG_VERSION_TIMEOUT_MS,
    });
    present = out.includes(SOXR_FEATURE_FLAG);
  } catch {
    present = false;
  }
  soxrCache.set(ffmpegBin, present);
  return present;
}

export interface ResamplerChoice {
  resampler: AudioResampler;
  /** Why the request could not be met, when `resampler` is not the one asked for or the default. */
  fallbackReason?: string;
}

const RESAMPLERS: ReadonlySet<string> = new Set<AudioResampler>(['soxr', 'swr']);

/**
 * Picks the resampler. Unset means soxr when the build has it, otherwise the default swresample with the
 * reason reported; an explicit `soxr` on a build without it is an EngineUnavailableError, never a silent swap.
 */
export function chooseResampler(requested: AudioResampler | undefined, ffmpegBin?: string | null): ResamplerChoice {
  if (requested !== undefined && !RESAMPLERS.has(requested)) {
    throw new InvalidMediaOptionError(`Invalid audio resampler "${String(requested)}". Allowed: soxr, swr.`);
  }
  if (requested === 'swr') return { resampler: 'swr' };
  // Without a binary to ask (argument-only callers) an explicit request is trusted; the default stays swresample.
  const available = ffmpegBin ? ffmpegHasSoxr(ffmpegBin) : requested === 'soxr';
  if (available) return { resampler: 'soxr' };
  if (requested === 'soxr') {
    throw new EngineUnavailableError('ffmpeg', 'this build has no libsoxr, so the soxr resampler cannot be used');
  }
  return { resampler: 'swr', fallbackReason: 'this ffmpeg build has no libsoxr; the default swresample resampler was used' };
}

/** `aresample` filter for a rate change with the chosen resampler. */
export function resampleFilter(rate: number, choice: ResamplerChoice, dither?: string): string {
  const parts = [`aresample=${rate}`];
  if (choice.resampler === 'soxr') parts.push('resampler=soxr', `precision=${SOXR_PRECISION_BITS}`);
  if (dither) parts.push(`dither_method=${dither}`);
  return parts.join(':');
}

/** Dither methods swresample offers for the reduction to 16 bits; `none` rounds. */
export const DITHER_METHODS: ReadonlySet<string> = new Set<AudioDither>(['none', 'rectangular', 'triangular', 'triangular_hp']);
/** Triangular (TPDF) dither with a high-pass shaped spectrum: the default for 16-bit output. */
export const DEFAULT_DITHER: AudioDither = 'triangular_hp';
/** Output codecs that write 16-bit samples, where a float or deeper source is reduced to 16 bits. */
export const SIXTEEN_BIT_CODECS: ReadonlySet<string> = new Set(['pcm_s16le']);

export function resolveDither(requested: AudioDither | undefined, codec: string): AudioDither | undefined {
  if (requested !== undefined && !DITHER_METHODS.has(requested)) {
    throw new InvalidMediaOptionError(`Invalid dither "${String(requested)}". Allowed: ${[...DITHER_METHODS].join(', ')}.`);
  }
  if (!SIXTEEN_BIT_CODECS.has(codec)) {
    if (requested !== undefined) {
      throw new InvalidMediaOptionError(`Dither applies to 16-bit PCM output only; the '${codec}' encoder writes another sample format.`);
    }
    return undefined;
  }
  return requested ?? DEFAULT_DITHER;
}
