import { ConversionFailedError, CorruptStreamError, PayloadLimitError } from '../types';
import { DJVU_MAX_PAGES } from './djvu-container';
import { assertInputPixels } from './image-input-limits';

/**
 * What `djvused` of djvulibre 3.5.28 says about a document: its page count, its directory and the size of every page. The
 * program that draws a document is also the one that decides what its pages are, so the worker asks it (tools/djvused.cpp
 * `command_n`, `command_ls` and `command_size`, lines 481 to 610) and takes its answer, in place of a model of its own. A
 * page is a directory entry with the page flag (`DjVmDir::File::is_page`); the size of a `FORM:DJVU` page is the width and
 * height of its `INFO` chunk, and of a `FORM:BM44` or `FORM:PM44` page the size its first wavelet chunk declares
 * (`print_size`, lines 551 to 593).
 *
 * Two runs, because `size` opens the page and creates the files it includes, and crashes on a document whose includes form a
 * cycle or run thousands of files deep (measured with 3.5.28: a stack overflow, status 139, at 5,000 levels, and at once on two
 * files that include each other), while `n` and `ls` read the directory alone. The first run prints the count on a line of its
 * own and a line for each file of the directory but its thumbnails; the include graph of the document is checked against that
 * directory (djvu-include-graph.ts); the second run prints a line `width=W height=H` for each page that has a size. The
 * output is parsed strictly: a line of another shape, a count that disagrees with the page lines or with the sizes, and a
 * size of zero all end the conversion.
 */

/** The first run: the page count and the directory. */
export const DJVUSED_DIRECTORY_SCRIPT = 'n;ls';
/** The second run, once the include graph is known to be shallow and acyclic: the size of every page. */
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

/**
 * One file of the directory that `ls` lists: whether it is a page, and the strings an `INCL` chunk may name it by. `ids` holds the
 * first part of the line and the whole of it, so that an id that itself holds ` F=` or ` T=` is still found by its name.
 */
export interface DjvuDirectoryEntry {
  readonly page: boolean;
  /** `DjVuDocument::id_to_url` (libdjvu/DjVuDocument.cpp lines 794 to 847) looks a name up as an id, then as a name, then as a title. */
  readonly ids: readonly string[];
  readonly names: readonly string[];
  readonly titles: readonly string[];
}

/** The page count and the files of the directory but its thumbnails, in the order of the directory. */
export interface DjvuDirectory {
  readonly pageCount: number;
  readonly entries: readonly DjvuDirectoryEntry[];
}

const COUNT_LINE = /^\d+$/;
/** `"%4d P "`, then the size as `"%8d  "`, then the id, `" F=name"` when the name differs from the id and `" T=title"` for a titled page. */
const PAGE_LINE = /^ *\d+ P +\d+ {2}(.+)$/;
const OTHER_LINE = /^ {5}[IA?] +\d+ {2}(.+)$/;
const THUMBNAILS_LINE = /^ {5}T +<thumbnails>$/;
const SIZE_LINE = /^width=(\d+) height=(\d+)(?: rotation=\d+)?$/;
const NAME_MARKER = ' F=';
const TITLE_MARKER = ' T=';

function malformed(line: string): ConversionFailedError {
  return new ConversionFailedError(`djvused printed a line that this converter does not read: ${JSON.stringify(line.slice(0, 80))}`);
}

/** The id, the name and the title of a line, split at the first markers (a search that reads the line once: a name may be megabytes long). */
function entryOf(text: string, page: boolean): DjvuDirectoryEntry {
  const nameAt = text.indexOf(NAME_MARKER);
  const titleAt = text.indexOf(TITLE_MARKER);
  const markers = [nameAt, titleAt].filter((at) => at !== -1);
  const idEnd = markers.length === 0 ? text.length : Math.min(...markers);
  const nameEnd = titleAt === -1 ? text.length : titleAt;
  const names = nameAt !== -1 && nameAt < nameEnd ? [text.slice(nameAt + NAME_MARKER.length, nameEnd)] : [];
  const titles = titleAt === -1 ? [] : [text.slice(titleAt + TITLE_MARKER.length)];
  return { page, ids: [text.slice(0, idEnd), text], names, titles };
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

/** Parses what `djvused -e 'n;ls'` printed and applies the page limit of the converter to the count. */
export function parseDjvusedDirectory(output: string): DjvuDirectory {
  const lines = linesOf(output);
  if (lines.length === 0 || !COUNT_LINE.test(lines[0])) throw malformed(lines[0] ?? '');
  const pageCount = Number(lines[0]);
  if (pageCount > DJVU_MAX_PAGES) throw new PayloadLimitError(`The DjVu document has ${pageCount} pages; at most ${DJVU_MAX_PAGES} are converted.`);
  const entries: DjvuDirectoryEntry[] = [];
  for (const line of lines.slice(1)) {
    const page = PAGE_LINE.exec(line);
    const other = page === null ? OTHER_LINE.exec(line) : null;
    if (page !== null) entries.push(entryOf(page[1], true));
    else if (other !== null) entries.push(entryOf(other[1], false));
    else if (!THUMBNAILS_LINE.test(line)) throw malformed(line);
  }
  const listed = entries.filter((entry) => entry.page).length;
  if (listed !== pageCount) throw new ConversionFailedError(`djvused reports ${pageCount} pages and lists ${listed} page files in the directory, which do not agree.`);
  if (pageCount === 0) throw new CorruptStreamError('The DjVu document holds no page.');
  return { pageCount, entries };
}

/** Parses what `djvused -e size` printed: the pixel size of each of the `pageCount` pages, under the pixel limit of the image inputs. */
export function parseDjvusedSizes(output: string, pageCount: number): DjvuPageSize[] {
  const pages = linesOf(output).map(sizeOf);
  if (pages.length !== pageCount) throw new ConversionFailedError(`djvused reports ${pageCount} pages and ${pages.length} page sizes, which do not agree.`);
  return pages;
}
