import { randomUUID } from 'node:crypto';
import type { NextRequest } from 'next/server';
import { problemNameOfType } from '../refusal-codes';
import type { ConversionOptions } from '../types';

/**
 * One server log line for each refusal (4xx) and failure (5xx) of a convert route: the status, the refusal code, the source and
 * target formats, the input size, the duration, a request id, and for an answer decided by an error the class of that error with
 * a sanitized message and its top frames, so that a 400 or 500 the edge logs can be traced to its cause from this line alone. The
 * line holds nothing the client chose freely: the file name and the passwords are cut out of the message, and a format is named only
 * as the registry names it.
 *
 * The line is the record of the answer: a route does not log the error it answers with a 500 itself. Answers that shed load or
 * turn a caller away before any work (no credentials, a rate limit, a body declared too large, a full disk) leave no line, because
 * the edge already counts them and a flood of them would fill the log.
 */

/** What a route learned about a request by the time it answered; the route fills it in as it reads the request. */
export interface ConversionTrace {
  readonly requestId: string;
  source?: string;
  target?: string;
  bytes?: number;
  /** The error that decided the answer. */
  cause?: unknown;
  /** Text of the request that must not reach the log: the file name and the passwords. */
  privateText?: readonly string[];
}

interface ConversionOutcome {
  requestId: string;
  status: number;
  code?: string;
  source?: string;
  target?: string;
  bytes?: number;
  durationMs: number;
  error?: { class: string; message: string; frames: string[] };
}

const HTTP_BAD_REQUEST = 400;
const HTTP_UNAUTHORIZED = 401;
const HTTP_PAYLOAD_TOO_LARGE = 413;
const HTTP_TOO_MANY_REQUESTS = 429;
const HTTP_INTERNAL_SERVER_ERROR = 500;
const HTTP_SERVICE_UNAVAILABLE = 503;
const STORAGE_FULL_PROBLEM = 'storage-full';

/** Statuses of an answer that sheds load whatever its cause. */
const SHED_STATUSES: ReadonlySet<number> = new Set([HTTP_UNAUTHORIZED, HTTP_TOO_MANY_REQUESTS]);

const MAX_MESSAGE_CHARS = 300;
const MAX_STACK_FRAMES = 6;
const MAX_FRAME_CHARS = 200;
const REDACTED = '[redacted]';

/** The text of a request that an error message might repeat: the file name, its name without extension, and the passwords of the options. */
export function privateTextOf(fileName: string, options: ConversionOptions): string[] {
  const stem = fileName.replace(/\.[^/.]+$/, '');
  const { password, passwords } = options;
  const candidates: unknown[] = [fileName, stem, password, ...(Array.isArray(passwords) ? passwords : [])];
  return candidates.filter((text): text is string => typeof text === 'string' && text.length > 0);
}

function sanitized(text: string, privateText: readonly string[], maxChars: number): string {
  let clean = text;
  for (const secret of privateText) clean = clean.replaceAll(secret, REDACTED);
  return clean.slice(0, maxChars);
}

function describeCause(cause: unknown, privateText: readonly string[]): ConversionOutcome['error'] {
  if (!(cause instanceof Error)) return { class: typeof cause, message: '', frames: [] };
  const frames = (cause.stack ?? '')
    .split('\n')
    .filter((line) => line.trimStart().startsWith('at '))
    .slice(0, MAX_STACK_FRAMES)
    .map((frame) => sanitized(frame.trim(), privateText, MAX_FRAME_CHARS));
  return { class: cause.name, message: sanitized(cause.message, privateText, MAX_MESSAGE_CHARS), frames };
}

/** The refusal code of an answer: its `code`, or the name of its problem type. */
async function codeOf(response: Response): Promise<string | undefined> {
  if (!(response.headers.get('content-type') ?? '').includes('json')) return undefined;
  const body: unknown = await response
    .clone()
    .json()
    .catch(() => undefined);
  if (typeof body !== 'object' || body === null) return undefined;
  const { code, type } = body as { code?: unknown; type?: unknown };
  if (typeof code === 'string') return code;
  return typeof type === 'string' ? problemNameOfType(type) : undefined;
}

/** Whether an answer of `status` turned the caller away before the route read the request or did any work. */
function isShed(status: number, code: string | undefined, trace: ConversionTrace): boolean {
  if (status === HTTP_PAYLOAD_TOO_LARGE) return trace.bytes === undefined;
  return status === HTTP_SERVICE_UNAVAILABLE && code === STORAGE_FULL_PROBLEM;
}

async function writeOutcome(route: string, trace: ConversionTrace, status: number, response: Response | undefined, startedAt: number): Promise<void> {
  if (SHED_STATUSES.has(status)) return;
  const code = response ? await codeOf(response) : undefined;
  if (isShed(status, code, trace)) return;
  const outcome: ConversionOutcome = {
    requestId: trace.requestId,
    status,
    code,
    source: trace.source,
    target: trace.target,
    bytes: trace.bytes,
    durationMs: Date.now() - startedAt,
    error: trace.cause === undefined ? undefined : describeCause(trace.cause, trace.privateText ?? []),
  };
  if (status >= HTTP_INTERNAL_SERVER_ERROR) console.error(`[${route}] failure ${JSON.stringify(outcome)}`);
  else console.warn(`[${route}] refusal ${JSON.stringify(outcome)}`);
}

/** Writes the line of an answer; a log that cannot be written never changes the answer. */
async function logOutcome(route: string, trace: ConversionTrace, status: number, response: Response | undefined, startedAt: number): Promise<void> {
  try {
    await writeOutcome(route, trace, status, response, startedAt);
  } catch (logFailure) {
    console.error(`[${route}] outcome line not written: ${logFailure instanceof Error ? logFailure.name : typeof logFailure}`);
  }
}

/**
 * Wraps a convert route so that each answer of 400 or more is logged once, with what the route put in its trace. An error the
 * route lets escape is logged as a 500 and thrown again for the framework to answer.
 */
export function loggingOutcomes<Result extends Response>(
  route: string,
  handler: (req: NextRequest, trace: ConversionTrace) => Promise<Result>
): (req: NextRequest) => Promise<Result> {
  return async (req) => {
    const startedAt = Date.now();
    const trace: ConversionTrace = { requestId: randomUUID() };
    let response: Result;
    try {
      response = await handler(req, trace);
    } catch (escaped) {
      trace.cause = escaped;
      await logOutcome(route, trace, HTTP_INTERNAL_SERVER_ERROR, undefined, startedAt);
      throw escaped;
    }
    if (response.status >= HTTP_BAD_REQUEST) await logOutcome(route, trace, response.status, response, startedAt);
    return response;
  };
}
