import { ConversionFailedError, CorruptStreamError, PayloadLimitError } from '../types';
import { DJVU_MAX_PAGES } from './djvu-container';
import { assertInputPixels } from './image-input-limits';

/**
 * What `djvused` of djvulibre 3.5.28 says about a document: its page count and the size of every page. The program that draws a
 * document is also the one that decides what its pages are, so the worker asks it (tools/djvused.cpp `command_n` and
 * `command_size`, lines 481 to 610) and takes its answer, in place of a model of its own. A page is a directory entry with the
 * page flag (`DjVmDir::File::is_page`); the size of a `FORM:DJVU` page is the width and height of its `INFO` chunk, and of a
 * `FORM:BM44` or `FORM:PM44` page the size its first wavelet chunk declares (`print_size`, lines 551 to 593).
 *
 * Two runs, because `n` reads the directory alone, while `size` opens every page and creates the files it includes
 * (djvu-render.ts decides what its failure means). They are not one `n;size` run: the program's output is buffered, so a crash
 * in `size` loses the count `n` printed, and a failure of the directory could not be told from a failure of the pages. The
 * first run prints the count and nothing else; the second prints a line `width=W height=H` for each page that has a size. The
 * output is parsed strictly: a line of another shape, a count that disagrees with the sizes, and a size of zero all end the
 * conversion. No id, name or title of a file is printed by either run.
 */

/** The first run: the page count. */
export const DJVUSED_PAGE_COUNT_SCRIPT = 'n';
/** The second run: the size of every page, which opens the pages and the files they include. */
export const DJVUSED_SIZE_SCRIPT = 'size';

/** The most `djvused` may print, standard error included: the sizes are 24 bytes a page, 240,000 bytes for the page limit. */
export const DJVUSED_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

export interface DjvuPageSize {
  readonly width: number;
  readonly height: number;
}

const COUNT_LINE = /^\d+$/;
const SIZE_LINE = /^width=(\d+) height=(\d+)(?: rotation=\d+)?$/;

function malformed(line: string): ConversionFailedError {
  return new ConversionFailedError(`djvused printed a line that this converter does not read: ${JSON.stringify(line.slice(0, 80))}`);
}

function sizeOf(line: string): DjvuPageSize {
  const found = SIZE_LINE.exec(line);
  if (found === null) throw malformed(line);
  const width = Number(found[1]);
  const height = Number(found[2]);
  if (width === 0 || height === 0) throw new CorruptStreamError(`The DjVu file is damaged: a page declares an empty picture (${width} by ${height} pixels).`);
  assertInputPixels(width, height);
  return { width, height };
}

function linesOf(output: string): string[] {
  const lines = output.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

/** Parses what `djvused -e n` printed into the page count, and applies the page limit of the converter to it. */
export function parseDjvusedPageCount(output: string): number {
  const [count, ...rest] = linesOf(output);
  if (count === undefined || !COUNT_LINE.test(count)) throw malformed(count ?? '');
  if (rest.length > 0) throw malformed(rest[0]);
  const pageCount = Number(count);
  if (pageCount > DJVU_MAX_PAGES) throw new PayloadLimitError(`The DjVu document has ${pageCount} pages; at most ${DJVU_MAX_PAGES} are converted.`);
  if (pageCount === 0) throw new CorruptStreamError('The DjVu document holds no page.');
  return pageCount;
}

/** Parses what `djvused -e size` printed: the pixel size of each of the `pageCount` pages, under the pixel limit of the image inputs. */
export function parseDjvusedSizes(output: string, pageCount: number): DjvuPageSize[] {
  const pages = linesOf(output).map(sizeOf);
  if (pages.length !== pageCount) throw new ConversionFailedError(`djvused reports ${pageCount} pages and ${pages.length} page sizes, which do not agree.`);
  return pages;
}
