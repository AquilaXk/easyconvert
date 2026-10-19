import { PdfPostprocessError } from '../../types';
import { repairPageTree } from './page-tree';

/** What qpdf prints when the page tree reaches one of its own nodes again. */
const PAGE_TREE_LOOP_MESSAGE = 'Loop detected in /Pages structure';

/** Whether `error` is qpdf's refusal of a page tree that loops. */
export function isQpdfLoopRefusal(error: unknown): boolean {
  return error instanceof PdfPostprocessError && error.message.includes(PAGE_TREE_LOOP_MESSAGE);
}

/**
 * Whether `error` is the in-process PDF parser running out of stack: it follows /Kids without a visited set, so a tree
 * that loops ends there. A tree that is only very deep ends there too, and `repairPageTree` leaves such a file as it is,
 * so the refusal stays.
 */
export function isParserLoopRefusal(error: unknown): boolean {
  return error instanceof RangeError && error.message.includes('call stack');
}

/**
 * `run` on `plain`; when `run` fails with a refusal of a page tree that loops (`isLoopRefusal`: qpdf's by default), `run`
 * once more on the mended tree (see page-tree). A document that `run` reads costs nothing extra, and a loop that cannot
 * be mended keeps the first refusal.
 */
export async function withMendedPageTree<T>(
  plain: Buffer,
  run: (pdf: Buffer) => Promise<T>,
  isLoopRefusal: (error: unknown) => boolean = isQpdfLoopRefusal
): Promise<T> {
  try {
    return await run(plain);
  } catch (error) {
    if (!isLoopRefusal(error)) throw error;
    const mended = await repairPageTree(plain);
    if (mended === plain) throw error;
    return run(mended);
  }
}
