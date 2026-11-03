import { randomUUID } from 'node:crypto';
import type { NextRequest } from 'next/server';
import { PROBLEM_TYPE_BASE } from '../refusal-codes';
import { FORMAT_REGISTRY } from '../registry';

/**
 * One server log line for each refusal (4xx) and failure (5xx) of a convert route: the status, the refusal code, the source and
 * target formats, the input size, the duration and a request id, so that a 400 or 500 the edge logs can be traced to its cause. The
 * line holds nothing the client chose freely: no file name, no options, no password, and a format only when it is one of the registry.
 */

/** What a route learned about a request by the time it answered; the route fills it in as it reads the request. */
export interface ConversionTrace {
  source?: string;
  target?: string;
  bytes?: number;
}

interface ConversionOutcome extends ConversionTrace {
  requestId: string;
  status: number;
  code?: string;
  durationMs: number;
}

const HTTP_BAD_REQUEST = 400;
const HTTP_INTERNAL_SERVER_ERROR = 500;

/** The format as the registry names it, or undefined for anything else a client sent. */
export function registryFormat(format: string | null | undefined): string | undefined {
  const name = format?.toLowerCase().replace(/^\./, '').trim();
  return name && Object.hasOwn(FORMAT_REGISTRY, name) ? name : undefined;
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
  return typeof type === 'string' && type.startsWith(PROBLEM_TYPE_BASE) ? type.slice(PROBLEM_TYPE_BASE.length) : undefined;
}

async function logOutcome(route: string, trace: ConversionTrace, response: Response, startedAt: number): Promise<void> {
  const outcome: ConversionOutcome = {
    requestId: randomUUID(),
    status: response.status,
    code: await codeOf(response),
    ...trace,
    durationMs: Date.now() - startedAt,
  };
  if (response.status >= HTTP_INTERNAL_SERVER_ERROR) console.error(`[${route}] failure ${JSON.stringify(outcome)}`);
  else console.warn(`[${route}] refusal ${JSON.stringify(outcome)}`);
}

/** Wraps a convert route so that each answer of 400 or more is logged once, with what the route put in its trace. */
export function loggingOutcomes<Result extends Response>(
  route: string,
  handler: (req: NextRequest, trace: ConversionTrace) => Promise<Result>
): (req: NextRequest) => Promise<Result> {
  return async (req) => {
    const startedAt = Date.now();
    const trace: ConversionTrace = {};
    const response = await handler(req, trace);
    if (response.status >= HTTP_BAD_REQUEST) await logOutcome(route, trace, response, startedAt);
    return response;
  };
}
