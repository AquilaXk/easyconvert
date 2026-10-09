import { describe, expect, it } from 'vitest';
import { layoutPdfDocument } from '../src/lib/conversions/pdf-layout';
import { parseListMarker } from '../src/lib/conversions/pdf-layout/lists';
import { PDF_LAYOUT_MAX_STEPS_PER_PAGE, PdfLayoutLimitError } from '../src/lib/conversions/pdf-layout/limits';
import { counterLabel, markerText } from '../src/lib/conversions/document-model/counters';
import { documentToHtml } from '../src/lib/conversions/document-model/html';
import { documentToMarkdown, documentToStructuredText } from '../src/lib/conversions/document-model/markdown';
import { documentToText } from '../src/lib/conversions/document-model/text';
import type { DocumentModel, ListBlock } from '../src/lib/conversions/document-model/model';
import type { PdfContentFont, PdfContentItem, PdfContentRule, PdfPageContent } from '../src/lib/conversions/pdf-text-types';
import { expectNoHang } from './helpers/timing';

/**
 * The layout analysis on pages written out by hand (the expected structure is what the numbers say, not what the
 * code computes), the list markers of the standard numbering styles, and the writers on models written by hand.
 */

const PAGE_WIDTH = 600;
const PAGE_HEIGHT = 800;
const BODY = 12;
const CHAR_WIDTH = 6;
const REGULAR: PdfContentFont = { name: 'Body', bold: false, italic: false, monospace: false, serif: false };
const BOLD: PdfContentFont = { name: 'Body-Bold', bold: true, italic: false, monospace: false, serif: false };
const FONTS = [REGULAR, BOLD];
const COLUMN_LINES = 50_000;
const STAIRCASE_RUNS = 5_000;
const HOSTILE_TEST_TIMEOUT_MS = 60_000;

function item(text: string, x: number, baseline: number, size = BODY, font = 0): PdfContentItem {
  return { text, x, baseline, width: text.length * CHAR_WIDTH * (size / BODY), size, font, rtl: false, angled: false, vertical: false };
}

function page(items: PdfContentItem[], rules: PdfContentRule[] = []): PdfPageContent {
  return {
    pageNumber: 1,
    width: PAGE_WIDTH,
    height: PAGE_HEIGHT,
    items,
    rules,
    images: [],
    unmappedItems: 0,
    operatorsSkipped: false,
    rulesTruncated: false,
  };
}

function lines(model: DocumentModel): string[] {
  return documentToText(model).split('\n').filter((line) => line !== '');
}

describe('list markers (bullets and the counters of the standard numbering formats)', () => {
  const cases: [string, { kind: string; value: number; punctuation: string; rest: string } | null][] = [
    ['• first', { kind: 'bullet', value: 0, punctuation: 'dot', rest: 'first' }],
    ['- dash item', { kind: 'bullet', value: 0, punctuation: 'dot', rest: 'dash item' }],
    ['1. one', { kind: 'decimal', value: 1, punctuation: 'dot', rest: 'one' }],
    ['12) twelve', { kind: 'decimal', value: 12, punctuation: 'paren', rest: 'twelve' }],
    ['(3) three', { kind: 'decimal', value: 3, punctuation: 'both', rest: 'three' }],
    ['a. alpha', { kind: 'lowerLetter', value: 1, punctuation: 'dot', rest: 'alpha' }],
    ['B) bravo', { kind: 'upperLetter', value: 2, punctuation: 'paren', rest: 'bravo' }],
    ['iv. four', { kind: 'lowerRoman', value: 4, punctuation: 'dot', rest: 'four' }],
    ['XII. twelve', { kind: 'upperRoman', value: 12, punctuation: 'dot', rest: 'twelve' }],
    ['-5 degrees', null],
    ['A.Smith wrote', null],
    ['1.5 kg of flour', null],
    ['**bold** text', null],
    ['plain text', null],
  ];
  for (const [text, expected] of cases) {
    it(`reads ${JSON.stringify(text)}`, () => {
      const marker = parseListMarker(text);
      if (expected === null) expect(marker).toBeNull();
      else expect({ kind: marker?.kind, value: marker?.value, punctuation: marker?.punctuation, rest: marker?.rest }).toEqual(expected);
    });
  }

  it('labels counters in the formats of ECMA-376 17.18.59', () => {
    expect([1, 2, 26, 27, 52].map((value) => counterLabel('lowerLetter', value))).toEqual(['a', 'b', 'z', 'aa', 'az']);
    expect([4, 9, 14, 1994].map((value) => counterLabel('lowerRoman', value))).toEqual(['iv', 'ix', 'xiv', 'mcmxciv']);
    expect(counterLabel('upperRoman', 12)).toBe('XII');
    expect(markerText('decimal', 3, 'both', '')).toBe('(3)');
    expect(markerText('lowerLetter', 2, 'paren', '')).toBe('b)');
  });
});

describe('structure from positioned text', () => {
  it('reads two columns column by column under a full-width title', () => {
    const left = ['alpha one two three four', 'alpha five six seven eight', 'alpha nine ten eleven twelve', 'alpha thirteen fourteen fifteen'];
    const right = ['bravo one two three four', 'bravo five six seven eight', 'bravo nine ten eleven twelve', 'bravo thirteen fourteen fifteen'];
    const items = [item('A title across the page', 150, 60, 20, 1)];
    left.forEach((text, index) => items.push(item(text, 50, 120 + index * 14)));
    right.forEach((text, index) => items.push(item(text, 330, 120 + index * 14)));
    const model = layoutPdfDocument([page(items.reverse())], FONTS);
    expect(model.sections.map((section) => section.columns)).toEqual([1, 2]);
    const order = documentToText(model).replace(/\s+/g, ' ');
    expect(order.indexOf('A title')).toBeLessThan(order.indexOf('alpha one'));
    expect(order.indexOf('alpha thirteen')).toBeLessThan(order.indexOf('bravo one'));
  });

  it('orders a right-to-left line by its runs, keeping a left-to-right number inside', () => {
    // Drawn left to right on the page: "shalom" run, the number 42, then the first words of the sentence (right-most).
    const rtl = (text: string, x: number): PdfContentItem => ({ ...item(text, x, 100), rtl: true });
    const model = layoutPdfDocument([page([rtl('סוף', 100), item('42', 160, 100), rtl('התחלה', 200)])], FONTS);
    expect(documentToText(model)).toBe('התחלה 42 סוף');
  });

  it('makes the biggest text a level-1 heading and bold body text a lower level', () => {
    const items = [
      item('Annual report', 50, 80, 24, 1),
      item('This body paragraph has several words so that it counts as ordinary body text here.', 50, 120),
      item('and it continues on a second line of the same paragraph for good measure.', 50, 134),
      item('Method', 50, 170, BODY, 1),
      item('More body text follows the bold run-in heading and fills the line quite well.', 50, 200),
      item('and a second line to make the body size the most common one on the page.', 50, 214),
    ];
    const model = layoutPdfDocument([page(items)], FONTS);
    const blocks = model.sections.flatMap((section) => section.blocks);
    expect(blocks.map((block) => (block.type === 'heading' ? `h${block.level}` : block.type))).toEqual(['h1', 'paragraph', 'h2', 'paragraph']);
  });

  it('builds a list from bullet runs and a numbered list that counts on', () => {
    const items = [
      item('Intro text for the list, long enough to be a paragraph of its own on the page.', 50, 80),
      item('•', 70, 120),
      item('first bullet', 90, 120),
      item('•', 70, 140),
      item('second bullet', 90, 140),
      item('1.', 70, 190),
      item('numbered one', 95, 190),
      item('2.', 70, 210),
      item('numbered two', 95, 210),
    ];
    const model = layoutPdfDocument([page(items)], FONTS);
    const lists = model.sections.flatMap((section) => section.blocks).filter((block): block is ListBlock => block.type === 'list');
    expect(lists.map((list) => ({ kind: list.levels[0].kind, items: list.items.map((entry) => entry.runs.map((run) => run.text).join('')) }))).toEqual([
      { kind: 'bullet', items: ['first bullet', 'second bullet'] },
      { kind: 'decimal', items: ['numbered one', 'numbered two'] },
    ]);
  });

  it('finds a ruled table with a merged cell from its lines', () => {
    const horizontal = [100, 130, 160, 190].map((y): PdfContentRule => ({ x0: 50, y0: y, x1: 350, y1: y, thickness: 0.5 }));
    const vertical = [50, 150, 250, 350].map((x): PdfContentRule => ({ x0: x, y0: 100, x1: x, y1: 190, thickness: 0.5 }));
    // No line between the first two cells of the last row: they are one cell spanning two columns.
    const rules = [...horizontal, ...vertical.filter((rule) => rule.x0 !== 150), { x0: 150, y0: 100, x1: 150, y1: 160, thickness: 0.5 }];
    const items = [
      item('H1', 60, 120),
      item('H2', 160, 120),
      item('H3', 260, 120),
      item('a1', 60, 150),
      item('a2', 160, 150),
      item('a3', 260, 150),
      item('merged cell', 60, 180),
      item('c3', 260, 180),
    ];
    const model = layoutPdfDocument([page(items, rules)], FONTS);
    const table = model.sections.flatMap((section) => section.blocks).find((block) => block.type === 'table');
    expect(table?.type === 'table' ? table.rows.map((row) => row.map((cell) => `${cell.paragraphs.map((p) => p.runs.map((r) => r.text).join('')).join('')}:${cell.colSpan}`)) : null).toEqual([
      ['H1:1', 'H2:1', 'H3:1'],
      ['a1:1', 'a2:1', 'a3:1'],
      ['merged cell:2', 'c3:1'],
    ]);
  });

  it('rejoins a word a hyphen broke at the end of a line, and keeps a real hyphen before a capital', () => {
    const items = [
      item('The records of the organiza-', 50, 100),
      item('tion are in the old Anglo-', 50, 114),
      item('Saxon style, as it was said.', 50, 128),
    ];
    expect(lines(layoutPdfDocument([page(items)], FONTS))).toEqual(['The records of the organization are in the old Anglo-Saxon style, as it was said.']);
  });
});

describe('hostile pages', () => {
  it('refuses a page whose layout would take more steps than the limit, quickly and with a typed error', async () => {
    // Every run is on its own baseline and the runs cannot be clustered cheaply: the step budget decides.
    const items: PdfContentItem[] = [];
    for (let i = 0; i < 20_000; i++) items.push(item(`w${i}`, (i * 37) % 500, 20 + ((i * 7919) % 760)));
    const outcome = await expectNoHang(
      'hostile page',
      () => {
        try {
          return { model: layoutPdfDocument([page(items)], FONTS) };
        } catch (error) {
          return { error };
        }
      },
      20_000
    );
    // Either the page lays out within the budget or it is refused; it must never hang or fail untyped.
    if ('error' in outcome) {
      expect(outcome.error).toBeInstanceOf(PdfLayoutLimitError);
      expect((outcome.error as PdfLayoutLimitError).status).toBe(400);
      expect((outcome.error as PdfLayoutLimitError).message).toContain(String(PDF_LAYOUT_MAX_STEPS_PER_PAGE));
    } else {
      expect(outcome.model.pageCount).toBe(1);
    }
  });

  it('lays out a column of 50,000 lines top to bottom without hanging (growth ratio in the perf suite)', async () => {
    const items = Array.from({ length: COLUMN_LINES }, (_, i) => item(`r${i}`, 20, 20 + i * 20));
    const model = await expectNoHang('column of lines', () => layoutPdfDocument([page(items)], FONTS), 30_000);
    expect(documentToText(model).match(/r\d+/g)).toEqual(items.map((entry) => entry.text));
  }, HOSTILE_TEST_TIMEOUT_MS);

  it('lays out a staircase that peels one run per cut without hanging', async () => {
    const items = Array.from({ length: STAIRCASE_RUNS }, (_, i) => item(`s${i}`, 20 + (i % 5) * 100, 20 + i * 14));
    const model = await expectNoHang('staircase', () => layoutPdfDocument([page(items)], FONTS), 30_000);
    expect([...(documentToText(model).match(/s\d+/g) ?? [])].sort()).toEqual(items.map((entry) => entry.text).sort());
  }, HOSTILE_TEST_TIMEOUT_MS);

  it('lays out a page of many tiny gaps without recursing without bound', async () => {
    const items: PdfContentItem[] = [];
    for (let row = 0; row < 200; row++) for (let column = 0; column < 40; column++) items.push(item('x', 20 + column * 14, 20 + row * 3.5, 3));
    const model = await expectNoHang('dense grid', () => layoutPdfDocument([page(items)], FONTS), 20_000);
    expect(documentToText(model).replace(/[^x]/g, '')).toBe('x'.repeat(200 * 40));
  });
});

describe('writers on models written by hand', () => {
  const run = (text: string, bold = false) => ({ text, bold, italic: false, monospace: false });
  const list: ListBlock = {
    type: 'list',
    id: 1,
    levels: [
      { kind: 'decimal', punctuation: 'dot', glyph: '' },
      { kind: 'bullet', punctuation: 'dot', glyph: '•' },
    ],
    items: [
      { runs: [run('one')], level: 0, rtl: false, value: 1 },
      { runs: [run('nested a')], level: 1, rtl: false, value: 0 },
      { runs: [run('nested b')], level: 1, rtl: false, value: 0 },
      { runs: [run('two')], level: 0, rtl: false, value: 2 },
    ],
  };
  const model: DocumentModel = {
    sections: [
      {
        columns: 1,
        blocks: [
          { type: 'heading', level: 2, runs: [run('Title')], rtl: false },
          { type: 'paragraph', runs: [run('Plain '), run('bold', true), run(' and *stars* <tag> | pipe')], rtl: false, align: 'left' },
          list,
          {
            type: 'table',
            bordered: true,
            columnWidths: [100, 100],
            rows: [
              [
                { paragraphs: [{ type: 'paragraph', runs: [run('H')], rtl: false, align: 'left' }], colSpan: 2, rowSpan: 1, continuation: false, header: true },
              ],
              [
                { paragraphs: [{ type: 'paragraph', runs: [run('a|b')], rtl: false, align: 'left' }], colSpan: 1, rowSpan: 1, continuation: false, header: false },
                { paragraphs: [{ type: 'paragraph', runs: [run('c')], rtl: false, align: 'left' }], colSpan: 1, rowSpan: 1, continuation: false, header: false },
              ],
            ],
          },
        ],
      },
    ],
    images: [],
    pageWidthPt: PAGE_WIDTH,
    pageHeightPt: PAGE_HEIGHT,
    margins: { top: 72, right: 72, bottom: 72, left: 72 },
    bodySize: BODY,
    bodyFont: 'sans',
    headingSizes: [],
    pageCount: 1,
  };

  it('writes Markdown with escapes, nested list markers and a pipe table', () => {
    expect(documentToMarkdown(model)).toBe(
      [
        '## Title',
        'Plain **bold** and \\*stars\\* \\<tag\\> \\| pipe',
        '1. one\n  - nested a\n  - nested b\n2. two',
        '| H |  |\n| --- | --- |\n| a\\|b | c |',
      ].join('\n\n')
    );
  });

  it('writes structured text without Markdown escapes for the other writers', () => {
    expect(documentToStructuredText(model).split('\n\n')[1]).toBe('Plain bold and *stars* <tag> | pipe');
  });

  it('writes HTML with nested lists and a spanning header cell', () => {
    const html = documentToHtml(model, 'T & <b>');
    expect(/<title>(.*?)<\/title>/.exec(html)?.[1]).toBe('T &amp; &lt;b&gt;');
    expect(/<body>(.*)<\/body>/s.exec(html)?.[1]).toBe(
      [
        '<h2>Title</h2>',
        '<p>Plain <strong>bold</strong> and *stars* &lt;tag&gt; | pipe</p>',
        '<ol type="1"><li>one<ul><li>nested a</li><li>nested b</li></ul></li><li>two</li></ol>',
        '<table border="1"><thead><tr><th colspan="2">H</th></tr></thead><tbody><tr><td>a|b</td><td>c</td></tr></tbody></table>',
      ].join('\n')
    );
  });
});
