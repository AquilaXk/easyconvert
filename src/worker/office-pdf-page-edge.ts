import { getMaxInMemoryBytes } from '../lib/storage/errors';
import { wordsPastPageEdge } from '../lib/conversions/pdf-page-edge';
import { pagesPhrase } from '../lib/conversions/pdf-text-types';

/**
 * The check behind the choice between the office suite's PDF of an HTML page and the in-process renderer's
 * (docs/policy-decisions.md entry 90): whether the office suite's PDF has words past the edge of their page.
 */

/** Wall-clock budget of the check of one PDF, in milliseconds; the host's own limit (60 s) applies when it is shorter. */
export const PAGE_EDGE_CHECK_DEADLINE_MS = 10_000;

/** A PDF as the worker holds it: its size, and its bytes read on demand. */
interface OfficePdf {
  readonly size: number;
  readonly buffer: Buffer;
}

/**
 * What is wrong with the PDF's pages, as a sentence naming the words and pages, or `null` when no word is past an edge. A PDF
 * that cannot be checked (bigger than the in-memory limit, not readable, the check out of time or over the PDF text reader's
 * limits) is answered `null` too: the check must never refuse or delay a PDF the office suite drew, so it leaves it as it is.
 */
export async function wordsPastEdgeOfOfficePdf(pdf: OfficePdf): Promise<string | null> {
  if (pdf.size > getMaxInMemoryBytes()) return null;
  try {
    const { words, pages } = await wordsPastPageEdge(pdf.buffer, PAGE_EDGE_CHECK_DEADLINE_MS);
    return words === 0 ? null : `${words} ${words === 1 ? 'word' : 'words'} past the page edge on ${pagesPhrase(pages)}`;
  } catch {
    return null;
  }
}
