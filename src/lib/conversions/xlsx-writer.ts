import JSZip from 'jszip';
import { SHEET_MAX_CELL_CHARS, XLSX_MAX_COLUMNS, XLSX_MAX_ROWS, sheetLimitError } from './office/sheet-bounds';

/**
 * Writes a table as an XLSX workbook with typed cells (ECMA-376 Part 1, 18.3): a number is a number, a boolean `t="b"`, a date a serial
 * number under a date format, and text goes through the shared string table (`t="s"`). The write follows the layout of the
 * xlsxwriter package (BSD-2-Clause): `sharedStrings.xml` with `count` and `uniqueCount`, the `_xHHHH_` escape of control characters and of a
 * literal that looks like one (`sharedstrings.py`), `xml:space="preserve"` around whitespace at either end of a string, and a
 * `styles.xml` with one cell format for dates.
 */

/** A calendar day as a 1900-system serial number. */
export interface SheetDate {
  readonly serial: number;
}

export type SheetCell = string | number | boolean | null | SheetDate;

/** How a text cell of the table is read: as the text it is, or as the number or date it spells. */
export type TextCells = 'verbatim' | 'detect';

/**
 * A decimal number that a double keeps and that reads back as the same text: no sign but a minus, no leading zero except the one of
 * `0.x`, no trailing zero after the point, no exponent, no thousands separator. "00004", "1.50", "+5" and "1e4" are text.
 */
const PLAIN_DECIMAL = /^-?(?:0|[1-9]\d*)(?:\.\d*[1-9])?$/;
/** Digits a double keeps exactly (DBL_DIG): Excel stores 15 significant digits, so a longer figure would change in the sheet. */
const MAX_SIGNIFICANT_DIGITS = 15;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
/** The serial of 1900-03-01, the first day after Excel's invented 1900-02-29: earlier days have two serials in the wild, so they stay text. */
const FIRST_UNAMBIGUOUS_DATE = Date.UTC(1900, 2, 1);
const LAST_DATE = Date.UTC(9999, 11, 31);
const DAY_ZERO = Date.UTC(1899, 11, 30);
const MS_PER_DAY = 86_400_000;

const CHAR_MINUS = 45;
const CHAR_ZERO = 48;
const CHAR_NINE = 57;
const ISO_DATE_LENGTH = 10;

/** Whether a text can begin a number or an ISO date: a digit or a minus sign. Any other text is a string without a pattern test. */
function startsLikeNumberOrDate(text: string): boolean {
  const first = text.charCodeAt(0);
  return first === CHAR_MINUS || (first >= CHAR_ZERO && first <= CHAR_NINE);
}

function significantDigits(decimal: string): number {
  return decimal.replace(/^-/, '').replace('.', '').replace(/^0+/, '').length;
}

function numberOfText(text: string): number | undefined {
  if (!PLAIN_DECIMAL.test(text)) return undefined;
  // A text of 15 characters or fewer cannot hold more than 15 digits.
  if (text.length > MAX_SIGNIFICANT_DIGITS && significantDigits(text) > MAX_SIGNIFICANT_DIGITS) return undefined;
  const value = Number(text);
  return String(value) === text ? value : undefined;
}

function dateOfText(text: string): SheetDate | undefined {
  if (text.length !== ISO_DATE_LENGTH) return undefined;
  const match = ISO_DATE.exec(text);
  if (match === null) return undefined;
  const [year, month, day] = [Number(match[1]), Number(match[2]) - 1, Number(match[3])];
  const time = Date.UTC(year, month, day);
  const calendar = new Date(time);
  const isCalendarDay = calendar.getUTCFullYear() === year && calendar.getUTCMonth() === month && calendar.getUTCDate() === day;
  if (!isCalendarDay || time < FIRST_UNAMBIGUOUS_DATE || time > LAST_DATE) return undefined;
  return { serial: (time - DAY_ZERO) / MS_PER_DAY };
}

/** The cell a text field becomes: a number or a calendar date when it spells one exactly, else the text. */
function sheetCellFromText(text: string): SheetCell {
  if (text === '') return null;
  if (!startsLikeNumberOrDate(text)) return text;
  const number = numberOfText(text);
  if (number !== undefined) return number;
  return dateOfText(text) ?? text;
}

const COLUMN_NAMES: string[] = [];

/** Bijective base-26 column name: 0 is "A", 25 is "Z", 26 is "AA". */
export function getExcelColumnName(index: number): string {
  const cached = COLUMN_NAMES[index];
  if (cached !== undefined) return cached;
  let name = '';
  for (let rest = index + 1; rest > 0; rest = Math.floor((rest - 1) / 26)) {
    name = String.fromCharCode(65 + ((rest - 1) % 26)) + name;
  }
  COLUMN_NAMES[index] = name;
  return name;
}

const XML_DECLARATION = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const MAIN_NAMESPACE = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const RELATIONSHIPS_NAMESPACE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PACKAGE_RELATIONSHIPS_NAMESPACE = 'http://schemas.openxmlformats.org/package/2006/relationships';
const DATE_STYLE_INDEX = 1;
const DATE_FORMAT_ID = 164;

/** Characters XML 1.0 cannot carry, and a lone surrogate: written as `_xHHHH_` (ECMA-376 Part 1, 22.4.2.4). */
const NOT_XML_CHARACTER = /[\u0000-\u0008\u000B-\u001F\uFFFE\uFFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
const LITERAL_ESCAPE = /_x[0-9a-fA-F]{4}_/g;
const XML_TEXT_SPECIALS = /[&<>]/g;
const OUTER_WHITESPACE = /^\s|\s$/;
const XML_TEXT_ENTITIES: Readonly<Record<string, string>> = { '&': '&amp;', '<': '&lt;', '>': '&gt;' };

function hexEscape(character: string): string {
  return `_x${character.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}_`;
}

function sharedStringItem(text: string): string {
  const escaped = text
    .replace(LITERAL_ESCAPE, (literal) => `_x005F${literal}`)
    .replace(NOT_XML_CHARACTER, hexEscape)
    .replace(XML_TEXT_SPECIALS, (character) => XML_TEXT_ENTITIES[character]);
  return OUTER_WHITESPACE.test(text) ? `<si><t xml:space="preserve">${escaped}</t></si>` : `<si><t>${escaped}</t></si>`;
}

/** What a cell is written as: text read as a number or date when `detect` says so, and a number a double does not keep exactly as the text of it. */
function cellOf(raw: SheetCell, textCells: TextCells): SheetCell {
  if (typeof raw === 'string') return textCells === 'detect' ? sheetCellFromText(raw) : raw;
  if (typeof raw === 'number') return numberOfText(String(raw)) ?? String(raw);
  return raw;
}

const limitError = (what: string, count: number, limit: number): Error => sheetLimitError('The table', count, what, 'a worksheet', limit);

function assertFitsWorksheet(rows: readonly (readonly SheetCell[])[]): number {
  if (rows.length > XLSX_MAX_ROWS) throw limitError('rows', rows.length, XLSX_MAX_ROWS);
  let width = 0;
  for (const row of rows) width = Math.max(width, row.length);
  if (width > XLSX_MAX_COLUMNS) throw limitError('columns', width, XLSX_MAX_COLUMNS);
  return width;
}

interface WrittenSheet {
  xml: string;
  strings: string[];
  stringReferences: number;
}

function writeSheet(rows: readonly (readonly SheetCell[])[], width: number, textCells: TextCells): WrittenSheet {
  const stringIndex = new Map<string, number>();
  const strings: string[] = [];
  let stringReferences = 0;
  const referenceTo = (text: string): number => {
    if (text.length > SHEET_MAX_CELL_CHARS) throw limitError('characters in one cell', text.length, SHEET_MAX_CELL_CHARS);
    stringReferences++;
    let index = stringIndex.get(text);
    if (index === undefined) {
      index = strings.length;
      stringIndex.set(text, index);
      strings.push(text);
    }
    return index;
  };
  const textCell = (reference: string, text: string): string => `<c r="${reference}" t="s"><v>${referenceTo(text)}</v></c>`;

  const body: string[] = [];
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
    const row = rows[rowIndex];
    const rowNumber = rowIndex + 1;
    let cells = '';
    for (let column = 0; column < row.length; column++) {
      const cell = cellOf(row[column], textCells);
      if (cell === null || cell === '') continue;
      const reference = getExcelColumnName(column) + rowNumber;
      if (typeof cell === 'string') cells += textCell(reference, cell);
      else if (typeof cell === 'number') cells += `<c r="${reference}"><v>${cell}</v></c>`;
      else if (typeof cell === 'boolean') cells += `<c r="${reference}" t="b"><v>${cell ? 1 : 0}</v></c>`;
      else cells += `<c r="${reference}" s="${DATE_STYLE_INDEX}"><v>${cell.serial}</v></c>`;
    }
    if (cells !== '') body.push(`<row r="${rowNumber}">${cells}</row>`);
  }

  const lastCell = `${getExcelColumnName(Math.max(width, 1) - 1)}${Math.max(rows.length, 1)}`;
  const xml = `${XML_DECLARATION}<worksheet xmlns="${MAIN_NAMESPACE}"><dimension ref="A1:${lastCell}"/><sheetData>${body.join('')}</sheetData></worksheet>`;
  return { xml, strings, stringReferences };
}

const CONTENT_TYPES =
  `${XML_DECLARATION}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
  '<Default Extension="xml" ContentType="application/xml"/>' +
  '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
  '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
  '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
  '<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/></Types>';

const PACKAGE_RELATIONSHIPS =
  `${XML_DECLARATION}<Relationships xmlns="${PACKAGE_RELATIONSHIPS_NAMESPACE}">` +
  `<Relationship Id="rId1" Type="${RELATIONSHIPS_NAMESPACE}/officeDocument" Target="xl/workbook.xml"/></Relationships>`;

const WORKBOOK =
  `${XML_DECLARATION}<workbook xmlns="${MAIN_NAMESPACE}" xmlns:r="${RELATIONSHIPS_NAMESPACE}">` +
  '<sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>';

const WORKBOOK_RELATIONSHIPS =
  `${XML_DECLARATION}<Relationships xmlns="${PACKAGE_RELATIONSHIPS_NAMESPACE}">` +
  `<Relationship Id="rId1" Type="${RELATIONSHIPS_NAMESPACE}/worksheet" Target="worksheets/sheet1.xml"/>` +
  `<Relationship Id="rId2" Type="${RELATIONSHIPS_NAMESPACE}/styles" Target="styles.xml"/>` +
  `<Relationship Id="rId3" Type="${RELATIONSHIPS_NAMESPACE}/sharedStrings" Target="sharedStrings.xml"/></Relationships>`;

const STYLES =
  `${XML_DECLARATION}<styleSheet xmlns="${MAIN_NAMESPACE}">` +
  `<numFmts count="1"><numFmt numFmtId="${DATE_FORMAT_ID}" formatCode="yyyy\\-mm\\-dd"/></numFmts>` +
  '<fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>' +
  '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
  '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
  '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
  '<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
  `<xf numFmtId="${DATE_FORMAT_ID}" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs>` +
  '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>';

/**
 * The XLSX package of a table of one sheet. `textCells` says whether a string cell is read as the number or date it spells (a
 * delimited text or a sheet read as text) or kept as the text it is (a typed source such as JSON, where "007" is a string).
 * `uncompressed` stores the parts without deflate, for a workbook that is read once and discarded (the office suite's `.xls` export).
 * @throws DataLimitExceededError (413) when the table has more than 1,048,576 rows or 16,384 columns or a cell of more than
 *   32,767 characters; it is never cut to fit.
 */
export async function writeXlsx(rows: readonly (readonly SheetCell[])[], textCells: TextCells, uncompressed = false): Promise<Buffer> {
  const width = assertFitsWorksheet(rows);
  const sheet = writeSheet(rows, width, textCells);
  const sharedStrings =
    `${XML_DECLARATION}<sst xmlns="${MAIN_NAMESPACE}" count="${sheet.stringReferences}" uniqueCount="${sheet.strings.length}">` +
    `${sheet.strings.map(sharedStringItem).join('')}</sst>`;

  const zip = new JSZip();
  zip.file('[Content_Types].xml', CONTENT_TYPES);
  zip.file('_rels/.rels', PACKAGE_RELATIONSHIPS);
  zip.file('xl/workbook.xml', WORKBOOK);
  zip.file('xl/_rels/workbook.xml.rels', WORKBOOK_RELATIONSHIPS);
  zip.file('xl/styles.xml', STYLES);
  zip.file('xl/sharedStrings.xml', sharedStrings);
  zip.file('xl/worksheets/sheet1.xml', sheet.xml);
  return zip.generateAsync({ type: 'nodebuffer', compression: uncompressed ? 'STORE' : 'DEFLATE' });
}
