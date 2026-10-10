import { LEGACY_OFFICE_MAX_INPUT_BYTES } from './legacy-office-limits';
import { LegacyOfficeFormatError } from './legacy-office-errors';
import { decodeWindows1252 } from './windows-1252';

/**
 * Text reader for Rich Text Format documents, written from the RTF 1.9.1 specification: a tokenizer for
 * groups, control words, control symbols, `\'hh` bytes and `\uN` characters with `\ucN` fallback
 * skipping, code page decoding of 8-bit text, and destination groups that carry no body text.
 */

const LABEL = 'RTF document';

/** Deepest group nesting the reader follows. */
export const RTF_MAX_GROUP_DEPTH = 256;
/** Longest control word name; the specification allows 32 letters. */
export const RTF_MAX_CONTROL_WORD_LENGTH = 32;
/** Most digits of a control word parameter; the specification allows a signed 16-bit value. */
export const RTF_MAX_PARAMETER_DIGITS = 10;

const BYTE_OPEN_BRACE = 0x7b;
const BYTE_CLOSE_BRACE = 0x7d;
const BYTE_BACKSLASH = 0x5c;
const BYTE_CR = 0x0d;
const BYTE_LF = 0x0a;
const BYTE_SPACE = 0x20;
const BYTE_MINUS = 0x2d;
const BYTE_NUL = 0x00;
const BYTE_STAR = 0x2a;
const BYTE_APOSTROPHE = 0x27;
const BYTE_TAB = 0x09;
const FIRST_PRINTABLE_BYTE = 0x20;
const FIRST_NON_ASCII = 0x80;
const HEX_RADIX = 16;
const HEX_DIGITS_PER_BYTE = 2;
const HEX_LETTER_OFFSET = 10;
const SIGNED_16_BIT_OFFSET = 0x10000;
const MAX_UNICODE_CODE_UNIT = 0xffff;
const NO_BREAK_SPACE = ' ';
const NON_BREAKING_HYPHEN = '‑';
const RTF_SIGNATURE = Buffer.from('{\\rtf', 'latin1');

const HIGH_SURROGATE_FIRST = 0xd800;
const HIGH_SURROGATE_LAST = 0xdbff;
const LOW_SURROGATE_FIRST = 0xdc00;
const LOW_SURROGATE_LAST = 0xdfff;

const CODEPAGE_ANSI = 1252;
const CODEPAGE_MAC_ROMAN = 10000;
const CODEPAGE_OEM_US = 437;
const CODEPAGE_OEM_MULTILINGUAL = 850;
const DEFAULT_UNICODE_SKIP = 1;

/** Code pages the runtime decoder can read, by the label the decoder knows them under. */
const DECODER_LABELS: ReadonlyMap<number, string> = new Map([
  [874, 'windows-874'],
  [932, 'shift_jis'],
  [936, 'gbk'],
  [949, 'euc-kr'],
  [950, 'big5'],
  [1250, 'windows-1250'],
  [1251, 'windows-1251'],
  [1253, 'windows-1253'],
  [1254, 'windows-1254'],
  [1255, 'windows-1255'],
  [1256, 'windows-1256'],
  [1257, 'windows-1257'],
  [1258, 'windows-1258'],
  [CODEPAGE_MAC_ROMAN, 'macintosh'],
]);

/** Code page of each `\fcharsetN` value (RTF 1.9.1 font charset table); other charsets use the document code page. */
const CHARSET_CODEPAGES: ReadonlyMap<number, number> = new Map([
  [0, CODEPAGE_ANSI],
  [77, CODEPAGE_MAC_ROMAN],
  [128, 932],
  [129, 949],
  [130, 1361],
  [134, 936],
  [136, 950],
  [161, 1253],
  [162, 1254],
  [163, 1258],
  [177, 1255],
  [178, 1256],
  [186, 1257],
  [204, 1251],
  [222, 874],
  [238, 1250],
  [254, CODEPAGE_OEM_US],
  [255, CODEPAGE_OEM_US],
]);

/** Destinations that hold no body text: tables, styles, metadata, binary data, running headers and field codes. */
const IGNORED_DESTINATIONS: ReadonlySet<string> = new Set([
  'colortbl', 'stylesheet', 'info', 'pict', 'object', 'header', 'footer', 'headerl', 'headerr', 'headerf', 'footerl',
  'footerr', 'footerf', 'listtable', 'listoverridetable', 'rsidtbl', 'generator', 'themedata', 'colorschememapping',
  'latentstyles', 'datastore', 'xmlnstbl', 'filetbl', 'revtbl', 'pgptbl', 'protusertbl', 'template', 'fldinst', 'bkmkstart',
  'bkmkend', 'xe', 'tc', 'txe', 'rxe', 'sp', 'shprslt', 'pntext', 'listtext', 'pnseclvl', 'userprops', 'private',
  'nonshppict', 'blipuid', 'ftnsep', 'ftnsepc', 'aftnsep', 'aftnsepc', 'ftncn', 'aftncn', 'background', 'fchars', 'lchars',
  'defchp', 'defpap', 'docvar', 'annotation', 'atnid', 'atnauthor', 'atndate', 'atnref', 'do', 'mmathpr', 'wgrffmtfilter',
  'fontemb', 'fontfile', 'falt', 'panose', 'fname', 'revauth', 'revdttm', 'pn',
]);

/** Starred destinations the reader understands, so `\*` does not make it skip them. */
const UNDERSTOOD_STARRED: ReadonlySet<string> = new Set(['ud', 'shpinst']);

/** Control words that stand for one character. */
const CHARACTER_WORDS: ReadonlyMap<string, string> = new Map([
  ['emdash', '—'],
  ['endash', '–'],
  ['emspace', ' '],
  ['enspace', ' '],
  ['qmspace', ' '],
  ['bullet', '•'],
  ['lquote', '‘'],
  ['rquote', '’'],
  ['ldblquote', '“'],
  ['rdblquote', '”'],
  ['zwj', '‍'],
  ['zwnj', '‌'],
  ['ltrmark', '‎'],
  ['rtlmark', '‏'],
  ['tab', '\t'],
  ['cell', '\t'],
  ['nestcell', '\t'],
]);

/** Control words that end a paragraph or line. */
const LINE_BREAK_WORDS: ReadonlySet<string> = new Set(['par', 'line', 'sect', 'page', 'column']);
const ROW_END_WORDS: ReadonlySet<string> = new Set(['row', 'nestrow']);

type Destination = 'text' | 'ignore' | 'fonttbl';

interface GroupState {
  destination: Destination;
  /** `\ucN`: how many fallback characters follow each `\uN`. */
  unicodeSkip: number;
  font: number;
  /** The font table entry being defined while inside a `\fonttbl` group. */
  definingFont: number;
}

function hasUnpairedSurrogate(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= HIGH_SURROGATE_FIRST && code <= HIGH_SURROGATE_LAST) {
      const next = i + 1 < text.length ? text.charCodeAt(i + 1) : 0;
      if (next < LOW_SURROGATE_FIRST || next > LOW_SURROGATE_LAST) return true;
      i++;
    } else if (code >= LOW_SURROGATE_FIRST && code <= LOW_SURROGATE_LAST) {
      return true;
    }
  }
  return false;
}

function isLetter(byte: number): boolean {
  return (byte >= 0x41 && byte <= 0x5a) || (byte >= 0x61 && byte <= 0x7a);
}

function isDigit(byte: number): boolean {
  return byte >= 0x30 && byte <= 0x39;
}

function hexValue(byte: number): number {
  if (isDigit(byte)) return byte - 0x30;
  if (byte >= 0x41 && byte <= 0x46) return byte - 0x41 + HEX_LETTER_OFFSET;
  if (byte >= 0x61 && byte <= 0x66) return byte - 0x61 + HEX_LETTER_OFFSET;
  return -1;
}

class RtfReader {
  private index = 0;
  private readonly output: string[] = [];
  private readonly stack: GroupState[] = [];
  private current: GroupState = { destination: 'text', unicodeSkip: DEFAULT_UNICODE_SKIP, font: 0, definingFont: -1 };
  private rootClosed = false;
  /** True until the first token of a group is read; that token may name the group's destination. */
  private groupJustOpened = false;
  /** A `\*` opened the group: its destination is optional and skipped unless the reader knows it. */
  private starPending = false;
  private defaultFont = 0;
  private documentCodepage = CODEPAGE_ANSI;
  private readonly fontCodepages = new Map<number, number>();
  private readonly decoders = new Map<number, TextDecoder>();
  private pending: number[] = [];
  private pendingCodepage = CODEPAGE_ANSI;
  /** Fallback characters still to skip after a `\uN`. */
  private fallbackToSkip = 0;

  constructor(private readonly data: Buffer) {}

  read(): string {
    this.assertSignature();
    const data = this.data;
    while (this.index < data.length) {
      if (this.rootClosed) {
        this.assertTrailingBytesAreInert();
        break;
      }
      const byte = data[this.index];
      if (byte === BYTE_OPEN_BRACE) {
        this.openGroup();
      } else if (byte === BYTE_CLOSE_BRACE) {
        this.closeGroup();
      } else if (byte === BYTE_BACKSLASH) {
        this.readControl();
      } else if (byte === BYTE_CR || byte === BYTE_LF) {
        this.index++;
      } else {
        this.index++;
        this.acceptTextByte(byte);
      }
    }
    if (!this.rootClosed) {
      throw new LegacyOfficeFormatError(`${LABEL}: the document ends inside an open group.`);
    }
    return this.finish();
  }

  private assertSignature(): void {
    if (this.data.length < RTF_SIGNATURE.length || !this.data.subarray(0, RTF_SIGNATURE.length).equals(RTF_SIGNATURE)) {
      throw new LegacyOfficeFormatError(`${LABEL}: the file does not start with an RTF header.`);
    }
  }

  private assertTrailingBytesAreInert(): void {
    for (let i = this.index; i < this.data.length; i++) {
      const byte = this.data[i];
      if (byte !== BYTE_CR && byte !== BYTE_LF && byte !== BYTE_SPACE && byte !== BYTE_NUL) {
        throw new LegacyOfficeFormatError(`${LABEL}: unexpected data follows the end of the document.`);
      }
    }
  }

  private finish(): string {
    const text = this.output.join('');
    if (hasUnpairedSurrogate(text)) {
      throw new LegacyOfficeFormatError(`${LABEL}: a \\u escape leaves an unpaired surrogate in the text.`);
    }
    let end = text.length;
    while (end > 0 && (text[end - 1] === '\n' || text[end - 1] === '\t' || text[end - 1] === ' ')) end--;
    const trimmed = text.slice(0, end);
    if (trimmed.trim().length === 0) {
      throw new LegacyOfficeFormatError(`${LABEL}: the document holds no text.`);
    }
    return trimmed;
  }

  private openGroup(): void {
    this.index++;
    this.flushPending();
    this.fallbackToSkip = 0;
    if (this.stack.length >= RTF_MAX_GROUP_DEPTH) {
      throw new LegacyOfficeFormatError(`${LABEL}: groups are nested deeper than ${RTF_MAX_GROUP_DEPTH} levels.`);
    }
    this.stack.push(this.current);
    this.current = { ...this.current };
    this.groupJustOpened = true;
    this.starPending = false;
  }

  private closeGroup(): void {
    this.index++;
    this.flushPending();
    this.fallbackToSkip = 0;
    this.groupJustOpened = false;
    this.starPending = false;
    const parent = this.stack.pop();
    if (parent === undefined) {
      throw new LegacyOfficeFormatError(`${LABEL}: a closing brace has no matching opening brace.`);
    }
    this.current = parent;
    if (this.stack.length === 0) this.rootClosed = true;
  }

  private readControl(): void {
    const data = this.data;
    const start = this.index + 1;
    if (start >= data.length) {
      throw new LegacyOfficeFormatError(`${LABEL}: the document ends after a backslash.`);
    }
    const first = data[start];
    if (isLetter(first)) {
      this.readControlWord(start);
      return;
    }
    this.index = start + 1;
    if (first === BYTE_APOSTROPHE) {
      this.readHexByte();
      return;
    }
    this.handleControlSymbol(first);
  }

  private readHexByte(): void {
    const data = this.data;
    if (this.index + HEX_DIGITS_PER_BYTE > data.length) {
      throw new LegacyOfficeFormatError(`${LABEL}: a \\' escape is cut off.`);
    }
    const high = hexValue(data[this.index]);
    const low = hexValue(data[this.index + 1]);
    if (high < 0 || low < 0) {
      throw new LegacyOfficeFormatError(`${LABEL}: a \\' escape is not followed by two hex digits.`);
    }
    this.index += HEX_DIGITS_PER_BYTE;
    this.groupJustOpened = false;
    this.starPending = false;
    if (this.fallbackToSkip > 0) {
      this.fallbackToSkip--;
      return;
    }
    this.pushEightBit(high * HEX_RADIX + low);
  }

  private handleControlSymbol(symbol: number): void {
    this.fallbackToSkip = 0;
    this.flushPending();
    if (this.groupJustOpened && symbol === BYTE_STAR) {
      // The destination keyword that follows still counts as the first token of the group.
      this.starPending = true;
      return;
    }
    this.groupJustOpened = false;
    this.starPending = false;
    switch (String.fromCharCode(symbol)) {
      case '\\':
      case '{':
      case '}':
        this.emit(String.fromCharCode(symbol));
        break;
      case '~':
        this.emit(NO_BREAK_SPACE);
        break;
      case '_':
        this.emit(NON_BREAKING_HYPHEN);
        break;
      case '\r':
      case '\n':
        this.emit('\n');
        break;
      default:
        break;
    }
  }

  private readControlWord(start: number): void {
    const data = this.data;
    let end = start;
    while (end < data.length && isLetter(data[end])) {
      end++;
      if (end - start > RTF_MAX_CONTROL_WORD_LENGTH) {
        throw new LegacyOfficeFormatError(`${LABEL}: a control word is longer than ${RTF_MAX_CONTROL_WORD_LENGTH} letters.`);
      }
    }
    const word = data.toString('latin1', start, end);
    let parameter: number | undefined;
    let cursor = end;
    const negative = cursor < data.length && data[cursor] === BYTE_MINUS;
    const digitsStart = negative ? cursor + 1 : cursor;
    let digitsEnd = digitsStart;
    while (digitsEnd < data.length && isDigit(data[digitsEnd])) {
      digitsEnd++;
      if (digitsEnd - digitsStart > RTF_MAX_PARAMETER_DIGITS) {
        throw new LegacyOfficeFormatError(`${LABEL}: the parameter of \\${word} has more than ${RTF_MAX_PARAMETER_DIGITS} digits.`);
      }
    }
    if (digitsEnd > digitsStart) {
      const magnitude = Number.parseInt(data.toString('latin1', digitsStart, digitsEnd), 10);
      parameter = negative ? -magnitude : magnitude;
      cursor = digitsEnd;
    }
    if (cursor < data.length && data[cursor] === BYTE_SPACE) cursor++;
    this.index = cursor;
    this.handleControlWord(word, parameter);
  }

  private handleControlWord(word: string, parameter: number | undefined): void {
    const wasFirst = this.groupJustOpened;
    this.groupJustOpened = false;
    this.fallbackToSkip = 0;
    this.flushPending();
    if (wasFirst) this.classifyDestination(word);
    this.starPending = false;
    if (word === 'bin') {
      this.skipBinary(parameter ?? 0);
      return;
    }
    if (this.current.destination === 'ignore') return;
    if (this.current.destination === 'fonttbl') {
      this.handleFontTableWord(word, parameter);
      return;
    }
    this.handleTextWord(word, parameter);
  }

  /** The first control word of a group names its destination; `\*` marks the destination as optional. */
  private classifyDestination(word: string): void {
    if (word === 'fonttbl') {
      this.current.destination = 'fonttbl';
    } else if (IGNORED_DESTINATIONS.has(word)) {
      this.current.destination = 'ignore';
    } else if (this.starPending && !UNDERSTOOD_STARRED.has(word)) {
      this.current.destination = 'ignore';
    }
  }

  private handleFontTableWord(word: string, parameter: number | undefined): void {
    if (parameter === undefined) return;
    if (word === 'f') {
      this.current.definingFont = parameter;
    } else if (word === 'fcharset' && this.current.definingFont >= 0) {
      const codepage = CHARSET_CODEPAGES.get(parameter);
      if (codepage !== undefined) this.fontCodepages.set(this.current.definingFont, codepage);
    } else if (word === 'cpg' && this.current.definingFont >= 0) {
      this.fontCodepages.set(this.current.definingFont, parameter);
    }
  }

  private handleTextWord(word: string, parameter: number | undefined): void {
    if (word === 'u') {
      this.appendUnicode(parameter);
      return;
    }
    const character = CHARACTER_WORDS.get(word);
    if (character !== undefined) {
      this.emit(character);
    } else if (LINE_BREAK_WORDS.has(word)) {
      this.emit('\n');
    } else if (ROW_END_WORDS.has(word)) {
      this.endRow();
    } else if (word === 'uc') {
      this.current.unicodeSkip = Math.max(0, parameter ?? DEFAULT_UNICODE_SKIP);
    } else if (word === 'ansicpg' && parameter !== undefined) {
      this.documentCodepage = parameter;
    } else if (word === 'ansi') {
      this.documentCodepage = CODEPAGE_ANSI;
    } else if (word === 'mac') {
      this.documentCodepage = CODEPAGE_MAC_ROMAN;
    } else if (word === 'pc') {
      this.documentCodepage = CODEPAGE_OEM_US;
    } else if (word === 'pca') {
      this.documentCodepage = CODEPAGE_OEM_MULTILINGUAL;
    } else if (word === 'deff' && parameter !== undefined) {
      this.defaultFont = parameter;
      this.current.font = parameter;
    } else if (word === 'f' && parameter !== undefined) {
      this.current.font = parameter;
    } else if (word === 'plain') {
      this.current.font = this.defaultFont;
    }
  }

  /** `\uN`: a signed 16-bit UTF-16 code unit, followed by `\ucN` fallback characters that are skipped. */
  private appendUnicode(parameter: number | undefined): void {
    if (parameter === undefined) {
      throw new LegacyOfficeFormatError(`${LABEL}: \\u has no value.`);
    }
    const code = parameter < 0 ? parameter + SIGNED_16_BIT_OFFSET : parameter;
    if (code < 0 || code > MAX_UNICODE_CODE_UNIT) {
      throw new LegacyOfficeFormatError(`${LABEL}: \\u${parameter} is outside the 16-bit range.`);
    }
    this.output.push(String.fromCharCode(code));
    this.fallbackToSkip = this.current.unicodeSkip;
  }

  private endRow(): void {
    if (this.output.length > 0 && this.output[this.output.length - 1] === '\t') {
      this.output[this.output.length - 1] = '\n';
    } else {
      this.output.push('\n');
    }
  }

  /** `\binN` is followed by N raw bytes that must not be parsed. */
  private skipBinary(length: number): void {
    if (length < 0 || this.index + length > this.data.length) {
      throw new LegacyOfficeFormatError(`${LABEL}: \\bin${length} runs past the end of the document.`);
    }
    this.index += length;
  }

  private acceptTextByte(byte: number): void {
    this.groupJustOpened = false;
    this.starPending = false;
    if (this.fallbackToSkip > 0) {
      this.fallbackToSkip--;
      return;
    }
    if (this.current.destination !== 'text') return;
    if (byte < FIRST_NON_ASCII) {
      this.flushPending();
      if (byte >= FIRST_PRINTABLE_BYTE || byte === BYTE_TAB) this.output.push(String.fromCharCode(byte));
    } else {
      this.pushEightBit(byte);
    }
  }

  private emit(text: string): void {
    if (this.current.destination === 'text') this.output.push(text);
  }

  private pushEightBit(byte: number): void {
    if (this.current.destination !== 'text') return;
    const codepage = this.fontCodepages.get(this.current.font) ?? this.documentCodepage;
    if (this.pending.length > 0 && codepage !== this.pendingCodepage) this.flushPending();
    this.pendingCodepage = codepage;
    this.pending.push(byte);
  }

  private flushPending(): void {
    if (this.pending.length === 0) return;
    const bytes = Uint8Array.from(this.pending);
    this.pending = [];
    this.output.push(this.decode(bytes, this.pendingCodepage));
  }

  private decode(bytes: Uint8Array, codepage: number): string {
    if (codepage === CODEPAGE_ANSI) return decodeWindows1252(bytes);
    let decoder = this.decoders.get(codepage);
    if (decoder === undefined) {
      const label = DECODER_LABELS.get(codepage);
      if (label === undefined) {
        throw new LegacyOfficeFormatError(`${LABEL}: code page ${codepage} is not supported.`);
      }
      decoder = new TextDecoder(label, { fatal: true });
      this.decoders.set(codepage, decoder);
    }
    try {
      return decoder.decode(bytes);
    } catch {
      throw new LegacyOfficeFormatError(`${LABEL}: bytes cannot be decoded in code page ${codepage}.`);
    }
  }
}

/**
 * Extracts the text of an RTF document. Malformed documents (no RTF header, unbalanced groups, groups
 * nested past RTF_MAX_GROUP_DEPTH, truncated escapes, undecodable bytes, no text) throw a
 * LegacyOfficeFormatError.
 */
export function readRtfText(data: Buffer): string {
  if (data.length > LEGACY_OFFICE_MAX_INPUT_BYTES) {
    throw new LegacyOfficeFormatError(`${LABEL}: the file exceeds the ${LEGACY_OFFICE_MAX_INPUT_BYTES}-byte limit.`);
  }
  return new RtfReader(data).read();
}
