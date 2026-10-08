import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { parse } from 'parse5';
import type { DefaultTreeAdapterMap } from 'parse5';

/**
 * Renders a React element to static markup (what a visitor's browser receives before hydration) and parses it
 * with parse5, a WHATWG HTML parser that is independent of the code under test. Tests assert on the parsed DOM:
 * visible text, headings, link targets, ARIA attributes and class tokens, never on the component's source text.
 */

type Node = DefaultTreeAdapterMap['node'];
export type DomElement = DefaultTreeAdapterMap['element'];
type TextNode = DefaultTreeAdapterMap['textNode'];

const NON_VISIBLE_TAGS = new Set(['script', 'style', 'template', 'noscript']);
const HEADING_TAGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);

export function renderDom(element: ReactElement): DomElement {
  const document = parse(`<!DOCTYPE html><html><body>${renderToStaticMarkup(element)}</body></html>`);
  const html = document.childNodes.find((n): n is DomElement => 'tagName' in n && n.tagName === 'html');
  if (!html) throw new Error('rendered markup has no <html> element');
  return html;
}

/** Renders `component` with `props`, for components typed with required props. */
export function renderComponent<P extends object>(component: (props: P) => ReactElement | null, props: P): DomElement {
  return renderDom(createElement(component as (props: P) => ReactElement, props));
}

function isElement(node: Node): node is DomElement {
  return 'tagName' in node && 'attrs' in node;
}

function childrenOf(node: Node): Node[] {
  if ('content' in node && node.content) return node.content.childNodes;
  return 'childNodes' in node ? node.childNodes : [];
}

export function allElements(root: Node): DomElement[] {
  const found: DomElement[] = [];
  const visit = (node: Node): void => {
    if (isElement(node)) found.push(node);
    for (const child of childrenOf(node)) visit(child);
  };
  visit(root);
  return found;
}

export function attrOf(element: DomElement, name: string): string | null {
  return element.attrs.find((a) => a.name === name)?.value ?? null;
}

/** Text a visitor can read under `node`, whitespace collapsed (script and style content excluded). */
export function visibleText(node: Node): string {
  const parts: string[] = [];
  const visit = (current: Node): void => {
    if (isElement(current) && NON_VISIBLE_TAGS.has(current.tagName)) return;
    if (current.nodeName === '#text') parts.push((current as TextNode).value);
    for (const child of childrenOf(current)) visit(child);
  };
  visit(node);
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

/** Visible text of each heading element, in document order. */
export function headings(root: Node): string[] {
  return allElements(root)
    .filter((e) => HEADING_TAGS.has(e.tagName))
    .map((e) => visibleText(e));
}

/** `{ text, href }` of every anchor, in document order. */
export function links(root: Node): Array<{ text: string; href: string }> {
  return allElements(root)
    .filter((e) => e.tagName === 'a' && attrOf(e, 'href') !== null)
    .map((e) => ({ text: visibleText(e), href: attrOf(e, 'href') as string }));
}

/** Every distinct class token used anywhere under `root`. */
export function classTokens(root: Node): Set<string> {
  const tokens = new Set<string>();
  for (const element of allElements(root)) {
    for (const token of (attrOf(element, 'class') ?? '').split(/\s+/)) {
      if (token !== '') tokens.add(token);
    }
  }
  return tokens;
}

/** The entries of `wanted` that `available` does not hold: an empty list means all are present. */
export function missingFrom(available: Iterable<string>, wanted: readonly string[]): string[] {
  const have = new Set(available);
  return wanted.filter((w) => !have.has(w));
}

/** The entries of `forbidden` that `available` holds: an empty list means none is present. */
export function presentIn(available: Iterable<string>, forbidden: readonly string[]): string[] {
  const have = new Set(available);
  return forbidden.filter((f) => have.has(f));
}

/** Phrases of `phrases` that do not occur in the visible text; empty when all do. */
export function phrasesMissing(text: string, phrases: readonly string[]): string[] {
  return phrases.filter((p) => !text.includes(p));
}

/** Phrases of `phrases` that occur in the visible text; empty when none does. */
export function phrasesPresent(text: string, phrases: readonly string[]): string[] {
  return phrases.filter((p) => text.includes(p));
}

/** Elements whose tag is `tag` and, when given, whose attribute `name` equals `value`. */
export function select(root: Node, tag: string, name?: string, value?: string): DomElement[] {
  return allElements(root).filter((e) => e.tagName === tag && (name === undefined || attrOf(e, name) === value));
}
