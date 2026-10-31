import { formatBytes } from '../format-bytes';
import { SINGLE_REQUEST_BODY_MAX_BYTES, SINGLE_REQUEST_FILE_MAX_BYTES, UPLOAD_PART_MAX_BYTES } from '../plan-limits';

/**
 * How large a request body each API route takes (docs/policy-decisions.md, entry 137), read from the `Content-Length`
 * before any body is read. Pure, so the edge middleware and the routes share it.
 */

const MIB = 1024 * 1024;

/** A declared length in exact bytes: rounded to MiB it could read the same as the limit it is over. */
function exactBytes(bytes: number): string {
  return `${bytes.toLocaleString('en-US')} bytes`;
}

/** The body of a route that takes no file: JSON or a form of a few fields. */
export const SMALL_REQUEST_BODY_MAX_BYTES = MIB;

/** Routes that take file bytes in a request, each up to SINGLE_REQUEST_BODY_MAX_BYTES; their sub-paths too. */
const FILE_ROUTES: readonly string[] = [
  '/api/convert',
  '/api/queue/jobs',
  '/api/storage/multipart',
  '/api/v1/archives/inspect',
  '/api/v1/convert',
  '/api/v1/jobs',
  '/api/v1/uploads',
];

function isFileRoute(pathname: string): boolean {
  return FILE_ROUTES.some((route) => pathname === route || pathname.startsWith(`${route}/`));
}

type DeclaredLength = { kind: 'absent' } | { kind: 'malformed' } | { kind: 'bytes'; bytes: number };

/** A `Content-Length` value: one or more digits (RFC 9110, section 8.6) that fit an exact integer. */
function parseContentLength(header: string | null): DeclaredLength {
  if (header === null) return { kind: 'absent' };
  const value = header.trim();
  if (!/^\d+$/.test(value)) return { kind: 'malformed' };
  const bytes = Number(value);
  return Number.isSafeInteger(bytes) ? { kind: 'bytes', bytes } : { kind: 'malformed' };
}

const MALFORMED_CONTENT_LENGTH_DETAIL = 'The Content-Length header is not a whole number of bytes.';

/** The upload flow a client of `pathname` uses for a larger file: the public one under /api/v1, the web application's elsewhere. */
function partsFlowOf(pathname: string): { upload: string; job: string } {
  return pathname.startsWith('/api/v1/')
    ? { upload: 'POST /api/v1/uploads', job: 'POST /api/v1/jobs' }
    : { upload: 'POST /api/storage/multipart', job: 'POST /api/queue/jobs' };
}

/** What a route that takes a file says to a body over one request: the way to send it in parts. */
function singleRequestOverflowDetail(declaredBytes: number, pathname: string): string {
  const flow = partsFlowOf(pathname);
  return (
    `This request carries ${exactBytes(declaredBytes)}, over the ${formatBytes(SINGLE_REQUEST_FILE_MAX_BYTES)} one request may carry. ` +
    `Send a larger file in parts of at most ${formatBytes(UPLOAD_PART_MAX_BYTES)}: open an upload with ${flow.upload}, send the parts, ` +
    `then start the conversion with ${flow.job} on the stored file.`
  );
}

/** What a route that takes no file says to a body over its limit. */
function smallRequestOverflowDetail(declaredBytes: number): string {
  return `This request carries ${exactBytes(declaredBytes)}, over the ${formatBytes(SMALL_REQUEST_BODY_MAX_BYTES)} this route takes.`;
}

/** What a part route says to a part over the largest part. */
function partOverflowDetail(declaredBytes: number): string {
  return `This part carries ${exactBytes(declaredBytes)}, over the largest part of ${formatBytes(UPLOAD_PART_MAX_BYTES)}.`;
}

export type BodyLengthVerdict = { status: 400 | 413; detail: string } | null;

function verdictFor(header: string | null, limit: number, overflowDetail: (declaredBytes: number) => string): BodyLengthVerdict {
  const declared = parseContentLength(header);
  if (declared.kind === 'malformed') return { status: 400, detail: MALFORMED_CONTENT_LENGTH_DETAIL };
  if (declared.kind === 'absent' || declared.bytes <= limit) return null;
  return { status: 413, detail: overflowDetail(declared.bytes) };
}

/** The refusal of a request to `pathname` by its declared length, or null when it may be read. */
export function requestBodyVerdict(pathname: string, header: string | null): BodyLengthVerdict {
  return isFileRoute(pathname)
    ? singleRequestVerdict(pathname, header)
    : verdictFor(header, SMALL_REQUEST_BODY_MAX_BYTES, smallRequestOverflowDetail);
}

/** The refusal of a request to `pathname`, a route that takes a file whole, by its declared length, or null when it may be read. */
export function singleRequestVerdict(pathname: string, header: string | null): BodyLengthVerdict {
  return verdictFor(header, SINGLE_REQUEST_BODY_MAX_BYTES, (declared) => singleRequestOverflowDetail(declared, pathname));
}

/** The refusal of a part by its declared length, or null when it may be read. */
export function partBodyVerdict(header: string | null): BodyLengthVerdict {
  return verdictFor(header, UPLOAD_PART_MAX_BYTES, partOverflowDetail);
}
