import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { stageHtmlForNativeEngine } from '../src/lib/conversions/html-native-staging';
import { executeWorkerConversion, libreOfficePool } from '../src/worker/engines';
import { htmlText, lostCharacters, pdfWordBoxes, withCapturingSoffice, wordsOutsidePage } from './helpers/html-pdf-oracle';
import { pdfFacts } from './helpers/corpus-facts';
import { pdfInternalLinkTargets } from './helpers/pdf-link-targets';
import { oracleTest } from './helpers/oracle-test';
import { requireRealworldSample } from './helpers/realworld-sample';

/**
 * Words of a page must stay on the page the office suite draws them on. Three layouts of table pages made it lose them, each
 * measured on LibreOffice 24.2 and each fixed in the page the suite is handed (docs/policy-decisions.md entry 68):
 *   - a `nowrap` cell followed by a cell that starts with a table: the suite sizes that table by its longest line, and the
 *     cell and the cells after it run past the right edge of the page;
 *   - a table wider than the page (a fixed `width` above 718 px, the width from the left margin to the page edge): its right
 *     part is past the page edge, where nothing is drawn;
 *   - a `div` or `center` with an `id`: the suite makes a section of it, and a table row that holds a section, or a section
 *     that holds tables, is cut off at the end of the page it starts on.
 * The oracles are parse5 (the words the page holds, and the staged page) and Poppler (`pdftotext -bbox`: the words of the PDF
 * and their boxes). A word outside the page box, or a letter or digit of the page that the PDF text lacks, fails a test.
 */

const LIBREOFFICE_TIMEOUT_MS = 180_000;
const TOOLS: Array<'soffice' | 'pdftotext' | 'pdfinfo' | 'qpdf'> = ['soffice', 'pdftotext', 'pdfinfo', 'qpdf'];
/** Longer than the 17 cm text area at the size of the body text, so that it cannot be drawn on one line of the page. */
const LONG_LINE_WORDS = 30;
/** More rows than fit on three pages. */
const TALL_TABLE_ROWS = 120;

let poolWasEnabled = false;

beforeAll(() => {
  // The pool daemon cannot start in some sandboxes; one-shot LibreOffice runs the same filter.
  poolWasEnabled = libreOfficePool.isEnabled();
  libreOfficePool.disable();
});

afterAll(() => {
  if (poolWasEnabled) libreOfficePool.enable();
});

function words(prefix: string, count: number): string[] {
  return Array.from({ length: count }, (_, index) => `${prefix}${String.fromCharCode(97 + (index % 26))}${index}`);
}

function page(body: string): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>page</title></head><body>${body}</body></html>`;
}

function longLine(prefix: string): string {
  return words(prefix, LONG_LINE_WORDS).join(' ');
}

function tallTable(prefix: string): string {
  const rows = words(prefix, TALL_TABLE_ROWS).map((word) => `<tr><td>${word} text text</td><td>${word}x</td></tr>`);
  return `<table width="100%">${rows.join('')}</table>`;
}

async function toPdf(html: string): Promise<Buffer> {
  return (await executeWorkerConversion(Buffer.from(html, 'utf-8'), 'html', 'pdf', {}, 'page.html')).buffer;
}

/** What the PDF lacks of the page: letters and digits missing from its text, and words whose box leaves the page. */
function losses(html: string, pdf: Buffer): { lostCharacters: number; outsidePage: string[] } {
  return { lostCharacters: lostCharacters(htmlText(html), pdfFacts(pdf).text), outsidePage: wordsOutsidePage(pdfWordBoxes(pdf)) };
}

const NO_LOSS = { lostCharacters: 0, outsidePage: [] };

describe('a nowrap cell before a cell that starts with a table', () => {
  const nested = (line: string): string => `<table width="100%"><tr><td>${line}</td></tr></table>`;
  const row = (cells: string): string => `<table width="100%"><tr valign="top">${cells}</tr></table>`;

  oracleTest(
    'keeps the long line, the cell after it and the cell itself on the page',
    TOOLS,
    async () => {
      const html = page(row(`<td nowrap>datecell</td><td>${nested(longLine('title'))}</td><td>trailercell</td>`));
      expect(losses(html, await toPdf(html))).toEqual(NO_LOSS);
    },
    LIBREOFFICE_TIMEOUT_MS
  );

  oracleTest(
    'keeps the page of a row with two nowrap cells and fixed percentage widths',
    TOOLS,
    async () => {
      const html = page(
        row(`<td nowrap>1</td><td nowrap>21 Oct 2008</td><td width="35%">${nested(longLine('title'))}</td><td width="30%">${longLine('author')}</td><td>pdfcell</td>`).repeat(3)
      );
      expect(losses(html, await toPdf(html))).toEqual(NO_LOSS);
    },
    LIBREOFFICE_TIMEOUT_MS
  );

  it('writes nowrap only where the next cell does not start with a table', async () => {
    const staged = await stageHtmlForNativeEngine(
      page(
        row(
          `<td nowrap>before-table</td><td>${nested('a')}</td>` +
            `<td nowrap>before-text</td><td>text ${nested('b')}</td>` +
            `<td nowrap>before-wrapper</td><td><script>1</script> <noindex>${nested('c')}</noindex></td>` +
            `<td nowrap>before-paragraph</td><td><p>${nested('d')}</p></td>` +
            `<td nowrap>last</td>`
        )
      )
    );
    const cells = [...staged.html.matchAll(/<td( nowrap="")?>(before-[a-z]+|last)</g)].map((match) => [match[2], match[1] !== undefined]);
    expect(cells).toEqual([
      ['before-table', false],
      ['before-text', true],
      ['before-wrapper', false],
      ['before-paragraph', true],
      ['last', true],
    ]);
  });
});

describe('a table wider than the page', () => {
  const wide = (width: string, line: string): string => `<table width="${width}" border="1"><tr><td align="right">${line}</td></tr></table>`;

  oracleTest(
    'keeps the words of a table wider than the page on the page',
    TOOLS,
    async () => {
      const html = page(wide('800', longLine('wide')));
      expect(losses(html, await toPdf(html))).toEqual(NO_LOSS);
    },
    LIBREOFFICE_TIMEOUT_MS
  );

  oracleTest(
    'keeps the words of a wide table that is in a cell of another table',
    TOOLS,
    async () => {
      const html = page(`<table width="100%"><tr><td>${wide('750', longLine('inner'))}</td></tr></table>`);
      expect(losses(html, await toPdf(html))).toEqual(NO_LOSS);
    },
    LIBREOFFICE_TIMEOUT_MS
  );

  it('writes a fixed width past the page edge as the width up to the edge, and every other width as it is', async () => {
    const widths = ['642', '718', '719', '754', ' 800px ', '100%', '90%', '', '0', 'auto', '1e3'];
    const staged = await stageHtmlForNativeEngine(page(widths.map((width) => `<table width="${width}"><tr><td>x</td></tr></table>`).join('')));
    expect([...staged.html.matchAll(/<table( width="[^"]*")?>/g)].map((match) => match[1] ?? null)).toEqual([
      ' width="642"',
      ' width="718"',
      ' width="718"',
      ' width="718"',
      ' width="718"',
      ' width="100%"',
      ' width="90%"',
      ' width=""',
      ' width="0"',
      ' width="auto"',
      ' width="1e3"',
    ]);
  });
});

describe('a division with an id', () => {
  const sectionRows = (tag: string): string =>
    `<table width="100%"><tr><td><${tag} id="top">sectionword</${tag}></td></tr><tr><td>${tallTable('row')}</td></tr></table>`;

  for (const tag of ['div', 'center']) {
    oracleTest(
      `keeps the rows after the page break when a <${tag} id> sits in a row above them`,
      TOOLS,
      async () => {
        const html = page(sectionRows(tag));
        const pdf = await toPdf(html);
        expect({ ...losses(html, pdf), pages: pdfFacts(pdf).pages > 1 }).toEqual({ ...NO_LOSS, pages: true });
      },
      LIBREOFFICE_TIMEOUT_MS
    );
  }

  oracleTest(
    'still makes the id of a division a link target',
    TOOLS,
    async () => {
      const html = page(
        `<p><a href="#target">jump</a></p><table width="100%"><tr><td>before</td></tr><tr><td><div id="target">anchoredword</div> after</td></tr></table>`
      );
      expect(pdfInternalLinkTargets(await toPdf(html))).toEqual([{ link: 'jump', page: 1, after: 'anchoredword' }]);
    },
    LIBREOFFICE_TIMEOUT_MS
  );

  it('does not write the id of a div or center in a cell or around a table, unless a style sheet names it, and keeps every anchor', async () => {
    const staged = await stageHtmlForNativeEngine(
      page(
        `<style>#styled { color: red } div#also-styled > p { margin: 0 } #prefix-of-longer-id-x { margin: 0 }</style>` +
          `<div id="outside">a</div><center id="centered">b</center><section id="sec">c</section>` +
          `<table><tr><td><div id="inner">d</div><center id="innercenter">e</center><div id="styled">f</div><div id="also-styled">g</div>` +
          `<div id="prefix-of-longer-id">h</div><div id="prefix">i</div></td></tr></table>` +
          `<div id="wraps"><p>j</p><table><tr><td>k</td></tr></table></div><div id="after">l</div>`
      )
    );
    const elements = [...staged.html.matchAll(/<(div|center|section)(?: id="([a-z-]+)")?>/g)].map((match) => [match[1], match[2] ?? null]);
    expect(elements).toEqual([
      ['div', 'outside'],
      ['center', 'centered'],
      ['section', 'sec'],
      ['div', null],
      ['center', null],
      ['div', 'styled'],
      ['div', 'also-styled'],
      ['div', null],
      ['div', null],
      ['div', null],
      ['div', 'after'],
    ]);
    // The named anchor that is the link target of each division stays, whether or not its id is written.
    expect([...staged.html.matchAll(/<a name="([a-z-]+)"><\/a>/g)].map((match) => match[1])).toEqual([
      'outside',
      'centered',
      'sec',
      'inner',
      'innercenter',
      'styled',
      'also-styled',
      'prefix-of-longer-id',
      'prefix',
      'wraps',
      'after',
    ]);
  });
});

describe('a real page of the public corpus', () => {
  let imageFetch: string | undefined;

  beforeEach(() => {
    imageFetch = process.env.HTML_IMAGE_FETCH;
    process.env.HTML_IMAGE_FETCH = 'off';
  });

  afterEach(() => {
    if (imageFetch === undefined) delete process.env.HTML_IMAGE_FETCH;
    else process.env.HTML_IMAGE_FETCH = imageFetch;
  });

  // 001742: a record table whose cells are nowrap before nested tables, in a 754 px table, beside a division with an id.
  // 000209: one division with an id that holds every table of the page. 001413: 25 divisions with ids in table cells.
  for (const id of ['govdocs1-001742.html', 'govdocs1-000209.html', 'govdocs1-001413.html']) {
    oracleTest(
      `${id} keeps every word of the page the office suite is handed on the page`,
      TOOLS,
      async (ctx) => {
        const { bytes } = await requireRealworldSample(ctx, id);
        const convert = (): ReturnType<typeof executeWorkerConversion> => executeWorkerConversion(bytes, 'html', 'pdf', {}, id);
        const handed = await withCapturingSoffice(convert);
        expect(losses(handed, (await convert()).buffer)).toEqual(NO_LOSS);
      },
      LIBREOFFICE_TIMEOUT_MS
    );
  }
});
