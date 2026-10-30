import JSZip from 'jszip';
import type { SheetLimitError } from '../types';
import { stringifyJsonLossless, type DataValue } from './data-json';
import { SHEET_MAX_CELL_CHARS, XLSX_MAX_COLUMNS, XLSX_MAX_ROWS, sheetLimitError } from './office/sheet-bounds';

/**
 * Writes a table as an XLSX workbook with typed cells (ECMA-376 Part 1, 18.3): a number is a number, a boolean `t="b"`, a date a serial
 * number under a date format, and text goes through the shared string table (`t="s"`). The write follows the layout of the
 * xlsxwriter package (BSD-2-Clause): `sharedStrings.xml` with `count` and `uniqueCount`, the `_xHHHH_` escape of control characters and of a
 * literal that looks like one (`sharedstrings.py`), `xml:space="preserve"` around whitespace at either end of a string, and a
 * `styles.xml` with a cell format for dates and one for each count of decimals that a figure such as `20.00` shows.
 */

/** Day zero of the 1900 date system (1899-12-30), which makes serials from 61 on agree with Excel's, and the length of a day. */
export const DAY_ZERO_1900 = Date.UTC(1899, 11, 30);
export const MS_PER_DAY = 86_400_000;

/** A value of a table: text, a number, a boolean, or an empty cell. */
export type SheetCell = string | number | boolean | null;

/** How a text cell of the table is read: as the text it is, or as the number or date it spells. */
export type TextCells = 'verbatim' | 'detect';

/** A table to write as one sheet, and how its text cells are read. */
export interface SheetTable {
  readonly rows: readonly (readonly SheetCell[])[];
  readonly textCells: TextCells;
}

/** A range of cells joined into one (ECMA-376 Part 1, 18.3.1.54 `mergeCell`): its first cell's row and column from zero, and its extent. */
export interface SheetMerge {
  readonly row: number;
  readonly column: number;
  readonly rowSpan: number;
  readonly columnSpan: number;
}

/** One sheet of a workbook: its tab name, its rows, and the ranges of cells that are merged (the value of a range is in its first cell). */
export interface WorkbookSheet {
  readonly name: string;
  readonly rows: readonly (readonly SheetCell[])[];
  readonly merges?: readonly SheetMerge[];
}

/** How the parts of the package are stored: deflated for a result, stored for a workbook the office suite reads once and discards. */
export type WorkbookCompression = 'DEFLATE' | 'STORE';

/** A calendar day as a 1900-system serial number. */
interface SheetDate {
  readonly serial: number;
}

/** A number shown with a fixed count of decimals: a figure such as `20.00`, whose zeros after the point are part of how it reads. */
interface SheetDecimal {
  readonly value: number;
  readonly decimals: number;
}

/** What a cell is written as once its text is read. */
type WrittenCell = SheetCell | SheetDate | SheetDecimal;

/**
 * A decimal number that a double keeps and that reads back as the same text: no sign but a minus, no leading zero except the one of
 * `0.x`, no trailing zero after the point, no exponent, no thousands separator. "00004", "+5" and "1e4" are text.
 */
const PLAIN_DECIMAL = /^-?(?:0|[1-9]\d*)(?:\.\d*[1-9])?$/;
/** The same with zeros after the last significant digit (`20.00`, `5.50`, `0.0`): the group is the fraction. */
const FIXED_DECIMAL = /^-?(?:0|[1-9]\d*)\.(\d*0)$/;
/** Digits a double keeps exactly (DBL_DIG): Excel stores 15 significant digits, so a longer figure would change in the sheet. */
const MAX_SIGNIFICANT_DIGITS = 15;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
/** The serial of 1900-03-01, the first day after Excel's invented 1900-02-29: earlier days have two serials in the wild, so they stay text. */
const FIRST_UNAMBIGUOUS_DATE = Date.UTC(1900, 2, 1);
const LAST_DATE = Date.UTC(9999, 11, 31);

const CHAR_MINUS = 45;
const CHAR_ZERO = 48;
const CHAR_NINE = 57;
const ISO_DATE_LENGTH = 10;

/** Whether a text can begin a number or an ISO date: a digit or a minus sign. Any other text is a string without a pattern test. */
function startsLikeNumberOrDate(text: string): boolean {
  const first = text.charCodeAt(0);
  return first === CHAR_MINUS || (first >= CHAR_ZERO && first <= CHAR_NINE);
}

/** Whether a figure has more significant digits than a double keeps. A text of 15 characters or fewer cannot. */
function pastDoubleDigits(decimal: string): boolean {
  return decimal.length > MAX_SIGNIFICANT_DIGITS && decimal.replace(/^-/, '').replace('.', '').replace(/^0+/, '').length > MAX_SIGNIFICANT_DIGITS;
}

function numberOfText(text: string): number | undefined {
  if (!PLAIN_DECIMAL.test(text) || pastDoubleDigits(text)) return undefined;
  const value = Number(text);
  return String(value) === text ? value : undefined;
}

/**
 * A figure with zeros after its last significant digit is the number it spells, shown with as many decimals, as long as the format
 * gives the text back. A spreadsheet's CSV import stores such a field as a number (LibreOffice: `ScColumn::ParseString` takes a
 * plain decimal with `ScStringUtil::parseSimpleNumber` and sets a value cell, sc/source/core/data/column3.cxx lines 2290 to 2313);
 * the fixed format keeps the zeros it would otherwise drop from view. More decimals than a double keeps digits stay text.
 */
function decimalOfText(text: string): SheetDecimal | undefined {
  const match = FIXED_DECIMAL.exec(text);
  if (match === null || pastDoubleDigits(text)) return undefined;
  const decimals = match[1].length;
  if (decimals > MAX_SIGNIFICANT_DIGITS) return undefined;
  const value = Number(text);
  return value.toFixed(decimals) === text ? { value, decimals } : undefined;
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
  return { serial: (time - DAY_ZERO_1900) / MS_PER_DAY };
}

/** The cell a text field becomes: a number, a fixed-decimal number or a calendar date when it spells one exactly, else the text. */
function cellFromText(text: string): WrittenCell {
  if (text === '') return null;
  if (!startsLikeNumberOrDate(text)) return text;
  return numberOfText(text) ?? decimalOfText(text) ?? dateOfText(text) ?? text;
}

/**
 * The cell a value of a typed table (JSON, Parquet, YAML, XML) becomes: its own type, the text of an integer past the safe range,
 * and the JSON text of a nested value.
 */
export function sheetCellOfValue(value: DataValue): SheetCell {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  return typeof value === 'bigint' ? String(value) : stringifyJsonLossless(value);
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

/**
 * What a cell is written as: text read as a number, a fixed-decimal number or a date when `detect` says so. A finite number of a typed
 * source is written as it is, the shortest text that reads back as the same double (`xsd:double`); it has no spelling to keep.
 */
function cellOf(raw: SheetCell, textCells: TextCells): WrittenCell {
  if (typeof raw === 'string') return textCells === 'detect' ? cellFromText(raw) : raw;
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : String(raw);
  return raw;
}

/**
 * The cell formats a sheet uses, as indexes into `cellXfs`: 0 is General, 1 the date format, and each count of decimals a figure
 * shows gets the next one, in the order the sheet first needs it.
 */
class CellFormats {
  private readonly decimalFormats = new Map<number, number>();

  decimalStyle(decimals: number): number {
    let style = this.decimalFormats.get(decimals);
    if (style === undefined) {
      style = DATE_STYLE_INDEX + 1 + this.decimalFormats.size;
      this.decimalFormats.set(decimals, style);
    }
    return style;
  }

  /** `styles.xml`: the date format (custom id 164) and a `0.00`-style format for each count of decimals (165 on). */
  stylesXml(): string {
    const decimals = [...this.decimalFormats.keys()];
    const numFmts = [
      `<numFmt numFmtId="${DATE_FORMAT_ID}" formatCode="yyyy\\-mm\\-dd"/>`,
      ...decimals.map((count, index) => `<numFmt numFmtId="${DATE_FORMAT_ID + 1 + index}" formatCode="0.${'0'.repeat(count)}"/>`),
    ];
    const cellXfs = [
      '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>',
      `<xf numFmtId="${DATE_FORMAT_ID}" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>`,
      ...decimals.map((_, index) => `<xf numFmtId="${DATE_FORMAT_ID + 1 + index}" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>`),
    ];
    return (
      `${XML_DECLARATION}<styleSheet xmlns="${MAIN_NAMESPACE}">` +
      `<numFmts count="${numFmts.length}">${numFmts.join('')}</numFmts>` +
      '<fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>' +
      '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
      '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
      '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
      `<cellXfs count="${cellXfs.length}">${cellXfs.join('')}</cellXfs>` +
      '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>'
    );
  }
}

const tableLimitError = (count: number, what: string, limit: number): SheetLimitError => sheetLimitError('The table', count, what, 'a worksheet', limit);

/** The shared string table of a workbook: every distinct text once, and how many cells refer to a string. */
class SharedStrings {
  readonly strings: string[] = [];
  references = 0;
  private readonly index = new Map<string, number>();

  referenceTo(text: string): number {
    if (text.length > SHEET_MAX_CELL_CHARS) throw tableLimitError(text.length, 'characters in one cell', SHEET_MAX_CELL_CHARS);
    this.references++;
    let at = this.index.get(text);
    if (at === undefined) {
      at = this.strings.length;
      this.index.set(text, at);
      this.strings.push(text);
    }
    return at;
  }
}

/** What the sheets of one workbook share: its string table and its cell formats, which `styles.xml` and `sharedStrings.xml` hold once. */
interface WorkbookParts {
  readonly strings: SharedStrings;
  readonly formats: CellFormats;
}

/** The `mergeCells` element of a sheet, (18.3.1.55) placed after `sheetData` as the sequence of `worksheet` has it (18.3.1.99), or nothing for a sheet without a merge. */
function mergeCellsXml(merges: readonly SheetMerge[]): string {
  const ranges = merges.filter((merge) => merge.rowSpan > 1 || merge.columnSpan > 1);
  if (ranges.length === 0) return '';
  const refs = ranges.map((merge) => {
    const lastRow = merge.row + merge.rowSpan;
    const lastColumn = merge.column + merge.columnSpan;
    if (lastRow > XLSX_MAX_ROWS) throw tableLimitError(lastRow, 'rows', XLSX_MAX_ROWS);
    if (lastColumn > XLSX_MAX_COLUMNS) throw tableLimitError(lastColumn, 'columns', XLSX_MAX_COLUMNS);
    return `<mergeCell ref="${getExcelColumnName(merge.column)}${merge.row + 1}:${getExcelColumnName(lastColumn - 1)}${lastRow}"/>`;
  });
  return `<mergeCells count="${refs.length}">${refs.join('')}</mergeCells>`;
}

/**
 * The sheet XML of a table. The extent is the last row and column that hold a cell:
 * a cell past the last row or column of a worksheet is refused (413), while empty fields at the end of a row or empty rows at the end
 * of the table are not cells and count for nothing, and the `dimension` the sheet declares is that extent.
 */
function writeSheet(sheet: WorkbookSheet, textCells: TextCells, parts: WorkbookParts): string {
  const { strings, formats } = parts;
  const writeCell = (reference: string, cell: Exclude<WrittenCell, null>): string => {
    if (typeof cell === 'string') return `<c r="${reference}" t="s"><v>${strings.referenceTo(cell)}</v></c>`;
    if (typeof cell === 'number') return `<c r="${reference}"><v>${cell}</v></c>`;
    if (typeof cell === 'boolean') return `<c r="${reference}" t="b"><v>${cell ? 1 : 0}</v></c>`;
    if ('serial' in cell) return `<c r="${reference}" s="${DATE_STYLE_INDEX}"><v>${cell.serial}</v></c>`;
    return `<c r="${reference}" s="${formats.decimalStyle(cell.decimals)}"><v>${cell.value}</v></c>`;
  };

  const body: string[] = [];
  let lastRow = 0;
  let lastColumn = 0;
  for (let rowIndex = 0; rowIndex < sheet.rows.length; rowIndex++) {
    const row = sheet.rows[rowIndex];
    const rowNumber = rowIndex + 1;
    let cells = '';
    for (let column = 0; column < row.length; column++) {
      const cell = cellOf(row[column], textCells);
      if (cell === null || cell === '') continue;
      if (rowNumber > XLSX_MAX_ROWS) throw tableLimitError(rowNumber, 'rows', XLSX_MAX_ROWS);
      if (column >= XLSX_MAX_COLUMNS) throw tableLimitError(column + 1, 'columns', XLSX_MAX_COLUMNS);
      cells += writeCell(getExcelColumnName(column) + rowNumber, cell);
      lastColumn = Math.max(lastColumn, column + 1);
    }
    if (cells === '') continue;
    body.push(`<row r="${rowNumber}">${cells}</row>`);
    lastRow = rowNumber;
  }

  const lastCell = `${getExcelColumnName(Math.max(lastColumn, 1) - 1)}${Math.max(lastRow, 1)}`;
  return `${XML_DECLARATION}<worksheet xmlns="${MAIN_NAMESPACE}"><dimension ref="A1:${lastCell}"/><sheetData>${body.join('')}</sheetData>${mergeCellsXml(sheet.merges ?? [])}</worksheet>`;
}

const CONTENT_TYPES_HEAD =
  `${XML_DECLARATION}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
  '<Default Extension="xml" ContentType="application/xml"/>' +
  '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>';
const CONTENT_TYPES_TAIL =
  '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
  '<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/></Types>';

const PACKAGE_RELATIONSHIPS =
  `${XML_DECLARATION}<Relationships xmlns="${PACKAGE_RELATIONSHIPS_NAMESPACE}">` +
  `<Relationship Id="rId1" Type="${RELATIONSHIPS_NAMESPACE}/officeDocument" Target="xl/workbook.xml"/></Relationships>`;

const XML_ATTRIBUTE_ENTITIES: Readonly<Record<string, string>> = { ...XML_TEXT_ENTITIES, '"': '&quot;' };

/** The `[Content_Types].xml`, `workbook.xml` and its relationships for the sheets of a workbook, each sheet `sheet<n>.xml` with the relationship `rId<n>`. */
function workbookParts(sheets: readonly WorkbookSheet[]): { contentTypes: string; workbook: string; relationships: string } {
  const numbers = sheets.map((_, index) => index + 1);
  const styles = sheets.length + 1;
  const sharedStrings = sheets.length + 2;
  return {
    contentTypes:
      CONTENT_TYPES_HEAD +
      numbers.map((n) => `<Override PartName="/xl/worksheets/sheet${n}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('') +
      CONTENT_TYPES_TAIL,
    workbook:
      `${XML_DECLARATION}<workbook xmlns="${MAIN_NAMESPACE}" xmlns:r="${RELATIONSHIPS_NAMESPACE}"><sheets>` +
      sheets.map((sheet, index) => `<sheet name="${sheet.name.replace(/[&<>"]/g, (character) => XML_ATTRIBUTE_ENTITIES[character])}" sheetId="${numbers[index]}" r:id="rId${numbers[index]}"/>`).join('') +
      '</sheets></workbook>',
    relationships:
      `${XML_DECLARATION}<Relationships xmlns="${PACKAGE_RELATIONSHIPS_NAMESPACE}">` +
      numbers.map((n) => `<Relationship Id="rId${n}" Type="${RELATIONSHIPS_NAMESPACE}/worksheet" Target="worksheets/sheet${n}.xml"/>`).join('') +
      `<Relationship Id="rId${styles}" Type="${RELATIONSHIPS_NAMESPACE}/styles" Target="styles.xml"/>` +
      `<Relationship Id="rId${sharedStrings}" Type="${RELATIONSHIPS_NAMESPACE}/sharedStrings" Target="sharedStrings.xml"/></Relationships>`,
  };
}

/**
 * The XLSX package of a workbook of one or more sheets, in the order given, sharing one string table and one set of cell formats.
 * `textCells` says whether a string cell is read as the number or date it spells (a delimited text, a sheet read as text, a table
 * of a PDF) or kept as the text it is (a typed source such as JSON, where "007" is a string).
 * `compression` is `STORE` only for a workbook that is read once and discarded (the office suite's `.xls` export).
 * The caller names the sheets: a name of 1 to 31 characters without `[ ] : * ? / \`, each one different from the others (case apart).
 * @throws SheetLimitError (413) when a cell lies past row 1,048,576 or column 16,384, or holds more than 32,767 characters; the
 *   table is never cut to fit.
 */
export async function writeXlsxWorkbook(sheets: readonly WorkbookSheet[], textCells: TextCells, compression: WorkbookCompression = 'DEFLATE'): Promise<Buffer> {
  const parts: WorkbookParts = { strings: new SharedStrings(), formats: new CellFormats() };
  const sheetXml = sheets.map((sheet) => writeSheet(sheet, textCells, parts));
  const { strings } = parts;
  const sharedStrings =
    `${XML_DECLARATION}<sst xmlns="${MAIN_NAMESPACE}" count="${strings.references}" uniqueCount="${strings.strings.length}">` +
    `${strings.strings.map(sharedStringItem).join('')}</sst>`;
  const { contentTypes, workbook, relationships } = workbookParts(sheets);

  const zip = new JSZip();
  zip.file('[Content_Types].xml', contentTypes);
  zip.file('_rels/.rels', PACKAGE_RELATIONSHIPS);
  zip.file('xl/workbook.xml', workbook);
  zip.file('xl/_rels/workbook.xml.rels', relationships);
  zip.file('xl/styles.xml', parts.formats.stylesXml());
  zip.file('xl/sharedStrings.xml', sharedStrings);
  sheetXml.forEach((xml, index) => zip.file(`xl/worksheets/sheet${index + 1}.xml`, xml));
  return zip.generateAsync({ type: 'nodebuffer', compression });
}

/** The XLSX package of a table of one sheet, `Sheet1`; see `writeXlsxWorkbook`. */
export function writeXlsx(rows: readonly (readonly SheetCell[])[], textCells: TextCells, compression: WorkbookCompression = 'DEFLATE'): Promise<Buffer> {
  return writeXlsxWorkbook([{ name: 'Sheet1', rows }], textCells, compression);
}
