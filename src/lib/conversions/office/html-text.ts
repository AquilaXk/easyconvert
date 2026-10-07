import { ConversionFailedError } from '../../types';

/**
 * Plain text of an (X)HTML document, for the ebook readers: block elements become paragraphs, line breaks
 * stay line breaks, and the head, scripts, styles and navigation lists are not text of the book. The scan is
 * one linear pass; tag nesting is bounded by a named limit.
 */

/** Elements whose whole content is not book text. */
const SKIPPED_ELEMENTS: ReadonlySet<string> = new Set(['head', 'script', 'style', 'nav', 'svg', 'template', 'noscript']);

/** Elements that start and end a paragraph (MOBI page breaks are `mbp:pagebreak`). */
const BLOCK_ELEMENTS: ReadonlySet<string> = new Set([
  'p', 'div', 'section', 'article', 'aside', 'header', 'footer', 'main', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'pre',
  'ul', 'ol', 'li', 'dl', 'dt', 'dd', 'table', 'tr', 'hr', 'figure', 'figcaption', 'body', 'address', 'details', 'summary',
  'fieldset', 'form', 'center', 'mbp:pagebreak',
]);

/** Elements without content: a closing tag never follows. */
const VOID_ELEMENTS: ReadonlySet<string> = new Set(['br', 'hr', 'img', 'meta', 'link', 'input', 'col', 'area', 'base', 'embed', 'source', 'track', 'wbr']);

const CELL_ELEMENTS: ReadonlySet<string> = new Set(['td', 'th']);

/** The deepest element nesting accepted; real books stay far below it. */
export const HTML_TEXT_MAX_NESTING = 512;

const PARAGRAPH_BREAK = '\n\n';
const LINE_BREAK = '\n';
const CHAR_QUOTE_DOUBLE = '"';
const CHAR_QUOTE_SINGLE = "'";

/** The five XML entities plus the HTML names that real books use; numeric references are decoded for any code point. */
const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', shy: '', hellip: '…', mdash: '—', ndash: '–',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', copy: '©', reg: '®', trade: '™', laquo: '«',
  raquo: '»', times: '×', middot: '·', bull: '•', euro: '€', pound: '£', yen: '¥', cent: '¢',
  deg: '°', plusmn: '±', frac12: '½', frac14: '¼', frac34: '¾', sect: '§', para: '¶',
};

const ENTITY_PATTERN = /&(#x[0-9a-fA-F]{1,6}|#[0-9]{1,7}|[A-Za-z][A-Za-z0-9]{1,15});/g;
const MAX_CODE_POINT = 0x10ffff;
const HEX_RADIX = 16;
const DECIMAL_RADIX = 10;

function decodeEntities(text: string): string {
  if (!text.includes('&')) return text;
  return text.replace(ENTITY_PATTERN, (whole, body: string) => {
    if (body.startsWith('#')) {
      const isHex = body[1] === 'x' || body[1] === 'X';
      const code = Number.parseInt(body.slice(isHex ? 2 : 1), isHex ? HEX_RADIX : DECIMAL_RADIX);
      return code > 0 && code <= MAX_CODE_POINT ? String.fromCodePoint(code) : whole;
    }
    return NAMED_ENTITIES[body] ?? whole;
  });
}

/** Index of the `>` that ends the tag starting at `from`, skipping quoted attribute values; -1 when the tag never ends. */
function tagEnd(html: string, from: number): number {
  let quote = '';
  for (let i = from; i < html.length; i += 1) {
    const ch = html[i];
    if (quote) {
      if (ch === quote) quote = '';
    } else if (ch === CHAR_QUOTE_DOUBLE || ch === CHAR_QUOTE_SINGLE) {
      quote = ch;
    } else if (ch === '>') {
      return i;
    }
  }
  return -1;
}

const TAG_NAME_PATTERN = /^\/?([A-Za-z][\w:.-]*)/;

interface TextState {
  out: string[];
  /** The break owed before the next text: none, a line break or a paragraph break. */
  pending: string;
  atLineStart: boolean;
}

function requestBreak(state: TextState, kind: string): void {
  if (kind === PARAGRAPH_BREAK || state.pending === '') state.pending = kind;
}

function appendText(state: TextState, raw: string): void {
  let text = decodeEntities(raw).replace(/[ \t\r\n\f]+/g, ' ');
  if (state.atLineStart || state.pending !== '') text = text.trimStart();
  if (state.out.length === 0) text = text.trimStart();
  if (text === '') return;
  if (state.pending !== '' && state.out.length > 0) state.out.push(state.pending);
  state.pending = '';
  state.out.push(text);
  state.atLineStart = false;
}

/** The text of `html`: paragraphs separated by one blank line, lines by a line break, no markup. */
export function htmlToText(html: string): string {
  const state: TextState = { out: [], pending: '', atLineStart: true };
  const skipped: string[] = [];
  let depth = 0;
  let pos = 0;
  while (pos < html.length) {
    const lt = html.indexOf('<', pos);
    const textEnd = lt === -1 ? html.length : lt;
    if (textEnd > pos && skipped.length === 0) appendText(state, html.slice(pos, textEnd));
    if (lt === -1) break;
    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt + 4);
      pos = end === -1 ? html.length : end + 3;
      continue;
    }
    if (html.startsWith('<![CDATA[', lt)) {
      const end = html.indexOf(']]>', lt + 9);
      if (skipped.length === 0) appendText(state, html.slice(lt + 9, end === -1 ? html.length : end));
      pos = end === -1 ? html.length : end + 3;
      continue;
    }
    const end = tagEnd(html, lt + 1);
    if (end === -1) break;
    const inner = html.slice(lt + 1, end);
    pos = end + 1;
    const match = TAG_NAME_PATTERN.exec(inner);
    if (!match) continue;
    const name = match[1].toLowerCase();
    const closing = inner.startsWith('/');
    const selfClosing = inner.endsWith('/') || VOID_ELEMENTS.has(name);

    if (closing) {
      if (skipped.length > 0) {
        if (skipped[skipped.length - 1] === name) skipped.pop();
        continue;
      }
      depth = Math.max(0, depth - 1);
      if (BLOCK_ELEMENTS.has(name)) requestBreak(state, PARAGRAPH_BREAK);
      continue;
    }
    if (skipped.length > 0) {
      if (!selfClosing && SKIPPED_ELEMENTS.has(name) && skipped[skipped.length - 1] === name) skipped.push(name);
      continue;
    }
    if (SKIPPED_ELEMENTS.has(name)) {
      if (!selfClosing) skipped.push(name);
      continue;
    }
    if (!selfClosing) {
      depth += 1;
      if (depth > HTML_TEXT_MAX_NESTING) {
        throw new ConversionFailedError(`The document nests elements deeper than ${HTML_TEXT_MAX_NESTING} levels.`);
      }
    }
    if (name === 'br') requestBreak(state, LINE_BREAK);
    else if (BLOCK_ELEMENTS.has(name)) requestBreak(state, PARAGRAPH_BREAK);
    else if (CELL_ELEMENTS.has(name) && !state.atLineStart) state.out.push(' ');
  }
  return state.out.join('').replace(/ {2,}/g, ' ').replace(/[ \t]+\n/g, '\n').replace(/\n[ \t]+/g, '\n').replace(/\n{3,}/g, PARAGRAPH_BREAK).trim();
}
