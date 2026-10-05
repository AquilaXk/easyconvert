import Papa from 'papaparse';
import yaml from 'js-yaml';
import iconv from 'iconv-lite';
import PDFDocument from 'pdfkit';
import {
  ConversionOptions,
  ConversionResult,
  DataEncodingError,
  DataParseError,
  UnsupportedOptionError,
} from '../types';
import { generateXlsxFromData, generateOdsFromData, generateXlsXmlFromData } from './office';
import { sanitizeSvgString } from '../security/svg-sanitizer';
import { encodeParquet, decodeParquet } from './parquet';
import { assertNoComplexScript } from './ctl';

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
    throw new UnsupportedOptionError(`Unsupported text encoding "${label}"; pass a WHATWG encoding label.`);
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
  if (requested !== undefined) {
    if (requested.length === 0 || Papa.BAD_DELIMITERS.some((bad) => requested.includes(bad))) {
      throw new UnsupportedOptionError(`Unsupported delimiter ${JSON.stringify(requested)}.`);
    }
    return requested;
  }
  return detectDelimiter(text, src === 'csv' ? ',' : '\t');
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
function writeDelimited(
  input: Record<string, unknown>[] | { fields: string[]; data: Record<string, unknown>[] },
  tgt: string,
  options: ConversionOptions
): Buffer {
  const delimiter = tgt === 'tsv' ? '\t' : ',';
  const escapeFormulas = options.escapeFormulas ?? true;
  const withBom = options.bom ?? tgt === 'csv';
  const fieldCount = Array.isArray(input) ? Object.keys(input[0] ?? {}).length : input.fields.length;
  const text = Papa.unparse(input, {
    delimiter,
    escapeFormulae: escapeFormulas ? FORMULA_TRIGGER : false,
    // A one-column record whose only value is empty would otherwise be an empty line.
    quotes: (value: unknown) => fieldCount === 1 && value === '',
  });
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

export async function convertData(
  inputBuffer: Buffer,
  sourceFormat: string,
  targetFormat: string,
  options: ConversionOptions = {},
  originalFilename: string
): Promise<ConversionResult> {
  const baseName = originalFilename.replace(/\.[^/.]+$/, '');
  const src = sourceFormat.toLowerCase();
  const tgt = targetFormat.toLowerCase();

  // PARQUET -> Target
  if (src === 'parquet') {
    const records = decodeParquet(inputBuffer);
    if (tgt === 'json') {
      const json = JSON.stringify(records, null, 2);
      const buffer = Buffer.from(json, 'utf-8');
      return { buffer, mimeType: 'application/json', filename: `${baseName}.json`, size: buffer.length };
    }
    if (tgt === 'csv' || tgt === 'tsv') {
      return delimitedResult(writeDelimited(records, tgt, options), tgt, baseName);
    }
    if (tgt === 'yaml' || tgt === 'yml') {
      const yamlStr = yaml.dump(records);
      const buffer = Buffer.from(yamlStr, 'utf-8');
      return { buffer, mimeType: 'application/x-yaml', filename: `${baseName}.yaml`, size: buffer.length };
    }
    if (tgt === 'xlsx') {
      const csvStr = Papa.unparse(records);
      const xlsxBuffer = await generateXlsxFromData(Buffer.from(csvStr, 'utf-8'), 'csv', options, baseName);
      return {
        buffer: xlsxBuffer,
        mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        filename: `${baseName}.xlsx`,
        size: xlsxBuffer.length,
      };
    }
    if (tgt === 'ods') {
      const headers = Object.keys((records[0] || {}) as Record<string, unknown>);
      const rows = [
        headers,
        ...records.map((d) => headers.map((h) => String(d[h] ?? ''))),
      ];
      const odsBuffer = await generateOdsFromData(rows, baseName);
      return {
        buffer: odsBuffer,
        mimeType: 'application/vnd.oasis.opendocument.spreadsheet',
        filename: `${baseName}.ods`,
        size: odsBuffer.length,
      };
    }
    if (tgt === 'pdf') {
      const pdfBuffer = await renderDataToPdf(records, baseName, options);
      return { buffer: pdfBuffer, mimeType: 'application/pdf', filename: `${baseName}.pdf`, size: pdfBuffer.length };
    }
    if (tgt === 'txt') {
      const buffer = Buffer.from(JSON.stringify(records, null, 2), 'utf-8');
      return { buffer, mimeType: 'text/plain', filename: `${baseName}.txt`, size: buffer.length };
    }
    if (tgt === 'xml') {
      const xmlStr = jsonToXml(records, 'root');
      const buffer = Buffer.from(xmlStr, 'utf-8');
      return { buffer, mimeType: 'application/xml', filename: `${baseName}.xml`, size: buffer.length };
    }
    if (tgt === 'html') {
      const html = generateTableHtml(records, baseName);
      const buffer = Buffer.from(html, 'utf-8');
      return { buffer, mimeType: 'text/html', filename: `${baseName}.html`, size: buffer.length };
    }
    if (tgt === 'ndjson') {
      const ndjsonStr = records.map((r) => JSON.stringify(r)).join('\n');
      const buffer = Buffer.from(ndjsonStr, 'utf-8');
      return { buffer, mimeType: 'application/x-ndjson', filename: `${baseName}.ndjson`, size: buffer.length };
    }
    if (tgt === 'xls') {
      const headers = Object.keys((records[0] || {}) as Record<string, unknown>);
      const rows = [headers, ...records.map((d) => headers.map((h) => String(d[h] ?? '')))];
      const xlsXml = generateXlsXmlFromData(rows, baseName);
      const buffer = Buffer.from(xlsXml, 'utf-8');
      return { buffer, mimeType: 'application/vnd.ms-excel', filename: `${baseName}.xls`, size: buffer.length };
    }
    if (tgt === 'parquet') {
      return { buffer: inputBuffer, mimeType: 'application/vnd.apache.parquet', filename: `${baseName}.parquet`, size: inputBuffer.length };
    }
    throw new Error(`Unsupported data conversion from parquet to ${targetFormat}`);
  }

  // CSV, TSV, or TAB -> Target
  if (src === 'csv' || src === 'tsv' || src === 'tab') {
    const table = parseDelimitedTable(inputBuffer, src, options);

    if (tgt === 'json') {
      const json = JSON.stringify(table.records, null, 2);
      const buffer = Buffer.from(json, 'utf-8');
      return { buffer, mimeType: 'application/json', filename: `${baseName}.json`, size: buffer.length };
    }

    if (tgt === 'csv' || tgt === 'tsv') {
      const buffer = writeDelimited({ fields: table.fields, data: table.records }, tgt, options);
      return delimitedResult(buffer, tgt, baseName);
    }

    if (tgt === 'pdf') {
      const pdfBuffer = await renderDataToPdf(table.records, baseName, options);
      return { buffer: pdfBuffer, mimeType: 'application/pdf', filename: `${baseName}.pdf`, size: pdfBuffer.length };
    }

    if (tgt === 'xlsx') {
      // The spreadsheet writer reads UTF-8, so it gets the decoded text and the resolved delimiter.
      const xlsxBuffer = await generateXlsxFromData(
        Buffer.from(table.text, 'utf-8'),
        src,
        { ...options, delimiter: table.delimiter },
        baseName
      );
      return {
        buffer: xlsxBuffer,
        mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        filename: `${baseName}.xlsx`,
        size: xlsxBuffer.length,
      };
    }

    if (tgt === 'ods') {
      const headers = table.fields;
      const rows = [
        headers,
        ...table.records.map((d) => headers.map((h) => String(d[h] ?? ''))),
      ];
      const odsBuffer = await generateOdsFromData(rows, baseName);
      return {
        buffer: odsBuffer,
        mimeType: 'application/vnd.oasis.opendocument.spreadsheet',
        filename: `${baseName}.ods`,
        size: odsBuffer.length,
      };
    }

    if (tgt === 'xls') {
      const headers = table.fields;
      const rows = [
        headers,
        ...table.records.map((d) => headers.map((h) => String(d[h] ?? ''))),
      ];
      const xlsXml = generateXlsXmlFromData(rows, baseName);
      const buffer = Buffer.from(xlsXml, 'utf-8');
      return {
        buffer,
        mimeType: 'application/vnd.ms-excel',
        filename: `${baseName}.xls`,
        size: buffer.length,
      };
    }

    if (tgt === 'yaml' || tgt === 'yml') {
      const yamlStr = yaml.dump(table.records);
      const buffer = Buffer.from(yamlStr, 'utf-8');
      return { buffer, mimeType: 'application/x-yaml', filename: `${baseName}.yaml`, size: buffer.length };
    }

    if (tgt === 'html') {
      const html = generateTableHtml(table.records, baseName);
      const buffer = Buffer.from(html, 'utf-8');
      return { buffer, mimeType: 'text/html', filename: `${baseName}.html`, size: buffer.length };
    }

    if (tgt === 'parquet') {
      const parquetBuffer = encodeParquet(table.records);
      return { buffer: parquetBuffer, mimeType: 'application/vnd.apache.parquet', filename: `${baseName}.parquet`, size: parquetBuffer.length };
    }

    if (tgt === 'txt') {
      const buffer = Buffer.from(table.text, 'utf-8');
      return { buffer, mimeType: 'text/plain', filename: `${baseName}.txt`, size: buffer.length };
    }
  }

  const textContent = inputBuffer.toString('utf-8');

  // JSON -> Target
  if (src === 'json') {
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(textContent);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Invalid JSON';
      throw new Error(`JSON parsing failed: ${msg}`);
    }

    if (tgt === 'csv' || tgt === 'tsv') {
      const arrayData = (Array.isArray(parsedJson) ? parsedJson : [parsedJson]) as Record<string, unknown>[];
      return delimitedResult(writeDelimited(arrayData, tgt, options), tgt, baseName);
    }

    if (tgt === 'yaml' || tgt === 'yml') {
      const yamlStr = yaml.dump(parsedJson);
      const buffer = Buffer.from(yamlStr, 'utf-8');
      return { buffer, mimeType: 'application/x-yaml', filename: `${baseName}.yaml`, size: buffer.length };
    }

    if (tgt === 'pdf') {
      const arrayData = Array.isArray(parsedJson) ? parsedJson : [parsedJson];
      const pdfBuffer = await renderDataToPdf(arrayData as Record<string, unknown>[], baseName, options);
      return { buffer: pdfBuffer, mimeType: 'application/pdf', filename: `${baseName}.pdf`, size: pdfBuffer.length };
    }

    if (tgt === 'xlsx') {
      const xlsxBuffer = await generateXlsxFromData(inputBuffer, 'json', options, baseName);
      return {
        buffer: xlsxBuffer,
        mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        filename: `${baseName}.xlsx`,
        size: xlsxBuffer.length,
      };
    }

    if (tgt === 'ods') {
      const arrayData = Array.isArray(parsedJson) ? parsedJson : [parsedJson];
      const headers = Object.keys((arrayData[0] || {}) as Record<string, unknown>);
      const rows = [
        headers,
        ...(arrayData as Record<string, unknown>[]).map((d) => headers.map((h) => String(d[h] ?? ''))),
      ];
      const odsBuffer = await generateOdsFromData(rows, baseName);
      return {
        buffer: odsBuffer,
        mimeType: 'application/vnd.oasis.opendocument.spreadsheet',
        filename: `${baseName}.ods`,
        size: odsBuffer.length,
      };
    }

    if (tgt === 'xls') {
      const arrayData = Array.isArray(parsedJson) ? parsedJson : [parsedJson];
      const headers = Object.keys((arrayData[0] || {}) as Record<string, unknown>);
      const rows = [
        headers,
        ...(arrayData as Record<string, unknown>[]).map((d) => headers.map((h) => String(d[h] ?? ''))),
      ];
      const xlsXml = generateXlsXmlFromData(rows, baseName);
      const buffer = Buffer.from(xlsXml, 'utf-8');
      return {
        buffer,
        mimeType: 'application/vnd.ms-excel',
        filename: `${baseName}.xls`,
        size: buffer.length,
      };
    }

    if (tgt === 'xml') {
      const xmlStr = jsonToXml(parsedJson, 'root');
      const buffer = Buffer.from(xmlStr, 'utf-8');
      return { buffer, mimeType: 'application/xml', filename: `${baseName}.xml`, size: buffer.length };
    }

    if (tgt === 'html') {
      const arrayData = Array.isArray(parsedJson)
        ? (parsedJson as Record<string, unknown>[])
        : [parsedJson as Record<string, unknown>];
      const html = generateTableHtml(arrayData, baseName);
      const buffer = Buffer.from(html, 'utf-8');
      return { buffer, mimeType: 'text/html', filename: `${baseName}.html`, size: buffer.length };
    }

    if (tgt === 'parquet') {
      const arrayData = Array.isArray(parsedJson)
        ? (parsedJson as Record<string, unknown>[])
        : [parsedJson as Record<string, unknown>];
      const parquetBuffer = encodeParquet(arrayData);
      return { buffer: parquetBuffer, mimeType: 'application/vnd.apache.parquet', filename: `${baseName}.parquet`, size: parquetBuffer.length };
    }

    if (tgt === 'txt') {
      const buffer = Buffer.from(JSON.stringify(parsedJson, null, 2), 'utf-8');
      return { buffer, mimeType: 'text/plain', filename: `${baseName}.txt`, size: buffer.length };
    }
  }

  // YAML -> Target
  if (src === 'yaml' || src === 'yml') {
    let parsedYaml: unknown;
    try {
      parsedYaml = yaml.load(textContent);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Invalid YAML';
      throw new Error(`YAML parsing failed: ${msg}`);
    }

    if (tgt === 'json') {
      const json = JSON.stringify(parsedYaml, null, 2);
      const buffer = Buffer.from(json, 'utf-8');
      return { buffer, mimeType: 'application/json', filename: `${baseName}.json`, size: buffer.length };
    }

    if (tgt === 'parquet') {
      const arrayData = Array.isArray(parsedYaml)
        ? (parsedYaml as Record<string, unknown>[])
        : [parsedYaml as Record<string, unknown>];
      const parquetBuffer = encodeParquet(arrayData);
      return { buffer: parquetBuffer, mimeType: 'application/vnd.apache.parquet', filename: `${baseName}.parquet`, size: parquetBuffer.length };
    }

    if (tgt === 'txt') {
      const buffer = Buffer.from(textContent, 'utf-8');
      return { buffer, mimeType: 'text/plain', filename: `${baseName}.txt`, size: buffer.length };
    }
  }

  // XML -> Target
  if (src === 'xml') {
    const sanitizedXml = sanitizeSvgString(textContent);
    const parsed = simpleXmlToJson(sanitizedXml);
    const output =
      parsed.root && typeof parsed.root === 'object' && Object.keys(parsed).length === 1
        ? parsed.root
        : parsed;

    if (tgt === 'json') {
      const json = JSON.stringify(output, null, 2);
      const buffer = Buffer.from(json, 'utf-8');
      return { buffer, mimeType: 'application/json', filename: `${baseName}.json`, size: buffer.length };
    }

    if (tgt === 'yaml' || tgt === 'yml') {
      const yamlStr = yaml.dump(output);
      const buffer = Buffer.from(yamlStr, 'utf-8');
      return { buffer, mimeType: 'application/x-yaml', filename: `${baseName}.yaml`, size: buffer.length };
    }

    if (tgt === 'csv' || tgt === 'tsv') {
      const records = extractTabularRecordsFromXml(output);
      return delimitedResult(writeDelimited(records, tgt, options), tgt, baseName);
    }

    if (tgt === 'parquet') {
      const records = extractTabularRecordsFromXml(output);
      const parquetBuffer = encodeParquet(records);
      return { buffer: parquetBuffer, mimeType: 'application/vnd.apache.parquet', filename: `${baseName}.parquet`, size: parquetBuffer.length };
    }

    if (tgt === 'txt') {
      // Clean XML to plain text
      const clean = textContent
        .replace(/<[^>]+>/g, ' ')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"')
        .replace(/\s+/g, ' ')
        .trim();
      const buffer = Buffer.from(clean || textContent, 'utf-8');
      return { buffer, mimeType: 'text/plain', filename: `${baseName}.txt`, size: buffer.length };
    }
  }

  // NDJSON or JSONL -> Target
  if (src === 'ndjson' || src === 'jsonl') {
    const lines = textContent
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    const parsedData: Record<string, unknown>[] = [];
    for (const line of lines) {
      try {
        const obj = JSON.parse(line);
        parsedData.push(typeof obj === 'object' && obj !== null ? obj : { value: obj });
      } catch {
        // skip malformed lines
      }
    }
    if (parsedData.length === 0) {
      throw new Error(`Failed to parse ${src.toUpperCase()}: no valid JSON records found.`);
    }

    if (tgt === 'json') {
      const json = JSON.stringify(parsedData, null, 2);
      const buffer = Buffer.from(json, 'utf-8');
      return { buffer, mimeType: 'application/json', filename: `${baseName}.json`, size: buffer.length };
    }

    if (tgt === 'csv' || tgt === 'tsv') {
      return delimitedResult(writeDelimited(parsedData, tgt, options), tgt, baseName);
    }

    if (tgt === 'yaml' || tgt === 'yml') {
      const yamlStr = yaml.dump(parsedData);
      const buffer = Buffer.from(yamlStr, 'utf-8');
      return { buffer, mimeType: 'application/x-yaml', filename: `${baseName}.yaml`, size: buffer.length };
    }

    if (tgt === 'pdf') {
      const pdfBuffer = await renderDataToPdf(parsedData, baseName, options);
      return { buffer: pdfBuffer, mimeType: 'application/pdf', filename: `${baseName}.pdf`, size: pdfBuffer.length };
    }

    if (tgt === 'xlsx') {
      const headers = Object.keys(parsedData[0] || {});
      const rows = [headers, ...parsedData.map((d) => headers.map((h) => String(d[h] ?? '')))];
      const csv = rows.map((r) => r.map((c) => (c.includes(',') ? `"${c}"` : c)).join(',')).join('\n');
      const xlsxBuffer = await generateXlsxFromData(Buffer.from(csv, 'utf-8'), 'csv', options, baseName);
      return {
        buffer: xlsxBuffer,
        mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        filename: `${baseName}.xlsx`,
        size: xlsxBuffer.length,
      };
    }

    if (tgt === 'ods') {
      const headers = Object.keys(parsedData[0] || {});
      const rows = [headers, ...parsedData.map((d) => headers.map((h) => String(d[h] ?? '')))];
      const odsBuffer = await generateOdsFromData(rows, baseName);
      return {
        buffer: odsBuffer,
        mimeType: 'application/vnd.oasis.opendocument.spreadsheet',
        filename: `${baseName}.ods`,
        size: odsBuffer.length,
      };
    }

    if (tgt === 'xls') {
      const headers = Object.keys(parsedData[0] || {});
      const rows = [headers, ...parsedData.map((d) => headers.map((h) => String(d[h] ?? '')))];
      const xlsXml = generateXlsXmlFromData(rows, baseName);
      const buffer = Buffer.from(xlsXml, 'utf-8');
      return { buffer, mimeType: 'application/vnd.ms-excel', filename: `${baseName}.xls`, size: buffer.length };
    }

    if (tgt === 'parquet') {
      const parquetBuffer = encodeParquet(parsedData);
      return { buffer: parquetBuffer, mimeType: 'application/vnd.apache.parquet', filename: `${baseName}.parquet`, size: parquetBuffer.length };
    }

    if (tgt === 'txt') {
      const buffer = Buffer.from(JSON.stringify(parsedData, null, 2), 'utf-8');
      return { buffer, mimeType: 'text/plain', filename: `${baseName}.txt`, size: buffer.length };
    }
  }

  throw new Error(`Unsupported data conversion from ${sourceFormat} to ${targetFormat}`);
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

function jsonToXml(obj: unknown, rootName = 'root'): string {
  function toXml(val: unknown, tag: string): string {
    if (val === null || val === undefined) return `<${tag}/>`;
    if (typeof val !== 'object') {
      return `<${tag}>${escapeHtml(String(val))}</${tag}>`;
    }
    if (Array.isArray(val)) {
      return val.map((item) => toXml(item, 'item')).join('');
    }
    const children = Object.entries(val as Record<string, unknown>)
      .map(([k, v]) => toXml(v, k.replace(/[^a-zA-Z0-9_-]/g, '_')))
      .join('');
    return `<${tag}>${children}</${tag}>`;
  }

  return `<?xml version="1.0" encoding="UTF-8"?>\n${toXml(obj, rootName)}`;
}

export function simpleXmlToJson(xml: string): Record<string, unknown> {
  const cleanXml = sanitizeSvgString(xml)
    .replace(/<\?xml.*?\?>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .trim();
  if (!cleanXml) return {};

  type ElementNode = {
    tag: string;
    attributes: Record<string, string>;
    children: ElementNode[];
    text: string;
  };

  const root: ElementNode = { tag: '__root__', attributes: {}, children: [], text: '' };
  const stack: ElementNode[] = [root];

  let i = 0;
  const len = cleanXml.length;

  while (i < len) {
    if (cleanXml[i] === '<') {
      if (cleanXml.slice(i, i + 9) === '<![CDATA[') {
        const endCdata = cleanXml.indexOf(']]>', i + 9);
        const cdataContent =
          endCdata === -1 ? cleanXml.slice(i + 9) : cleanXml.slice(i + 9, endCdata);
        if (stack.length > 0) {
          stack[stack.length - 1].text += cdataContent;
        }
        i = endCdata === -1 ? len : endCdata + 3;
        continue;
      }
      if (cleanXml[i + 1] === '/') {
        // Closing tag: </tagName>
        const endClose = cleanXml.indexOf('>', i + 2);
        if (endClose === -1) break;
        const closeTagName = cleanXml.slice(i + 2, endClose).trim().split(/\s+/)[0];
        // Pop matching tag from stack
        for (let s = stack.length - 1; s > 0; s--) {
          if (stack[s].tag === closeTagName) {
            stack.length = s;
            break;
          }
        }
        i = endClose + 1;
        continue;
      }
      // Opening or self-closing tag: <tagName ... /> or <tagName ...>
      const endOpen = cleanXml.indexOf('>', i + 1);
      if (endOpen === -1) break;
      const tagContent = cleanXml.slice(i + 1, endOpen).trim();
      const isSelfClosing = tagContent.endsWith('/');
      const cleanTagContent = isSelfClosing ? tagContent.slice(0, -1).trim() : tagContent;

      const spaceIdx = cleanTagContent.search(/\s/);
      const tagName = spaceIdx === -1 ? cleanTagContent : cleanTagContent.slice(0, spaceIdx);

      if (tagName && /^[a-zA-Z0-9_:-]+$/.test(tagName)) {
        const node: ElementNode = { tag: tagName, attributes: {}, children: [], text: '' };
        if (spaceIdx !== -1) {
          const attrStr = cleanTagContent.slice(spaceIdx + 1);
          const attrRegex = /([a-zA-Z0-9_:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
          let attrMatch;
          while ((attrMatch = attrRegex.exec(attrStr)) !== null) {
            node.attributes[attrMatch[1]] = attrMatch[2] ?? attrMatch[3] ?? '';
          }
        }
        stack[stack.length - 1].children.push(node);
        if (!isSelfClosing) {
          stack.push(node);
        }
      }
      i = endOpen + 1;
    } else {
      // Text node
      const nextOpen = cleanXml.indexOf('<', i);
      const textChunk = nextOpen === -1 ? cleanXml.slice(i) : cleanXml.slice(i, nextOpen);
      stack[stack.length - 1].text += textChunk;
      i = nextOpen === -1 ? len : nextOpen;
    }
  }

  function nodeToValue(node: ElementNode): unknown {
    if (node.children.length === 0) {
      const trimmed = node.text.trim();
      if (Object.keys(node.attributes).length > 0) {
        return {
          ...node.attributes,
          ...(trimmed ? { _text: trimmed } : {}),
        };
      }
      return trimmed;
    }
    const result: Record<string, unknown> = { ...node.attributes };
    for (const child of node.children) {
      const childVal = nodeToValue(child);
      if (result[child.tag] !== undefined) {
        if (Array.isArray(result[child.tag])) {
          (result[child.tag] as unknown[]).push(childVal);
        } else {
          result[child.tag] = [result[child.tag], childVal];
        }
      } else {
        result[child.tag] = childVal;
      }
    }
    const trimmed = node.text.trim();
    if (trimmed) {
      result._text = trimmed;
    }
    return result;
  }

  const output: Record<string, unknown> = {};
  for (const child of root.children) {
    const val = nodeToValue(child);
    if (output[child.tag] !== undefined) {
      if (Array.isArray(output[child.tag])) {
        (output[child.tag] as unknown[]).push(val);
      } else {
        output[child.tag] = [output[child.tag], val];
      }
    } else {
      output[child.tag] = val;
    }
  }

  return Object.keys(output).length > 0
    ? output
    : { text: cleanXml.replace(/<[^>]+>/g, '').trim() };
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

function extractTabularRecordsFromXml(parsed: unknown): Record<string, unknown>[] {
  if (Array.isArray(parsed)) return parsed as Record<string, unknown>[];
  if (!parsed || typeof parsed !== 'object') return [{ value: parsed }];

  const obj = parsed as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    const val = obj[key];
    if (Array.isArray(val) && val.length > 0 && typeof val[0] === 'object') {
      return val as Record<string, unknown>[];
    }
    if (val && typeof val === 'object') {
      const childObj = val as Record<string, unknown>;
      for (const innerKey of Object.keys(childObj)) {
        const innerVal = childObj[innerKey];
        if (Array.isArray(innerVal) && innerVal.length > 0) {
          return innerVal as Record<string, unknown>[];
        }
      }
      return [childObj];
    }
  }
  return [obj];
}
