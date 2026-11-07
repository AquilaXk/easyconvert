/** Page intervals and the pure arithmetic on them. This module imports nothing, so the browser and edge code can use it without the worker's error types. */

export interface PageInterval {
  start: number;
  end: number;
}

/**
 * The intervals sorted and joined where they overlap or touch, the pass of Chromium's `printing::PageRange::Normalize`
 * (printing/page_range.cc): the cost is the sort of the intervals, whatever pages they name. The input is left as it is.
 */
export function mergeIntervals(intervals: readonly PageInterval[]): PageInterval[] {
  const sorted = intervals.map(({ start, end }) => ({ start, end })).sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: PageInterval[] = [];
  for (const next of sorted) {
    const last = merged[merged.length - 1];
    if (last === undefined || last.end + 1 < next.start) merged.push(next);
    else last.end = Math.max(last.end, next.end);
  }
  return merged;
}

/** The pages of `intervals` as an ascending list. */
export function pagesOfIntervals(intervals: readonly PageInterval[]): number[] {
  const pages: number[] = [];
  for (const { start, end } of intervals) {
    for (let page = start; page <= end; page++) pages.push(page);
  }
  return pages;
}

/** How many pages `intervals` select. */
export function pageCountOfIntervals(intervals: readonly PageInterval[]): number {
  return intervals.reduce((total, { start, end }) => total + end - start + 1, 0);
}
