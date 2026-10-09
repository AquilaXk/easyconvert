import { ConversionFailedError } from '../../types';

/**
 * Text for XML 1.0 parts (DOCX, EPUB, HTML as XHTML). The Char production of the XML 1.0 specification allows tab, line
 * feed, carriage return, U+0020 to U+D7FF, U+E000 to U+FFFD and the supplementary planes. Anything else (control
 * codes, lone surrogates, U+FFFE and U+FFFF) makes the part ill-formed, so text with such a character is refused rather
 * than written, and never quietly dropped or replaced.
 */

/** A character XML 1.0 does not allow. */
const DISALLOWED_XML_CHARACTER = /[^\u0009\u000A\u000D -퟿-�\u{10000}-\u{10FFFF}]/u;

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
  const match = DISALLOWED_XML_CHARACTER.exec(text);
  if (match !== null) throw new InvalidXmlCharacterError(match[0].codePointAt(0) ?? 0);
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
