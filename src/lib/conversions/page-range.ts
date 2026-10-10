import { InvalidPageRangeError } from '../types';

export { InvalidPageRangeError };

export interface PageInterval {
  start: number;
  end: number;
}

/**
 * Maximum pages allowed per conversion request by user subscription tier.
 */
export const TIER_MAX_PAGES: Record<string, number> = {
  free: 50,
  pro: 500,
  enterprise: 2000,
};

function parseIntegerPage(val: string, label: string): number {
  const num = Number.parseInt(val, 10);
  if (Number.isNaN(num) || num < 1) {
    throw new InvalidPageRangeError(`Invalid ${label}: "${val}". Page numbers must be >= 1.`);
  }
  return num;
}

function parseSinglePageToken(token: string, pageCount: number): number {
  const page = parseIntegerPage(token, 'page number');
  if (page > pageCount) {
    throw new InvalidPageRangeError(`Page number ${page} exceeds document page count of ${pageCount}.`);
  }
  return page;
}

function parseOpenEndedStart(startPart: string, pageCount: number): number[] {
  const start = parseIntegerPage(startPart, 'range start');
  if (start > pageCount) {
    throw new InvalidPageRangeError(`Range start ${start} exceeds document page count of ${pageCount}.`);
  }
  const pages: number[] = [];
  for (let p = start; p <= pageCount; p++) {
    pages.push(p);
  }
  return pages;
}

function parseOpenEndedEnd(endPart: string, pageCount: number): number[] {
  const end = parseIntegerPage(endPart, 'range end');
  if (end > pageCount) {
    throw new InvalidPageRangeError(`Range end ${end} exceeds document page count of ${pageCount}.`);
  }
  const pages: number[] = [];
  for (let p = 1; p <= end; p++) {
    pages.push(p);
  }
  return pages;
}

function parseClosedRange(startPart: string, endPart: string, pageCount: number): number[] {
  const start = parseIntegerPage(startPart, 'range start');
  const end = parseIntegerPage(endPart, 'range end');
  if (start > pageCount || end > pageCount) {
    throw new InvalidPageRangeError(`Range ${start}-${end} exceeds document page count of ${pageCount}.`);
  }
  if (start > end) {
    throw new InvalidPageRangeError(`Range start ${start} cannot exceed range end ${end}.`);
  }
  const pages: number[] = [];
  for (let p = start; p <= end; p++) {
    pages.push(p);
  }
  return pages;
}

function parseRangeToken(token: string, pageCount: number): number[] {
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

function parseTokenPages(token: string, pageCount: number): number[] {
  if (!token.includes('-')) {
    return [parseSinglePageToken(token, pageCount)];
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

/**
 * Parses and validates a page range specification string against the total page count.
 * Grammar: N | N-M | N- | -M, comma separated (e.g. "1, 3-5, 8-").
 */
export function parsePageRanges(spec: string, pageCount: number): number[] {
  if (typeof pageCount !== 'number' || !Number.isInteger(pageCount) || pageCount < 1) {
    throw new InvalidPageRangeError(`Invalid document page count: ${pageCount}. Must be an integer >= 1.`);
  }

  if (typeof spec !== 'string' || spec.trim() === '') {
    throw new InvalidPageRangeError('Page range specification must be a non-empty string.');
  }

  const rawTokens = spec.split(',');
  const matchedPages = new Set<number>();

  for (const rawToken of rawTokens) {
    const token = rawToken.trim();
    assertValidTokenString(token, spec);
    for (const page of parseTokenPages(token, pageCount)) {
      matchedPages.add(page);
    }
  }

  if (matchedPages.size === 0) {
    throw new InvalidPageRangeError(`Page range specification "${spec}" matched 0 pages.`);
  }

  return Array.from(matchedPages).sort((a, b) => a - b);
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

  const rawTokens = spec.split(',');
  for (const rawToken of rawTokens) {
    validateSingleTokenSyntax(rawToken.trim(), spec);
  }
}

function countTokenPages(token: string, maxAllowed: number, userTier: string): number {
  if (!token.includes('-')) {
    const page = Number.parseInt(token, 10);
    if (page > maxAllowed) {
      throw new InvalidPageRangeError(
        `Page ${page} exceeds maximum allowed page (${maxAllowed}) for tier '${userTier}'.`
      );
    }
    return 1;
  }

  const [startPart, endPart] = token.split('-');
  const start = startPart ? Number.parseInt(startPart, 10) : 1;
  const end = endPart ? Number.parseInt(endPart, 10) : undefined;

  if (start > maxAllowed) {
    throw new InvalidPageRangeError(
      `Range start ${start} exceeds maximum allowed page (${maxAllowed}) for tier '${userTier}'.`
    );
  }
  if (end !== undefined) {
    if (end > maxAllowed) {
      throw new InvalidPageRangeError(
        `Range end ${end} exceeds maximum allowed page (${maxAllowed}) for tier '${userTier}'.`
      );
    }
    return end - start + 1;
  }
  return 0;
}

/**
 * Validates that requested page ranges do not exceed maximum page limits for the specified tier.
 */
/** Most pages one request may convert for `userTier`; unknown tiers get the free tier's limit. */
export function tierMaxPages(userTier = 'free'): number {
  return TIER_MAX_PAGES[userTier.toLowerCase()] ?? TIER_MAX_PAGES.free;
}

/** The largest page limit of any tier: no caller-supplied limit can go beyond it. */
export const MAX_TIER_PAGES = Math.max(...Object.values(TIER_MAX_PAGES));

/**
 * Key of the page limit a conversion runs under. It is a symbol, so it cannot come out of request JSON:
 * only server code that knows the caller's tier sets it, with `withTierPageCap`. Options sent by a client
 * (including a `maxPages` field) never reach it.
 */
export const TIER_PAGE_CAP = Symbol.for('easyconvert.tierPageCap');

export interface TierPageCapped {
  [TIER_PAGE_CAP]?: number;
}

/** Copy of `options` that carries `maxPages` as the page limit of the conversion; any client `maxPages` is dropped. */
export function withTierPageCap<T extends object>(options: T | undefined, maxPages: number): T & TierPageCapped {
  const { maxPages: _clientValue, ...rest } = (options ?? {}) as T & { maxPages?: unknown };
  return { ...(rest as T), [TIER_PAGE_CAP]: maxPages };
}

/**
 * The page limit a conversion runs under: the limit set by server code, held to the largest tier's limit,
 * or the free tier's limit when none was set. A set limit that is not a positive integer is refused.
 */
export function resolvePageLimit(options: TierPageCapped | undefined): number {
  const set = options?.[TIER_PAGE_CAP];
  if (set === undefined) return TIER_MAX_PAGES.free;
  if (typeof set !== 'number' || !Number.isInteger(set) || set <= 0) {
    throw new InvalidPageRangeError(`Invalid page limit ${String(set)}: expected a positive whole number of pages`);
  }
  return Math.min(set, MAX_TIER_PAGES);
}

export function validateTierPageLimit(spec: string, userTier = 'free'): void {
  const normalizedTier = userTier.toLowerCase();
  const maxAllowed = TIER_MAX_PAGES[normalizedTier] ?? TIER_MAX_PAGES.free;
  validatePageRangeSyntax(spec);

  const tokens = spec.split(',');
  let estimatedTotal = 0;

  for (const rawToken of tokens) {
    estimatedTotal += countTokenPages(rawToken.trim(), maxAllowed, userTier);
  }

  if (estimatedTotal > maxAllowed) {
    throw new InvalidPageRangeError(
      `Requested page count (${estimatedTotal}) exceeds maximum allowed pages (${maxAllowed}) for tier '${userTier}'.`
    );
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
