import { ConversionFailedError, CorruptStreamError, PayloadLimitError } from '../types';
import { DJVU_MAX_PAGES } from './djvu-container';
import { assertInputPixels } from './image-input-limits';

/**
 * What `djvused` of djvulibre 3.5.28 says about a document: its page count and the size of every page. The program that draws a
 * document is also the one that decides what its pages are, so the worker asks it (tools/djvused.cpp `command_n`, `command_ls`
 * and `command_size`, lines 481 to 610) and takes its answer, in place of a model of its own. A page is a directory entry with
 * the page flag (`DjVmDir::File::is_page`); the size of a `FORM:DJVU` page is the width and height of its `INFO` chunk, and of a
 * `FORM:BM44` or `FORM:PM44` page the size its first wavelet chunk declares (`print_size`, lines 551 to 593).
 *
 * Two runs, because `n` and `ls` read the directory alone, while `size` opens every page and creates the files it includes
 * (djvu-render.ts decides what its failure means). The first run prints the count on a line of its own and a line for each file of
 * the directory but its thumbnails; only the kind of each line is read, never the id, name or title after it, which the program
 * prints as they are. The second run prints a line `width=W height=H` for each page that has a size. The output is parsed
 * strictly: a line of another shape, a count that disagrees with the page lines or with the sizes, and a size of zero all end
 * the conversion. A name that holds a newline only adds lines: one of another shape or one more page line ends the conversion,
 * and one more line of another kind of file changes nothing, so no name changes the page count that is taken.
 */

/** The first run: the page count and the directory. */
export const DJVUSED_DIRECTORY_SCRIPT = 'n;ls';
/** The second run: the size of every page, which opens the pages and the files they include. */
export const DJVUSED_SIZE_SCRIPT = 'size';

/**
 * The most `djvused` may print: a directory line is 18 bytes and the name of the file, so the 20,000 files that a directory may
 * list (`DJVU_MAX_DIRECTORY_FILES`) with names and titles of a few hundred bytes come to a few megabytes (429,452 bytes
 * measured for 10,000 plain names); the sizes are 24 bytes a page.
 */
export const DJVUSED_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

export interface DjvuPageSize {
  readonly width: number;
  readonly height: number;
}

const COUNT_LINE = /^\d+$/;
/** `"%4d P "`, then the size as `"%8d  "`, then the id, `" F=name"` when the name differs from the id and `" T=title"` for a titled page. */
const PAGE_LINE = /^ *\d+ P +\d+ {2}.+$/;
const OTHER_LINE = /^ {5}[IA?] +\d+ {2}.+$/;
const THUMBNAILS_LINE = /^ {5}T +<thumbnails>$/;
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

/** Parses what `djvused -e 'n;ls'` printed into the page count, and applies the page limit of the converter to it. */
export function parseDjvusedPageCount(output: string): number {
  const lines = linesOf(output);
  if (lines.length === 0 || !COUNT_LINE.test(lines[0])) throw malformed(lines[0] ?? '');
  const pageCount = Number(lines[0]);
  if (pageCount > DJVU_MAX_PAGES) throw new PayloadLimitError(`The DjVu document has ${pageCount} pages; at most ${DJVU_MAX_PAGES} are converted.`);
  let listed = 0;
  for (const line of lines.slice(1)) {
    if (PAGE_LINE.test(line)) listed++;
    else if (!OTHER_LINE.test(line) && !THUMBNAILS_LINE.test(line)) throw malformed(line);
  }
  if (listed !== pageCount) throw new ConversionFailedError(`djvused reports ${pageCount} pages and lists ${listed} page files in the directory, which do not agree.`);
  if (pageCount === 0) throw new CorruptStreamError('The DjVu document holds no page.');
  return pageCount;
}

/** Parses what `djvused -e size` printed: the pixel size of each of the `pageCount` pages, under the pixel limit of the image inputs. */
export function parseDjvusedSizes(output: string, pageCount: number): DjvuPageSize[] {
  const pages = linesOf(output).map(sizeOf);
  if (pages.length !== pageCount) throw new ConversionFailedError(`djvused reports ${pageCount} pages and ${pages.length} page sizes, which do not agree.`);
  return pages;
}
