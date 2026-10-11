import sharp, { type Metadata } from 'sharp';
import { ConversionFailedError, EngineUnavailableError } from '../types';
import type { PdfBlock, PdfRasterImage, PdfTableCell } from './pdf-blocks';
import type { PdfTextSegment } from './pdf-fonts';
import { loadExternalImages, type ImageCaps } from './html-image-loader';
import { OmittedExternalImages, type HtmlResourcePolicy } from './html-omitted-resources';

/**
 * Parses HTML into the PDF block model: headings, paragraphs, lists, tables, links, preformatted
 * text, quotes, rules and embedded (data: URI) PNG/JPEG images. Content the in-process renderer
 * cannot draw is refused with a typed error instead of being dropped. The one exception is an image
 * that is not embedded: it is fetched and embedded first (see html-image-loader.ts), and one that cannot
 * be loaded is left out and reported (see HtmlResourcePolicy) unless the caller requires every resource.
 */

export interface HtmlElement {
  readonly tag: string;
  readonly attrs: ReadonlyMap<string, string>;
  readonly children: HtmlNode[];
  /** Inside SVG or MathML, where `/>` closes an element. */
  readonly foreign?: boolean;
}

export type HtmlNode = HtmlElement | string;

/** A parsed document: the element tree and the text of its <title>. */
export interface ParsedHtmlDocument {
  readonly root: HtmlElement;
  readonly title?: string;
}

export interface HtmlDocumentBlocks {
  /** Text of the <title> element, for PDF metadata. */
  title?: string;
  blocks: PdfBlock[];
  /** One line per external image that could not be loaded and was left out (see HtmlResourcePolicy); empty when none was. */
  warnings: string[];
}

const MAX_NESTING_DEPTH = 256;
const HEX_RADIX = 16;
const DECIMAL_RADIX = 10;
const MAX_CODE_POINT = 0x10ffff;
const REPLACEMENT_CHARACTER = '�';
const SURROGATE_FIRST = 0xd800;
const SURROGATE_LAST = 0xdfff;
const DEFAULT_LIST_START = 1;
const STYLE_ELEMENT = 'style';
const TITLE_ELEMENT = 'title';
/** Raw-text elements whose content is kept as text: textarea decodes character references, xmp does not. */
const TEXTAREA_ELEMENT = 'textarea';
const XMP_ELEMENT = 'xmp';
/** Roots of foreign content (SVG, MathML), where a start tag ending in `/>` has no content. */
const FOREIGN_ROOTS: ReadonlySet<string> = new Set(['svg', 'math']);
/** Largest colspan honoured, as in HTML (larger values are clamped). */
const MAX_COLUMN_SPAN = 1000;
const COMMENT_OPEN = '<!--';

const VOID_ELEMENTS: ReadonlySet<string> = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr',
]);
/** Elements whose content is raw text up to the matching end tag. */
const RAW_TEXT_ELEMENTS: ReadonlySet<string> = new Set([
  'script', 'style', 'title', 'textarea', 'xmp', 'iframe', 'noembed', 'noframes',
]);
/** Elements that are never displayed. */
const HIDDEN_ELEMENTS: ReadonlySet<string> = new Set([
  'head', 'script', 'style', 'template', 'noembed', 'noframes', 'meta', 'link', 'base', 'title', 'noscript',
]);
/** Embedded or interactive content the in-process renderer cannot draw. */
const UNSUPPORTED_ELEMENTS: ReadonlySet<string> = new Set([
  'svg', 'math', 'canvas', 'video', 'audio', 'iframe', 'object', 'embed', 'select', 'textarea', 'xmp',
]);
/** Opening any of these closes an open <p>. */
const PARAGRAPH_CLOSERS: ReadonlySet<string> = new Set([
  'address', 'article', 'aside', 'blockquote', 'center', 'details', 'dialog', 'dir', 'div', 'dl', 'dd', 'dt',
  'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hgroup',
  'hr', 'li', 'main', 'menu', 'nav', 'ol', 'p', 'pre', 'section', 'summary', 'table', 'ul',
]);
/** Elements that stop the search for an open <p> to close. */
const PARAGRAPH_SCOPE: ReadonlySet<string> = new Set(['table', 'td', 'th', 'caption', 'button', 'object', 'template']);
const PARAGRAPH: ReadonlySet<string> = new Set(['p']);
const LIST_ITEM: ReadonlySet<string> = new Set(['li']);
const DEFINITION_ITEMS: ReadonlySet<string> = new Set(['dt', 'dd']);
const DEFINITION_LIST: ReadonlySet<string> = new Set(['dl']);
const TABLE: ReadonlySet<string> = new Set(['table']);
const TABLE_ROW: ReadonlySet<string> = new Set(['tr']);
const TABLE_ROW_SCOPE: ReadonlySet<string> = new Set(['table', 'thead', 'tbody', 'tfoot']);
const TABLE_CELL_SCOPE: ReadonlySet<string> = new Set(['tr', 'table']);
const OPTION: ReadonlySet<string> = new Set(['option']);
const SELECT: ReadonlySet<string> = new Set(['select']);
const HEADING_ELEMENTS: ReadonlySet<string> = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
const TABLE_SECTION_ELEMENTS: ReadonlySet<string> = new Set(['thead', 'tbody', 'tfoot']);
const TABLE_CELL_ELEMENTS: ReadonlySet<string> = new Set(['td', 'th']);
const TABLE_COLUMN_ELEMENTS: ReadonlySet<string> = new Set(['colgroup', 'col']);
const LIST_ELEMENTS: ReadonlySet<string> = new Set(['ul', 'ol', 'menu', 'dir']);
const PREFORMATTED_ELEMENTS: ReadonlySet<string> = new Set(['pre', 'listing', 'plaintext']);
/** Elements laid out as blocks (their content starts on a new line). */
const BLOCK_ELEMENTS: ReadonlySet<string> = new Set([
  'html', 'body', 'address', 'article', 'aside', 'center', 'details', 'dialog', 'div', 'dl', 'dd', 'dt', 'fieldset',
  'figcaption', 'figure', 'footer', 'form', 'header', 'hgroup', 'legend', 'main', 'nav', 'section', 'summary',
  'caption', 'p', 'table', 'blockquote', 'hr', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol',
  'menu', 'dir', 'pre', 'listing', 'plaintext',
]);
const ALLOWED_IMAGE_FORMATS: ReadonlySet<string> = new Set(['png', 'jpeg']);
/** Largest embedded image, in pixels, the in-process renderer decodes. */
export const MAX_IMAGE_PIXELS = 25_000_000;
const JPEG_REENCODE_QUALITY = 95;
/** An inline style that hides the element (CSS display: none). */
const DISPLAY_NONE = /(?:^|;)\s*display\s*:\s*none\s*(?:!\s*important\s*)?(?:;|$)/i;
/** Characters a PDF URI action must not carry raw: anything outside printable ASCII (PDF 32000-1, 12.6.4.7). */
const NON_URI_CHARACTER = /[^\x21-\x7e]/gu;
/** Link targets kept as PDF link annotations; other targets keep their text without a link. */
const LINK_SCHEMES = /^(?:https?|mailto):/i;
const DATA_URI = /^data:([^,]*),(.*)$/is;
const BASE64_BODY = /^[A-Za-z0-9+/]*={0,2}$/;
const SPACE_CHARACTER = ' ';
const LINE_BREAK = '\n';
const HTML_WHITESPACE = /[ \t\n\f\r]+/g;
const TAG_NAME_END = /[\s/>]/;
const ATTRIBUTE_NAME_END = /[\s/>=]/;
const UNQUOTED_VALUE_END = /[\s>]/;
const ATTRIBUTE_GAP = /[\s/]/;
const SPACE = /\s/;
const ASCII_LETTER = /[A-Za-z]/;

/** HTML named character references (the HTML 4 set plus &apos;), name to code point in hex. */
const NAMED_ENTITY_TABLE =
  'quot:22 amp:26 apos:27 lt:3c gt:3e nbsp:a0 iexcl:a1 cent:a2 pound:a3 curren:a4 yen:a5 brvbar:a6 sect:a7 uml:a8 ' +
  'copy:a9 ordf:aa laquo:ab not:ac shy:ad reg:ae macr:af deg:b0 plusmn:b1 sup2:b2 sup3:b3 acute:b4 micro:b5 ' +
  'para:b6 middot:b7 cedil:b8 sup1:b9 ordm:ba raquo:bb frac14:bc frac12:bd frac34:be iquest:bf Agrave:c0 ' +
  'Aacute:c1 Acirc:c2 Atilde:c3 Auml:c4 Aring:c5 AElig:c6 Ccedil:c7 Egrave:c8 Eacute:c9 Ecirc:ca Euml:cb ' +
  'Igrave:cc Iacute:cd Icirc:ce Iuml:cf ETH:d0 Ntilde:d1 Ograve:d2 Oacute:d3 Ocirc:d4 Otilde:d5 Ouml:d6 ' +
  'times:d7 Oslash:d8 Ugrave:d9 Uacute:da Ucirc:db Uuml:dc Yacute:dd THORN:de szlig:df agrave:e0 aacute:e1 ' +
  'acirc:e2 atilde:e3 auml:e4 aring:e5 aelig:e6 ccedil:e7 egrave:e8 eacute:e9 ecirc:ea euml:eb igrave:ec ' +
  'iacute:ed icirc:ee iuml:ef eth:f0 ntilde:f1 ograve:f2 oacute:f3 ocirc:f4 otilde:f5 ouml:f6 divide:f7 ' +
  'oslash:f8 ugrave:f9 uacute:fa ucirc:fb uuml:fc yacute:fd thorn:fe yuml:ff OElig:152 oelig:153 Scaron:160 ' +
  'scaron:161 Yuml:178 fnof:192 circ:2c6 tilde:2dc Alpha:391 Beta:392 Gamma:393 Delta:394 Epsilon:395 ' +
  'Zeta:396 Eta:397 Theta:398 Iota:399 Kappa:39a Lambda:39b Mu:39c Nu:39d Xi:39e Omicron:39f Pi:3a0 Rho:3a1 ' +
  'Sigma:3a3 Tau:3a4 Upsilon:3a5 Phi:3a6 Chi:3a7 Psi:3a8 Omega:3a9 alpha:3b1 beta:3b2 gamma:3b3 delta:3b4 ' +
  'epsilon:3b5 zeta:3b6 eta:3b7 theta:3b8 iota:3b9 kappa:3ba lambda:3bb mu:3bc nu:3bd xi:3be omicron:3bf ' +
  'pi:3c0 rho:3c1 sigmaf:3c2 sigma:3c3 tau:3c4 upsilon:3c5 phi:3c6 chi:3c7 psi:3c8 omega:3c9 thetasym:3d1 ' +
  'upsih:3d2 piv:3d6 ensp:2002 emsp:2003 thinsp:2009 zwnj:200c zwj:200d lrm:200e rlm:200f ndash:2013 ' +
  'mdash:2014 lsquo:2018 rsquo:2019 sbquo:201a ldquo:201c rdquo:201d bdquo:201e dagger:2020 Dagger:2021 ' +
  'bull:2022 hellip:2026 permil:2030 prime:2032 Prime:2033 lsaquo:2039 rsaquo:203a oline:203e frasl:2044 ' +
  'euro:20ac image:2111 weierp:2118 real:211c trade:2122 alefsym:2135 larr:2190 uarr:2191 rarr:2192 darr:2193 ' +
  'harr:2194 crarr:21b5 lArr:21d0 uArr:21d1 rArr:21d2 dArr:21d3 hArr:21d4 forall:2200 part:2202 exist:2203 ' +
  'empty:2205 nabla:2207 isin:2208 notin:2209 ni:220b prod:220f sum:2211 minus:2212 lowast:2217 radic:221a ' +
  'prop:221d infin:221e ang:2220 and:2227 or:2228 cap:2229 cup:222a int:222b there4:2234 sim:223c cong:2245 ' +
  'asymp:2248 ne:2260 equiv:2261 le:2264 ge:2265 sub:2282 sup:2283 nsub:2284 sube:2286 supe:2287 oplus:2295 ' +
  'otimes:2297 perp:22a5 sdot:22c5 lceil:2308 rceil:2309 lfloor:230a rfloor:230b lang:27e8 rang:27e9 loz:25ca ' +
  'spades:2660 clubs:2663 hearts:2665 diams:2666 AMP:26 COPY:a9 GT:3e LT:3c QUOT:22 REG:ae';

/** Names HTML also decodes without a semicolon (the legacy references of the HTML named character reference table). */
const LEGACY_ENTITY_NAMES: ReadonlySet<string> = new Set(
  (
    'AElig AMP Aacute Acirc Agrave Aring Atilde Auml COPY Ccedil ETH Eacute Ecirc Egrave Euml GT Iacute Icirc Igrave ' +
    'Iuml LT Ntilde Oacute Ocirc Ograve Oslash Otilde Ouml QUOT REG THORN Uacute Ucirc Ugrave Uuml Yacute aacute acirc ' +
    'acute aelig agrave amp aring atilde auml brvbar ccedil cedil cent copy curren deg divide eacute ecirc egrave eth ' +
    'euml frac12 frac14 frac34 gt iacute icirc iexcl igrave iquest iuml laquo lt macr micro middot nbsp not ntilde ' +
    'oacute ocirc ograve ordf ordm oslash otilde ouml para plusmn pound quot raquo reg sect shy sup1 sup2 sup3 szlig ' +
    'thorn times uacute ucirc ugrave uml uuml yacute yen yuml'
  ).split(' ')
);
const MIN_LEGACY_NAME_LENGTH = 2;
const MAX_LEGACY_NAME_LENGTH = 6;
/** A character after a semicolon-less reference in an attribute value that keeps it literal. */
const ATTRIBUTE_REFERENCE_GUARD = /^[=A-Za-z0-9]$/;

const NAMED_ENTITIES: ReadonlyMap<string, string> = new Map(
  NAMED_ENTITY_TABLE.split(' ').map((entry) => {
    const [name, hex] = entry.split(':');
    return [name, String.fromCodePoint(Number.parseInt(hex, HEX_RADIX))];
  })
);

const CHARACTER_REFERENCE = /&(?:#[xX]([0-9a-fA-F]{1,8});?|#([0-9]{1,10});?|([A-Za-z][A-Za-z0-9]{1,31})(;?))/g;

function decodeCodePoint(value: number): string {
  if (value === 0 || value > MAX_CODE_POINT || (value >= SURROGATE_FIRST && value <= SURROGATE_LAST)) {
    return REPLACEMENT_CHARACTER;
  }
  return String.fromCodePoint(value);
}

/**
 * A named reference as HTML reads it: the full name when it ends in a semicolon, otherwise the
 * longest legacy name it starts with (`&copy2025` is ©2025, `&notit` is ¬it). In an attribute value
 * a semicolon-less reference followed by '=' or a letter or digit stays literal (`?a=1&copy=2`).
 */
function decodeNamedReference(match: string, name: string, semicolon: string, following: string | undefined, inAttribute: boolean): string {
  if (semicolon && NAMED_ENTITIES.has(name)) return NAMED_ENTITIES.get(name) as string;
  for (let length = Math.min(name.length, MAX_LEGACY_NAME_LENGTH); length >= MIN_LEGACY_NAME_LENGTH; length--) {
    const legacy = name.slice(0, length);
    if (!LEGACY_ENTITY_NAMES.has(legacy)) continue;
    const next = length < name.length ? name[length] : semicolon || following;
    if (inAttribute && next !== undefined && ATTRIBUTE_REFERENCE_GUARD.test(next)) return match;
    return (NAMED_ENTITIES.get(legacy) as string) + name.slice(length) + semicolon;
  }
  return match;
}

/** Decodes numeric and named character references; unknown names stay literal, as in HTML. */
export function decodeHtmlCharacterReferences(text: string, inAttribute = false): string {
  if (!text.includes('&')) return text;
  return text.replace(
    CHARACTER_REFERENCE,
    (match: string, hex: string | undefined, decimal: string | undefined, name: string | undefined, semicolon: string | undefined, offset: number) => {
      if (hex !== undefined) return decodeCodePoint(Number.parseInt(hex, HEX_RADIX));
      if (decimal !== undefined) return decodeCodePoint(Number.parseInt(decimal, DECIMAL_RADIX));
      if (name === undefined) return match;
      return decodeNamedReference(match, name, semicolon ?? '', text[offset + match.length], inAttribute);
    }
  );
}

class HtmlTreeBuilder {
  readonly root: HtmlElement = { tag: '#root', attrs: new Map(), children: [] };
  private readonly stack: HtmlElement[] = [this.root];
  title?: string;

  private get current(): HtmlElement {
    return this.stack[this.stack.length - 1];
  }

  text(value: string): void {
    if (value.length > 0) this.current.children.push(decodeHtmlCharacterReferences(value));
  }

  /** Pops up to and including the nearest open element named in `tags`, unless a boundary comes first. */
  private closeOpen(tags: ReadonlySet<string>, boundaries?: ReadonlySet<string>): void {
    for (let i = this.stack.length - 1; i > 0; i--) {
      const tag = this.stack[i].tag;
      if (tags.has(tag)) {
        this.stack.length = i;
        return;
      }
      if (boundaries?.has(tag)) return;
    }
  }

  /** Whether a start tag `tag` here would be foreign content. */
  isForeign(tag: string): boolean {
    return FOREIGN_ROOTS.has(tag) || this.current.foreign === true;
  }

  start(tag: string, attrs: Map<string, string>, selfClosing = false): void {
    if (PARAGRAPH_CLOSERS.has(tag)) this.closeOpen(PARAGRAPH, PARAGRAPH_SCOPE);
    if (HEADING_ELEMENTS.has(tag) && HEADING_ELEMENTS.has(this.current.tag)) this.stack.pop();
    if (tag === 'li') this.closeOpen(LIST_ITEM, LIST_ELEMENTS);
    if (DEFINITION_ITEMS.has(tag)) this.closeOpen(DEFINITION_ITEMS, DEFINITION_LIST);
    if (TABLE_SECTION_ELEMENTS.has(tag)) this.closeOpen(TABLE_SECTION_ELEMENTS, TABLE);
    if (tag === 'tr') this.closeOpen(TABLE_ROW, TABLE_ROW_SCOPE);
    if (TABLE_CELL_ELEMENTS.has(tag)) this.closeOpen(TABLE_CELL_ELEMENTS, TABLE_CELL_SCOPE);
    if (tag === 'option') this.closeOpen(OPTION, SELECT);

    const foreign = this.isForeign(tag);
    const element: HtmlElement = { tag, attrs, children: [], foreign };
    this.current.children.push(element);
    if (VOID_ELEMENTS.has(tag) || (selfClosing && foreign)) return;
    if (this.stack.length >= MAX_NESTING_DEPTH) {
      throw new ConversionFailedError(`HTML nests elements deeper than ${MAX_NESTING_DEPTH} levels`);
    }
    this.stack.push(element);
  }

  rawText(tag: string, attrs: Map<string, string>, content: string): void {
    if (tag === TITLE_ELEMENT && this.title === undefined && !this.isForeign(tag)) {
      this.title = decodeHtmlCharacterReferences(content).replace(HTML_WHITESPACE, ' ').trim();
    }
    this.start(tag, attrs);
    // Style sheets are kept as raw text (never drawn) so their url() and @import references can be checked;
    // textarea and xmp content is kept as text, which is all it ever is.
    if (content.length > 0) {
      if (tag === STYLE_ELEMENT || tag === XMP_ELEMENT) this.current.children.push(content);
      else if (tag === TEXTAREA_ELEMENT) this.current.children.push(decodeHtmlCharacterReferences(content));
    }
    this.end(tag);
  }

  end(tag: string): void {
    if (tag === 'br') {
      this.start('br', new Map());
      return;
    }
    for (let i = this.stack.length - 1; i > 0; i--) {
      if (this.stack[i].tag === tag) {
        this.stack.length = i;
        return;
      }
    }
  }
}

/**
 * Reads attributes from just after the tag name; returns them with the index of the closing '>'
 * and whether the tag ends in a self-closing `/>` (a '/' inside an unquoted value does not count).
 */
function parseAttributes(source: string, from: number): { attrs: Map<string, string>; end: number; selfClosing: boolean } {
  const attrs = new Map<string, string>();
  const length = source.length;
  let i = from;
  let selfClosing = false;
  while (i < length) {
    const gapStart = i;
    while (i < length && ATTRIBUTE_GAP.test(source[i])) i++;
    if (i >= length || source[i] === '>') {
      selfClosing = i < length && i > gapStart && source[i - 1] === '/';
      break;
    }
    const nameStart = i;
    while (i < length && !ATTRIBUTE_NAME_END.test(source[i])) i++;
    const name = asciiLowerCase(source.slice(nameStart, i));
    while (i < length && SPACE.test(source[i])) i++;
    let value = '';
    if (source[i] === '=') {
      i++;
      while (i < length && SPACE.test(source[i])) i++;
      const quote = source[i];
      if (quote === '"' || quote === "'") {
        const close = source.indexOf(quote, i + 1);
        const stop = close < 0 ? length : close;
        value = source.slice(i + 1, stop);
        i = stop + 1;
      } else {
        const valueStart = i;
        while (i < length && !UNQUOTED_VALUE_END.test(source[i])) i++;
        value = source.slice(valueStart, i);
      }
    }
    if (name && !attrs.has(name)) attrs.set(name, decodeHtmlCharacterReferences(value, true));
  }
  return { attrs, end: i, selfClosing };
}

/**
 * Index just past the comment whose text starts at `from`, as HTML ends comments: `<!-->` and
 * `<!--->` are empty comments, and `-->` or `--!>` closes any other. An unclosed comment runs to the end.
 */
function commentEnd(html: string, from: number): number {
  if (html[from] === '>') return from + 1;
  if (html[from] === '-' && html[from + 1] === '>') return from + 2;
  let dashes = html.indexOf('--', from);
  while (dashes >= 0) {
    if (html[dashes + 2] === '>') return dashes + 3;
    if (html[dashes + 2] === '!' && html[dashes + 3] === '>') return dashes + 4;
    dashes = html.indexOf('--', dashes + 1);
  }
  return html.length;
}

/**
 * Lowercases ASCII letters only. HTML tag and attribute names are ASCII-case-insensitive, and
 * keeping every other character (such as U+0130, whose full lowercase form is two code units)
 * keeps offsets into the lowercased copy valid for the original text.
 */
export function asciiLowerCase(text: string): string {
  return text.replace(/[A-Z]+/g, (letters) => letters.toLowerCase());
}

/** Index of the end tag `</tag` (followed by whitespace, '/' or '>') at or after `from`, or -1. */
function findRawTextEnd(lowerHtml: string, tag: string, from: number): number {
  const needle = `</${tag}`;
  let index = lowerHtml.indexOf(needle, from);
  while (index >= 0) {
    const after = lowerHtml[index + needle.length];
    if (after === undefined || TAG_NAME_END.test(after)) return index;
    index = lowerHtml.indexOf(needle, index + needle.length);
  }
  return -1;
}

/** Builds an element tree from HTML source with the HTML implied-end-tag rules used for layout. */
export function parseHtmlTree(html: string): ParsedHtmlDocument {
  const builder = new HtmlTreeBuilder();
  const lowerHtml = asciiLowerCase(html);
  const length = html.length;
  let i = 0;
  let textStart = 0;
  const flushText = (until: number): void => {
    if (until > textStart) builder.text(html.slice(textStart, until));
  };

  while (i < length) {
    const lt = html.indexOf('<', i);
    if (lt < 0) break;
    const next = html[lt + 1];
    if (html.startsWith(COMMENT_OPEN, lt)) {
      flushText(lt);
      i = commentEnd(html, lt + COMMENT_OPEN.length);
      textStart = i;
      continue;
    }
    if (next === '!' || next === '?') {
      flushText(lt);
      const close = html.indexOf('>', lt + 2);
      i = close < 0 ? length : close + 1;
      textStart = i;
      continue;
    }
    const isEnd = next === '/';
    const nameStart = isEnd ? lt + 2 : lt + 1;
    if (!ASCII_LETTER.test(html[nameStart] ?? '')) {
      i = lt + 1;
      continue;
    }
    flushText(lt);
    let nameEnd = nameStart;
    while (nameEnd < length && !TAG_NAME_END.test(html[nameEnd])) nameEnd++;
    const tag = lowerHtml.slice(nameStart, nameEnd);
    const { attrs, end, selfClosing } = parseAttributes(html, nameEnd);
    i = Math.min(end + 1, length);
    textStart = i;

    if (isEnd) {
      builder.end(tag);
      continue;
    }
    if (RAW_TEXT_ELEMENTS.has(tag) && !(selfClosing && builder.isForeign(tag))) {
      const contentEnd = findRawTextEnd(lowerHtml, tag, i);
      const stop = contentEnd < 0 ? length : contentEnd;
      builder.rawText(tag, attrs, html.slice(i, stop));
      const closeEnd = contentEnd < 0 ? -1 : html.indexOf('>', contentEnd);
      i = closeEnd < 0 ? length : closeEnd + 1;
      textStart = i;
      continue;
    }
    builder.start(tag, attrs, selfClosing);
  }
  flushText(length);
  return builder;
}

function unsupported(what: string): EngineUnavailableError {
  return new EngineUnavailableError(
    'soffice',
    `HTML ${what} cannot be drawn by the in-process PDF renderer; rendering it needs the native LibreOffice engine`
  );
}

function externalImageRefusal(src: string): ConversionFailedError {
  return new ConversionFailedError(
    `HTML image "${src}" is an external reference that was not loaded; embed the image as a data: URI`
  );
}

function decodeImageSource(src: string): Buffer {
  const match = DATA_URI.exec(src.trim());
  if (!match) throw externalImageRefusal(src);
  const body = match[2].replace(/\s+/g, '');
  if (!/;base64$/i.test(match[1]) || !BASE64_BODY.test(body)) {
    throw new ConversionFailedError('HTML data: URI image must be base64-encoded PNG or JPEG data');
  }
  return Buffer.from(body, 'base64');
}

/** The colspan of a table cell: a whole number from 1 to MAX_COLUMN_SPAN, 1 when absent or invalid. */
function columnSpan(cell: HtmlElement): number {
  const span = Number.parseInt(cell.attrs.get('colspan') ?? '', DECIMAL_RADIX);
  if (!Number.isFinite(span) || span < 1) return 1;
  return Math.min(span, MAX_COLUMN_SPAN);
}

/** Whether the element is never displayed: hidden elements, the hidden attribute, or display: none. */
function isHidden(node: HtmlElement): boolean {
  return HIDDEN_ELEMENTS.has(node.tag) || node.attrs.has('hidden') || DISPLAY_NONE.test(node.attrs.get('style') ?? '');
}

/** Percent-encodes characters outside printable ASCII as UTF-8; undefined when the target is not encodable. */
function encodeLinkTarget(href: string): string | undefined {
  try {
    return href.replace(NON_URI_CHARACTER, (ch) => encodeURIComponent(ch));
  } catch {
    return undefined;
  }
}

function appendAll<T>(target: T[], items: readonly T[]): void {
  for (const item of items) target.push(item);
}

interface InlineContext {
  readonly segments: PdfTextSegment[];
  /** Images met inside inline content, drawn after the paragraph that holds them. */
  readonly images: HtmlElement[];
}

interface PendingImage {
  readonly block: { kind: 'image'; image: PdfRasterImage };
  readonly bytes: Buffer;
}

class HtmlBlockBuilder {
  readonly images: PendingImage[] = [];


  private isBlock(node: HtmlNode): node is HtmlElement {
    return typeof node !== 'string' && BLOCK_ELEMENTS.has(node.tag);
  }

  private assertDrawable(node: HtmlElement): void {
    if (UNSUPPORTED_ELEMENTS.has(node.tag)) throw unsupported(`<${node.tag}>`);
    if (node.tag === 'input' && (node.attrs.get('type') ?? '').toLowerCase() !== 'hidden') throw unsupported('<input>');
  }

  /** Collects a node's inline content; block elements inside inline content start on a new line. */
  private inline(node: HtmlNode, link: string | undefined, context: InlineContext, preserve: boolean): void {
    if (typeof node === 'string') {
      context.segments.push({ text: preserve ? node : node.replace(HTML_WHITESPACE, ' '), link });
      return;
    }
    if (isHidden(node)) return;
    this.assertDrawable(node);
    if (node.tag === 'br') {
      context.segments.push({ text: '\n', link });
      return;
    }
    if (node.tag === 'img') {
      context.images.push(node);
      return;
    }
    const href = node.tag === 'a' ? node.attrs.get('href')?.trim() : undefined;
    const childLink = href && LINK_SCHEMES.test(href) ? encodeLinkTarget(href) ?? link : link;
    const childPreserve = preserve || PREFORMATTED_ELEMENTS.has(node.tag);
    const block = this.isBlock(node);
    if (block) context.segments.push({ text: '\n' });
    for (const child of node.children) this.inline(child, childLink, context, childPreserve);
    if (block) context.segments.push({ text: '\n' });
    // Table parts met inside inline content keep their cells apart: a space after a cell, a line break after a row.
    if (TABLE_CELL_ELEMENTS.has(node.tag)) context.segments.push({ text: ' ' });
    if (node.tag === 'tr') context.segments.push({ text: '\n' });
  }

  /**
   * Joins segments that share a link, drops collapsible spaces next to line breaks and at the
   * ends, and drops leading and trailing line breaks, in one linear pass.
   */
  private tidy(segments: readonly PdfTextSegment[]): PdfTextSegment[] {
    const tidied: PdfTextSegment[] = [];
    let text = '';
    let link: string | undefined;
    const emit = (piece: string, pieceLink: string | undefined): void => {
      if (pieceLink !== link) {
        if (text) tidied.push({ text, link });
        text = '';
        link = pieceLink;
      }
      text += piece;
    };
    let started = false;
    let pendingBreaks = '';
    let pendingSpaceLink: string | undefined;
    let pendingSpace = false;
    for (const segment of segments) {
      for (const ch of segment.text) {
        if (ch === SPACE_CHARACTER) {
          if (started && !pendingBreaks && !pendingSpace) {
            pendingSpace = true;
            pendingSpaceLink = segment.link;
          }
          continue;
        }
        if (ch === LINE_BREAK) {
          pendingSpace = false;
          if (started) pendingBreaks += LINE_BREAK;
          continue;
        }
        if (pendingBreaks) {
          emit(pendingBreaks, undefined);
        } else if (pendingSpace) {
          emit(SPACE_CHARACTER, pendingSpaceLink);
        }
        pendingBreaks = '';
        pendingSpace = false;
        emit(ch, segment.link);
        started = true;
      }
    }
    if (text) tidied.push({ text, link });
    return tidied;
  }

  private inlineContent(nodes: readonly HtmlNode[], images: HtmlElement[]): PdfTextSegment[] {
    const context: InlineContext = { segments: [], images };
    for (const node of nodes) this.inline(node, undefined, context, false);
    return this.tidy(context.segments);
  }

  /** Lays out children as blocks; runs of inline content between blocks become paragraphs. */
  blocks(nodes: readonly HtmlNode[]): PdfBlock[] {
    const blocks: PdfBlock[] = [];
    let pendingInline: HtmlNode[] = [];
    const flush = (): void => {
      if (pendingInline.length === 0) return;
      const images: HtmlElement[] = [];
      const content = this.inlineContent(pendingInline, images);
      if (content.length > 0) blocks.push({ kind: 'paragraph', content });
      for (const image of images) appendAll(blocks, this.imageBlocks(image));
      pendingInline = [];
    };
    for (const node of nodes) {
      if (this.isBlock(node) && !isHidden(node)) {
        flush();
        appendAll(blocks, this.block(node));
      } else {
        pendingInline.push(node);
      }
    }
    flush();
    return blocks;
  }

  private block(node: HtmlElement): PdfBlock[] {
    if (HEADING_ELEMENTS.has(node.tag)) {
      const images: HtmlElement[] = [];
      const content = this.inlineContent(node.children, images);
      const heading: PdfBlock[] = content.length > 0 ? [{ kind: 'heading', level: Number(node.tag.slice(1)), content }] : [];
      return [...heading, ...images.flatMap((image) => this.imageBlocks(image))];
    }
    if (PREFORMATTED_ELEMENTS.has(node.tag)) return this.preformatted(node);
    if (LIST_ELEMENTS.has(node.tag)) return [this.list(node)];
    if (node.tag === 'table') return this.table(node);
    if (node.tag === 'blockquote') return [{ kind: 'quote', blocks: this.blocks(node.children) }];
    if (node.tag === 'hr') return [{ kind: 'rule' }];
    return this.blocks(node.children);
  }

  private preformatted(node: HtmlElement): PdfBlock[] {
    const context: InlineContext = { segments: [], images: [] };
    for (const child of node.children) this.inline(child, undefined, context, true);
    if (context.images.length > 0) throw unsupported('<img> inside <pre>');
    // A line break right after <pre> is not part of the content.
    const text = context.segments.map((segment) => segment.text).join('').replace(/^\r?\n/, '');
    return text.length > 0 ? [{ kind: 'preformatted', text }] : [];
  }

  private list(node: HtmlElement): PdfBlock {
    const start = Number.parseInt(node.attrs.get('start') ?? '', DECIMAL_RADIX);
    const items: PdfBlock[][] = [];
    let loose: HtmlNode[] = [];
    for (const child of node.children) {
      if (typeof child !== 'string' && child.tag === 'li') {
        if (loose.length > 0) items.push(this.blocks(loose));
        loose = [];
        if (!isHidden(child)) items.push(this.blocks(child.children));
      } else if (typeof child !== 'string' || child.trim().length > 0) {
        loose.push(child);
      }
    }
    if (loose.length > 0) items.push(this.blocks(loose));
    return {
      kind: 'list',
      ordered: node.tag === 'ol',
      start: Number.isFinite(start) ? start : DEFAULT_LIST_START,
      items: items.filter((item) => item.length > 0),
    };
  }

  /** Rows of the table; content placed directly in the table is drawn before it, as browsers do. */
  private table(node: HtmlElement): PdfBlock[] {
    const before: PdfBlock[] = [];
    const rows: PdfTableCell[][] = [];
    const visit = (element: HtmlElement): void => {
      for (const child of element.children) {
        if (typeof child === 'string') {
          if (child.trim().length > 0) appendAll(before, this.blocks([child]));
        } else if (TABLE_SECTION_ELEMENTS.has(child.tag)) {
          visit(child);
        } else if (child.tag === 'tr') {
          if (!isHidden(child)) rows.push(this.row(child, before));
        } else if (!TABLE_COLUMN_ELEMENTS.has(child.tag)) {
          appendAll(before, this.blocks(child.tag === 'caption' ? child.children : [child]));
        }
      }
    };
    visit(node);
    return rows.length > 0 ? [...before, { kind: 'table', rows }] : before;
  }

  private row(tr: HtmlElement, before: PdfBlock[]): PdfTableCell[] {
    const cells: PdfTableCell[] = [];
    for (const child of tr.children) {
      if (typeof child !== 'string' && TABLE_CELL_ELEMENTS.has(child.tag)) {
        cells.push({ content: this.cellContent(child), span: columnSpan(child) });
      } else if (typeof child !== 'string' || child.trim().length > 0) {
        appendAll(before, this.blocks([child]));
      }
    }
    return cells;
  }

  /** A table cell's content as one text flow; nested blocks are separated by line breaks. */
  private cellContent(cell: HtmlElement): PdfTextSegment[] {
    const segments: PdfTextSegment[] = [];
    const append = (blocks: readonly PdfBlock[]): void => {
      for (const block of blocks) {
        if (block.kind === 'rule') continue;
        if (segments.length > 0) segments.push({ text: '\n' });
        if (block.kind === 'paragraph' || block.kind === 'heading') {
          appendAll(segments, block.content);
        } else if (block.kind === 'preformatted') {
          segments.push({ text: block.text });
        } else if (block.kind === 'list') {
          block.items.forEach((item) => append(item));
        } else if (block.kind === 'quote') {
          append(block.blocks);
        } else {
          throw unsupported(block.kind === 'table' ? 'tables nested in table cells' : '<img> inside table cells');
        }
      }
    };
    append(this.blocks(cell.children));
    return segments;
  }

  /** The image block of an `<img>`. External images are already out of the tree (see parseHtmlToPdfBlocks). */
  private imageBlocks(node: HtmlElement): PdfBlock[] {
    const src = node.attrs.get('src');
    if (!src) throw new ConversionFailedError('HTML <img> has no src attribute');
    return [this.image(node, src)];
  }

  private image(node: HtmlElement, src: string): PdfBlock {
    const block = { kind: 'image' as const, image: { data: Buffer.alloc(0), widthPx: 0, heightPx: 0 } };
    this.images.push({ block, bytes: decodeImageSource(src) });
    return block;
  }
}

/** JPEG markers: start of image, and the frame types a PDF DCTDecode filter reads (baseline, extended, progressive). */
const JPEG_SOI = 0xffd8;
const JPEG_MARKER = 0xff;
const PDF_JPEG_FRAMES: ReadonlySet<number> = new Set([0xc0, 0xc1, 0xc2]);
/** Frame markers of every JPEG coding process (SOF0 to SOF15, which excludes DHT, JPG and DAC). */
const JPEG_FRAMES: ReadonlySet<number> = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
/** Markers without a length field. */
const JPEG_STANDALONE: ReadonlySet<number> = new Set([0x01, 0xd0, 0xd1, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7]);
const JPEG_PASSTHROUGH_SPACES: ReadonlySet<string> = new Set(['srgb', 'b-w']);
const EIGHT_BIT_DEPTH = 'uchar';
const UPRIGHT_ORIENTATION = 1;
const LOSSLESS_JPEG_QUALITY = 100;
/** Most images one document may embed, and the most pixels they may hold together. */
export const MAX_IMAGES_PER_DOCUMENT = 64;
export const MAX_DOCUMENT_IMAGE_PIXELS = 100_000_000;
/** What the loader of external images may add to a document: the limits of this renderer and of the staging for LibreOffice. */
export const HTML_IMAGE_CAPS: ImageCaps = {
  maxImages: MAX_IMAGES_PER_DOCUMENT,
  maxImagePixels: MAX_IMAGE_PIXELS,
  maxDocumentPixels: MAX_DOCUMENT_IMAGE_PIXELS,
};

/** The frame marker of a JPEG (0xC0 for baseline...), or null when none is found. */
function jpegFrameMarker(data: Buffer): number | null {
  if (data.length < 4 || data.readUInt16BE(0) !== JPEG_SOI) return null;
  let offset = 2;
  while (offset + 4 <= data.length && data[offset] === JPEG_MARKER) {
    const marker = data[offset + 1];
    if (JPEG_FRAMES.has(marker)) return marker;
    if (JPEG_STANDALONE.has(marker) || marker === JPEG_MARKER) {
      offset += marker === JPEG_MARKER ? 1 : 2;
      continue;
    }
    offset += 2 + data.readUInt16BE(offset + 2);
  }
  return null;
}

/**
 * Whether a JPEG can go into the PDF unchanged: upright, 8-bit sRGB or grayscale, no ICC profile,
 * and a baseline, extended or progressive frame.
 */
function canEmbedJpegAsIs(data: Buffer, metadata: Metadata): boolean {
  const frame = jpegFrameMarker(data);
  return (
    (metadata.orientation ?? UPRIGHT_ORIENTATION) === UPRIGHT_ORIENTATION &&
    metadata.depth === EIGHT_BIT_DEPTH &&
    JPEG_PASSTHROUGH_SPACES.has(metadata.space ?? '') &&
    !metadata.icc &&
    frame !== null &&
    PDF_JPEG_FRAMES.has(frame)
  );
}

/**
 * Checks every embedded image from its header before decoding any: only PNG and JPEG, at most
 * MAX_IMAGE_PIXELS each, at most MAX_IMAGES_PER_DOCUMENT and MAX_DOCUMENT_IMAGE_PIXELS together.
 * A JPEG that a PDF can carry unchanged is embedded byte for byte after one verifying decode;
 * other images are decoded once into 8-bit sRGB with the orientation tag applied (PNG stays PNG,
 * JPEG is re-encoded at quality 100 without chroma subsampling).
 */
async function verifyImages(images: readonly PendingImage[]): Promise<void> {
  if (images.length > MAX_IMAGES_PER_DOCUMENT) {
    throw new ConversionFailedError(
      `HTML embeds ${images.length} images; the in-process PDF renderer draws at most ${MAX_IMAGES_PER_DOCUMENT} per document`
    );
  }
  const headers: Metadata[] = [];
  let totalPixels = 0;
  for (const pending of images) {
    let metadata: Metadata;
    try {
      // The header alone: pixel limits are checked before any pixel is decoded.
      metadata = await sharp(pending.bytes, { limitInputPixels: false }).metadata();
    } catch (err) {
      throw new ConversionFailedError(`HTML embedded image could not be read: ${(err as Error).message}`);
    }
    const format = metadata.format;
    if (!format || !ALLOWED_IMAGE_FORMATS.has(format)) throw unsupported(`<img> with ${format ?? 'unknown'} data`);
    const width = metadata.width ?? 0;
    const height = metadata.height ?? 0;
    if (width <= 0 || height <= 0) throw new ConversionFailedError('HTML embedded image declares no pixel size');
    if (width * height > MAX_IMAGE_PIXELS) {
      throw new ConversionFailedError(
        `HTML embedded image is ${width}x${height} pixels, above the ${MAX_IMAGE_PIXELS}-pixel limit of the in-process PDF renderer`
      );
    }
    totalPixels += width * height;
    headers.push(metadata);
  }
  if (totalPixels > MAX_DOCUMENT_IMAGE_PIXELS) {
    throw new ConversionFailedError(
      `HTML embeds images totalling ${totalPixels} pixels, above the ${MAX_DOCUMENT_IMAGE_PIXELS}-pixel limit per document`
    );
  }
  for (const [index, pending] of images.entries()) {
    const metadata = headers[index];
    try {
      const decoder = sharp(pending.bytes, { limitInputPixels: MAX_IMAGE_PIXELS });
      if (metadata.format === 'jpeg' && canEmbedJpegAsIs(pending.bytes, metadata)) {
        await decoder.raw().toBuffer();
        pending.block.image = { data: pending.bytes, widthPx: metadata.width ?? 0, heightPx: metadata.height ?? 0 };
        continue;
      }
      const pipeline = decoder.rotate().toColourspace('srgb');
      const encoded =
        metadata.format === 'png' ? pipeline.png() : pipeline.jpeg({ quality: LOSSLESS_JPEG_QUALITY, chromaSubsampling: '4:4:4' });
      const { data, info } = await encoded.toBuffer({ resolveWithObject: true });
      pending.block.image = { data, widthPx: info.width, heightPx: info.height };
    } catch (err) {
      throw new ConversionFailedError(`HTML embedded image could not be decoded: ${(err as Error).message}`);
    }
  }
}

/** Raster formats a document reader hands over that are redrawn as PNG because a PDF cannot carry them. */
const REDRAWN_IMAGE_FORMATS: ReadonlySet<string> = new Set(['gif', 'tiff', 'webp', 'heif']);

/**
 * One image of a document for the PDF writer, from the bytes of the source file. A JPEG a PDF can carry is embedded
 * byte for byte after one verifying decode; other PNG and JPEG images are decoded once into 8-bit sRGB with their
 * orientation applied; GIF, TIFF and WebP are redrawn as PNG (first frame). Larger than MAX_IMAGE_PIXELS, or in any
 * other format (BMP, SVG), is a typed error naming `label`.
 */
export async function prepareEmbeddedImage(bytes: Buffer, label: string): Promise<PdfRasterImage> {
  let metadata: Metadata;
  try {
    metadata = await sharp(bytes, { limitInputPixels: false }).metadata();
  } catch (err) {
    throw new ConversionFailedError(`${label} could not be read: ${(err as Error).message}`);
  }
  const format = metadata.format ?? 'unknown';
  const width = metadata.width ?? 0;
  const height = metadata.height ?? 0;
  if (!ALLOWED_IMAGE_FORMATS.has(format) && !REDRAWN_IMAGE_FORMATS.has(format)) throw new EngineUnavailableError('soffice', `${label} is in ${format} format, which the in-process PDF renderer cannot draw; rendering it needs the native LibreOffice engine`);
  if (width <= 0 || height <= 0) throw new ConversionFailedError(`${label} declares no pixel size`);
  if (width * height > MAX_IMAGE_PIXELS) {
    throw new ConversionFailedError(`${label} is ${width}x${height} pixels, above the ${MAX_IMAGE_PIXELS}-pixel limit of the in-process PDF renderer`);
  }
  try {
    const decoder = sharp(bytes, { limitInputPixels: MAX_IMAGE_PIXELS });
    if (format === 'jpeg' && canEmbedJpegAsIs(bytes, metadata)) {
      await decoder.raw().toBuffer();
      return { data: bytes, widthPx: width, heightPx: height };
    }
    const pipeline = decoder.rotate().toColourspace('srgb');
    const encoded = format === 'jpeg' ? pipeline.jpeg({ quality: LOSSLESS_JPEG_QUALITY, chromaSubsampling: '4:4:4' }) : pipeline.png();
    const { data, info } = await encoded.toBuffer({ resolveWithObject: true });
    return { data, widthPx: info.width, heightPx: info.height };
  } catch (err) {
    throw new ConversionFailedError(`${label} could not be decoded: ${(err as Error).message}`);
  }
}

/**
 * Parses HTML into PDF blocks. Throws EngineUnavailableError('soffice') for content only the native
 * engine draws (embedded media, form fields, SVG, MathML, non-PNG/JPEG images) and
 * ConversionFailedError for embedded images that cannot be decoded, and for external images that cannot
 * be loaded when the policy requires every resource.
 */
export async function parseHtmlToPdfBlocks(html: string, policy: HtmlResourcePolicy = {}): Promise<HtmlDocumentBlocks> {
  const tree = parseHtmlTree(html.replace(/^﻿/, ''));
  const omitted = new OmittedExternalImages();
  await loadExternalImages(tree.root, policy, omitted, HTML_IMAGE_CAPS);
  const builder = new HtmlBlockBuilder();
  const blocks = builder.blocks(tree.root.children);
  await verifyImages(builder.images);
  return { title: tree.title || undefined, blocks, warnings: omitted.warnings() };
}
