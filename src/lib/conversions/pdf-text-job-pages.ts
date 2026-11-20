import { pageOutOfBounds, resolvePageSelection } from './page-range';
import { PDF_TEXT_MAX_PAGES, PdfTextGeometryError, type PdfTextJob } from './pdf-text-types';

/** A job whose page selection is resolved against the page count of the open document: `only` holds the pages it reads. */
export type PagedJob = PdfTextJob & { only?: ReadonlySet<number> };

export function requirePages(explicit: Set<number> | null, pageCount: number): void {
  for (const pageNumber of explicit ?? []) {
    if (!Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > pageCount) {
      throw new PdfTextGeometryError(`PDF page ${pageNumber} does not exist; the document has ${pageCount} pages.`);
    }
  }
}

/**
 * The job with the pages of its `select` resolved, so that every part of it reads only those pages.
 * @throws InvalidPageRangeError when the selection names a page the document does not have, or is not a page range.
 */
export function pagedJob(job: PdfTextJob, pageCount: number): PagedJob {
  const selected = resolvePageSelection(job.select?.page, job.select?.pages, pageCount, pageOutOfBounds);
  return selected === undefined ? job : { ...job, only: new Set(selected) };
}

/** The refusal of a job that reads more pages than `PDF_TEXT_MAX_PAGES`: the pages it selects, or the document's when it selects none; null when it reads no more. */
export function pageLimitMessage(job: PagedJob, pageCount: number): string | null {
  const read = job.only?.size ?? pageCount;
  if (read <= PDF_TEXT_MAX_PAGES) return null;
  return job.only === undefined ? `PDF has ${pageCount} pages; at most ${PDF_TEXT_MAX_PAGES} can be read.` : `The selection reads ${read} pages; at most ${PDF_TEXT_MAX_PAGES} can be read.`;
}
