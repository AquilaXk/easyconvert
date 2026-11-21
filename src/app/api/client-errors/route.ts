import { NextRequest, NextResponse } from 'next/server';
import { createProblemDetailsResponse } from '@/lib/api/problem-details';
import { parseContentLength } from '@/lib/api/request-body-limit';
import { AuthStoreUnavailableError } from '@/lib/auth/store-unavailable';
import { consumeClientErrorRateLimit, resolveAuthClientIp } from '@/lib/auth/login-rate-limiter';
import { CLIENT_ERROR_MAX_BODY_BYTES, CLIENT_ERROR_PATH } from '@/lib/client-errors/report';
import { sanitiseClientError } from '@/lib/client-errors/sanitise';

export const dynamic = 'force-dynamic';

const HTTP_NO_CONTENT = 204;
const HTTP_BAD_REQUEST = 400;
const HTTP_FORBIDDEN = 403;
const HTTP_PAYLOAD_TOO_LARGE = 413;
const HTTP_TOO_MANY_REQUESTS = 429;
const HTTP_SERVICE_UNAVAILABLE = 503;

/**
 * The crash report of a page of this site (entry 384 of docs/policy-decisions.md): the route answers 204 with no body and writes one
 * server log line of what the sanitiser keeps. The report is never echoed, in an answer or in the line, beyond those fields.
 */

/**
 * Whether the browser says the request is from a page of this site. A browser that sends Fetch Metadata names it (`same-origin`);
 * an older one sends an `Origin` of this host on a POST. A request that says neither is not from a page. The edge middleware has
 * already compared the origin with the configured one (src/middleware.ts); this check does not rely on it.
 */
function isFromOwnPage(req: NextRequest): boolean {
  const site = req.headers.get('sec-fetch-site');
  if (site) return site === 'same-origin';
  const origin = req.headers.get('origin');
  const host = req.headers.get('host');
  if (!origin || !host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

/** The body as text, or null once more than the cap arrived; a body that declares no length is counted as it arrives. */
async function readCapped(req: NextRequest): Promise<string | null> {
  const reader = req.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
    received += chunk.value.byteLength;
    if (received > CLIENT_ERROR_MAX_BODY_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(chunk.value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function parsedJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  if (!isFromOwnPage(req)) return createProblemDetailsResponse(HTTP_FORBIDDEN, 'Crash reports are taken from the pages of this site only.', CLIENT_ERROR_PATH);

  const declared = parseContentLength(req.headers.get('content-length'));
  if (declared.kind === 'malformed') return createProblemDetailsResponse(HTTP_BAD_REQUEST, 'The Content-Length header is not a whole number of bytes.', CLIENT_ERROR_PATH);
  if (declared.kind === 'bytes' && declared.bytes > CLIENT_ERROR_MAX_BODY_BYTES) {
    return createProblemDetailsResponse(HTTP_PAYLOAD_TOO_LARGE, `A crash report is at most ${CLIENT_ERROR_MAX_BODY_BYTES} bytes.`, CLIENT_ERROR_PATH);
  }

  const client = resolveAuthClientIp(req);
  if ('refused' in client) return client.refused;
  try {
    const limit = await consumeClientErrorRateLimit(client.clientIp);
    if (!limit.allowed) {
      return createProblemDetailsResponse(HTTP_TOO_MANY_REQUESTS, 'Too many crash reports. Try again later.', CLIENT_ERROR_PATH, undefined, undefined, {
        'Retry-After': String(limit.retryAfterSeconds),
      });
    }
  } catch (error) {
    if (!(error instanceof AuthStoreUnavailableError)) throw error;
    return createProblemDetailsResponse(HTTP_SERVICE_UNAVAILABLE, 'Crash reports are not taken for now.', CLIENT_ERROR_PATH, undefined, undefined, {
      'Retry-After': String(error.retryAfterSeconds),
    });
  }

  const text = await readCapped(req);
  if (text === null) return createProblemDetailsResponse(HTTP_PAYLOAD_TOO_LARGE, `A crash report is at most ${CLIENT_ERROR_MAX_BODY_BYTES} bytes.`, CLIENT_ERROR_PATH);
  const line = sanitiseClientError(parsedJson(text), req.headers.get('user-agent'));
  if (!line) return createProblemDetailsResponse(HTTP_BAD_REQUEST, 'The body is not a crash report.', CLIENT_ERROR_PATH);

  console.warn(`[client-error] ${JSON.stringify(line)}`);
  return new NextResponse(null, { status: HTTP_NO_CONTENT });
}
