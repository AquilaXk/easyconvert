import { CadGeometryUnavailableError } from '../types';

/** A minimal, linear-time XML tag scanner for the SVG readers: tags, attributes and entities, no tree. */

export interface XmlTag {
  name: string;
  attrs: Map<string, string>;
  closing: boolean;
  selfClosing: boolean;
}

export const XML_NAME_PATTERN = /[A-Za-z_][\w:.-]*/y;
const XML_ATTR_PATTERN = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'))?/g;
const XML_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

const MAX_CODE_POINT = 0x10ffff;

function decodeXmlEntities(value: string): string {
  return value.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (whole, ent: string) => {
    if (ent.startsWith('#')) {
      const code = ent.startsWith('#x') ? Number.parseInt(ent.slice(2), 16) : Number.parseInt(ent.slice(1), 10);
      if (Number.isNaN(code) || code < 0 || code > MAX_CODE_POINT) {
        throw new CadGeometryUnavailableError(`Invalid XML character reference "${whole}".`);
      }
      return String.fromCodePoint(code);
    }
    return XML_ENTITIES[ent] ?? whole;
  });
}

/** Largest SVG text (and decompressed SVGZ payload) the parser accepts. */
export const MAX_SVG_INPUT_CHARS = 5 * 1024 * 1024;

export function malformedXml(reason: string): CadGeometryUnavailableError {
  return new CadGeometryUnavailableError(`Malformed SVG: ${reason}.`);
}

/** Index just past the end of a markup declaration, or throws when it is never terminated. */
export function endOfMarkup(xml: string, from: number, terminator: string, what: string): number {
  const end = xml.indexOf(terminator, from);
  if (end < 0) throw malformedXml(`unterminated ${what}`);
  return end + terminator.length;
}

const CHAR_GT = 0x3e;
const CHAR_DQUOTE = 0x22;
const CHAR_SQUOTE = 0x27;
export const CHAR_SLASH = 0x2f;

/** Index of the `>` that closes the tag whose attribute text starts at `from`; quoted values may contain `>`. */
export function endOfTag(xml: string, from: number): number {
  let i = from;
  while (i < xml.length) {
    const c = xml.charCodeAt(i);
    if (c === CHAR_GT) return i;
    if (c === CHAR_DQUOTE || c === CHAR_SQUOTE) {
      const close = xml.indexOf(c === CHAR_DQUOTE ? '"' : "'", i + 1);
      if (close < 0) throw malformedXml('unterminated attribute value');
      i = close + 1;
    } else {
      i++;
    }
  }
  throw malformedXml('unterminated tag');
}

/** Position after a comment, CDATA section, processing instruction or declaration starting at `lt`; -1 for an element. */
export function skipNonElementMarkup(xml: string, lt: number): number {
  if (xml.startsWith('<!--', lt)) return endOfMarkup(xml, lt + 4, '-->', 'comment');
  if (xml.startsWith('<![CDATA[', lt)) return endOfMarkup(xml, lt + 9, ']]>', 'CDATA section');
  if (xml.startsWith('<?', lt)) return endOfMarkup(xml, lt + 2, '?>', 'processing instruction');
  if (xml.startsWith('<!', lt)) return endOfMarkup(xml, lt + 2, '>', 'declaration');
  return -1;
}

/** Single-pass, linear-time tokenizer; every scan advances past the text it consumed. */
export function* scanXmlTags(xml: string): Generator<XmlTag> {
  let pos = 0;
  while (pos < xml.length) {
    const lt = xml.indexOf('<', pos);
    if (lt < 0) return;
    const after = skipNonElementMarkup(xml, lt);
    if (after >= 0) {
      pos = after;
      continue;
    }
    const closing = xml.charCodeAt(lt + 1) === CHAR_SLASH;
    const nameStart = closing ? lt + 2 : lt + 1;
    XML_NAME_PATTERN.lastIndex = nameStart;
    const nameMatch = XML_NAME_PATTERN.exec(xml);
    if (!nameMatch) {
      pos = lt + 1; // a bare "<" in character data
      continue;
    }
    const name = nameMatch[0];
    const attrStart = nameStart + name.length;
    const tagEnd = endOfTag(xml, attrStart);
    let attrText = xml.substring(attrStart, tagEnd).trimEnd();
    const selfClosing = attrText.endsWith('/');
    if (selfClosing) attrText = attrText.slice(0, -1);
    const attrs = new Map<string, string>();
    for (const a of attrText.matchAll(XML_ATTR_PATTERN)) {
      attrs.set(a[1], decodeXmlEntities(a[2] ?? a[3] ?? ''));
    }
    pos = tagEnd + 1;
    yield { name: name.replace(/^svg:/, ''), attrs, closing, selfClosing };
  }
}
