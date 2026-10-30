import Papa from 'papaparse';
import { DataParseError } from '../types';
import { positionOf, setOwn, type DataObject } from './data-json';

/**
 * Reading delimited-text input (delimiter detection, line-break guess, header naming, records),
 * shared by the server data engine, the browser streaming path and the pure data module so all
 * of them read a file the same way. Browser-safe: it depends only on papaparse and data-json.
 */

/** Delimiters tried, in tie-break order, after the source format's own delimiter. */
export const DELIMITER_CANDIDATES: readonly string[] = [',', ';', '\t', '|'];
/** Records sampled when detecting the delimiter. */
export const DELIMITER_SAMPLE_RECORDS = 50;

/** The delimiter a delimited format nominally uses: comma for CSV, TAB for TSV/TAB. */
export function nominalDelimiter(sourceFormat: string): string {
  return sourceFormat === 'csv' ? ',' : '\t';
}

function sampleRecords(text: string, delimiter: string): Papa.ParseResult<string[]> {
  return Papa.parse<string[]>(text, { delimiter, preview: DELIMITER_SAMPLE_RECORDS, skipEmptyLines: true });
}

/** Field count of the sampled records when they all agree, else 0. */
function consistentFieldCount(text: string, delimiter: string): number {
  const sample = sampleRecords(text, delimiter);
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
export function detectDelimiter(text: string, nominal: string): string {
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

/**
 * Whether a prefix of the input already holds the whole delimiter sample, so detecting on it
 * gives the same answer as detecting on the full text: for every candidate the parser stopped at
 * the sample limit with input left over (so the last sampled record was ended by a line break),
 * and the prefix covers the window papaparse inspects to guess the line break.
 */
export function isDelimiterSampleComplete(prefix: string, lineBreakWindowChars: number): boolean {
  if (prefix.length < lineBreakWindowChars) return false;
  return DELIMITER_CANDIDATES.every((candidate) => {
    const sample = sampleRecords(prefix, candidate);
    return sample.meta.truncated && sample.meta.cursor < prefix.length;
  });
}

/** papaparse guesses the line break from the first 1 MiB of text. */
export const LINE_BREAK_GUESS_WINDOW_CHARS = 1024 * 1024;
/** Quoted spans, removed before counting line breaks (papaparse's lazy quote-to-quote match). */
const QUOTED_SPAN = /"([^]*?)"/gm;

/**
 * The one line break a delimited text uses, guessed exactly as papaparse guesses it: over the
 * first 1 MiB with quoted spans removed, LF when there is no CR or an LF comes before the first
 * CR; otherwise CRLF when at least half of the CR-separated pieces start with LF, else CR. The
 * server passes it to the parser and the stream splits records on it, so both read the same rows.
 */
export function guessLineBreak(text: string): '\n' | '\r\n' | '\r' {
  const window = text.substring(0, LINE_BREAK_GUESS_WINDOW_CHARS).replace(QUOTED_SPAN, '');
  const byCr = window.split('\r');
  const byLf = window.split('\n');
  const lfAppearsFirst = byLf.length > 1 && byLf[0].length < byCr[0].length;
  if (byCr.length === 1 || lfAppearsFirst) return '\n';
  const piecesStartingWithLf = byCr.filter((piece) => piece[0] === '\n').length;
  return piecesStartingWithLf >= byCr.length / 2 ? '\r\n' : '\r';
}

const BOM = '﻿';

/**
 * Header names for both the server parser and the stream, following papaparse's `header: true`
 * naming: a leading BOM is stripped from each, and a repeated name becomes name_N with the first
 * N that is not already a header (a, a, a_1 -> a, a_2, a_1). Callers key records with own
 * properties, so names such as __proto__ stay ordinary columns.
 */
export function renameDuplicateHeaders(headers: readonly string[]): string[] {
  const seenCount = new Map<string, number>();
  const used = new Set(headers);
  return headers.map((raw) => {
    const header = raw.startsWith(BOM) ? raw.slice(BOM.length) : raw;
    const count = seenCount.get(header);
    let name = header;
    if (count === undefined) {
      seenCount.set(header, 1);
    } else {
      let suffix = count;
      do {
        name = `${header}_${suffix}`;
        suffix++;
      } while (used.has(name));
      used.add(name);
      seenCount.set(header, count + 1);
    }
    used.add(header);
    return name;
  });
}

/** papaparse counts quote-error rows from 0 over every line, blank ones included; our rows are 1-based. */
const QUOTE_ERROR_ROW_OFFSET = 1;

function quoteParseError(error: Papa.ParseError, text: string, src: string): DataParseError {
  const row = typeof error.row === 'number' ? error.row + QUOTE_ERROR_ROW_OFFSET : undefined;
  const line = typeof error.index === 'number' ? positionOf(text, error.index).line : undefined;
  const where = [row !== undefined ? `row ${row}` : '', line !== undefined ? `line ${line}` : ''].filter(Boolean).join(', ');
  return new DataParseError(
    `Failed to parse ${src.toUpperCase()}: ${error.message}${where ? ` (${where})` : ''}.`,
    { row, line }
  );
}

/** Papaparse's reading of delimited text, every line included; any quote problem throws the DataParseError with the lowest row. */
function parseDelimitedText(text: string, delimiter: string, src: string): Papa.ParseResult<string[]> {
  const parsed = Papa.parse<string[]>(text, { skipEmptyLines: false, delimiter, newline: guessLineBreak(text) });
  if (parsed.errors.length > 0) {
    const errors = parsed.errors.map((error) => quoteParseError(error, text, src));
    errors.sort((a, b) => (a.row ?? Number.MAX_SAFE_INTEGER) - (b.row ?? Number.MAX_SAFE_INTEGER));
    throw errors[0];
  }
  return parsed;
}

/**
 * The rows of delimited text as a sheet holds them: the lines that are not blank, each with the fields it has. Unlike
 * `parseDelimitedRecords` the rows are not evened out to a header, because a sheet cell that a row lacks is empty. Any quote
 * problem throws the same DataParseError.
 */
export function parseDelimitedRows(text: string, delimiter: string, src: string): string[][] {
  return parseDelimitedText(text, delimiter, src).data.filter((row) => !isBlankRow(row));
}

function isBlankRow(row: readonly string[]): boolean {
  return row.length === 1 && row[0] === '';
}

/** Name of a column the header does not cover, as pandas names a header cell without a name (`Unnamed: <index>`). */
const UNNAMED_COLUMN_PREFIX = 'Unnamed: ';

/**
 * Records whose field count differs from the table's. A table is as wide as its widest record (LibreOffice's text import widens
 * the sheet to the widest line; pandas' tokenizer pads a short record with empty fields, Python's `csv.DictReader` fills it with
 * `restval`); the header names the columns it covers and the rest are `Unnamed: <index>`. Rows are numbered over every line,
 * blank ones included, like quote errors.
 */
export interface RaggedRows {
  headerWidth: number;
  width: number;
  /** The first row that has `width` fields. */
  widestRow: number;
  /** Records that are not blank lines, the header included. */
  records: number;
  /** Fields of all those records, before any padding. */
  cells: number;
  /** Data records with more fields than the header. */
  longerThanHeader: RowTally | null;
  /** Data records with fewer fields than the widest record. */
  shorterThanWidest: RowTally | null;
}

/** How many records have a trait, and the row of the first. */
interface RowTally {
  count: number;
  firstRow: number;
}

function countRow(tally: RowTally | null, row: number): RowTally {
  return { count: (tally?.count ?? 0) + 1, firstRow: tally?.firstRow ?? row };
}

/** Counts how the records of `data` (blank lines included) differ in width; null when they all have the header's width. */
function tallyRaggedRows(data: readonly (readonly string[])[]): RaggedRows | null {
  let headerWidth = -1;
  let width = 0;
  let widestRow = 0;
  let records = 0;
  let cells = 0;
  data.forEach((fields, index) => {
    if (isBlankRow(fields)) return;
    if (headerWidth < 0) headerWidth = fields.length;
    if (fields.length > width) {
      width = fields.length;
      widestRow = index + 1;
    }
    records++;
    cells += fields.length;
  });
  if (headerWidth < 0) return null;
  let longer: RowTally | null = null;
  let shorter: RowTally | null = null;
  let headerSeen = false;
  for (let index = 0; index < data.length; index++) {
    const fields = data[index];
    if (isBlankRow(fields)) continue;
    if (!headerSeen) {
      headerSeen = true;
      continue;
    }
    const row = index + 1;
    if (fields.length > headerWidth) longer = countRow(longer, row);
    if (fields.length < width) shorter = countRow(shorter, row);
  }
  if (width === headerWidth && shorter === null) return null;
  return { headerWidth, width, widestRow, records, cells, longerThanHeader: longer, shorterThanWidest: shorter };
}

/**
 * Most columns a ragged table may be padded to: the 16,384 (XFD) columns of a sheet in Excel ("Excel specifications and limits",
 * Microsoft) and in LibreOffice Calc (MAXCOLCOUNT = 16 * 1024, sc/inc/address.hxx), the applications whose text import widens the
 * sheet to the widest line.
 */
export const DELIMITED_MAX_COLUMNS = 16_384;
/** Most records a ragged table may hold: the 1,048,576 rows of a sheet (Excel; MAXROWCOUNT = 1024 * 1024, sc/inc/address.hxx). */
export const DELIMITED_MAX_RECORDS = 1_048_576;
/** Longest field, in characters, of a ragged table: Python's `csv.field_size_limit` default of 128 * 1024 (Modules/_csv.c, `field_limit`). */
export const DELIMITED_MAX_FIELD_CHARS = 131_072;
/** Cells a ragged table may be padded to however few the file holds: PDF_TABLE_MAX_CELLS, the most the table writer draws; about 75 MB of heap. */
const RAGGED_FREE_CELLS = 1_000_000;
/**
 * Times the cells a file holds that padding may make of them, as a YAML document may expand to a multiple of its values
 * (YAML_EXPANSION_FACTOR in data.ts) with a floor of its own.
 */
const RAGGED_EXPANSION_FACTOR = 4;

function raggedRefusal(src: string, row: number, problem: string): DataParseError {
  return new DataParseError(`Failed to parse ${src.toUpperCase()}: row ${row} ${problem}`, { row });
}

/** The row of the first field of `data` longer than the limit, with its length, or null. */
function firstOverlongField(data: readonly (readonly string[])[]): { row: number; length: number } | null {
  for (let index = 0; index < data.length; index++) {
    for (const field of data[index]) {
      if (field.length > DELIMITED_MAX_FIELD_CHARS) return { row: index + 1, length: field.length };
    }
  }
  return null;
}

/** The row of the first record past the limit; records are the lines that are not blank. */
function firstRowPastRecordLimit(data: readonly (readonly string[])[]): number {
  let records = 0;
  for (let index = 0; index < data.length; index++) {
    if (!isBlankRow(data[index]) && ++records > DELIMITED_MAX_RECORDS) return index + 1;
  }
  return data.length;
}

/**
 * Refuses a ragged table that is larger than the readers it follows hold, naming the row. The limits bound what this reading
 * newly accepts; a table whose records all have the header's width is read as before. Every record is padded to the widest one,
 * so a single wide record costs width times rows: 400 million cells (about 30 GB of heap) from an 80 KB file with 20,000 rows and
 * one record of 20,000 fields.
 */
function assertRaggedTableFits(ragged: RaggedRows, data: readonly (readonly string[])[], src: string): void {
  if (ragged.width > DELIMITED_MAX_COLUMNS) {
    throw raggedRefusal(src, ragged.widestRow, `has ${ragged.width} fields; a table is limited to ${DELIMITED_MAX_COLUMNS} columns, as a sheet of a spreadsheet application is.`);
  }
  if (ragged.records > DELIMITED_MAX_RECORDS) {
    throw raggedRefusal(src, firstRowPastRecordLimit(data), `is record ${DELIMITED_MAX_RECORDS + 1}; a table is limited to ${DELIMITED_MAX_RECORDS} rows, as a sheet of a spreadsheet application is.`);
  }
  const padded = ragged.width * ragged.records;
  if (padded > RAGGED_FREE_CELLS && padded > RAGGED_EXPANSION_FACTOR * ragged.cells) {
    throw raggedRefusal(
      src,
      ragged.widestRow,
      `has ${ragged.width} fields, and padding the other ${ragged.records - 1} rows to it would make ${padded} cells from ${ragged.cells}; ` +
        `a ragged table may hold up to ${RAGGED_EXPANSION_FACTOR} times its cells.`
    );
  }
  const overlong = firstOverlongField(data);
  if (overlong !== null) {
    throw raggedRefusal(src, overlong.row, `has a field of ${overlong.length} characters; a field is limited to ${DELIMITED_MAX_FIELD_CHARS} characters.`);
  }
}

function rowsPhrase(count: number, firstRow: number, one: string, many: string): string {
  return `${count} ${count === 1 ? `row ${one}` : `rows ${many}`} (the first is row ${firstRow})`;
}

/** One line per kind of deviation, for `metadata.warnings` of the conversion. */
export function raggedRowWarnings(ragged: RaggedRows | null, src: string): string[] {
  if (ragged === null) return [];
  const label = src.toUpperCase();
  const lines: string[] = [];
  const { longerThanHeader, shorterThanWidest, headerWidth, width } = ragged;
  if (longerThanHeader) {
    const added = width - headerWidth;
    const first = `${UNNAMED_COLUMN_PREFIX}${headerWidth}`;
    const names = added === 1 ? first : `${first} to ${UNNAMED_COLUMN_PREFIX}${width - 1}`;
    lines.push(
      `${label}: ${rowsPhrase(longerThanHeader.count, longerThanHeader.firstRow, 'has more fields than the header', 'have more fields than the header')}; ` +
        `${added} ${added === 1 ? 'column was' : 'columns were'} added, named ${names}.`
    );
  }
  if (shorterThanWidest) {
    const { count, firstRow } = shorterThanWidest;
    lines.push(
      `${label}: ${rowsPhrase(count, firstRow, 'has fewer fields than the widest row', 'have fewer fields than the widest row')}; ` +
        `${count === 1 ? 'its' : 'their'} missing cells are empty.`
    );
  }
  return lines;
}

export interface DelimitedRecords {
  fields: string[];
  records: DataObject[];
  /** How the records differ in width, when they do; the table is then as wide as the widest record. */
  ragged: RaggedRows | null;
}

/** Widens the header with `Unnamed: <index>` names and fills every short record with empty fields, in place. */
function evenOutRows(rows: string[][], ragged: RaggedRows): void {
  const header = rows[0];
  for (let index = header.length; index < ragged.width; index++) header.push(`${UNNAMED_COLUMN_PREFIX}${index}`);
  for (const row of rows) {
    while (row.length < ragged.width) row.push('');
  }
}

/**
 * Parses decoded delimited text with a header record. Rows are read as arrays on the line break
 * guessLineBreak picks (as the browser stream does) and keyed with own properties, so a column
 * named __proto__ or constructor keeps its values; duplicate header names are renamed (a, a_1,
 * ...) and blank lines skipped. A record with fewer fields than the widest is filled out with
 * empty cells and one with more widens the table (see RaggedRows); any quote problem throws the
 * DataParseError with the lowest row.
 */
export function parseDelimitedRecords(text: string, delimiter: string, src: string): DelimitedRecords {
  const parsed = parseDelimitedText(text, delimiter, src);
  const ragged = tallyRaggedRows(parsed.data);
  const rows = parsed.data.filter((row) => !isBlankRow(row));
  if (rows.length === 0) return { fields: [], records: [], ragged };
  if (ragged !== null) {
    assertRaggedTableFits(ragged, parsed.data, src);
    evenOutRows(rows, ragged);
  }
  const fields = renameDuplicateHeaders(rows[0]);
  const needsSetOwn = fields.some((f) => f === '__proto__' || (f.charCodeAt(0) >= 0x30 && f.charCodeAt(0) <= 0x39));
  const records = rows.slice(1).map((row) => {
    const record: DataObject = {};
    if (needsSetOwn) {
      for (let i = 0; i < fields.length; i++) setOwn(record, fields[i], row[i]);
    } else {
      for (let i = 0; i < fields.length; i++) record[fields[i]] = row[i];
    }
    return record;
  });
  return { fields, records, ragged };
}
