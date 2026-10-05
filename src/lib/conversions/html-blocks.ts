import sharp from 'sharp';
import { ConversionFailedError, EngineUnavailableError } from '../types';
import type { PdfBlock, PdfRasterImage, PdfTableCell } from './pdf-blocks';
import type { PdfTextSegment } from './pdf-fonts';

/**
 * Parses HTML into the PDF block model: headings, paragraphs, lists, tables, links, preformatted
 * text, quotes, rules and embedded (data: URI) PNG/JPEG images. Content the in-process renderer
 * cannot draw is refused with a typed error instead of being dropped.
 */

interface HtmlElement {
  readonly tag: string;
  readonly attrs: ReadonlyMap<string, string>;
  readonly children: HtmlNode[];
}

type HtmlNode = HtmlElement | string;

export interface HtmlDocumentBlocks {
  /** Text of the <title> element, for PDF metadata. */
  title?: string;
  blocks: PdfBlock[];
}

const MAX_NESTING_DEPTH = 256;
const HEX_RADIX = 16;
const DECIMAL_RADIX = 10;
const MAX_CODE_POINT = 0x10ffff;
const REPLACEMENT_CHARACTER = '�';
const SURROGATE_FIRST = 0xd800;
const SURROGATE_LAST = 0xdfff;
const DEFAULT_LIST_START = 1;
/** Largest colspan honoured, as in HTML (larger values are clamped). */
const MAX_COLUMN_SPAN = 1000;
const COMMENT_OPEN = '<!--';
const COMMENT_CLOSE = '-->';

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
const MAX_IMAGE_PIXELS = 25_000_000;
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
  'spades:2660 clubs:2663 hearts:2665 diams:2666';

const NAMED_ENTITIES: ReadonlyMap<string, string> = new Map(
  NAMED_ENTITY_TABLE.split(' ').map((entry) => {
    const [name, hex] = entry.split(':');
    return [name, String.fromCodePoint(Number.parseInt(hex, HEX_RADIX))];
  })
);

const CHARACTER_REFERENCE = /&(?:#[xX]([0-9a-fA-F]{1,8});?|#([0-9]{1,10});?|([A-Za-z][A-Za-z0-9]{1,31});)/g;

function decodeCodePoint(value: number): string {
  if (value === 0 || value > MAX_CODE_POINT || (value >= SURROGATE_FIRST && value <= SURROGATE_LAST)) {
    return REPLACEMENT_CHARACTER;
  }
  return String.fromCodePoint(value);
}

/** Decodes numeric and named character references; unknown names stay literal, as in HTML. */
export function decodeHtmlCharacterReferences(text: string): string {
  if (!text.includes('&')) return text;
  return text.replace(CHARACTER_REFERENCE, (match: string, hex?: string, decimal?: string, name?: string) => {
    if (hex !== undefined) return decodeCodePoint(Number.parseInt(hex, HEX_RADIX));
    if (decimal !== undefined) return decodeCodePoint(Number.parseInt(decimal, DECIMAL_RADIX));
    return (name !== undefined && NAMED_ENTITIES.get(name)) || match;
  });
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

  start(tag: string, attrs: Map<string, string>): void {
    if (PARAGRAPH_CLOSERS.has(tag)) this.closeOpen(PARAGRAPH, PARAGRAPH_SCOPE);
    if (HEADING_ELEMENTS.has(tag) && HEADING_ELEMENTS.has(this.current.tag)) this.stack.pop();
    if (tag === 'li') this.closeOpen(LIST_ITEM, LIST_ELEMENTS);
    if (DEFINITION_ITEMS.has(tag)) this.closeOpen(DEFINITION_ITEMS, DEFINITION_LIST);
    if (TABLE_SECTION_ELEMENTS.has(tag)) this.closeOpen(TABLE_SECTION_ELEMENTS, TABLE);
    if (tag === 'tr') this.closeOpen(TABLE_ROW, TABLE_ROW_SCOPE);
    if (TABLE_CELL_ELEMENTS.has(tag)) this.closeOpen(TABLE_CELL_ELEMENTS, TABLE_CELL_SCOPE);
    if (tag === 'option') this.closeOpen(OPTION, SELECT);

    const element: HtmlElement = { tag, attrs, children: [] };
    this.current.children.push(element);
    if (VOID_ELEMENTS.has(tag)) return;
    if (this.stack.length >= MAX_NESTING_DEPTH) {
      throw new ConversionFailedError(`HTML nests elements deeper than ${MAX_NESTING_DEPTH} levels`);
    }
    this.stack.push(element);
  }

  rawText(tag: string, attrs: Map<string, string>, content: string): void {
    if (tag === 'title' && this.title === undefined) {
      this.title = decodeHtmlCharacterReferences(content).replace(HTML_WHITESPACE, ' ').trim();
    }
    this.start(tag, attrs);
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

/** Reads attributes from just after the tag name; returns them with the index of the closing '>'. */
function parseAttributes(source: string, from: number): { attrs: Map<string, string>; end: number } {
  const attrs = new Map<string, string>();
  const length = source.length;
  let i = from;
  while (i < length) {
    while (i < length && ATTRIBUTE_GAP.test(source[i])) i++;
    if (i >= length || source[i] === '>') break;
    const nameStart = i;
    while (i < length && !ATTRIBUTE_NAME_END.test(source[i])) i++;
    const name = source.slice(nameStart, i).toLowerCase();
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
    if (name && !attrs.has(name)) attrs.set(name, decodeHtmlCharacterReferences(value));
  }
  return { attrs, end: i };
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
function parseHtmlTree(html: string): HtmlTreeBuilder {
  const builder = new HtmlTreeBuilder();
  const lowerHtml = html.toLowerCase();
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
      const close = html.indexOf(COMMENT_CLOSE, lt + COMMENT_OPEN.length);
      i = close < 0 ? length : close + COMMENT_CLOSE.length;
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
    const { attrs, end } = parseAttributes(html, nameEnd);
    i = Math.min(end + 1, length);
    textStart = i;

    if (isEnd) {
      builder.end(tag);
      continue;
    }
    if (RAW_TEXT_ELEMENTS.has(tag)) {
      const contentEnd = findRawTextEnd(lowerHtml, tag, i);
      const stop = contentEnd < 0 ? length : contentEnd;
      builder.rawText(tag, attrs, html.slice(i, stop));
      const closeEnd = contentEnd < 0 ? -1 : html.indexOf('>', contentEnd);
      i = closeEnd < 0 ? length : closeEnd + 1;
      textStart = i;
      continue;
    }
    builder.start(tag, attrs);
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

function decodeImageSource(src: string): Buffer {
  const match = DATA_URI.exec(src.trim());
  if (!match) {
    throw new ConversionFailedError(
      `HTML image "${src}" is an external reference; external resources are not fetched, so embed the image as a data: URI`
    );
  }
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
      for (const image of images) blocks.push(this.image(image));
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
      return [...heading, ...images.map((image) => this.image(image))];
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

  private image(node: HtmlElement): PdfBlock {
    const src = node.attrs.get('src');
    if (!src) throw new ConversionFailedError('HTML <img> has no src attribute');
    const block = { kind: 'image' as const, image: { data: Buffer.alloc(0), widthPx: 0, heightPx: 0 } };
    this.images.push({ block, bytes: decodeImageSource(src) });
    return block;
  }
}

/**
 * Checks each embedded image from its header (format, then a pixel limit) before decoding it, then
 * decodes it once into an 8-bit sRGB PNG or JPEG with the orientation tag applied, which is what
 * the PDF embeds. Only PNG and JPEG are drawn.
 */
async function verifyImages(images: readonly PendingImage[]): Promise<void> {
  for (const pending of images) {
    let metadata: sharp.Metadata;
    try {
      // The header alone: the pixel limit below is checked before any pixel is decoded.
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
    try {
      const pipeline = sharp(pending.bytes, { limitInputPixels: MAX_IMAGE_PIXELS }).rotate().toColourspace('srgb');
      const encoded = format === 'png' ? pipeline.png() : pipeline.jpeg({ quality: JPEG_REENCODE_QUALITY });
      const { data, info } = await encoded.toBuffer({ resolveWithObject: true });
      pending.block.image = { data, widthPx: info.width, heightPx: info.height };
    } catch (err) {
      throw new ConversionFailedError(`HTML embedded image could not be decoded: ${(err as Error).message}`);
    }
  }
}

/**
 * Parses HTML into PDF blocks. Throws EngineUnavailableError('soffice') for content only the native
 * engine draws (embedded media, form fields, SVG, MathML, non-PNG/JPEG images) and
 * ConversionFailedError for images that are external references or cannot be decoded.
 */
export async function parseHtmlToPdfBlocks(html: string): Promise<HtmlDocumentBlocks> {
  const tree = parseHtmlTree(html.replace(/^﻿/, ''));
  const builder = new HtmlBlockBuilder();
  const blocks = builder.blocks(tree.root.children);
  await verifyImages(builder.images);
  return { title: tree.title || undefined, blocks };
}
