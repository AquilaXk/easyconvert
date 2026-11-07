import { randomUUID } from 'node:crypto';
import type { NextRequest } from 'next/server';
import { PROTECT_PASSWORD_KEYS } from '../queue/option-secrets';
import { HTTP_TOO_MANY_REQUESTS, problemNameOfType } from '../refusal-codes';
import { escapeRegExp } from '../security/redact';
import type { ConversionOptions } from '../types';

/**
 * One server log line for each refusal (4xx) and failure (5xx) of a convert route: the status, the refusal code, the source and
 * target formats, the input size, the duration and a request id. When an error decided the answer the line names its class; for
 * a failure it also holds the error's message and top frames, cut short, so that a 500 the edge logs can be traced to its cause
 * from this line alone. A refusal is named by its code and class only: the message of an engine can quote the file. The file
 * name and the passwords of the options are cut out of what the line quotes, and a format is named only as the registry names it.
 *
 * The line is the record of the answer: a route does not log the error it answers with a 500 itself. The route wrappers that
 * turn a request away before the handler (a body declared too large, a full disk) run outside the log, and a 401 or 429 that no
 * error decided (no credentials, the rate limit, the concurrency limit, the daily allowance) leaves no line, because the edge
 * already counts them and a flood of them would fill the log.
 */

/** What a route learned about a request by the time it answered; the route fills it in as it reads the request. */
export interface ConversionTrace {
  readonly requestId: string;
  source?: string;
  target?: string;
  bytes?: number;
  /** The error that decided the answer. */
  cause?: unknown;
  /** The text of the request an error message might repeat; built from the file name and the options only when the line of a failure is written. */
  privateText?: () => string[];
  /** Keeps the names of the uploaded files and the options as received for `privateText`. */
  keepPrivate(fileNames: string | readonly string[], options: ConversionOptions): void;
}

interface ConversionOutcome {
  requestId: string;
  status: number;
  code?: string;
  source?: string;
  target?: string;
  bytes?: number;
  durationMs: number;
  error?: { class: string; message?: string; frames?: string[] };
}

const HTTP_BAD_REQUEST = 400;
const HTTP_UNAUTHORIZED = 401;
const HTTP_INTERNAL_SERVER_ERROR = 500;

/** Statuses of an answer that sheds load, unless an error decided it. */
const SHED_STATUSES: ReadonlySet<number> = new Set([HTTP_UNAUTHORIZED, HTTP_TOO_MANY_REQUESTS]);

const MAX_MESSAGE_CHARS = 300;
const MAX_STACK_FRAMES = 6;
const MAX_FRAME_CHARS = 200;
const REDACTED = '[redacted]';
/** A secret shorter than this is cut only where it stands apart from letters and digits, so that it does not cut words. */
const MIN_FREE_SECRET_CHARS = 3;
const WORD_CHARACTER = '[\\p{L}\\p{M}\\p{N}]';
const PATH_SEPARATORS = /[\\/]/;
const EXTENSION = /\.[^.]+$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The passwords of the options: the open password, the passwords of a merge, and the passwords a PDF is protected with. */
function passwordsOf(options: ConversionOptions): unknown[] {
  const { password, passwords, protect } = options;
  const protectHolders = [options, protect].filter(isRecord);
  return [password, ...(Array.isArray(passwords) ? passwords : []), ...protectHolders.flatMap((holder) => PROTECT_PASSWORD_KEYS.map((key) => holder[key]))];
}

/**
 * The text of a request that an error message might repeat: the file name, its leaf after the last `/` or `\\`, the leaf
 * without its extension, and the passwords of the options, each as received and composed (NFC), and percent-encoded in both
 * forms. A message is composed before it is read, but a percent-encoded name is not, so an encoded name sent decomposed
 * is cut only by the encoding of the decomposed form.
 */
function privateTextOf(fileNames: readonly string[], options: ConversionOptions): string[] {
  const names = fileNames.flatMap((fileName) => {
    const leaf = fileName.split(PATH_SEPARATORS).pop() ?? fileName;
    return [fileName, leaf, leaf.replace(EXTENSION, '')];
  });
  const received = [...names, ...passwordsOf(options)].filter(
    (text): text is string => typeof text === 'string' && text.length > 0
  );
  const forms = new Set(received.flatMap((text) => [text, text.normalize('NFC')]));
  return [...new Set([...forms].flatMap((text) => (text.isWellFormed() ? [text, encodeURIComponent(text)] : [text])))];
}

/** One pattern for every secret, longest first, so that a name is cut whole before its stem and each text is read once. */
function secretPattern(privateText: readonly string[]): RegExp | undefined {
  if (privateText.length === 0) return undefined;
  const alternatives = [...privateText]
    .sort((a, b) => b.length - a.length)
    .map((secret) => {
      const literal = escapeRegExp(secret);
      return [...secret].length < MIN_FREE_SECRET_CHARS ? `(?<!${WORD_CHARACTER})${literal}(?!${WORD_CHARACTER})` : literal;
    });
  return new RegExp(alternatives.join('|'), 'gu');
}

function sanitized(text: string, secrets: RegExp | undefined, maxChars: number): string {
  const composed = text.normalize('NFC');
  return (secrets ? composed.replace(secrets, REDACTED) : composed).slice(0, maxChars);
}

/** The error of an answer: its class, and for a failure of the server its message and top frames with the secrets cut out. */
function describeCause(trace: ConversionTrace, status: number): ConversionOutcome['error'] {
  const { cause } = trace;
  if (!(cause instanceof Error)) return { class: typeof cause };
  if (status < HTTP_INTERNAL_SERVER_ERROR) return { class: cause.name };
  const secrets = secretPattern(trace.privateText?.() ?? []);
  const frames = (cause.stack ?? '')
    .split('\n')
    .filter((line) => line.trimStart().startsWith('at '))
    .slice(0, MAX_STACK_FRAMES)
    .map((frame) => sanitized(frame.trim(), secrets, MAX_FRAME_CHARS));
  return { class: cause.name, message: sanitized(cause.message, secrets, MAX_MESSAGE_CHARS), frames };
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

async function writeOutcome(route: string, trace: ConversionTrace, status: number, response: Response | undefined, startedAt: number): Promise<void> {
  if (trace.cause === undefined && SHED_STATUSES.has(status)) return;
  const code = response ? await codeOf(response) : undefined;
  const outcome: ConversionOutcome = {
    requestId: trace.requestId,
    status,
    code,
    source: trace.source,
    target: trace.target,
    bytes: trace.bytes,
    durationMs: Date.now() - startedAt,
    error: trace.cause === undefined ? undefined : describeCause(trace, status),
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

function newTrace(): ConversionTrace {
  const trace: ConversionTrace = {
    requestId: randomUUID(),
    keepPrivate(fileNames, options) {
      const names = typeof fileNames === 'string' ? [fileNames] : fileNames;
      trace.privateText = () => privateTextOf(names, options);
    },
  };
  return trace;
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
    const trace = newTrace();
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
