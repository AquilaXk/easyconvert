/**
 * What qpdf prints when the page tree reaches one of its own nodes again. A leaf module, free of the qpdf runner and of
 * the page-tree mend, so that the worker and the library can both name the sentence.
 */
export const PAGE_TREE_LOOP_MESSAGE = 'Loop detected in /Pages structure';

/**
 * Whether `text` (the whole standard error of a qpdf run, or a message made from it) reports a page tree that loops.
 * The sentence is not always the first line: qpdf warns about a repeated kid before it refuses the loop.
 */
export function reportsPageTreeLoop(text: string): boolean {
  return text.includes(PAGE_TREE_LOOP_MESSAGE);
}
