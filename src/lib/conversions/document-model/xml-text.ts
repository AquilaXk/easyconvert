import { ConversionFailedError } from '../../types';

/**
 * Text for XML 1.0 parts (DOCX, EPUB, HTML as XHTML). The Char production of the XML 1.0 specification allows tab, line
 * feed, carriage return, U+0020 to U+D7FF, U+E000 to U+FFFD and the supplementary planes. Anything else (control
 * codes, lone surrogates, U+FFFE and U+FFFF) makes the part ill-formed, so text with such a character is refused rather
 * than written, and never quietly dropped or replaced.
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

/** Whether the code point is a Char of XML 1.0. A lone surrogate (U+D800 to U+DFFF) is not. */
function isXmlChar(codePoint: number): boolean {
  if (codePoint === XML_TAB || codePoint === XML_LINE_FEED || codePoint === XML_CARRIAGE_RETURN) return true;
  if (codePoint >= XML_BMP_LOW_START && codePoint <= XML_BMP_LOW_END) return true;
  if (codePoint >= XML_BMP_HIGH_START && codePoint <= XML_BMP_HIGH_END) return true;
  return codePoint >= XML_SUPPLEMENTARY_START && codePoint <= XML_SUPPLEMENTARY_END;
}

/** Text holding a character that cannot appear in XML 1.0 (HTTP 400). */
export class InvalidXmlCharacterError extends ConversionFailedError {
  readonly status = 400;
  constructor(codePoint: number) {
    super(`The text has the character U+${codePoint.toString(16).toUpperCase().padStart(4, '0')}, which XML 1.0 does not allow.`);
    this.name = 'InvalidXmlCharacterError';
  }
}

/** Throws InvalidXmlCharacterError when the text has a character XML 1.0 does not allow. */
export function assertXmlText(text: string): void {
  for (const character of text) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (!isXmlChar(codePoint)) throw new InvalidXmlCharacterError(codePoint);
  }
}

const AMPERSAND = /&/g;
const LESS_THAN = /</g;
const GREATER_THAN = />/g;
const QUOTE = /"/g;

/** Escapes text for element content and double-quoted attributes. */
export function escapeXmlText(text: string): string {
  assertXmlText(text);
  return text.replace(AMPERSAND, '&amp;').replace(LESS_THAN, '&lt;').replace(GREATER_THAN, '&gt;').replace(QUOTE, '&quot;');
}
