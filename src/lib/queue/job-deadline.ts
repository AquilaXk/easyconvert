import { tierMaxPages } from '../conversions/page-range';
import { bindJobLimits } from '../conversions/job-time';
import { getFormatByExtension } from '../registry';
import type { ConversionOptions } from '../types';
import type { ConversionEnginePort } from './engine-port';

/**
 * The wall-clock limit of a conversion job. One pure function, `jobDeadlineMs`, is the single source of every
 * deadline: the queue's job timeout, the `timeoutMs` the converter receives, and the limit of the synchronous
 * routes. A deadline is the base of the owner's tier plus an allowance for the work (pages, media seconds, MiB of
 * input), never above the tier's maximum. Every number is a documented setting (`JOB_DEADLINE_*`, see
 * docs/configuration.md).
 *
 * Work whose size is not known when the job is queued (a graph node, a stored input without a size) gets the
 * maximum of the tier: bounded, never unbounded.
 */

export type JobDeadlineFamily = 'pages' | 'media' | 'bytes';

export interface JobDeadlineInput {
  /** The owner's tier; an unknown or missing tier is the free tier, as for the page limit. */
  tier?: string;
  /** What the work is counted in: `pages` for documents, `media` for audio and video, `bytes` for the rest. */
  family: JobDeadlineFamily;
  /** Size of the input in bytes; missing means unknown, which gives the maximum of the tier. */
  inputBytes?: number;
  /** Pages of a document; missing means the page limit of the tier. */
  pages?: number;
  /** Length of an audio or video input in seconds. */
  mediaSeconds?: number;
}

export interface JobDeadlineSettings {
  baseMs: Record<string, number>;
  maxMs: Record<string, number>;
  perPageMs: number;
  perMibMs: number;
  perMediaSecondMs: number;
  /** Most a synchronous request may run; longer conversions belong on the asynchronous API. */
  syncMaxMs: number;
}

/** Environment variable of each setting. */
export const JOB_DEADLINE_ENV = {
  BASE_FREE: 'JOB_DEADLINE_BASE_MS_FREE',
  BASE_PRO: 'JOB_DEADLINE_BASE_MS_PRO',
  BASE_ENTERPRISE: 'JOB_DEADLINE_BASE_MS_ENTERPRISE',
  MAX_FREE: 'JOB_DEADLINE_MAX_MS_FREE',
  MAX_PRO: 'JOB_DEADLINE_MAX_MS_PRO',
  MAX_ENTERPRISE: 'JOB_DEADLINE_MAX_MS_ENTERPRISE',
  PER_PAGE: 'JOB_DEADLINE_PER_PAGE_MS',
  PER_MIB: 'JOB_DEADLINE_PER_MIB_MS',
  PER_MEDIA_SECOND: 'JOB_DEADLINE_PER_MEDIA_SECOND_MS',
  SYNC_MAX: 'SYNC_DEADLINE_MAX_MS',
} as const;

/**
 * Defaults, from the real-world corpus (bench/realworld, nightly run on 16 518 jobs): the slowest job that ended
 * with a conversion or a typed refusal took 66.8 s on a parallel CI runner, the slowest per-page rate was 14.2 s
 * per page, and the rest of the corpus finished in under 42.7 s (99.9th percentile). A page is allowed 10 s, the
 * OCR page budget; media keeps the 3 s per second of the media engine's own formula (3 x duration + 60 s).
 */
export const JOB_DEADLINE_DEFAULTS: Record<keyof typeof JOB_DEADLINE_ENV, number> = {
  BASE_FREE: 60_000,
  BASE_PRO: 120_000,
  BASE_ENTERPRISE: 180_000,
  MAX_FREE: 300_000,
  MAX_PRO: 1_800_000,
  MAX_ENTERPRISE: 3_600_000,
  PER_PAGE: 10_000,
  PER_MIB: 2_000,
  PER_MEDIA_SECOND: 3_000,
  SYNC_MAX: 120_000,
};

const TIERS = ['free', 'pro', 'enterprise'] as const;
const FREE_TIER = 'free';
const BYTES_PER_MIB = 1024 * 1024;
const MAX_SETTING_DIGITS = 16;
const INT32_MAX = 2_147_483_647;
const SETTING_PATTERN = new RegExp(`^\\d{1,${MAX_SETTING_DIGITS}}$`);

type Env = Readonly<Record<string, string | undefined>>;

/**
 * A deadline setting or input is invalid. It is a server-side fault, so the routes answer a generic 500 and log
 * the detail: the message names a setting, which a client has no business reading.
 */
export class JobDeadlineError extends RangeError {
  constructor(message: string) {
    super(message);
    this.name = 'JobDeadlineError';
  }
}

/** A positive-integer setting of `env` (a blank value is unset); a set value that is not one is a JobDeadlineError. */
export function readIntegerSetting(env: Env, name: string, defaultValue: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return defaultValue;
  const text = raw.trim();
  const value = SETTING_PATTERN.test(text) ? Number(text) : Number.NaN;
  if (!Number.isSafeInteger(value) || value < 1 || value > INT32_MAX) {
    throw new JobDeadlineError(`${name} must be an integer from 1 to ${INT32_MAX}`);
  }
  return value;
}

function readSetting(env: Env, key: keyof typeof JOB_DEADLINE_ENV): number {
  return readIntegerSetting(env, JOB_DEADLINE_ENV[key], JOB_DEADLINE_DEFAULTS[key]);
}

/**
 * The deadline settings of `env`. A set value that is not an integer in range, or a base above the maximum of
 * its tier, is an error: a bad setting never falls back to a default.
 */
export function jobDeadlineSettings(env: Env = process.env): JobDeadlineSettings {
  const baseMs: Record<string, number> = {};
  const maxMs: Record<string, number> = {};
  for (const tier of TIERS) {
    const suffix = tier.toUpperCase() as 'FREE' | 'PRO' | 'ENTERPRISE';
    baseMs[tier] = readSetting(env, `BASE_${suffix}`);
    maxMs[tier] = readSetting(env, `MAX_${suffix}`);
    if (baseMs[tier] > maxMs[tier]) {
      throw new JobDeadlineError(
        `${JOB_DEADLINE_ENV[`BASE_${suffix}`]} (${baseMs[tier]}) must not exceed ${JOB_DEADLINE_ENV[`MAX_${suffix}`]} (${maxMs[tier]})`
      );
    }
  }
  return {
    baseMs,
    maxMs,
    perPageMs: readSetting(env, 'PER_PAGE'),
    perMibMs: readSetting(env, 'PER_MIB'),
    perMediaSecondMs: readSetting(env, 'PER_MEDIA_SECOND'),
    syncMaxMs: readSetting(env, 'SYNC_MAX'),
  };
}

let cachedSettings: { key: string; settings: JobDeadlineSettings } | undefined;

/**
 * The deadline settings of the process environment, resolved once: the result is reused until one of the
 * variables changes (which a running process never does outside tests), so no request re-parses them.
 */
export function currentJobDeadlineSettings(): JobDeadlineSettings {
  const key = Object.values(JOB_DEADLINE_ENV)
    .map((name) => process.env[name] ?? '')
    .join('\u0000');
  if (cachedSettings?.key !== key) cachedSettings = { key, settings: jobDeadlineSettings(process.env) };
  return cachedSettings.settings;
}

function knownTier(tier: string | undefined): string {
  const normalized = (tier ?? FREE_TIER).toLowerCase();
  return TIERS.includes(normalized as (typeof TIERS)[number]) ? normalized : FREE_TIER;
}

function requireNonNegativeNumber(value: number, label: string): void {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new JobDeadlineError(`${label} must be a finite number of at least 0, got ${String(value)}`);
  }
}

function requirePageCount(value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new JobDeadlineError(`pages must be an integer of at least 1, got ${String(value)}`);
  }
}

/** The maximum deadline of a tier in milliseconds. */
export function tierMaxDeadlineMs(tier: string | undefined, settings: JobDeadlineSettings = currentJobDeadlineSettings()): number {
  return settings.maxMs[knownTier(tier)];
}

/**
 * Wall-clock limit in milliseconds for one conversion job of `input`: the tier's base plus `perPageMs` per page
 * (the page limit of the tier when the count is unknown, and never more pages than that limit), `perMediaSecondMs`
 * per second of media, and `perMibMs` per started MiB of input, never above the tier's maximum. Work of unknown
 * size gets the maximum. Invalid quantities throw a RangeError.
 */
export function jobDeadlineMs(input: JobDeadlineInput, settings: JobDeadlineSettings = currentJobDeadlineSettings()): number {
  const tier = knownTier(input.tier);
  const max = settings.maxMs[tier];
  if (input.inputBytes !== undefined) requireNonNegativeNumber(input.inputBytes, 'inputBytes');
  if (input.mediaSeconds !== undefined) requireNonNegativeNumber(input.mediaSeconds, 'mediaSeconds');
  if (input.pages !== undefined) requirePageCount(input.pages);
  if (input.inputBytes === undefined) return max;

  let deadline = settings.baseMs[tier] + Math.ceil(input.inputBytes / BYTES_PER_MIB) * settings.perMibMs;
  if (input.family === 'pages') {
    const limit = tierMaxPages(tier);
    deadline += Math.min(input.pages ?? limit, limit) * settings.perPageMs;
  } else if (input.family === 'media' && input.mediaSeconds !== undefined) {
    deadline += Math.ceil(input.mediaSeconds) * settings.perMediaSecondMs;
  }
  return Math.min(deadline, max);
}

const PAGE_CATEGORIES: ReadonlySet<string> = new Set(['document', 'presentation', 'spreadsheet', 'ebook']);
const MEDIA_CATEGORIES: ReadonlySet<string> = new Set(['audio', 'video']);

function normalizeFormat(format: string): string {
  return (format || '').trim().toLowerCase().replace(/^\./, '');
}

/** What a conversion between the two formats is counted in: media on either side, a paged source, or bytes. */
export function jobDeadlineFamily(sourceFormat: string, targetFormat: string): JobDeadlineFamily {
  const source = getFormatByExtension(normalizeFormat(sourceFormat))?.category;
  const target = getFormatByExtension(normalizeFormat(targetFormat))?.category;
  if ((source && MEDIA_CATEGORIES.has(source)) || (target && MEDIA_CATEGORIES.has(target))) return 'media';
  if (source && PAGE_CATEGORIES.has(source)) return 'pages';
  return 'bytes';
}

export interface ConversionDeadlineInput {
  tier?: string;
  sourceFormat: string;
  targetFormat: string;
  /** Missing means unknown, which gives the maximum of the tier. */
  inputBytes?: number;
  pages?: number;
  mediaSeconds?: number;
  options?: ConversionOptions;
}

/** `jobDeadlineMs` for a conversion between two formats. */
export function conversionDeadlineMs(
  input: ConversionDeadlineInput,
  settings: JobDeadlineSettings = currentJobDeadlineSettings()
): number {
  return jobDeadlineMs(
    {
      tier: input.tier,
      family: jobDeadlineFamily(input.sourceFormat, input.targetFormat),
      inputBytes: input.inputBytes,
      pages: input.pages,
      mediaSeconds: input.mediaSeconds,
    },
    settings
  );
}

/** A synchronous request's deadline: the job deadline held to the synchronous cap (`SYNC_DEADLINE_MAX_MS`). */
export function syncDeadlineMs(deadlineMs: number, settings: JobDeadlineSettings = currentJobDeadlineSettings()): number {
  return Math.min(deadlineMs, settings.syncMaxMs);
}

/** What an engine wrapper needs of a queue job: its attempt signal and its time limits. */
export interface DeadlinedJob {
  signal: AbortSignal;
  opts?: { timeout?: number; deadlineAt?: number };
}

/**
 * An engine that runs every conversion of `job` under the job's deadline. The conversion gets the attempt's
 * signal (it fires at the deadline, so the sandbox kills child process groups) and the job's absolute deadline;
 * the engines keep their own stage limits, each clamped to the time the job has left. The deadline is never
 * passed as a `timeoutMs`, which the engines read as a per-stage override. `signal`, `timeoutMs` and `deadline*`
 * in the request options are dropped (job data comes from request bodies); only a genuine `AbortSignal` that
 * server code passed in is combined with the job's.
 */
export function jobDeadlineAt(job: DeadlinedJob): number | undefined {
  const timeoutMs = job.opts?.timeout;
  return job.opts?.deadlineAt ?? (timeoutMs === undefined ? undefined : Date.now() + timeoutMs);
}

export function deadlineBoundEngine(engine: ConversionEnginePort, job: DeadlinedJob): ConversionEnginePort {
  return {
    name: engine.name,
    convert: (input, sourceFormat, targetFormat, options, originalFilename) => {
      return engine.convert(
        input,
        sourceFormat,
        targetFormat,
        bindJobLimits(options, { signal: job.signal, deadlineAt: jobDeadlineAt(job), timeoutMs: job.opts?.timeout }),
        originalFilename
      );
    },
  };
}
