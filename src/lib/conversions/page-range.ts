import { InvalidPageRangeError } from '../types';

export { InvalidPageRangeError };

export interface PageInterval {
  start: number;
  end: number;
}

/**
 * Most pages one request renders to page images or converts to separate images, the same for every caller (policy entry 44).
 * The pages follow the content and a request cannot predict them: real workbooks print 900 to 5,200 pages and a real 8 MB report
 * 4,181 to 4,874. The office suite writes their PDF in 3 to 32 s, but the pages cost about 50 ms and 0.5 MB each (4 vCPU), so
 * one request ran to minutes and half a gigabyte, past the job deadline when the runner is shared. A PDF, a DjVu, an XPS
 * document and a multi-page image (a TIFF or a HEIF sequence) are held to the same number, which keeps the output ZIP and the
 * decoding of a document of any size within one job; OCR and the re-encoded rasters of the worker use it too.
 */
export const PAGE_IMAGE_MAX_PAGES = 500;

/**
 * Longest page specification, in characters. A specification is untrusted text that the web server and the worker read on one
 * thread; this bound, with the merge of its ranges, keeps the cost of reading it to its tokens and the pages it selects.
 */
export const MAX_PAGE_SPEC_CHARS = 8192;

function parseIntegerPage(val: string, label: string): number {
  const num = Number.parseInt(val, 10);
  if (Number.isNaN(num) || num < 1) {
    throw new InvalidPageRangeError(`Invalid ${label}: "${val}". Page numbers must be >= 1.`);
  }
  return num;
}

function parseSinglePageToken(token: string, pageCount: number): PageInterval {
  const page = parseIntegerPage(token, 'page number');
  if (page > pageCount) {
    throw new InvalidPageRangeError(`Page number ${page} exceeds document page count of ${pageCount}.`);
  }
  return { start: page, end: page };
}

function parseOpenEndedStart(startPart: string, pageCount: number): PageInterval {
  const start = parseIntegerPage(startPart, 'range start');
  if (start > pageCount) {
    throw new InvalidPageRangeError(`Range start ${start} exceeds document page count of ${pageCount}.`);
  }
  return { start, end: pageCount };
}

function parseOpenEndedEnd(endPart: string, pageCount: number): PageInterval {
  const end = parseIntegerPage(endPart, 'range end');
  if (end > pageCount) {
    throw new InvalidPageRangeError(`Range end ${end} exceeds document page count of ${pageCount}.`);
  }
  return { start: 1, end };
}

function parseClosedRange(startPart: string, endPart: string, pageCount: number): PageInterval {
  const start = parseIntegerPage(startPart, 'range start');
  const end = parseIntegerPage(endPart, 'range end');
  if (start > pageCount || end > pageCount) {
    throw new InvalidPageRangeError(`Range ${start}-${end} exceeds document page count of ${pageCount}.`);
  }
  if (start > end) {
    throw new InvalidPageRangeError(`Range start ${start} cannot exceed range end ${end}.`);
  }
  return { start, end };
}

function parseRangeToken(token: string, pageCount: number): PageInterval {
  const hyphenCount = (token.match(/-/g) || []).length;
  if (hyphenCount !== 1) {
    throw new InvalidPageRangeError(`Invalid range format: "${token}". Exactly one hyphen is allowed per range.`);
  }

  const [startPart, endPart] = token.split('-');
  if (startPart === '' && endPart === '') {
    throw new InvalidPageRangeError('Bare hyphen "-" is not a valid page range.');
  }
  if (startPart !== '' && endPart === '') {
    return parseOpenEndedStart(startPart, pageCount);
  }
  if (startPart === '' && endPart !== '') {
    return parseOpenEndedEnd(endPart, pageCount);
  }
  return parseClosedRange(startPart, endPart, pageCount);
}

function parseTokenInterval(token: string, pageCount: number): PageInterval {
  if (!token.includes('-')) {
    return parseSinglePageToken(token, pageCount);
  }
  return parseRangeToken(token, pageCount);
}

function assertValidTokenString(token: string, spec: string): void {
  if (token === '') {
    throw new InvalidPageRangeError(`Invalid empty page range token in specification: "${spec}".`);
  }
  if (!/^[0-9-]+$/.test(token)) {
    throw new InvalidPageRangeError(`Invalid character in page range token: "${token}". Only digits and hyphens are allowed.`);
  }
}

function assertSpecLength(spec: string): void {
  if (spec.length > MAX_PAGE_SPEC_CHARS) {
    throw new InvalidPageRangeError(`A page range specification is at most ${MAX_PAGE_SPEC_CHARS} characters long.`);
  }
}

/**
 * Sorts the intervals and joins the ones that overlap or touch, the pass of Chromium's `printing::PageRange::Normalize`
 * (printing/page_range.cc): the cost is the sort of the tokens, whatever pages they name.
 */
function mergeIntervals(intervals: PageInterval[]): PageInterval[] {
  intervals.sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: PageInterval[] = [intervals[0]];
  for (let index = 1; index < intervals.length; index++) {
    const last = merged[merged.length - 1];
    const next = intervals[index];
    if (last.end + 1 < next.start) merged.push(next);
    else last.end = Math.max(last.end, next.end);
  }
  return merged;
}

/**
 * Parses and validates a page range specification string against the total page count, and returns the pages it selects as
 * sorted, non-overlapping intervals that do not touch.
 * Grammar: N | N-M | N- | -M, comma separated (e.g. "1, 3-5, 8-"). At most `MAX_PAGE_SPEC_CHARS` characters.
 */
export function parsePageIntervals(spec: string, pageCount: number): PageInterval[] {
  if (typeof pageCount !== 'number' || !Number.isInteger(pageCount) || pageCount < 1) {
    throw new InvalidPageRangeError(`Invalid document page count: ${pageCount}. Must be an integer >= 1.`);
  }

  if (typeof spec !== 'string' || spec.trim() === '') {
    throw new InvalidPageRangeError('Page range specification must be a non-empty string.');
  }
  assertSpecLength(spec);

  const intervals = spec.split(',').map((rawToken) => {
    const token = rawToken.trim();
    assertValidTokenString(token, spec);
    return parseTokenInterval(token, pageCount);
  });
  return mergeIntervals(intervals);
}

/** The pages `parsePageIntervals` selects, as an ascending list. */
export function parsePageRanges(spec: string, pageCount: number): number[] {
  const pages: number[] = [];
  for (const { start, end } of parsePageIntervals(spec, pageCount)) {
    for (let page = start; page <= end; page++) pages.push(page);
  }
  return pages;
}

/**
 * Groups a sorted array of page numbers into contiguous intervals.
 * E.g. [1, 2, 3, 5, 7, 8] => [{ start: 1, end: 3 }, { start: 5, end: 5 }, { start: 7, end: 8 }].
 */
export function groupConsecutiveRanges(pages: number[]): PageInterval[] {
  if (pages.length === 0) return [];
  const intervals: PageInterval[] = [];
  let currentStart = pages[0];
  let currentEnd = pages[0];

  for (let i = 1; i < pages.length; i++) {
    const page = pages[i];
    if (page === currentEnd + 1) {
      currentEnd = page;
    } else {
      intervals.push({ start: currentStart, end: currentEnd });
      currentStart = page;
      currentEnd = page;
    }
  }
  intervals.push({ start: currentStart, end: currentEnd });
  return intervals;
}

function validateRangeBound(part: string, label: string): number | undefined {
  if (part === '') return undefined;
  return parseIntegerPage(part, label);
}

function validateSingleTokenSyntax(token: string, spec: string): void {
  assertValidTokenString(token, spec);

  if (!token.includes('-')) {
    parseIntegerPage(token, 'page number');
    return;
  }

  const hyphenCount = (token.match(/-/g) || []).length;
  if (hyphenCount !== 1) {
    throw new InvalidPageRangeError(`Invalid range format: "${token}". Exactly one hyphen is allowed per range.`);
  }

  const [startPart, endPart] = token.split('-');
  if (startPart === '' && endPart === '') {
    throw new InvalidPageRangeError('Bare hyphen "-" is not a valid page range.');
  }

  const start = validateRangeBound(startPart, 'range start');
  const end = validateRangeBound(endPart, 'range end');
  if (start !== undefined && end !== undefined && start > end) {
    throw new InvalidPageRangeError(`Range start ${start} cannot exceed range end ${end}.`);
  }
}

/**
 * Validates the syntactic validity of a page range string without requiring a known total page count.
 */
export function validatePageRangeSyntax(spec: string): void {
  if (typeof spec !== 'string' || spec.trim() === '') {
    throw new InvalidPageRangeError('Page range specification must be a non-empty string.');
  }
  assertSpecLength(spec);

  const rawTokens = spec.split(',');
  for (const rawToken of rawTokens) {
    validateSingleTokenSyntax(rawToken.trim(), spec);
  }
}

const MIN_PAGE_DIGITS = 3;

/** ZIP entry name for page `pageNumber` of a multi-page output: `<name>-p001.<ext>`, padded to the last page's width. */
export function pageEntryName(baseName: string, pageNumber: number, lastPage: number, extension: string): string {
  const padLength = Math.max(MIN_PAGE_DIGITS, String(lastPage).length);
  return `${baseName}-p${String(pageNumber).padStart(padLength, '0')}.${extension}`;
}

const WHOLE_NUMBER_TEXT = /^-?[0-9]+$/;

/**
 * The page number a `page` option names, or undefined when it names none (null, undefined, empty or blank
 * text). Only whole numbers qualify: a number, or text of decimal digits with optional surrounding
 * whitespace. Exponent and hexadecimal text, fractions, signs other than a minus and non-scalar values are
 * refused instead of being coerced.
 */
function parsePageNumber(page: unknown): number | undefined {
  if (page === null || page === undefined) return undefined;
  if (typeof page === 'number' && Number.isSafeInteger(page)) return page;
  if (typeof page === 'string') {
    const text = page.trim();
    if (text === '') return undefined;
    if (WHOLE_NUMBER_TEXT.test(text) && Number.isSafeInteger(Number(text))) return Number(text);
  }
  throw new InvalidPageRangeError(`Invalid page ${JSON.stringify(page)}: use a whole number written in decimal digits`);
}

/**
 * Resolves the pages a request selects from its `page` (one page) and `pages` (ranges) options, or undefined
 * when it selects none. `null`, an empty or blank string count as absent, and surrounding whitespace is
 * ignored in both options. When both are given they must select the same single page, otherwise the request
 * is ambiguous and is refused.
 */
export function resolvePageSelection(
  page: number | string | null | undefined,
  spec: string | null | undefined,
  pageCount: number,
  outOfRange: (page: number | string, pageCount: number) => InvalidPageRangeError
): number[] | undefined {
  const single = parsePageNumber(page);
  const ranges = typeof spec === 'string' && spec.trim() !== '' ? spec.trim() : undefined;
  if (single === undefined) {
    return ranges === undefined ? undefined : parsePageRanges(ranges, pageCount);
  }
  if (single < 1 || single > pageCount) throw outOfRange(single, pageCount);
  if (ranges !== undefined) {
    const listed = parsePageRanges(ranges, pageCount);
    if (listed.length !== 1 || listed[0] !== single) {
      throw new InvalidPageRangeError(`The "page" option (${single}) and the "pages" option ("${ranges}") select different pages`);
    }
  }
  return [single];
}
