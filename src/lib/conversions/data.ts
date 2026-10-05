import Papa from 'papaparse';
import iconv from 'iconv-lite';
import PDFDocument from 'pdfkit';
import { parse as parseToml, stringify as stringifyToml, TomlError } from 'smol-toml';
import {
  Document as YamlDocument,
  Scalar as YamlScalar,
  parseDocument as parseYamlDocument,
  visit as visitYaml,
  type ScalarTag,
} from 'yaml';
import {
  ConversionOptions,
  ConversionResult,
  DataEncodingError,
  DataLimitExceededError,
  DataParseError,
  DataRepresentationError,
  UnsupportedOptionError,
  UnsupportedTargetError,
} from '../types';
import { generateXlsxFromData, generateOdsFromData, generateXlsXmlFromData } from './office';
import { encodeParquet, decodeParquet } from './parquet';
import { assertNoComplexScript } from './ctl';
import {
  MAX_DATA_NESTING_DEPTH,
  isDataObject,
  normalizeDataValue,
  parseJsonLossless,
  setOwn,
  stringifyJsonLossless,
  type DataObject,
  type DataValue,
} from './data-json';
import { parseXmlDocument, serializeDataToXml, xmlRecords, xmlStringValue, xmlToJsonMl } from './data-xml';

export { encodeParquet, decodeParquet };

// ---------------------------------------------------------------------------
// Delimited text (CSV / TSV / TAB): input decoding
// ---------------------------------------------------------------------------

type ByteRange = readonly [first: number, last: number];

/** Byte-order marks that identify a Unicode encoding outright; a BOM wins over any label (WHATWG "decode"). */
const BOM_SIGNATURES: readonly { bytes: readonly number[]; encoding: string }[] = [
  { bytes: [0xef, 0xbb, 0xbf], encoding: 'utf-8' },
  { bytes: [0xff, 0xfe], encoding: 'utf-16le' },
  { bytes: [0xfe, 0xff], encoding: 'utf-16be' },
];

/** Leading bytes inspected for the NUL pattern of BOM-less UTF-16 text. */
const UTF16_SNIFF_BYTES = 4096;
/** Share of code units whose high byte must be NUL: ASCII-range UTF-16 text has one in every unit. */
const UTF16_NUL_LANE_MIN_SHARE = 0.5;
/** Share of code units whose other byte may be NUL before the NUL pattern stops looking like UTF-16. */
const UTF16_OTHER_LANE_MAX_SHARE = 0.05;
const ASCII_LIMIT = 0x80;
const REPLACEMENT_CHARACTER = 0xfffd;

/**
 * Decoding tables for the WHATWG legacy CJK encodings, whose decoders are CP949, Windows-31J and
 * GB 18030. Node's ICU TextDecoder does not implement them: its "euc-kr" lacks the CP949
 * extension rows and turns their lead bytes into C1 controls, and its "gbk" drops some valid
 * sequences, both without throwing in fatal mode. iconv-lite's tables match glibc iconv for
 * every CP949 and CP932 double-byte sequence.
 */
const LEGACY_CJK_TABLES: ReadonlyMap<string, string> = new Map([
  ['euc-kr', 'cp949'],
  ['shift_jis', 'cp932'],
  ['gbk', 'gb18030'],
  ['gb18030', 'gb18030'],
]);

interface LegacyEncodingCandidate {
  /** WHATWG encoding name, a key of LEGACY_CJK_TABLES. */
  encoding: string;
  /** Lead and trail byte ranges of the encoding's everyday repertoire. */
  leadBytes: readonly ByteRange[];
  trailBytes: readonly ByteRange[];
}

/**
 * Legacy CJK encodings tried, in tie-break order, when the input is neither BOM-marked, UTF-16
 * nor valid UTF-8. Every one of them decodes most byte soup without error, so each candidate is
 * also scored by how much of its decoded text falls inside the repertoire that real text in that
 * encoding uses: KS X 1001 symbols and the 2,350 common Hangul syllables, JIS X 0208 symbols,
 * kana and level-1 kanji, and GB 2312. Korean text decoded as GBK also lands inside GB 2312, so
 * EUC-KR comes before GBK; Japanese text decoded as GBK lands inside GBK's extension rows instead.
 */
const LEGACY_ENCODING_CANDIDATES: readonly LegacyEncodingCandidate[] = [
  { encoding: 'euc-kr', leadBytes: [[0xa1, 0xac], [0xb0, 0xc8]], trailBytes: [[0xa1, 0xfe]] },
  { encoding: 'shift_jis', leadBytes: [[0x81, 0x98]], trailBytes: [[0x40, 0x7e], [0x80, 0xfc]] },
  { encoding: 'gbk', leadBytes: [[0xa1, 0xf7]], trailBytes: [[0xa1, 0xfe]] },
];

/** Minimum share of non-ASCII characters that must fall in a candidate's everyday repertoire. */
const LEGACY_REPERTOIRE_MIN_SHARE = 0.5;

const legacyRepertoireCache = new Map<string, ReadonlySet<number>>();

/** Decodes with a legacy CJK table; null when any sequence is invalid (the table emits U+FFFD for it). */
function decodeLegacyCjk(bytes: Uint8Array, encoding: string): string | null {
  const table = LEGACY_CJK_TABLES.get(encoding);
  if (!table) return null;
  const text = iconv.decode(bytes, table, { stripBOM: false });
  return text.includes(String.fromCodePoint(REPLACEMENT_CHARACTER)) ? null : text;
}

/** Code points of a candidate's everyday repertoire, decoded once from its byte ranges. */
function legacyRepertoire(candidate: LegacyEncodingCandidate): ReadonlySet<number> {
  const cached = legacyRepertoireCache.get(candidate.encoding);
  if (cached) return cached;
  const repertoire = new Set<number>();
  const pair = new Uint8Array(2);
  for (const [leadFirst, leadLast] of candidate.leadBytes) {
    for (let lead = leadFirst; lead <= leadLast; lead++) {
      for (const [trailFirst, trailLast] of candidate.trailBytes) {
        for (let trail = trailFirst; trail <= trailLast; trail++) {
          pair[0] = lead;
          pair[1] = trail;
          const decoded = decodeLegacyCjk(pair, candidate.encoding);
          const codePoint = decoded?.codePointAt(0);
          if (
            decoded &&
            codePoint !== undefined &&
            codePoint >= ASCII_LIMIT &&
            decoded.length === String.fromCodePoint(codePoint).length
          ) {
            repertoire.add(codePoint);
          }
        }
      }
    }
  }
  legacyRepertoireCache.set(candidate.encoding, repertoire);
  return repertoire;
}

function repertoireShare(text: string, repertoire: ReadonlySet<number>): number {
  let nonAscii = 0;
  let inRepertoire = 0;
  for (const char of text) {
    const codePoint = char.codePointAt(0) ?? 0;
    if (codePoint < ASCII_LIMIT) continue;
    nonAscii++;
    if (repertoire.has(codePoint)) inRepertoire++;
  }
  return nonAscii === 0 ? 0 : inRepertoire / nonAscii;
}

function sniffBom(bytes: Uint8Array): string | null {
  for (const { bytes: signature, encoding } of BOM_SIGNATURES) {
    if (bytes.length >= signature.length && signature.every((byte, index) => bytes[index] === byte)) {
      return encoding;
    }
  }
  return null;
}

/** BOM-less UTF-16 from its NUL lane: Latin-script text puts a zero byte in every code unit. */
function sniffUtf16ByNulPattern(bytes: Uint8Array): string | null {
  const units = Math.floor(Math.min(bytes.length, UTF16_SNIFF_BYTES) / 2);
  if (units === 0) return null;
  let evenNul = 0;
  let oddNul = 0;
  for (let unit = 0; unit < units; unit++) {
    if (bytes[unit * 2] === 0) evenNul++;
    if (bytes[unit * 2 + 1] === 0) oddNul++;
  }
  const nulLaneMin = units * UTF16_NUL_LANE_MIN_SHARE;
  const otherLaneMax = units * UTF16_OTHER_LANE_MAX_SHARE;
  if (oddNul >= nulLaneMin && evenNul <= otherLaneMax) return 'utf-16le';
  if (evenNul >= nulLaneMin && oddNul <= otherLaneMax) return 'utf-16be';
  return null;
}

/** Decodes with a canonical WHATWG encoding name; invalid input throws instead of yielding U+FFFD. */
function decodeStrict(bytes: Uint8Array, encoding: string): string {
  if (LEGACY_CJK_TABLES.has(encoding)) {
    const text = decodeLegacyCjk(bytes, encoding);
    if (text === null) throw new DataEncodingError(`Input is not valid ${encoding} text.`);
    return text;
  }
  try {
    // ignoreBOM stays false, so a BOM of this encoding is stripped.
    return new TextDecoder(encoding, { fatal: true }).decode(bytes);
  } catch {
    throw new DataEncodingError(`Input is not valid ${encoding} text.`);
  }
}

function canonicalEncoding(label: string): string {
  try {
    return new TextDecoder(label).encoding;
  } catch {
    throw new UnsupportedOptionError(`Option "encoding" must be a WHATWG encoding label; "${label}" is not one.`);
  }
}

function detectLegacyCjkText(bytes: Uint8Array): string | null {
  let best: { text: string; share: number } | null = null;
  for (const candidate of LEGACY_ENCODING_CANDIDATES) {
    const text = decodeLegacyCjk(bytes, candidate.encoding);
    if (text === null) continue;
    const share = repertoireShare(text, legacyRepertoire(candidate));
    // Strictly greater: on a tie the earlier candidate keeps its place.
    if (share >= LEGACY_REPERTOIRE_MIN_SHARE && (!best || share > best.share)) {
      best = { text, share };
    }
  }
  return best ? best.text : null;
}

/**
 * Decodes delimited-text bytes: a BOM decides first, then an explicit `encoding` option, then the
 * NUL pattern of BOM-less UTF-16, then strict UTF-8 (TextDecoder, fatal), then the scored legacy
 * CJK candidates. Every decode is strict, so undecodable bytes raise a DataEncodingError instead
 * of turning into U+FFFD.
 */
function decodeDelimitedText(bytes: Uint8Array, requestedEncoding?: string): string {
  const bomEncoding = sniffBom(bytes);
  if (bomEncoding) return decodeStrict(bytes, bomEncoding);
  if (requestedEncoding !== undefined) return decodeStrict(bytes, canonicalEncoding(requestedEncoding));
  const utf16 = sniffUtf16ByNulPattern(bytes);
  if (utf16) return decodeStrict(bytes, utf16);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    // Not UTF-8: fall through to the legacy candidates.
  }
  const legacy = detectLegacyCjkText(bytes);
  if (legacy === null) {
    throw new DataEncodingError(
      'Could not detect the text encoding (tried UTF-8, UTF-16, EUC-KR/CP949, Shift_JIS and GBK); pass the "encoding" option.'
    );
  }
  return legacy;
}

// ---------------------------------------------------------------------------
// Delimited text: delimiter detection and parsing
// ---------------------------------------------------------------------------

/** Delimiters tried, in tie-break order, after the source format's own delimiter. */
const DELIMITER_CANDIDATES: readonly string[] = [',', ';', '\t', '|'];
/** Records sampled when detecting the delimiter. */
const DELIMITER_SAMPLE_RECORDS = 50;
/** Papa counts FieldMismatch rows from 0 after the header; our rows are 1-based and include the header. */
const FIELD_MISMATCH_ROW_OFFSET = 2;
/** Papa counts quote-error rows from 0 including the header row. */
const QUOTE_ERROR_ROW_OFFSET = 1;

interface DelimitedTable {
  fields: string[];
  records: Record<string, string>[];
  /** The decoded input text. */
  text: string;
  delimiter: string;
}

/** Field count of the sampled records when they all agree, else 0. */
function consistentFieldCount(text: string, delimiter: string): number {
  const sample = Papa.parse<string[]>(text, { delimiter, preview: DELIMITER_SAMPLE_RECORDS, skipEmptyLines: true });
  if (sample.errors.length > 0 || sample.data.length === 0) return 0;
  const width = sample.data[0].length;
  return sample.data.every((record) => record.length === width) ? width : 0;
}

/**
 * The source format's own delimiter wins when it splits the sampled records into a consistent
 * table of two or more columns; otherwise the candidate with the widest consistent table does.
 * A file no candidate splits consistently keeps the format's delimiter (a one-column table, or a
 * parse error that names the offending row).
 */
function detectDelimiter(text: string, nominal: string): string {
  if (consistentFieldCount(text, nominal) > 1) return nominal;
  let best = nominal;
  let bestWidth = 1;
  for (const candidate of DELIMITER_CANDIDATES) {
    if (candidate === nominal) continue;
    const width = consistentFieldCount(text, candidate);
    if (width > bestWidth) {
      best = candidate;
      bestWidth = width;
    }
  }
  return best;
}

function resolveDelimiter(text: string, src: string, requested?: string): string {
  return requested ?? detectDelimiter(text, src === 'csv' ? ',' : '\t');
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
  if (typeof options !== 'object' || options === null || Array.isArray(options)) {
    throw new UnsupportedOptionError('Conversion options must be an object.');
  }
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

function lineNumberAt(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) {
    if (text.charCodeAt(i) === 0x0a) line++;
  }
  return line;
}

function delimitedParseError(error: Papa.ParseError, text: string, src: string): DataParseError {
  let row: number | undefined;
  if (typeof error.row === 'number') {
    row = error.row + (error.type === 'FieldMismatch' ? FIELD_MISMATCH_ROW_OFFSET : QUOTE_ERROR_ROW_OFFSET);
  }
  const line = typeof error.index === 'number' ? lineNumberAt(text, error.index) : undefined;
  const where = [row !== undefined ? `row ${row}` : '', line !== undefined ? `line ${line}` : ''].filter(Boolean).join(', ');
  return new DataParseError(
    `Failed to parse ${src.toUpperCase()}: ${error.message}${where ? ` (${where})` : ''}.`,
    { row, line }
  );
}

/** Decodes and parses delimited text with a header record; any parse error fails closed. */
function parseDelimitedTable(inputBuffer: Buffer, src: string, options: ConversionOptions): DelimitedTable {
  const text = decodeDelimitedText(inputBuffer, options.encoding);
  const delimiter = resolveDelimiter(text, src, options.delimiter);
  const parsed = Papa.parse<Record<string, string>>(text, { header: true, skipEmptyLines: true, delimiter });
  if (parsed.errors.length > 0) {
    const errors = parsed.errors.map((error) => delimitedParseError(error, text, src));
    errors.sort((a, b) => (a.row ?? Number.MAX_SAFE_INTEGER) - (b.row ?? Number.MAX_SAFE_INTEGER));
    throw errors[0];
  }
  return { fields: parsed.meta.fields ?? [], records: parsed.data, text, delimiter };
}

// ---------------------------------------------------------------------------
// Delimited text: output
// ---------------------------------------------------------------------------

/**
 * Cells a spreadsheet evaluates as a formula: a leading = + - @ TAB or CR. Plain numeric literals
 * (-5, +1.5e3) are values, not formulas, so they are left alone.
 */
const FORMULA_TRIGGER = /^(?![+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$)[=+\-@\t\r]/;
const UTF8_BOM_CHAR = '\uFEFF';

/**
 * Writes CSV or TSV. A UTF-8 BOM is on by default for CSV, the format spreadsheet applications
 * open directly and decode as UTF-8 only when the BOM is present; it is off by default for TSV,
 * which mostly feeds data tooling where a BOM would corrupt the first header. Formula cells are
 * prefixed with ' and quoted unless `escapeFormulas` is false.
 */
function writeDelimited(fields: string[], rows: readonly (readonly unknown[])[], tgt: string, options: ConversionOptions): Buffer {
  const delimiter = tgt === 'tsv' ? '\t' : ',';
  const escapeFormulas = options.escapeFormulas ?? true;
  const withBom = options.bom ?? tgt === 'csv';
  const data = rows.map((row) => row.map((cell) => cell ?? ''));
  const text = Papa.unparse(
    { fields, data },
    {
      delimiter,
      escapeFormulae: escapeFormulas ? FORMULA_TRIGGER : false,
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
    const keys = Object.keys(value);
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

/** A table over the union of all records' columns in first-seen order; a non-object record fills "value". */
function tabulate(records: DataValue[], leadingFields: readonly string[] = []): DataTable {
  const fieldIndex = new Map<string, number>(leadingFields.map((field, index) => [field, index]));
  const flattened = records.map((record) => {
    const cells = new Map<string, DataValue>();
    if (isDataObject(record)) flattenInto(record, '', cells);
    else setCell(cells, 'value', Array.isArray(record) ? stringifyJsonLossless(record) : record);
    for (const field of cells.keys()) {
      if (!fieldIndex.has(field)) fieldIndex.set(field, fieldIndex.size);
    }
    return cells;
  });
  const fields = [...fieldIndex.keys()];
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

function tableStrings(table: DataTable): string[][] {
  return [table.fields, ...table.rows.map((row) => row.map(cellText))];
}

// ---------------------------------------------------------------------------
// Structured sources: JSON, NDJSON, YAML, TOML, XML, parquet, delimited text
// ---------------------------------------------------------------------------

/** Alias resolutions per YAML document (the yaml library's default); more indicates an expansion attack. */
const MAX_YAML_ALIAS_COUNT = 100;
/** Values a YAML document may expand to per value written in its source. */
const YAML_EXPANSION_FACTOR = 10;
/** Values every YAML document may expand to regardless of its own size. */
const YAML_MIN_EXPANDED_VALUES = 100_000;
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
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new DataEncodingError(`${format} input is not valid UTF-8 text.`);
  }
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

function parseYamlText(text: string): DataValue {
  const document = parseYamlDocument(text, { intAsBigInt: true, merge: true, uniqueKeys: true });
  const [first] = document.errors;
  if (first) {
    const position = first.linePos?.[0];
    throw new DataParseError(`YAML parsing failed: ${first.message.split('\n')[0]}`, {
      line: position?.line,
      column: position?.col,
    });
  }
  let sourceValues = 0;
  visitYaml(document, {
    Node() {
      sourceValues++;
    },
  });
  let raw: unknown;
  try {
    raw = document.toJS({ maxAliasCount: MAX_YAML_ALIAS_COUNT });
  } catch (err) {
    if (err instanceof ReferenceError) {
      throw new DataLimitExceededError(`YAML alias expansion exceeds the cap of ${MAX_YAML_ALIAS_COUNT} aliases: ${err.message}.`);
    }
    throw new DataParseError(`YAML parsing failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  return normalizeDataValue(raw, {
    maxValues: Math.max(YAML_MIN_EXPANDED_VALUES, sourceValues * YAML_EXPANSION_FACTOR),
    label: 'YAML document',
  });
}

function parseTomlText(text: string): DataValue {
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

function asRecords(value: DataValue): DataValue[] {
  return Array.isArray(value) ? value : [value];
}

function readStructuredSource(inputBuffer: Buffer, src: string, tgt: string, options: ConversionOptions): StructuredSource {
  if (src === 'csv' || src === 'tsv' || src === 'tab') {
    const table = parseDelimitedTable(inputBuffer, src, options);
    return { value: table.records, records: () => table.records, fields: table.fields, text: () => table.text };
  }
  if (src === 'json') {
    const value = parseJsonLossless(decodeUtf8Text(inputBuffer, 'JSON'));
    return { value, records: () => asRecords(value), text: () => stringifyJsonLossless(value, JSON_INDENT) };
  }
  if (src === 'ndjson' || src === 'jsonl') {
    const records = parseNdjsonText(decodeUtf8Text(inputBuffer, src.toUpperCase()), src);
    return { value: records, records: () => records, text: () => stringifyJsonLossless(records, JSON_INDENT) };
  }
  if (src === 'yaml' || src === 'yml') {
    const bom = sniffBom(inputBuffer);
    const text = decodeStrict(inputBuffer, bom ?? 'utf-8');
    const value = parseYamlText(text);
    return { value, records: () => asRecords(value), text: () => text };
  }
  if (src === 'toml') {
    const text = decodeUtf8Text(inputBuffer, 'TOML');
    const value = parseTomlText(text);
    return { value, records: () => [value], text: () => text };
  }
  if (src === 'xml') {
    const root = parseXmlDocument(decodeXmlText(inputBuffer));
    return { value: xmlToJsonMl(root), records: () => xmlRecords(root), text: () => xmlStringValue(root) };
  }
  if (src === 'parquet') {
    const records = asRecords(
      normalizeDataValue(decodeParquet(inputBuffer), { maxValues: Number.POSITIVE_INFINITY, label: 'Parquet file' })
    );
    return { value: records, records: () => records, text: () => stringifyJsonLossless(records, JSON_INDENT) };
  }
  throw new Error(`Unsupported data conversion from ${src} to ${tgt}`);
}

// ---------------------------------------------------------------------------
// Structured targets
// ---------------------------------------------------------------------------

/**
 * Characters a YAML stream may carry only as escapes (outside c-printable: C0 and C1 controls,
 * DEL, unpaired surrogates, U+FFFE/U+FFFF), plus NEL, LS and PS, which YAML 1.1 reads as line breaks.
 */
const YAML_ESCAPE_ONLY = /[\0-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F\u2028\u2029\uFFFE\uFFFF\uD800-\uDFFF]/u;
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
  const document = new YamlDocument(value, {
    compat: 'yaml-1.1',
    aliasDuplicateObjects: false,
    customTags: (tags) => [YAML_EXPONENT_FLOAT_TAG, ...tags],
  });
  visitYaml(document, {
    Scalar(_key, node) {
      // YAML 1.1 readers also reject a tab inside a plain scalar, which YAML 1.2 allows.
      if (typeof node.value === 'string' && (node.value.includes('\t') || YAML_ESCAPE_ONLY.test(node.value))) {
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
    for (const [key, child] of Object.entries(value)) {
      const childPath = path === '' ? key : `${path}.${key}`;
      if (UNPAIRED_SURROGATE.test(key)) {
        throw new DataRepresentationError(`TOML keys must be valid Unicode; "${childPath}" holds an unpaired surrogate.`);
      }
      assertTomlRepresentable(child, childPath);
    }
  }
}

function writeTomlText(value: DataValue): string {
  if (!isDataObject(value)) {
    throw new DataRepresentationError('A TOML document is a table; the input must be a JSON object or YAML mapping.');
  }
  assertTomlRepresentable(value, '');
  return stringifyToml(value, { maxDepth: MAX_DATA_NESTING_DEPTH });
}

function textResult(text: string, mimeType: string, baseName: string, extension: string): ConversionResult {
  const buffer = Buffer.from(text, 'utf-8');
  return { buffer, mimeType, filename: `${baseName}.${extension}`, size: buffer.length };
}

export async function convertData(
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
    throw new Error(`Unsupported data conversion from ${sourceFormat} to ${targetFormat}`);
  }
  const table = tabulate(source.records(), source.fields);

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
    const pdfBuffer = await renderDataToPdf(tableRecords(table), baseName, options);
    return { buffer: pdfBuffer, mimeType: 'application/pdf', filename: `${baseName}.pdf`, size: pdfBuffer.length };
  }
  if (tgt === 'ods') {
    const odsBuffer = await generateOdsFromData(tableStrings(table), baseName);
    return { buffer: odsBuffer, mimeType: 'application/vnd.oasis.opendocument.spreadsheet', filename: `${baseName}.ods`, size: odsBuffer.length };
  }
  if (tgt === 'xls') {
    return textResult(generateXlsXmlFromData(tableStrings(table), baseName), 'application/vnd.ms-excel', baseName, 'xls');
  }
  // xlsx: the workbook writer reads RFC 4180 CSV, so it gets the table without BOM or formula escaping.
  const csvText = Papa.unparse({ fields: table.fields, data: table.rows.map((row) => row.map(cellText)) });
  const xlsxBuffer = await generateXlsxFromData(Buffer.from(csvText, 'utf-8'), 'csv', { ...options, delimiter: ',' }, baseName);
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

  const headers = Object.keys(data[0] || {});
  const headerHtml = headers
    .map(
      (h) =>
        `<th style="padding: 10px; border: 1px solid #CCD2FC; background: #F0F2FE; color: #1F2340;">${escapeHtml(
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
              `<td style="padding: 8px 10px; border: 1px solid #E1E4EE; color: #4D536B;">${escapeHtml(
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
  <title>${escapeHtml(title)}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; padding: 2rem; color: #1F2340; }
    h1 { color: #5C6BC0; }
    table { border-collapse: collapse; width: 100%; max-width: 1000px; margin-top: 1rem; }
  </style>
</head>
<body>
  <h1>${escapeHtml(title)}</h1>
  <table>
    <thead><tr>${headerHtml}</tr></thead>
    <tbody>${rowsHtml}</tbody>
  </table>
</body>
</html>`;
}

function escapeHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Renders structured tabular dataset into a formatted PDF document with lavender palette
 */
async function renderDataToPdf(
  data: Record<string, unknown>[],
  title: string,
  options: ConversionOptions
): Promise<Buffer> {
  assertNoComplexScript(title, 'Pure-TS Data to PDF');
  if (Array.isArray(data)) {
    for (const item of data) {
      if (item && typeof item === 'object') {
        for (const [key, val] of Object.entries(item)) {
          assertNoComplexScript(key, 'Pure-TS Data to PDF');
          if (typeof val === 'string') {
            assertNoComplexScript(val, 'Pure-TS Data to PDF');
          }
        }
      }
    }
  }

  return new Promise<Buffer>((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      layout: 'landscape',
      margin: 30,
    });

    const chunks: Buffer[] = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', (err) => reject(err));

    // Title header
    doc.fillColor('#5C6BC0').fontSize(16).text(title, 30, 30);
    doc.fillColor('#8E95AF').fontSize(9).text(`Structured Data Export • ${new Date().toLocaleDateString()}`, 30, 50);

    if (!Array.isArray(data) || data.length === 0) {
      doc.fillColor('#4D536B').fontSize(11).text('No records found in dataset.', 30, 80);
      doc.end();
      return;
    }

    const headers = Object.keys(data[0] || {}).slice(0, 10);
    if (headers.length === 0) {
      doc.end();
      return;
    }

    const startX = 30;
    const startY = 75;
    const pageWidth = doc.page.width - 60;
    const colWidth = Math.floor(pageWidth / headers.length);
    const rowHeight = 22;

    let currY = startY;

    // Header Background
    doc.rect(startX, currY, pageWidth, rowHeight).fill('#F0F2FE');
    doc.rect(startX, currY, pageWidth, rowHeight).strokeColor('#CCD2FC').lineWidth(1).stroke();

    headers.forEach((h, idx) => {
      doc.fillColor('#1F2340').fontSize(10).font('Helvetica-Bold');
      doc.text(h, startX + idx * colWidth + 6, currY + 6, {
        width: colWidth - 12,
        ellipsis: true,
      });
    });

    currY += rowHeight;

    // Data rows
    doc.font('Helvetica');
    data.slice(0, 200).forEach((row, rIdx) => {
      if (currY + rowHeight > doc.page.height - 40) {
        doc.addPage({ size: 'A4', layout: 'landscape', margin: 30 });
        currY = 30;
      }

      if (rIdx % 2 === 1) {
        doc.rect(startX, currY, pageWidth, rowHeight).fill('#FAFAFE');
      }
      doc.rect(startX, currY, pageWidth, rowHeight).strokeColor('#E1E4EE').lineWidth(0.5).stroke();

      headers.forEach((h, idx) => {
        const val = String(row[h] ?? '');
        doc.fillColor('#4D536B').fontSize(9);
        doc.text(val, startX + idx * colWidth + 6, currY + 6, {
          width: colWidth - 12,
          ellipsis: true,
        });
      });

      currY += rowHeight;
    });

    doc.end();
  });
}
