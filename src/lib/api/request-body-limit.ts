import { formatBytes } from '../format-bytes';
import { SINGLE_REQUEST_BODY_MAX_BYTES, SINGLE_REQUEST_FILE_MAX_BYTES, UPLOAD_PART_MAX_BYTES } from '../plan-limits';

/**
 * How large a request body each API route takes (docs/policy-decisions.md, entry 137), read from the `Content-Length`
 * before any body is read. A body that comes without a length (chunked, or framed by HTTP/2 alone) is counted by the
 * middleware as it arrives: a route that takes a file refuses it with 411 at its first byte, since the framework would
 * cut such a body short at one request without an error, and every other route takes it up to the small limit. Pure,
 * so the edge middleware and the routes share it.
 */

const MIB = 1024 * 1024;

/** A declared length in exact bytes: rounded to MiB it could read the same as the limit it is over. */
function exactBytes(bytes: number): string {
  return `${bytes.toLocaleString('en-US')} bytes`;
}

/** The body of a route that takes no file: JSON or a form of a few fields. */
export const SMALL_REQUEST_BODY_MAX_BYTES = MIB;

/**
 * Routes that take file bytes in a request, each up to SINGLE_REQUEST_BODY_MAX_BYTES, with their sub-paths. A route
 * that names an action takes a file only for that action: the other actions of the parts route are small JSON bodies.
 */
const FILE_ROUTES: ReadonlyArray<{ path: string; action?: string }> = [
  { path: '/api/convert' },
  { path: '/api/queue/jobs' },
  { path: '/api/storage/multipart', action: 'chunk' },
  { path: '/api/v1/archives/inspect' },
  { path: '/api/v1/convert' },
  { path: '/api/v1/jobs' },
  { path: '/api/v1/uploads' },
];

/** The address of a request: its path and its query. */
export interface RequestTarget {
  pathname: string;
  searchParams: URLSearchParams;
}

/** The headers of a request, as both `Headers` and the edge request give them. */
interface HeaderSource {
  get(name: string): string | null;
}

function isFileRoute({ pathname, searchParams }: RequestTarget): boolean {
  return FILE_ROUTES.some(
    (route) => (pathname === route.path || pathname.startsWith(`${route.path}/`)) && (!route.action || searchParams.get('action') === route.action)
  );
}

/** What a request body is, which decides what it may hold and whether it must declare its length. */
type BodyKind =
  /** A JSON or form of a few fields: 1 MiB, counted as it arrives when it has no length. */
  | 'small'
  /** A file in one request (or a tus chunk): one request, and a length declared. */
  | 'single'
  /** One part of a file sent in parts: the largest part, and a length declared. */
  | 'part';

const UPLOADS_ROUTE = /^\/api\/v1\/uploads(?:\/tus)?\/?$/;
const DIRECT_UPLOADS_ROUTE = '/api/v1/uploads/direct';
const DIRECT_PART_ROUTE = '/api/v1/uploads/direct/part';
/** Routes whose body is a multipart form when it carries a file and JSON otherwise. */
const FORM_OR_JSON_ROUTES: readonly string[] = ['/api/queue/jobs', '/api/v1/jobs'];

function isUnder(pathname: string, route: string): boolean {
  return pathname === route || pathname.startsWith(`${route}/`);
}

function isMultipartForm(headers: HeaderSource): boolean {
  return (headers.get('content-type') ?? '').toLowerCase().includes('multipart/form-data');
}

/**
 * What the body of a request to `target` is. The upload routes carry more than files: the control calls of an upload
 * (`?action=initiate|complete|abort`, `direct`, `direct/complete`) are small JSON, a part is held to the largest part, and
 * only a tus creation or chunk is a file of one request. The job routes take a file only in a multipart form; their JSON
 * calls are small. Any other route that takes files is `single`, and every route else is `small`.
 */
function bodyKindOf(target: RequestTarget, headers: HeaderSource): BodyKind {
  const { pathname, searchParams } = target;
  if (pathname === DIRECT_PART_ROUTE) return 'part';
  if (isUnder(pathname, DIRECT_UPLOADS_ROUTE)) return 'small';
  if (UPLOADS_ROUTE.test(pathname)) {
    const action = searchParams.get('action');
    if (!action) return 'single';
    return action === 'part' ? 'part' : 'small';
  }
  if (FORM_OR_JSON_ROUTES.some((route) => isUnder(pathname, route))) return isMultipartForm(headers) ? 'single' : 'small';
  return isFileRoute(target) ? 'single' : 'small';
}

export type DeclaredLength = { kind: 'absent' } | { kind: 'malformed' } | { kind: 'bytes'; bytes: number };

/** A `Content-Length` value: one or more digits (RFC 9110, section 8.6) that fit an exact integer. */
export function parseContentLength(header: string | null): DeclaredLength {
  if (header === null) return { kind: 'absent' };
  const value = header.trim();
  if (!/^\d+$/.test(value)) return { kind: 'malformed' };
  const bytes = Number(value);
  return Number.isSafeInteger(bytes) ? { kind: 'bytes', bytes } : { kind: 'malformed' };
}

const MALFORMED_CONTENT_LENGTH_DETAIL = 'The Content-Length header is not a whole number of bytes.';
const LENGTH_REQUIRED_DETAIL =
  'A request that carries a file must declare its Content-Length; send the body with its length instead of in chunks.';

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

/** What a route that takes no file says to a body sent without a length once more than its limit arrived. */
const COUNTED_OVERFLOW_DETAIL = `This request carries more than the ${formatBytes(SMALL_REQUEST_BODY_MAX_BYTES)} this route takes.`;

/** What a part route says to a part over the largest part. */
function partOverflowDetail(declaredBytes: number): string {
  return `This part carries ${exactBytes(declaredBytes)}, over the largest part of ${formatBytes(UPLOAD_PART_MAX_BYTES)}.`;
}

export type BodyLengthVerdict = { status: 400 | 413; detail: string } | null;

function verdictFor(headers: HeaderSource, limit: number, overflowDetail: (declaredBytes: number) => string): BodyLengthVerdict {
  const declared = parseContentLength(headers.get('content-length'));
  if (declared.kind === 'malformed') return { status: 400, detail: MALFORMED_CONTENT_LENGTH_DETAIL };
  if (declared.kind === 'absent' || declared.bytes <= limit) return null;
  return { status: 413, detail: overflowDetail(declared.bytes) };
}

/** A body without a declared length, read as it arrives: past `countUpTo` bytes the request is refused with `status`. */
export interface CountedBody {
  countUpTo: number;
  status: 411 | 413;
  detail: string;
}

/** What the middleware does with a body before the route reads it: refuse it, count it as it arrives, or let it pass (null). */
export type RequestBodyCheck = NonNullable<BodyLengthVerdict> | CountedBody | null;

/**
 * The check of the body of a request to `target`, by what the call is (`bodyKindOf`). A body without a declared length is
 * counted: a file or a part takes none of it (411 at its first byte, which an empty body never reaches), and a small body
 * takes the small limit.
 */
export function requestBodyVerdict(target: RequestTarget, headers: HeaderSource): RequestBodyCheck {
  const kind = bodyKindOf(target, headers);
  if (headers.get('content-length') === null) {
    return kind === 'small'
      ? { countUpTo: SMALL_REQUEST_BODY_MAX_BYTES, status: 413, detail: COUNTED_OVERFLOW_DETAIL }
      : { countUpTo: 0, status: 411, detail: LENGTH_REQUIRED_DETAIL };
  }
  if (kind === 'single') return singleRequestVerdict(target.pathname, headers);
  if (kind === 'part') return partBodyVerdict(headers);
  return verdictFor(headers, SMALL_REQUEST_BODY_MAX_BYTES, smallRequestOverflowDetail);
}

/** The refusal of a request to `pathname`, a route that takes a file whole, by its declared length, or null when it may be read. */
export function singleRequestVerdict(pathname: string, headers: HeaderSource): BodyLengthVerdict {
  return verdictFor(headers, SINGLE_REQUEST_BODY_MAX_BYTES, (declared) => singleRequestOverflowDetail(declared, pathname));
}

/** The refusal of a part by its declared length, or null when it may be read. */
export function partBodyVerdict(headers: HeaderSource): BodyLengthVerdict {
  return verdictFor(headers, UPLOAD_PART_MAX_BYTES, partOverflowDetail);
}
