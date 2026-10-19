import { reportConversionWarning } from '../conversion-warnings';

/**
 * Text for XML 1.0 parts (DOCX, ODT, EPUB, HTML as XHTML). The Char production of the XML 1.0 specification allows tab, line
 * feed, carriage return, U+0020 to U+D7FF, U+E000 to U+FFFD and the supplementary planes. Anything else makes the part
 * ill-formed, so it is not written, and the document is not refused for it (policy 55):
 *   - a control code (U+0000 to U+001F other than tab, line feed and carriage return) has no glyph and no meaning in the
 *     document, so it is dropped, as the PDF writers drop controls;
 *   - a lone surrogate, U+FFFE and U+FFFF stand for a character that was lost before the writer, so each becomes U+FFFD
 *     and the conversion reports it once per distinct code point (policy 7).
 */

/** Code points of the XML 1.0 Char production outside the contiguous ranges below. */
const XML_TAB = 0x09;
const XML_LINE_FEED = 0x0a;
const XML_CARRIAGE_RETURN = 0x0d;
const XML_BMP_LOW_START = 0x20;
const XML_BMP_LOW_END = 0xd7ff;
const XML_BMP_HIGH_START = 0xe000;
const XML_BMP_HIGH_END = 0xfffd;
const XML_SUPPLEMENTARY_START = 0x10000;
const XML_SUPPLEMENTARY_END = 0x10ffff;
const REPLACEMENT_CHARACTER = '\uFFFD';
const HEX_RADIX = 16;
const CODE_POINT_HEX_WIDTH = 4;
/**
 * A code point XML 1.0 does not allow: a control code other than tab, line feed and carriage return, a surrogate that is
 * not one half of a pair, or U+FFFE or U+FFFF. It tests a whole text at once, so the common case reads the text once.
 */
// eslint-disable-next-line no-control-regex -- the control codes are exactly what this expression finds
const NOT_XML_TEXT = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** Whether the code point is a Char of XML 1.0. A lone surrogate (U+D800 to U+DFFF) is not. */
function isXmlChar(codePoint: number): boolean {
  if (codePoint === XML_TAB || codePoint === XML_LINE_FEED || codePoint === XML_CARRIAGE_RETURN) return true;
  if (codePoint >= XML_BMP_LOW_START && codePoint <= XML_BMP_LOW_END) return true;
  if (codePoint >= XML_BMP_HIGH_START && codePoint <= XML_BMP_HIGH_END) return true;
  return codePoint >= XML_SUPPLEMENTARY_START && codePoint <= XML_SUPPLEMENTARY_END;
}

/** Whether the code point is a control code with no place in XML 1.0 (the C0 controls other than tab, line feed and carriage return). */
function isDroppedControl(codePoint: number): boolean {
  return codePoint < XML_BMP_LOW_START;
}

function replaceUnwritable(codePoint: number): string {
  const label = `U+${codePoint.toString(HEX_RADIX).toUpperCase().padStart(CODE_POINT_HEX_WIDTH, '0')}`;
  reportConversionWarning(`Replaced ${label} with U+FFFD: XML 1.0 cannot carry this code point (a lone surrogate or a noncharacter).`);
  return REPLACEMENT_CHARACTER;
}

/** The text with every code point XML 1.0 does not allow dropped (controls) or replaced by U+FFFD (the others, reported). */
function xmlSafeText(text: string): string {
  if (!NOT_XML_TEXT.test(text)) return text;
  let safe = '';
  for (const character of text) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (isXmlChar(codePoint)) safe += character;
    else if (!isDroppedControl(codePoint)) safe += replaceUnwritable(codePoint);
  }
  return safe;
}

const AMPERSAND = /&/g;
const LESS_THAN = /</g;
const GREATER_THAN = />/g;
const QUOTE = /"/g;

/** Escapes text for element content and double-quoted attributes; code points XML 1.0 does not allow are handled by `xmlSafeText`. */
export function escapeXmlText(text: string): string {
  return xmlSafeText(text).replace(AMPERSAND, '&amp;').replace(LESS_THAN, '&lt;').replace(GREATER_THAN, '&gt;').replace(QUOTE, '&quot;');
}
