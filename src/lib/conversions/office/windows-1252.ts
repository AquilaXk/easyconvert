/**
 * Windows-1252 decoding for the legacy Office readers. The runtime TextDecoder label "windows-1252"
 * decodes as ISO-8859-1 on some Node releases, which turns bytes 0x80-0x9F into C1 controls instead of
 * curly quotes, dashes and the euro sign, so the 32-entry high table is spelled out here.
 */

const FIRST_HIGH_BYTE = 0x80;
const LAST_HIGH_BYTE = 0x9f;
/** Characters converted per String.fromCharCode call, small enough to stay below the argument limit. */
const DECODE_CHUNK_CHARS = 8192;

/** Code points of bytes 0x80..0x9F; the five bytes the code page leaves undefined keep their C1 code point. */
const HIGH_TABLE: readonly number[] = [
  0x20ac, 0x0081, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, 0x008d, 0x017d, 0x008f,
  0x0090, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x009d, 0x017e, 0x0178,
];

/** Decodes bytes as Windows-1252: bytes below 0x80 and above 0x9F are their own Latin-1 code points. */
export function decodeWindows1252(bytes: Uint8Array): string {
  const chunks: string[] = [];
  for (let start = 0; start < bytes.length; start += DECODE_CHUNK_CHARS) {
    const end = Math.min(start + DECODE_CHUNK_CHARS, bytes.length);
    const codes = new Array<number>(end - start);
    for (let i = start; i < end; i++) {
      const byte = bytes[i];
      codes[i - start] = byte >= FIRST_HIGH_BYTE && byte <= LAST_HIGH_BYTE ? HIGH_TABLE[byte - FIRST_HIGH_BYTE] : byte;
    }
    chunks.push(String.fromCharCode(...codes));
  }
  return chunks.join('');
}
