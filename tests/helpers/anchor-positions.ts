import path from 'node:path';
import JSZip from 'jszip';
import { parse } from 'parse5';
import type { DefaultTreeAdapterMap } from 'parse5';
import { SaxesParser } from 'saxes';
import { inspectEpub } from './epub-inspect';
import { zipEntryText } from './zip-entry';

/**
 * Where the internal links of a page and of the documents made from it point. A link target is described by what a
 * reader sees there: `after` is the first word at or after the target in reading order, and `before` is the text of
 * the same paragraph that comes before it (empty when the target is the start of a block). The page is read by
 * parse5 with the rule of the HTML Living Standard, "the indicated part of the document" (an element whose `id`
 * matches, then the first `a` whose `name` matches); the documents are read by an XML parser (saxes) and by parse5 for
 * EPUB. None of it shares code with the converter.
 */

type Node = DefaultTreeAdapterMap['node'];
type Element = DefaultTreeAdapterMap['element'];

export interface LinkTarget {
  /** The text of the link. */
  link: string;
  /** Text of the target's paragraph before the target. */
  before: string;
  /** The first word at or after the target. */
  after: string;
}

/** Elements whose text a reader does not see on the page. */
const NOT_SHOWN: ReadonlySet<string> = new Set(['script', 'style', 'head', 'template', 'title', 'noscript']);
/** Elements of an EPUB content document that start a paragraph of their own. */
const BLOCKS: ReadonlySet<string> = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'td', 'th', 'pre', 'blockquote', 'div', 'figcaption', 'caption', 'dt', 'dd']);

function isElement(node: Node): node is Element {
  return 'tagName' in node;
}

function attributes(element: Element): Map<string, string> {
  return new Map(element.attrs.map((attr) => [attr.name, attr.value]));
}

function firstWord(texts: readonly string[]): string {
  const text = texts.find((chunk) => chunk.trim() !== '');
  return text === undefined ? '' : (text.trim().split(/\s+/)[0] ?? '');
}

function decoded(fragment: string): string {
  try {
    return decodeURIComponent(fragment);
  } catch {
    return fragment;
  }
}

function textOf(node: Node): string {
  if (node.nodeName === '#text') return (node as unknown as { value: string }).value;
  return 'childNodes' in node ? node.childNodes.map(textOf).join('') : '';
}

/** The elements of a parsed page in tree order. */
function elementsInOrder(root: Node): Element[] {
  const found: Element[] = [];
  const walk = (node: Node): void => {
    if (isElement(node)) found.push(node);
    if ('childNodes' in node) node.childNodes.forEach(walk);
  };
  walk(root);
  return found;
}

/**
 * The indicated element of a fragment (HTML Living Standard, "the indicated part of the document"): the first element
 * whose `id` is the fragment as written, else as percent-decoded; else the first `a` whose `name` is that.
 */
function indicatedElement(elements: readonly Element[], fragment: string): Element | undefined {
  for (const candidate of [fragment, decoded(fragment)]) {
    const byId = elements.find((element) => attributes(element).get('id') === candidate);
    if (byId) return byId;
    const byName = elements.find((element) => element.tagName === 'a' && attributes(element).get('name') === candidate);
    if (byName) return byName;
  }
  return undefined;
}

/** The shown text nodes of a page in order, with the position of each element's start in that list. */
function shownText(root: Node): { texts: string[]; startOf: Map<Element, number> } {
  const texts: string[] = [];
  const startOf = new Map<Element, number>();
  const walk = (node: Node): void => {
    if (node.nodeName === '#text') {
      texts.push((node as unknown as { value: string }).value);
      return;
    }
    if (isElement(node)) {
      startOf.set(node, texts.length);
      if (NOT_SHOWN.has(node.tagName)) return;
    }
    if ('childNodes' in node) node.childNodes.forEach(walk);
  };
  walk(root);
  return { texts, startOf };
}

/** The internal links of a page and the first word after the element each indicates, as a browser resolves them. Links to nothing are left out. */
export function pageLinkTargets(html: string): Array<Pick<LinkTarget, 'link' | 'after'>> {
  const root = parse(html) as unknown as Node;
  const elements = elementsInOrder(root);
  const { texts, startOf } = shownText(root);
  const targets: Array<Pick<LinkTarget, 'link' | 'after'>> = [];
  for (const element of elements) {
    const href = element.tagName === 'a' ? attributes(element).get('href') : undefined;
    if (href === undefined || !href.startsWith('#')) continue;
    const indicated = indicatedElement(elements, href.slice(1));
    if (indicated === undefined) continue;
    targets.push({ link: textOf(element).replace(/\s+/g, ' ').trim(), after: firstWord(texts.slice(startOf.get(indicated))) });
  }
  return targets;
}

interface Mark {
  textIndex: number;
  before: string;
}

interface Collected {
  texts: string[];
  marks: Map<string, Mark>;
  links: Array<{ name: string; text: string }>;
}

function resolved(collected: Collected): LinkTarget[] {
  return collected.links.flatMap((link) => {
    const mark = collected.marks.get(link.name);
    return mark === undefined ? [] : [{ link: link.text.replace(/\s+/g, ' ').trim(), before: mark.before, after: firstWord(collected.texts.slice(mark.textIndex)) }];
  });
}

interface XmlVocabulary {
  /** Elements that start a paragraph. */
  paragraph: ReadonlySet<string>;
  /** Element whose character data is text, or undefined when all character data is. */
  textElement?: string;
  /** Elements whose character data is not text on the page (a picture's title). */
  notText?: ReadonlySet<string>;
  /** The name a bookmark element defines. */
  bookmark: (tag: { name: string; attributes: Record<string, string> }) => string | undefined;
  /** The bookmark an element links to. */
  link: (tag: { name: string; attributes: Record<string, string> }) => string | undefined;
  linkElement: string;
}

function xmlLinkTargets(xml: string, vocabulary: XmlVocabulary): LinkTarget[] {
  const collected: Collected = { texts: [], marks: new Map(), links: [] };
  let paragraph = '';
  let inText = vocabulary.textElement === undefined;
  let hidden = 0;
  const open: Array<{ name: string; text: string }> = [];
  const parser = new SaxesParser({ xmlns: false });
  parser.on('opentag', (tag) => {
    const attrs = tag.attributes as Record<string, string>;
    if (vocabulary.paragraph.has(tag.name)) paragraph = '';
    if (tag.name === vocabulary.textElement) inText = true;
    if (vocabulary.notText?.has(tag.name)) hidden += 1;
    const mark = vocabulary.bookmark({ name: tag.name, attributes: attrs });
    if (mark !== undefined && !collected.marks.has(mark)) collected.marks.set(mark, { textIndex: collected.texts.length, before: paragraph.trim() });
    const target = vocabulary.link({ name: tag.name, attributes: attrs });
    if (target !== undefined) open.push({ name: target, text: '' });
  });
  parser.on('closetag', (tag) => {
    if (tag.name === vocabulary.textElement) inText = false;
    if (vocabulary.notText?.has(tag.name)) hidden -= 1;
    if (tag.name === vocabulary.linkElement) {
      const link = open.pop();
      if (link) collected.links.push(link);
    }
  });
  parser.on('text', (chunk) => {
    if (!inText || hidden > 0) return;
    collected.texts.push(chunk);
    paragraph += chunk;
    for (const link of open) link.text += chunk;
  });
  parser.on('error', (error) => {
    throw error;
  });
  parser.write(xml).close();
  return resolved(collected);
}

/** The internal hyperlinks of a Word document and where their bookmarks stand. */
export async function docxLinkTargets(docx: Buffer): Promise<LinkTarget[]> {
  const zip = await JSZip.loadAsync(docx);
  return xmlLinkTargets(await zipEntryText(zip, 'word/document.xml'), {
    paragraph: new Set(['w:p']),
    textElement: 'w:t',
    bookmark: (tag) => (tag.name === 'w:bookmarkStart' ? tag.attributes['w:name'] : undefined),
    link: (tag) => (tag.name === 'w:hyperlink' ? tag.attributes['w:anchor'] : undefined),
    linkElement: 'w:hyperlink',
  });
}

/** The internal links of an ODF text document and where their bookmarks stand. */
export async function odtLinkTargets(odt: Buffer): Promise<LinkTarget[]> {
  const zip = await JSZip.loadAsync(odt);
  return xmlLinkTargets(await zipEntryText(zip, 'content.xml'), {
    paragraph: new Set(['text:p', 'text:h']),
    notText: new Set(['svg:title', 'svg:desc']),
    bookmark: (tag) => (tag.name === 'text:bookmark' ? tag.attributes['text:name'] : undefined),
    link: (tag) => (tag.name === 'text:a' && tag.attributes['xlink:href']?.startsWith('#') ? tag.attributes['xlink:href'].slice(1) : undefined),
    linkElement: 'text:a',
  });
}

/** The internal links of the content documents of an EPUB, within a document or to another one, and where the elements they name stand. */
export async function epubLinkTargets(epub: Buffer): Promise<LinkTarget[]> {
  const chapters = new Map<string, Collected>();
  const links: Array<{ chapter: string; href: string; text: string }> = [];
  for (const chapter of (await inspectEpub(epub)).chapters) {
    const collected: Collected = { texts: [], marks: new Map(), links: [] };
    chapters.set(path.posix.basename(chapter.path), collected);
    let paragraph = '';
    const open: Array<{ href: string; text: string; element: Element }> = [];
    const walk = (node: Node): void => {
      if (node.nodeName === '#text') {
        const value = (node as unknown as { value: string }).value;
        collected.texts.push(value);
        paragraph += value;
        for (const link of open) link.text += value;
        return;
      }
      if (!isElement(node)) {
        if ('childNodes' in node) node.childNodes.forEach(walk);
        return;
      }
      const attrs = attributes(node);
      const id = attrs.get('id');
      if (BLOCKS.has(node.tagName)) paragraph = '';
      if (id !== undefined && !collected.marks.has(id)) collected.marks.set(id, { textIndex: collected.texts.length, before: paragraph.trim() });
      const href = node.tagName === 'a' ? attrs.get('href') : undefined;
      if (href !== undefined && (href.startsWith('#') || /^[^/:]+\.xhtml#/.test(href))) open.push({ href, text: '', element: node });
      node.childNodes.forEach(walk);
      if (BLOCKS.has(node.tagName)) paragraph = '';
      if (open.length > 0 && open[open.length - 1].element === node) {
        const link = open.pop() as { href: string; text: string };
        links.push({ chapter: path.posix.basename(chapter.path), href: link.href, text: link.text });
      }
    };
    walk(parse(chapter.html) as unknown as Node);
  }
  return links.flatMap((link) => {
    const [file, fragment] = link.href.split('#');
    const collected = chapters.get(file === '' ? link.chapter : file);
    const mark = collected?.marks.get(decoded(fragment));
    if (collected === undefined || mark === undefined) return [];
    return [{ link: link.text.replace(/\s+/g, ' ').trim(), before: mark.before, after: firstWord(collected.texts.slice(mark.textIndex)) }];
  });
}
