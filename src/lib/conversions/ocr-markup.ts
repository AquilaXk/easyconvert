import { ConversionFailedError } from '../types';

/**
 * A bounded, non-validating XML 1.0 reader for hOCR (XHTML) and ALTO documents.
 *
 * It reports elements, attributes and character data to a handler and never builds a tree.
 * Element names are reported without their namespace prefix and namespaces are not resolved, so a
 * document that uses an undeclared prefix is still read. The input must otherwise be well formed:
 * unclosed or mismatched tags, a second root, unquoted or duplicated attributes, unknown entity
 * references, characters XML 1.0 forbids, an XML declaration that is not first, and text outside the
 * root throw OcrMarkupError. A DOCTYPE is skipped, but one with an internal subset is refused, so no
 * entity can be declared and no external resource is read.
 *
 * HTML mode (`options.html`, used for hOCR only) additionally accepts what an HTML5 serializer
 * writes: void elements such as `<meta>` and `<br>` without a closing tag, and the common HTML
 * named character references. Everything else stays strict.
 */

/**
 * Longest document accepted, in UTF-16 code units: 32 MiB. A word costs about 150 bytes of hOCR, so
 * this holds roughly 200,000 words, several hundred dense scanned pages, while keeping the
 * transient memory of one conversion (the string, its decoded pieces and the result) well under a
 * gigabyte.
 */
export const OCR_MARKUP_MAX_CHARS = 32 * 1024 * 1024;
/** Longest run of character data between two tags (or one CDATA section); words and lines are far shorter. */
export const OCR_MARKUP_MAX_TEXT_CHARS = 1024 * 1024;
/** Longest attribute value; the longest legitimate one is a line title of a few hundred characters. */
export const OCR_MARKUP_MAX_ATTRIBUTE_CHARS = 256 * 1024;
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
const FIRST_SURROGATE = 0xd800;
const CH_HASH = 0x23;
const CH_LOWER_X = 0x78;
const CH_SEMICOLON = 0x3b;
/** What reading past the end of the source yields: no character test accepts it. */
const NO_CODE = -1;

const PREDEFINED_ENTITIES: ReadonlyMap<string, string> = new Map([
  ['amp', '&'],
  ['lt', '<'],
  ['gt', '>'],
  ['quot', '"'],
  ['apos', "'"],
]);

/** HTML named references an HTML5 serializer writes in practice; used in HTML mode only. */
const HTML_ENTITIES: ReadonlyMap<string, string> = new Map([
  ['nbsp', '\u00a0'], ['iexcl', '\u00a1'], ['cent', '\u00a2'], ['pound', '\u00a3'], ['yen', '\u00a5'],
  ['sect', '\u00a7'], ['copy', '\u00a9'], ['laquo', '\u00ab'], ['shy', '\u00ad'], ['reg', '\u00ae'],
  ['deg', '\u00b0'], ['plusmn', '\u00b1'], ['micro', '\u00b5'], ['para', '\u00b6'], ['middot', '\u00b7'],
  ['raquo', '\u00bb'], ['iquest', '\u00bf'], ['times', '\u00d7'], ['divide', '\u00f7'],
  ['agrave', '\u00e0'], ['aacute', '\u00e1'], ['acirc', '\u00e2'], ['auml', '\u00e4'], ['ccedil', '\u00e7'],
  ['egrave', '\u00e8'], ['eacute', '\u00e9'], ['ecirc', '\u00ea'], ['iacute', '\u00ed'], ['ntilde', '\u00f1'],
  ['oacute', '\u00f3'], ['ouml', '\u00f6'], ['uacute', '\u00fa'], ['uuml', '\u00fc'], ['szlig', '\u00df'],
  ['ndash', '\u2013'], ['mdash', '\u2014'], ['lsquo', '\u2018'], ['rsquo', '\u2019'], ['ldquo', '\u201c'],
  ['rdquo', '\u201d'], ['bull', '\u2022'], ['hellip', '\u2026'], ['euro', '\u20ac'], ['trade', '\u2122'],
]);

/** HTML void elements: written without an end tag by an HTML5 serializer. */
const HTML_VOID_ELEMENTS: ReadonlySet<string> = new Set([
  'meta', 'link', 'br', 'hr', 'img', 'input', 'area', 'base', 'col', 'embed', 'param', 'source', 'track', 'wbr',
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
  for (const character of digits) {
    const digit = Number.parseInt(character, radix);
    if (Number.isNaN(digit)) return Number.NaN;
    value = value * radix + digit;
  }
  return value;
}

/** Index of the `;` ending the reference that starts at `at`, or -1; the search is bounded so a run of `&` stays linear. */
function findReferenceEnd(source: string, at: number, to: number): number {
  const last = Math.min(to - 1, at + 1 + MAX_REFERENCE_CHARS);
  for (let i = at + 1; i <= last; i++) {
    if (source.codePointAt(i) === CH_SEMICOLON) return i;
  }
  return -1;
}

/** The character a numeric reference body (`#65` or `#x41`) names, or null when it is malformed or not an XML character. */
function decodeNumericReference(body: string): string | null {
  const hex = body.codePointAt(1) === CH_LOWER_X;
  const codePoint = hex ? parseCodePoint(body.slice(2), HEX_RADIX) : parseCodePoint(body.slice(1), DECIMAL_RADIX);
  if (!isXmlChar(codePoint)) return null;
  return String.fromCodePoint(codePoint);
}

/** The text a reference body (between `&` and `;`) stands for, or null when it is unknown. */
function decodeReference(body: string, html: boolean): string | null {
  if (body.codePointAt(0) === CH_HASH) return decodeNumericReference(body);
  const predefined = PREDEFINED_ENTITIES.get(body);
  if (predefined !== undefined) return predefined;
  if (html) return HTML_ENTITIES.get(body) ?? null;
  return null;
}

/**
 * Replaces the predefined entities (plus the HTML ones in HTML mode) and numeric character
 * references in `raw`, which starts at `offset` in the document. Strict mode throws on any other
 * `&` sequence; lenient mode leaves it as written. Callers bound `raw` by the text and attribute
 * limits, so the pieces collected here stay small.
 */
function decodeReferences(raw: string, offset: number, strict: boolean, html: boolean): string {
  let at = raw.indexOf('&');
  if (at === -1) return raw;
  const parts: string[] = [];
  let copied = 0;
  while (at !== -1) {
    const semicolon = findReferenceEnd(raw, at, raw.length);
    const decoded = semicolon === -1 ? null : decodeReference(raw.slice(at + 1, semicolon), html);
    if (decoded === null) {
      if (strict) fail('unknown or malformed character reference', offset + at);
      at = raw.indexOf('&', at + 1);
      continue;
    }
    parts.push(raw.slice(copied, at), decoded);
    copied = semicolon + 1;
    at = raw.indexOf('&', copied);
  }
  parts.push(raw.slice(copied));
  return parts.join('');
}

/** Lenient decoding of XML entities and numeric references for text that is not a whole document. */
export function unescapeXml(text: string): string {
  if (!text) return '';
  return decodeReferences(text, 0, false, false);
}

const ATTRIBUTE_SPACE = /[\t\n\r]/g;

/** Attribute-value normalization: tabs and line breaks become spaces (one pass, no per-character array). */
function normalizeAttributeSpace(value: string): string {
  return value.replace(ATTRIBUTE_SPACE, ' ');
}

/**
 * Throws on the first character XML 1.0 does not allow: C0 controls other than tab, line feed and
 * carriage return, U+FFFE, U+FFFF and unpaired surrogates.
 */
function assertXmlCharacters(source: string): void {
  for (let i = 0; i < source.length; i++) {
    const code = source.codePointAt(i) ?? 0;
    if (code >= CH_SPACE && code < FIRST_SURROGATE) continue;
    // A surrogate pair is one astral code point, which is always allowed; a lone surrogate reads as itself.
    if (code >= FIRST_ASTRAL) {
      i++;
    } else if (!isXmlChar(code)) {
      fail(`character U+${code.toString(HEX_RADIX).toUpperCase().padStart(4, '0')} is not allowed in XML 1.0`, i);
    }
  }
}

function localName(qualified: string): string {
  const colon = qualified.indexOf(':');
  if (colon === -1) return qualified;
  return qualified.slice(colon + 1);
}

export interface ReadMarkupOptions {
  /** Accept HTML5-serialized markup: unclosed void elements and HTML named character references. */
  html?: boolean;
}

/** The attributes of one start tag, with how many were read. */
interface AttributeSet {
  values: Record<string, string>;
  count: number;
}

/** Position, nesting and document state of one pass over the source. */
class MarkupReader {
  private pos: number;
  private readonly length: number;
  private readonly open: string[] = [];
  private readonly documentStart: number;
  private elements = 0;
  private rootSeen = false;
  private doctypeSeen = false;

  constructor(
    private readonly source: string,
    private readonly handler: MarkupHandler,
    private readonly html: boolean
  ) {
    this.length = source.length;
    this.documentStart = source.codePointAt(0) === CH_BOM ? 1 : 0;
    this.pos = this.documentStart;
  }

  /** The code point at `index`, or -1 past the end, which no character test accepts. */
  private codeAt(index: number): number {
    return this.source.codePointAt(index) ?? NO_CODE;
  }

  private skipSpace(): void {
    while (this.pos < this.length && isXmlSpace(this.codeAt(this.pos))) this.pos++;
  }

  private readName(what: string): string {
    const start = this.pos;
    if (this.pos >= this.length || !isNameStart(this.codeAt(this.pos))) fail(`expected ${what} name`, this.pos);
    this.pos++;
    while (this.pos < this.length && isNameChar(this.codeAt(this.pos))) this.pos++;
    if (this.pos - start > OCR_MARKUP_MAX_NAME_CHARS) fail(`${what} name is longer than ${OCR_MARKUP_MAX_NAME_CHARS} characters`, start);
    return this.source.slice(start, this.pos);
  }

  private emitText(from: number, to: number): void {
    if (from >= to) return;
    if (to - from > OCR_MARKUP_MAX_TEXT_CHARS) fail(`text is longer than ${OCR_MARKUP_MAX_TEXT_CHARS} characters`, from);
    if (this.open.length > 0) {
      this.handler.text(decodeReferences(this.source.slice(from, to), from, true, this.html));
      return;
    }
    for (let i = from; i < to; i++) {
      if (!isXmlSpace(this.codeAt(i))) fail('text outside the root element', i);
    }
  }

  private skipTo(terminator: string, what: string): number {
    const end = this.source.indexOf(terminator, this.pos);
    if (end === -1) fail(`unterminated ${what}`, this.pos);
    return end;
  }

  private readDoctype(): void {
    if (this.rootSeen || this.doctypeSeen) fail('misplaced DOCTYPE', this.pos);
    this.doctypeSeen = true;
    let at = this.pos + '<!DOCTYPE'.length;
    let quote = 0;
    while (at < this.length) {
      const code = this.codeAt(at);
      if (quote !== 0) {
        if (code === quote) quote = 0;
      } else if (code === CH_QUOTE || code === CH_APOSTROPHE) {
        quote = code;
      } else if (code === CH_LEFT_BRACKET) {
        fail('a DOCTYPE internal subset is not supported', at);
      } else if (code === CH_GT) {
        this.pos = at + 1;
        return;
      }
      at++;
    }
    fail('unterminated DOCTYPE', this.pos);
  }

  private readCdata(): void {
    if (this.open.length === 0) fail('CDATA outside the root element', this.pos);
    const start = this.pos + '<![CDATA['.length;
    const end = this.source.indexOf(']]>', start);
    if (end === -1) fail('unterminated CDATA section', this.pos);
    if (end - start > OCR_MARKUP_MAX_TEXT_CHARS) fail(`text is longer than ${OCR_MARKUP_MAX_TEXT_CHARS} characters`, start);
    if (end > start) this.handler.text(this.source.slice(start, end));
    this.pos = end + ']]>'.length;
  }

  /** A comment, CDATA section or DOCTYPE; anything else starting `<!` is refused. */
  private readDeclaration(): void {
    if (this.source.startsWith('<!--', this.pos)) {
      this.pos = this.skipTo('-->', 'comment') + '-->'.length;
    } else if (this.source.startsWith('<![CDATA[', this.pos)) {
      this.readCdata();
    } else if (this.source.startsWith('<!DOCTYPE', this.pos)) {
      this.readDoctype();
    } else {
      fail('unsupported markup declaration', this.pos);
    }
  }

  private readProcessingInstruction(): void {
    let targetEnd = this.pos + 2;
    while (targetEnd < this.length && isNameChar(this.codeAt(targetEnd))) targetEnd++;
    if (this.source.slice(this.pos + 2, targetEnd).toLowerCase() === 'xml' && this.pos !== this.documentStart) {
      fail('an XML declaration is only allowed at the start of the document', this.pos);
    }
    this.pos = this.skipTo('?>', 'processing instruction') + '?>'.length;
  }

  private readAttribute(tagStart: number, set: AttributeSet): void {
    const name = this.readName('attribute');
    this.skipSpace();
    if (this.codeAt(this.pos) !== CH_EQUALS) fail(`attribute ${name} has no value`, this.pos);
    this.pos++;
    this.skipSpace();
    const quote = this.codeAt(this.pos);
    if (quote !== CH_QUOTE && quote !== CH_APOSTROPHE) fail(`attribute ${name} value is not quoted`, this.pos);
    const valueStart = this.pos + 1;
    const valueEnd = this.source.indexOf(quote === CH_QUOTE ? '"' : "'", valueStart);
    if (valueEnd === -1) fail(`attribute ${name} value is not terminated`, valueStart);
    if (valueEnd - valueStart > OCR_MARKUP_MAX_ATTRIBUTE_CHARS) {
      fail(`attribute ${name} value is longer than ${OCR_MARKUP_MAX_ATTRIBUTE_CHARS} characters`, valueStart);
    }
    const raw = this.source.slice(valueStart, valueEnd);
    if (raw.includes('<')) fail(`attribute ${name} value contains <`, valueStart);
    if (name in set.values) fail(`duplicate attribute ${name}`, valueStart);
    if (++set.count > OCR_MARKUP_MAX_ATTRIBUTES) {
      fail(`more than ${OCR_MARKUP_MAX_ATTRIBUTES} attributes on one element`, tagStart);
    }
    set.values[name] = normalizeAttributeSpace(decodeReferences(raw, valueStart, true, this.html));
    this.pos = valueEnd + 1;
  }

  /** The attributes up to the end of the start tag, and whether the tag closes itself (`/>`). */
  private readAttributes(tagStart: number): { attributes: MarkupAttributes; selfClosing: boolean } {
    const set: AttributeSet = { values: Object.create(null), count: 0 };
    for (;;) {
      const before = this.pos;
      this.skipSpace();
      if (this.pos >= this.length) fail('unterminated start tag', tagStart);
      const code = this.codeAt(this.pos);
      if (code === CH_GT) {
        this.pos++;
        return { attributes: set.values, selfClosing: false };
      }
      if (code === CH_SLASH) {
        if (this.codeAt(this.pos + 1) !== CH_GT) fail('expected > after /', this.pos);
        this.pos += 2;
        return { attributes: set.values, selfClosing: true };
      }
      if (this.pos === before) fail('attributes must be separated by white space', this.pos);
      this.readAttribute(tagStart, set);
    }
  }

  private checkElementLimits(tagStart: number): void {
    if (this.open.length === 0 && this.rootSeen) fail('more than one root element', tagStart);
    if (this.open.length >= OCR_MARKUP_MAX_DEPTH) fail(`elements nested deeper than ${OCR_MARKUP_MAX_DEPTH}`, tagStart);
    if (++this.elements > OCR_MARKUP_MAX_ELEMENTS) {
      throw new OcrMarkupError(`Markup has more than ${OCR_MARKUP_MAX_ELEMENTS} elements.`);
    }
  }

  private readOpenTag(): void {
    const tagStart = this.pos;
    this.pos++;
    const qualified = this.readName('element');
    const { attributes, selfClosing: closedByTag } = this.readAttributes(tagStart);
    const selfClosing = closedByTag || (this.html && HTML_VOID_ELEMENTS.has(qualified.toLowerCase()));
    this.checkElementLimits(tagStart);
    this.rootSeen = true;
    const name = localName(qualified);
    const depth = this.open.length + 1;
    this.handler.open(name, attributes, depth);
    if (selfClosing) {
      this.handler.close(name, depth);
    } else {
      this.open.push(qualified);
    }
  }

  private readCloseTag(): void {
    const tagStart = this.pos;
    this.pos += 2;
    const qualified = this.readName('element');
    this.skipSpace();
    if (this.codeAt(this.pos) !== CH_GT) fail('expected > in end tag', this.pos);
    this.pos++;
    // A void element is already closed; an XHTML-style end tag after it is ignored in HTML mode.
    if (this.html && HTML_VOID_ELEMENTS.has(qualified.toLowerCase()) && this.open.at(-1) !== qualified) return;
    const expected = this.open.pop();
    if (expected === undefined) fail(`unexpected end tag </${qualified}>`, tagStart);
    if (expected !== qualified) fail(`end tag </${qualified}> does not match <${expected}>`, tagStart);
    this.handler.close(localName(qualified), this.open.length + 1);
  }

  /** Reads the construct that starts with `<` at the current position; `next` is the code point after it. */
  private readMarkupAt(next: number): void {
    if (next === CH_BANG) {
      this.readDeclaration();
    } else if (next === CH_QUESTION) {
      this.readProcessingInstruction();
    } else if (next === CH_SLASH) {
      this.readCloseTag();
    } else {
      this.readOpenTag();
    }
  }

  run(): void {
    while (this.pos < this.length) {
      const lt = this.source.indexOf('<', this.pos);
      if (lt === -1) {
        this.emitText(this.pos, this.length);
        break;
      }
      this.emitText(this.pos, lt);
      this.pos = lt;
      this.readMarkupAt(this.codeAt(this.pos + 1));
    }
    const unclosed = this.open.at(-1);
    if (unclosed !== undefined) fail(`element <${unclosed}> is not closed`, this.length);
    if (!this.rootSeen) fail('the document has no root element', this.length);
  }
}

/**
 * Reads `source`, calling `handler` for every element and run of character data.
 * @throws OcrMarkupError for malformed markup or when a named limit is exceeded.
 */
export function readMarkup(source: string, handler: MarkupHandler, options: ReadMarkupOptions = {}): void {
  if (source.length > OCR_MARKUP_MAX_CHARS) {
    throw new OcrMarkupError(`Markup is larger than ${OCR_MARKUP_MAX_CHARS} characters.`);
  }
  assertXmlCharacters(source);
  new MarkupReader(source, handler, options.html === true).run();
}
