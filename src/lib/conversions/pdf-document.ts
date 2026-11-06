import { ConversionFailedError, CorruptStreamError, DecompressionLimitError } from '../types';
import { InflateBudget, MAX_STREAM_INFLATE_BYTES, inflatePdfFlate } from './bounded-inflate';
import { CidWidthReader } from './pdf-cid-widths';
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
import {
  type PdfArray,
  type PdfDict,
  type PdfName,
  type PdfOpaque,
  type PdfRef,
  type PdfValue,
  MAX_GENERATION_DIGITS,
  MAX_OBJECT_NUMBER_DIGITS,
  PdfStructureError,
  CHAR_LF,
  CHAR_CR,
  CHAR_LESS,
  isArray,
  isDict,
  isDigit,
  isName,
  isRef,
  isRegular,
  decodeNameEscapes,
  isWhite,
  parseValue,
  skipValue,
  skipWhite,
} from './pdf-values';
export { MAX_PDF_PARSE_DEPTH, PdfStructureError, parseValue, skipWhite } from './pdf-values';
export type { PdfArray, PdfDict, PdfName, PdfOpaque, PdfRef, PdfValue } from './pdf-values';
import { type PageTreeSource, PageFault, recoversByScanning } from './pdf-page-recovery';
import { type XrefEntry, XrefFormatError, headerOffset, lastStartXref, objectHeaderAt, readXrefStreamRows, readXrefTable } from './pdf-xref';

/**
 * Read-only structural view of a PDF (ISO 32000-1 sections 7.3 to 7.5) for the text extractor: an
 * object index built by scanning the file, the page tree walked from the catalog, and bounded
 * decoding of exactly the streams a page draws: its /Contents and the form XObjects its resources
 * name. Image streams, orphan objects and objects superseded by an incremental update are never
 * decoded. The file is scanned for its objects, so a damaged table does not hide content; and where the cross-reference
 * is readable, the object a number leads to is the one pdf.js reads through it (`followCrossReference`), because the
 * checks that run on this view are about what pdf.js will decode.
 */

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
/**
 * Annotations the pages of one document may list together, counted per listing. Neither pdf.js nor Poppler caps them, and
 * pdf.js keeps what it built for each page's annotations until the document closes: in the reader's thread (a 1 GiB heap)
 * 100,000 widgets that draw a caption were read and 150,000 ran it out of memory, whether on one page or spread over
 * pages, so the cap is half of what was read. The most any of the 1,256 real-world PDFs lists is 891.
 */
export const MAX_PDF_ANNOTATIONS = 50 * 1000;
/**
 * States one annotation's normal appearance may have (ISO 32000-1 section 12.5.5). A check box or a radio button has two,
 * Off and its on state, and no real-world PDF has more; pdf.js draws at most three of them (/AS, the on state, Off).
 */
export const MAX_PDF_APPEARANCE_STATES = 64;
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
/** The filters pdf.js hands to its WebAssembly picture decoders, with their abbreviations (`Parser.makeFilter`, pdf.worker.mjs 17658-17675). */
export const JPX_FILTERS: ReadonlySet<string> = new Set(['JPXDecode', 'JPX']);
export const JBIG2_FILTERS: ReadonlySet<string> = new Set(['JBIG2Decode']);
export const CCITT_FILTERS: ReadonlySet<string> = new Set(['CCITTFaxDecode', 'CCF']);
const PICTURE_CODEC_FILTERS = new Set([...JPX_FILTERS, ...JBIG2_FILTERS, ...CCITT_FILTERS]);

const MAX_OBJECT_HEADER_LOOKBACK = 40;
const ENDSTREAM = 'endstream';
/** Sections of a cross-reference one file may chain through /Prev and /XRefStm; a real file has a handful, one per saved revision. */
const MAX_PDF_XREF_SECTIONS = 10_000;
/** Bytes beyond twice the file that the cross-reference may read: the headers and trailers of a small file. */
const CROSS_REFERENCE_SLACK_BYTES = 64 * 1024;
/** Decoded bytes the xref streams of one file may have together: 7 bytes a row for the most objects a file may define, with room for wider rows. */
const MAX_PDF_XREF_STREAM_BYTES = 16 * 1024 * 1024;
/**
 * White space allowed between the data a /Length names and `endstream`: a line end is one or two bytes, and the longest gap
 * in the 120,114 streams with a direct, correct /Length of the 1,264 cached real-world PDFs is 2 bytes (policy 73).
 */
const MAX_WHITE_BEFORE_ENDSTREAM = 16;
const STREAM_KEYWORD = 'stream';



interface StreamSpan {
  dict: PdfDict;
  rawStart: number;
  rawEnd: number;
}

interface PdfObjectEntry {
  num: number;
  /** Generation number of the definition (0 for an object inside an object stream, section 7.5.7). */
  gen: number;
  /** Text the object lives in: the file, or the decoded text of the object stream that holds it. */
  source: string;
  /** Position of the object's first token: white space and comments in front of it are not part of it. */
  start: number;
  end: number;
  /** Position of the definition in the file; the later definition of an object number wins (section 7.5.6). */
  seq: number;
  stream?: StreamSpan;
}

/** A Type0 font dictionary (section 9.7.6) as the file defines it, with what a text reader needs of its descendant CIDFont. */
export interface CompositeFontDictionary {
  objectNumber: number;
  generation: number;
  /** The text of the dictionary (`<< ... >>`) as the file, or the object stream that holds it, writes it. */
  text: string;
  hasToUnicode: boolean;
  /** The /Encoding name (Identity-H or a predefined CMap), or null for an embedded CMap stream. */
  encoding: string | null;
  /** /Subtype of the descendant CIDFont (CIDFontType0 or CIDFontType2). */
  descendant: string | null;
  /** /BaseFont of the descendant CIDFont as written, a subset tag included. */
  descendantName: string | null;
  /** The program the font descriptor embeds: a /FontFile2, a /FontFile3 of subtype CIDFontType0C, or null for none or another. */
  program: 'truetype' | 'cid-cff' | null;
  /** /Registry and /Ordering of the descendant's /CIDSystemInfo, as written (a hex string keeps its digits). */
  registry: string | null;
  ordering: string | null;
  /** The descendant's /CIDToGIDMap: `identity` when absent or /Identity, the decoded stream, or null when unreadable. */
  cidToGidMap(): 'identity' | Buffer | null;
  /** The decoded /FontFile2 of the descendant's font descriptor, or null when there is none or it cannot be decoded. */
  trueTypeProgram(): Buffer | null;
  /** The decoded /FontFile3 of subtype CIDFontType0C of the descendant's font descriptor, or null when there is none or it cannot be decoded. */
  cffProgram(): Buffer | null;
  /** The decoded /ToUnicode stream, or null when the font has none, names a predefined CMap instead, or the stream cannot be decoded. */
  toUnicodeData(): Buffer | null;
  /** The widths the descendant's /W gives the CIDs from `first` to `last` (section 9.7.4.3), read as pdfjs reads them and on the step budget of the call that gave the font; none once it is spent. */
  cidWidths(first: number, last: number): Map<number, number>;
}

/** A simple font dictionary (section 9.6: Type1, MMType1, TrueType or Type3) as the file defines it, with its encoding differences. */
export interface SimpleFontDictionary {
  objectNumber: number;
  generation: number;
  /** The text of the dictionary (`<< ... >>`) as the file, or the object stream that holds it, writes it. */
  text: string;
  hasToUnicode: boolean;
  /** /BaseFont as written, a subset tag included. */
  baseFont: string | null;
  /** The items of the /Differences array of an /Encoding dictionary (section 9.6.5.1): integer codes and glyph names, null for any other item; null when there is no array. */
  differences: ReadonlyArray<number | string | null> | null;
}

/** What an incremental update of the file (section 7.5.6) refers back to. */
export interface PdfUpdateBase {
  root: { num: number; gen: number };
  /** The first object number no definition of the file uses. */
  nextObjectNumber: number;
  /** Byte offset of the file's last cross-reference section, as its last `startxref` gives it. */
  previousXref: number;
}

/** Called with the text of a content stream and the index of the page that draws it (null for a file without page structure). */
export type ContentVisitor = (content: string, pageIndex: number | null) => void;

/** One filter of a stream's chain, with its /DecodeParms dictionary. */
export interface PdfFilterStage {
  name: string;
  parms: PdfDict | null;
}

/** An image XObject stream, for a reader of the data its filters decode. */
export interface PdfImageStream {
  objectNumber: number;
  generation: number;
  dict: PdfDict;
  /** Filters in decoding order. */
  filters: PdfFilterStage[];
  /** The data the filter at `index` reads: the stream's data decoded through the filters before it, or null when one of them is not one this reader decodes. */
  dataBefore(index: number, budget: InflateBudget): Buffer | null;
}

/**
 * The filters of a stream in decoding order from its /Filter and /DecodeParms values, each with its parameter dictionary.
 * `resolve` follows a reference; an inline image, which has none, passes a function that returns its argument.
 */
export function filterStages(filters: PdfValue, parms: PdfValue, resolve: (value: PdfValue | undefined) => PdfValue): PdfFilterStage[] {
  const names: string[] = [];
  if (isName(filters)) names.push(filters.value);
  if (isArray(filters)) {
    for (const item of filters.items) {
      const name = resolve(item);
      if (isName(name)) names.push(name.value);
    }
  }
  const parmsOf = (index: number): PdfDict | null => {
    const own = isArray(parms) ? parms.items[index] : parms;
    const value = isArray(parms) || index === 0 ? resolve(own) : null;
    return isDict(value) ? value : null;
  };
  return names.map((name, index) => ({ name, parms: parmsOf(index) }));
}

interface PageNode {
  dict: PdfDict;
  resources: PdfValue;
}


const SIMPLE_FONT_SUBTYPES = new Set(['Type1', 'MMType1', 'TrueType', 'Type3']);


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

/** An object stream read: its decoded text, /First, the "number offset" pairs of its header, and the span of each object. */
interface ObjectStreamContents {
  decoded: string;
  first: number;
  members: Array<{ num: number; offset: number }>;
  spans: Map<number, MemberSpan>;
}

/** Where an object stored in an object stream begins and ends in the decoded text of the stream. */
interface MemberSpan {
  start: number;
  end: number;
}

/**
 * The span of the object stored at each of `offsets` (distinct, ascending, inside `decoded`). An object ends where the next
 * higher offset begins, so spans never overlap and one pass covers them all, and it begins at its first token: the white
 * space and comments in front of it are skipped as the lexer of pdf.js (`Lexer.getObj`) and the tokenizers of qpdf and PDFBox
 * skip them, inside the span only, so that a comment with no line end ends with its object.
 */
function memberSpans(decoded: string, offsets: number[]): Map<number, MemberSpan> {
  const spans = new Map<number, MemberSpan>();
  offsets.forEach((offset, index) => {
    const end = Math.min(offsets[index + 1] ?? decoded.length, offset + MAX_PDF_OBJSTM_ENTRY_BYTES);
    spans.set(offset, { start: skipWhite(decoded, offset, end), end });
  });
  return spans;
}

/** The offset after the file's last `startxref` keyword. */
const STARTXREF = /^startxref\s+(\d{1,15})/;
/** Names of the `Do` operators in a content stream, in drawing order. */
const DO_OPERATOR = /\/([^\s/<>[\](){}%]+)\s+Do(?![A-Za-z0-9*'"])/g;

/**
 * Which definition of an object number the index keeps. `preferred` is the one pdf.js reads: the cross-reference's where pdf.js
 * follows it, the last in the file where it scans. `last` and `first` ignore the cross-reference and keep the last or the first
 * definition in file order; `otherReadings` gives them to a caller that cannot tell which one pdf.js reads.
 */
export type PdfReading = 'preferred' | 'last' | 'first';

/** How a fetch of an object the cross-reference lists fails in pdf.js: `entry` is an `XRefEntryException`, which makes pdf.js read the file by scanning it. */
type FetchFault = 'entry' | 'format';

export class PdfDocument {
  /** True when the trailer names an Encrypt dictionary; streams are then ciphertext this reader cannot decode. */
  encrypted = false;

  private readonly text: string;
  private index = new Map<number, PdfObjectEntry>();
  private readonly objectStreams: PdfObjectEntry[] = [];
  /** Streams whose /Length is an object the scan had not reached yet; see `applyLaterLengths`. */
  private readonly laterLengths: PdfObjectEntry[] = [];
  private readonly objectStreamTexts: string[] = [];
  /** The contents of each object stream read, by the position of its data, so that a stream the cross-reference and the scan both lead to is decoded once. */
  private readonly objectStreamContents = new Map<number, ObjectStreamContents | null>();
  private readonly parsed = new Map<number, PdfValue>();
  private readonly structureBudget = new InflateBudget(MAX_PDF_STRUCTURE_PARSE_BYTES);
  private readonly formCache = new Map<number, string | null>();
  private readonly damagedAppearances = new Set<number>();
  /** Bytes the cross-reference may make this reader parse: sections and the objects its entries lead to (see `chargeCrossReference`). */
  private crossReferenceBytes = 0;
  /** The decoded bytes of every cross-reference stream this reader decodes, so that a stream several sections lead to is charged for each. */
  private readonly xrefStreamBudget = new InflateBudget(MAX_PDF_XREF_STREAM_BYTES);
  /** Sections of the cross-reference this reader rejected; it cannot tell that pdf.js rejects every one of them. */
  private rejectedSections = 0;
  /** Whether a number is defined more than once in the file, so that the choice between its definitions matters. */
  private superseded = false;
  private followedCrossReference = false;
  /** Whether the index may differ from the objects pdf.js reads: the cross-reference was not followed or a section was rejected, and a number has several definitions. */
  private uncertain = false;
  private rootRef: PdfRef | null = null;
  private pageList: PageNode[] | null | undefined;
  private objectCount = 0;
  private contentStreamCount = 0;
  private annotationCount = 0;
  private formInvocations = 0;
  /** Image XObjects each page draws, by object number, recorded while its content streams are read. */
  private paintedImages: Array<Set<number>> = [];

  /**
   * @param skipUndecodable leave streams alone that use a filter or predictor this reader does not decode, instead of
   * refusing the document: for callers that only check limits and leave the reading to another reader.
   */
  constructor(
    private readonly buffer: Buffer,
    private readonly budget: InflateBudget = new InflateBudget(),
    private readonly skipUndecodable = false,
    private readonly reading: PdfReading = 'preferred'
  ) {
    this.text = buffer.toString('latin1');
    this.scan();
    this.applyLaterLengths();
    const crossReference = reading === 'preferred' ? this.followCrossReference() : null;
    this.expandObjectStreams();
    // The definition the cross-reference leads to is the one pdf.js reads, whatever the file has after it.
    if (crossReference !== null) for (const [num, entry] of crossReference) this.index.set(num, entry);
    // Anything resolved while the index was still growing may have seen a missing or older object.
    this.parsed.clear();
    this.followedCrossReference = crossReference !== null;
    this.uncertain = reading === 'preferred' && this.superseded && (crossReference === null || this.rejectedSections > 0);
  }

  /**
   * The other readings of the file for a caller that decides from the objects (the picture check): the last and the first
   * definition of every number in file order, without the cross-reference. Where this reader did not follow the cross-reference,
   * or rejected a section of it, it cannot know that pdf.js reads the same sections, and a number with several definitions may
   * lead to any of them; a caller that takes the worst reading never counts less than for either. Empty where the index is certain.
   */
  otherReadings(): PdfDocument[] {
    if (!this.uncertain) return [];
    const readings: PdfReading[] = this.followedCrossReference ? ['last', 'first'] : ['first'];
    return readings.map((r) => new PdfDocument(this.buffer, new InflateBudget(), this.skipUndecodable, r));
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
    if (existing) this.superseded = true;
    if (!existing || (this.reading === 'first' ? entry.seq < existing.seq : entry.seq >= existing.seq)) this.index.set(entry.num, entry);
  }

  /** Reads "<num> <gen> " in front of an `obj` keyword at `objAt`. */
  private objectHeaderBefore(objAt: number): { num: number; gen: number } | null {
    const src = this.text;
    const floor = Math.max(0, objAt - MAX_OBJECT_HEADER_LOOKBACK);
    let i = objAt - 1;
    if (i < floor || !isWhite(src.charCodeAt(i))) return null;
    while (i >= floor && isWhite(src.charCodeAt(i))) i--;
    const genEnd = i;
    while (i >= floor && isDigit(src.charCodeAt(i))) i--;
    if (i === genEnd || genEnd - i > MAX_GENERATION_DIGITS) return null;
    const gen = Number(src.slice(i + 1, genEnd + 1));
    if (i < floor || !isWhite(src.charCodeAt(i))) return null;
    while (i >= floor && isWhite(src.charCodeAt(i))) i--;
    const numEnd = i;
    while (i >= floor && isDigit(src.charCodeAt(i))) i--;
    if (i === numEnd || numEnd - i > MAX_OBJECT_NUMBER_DIGITS) return null;
    return { num: Number(src.slice(i + 1, numEnd + 1)), gen };
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

      const header = this.objectHeaderBefore(objAt);
      const afterKeyword = objAt + 3;
      if (header === null || isRegular(src.charCodeAt(afterKeyword))) {
        pos = afterKeyword;
        continue;
      }
      pos = this.scanObject(header, objAt, afterKeyword);
    }
  }

  /** Registers the object whose body starts at `bodyFrom` and returns where scanning resumes. */
  private scanObject(header: { num: number; gen: number }, seq: number, bodyFrom: number): number {
    const { entry, resume, laterLength } = this.defineObject(header, seq, bodyFrom);
    this.register(entry);
    if (laterLength) this.laterLengths.push(entry);
    if (entry.stream) {
      const dict = entry.stream.dict;
      if (isName(dict.entries.get('Type'), 'ObjStm')) this.objectStreams.push(entry);
      if (isName(dict.entries.get('Type'), 'XRef')) this.noteTrailer(dict);
    }
    return resume;
  }

  /**
   * Reads the object whose body starts at `bodyFrom`: its entry, where the next one can start, and whether its /Length is an
   * object that the scan had not reached yet.
   */
  private defineObject({ num, gen }: { num: number; gen: number }, seq: number, bodyFrom: number): { entry: PdfObjectEntry; resume: number; laterLength: boolean } {
    const src = this.text;
    const start = skipWhite(src, bodyFrom);
    const valueEnd = skipValue(src, start);
    const entry: PdfObjectEntry = { num, gen, source: src, start, end: valueEnd, seq };

    const afterValue = skipWhite(src, valueEnd);
    const startsDict = src.charCodeAt(start) === CHAR_LESS && src.charCodeAt(start + 1) === CHAR_LESS;
    if (!startsDict || !src.startsWith(STREAM_KEYWORD, afterValue)) {
      return { entry, resume: Math.max(valueEnd, bodyFrom), laterLength: false };
    }

    const dict = parseValue(src, start, 0).value as PdfDict;
    let rawStart = afterValue + STREAM_KEYWORD.length;
    if (src.charCodeAt(rawStart) === CHAR_CR && src.charCodeAt(rawStart + 1) === CHAR_LF) rawStart += 2;
    else if (src.charCodeAt(rawStart) === CHAR_LF || src.charCodeAt(rawStart) === CHAR_CR) rawStart += 1;

    const length = this.directLength(dict);
    let rawEnd = this.endAtLength(rawStart, length);
    let resume = rawEnd === -1 ? -1 : skipWhite(src, rawEnd) + ENDSTREAM.length;
    if (rawEnd === -1) {
      const marker = src.indexOf(ENDSTREAM, rawStart);
      if (marker === -1) throw new PdfStructureError(`PDF stream of object ${num} is not terminated by endstream.`);
      rawEnd = marker;
      if (src.charCodeAt(rawEnd - 1) === CHAR_LF) rawEnd--;
      if (rawEnd > rawStart && src.charCodeAt(rawEnd - 1) === CHAR_CR) rawEnd--;
      resume = marker + ENDSTREAM.length;
    }

    entry.stream = { dict, rawStart, rawEnd };
    return { entry, resume, laterLength: length === null && isRef(dict.entries.get('Length')) };
  }

  /**
   * End of the data of stream `num` when `length` bytes from `rawStart` are followed by `endstream`, or -1 when they are
   * not: PDFBox `COSParser.validateStreamLength` (3.0.5, lines 1077-1112, Apache-2.0) checks the same before it trusts
   * /Length. Only `MAX_WHITE_BEFORE_ENDSTREAM` bytes of white space may lie between them. PDFBox (`skipSpaces`, lines
   * 1286-1310), pdf.js (`makeStream`) and qpdf (`QPDF_objects.cc` line 1366) do not bound that run, so lengths that all
   * end in one long run of white space would cost the run once per stream; this bound is ours (policy 73).
   */
  private endAtLength(rawStart: number, length: number | null): number {
    if (length === null || rawStart + length > this.text.length) return -1;
    const dataEnd = rawStart + length;
    const limit = Math.min(this.text.length, dataEnd + MAX_WHITE_BEFORE_ENDSTREAM);
    let marker = dataEnd;
    while (marker < limit && isWhite(this.text.charCodeAt(marker))) marker++;
    return this.text.startsWith(ENDSTREAM, marker) ? dataEnd : -1;
  }

  /**
   * Gives the streams whose /Length is an object written after them the end that object states, now that every object of
   * the file is indexed. pdf.js (`Parser.makeStream`, 6.3.289 src/core/parser.js line 740, which fetches /Length) and
   * PDFBox (`COSParser.parseCOSStream`, 3.0.5, lines 914-931) resolve the length before they search for `endstream`; the
   * search alone drops a line end in front of `endstream` that may be the last byte of the data. A length that `endstream`
   * does not follow keeps the searched end.
   */
  private applyLaterLengths(): void {
    for (const entry of this.laterLengths) {
      const stream = entry.stream as StreamSpan;
      const end = this.endAtLength(stream.rawStart, this.directLength(stream.dict));
      if (end !== -1) stream.rawEnd = end;
    }
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
      const contents = this.objectStreamOf(holder);
      if (contents === null) continue;
      for (const member of contents.members) {
        const span = contents.spans.get(contents.first + member.offset);
        if (span !== undefined) this.register({ num: member.num, gen: 0, source: contents.decoded, ...span, seq: holder.seq });
      }
    }
  }

  /**
   * The decoded text of an object stream, its header and the span of each object (once per stream), or null when its /First or /N
   * is not a number or it cannot be decoded.
   */
  private objectStreamOf(holder: PdfObjectEntry): ObjectStreamContents | null {
    const stream = holder.stream as StreamSpan;
    const known = this.objectStreamContents.get(stream.rawStart);
    if (known !== undefined) return known;
    const first = this.resolve(stream.dict.entries.get('First'));
    const count = this.resolve(stream.dict.entries.get('N'));
    let contents: ObjectStreamContents | null = null;
    if (typeof first === 'number' && typeof count === 'number' && count >= 0 && first >= 0) {
      if (count > MAX_PDF_OBJECTS) throw new PdfStructureError('PDF object stream lists too many objects.');
      const decoded = this.decodeStream(holder);
      if (decoded !== null) {
        this.objectStreamTexts.push(decoded);
        if (first > decoded.length || first > count * OBJSTM_HEADER_BYTES_PER_ENTRY + OBJSTM_HEADER_SLACK_BYTES) {
          throw new PdfStructureError(`PDF object stream has a /First of ${first} that its ${count} entries cannot need.`);
        }
        const members = readObjectStreamHeader(decoded, first, count);
        const offsets = [...new Set(members.map((member) => first + member.offset))].filter((offset) => offset < decoded.length).sort((a, b) => a - b);
        contents = { decoded, first, members, spans: memberSpans(decoded, offsets) };
      }
    }
    this.objectStreamContents.set(stream.rawStart, contents);
    return contents;
  }

  // ---------------------------------------------------------------------------------------------
  // Cross-reference (the objects as pdf.js resolves them)
  // ---------------------------------------------------------------------------------------------

  /**
   * The definition of every object the cross-reference leads to, as pdf.js resolves it (`XRef` of pdf.js v6.3.289,
   * src/core/xref.js): the sections are read from the last `startxref` through /XRefStm and /Prev, the first entry of a number
   * wins (`readXRef` 535-615), an entry with an offset leads to the object whose header lies there (`fetchUncompressed`
   * 725-775), and an entry of type 2 to the object at that index of its object stream (`fetchCompressed` 777-858). The file is
   * scanned in file order instead (`indexObjects` 429-533, where the last definition of a number wins) only when pdf.js does:
   * no section is readable, the trailer's /Root has no /Pages (`XRef.parse` 124-134), or the first or last page needs an object
   * whose entry names another one (`checkFirstPage`, `checkLastPage`: an `XRefEntryException` re-reads the file by scanning it).
   * The trailer that decides encryption and the root is the first section's, not any `trailer` text the file holds.
   *
   * Returns null when pdf.js scans the file, and the file-order index stays. Otherwise returns the definitions to put over it:
   * an object the cross-reference does not list, or lists with an entry that names another object, stays as the scan found it,
   * the reading that hides the least.
   */
  private followCrossReference(): Map<number, PdfObjectEntry> | null {
    const base = headerOffset(this.text);
    const entries = new Map<number, XrefEntry>();
    const add = (num: number, entry: XrefEntry): void => {
      if (entries.has(num)) return;
      entries.set(num, entry);
      if (entries.size > MAX_PDF_OBJECTS) throw new PdfStructureError(`PDF cross-reference lists more than ${MAX_PDF_OBJECTS} objects.`);
    };
    const top = this.readXrefSections(base, entries, add);
    if (top === null) return null;

    const scanned = this.index;
    const found = new Map<number, PdfObjectEntry>();
    const failed = new Map<number, FetchFault>();
    for (const [num, entry] of entries) {
      if (entry.kind !== 'offset' || entry.offset === 0) continue;
      const defined = this.definitionAt(base + entry.offset, num, entry.gen);
      if ('fault' in defined) failed.set(num, defined.fault);
      else found.set(num, defined.entry);
    }
    try {
      // What pdf.js sees is the listed objects alone, so the checks below read nothing else.
      this.index = found;
      this.parsed.clear();
      // The /Encrypt dictionary may be an object of an object stream; no other is read before it is known (an encrypted file's streams are ciphertext here).
      const encryptRef = top.entries.get('Encrypt');
      if (isRef(encryptRef)) this.addObjectStreamMembers(entries, found, failed, [encryptRef.num]);
      const encrypted = isDict(this.resolve(encryptRef));
      if (!encrypted) {
        this.addObjectStreamMembers(entries, found, failed);
        const root = this.resolveDict(top.entries.get('Root'));
        const pages = root?.entries.get('Pages');
        const pagesDict = this.resolveDict(pages);
        if (!root || !pagesDict) return null;
        if (recoversByScanning(pagesDict, pages, this.pageTreeSource(failed))) return null;
      }
      this.encrypted = encrypted;
      const rootRef = top.entries.get('Root');
      if (isRef(rootRef)) this.rootRef = rootRef;
      return found;
    } finally {
      this.index = scanned;
      this.parsed.clear();
      this.pageList = undefined;
    }
  }

  /** `XRef.fetch` on the objects the cross-reference leads to, which are the index while `followCrossReference` checks them. */
  private pageTreeSource(failed: ReadonlyMap<number, FetchFault>): PageTreeSource {
    return {
      fetch: (ref) => {
        const fault = failed.get(ref.num);
        if (fault !== undefined) throw new PageFault(fault === 'entry');
        return this.parsedObject(ref.num);
      },
    };
  }

  /** Reads the sections of the cross-reference newest first and returns the first section's trailer dictionary, or null when none is readable. */
  private readXrefSections(base: number, entries: Map<number, XrefEntry>, add: (num: number, entry: XrefEntry) => void): PdfDict | null {
    const queue = [lastStartXref(this.text)];
    const parsed = new Set<number>();
    const streamSections = new Set<number>();
    let top: PdfDict | null = null;
    while (queue.length > 0) {
      const at = queue[0];
      queue.shift();
      if (parsed.has(at)) continue;
      parsed.add(at);
      if (parsed.size > MAX_PDF_XREF_SECTIONS) throw new PdfStructureError(`PDF cross-reference has more than ${MAX_PDF_XREF_SECTIONS} sections.`);
      let dict: PdfDict;
      try {
        dict = this.readXrefSection(base + at, entries, add);
      } catch (error) {
        if (!(error instanceof XrefFormatError)) throw error;
        this.rejectedSections++;
        continue;
      }
      top ??= dict;
      const hybrid = this.resolve(dict.entries.get('XRefStm'));
      if (typeof hybrid === 'number' && Number.isInteger(hybrid) && !streamSections.has(hybrid)) {
        streamSections.add(hybrid);
        queue.push(hybrid);
      }
      const previous = dict.entries.get('Prev');
      if (typeof previous === 'number' && Number.isInteger(previous)) queue.push(previous);
      else if (isRef(previous)) queue.push(previous.num);
    }
    return top;
  }

  /** One section: a classic table and its trailer, or an xref stream, whichever lies at `at`. Returns its dictionary. */
  private readXrefSection(at: number, entries: ReadonlyMap<number, XrefEntry>, add: (num: number, entry: XrefEntry) => void): PdfDict {
    const src = this.text;
    const pos = skipWhite(src, at);
    if (src.startsWith('xref', pos) && !isRegular(src.charCodeAt(pos + 4))) return this.readXrefTableSection(pos, entries, add);
    const header = objectHeaderAt(src, pos);
    if (header?.glued !== null) throw new XrefFormatError('Invalid XRef stream header');
    const defined = this.defineObject({ num: header.num, gen: header.gen }, header.end - 3, header.end);
    this.chargeCrossReference(defined.resume - pos);
    const dict = defined.entry.stream?.dict;
    if (!dict) throw new XrefFormatError('Invalid XRef stream');
    const decoded = this.decodeStream(defined.entry, this.xrefStreamBudget, false);
    if (decoded === null) throw new XrefFormatError('Failed to read XRef stream');
    // pdf.js reads /W and /Index as the dictionary holds them (`Dict.get` follows a reference to the array, not one inside it) and a missing /Index as 0 and /Size.
    const index = this.resolve(dict.entries.get('Index'));
    const arrayItems = (value: PdfValue): readonly unknown[] => (isArray(value) ? value.items : []);
    const ranges = index === null || index === 0 || index === false ? [0, this.resolve(dict.entries.get('Size'))] : arrayItems(index);
    readXrefStreamRows(Buffer.from(decoded, 'latin1'), arrayItems(this.resolve(dict.entries.get('W'))), ranges, add, MAX_PDF_OBJECTS);
    return dict;
  }

  /** A classic table at `pos` (its `xref` keyword) and its trailer. The bytes read are charged also when the table is rejected: a table that fails near its end has been read to there. */
  private readXrefTableSection(pos: number, entries: ReadonlyMap<number, XrefEntry>, add: (num: number, entry: XrefEntry) => void): PdfDict {
    const src = this.text;
    const reached = { end: pos + 4 };
    try {
      const afterTrailer = readXrefTable(src, pos + 4, add, reached);
      // xref.js lines 255-258: the first object of a table must be free, checked once its entries are in.
      if (entries.get(0) !== undefined && entries.get(0)?.kind !== 'free') throw new XrefFormatError('Invalid XRef table: unexpected first object');
      const dict = parseValue(src, afterTrailer, 0).value;
      if (!isDict(dict)) throw new XrefFormatError('Invalid XRef table: could not parse trailer dictionary');
      return dict;
    } finally {
      this.chargeCrossReference(reached.end - pos);
    }
  }

  /**
   * Counts bytes read for the cross-reference against twice the file and a little more. The scan reads each byte of the file once;
   * entries and sections that lead into the same bytes again (every offset a fake `N 0 obj` header in one long unterminated
   * object, or every `/Prev` the start of one long table) would read them once for each, so a file that needs more than the
   * allowance is not a file whose objects are laid out one after the other.
   */
  private chargeCrossReference(bytes: number): void {
    this.crossReferenceBytes += bytes;
    if (this.crossReferenceBytes > 2 * this.text.length + CROSS_REFERENCE_SLACK_BYTES) {
      throw new PdfStructureError('PDF cross-reference leads into the same bytes again and again.');
    }
  }

  /**
   * The object whose header lies at `offset`, read as pdf.js reads it (`fetchUncompressed`: three tokens, the number and the
   * generation compared as numbers, a comment or white space between them, and `obj` followed by digits taken as that integer),
   * or the fault pdf.js throws: an `XRefEntryException` when the header names another object or is not one, another error when
   * the object cannot be read.
   */
  private definitionAt(offset: number, num: number, gen: number): { entry: PdfObjectEntry } | { fault: FetchFault } {
    if (offset < 0 || offset >= this.text.length) return { fault: 'entry' };
    const header = objectHeaderAt(this.text, offset);
    if (header === null || header.num !== num || header.gen !== gen) return { fault: 'entry' };
    if (header.glued !== null) {
      this.chargeCrossReference(header.end - offset);
      const value = String(header.glued);
      return { entry: { num, gen, source: value, start: 0, end: value.length, seq: header.end } };
    }
    let defined: ReturnType<PdfDocument['defineObject']>;
    try {
      defined = this.defineObject({ num, gen }, header.end - 3, header.end);
    } catch (error) {
      if (!(error instanceof PdfStructureError)) throw error;
      // The object ran to the end of the file looking for its `endstream`.
      this.chargeCrossReference(this.text.length - offset);
      return { fault: 'format' };
    }
    this.chargeCrossReference(defined.resume - offset);
    return { entry: defined.entry };
  }

  /**
   * Adds the objects the cross-reference puts in object streams (type 2 entries; those named in `only`, or all) to `found`. Those
   * that pdf.js cannot read are `failed`: a stream whose entry is bad or whose index is past its objects is an
   * `XRefEntryException` (`fetchCompressed`, pdf.worker.mjs lines 59062-59125), one that is not a stream or has no /First or /N a `FormatError`.
   */
  private addObjectStreamMembers(entries: Map<number, XrefEntry>, found: Map<number, PdfObjectEntry>, failed: Map<number, FetchFault>, only?: readonly number[]): void {
    for (const num of only ?? entries.keys()) {
      const entry = entries.get(num);
      if (entry?.kind !== 'member' || found.has(num)) continue;
      const holder = found.get(entry.offset);
      const holderEntry = entries.get(entry.offset);
      // The reference to the stream has generation 0, which its entry must state.
      if (holderEntry?.kind === 'offset' && holderEntry.gen !== 0) failed.set(num, 'entry');
      else if (failed.get(entry.offset) === 'entry') failed.set(num, 'entry');
      else if (!holder?.stream) failed.set(num, 'format');
      else this.addObjectStreamMember(num, entry, holder, found, failed);
    }
  }

  private addObjectStreamMember(num: number, entry: XrefEntry, holder: PdfObjectEntry, found: Map<number, PdfObjectEntry>, failed: Map<number, FetchFault>): void {
    const contents = this.objectStreamOf(holder);
    const member = contents?.members[entry.gen];
    const span = contents && member ? contents.spans.get(contents.first + member.offset) : undefined;
    if (contents && member && span) found.set(num, { num, gen: 0, source: contents.decoded, ...span, seq: holder.seq });
    else failed.set(num, contents && !member ? 'entry' : 'format');
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
    const data = this.decodeStages(entry, this.filterChain(stream.dict), budget, required && !this.skipUndecodable);
    return data === null ? null : data.toString('latin1');
  }

  private decodeStages(entry: PdfObjectEntry, stages: PdfFilterStage[], budget: InflateBudget, strict: boolean): Buffer | null {
    const stream = entry.stream as StreamSpan;
    const label = `PDF stream of object ${entry.num}`;
    for (const stage of stages) {
      if (!DECODABLE_FILTERS.has(stage.name)) {
        if (!strict) return null;
        throw new PdfStructureError(`${label} uses the ${stage.name} filter, which this reader cannot decode.`);
      }
    }
    let data = this.buffer.subarray(stream.rawStart, stream.rawEnd);
    // pdf.js Parser.makeFilter (src/core/parser.js, v6.3.289, lines 842-845): a stream with no data reads as empty,
    // whatever its filters.
    if (data.length === 0) return data;
    if (stages.length === 0) {
      budget.charge(data.length, label);
      return data;
    }
    for (const stage of stages) {
      if (ASCII_HEX_FILTERS.has(stage.name)) {
        data = decodeAsciiHex(data, label, budget);
      } else if (ASCII85_FILTERS.has(stage.name)) {
        data = decodeAscii85(data, label, budget);
      } else {
        data = inflatePdfFlate(data, { label, budget });
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
    return data;
  }

  /** A value with its references followed; null for a missing object or a chain longer than MAX_PDF_REFERENCE_CHAIN. */
  resolved(value: PdfValue | undefined): PdfValue {
    return this.resolve(value);
  }

  /**
   * Object numbers of the picture streams the file defines (the latest definition of each number): image XObjects, and any
   * other stream that carries a picture codec filter, since pdf.js decodes an /SMask or /Mask stream as an image whatever its
   * /Subtype (`PDFImage.buildImage`, pdf.worker.mjs 39485-39498).
   */
  imageStreamNumbers(): number[] {
    return [...this.index.values()].filter((entry) => this.isPicture(entry)).map((entry) => entry.num);
  }

  /** The picture stream `value` refers to (an image XObject, or a stream with a picture codec filter), or null when it refers to none. */
  imageStream(value: PdfValue | undefined): PdfImageStream | null {
    const entry = this.entryOf(value);
    if (!entry || !this.isPicture(entry)) return null;
    const dict = (entry.stream as StreamSpan).dict;
    const filters = this.filterChain(dict);
    return {
      objectNumber: entry.num,
      generation: entry.gen,
      dict,
      filters,
      dataBefore: (index, budget) => this.filteredData(entry, filters.slice(0, index), budget),
    };
  }

  /** The decoded data of the stream `value` refers to, or null when it is no stream, the file is encrypted, or a filter is not one this reader decodes. */
  streamData(value: PdfValue | undefined, budget: InflateBudget): Buffer | null {
    const entry = this.entryOf(value);
    return entry ? this.filteredData(entry, this.filterChain((entry.stream as StreamSpan).dict), budget) : null;
  }

  /** A stream's data through `stages`: the file's own bytes when there are none (not charged, nothing is decoded), else decoded within `budget`. */
  private filteredData(entry: PdfObjectEntry, stages: PdfFilterStage[], budget: InflateBudget): Buffer | null {
    if (this.encrypted) return null;
    const stream = entry.stream as StreamSpan;
    if (stages.length === 0) return this.buffer.subarray(stream.rawStart, stream.rawEnd);
    return this.decodeStages(entry, stages, budget, false);
  }

  /** `dict.get(key, abbreviation)` of pdf.js (`Dict.#getValue`, pdf.worker.mjs 6542-6549): the first key unless it is missing, then the second, with a reference followed. */
  private entryValue(dict: PdfDict, key: string, abbreviation: string): PdfValue {
    const value = dict.entries.get(key);
    return this.resolve(value !== undefined ? value : dict.entries.get(abbreviation));
  }

  /**
   * Filter names of a stream in decoding order, each with its /DecodeParms dictionary. /F and /DP come before /Filter and
   * /DecodeParms, as pdf.js reads them in every stream, not only in inline images (`Parser.filter`, pdf.worker.mjs 17596-17598).
   */
  private filterChain(dict: PdfDict): PdfFilterStage[] {
    return filterStages(this.entryValue(dict, 'F', 'Filter'), this.entryValue(dict, 'DP', 'DecodeParms'), (value) => this.resolve(value));
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

  /** Whether the dictionary's /Subtype is `name`, a reference to a name included (`Dict.get` fetches it). */
  private hasSubtype(dict: PdfDict | undefined, name: string): boolean {
    return dict !== undefined && isName(this.resolve(dict.entries.get('Subtype')), name);
  }

  private isImage(entry: PdfObjectEntry): boolean {
    return this.hasSubtype(entry.stream?.dict, 'Image');
  }

  /** An image XObject, or any stream that carries a filter pdf.js decodes with its picture decoders. */
  private isPicture(entry: PdfObjectEntry): boolean {
    return entry.stream !== undefined && (this.isImage(entry) || this.filterChain(entry.stream.dict).some(({ name }) => PICTURE_CODEC_FILTERS.has(name)));
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
   * /Contents, followed by the form XObjects its resources name and the content invokes, then the normal appearances
   * of the annotations it lists and the forms they invoke. A file with no
   * page structure (no trailer root, catalog or page object) is read stream by stream instead, still
   * bounded, with image streams left alone. Encrypted files yield nothing.
   */
  contentStreams(visit: ContentVisitor): void {
    this.visitPageStreams(visit, true);
  }

  /**
   * Calls `visit` with the text of every annotation appearance stream the pages draw and the forms they invoke, under the
   * same budgets as `contentStreams`, for a reader that takes the page content as it is but builds the annotations. A file
   * with no page structure is read stream by stream, as there.
   */
  annotationAppearanceStreams(visit: ContentVisitor): void {
    this.visitPageStreams(visit, false);
  }

  /**
   * The image XObjects each page draws with `Do`, in its content, the forms it invokes and its annotation appearances, by object
   * number, as recorded by the last `contentStreams` or `annotationAppearanceStreams` call; empty for an encrypted file or one
   * without page structure.
   */
  paintedImageObjects(): ReadonlyArray<ReadonlySet<number>> {
    return this.paintedImages;
  }

  private visitPageStreams(visit: ContentVisitor, withPageContent: boolean): void {
    this.paintedImages = [];
    if (this.encrypted) return;
    const pages = this.pages();
    if (pages === null) {
      this.visitLooseStreams(visit);
      return;
    }
    const activeForms = new Set<number>();
    pages.forEach((page, pageIndex) => {
      const painted = new Set<number>();
      this.paintedImages.push(painted);
      const visitPage = (content: string): void => visit(content, pageIndex);
      for (const entry of withPageContent ? this.pageContentEntries(page.dict) : []) {
        this.countContentStream();
        const content = this.decodeStream(entry);
        if (content === null) continue;
        visitPage(content);
        this.drawForms(content, page.resources, 0, activeForms, visitPage, painted);
      }
      for (const entry of this.annotationAppearanceEntries(page.dict)) {
        const content = this.appearanceContent(entry);
        if (content === null) continue;
        visitPage(content);
        this.drawForms(content, (entry.stream as StreamSpan).dict.entries.get('Resources') ?? null, 0, activeForms, visitPage, painted);
      }
    });
  }

  /**
   * Decoded appearance stream; null when its data is damaged. pdf.js leaves out an annotation whose appearance fails to
   * read ("ignoring annotation data", src/core/document.js `getOperatorList`) and draws the rest, so a damaged
   * appearance is no reason to refuse the page. A stream past a limit is still refused.
   */
  private appearanceContent(entry: PdfObjectEntry): string | null {
    if (this.damagedAppearances.has(entry.num)) {
      this.countContentStream();
      return null;
    }
    try {
      return this.formContent(entry);
    } catch (error) {
      if (!(error instanceof CorruptStreamError)) throw error;
      this.damagedAppearances.add(entry.num);
      return null;
    }
  }

  /**
   * The normal appearance streams of the annotations a page lists (ISO 32000-1 section 12.5.5), one at a time so that each
   * is counted as it is drawn: the stream /AP /N names, or every stream of the states dictionary it names instead, whatever
   * their /Subtype, since pdf.js draws the one /AS names as it is (`Annotation.setAppearance`). pdf.js builds an annotation
   * for every entry of /Annots, so the entries count against MAX_PDF_ANNOTATIONS for the document, and an annotation listed
   * twice, which a real page never does, is refused rather than built twice.
   * @throws PdfStructureError past MAX_PDF_ANNOTATIONS or MAX_PDF_APPEARANCE_STATES, or for an annotation listed twice.
   */
  private *annotationAppearanceEntries(page: PdfDict): Generator<PdfObjectEntry> {
    const annotations = this.resolve(this.pageAnnotations(page));
    if (!isArray(annotations)) return;
    this.annotationCount += annotations.items.length;
    if (this.annotationCount > MAX_PDF_ANNOTATIONS) throw new PdfStructureError(`PDF lists more than ${MAX_PDF_ANNOTATIONS} annotations.`);
    const listed = new Set<number>();
    for (const item of annotations.items) {
      if (!isRef(item)) continue;
      if (listed.has(item.num)) throw new PdfStructureError(`PDF page lists annotation ${item.num} more than once.`);
      listed.add(item.num);
    }
    for (const item of annotations.items) yield* this.normalAppearances(item);
  }

  private *normalAppearances(annotation: PdfValue): Generator<PdfObjectEntry> {
    const normal = this.resolveDict(this.resolveDict(annotation)?.entries.get('AP'))?.entries.get('N');
    const stream = this.entryOf(normal);
    if (stream) {
      yield stream;
      return;
    }
    const states = this.resolveDict(normal)?.entries;
    if (!states) return;
    if (states.size > MAX_PDF_APPEARANCE_STATES) {
      throw new PdfStructureError(`PDF annotation has more than ${MAX_PDF_APPEARANCE_STATES} appearance states.`);
    }
    for (const state of states.values()) {
      const entry = this.entryOf(state);
      if (entry) yield entry;
    }
  }

  /**
   * /Annots as pdf.js reads it (`Page.annotations` through `getInheritableProperty`): the page's own, else that of the
   * nearest node up its /Parent chain, which stops where it would visit a node again.
   * @throws PdfStructureError when the chain is longer than a page tree may be deep.
   */
  private pageAnnotations(page: PdfDict): PdfValue | undefined {
    const visited = new Set<number>();
    let node: PdfDict | null = page;
    for (let depth = 0; node !== null; depth++) {
      const annotations = node.entries.get('Annots');
      if (annotations !== undefined) return annotations;
      const parent = node.entries.get('Parent');
      if (isRef(parent)) {
        if (visited.has(parent.num)) return undefined;
        visited.add(parent.num);
      }
      if (depth >= MAX_PDF_PAGE_TREE_DEPTH) throw new PdfStructureError('PDF page tree is nested too deeply.');
      node = this.resolveDict(parent);
    }
    return undefined;
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
    visit: (content: string) => void,
    painted: Set<number>
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
      if (this.isImage(entry)) painted.add(entry.num);
      if (!this.hasSubtype(entry.stream?.dict, 'Form')) continue;

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
      this.drawForms(formText, formResources === undefined ? resources : formResources, depth + 1, active, visit, painted);
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

  /**
   * The Type0 font dictionaries that the resources of the pages, and of the form XObjects those resources name, refer
   * to by reference, each once and at most `limit`. Streams they lead to are decoded on demand within `budget`, each stream
   * once however many fonts name it; one that does not decode reads as null, and one that inflates past a limit throws a
   * DecompressionLimitError, so that no later font pays for the same stream again. The /W arrays of the fonts are read on
   * one step budget (pdf-cid-widths.ts). Encrypted files and files without page structure have none.
   */
  compositeFonts(limit: number, budget: InflateBudget): CompositeFontDictionary[] {
    const streams = new Map<number, Buffer | null>();
    const widthReader = new CidWidthReader((value) => this.resolve(value));
    return this.pageFonts(limit, (num) => this.compositeFont(num, budget, streams, widthReader));
  }

  /**
   * The simple font dictionaries that the resources of the pages, and of the form XObjects those resources name, refer to by
   * reference, each once and at most `limit`, read as `compositeFonts` reads its fonts. Encrypted files and files without
   * page structure have none.
   */
  simpleFonts(limit: number): SimpleFontDictionary[] {
    return this.pageFonts(limit, (num) => this.simpleFont(num));
  }

  /** The fonts `read` makes of the font references of the page resources and their forms, each object once and at most `limit`. */
  private pageFonts<T>(limit: number, read: (num: number) => T | null): T[] {
    const pages = this.encrypted ? null : this.pages();
    if (pages === null) return [];
    const fonts = new Map<number, T>();
    const seen = new Set<number>();
    const visited = new Set<PdfDict>();
    const visit = (resources: PdfValue, depth: number): void => {
      const dict = this.resolveDict(resources);
      if (!dict || visited.has(dict) || fonts.size >= limit) return;
      visited.add(dict);
      for (const reference of this.resolveDict(dict.entries.get('Font'))?.entries.values() ?? []) {
        if (fonts.size >= limit || !isRef(reference) || seen.has(reference.num)) continue;
        seen.add(reference.num);
        const font = read(reference.num);
        if (font) fonts.set(reference.num, font);
      }
      if (depth >= MAX_PDF_FORM_DEPTH) return;
      for (const reference of this.resolveDict(dict.entries.get('XObject'))?.entries.values() ?? []) {
        const form = this.entryOf(reference)?.stream?.dict;
        if (form && this.hasSubtype(form, 'Form')) visit(form.entries.get('Resources') ?? null, depth + 1);
      }
    };
    for (const page of pages) visit(page.resources, 0);
    return [...fonts.values()];
  }

  private simpleFont(num: number): SimpleFontDictionary | null {
    const entry = this.index.get(num);
    const dict = this.resolveDict({ kind: 'ref', num });
    const subtype = dict?.entries.get('Subtype');
    if (!entry || entry.stream || !dict || !isName(subtype) || !SIMPLE_FONT_SUBTYPES.has(subtype.value)) return null;
    const differences = this.resolve(this.resolveDict(dict.entries.get('Encoding'))?.entries.get('Differences'));
    const baseFont = this.resolve(dict.entries.get('BaseFont'));
    return {
      objectNumber: num,
      generation: entry.gen,
      text: entry.source.slice(entry.start, entry.end),
      hasToUnicode: dict.entries.has('ToUnicode'),
      baseFont: isName(baseFont) ? baseFont.value : null,
      differences: isArray(differences)
        ? differences.items.map((item) => {
            const value = this.resolve(item);
            if (typeof value === 'number') return Number.isInteger(value) ? value : null;
            return isName(value) ? value.value : null;
          })
        : null,
    };
  }

  private compositeFont(
    num: number,
    budget: InflateBudget,
    streams: Map<number, Buffer | null>,
    widthReader: CidWidthReader
  ): CompositeFontDictionary | null {
    const entry = this.index.get(num);
    const dict = this.resolveDict({ kind: 'ref', num });
    if (!entry || entry.stream || !dict || !isName(dict.entries.get('Subtype'), 'Type0')) return null;
    const descendants = this.resolve(dict.entries.get('DescendantFonts'));
    const descendant = this.resolveDict(isArray(descendants) ? descendants.items[0] : undefined);
    const system = this.resolveDict(descendant?.entries.get('CIDSystemInfo'));
    const descriptor = this.resolveDict(descendant?.entries.get('FontDescriptor'));
    const encoding = this.resolve(dict.entries.get('Encoding'));
    const subtype = descendant?.entries.get('Subtype');
    const text = (key: string): string | null => {
      const value = this.resolve(system?.entries.get(key));
      return value !== null && typeof value === 'object' && value.kind === 'string' ? value.value : null;
    };
    const decoded = (value: PdfValue | undefined): Buffer | null => {
      const stream = this.entryOf(value);
      if (!stream || this.isImage(stream)) return null;
      const known = streams.get(stream.num);
      if (known !== undefined) return known;
      let bytes: Buffer | null = null;
      try {
        const content = this.decodeStream(stream, budget, false);
        bytes = content === null ? null : Buffer.from(content, 'latin1');
      } catch (error) {
        if (error instanceof DecompressionLimitError) throw error;
      }
      streams.set(stream.num, bytes);
      return bytes;
    };
    const name = this.resolve(descendant?.entries.get('BaseFont'));
    return {
      objectNumber: num,
      generation: entry.gen,
      text: entry.source.slice(entry.start, entry.end),
      hasToUnicode: dict.entries.has('ToUnicode'),
      encoding: isName(encoding) ? encoding.value : null,
      descendant: isName(subtype) ? subtype.value : null,
      descendantName: isName(name) ? name.value : null,
      program: this.fontProgramKind(descriptor),
      registry: text('Registry'),
      ordering: text('Ordering'),
      cidToGidMap: () => {
        const map = descendant?.entries.get('CIDToGIDMap');
        if (map === undefined || isName(this.resolve(map), 'Identity')) return 'identity';
        return decoded(map);
      },
      trueTypeProgram: () => decoded(descriptor?.entries.get('FontFile2')),
      cffProgram: () => (this.fontProgramKind(descriptor) === 'cid-cff' ? decoded(descriptor?.entries.get('FontFile3')) : null),
      toUnicodeData: () => decoded(dict.entries.get('ToUnicode')),
      cidWidths: (first, last) => widthReader.read(descendant?.entries.get('W'), first, last),
    };
  }

  /** The program a font descriptor embeds: /FontFile2, /FontFile3 of subtype CIDFontType0C, or null for none or another. */
  private fontProgramKind(descriptor: PdfDict | null): CompositeFontDictionary['program'] {
    if (descriptor?.entries.has('FontFile2')) return 'truetype';
    const fontFile3 = this.entryOf(descriptor?.entries.get('FontFile3'))?.stream?.dict;
    return fontFile3 && isName(fontFile3.entries.get('Subtype'), 'CIDFontType0C') ? 'cid-cff' : null;
  }

  /** The root, the next free object number and the last cross-reference offset, or null when the file names no root or `startxref`. */
  updateBase(): PdfUpdateBase | null {
    const root = this.rootRef ? this.index.get(this.rootRef.num) : undefined;
    const startxref = STARTXREF.exec(this.text.slice(this.text.lastIndexOf('startxref')));
    if (!root || !startxref || this.encrypted) return null;
    let highest = 0;
    for (const num of this.index.keys()) highest = Math.max(highest, num);
    return { root: { num: root.num, gen: root.gen }, nextObjectNumber: highest + 1, previousXref: Number(startxref[1]) };
  }

  /** Reads every stream in file order for a file with no page structure, each pass on its own budget. */
  private visitLooseStreams(visit: ContentVisitor): void {
    const passBudget = new InflateBudget();
    const entries = [...this.index.values()]
      .filter((entry) => entry.stream !== undefined && !this.isImage(entry))
      .sort((a, b) => a.seq - b.seq);
    for (const entry of entries) {
      const type = entry.stream?.dict.entries.get('Type');
      if (isName(type, 'XRef') || isName(type, 'ObjStm')) continue;
      this.countContentStream();
      const content = this.decodeStream(entry, passBudget, false);
      if (content !== null) visit(content, null);
    }
  }
}
