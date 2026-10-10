import { PayloadLimitError } from '../types';

/**
 * Wall-clock work the OCR of one document may cost. A scanned page costs about the same however many pages follow
 * it, so the budget grows with the pages to read: a long, legitimate scan is never cut at a fixed time, while a page
 * that never ends or costs far more than a page should is stopped.
 *
 * The default page budget is measured. Read one at a time, a page of the real-world scans (300 dpi CCITT, 56 to 73
 * pages each) costs 1.0 to 1.5 s at the median and 4.4 s at most on a fast 12-core machine; about 1.2 to 1.6 CPU
 * seconds a page across all work. 10 s a page is more than twice the worst page measured there and leaves room for a
 * runner several times slower and shared by other jobs.
 */
export const OCR_PAGE_BUDGET_MS = 10_000;
/** Environment variable that overrides the page budget (milliseconds); tests use it to keep CI fast. */
export const OCR_PAGE_BUDGET_ENV = 'EASYCONVERT_OCR_PAGE_BUDGET_MS';
/** Start-up allowance of a document, in page budgets: opening the PDF, starting the engine and loading language data. */
export const OCR_ALLOWANCE_PAGES = 3;
/** One page may take this many page budgets (render, and every reading of it) before it is refused as pathological. */
export const OCR_PAGE_GUARD_PAGES = 6;
/** Share of a job's own deadline the OCR may use, so that the refusal arrives before the deadline and the output can still be written. */
export const OCR_JOB_DEADLINE_SHARE = 0.9;
/** Longest delay a timer takes. */
const MAX_TIMER_MS = 2_147_483_647;

/** A document or page whose OCR would cost more than its budget; HTTP 413, like the other limits on the size of the work. */
export class OcrWorkLimitError extends PayloadLimitError {
  constructor(message: string) {
    super(message);
    this.name = 'OcrWorkLimitError';
  }
}

/** The page budget in milliseconds: the environment override when it is a positive integer, otherwise the default. */
export function ocrPageBudgetMs(): number {
  const override = Number(process.env[OCR_PAGE_BUDGET_ENV]);
  return Number.isInteger(override) && override > 0 ? override : OCR_PAGE_BUDGET_MS;
}

/** Milliseconds `pages` pages may take: the start-up allowance plus one page budget for each, and never past the job's own deadline. */
export function ocrDocumentBudgetMs(pages: number, jobDeadlineMs?: number): number {
  const pageBudget = ocrPageBudgetMs();
  const total = (OCR_ALLOWANCE_PAGES + pages) * pageBudget;
  if (jobDeadlineMs === undefined || !(jobDeadlineMs > 0)) return total;
  return Math.max(1, Math.min(total, Math.floor(jobDeadlineMs * OCR_JOB_DEADLINE_SHARE)));
}

/**
 * The time one document's OCR has left, and the guard of each page. A page is checked before it starts and raced
 * against the time left and against its own limit, so a page that never ends does not hold the document to the
 * engine's own timeouts (60 s to render, 120 s per reading); its work is left to those timeouts and its result is
 * dropped.
 */
export class OcrWorkBudget {
  private readonly startedAt = performance.now();
  private readonly limitMs: number;
  private readonly pageLimitMs = ocrPageBudgetMs() * OCR_PAGE_GUARD_PAGES;
  private pagesRead = 0;
  private readonly cancellation = new AbortController();

  /**
   * @param jobSignal the job's own signal (its deadline, a cancel): when it fires the document is over like when a page is
   * refused, so the pages in flight stop and a page not started never starts.
   */
  constructor(
    private readonly pagesTotal: number,
    jobDeadlineMs?: number,
    jobSignal?: AbortSignal
  ) {
    this.limitMs = ocrDocumentBudgetMs(pagesTotal, jobDeadlineMs);
    if (jobSignal) {
      if (jobSignal.aborted) this.cancellation.abort(jobSignal.reason);
      else jobSignal.addEventListener('abort', () => this.cancellation.abort(jobSignal.reason), { once: true });
    }
  }

  private remainingMs(): number {
    return this.limitMs - (performance.now() - this.startedAt);
  }

  private documentError(): OcrWorkLimitError {
    return new OcrWorkLimitError(
      `Recognizing this document needs more than the ${this.limitMs} ms allowed for ${this.pagesTotal} pages (${OCR_PAGE_BUDGET_ENV} sets the time for one page); ` +
        `${this.pagesRead} of ${this.pagesTotal} pages were read. Select a page range or split the document.`
    );
  }

  private pageError(pageNumber: number): OcrWorkLimitError {
    return new OcrWorkLimitError(
      `Page ${pageNumber} needs more than ${this.pageLimitMs} ms to recognize, ${OCR_PAGE_GUARD_PAGES} times the ${ocrPageBudgetMs()} ms budget of a page (${OCR_PAGE_BUDGET_ENV}). ` +
        `${this.pagesRead} of ${this.pagesTotal} pages were read. Select a page range without it.`
    );
  }

  /**
   * Runs the work of one page, which gets a signal that fires as soon as any page of the document is refused or
   * fails: the document is over then, and the pages still being drawn or read stop at their next stage and give
   * their place in the engine to the next job instead of finishing work nobody waits for.
   * @throws OcrWorkLimitError (413) when the document has used up its budget, or the page takes more than its own limit.
   */
  async guardPage<T>(pageNumber: number, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const signal = this.cancellation.signal;
    signal.throwIfAborted();
    const remaining = this.remainingMs();
    let timer: NodeJS.Timeout | undefined;
    let onOver: (() => void) | undefined;
    try {
      if (remaining <= 0) throw this.documentError();
      const documentIsNearer = remaining <= this.pageLimitMs;
      // The page also ends when the document is over (a refused page, or the job's own signal), even when its work
      // does not look at the signal.
      const over = new Promise<never>((_, reject) => {
        onOver = () => reject(signal.reason);
        signal.addEventListener('abort', onOver, { once: true });
      });
      const expired = new Promise<never>((_, reject) => {
        const delay = Math.min(MAX_TIMER_MS, Math.ceil(documentIsNearer ? remaining : this.pageLimitMs));
        timer = setTimeout(() => reject(documentIsNearer ? this.documentError() : this.pageError(pageNumber)), delay);
      });
      const pending = work(signal);
      pending.catch(() => undefined);
      const result = await Promise.race([pending, expired, over]);
      this.pagesRead++;
      return result;
    } catch (error) {
      if (!signal.aborted) this.cancellation.abort(error);
      throw error;
    } finally {
      clearTimeout(timer);
      if (onOver) signal.removeEventListener('abort', onOver);
    }
  }
}
