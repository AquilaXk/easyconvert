import { UnsupportedOptionError } from '../lib/types';
import { readSandboxOutput, writeSandboxOutput } from '../lib/security/sandbox-output';
import { pageOutOfBounds, pageSelectionOf, resolvePageIntervals } from '../lib/conversions/page-range';
import type { PageInterval } from '../lib/conversions/page-intervals';
import type { WorkerEngineOptions } from './worker-types';

/**
 * pdftotext flags for a text export. The default is poppler's reading-order mode, which follows
 * the page's own text flow and reads columns one after another. `layout: true` keeps physical
 * layout (`-layout`) so table rows stay on one line. Any other `layout` value is a client error.
 */
export function buildPdftotextArgs(options: WorkerEngineOptions): string[] {
  if (options.layout === undefined || options.layout === false) return [];
  if (options.layout === true) return ['-layout'];
  throw new UnsupportedOptionError('The layout option must be a boolean.');
}

/** pdftotext ends every page it writes with a form feed, the last one too (`-nopgbrk` would leave them out; the export never asks). */
const PAGE_BREAK = 0x0c;

/** The pages a pdftotext run reads for a request: its flags, and what to do with the text it writes. */
export interface PopplerTextPages {
  /** `-f` and `-l`: the first and the last selected page; none when the request selects no page. */
  args: string[];
  /** Cuts the pages between the first and the last selected page that the request did not select out of the text file pdftotext wrote. */
  keepSelected(outputPath: string): void;
}

const EVERY_PAGE: PopplerTextPages = { args: [], keepSelected: () => undefined };

/** The text of the pages of `text` (page `first` on) that `selected` keeps, each with its page break. */
function selectedPagesText(text: Buffer, first: number, selected: readonly PageInterval[]): Buffer {
  const kept: Buffer[] = [];
  let pageNumber = first;
  let start = 0;
  for (let end = text.indexOf(PAGE_BREAK); end !== -1; end = text.indexOf(PAGE_BREAK, start)) {
    if (selected.some((interval) => pageNumber >= interval.start && pageNumber <= interval.end)) kept.push(text.subarray(start, end + 1));
    pageNumber++;
    start = end + 1;
  }
  return Buffer.concat(kept);
}

/**
 * The pages poppler's `pdftotext -f -l` reads for the request's `page` and `pages`, as the page-image chains select them (page-range.ts).
 * `pdftotext` takes one run of pages, so a selection with gaps (`1,4-5`) reads from its first to its last page and the text of the
 * pages between them is cut from the file afterwards, which reads the document once and leaves every selected page as it was.
 * @param pageCount reads the page count of the document; asked only when the request selects pages.
 * @throws InvalidPageRangeError when the request selects a page the document does not have.
 */
export async function popplerTextPages(options: WorkerEngineOptions, pageCount: () => Promise<number>): Promise<PopplerTextPages> {
  const selection = pageSelectionOf(options);
  if (selection === undefined) return EVERY_PAGE;
  const selected = resolvePageIntervals(selection.page, selection.pages, await pageCount(), pageOutOfBounds);
  if (selected === undefined) return EVERY_PAGE;
  const first = selected[0].start;
  const last = selected[selected.length - 1].end;
  return {
    args: ['-f', String(first), '-l', String(last)],
    keepSelected: (outputPath) => {
      if (selected.length > 1) writeSandboxOutput(outputPath, selectedPagesText(readSandboxOutput(outputPath), first, selected));
    },
  };
}
