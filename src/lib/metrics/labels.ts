/**
 * The values a metric label may take. Every label of every metric is one of these closed lists, so a metric has a bounded
 * number of series whatever the traffic is: a file name, a user, a job or a request never becomes a label value. A value that
 * is not on its list is recorded as the list's fallback.
 */

/** The convert routes that count their answers (the `route` names `loggingOutcomes` gets). */
export const REQUEST_ROUTES = ['convert', 'convert/batch', 'v1/convert'] as const;
export type RequestRoute = (typeof REQUEST_ROUTES)[number] | 'other';

/** How a request or a job ended: it did the work, it was turned away (a 4xx), it failed (a 5xx) or it ran past its deadline. */
export const OUTCOMES = ['ok', 'refused', 'failed', 'timed_out'] as const;
export type Outcome = (typeof OUTCOMES)[number];

/** The families are the categories of the format registry (`FormatCategory`), taken from the source format; `unknown` when it is not known. */
export const FAMILIES = [
  'image',
  'document',
  'archive',
  'video',
  'audio',
  'ebook',
  'spreadsheet',
  'presentation',
  'data',
  'vector',
  'font',
  'cad',
  'unknown',
] as const;
export type Family = (typeof FAMILIES)[number];

/** The queues of the engine (`easyconvert-jobs` and one per resource class). */
export const QUEUE_NAMES = ['default', 'light', 'cpu', 'memory', 'gpu'] as const;
export type QueueName = (typeof QUEUE_NAMES)[number];

/** The states of a queue that the depth metric reports; completed and failed jobs are history, not depth. */
export const QUEUE_DEPTH_STATES = ['waiting', 'active', 'delayed'] as const;
export type QueueDepthState = (typeof QUEUE_DEPTH_STATES)[number];

/** Why a sandboxed program was not started: the operating system refused the start, or the host cannot confine the program. */
export const SPAWN_FAILURE_REASONS = ['spawn_error', 'sandbox_unavailable'] as const;
export type SpawnFailureReason = (typeof SPAWN_FAILURE_REASONS)[number];

const HTTP_BAD_REQUEST = 400;
const HTTP_SERVER_ERROR = 500;
const HTTP_GATEWAY_TIMEOUT = 504;

/** `value` when it is on `list`, else `fallback`. */
export function onList<const Item extends string>(list: readonly Item[], value: unknown, fallback: Item): Item {
  return list.find((item) => item === value) ?? fallback;
}

/** The outcome an HTTP status stands for. A 499 (the client left) is a refusal: no fault of the service. */
export function outcomeOfStatus(status: number): Outcome {
  if (status < HTTP_BAD_REQUEST) return 'ok';
  if (status === HTTP_GATEWAY_TIMEOUT) return 'timed_out';
  return status < HTTP_SERVER_ERROR ? 'refused' : 'failed';
}
