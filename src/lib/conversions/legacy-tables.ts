import iconv from 'iconv-lite';

const REPLACEMENT_CHARACTER = 0xfffd;

/** Non-ASCII characters a legacy guess needs before it is trusted; fewer cannot tell the encodings apart. */
export const MIN_LEGACY_EVIDENCE_CHARS = 4;

/**
 * iconv-lite decoding tables for WHATWG legacy encodings that Node's TextDecoder gets wrong
 * without throwing in fatal mode: its "euc-kr" lacks the CP949 extension rows and turns their
 * lead bytes into C1 controls, its "gbk" drops some valid sequences, its "big5" drops HKSCS
 * characters, and its "windows-1252" (also the decoder of the latin1 and iso-8859-1 labels)
 * decodes 0x80-0x9F as ISO-8859-1 C1 controls instead of curly quotes, dashes and the euro sign.
 * iconv-lite's tables match glibc iconv for every sequence used here; Windows-1252's five
 * unassigned bytes are rejected rather than read as C1 controls.
 */
export const LEGACY_TABLES: ReadonlyMap<string, string> = new Map([
  ['euc-kr', 'cp949'],
  ['shift_jis', 'cp932'],
  ['gbk', 'gb18030'],
  ['gb18030', 'gb18030'],
  ['big5', 'big5hkscs'],
  ['windows-1252', 'cp1252'],
]);

/**
 * A decoder for chunks of text in an iconv-lite table: a call with bytes gives the text of the chunk (a sequence cut at its end
 * is carried over to the next call) and a call with none ends the text. A result is null when a sequence is invalid (the table
 * emits U+FFFD for it).
 */
export function createTableDecoder(table: string): (chunk?: Uint8Array) => string | null {
  const decoder = iconv.getDecoder(table, { stripBOM: false });
  return (chunk?: Uint8Array): string | null => {
    const text = (chunk ? decoder.write(chunk as Buffer) : decoder.end()) ?? '';
    return text.includes(String.fromCodePoint(REPLACEMENT_CHARACTER)) ? null : text;
  };
}

/** Decodes with an iconv-lite table; null when any sequence is invalid. */
export function decodeWithTable(bytes: Uint8Array, table: string): string | null {
  const decode = createTableDecoder(table);
  const text = decode(bytes);
  const rest = decode();
  return text === null || rest === null ? null : text + rest;
}
