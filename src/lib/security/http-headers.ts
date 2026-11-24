import { ConversionFailedError } from '../types';

/**
 * Shared RFC 9110 & WHATWG Fetch custom HTTP header guard.
 *
 * References:
 * - RFC 9110 §5.1 (`tchar` token) and §5.5 (`field-vchar` / `obs-text`, rejecting NUL/CR/LF/CTLs `< 0x20` except HTAB, `0x7F`, and code points `> 0xFF`).
 * - WHATWG Fetch §2.2.2 (`forbiddenHeaderNames`), noting `undici/lib/web/fetch/headers.js:84,107` normalizes CR/LF and omits forbidden-header filtering.
 * - Reverse-proxy spoofing headers (`x-real-ip`, `x-forwarded-*`) and framing headers (`content-length`, `transfer-encoding`).
 *   `content-type` remains allowed at submission; `export.url` strips framing headers at egress in `withoutFramingHeaders`.
 */

export const CUSTOM_HEADER_NAME_REGEX = /^[!#$%&'*+\-.^_`|~0-9a-zA-Z]+$/;
export const CUSTOM_HEADER_VALUE_REGEX = /^[\t\x20-\x7E\x80-\xFF]*$/;

export const FORBIDDEN_CUSTOM_HEADERS: ReadonlySet<string> = new Set([
  'host',
  'connection',
  'content-length',
  'transfer-encoding',
  'keep-alive',
  'te',
  'upgrade',
  'trailer',
  'proxy-authorization',
  'proxy-authenticate',
  'cookie',
  'set-cookie',
  'origin',
  'referer',
  'x-real-ip',
]);

export const FORBIDDEN_CUSTOM_HEADER_PREFIXES = ['proxy-', 'sec-', 'x-forwarded-'] as const;

export const DEFAULT_MAX_CUSTOM_HEADERS = 64;
export const DEFAULT_MAX_CUSTOM_HEADER_NAME_CHARS = 256;
export const DEFAULT_MAX_CUSTOM_HEADER_VALUE_CHARS = 8192;
export const DEFAULT_MAX_REPORTED_HEADER_NAME_CHARS = 48;

export interface CustomHeaderLimits {
  maxHeaders?: number;
  maxNameChars?: number;
  maxValueChars?: number;
  maxReportedNameChars?: number;
}

export interface CustomHeaderIssue {
  /** Sanitized header name when a specific entry failed; undefined when the container itself failed. */
  headerName?: string;
  /** Fixed reason string without any header value. */
  reason: string;
}

/** Raised at runtime when an outbound URL import/export receives forbidden or malformed custom HTTP headers. */
export class InvalidCustomHeaderError extends ConversionFailedError {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidCustomHeaderError';
  }
}

export function isForbiddenCustomHeader(name: string): boolean {
  const lower = name.trim().toLowerCase();
  return (
    FORBIDDEN_CUSTOM_HEADERS.has(lower) ||
    FORBIDDEN_CUSTOM_HEADER_PREFIXES.some((prefix) => lower.startsWith(prefix))
  );
}

/** Replaces characters outside RFC 9110 `tchar` with `_` so CRLF/CTLs never enter problem paths or messages. */
export function sanitizeHeaderNameForReport(
  name: string,
  maxChars = DEFAULT_MAX_REPORTED_HEADER_NAME_CHARS
): string {
  return name.slice(0, maxChars).replace(/[^!#$%&'*+\-.^_`|~0-9a-zA-Z]/g, '_');
}

function isPlainHeaderMap(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export function inspectCustomHeaderEntry(
  name: string,
  value: unknown,
  limits?: CustomHeaderLimits
): CustomHeaderIssue | undefined {
  const maxNameChars = limits?.maxNameChars ?? DEFAULT_MAX_CUSTOM_HEADER_NAME_CHARS;
  const maxValueChars = limits?.maxValueChars ?? DEFAULT_MAX_CUSTOM_HEADER_VALUE_CHARS;
  const maxReportedNameChars = limits?.maxReportedNameChars ?? DEFAULT_MAX_REPORTED_HEADER_NAME_CHARS;
  const headerName = sanitizeHeaderNameForReport(name, maxReportedNameChars);

  if (name.length > maxNameChars) {
    return { headerName, reason: `header name is longer than ${maxNameChars} characters` };
  }
  if (!CUSTOM_HEADER_NAME_REGEX.test(name)) {
    return { headerName, reason: 'invalid header name' };
  }
  if (isForbiddenCustomHeader(name)) {
    return { headerName, reason: 'header is not permitted' };
  }
  if (typeof value !== 'string') {
    return { headerName, reason: 'header value must be a string' };
  }
  if (value.length > maxValueChars) {
    return { headerName, reason: `header value is longer than ${maxValueChars} characters` };
  }
  if (!CUSTOM_HEADER_VALUE_REGEX.test(value)) {
    return { headerName, reason: 'invalid header value' };
  }
  return undefined;
}

export function inspectCustomHeaders(
  headers: unknown,
  limits?: CustomHeaderLimits
): CustomHeaderIssue[] {
  if (!isPlainHeaderMap(headers)) {
    return [{ reason: 'headers must be an object of strings' }];
  }
  const maxHeaders = limits?.maxHeaders ?? DEFAULT_MAX_CUSTOM_HEADERS;
  const entries = Object.entries(headers);
  if (entries.length > maxHeaders) {
    return [{ reason: `more than ${maxHeaders} headers` }];
  }
  const issues: CustomHeaderIssue[] = [];
  for (const [name, value] of entries) {
    const issue = inspectCustomHeaderEntry(name, value, limits);
    if (issue) {
      issues.push(issue);
    }
  }
  return issues;
}

/** Formats a header issue without repeating any header value. */
export function formatCustomHeaderIssue(issue: CustomHeaderIssue): string {
  return issue.headerName !== undefined ? `header "${issue.headerName}": ${issue.reason}` : issue.reason;
}

export function assertSafeCustomHeaders(
  headers: Record<string, string> | undefined,
  limits?: CustomHeaderLimits
): void {
  if (headers === undefined) {
    return;
  }
  const issues = inspectCustomHeaders(headers, limits);
  if (issues.length === 0) {
    return;
  }
  throw new InvalidCustomHeaderError(`Invalid custom HTTP headers (${formatCustomHeaderIssue(issues[0])})`);
}
