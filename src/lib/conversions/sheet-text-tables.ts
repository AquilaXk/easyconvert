import { DataParseError, UnsupportedTargetError, type ConversionOptions } from '../types';
import { dataObjectKeys, fieldsInFirstSeenOrder, isDataObject, parseJsonLossless } from './data-json';
import { parseDelimitedRows } from './delimited-detect';
import { sheetCellOfValue, type SheetCell } from './xlsx-writer';

/** The tables that text sources hold for a spreadsheet target: a JSON document and delimited text. */

const JSON_TABLE_SHAPE_MESSAGE = 'Invalid JSON table: expected an array of objects or an array of values.';

/**
 * The table a JSON document holds: an array of objects becomes a header row and one row per record, the header being the keys of
 * every record in the order they first appear (as the data engine's table of records has them); an array of plain values becomes a
 * single "Value" column. Anything else is not a table and is refused, as is an array of records with an item that is not an object,
 * and text that is not JSON: a sheet holding the document's own text would be a substitute result.
 */
export function parseJsonTableCells(text: string): SheetCell[][] {
  const parsed = parseJsonLossless(text);
  if (!Array.isArray(parsed) || parsed.length === 0) throw new DataParseError(JSON_TABLE_SHAPE_MESSAGE);
  if (isDataObject(parsed[0])) {
    const records = parsed.map((item, index) => {
      if (!isDataObject(item)) throw new DataParseError(`${JSON_TABLE_SHAPE_MESSAGE} Item ${index + 1} of the array of objects is not an object.`);
      return item;
    });
    const headers = fieldsInFirstSeenOrder(records.map((record) => dataObjectKeys(record)));
    return [headers, ...records.map((record) => headers.map((header) => sheetCellOfValue(Object.hasOwn(record, header) ? record[header] : null)))];
  }
  if (parsed.some((item) => typeof item === 'object' && item !== null)) throw new DataParseError(JSON_TABLE_SHAPE_MESSAGE);
  return [['Value'], ...parsed.map((item) => [sheetCellOfValue(item)])];
}

/** The text of a cell as a text target writes it. */
function sheetCellText(cell: SheetCell): string {
  return cell === null ? '' : String(cell);
}

export function parseJsonTableRows(text: string): string[][] {
  return parseJsonTableCells(text).map((row) => row.map(sheetCellText));
}

/**
 * The rows of CSV or TSV text: the lines that are not blank, each with its fields. Text that is not well formed delimited
 * text (an unterminated quote, a quote that closes inside a field) is a DataParseError; a sheet of the text split on the
 * delimiter would be a substitute result.
 */
export function delimitedSheetRows(text: string, sourceType: string, options: ConversionOptions): string[][] {
  return parseDelimitedRows(text.replace(/^\uFEFF/, ''), sourceType === 'tsv' || sourceType === 'tab' ? '\t' : options.delimiter || ',', sourceType);
}

/**
 * The refusal of a spreadsheet target for a PDF until the tables of its pages are extracted: reading its bytes as delimited text gave
 * junk rows or a misleading parse error.
 */
export function pdfSheetRefusal(): UnsupportedTargetError {
  return new UnsupportedTargetError('A PDF is not converted to a spreadsheet yet: the tables of its pages are not extracted.');
}
