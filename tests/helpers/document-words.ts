import JSZip from 'jszip';
import { parse } from 'parse5';
import type { DefaultTreeAdapterMap } from 'parse5';
import { SaxesParser } from 'saxes';
import { inspectEpub } from './epub-inspect';
import { zipEntryText } from './zip-entry';

/**
 * The words of a page as a reader sees them, and the words of the documents made from it, for tests that ask whether a
 * conversion kept the text of a page. The page is read by parse5 (a WHATWG HTML parser, which closes the elements an
 * author left open the way a browser does); the documents are read by an XML parser (saxes) and by parse5 for EPUB.
 * Neither reader shares code with the converter. A word is two or more ASCII letters or digits: the pages of the corpus
 * are ASCII-heavy, and non-ASCII text would differ by encoding rather than by what the converter kept.
 */

type Node = DefaultTreeAdapterMap['node'];

const WORD = /[A-Za-z0-9]{2,}/g;
/** Elements whose text a reader does not see on the page (or that this converter leaves out on purpose: no form, no script, no fallback). */
const NOT_SHOWN: ReadonlySet<string> = new Set(['script', 'style', 'head', 'template', 'title', 'noframes', 'noscript', 'select', 'textarea', 'object', 'iframe', 'svg']);
/** Elements that start a new line in a reader's layout; text on either side of one is not one word. */
const LINE_BREAKING: ReadonlySet<string> = new Set([
  'address', 'article', 'aside', 'blockquote', 'body', 'br', 'caption', 'center', 'dd', 'div', 'dl', 'dt', 'fieldset', 'figcaption', 'figure',
  'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'html', 'li', 'main', 'nav', 'ol', 'p', 'pre', 'section', 'table', 'tbody',
  'td', 'tfoot', 'th', 'thead', 'tr', 'ul',
]);

export function wordsOf(text: string): string[] {
  return text.match(WORD) ?? [];
}

function pageText(node: Node): string {
  if (node.nodeName === '#text') return (node as unknown as { value: string }).value;
  if (NOT_SHOWN.has(node.nodeName) || !('childNodes' in node)) return '';
  const inner = node.childNodes.map(pageText).join('');
  return LINE_BREAKING.has(node.nodeName) ? ` ${inner} ` : inner;
}

/** The words a browser shows for `html`, in reading order. */
export function pageWords(html: string): string[] {
  return wordsOf(pageText(parse(html) as unknown as Node));
}

/** The text of an XML part, with a space after each of the elements named in `lineElements` (paragraphs, headings, breaks, tabs). */
function xmlText(xml: string, lineElements: ReadonlySet<string>): string {
  let text = '';
  const parser = new SaxesParser({ xmlns: false });
  parser.on('text', (chunk) => {
    text += chunk;
  });
  parser.on('closetag', (tag) => {
    if (lineElements.has(tag.name)) text += ' ';
  });
  parser.on('opentag', (tag) => {
    if (lineElements.has(tag.name)) text += ' ';
  });
  parser.on('error', (error) => {
    throw error;
  });
  parser.write(xml).close();
  return text;
}

const DOCX_LINES: ReadonlySet<string> = new Set(['w:p', 'w:br', 'w:tab']);
const ODT_LINES: ReadonlySet<string> = new Set(['text:p', 'text:h', 'text:line-break', 'text:tab']);

export async function docxWords(docx: Buffer): Promise<string[]> {
  const zip = await JSZip.loadAsync(docx);
  return wordsOf(xmlText(await zipEntryText(zip, 'word/document.xml'), DOCX_LINES));
}

export async function odtWords(odt: Buffer): Promise<string[]> {
  const zip = await JSZip.loadAsync(odt);
  return wordsOf(xmlText(await zipEntryText(zip, 'content.xml'), ODT_LINES));
}

export async function epubWords(epub: Buffer): Promise<string[]> {
  const book = await inspectEpub(epub);
  return book.chapters.flatMap((chapter) => pageWords(chapter.html));
}

/** The words of `expected` that `actual` does not hold after the words that matched before them, in order (a subsequence match). */
export function wordsNotKept(expected: readonly string[], actual: readonly string[]): string[] {
  const lost: string[] = [];
  let from = 0;
  for (const word of expected) {
    const at = actual.indexOf(word, from);
    if (at === -1) lost.push(word);
    else from = at + 1;
  }
  return lost;
}
