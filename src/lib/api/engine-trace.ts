import { redactText } from '../security/redact';

/**
 * Which engine converted a file and, when a fallback happened, why. The engines record the raw reason
 * (an error message that can quote a sandbox path or a tool's stderr); API surfaces only ever carry the
 * bounded, redacted form built here.
 */

export const ENGINE_USED_HEADER = 'X-Engine-Used';
export const FALLBACK_REASON_HEADER = 'X-Fallback-Reason';

/** Longest `fallbackReason` an API surface carries, ellipsis included. */
export const MAX_FALLBACK_REASON_CHARS = 200;

const ELLIPSIS = '...';
const PATH_PLACEHOLDER = '<path>';
const NON_PRINTABLE_ASCII = /[^\x20-\x7e]/g;
const REPEATED_SPACES = / {2,}/g;
const LINE_BREAK = /\r?\n/;
/** A path starts at the beginning of the text or after a space, quote, bracket, `=` or `,`. */
const PATH_START = String.raw`(?<=^|[\s"'(\[=,])`;
const PATH_BODY = String.raw`[^\s"'<>()\[\]]*`;
const POSIX_PATH = new RegExp(String.raw`${PATH_START}\/[^\s"'<>()\[\]]+`, 'g');
const HOME_PATH = new RegExp(String.raw`${PATH_START}~\/${PATH_BODY}`, 'g');
const WINDOWS_PATH = new RegExp(String.raw`\b[A-Za-z]:\\${PATH_BODY}`, 'g');

export interface EngineTrace {
  engineUsed?: string;
  fallbackReason?: string;
}

/** The engine fields of a conversion result; `fallbackChain` lists the engines that failed before it. */
export interface EngineTraceSource {
  engineUsed?: string;
  fallbackReason?: string;
  fallbackChain?: string[];
}

/**
 * The reason of a fallback as an API may show it: the first line only (a tool's stderr follows it), credentials
 * masked, file system paths replaced, printable ASCII only (it travels in a header too) and at most
 * `MAX_FALLBACK_REASON_CHARS` long. Undefined when nothing is left.
 */
export function publicFallbackReason(reason: string | undefined): string | undefined {
  const firstLine = (reason ?? '').split(LINE_BREAK).find((line) => line.trim().length > 0);
  if (firstLine === undefined) return undefined;
  const text = redactText(firstLine)
    .replaceAll(WINDOWS_PATH, PATH_PLACEHOLDER)
    .replaceAll(HOME_PATH, PATH_PLACEHOLDER)
    .replaceAll(POSIX_PATH, PATH_PLACEHOLDER)
    .replaceAll(NON_PRINTABLE_ASCII, '?')
    .replaceAll(REPEATED_SPACES, ' ')
    .trim();
  if (text.length === 0) return undefined;
  if (text.length <= MAX_FALLBACK_REASON_CHARS) return text;
  return `${text.slice(0, MAX_FALLBACK_REASON_CHARS - ELLIPSIS.length)}${ELLIPSIS}`;
}

/**
 * JSON fields naming the engine of a result and, only when a fallback happened, its public reason. A result
 * that went through a failed engine without recording a reason is described by the last failed link.
 */
export function engineTraceFields(result: EngineTraceSource): EngineTrace {
  const fields: EngineTrace = {};
  if (result.engineUsed) fields.engineUsed = result.engineUsed;
  const reason = publicFallbackReason(result.fallbackReason ?? result.fallbackChain?.at(-1));
  if (reason !== undefined) fields.fallbackReason = reason;
  return fields;
}

/** Headers carrying the same two values for a raw binary response. */
export function engineTraceHeaders(result: EngineTraceSource): Record<string, string> {
  const fields = engineTraceFields(result);
  const headers: Record<string, string> = {};
  if (fields.engineUsed) headers[ENGINE_USED_HEADER] = fields.engineUsed;
  if (fields.fallbackReason) headers[FALLBACK_REASON_HEADER] = fields.fallbackReason;
  return headers;
}
