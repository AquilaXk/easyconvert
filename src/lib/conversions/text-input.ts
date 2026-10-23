import fs from 'node:fs';
import chardet from 'chardet';
import { ConversionFailedError } from '../types';
import { reportConversionWarning } from './conversion-warnings';
import { LEGACY_TABLES, MIN_LEGACY_EVIDENCE_CHARS, decodeWithTable } from './legacy-tables';
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
function detectionWindow(buffer: Uint8Array): { start: number; end: number } {
  let firstNonAscii = buffer.findIndex((byte) => byte >= FIRST_NON_ASCII_BYTE);
  if (firstNonAscii < 0) firstNonAscii = buffer.length;
  const start = Math.max(0, firstNonAscii - LEADING_CONTEXT_BYTES);
  return { start, end: Math.min(buffer.length, start + TEXT_DETECTION_BYTES) };
}

/** Refuses bytes that libmagic's `text_chars` table says never occur in text: C0 controls other than TEXT_CONTROL_BYTES, and DEL. */
function assertLooksLikeText(bytes: Uint8Array): void {
  const offset = bytes.findIndex((byte) => (byte < FIRST_PRINTABLE_ASCII_BYTE && !TEXT_CONTROL_BYTES.has(byte)) || byte === DELETE_BYTE);
  if (offset >= 0) {
    const hex = bytes[offset].toString(16).padStart(2, '0');
    throw new ConversionFailedError(`The input is not text: the byte 0x${hex} at offset ${offset} is a control character that text does not use`);
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

/** `bytes` read as `encoding`, or null when they are not valid in it. Windows-1252 decodes every byte, as the standard does. */
function decodeAs(bytes: Uint8Array, encoding: string): string | null {
  if (encoding === WINDOWS_1252) return decodeWindows1252(bytes);
  const table = LEGACY_TABLES.get(encoding);
  if (table !== undefined) return decodeWithTable(bytes, table);
  try {
    return new TextDecoder(encoding, { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
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

/** The characters of a Unicode text file, read and strictly decoded in chunks, whatever the size. */
function distinctCharactersOfUnicodeFile(filePath: string, chunkBytes: number): string {
  const seen = new Set<number>();
  const chunk = Buffer.alloc(chunkBytes);
  const fd = fs.openSync(filePath, 'r');
  try {
    let bytesRead = fs.readSync(fd, chunk, 0, chunk.length, null);
    const decode = createTextInputDecoder(chunk.subarray(0, bytesRead));
    while (bytesRead > 0) {
      for (const ch of decode(chunk.subarray(0, bytesRead))) seen.add(ch.codePointAt(0) as number);
      bytesRead = fs.readSync(fd, chunk, 0, chunk.length, null);
    }
    for (const ch of decode()) seen.add(ch.codePointAt(0) as number);
  } finally {
    fs.closeSync(fd);
  }
  let text = '';
  for (const codePoint of seen) text += String.fromCodePoint(codePoint);
  return text;
}

/**
 * The characters of a text file, for deciding how it is drawn. A Unicode file is scanned in chunks of `chunkBytes`, whatever
 * its size, and gives its distinct characters; a file that is not valid UTF-8 is legacy text and is read whole, as the
 * conversion reads it (decodeTextInput), so both see the same encoding.
 */
export function readTextFileCharacters(filePath: string, chunkBytes: number): string {
  try {
    return distinctCharactersOfUnicodeFile(filePath, chunkBytes);
  } catch (error) {
    if (!(error instanceof InvalidUnicodeTextError)) throw error;
  }
  return decodeTextInput(fs.readFileSync(filePath));
}
