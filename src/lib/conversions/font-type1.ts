import { CorruptStreamError, PayloadLimitError, UnprocessableFontInputError } from '../types';

/**
 * Reader of PostScript Type 1 fonts (PFA and PFB), written from Adobe's "Adobe Type 1 Font Format" (chapter 7: the eexec encryption and the
 * private dictionary) and Adobe Technical Note 5040 (the PFB segments). It does not decode a glyph. It checks that a file is a Type 1 font
 * that holds glyphs, counts them, and rewrites the file as the one spelling FontForge reads in full: a PFB whose text has LF line endings
 * and whose encrypted part is a single binary segment. FontForge reads a private dictionary written with CR LF line endings as a font
 * without glyphs and exits with success; the rewrite removes that failure, and the glyph count lets the caller see any other loss.
 */

const PFB_MARKER = 0x80;
const PFB_ASCII = 1;
const PFB_BINARY = 2;
const PFB_END = 3;
const PFB_HEADER_BYTES = 6;
const EEXEC_KEY = 55665;
const EEXEC_LEADING_BYTES = 4;
const CIPHER_C1 = 52845;
const CIPHER_C2 = 22719;
const HEX_DIGITS_THAT_DECIDE = 4;
/** Zeros of the trailer, as 64 per line, which the PFB trailer segment ends with `cleartomark`. */
const TRAILER_ZERO_LINES = 8;
const TRAILER_ZEROS_PER_LINE = 64;
const FONT_SIGNATURES = ['%!PS-AdobeFont', '%!FontType1'];
const PRIVATE_DICTIONARY_END = 'closefile';
const CHARSTRINGS_NAME = '/CharStrings';
const MAX_PROCEDURE_NAME_CHARS = 32;
const MAX_CHARSTRING_DIGITS = 9;
const EEXEC = 'eexec';
/**
 * Limits that keep a crafted file from costing more than a real font does. The largest Type 1 fonts are a few MB (Latin faces are 30 to
 * 150 KB, the URW set 134 KB at most; a Type 1 CJK face with 20,000 glyphs is under 10 MB as PFA hex, half of that as PFB), so 16 MiB leaves
 * a wide margin. A font holds at most 65,535 glyphs and as many subroutines, so no more charstring entries than that sum are read. A PFB has
 * three segments in practice (Adobe splits long runs at 64 KB, 256 segments for 16 MiB); 4,096 leaves room, and an empty segment costs
 * six bytes of file, so the count is capped rather than left to the size.
 */
export const MAX_TYPE1_FILE_BYTES = 16 * 1024 * 1024;
export const MAX_TYPE1_CHARSTRING_ENTRIES = 2 * 65_536;
export const MAX_PFB_SEGMENTS = 4096;
/** The operator that starts the encrypted part: `currentfile eexec`, so the word in a comment or a font name is not taken for it. */
const EEXEC_OPERATOR = /currentfile\s+eexec/;

/** A Type 1 font that has been read: the glyphs it holds and the file to hand to FontForge. */
export interface Type1Font {
  /** The entries of the CharStrings dictionary: every glyph the font draws, `.notdef` included. */
  glyphCount: number;
  /** The font as a PFB with LF line endings and one binary segment. */
  fontFile: Buffer;
}

/** True for the source formats this reader handles. */
export function isType1Format(format: string): boolean {
  return format === 'pfa' || format === 'pfb';
}

function isWhitespace(byte: number): boolean {
  return byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d || byte === 0x0c || byte === 0x00;
}

function isHexDigit(byte: number): boolean {
  return (byte >= 0x30 && byte <= 0x39) || (byte >= 0x41 && byte <= 0x46) || (byte >= 0x61 && byte <= 0x66);
}

function startsWithFontSignature(text: Buffer): boolean {
  return FONT_SIGNATURES.some((signature) => text.toString('latin1', 0, signature.length) === signature);
}

/** The clear text and the encrypted run of a file, as it stores them. */
interface Type1Parts {
  clearText: string;
  cipher: Buffer;
}

/** The segments of a PFB file: the text up to `eexec`, and the binary segments joined. Anything else in a segment is a damaged container. */
function splitPfb(file: Buffer): Type1Parts {
  const text: Buffer[] = [];
  const binary: Buffer[] = [];
  let at = 0;
  let segments = 0;
  for (;;) {
    if (at + 2 > file.length || file[at] !== PFB_MARKER) {
      throw new CorruptStreamError('The PFB file is damaged: a segment does not start with the 0x80 marker, or the end marker is missing.');
    }
    const type = file[at + 1];
    if (type === PFB_END) break;
    if (++segments > MAX_PFB_SEGMENTS) {
      throw new PayloadLimitError(`The PFB file has more than the ${MAX_PFB_SEGMENTS} segments the converter reads.`);
    }
    if (type !== PFB_ASCII && type !== PFB_BINARY) {
      throw new CorruptStreamError(`The PFB file is damaged: a segment has the unknown type ${type}.`);
    }
    if (at + PFB_HEADER_BYTES > file.length) {
      throw new CorruptStreamError('The PFB file is damaged: a segment header is cut short.');
    }
    const length = file.readUInt32LE(at + 2);
    const end = at + PFB_HEADER_BYTES + length;
    if (end > file.length) {
      throw new CorruptStreamError('The PFB file is damaged: a segment is longer than the file.');
    }
    const data = file.subarray(at + PFB_HEADER_BYTES, end);
    // Text after the first binary segment is the trailer (zeros and cleartomark): nothing in it is needed.
    if (type === PFB_BINARY) binary.push(data);
    else if (binary.length === 0) text.push(data);
    at = end;
  }
  const clearText = Buffer.concat(text);
  if (!startsWithFontSignature(clearText)) {
    throw new CorruptStreamError('The file is not a PostScript Type 1 font: its first PFB segment does not start with %!PS-AdobeFont or %!FontType1.');
  }
  if (binary.length === 0) {
    throw new CorruptStreamError('The PFB file holds no encrypted segment, so it has no glyphs to convert.');
  }
  return { clearText: clearText.toString('latin1'), cipher: Buffer.concat(binary) };
}

/** The hexadecimal digits of a PFA's encrypted run, ignoring white space, up to the first character that is neither. */
function decodeHexRun(data: Buffer): Buffer {
  const bytes = Buffer.alloc(data.length >> 1);
  let length = 0;
  let high = -1;
  for (const character of data) {
    if (isWhitespace(character)) continue;
    if (!isHexDigit(character)) break;
    const digit = Number.parseInt(String.fromCharCode(character), 16);
    if (high < 0) {
      high = digit;
    } else {
      bytes[length++] = high * 16 + digit;
      high = -1;
    }
  }
  return bytes.subarray(0, length);
}

/** The clear text up to `eexec` and the encrypted run after it, which is hexadecimal when its first four characters are hexadecimal digits. */
function splitPfa(file: Buffer): Type1Parts {
  const text = file.toString('latin1');
  const eexec = EEXEC_OPERATOR.exec(text);
  if (eexec === null) {
    throw new CorruptStreamError('The file is not a complete PostScript Type 1 font: it has no eexec section, so it has no glyphs to convert.');
  }
  const clearEnd = eexec.index + eexec[0].length;
  let start = clearEnd;
  while (start < file.length && isWhitespace(file[start])) start++;
  const leading = file.subarray(start, start + HEX_DIGITS_THAT_DECIDE);
  const isHex = leading.length === HEX_DIGITS_THAT_DECIDE && leading.every(isHexDigit);
  const run = file.subarray(start);
  return { clearText: text.slice(0, clearEnd), cipher: isHex ? decodeHexRun(run) : run };
}

/** One step of the eexec and charstring ciphers: Adobe's recurrence, with the key and the two constants. */
function eexecCipher(data: Buffer, mode: 'decrypt' | 'encrypt'): Buffer {
  const out = Buffer.alloc(data.length);
  let r = EEXEC_KEY;
  for (let index = 0; index < data.length; index++) {
    const input = data[index];
    const output = input ^ (r >> 8);
    out[index] = output;
    const cipherByte = mode === 'decrypt' ? input : output;
    r = ((cipherByte + r) * CIPHER_C1 + CIPHER_C2) & 0xffff;
  }
  return out;
}

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The pieces of a private dictionary: text, and the binary data of the charstrings that the text announces with their length. */
interface PrivatePiece {
  binary: boolean;
  data: Buffer;
}

/** What the scan of a private dictionary found. */
interface PrivateScan {
  pieces: PrivatePiece[];
  glyphCount: number;
}

const READ_PROCEDURE = new RegExp(`/(\\S{1,${MAX_PROCEDURE_NAME_CHARS}})\\s*\\{\\s*string\\s+currentfile\\s+exch\\s+readstring\\s+pop\\s*\\}`);

/**
 * Walks the private dictionary: the text between the binary data of Subrs and CharStrings entries (`dup 3 15 RD <15 bytes>` and
 * `/A 40 RD <40 bytes>`, with `RD` whatever name the font gives its read procedure) is kept as text, and the data is kept apart so that
 * no line ending inside it is ever touched. The dictionary ends at `closefile`; what the cipher decrypts to after that is not part of it.
 */
function scanPrivateDictionary(plain: Buffer): PrivateScan {
  const text = plain.toString('latin1');
  const read = READ_PROCEDURE.exec(text);
  if (read === null) {
    throw new UnprocessableFontInputError('The Type 1 font defines no procedure that reads a charstring, so its glyphs cannot be located.');
  }
  const entry = new RegExp(`(\\d{1,${MAX_CHARSTRING_DIGITS}})\\s+${escapeForRegExp(read[1])} `, 'g');
  const charStringsAt = text.indexOf(CHARSTRINGS_NAME);
  const pieces: PrivatePiece[] = [];
  let glyphCount = 0;
  let charstringEntries = 0;
  let position = 0;
  let endAt = text.indexOf(PRIVATE_DICTIONARY_END);
  for (;;) {
    entry.lastIndex = position;
    const next = entry.exec(text);
    // The end is searched again only after a charstring has swallowed the place where it was found: the scan stays linear.
    if (endAt >= 0 && endAt < position) endAt = text.indexOf(PRIVATE_DICTIONARY_END, position);
    if (endAt >= 0 && (next === null || endAt < next.index)) {
      pieces.push({ binary: false, data: plain.subarray(position, endAt + PRIVATE_DICTIONARY_END.length) });
      break;
    }
    if (next === null) {
      throw new UnprocessableFontInputError('The Type 1 font is cut short: its private dictionary does not end with closefile.');
    }
    if (++charstringEntries > MAX_TYPE1_CHARSTRING_ENTRIES) {
      throw new PayloadLimitError(`The Type 1 font has more than the ${MAX_TYPE1_CHARSTRING_ENTRIES} charstrings (glyphs and subroutines) a font can hold.`);
    }
    const dataStart = next.index + next[0].length;
    const dataEnd = dataStart + Number(next[1]);
    if (dataEnd > plain.length) {
      throw new UnprocessableFontInputError('The Type 1 font is cut short: a charstring runs past the end of its private dictionary.');
    }
    pieces.push({ binary: false, data: plain.subarray(position, dataStart) });
    pieces.push({ binary: true, data: plain.subarray(dataStart, dataEnd) });
    if (charStringsAt >= 0 && next.index > charStringsAt) glyphCount++;
    position = dataEnd;
  }
  if (charStringsAt < 0 || glyphCount === 0) {
    throw new UnprocessableFontInputError('The Type 1 font has no CharStrings dictionary with glyphs in it.');
  }
  return { pieces, glyphCount };
}

/** Text with CR LF and CR written as LF: the same white space to PostScript, and the one FontForge reads in every position. */
function withLineFeeds(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}

function segment(type: number, body: Buffer): Buffer {
  const header = Buffer.alloc(PFB_HEADER_BYTES);
  header[0] = PFB_MARKER;
  header[1] = type;
  header.writeUInt32LE(body.length, 2);
  return Buffer.concat([header, body]);
}

function pfbTrailer(): Buffer {
  const zeros = `${'0'.repeat(TRAILER_ZEROS_PER_LINE)}\n`.repeat(TRAILER_ZERO_LINES);
  return Buffer.from(`${zeros}cleartomark\n`, 'latin1');
}

/**
 * Checks that `file` (a PFA or a PFB, told apart by what it starts with, not by its name) is a Type 1 font that holds glyphs, and
 * rewrites it for FontForge. A file that is not a complete Type 1 container is a `CorruptStreamError` (HTTP 400); a container that is
 * intact but holds no usable font is an `UnprocessableFontInputError` (HTTP 422) that says why.
 */
export function readType1Font(file: Buffer): Type1Font {
  if (file.length > MAX_TYPE1_FILE_BYTES) {
    throw new PayloadLimitError(`The Type 1 font is ${file.length} bytes; the converter reads at most ${MAX_TYPE1_FILE_BYTES} bytes (16 MiB).`);
  }
  let parts: Type1Parts;
  if (file[0] === PFB_MARKER) {
    parts = splitPfb(file);
  } else if (startsWithFontSignature(file)) {
    parts = splitPfa(file);
  } else {
    throw new CorruptStreamError('The file is not a PostScript Type 1 font: it starts with neither %!PS-AdobeFont, %!FontType1 nor the PFB segment marker.');
  }
  if (!parts.clearText.trimEnd().endsWith(EEXEC)) {
    throw new CorruptStreamError('The PostScript Type 1 font is damaged: its clear text does not end with eexec.');
  }
  const decrypted = eexecCipher(parts.cipher, 'decrypt');
  const leading = decrypted.subarray(0, EEXEC_LEADING_BYTES);
  const scan = scanPrivateDictionary(decrypted.subarray(EEXEC_LEADING_BYTES));
  const rewritten = Buffer.concat([
    leading,
    ...scan.pieces.map((piece) => (piece.binary ? piece.data : Buffer.from(withLineFeeds(piece.data.toString('latin1')), 'latin1'))),
    Buffer.from('\n'),
  ]);
  const clearText = Buffer.from(`${withLineFeeds(parts.clearText).trimEnd()}\n`, 'latin1');
  return {
    glyphCount: scan.glyphCount,
    fontFile: Buffer.concat([segment(PFB_ASCII, clearText), segment(PFB_BINARY, eexecCipher(rewritten, 'encrypt')), segment(PFB_ASCII, pfbTrailer()), Buffer.from([PFB_MARKER, PFB_END])]),
  };
}
