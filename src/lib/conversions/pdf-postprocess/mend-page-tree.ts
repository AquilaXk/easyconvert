import { PdfPostprocessError } from '../../types';
import { repairPageTree } from './page-tree';
import { runQpdf, type QpdfWorkspace } from './qpdf-run';

/** What qpdf prints when the page tree reaches one of its own nodes again. */
export const PAGE_TREE_LOOP_MESSAGE = 'Loop detected in /Pages structure';

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

/**
 * Whether qpdf refuses the pages of the document in `workspace` because their tree loops. Any other failure answers
 * false: the steps that follow answer as they would without the question. Meant to run beside another qpdf run on the same file.
 */
export async function pageTreeLoops(workspace: QpdfWorkspace, signal?: AbortSignal): Promise<boolean> {
  try {
    await runQpdf(workspace, { args: ['--show-pages', workspace.inputPath], action: 'Reading the pages', signal });
    return false;
  } catch (error) {
    return isQpdfLoopRefusal(error);
  }
}
