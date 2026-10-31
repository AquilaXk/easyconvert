/**
 * The page counter of a running header or footer: the line that prints which page it is on. A text sheet of a workbook leaves it out,
 * because the sheet is named after the page. A line counts only when its number follows the page index, and a miss keeps the line.
 */

/**
 * A line that is nothing but a page number, as a running header or footer prints it: "3", "Page 3", "3 of 9", "3 / 9", and the same set
 * between dashes or dots ("- 3 -", "— 3 —", "· 3 ·"); the first number is captured.
 */
const PAGE_NUMBER_LINE = /^(?:[-–—·•]\s*)?(?:page\s*)?(\d+)(?:\s*(?:of|\/)\s*\d+)?(?:\s*[-–—·•])?$/i;

/** The number a counter line prints, or undefined when the line is anything else. */
export function printedPageNumber(text: string): number | undefined {
  const match = PAGE_NUMBER_LINE.exec(text.trim());
  return match === null ? undefined : Number(match[1]);
}

/** A one-line header or footer paragraph accepted as running furniture, with the key that groups its pages (page numbers masked). */
export interface FurnitureLine<Block> {
  block: Block;
  key: string;
  text: string;
  pageNumber: number;
}

/**
 * The furniture lines that are page counters. A group of lines with one key is a counter when every line prints a number and all of them
 * differ from their page index by the same offset: 0 for a counter that starts at the first page, another constant for one that starts
 * after an unnumbered cover or front matter. A group that prints the same number on every page, or a number that follows no page, is
 * not a counter and stays. A document of one page has no second page to show a constant, so only its own number (offset 0) counts.
 */
export function pageCounterBlocks<Block>(lines: readonly FurnitureLine<Block>[], pageCount: number): Set<Block> {
  const groups = new Map<string, FurnitureLine<Block>[]>();
  for (const line of lines) {
    const group = groups.get(line.key);
    if (group) group.push(line);
    else groups.set(line.key, [line]);
  }
  const counters = new Set<Block>();
  for (const group of groups.values()) {
    const offsets = group.map((line) => {
      const printed = printedPageNumber(line.text);
      return printed === undefined ? undefined : printed - line.pageNumber;
    });
    const [offset] = offsets;
    if (offset === undefined || offsets.some((other) => other !== offset)) continue;
    if (pageCount === 1 && offset !== 0) continue;
    for (const line of group) counters.add(line.block);
  }
  return counters;
}
