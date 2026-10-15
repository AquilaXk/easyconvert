/**
 * What a conversion left out of the document, as an API surface carries it: one line per omission, such as an
 * HTML image that is not embedded. The engines record the lines in the result metadata; what reaches a client is the
 * bounded, validated form built here, so a value from a worker or a stored job result is never trusted as it stands.
 */

export const CONVERSION_WARNINGS_HEADER = 'X-Conversion-Warnings';

/** Most lines a response lists (an engine lists at most 50 omissions and one line that counts the rest). */
export const MAX_CONVERSION_WARNINGS = 64;
/** Longest line, in characters. */
export const MAX_CONVERSION_WARNING_CHARS = 300;
/** Longest header value; entries beyond it are not sent (the JSON response and the job result carry them all). */
const MAX_HEADER_CHARS = 2048;
const CONTROL_CHARACTERS = /\p{Cc}/gu;

export interface ConversionWarningsSource {
  warnings?: unknown;
  metadata?: Record<string, unknown>;
}

function boundedLine(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = [...value.replaceAll(CONTROL_CHARACTERS, ' ').trim()].slice(0, MAX_CONVERSION_WARNING_CHARS).join('');
  return text === '' ? undefined : text;
}

/** The valid lines of a recorded list, at most MAX_CONVERSION_WARNINGS; anything else in it is ignored. */
export function publicConversionWarnings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const lines: string[] = [];
  for (const raw of value) {
    const line = boundedLine(raw);
    if (line !== undefined) lines.push(line);
    if (lines.length >= MAX_CONVERSION_WARNINGS) break;
  }
  return lines;
}

/** JSON field listing what a conversion left out; absent when it left nothing out. */
export function conversionWarningsFields(result: ConversionWarningsSource): { warnings?: string[] } {
  const lines = publicConversionWarnings(result.warnings ?? result.metadata?.warnings);
  return lines.length > 0 ? { warnings: lines } : {};
}

/**
 * Header form for a raw binary response: each line percent-encoded (printable ASCII, no comma inside an entry),
 * entries separated by commas, cut at the last entry that fits.
 */
export function conversionWarningsHeaders(result: ConversionWarningsSource): Record<string, string> {
  const { warnings } = conversionWarningsFields(result);
  if (!warnings) return {};
  const entries: string[] = [];
  let length = 0;
  for (const line of warnings) {
    const entry = encodeURIComponent(line);
    const added = entries.length === 0 ? entry.length : entry.length + 1;
    if (length + added > MAX_HEADER_CHARS) break;
    entries.push(entry);
    length += added;
  }
  return entries.length > 0 ? { [CONVERSION_WARNINGS_HEADER]: entries.join(',') } : {};
}
