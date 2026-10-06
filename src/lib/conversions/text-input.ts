import { ConversionFailedError } from '../types';

/**
 * Strict decoding of plain-text input: UTF-8 (with or without a byte order mark) or UTF-16 with a
 * byte order mark. Anything else fails with ConversionFailedError instead of turning into
 * replacement characters or mojibake.
 */

export type TextInputEncoding = 'utf-8' | 'utf-16le' | 'utf-16be';

const UTF16LE_BOM = [0xff, 0xfe] as const;
const UTF16BE_BOM = [0xfe, 0xff] as const;

/** The encoding a text file declares through its byte order mark; UTF-8 when it has none. */
export function detectTextInputEncoding(head: Uint8Array): TextInputEncoding {
  if (head.length >= UTF16LE_BOM.length && head[0] === UTF16LE_BOM[0] && head[1] === UTF16LE_BOM[1]) return 'utf-16le';
  if (head.length >= UTF16BE_BOM.length && head[0] === UTF16BE_BOM[0] && head[1] === UTF16BE_BOM[1]) return 'utf-16be';
  return 'utf-8';
}

function invalidEncoding(encoding: TextInputEncoding): ConversionFailedError {
  return new ConversionFailedError(
    `Text input is not valid ${encoding.toUpperCase()}; save it as UTF-8 (or UTF-16 with a byte order mark) and convert again`
  );
}

/**
 * A fatal decoder for text that starts with `head`; the byte order mark is consumed. Decode chunks
 * with `{ stream: true }` and finish with an empty call; invalid bytes throw ConversionFailedError.
 */
export function createTextInputDecoder(head: Uint8Array): (chunk?: Uint8Array) => string {
  const encoding = detectTextInputEncoding(head);
  const decoder = new TextDecoder(encoding, { fatal: true });
  return (chunk?: Uint8Array): string => {
    try {
      return chunk ? decoder.decode(chunk, { stream: true }) : decoder.decode();
    } catch {
      throw invalidEncoding(encoding);
    }
  };
}

/** Decodes a whole text file; throws ConversionFailedError for bytes that are not valid text. */
export function decodeTextInput(buffer: Buffer): string {
  const decode = createTextInputDecoder(buffer);
  return decode(buffer) + decode();
}
