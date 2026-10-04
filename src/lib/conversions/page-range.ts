import { InvalidPageRangeError } from '../types';

export { InvalidPageRangeError };

export interface PageInterval {
  start: number;
  end: number;
}

/**
 * Parses and validates a page range specification string against the total page count.
 * Grammar: N | N-M | N- | -M, comma separated (e.g. "1, 3-5, 8-").
 *
 * Rules:
 * - 1-indexed pages (pages >= 1).
 * - Fails closed on any unexpected characters, 0, page numbers exceeding pageCount,
 *   reverse ranges (start > end), empty tokens (e.g. "1,,2" or ",1"), or bare hyphens.
 * - Deduplicates pages and returns them sorted in ascending order.
 *
 * @param spec Comma-separated page range expression.
 * @param pageCount Total number of pages in the document (must be >= 1).
 * @returns Array of unique, 1-indexed page numbers in ascending order.
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
    if (token === '') {
      throw new InvalidPageRangeError(`Invalid empty page range token in specification: "${spec}".`);
    }

    // Only digits and hyphen allowed
    if (!/^[0-9-]+$/.test(token)) {
      throw new InvalidPageRangeError(`Invalid character in page range token: "${token}". Only digits and hyphens are allowed.`);
    }

    if (!token.includes('-')) {
      // Single page number: N
      const page = Number.parseInt(token, 10);
      if (Number.isNaN(page) || page < 1) {
        throw new InvalidPageRangeError(`Invalid page number: "${token}". Page numbers must be >= 1.`);
      }
      if (page > pageCount) {
        throw new InvalidPageRangeError(`Page number ${page} exceeds document page count of ${pageCount}.`);
      }
      matchedPages.add(page);
    } else {
      // Range token containing '-'
      const hyphenCount = (token.match(/-/g) || []).length;
      if (hyphenCount !== 1) {
        throw new InvalidPageRangeError(`Invalid range format: "${token}". Exactly one hyphen is allowed per range.`);
      }

      const [startPart, endPart] = token.split('-');

      if (startPart === '' && endPart === '') {
        throw new InvalidPageRangeError(`Bare hyphen "-" is not a valid page range.`);
      }

      if (startPart !== '' && endPart === '') {
        // Open-ended start: N- (from N to pageCount)
        const start = Number.parseInt(startPart, 10);
        if (Number.isNaN(start) || start < 1) {
          throw new InvalidPageRangeError(`Invalid range start: "${startPart}". Page numbers must be >= 1.`);
        }
        if (start > pageCount) {
          throw new InvalidPageRangeError(`Range start ${start} exceeds document page count of ${pageCount}.`);
        }
        for (let p = start; p <= pageCount; p++) {
          matchedPages.add(p);
        }
      } else if (startPart === '' && endPart !== '') {
        // Open-ended end: -M (from 1 to M)
        const end = Number.parseInt(endPart, 10);
        if (Number.isNaN(end) || end < 1) {
          throw new InvalidPageRangeError(`Invalid range end: "${endPart}". Page numbers must be >= 1.`);
        }
        if (end > pageCount) {
          throw new InvalidPageRangeError(`Range end ${end} exceeds document page count of ${pageCount}.`);
        }
        for (let p = 1; p <= end; p++) {
          matchedPages.add(p);
        }
      } else {
        // Closed range: N-M
        const start = Number.parseInt(startPart, 10);
        const end = Number.parseInt(endPart, 10);
        if (Number.isNaN(start) || start < 1) {
          throw new InvalidPageRangeError(`Invalid range start: "${startPart}". Page numbers must be >= 1.`);
        }
        if (Number.isNaN(end) || end < 1) {
          throw new InvalidPageRangeError(`Invalid range end: "${endPart}". Page numbers must be >= 1.`);
        }
        if (start > pageCount || end > pageCount) {
          throw new InvalidPageRangeError(`Range ${start}-${end} exceeds document page count of ${pageCount}.`);
        }
        if (start > end) {
          throw new InvalidPageRangeError(`Range start ${start} cannot exceed range end ${end}.`);
        }
        for (let p = start; p <= end; p++) {
          matchedPages.add(p);
        }
      }
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
 *
 * This allows efficient multi-page extraction via tools that support range arguments (e.g. pdftoppm -f -l).
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

/**
 * Maximum pages allowed per conversion request by user subscription tier.
 */
export const TIER_MAX_PAGES: Record<string, number> = {
  free: 50,
  pro: 500,
  enterprise: 2000,
};

/**
 * Validates the syntactic validity of a page range string without requiring a known total page count.
 * Grammar: N | N-M | N- | -M, comma separated.
 * Checks for invalid characters, empty tokens, bare hyphens, and start > end.
 */
export function validatePageRangeSyntax(spec: string): void {
  if (typeof spec !== 'string' || spec.trim() === '') {
    throw new InvalidPageRangeError('Page range specification must be a non-empty string.');
  }

  const rawTokens = spec.split(',');
  for (const rawToken of rawTokens) {
    const token = rawToken.trim();
    if (token === '') {
      throw new InvalidPageRangeError(`Invalid empty page range token in specification: "${spec}".`);
    }

    if (!/^[0-9-]+$/.test(token)) {
      throw new InvalidPageRangeError(`Invalid character in page range token: "${token}". Only digits and hyphens are allowed.`);
    }

    if (!token.includes('-')) {
      const page = Number.parseInt(token, 10);
      if (Number.isNaN(page) || page < 1) {
        throw new InvalidPageRangeError(`Invalid page number: "${token}". Page numbers must be >= 1.`);
      }
    } else {
      const hyphenCount = (token.match(/-/g) || []).length;
      if (hyphenCount !== 1) {
        throw new InvalidPageRangeError(`Invalid range format: "${token}". Exactly one hyphen is allowed per range.`);
      }

      const [startPart, endPart] = token.split('-');
      if (startPart === '' && endPart === '') {
        throw new InvalidPageRangeError('Bare hyphen "-" is not a valid page range.');
      }

      let start: number | undefined;
      let end: number | undefined;

      if (startPart !== '') {
        start = Number.parseInt(startPart, 10);
        if (Number.isNaN(start) || start < 1) {
          throw new InvalidPageRangeError(`Invalid range start: "${startPart}". Page numbers must be >= 1.`);
        }
      }

      if (endPart !== '') {
        end = Number.parseInt(endPart, 10);
        if (Number.isNaN(end) || end < 1) {
          throw new InvalidPageRangeError(`Invalid range end: "${endPart}". Page numbers must be >= 1.`);
        }
      }

      if (start !== undefined && end !== undefined && start > end) {
        throw new InvalidPageRangeError(`Range start ${start} cannot exceed range end ${end}.`);
      }
    }
  }
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
    const token = rawToken.trim();
    if (!token.includes('-')) {
      const page = Number.parseInt(token, 10);
      if (page > maxAllowed) {
        throw new InvalidPageRangeError(
          `Page ${page} exceeds maximum allowed page (${maxAllowed}) for tier '${userTier}'.`
        );
      }
      estimatedTotal += 1;
    } else {
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
        estimatedTotal += end - start + 1;
      }
    }
  }

  if (estimatedTotal > maxAllowed) {
    throw new InvalidPageRangeError(
      `Requested page count (${estimatedTotal}) exceeds maximum allowed pages (${maxAllowed}) for tier '${userTier}'.`
    );
  }
}
