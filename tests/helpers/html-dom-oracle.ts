import { parse, parseFragment } from 'parse5';
import type { DefaultTreeAdapterMap } from 'parse5';

/**
 * Independent HTML oracle built on parse5 (a WHATWG-compliant HTML parser that is
 * not part of the code under test). The helpers work on the parsed DOM, never on regexes, and URL
 * destinations are judged with the WHATWG URL parser rather than patterns copied from the renderer.
 */

type Node = DefaultTreeAdapterMap['node'];
type Element = DefaultTreeAdapterMap['element'];
type TextNode = DefaultTreeAdapterMap['textNode'];
type ParentNode = DefaultTreeAdapterMap['parentNode'];

const FORBIDDEN_ELEMENTS = new Set([
  'script',
  'iframe',
  'object',
  'embed',
  'frame',
  'frameset',
  'applet',
  'base',
  'form',
  'foreignobject',
  'math',
  'template',
  'noscript',
]);

// The converter's own document shell legitimately carries a charset <meta>, a Content-Security-Policy
// <meta> and one <style> in <head>; these elements are only dangerous inside the body or when a
// <meta http-equiv> does anything other than declare a Content-Security-Policy (e.g. refresh).
const BODY_ONLY_FORBIDDEN_ELEMENTS = new Set(['meta', 'link', 'style']);

const URL_ATTRIBUTES = new Set(['href', 'src', 'xlink:href', 'action', 'formaction', 'poster', 'data']);
// srcdoc embeds a whole document; no generated element may ever carry it.
const FORBIDDEN_ATTRIBUTES = new Set(['srcdoc']);
const DANGEROUS_STYLE_TOKENS = ['url(', 'expression(', 'javascript:', '@import', 'behavior:', '-moz-binding'];

// Navigation protocols a rendered document may use. Everything else (javascript:, vbscript:, data:,
// blob:, file:, unknown schemes) is a violation. The WHATWG URL parser applies the same
// tab/newline/control-character stripping a browser does before it reads the scheme.
const SAFE_PROTOCOLS = new Set(['http:', 'https:', 'mailto:', 'tel:']);
const SAFE_DATA_IMAGE_TYPES = new Set(['image/png', 'image/gif', 'image/jpeg', 'image/webp']);
const RESOLUTION_BASE = 'https://oracle-base.invalid/';

export interface DomViolation {
  kind: 'element' | 'event-handler' | 'url';
  detail: string;
}

function isElement(node: Node): node is Element {
  return 'tagName' in node && 'attrs' in node;
}

function childNodesOf(node: Node): Node[] {
  if ('content' in node && node.content) return node.content.childNodes;
  return 'childNodes' in node ? node.childNodes : [];
}

function walk(node: Node, visit: (el: Element, inBody: boolean) => void, inBody = false): void {
  const nowInBody = inBody || (isElement(node) && node.tagName === 'body');
  if (isElement(node)) visit(node, nowInBody);
  for (const child of childNodesOf(node)) walk(child, visit, nowInBody);
}

function isSafeUrl(tag: string, attribute: string, value: string): boolean {
  let url: URL;
  try {
    url = new URL(value, RESOLUTION_BASE);
  } catch {
    // An unparseable destination is not something a browser should be asked to interpret.
    return false;
  }
  if (SAFE_PROTOCOLS.has(url.protocol)) return true;
  if (url.protocol === 'data:' && tag === 'img' && attribute === 'src') {
    return SAFE_DATA_IMAGE_TYPES.has(url.pathname.split(/[;,]/)[0].toLowerCase());
  }
  return false;
}

/** Returns every dangerous construct found in the parsed document; empty means clean. */
export function findDangerousConstructs(html: string): DomViolation[] {
  const violations: DomViolation[] = [];
  const root = parse(html);
  walk(root, (el, inBody) => {
    const tag = el.tagName.toLowerCase();
    const redirects =
      tag === 'meta' &&
      el.attrs.some((a) => a.name.toLowerCase() === 'http-equiv' && a.value.toLowerCase() !== 'content-security-policy');
    if (FORBIDDEN_ELEMENTS.has(tag) || redirects || (inBody && BODY_ONLY_FORBIDDEN_ELEMENTS.has(tag))) {
      violations.push({ kind: 'element', detail: `<${tag}>` });
    }
    for (const attr of el.attrs) {
      const name = attr.name.toLowerCase();
      if (name.startsWith('on')) {
        violations.push({ kind: 'event-handler', detail: `${tag}[${name}]` });
      }
      if (FORBIDDEN_ATTRIBUTES.has(name)) {
        violations.push({ kind: 'element', detail: `${tag}[${name}]` });
      }
      if (name === 'style' && DANGEROUS_STYLE_TOKENS.some((token) => attr.value.toLowerCase().includes(token))) {
        violations.push({ kind: 'url', detail: `${tag}[style]=${attr.value.slice(0, 40)}` });
      }
      if (URL_ATTRIBUTES.has(name) && !isSafeUrl(tag, name, attr.value)) {
        violations.push({ kind: 'url', detail: `${tag}[${name}]=${attr.value.slice(0, 40)}` });
      }
    }
  });
  return violations;
}

function textOf(root: Node): string {
  const chunks: string[] = [];
  const visitText = (node: Node): void => {
    if (node.nodeName === '#text') chunks.push((node as TextNode).value);
    for (const child of childNodesOf(node)) visitText(child);
  };
  visitText(root);
  return chunks.join('');
}

/** All text node content of the document, in order. */
export function collectText(html: string): string {
  return textOf(parse(html));
}

/** Text content of the document body only (excludes the head, title and style text). */
export function collectBodyText(html: string): string {
  let bodyText = '';
  walk(parse(html), (el) => {
    if (el.tagName === 'body' && bodyText === '') bodyText = textOf(el);
  });
  return bodyText;
}

/** Collects `[tag, attribute, value]` triples for the given attribute names. */
export function collectAttributes(html: string, names: ReadonlySet<string>): Array<[string, string, string]> {
  const found: Array<[string, string, string]> = [];
  walk(parse(html), (el) => {
    for (const attr of el.attrs) {
      if (names.has(attr.name.toLowerCase())) found.push([el.tagName, attr.name, attr.value]);
    }
  });
  return found;
}

const BLOCK_ELEMENTS = new Set([
  'address', 'article', 'aside', 'blockquote', 'body', 'dd', 'details', 'div', 'dl', 'dt', 'fieldset',
  'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'li',
  'main', 'nav', 'ol', 'p', 'pre', 'section', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'ul',
]);

function isBlock(node: Node | undefined): boolean {
  return node !== undefined && isElement(node) && BLOCK_ELEMENTS.has(node.tagName);
}

// Text is compared in escaped form so that visible markup text (&lt;b&gt;) never equals a real element (<b>).
function escapeText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function canonicalAttrs(el: Element): string {
  return el.attrs
    .map((a) => `${a.name}=${JSON.stringify(a.value)}`)
    .sort()
    .join(' ');
}

function canonicalize(node: Node, inPre: boolean): string {
  if (node.nodeName === '#text') {
    return escapeText((node as TextNode).value);
  }
  if (node.nodeName === '#comment') return '';
  if (!isElement(node)) return childNodesOf(node).map((c) => canonicalize(c, inPre)).join('');

  const pre = inPre || node.tagName === 'pre';
  const kids = childNodesOf(node);
  const parts: string[] = [];
  kids.forEach((child, index) => {
    if (child.nodeName !== '#text' || pre) {
      parts.push(canonicalize(child, pre));
      return;
    }
    let text = escapeText((child as TextNode).value).replace(/[ \t\r\n]+/g, ' ');
    const prev = kids[index - 1];
    const next = kids[index + 1];
    if (index === 0 || isBlock(prev)) text = text.replace(/^ /, '');
    if (index === kids.length - 1 || isBlock(next)) text = text.replace(/ $/, '');
    parts.push(text);
  });
  const attrs = canonicalAttrs(node);
  const attrSuffix = attrs ? ` ${attrs}` : '';
  return `<${node.tagName}${attrSuffix}>${parts.join('')}</${node.tagName}>`;
}

/** Canonical form of an HTML fragment used to compare two renderings of the same document. */
export function normalizeHtmlFragment(html: string): string {
  const fragment = parseFragment(html) as ParentNode;
  return canonicalize(fragment, false).trim();
}
