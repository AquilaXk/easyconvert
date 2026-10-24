import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { convertFile } from '../src/lib/conversions/index';
import { ConversionFailedError, EngineUnavailableError } from '../src/lib/types';
import { requireOracleTool } from './helpers/differential-oracle';
import { pageWords } from './helpers/document-words';
import { pdfFacts } from './helpers/corpus-facts';
import { lostCharacters, pdfWordBoxes, wordsOutsidePage } from './helpers/html-pdf-oracle';
import { pdfLinks } from './helpers/pdf-named-links';
import { withMissingBinary } from './helpers/native-tools';
import { oracleTest } from './helpers/oracle-test';
import { pageRectangles } from './helpers/pdf-rectangles';
import { popplerWords, type WordBox } from './helpers/poppler-words';
import { requireRealworldSample } from './helpers/realworld-sample';

/**
 * Tables inside table cells and table rows taller than a page, on the in-process route (no office suite). Poppler reads
 * the PDFs: `pdftotext -bbox-layout` for word positions, `pdfinfo` for page counts, `pdfimages -list` for the size a picture
 * is placed at; pdf-lib reads the rectangles of the content stream. The expected positions follow from the HTML structure
 * (which cell is left of which, which row is below which) and from the page geometry (A4 with 50 pt margins), not from the
 * renderer. The real pages of the corpus are read by parse5 for the words they hold.
 */

const TOOLS: Array<'pdftotext' | 'pdfinfo' | 'pdfimages'> = ['pdftotext', 'pdfinfo', 'pdfimages'];
const PAGE_MARGIN = 50;
const A4_HEIGHT_PT = 841.89;
const A4_WIDTH_PT = 595.28;
const BOTTOM_EDGE = A4_HEIGHT_PT - PAGE_MARGIN;
const RIGHT_EDGE = A4_WIDTH_PT - PAGE_MARGIN;
const POSITION_TOLERANCE_PT = 0.6;
/** Poppler's word boxes start at the glyph's origin plus its left bearing. */
const GLYPH_BEARING_PT = 1.5;
const LINE_HEIGHT_PT = 16;
const MAX_TABLE_DEPTH = 32;
/** The space between a cell's border and its text, and the narrowest column, in points. */
const TABLE_PADDING_PT = 4;
const MIN_COLUMN_PT = 24;

/** Converts without the office suite, so the in-process renderer is the route. */
const inProcess = (html: string, options: Record<string, unknown> = {}): ReturnType<typeof convertFile> =>
  withMissingBinary('SOFFICE_PATH', () => convertFile(Buffer.from(html, 'utf-8'), 'html', 'pdf', options, 'page.html'));

/** The word `text` of the PDF, the `nth` time it occurs in reading order. */
function wordAt(words: readonly WordBox[], text: string, nth = 0): WordBox {
  const found = words.filter((word) => word.text === text)[nth];
  if (!found) throw new Error(`the PDF has no word ${text} (occurrence ${nth}); it has ${words.map((word) => word.text).join(' ')}`);
  return found;
}

/** `prefix001` to `prefixNNN`. */
function numbered(count: number, prefix: string): string[] {
  return Array.from({ length: count }, (_, index) => `${prefix}${String(index + 1).padStart(3, '0')}`);
}

/** The numbered words of the PDF in the order Poppler reads them, by page then top to bottom. */
function numberedWordsByPage(words: readonly WordBox[], prefix: string): WordBox[] {
  return words.filter((word) => word.text.startsWith(prefix)).sort((a, b) => a.page - b.page || a.y0 - b.y0);
}

describe('tables inside table cells', () => {
  oracleTest(
    'lays a table out inside its cell, to the right of the cell before it, rows and columns in order',
    TOOLS,
    async () => {
      const result = await inProcess(
        '<table><tr><td>outer</td><td><table><tr><td>alpha</td><td>bravo</td></tr><tr><td colspan="2">charlie</td></tr></table></td></tr></table>'
      );
      const words = popplerWords(result.buffer);
      const [outer, alpha, bravo, charlie] = ['outer', 'alpha', 'bravo', 'charlie'].map((text) => wordAt(words, text));
      expect({ pages: pdfFacts(result.buffer).pages, words: words.map((word) => word.text).sort() }).toEqual({ pages: 1, words: ['alpha', 'bravo', 'charlie', 'outer'] });
      expect(outer.x1).toBeLessThan(alpha.x0);
      expect(alpha.x1).toBeLessThan(bravo.x0);
      expect(bravo.x1).toBeLessThan(RIGHT_EDGE);
      expect(charlie.y0).toBeGreaterThan(alpha.y1 - POSITION_TOLERANCE_PT);
      expect(Math.abs(charlie.x0 - alpha.x0)).toBeLessThan(POSITION_TOLERANCE_PT);
      expect(Math.abs(bravo.y0 - alpha.y0)).toBeLessThan(POSITION_TOLERANCE_PT);
    }
  );

  oracleTest(
    'places a cell that merges downward beside the rows it spans, in a table and in a table inside a cell',
    TOOLS,
    async () => {
      const result = await inProcess(
        '<table><tr><td rowspan="2">alpha</td><td>bravo</td></tr><tr><td>charlie</td></tr></table>' +
          '<table><tr><td>lead</td><td><table><tr><td rowspan="2">delta</td><td>echo</td></tr><tr><td>foxtrot</td></tr></table></td></tr></table>'
      );
      const words = popplerWords(result.buffer);
      const [alpha, bravo, charlie, delta, echo, foxtrot] = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot'].map((text) => wordAt(words, text));
      for (const [merged, upper, lower] of [
        [alpha, bravo, charlie],
        [delta, echo, foxtrot],
      ]) {
        expect(merged.x1).toBeLessThan(upper.x0);
        expect(Math.abs(lower.x0 - upper.x0)).toBeLessThan(POSITION_TOLERANCE_PT);
        expect(lower.y0).toBeGreaterThan(upper.y1 - POSITION_TOLERANCE_PT);
      }
    }
  );

  oracleTest(
    'gives each column of a table, with or without a table inside it, the width its content asks for',
    TOOLS,
    async () => {
      const long = 'many words that fill the wide column of the table and run on '.repeat(6).trim();
      const nested = await inProcess(`<table><tr><td>ab</td><td><table><tr><td>${long}</td></tr></table></td></tr></table>`);
      const plain = await inProcess(`<table><tr><td>ab</td><td>${long}</td></tr></table>`);
      const textStart = (pdf: Buffer): number => wordAt(popplerWords(pdf), 'many').x0;
      // The short column is as wide as `ab` and its padding; equal columns would start the long one at half the text width.
      expect({ plain: textStart(plain.buffer) < PAGE_MARGIN + 60, nested: textStart(nested.buffer) < PAGE_MARGIN + 60 }).toEqual({ plain: true, nested: true });
    }
  );

  oracleTest(
    'draws a table nested at the deepest level and refuses one level more, with the limit named',
    TOOLS,
    async () => {
      const nest = (tables: number): string => `${'<table><tr><td>'.repeat(tables)}deepest${'</td></tr></table>'.repeat(tables)}`;
      const atLimit = await inProcess(nest(MAX_TABLE_DEPTH + 1));
      expect(popplerWords(atLimit.buffer).map((word) => word.text)).toEqual(['deepest']);
      const refusal = await inProcess(nest(MAX_TABLE_DEPTH + 2)).catch((error: unknown) => error);
      expect(refusal).toBeInstanceOf(EngineUnavailableError);
      expect((refusal as Error).message).toBe(
        `Engine 'soffice' is unavailable: HTML tables nested more than ${MAX_TABLE_DEPTH} levels deep cannot be drawn by the in-process PDF renderer; rendering it needs the native LibreOffice engine`
      );
    }
  );

  it('answers a page nested far past the limit with a typed refusal, quickly', async () => {
    const started = Date.now();
    const refusal = await inProcess(`${'<table><tr><td>'.repeat(400)}x${'</td></tr></table>'.repeat(400)}`).catch((error: unknown) => error);
    expect(refusal instanceof EngineUnavailableError || refusal instanceof ConversionFailedError).toBe(true);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('refuses a cell spanning a thousand columns as too wide for the page, quickly, whatever its rowspan', async () => {
    const started = Date.now();
    const refusal = await inProcess('<table><tr><td colspan="1000" rowspan="65534">x</td></tr></table>').catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(EngineUnavailableError);
    expect((refusal as Error).message).toMatch(/a table with 1000 columns does not fit the page width/);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  oracleTest(
    'cuts a rowspan at the last row, however large it is, and a rowspan of 0 spans the rest',
    TOOLS,
    async () => {
      const result = await inProcess(
        '<table><tr><td rowspan="65534">alpha</td><td>bravo</td></tr><tr><td>charlie</td></tr><tr><td>delta</td></tr></table>' +
          '<table><tr><td rowspan="0">echo</td><td>foxtrot</td></tr><tr><td>golf</td></tr></table>'
      );
      const words = popplerWords(result.buffer);
      for (const [merged, upper, lower] of [
        ['alpha', 'bravo', 'delta'],
        ['echo', 'foxtrot', 'golf'],
      ]) {
        expect(wordAt(words, merged).x1).toBeLessThan(wordAt(words, upper).x0);
        expect(Math.abs(wordAt(words, lower).x0 - wordAt(words, upper).x0)).toBeLessThan(POSITION_TOLERANCE_PT);
      }
      expect(pdfFacts(result.buffer).pages).toBe(1);
    }
  );

  it('converts two thousand rows tied by one merged cell in bounded time', async () => {
    const rows = numbered(2000, 'row').map((word, index) => (index === 0 ? `<tr><td rowspan="2000">first</td><td>${word}</td></tr>` : `<tr><td>${word}</td></tr>`));
    const started = Date.now();
    const result = await inProcess(`<table>${rows.join('')}</table>`);
    const elapsed = Date.now() - started;
    expect(popplerWords(result.buffer).filter((word) => word.text.startsWith('row')).length).toBe(2000);
    expect({ underBound: elapsed < 30_000, elapsed }).toEqual({ underBound: true, elapsed });
  }, 60_000);

  oracleTest(
    'leaves a plain xmp element as literal preformatted text',
    TOOLS,
    async () => {
      const result = await inProcess('<p>before</p><xmp><b>kept</b> as text</xmp><p>after</p>');
      expect(pdfFacts(result.buffer).text).toBe('before <b>kept</b> as text after');
    }
  );
});

describe('the width of a table, and pages whose tables are wider than the paper', () => {
  const TEXT_WIDTH_PT = A4_WIDTH_PT - 2 * PAGE_MARGIN;
  /** The most a print engine shrinks a page to fit its widest content (Blink's printingMaximumShrinkFactor). */
  const MAXIMUM_SHRINK = 1.5;
  /** Height of the box Poppler gives a word of `pdf`: the font size it is drawn at, times a constant of the font. */
  const wordHeight = (pdf: Buffer, text: string): number => {
    const word = wordAt(popplerWords(pdf), text);
    return word.y1 - word.y0;
  };
  /** A row of `count` cells holding their column's number, narrower than the narrowest column, so each column is 24 pt. */
  const wideRow = (count: number): string => `<table><tr>${Array.from({ length: count }, (_, index) => `<td>${index + 1}</td>`).join('')}</tr></table>`;

  oracleTest(
    'makes a table without a width as wide as its content, as browsers do, and one with a width as wide as it says',
    TOOLS,
    async () => {
      const content = popplerWords((await inProcess('<table><tr><td>alpha</td><td>bravo</td></tr></table>')).buffer);
      expect(wordAt(content, 'bravo').x1).toBeLessThan(PAGE_MARGIN + 80);
      // Two columns that ask for the same width share what the table states: half of the text width, or of 200 px (150 pt).
      const full = popplerWords((await inProcess('<table width="100%"><tr><td>same</td><td>same</td></tr></table>')).buffer);
      expect(Math.abs(wordAt(full, 'same', 1).x0 - (PAGE_MARGIN + TEXT_WIDTH_PT / 2 + TABLE_PADDING_PT))).toBeLessThan(GLYPH_BEARING_PT);
      const fixed = popplerWords((await inProcess('<table width="200"><tr><td>same</td><td>same</td></tr></table>')).buffer);
      expect(Math.abs(wordAt(fixed, 'same', 1).x0 - (PAGE_MARGIN + 75 + TABLE_PADDING_PT))).toBeLessThan(GLYPH_BEARING_PT);
    }
  );

  oracleTest(
    'places a narrow table in the middle or at the right where its align attribute or an aligning ancestor puts it',
    TOOLS,
    async () => {
      const words = popplerWords(
        (
          await inProcess(
            '<table align="center"><tr><td>alpha</td></tr></table><center><table><tr><td>bravo</td></tr></table></center>' +
              '<div align="right"><table><tr><td>charlie</td></tr></table></div><center><table align="left"><tr><td>delta</td></tr></table></center>'
          )
        ).buffer
      );
      const middle = (word: WordBox): number => (word.x0 + word.x1) / 2;
      expect(Math.abs(middle(wordAt(words, 'alpha')) - A4_WIDTH_PT / 2)).toBeLessThan(GLYPH_BEARING_PT);
      expect(Math.abs(middle(wordAt(words, 'bravo')) - A4_WIDTH_PT / 2)).toBeLessThan(GLYPH_BEARING_PT);
      expect(Math.abs(wordAt(words, 'charlie').x1 - (RIGHT_EDGE - TABLE_PADDING_PT))).toBeLessThan(GLYPH_BEARING_PT);
      expect(Math.abs(wordAt(words, 'delta').x0 - (PAGE_MARGIN + TABLE_PADDING_PT))).toBeLessThan(GLYPH_BEARING_PT);
    }
  );

  oracleTest(
    'shrinks a page whose table needs more than the text width, as print engines do, keeping every word on the page',
    TOOLS,
    async () => {
      // 25 columns of at least 24 pt need 600 pt of a 495.28 pt text width: the page is drawn 600 / 495.28 times smaller.
      const plain = await inProcess('<p>Reading size</p>');
      const shrunk = await inProcess(`<p>Reading size</p>${wideRow(25)}`);
      const boxes = pdfWordBoxes(shrunk.buffer);
      expect({ outside: wordsOutsidePage(boxes), pageWidths: [...new Set(boxes.map((box) => box.pageWidth))], columns: boxes.filter((box) => /^\d+$/.test(box.text)).map((box) => Number(box.text)) }).toEqual({
        outside: [],
        pageWidths: [Number(A4_WIDTH_PT.toFixed(6))],
        columns: Array.from({ length: 25 }, (_, index) => index + 1),
      });
      const scale = wordHeight(shrunk.buffer, 'Reading') / wordHeight(plain.buffer, 'Reading');
      expect(Math.abs(scale - TEXT_WIDTH_PT / (25 * MIN_COLUMN_PT))).toBeLessThan(0.01);
    }
  );

  oracleTest(
    'shrinks a page to a table whose pixel width is wider than the text, and keeps links landing on their line',
    TOOLS,
    async () => {
      // 900 px is 675 pt.
      const plain = await inProcess('<p>Reading size</p>');
      const shrunk = await inProcess(
        `<p>Reading size <a href="#far">jump</a></p><table width="900"><tr><td>alpha</td><td>bravo</td></tr></table>${'<p>filler line</p>'.repeat(80)}<h2 id="far">Target heading</h2>`
      );
      expect(wordsOutsidePage(pdfWordBoxes(shrunk.buffer))).toEqual([]);
      const scale = wordHeight(shrunk.buffer, 'Reading') / wordHeight(plain.buffer, 'Reading');
      expect(Math.abs(scale - TEXT_WIDTH_PT / 675)).toBeLessThan(0.01);
      const [link] = pdfLinks(shrunk.buffer);
      expect({ text: link.text, line: link.line }).toEqual({ text: 'jump', line: ['Target', 'heading'] });
    }
  );

  oracleTest(
    'refuses a page that would have to shrink more than a print engine shrinks one, with the limit named',
    TOOLS,
    async () => {
      // 40 columns need 960 pt: 1.94 times the text width.
      const refusal = await inProcess(wideRow(40)).catch((error: unknown) => error);
      expect(refusal).toBeInstanceOf(EngineUnavailableError);
      expect((refusal as Error).message).toMatch(new RegExp(`a table with 40 columns does not fit the page width: it needs 960pt of 495pt, and a page is shrunk at most ${MAXIMUM_SHRINK} times`));
    }
  );

  oracleTest(
    'answers absurd widths and spans in bounded time: a table of 99999999 px and one of 100000 %',
    TOOLS,
    async () => {
      const started = Date.now();
      const result = await inProcess('<table width="99999999"><tr><td>alpha</td></tr></table><table width="100000%"><tr><td>bravo</td></tr></table>');
      expect({ outside: wordsOutsidePage(pdfWordBoxes(result.buffer)), text: pdfFacts(result.buffer).text }).toEqual({ outside: [], text: 'alpha bravo' });
      expect(Date.now() - started).toBeLessThan(5_000);
    }
  );

  oracleTest(
    'converts govdocs1-001143 (four columns holding a 14-column table, 768 pt of 741 pt) in landscape with every word on the page',
    TOOLS,
    async (ctx) => {
      const { bytes } = await requireRealworldSample(ctx, 'govdocs1-001143.html');
      const result = await convertFile(bytes, 'html', 'pdf', { orientation: 'landscape' }, 'govdocs1-001143.html');
      // A word in a column narrower than the word is broken, so the letters and digits are counted, not the words.
      const pdfText = execFileSync(requireOracleTool('pdftotext'), ['-', '-'], { input: result.buffer, encoding: 'utf-8' });
      expect({ outside: wordsOutsidePage(pdfWordBoxes(result.buffer)), lost: lostCharacters(pageWords(bytes.toString('latin1')).join(' '), pdfText) }).toEqual({ outside: [], lost: 0 });
    },
    60_000
  );
});

describe('table rows taller than a page', () => {
  const rowOf = (side: string, count: number): string => `<p>before</p><table><tr><td>${side}</td><td>${numbered(count, 'line').join('<br>')}</td></tr><tr><td>next</td><td>row</td></tr></table>`;

  oracleTest(
    'continues the cells of a row of three pages on the next pages, line by line, with the borders drawn on every page',
    TOOLS,
    async () => {
      const result = await inProcess(rowOf('side', 150));
      const words = popplerWords(result.buffer);
      const lines = numberedWordsByPage(words, 'line');
      const pages = pdfFacts(result.buffer).pages;
      // Every line once, in order, spread over at least three pages and none of them left empty.
      expect(lines.map((word) => word.text)).toEqual(numbered(150, 'line'));
      const pagesWithLines = [...new Set(lines.map((word) => word.page))];
      expect({ pages, pagesWithLines }).toEqual({ pages, pagesWithLines: Array.from({ length: pages }, (_, index) => index + 1) });
      expect(pages).toBeGreaterThanOrEqual(3);
      // A page that the row goes on from is filled to the bottom margin.
      for (const page of pagesWithLines.slice(0, -1)) {
        const last = lines.filter((word) => word.page === page).at(-1) as WordBox;
        expect(last.y1).toBeLessThanOrEqual(BOTTOM_EDGE + POSITION_TOLERANCE_PT);
        expect(last.y1).toBeGreaterThan(BOTTOM_EDGE - 2 * LINE_HEIGHT_PT);
      }
      // The short cell is drawn once, with the first lines; the row after the tall one follows its last line.
      expect({ sidePage: wordAt(words, 'side').page, nextPage: wordAt(words, 'next').page }).toEqual({ sidePage: 1, nextPage: pages });
      expect(wordAt(words, 'next').y0).toBeGreaterThan((lines.at(-1) as WordBox).y1 - POSITION_TOLERANCE_PT);
      // Both cells of the row have their box on each page the row is on: two rectangles reach the bottom margin.
      const rectangles = await pageRectangles(result.buffer);
      for (const page of pagesWithLines.slice(0, -1)) {
        const reachingBottom = rectangles[page - 1].filter((rectangle) => Math.abs(rectangle.y + rectangle.height - BOTTOM_EDGE) < POSITION_TOLERANCE_PT);
        expect({ page, boxes: reachingBottom.length }).toEqual({ page, boxes: 2 });
      }
    },
    60_000
  );

  oracleTest(
    'cuts a row taller than a page inside a cell that holds a table, keeping every line in order',
    TOOLS,
    async () => {
      const result = await inProcess(
        `<table><tr><td>lead</td><td><table><tr><td>${numbered(150, 'line').join('<br>')}</td><td>tail</td></tr></table></td></tr></table>`
      );
      const words = popplerWords(result.buffer);
      expect(numberedWordsByPage(words, 'line').map((word) => word.text)).toEqual(numbered(150, 'line'));
      expect(pdfFacts(result.buffer).pages).toBeGreaterThanOrEqual(3);
      expect(wordAt(words, 'tail').page).toBe(1);
    },
    60_000
  );

  oracleTest(
    'scales a picture taller than a page to the page and puts what follows on the next one',
    TOOLS,
    async () => {
      const png = await sharp({ create: { width: 200, height: 3000, channels: 3, background: { r: 200, g: 30, b: 30 } } }).png().toBuffer();
      const result = await inProcess(`<table><tr><td>caption</td><td><img src="data:image/png;base64,${png.toString('base64')}"></td></tr></table><p>after</p>`);
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tall-picture-'));
      try {
        const file = path.join(dir, 'in.pdf');
        fs.writeFileSync(file, result.buffer);
        const listing = execFileSync(requireOracleTool('pdfimages'), ['-list', file], { encoding: 'utf-8' }).split('\n')[2].trim().split(/\s+/);
        const [page, height, yPpi] = [listing[0], listing[4], listing[13]];
        const placedHeight = (Number(height) * 72) / Number(yPpi);
        const words = popplerWords(result.buffer);
        expect({ page: Number(page), pages: pdfFacts(result.buffer).pages, captionPage: wordAt(words, 'caption').page, afterPage: wordAt(words, 'after').page }).toEqual({
          page: 1,
          pages: 2,
          captionPage: 1,
          afterPage: 2,
        });
        // Scaled down to the page: no taller than the page between its margins, and not a thumbnail.
        expect(placedHeight).toBeLessThanOrEqual(A4_HEIGHT_PT - 2 * PAGE_MARGIN + 3);
        expect(placedHeight).toBeGreaterThan(A4_HEIGHT_PT - 2 * PAGE_MARGIN - 40);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  );
});

describe('real pages of the public government corpus on the in-process route', () => {
  let imageFetch: string | undefined;

  beforeEach(() => {
    imageFetch = process.env.HTML_IMAGE_FETCH;
    process.env.HTML_IMAGE_FETCH = 'off';
  });

  afterEach(() => {
    if (imageFetch === undefined) delete process.env.HTML_IMAGE_FETCH;
    else process.env.HTML_IMAGE_FETCH = imageFetch;
  });

  /** Count of each letter and digit of `text`, the word breaks left out, so a word cut across lines still counts. */
  const characterCounts = (text: string): Map<string, number> => {
    const counts = new Map<string, number>();
    for (const character of text.replace(/[^A-Za-z0-9]/g, '')) counts.set(character, (counts.get(character) ?? 0) + 1);
    return counts;
  };

  const SAMPLES: ReadonlyArray<readonly [string, string]> = [
    ['govdocs1-000057.html', 'a row taller than a page: a contents list beside a long article'],
    ['govdocs1-000440.html', 'a row taller than a page'],
    ['govdocs1-000726.html', 'rows taller than a page in a document of dozens of pages'],
    ['govdocs1-001429.html', 'a cell of a million characters'],
    ['govdocs1-000071.html', 'tables nested ten deep'],
    ['govdocs1-000635.html', 'tables nested in a page wider than the paper'],
    ['govdocs1-001120.html', '145 tables nested in one another'],
    ['govdocs1-000409.html', 'a side column and an article in one row of many pages'],
  ];

  for (const [id, description] of SAMPLES) {
    oracleTest(
      `${id} (${description}) converts with every letter and digit of its text`,
      TOOLS,
      async (ctx) => {
        const { bytes } = await requireRealworldSample(ctx, id);
        const result = await convertFile(bytes, 'html', 'pdf', { orientation: 'landscape' }, id);
        const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'nested-corpus-')), 'in.pdf');
        try {
          fs.writeFileSync(file, result.buffer);
          const shown = characterCounts(execFileSync(requireOracleTool('pdftotext'), ['-raw', file, '-'], { encoding: 'utf-8', maxBuffer: 1 << 28 }));
          const expected = characterCounts(pageWords(bytes.toString('latin1')).join(''));
          const lost = [...expected].filter(([character, count]) => (shown.get(character) ?? 0) < count).map(([character]) => character);
          expect({ lost, pages: pdfFacts(result.buffer).pages > 0 }).toEqual({ lost: [], pages: true });
        } finally {
          fs.rmSync(path.dirname(file), { recursive: true, force: true });
        }
      },
      120_000
    );
  }
});
