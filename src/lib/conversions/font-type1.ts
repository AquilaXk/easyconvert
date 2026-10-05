import { ConversionFailedError } from '../types';
import { ADOBE_STANDARD_ENCODING_ENTRIES } from './font-type1-data';

/**
 * Adobe Type 1 font reader (Adobe Type 1 Font Format, version 1.1).
 *
 * Reads PFB (segmented) and PFA (hexadecimal) containers, decrypts the eexec private portion and
 * the individual charstrings, parses the cleartext font dictionary and interprets every charstring
 * into absolute cubic outlines. Every read is bounds checked and every limit is enforced with a
 * typed error, so a malformed or hostile font never yields partial output.
 */

export class Type1FontError extends ConversionFailedError {
  constructor(message: string) {
    super(message);
    this.name = 'Type1FontError';
  }
}

// ---------------------------------------------------------------------------------------------
// Constants (Adobe Type 1 Font Format chapters 5 to 8)
// ---------------------------------------------------------------------------------------------

const PFB_SEGMENT_MARKER = 0x80;
const PFB_SEGMENT_ASCII = 1;
const PFB_SEGMENT_BINARY = 2;
const PFB_SEGMENT_EOF = 3;
const PFB_SEGMENT_HEADER_BYTES = 6;
const PFB_EOF_HEADER_BYTES = 2;

const EEXEC_KEY = 55665;
const CHARSTRING_KEY = 4330;
const CRYPT_C1 = 52845;
const CRYPT_C2 = 22719;
const CRYPT_MODULUS_MASK = 0xffff;
const EEXEC_LEAD_BYTES = 4;
const EEXEC_SNIFF_BYTES = 4;
const DEFAULT_LEN_IV = 4;
const UNENCRYPTED_LEN_IV = -1;
const MAX_LEN_IV = 16;
const PFA_TRAILER_ZEROS = 512;

const MAX_CLEARTEXT_BYTES = 1 << 20;
const MAX_ENCRYPTED_BYTES = 32 << 20;
const MAX_SUBRS = 16384;
const MAX_GLYPHS = 32768;
const MAX_GLYPH_NAME_LENGTH = 127;

/** Type 1 BuildChar operand stack depth (Type 1 Font Format, "Charstring Operand Stack"). */
const MAX_STACK_DEPTH = 24;
/** Subroutine nesting limit. */
const MAX_SUBR_CALL_DEPTH = 10;
/** Tokens executed for one glyph, including subroutine bodies. */
const MAX_STEPS_PER_GLYPH = 50_000;
/** Tokens executed for a whole font, so many glyphs cannot each burn the per-glyph budget. */
const MAX_STEPS_PER_FONT = 16_000_000;
const MAX_PS_STACK_DEPTH = MAX_STACK_DEPTH;
const FLEX_POINT_COUNT = 7;
const FLEX_END_ARGUMENT_COUNT = 3;
const SEAC_ARGUMENT_COUNT = 5;
const MAX_ENCODING_CODE = 255;
const MAX_FONT_MATRIX_ENTRIES = 6;
const FONT_BBOX_ENTRIES = 4;

const NOTDEF_GLYPH_NAME = '.notdef';
const FONT_TYPE_TYPE1 = 1;
const PAINT_TYPE_FILL = 0;

const WHITESPACE_BYTES = new Set([0, 9, 10, 12, 13, 32]);
const DELIMITER_BYTES = new Set([0x28, 0x29, 0x3c, 0x3e, 0x5b, 0x5d, 0x7b, 0x7d, 0x2f, 0x25]);
const PS_SUBRS_TERMINATORS = new Set(['ND', '|-', 'def']);
const BASE_FONT_MATRIX: readonly number[] = [0.001, 0, 0, 0.001, 0, 0];
const GLYPH_NAME_PATTERN = /^[\x21-\x7e]+$/;
const NUMBER_PATTERN = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;
const INTEGER_PATTERN = /^[+-]?\d+$/;

// Charstring commands (Type 1 Font Format, "Charstring Command Set").
const CMD_HSTEM = 1;
const CMD_VSTEM = 3;
const CMD_VMOVETO = 4;
const CMD_RLINETO = 5;
const CMD_HLINETO = 6;
const CMD_VLINETO = 7;
const CMD_RRCURVETO = 8;
const CMD_CLOSEPATH = 9;
const CMD_CALLSUBR = 10;
const CMD_RETURN = 11;
const CMD_ESCAPE = 12;
const CMD_HSBW = 13;
const CMD_ENDCHAR = 14;
const CMD_RMOVETO = 21;
const CMD_HMOVETO = 22;
const CMD_VHCURVETO = 30;
const CMD_HVCURVETO = 31;
const ESC_DOTSECTION = 0;
const ESC_VSTEM3 = 1;
const ESC_HSTEM3 = 2;
const ESC_SEAC = 6;
const ESC_SBW = 7;
const ESC_DIV = 12;
const ESC_CALLOTHERSUBR = 16;
const ESC_POP = 17;
const ESC_SETCURRENTPOINT = 33;

// Number encodings (Type 1 Font Format, "Charstring Number Encoding").
const NUM_SMALL_MAX = 246;
const NUM_SMALL_BIAS = 139;
const NUM_POSITIVE_MAX = 250;
const NUM_POSITIVE_BASE = 247;
const NUM_NEGATIVE_MAX = 254;
const NUM_NEGATIVE_BASE = 251;
const NUM_TWO_BYTE_BIAS = 108;
const NUM_BYTE_RANGE = 256;
const NUM_FIRST = 32;

// OtherSubrs handled natively.
const OTHERSUBR_FLEX_END = 0;
const OTHERSUBR_FLEX_BEGIN = 1;
const OTHERSUBR_FLEX_POINT = 2;
const OTHERSUBR_HINT_REPLACEMENT = 3;
const OTHERSUBR_COUNTER_CONTROL_A = 12;
const OTHERSUBR_COUNTER_CONTROL_B = 13;

// ---------------------------------------------------------------------------------------------
// Public model
// ---------------------------------------------------------------------------------------------

export type Type1PathCommand =
  | { type: 'move'; x: number; y: number }
  | { type: 'line'; x: number; y: number }
  | { type: 'curve'; x1: number; y1: number; x2: number; y2: number; x3: number; y3: number }
  | { type: 'close' };

export interface Type1Glyph {
  name: string;
  /** Horizontal advance in glyph space units (before FontMatrix). */
  advance: number;
  /** Absolute outline in glyph space units (before FontMatrix). */
  commands: Type1PathCommand[];
}

export interface Type1Font {
  fontName: string;
  familyName: string;
  fullName: string;
  weight: string;
  version: string;
  notice: string;
  fontMatrix: number[];
  fontBBox: number[];
  italicAngle: number;
  isFixedPitch: boolean;
  underlinePosition: number;
  underlineThickness: number;
  fsType: number;
  /** Character code to glyph name from the font's own Encoding. */
  encoding: Map<number, string>;
  /** Glyph 0 is always .notdef. */
  glyphs: Type1Glyph[];
}

// ---------------------------------------------------------------------------------------------
// Container framing (PFB segments and PFA hexadecimal text)
// ---------------------------------------------------------------------------------------------

interface Type1Sections {
  cleartext: Buffer;
  encrypted: Buffer;
}

function splitPfb(buffer: Buffer): Type1Sections {
  const clear: Buffer[] = [];
  const binary: Buffer[] = [];
  let pos = 0;
  let sawBinary = false;
  let sawEof = false;
  let clearBytes = 0;
  let binaryBytes = 0;

  while (pos < buffer.length) {
    if (pos + PFB_EOF_HEADER_BYTES > buffer.length) {
      throw new Type1FontError('Truncated PFB segment header.');
    }
    if (buffer[pos] !== PFB_SEGMENT_MARKER) {
      throw new Type1FontError(`Invalid PFB segment marker 0x${buffer[pos].toString(16)} at offset ${pos}.`);
    }
    const type = buffer[pos + 1];
    if (type === PFB_SEGMENT_EOF) {
      sawEof = true;
      break;
    }
    if (type !== PFB_SEGMENT_ASCII && type !== PFB_SEGMENT_BINARY) {
      throw new Type1FontError(`Invalid PFB segment type ${type} at offset ${pos}.`);
    }
    if (pos + PFB_SEGMENT_HEADER_BYTES > buffer.length) {
      throw new Type1FontError('Truncated PFB segment header.');
    }
    const length = buffer.readUInt32LE(pos + 2);
    const start = pos + PFB_SEGMENT_HEADER_BYTES;
    if (length > buffer.length - start) {
      throw new Type1FontError(`PFB segment at offset ${pos} declares ${length} bytes but the file ends first.`);
    }
    const payload = buffer.subarray(start, start + length);
    if (type === PFB_SEGMENT_BINARY) {
      sawBinary = true;
      binaryBytes += length;
      binary.push(payload);
    } else if (!sawBinary) {
      clearBytes += length;
      clear.push(payload);
    }
    if (clearBytes > MAX_CLEARTEXT_BYTES) {
      throw new Type1FontError('PFB cleartext portion is implausibly large.');
    }
    if (binaryBytes > MAX_ENCRYPTED_BYTES) {
      throw new Type1FontError('PFB encrypted portion exceeds the supported size.');
    }
    pos = start + length;
  }

  if (!sawBinary) {
    throw new Type1FontError('PFB contains no binary (eexec) segment.');
  }
  if (!sawEof && pos !== buffer.length) {
    throw new Type1FontError('PFB ends inside a segment.');
  }
  return { cleartext: Buffer.concat(clear), encrypted: Buffer.concat(binary) };
}

function isHexDigit(byte: number): boolean {
  return (byte >= 0x30 && byte <= 0x39) || (byte >= 0x41 && byte <= 0x46) || (byte >= 0x61 && byte <= 0x66);
}

function hexValue(byte: number): number {
  if (byte <= 0x39) return byte - 0x30;
  if (byte <= 0x46) return byte - 0x41 + 10;
  return byte - 0x61 + 10;
}

const NIBBLE_BITS = 4;

function decodeHexRegion(region: Buffer): Buffer {
  const nibbles = new Uint8Array(region.length);
  let count = 0;
  for (const byte of region) {
    if (WHITESPACE_BYTES.has(byte)) continue;
    if (!isHexDigit(byte)) {
      throw new Type1FontError('PFA eexec section contains a non-hexadecimal character.');
    }
    nibbles[count++] = hexValue(byte);
  }
  // The section ends with 512 ASCII zeros that precede cleartomark; they are not ciphertext.
  if (count >= PFA_TRAILER_ZEROS) {
    let allZero = true;
    for (let i = count - PFA_TRAILER_ZEROS; i < count; i++) {
      if (nibbles[i] !== 0) {
        allZero = false;
        break;
      }
    }
    if (allZero) count -= PFA_TRAILER_ZEROS;
  }
  if (count % 2 !== 0) {
    throw new Type1FontError('PFA eexec section has an odd number of hexadecimal digits.');
  }
  const out = Buffer.alloc(count / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = (nibbles[2 * i] << NIBBLE_BITS) | nibbles[2 * i + 1];
  }
  return out;
}

function splitPfa(buffer: Buffer): Type1Sections {
  const head = buffer.subarray(0, Math.min(buffer.length, MAX_CLEARTEXT_BYTES)).toString('latin1');
  const match = /currentfile\s+eexec/.exec(head);
  if (!match) {
    throw new Type1FontError('Type 1 font has no "currentfile eexec" section.');
  }
  const cleartext = buffer.subarray(0, match.index + match[0].length);
  let pos = match.index + match[0].length;
  while (pos < buffer.length && WHITESPACE_BYTES.has(buffer[pos])) pos++;
  if (pos >= buffer.length) {
    throw new Type1FontError('Type 1 font has an empty eexec section.');
  }

  const rest = buffer.subarray(pos);
  let sniffIsHex = rest.length >= EEXEC_SNIFF_BYTES;
  for (let i = 0; i < EEXEC_SNIFF_BYTES && sniffIsHex; i++) {
    sniffIsHex = isHexDigit(rest[i]);
  }
  if (!sniffIsHex) {
    // Binary eexec data in a text container: it runs to the end of the file.
    return { cleartext, encrypted: rest };
  }

  const markerAt = rest.lastIndexOf('cleartomark', undefined, 'latin1');
  const region = markerAt >= 0 ? rest.subarray(0, markerAt) : rest;
  if (region.length > MAX_ENCRYPTED_BYTES * 2) {
    throw new Type1FontError('PFA encrypted portion exceeds the supported size.');
  }
  return { cleartext, encrypted: decodeHexRegion(region) };
}

function splitContainer(buffer: Buffer): Type1Sections {
  if (buffer.length === 0) {
    throw new Type1FontError('Type 1 font payload is empty.');
  }
  const sections = buffer[0] === PFB_SEGMENT_MARKER ? splitPfb(buffer) : splitPfa(buffer);
  if (sections.cleartext.length > MAX_CLEARTEXT_BYTES) {
    throw new Type1FontError('Type 1 cleartext portion is implausibly large.');
  }
  if (sections.encrypted.length <= EEXEC_LEAD_BYTES) {
    throw new Type1FontError('Type 1 eexec section is too short.');
  }
  return sections;
}

// ---------------------------------------------------------------------------------------------
// Encryption (Type 1 Font Format chapter 7)
// ---------------------------------------------------------------------------------------------

function decryptType1(data: Uint8Array, key: number, leadBytes: number): Buffer {
  const out = Buffer.alloc(data.length);
  let r = key;
  for (let i = 0; i < data.length; i++) {
    const cipher = data[i];
    out[i] = cipher ^ (r >> 8);
    r = ((cipher + r) * CRYPT_C1 + CRYPT_C2) & CRYPT_MODULUS_MASK;
  }
  return out.subarray(leadBytes);
}

// ---------------------------------------------------------------------------------------------
// PostScript-subset scanner shared by the cleartext and the private dictionary
// ---------------------------------------------------------------------------------------------

type TokenKind = 'literal' | 'name' | 'int' | 'real' | 'string' | 'delim';

interface PsToken {
  kind: TokenKind;
  text: string;
  value: number;
  start: number;
}

class PsScanner {
  pos = 0;

  constructor(private readonly data: Buffer) {}

  private skipSpace(): void {
    const { data } = this;
    while (this.pos < data.length) {
      const byte = data[this.pos];
      if (WHITESPACE_BYTES.has(byte)) {
        this.pos++;
      } else if (byte === 0x25) {
        while (this.pos < data.length && data[this.pos] !== 10 && data[this.pos] !== 13) this.pos++;
      } else {
        break;
      }
    }
  }

  private readRegular(): string {
    const { data } = this;
    const begin = this.pos;
    while (this.pos < data.length && !WHITESPACE_BYTES.has(data[this.pos]) && !DELIMITER_BYTES.has(data[this.pos])) {
      this.pos++;
    }
    return data.toString('latin1', begin, this.pos);
  }

  private readString(): string {
    const { data } = this;
    let depth = 1;
    const out: number[] = [];
    this.pos++;
    while (this.pos < data.length) {
      const byte = data[this.pos++];
      if (byte === 0x5c && this.pos < data.length) {
        out.push(data[this.pos++]);
      } else if (byte === 0x28) {
        depth++;
        out.push(byte);
      } else if (byte === 0x29) {
        depth--;
        if (depth === 0) return Buffer.from(out).toString('latin1');
        out.push(byte);
      } else {
        out.push(byte);
      }
    }
    throw new Type1FontError('Unterminated PostScript string.');
  }

  next(): PsToken | null {
    this.skipSpace();
    const { data } = this;
    if (this.pos >= data.length) return null;
    const start = this.pos;
    const byte = data[this.pos];

    if (byte === 0x2f) {
      this.pos++;
      return { kind: 'literal', text: this.readRegular(), value: 0, start };
    }
    if (byte === 0x28) {
      return { kind: 'string', text: this.readString(), value: 0, start };
    }
    if (byte === 0x3c && data[this.pos + 1] !== 0x3c) {
      const close = data.indexOf(0x3e, this.pos);
      if (close < 0) throw new Type1FontError('Unterminated PostScript hex string.');
      this.pos = close + 1;
      return { kind: 'string', text: '', value: 0, start };
    }
    if (DELIMITER_BYTES.has(byte)) {
      const twoChar = (byte === 0x3c || byte === 0x3e) && data[this.pos + 1] === byte;
      this.pos += twoChar ? 2 : 1;
      return { kind: 'delim', text: data.toString('latin1', start, this.pos), value: 0, start };
    }

    const text = this.readRegular();
    if (INTEGER_PATTERN.test(text)) {
      return { kind: 'int', text, value: Number.parseInt(text, 10), start };
    }
    if (NUMBER_PATTERN.test(text)) {
      return { kind: 'real', text, value: Number.parseFloat(text), start };
    }
    return { kind: 'name', text, value: 0, start };
  }

  /** Returns the exact bytes of a binary blob that follows an RD token (one separator byte, then length bytes). */
  readBlob(length: number): Buffer {
    const begin = this.pos + 1;
    if (!Number.isInteger(length) || length < 0 || begin + length > this.data.length) {
      throw new Type1FontError('Binary charstring data runs past the end of the private dictionary.');
    }
    this.pos = begin + length;
    return this.data.subarray(begin, begin + length);
  }
}

function isNumberToken(token: PsToken | null): token is PsToken {
  return token !== null && (token.kind === 'int' || token.kind === 'real');
}

function expectInt(token: PsToken | null, what: string): number {
  if (token === null || token.kind !== 'int') {
    throw new Type1FontError(`Expected an integer for ${what}.`);
  }
  return token.value;
}

// ---------------------------------------------------------------------------------------------
// Cleartext font dictionary
// ---------------------------------------------------------------------------------------------

interface FontDictionary {
  fontName: string;
  familyName: string;
  fullName: string;
  weight: string;
  version: string;
  notice: string;
  fontMatrix: number[];
  fontBBox: number[];
  italicAngle: number;
  isFixedPitch: boolean;
  underlinePosition: number;
  underlineThickness: number;
  fsType: number;
  encodingKind: 'standard' | 'custom' | 'unknown';
  encoding: Map<number, string>;
}

function readNumberArray(scanner: PsScanner, limit: number, what: string): number[] {
  const open = scanner.next();
  if (open === null || open.kind !== 'delim' || (open.text !== '[' && open.text !== '{')) {
    throw new Type1FontError(`${what} must be an array.`);
  }
  const values: number[] = [];
  for (;;) {
    const token = scanner.next();
    if (token === null) throw new Type1FontError(`${what} is not terminated.`);
    if (token.kind === 'delim' && (token.text === ']' || token.text === '}')) break;
    if (!isNumberToken(token)) throw new Type1FontError(`${what} holds a non-numeric entry.`);
    values.push(token.value);
    if (values.length > limit) throw new Type1FontError(`${what} has too many entries.`);
  }
  return values;
}

function readEncoding(scanner: PsScanner, dict: FontDictionary): void {
  const first = scanner.next();
  if (first !== null && first.kind === 'name' && first.text === 'StandardEncoding') {
    dict.encodingKind = 'standard';
    return;
  }
  if (first === null || first.kind !== 'int') {
    dict.encodingKind = 'unknown';
    return;
  }
  dict.encodingKind = 'custom';
  // `256 array 0 1 255 {...} for dup <code> /<name> put ... readonly def`
  let previous2: PsToken | null = null;
  let previous1: PsToken | null = null;
  for (let token = scanner.next(); token !== null; token = scanner.next()) {
    if (token.kind === 'name' && token.text === 'def') return;
    if (
      token.kind === 'name' &&
      token.text === 'put' &&
      previous1 !== null &&
      previous1.kind === 'literal' &&
      previous2 !== null &&
      previous2.kind === 'int'
    ) {
      if (previous2.value >= 0 && previous2.value <= MAX_ENCODING_CODE) {
        dict.encoding.set(previous2.value, previous1.text);
      } else {
        throw new Type1FontError(`Encoding code ${previous2.value} is outside 0..255.`);
      }
    }
    previous2 = previous1;
    previous1 = token;
  }
  throw new Type1FontError('Encoding array is not terminated.');
}

type StringField = 'familyName' | 'fullName' | 'weight' | 'version' | 'notice';

const STRING_KEYS: ReadonlyMap<string, StringField> = new Map<string, StringField>([
  ['FamilyName', 'familyName'],
  ['FullName', 'fullName'],
  ['Weight', 'weight'],
  ['version', 'version'],
  ['Notice', 'notice'],
]);

function parseCleartext(cleartext: Buffer): FontDictionary {
  const dict: FontDictionary = {
    fontName: '',
    familyName: '',
    fullName: '',
    weight: '',
    version: '',
    notice: '',
    fontMatrix: [...BASE_FONT_MATRIX],
    fontBBox: [0, 0, 0, 0],
    italicAngle: 0,
    isFixedPitch: false,
    underlinePosition: 0,
    underlineThickness: 0,
    fsType: 0,
    encodingKind: 'unknown',
    encoding: new Map(),
  };
  const seen = new Set<string>();
  const scanner = new PsScanner(cleartext);

  for (let token = scanner.next(); token !== null; token = scanner.next()) {
    if (token.kind !== 'literal' || seen.has(token.text)) continue;
    const key = token.text;
    const stringField = STRING_KEYS.get(key);

    if (key === 'FontName') {
      const value = scanner.next();
      if (value !== null && value.kind === 'literal') {
        dict.fontName = value.text;
        seen.add(key);
      }
    } else if (stringField !== undefined) {
      const value = scanner.next();
      if (value !== null && value.kind === 'string') {
        dict[stringField] = value.text;
        seen.add(key);
      }
    } else if (key === 'FontMatrix') {
      dict.fontMatrix = readNumberArray(scanner, MAX_FONT_MATRIX_ENTRIES, 'FontMatrix');
      if (dict.fontMatrix.length !== MAX_FONT_MATRIX_ENTRIES) {
        throw new Type1FontError('FontMatrix must hold six numbers.');
      }
      seen.add(key);
    } else if (key === 'FontBBox') {
      dict.fontBBox = readNumberArray(scanner, FONT_BBOX_ENTRIES, 'FontBBox');
      if (dict.fontBBox.length !== FONT_BBOX_ENTRIES) {
        throw new Type1FontError('FontBBox must hold four numbers.');
      }
      seen.add(key);
    } else if (key === 'ItalicAngle' || key === 'UnderlinePosition' || key === 'UnderlineThickness' || key === 'FSType') {
      const value = scanner.next();
      if (isNumberToken(value)) {
        if (key === 'ItalicAngle') dict.italicAngle = value.value;
        else if (key === 'UnderlinePosition') dict.underlinePosition = value.value;
        else if (key === 'UnderlineThickness') dict.underlineThickness = value.value;
        else dict.fsType = value.value;
        seen.add(key);
      }
    } else if (key === 'isFixedPitch') {
      const value = scanner.next();
      if (value !== null && value.kind === 'name') {
        dict.isFixedPitch = value.text === 'true';
        seen.add(key);
      }
    } else if (key === 'FontType' || key === 'PaintType') {
      const value = scanner.next();
      const expected = key === 'FontType' ? FONT_TYPE_TYPE1 : PAINT_TYPE_FILL;
      if (isNumberToken(value) && value.value !== expected) {
        throw new Type1FontError(`Unsupported ${key} ${value.value}: only filled Type 1 outlines are supported.`);
      }
      seen.add(key);
    } else if (key === 'Encoding') {
      readEncoding(scanner, dict);
      seen.add(key);
    }
  }

  if (!dict.fontName) {
    throw new Type1FontError('Type 1 font dictionary has no /FontName.');
  }
  return dict;
}

// ---------------------------------------------------------------------------------------------
// Private dictionary: lenIV, Subrs, CharStrings
// ---------------------------------------------------------------------------------------------

interface PrivateData {
  lenIV: number;
  subrs: Array<Buffer | undefined>;
  charStrings: Array<{ name: string; data: Buffer }>;
}

function readSubrs(scanner: PsScanner, priv: PrivateData): void {
  const count = expectInt(scanner.next(), '/Subrs count');
  if (count < 0 || count > MAX_SUBRS) {
    throw new Type1FontError(`/Subrs count ${count} is outside 0..${MAX_SUBRS}.`);
  }
  priv.subrs = new Array<Buffer | undefined>(count).fill(undefined);
  let entries = 0;
  for (;;) {
    const token = scanner.next();
    if (token === null) throw new Type1FontError('/Subrs array is not terminated.');
    if (token.kind === 'literal') {
      scanner.pos = token.start;
      return;
    }
    if (token.kind !== 'name') continue;
    if (PS_SUBRS_TERMINATORS.has(token.text)) return;
    if (token.text !== 'dup') continue;
    const index = expectInt(scanner.next(), 'subroutine index');
    const length = expectInt(scanner.next(), 'subroutine length');
    const readOperator = scanner.next();
    if (readOperator === null || readOperator.kind !== 'name') {
      throw new Type1FontError('Subroutine entry has no RD operator.');
    }
    if (index < 0 || index >= count) {
      throw new Type1FontError(`Subroutine index ${index} is outside the declared /Subrs count ${count}.`);
    }
    entries++;
    if (entries > count) {
      throw new Type1FontError('More subroutine entries than declared in /Subrs.');
    }
    priv.subrs[index] = scanner.readBlob(length);
  }
}

function readCharStrings(scanner: PsScanner, priv: PrivateData): void {
  const declared = expectInt(scanner.next(), '/CharStrings count');
  if (declared <= 0 || declared > MAX_GLYPHS) {
    throw new Type1FontError(`/CharStrings count ${declared} is outside 1..${MAX_GLYPHS}.`);
  }
  for (let token = scanner.next(); ; token = scanner.next()) {
    if (token === null) throw new Type1FontError('/CharStrings dictionary has no "begin".');
    if (token.kind === 'name' && token.text === 'begin') break;
  }
  for (;;) {
    const token = scanner.next();
    if (token === null) throw new Type1FontError('/CharStrings dictionary is truncated before "end".');
    if (token.kind === 'name' && token.text === 'end') return;
    if (token.kind !== 'literal') continue;
    if (priv.charStrings.length >= declared) {
      throw new Type1FontError('More charstrings than declared in /CharStrings.');
    }
    const length = expectInt(scanner.next(), `length of charstring ${token.text}`);
    const readOperator = scanner.next();
    if (readOperator === null || readOperator.kind !== 'name') {
      throw new Type1FontError(`Charstring ${token.text} has no RD operator.`);
    }
    priv.charStrings.push({ name: token.text, data: scanner.readBlob(length) });
  }
}

function parsePrivate(decrypted: Buffer): PrivateData {
  const priv: PrivateData = { lenIV: DEFAULT_LEN_IV, subrs: [], charStrings: [] };
  const scanner = new PsScanner(decrypted);
  let sawSubrs = false;
  for (let token = scanner.next(); token !== null; token = scanner.next()) {
    if (token.kind !== 'literal') continue;
    if (token.text === 'lenIV') {
      const value = expectInt(scanner.next(), '/lenIV');
      if (value !== UNENCRYPTED_LEN_IV && (value < 0 || value > MAX_LEN_IV)) {
        throw new Type1FontError(`/lenIV ${value} is unsupported.`);
      }
      priv.lenIV = value;
    } else if (token.text === 'Subrs' && !sawSubrs) {
      sawSubrs = true;
      readSubrs(scanner, priv);
    } else if (token.text === 'CharStrings') {
      readCharStrings(scanner, priv);
      return priv;
    }
  }
  throw new Type1FontError('Private dictionary has no /CharStrings.');
}

function decryptCharString(data: Buffer, lenIV: number): Buffer {
  if (lenIV === UNENCRYPTED_LEN_IV) return data;
  if (data.length < lenIV) {
    throw new Type1FontError('Charstring is shorter than lenIV.');
  }
  return decryptType1(data, CHARSTRING_KEY, lenIV);
}

// ---------------------------------------------------------------------------------------------
// Standard encoding
// ---------------------------------------------------------------------------------------------

let standardEncodingCache: Map<number, string> | null = null;

function standardEncoding(): Map<number, string> {
  if (standardEncodingCache === null) {
    const map = new Map<number, string>();
    for (const line of ADOBE_STANDARD_ENCODING_ENTRIES) {
      for (const entry of line.split(' ')) {
        const split = entry.indexOf('=');
        map.set(Number.parseInt(entry.slice(0, split), 10), entry.slice(split + 1));
      }
    }
    standardEncodingCache = map;
  }
  return standardEncodingCache;
}

/** Glyph name at a StandardEncoding code, or undefined when the code is unassigned. */
export function standardEncodingName(code: number): string | undefined {
  return standardEncoding().get(code);
}

// ---------------------------------------------------------------------------------------------
// Charstring interpreter
// ---------------------------------------------------------------------------------------------

interface FlexState {
  active: boolean;
  points: Array<[number, number]>;
}

interface GlyphOutline {
  advance: number;
  sbx: number;
  commands: Type1PathCommand[];
}

class InterpreterBudget {
  steps = 0;
}

class CharStringRunner {
  private readonly stack: number[] = [];
  private readonly psStack: number[] = [];
  private readonly commands: Type1PathCommand[] = [];
  private readonly flex: FlexState = { active: false, points: [] };
  private x = 0;
  private y = 0;
  private sbx = 0;
  private advance = 0;
  private hasWidth = false;
  private subpathOpen = false;
  private ended = false;
  private glyphSteps = 0;

  constructor(
    private readonly glyphName: string,
    private readonly lookup: GlyphLookup,
    private readonly budget: InterpreterBudget,
    private readonly allowSeac: boolean
  ) {}

  private fail(message: string): never {
    throw new Type1FontError(`Glyph ${this.glyphName}: ${message}`);
  }

  run(code: Buffer): GlyphOutline {
    this.execute(code, 0);
    if (!this.ended) this.fail('charstring ended without endchar.');
    if (!this.hasWidth) this.fail('charstring has no hsbw or sbw.');
    return { advance: this.advance, sbx: this.sbx, commands: this.commands };
  }

  private push(value: number): void {
    if (this.stack.length >= MAX_STACK_DEPTH) this.fail('operand stack overflow.');
    this.stack.push(value);
  }

  private pop(): number {
    const value = this.stack.pop();
    if (value === undefined) this.fail('operand stack underflow.');
    return value;
  }

  /** Takes the top `count` operands in push order and clears the stack, as every path operator does. */
  private take(count: number): number[] {
    if (this.stack.length < count) this.fail(`operator needs ${count} operands, found ${this.stack.length}.`);
    const operands = this.stack.slice(this.stack.length - count);
    this.stack.length = 0;
    return operands;
  }

  private requireWidth(): void {
    if (!this.hasWidth) this.fail('path operator before hsbw.');
  }

  private ensureSubpath(): void {
    if (!this.subpathOpen) {
      this.commands.push({ type: 'move', x: this.x, y: this.y });
      this.subpathOpen = true;
    }
  }

  private closeSubpath(): void {
    if (this.subpathOpen) {
      this.commands.push({ type: 'close' });
      this.subpathOpen = false;
    }
  }

  private moveBy(dx: number, dy: number): void {
    this.requireWidth();
    this.x += dx;
    this.y += dy;
    if (this.flex.active) return;
    this.closeSubpath();
    this.commands.push({ type: 'move', x: this.x, y: this.y });
    this.subpathOpen = true;
  }

  private lineBy(dx: number, dy: number): void {
    this.requireWidth();
    this.ensureSubpath();
    this.x += dx;
    this.y += dy;
    this.commands.push({ type: 'line', x: this.x, y: this.y });
  }

  private curveBy(dx1: number, dy1: number, dx2: number, dy2: number, dx3: number, dy3: number): void {
    this.requireWidth();
    this.ensureSubpath();
    const x1 = this.x + dx1;
    const y1 = this.y + dy1;
    const x2 = x1 + dx2;
    const y2 = y1 + dy2;
    this.x = x2 + dx3;
    this.y = y2 + dy3;
    this.commands.push({ type: 'curve', x1, y1, x2, y2, x3: this.x, y3: this.y });
  }

  private tick(): void {
    this.glyphSteps++;
    this.budget.steps++;
    if (this.glyphSteps > MAX_STEPS_PER_GLYPH) this.fail('charstring exceeds the operation limit.');
    if (this.budget.steps > MAX_STEPS_PER_FONT) {
      throw new Type1FontError('Font charstrings exceed the total operation limit.');
    }
  }

  private execute(code: Buffer, depth: number): void {
    let i = 0;
    while (i < code.length) {
      this.tick();
      const byte = code[i++];
      if (byte >= NUM_FIRST) {
        i = this.readNumber(code, i, byte);
        continue;
      }
      if (byte === CMD_RETURN) {
        if (depth === 0) this.fail('return outside a subroutine.');
        return;
      }
      if (byte === CMD_CALLSUBR) {
        this.callSubr(depth);
        if (this.ended) return;
        continue;
      }
      if (byte === CMD_ESCAPE) {
        if (i >= code.length) this.fail('truncated escape operator.');
        this.escape(code[i++]);
        if (this.ended) return;
        continue;
      }
      this.simpleOperator(byte);
      if (this.ended) return;
    }
    if (depth > 0) this.fail('subroutine ended without return.');
  }

  private readNumber(code: Buffer, at: number, byte: number): number {
    let next = at;
    if (byte <= NUM_SMALL_MAX) {
      this.push(byte - NUM_SMALL_BIAS);
    } else if (byte <= NUM_POSITIVE_MAX) {
      if (next >= code.length) this.fail('truncated number.');
      this.push((byte - NUM_POSITIVE_BASE) * NUM_BYTE_RANGE + code[next++] + NUM_TWO_BYTE_BIAS);
    } else if (byte <= NUM_NEGATIVE_MAX) {
      if (next >= code.length) this.fail('truncated number.');
      this.push(-(byte - NUM_NEGATIVE_BASE) * NUM_BYTE_RANGE - code[next++] - NUM_TWO_BYTE_BIAS);
    } else {
      if (next + 4 > code.length) this.fail('truncated 32-bit number.');
      this.push(code.readInt32BE(next));
      next += 4;
    }
    return next;
  }

  private callSubr(depth: number): void {
    const index = this.pop();
    if (depth + 1 > MAX_SUBR_CALL_DEPTH) this.fail('subroutine nesting is too deep.');
    const subr = this.lookup.subr(index);
    if (subr === undefined) this.fail(`call to undefined subroutine ${index}.`);
    this.execute(subr, depth + 1);
  }

  private simpleOperator(op: number): void {
    switch (op) {
      case CMD_HSTEM:
      case CMD_VSTEM:
        this.take(2);
        break;
      case CMD_VMOVETO:
        this.moveBy(0, this.take(1)[0]);
        break;
      case CMD_RMOVETO: {
        const [dx, dy] = this.take(2);
        this.moveBy(dx, dy);
        break;
      }
      case CMD_HMOVETO:
        this.moveBy(this.take(1)[0], 0);
        break;
      case CMD_RLINETO: {
        const [dx, dy] = this.take(2);
        this.lineBy(dx, dy);
        break;
      }
      case CMD_HLINETO:
        this.lineBy(this.take(1)[0], 0);
        break;
      case CMD_VLINETO:
        this.lineBy(0, this.take(1)[0]);
        break;
      case CMD_RRCURVETO: {
        const [a, b, c, d, e, f] = this.take(6);
        this.curveBy(a, b, c, d, e, f);
        break;
      }
      case CMD_VHCURVETO: {
        const [dy1, dx2, dy2, dx3] = this.take(4);
        this.curveBy(0, dy1, dx2, dy2, dx3, 0);
        break;
      }
      case CMD_HVCURVETO: {
        const [dx1, dx2, dy2, dy3] = this.take(4);
        this.curveBy(dx1, 0, dx2, dy2, 0, dy3);
        break;
      }
      case CMD_CLOSEPATH:
        this.take(0);
        this.requireWidth();
        this.closeSubpath();
        break;
      case CMD_HSBW: {
        const [sbx, wx] = this.take(2);
        this.setSideBearing(sbx, 0, wx);
        break;
      }
      case CMD_ENDCHAR:
        this.take(0);
        this.requireWidth();
        this.closeSubpath();
        this.ended = true;
        break;
      default:
        this.fail(`unsupported charstring operator ${op}.`);
    }
  }

  private setSideBearing(sbx: number, sby: number, wx: number): void {
    if (this.hasWidth) this.fail('hsbw or sbw executed twice.');
    this.sbx = sbx;
    this.x = sbx;
    this.y = sby;
    this.advance = wx;
    this.hasWidth = true;
  }

  private escape(op: number): void {
    switch (op) {
      case ESC_DOTSECTION:
      case ESC_VSTEM3:
      case ESC_HSTEM3:
        this.stack.length = 0;
        break;
      case ESC_SBW: {
        const [sbx, sby, wx] = this.take(4);
        this.setSideBearing(sbx, sby, wx);
        break;
      }
      case ESC_DIV: {
        const divisor = this.pop();
        const dividend = this.pop();
        if (divisor === 0) this.fail('division by zero.');
        this.push(dividend / divisor);
        break;
      }
      case ESC_CALLOTHERSUBR:
        this.callOtherSubr();
        break;
      case ESC_POP: {
        const value = this.psStack.pop();
        if (value === undefined) this.fail('pop on an empty PostScript stack.');
        this.push(value);
        break;
      }
      case ESC_SETCURRENTPOINT: {
        const [nx, ny] = this.take(2);
        this.x = nx;
        this.y = ny;
        break;
      }
      case ESC_SEAC:
        this.seac();
        break;
      default:
        this.fail(`unsupported escape operator ${op}.`);
    }
  }

  private callOtherSubr(): void {
    const which = this.pop();
    const count = this.pop();
    if (!Number.isInteger(count) || count < 0 || count > this.stack.length) {
      this.fail('callothersubr has an invalid argument count.');
    }
    // The last argument leaves the Type 1 stack first.
    const args: number[] = [];
    for (let i = 0; i < count; i++) args.push(this.pop());

    switch (which) {
      case OTHERSUBR_FLEX_BEGIN:
        this.requireWidth();
        this.ensureSubpath();
        this.flex.active = true;
        this.flex.points = [];
        break;
      case OTHERSUBR_FLEX_POINT:
        if (!this.flex.active) this.fail('flex point outside a flex sequence.');
        if (this.flex.points.length >= FLEX_POINT_COUNT) this.fail('flex sequence has too many points.');
        this.flex.points.push([this.x, this.y]);
        break;
      case OTHERSUBR_FLEX_END:
        this.endFlex(args);
        break;
      case OTHERSUBR_HINT_REPLACEMENT:
        if (count !== 1) this.fail('hint replacement needs one argument.');
        this.psStack.push(args[0]);
        break;
      case OTHERSUBR_COUNTER_CONTROL_A:
      case OTHERSUBR_COUNTER_CONTROL_B:
        break;
      default:
        this.fail(`unsupported OtherSubrs entry ${which}.`);
    }
    if (this.psStack.length > MAX_PS_STACK_DEPTH) this.fail('PostScript stack overflow.');
  }

  private endFlex(args: number[]): void {
    if (args.length !== FLEX_END_ARGUMENT_COUNT) this.fail('flex end needs three arguments.');
    if (!this.flex.active || this.flex.points.length !== FLEX_POINT_COUNT) {
      this.fail('flex sequence does not hold seven points.');
    }
    const [, p1, p2, p3, p4, p5, p6] = this.flex.points;
    this.commands.push({ type: 'curve', x1: p1[0], y1: p1[1], x2: p2[0], y2: p2[1], x3: p3[0], y3: p3[1] });
    this.commands.push({ type: 'curve', x1: p4[0], y1: p4[1], x2: p5[0], y2: p5[1], x3: p6[0], y3: p6[1] });
    this.x = p6[0];
    this.y = p6[1];
    this.flex.active = false;
    this.flex.points = [];
    // args are [y, x, flexHeight]; the PostScript stack must yield x then y on the two pops.
    this.psStack.push(args[0], args[1]);
  }

  private seac(): void {
    if (!this.allowSeac) this.fail('nested seac composites are not allowed.');
    this.requireWidth();
    const [asb, adx, ady, bchar, achar] = this.take(SEAC_ARGUMENT_COUNT);
    const baseName = Number.isInteger(bchar) ? standardEncodingName(bchar) : undefined;
    const accentName = Number.isInteger(achar) ? standardEncodingName(achar) : undefined;
    if (baseName === undefined || accentName === undefined) {
      this.fail('seac references a character code outside StandardEncoding.');
    }
    const base = this.lookup.component(baseName, this.budget);
    const accent = this.lookup.component(accentName, this.budget);
    const offsetX = this.sbx + adx - asb;
    this.closeSubpath();
    this.commands.push(...base.commands);
    for (const command of accent.commands) {
      this.commands.push(translateCommand(command, offsetX, ady));
    }
    this.ended = true;
  }
}

function translateCommand(command: Type1PathCommand, dx: number, dy: number): Type1PathCommand {
  switch (command.type) {
    case 'move':
    case 'line':
      return { type: command.type, x: command.x + dx, y: command.y + dy };
    case 'curve':
      return {
        type: 'curve',
        x1: command.x1 + dx,
        y1: command.y1 + dy,
        x2: command.x2 + dx,
        y2: command.y2 + dy,
        x3: command.x3 + dx,
        y3: command.y3 + dy,
      };
    default:
      return command;
  }
}

class GlyphLookup {
  private readonly byName = new Map<string, Buffer>();
  private readonly subrCache = new Map<number, Buffer>();

  constructor(
    private readonly priv: PrivateData,
    glyphs: Array<{ name: string; data: Buffer }>
  ) {
    for (const glyph of glyphs) this.byName.set(glyph.name, glyph.data);
  }

  subr(index: number): Buffer | undefined {
    if (!Number.isInteger(index) || index < 0 || index >= this.priv.subrs.length) return undefined;
    const cached = this.subrCache.get(index);
    if (cached !== undefined) return cached;
    const raw = this.priv.subrs[index];
    if (raw === undefined) return undefined;
    const decrypted = decryptCharString(raw, this.priv.lenIV);
    this.subrCache.set(index, decrypted);
    return decrypted;
  }

  component(name: string, budget: InterpreterBudget): GlyphOutline {
    const code = this.byName.get(name);
    if (code === undefined) {
      throw new Type1FontError(`seac references missing glyph ${name}.`);
    }
    return new CharStringRunner(name, this, budget, false).run(code);
  }

  interpret(name: string, budget: InterpreterBudget): GlyphOutline {
    const code = this.byName.get(name);
    if (code === undefined) throw new Type1FontError(`Missing glyph ${name}.`);
    return new CharStringRunner(name, this, budget, true).run(code);
  }
}

// ---------------------------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------------------------

/**
 * Parses a PFA or PFB Type 1 font. Throws Type1FontError for any structural problem.
 */
export function parseType1Font(buffer: Buffer): Type1Font {
  const { cleartext, encrypted } = splitContainer(buffer);
  const dict = parseCleartext(cleartext);
  const decrypted = decryptType1(encrypted, EEXEC_KEY, EEXEC_LEAD_BYTES);
  const priv = parsePrivate(decrypted);

  const seenNames = new Set<string>();
  const glyphData: Array<{ name: string; data: Buffer }> = [];
  for (const entry of priv.charStrings) {
    if (entry.name.length > MAX_GLYPH_NAME_LENGTH || !GLYPH_NAME_PATTERN.test(entry.name)) {
      throw new Type1FontError(`Invalid glyph name "${entry.name.slice(0, MAX_GLYPH_NAME_LENGTH)}".`);
    }
    if (seenNames.has(entry.name)) {
      throw new Type1FontError(`Duplicate glyph name ${entry.name}.`);
    }
    seenNames.add(entry.name);
    glyphData.push({ name: entry.name, data: decryptCharString(entry.data, priv.lenIV) });
  }

  const lookup = new GlyphLookup(priv, glyphData);
  const budget = new InterpreterBudget();
  const glyphs: Type1Glyph[] = [];
  for (const entry of glyphData) {
    const outline = lookup.interpret(entry.name, budget);
    glyphs.push({ name: entry.name, advance: outline.advance, commands: outline.commands });
  }

  const notdefIndex = glyphs.findIndex((g) => g.name === NOTDEF_GLYPH_NAME);
  if (notdefIndex > 0) {
    const [notdef] = glyphs.splice(notdefIndex, 1);
    glyphs.unshift(notdef);
  } else if (notdefIndex < 0) {
    // Required by the font file formats; an empty .notdef carries no outline.
    glyphs.unshift({ name: NOTDEF_GLYPH_NAME, advance: 0, commands: [] });
  }

  const encoding = dict.encodingKind === 'standard' ? new Map(standardEncoding()) : dict.encoding;

  return {
    fontName: dict.fontName,
    familyName: dict.familyName,
    fullName: dict.fullName,
    weight: dict.weight,
    version: dict.version,
    notice: dict.notice,
    fontMatrix: dict.fontMatrix,
    fontBBox: dict.fontBBox,
    italicAngle: dict.italicAngle,
    isFixedPitch: dict.isFixedPitch,
    underlinePosition: dict.underlinePosition,
    underlineThickness: dict.underlineThickness,
    fsType: dict.fsType,
    encoding,
    glyphs,
  };
}
