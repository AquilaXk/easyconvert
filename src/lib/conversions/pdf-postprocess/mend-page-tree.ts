import { PdfPostprocessError } from '../../types';
import { reportsPageTreeLoop } from './page-tree-loop';
import { repairPageTree } from './page-tree';
import { runQpdf, type QpdfWorkspace } from './qpdf-run';

/** Whether `error` is qpdf's refusal of a page tree that loops. */
export function isQpdfLoopRefusal(error: unknown): boolean {
  return error instanceof PdfPostprocessError && reportsPageTreeLoop(error.message);
}

/** How a failed run reports a page tree that loops, and whether that report is certain enough to skip asking qpdf again. */
export interface LoopRefusal {
  matches: (error: unknown) => boolean;
  /** True when the report is qpdf's own, so the mend need not list the pages again to learn that the tree loops. */
  confirmsLoop: boolean;
}

export const QPDF_LOOP_REFUSAL: LoopRefusal = { matches: isQpdfLoopRefusal, confirmsLoop: true };

/**
 * The in-process PDF parser running out of stack: it follows /Kids without a visited set, so a tree that loops ends
 * there. A tree that is only very deep ends there too, and `repairPageTree` leaves such a file as it is (it lists the
 * pages first), so the refusal stays.
 */
export const PARSER_LOOP_REFUSAL: LoopRefusal = {
  matches: (error) => error instanceof RangeError && error.message.includes('call stack'),
  confirmsLoop: false,
};

/**
 * `run` on `plain`; when `run` fails with a refusal of a page tree that loops (`refusal`: qpdf's by default), `run`
 * once more on the mended tree (see page-tree). A document that `run` reads costs nothing extra, and a loop that cannot
 * be mended keeps the first refusal.
 */
export async function withMendedPageTree<T>(
  plain: Buffer,
  run: (pdf: Buffer) => Promise<T>,
  refusal: LoopRefusal = QPDF_LOOP_REFUSAL
): Promise<T> {
  try {
    return await run(plain);
  } catch (error) {
    if (!refusal.matches(error)) throw error;
    const mended = await repairPageTree(plain, { knownLooping: refusal.confirmsLoop });
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
