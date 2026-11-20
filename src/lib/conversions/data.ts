import { randomUUID } from 'node:crypto';
import Papa from 'papaparse';
import { parse as parseToml, stringify as stringifyToml, TomlError } from 'smol-toml';
import {
  Document as YamlDocument,
  Scalar as YamlScalar,
  isScalar as isYamlScalar,
  parseDocument as parseYamlDocument,
  visit as visitYaml,
  type ScalarTag,
  type YAMLError,
  type YAMLMap,
} from 'yaml';
import {
  ConversionOptions,
  ConversionFailedError,
  ConversionResult,
  DataEncodingError,
  DataLimitExceededError,
  DataParseError,
  DataRepresentationError,
  PayloadLimitError,
  UnsupportedOptionError,
  UnsupportedTargetError,
} from '../types';
import { generateOdsFromData, officeSheetWorkbook } from './office';
import { sheetLimitError } from './office/sheet-bounds';
import { gridLimitError, gridOf, isSpreadsheetGrid, type Grid } from './table-grid';
import { sheetCellOfValue, writeXlsx, type SheetCell } from './xlsx-writer';
import { unconvertibleOfficeTarget } from './native-engine-pairs';
import { encodeParquet, decodeParquet, decodeParquetTable, ParquetFormatError } from './parquet';
import type { CellShape } from './parquet';
import { renderPdfTables } from './pdf-table-layout';
import {
  MAX_DATA_NESTING_DEPTH,
  MAX_INTEGER_LITERAL_DIGITS,
  dataObjectKeys,
  fieldsInFirstSeenOrder,
  isDataObject,
  normalizeDataValue,
  parseJsonLossless,
  positionOf,
  setOwn,
  stringifyJsonLossless,
  withOrderedKeysView,
  type DataObject,
  type DataValue,
} from './data-json';
import { parseXmlDocument, serializeDataToXml, xmlRecords, xmlStringValue, xmlToJsonMlDocument } from './data-xml';
import { assertToml10Syntax } from './data-toml';
import { assertDataInputBytes, assertDataItemCount } from './data-limits';
import { convertOnDataThread } from './data-task';
import { SHEET_TEXT_SOURCES } from './office/sheet-write';
import { assertConversionOptionsObject } from './options-guard';
import { delimitedToParquet, jsonLinesToDelimited, parquetToDelimited, parquetToJson } from './data-fast-paths';
import { DELIMITED_RECORD_SEPARATOR, FORMULA_TRIGGER, UTF8_BOM_CHAR, writesBomByDefault } from './delimited-rules';
import { DELIMITER_CANDIDATES, detectDelimiter, nominalDelimiter, parseDelimitedRecords, raggedRowWarnings } from './delimited-detect';
import { reportConversionWarning } from './conversion-warnings';
import { canonicalEncoding, decodeCheckedDelimitedText, decodeStrict, sniffBom, sniffUtf16ByNulPattern } from './delimited-text-decoder';
import { escapeMarkupAttribute } from '../text/escape';

export { encodeParquet, decodeParquet };

// ---------------------------------------------------------------------------
// Delimited text: delimiter detection and parsing
// ---------------------------------------------------------------------------


interface DelimitedTable {
  fields: string[];
  records: DataObject[];
  /** The decoded input text. */
  text: string;
  delimiter: string;
}

function resolveDelimiter(text: string, src: string, requested?: string): string {
  return requested ?? detectDelimiter(text, nominalDelimiter(src));
}

const ALLOWED_DELIMITERS: ReadonlySet<string> = new Set(DELIMITER_CANDIDATES);
const BOOLEAN_DATA_OPTIONS = ['bom', 'escapeFormulas'] as const;

function optionError(name: string, expectation: string, value: unknown): UnsupportedOptionError {
  return new UnsupportedOptionError(`Option "${name}" must be ${expectation}; got ${JSON.stringify(value) ?? typeof value}.`);
}

/**
 * Options arrive as parsed request JSON, so their types are checked before use: a wrong type is
 * a typed 400, never a TypeError deep in a parser.
 */
function assertDataOptions(options: unknown): asserts options is ConversionOptions {
  assertConversionOptionsObject(options);
  const { delimiter, encoding } = options as Record<string, unknown>;
  if (delimiter !== undefined && (typeof delimiter !== 'string' || !ALLOWED_DELIMITERS.has(delimiter))) {
    throw optionError('delimiter', 'one of ",", ";", TAB or "|"', delimiter);
  }
  if (encoding !== undefined) {
    if (typeof encoding !== 'string') throw optionError('encoding', 'a WHATWG encoding label', encoding);
    canonicalEncoding(encoding);
  }
  for (const name of BOOLEAN_DATA_OPTIONS) {
    const value = (options as Record<string, unknown>)[name];
    if (value !== undefined && typeof value !== 'boolean') throw optionError(name, 'true or false', value);
  }
}

/**
 * Decodes and parses delimited text with a header record (parseDelimitedRecords, shared with the
 * browser paths); a quote error fails closed, and records of another width than the header are
 * evened out and reported in the warnings of the conversion.
 */
function parseDelimitedTable(inputBuffer: Buffer, src: string, options: ConversionOptions): DelimitedTable {
  const text = decodeCheckedDelimitedText(inputBuffer, options.encoding, src.toUpperCase());
  const delimiter = resolveDelimiter(text, src, options.delimiter);
  const { fields, records, ragged } = parseDelimitedRecords(text, delimiter, src);
  for (const line of raggedRowWarnings(ragged, src)) reportConversionWarning(line);
  return { fields, records, text, delimiter };
}

// ---------------------------------------------------------------------------
// Delimited text: output
// ---------------------------------------------------------------------------

/**
 * Writes CSV or TSV under the shared delimited-output rules: a UTF-8 BOM by default for CSV only
 * (writesBomByDefault), and formula cells (FORMULA_TRIGGER) prefixed with ' and quoted unless
 * `escapeFormulas` is false.
 */
function writeDelimited(fields: string[], rows: readonly (readonly unknown[])[], tgt: string, options: ConversionOptions): Buffer {
  const delimiter = tgt === 'tsv' ? '\t' : ',';
  const escapeFormulas = options.escapeFormulas ?? true;
  const withBom = options.bom ?? writesBomByDefault(tgt);
  // Papa.unparse turns null/undefined into '' except that its quotes callback is skipped on null; only a 1-column empty cell needs quoting.
  const data = (fields.length === 1 ? rows.map((row) => (row[0] == null ? [''] : row)) : rows) as unknown[][];
  const text = Papa.unparse(
    { fields, data },
    {
      delimiter,
      escapeFormulae: escapeFormulas ? FORMULA_TRIGGER : false,
      newline: DELIMITED_RECORD_SEPARATOR,
      // A one-column record whose only value is empty would otherwise be an empty line.
      quotes: (value: unknown) => fields.length === 1 && value === '',
    }
  );
  return Buffer.from(withBom ? UTF8_BOM_CHAR + text : text, 'utf-8');
}

function delimitedResult(buffer: Buffer, tgt: string, baseName: string): ConversionResult {
  return {
    buffer,
    mimeType: tgt === 'tsv' ? 'text/tab-separated-values' : 'text/csv',
    filename: `${baseName}.${tgt}`,
    size: buffer.length,
  };
}

// ---------------------------------------------------------------------------
// Tables from structured data
// ---------------------------------------------------------------------------

const JSON_INDENT = 2;
/** Targets written from the flattened table of records. */
const TABLE_TARGETS: ReadonlySet<string> = new Set(['csv', 'tsv', 'parquet', 'html', 'pdf', 'ods', 'xls', 'xlsx']);

interface DataTable {
  fields: string[];
  rows: DataValue[][];
}

/** Writes one table cell per leaf: nested objects become dot paths, arrays their JSON text. */
function flattenInto(value: DataValue, path: string, cells: Map<string, DataValue>): void {
  if (isDataObject(value)) {
    const keys = dataObjectKeys(value);
    if (keys.length === 0) {
      setCell(cells, path, '{}');
      return;
    }
    for (const key of keys) flattenInto(value[key], path === '' ? key : `${path}.${key}`, cells);
    return;
  }
  setCell(cells, path, Array.isArray(value) ? stringifyJsonLossless(value) : value);
}

function setCell(cells: Map<string, DataValue>, path: string, value: DataValue): void {
  if (cells.has(path)) {
    throw new DataRepresentationError(`Two values flatten to the same column "${path}"; rename one of the keys.`);
  }
  cells.set(path, value);
}

const HEADER_ROWS = 1;

/**
 * What a table of records may hold is the grid of its target (`gridOf`), checked before its matrix is built: a record of one key of its own
 * adds a column, so R records can make R columns and R x R cells from R lines of input.
 */
function assertTableFits(fields: number, records: number, bounds: Grid): void {
  const cells = fields * records;
  if (isSpreadsheetGrid(bounds)) {
    if (fields > bounds.columns) throw gridLimitError(bounds, fields, 'columns');
    if (records + HEADER_ROWS > bounds.rows) throw gridLimitError(bounds, records + HEADER_ROWS, 'rows');
    if (cells > bounds.cells) throw sheetLimitError('The table', cells, 'cells (records times columns)', 'a workbook this engine reads', bounds.cells);
  } else if (fields > bounds.columns || records > bounds.rows || cells > bounds.cells) {
    const limits = [[bounds.columns, 'columns'], [bounds.rows, 'records'], [bounds.cells, 'cells']] as const;
    const held = limits.filter(([limit]) => Number.isFinite(limit)).map(([limit, unit]) => `${limit} ${unit}`).join(', ');
    throw new PayloadLimitError(`The table of records has ${fields} columns by ${records} records, ${cells} cells; this target holds at most ${held}.`);
  }
}

/** A table over the union of all records' columns in first-seen order; a non-object record fills "value". */
function tabulate(records: DataValue[], tgt: string, leadingFields: readonly string[] = []): DataTable {
  const flattened = records.map((record) => {
    const cells = new Map<string, DataValue>();
    if (isDataObject(record)) flattenInto(record, '', cells);
    else setCell(cells, 'value', Array.isArray(record) ? stringifyJsonLossless(record) : record);
    return cells;
  });
  const fields = fieldsInFirstSeenOrder(flattened.map((cells) => cells.keys()), leadingFields);
  assertTableFits(fields.length, flattened.length, gridOf(tgt));
  return { fields, rows: flattened.map((cells) => fields.map((field) => cells.get(field) ?? null)) };
}

function tableRecords(table: DataTable): DataObject[] {
  return table.rows.map((row) => {
    const record: DataObject = {};
    table.fields.forEach((field, index) => setOwn(record, field, row[index]));
    return record;
  });
}

function cellText(value: DataValue): string {
  return value === null ? '' : String(value);
}

/** The sheet of a table: the header row, then one row per record, each value in a cell of its own type. */
function tableSheet(table: DataTable): SheetCell[][] {
  return [table.fields, ...table.rows.map((row) => row.map(sheetCellOfValue))];
}

/** Rejects unpaired surrogates in a table: every table writer would silently turn them into U+FFFD. */
function assertTableUnicode(table: DataTable, tgt: string): void {
  const label = tgt.toUpperCase();
  for (const field of table.fields) {
    if (UNPAIRED_SURROGATE.test(field)) {
      throw new DataRepresentationError(
        `${label} text must be valid Unicode; the column name ${JSON.stringify(field)} holds an unpaired surrogate.`
      );
    }
  }
  table.rows.forEach((row, rowIndex) => {
    row.forEach((cell, column) => {
      if (typeof cell === 'string' && UNPAIRED_SURROGATE.test(cell)) {
        throw new DataRepresentationError(
          `${label} text must be valid Unicode; row ${rowIndex + 1}, column ${JSON.stringify(table.fields[column])} holds an unpaired surrogate.`
        );
      }
    });
  });
}

function tableStrings(table: DataTable): string[][] {
  return [table.fields, ...table.rows.map((row) => row.map(cellText))];
}

// ---------------------------------------------------------------------------
// Structured sources: JSON, NDJSON, YAML, TOML, XML, parquet, delimited text
// ---------------------------------------------------------------------------

/** Aliases one YAML document may use (inclusive); exponential expansion is bounded by the value cap below. */
const MAX_YAML_ALIAS_COUNT = 100;
/** Values a YAML document may expand to per value written in its source. */
const YAML_EXPANSION_FACTOR = 10;
/** Values every YAML document may expand to regardless of its own size. */
const YAML_MIN_EXPANDED_VALUES = 100_000;
/** Sign and radix prefix (0x, 0o, 0b) of a YAML integer literal, which are not digits. */
const YAML_INTEGER_PREFIX = /^[-+]?(?:0[xob])?/;
/** Characters of a literal that can hold its sign and radix prefix. */
const YAML_INTEGER_PREFIX_MAX_LENGTH = 3;
const INT64_MIN = -(BigInt(2) ** BigInt(63));
const INT64_MAX = BigInt(2) ** BigInt(63) - BigInt(1);
/** Leading bytes searched for the XML declaration's encoding pseudo-attribute. */
const XML_DECLARATION_SCAN_BYTES = 256;
const XML_DECLARATION_ENCODING =
  /^<\?xml[\x20\t\r\n][^>]*?encoding[\x20\t\r\n]*=[\x20\t\r\n]*(["'])([A-Za-z][A-Za-z0-9._-]*)\1/;
const UTF16LE_XML_SIGNATURE: readonly number[] = [0x3c, 0x00, 0x3f, 0x00];
const UTF16BE_XML_SIGNATURE: readonly number[] = [0x00, 0x3c, 0x00, 0x3f];

interface StructuredSource {
  /** The whole document as data: the JSON, YAML, TOML and XML writers serialize it. */
  value: DataValue;
  /** Records for table targets (CSV, TSV, parquet, spreadsheets, HTML, PDF). */
  records: () => DataValue[];
  /** Columns that lead every table even when no record has them (a CSV header). */
  fields?: string[];
  /** Plain-text rendering for the txt target. */
  text: () => string;
}

function startsWithBytes(bytes: Uint8Array, signature: readonly number[]): boolean {
  return bytes.length >= signature.length && signature.every((byte, index) => bytes[index] === byte);
}

/** Strict UTF-8, the only encoding JSON (RFC 8259), NDJSON and TOML allow; a UTF-8 BOM is dropped. */
function decodeUtf8Text(bytes: Uint8Array, format: string): string {
  const bom = sniffBom(bytes);
  if (bom !== null && bom !== 'utf-8') {
    throw new DataEncodingError(`${format} input must be UTF-8, but it starts with a ${bom} byte-order mark.`);
  }
  if (bom === null && sniffUtf16ByNulPattern(bytes) !== null) {
    throw new DataEncodingError(`${format} input must be UTF-8, but it is UTF-16 text without a byte-order mark.`);
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new DataEncodingError(`${format} input is not valid UTF-8 text.`);
  }
}

/** The strict UTF-8 text of a JSON, NDJSON or TOML input of at most the size and the count of values its source is read with. */
function decodeCheckedText(bytes: Uint8Array, kind: 'json' | 'ndjson' | 'toml', format: string): string {
  assertDataInputBytes(kind, bytes.length, format);
  const text = decodeUtf8Text(bytes, format);
  assertDataItemCount(kind, text, format);
  return text;
}

/** XML 1.0 Appendix F: a BOM, then the UTF-16 form of "<?", then the declared encoding, then UTF-8. */
function decodeXmlText(bytes: Uint8Array): string {
  const bom = sniffBom(bytes);
  if (bom) return decodeStrict(bytes, bom);
  if (startsWithBytes(bytes, UTF16LE_XML_SIGNATURE)) return decodeStrict(bytes, 'utf-16le');
  if (startsWithBytes(bytes, UTF16BE_XML_SIGNATURE)) return decodeStrict(bytes, 'utf-16be');
  const head = Buffer.from(bytes.subarray(0, XML_DECLARATION_SCAN_BYTES)).toString('latin1');
  const declared = XML_DECLARATION_ENCODING.exec(head)?.[2];
  if (declared === undefined) return decodeStrict(bytes, 'utf-8');
  let encoding: string;
  try {
    encoding = new TextDecoder(declared).encoding;
  } catch {
    throw new DataEncodingError(`Unsupported XML encoding declaration "${declared}".`);
  }
  return decodeStrict(bytes, encoding);
}

function yamlParseError(error: YAMLError): DataParseError {
  const position = error.linePos?.[0];
  const reason =
    error.code === 'MULTIPLE_DOCS'
      ? 'the input holds more than one document; convert one document at a time.'
      : error.message.split('\n')[0];
  return new DataParseError(`YAML parsing failed: ${reason}`, { line: position?.line, column: position?.col });
}

/**
 * Map keys must be scalars and unique after conversion to JSON property names, where 1 and "1"
 * (or ~ and "") become the same key. One Set per map keeps this linear; the yaml library's own
 * uniqueKeys check compares every pair and took minutes for 100,000 keys. Merge keys (<<) are
 * exempt, so explicit keys still override merged ones.
 */
function assertYamlKeysUnique(map: YAMLMap, text: string): void {
  const seen = new Set<string>();
  // The position is computed only for the error: scanning for it on every key would be quadratic.
  const locate = (key: unknown): { line?: number; column?: number } => {
    const offset = (key as { range?: [number, number, number] } | null)?.range?.[0];
    return offset === undefined ? {} : positionOf(text, offset);
  };
  for (const pair of map.items) {
    const key = pair.key;
    if (key !== null && !isYamlScalar(key)) {
      throw new DataParseError('YAML parsing failed: map keys must be scalars to become JSON property names.', locate(key));
    }
    const value = key === null ? null : key.value;
    if (typeof value === 'symbol') continue;
    const name = value === null ? '' : String(value);
    if (seen.has(name)) {
      throw new DataParseError(`YAML parsing failed: duplicate key ${JSON.stringify(name)} in a map.`, locate(key));
    }
    seen.add(name);
  }
}

/** Rejects integer literals longer than MAX_INTEGER_LITERAL_DIGITS before they are copied or printed. */
function assertYamlIntegerLength(scalar: YamlScalar, text: string): void {
  if (typeof scalar.value !== 'bigint' || !scalar.range) return;
  const [start, end] = scalar.range;
  const prefix = YAML_INTEGER_PREFIX.exec(text.slice(start, start + YAML_INTEGER_PREFIX_MAX_LENGTH))?.[0] ?? '';
  if (end - start - prefix.length <= MAX_INTEGER_LITERAL_DIGITS) return;
  const { line, column } = positionOf(text, start);
  throw new DataLimitExceededError(
    `YAML integer literal at line ${line}, column ${column} has more than ${MAX_INTEGER_LITERAL_DIGITS} digits.`
  );
}

function parseYamlText(text: string): DataValue {
  const document = parseYamlDocument(text, { intAsBigInt: true, merge: true, uniqueKeys: false });
  // Warnings include tags that could not be resolved (!!int abc, unknown !tags); guessing a value would be silent.
  const [first] = [...document.errors, ...document.warnings];
  if (first) throw yamlParseError(first);
  let sourceValues = 0;
  let aliases = 0;
  visitYaml(document, {
    Alias() {
      aliases++;
      sourceValues++;
    },
    Scalar(_key, scalar) {
      sourceValues++;
      assertYamlIntegerLength(scalar, text);
    },
    Seq() {
      sourceValues++;
    },
    Map(_key, map) {
      sourceValues++;
      assertYamlKeysUnique(map, text);
    },
  });
  if (aliases > MAX_YAML_ALIAS_COUNT) {
    throw new DataLimitExceededError(`YAML document uses ${aliases} aliases; at most ${MAX_YAML_ALIAS_COUNT} are allowed.`);
  }
  let raw: unknown;
  try {
    // Aliases resolve to shared objects; the value cap below bounds their expansion.
    raw = document.toJS({ maxAliasCount: -1, mapAsMap: true });
  } catch (err) {
    throw new DataParseError(`YAML parsing failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    return normalizeDataValue(raw, {
      maxValues: Math.max(YAML_MIN_EXPANDED_VALUES, sourceValues * YAML_EXPANSION_FACTOR),
      label: 'YAML document',
    });
  } catch (err) {
    if (err instanceof DataLimitExceededError && aliases > 0 && /expands to more than/.test(err.message)) {
      throw new DataLimitExceededError(err.message.replace(/\.$/, ' through its aliases.'));
    }
    throw err;
  }
}

function parseTomlText(text: string): DataValue {
  assertToml10Syntax(text);
  let raw: unknown;
  try {
    raw = parseToml(text, { integersAsBigInt: 'asNeeded', maxDepth: MAX_DATA_NESTING_DEPTH });
  } catch (err) {
    if (err instanceof TomlError) {
      throw new DataParseError(`TOML parsing failed: ${err.message.split('\n')[0]}`, { line: err.line, column: err.column });
    }
    throw err;
  }
  // TOML has no aliases, so its value count is bounded by the source itself.
  return normalizeDataValue(raw, { maxValues: Number.POSITIVE_INFINITY, label: 'TOML document' });
}

/** A line holding only JSON whitespace; any other content must parse as a JSON value. */
const NDJSON_BLANK_LINE = /^[\x20\t]*$/;

/** One JSON value per line; blank lines are skipped and a malformed line fails with its 1-based number. */
function parseNdjsonText(text: string, src: string): DataValue[] {
  const label = src.toUpperCase();
  const records: DataValue[] = [];
  text.split('\n').forEach((rawLine, index) => {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (!NDJSON_BLANK_LINE.test(line)) records.push(parseJsonLossless(line, label, index + 1));
  });
  if (records.length === 0) {
    throw new DataParseError(`${label} parsing failed: no JSON records found.`);
  }
  return records;
}

/**
 * One value of a Parquet record cut into the cells of a table, by the same rules as a JSON record (`flattenInto`): a struct stays an
 * object, so it becomes a dotted column per field, and a list becomes JSON text. A map is JSON text here too, and not dotted columns:
 * its keys are data, and columns made of them would change with the rows. A struct that is null in a row gets every one of its fields
 * as null, from the schema, so a column exists for each field of each struct whether or not a row holds it.
 */
function tabularValue(value: DataValue, shape: CellShape): DataValue {
  if (shape === 'plain') return value;
  if (shape === 'map') return value === null ? null : stringifyJsonLossless(value);
  const fields = value as DataObject | null;
  const cells: DataObject = {};
  for (const [name, inner] of shape) setOwn(cells, name, tabularValue(fields === null ? null : fields[name], inner));
  return cells;
}

/** Records for the table targets from records that hold structs and maps; the structured targets keep the nesting and never see these copies. */
function tabularRecords(records: DataValue[], shapes: ReadonlyMap<string, CellShape>): DataValue[] {
  return records.map((record) => {
    const row = record as DataObject;
    const cells: DataObject = {};
    for (const key of dataObjectKeys(row)) {
      const shape = shapes.get(key);
      setOwn(cells, key, shape === undefined ? row[key] : tabularValue(row[key], shape));
    }
    return cells;
  });
}

function asRecords(value: DataValue): DataValue[] {
  return Array.isArray(value) ? value : [value];
}

function readStructuredSource(inputBuffer: Buffer, src: string, tgt: string, options: ConversionOptions): StructuredSource {
  if (src === 'csv' || src === 'tsv' || src === 'tab') {
    const table = parseDelimitedTable(inputBuffer, src, options);
    return { value: table.records, records: () => table.records, fields: table.fields, text: () => table.text };
  }
  if (src === 'json') {
    const value = parseJsonLossless(decodeCheckedText(inputBuffer, 'json', 'JSON'));
    return { value, records: () => asRecords(value), text: () => stringifyJsonLossless(value, JSON_INDENT) };
  }
  if (src === 'ndjson' || src === 'jsonl') {
    const records = parseNdjsonText(decodeCheckedText(inputBuffer, 'ndjson', src.toUpperCase()), src);
    return { value: records, records: () => records, text: () => stringifyJsonLossless(records, JSON_INDENT) };
  }
  if (src === 'yaml' || src === 'yml') {
    // YAML 1.2 (5.2) allows UTF-16 and detects it from a BOM or the NUL pattern of its first characters.
    assertDataInputBytes('yaml', inputBuffer.length, 'YAML');
    const encoding = sniffBom(inputBuffer) ?? sniffUtf16ByNulPattern(inputBuffer) ?? 'utf-8';
    const text = decodeStrict(inputBuffer, encoding);
    assertDataItemCount('yaml', text, 'YAML');
    const value = parseYamlText(text);
    return { value, records: () => asRecords(value), text: () => text };
  }
  if (src === 'toml') {
    const text = decodeCheckedText(inputBuffer, 'toml', 'TOML');
    const value = parseTomlText(text);
    return { value, records: () => [value], text: () => text };
  }
  if (src === 'xml') {
    assertDataInputBytes('xml', inputBuffer.length, 'XML');
    const xmlText = decodeXmlText(inputBuffer);
    assertDataItemCount('xml', xmlText, 'XML');
    const root = parseXmlDocument(xmlText);
    return { value: xmlToJsonMlDocument(root), records: () => xmlRecords(root), text: () => xmlStringValue(root) };
  }
  if (src === 'parquet') {
    const { records: decoded, shapes } = decodeParquetTable(inputBuffer);
    const records = decoded as DataValue[];
    return {
      value: records,
      records: () => (shapes.size === 0 ? records : tabularRecords(records, shapes)),
      text: () => stringifyJsonLossless(records, JSON_INDENT),
    };
  }
  throw new UnsupportedTargetError(`Unsupported data conversion from ${src} to ${tgt}`);
}

// ---------------------------------------------------------------------------
// Structured targets
// ---------------------------------------------------------------------------

/**
 * Characters a YAML stream may carry only as escapes (outside c-printable: C0 and C1 controls,
 * DEL, unpaired surrogates, U+FFFE/U+FFFF), plus NEL, LS and PS, which YAML 1.1 reads as line breaks.
 */
const YAML_ESCAPE_ONLY = /[\0-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F\u2028\u2029\uFEFF\uFFFE\uFFFF\uD800-\uDFFF]/u;
/** Plain scalars YAML 1.1 reads as something other than a string: the value key and the merge key. */
const YAML_11_SPECIAL_SCALARS: ReadonlySet<string> = new Set(['=', '<<']);
const YAML_ESCAPE_ONLY_ALL = new RegExp(YAML_ESCAPE_ONLY.source, 'gu');
const YAML_NAMED_ESCAPES: ReadonlyMap<number, string> = new Map([
  [0x85, '\\N'],
  [0x2028, '\\L'],
  [0x2029, '\\P'],
]);
const BYTE_ESCAPE_LIMIT = 0xff;
const BYTE_ESCAPE_DIGITS = 2;
const UNICODE_ESCAPE_DIGITS = 4;

/** Exponent-form number text whose mantissa has no decimal point, e.g. "5e+22" or "1e-7". */
const EXPONENT_WITHOUT_POINT = /^(-?\d+)(e[-+]\d+)$/;

/**
 * Writes a double in exponent form with an explicit ".0" mantissa ("5.0e+22"): YAML 1.1 readers
 * need the decimal point to read it as a float, and YAML 1.2 reads both spellings the same.
 * Placed first in the schema, so it wins over the core number tags for exactly these values.
 */
const YAML_EXPONENT_FLOAT_TAG: ScalarTag = {
  identify: (value) => typeof value === 'number' && EXPONENT_WITHOUT_POINT.test(String(value)),
  default: true,
  tag: 'tag:yaml.org,2002:float',
  test: /^-?\d+\.0e[-+]\d+$/,
  resolve: (text) => parseFloat(text),
  stringify: ({ value }) => String(value).replace(EXPONENT_WITHOUT_POINT, '$1.0$2'),
};

function yamlEscape(char: string): string {
  const codePoint = char.codePointAt(0) ?? 0;
  const named = YAML_NAMED_ESCAPES.get(codePoint);
  if (named) return named;
  const hex = codePoint.toString(16).toUpperCase();
  return codePoint <= BYTE_ESCAPE_LIMIT
    ? `\\x${hex.padStart(BYTE_ESCAPE_DIGITS, '0')}`
    : `\\u${hex.padStart(UNICODE_ESCAPE_DIGITS, '0')}`;
}

/**
 * YAML 1.2 output that YAML 1.1 readers load the same way: strings such as "yes", "on" or
 * "2024-01-01" are quoted, exponent floats carry a decimal point, and BigInt values are written
 * as exact integers. A scalar holding a tab or an escape-only character is double-quoted and the
 * character escaped, which the yaml library leaves to the caller for DEL, C1 controls and
 * U+FFFE/U+FFFF.
 */
function writeYamlText(value: DataValue): string {
  const document = new YamlDocument(withOrderedKeysView(value), {
    compat: 'yaml-1.1',
    aliasDuplicateObjects: false,
    customTags: (tags) => [YAML_EXPONENT_FLOAT_TAG, ...tags],
  });
  visitYaml(document, {
    Scalar(_key, node) {
      // YAML 1.1 readers also reject a tab inside a plain scalar, which YAML 1.2 allows.
      const text = node.value;
      if (
        typeof text === 'string' &&
        (text.includes('\t') || YAML_ESCAPE_ONLY.test(text) || YAML_11_SPECIAL_SCALARS.has(text))
      ) {
        node.type = YamlScalar.QUOTE_DOUBLE;
      }
    },
  });
  return document.toString().replace(YAML_ESCAPE_ONLY_ALL, yamlEscape);
}

const UNPAIRED_SURROGATE = /[\uD800-\uDFFF]/u;

/**
 * Rejects values TOML cannot hold before smol-toml sees them: it would drop null, accept any
 * BigInt and replace unpaired surrogates with U+FFFD.
 */
function assertTomlRepresentable(value: DataValue, path: string): void {
  if (value === null) {
    throw new DataRepresentationError(`TOML has no null value (at "${path}").`);
  }
  if (typeof value === 'string' && UNPAIRED_SURROGATE.test(value)) {
    throw new DataRepresentationError(`TOML text must be valid Unicode; "${path}" holds an unpaired surrogate.`);
  }
  if (typeof value === 'bigint' && (value < INT64_MIN || value > INT64_MAX)) {
    throw new DataRepresentationError(`TOML integers are 64-bit; ${value} at "${path}" is out of range.`);
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertTomlRepresentable(item, `${path}[${index}]`));
  } else if (isDataObject(value)) {
    for (const key of dataObjectKeys(value)) {
      const child = value[key];
      const childPath = path === '' ? key : `${path}.${key}`;
      if (UNPAIRED_SURROGATE.test(key)) {
        throw new DataRepresentationError(`TOML keys must be valid Unicode; "${childPath}" holds an unpaired surrogate.`);
      }
      assertTomlRepresentable(child, childPath);
    }
  }
}

/** TOML literal for a negative zero: only a float keeps the sign (an integer -0 is 0). */
const TOML_NEGATIVE_ZERO = '-0.0';

/** A copy of the value with every negative zero replaced by `marker`; counts the replacements. */
function markNegativeZeros(value: DataValue, marker: string, count: { replaced: number }): DataValue {
  if (typeof value === 'number' && Object.is(value, -0)) {
    count.replaced++;
    return marker;
  }
  if (Array.isArray(value)) return value.map((item) => markNegativeZeros(item, marker, count));
  if (isDataObject(value)) {
    const copy: DataObject = {};
    for (const key of dataObjectKeys(value)) setOwn(copy, key, markNegativeZeros(value[key], marker, count));
    return copy;
  }
  return value;
}

function writeTomlText(value: DataValue): string {
  if (!isDataObject(value)) {
    throw new DataRepresentationError('A TOML document is a table; the input must be a JSON object or YAML mapping.');
  }
  assertTomlRepresentable(value, '');
  // smol-toml writes -0 as 0, so each negative zero goes through as a unique quoted marker string
  // that is then replaced by -0.0. The count check proves no user string produced the marker.
  const marker = `negative-zero-${randomUUID()}`;
  const count = { replaced: 0 };
  const marked = withOrderedKeysView(markNegativeZeros(value, marker, count));
  const toml = stringifyToml(marked, { maxDepth: MAX_DATA_NESTING_DEPTH });
  if (count.replaced === 0) return toml;
  const pieces = toml.split(JSON.stringify(marker));
  if (pieces.length - 1 !== count.replaced) {
    throw new DataRepresentationError('A negative zero could not be written as the TOML float -0.0.');
  }
  return pieces.join(TOML_NEGATIVE_ZERO);
}

function textResult(text: string, mimeType: string, baseName: string, extension: string): ConversionResult {
  const buffer = Buffer.from(text, 'utf-8');
  return { buffer, mimeType, filename: `${baseName}.${extension}`, size: buffer.length };
}

/**
 * A decoded Parquet table can still be too large for the JS engine to serialize into the target
 * (string or array length limits); that is an input problem, not an internal error.
 */
async function guardParquetSource<T>(convert: () => Promise<T>): Promise<T> {
  try {
    return await convert();
  } catch (error) {
    if (error instanceof RangeError) {
      throw new ParquetFormatError(`Unsupported Parquet file: the table is too large to convert (${error.message})`);
    }
    throw error;
  }
}

/**
 * Converts a structured-data source (CSV, TSV, JSON, NDJSON, YAML, TOML, XML, Parquet): a text of `DATA_POOL_MIN_BYTES` or more is
 * converted on a CPU pool thread (data-task.ts), a shorter one here.
 */
export async function convertData(
  inputBuffer: Buffer,
  sourceFormat: string,
  targetFormat: string,
  options: ConversionOptions = {},
  originalFilename: string
): Promise<ConversionResult> {
  assertDataOptions(options);
  const onThread = await convertOnDataThread('convert', inputBuffer, sourceFormat, targetFormat, options, originalFilename);
  return onThread ?? convertDataInline(inputBuffer, sourceFormat, targetFormat, options, originalFilename);
}

/** `convertData` on the calling thread; the pool thread runs this. */
export async function convertDataInline(
  inputBuffer: Buffer,
  sourceFormat: string,
  targetFormat: string,
  options: ConversionOptions = {},
  originalFilename: string
): Promise<ConversionResult> {
  assertDataOptions(options);
  const baseName = originalFilename.replace(/\.[^/.]+$/, '');
  const src = sourceFormat.toLowerCase();
  const tgt = targetFormat.toLowerCase();

  if (src === 'parquet' && tgt === 'parquet') {
    // Decoding re-infers column types (INT32 -> INT64, FLOAT -> DOUBLE) and drops the codec, so a
    // re-encode would not reproduce the file; returning the input unchanged is not a conversion.
    throw new UnsupportedTargetError('Parquet to Parquet is not a supported conversion.');
  }

  if (tgt === 'parquet' && (src === 'csv' || src === 'tsv' || src === 'tab')) {
    const parquetBuffer = delimitedToParquet(inputBuffer, src, options);
    if (parquetBuffer !== null) {
      return { buffer: parquetBuffer, mimeType: 'application/vnd.apache.parquet', filename: `${baseName}.parquet`, size: parquetBuffer.length };
    }
  }

  if ((src === 'jsonl' || src === 'ndjson') && (tgt === 'csv' || tgt === 'tsv')) {
    const delimitedBuffer = jsonLinesToDelimited(inputBuffer, src, tgt, options);
    if (delimitedBuffer !== null) {
      return delimitedResult(delimitedBuffer, tgt, baseName);
    }
  }

  if (src === 'parquet') {
    return guardParquetSource(async () => {
      if (tgt === 'csv' || tgt === 'tsv') {
        const delimitedBuffer = parquetToDelimited(inputBuffer, tgt, options);
        if (delimitedBuffer !== null) {
          return delimitedResult(delimitedBuffer, tgt, baseName);
        }
      }
      if (tgt === 'json') {
        const jsonBuffer = parquetToJson(inputBuffer);
        if (jsonBuffer !== null) {
          return { buffer: jsonBuffer, mimeType: 'application/json', filename: `${baseName}.json`, size: jsonBuffer.length };
        }
      }
      return convertStructured(inputBuffer, src, tgt, options, baseName);
    });
  }
  return convertStructured(inputBuffer, src, tgt, options, baseName);
}

/**
 * Sources the data engine reads as a table of records for a spreadsheet target, with the readers the CSV, JSON and Parquet targets use:
 * a record is a row and a key is a column. CSV, TSV and JSON are read by the office engine's own table reader.
 */
export const STRUCTURED_SHEET_SOURCES: ReadonlySet<string> = new Set(['parquet', 'ndjson', 'jsonl', 'yaml', 'yml', 'xml']);

/**
 * The XLSX workbook the office suite reads once on the way to `.xls` and discards: the sheet the `.xlsx` target writes of the source,
 * stored without deflate. The suite inflates nothing then, and deflating took 18 of the 28 ms that writing the workbook of the data
 * family's 2,500-row table took.
 */
export async function writeTransientWorkbook(inputBuffer: Buffer, src: string, options: ConversionOptions): Promise<Buffer> {
  if (STRUCTURED_SHEET_SOURCES.has(src)) assertDataOptions(options);
  const onThread = STRUCTURED_SHEET_SOURCES.has(src) || SHEET_TEXT_SOURCES.has(src) ? await convertOnDataThread('workbook', inputBuffer, src, 'xls', options, '') : null;
  return onThread ?? writeTransientWorkbookInline(inputBuffer, src, options);
}

/** `writeTransientWorkbook` on the calling thread; the pool thread runs this. */
export async function writeTransientWorkbookInline(inputBuffer: Buffer, src: string, options: ConversionOptions): Promise<Buffer> {
  if (!STRUCTURED_SHEET_SOURCES.has(src)) return officeSheetWorkbook(inputBuffer, src, options, 'STORE');
  assertDataOptions(options);
  const write = async (): Promise<Buffer> => {
    const source = readStructuredSource(inputBuffer, src, 'xlsx', options);
    const table = tabulate(source.records(), 'xls', source.fields);
    assertTableUnicode(table, 'xlsx');
    return writeXlsx(tableSheet(table), 'verbatim', 'STORE');
  };
  return src === 'parquet' ? guardParquetSource(write) : write();
}

async function convertStructured(
  inputBuffer: Buffer,
  src: string,
  tgt: string,
  options: ConversionOptions,
  baseName: string
): Promise<ConversionResult> {
  const source = readStructuredSource(inputBuffer, src, tgt, options);

  switch (tgt) {
    case 'json':
      return textResult(stringifyJsonLossless(source.value, JSON_INDENT), 'application/json', baseName, 'json');
    case 'yaml':
    case 'yml':
      return textResult(writeYamlText(source.value), 'application/x-yaml', baseName, 'yaml');
    case 'toml':
      return textResult(writeTomlText(source.value), 'application/toml', baseName, 'toml');
    case 'xml':
      return textResult(serializeDataToXml(source.value), 'application/xml', baseName, 'xml');
    case 'txt':
      return textResult(source.text(), 'text/plain', baseName, 'txt');
    case 'ndjson':
      return textResult(
        source.records().map((record) => stringifyJsonLossless(record)).join('\n'),
        'application/x-ndjson',
        baseName,
        'ndjson'
      );
    default:
      break;
  }

  if (!TABLE_TARGETS.has(tgt)) {
    throw new UnsupportedTargetError(`Unsupported data conversion from ${src} to ${tgt}`);
  }
  const table = tabulate(source.records(), tgt, source.fields);
  assertTableUnicode(table, tgt);

  if (tgt === 'csv' || tgt === 'tsv') {
    return delimitedResult(writeDelimited(table.fields, table.rows, tgt, options), tgt, baseName);
  }
  if (tgt === 'parquet') {
    const parquetBuffer = encodeParquet(tableRecords(table));
    return { buffer: parquetBuffer, mimeType: 'application/vnd.apache.parquet', filename: `${baseName}.parquet`, size: parquetBuffer.length };
  }
  if (tgt === 'html') {
    return textResult(generateTableHtml(tableRecords(table), baseName), 'text/html', baseName, 'html');
  }
  if (tgt === 'pdf') {
    const pdfBuffer = await renderDataToPdf(table, baseName);
    return { buffer: pdfBuffer, mimeType: 'application/pdf', filename: `${baseName}.pdf`, size: pdfBuffer.length };
  }
  if (tgt === 'ods') {
    const odsBuffer = await generateOdsFromData(tableStrings(table), baseName);
    return { buffer: odsBuffer, mimeType: 'application/vnd.oasis.opendocument.spreadsheet', filename: `${baseName}.ods`, size: odsBuffer.length };
  }
  if (tgt === 'xls') {
    throw unconvertibleOfficeTarget(src, tgt);
  }
  const xlsxBuffer = await writeXlsx(tableSheet(table), 'verbatim');
  return {
    buffer: xlsxBuffer,
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    filename: `${baseName}.xlsx`,
    size: xlsxBuffer.length,
  };
}

function generateTableHtml(data: Record<string, unknown>[], title: string): string {
  if (!Array.isArray(data) || data.length === 0) {
    return `<!DOCTYPE html><html><body><p>Empty dataset</p></body></html>`;
  }

  const headers = dataObjectKeys(data[0] || {});
  const headerHtml = headers
    .map(
      (h) =>
        `<th style="padding: 10px; border: 1px solid #CCD2FC; background: #F0F2FE; color: #1F2340;">${escapeMarkupAttribute(
          h
        )}</th>`
    )
    .join('');
  const rowsHtml = data
    .map(
      (row) =>
        `<tr>${headers
          .map(
            (h) =>
              `<td style="padding: 8px 10px; border: 1px solid #E1E4EE; color: #4D536B;">${escapeMarkupAttribute(
                String(row[h] ?? '')
              )}</td>`
          )
          .join('')}</tr>`
    )
    .join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>${escapeMarkupAttribute(title)}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; padding: 2rem; color: #1F2340; }
    h1 { color: #5C6BC0; }
    table { border-collapse: collapse; width: 100%; max-width: 1000px; margin-top: 1rem; }
  </style>
</head>
<body>
  <h1>${escapeMarkupAttribute(title)}</h1>
  <table>
    <thead><tr>${headerHtml}</tr></thead>
    <tbody>${rowsHtml}</tbody>
  </table>
</body>
</html>`;
}

/**
 * Renders a table into a PDF that draws only its cells: the title is stored in the PDF metadata, every row is
 * drawn (paginated, with the header row repeated), long cell text wraps, and a table wider than the page
 * continues in further column groups.
 */
async function renderDataToPdf(table: DataTable, title: string): Promise<Buffer> {
  if (table.fields.length === 0 || table.rows.length === 0) {
    throw new ConversionFailedError('The dataset has no rows to draw in a PDF.');
  }
  const strings = tableStrings(table);
  return renderPdfTables(
    [{ rows: strings.map((row) => row.map((text) => ({ text }))), headerRows: 1 }],
    { title, orientation: 'landscape' }
  );
}
