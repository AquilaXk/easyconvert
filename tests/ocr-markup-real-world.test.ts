import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { convertDocument } from '../src/lib/conversions/document';
import { exportAlto, exportHocr } from '../src/lib/conversions/ocr-export';
import { parseAlto, parseHocr } from '../src/lib/conversions/ocr-import';
import { OcrMarkupError } from '../src/lib/conversions/ocr-markup';
import { oracleTest } from './helpers/oracle-test';
import { getOracleToolPath, OracleToolMissingError } from './helpers/differential-oracle';
import { xmlWellFormed, xpathAttributes, xpathCount, xpathString } from './helpers/xml-oracle';

/**
 * Real OCR output (a Chronicling America ALTO page whose first lines start 20 px above the page, a
 * multi-page hOCR whose pages carry no bbox) must convert. The fixtures are small derivatives of those
 * shapes; the outputs are read back with xmllint, never with the reader under test.
 */
const ALTO_WORDS = ['Above', 'the', 'page', 'Past', 'the', 'edge', 'Inside'];
const ALTO_PAGE_WIDTH = 200;
const ALTO_PAGE_HEIGHT = 100;

const ALTO_ABOVE_THE_PAGE = `<?xml version="1.0" encoding="UTF-8"?>
<alto xmlns="http://schema.ccs-gmbh.com/ALTO"><Layout><Page ID="P1" WIDTH="${ALTO_PAGE_WIDTH}" HEIGHT="${ALTO_PAGE_HEIGHT}" PHYSICAL_IMG_NR="1">
<PrintSpace HPOS="0" VPOS="0" WIDTH="${ALTO_PAGE_WIDTH}" HEIGHT="${ALTO_PAGE_HEIGHT}"><TextBlock ID="B1" HPOS="0" VPOS="-20" WIDTH="200" HEIGHT="60">
<TextLine ID="L1" HPOS="10" VPOS="-20" WIDTH="90" HEIGHT="30">
<String ID="W1" CONTENT="Above" HPOS="10" VPOS="-20" WIDTH="30" HEIGHT="30"/><SP WIDTH="5"/>
<String ID="W2" CONTENT="the" HPOS="45" VPOS="-20" WIDTH="20" HEIGHT="30"/><SP WIDTH="5"/>
<String ID="W3" CONTENT="page" HPOS="70" VPOS="-20" WIDTH="30" HEIGHT="30"/></TextLine>
<TextLine ID="L2" HPOS="150" VPOS="40" WIDTH="80" HEIGHT="20">
<String ID="W4" CONTENT="Past" HPOS="150" VPOS="40" WIDTH="30" HEIGHT="20"/><SP WIDTH="5"/>
<String ID="W5" CONTENT="the" HPOS="185" VPOS="40" WIDTH="20" HEIGHT="20"/><SP WIDTH="5"/>
<String ID="W6" CONTENT="edge" HPOS="210" VPOS="40" WIDTH="20" HEIGHT="20"/></TextLine>
<TextLine ID="L3" HPOS="10" VPOS="70" WIDTH="60" HEIGHT="20">
<String ID="W7" CONTENT="Inside" HPOS="10" VPOS="70" WIDTH="60" HEIGHT="20"/></TextLine>
</TextBlock></PrintSpace></Page></Layout></alto>`;

function boxesOf(xml: string, element: string): number[][] {
  const read = (name: string): number[] =>
    xpathAttributes(xml, `//*[local-name()='${element}']/@${name}`).map(Number);
  const [hpos, vpos, width, height] = ['HPOS', 'VPOS', 'WIDTH', 'HEIGHT'].map(read);
  return hpos.map((x, i) => [x, vpos[i], width[i], height[i]]);
}

describe('ALTO coordinates outside the page', () => {
  it('reads the words of the source independently as the sequence the test expects', () => {
    expect(xpathAttributes(ALTO_ABOVE_THE_PAGE, "//*[local-name()='String']/@CONTENT")).toEqual(ALTO_WORDS);
  });

  it('clamps a negative VPOS and a box past the edge to the page and keeps every word, in ALTO output', () => {
    const out = exportAlto(parseAlto(ALTO_ABOVE_THE_PAGE));
    expect(xmlWellFormed(out).ok).toBe(true);
    expect(xpathAttributes(out, "//*[local-name()='String']/@CONTENT")).toEqual(ALTO_WORDS);
    const words = boxesOf(out, 'String');
    expect(words).toHaveLength(ALTO_WORDS.length);
    for (const [x, y, width, height] of words) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(x + width).toBeLessThanOrEqual(ALTO_PAGE_WIDTH);
      expect(y + height).toBeLessThanOrEqual(ALTO_PAGE_HEIGHT);
    }
    expect(words[0]).toEqual([10, 0, 30, 10]);
    expect(words[5]).toEqual([199, 40, 1, 20]);
  });

  it('writes the same words in hOCR with every word box on the page', () => {
    const out = exportHocr(parseAlto(ALTO_ABOVE_THE_PAGE));
    expect(xmlWellFormed(out).ok).toBe(true);
    const count = xpathCount(out, "//*[@class='ocrx_word']");
    expect(count).toBe(ALTO_WORDS.length);
    const texts = Array.from({ length: count }, (_, i) => xpathString(out, `string((//*[@class='ocrx_word'])[${i + 1}])`));
    expect(texts).toEqual(ALTO_WORDS);
    for (const title of xpathAttributes(out, "//*[@class='ocrx_word']/@title")) {
      const [x0, y0, x1, y1] = /bbox (\d+) (\d+) (\d+) (\d+)/.exec(title)!.slice(1).map(Number);
      expect(x0).toBeGreaterThanOrEqual(0);
      expect(y0).toBeGreaterThanOrEqual(0);
      expect(x1).toBeLessThanOrEqual(ALTO_PAGE_WIDTH);
      expect(y1).toBeLessThanOrEqual(ALTO_PAGE_HEIGHT);
    }
  });

  it('still refuses a position beyond the coordinate limit', () => {
    const absurd = ALTO_ABOVE_THE_PAGE.replace('VPOS="-20" WIDTH="30" HEIGHT="30"/><SP WIDTH="5"/>\n<String ID="W2"', 'VPOS="-1000001" WIDTH="30" HEIGHT="30"/><SP WIDTH="5"/>\n<String ID="W2"');
    expect(absurd).not.toBe(ALTO_ABOVE_THE_PAGE);
    expect(() => parseAlto(absurd)).toThrow(/ALTO VPOS -1000001 is outside -1000000\.\.1000000/);
  });
});

const hocrPage = (title: string, body: string): string => `<div class="ocr_page"${title}>${body}</div>`;
const hocrLine = (bbox: string, words: string): string => `<span class="ocr_line" title="${bbox}">${words}</span>`;
const hocrWord = (bbox: string, text: string): string => `<span class="ocrx_word" title="${bbox}">${text}</span>`;
const HOCR_WORDS = ['alpha', 'beta', 'gamma'];
const HOCR_WITHOUT_PAGE_BBOX = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>t</title></head><body>${hocrPage(
  '',
  hocrLine('bbox 10 20 110 40', hocrWord('bbox 10 20 50 40', 'alpha') + hocrWord('bbox 60 20 110 40', 'beta')) +
    hocrLine('bbox 10 60 300 90', hocrWord('bbox 10 60 300 90', 'gamma'))
)}</body></html>`;

describe('hOCR pages without a bbox', () => {
  it('sizes the page from the union of the boxes inside it', () => {
    const parsed = parseHocr(HOCR_WITHOUT_PAGE_BBOX);
    expect([parsed.imageWidth, parsed.imageHeight]).toEqual([300, 90]);
  });

  it('converts to ALTO with the independent word sequence and the measured page size', () => {
    const out = exportAlto(parseHocr(HOCR_WITHOUT_PAGE_BBOX));
    expect(xmlWellFormed(out).ok).toBe(true);
    expect(xpathAttributes(out, "//*[local-name()='String']/@CONTENT")).toEqual(HOCR_WORDS);
    expect(xpathAttributes(out, "//*[local-name()='Page']/@WIDTH")).toEqual(['300']);
    expect(xpathAttributes(out, "//*[local-name()='Page']/@HEIGHT")).toEqual(['90']);
  });

  it('measures each of several pages on its own', () => {
    const two = `<html><body>${hocrPage('', hocrLine('bbox 0 0 100 10', hocrWord('bbox 0 0 100 10', 'one')))}${hocrPage('', hocrLine('bbox 0 0 40 30', hocrWord('bbox 0 0 40 30', 'two')))}</body></html>`;
    const parsed = parseHocr(two);
    expect(parsed.pages?.map((p) => [p.width, p.height, p.text])).toEqual([
      [100, 10, 'one'],
      [40, 30, 'two'],
    ]);
  });

  it('keeps the bbox of a page that has one', () => {
    const parsed = parseHocr(hocrPage(' title="bbox 0 0 500 400"', hocrLine('bbox 0 0 50 10', hocrWord('bbox 0 0 50 10', 'x'))));
    expect([parsed.imageWidth, parsed.imageHeight]).toEqual([500, 400]);
  });
});

/** bench/realworld sample hocrt-test.hocr (sha256 971fef58...): two pages with text and no bbox, line or word. */
const HOCRT_TEST = `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="en" lang="en">
  <head>
    <title>Test multi-page hOCR file</title>
  </head>
  <body>
    <div class="ocr_page">Page 1</div>
    <div class="ocr_page">Page 2</div>
  </body>
</html>
`;
const GEOMETRY_REFUSAL =
  'hOCR/ALTO need word geometry: page 1 has text but no recognized lines. Convert to txt, html or pdf to keep the text.';

async function convertHocrt(target: string): Promise<{ buffer: Buffer }> {
  return convertDocument(Buffer.from(HOCRT_TEST, 'utf-8'), 'hocr', target, {}, 'hocrt-test.hocr');
}

describe('hOCR pages with no geometry at all', () => {
  it('reads the independent page texts the target outputs must equal', () => {
    expect(xpathAttributes(HOCRT_TEST, "//*[@class='ocr_page']/@class")).toEqual(['ocr_page', 'ocr_page']);
    expect([1, 2].map((n) => xpathString(HOCRT_TEST, `string((//*[@class='ocr_page'])[${n}])`))).toEqual(['Page 1', 'Page 2']);
  });

  it('keeps the text of each page in reading order and no size', () => {
    const parsed = parseHocr(HOCRT_TEST);
    expect(parsed.pages?.map((p) => [p.width, p.height, p.text, p.lineBlocks.length])).toEqual([
      [0, 0, 'Page 1', 0],
      [0, 0, 'Page 2', 0],
    ]);
  });

  it('converts to txt with the page texts in order', async () => {
    expect((await convertHocrt('txt')).buffer.toString('utf-8')).toBe('Page 1\n\nPage 2');
  });

  it('converts to html that an XML parser reads back as the same page texts', async () => {
    const html = (await convertHocrt('html')).buffer.toString('utf-8');
    expect(xmlWellFormed(html).ok).toBe(true);
    expect([1, 2].map((n) => xpathString(html, `string((//*[@class='ocr_page'])[${n}])`))).toEqual(['Page 1', 'Page 2']);
  });

  oracleTest(
    'converts to a PDF that Poppler reads back as the page texts in order',
    ['pdftotext'],
    async () => {
      const work = fs.mkdtempSync(path.join(os.tmpdir(), 'hocrt-pdf-'));
      try {
        const file = path.join(work, 'out.pdf');
        fs.writeFileSync(file, (await convertHocrt('pdf')).buffer);
        const tool = getOracleToolPath('pdftotext');
        if (!tool) throw new OracleToolMissingError('pdftotext', 'pdftotext is not installed');
        const text = execFileSync(tool, ['-enc', 'UTF-8', file, '-'], { encoding: 'utf8' });
        expect(text.split(/\s+/).filter(Boolean)).toEqual(['Page', '1', 'Page', '2']);
      } finally {
        fs.rmSync(work, { recursive: true, force: true });
      }
    },
    60_000
  );

  it('refuses ALTO with a typed 400 that names the reason and the formats that work', async () => {
    let thrown: unknown;
    try {
      await convertHocrt('alto');
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(OcrMarkupError);
    expect((thrown as OcrMarkupError).status).toBe(400);
    expect((thrown as OcrMarkupError).message).toBe(GEOMETRY_REFUSAL);
  });
});
