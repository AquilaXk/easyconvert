import { describe, expect, it } from 'vitest';
import { convertFile } from '../src/lib/conversions';
import { docxAnchors, epubAnchors, odtAnchors } from './helpers/anchor-targets';
import { docxWords, epubWords, odtWords, pageWords, wordsNotKept } from './helpers/document-words';
import { elementsOf, inspectEpub } from './helpers/epub-inspect';
import { runEpubcheck } from './helpers/epubcheck';
import { oracleTest } from './helpers/oracle-test';
import { requireRealworldSample } from './helpers/realworld-sample';

/**
 * Unknown wrapper elements and text directly in a table (words), and ids and fragments in the output (anchors).
 *
 * Words: a browser lays out an unknown element such as `<noindex>` as an inline box, and the divisions, lists and
 * paragraphs inside it as blocks, so the text of two divisions is two lines; and it moves text that stands in a table
 * outside any cell to just before the table (foster parenting, WHATWG HTML, "in table" insertion mode). The expected words
 * come from parse5 reading the page; before the change the reader joined the text of the divisions (`HomeImage`) and
 * dropped the text in the table.
 *
 * Anchors: HTML allows an id twice (the first is the link target) and a link fragment with a space or a percent
 * escape; EPUB (an `id` is an XML ID), Word (a bookmark name) and ODF (a bookmark name) do not. EPUBCheck reported
 * RSC-005 for the duplicate and invalid ids and RSC-020 for the fragments with a space on 48 of the 450 saved pages.
 */

const TARGETS = ['docx', 'odt', 'epub'] as const;
const READERS = { docx: docxWords, odt: odtWords, epub: epubWords } as const;

async function wordsOfConversion(html: Buffer, name: string, target: (typeof TARGETS)[number]): Promise<string[]> {
  return READERS[target]((await convertFile(html, 'html', target, {}, name)).buffer);
}

describe('unknown wrappers and text in a table, derived from the pages of the corpus', () => {
  const cases: Array<[string, string, string[]]> = [
    ['an unknown element around divisions', '<body><noindex><div>Home</div><div>Image</div></noindex></body>', ['Home', 'Image']],
    ['an unknown element around a list', '<body><noindex><ul><li>Alpha</li><li>beta</li></ul></noindex><p>gamma</p></body>', ['Alpha', 'beta', 'gamma']],
    ['an unknown element around text and a paragraph', '<body><wrapper>Alpha beta<p>gamma</p>delta</wrapper></body>', ['Alpha', 'beta', 'gamma', 'delta']],
    ['unknown elements inside each other', '<body><x-a><x-b><div>Alpha</div></x-b><div>beta</div></x-a></body>', ['Alpha', 'beta']],
    ['an unknown element around a table', '<body><noindex><table><tr><td>Alpha</td></tr></table><div>beta</div></noindex></body>', ['Alpha', 'beta']],
    ['text in a table outside a cell', '<body><table>Alpha beta<tr><td>gamma</td></tr></table></body>', ['Alpha', 'beta', 'gamma']],
    ['text in a row outside a cell', '<body><table><tr>Alpha<td>beta</td></tr></table></body>', ['Alpha', 'beta']],
    ['a division and a link in a table outside a cell', '<body><table><div>Alpha</div><a href="http://example.com/">beta</a><tr><td>gamma</td></tr></table></body>', ['Alpha', 'beta', 'gamma']],
    ['an inline element between a table and its rows', '<body><table><font><tr><td>Alpha</td></tr></font><tr><td>beta</td></tr></table></body>', ['Alpha', 'beta']],
    ['an inline element between the cells of a row', '<body><table><tr><font size="1"><td>Alpha</td><font><td>beta</td></font></font></tr></table><p>gamma</p></body>', ['Alpha', 'beta', 'gamma']],
    ['a link around divisions', '<body><a href="http://example.com/"><div>Alpha</div><div>beta</div></a></body>', ['Alpha', 'beta']],
    ['text in a row group', '<body><table><tbody>Alpha<tr><td>beta</td></tr></tbody></table><p>gamma</p></body>', ['Alpha', 'beta', 'gamma']],
  ];

  for (const [label, html, phrases] of cases) {
    for (const target of TARGETS) {
      it(`keeps the words of a page with ${label} apart, as ${target}`, async () => {
        expect(pageWords(html)).toEqual(phrases);
        const words = await wordsOfConversion(Buffer.from(html), 'page.html', target);
        expect(words).toEqual(phrases);
      });
    }
  }
});

describe('formatting and links around blocks', () => {
  it('keeps the link of an inline element on each block it holds', async () => {
    const html = '<body><a href="http://example.com/x"><div>Alpha</div><ul><li>beta</li></ul></a></body>';
    const chapter = (await inspectEpub((await convertFile(Buffer.from(html), 'html', 'epub', {}, 'page.html')).buffer)).chapters[0].html;
    expect(elementsOf(chapter, new Set(['a'])).map((link) => `${link.attrs.get('href')} ${link.text}`)).toEqual(['http://example.com/x Alpha', 'http://example.com/x beta']);
  });

  it('keeps the formatting of an inline element on each block it holds', async () => {
    const html = '<body><b><div>Alpha</div><div>beta <i>gamma</i></div></b></body>';
    const chapter = (await inspectEpub((await convertFile(Buffer.from(html), 'html', 'epub', {}, 'page.html')).buffer)).chapters[0].html;
    expect(elementsOf(chapter, new Set(['strong'])).map((bold) => bold.text)).toEqual(['Alpha', 'beta', 'gamma']);
    expect(elementsOf(chapter, new Set(['p'])).map((paragraph) => paragraph.text)).toEqual(['Alpha', 'beta gamma']);
  });
});

describe('link targets a URI may not carry', () => {
  const page =
    '<body><p><a href="mailto: M.Post@example.nl">mail</a> <a href="mailto:w@example.gov?Subject=SIS Feedback">subject</a> ' +
    '<a href="http://example.gov/q?x=[a b]&amp;y=^z|w">query</a> <a href="http://www.a   b.example.gov/hrd/">host</a> ' +
    '<a href="http://example.gov/한글?x=100%">unicode</a> <a href="http://[::1]:8080/p">literal</a></p></body>';

  it('writes the target as a URI reference and leaves a web address with a space in its host unlinked', async () => {
    const chapter = (await inspectEpub((await convertFile(Buffer.from(page), 'html', 'epub', {}, 'page.html')).buffer)).chapters[0].html;
    expect(elementsOf(chapter, new Set(['a'])).map((link) => `${link.text} ${link.attrs.get('href')}`)).toEqual([
      'mail mailto:%20M.Post@example.nl',
      'subject mailto:w@example.gov?Subject=SIS%20Feedback',
      'query http://example.gov/q?x=%5Ba%20b%5D&y=%5Ez%7Cw',
      'unicode http://example.gov/%ED%95%9C%EA%B8%80?x=100%25',
      'literal http://[::1]:8080/p',
    ]);
    expect(chapter).toContain('host');
  });

  oracleTest('the EPUB passes EPUBCheck with no error and no warning', ['epubcheck'], async () => {
    const report = runEpubcheck((await convertFile(Buffer.from(page), 'html', 'epub', {}, 'page.html')).buffer);
    expect(report.messages.map((message) => `${message.severity} ${message.ID} ${message.message}`)).toEqual([]);
  }, 240_000);
});

describe('an anchor that wraps blocks', () => {
  it('keeps the name of an anchor left open around a paragraph, and the link to it', async () => {
    const html = '<body><p><a href="#skip">Skip</a></p><div><a name="skip"><p>Alpha</p><p>beta</p></a></div></body>';
    const chapter = (await inspectEpub((await convertFile(Buffer.from(html), 'html', 'epub', {}, 'page.html')).buffer)).chapters[0].html;
    expect(elementsOf(chapter, new Set(['a'])).map((anchor) => [anchor.attrs.get('href'), anchor.attrs.get('id'), anchor.text])).toEqual([
      ['#skip', undefined, 'Skip'],
      [undefined, 'skip', ''],
    ]);
    expect(elementsOf(chapter, new Set(['p'])).map((paragraph) => paragraph.text)).toEqual(['Skip', 'Alpha', 'beta']);
  });
});

describe('pages of the real-world corpus with unknown wrappers or text in a table', () => {
  const pages: Array<[string, string]> = [
    ['govdocs1-000411.html', 'an unknown element around divisions'],
    ['govdocs1-000412.html', 'an unknown element around divisions'],
    ['govdocs1-000875.html', 'an unknown element around divisions'],
    ['govdocs1-000014.html', 'an unknown element around divisions and lists'],
    ['govdocs1-002034.html', 'an unknown element around divisions and lists'],
    ['govdocs1-000070.html', 'inline elements between the cells of a row'],
  ];

  for (const [id, markup] of pages) {
    it(`${id} (${markup}) keeps the words of the page apart, as epub`, async (ctx) => {
      const sample = await requireRealworldSample(ctx, id);
      const expected = pageWords(new TextDecoder('windows-1252').decode(sample.bytes));
      expect(expected.length).toBeGreaterThan(50);
      const words = await wordsOfConversion(sample.bytes, id, 'epub');
      expect(wordsNotKept(expected, words).slice(0, 12)).toEqual([]);
    });
  }
});

describe('ids and links in the output of a page with repeated, spaced or generated ids', () => {
  const page =
    '<body><h1 id="top">Top</h1><p id="a">first</p><p id="a">second</p><a href="#a">to a</a>' +
    '<p id="my part">spaced</p><a href="#my part">space link</a> <a href="#my%20part">escaped link</a>' +
    '<p id="h-1">generated</p><a href="#h-1">generated link</a> <a href="#nowhere">dangling</a>' +
    '<p id="9lives">digit</p><a href="#9lives">digit link</a></body>';

  it('writes each EPUB id once, as a name, and every link to an id of its document', async () => {
    const report = await epubAnchors((await convertFile(Buffer.from(page), 'html', 'epub', {}, 'page.html')).buffer);
    expect(report.links.length).toBe(5);
    expect(report).toEqual({ duplicates: [], invalidNames: [], broken: [], links: report.links });
  });

  it('links the first of two equal ids, as a browser does', async () => {
    const epub = (await convertFile(Buffer.from(page), 'html', 'epub', {}, 'page.html')).buffer;
    const html = (await inspectEpub(epub)).chapters[0].html;
    const target = /<a href="#([^"]+)">to a<\/a>/.exec(html)?.[1];
    expect(target).toBe('a');
    expect(html.indexOf(`<a id="${target}"></a>first`)).toBeGreaterThan(-1);
  });

  it('keeps the link to a spaced id, written with a space or as an escape, pointing at the same id', async () => {
    const epub = (await convertFile(Buffer.from(page), 'html', 'epub', {}, 'page.html')).buffer;
    const html = (await inspectEpub(epub)).chapters[0].html;
    const spaced = /<a href="#([^"]+)">space link<\/a>/.exec(html)?.[1];
    const escaped = /<a href="#([^"]+)">escaped link<\/a>/.exec(html)?.[1];
    expect(spaced).toBe('my_part');
    expect(escaped).toBe('my_part');
    expect(html.indexOf(`<a id="${spaced}"></a>spaced`)).toBeGreaterThan(-1);
  });

  it('keeps ids apart across the content documents of one book', async () => {
    const book = '<body><h1>One</h1><p id="x">a</p><h1>Two</h1><p id="x">b</p><a href="#x">go</a></body>';
    const report = await epubAnchors((await convertFile(Buffer.from(book), 'html', 'epub', {}, 'book.html')).buffer);
    expect(report.links).toHaveLength(1);
    expect(report).toEqual({ duplicates: [], invalidNames: [], broken: [], links: report.links });
  });

  it('writes each Word bookmark once and every internal hyperlink to a bookmark', async () => {
    const report = await docxAnchors((await convertFile(Buffer.from(page), 'html', 'docx', {}, 'page.html')).buffer);
    expect(report.links.length).toBe(5);
    expect(report).toEqual({ duplicates: [], invalidNames: [], broken: [], links: report.links });
  });

  it('writes each ODF bookmark once and every internal link to a bookmark', async () => {
    const report = await odtAnchors((await convertFile(Buffer.from(page), 'html', 'odt', {}, 'page.html')).buffer);
    expect(report.links.length).toBe(5);
    expect(report).toEqual({ duplicates: [], invalidNames: [], broken: [], links: report.links });
  });

  oracleTest('the EPUB passes EPUBCheck with no error and no warning', ['epubcheck'], async () => {
    const report = runEpubcheck((await convertFile(Buffer.from(page), 'html', 'epub', {}, 'page.html')).buffer);
    expect(report.messages.map((message) => `${message.severity} ${message.ID} ${message.message}`)).toEqual([]);
  }, 240_000);
});
