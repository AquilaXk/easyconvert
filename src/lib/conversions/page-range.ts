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
