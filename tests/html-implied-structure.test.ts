import { describe, expect, it } from 'vitest';
import { convertFile } from '../src/lib/conversions';
import { docxWords, epubWords, odtWords, pageWords, wordsNotKept } from './helpers/document-words';
import { runEpubcheck } from './helpers/epubcheck';
import { oracleTest } from './helpers/oracle-test';
import { requireRealworldSample } from './helpers/realworld-sample';

/**
 * A page that leaves elements open (a head with no end tag, a second html tag, a table inside a table, a cell with no
 * row, a form between the rows of a table, row groups inside a column group, text between list items) is read as a browser
 * reads it, so the Word, ODF and EPUB documents made from it hold its text. Before, the body of such a page sat inside the
 * head, or the rows inside the form, and the reader dropped it: 25 of the 450 saved pages of the real-world sample
 * (govdocs1) became a document with a fraction of their text, 9 of them with none, and the EPUB writer refused those that
 * were left with nothing ("no content to put in an EPUB").
 *
 * The expected words come from parse5, a WHATWG HTML parser, reading the page: a page converts with all its words, in
 * order, or the words that were lost are listed. The derived pages also pin the phrases as literals.
 */

const TARGETS = ['docx', 'odt', 'epub'] as const;

const READERS = {
  docx: docxWords,
  odt: odtWords,
  epub: epubWords,
} as const;

async function wordsOfConversion(html: Buffer, name: string, target: (typeof TARGETS)[number]): Promise<string[]> {
  const result = await convertFile(html, 'html', target, {}, name);
  return READERS[target](result.buffer);
}

describe('pages that leave elements open, derived from the pages of the corpus', () => {
  const cases: Array<[string, string, string[]]> = [
    ['a head with no end tag', '<html><head><title>T</title><body><p>Alpha beta</p><p>gamma delta</p></body></html>', ['Alpha', 'beta', 'gamma', 'delta']],
    ['a text in a head with no end tag', '<html><head><title>T</title>Alpha beta<p>gamma delta</p></html>', ['Alpha', 'beta', 'gamma', 'delta']],
    ['a second head and a second html tag', '<html><head><title>T</title><head><html><body><p>Alpha beta</p></body></html>', ['Alpha', 'beta']],
    ['a table directly inside a table', '<body><table border><table><tr><td>Alpha beta</td></tr></table></table><p>gamma</p></body>', ['Alpha', 'beta', 'gamma']],
    ['a cell with no row', '<body><table><td>Alpha</td><td>beta</td></table></body>', ['Alpha', 'beta']],
    ['a cell after its row was closed', '<body><table><tr><td>Alpha</td></tr></tr><td>beta</td></table></body>', ['Alpha', 'beta']],
    ['a form between the rows of a table', '<body><table><form><tr><td>Alpha</td><td>beta</td></tr></form></table></body>', ['Alpha', 'beta']],
    ['row groups inside a column group', '<body><table><colgroup><thead><tr><th>Alpha</th></tr></thead><tbody><tr><td>beta</td></tr></tbody></table></body>', ['Alpha', 'beta']],
    ['text and paragraphs between list items', '<body><ul><p>Alpha</p><li>beta</li><a href="#x">gamma</a><li>delta</li></ul></body>', ['Alpha', 'beta', 'gamma', 'delta']],
  ];

  for (const [label, html, phrases] of cases) {
    for (const target of TARGETS) {
      it(`keeps the text of a page with ${label}, as ${target}`, async () => {
        const words = await wordsOfConversion(Buffer.from(html), 'page.html', target);
        expect(wordsNotKept(phrases, words).slice(0, 12)).toEqual([]);
        expect(wordsNotKept(pageWords(html), words).slice(0, 12)).toEqual([]);
      });
    }
  }
});

describe('pages of the real-world corpus that were left with a fraction of their text', () => {
  // What is wrong with each page is named by what its markup does; the first nine were left with no text at all.
  const pages: Array<[string, string]> = [
    ['govdocs1-000213.html', 'head with no end tag before the body'],
    ['govdocs1-000433.html', 'table inside a table with no row between'],
    ['govdocs1-000635.html', 'second html and head tags inside the first head'],
    ['govdocs1-000636.html', 'second html and head tags inside the first head'],
    ['govdocs1-001419.html', 'second html and head tags inside the first head'],
    ['govdocs1-001518.html', 'head repeated with a body and preformatted text after it'],
    ['govdocs1-001526.html', 'text and links directly in a list'],
    ['govdocs1-001533.html', 'paragraphs and divisions directly in a list'],
    ['govdocs1-001778.html', 'second html and head tags inside the first head'],
    ['govdocs1-001410.html', 'cells with no row'],
    ['govdocs1-000207.html', 'rows inside a form inside a table'],
    ['govdocs1-000634.html', 'row groups inside a column group'],
  ];

  for (const [id, markup] of pages) {
    for (const target of TARGETS) {
      it(`${id} (${markup}) keeps its text as ${target}`, async (ctx) => {
        const sample = await requireRealworldSample(ctx, id);
        const expected = pageWords(new TextDecoder('windows-1252').decode(sample.bytes));
        expect(expected.length).toBeGreaterThan(50);
        const words = await wordsOfConversion(sample.bytes, id, target);
        expect(wordsNotKept(expected, words).slice(0, 12)).toEqual([]);
      });
    }
  }
});

describe('pages of the real-world corpus that hold no text', () => {
  // What each page holds, read from its bytes: a frameset of frames and no body, a page of tags and blanks only, and a body with no content that sends the reader elsewhere.
  const pages: Array<[string, string]> = [
    ['govdocs1-001781.html', 'a frameset of three frames, no body'],
    ['govdocs1-000798.html', 'a frameset and its frames, no body'],
    ['govdocs1-002007.html', 'tags and blank lines only'],
    ['govdocs1-002028.html', 'an empty body and a meta refresh'],
  ];

  for (const [id, markup] of pages) {
    for (const target of TARGETS) {
      it(`${id} (${markup}) converts to a ${target} without words, as the page has none`, async (ctx) => {
        const sample = await requireRealworldSample(ctx, id);
        expect(pageWords(new TextDecoder('windows-1252').decode(sample.bytes))).toEqual([]);
        const result = await convertFile(sample.bytes, 'html', target, {}, id);
        expect(await READERS[target](result.buffer)).toEqual([]);
      });
    }
  }

  oracleTest('the EPUB of a frameset page passes EPUBCheck with no error and no warning', ['epubcheck'], async (ctx) => {
    const sample = await requireRealworldSample(ctx, 'govdocs1-001781.html');
    const report = runEpubcheck((await convertFile(sample.bytes, 'html', 'epub', {}, 'govdocs1-001781.html')).buffer);
    expect(report.messages.map((message) => `${message.severity} ${message.ID} ${message.message}`)).toEqual([]);
  }, 240_000);
});
