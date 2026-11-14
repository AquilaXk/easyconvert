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
/**
 * What a document may spend on second readings by the ONNX engine (policy decision 299), as a share of the time the document has
 * run (5%), plus a start allowance (3 s). A second reading is an extra beside the Tesseract readings that the budget was measured on, and on a
 * document that Tesseract scores low on most pages (a scanned form) it found less text than Tesseract on five of six pages, so the
 * spend is capped instead of left to the number of pages that score low.
 */
export const OCR_RESCUE_SHARE = 0.05;
export const OCR_RESCUE_ALLOWANCE_MS = 3_000;
/** A second reading is not started when the document has less than this many page budgets left. */
export const OCR_RESCUE_MIN_REMAINING_PAGES = 3;
/**
 * No second reading is started while a page of the document has been at its own work for this share of its limit: the reading takes
 * CPU from the page workers, and a page that is that far on is the one that it would push over (a form that Tesseract reads in 55 s
 * of the 60 s allowed ran past the limit when readings of other pages ran beside it).
 */
export const OCR_RESCUE_SLOW_PAGE_SHARE = 0.4;
/** What a second reading is assumed to cost until one has been timed. */
const OCR_RESCUE_FIRST_GUESS_MS = 3_000;
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
 * What a page may ask of its document for a second reading by the ONNX engine. `run` starts the reading when the document can
 * afford it and answers null when it cannot (the page keeps its Tesseract reading); while the reading runs the page's own time limit
 * stands still, since the time a reading waits for the engine and the CPU other pages take from it are not the page's own work. The
 * document's budget and the job's deadline keep counting.
 */
export interface OcrRescueGate {
  run<T>(task: () => Promise<T>): Promise<T | null>;
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
  private readonly pagesInFlight = new Set<{ startedAt: number; pausedMs: number; pausedAt: number | null }>();
  private rescueSpentMs = 0;
  private rescuesStarted = 0;
  private rescuesRunning = 0;

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

  /** Whether one more second reading fits in the share of the document's time that they may take, and in the time it has left. */
  private canRescue(): boolean {
    const elapsed = performance.now() - this.startedAt;
    if (this.remainingMs() < OCR_RESCUE_MIN_REMAINING_PAGES * ocrPageBudgetMs()) return false;
    const now = performance.now();
    for (const page of this.pagesInFlight) {
      const own = now - page.startedAt - page.pausedMs;
      if (page.pausedAt === null && own >= OCR_RESCUE_SLOW_PAGE_SHARE * this.pageLimitMs) return false;
    }
    const finished = this.rescuesStarted - this.rescuesRunning;
    const typical = finished > 0 ? this.rescueSpentMs / finished : OCR_RESCUE_FIRST_GUESS_MS;
    return this.rescueSpentMs + (this.rescuesRunning + 1) * typical <= OCR_RESCUE_ALLOWANCE_MS + OCR_RESCUE_SHARE * elapsed;
  }

  private rescueGate(pause: () => void, resume: () => void): OcrRescueGate {
    return {
      run: async <T,>(task: () => Promise<T>): Promise<T | null> => {
        if (!this.canRescue()) return null;
        const started = performance.now();
        this.rescuesStarted++;
        this.rescuesRunning++;
        pause();
        try {
          return await task();
        } finally {
          resume();
          this.rescuesRunning--;
          this.rescueSpentMs += performance.now() - started;
        }
      },
    };
  }

  /**
   * Runs the work of one page, which gets a signal that fires as soon as any page of the document is refused or
   * fails: the document is over then, and the pages still being drawn or read stop at their next stage and give
   * their place in the engine to the next job instead of finishing work nobody waits for. It also gets the gate of
   * its second readings (`OcrRescueGate`).
   * @throws OcrWorkLimitError (413) when the document has used up its budget, or the page takes more than its own limit.
   */
  async guardPage<T>(pageNumber: number, work: (signal: AbortSignal, rescue: OcrRescueGate) => Promise<T>): Promise<T> {
    const signal = this.cancellation.signal;
    signal.throwIfAborted();
    let timer: NodeJS.Timeout | undefined;
    let onOver: (() => void) | undefined;
    let clock: { startedAt: number; pausedMs: number; pausedAt: number | null } | undefined;
    try {
      if (this.remainingMs() <= 0) throw this.documentError();
      // The page also ends when the document is over (a refused page, or the job's own signal), even when its work
      // does not look at the signal.
      const over = new Promise<never>((_, reject) => {
        onOver = () => reject(signal.reason);
        signal.addEventListener('abort', onOver, { once: true });
      });
      let expire: (error: OcrWorkLimitError) => void = () => undefined;
      const expired = new Promise<never>((_, reject) => {
        expire = reject;
      });
      // The page's own time: the time since it started, less the time a second reading of it was running. The timer is set again when
      // that reading starts and ends, and it fires for whichever of the page limit and the document's time is nearer.
      const own = { startedAt: performance.now(), pausedMs: 0, pausedAt: null as number | null };
      clock = own;
      this.pagesInFlight.add(own);
      const arm = (): void => {
        clearTimeout(timer);
        const remaining = this.remainingMs();
        const pageRemaining = own.pausedAt === null ? this.pageLimitMs - (performance.now() - own.startedAt - own.pausedMs) : Infinity;
        const documentIsNearer = remaining <= pageRemaining;
        const delay = Math.min(MAX_TIMER_MS, Math.max(1, Math.ceil(documentIsNearer ? remaining : pageRemaining)));
        timer = setTimeout(() => expire(documentIsNearer ? this.documentError() : this.pageError(pageNumber)), delay);
      };
      const rescue = this.rescueGate(
        () => {
          own.pausedAt = performance.now();
          arm();
        },
        () => {
          own.pausedMs += performance.now() - (own.pausedAt ?? performance.now());
          own.pausedAt = null;
          arm();
        }
      );
      arm();
      const pending = work(signal, rescue);
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
      if (clock) this.pagesInFlight.delete(clock);
    }
  }
}
