/**
 * The job's remaining time, as the converters see it. The queue and the synchronous routes give a conversion
 * a signal (it fires at the job deadline and kills child process groups) and the absolute deadline under
 * `JOB_DEADLINE_AT`. The deadline is never a per-stage `timeoutMs`: every stage keeps its own limit and is
 * clamped to the time the job has left, `min(stage limit, remaining)`.
 *
 * `JOB_DEADLINE_AT` is a symbol, so it cannot come out of request JSON (as for the tier page cap). The string
 * keys `signal`, `timeoutMs` and `deadline*` are engine control options that only server code may set:
 * `bindJobLimits` removes them from request options and installs the job's own.
 */

export const JOB_DEADLINE_AT = Symbol.for('easyconvert.jobDeadlineAt');

/** Length of the job's deadline in milliseconds, for the timeout error of a stage that finds the deadline passed. */
export const JOB_TIMEOUT_MS = Symbol.for('easyconvert.jobTimeoutMs');

export interface JobDeadlined {
  [JOB_DEADLINE_AT]?: number;
  [JOB_TIMEOUT_MS]?: number;
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

/** Length of the job's deadline, or undefined when the conversion has none or was not told its length. */
export function jobTimeoutMs(options: object | undefined): number | undefined {
  const timeoutMs = (options as JobDeadlined | undefined)?.[JOB_TIMEOUT_MS];
  return typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) ? timeoutMs : undefined;
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

/** Request options without the engine control keys (`signal`, `timeoutMs`, `deadline*`); the input is not changed. */
export function stripEngineControls<T extends object>(options: T): T {
  const kept: Record<PropertyKey, unknown> = {};
  for (const key of Reflect.ownKeys(options)) {
    if (typeof key === 'string' && isControlKey(key)) continue;
    kept[key] = (options as Record<PropertyKey, unknown>)[key];
  }
  return kept as T;
}

/**
 * Options for one conversion of a job: request options with every engine control key removed, the job's signal
 * (combined with a genuine `AbortSignal` the server code passed in, never with a lookalike from JSON) and the
 * job's absolute deadline. Symbol-keyed server values such as the tier page cap are kept.
 */
export function bindJobLimits<T extends object>(
  options: T | undefined,
  limits: { signal: AbortSignal; deadlineAt?: number; timeoutMs?: number }
): T & JobDeadlined & { signal: AbortSignal } {
  const bound: Record<PropertyKey, unknown> = {};
  let ownSignal: AbortSignal | undefined;
  for (const key of Reflect.ownKeys(options ?? {})) {
    const value = (options as Record<PropertyKey, unknown>)[key];
    if (typeof key === 'string' && isControlKey(key)) {
      if (key === SIGNAL_KEY && value instanceof AbortSignal) ownSignal = value;
      continue;
    }
    bound[key] = value;
  }
  bound[SIGNAL_KEY] = ownSignal && ownSignal !== limits.signal ? AbortSignal.any([ownSignal, limits.signal]) : limits.signal;
  if (limits.deadlineAt !== undefined) bound[JOB_DEADLINE_AT] = limits.deadlineAt;
  if (limits.timeoutMs !== undefined) bound[JOB_TIMEOUT_MS] = limits.timeoutMs;
  return bound as T & JobDeadlined & { signal: AbortSignal };
}
