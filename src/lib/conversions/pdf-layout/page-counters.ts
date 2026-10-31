/**
 * The page counter of a running header or footer: the line that prints which page it is on. A text sheet of a workbook leaves it out,
 * because the sheet is named after the page. A line counts only when its number follows the page index, and a miss keeps the line.
 */

/** How a counter line is written: the number alone, a fraction ("3 / 9"), or with a word or paired marks around it ("Page 3", "3 of 9", "- 3 -"). */
export type CounterForm = 'bare' | 'fraction' | 'decorated';

/** The forms a line can have, each with the number it prints in the group `n`. A mark before the number needs the same mark after it. */
const COUNTER_FORMS: readonly (readonly [CounterForm, RegExp])[] = [
  ['bare', /^(?<n>\d+)$/],
  ['fraction', /^(?<n>\d+)\s*\/\s*\d+$/],
  ['decorated', /^page\s*(?<n>\d+)(?:\s*(?:of|\/)\s*\d+)?$/i],
  ['decorated', /^(?<n>\d+)\s*of\s*\d+$/i],
  ['decorated', /^(?<mark>[-–—·•])\s*(?:page\s*)?(?<n>\d+)(?:\s*(?:of|\/)\s*\d+)?\s*\k<mark>$/i],
];

export interface PrintedCounter {
  number: number;
  form: CounterForm;
}

/** The number a counter line prints and the form it is written in, or undefined when the line is anything else. */
export function printedCounter(text: string): PrintedCounter | undefined {
  const line = text.trim();
  for (const [form, pattern] of COUNTER_FORMS) {
    const match = pattern.exec(line);
    if (match?.groups) return { number: Number(match.groups.n), form };
  }
  return undefined;
}

/** A one-line header or footer paragraph accepted as running furniture, with the key that groups its pages (page numbers masked). */
export interface FurnitureLine<Block> {
  block: Block;
  key: string;
  text: string;
  pageNumber: number;
}

/** Pages a group must span for a counter that does not start at page 1: two pages show no constant, and a bare run of numbers is text. */
const MIN_PAGES_FOR_OFFSET = 3;
/** Pages a group of bare numbers must span: one page shows no recurrence, and a lone "1" in the top band is a section number. */
const MIN_PAGES_FOR_BARE = 2;

/**
 * The furniture lines that are page counters. A group of lines with one key is a counter when every line prints a number and all of them
 * differ from their page index by the same offset. Offset 0 is a counter that starts at the first page, in any form, except a bare number
 * on one page. Another constant is a counter that starts after an unnumbered cover or front matter; it is taken only in a decorated form
 * ("Page 3", "3 of 9", "- 3 -") over at least three pages, because a run of bare numbers, fractions or years ("1001", "1002", "1003", or
 * "1/3", "2/3", "3/3" on later pages) is text that happens to be consecutive. A group that prints the same number on every page, or a
 * number that follows no page, is not a counter and stays: the error of a wrong guess is one counter kept in a row, never text lost.
 */
export function pageCounterBlocks<Block>(lines: readonly FurnitureLine<Block>[]): Set<Block> {
  const groups = new Map<string, FurnitureLine<Block>[]>();
  for (const line of lines) {
    const group = groups.get(line.key);
    if (group) group.push(line);
    else groups.set(line.key, [line]);
  }
  const counters = new Set<Block>();
  for (const group of groups.values()) {
    const printed = group.map((line) => printedCounter(line.text));
    const offsets = printed.map((counter, at) => (counter === undefined ? undefined : counter.number - group[at].pageNumber));
    const [offset] = offsets;
    if (offset === undefined || offsets.some((other) => other !== offset)) continue;
    const forms = printed.map((counter) => counter?.form);
    const pageCount = new Set(group.map((line) => line.pageNumber)).size;
    const accepted =
      offset === 0
        ? pageCount >= MIN_PAGES_FOR_BARE || forms.some((form) => form !== 'bare')
        : pageCount >= MIN_PAGES_FOR_OFFSET && forms.every((form) => form === 'decorated');
    if (!accepted) continue;
    for (const line of group) counters.add(line.block);
  }
  return counters;
}
