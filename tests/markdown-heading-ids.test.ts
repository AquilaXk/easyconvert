import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { parse } from 'parse5';
import type { DefaultTreeAdapterMap } from 'parse5';
import { convertFile } from '../src/lib/conversions/index';
import { renderMarkdownFragment } from '../src/lib/conversions/markdown';
import { docxAnchors, epubAnchors, odtAnchors } from './helpers/anchor-targets';
import { elementsOf, inspectEpub } from './helpers/epub-inspect';
import { zipEntryText } from './helpers/zip-entry';

/**
 * Headings of a Markdown file written by the markdown-it path (HTML, Word, ODF and EPUB) carry the id a Markdown view on a
 * code host gives them, and a link to `#id` resolves. markdown-it-anchor 9.2 puts an id on each heading from the `text` and
 * `code_inline` tokens of its title; the slug is github-slugger's (see github-slug.ts), numbered `-1`, `-2` for repeats. The
 * readers below are parse5 and an XML parser: none shares code with the writers.
 */

type Node = DefaultTreeAdapterMap['node'];

const HEADING_TAGS: ReadonlySet<string> = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
const BOOKMARK_START = /<w:bookmarkStart\b[^>]*\bw:name="([^"]*)"/g;

const MARKDOWN = [
  '# Overview',
  '',
  'Go to [the details](#second-part), [the code](#c--rust-100-safe-code) or [again](#notes-1).',
  '',
  '## Second Part',
  '',
  '### C++ & Rust: 100% *safe* `code`',
  '',
  '#### 한글 제목',
  '',
  '# Notes',
  '',
  '# Notes',
  '',
  '[nowhere](#missing)',
].join('\n');

const IDS = ['overview', 'second-part', 'c--rust-100-safe-code', '한글-제목', 'notes', 'notes-1'];
const LINKED = ['second-part', 'c--rust-100-safe-code', 'notes-1'];

const convert = async (target: string): Promise<Buffer> => (await convertFile(Buffer.from(MARKDOWN, 'utf-8'), 'md', target, {}, 'notes.md')).buffer;

function headingIds(html: string): string[] {
  return elementsOf(html, HEADING_TAGS).map((heading) => heading.attrs.get('id') ?? '');
}

function anchorHrefs(html: string): string[] {
  const hrefs: string[] = [];
  const walk = (node: Node): void => {
    if ('tagName' in node && node.tagName === 'a') {
      const href = node.attrs.find((attr) => attr.name === 'href')?.value;
      if (href?.startsWith('#')) hrefs.push(decodeURIComponent(href.slice(1)));
    }
    if ('childNodes' in node) node.childNodes.forEach(walk);
  };
  walk(parse(html) as unknown as Node);
  return hrefs;
}

describe('the ids of headings in the markdown-it path', () => {
  it('writes an id on each heading of the HTML fragment, numbering a repeated one', () => {
    expect(headingIds(renderMarkdownFragment(MARKDOWN))).toEqual(IDS);
  });

  it('leaves a heading with no usable text without an id and still numbers the next one', () => {
    expect(headingIds(renderMarkdownFragment('# !!!\n\n# !!!\n\n# Text'))).toEqual(['', '-1', 'text']);
  });

  it('gives an id to a heading in a quotation and in a list, numbered with the others', () => {
    expect(headingIds(renderMarkdownFragment('> ## Quoted\n\n- ### Listed\n\n## Quoted'))).toEqual(['quoted', 'listed', 'quoted-1']);
  });
});

describe('a link to a heading resolves in every target of a Markdown file', () => {
  it('HTML: the headings have the ids and every link goes to one', async () => {
    const html = (await convert('html')).toString('utf8');
    expect(headingIds(html)).toEqual(IDS);
    expect(anchorHrefs(html)).toEqual([...LINKED, 'missing']);
  });

  it('Word: a bookmark on each heading and a hyperlink to one for each link that has a heading', async () => {
    const docx = await convert('docx');
    const xml = await zipEntryText(await JSZip.loadAsync(docx), 'word/document.xml');
    expect([...xml.matchAll(BOOKMARK_START)]).toHaveLength(IDS.length);
    const report = await docxAnchors(docx);
    expect(report.links).toHaveLength(LINKED.length);
    expect(report.broken).toEqual([]);
    expect(report.duplicates).toEqual([]);
  });

  it('EPUB: a link to the chapter and the id of each heading it names, and none for a heading that is not there', async () => {
    const epub = await convert('epub');
    const report = await epubAnchors(epub);
    expect(report.links.map((link) => link.split('#')[1])).toEqual(LINKED);
    expect(report.broken).toEqual([]);
    expect(report.duplicates).toEqual([]);
    expect(report.invalidNames).toEqual([]);
    const book = await inspectEpub(epub);
    expect(book.chapters.flatMap((chapter) => elementsOf(chapter.html, new Set(['a'])).map((anchor) => anchor.attrs.get('id') ?? '').filter((id) => id !== ''))).toEqual(IDS);
  });

  it('Word and EPUB: a heading whose id is longer than a Word bookmark name is linked all the same', async () => {
    const title = `Long ${'section title '.repeat(12)}end`;
    const markdown = Buffer.from(`# ${title}\n\nSee [it](#${title.toLowerCase().replace(/ /g, '-')}).\n`, 'utf-8');
    const docx = await docxAnchors((await convertFile(markdown, 'md', 'docx', {}, 'long.md')).buffer);
    expect({ links: docx.links.length, broken: docx.broken }).toEqual({ links: 1, broken: [] });
    const epub = await epubAnchors((await convertFile(markdown, 'md', 'epub', {}, 'long.md')).buffer);
    expect({ links: epub.links.length, broken: epub.broken }).toEqual({ links: 1, broken: [] });
  });

  it('ODF: a bookmark on each heading and a link to it for each link that has a heading', async () => {
    const report = await odtAnchors(await convert('odt'));
    expect(report.links).toEqual(LINKED.map((name) => `-> ${name}`));
    expect(report.broken).toEqual([]);
    expect(report.duplicates).toEqual([]);
  });
});
