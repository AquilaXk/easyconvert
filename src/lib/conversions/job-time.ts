/**
 * The job's remaining time, as the converters see it. The queue and the synchronous routes give a conversion
 * a signal (it fires at the job deadline and kills child process groups) and the absolute deadline under
 * `JOB_DEADLINE_AT`. The deadline is never a per-stage `timeoutMs`: every stage keeps its own limit and is
 * clamped to the time the job has left, `min(stage limit, remaining)`.
 *
 * `JOB_DEADLINE_AT` is a symbol, so it cannot come out of request JSON (as for the other server-only values). The string
 * keys `signal`, `timeoutMs` and `deadline*` are engine control options that only server code may set:
 * `bindJobLimits` removes them from request options and installs the job's own.
 */

import { PLAN_PROCESSING_MINUTES } from '../plan-limits';

export const JOB_DEADLINE_AT = Symbol.for('easyconvert.jobDeadlineAt');

export interface JobDeadlined {
  [JOB_DEADLINE_AT]?: number;
}

const SIGNAL_KEY = 'signal';
const DEADLINE_KEY_PREFIX = 'deadline';
const TIMEOUT_KEY = 'timeoutMs';
/** A stage is never given less than this, so a deadline that is about to pass still yields a valid timer. */
const MIN_STAGE_MS = 1;

function isControlKey(key: string): boolean {
  return key === SIGNAL_KEY || key === TIMEOUT_KEY || key.toLowerCase().startsWith(DEADLINE_KEY_PREFIX);
}

/** Milliseconds left until the job deadline, or undefined when the conversion has none. Zero or less means it passed. */
export function remainingJobMs(options: object | undefined, now: number = Date.now()): number | undefined {
  const deadlineAt = (options as JobDeadlined | undefined)?.[JOB_DEADLINE_AT];
  return typeof deadlineAt === 'number' && Number.isFinite(deadlineAt) ? deadlineAt - now : undefined;
}

/** `limitMs` held to the time the job has left (at least one millisecond); unchanged when there is no deadline. */
export function clampToJobRemaining(options: object | undefined, limitMs: number, now: number = Date.now()): number {
  const remaining = remainingJobMs(options, now);
  return remaining === undefined ? limitMs : Math.max(MIN_STAGE_MS, Math.min(limitMs, remaining));
}

/**
 * The limit of one stage of a conversion: its own default, or the server-set `options.timeoutMs` override, held
 * to the time the job has left. With no job deadline it is exactly the stage default.
 */
export function stageTimeoutMs(options: ({ timeoutMs?: number } & JobDeadlined) | undefined, defaultMs: number, now: number = Date.now()): number {
  return clampToJobRemaining(options, options?.timeoutMs || defaultMs, now);
}

/**
 * The limit of a stage that works through the pages of one document, one process or one encode for each page. `defaultMs` and `maxMs`
 * are what a stage without pages would have (its default and its ceiling, see `stageTimeoutMs`) and still bound the time of one process
 * of the stage. The loop as a whole gets `perPageMs` for each page once that is more than `defaultMs`, up to `pagedMaxMs`.
 */
export interface PagedStage {
  defaultMs: number;
  maxMs: number;
  perPageMs: number;
  pagedMaxMs: number;
}

/**
 * The page-loop stages of PDF conversion (SVG, EPS and re-encoded raster pages). A page costs 113 ms on four cores and about 450 ms on
 * one for the AVIF encoder of a scanned page, the slowest step measured, so 2 s a page is more than four times what one core needs; the
 * ceiling is the longest job of any tier (`PLAN_PROCESSING_MINUTES.paid`), and the job's own deadline cuts the loop first.
 */
export const PAGE_LOOP_STAGE: PagedStage = {
  defaultMs: 45_000,
  maxMs: 120_000,
  perPageMs: 2_000,
  pagedMaxMs: PLAN_PROCESSING_MINUTES.paid * 60_000,
};

/**
 * The limit of a whole page loop over `pages` pages: the stage default, or `perPageMs` for each page when that is more, never above
 * `pagedMaxMs`, held to the time the job has left. A server-set `options.timeoutMs` is the limit as it is for every stage, under `maxMs`
 * and the job's time, whatever the pages. A page count that is not a positive number counts as one page.
 */
export function pagedStageTimeoutMs(
  options: ({ timeoutMs?: number } & JobDeadlined) | undefined,
  pages: number,
  stage: PagedStage,
  now: number = Date.now()
): number {
  if (options?.timeoutMs) return clampToJobRemaining(options, Math.min(options.timeoutMs, stage.maxMs), now);
  const counted = Number.isFinite(pages) && pages > 1 ? pages : 1;
  return clampToJobRemaining(options, Math.min(Math.max(stage.defaultMs, counted * stage.perPageMs), stage.pagedMaxMs), now);
}

/**
 * Sets `key` on `target` as an own data property. Plain assignment of a `__proto__` key (an own key of parsed JSON)
 * would instead set the prototype of the copy, and every key under it would be inherited unchecked.
 */
function defineOwn(target: object, key: PropertyKey, value: unknown): void {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}

/** Request options without the engine control keys (`signal`, `timeoutMs`, `deadline*`); the input is not changed. */
export function stripEngineControls<T extends object>(options: T): T {
  const kept = {};
  for (const key of Reflect.ownKeys(options)) {
    if (typeof key === 'string' && isControlKey(key)) continue;
    defineOwn(kept, key, (options as Record<PropertyKey, unknown>)[key]);
  }
  return kept as T;
}

/**
 * Options for one conversion of a job: request options with every engine control key removed, the job's signal
 * (combined with a genuine `AbortSignal` the server code passed in, never with a lookalike from JSON) and the
 * job's absolute deadline. Symbol-keyed server values are kept.
 */
export function bindJobLimits<T extends object>(
  options: T | undefined,
  limits: { signal: AbortSignal; deadlineAt?: number }
): T & JobDeadlined & { signal: AbortSignal } {
  const bound: Record<PropertyKey, unknown> = {};
  let ownSignal: AbortSignal | undefined;
  for (const key of Reflect.ownKeys(options ?? {})) {
    const value = (options as Record<PropertyKey, unknown>)[key];
    if (typeof key === 'string' && isControlKey(key)) {
      if (key === SIGNAL_KEY && value instanceof AbortSignal) ownSignal = value;
      continue;
    }
    defineOwn(bound, key, value);
  }
  bound[SIGNAL_KEY] = ownSignal && ownSignal !== limits.signal ? AbortSignal.any([ownSignal, limits.signal]) : limits.signal;
  if (limits.deadlineAt !== undefined) bound[JOB_DEADLINE_AT] = limits.deadlineAt;
  return bound as T & JobDeadlined & { signal: AbortSignal };
}
