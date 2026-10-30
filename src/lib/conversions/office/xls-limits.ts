import type JSZip from 'jszip';
import { ConversionFailedError } from '../../types';
import { InflateBudget } from '../bounded-inflate';
import { openPackage } from '../package-access';
import { readZipEntryText, scanZipEntry } from '../zip-entry-reader';
import { streamElementsWithin } from './opc-parts';
import { XLSX_MAX_PART_ENTRIES, XLSX_NO_WORKSHEETS_MESSAGE, discoverXlsxSheets } from './xlsx-sheets';
import { XLS_MAX_COLUMNS, XLS_MAX_ROWS, sheetLimitError } from './sheet-bounds';

/**
 * A workbook that is written as `.xls` has to fit the BIFF8 sheet. The office suite's `MS Excel 97` export drops the rows past 65,536
 * and the columns past 256 without a word (measured: a 70,001-row sheet comes back as 65,536 rows and a 300-column sheet as 256),
 * so the extent of every worksheet is read from its cells first and a workbook that does not fit is refused.
 *
 * The extent is the last row and column that hold a cell with a value, a formula or an inline string, counted the way SheetJS reads
 * a worksheet (xlsx 0.18.5, `parse_ws_xml_data`, xlsx.js lines 14851 and 14880 to 14881): a `row` without `r` follows the row before
 * it, a `c` without `r` follows the cell before it, and the range grows from the cells read (lines 14854 and 14924), never from the
 * declared `dimension`. The office suite is what cuts the rows, so the parts checked are every one it may open as a worksheet: the
 * sheets the workbook lists (`discoverXlsxSheets`: whatever their name, at the target their relationship names), the parts under
 * `xl/worksheets/`, and the parts that `[Content_Types].xml` types as a worksheet. A workbook that lists a sheet whose part is not
 * in the package is refused, not passed. A tall part that nothing references gets a 413 as well, which is the safe side: no
 * producer writes one. The parts are streamed, charged to one decoded-byte budget for the workbook, and never held whole.
 */

/** The children of `c` that give a cell content (ECMA-376 Part 1, 18.3.1.4): a value, a formula, an inline string. */
const CELL_CONTENT: ReadonlySet<string> = new Set(['v', 'f', 'is']);
/** The parts a package keeps its worksheets in by convention; `_rels` holds their relationships. */
const WORKSHEET_PARTS = /^xl\/worksheets\/(?!_rels\/).+\.xml$/i;
const WORKSHEET_CONTENT_TYPE_SUFFIX = 'spreadsheetml.worksheet+xml';
const ROW_NUMBER = /^\d+$/;
const CELL_REFERENCE = /^\$?([A-Za-z]+)\$?(\d+)$/;
const ATTRIBUTE = /\s([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
/** The characters that end a start tag or open a quoted attribute value in it. */
const TAG_SPECIAL = /["'>]/g;
const COMMENT_START = '<!--';
const CDATA_START = '<![CDATA[';
const LETTERS_IN_ALPHABET = 26;
const CHAR_CODE_BEFORE_A = 64;

function columnNumber(letters: string): number {
  let number = 0;
  for (const letter of letters.toUpperCase()) number = number * LETTERS_IN_ALPHABET + letter.charCodeAt(0) - CHAR_CODE_BEFORE_A;
  return number;
}

function attribute(header: string, name: string): string | undefined {
  for (const match of header.matchAll(ATTRIBUTE)) {
    if (match[1] === name) return match[2] ?? match[3];
  }
  return undefined;
}

function localName(name: string): string {
  return name.slice(name.indexOf(':') + 1);
}

/** A comment, CDATA section, processing instruction or declaration being skipped: its terminator, and the last characters read before a chunk ended. */
interface Skipped {
  end: string;
  tail: string;
}

/** A tag being read across chunks: its text so far, and the quote of the attribute value it is inside, if any. */
interface OpenTag {
  text: string;
  quote: string;
}

/**
 * The extent of one worksheet part, read from the chunks of its XML in order. Every character is looked at once: text between tags
 * is passed over with `indexOf`, a tag is read to the `>` outside its quotes, and a construct cut by the end of a chunk carries on
 * into the next one.
 */
class WorksheetExtent {
  private row = 0;
  private column = 0;
  /** The cell whose start tag was read last, until its content or its end tag is. */
  private cell: { row: number; column: number } | undefined;
  private skipped: Skipped | undefined;
  private openTag: OpenTag | undefined;
  /** The first characters of a construct cut off at the end of a chunk before its kind could be told. */
  private pending = '';

  constructor(private readonly part: string) {}

  feed(chunk: string): void {
    const text = this.pending + chunk;
    this.pending = '';
    let position = 0;
    while (position < text.length) {
      if (this.skipped !== undefined) position = this.continueSkip(this.skipped, text, position);
      else if (this.openTag !== undefined) position = this.continueTag(this.openTag, text, position);
      else position = this.beginMarkup(text, position);
    }
  }

  private beginMarkup(text: string, from: number): number {
    const start = text.indexOf('<', from);
    if (start === -1) return text.length;
    const head = text.slice(start, start + CDATA_START.length);
    if (head.length < CDATA_START.length && (CDATA_START.startsWith(head) || COMMENT_START.startsWith(head))) {
      this.pending = head;
      return text.length;
    }
    if (head.startsWith(COMMENT_START)) {
      this.skipped = { end: '-->', tail: '' };
      return start + COMMENT_START.length;
    }
    if (head.startsWith(CDATA_START)) {
      this.skipped = { end: ']]>', tail: '' };
      return start + CDATA_START.length;
    }
    if (head[1] === '?' || head[1] === '!') {
      this.skipped = { end: '>', tail: '' };
      return start + 2;
    }
    this.openTag = { text: '', quote: '' };
    return start + 1;
  }

  private continueSkip(skipped: Skipped, text: string, from: number): number {
    const keep = skipped.end.length - 1;
    if (skipped.tail !== '') {
      // A terminator split by the end of the last chunk starts in `tail`.
      const seam = skipped.tail + text.slice(from, from + keep);
      const found = seam.indexOf(skipped.end);
      if (found !== -1 && found < skipped.tail.length) {
        this.skipped = undefined;
        return from + found + skipped.end.length - skipped.tail.length;
      }
    }
    const found = text.indexOf(skipped.end, from);
    if (found !== -1) {
      this.skipped = undefined;
      return found + skipped.end.length;
    }
    const rest = text.length - from;
    skipped.tail = rest >= keep ? text.slice(text.length - keep) : (skipped.tail + text.slice(from)).slice(-keep);
    return text.length;
  }

  private continueTag(tag: OpenTag, text: string, from: number): number {
    let index = from;
    while (index < text.length) {
      if (tag.quote !== '') {
        const close = text.indexOf(tag.quote, index);
        if (close === -1) break;
        tag.quote = '';
        index = close + 1;
        continue;
      }
      TAG_SPECIAL.lastIndex = index;
      const special = TAG_SPECIAL.exec(text);
      if (special === null) break;
      if (special[0] !== '>') {
        tag.quote = special[0];
        index = special.index + 1;
        continue;
      }
      this.openTag = undefined;
      this.readTag(tag.text + text.slice(from, special.index));
      return special.index + 1;
    }
    tag.text += text.slice(from);
    return text.length;
  }

  private readTag(header: string): void {
    if (header.startsWith('/')) {
      if (localName(header.slice(1).trim()) === 'c') this.cell = undefined;
      return;
    }
    const nameEnd = header.search(/[\s/]/);
    const name = localName(nameEnd === -1 ? header : header.slice(0, nameEnd));
    if (name === 'row') this.startRow(attribute(header, 'r'));
    else if (name === 'c') this.startCell(attribute(header, 'r'), header.trimEnd().endsWith('/'));
    else if (this.cell !== undefined && CELL_CONTENT.has(name)) {
      this.extend(this.cell.row, this.cell.column);
      this.cell = undefined;
    }
  }

  private startRow(reference: string | undefined): void {
    if (reference !== undefined && !ROW_NUMBER.test(reference)) throw this.unreadable(`row number "${reference}"`);
    this.row = reference === undefined ? this.row + 1 : Number(reference);
    this.column = 0;
  }

  private startCell(reference: string | undefined, empty: boolean): void {
    let row = this.row;
    if (reference === undefined) {
      this.column += 1;
    } else {
      const match = CELL_REFERENCE.exec(reference);
      if (match === null) throw this.unreadable(`cell reference "${reference}"`);
      this.column = columnNumber(match[1]);
      row = Number(match[2]);
    }
    this.cell = empty ? undefined : { row, column: this.column };
  }

  private extend(row: number, column: number): void {
    const subject = `The workbook (${this.part})`;
    if (row > XLS_MAX_ROWS) throw sheetLimitError(subject, row, 'rows', 'an .xls worksheet', XLS_MAX_ROWS);
    if (column > XLS_MAX_COLUMNS) throw sheetLimitError(subject, column, 'columns', 'an .xls worksheet', XLS_MAX_COLUMNS);
  }

  private unreadable(what: string): ConversionFailedError {
    return new ConversionFailedError(`The workbook cannot be checked against the .xls bounds: ${this.part} has the ${what}, which is not an A1 reference.`);
  }
}

/** The parts that `[Content_Types].xml` gives the content type of a worksheet, at most `XLSX_MAX_PART_ENTRIES` of its entries read. */
async function worksheetPartsByContentType(zip: JSZip, budget: InflateBudget): Promise<string[]> {
  const types = zip.file('[Content_Types].xml');
  if (types === null) return [];
  const parts: string[] = [];
  streamElementsWithin(
    await readZipEntryText(types, { budget, maxBytes: budget.limit }),
    'Override',
    XLSX_MAX_PART_ENTRIES,
    `The content types of the workbook list more than ${XLSX_MAX_PART_ENTRIES} parts.`,
    (override) => {
      const { PartName: partName, ContentType: contentType } = override.attrs;
      if (partName !== undefined && contentType?.endsWith(WORKSHEET_CONTENT_TYPE_SUFFIX)) parts.push(partName.replace(/^\//, ''));
    }
  );
  return parts;
}

/**
 * Every part of the package an office suite may open as a worksheet, once each: the sheets the workbook lists, then the parts
 * under `xl/worksheets/` and the parts typed as worksheets that are in the package. A sheet the workbook lists whose part is
 * missing is a refusal.
 */
async function worksheetEntriesToCheck(zip: JSZip, budget: InflateBudget): Promise<Map<string, JSZip.JSZipObject>> {
  const { sheets, unnamedSheetParts } = await discoverXlsxSheets(zip, { budget });
  const entries = new Map<string, JSZip.JSZipObject>();
  for (const part of [...sheets.map((sheet) => sheet.path), ...unnamedSheetParts]) {
    const entry = zip.file(part);
    if (entry === null) throw new ConversionFailedError(`The workbook lists a sheet at "${part}", which is not in the package, so it cannot be checked against the .xls bounds.`);
    entries.set(part, entry);
  }
  const conventional = Object.keys(zip.files).filter((part) => WORKSHEET_PARTS.test(part));
  for (const part of [...conventional, ...(await worksheetPartsByContentType(zip, budget))]) {
    const entry = zip.file(part);
    if (entry !== null) entries.set(part, entry);
  }
  return entries;
}

/**
 * Refuses (413) an XLSX package with a worksheet that holds a cell past row 65,536 or column 256. A package that is not a ZIP, a
 * package without a worksheet (the refusal of the reader), a part that does not inflate, a listed sheet that is not in the package,
 * and a cell reference that is not an A1 reference are refused too, so that nothing reaches the export unchecked.
 */
export async function assertWorkbookFitsXls(xlsx: Buffer): Promise<void> {
  const zip = await openPackage(xlsx, 'XLSX');
  const budget = new InflateBudget();
  const entries = await worksheetEntriesToCheck(zip, budget);
  if (entries.size === 0) throw new ConversionFailedError(XLSX_NO_WORKSHEETS_MESSAGE);
  for (const [part, entry] of entries) {
    const extent = new WorksheetExtent(part);
    await scanZipEntry(entry, (chunk) => extent.feed(chunk.toString('latin1')), { budget, maxBytes: budget.limit, label: `"${part}"` });
  }
}
