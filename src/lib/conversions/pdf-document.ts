import { ConversionFailedError } from '../types';
import { InflateBudget, MAX_STREAM_INFLATE_BYTES, inflateBounded } from './bounded-inflate';
import {
  PREDICTOR_PNG_MAX,
  PREDICTOR_PNG_MIN,
  PREDICTOR_TIFF,
  type PredictorParams,
  decodeAscii85,
  decodeAsciiHex,
  predictorRowBytes,
  undoPredictor,
} from './pdf-filters';

/**
 * Read-only structural view of a PDF (ISO 32000-1 sections 7.3 to 7.5) for the text extractor: an
 * object index built by scanning the file, the page tree walked from the catalog, and bounded
 * decoding of exactly the streams a page draws: its /Contents and the form XObjects its resources
 * name. Image streams, orphan objects and objects superseded by an incremental update are never
 * decoded. A scan replaces the cross-reference table, so a damaged table does not hide content.
 */

/** Malformed or over-complex PDF structure (cycles, runaway nesting, unterminated streams). Maps to HTTP 400. */
export class PdfStructureError extends ConversionFailedError {
  constructor(message: string) {
    super(message);
    this.name = 'PdfStructureError';
  }
}

/** Objects one document may define, counting those packed in object streams. */
export const MAX_PDF_OBJECTS = 500 * 1000;
/** Pages the page tree may list. */
export const MAX_PDF_PAGES = 50 * 1000;
/** Nesting of the page tree (Pages nodes below the root). */
export const MAX_PDF_PAGE_TREE_DEPTH = 64;
/** Nesting of form XObjects drawing other form XObjects. */
export const MAX_PDF_FORM_DEPTH = 16;
/** Form XObject invocations in one document. */
export const MAX_PDF_FORM_INVOCATIONS = 100 * 1000;
/** Content streams (page and form) one document may have decoded. */
export const MAX_PDF_CONTENT_STREAMS = 200 * 1000;
/** Nesting of arrays and dictionaries inside one object. */
export const MAX_PDF_PARSE_DEPTH = 32;
/** Longest chain of indirect references followed to reach a direct value. */
export const MAX_PDF_REFERENCE_CHAIN = 16;
/** Largest non-stream object the structure parser reads; a bigger one cannot be a page tree node of a real file. */
export const MAX_PDF_STRUCTURE_OBJECT_BYTES = 16 * 1024 * 1024;

/** Bytes one object stored in an object stream may span, whatever the offsets that follow it say. */
export const MAX_PDF_OBJSTM_ENTRY_BYTES = 4 * 1024 * 1024;
/** Largest object looked at when searching a file for catalog or page objects; real ones are far smaller. */
export const MAX_PDF_CLASSIFIED_OBJECT_BYTES = 1024 * 1024;
/** Bytes of non-stream objects the structure parser reads over a whole document, counting every parse. */
export const MAX_PDF_STRUCTURE_PARSE_BYTES = 128 * 1024 * 1024;
/**
 * Header bytes one object stream entry can need: two 10-digit numbers and separators take 22, and the
 * allowance adds slack for padding. A /First beyond N entries of this size is not a header.
 */
const OBJSTM_HEADER_BYTES_PER_ENTRY = 32;
const OBJSTM_HEADER_SLACK_BYTES = 256;
const MAX_LENGTH_DIGITS = 12;
const DEFAULT_BITS_PER_COMPONENT = 8;
/** Colour components a predictor row may carry (section 7.4.4.4 sets no bound; DeviceN allows 32). */
const MAX_PREDICTOR_COLORS = 32;
const PREDICTOR_BIT_DEPTHS = new Set([1, 2, 4, 8, 16]);
const ASCII_HEX_FILTERS = new Set(['ASCIIHexDecode', 'AHx']);
const ASCII85_FILTERS = new Set(['ASCII85Decode', 'A85']);
const FLATE_FILTERS = new Set(['FlateDecode', 'Fl']);
const DECODABLE_FILTERS = new Set([...ASCII_HEX_FILTERS, ...ASCII85_FILTERS, ...FLATE_FILTERS]);

const MAX_OBJECT_HEADER_LOOKBACK = 40;
const MAX_OBJECT_NUMBER_DIGITS = 10;
const MAX_GENERATION_DIGITS = 5;
const ENDSTREAM = 'endstream';
const STREAM_KEYWORD = 'stream';

const CHAR_NUL = 0;
const CHAR_TAB = 9;
const CHAR_LF = 10;
const CHAR_FF = 12;
const CHAR_CR = 13;
const CHAR_SPACE = 32;
const CHAR_0 = 48;
const CHAR_9 = 57;
const CHAR_PERCENT = 37;
const CHAR_LEFT_PAREN = 40;
const CHAR_RIGHT_PAREN = 41;
const CHAR_PLUS = 43;
const CHAR_MINUS = 45;
const CHAR_DOT = 46;
const CHAR_SLASH = 47;
const CHAR_LESS = 60;
const CHAR_GREATER = 62;
const CHAR_UPPER_R = 82;
const CHAR_LEFT_BRACKET = 91;
const CHAR_BACKSLASH = 92;
const CHAR_RIGHT_BRACKET = 93;
const CHAR_LEFT_BRACE = 123;
const CHAR_RIGHT_BRACE = 125;

type PdfValue = null | boolean | number | PdfName | PdfRef | PdfDict | PdfArray | PdfOpaque;
interface PdfName {
  kind: 'name';
  value: string;
}
interface PdfRef {
  kind: 'ref';
  num: number;
}
interface PdfDict {
  kind: 'dict';
  entries: Map<string, PdfValue>;
}
interface PdfArray {
  kind: 'array';
  items: PdfValue[];
}
interface PdfOpaque {
  kind: 'string' | 'keyword';
  value: string;
}

interface StreamSpan {
  dict: PdfDict;
  rawStart: number;
  rawEnd: number;
}

interface PdfObjectEntry {
  num: number;
  /** Text the object lives in: the file, or the decoded text of the object stream that holds it. */
  source: string;
  start: number;
  end: number;
  /** Position of the definition in the file; the later definition of an object number wins (section 7.5.6). */
  seq: number;
  stream?: StreamSpan;
}

interface PageNode {
  dict: PdfDict;
  resources: PdfValue;
}

function isWhite(code: number): boolean {
  return (
    code === CHAR_SPACE || code === CHAR_LF || code === CHAR_CR || code === CHAR_TAB || code === CHAR_FF || code === CHAR_NUL
  );
}

const DELIMITER_CODES = new Set<number>([
  CHAR_LEFT_PAREN,
  CHAR_RIGHT_PAREN,
  CHAR_LESS,
  CHAR_GREATER,
  CHAR_LEFT_BRACKET,
  CHAR_RIGHT_BRACKET,
  CHAR_LEFT_BRACE,
  CHAR_RIGHT_BRACE,
  CHAR_SLASH,
  CHAR_PERCENT,
]);

function isRegular(code: number): boolean {
  return !Number.isNaN(code) && !isWhite(code) && !DELIMITER_CODES.has(code);
}

function isDigit(code: number): boolean {
  return code >= CHAR_0 && code <= CHAR_9;
}

function skipWhite(src: string, from: number): number {
  let pos = from;
  while (pos < src.length) {
    const code = src.charCodeAt(pos);
    if (isWhite(code)) {
      pos++;
    } else if (code === CHAR_PERCENT) {
      // % starts a comment that runs to the end of the line
      while (pos < src.length && src.charCodeAt(pos) !== CHAR_LF && src.charCodeAt(pos) !== CHAR_CR) pos++;
    } else {
      break;
    }
  }
  return pos;
}

function decodeNameEscapes(raw: string): string {
  return raw.includes('#') ? raw.replace(/#([0-9a-fA-F]{2})/g, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16))) : raw;
}

/** End of a literal string starting at `pos` (which holds the opening parenthesis). */
function endOfLiteralString(src: string, pos: number): number {
  let depth = 0;
  let i = pos;
  while (i < src.length) {
    const code = src.charCodeAt(i);
    if (code === CHAR_BACKSLASH) {
      i += 2;
      continue;
    }
    if (code === CHAR_LEFT_PAREN) depth++;
    if (code === CHAR_RIGHT_PAREN) {
      depth--;
      if (depth === 0) return i + 1;
    }
    i++;
  }
  return src.length;
}

/** End of the value that starts at `from`, without building it. */
function skipValue(src: string, from: number): number {
  let pos = skipWhite(src, from);
  if (pos >= src.length) return pos;
  let depth = 0;
  do {
    pos = skipWhite(src, pos);
    if (pos >= src.length) return pos;
    const code = src.charCodeAt(pos);
    if (code === CHAR_LESS && src.charCodeAt(pos + 1) === CHAR_LESS) {
      depth++;
      pos += 2;
    } else if (code === CHAR_GREATER && src.charCodeAt(pos + 1) === CHAR_GREATER) {
      depth--;
      pos += 2;
    } else if (code === CHAR_LEFT_BRACKET) {
      depth++;
      pos++;
    } else if (code === CHAR_RIGHT_BRACKET) {
      depth--;
      pos++;
    } else if (code === CHAR_LEFT_PAREN) {
      pos = endOfLiteralString(src, pos);
    } else if (code === CHAR_LESS) {
      const close = src.indexOf('>', pos);
      pos = close === -1 ? src.length : close + 1;
    } else if (code === CHAR_SLASH) {
      pos++;
      while (isRegular(src.charCodeAt(pos))) pos++;
    } else if (isRegular(code)) {
      while (isRegular(src.charCodeAt(pos))) pos++;
    } else {
      pos++;
    }
    if (depth > MAX_PDF_PARSE_DEPTH) throw new PdfStructureError('PDF object is nested too deeply.');
  } while (depth > 0);
  return pos;
}

/** Reads a reference tail ("<gen> R") after an object number, returning its end or -1. */
function referenceTailEnd(src: string, from: number): number {
  let pos = skipWhite(src, from);
  const genStart = pos;
  while (isDigit(src.charCodeAt(pos)) && pos - genStart < MAX_GENERATION_DIGITS) pos++;
  if (pos === genStart) return -1;
  pos = skipWhite(src, pos);
  if (src.charCodeAt(pos) === CHAR_UPPER_R && !isRegular(src.charCodeAt(pos + 1))) return pos + 1;
  return -1;
}

function parseValue(src: string, from: number, depth: number): { value: PdfValue; end: number } {
  if (depth > MAX_PDF_PARSE_DEPTH) throw new PdfStructureError('PDF object is nested too deeply.');
  const pos = skipWhite(src, from);
  if (pos >= src.length) return { value: null, end: pos };
  const code = src.charCodeAt(pos);

  if (code === CHAR_LESS && src.charCodeAt(pos + 1) === CHAR_LESS) {
    const entries = new Map<string, PdfValue>();
    let cursor = pos + 2;
    while (true) {
      cursor = skipWhite(src, cursor);
      if (cursor >= src.length) break;
      if (src.charCodeAt(cursor) === CHAR_GREATER && src.charCodeAt(cursor + 1) === CHAR_GREATER) {
        cursor += 2;
        break;
      }
      const key = parseValue(src, cursor, depth + 1);
      cursor = key.end;
      if (isName(key.value)) {
        const valueAt = skipWhite(src, cursor);
        if (src.charCodeAt(valueAt) === CHAR_GREATER && src.charCodeAt(valueAt + 1) === CHAR_GREATER) {
          entries.set(key.value.value, null);
        } else {
          const value = parseValue(src, valueAt, depth + 1);
          cursor = value.end;
          entries.set(key.value.value, value.value);
        }
      }
    }
    return { value: { kind: 'dict', entries }, end: cursor };
  }
  if (code === CHAR_LEFT_BRACKET) {
    const items: PdfValue[] = [];
    let cursor = pos + 1;
    while (true) {
      cursor = skipWhite(src, cursor);
      if (cursor >= src.length) break;
      if (src.charCodeAt(cursor) === CHAR_RIGHT_BRACKET) {
        cursor++;
        break;
      }
      const item = parseValue(src, cursor, depth + 1);
      if (item.end <= cursor) break;
      cursor = item.end;
      items.push(item.value);
    }
    return { value: { kind: 'array', items }, end: cursor };
  }
  if (code === CHAR_LEFT_PAREN) {
    const end = endOfLiteralString(src, pos);
    return { value: { kind: 'string', value: src.slice(pos + 1, end - 1) }, end };
  }
  if (code === CHAR_LESS) {
    const close = src.indexOf('>', pos);
    const end = close === -1 ? src.length : close + 1;
    return { value: { kind: 'string', value: src.slice(pos + 1, end - 1) }, end };
  }
  if (code === CHAR_SLASH) {
    let end = pos + 1;
    while (isRegular(src.charCodeAt(end))) end++;
    return { value: { kind: 'name', value: decodeNameEscapes(src.slice(pos + 1, end)) }, end };
  }
  if (isDigit(code) || code === CHAR_PLUS || code === CHAR_MINUS || code === CHAR_DOT) {
    let end = pos + 1;
    while (isDigit(src.charCodeAt(end)) || src.charCodeAt(end) === CHAR_DOT) end++;
    const text = src.slice(pos, end);
    const number = Number(text);
    if (/^\d+$/.test(text) && text.length <= MAX_OBJECT_NUMBER_DIGITS) {
      const refEnd = referenceTailEnd(src, end);
      if (refEnd !== -1) return { value: { kind: 'ref', num: number }, end: refEnd };
    }
    return { value: Number.isNaN(number) ? 0 : number, end };
  }
  let end = pos;
  while (isRegular(src.charCodeAt(end))) end++;
  if (end === pos) return { value: null, end: pos + 1 };
  const word = src.slice(pos, end);
  if (word === 'true') return { value: true, end };
  if (word === 'false') return { value: false, end };
  if (word === 'null') return { value: null, end };
  return { value: { kind: 'keyword', value: word }, end };
}

function isName(value: PdfValue | undefined, name?: string): value is PdfName {
  return typeof value === 'object' && value !== null && value.kind === 'name' && (name === undefined || value.value === name);
}
function isDict(value: PdfValue | undefined): value is PdfDict {
  return typeof value === 'object' && value !== null && value.kind === 'dict';
}
function isArray(value: PdfValue | undefined): value is PdfArray {
  return typeof value === 'object' && value !== null && value.kind === 'array';
}
function isRef(value: PdfValue | undefined): value is PdfRef {
  return typeof value === 'object' && value !== null && value.kind === 'ref';
}

/** Integer at the start of an object's body, or null when the body is not a plain non-negative integer. */
function leadingInteger(src: string, from: number): number | null {
  const start = skipWhite(src, from);
  let end = start;
  while (isDigit(src.charCodeAt(end)) && end - start < MAX_LENGTH_DIGITS) end++;
  if (end === start || isRegular(src.charCodeAt(end))) return null;
  return Number(src.slice(start, end));
}

/** Reads up to `count` "<object number> <offset>" pairs from the first `first` characters of an object stream. */
function readObjectStreamHeader(decoded: string, first: number, count: number): Array<{ num: number; offset: number }> {
  const members: Array<{ num: number; offset: number }> = [];
  let pos = 0;
  const nextInteger = (): number | null => {
    pos = skipWhite(decoded, pos);
    if (pos >= first) return null;
    const start = pos;
    while (isDigit(decoded.charCodeAt(pos)) && pos - start < MAX_OBJECT_NUMBER_DIGITS) pos++;
    if (pos === start || isRegular(decoded.charCodeAt(pos))) return null;
    return Number(decoded.slice(start, pos));
  };
  while (members.length < count) {
    const num = nextInteger();
    const offset = num === null ? null : nextInteger();
    if (num === null || offset === null) break;
    members.push({ num, offset });
  }
  return members;
}

/** Index of the first element of the sorted `values` that is greater than `target`. */
function upperBound(values: number[], target: number): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (values[mid] <= target) low = mid + 1;
    else high = mid;
  }
  return low;
}

/** Names of the `Do` operators in a content stream, in drawing order. */
const DO_OPERATOR = /\/([^\s/<>[\](){}%]+)\s+Do(?![A-Za-z0-9*'"])/g;

export class PdfDocument {
  /** True when the trailer names an Encrypt dictionary; streams are then ciphertext this reader cannot decode. */
  encrypted = false;

  private readonly text: string;
  private readonly index = new Map<number, PdfObjectEntry>();
  private readonly objectStreams: PdfObjectEntry[] = [];
  private readonly objectStreamTexts: string[] = [];
  private readonly parsed = new Map<number, PdfValue>();
  private readonly structureBudget = new InflateBudget(MAX_PDF_STRUCTURE_PARSE_BYTES);
  private readonly formCache = new Map<number, string | null>();
  private rootRef: PdfRef | null = null;
  private pageList: PageNode[] | null | undefined;
  private objectCount = 0;
  private contentStreamCount = 0;
  private formInvocations = 0;

  /**
   * @param skipUndecodable leave streams alone that use a filter or predictor this reader does not decode, instead of
   * refusing the document: for callers that only check limits and leave the reading to another reader.
   */
  constructor(
    private readonly buffer: Buffer,
    private readonly budget: InflateBudget = new InflateBudget(),
    private readonly skipUndecodable = false
  ) {
    this.text = buffer.toString('latin1');
    this.scan();
    this.expandObjectStreams();
    // Anything resolved while the index was still growing may have seen a missing or older object.
    this.parsed.clear();
  }

  // ---------------------------------------------------------------------------------------------
  // Object index
  // ---------------------------------------------------------------------------------------------

  private register(entry: PdfObjectEntry): void {
    this.objectCount++;
    if (this.objectCount > MAX_PDF_OBJECTS) {
      throw new PdfStructureError(`PDF defines more than ${MAX_PDF_OBJECTS} objects.`);
    }
    const existing = this.index.get(entry.num);
    if (!existing || entry.seq >= existing.seq) this.index.set(entry.num, entry);
  }

  /** Reads "<num> <gen> " in front of an `obj` keyword at `objAt`. */
  private objectHeaderBefore(objAt: number): number | null {
    const src = this.text;
    const floor = Math.max(0, objAt - MAX_OBJECT_HEADER_LOOKBACK);
    let i = objAt - 1;
    if (i < floor || !isWhite(src.charCodeAt(i))) return null;
    while (i >= floor && isWhite(src.charCodeAt(i))) i--;
    const genEnd = i;
    while (i >= floor && isDigit(src.charCodeAt(i))) i--;
    if (i === genEnd || genEnd - i > MAX_GENERATION_DIGITS) return null;
    if (i < floor || !isWhite(src.charCodeAt(i))) return null;
    while (i >= floor && isWhite(src.charCodeAt(i))) i--;
    const numEnd = i;
    while (i >= floor && isDigit(src.charCodeAt(i))) i--;
    if (i === numEnd || numEnd - i > MAX_OBJECT_NUMBER_DIGITS) return null;
    return Number(src.slice(i + 1, numEnd + 1));
  }

  private noteTrailer(dict: PdfDict): void {
    const root = dict.entries.get('Root');
    if (isRef(root)) this.rootRef = root;
    if (dict.entries.has('Encrypt')) this.encrypted = true;
  }

  /** Walks the file once, front to back, registering every `N G obj` definition and noting trailers. */
  private scan(): void {
    const src = this.text;
    let pos = 0;
    let objAt = src.indexOf('obj', 0);
    let trailerAt = src.indexOf('trailer', 0);

    while (true) {
      if (objAt !== -1 && objAt < pos) objAt = src.indexOf('obj', pos);
      if (trailerAt !== -1 && trailerAt < pos) trailerAt = src.indexOf('trailer', pos);
      if (objAt === -1 && trailerAt === -1) break;

      if (trailerAt !== -1 && (objAt === -1 || trailerAt < objAt)) {
        const parsed = parseValue(src, trailerAt + 'trailer'.length, 0);
        if (isDict(parsed.value)) this.noteTrailer(parsed.value);
        pos = Math.max(parsed.end, trailerAt + 'trailer'.length);
        continue;
      }

      const num = this.objectHeaderBefore(objAt);
      const afterKeyword = objAt + 3;
      if (num === null || isRegular(src.charCodeAt(afterKeyword))) {
        pos = afterKeyword;
        continue;
      }
      pos = this.scanObject(num, objAt, afterKeyword);
    }
  }

  /** Registers the object whose body starts at `bodyFrom` and returns where scanning resumes. */
  private scanObject(num: number, seq: number, bodyFrom: number): number {
    const src = this.text;
    const start = skipWhite(src, bodyFrom);
    const valueEnd = skipValue(src, start);
    const entry: PdfObjectEntry = { num, source: src, start, end: valueEnd, seq };

    const afterValue = skipWhite(src, valueEnd);
    const startsDict = src.charCodeAt(start) === CHAR_LESS && src.charCodeAt(start + 1) === CHAR_LESS;
    if (!startsDict || !src.startsWith(STREAM_KEYWORD, afterValue)) {
      this.register(entry);
      return Math.max(valueEnd, bodyFrom);
    }

    const dict = parseValue(src, start, 0).value as PdfDict;
    let rawStart = afterValue + STREAM_KEYWORD.length;
    if (src.charCodeAt(rawStart) === CHAR_CR && src.charCodeAt(rawStart + 1) === CHAR_LF) rawStart += 2;
    else if (src.charCodeAt(rawStart) === CHAR_LF || src.charCodeAt(rawStart) === CHAR_CR) rawStart += 1;

    let rawEnd = -1;
    let resume = -1;
    const length = this.directLength(dict);
    if (length !== null && rawStart + length <= src.length) {
      const marker = skipWhite(src, rawStart + length);
      if (src.startsWith(ENDSTREAM, marker)) {
        rawEnd = rawStart + length;
        resume = marker + ENDSTREAM.length;
      }
    }
    if (rawEnd === -1) {
      const marker = src.indexOf(ENDSTREAM, rawStart);
      if (marker === -1) throw new PdfStructureError(`PDF stream of object ${num} is not terminated by endstream.`);
      rawEnd = marker;
      if (src.charCodeAt(rawEnd - 1) === CHAR_LF) rawEnd--;
      if (rawEnd > rawStart && src.charCodeAt(rawEnd - 1) === CHAR_CR) rawEnd--;
      resume = marker + ENDSTREAM.length;
    }

    entry.stream = { dict, rawStart, rawEnd };
    this.register(entry);

    if (isName(dict.entries.get('Type'), 'ObjStm')) this.objectStreams.push(entry);
    if (isName(dict.entries.get('Type'), 'XRef')) this.noteTrailer(dict);
    return resume;
  }

  private directLength(dict: PdfDict): number | null {
    const raw = dict.entries.get('Length');
    if (typeof raw === 'number') return Number.isInteger(raw) && raw >= 0 ? raw : null;
    if (!isRef(raw)) return null;
    // Objects are still being indexed, so the length object is not cached. Only its leading integer
    // is read: a length object is a bare integer, and anything longer must not be parsed per stream.
    const target = this.index.get(raw.num);
    if (!target || target.stream) return null;
    return leadingInteger(target.source, target.start);
  }

  /** Unpacks every object stream (section 7.5.7) so objects stored in them join the index. */
  private expandObjectStreams(): void {
    if (this.encrypted) return;
    for (const holder of this.objectStreams) {
      const stream = holder.stream as StreamSpan;
      const first = stream.dict.entries.get('First');
      const count = stream.dict.entries.get('N');
      if (typeof first !== 'number' || typeof count !== 'number' || count < 0 || first < 0) continue;
      if (count > MAX_PDF_OBJECTS) throw new PdfStructureError('PDF object stream lists too many objects.');
      const decoded = this.decodeStream(holder);
      if (decoded === null) continue;
      this.objectStreamTexts.push(decoded);

      if (first > decoded.length || first > count * OBJSTM_HEADER_BYTES_PER_ENTRY + OBJSTM_HEADER_SLACK_BYTES) {
        throw new PdfStructureError(`PDF object stream has a /First of ${first} that its ${count} entries cannot need.`);
      }
      const members = readObjectStreamHeader(decoded, first, count);
      const offsets = [...new Set(members.map((member) => first + member.offset))].sort((a, b) => a - b);
      for (const member of members) {
        const start = first + member.offset;
        if (start >= decoded.length) continue;
        // An entry ends where the next higher offset begins, so entries never overlap and one pass covers them all.
        const next = offsets[upperBound(offsets, start)] ?? decoded.length;
        const end = Math.min(next, start + MAX_PDF_OBJSTM_ENTRY_BYTES);
        this.register({ num: member.num, source: decoded, start, end, seq: holder.seq });
      }
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Values and references
  // ---------------------------------------------------------------------------------------------

  private parsedObject(num: number): PdfValue {
    if (this.parsed.has(num)) return this.parsed.get(num) as PdfValue;
    const entry = this.index.get(num);
    let value: PdfValue = null;
    if (entry) {
      if (entry.stream) {
        value = entry.stream.dict;
      } else if (entry.end - entry.start <= MAX_PDF_STRUCTURE_OBJECT_BYTES) {
        this.structureBudget.charge(entry.end - entry.start, `PDF object ${num}`);
        value = parseValue(entry.source.slice(entry.start, entry.end), 0, 0).value;
      }
    }
    this.parsed.set(num, value);
    return value;
  }

  private resolve(value: PdfValue | undefined): PdfValue {
    let current: PdfValue | undefined = value;
    for (let hops = 0; hops < MAX_PDF_REFERENCE_CHAIN && isRef(current); hops++) {
      current = this.parsedObject(current.num);
    }
    return isRef(current) || current === undefined ? null : current;
  }

  private resolveDict(value: PdfValue | undefined): PdfDict | null {
    const resolved = this.resolve(value);
    return isDict(resolved) ? resolved : null;
  }

  /** Index entry a reference leads to, following chains of references. */
  private entryOf(value: PdfValue | undefined): PdfObjectEntry | null {
    let current: PdfValue | undefined = value;
    for (let hops = 0; hops < MAX_PDF_REFERENCE_CHAIN && isRef(current); hops++) {
      const entry = this.index.get(current.num);
      if (!entry) return null;
      if (entry.stream) return entry;
      current = this.parsedObject(current.num);
    }
    return null;
  }

  // ---------------------------------------------------------------------------------------------
  // Stream decoding
  // ---------------------------------------------------------------------------------------------

  /**
   * Latin-1 text of a stream: stored as is, or decoded through its filter chain (ASCIIHexDecode,
   * ASCII85Decode, FlateDecode with PNG and TIFF predictors) within the stream cap and the document
   * budget. A stream that must be decoded for its text or structure and uses any other filter throws
   * a PdfStructureError; with `required` false (streams read blind in a file with no page structure)
   * it returns null instead.
   */
  private decodeStream(entry: PdfObjectEntry, budget: InflateBudget = this.budget, required = true): string | null {
    const stream = entry.stream as StreamSpan;
    const label = `PDF stream of object ${entry.num}`;
    const stages = this.filterChain(stream.dict);
    const strict = required && !this.skipUndecodable;

    for (const stage of stages) {
      if (!DECODABLE_FILTERS.has(stage.name)) {
        if (!strict) return null;
        throw new PdfStructureError(`${label} uses the ${stage.name} filter, which this reader cannot decode.`);
      }
    }
    let data = this.buffer.subarray(stream.rawStart, stream.rawEnd);
    if (stages.length === 0) {
      budget.charge(data.length, label);
      return data.toString('latin1');
    }
    for (const stage of stages) {
      if (ASCII_HEX_FILTERS.has(stage.name)) {
        data = decodeAsciiHex(data, label, budget);
      } else if (ASCII85_FILTERS.has(stage.name)) {
        data = decodeAscii85(data, label, budget);
      } else {
        data = inflateBounded(data, { label, format: 'zlib', budget });
        let predictor: PredictorParams | null = null;
        try {
          predictor = this.predictorParams(stage.parms, label);
        } catch (err) {
          if (strict) throw err;
          return null;
        }
        if (predictor) data = undoPredictor(data, predictor, label);
      }
    }
    return data.toString('latin1');
  }

  /** Filter names of a stream in decoding order, each with its /DecodeParms dictionary. */
  private filterChain(dict: PdfDict): Array<{ name: string; parms: PdfDict | null }> {
    const filters = this.resolve(dict.entries.get('Filter'));
    const names: string[] = [];
    if (isName(filters)) names.push(filters.value);
    if (isArray(filters)) {
      for (const item of filters.items) {
        const name = this.resolve(item);
        if (isName(name)) names.push(name.value);
      }
    }
    const parms = this.resolve(dict.entries.get('DecodeParms'));
    return names.map((name, index) => ({
      name,
      parms: this.resolveDict(isArray(parms) ? parms.items[index] : index === 0 ? parms : null),
    }));
  }

  private predictorParams(parms: PdfDict | null, label: string): PredictorParams | null {
    if (!parms) return null;
    const number = (key: string, fallback: number): number => {
      const value = this.resolve(parms.entries.get(key));
      return typeof value === 'number' && Number.isInteger(value) ? value : fallback;
    };
    const predictor = number('Predictor', 1);
    if (predictor <= 1) return null;
    const params: PredictorParams = {
      predictor,
      colors: number('Colors', 1),
      bitsPerComponent: number('BitsPerComponent', DEFAULT_BITS_PER_COMPONENT),
      columns: number('Columns', 1),
    };
    const isPng = predictor >= PREDICTOR_PNG_MIN && predictor <= PREDICTOR_PNG_MAX;
    if (!isPng && predictor !== PREDICTOR_TIFF) {
      throw new PdfStructureError(`${label} uses predictor ${predictor}, which this reader cannot decode.`);
    }
    if (params.colors < 1 || params.colors > MAX_PREDICTOR_COLORS) {
      throw new PdfStructureError(`${label} has a predictor /Colors of ${params.colors}.`);
    }
    if (!PREDICTOR_BIT_DEPTHS.has(params.bitsPerComponent)) {
      throw new PdfStructureError(`${label} has a predictor /BitsPerComponent of ${params.bitsPerComponent}.`);
    }
    if (predictor === PREDICTOR_TIFF && params.bitsPerComponent !== 8 && params.bitsPerComponent !== 16) {
      throw new PdfStructureError(`${label} uses the TIFF predictor on ${params.bitsPerComponent}-bit samples, which this reader cannot decode.`);
    }
    if (params.columns < 1 || predictorRowBytes(params) > MAX_STREAM_INFLATE_BYTES) {
      throw new PdfStructureError(`${label} has a predictor /Columns of ${params.columns}.`);
    }
    return params;
  }

  private isImage(entry: PdfObjectEntry): boolean {
    return isName(entry.stream?.dict.entries.get('Subtype'), 'Image');
  }

  private countContentStream(): void {
    this.contentStreamCount++;
    if (this.contentStreamCount > MAX_PDF_CONTENT_STREAMS) {
      throw new PdfStructureError(`PDF draws more than ${MAX_PDF_CONTENT_STREAMS} content streams.`);
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Page tree
  // ---------------------------------------------------------------------------------------------

  private catalogPages(): PdfValue {
    const catalog = this.resolveDict(this.rootRef ?? undefined);
    return catalog ? (catalog.entries.get('Pages') ?? null) : null;
  }

  private objectsOfType(type: string): PdfObjectEntry[] {
    const found: PdfObjectEntry[] = [];
    for (const entry of this.index.values()) {
      if (entry.stream || entry.end - entry.start > MAX_PDF_CLASSIFIED_OBJECT_BYTES) continue;
      // Only objects that mention /Type (or hide it behind a #xx escape) can name a type, so the rest are not parsed.
      const body = entry.source.slice(entry.start, entry.end);
      if (!body.includes('/Type') && !body.includes('#')) continue;
      const dict = this.resolveDict({ kind: 'ref', num: entry.num });
      if (dict && isName(dict.entries.get('Type'), type)) found.push(entry);
    }
    return found.sort((a, b) => a.seq - b.seq || a.num - b.num);
  }

  private collectPages(
    node: PdfValue,
    inherited: PdfValue,
    depth: number,
    out: PageNode[],
    active: Set<number>,
    seen: Set<number>
  ): void {
    if (depth > MAX_PDF_PAGE_TREE_DEPTH) throw new PdfStructureError('PDF page tree is nested too deeply.');
    const num = isRef(node) ? node.num : null;
    if (num !== null) {
      if (active.has(num)) throw new PdfStructureError('PDF page tree contains a cycle.');
      if (seen.has(num)) return;
      seen.add(num);
      active.add(num);
    }
    const dict = this.resolveDict(node);
    if (dict) {
      const resources = dict.entries.has('Resources') ? (dict.entries.get('Resources') as PdfValue) : inherited;
      const kids = this.resolve(dict.entries.get('Kids'));
      if (isArray(kids)) {
        for (const kid of kids.items) this.collectPages(kid, resources, depth + 1, out, active, seen);
      } else {
        if (out.length >= MAX_PDF_PAGES) throw new PdfStructureError(`PDF lists more than ${MAX_PDF_PAGES} pages.`);
        out.push({ dict, resources });
      }
    }
    if (num !== null) active.delete(num);
  }

  /** Pages in page-tree order, or null when the file has no page structure at all. */
  private pages(): PageNode[] | null {
    if (this.pageList === undefined) this.pageList = this.findPages();
    return this.pageList;
  }

  private findPages(): PageNode[] | null {
    const pages: PageNode[] = [];
    const walk = (root: PdfValue) => this.collectPages(root, null, 0, pages, new Set<number>(), new Set<number>());

    let hasCatalog = false;
    if (this.rootRef && this.resolveDict(this.rootRef)) {
      hasCatalog = true;
      walk(this.catalogPages());
    } else {
      const catalogs = this.objectsOfType('Catalog');
      if (catalogs.length > 0) {
        hasCatalog = true;
        const catalog = this.resolveDict({ kind: 'ref', num: catalogs[catalogs.length - 1].num });
        walk(catalog?.entries.get('Pages') ?? null);
      }
    }
    if (pages.length > 0) return pages;

    // The tree is missing or lists nothing: use the page objects the file defines, in file order.
    for (const entry of this.objectsOfType('Page')) walk({ kind: 'ref', num: entry.num });
    if (pages.length === 0 && !hasCatalog) return null;
    return pages;
  }

  // ---------------------------------------------------------------------------------------------
  // Public readers
  // ---------------------------------------------------------------------------------------------

  /**
   * Calls `visit` with the text of every content stream a page draws, in page-tree order: each page's
   * /Contents, followed by the form XObjects its resources name and the content invokes. A file with no
   * page structure (no trailer root, catalog or page object) is read stream by stream instead, still
   * bounded, with image streams left alone. Encrypted files yield nothing.
   */
  contentStreams(visit: (content: string) => void): void {
    if (this.encrypted) return;
    const pages = this.pages();
    if (pages === null) {
      this.visitLooseStreams(visit);
      return;
    }
    const activeForms = new Set<number>();
    for (const page of pages) {
      for (const entry of this.pageContentEntries(page.dict)) {
        this.countContentStream();
        const content = this.decodeStream(entry);
        if (content === null) continue;
        visit(content);
        this.drawForms(content, page.resources, 0, activeForms, visit);
      }
    }
  }

  private pageContentEntries(page: PdfDict): PdfObjectEntry[] {
    const contents = page.entries.get('Contents');
    const resolved = this.resolve(contents);
    if (isArray(resolved)) {
      const entries: PdfObjectEntry[] = [];
      for (const item of resolved.items) {
        const entry = this.entryOf(item);
        if (entry) entries.push(entry);
      }
      return entries;
    }
    const entry = this.entryOf(contents);
    return entry ? [entry] : [];
  }

  private drawForms(
    content: string,
    resources: PdfValue,
    depth: number,
    active: Set<number>,
    visit: (content: string) => void
  ): void {
    if (!content.includes('Do')) return;
    const xobjects = this.resolveDict(this.resolveDict(resources)?.entries.get('XObject'));
    if (!xobjects) return;

    const operator = new RegExp(DO_OPERATOR.source, 'g');
    let match: RegExpExecArray | null;
    while ((match = operator.exec(content)) !== null) {
      const reference = xobjects.entries.get(decodeNameEscapes(match[1]));
      const entry = this.entryOf(reference);
      if (!entry || !isRef(reference)) continue;
      if (!isName(entry.stream?.dict.entries.get('Subtype'), 'Form')) continue;

      this.formInvocations++;
      if (this.formInvocations > MAX_PDF_FORM_INVOCATIONS) {
        throw new PdfStructureError(`PDF draws more than ${MAX_PDF_FORM_INVOCATIONS} form XObjects.`);
      }
      if (active.has(entry.num)) throw new PdfStructureError('PDF form XObject draws itself.');
      if (depth >= MAX_PDF_FORM_DEPTH) throw new PdfStructureError('PDF form XObjects are nested too deeply.');

      const formText = this.formContent(entry);
      if (formText === null) continue;
      visit(formText);
      const formResources = (entry.stream as StreamSpan).dict.entries.get('Resources');
      active.add(entry.num);
      this.drawForms(formText, formResources === undefined ? resources : formResources, depth + 1, active, visit);
      active.delete(entry.num);
    }
  }

  /** Decoded form XObject, decoded once; every later drawing still counts its bytes against the budget. */
  private formContent(entry: PdfObjectEntry): string | null {
    this.countContentStream();
    if (this.formCache.has(entry.num)) {
      const cached = this.formCache.get(entry.num) ?? null;
      if (cached !== null) this.budget.charge(cached.length, `PDF form XObject of object ${entry.num}`);
      return cached;
    }
    const decoded = this.decodeStream(entry);
    this.formCache.set(entry.num, decoded);
    return decoded;
  }

  /**
   * Calls `visit` with the text of each ToUnicode CMap stream (section 9.10.3) that a font dictionary
   * names, in file order. In a file without page structure every non-image stream is offered instead.
   */
  toUnicodeStreams(visit: (content: string) => void): void {
    if (this.encrypted) return;
    if (this.pages() === null) {
      this.visitLooseStreams(visit);
      return;
    }
    const wanted = new Set<number>();
    const reference = /\/ToUnicode\s+(\d{1,10})\s+\d{1,5}\s+R/g;
    for (const haystack of [this.text, ...this.objectStreamTexts]) {
      let match: RegExpExecArray | null;
      while ((match = reference.exec(haystack)) !== null) wanted.add(Number(match[1]));
    }
    const entries = [...wanted]
      .map((num) => this.index.get(num))
      .filter((entry): entry is PdfObjectEntry => entry !== undefined && entry.stream !== undefined && !this.isImage(entry))
      .sort((a, b) => a.seq - b.seq);
    for (const entry of entries) {
      const content = this.decodeStream(entry);
      if (content !== null) visit(content);
    }
  }

  /** Reads every stream in file order for a file with no page structure, each pass on its own budget. */
  private visitLooseStreams(visit: (content: string) => void): void {
    const passBudget = new InflateBudget();
    const entries = [...this.index.values()]
      .filter((entry) => entry.stream !== undefined && !this.isImage(entry))
      .sort((a, b) => a.seq - b.seq);
    for (const entry of entries) {
      const type = entry.stream?.dict.entries.get('Type');
      if (isName(type, 'XRef') || isName(type, 'ObjStm')) continue;
      this.countContentStream();
      const content = this.decodeStream(entry, passBudget, false);
      if (content !== null) visit(content);
    }
  }
}
