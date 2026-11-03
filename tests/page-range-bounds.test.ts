import { describe, it, expect } from 'vitest';
import { parsePageIntervals, parsePageRanges, validatePageRangeSyntax } from '../src/lib/conversions/page-range';
import { InvalidPageRangeError } from '../src/lib/types';

/**
 * A page specification is untrusted text that the web server and the worker read on one thread, so its cost must follow
 * the text and the pages it selects, never the product of the two. The merge of the ranges is the sort-and-join of
 * Chromium's `printing::PageRange::Normalize` (printing/page_range.cc, BSD): overlapping and adjacent ranges become one.
 *
 * Oracle: a plain expansion of every token into a set, written here from the grammar `N | N-M | N- | -M`, which is how the
 * selection was computed before the ranges were merged.
 */

/** The longest specification, in characters (the limit the PDF page operations already had). */
const LONGEST_SPEC_CHARS = 8192;
const REPEATED_RANGE_TOKENS = 600;
const HUGE_PAGE_COUNT = 1_000_000_000;
const RANDOM_SPECS = 300;
const RANDOM_PAGE_COUNT = 40;
const MAX_TOKENS_PER_SPEC = 6;

function expandedWithSet(spec: string, pageCount: number): number[] {
  const pages = new Set<number>();
  for (const token of spec.split(',').map((part) => part.trim())) {
    const [first, last] = token.includes('-') ? token.split('-') : [token, token];
    const start = first === '' ? 1 : Number(first);
    const end = last === '' ? pageCount : Number(last);
    for (let page = start; page <= end; page++) pages.add(page);
  }
  return [...pages].sort((a, b) => a - b);
}

/** A repeatable generator, so a failing spec can be run again. */
function seeded(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) % 4_294_967_296;
    return state / 4_294_967_296;
  };
}

function randomSpec(next: () => number): string {
  const tokens: string[] = [];
  const count = 1 + Math.floor(next() * MAX_TOKENS_PER_SPEC);
  for (let index = 0; index < count; index++) {
    const low = 1 + Math.floor(next() * RANDOM_PAGE_COUNT);
    const high = low + Math.floor(next() * (RANDOM_PAGE_COUNT - low + 1));
    const shape = Math.floor(next() * 4);
    tokens.push(shape === 0 ? `${low}` : shape === 1 ? `${low}-${high}` : shape === 2 ? `${low}-` : `-${high}`);
  }
  return tokens.join(',');
}

describe('the pages a specification selects', () => {
  it('are the same as the plain expansion of every token, for random specifications', () => {
    const next = seeded(7);
    for (let index = 0; index < RANDOM_SPECS; index++) {
      const spec = randomSpec(next);
      expect(parsePageRanges(spec, RANDOM_PAGE_COUNT), spec).toEqual(expandedWithSet(spec, RANDOM_PAGE_COUNT));
    }
  });

  it('are merged into the fewest ranges: overlapping and adjacent ranges join, a gap keeps two', () => {
    expect(parsePageIntervals('1-3,4-6', 10)).toEqual([{ start: 1, end: 6 }]);
    expect(parsePageIntervals('5-8,1-6', 10)).toEqual([{ start: 1, end: 8 }]);
    expect(parsePageIntervals('7,2,3,9-', 12)).toEqual([{ start: 2, end: 3 }, { start: 7, end: 7 }, { start: 9, end: 12 }]);
    expect(parsePageIntervals('2-9,4,5-6', 10)).toEqual([{ start: 2, end: 9 }]);
  });
});

describe('a hostile page specification', () => {
  it('selects the same range however often the token repeats, in a work count that follows the tokens and not the pages', () => {
    const spec = Array(REPEATED_RANGE_TOKENS).fill(`1-${HUGE_PAGE_COUNT}`).join(',');
    expect(parsePageIntervals(spec, HUGE_PAGE_COUNT)).toEqual([{ start: 1, end: HUGE_PAGE_COUNT }]);
  });

  it('keeps its error for a page the document does not have', () => {
    const spec = `${Array(REPEATED_RANGE_TOKENS).fill('1-10').join(',')},11`;
    expect(() => parsePageIntervals(spec, 10)).toThrow(InvalidPageRangeError);
  });

  it('is refused above the longest specification, before any token is read', () => {
    const longest = `${'1,'.repeat(LONGEST_SPEC_CHARS / 2 - 1)}12`;
    expect(longest).toHaveLength(LONGEST_SPEC_CHARS);
    expect(() => validatePageRangeSyntax(longest)).not.toThrow();
    expect(parsePageRanges(longest, 12)).toEqual([1, 12]);
    const tooLong = `${longest},2`;
    expect(() => validatePageRangeSyntax(tooLong)).toThrow(InvalidPageRangeError);
    expect(() => parsePageRanges(tooLong, 12)).toThrow(InvalidPageRangeError);
    expect(() => parsePageIntervals(tooLong, 12)).toThrow(InvalidPageRangeError);
  });
});
