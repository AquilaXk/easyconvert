import Papa from 'papaparse';

/**
 * Delimiter detection and header naming for delimited-text input, shared by the server data
 * engine and the browser streaming path so both read a file the same way. Browser-safe: it
 * depends only on papaparse.
 */

/** Delimiters tried, in tie-break order, after the source format's own delimiter. */
export const DELIMITER_CANDIDATES: readonly string[] = [',', ';', '\t', '|'];
/** Records sampled when detecting the delimiter. */
export const DELIMITER_SAMPLE_RECORDS = 50;

/** The delimiter a delimited format nominally uses: comma for CSV, TAB for TSV/TAB. */
export function nominalDelimiter(sourceFormat: string): string {
  return sourceFormat === 'csv' ? ',' : '\t';
}

function sampleRecords(text: string, delimiter: string): Papa.ParseResult<string[]> {
  return Papa.parse<string[]>(text, { delimiter, preview: DELIMITER_SAMPLE_RECORDS, skipEmptyLines: true });
}

/** Field count of the sampled records when they all agree, else 0. */
function consistentFieldCount(text: string, delimiter: string): number {
  const sample = sampleRecords(text, delimiter);
  if (sample.errors.length > 0 || sample.data.length === 0) return 0;
  const width = sample.data[0].length;
  return sample.data.every((record) => record.length === width) ? width : 0;
}

/**
 * The source format's own delimiter wins when it splits the sampled records into a consistent
 * table of two or more columns; otherwise the candidate with the widest consistent table does.
 * A file no candidate splits consistently keeps the format's delimiter (a one-column table, or a
 * parse error that names the offending row).
 */
export function detectDelimiter(text: string, nominal: string): string {
  if (consistentFieldCount(text, nominal) > 1) return nominal;
  let best = nominal;
  let bestWidth = 1;
  for (const candidate of DELIMITER_CANDIDATES) {
    if (candidate === nominal) continue;
    const width = consistentFieldCount(text, candidate);
    if (width > bestWidth) {
      best = candidate;
      bestWidth = width;
    }
  }
  return best;
}

/**
 * Whether a prefix of the input already holds the whole delimiter sample, so detecting on it
 * gives the same answer as detecting on the full text: for every candidate the parser stopped at
 * the sample limit with input left over (so the last sampled record was ended by a line break),
 * and the prefix covers the window papaparse inspects to guess the line break.
 */
export function isDelimiterSampleComplete(prefix: string, lineBreakWindowChars: number): boolean {
  if (prefix.length < lineBreakWindowChars) return false;
  return DELIMITER_CANDIDATES.every((candidate) => {
    const sample = sampleRecords(prefix, candidate);
    return sample.meta.truncated && sample.meta.cursor < prefix.length;
  });
}

/** papaparse guesses the line break from the first 1 MiB of text. */
export const LINE_BREAK_GUESS_WINDOW_CHARS = 1024 * 1024;
/** Quoted spans, removed before counting line breaks (papaparse's lazy quote-to-quote match). */
const QUOTED_SPAN = /"([^]*?)"/gm;

/**
 * The one line break a delimited text uses, guessed exactly as papaparse guesses it: over the
 * first 1 MiB with quoted spans removed, LF when there is no CR or an LF comes before the first
 * CR; otherwise CRLF when at least half of the CR-separated pieces start with LF, else CR. The
 * server passes it to the parser and the stream splits records on it, so both read the same rows.
 */
export function guessLineBreak(text: string): '\n' | '\r\n' | '\r' {
  const window = text.substring(0, LINE_BREAK_GUESS_WINDOW_CHARS).replace(QUOTED_SPAN, '');
  const byCr = window.split('\r');
  const byLf = window.split('\n');
  const lfAppearsFirst = byLf.length > 1 && byLf[0].length < byCr[0].length;
  if (byCr.length === 1 || lfAppearsFirst) return '\n';
  const piecesStartingWithLf = byCr.filter((piece) => piece[0] === '\n').length;
  return piecesStartingWithLf >= byCr.length / 2 ? '\r\n' : '\r';
}

const BOM = '﻿';

/**
 * Header names for both the server parser and the stream, following papaparse's `header: true`
 * naming: a leading BOM is stripped from each, and a repeated name becomes name_N with the first
 * N that is not already a header (a, a, a_1 -> a, a_2, a_1). Callers key records with own
 * properties, so names such as __proto__ stay ordinary columns.
 */
export function renameDuplicateHeaders(headers: readonly string[]): string[] {
  const seenCount = new Map<string, number>();
  const used = new Set(headers);
  return headers.map((raw) => {
    const header = raw.startsWith(BOM) ? raw.slice(BOM.length) : raw;
    const count = seenCount.get(header);
    let name = header;
    if (count === undefined) {
      seenCount.set(header, 1);
    } else {
      let suffix = count;
      do {
        name = `${header}_${suffix}`;
        suffix++;
      } while (used.has(name));
      used.add(name);
      seenCount.set(header, count + 1);
    }
    used.add(header);
    return name;
  });
}
