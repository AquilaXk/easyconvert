/**
 * Single byte-range handling for the `Range` request header (RFC 9110 §14).
 *
 * - One satisfiable `bytes` range → `partial` with inclusive offsets (206).
 * - A malformed or unsatisfiable `bytes` range → `unsatisfiable` (416).
 * - No header, an unknown range unit, or several ranges → `full` (200); a server may always
 *   ignore `Range`, and multipart/byteranges responses are not produced.
 */

export type ByteRangeRequest =
  | { kind: 'full' }
  | { kind: 'partial'; start: number; end: number }
  | { kind: 'unsatisfiable' };

const BYTES_UNIT = 'bytes';
const UNIT_SEPARATOR = '=';
const RANGE_LIST_SEPARATOR = ',';
/** RFC 9110 §5.6.2 token, which a range-unit must be. */
const TOKEN_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
/** int-range = first-pos "-" [ last-pos ] */
const INT_RANGE_PATTERN = /^(\d+)-(\d*)$/;
/** suffix-range = "-" suffix-length */
const SUFFIX_RANGE_PATTERN = /^-(\d+)$/;

const FULL: ByteRangeRequest = { kind: 'full' };
const UNSATISFIABLE: ByteRangeRequest = { kind: 'unsatisfiable' };

function resolveIntRange(firstPos: string, lastPos: string, size: number): ByteRangeRequest {
  const start = Number(firstPos);
  const hasLastPos = lastPos.length > 0;
  const requestedEnd = Number(lastPos);
  if (hasLastPos && requestedEnd < start) {
    return UNSATISFIABLE;
  }
  if (start >= size) {
    return UNSATISFIABLE;
  }
  if (!hasLastPos || requestedEnd >= size) {
    return { kind: 'partial', start, end: size - 1 };
  }
  return { kind: 'partial', start, end: requestedEnd };
}

function resolveSuffixRange(suffixLength: string, size: number): ByteRangeRequest {
  const length = Number(suffixLength);
  if (length === 0) {
    return UNSATISFIABLE;
  }
  if (size === 0) {
    // A non-zero suffix of an empty representation is satisfiable but selects no bytes to send.
    return FULL;
  }
  return { kind: 'partial', start: Math.max(0, size - length), end: size - 1 };
}

/** Interprets a `Range` header value against a representation of `size` bytes. */
export function parseByteRange(header: string | null, size: number): ByteRangeRequest {
  if (header === null) {
    return FULL;
  }

  const separatorIndex = header.indexOf(UNIT_SEPARATOR);
  if (separatorIndex < 0) {
    return UNSATISFIABLE;
  }
  const unit = header.slice(0, separatorIndex);
  const rangeSet = header.slice(separatorIndex + 1);
  if (!TOKEN_PATTERN.test(unit)) {
    return UNSATISFIABLE;
  }
  if (unit.toLowerCase() !== BYTES_UNIT) {
    return FULL;
  }
  if (rangeSet.includes(RANGE_LIST_SEPARATOR)) {
    return FULL;
  }

  const intRange = INT_RANGE_PATTERN.exec(rangeSet);
  if (intRange) {
    return resolveIntRange(intRange[1], intRange[2], size);
  }
  const suffixRange = SUFFIX_RANGE_PATTERN.exec(rangeSet);
  if (suffixRange) {
    return resolveSuffixRange(suffixRange[1], size);
  }
  return UNSATISFIABLE;
}

/** `Content-Range` value for a 206 response. */
export function satisfiedContentRange(start: number, end: number, size: number): string {
  return `${BYTES_UNIT} ${start}-${end}/${size}`;
}

/** `Content-Range` value for a 416 response. */
export function unsatisfiedContentRange(size: number): string {
  return `${BYTES_UNIT} */${size}`;
}
