import { ConversionFailedError } from '../types';

/**
 * A bounded, non-validating XML 1.0 reader for hOCR (XHTML) and ALTO documents.
 *
 * It reports elements, attributes and character data to a handler and never builds a tree.
 * Element names are reported without their namespace prefix and namespaces are not resolved, so a
 * document that uses an undeclared prefix is still read. The input must otherwise be well formed:
 * unclosed or mismatched tags, a second root, unquoted or duplicated attributes, unknown entity
 * references and text outside the root throw OcrMarkupError. A DOCTYPE is skipped, but one with an
 * internal subset is refused, so no entity can be declared and no external resource is read.
 */

/** Longest document accepted, in UTF-16 code units. A dense scanned page is a few hundred kilobytes. */
export const OCR_MARKUP_MAX_CHARS = 128 * 1024 * 1024;
/** Deepest element nesting accepted; hOCR and ALTO pages nest about ten levels. */
export const OCR_MARKUP_MAX_DEPTH = 64;
/** Most elements accepted in one document. */
export const OCR_MARKUP_MAX_ELEMENTS = 5_000_000;
/** Most attributes accepted on one element. */
export const OCR_MARKUP_MAX_ATTRIBUTES = 64;
/** Longest element or attribute name accepted. */
export const OCR_MARKUP_MAX_NAME_CHARS = 128;

/** Longest entity or character reference, `&#x10FFFF;`, without its ampersand. */
const MAX_REFERENCE_CHARS = 10;
const MAX_CODE_POINT = 0x10ffff;
const HEX_RADIX = 16;
const DECIMAL_RADIX = 10;

const CH_TAB = 0x09;
const CH_LF = 0x0a;
const CH_CR = 0x0d;
const CH_SPACE = 0x20;
const CH_BANG = 0x21;
const CH_QUOTE = 0x22;
const CH_APOSTROPHE = 0x27;
const CH_SLASH = 0x2f;
const CH_LT = 0x3c;
const CH_EQUALS = 0x3d;
const CH_GT = 0x3e;
const CH_QUESTION = 0x3f;
const CH_LEFT_BRACKET = 0x5b;
const CH_BOM = 0xfeff;
const CH_UPPER_A = 0x41;
const CH_UPPER_Z = 0x5a;
const CH_LOWER_A = 0x61;
const CH_LOWER_Z = 0x7a;
const CH_DIGIT_0 = 0x30;
const CH_DIGIT_9 = 0x39;
const CH_UNDERSCORE = 0x5f;
const CH_COLON = 0x3a;
const CH_HYPHEN = 0x2d;
const CH_PERIOD = 0x2e;
const FIRST_NON_ASCII = 0x80;
const LAST_BEFORE_SURROGATES = 0xd7ff;
const FIRST_AFTER_SURROGATES = 0xe000;
const LAST_BMP_CHAR = 0xfffd;
const FIRST_ASTRAL = 0x10000;
const CH_HASH = 0x23;
const CH_LOWER_X = 0x78;
const CH_SEMICOLON = 0x3b;

const PREDEFINED_ENTITIES: ReadonlyMap<string, string> = new Map([
  ['amp', '&'],
  ['lt', '<'],
  ['gt', '>'],
  ['quot', '"'],
  ['apos', "'"],
]);

export class OcrMarkupError extends ConversionFailedError {
  readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = 'OcrMarkupError';
  }
}

export type MarkupAttributes = Readonly<Record<string, string>>;

export interface MarkupHandler {
  /** `depth` is 1 for the root element. */
  open(name: string, attributes: MarkupAttributes, depth: number): void;
  /** Decoded character data, possibly in several pieces per element. */
  text(text: string): void;
  close(name: string, depth: number): void;
}

function fail(message: string, offset: number): never {
  throw new OcrMarkupError(`Malformed markup at offset ${offset}: ${message}.`);
}

function isXmlSpace(code: number): boolean {
  return code === CH_SPACE || code === CH_TAB || code === CH_LF || code === CH_CR;
}

function isNameStart(code: number): boolean {
  const upper = code >= CH_UPPER_A && code <= CH_UPPER_Z;
  const lower = code >= CH_LOWER_A && code <= CH_LOWER_Z;
  return upper || lower || code === CH_UNDERSCORE || code === CH_COLON || code >= FIRST_NON_ASCII;
}

function isNameChar(code: number): boolean {
  const digit = code >= CH_DIGIT_0 && code <= CH_DIGIT_9;
  return isNameStart(code) || digit || code === CH_HYPHEN || code === CH_PERIOD;
}

/** Whether a code point may appear in an XML 1.0 document (Char production). */
function isXmlChar(codePoint: number): boolean {
  return (
    codePoint === CH_TAB ||
    codePoint === CH_LF ||
    codePoint === CH_CR ||
    (codePoint >= CH_SPACE && codePoint <= LAST_BEFORE_SURROGATES) ||
    (codePoint >= FIRST_AFTER_SURROGATES && codePoint <= LAST_BMP_CHAR) ||
    (codePoint >= FIRST_ASTRAL && codePoint <= MAX_CODE_POINT)
  );
}

function parseCodePoint(digits: string, radix: number): number {
  if (digits.length === 0) return Number.NaN;
  let value = 0;
  for (let i = 0; i < digits.length; i++) {
    const digit = Number.parseInt(digits[i], radix);
    if (Number.isNaN(digit)) return Number.NaN;
    value = value * radix + digit;
  }
  return value;
}

/** Index of the `;` ending the reference that starts at `at`, or -1; the search is bounded so a run of `&` stays linear. */
function findReferenceEnd(source: string, at: number, to: number): number {
  const last = Math.min(to - 1, at + 1 + MAX_REFERENCE_CHARS);
  for (let i = at + 1; i <= last; i++) {
    if (source.charCodeAt(i) === CH_SEMICOLON) return i;
  }
  return -1;
}

/**
 * Replaces the five predefined entities and numeric character references. Strict mode throws on
 * any other `&` sequence; lenient mode leaves it as written.
 */
function decodeReferences(source: string, from: number, to: number, strict: boolean): string {
  let at = source.indexOf('&', from);
  if (at === -1 || at >= to) return source.slice(from, to);
  const parts: string[] = [];
  let copied = from;
  while (at !== -1 && at < to) {
    const semicolon = findReferenceEnd(source, at, to);
    let decoded: string | null = null;
    if (semicolon !== -1) {
      const body = source.slice(at + 1, semicolon);
      if (body.charCodeAt(0) === CH_HASH) {
        const hex = body.charCodeAt(1) === CH_LOWER_X;
        const codePoint = hex ? parseCodePoint(body.slice(2), HEX_RADIX) : parseCodePoint(body.slice(1), DECIMAL_RADIX);
        if (isXmlChar(codePoint)) decoded = String.fromCodePoint(codePoint);
      } else {
        decoded = PREDEFINED_ENTITIES.get(body) ?? null;
      }
    }
    if (decoded === null) {
      if (strict) fail('unknown or malformed character reference', at);
      at = source.indexOf('&', at + 1);
      continue;
    }
    parts.push(source.slice(copied, at), decoded);
    copied = semicolon + 1;
    at = source.indexOf('&', copied);
  }
  parts.push(source.slice(copied, to));
  return parts.join('');
}

/** Lenient decoding of XML entities and numeric references for text that is not a whole document. */
export function unescapeXml(text: string): string {
  if (!text) return '';
  return decodeReferences(text, 0, text.length, false);
}

/** Attribute-value normalization: tabs and line breaks become spaces. */
function normalizeAttributeSpace(value: string): string {
  let needs = false;
  for (let i = 0; i < value.length && !needs; i++) {
    const code = value.charCodeAt(i);
    needs = code === CH_TAB || code === CH_LF || code === CH_CR;
  }
  if (!needs) return value;
  const out: string[] = [];
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    out.push(code === CH_TAB || code === CH_LF || code === CH_CR ? ' ' : value[i]);
  }
  return out.join('');
}

/**
 * Reads `source`, calling `handler` for every element and run of character data.
 * @throws OcrMarkupError for malformed markup or when a named limit is exceeded.
 */
export function readMarkup(source: string, handler: MarkupHandler): void {
  if (source.length > OCR_MARKUP_MAX_CHARS) {
    throw new OcrMarkupError(`Markup is larger than ${OCR_MARKUP_MAX_CHARS} characters.`);
  }
  const length = source.length;
  const open: string[] = [];
  let pos = source.charCodeAt(0) === CH_BOM ? 1 : 0;
  let elements = 0;
  let rootSeen = false;
  let doctypeSeen = false;

  const skipSpace = (): void => {
    while (pos < length && isXmlSpace(source.charCodeAt(pos))) pos++;
  };

  const readName = (what: string): string => {
    const start = pos;
    if (pos >= length || !isNameStart(source.charCodeAt(pos))) fail(`expected ${what} name`, pos);
    pos++;
    while (pos < length && isNameChar(source.charCodeAt(pos))) pos++;
    if (pos - start > OCR_MARKUP_MAX_NAME_CHARS) fail(`${what} name is longer than ${OCR_MARKUP_MAX_NAME_CHARS} characters`, start);
    return source.slice(start, pos);
  };

  const localName = (qualified: string): string => {
    const colon = qualified.indexOf(':');
    return colon === -1 ? qualified : qualified.slice(colon + 1);
  };

  const emitText = (from: number, to: number): void => {
    if (from >= to) return;
    if (open.length === 0) {
      for (let i = from; i < to; i++) {
        if (!isXmlSpace(source.charCodeAt(i))) fail('text outside the root element', i);
      }
      return;
    }
    handler.text(decodeReferences(source, from, to, true));
  };

  const readDoctype = (): void => {
    if (rootSeen || doctypeSeen) fail('misplaced DOCTYPE', pos);
    doctypeSeen = true;
    let at = pos + '<!DOCTYPE'.length;
    let quote = 0;
    while (at < length) {
      const code = source.charCodeAt(at);
      if (quote !== 0) {
        if (code === quote) quote = 0;
      } else if (code === CH_QUOTE || code === CH_APOSTROPHE) {
        quote = code;
      } else if (code === CH_LEFT_BRACKET) {
        fail('a DOCTYPE internal subset is not supported', at);
      } else if (code === CH_GT) {
        pos = at + 1;
        return;
      }
      at++;
    }
    fail('unterminated DOCTYPE', pos);
  };

  const readOpenTag = (): void => {
    const tagStart = pos;
    pos++;
    const qualified = readName('element');
    const attributes: Record<string, string> = Object.create(null);
    let attributeCount = 0;
    let selfClosing = false;
    for (;;) {
      const before = pos;
      skipSpace();
      if (pos >= length) fail('unterminated start tag', tagStart);
      const code = source.charCodeAt(pos);
      if (code === CH_GT) {
        pos++;
        break;
      }
      if (code === CH_SLASH) {
        if (source.charCodeAt(pos + 1) !== CH_GT) fail('expected > after /', pos);
        pos += 2;
        selfClosing = true;
        break;
      }
      if (pos === before) fail('attributes must be separated by white space', pos);
      const name = readName('attribute');
      skipSpace();
      if (source.charCodeAt(pos) !== CH_EQUALS) fail(`attribute ${name} has no value`, pos);
      pos++;
      skipSpace();
      const quote = source.charCodeAt(pos);
      if (quote !== CH_QUOTE && quote !== CH_APOSTROPHE) fail(`attribute ${name} value is not quoted`, pos);
      const valueStart = pos + 1;
      const valueEnd = source.indexOf(quote === CH_QUOTE ? '"' : "'", valueStart);
      if (valueEnd === -1) fail(`attribute ${name} value is not terminated`, valueStart);
      const raw = source.slice(valueStart, valueEnd);
      if (raw.includes('<')) fail(`attribute ${name} value contains <`, valueStart);
      if (name in attributes) fail(`duplicate attribute ${name}`, valueStart);
      if (++attributeCount > OCR_MARKUP_MAX_ATTRIBUTES) {
        fail(`more than ${OCR_MARKUP_MAX_ATTRIBUTES} attributes on one element`, tagStart);
      }
      attributes[name] = normalizeAttributeSpace(decodeReferences(raw, 0, raw.length, true));
      pos = valueEnd + 1;
    }
    if (open.length === 0 && rootSeen) fail('more than one root element', tagStart);
    if (open.length >= OCR_MARKUP_MAX_DEPTH) fail(`elements nested deeper than ${OCR_MARKUP_MAX_DEPTH}`, tagStart);
    if (++elements > OCR_MARKUP_MAX_ELEMENTS) {
      throw new OcrMarkupError(`Markup has more than ${OCR_MARKUP_MAX_ELEMENTS} elements.`);
    }
    rootSeen = true;
    const name = localName(qualified);
    handler.open(name, attributes, open.length + 1);
    if (selfClosing) {
      handler.close(name, open.length + 1);
    } else {
      open.push(qualified);
    }
  };

  const readCloseTag = (): void => {
    const tagStart = pos;
    pos += 2;
    const qualified = readName('element');
    skipSpace();
    if (source.charCodeAt(pos) !== CH_GT) fail('expected > in end tag', pos);
    pos++;
    const expected = open.pop();
    if (expected === undefined) fail(`unexpected end tag </${qualified}>`, tagStart);
    if (expected !== qualified) fail(`end tag </${qualified}> does not match <${expected}>`, tagStart);
    handler.close(localName(qualified), open.length + 1);
  };

  const skipTo = (terminator: string, what: string): number => {
    const end = source.indexOf(terminator, pos);
    if (end === -1) fail(`unterminated ${what}`, pos);
    return end;
  };

  while (pos < length) {
    const lt = source.indexOf('<', pos);
    if (lt === -1) {
      emitText(pos, length);
      break;
    }
    emitText(pos, lt);
    pos = lt;
    const next = source.charCodeAt(pos + 1);
    if (next === CH_BANG) {
      if (source.startsWith('<!--', pos)) {
        pos = skipTo('-->', 'comment') + '-->'.length;
      } else if (source.startsWith('<![CDATA[', pos)) {
        if (open.length === 0) fail('CDATA outside the root element', pos);
        const start = pos + '<![CDATA['.length;
        const end = source.indexOf(']]>', start);
        if (end === -1) fail('unterminated CDATA section', pos);
        if (end > start) handler.text(source.slice(start, end));
        pos = end + ']]>'.length;
      } else if (source.startsWith('<!DOCTYPE', pos)) {
        readDoctype();
      } else {
        fail('unsupported markup declaration', pos);
      }
    } else if (next === CH_QUESTION) {
      pos = skipTo('?>', 'processing instruction') + '?>'.length;
    } else if (next === CH_SLASH) {
      readCloseTag();
    } else {
      readOpenTag();
    }
  }
  if (open.length > 0) fail(`element <${open[open.length - 1]}> is not closed`, length);
  if (!rootSeen) fail('the document has no root element', length);
}
