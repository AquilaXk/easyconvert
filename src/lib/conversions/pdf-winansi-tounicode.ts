import { PDFDict, PDFName, type PDFDocument, type PDFFont } from 'pdf-lib';

/** WinAnsiEncoding (PDF 32000-1 Annex D.2) agrees with Latin-1 below this code and from WINANSI_C1_END up. */
const WINANSI_C1_START = 0x80;
const WINANSI_C1_END = 0xa0;
const WINANSI_LAST_CODE = 0xff;
const LATIN1_LAST_ASCII = 0x7f;
/** Bullet, which WinAnsiEncoding shows for its unused codes (0x81, 0x8D, 0x8F, 0x90, 0x9D). */
const WINANSI_BULLET = 0x2022;
/** Unicode value of each WinAnsiEncoding code 0x80 to 0x9F (windows-1252; unused codes as the bullet). */
const WINANSI_C1_TO_UNICODE: readonly number[] = [
  0x20ac, WINANSI_BULLET, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021,
  0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, WINANSI_BULLET, 0x017d, WINANSI_BULLET,
  WINANSI_BULLET, 0x2018, 0x2019, 0x201c, 0x201d, WINANSI_BULLET, 0x2013, 0x2014,
  0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, WINANSI_BULLET, 0x017e, 0x0178,
];

function hexCode(value: number, width: number): string {
  return value.toString(16).toUpperCase().padStart(width, '0');
}

/**
 * Creates an ISO 32000-1 compliant 1-byte WinAnsi ToUnicode CMap stream for StandardFonts. Codes 0x00 to 0x7F and
 * 0xA0 to 0xFF equal their Unicode values; 0x80 to 0x9F are the windows-1252 characters (euro sign, curly quotes,
 * dashes, trademark sign, ...), not the C1 control characters of the same numbers.
 */
export function createWinAnsiToUnicodeCMap(): string {
  const c1Entries = WINANSI_C1_TO_UNICODE.map((unicode, i) => `<${hexCode(WINANSI_C1_START + i, 2)}> <${hexCode(unicode, 4)}>`).join('\n');
  return `/CIDInit /ProcSet findresource begin
12 dict begin
begincmap
/CIDSystemInfo <<
  /Registry (Adobe)
  /Ordering (UCS)
  /Supplement 0
>> def
/CMapName /WinAnsi-ToUnicode def
/CMapType 2 def
1 begincodespacerange
<00> <${hexCode(WINANSI_LAST_CODE, 2)}>
endcodespacerange
2 beginbfrange
<00> <${hexCode(LATIN1_LAST_ASCII, 2)}> <0000>
<${hexCode(WINANSI_C1_END, 2)}> <${hexCode(WINANSI_LAST_CODE, 2)}> <${hexCode(WINANSI_C1_END, 4)}>
endbfrange
${WINANSI_C1_TO_UNICODE.length} beginbfchar
${c1Entries}
endbfchar
endcmap
CMapName currentdict /CMap defineresource pop
end
end`;
}

const TO_UNICODE_KEY = PDFName.of('ToUnicode');

/**
 * Gives a font that pdf-lib embeds from the standard 14 (WinAnsiEncoding, no /ToUnicode of its own) the CMap above, so
 * text drawn with it copies and searches as the characters the encoding shows rather than as the C1 controls that
 * share the codes 0x80 to 0x9F. The font is embedded now so that its dictionary exists to receive the entry.
 */
export async function attachWinAnsiToUnicode(doc: PDFDocument, font: PDFFont): Promise<void> {
  await font.embed();
  const dict = doc.context.lookup(font.ref);
  if (!(dict instanceof PDFDict)) throw new Error('The standard font has no dictionary to attach /ToUnicode to.');
  dict.set(TO_UNICODE_KEY, doc.context.register(doc.context.flateStream(createWinAnsiToUnicodeCMap())));
}
