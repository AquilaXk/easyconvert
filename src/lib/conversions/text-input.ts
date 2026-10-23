import fs from 'node:fs';
import chardet from 'chardet';
import { ConversionFailedError } from '../types';
import { reportConversionWarning } from './conversion-warnings';
import { LEGACY_TABLES, MIN_LEGACY_EVIDENCE_CHARS, createTableDecoder } from './legacy-tables';
import { decodeWindows1252 } from './office/windows-1252';

/**
 * Decoding of plain-text input. A byte order mark names UTF-8 or UTF-16 and a file that declares one is decoded strictly.
 * A file without one is UTF-8 when its bytes are valid UTF-8 (a pattern legacy text hardly ever matches) and otherwise
 * legacy text: bytes that libmagic would not take for text are refused, the ICU character set detector (`chardet`) names the
 * encoding, and Windows-1252, the default of the WHATWG Encoding Standard, is read when it finds none. The conversion is told
 * which encoding was read.
 */

export type TextInputEncoding = 'utf-8' | 'utf-16le' | 'utf-16be';

const UTF16LE_BOM = [0xff, 0xfe] as const;
const UTF16BE_BOM = [0xfe, 0xff] as const;
const UTF8_BOM = [0xef, 0xbb, 0xbf] as const;

/** Bytes examined to tell legacy text from binary data and to detect its encoding (FILE_ENCODING_MAX of libmagic's file.h). */
export const TEXT_DETECTION_BYTES = 64 * 1024;
const FIRST_NON_ASCII_BYTE = 0x80;
/** Context kept in front of the first non-ASCII byte, as chardetng feeds its detector from two bytes before it. */
const LEADING_CONTEXT_BYTES = 2;
/** ICU gives a multi-byte candidate 10 when the bytes "are not incompatible with our encoding" and nothing more (csrmbcs.cpp). */
const ICU_NO_EVIDENCE_CONFIDENCE = 10;
const WINDOWS_1252 = 'windows-1252';

/** Control bytes that libmagic's `text_chars` table lets plain text hold: BEL to SI, SUB and ESC. */
const TEXT_CONTROL_BYTES: ReadonlySet<number> = new Set([0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f, 0x1a, 0x1b]);
const DELETE_BYTE = 0x7f;
const FIRST_PRINTABLE_ASCII_BYTE = 0x20;

/** Text that a BOM declares as Unicode, or the bytes of a decoder that rejects them. */
export class InvalidUnicodeTextError extends ConversionFailedError {
  constructor(encoding: TextInputEncoding) {
    super(`Text input is not valid ${encoding.toUpperCase()}; save it as UTF-8 (or UTF-16 with a byte order mark) and convert again`);
    this.name = 'InvalidUnicodeTextError';
  }
}

function startsWith(head: Uint8Array, signature: readonly number[]): boolean {
  return head.length >= signature.length && signature.every((byte, index) => head[index] === byte);
}

/** The encoding a text file declares through its byte order mark; UTF-8 when it has none. */
export function detectTextInputEncoding(head: Uint8Array): TextInputEncoding {
  if (startsWith(head, UTF16LE_BOM)) return 'utf-16le';
  if (startsWith(head, UTF16BE_BOM)) return 'utf-16be';
  return 'utf-8';
}

/**
 * A fatal decoder for text that starts with `head`; the byte order mark is consumed. Decode chunks
 * with `{ stream: true }` and finish with an empty call; invalid bytes throw InvalidUnicodeTextError.
 */
export function createTextInputDecoder(head: Uint8Array): (chunk?: Uint8Array) => string {
  const encoding = detectTextInputEncoding(head);
  const decoder = new TextDecoder(encoding, { fatal: true });
  return (chunk?: Uint8Array): string => {
    try {
      return chunk ? decoder.decode(chunk, { stream: true }) : decoder.decode();
    } catch {
      throw new InvalidUnicodeTextError(encoding);
    }
  };
}

function hasByteOrderMark(buffer: Uint8Array): boolean {
  return detectTextInputEncoding(buffer) !== 'utf-8' || startsWith(buffer, UTF8_BOM);
}

/** The bytes the detector reads: from just before the first non-ASCII byte, as chardetng does, for at most TEXT_DETECTION_BYTES. */
function detectionWindowAround(firstNonAscii: number, length: number): { start: number; end: number } {
  const start = Math.max(0, firstNonAscii - LEADING_CONTEXT_BYTES);
  return { start, end: Math.min(length, start + TEXT_DETECTION_BYTES) };
}

function detectionWindow(buffer: Uint8Array): { start: number; end: number } {
  const firstNonAscii = buffer.findIndex((byte) => byte >= FIRST_NON_ASCII_BYTE);
  return detectionWindowAround(firstNonAscii < 0 ? buffer.length : firstNonAscii, buffer.length);
}

/**
 * Refuses bytes that libmagic's `text_chars` table says never occur in text: C0 controls other than TEXT_CONTROL_BYTES, and DEL.
 * `firstOffset` is the offset of `bytes` in the file, which the message names.
 */
function assertLooksLikeText(bytes: Uint8Array, firstOffset = 0): void {
  const offset = bytes.findIndex((byte) => (byte < FIRST_PRINTABLE_ASCII_BYTE && !TEXT_CONTROL_BYTES.has(byte)) || byte === DELETE_BYTE);
  if (offset >= 0) {
    const hex = bytes[offset].toString(16).padStart(2, '0');
    throw new ConversionFailedError(`The input is not text: the byte 0x${hex} at offset ${firstOffset + offset} is a control character that text does not use`);
  }
}

/** The WHATWG name of a detector's label, or null for one the standard does not decode (UTF-32, ISO-2022-KR and ISO-2022-CN). */
function standardEncodingName(label: string): string | null {
  try {
    const name = new TextDecoder(label).encoding;
    return name === 'replacement' ? null : name;
  } catch {
    return null;
  }
}

/** The encoding the detector finds in `sample`; Windows-1252 when it finds none, or the sample holds too little non-ASCII text to tell. */
function detectLegacyEncoding(sample: Uint8Array): string {
  if (sample.filter((byte) => byte >= FIRST_NON_ASCII_BYTE).length < MIN_LEGACY_EVIDENCE_CHARS) return WINDOWS_1252;
  const [best] = chardet.analyse(sample);
  if (best === undefined || best.confidence <= ICU_NO_EVIDENCE_CONFIDENCE) return WINDOWS_1252;
  return standardEncodingName(best.name) ?? WINDOWS_1252;
}

/**
 * A decoder for chunks of text in `encoding`: a call with bytes gives their text and a call with none ends the text; a result is
 * null when the bytes are not valid in the encoding. Windows-1252 decodes every byte, as the standard does.
 */
type LegacyDecoder = (chunk?: Uint8Array) => string | null;

function createLegacyDecoder(encoding: string): LegacyDecoder {
  if (encoding === WINDOWS_1252) return (chunk) => (chunk ? decodeWindows1252(chunk) : '');
  const table = LEGACY_TABLES.get(encoding);
  if (table !== undefined) return createTableDecoder(table);
  let decoder: TextDecoder;
  try {
    decoder = new TextDecoder(encoding, { fatal: true });
  } catch {
    return () => null;
  }
  return (chunk) => {
    try {
      return chunk ? decoder.decode(chunk, { stream: true }) : decoder.decode();
    } catch {
      return null;
    }
  };
}

/** `bytes` read as `encoding`, or null when they are not valid in it. */
function decodeAs(bytes: Uint8Array, encoding: string): string | null {
  const decode = createLegacyDecoder(encoding);
  const text = decode(bytes);
  const rest = decode();
  return text === null || rest === null ? null : text + rest;
}

function decodeLegacyText(buffer: Uint8Array): string {
  const { start, end } = detectionWindow(buffer);
  assertLooksLikeText(buffer.subarray(0, end));
  const detected = detectLegacyEncoding(buffer.subarray(start, end));
  const decoded = decodeAs(buffer, detected);
  const encoding = decoded === null ? WINDOWS_1252 : detected;
  reportConversionWarning(`Text input is not valid UTF-8; it was read as ${encoding}.`);
  return decoded ?? decodeWindows1252(buffer);
}

/**
 * Decodes a whole text file: Unicode as its byte order mark or its valid UTF-8 says, legacy text as described above. Throws
 * ConversionFailedError for a Unicode declaration the bytes break and for bytes that are not text.
 */
export function decodeTextInput(buffer: Buffer): string {
  const decode = createTextInputDecoder(buffer);
  try {
    return decode(buffer) + decode();
  } catch (error) {
    if (!(error instanceof InvalidUnicodeTextError) || hasByteOrderMark(buffer)) throw error;
  }
  return decodeLegacyText(buffer);
}

/** Calls `visit` with each chunk of `chunkBytes` of the file, in order, until it returns false. */
function visitChunks(fd: number, chunkBytes: number, visit: (bytes: Uint8Array, offset: number) => boolean | void): void {
  const chunk = Buffer.alloc(chunkBytes);
  let offset = 0;
  for (;;) {
    const bytesRead = fs.readSync(fd, chunk, 0, chunk.length, offset);
    if (bytesRead === 0 || visit(chunk.subarray(0, bytesRead), offset) === false) return;
    offset += bytesRead;
  }
}

function addCodePoints(seen: Set<number>, text: string): void {
  for (const ch of text) seen.add(ch.codePointAt(0) as number);
}

function joinCodePoints(seen: ReadonlySet<number>): string {
  let text = '';
  for (const codePoint of seen) text += String.fromCodePoint(codePoint);
  return text;
}

/** The characters of a Unicode text file, read and strictly decoded in chunks, whatever the size. */
function distinctCharactersOfUnicodeFile(filePath: string, chunkBytes: number): string {
  const seen = new Set<number>();
  const fd = fs.openSync(filePath, 'r');
  try {
    let decode: ((chunk?: Uint8Array) => string) | undefined;
    visitChunks(fd, chunkBytes, (bytes) => {
      decode ??= createTextInputDecoder(bytes);
      addCodePoints(seen, decode(bytes));
    });
    if (decode !== undefined) addCodePoints(seen, decode());
  } finally {
    fs.closeSync(fd);
  }
  return joinCodePoints(seen);
}

/** The sample the detector reads, found without holding the file: the same window as detectionWindow gives for its bytes. */
function legacyDetectionWindow(fd: number, size: number, chunkBytes: number): { start: number; end: number } {
  let firstNonAscii = size;
  visitChunks(fd, chunkBytes, (bytes, offset) => {
    const index = bytes.findIndex((byte) => byte >= FIRST_NON_ASCII_BYTE);
    if (index < 0) return true;
    firstNonAscii = offset + index;
    return false;
  });
  return detectionWindowAround(firstNonAscii, size);
}

function assertFileLooksLikeText(fd: number, end: number, chunkBytes: number): void {
  visitChunks(fd, chunkBytes, (bytes, offset) => {
    assertLooksLikeText(bytes.subarray(0, end - offset), offset);
    return offset + bytes.length < end;
  });
}

/** The distinct characters of the file read as `encoding`, in chunks; `valid` is false from the first chunk the encoding rejects. */
function scanLegacyFile(fd: number, chunkBytes: number, encoding: string): { seen: Set<number>; valid: boolean } {
  const seen = new Set<number>();
  const decode = createLegacyDecoder(encoding);
  let valid = true;
  visitChunks(fd, chunkBytes, (bytes) => {
    const text = decode(bytes);
    valid = text !== null;
    if (text !== null) addCodePoints(seen, text);
    return valid;
  });
  const rest = valid ? decode() : null;
  if (rest !== null) addCodePoints(seen, rest);
  return { seen, valid: valid && rest !== null };
}

/**
 * The characters of a file that is not valid Unicode, read as decodeLegacyText reads its bytes: the encoding comes from the same
 * sample and the same rules, and the file is read in chunks twice at most (once more as Windows-1252 when it is not valid in
 * the detected encoding), so the result and the warning are those of the whole read.
 */
function distinctCharactersOfLegacyFile(filePath: string, chunkBytes: number): string {
  const fd = fs.openSync(filePath, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const { start, end } = legacyDetectionWindow(fd, size, chunkBytes);
    assertFileLooksLikeText(fd, end, chunkBytes);
    const sample = Buffer.alloc(end - start);
    fs.readSync(fd, sample, 0, sample.length, start);
    const detected = detectLegacyEncoding(sample);
    let encoding = detected;
    let scan = scanLegacyFile(fd, chunkBytes, detected);
    if (!scan.valid) {
      encoding = WINDOWS_1252;
      scan = scanLegacyFile(fd, chunkBytes, WINDOWS_1252);
    }
    reportConversionWarning(`Text input is not valid UTF-8; it was read as ${encoding}.`);
    return joinCodePoints(scan.seen);
  } finally {
    fs.closeSync(fd);
  }
}

function fileHasByteOrderMark(filePath: string): boolean {
  const fd = fs.openSync(filePath, 'r');
  try {
    const head = Buffer.alloc(UTF8_BOM.length);
    return hasByteOrderMark(head.subarray(0, fs.readSync(fd, head, 0, head.length, 0)));
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * The characters of a text file, for deciding how it is drawn. The file is read in chunks of `chunkBytes`, whatever its size, and
 * gives its distinct characters, in the encoding the conversion reads it in (decodeTextInput): Unicode as its byte order mark or
 * its valid UTF-8 says, otherwise legacy text, so both see the same encoding.
 */
export function readTextFileCharacters(filePath: string, chunkBytes: number): string {
  try {
    return distinctCharactersOfUnicodeFile(filePath, chunkBytes);
  } catch (error) {
    if (!(error instanceof InvalidUnicodeTextError) || fileHasByteOrderMark(filePath)) throw error;
  }
  return distinctCharactersOfLegacyFile(filePath, chunkBytes);
}
