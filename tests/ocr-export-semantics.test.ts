import { afterEach, describe, expect, it, vi } from 'vitest';
import { convertFile } from '../src/lib/conversions/index';
import { exportAlto, exportHocr, parseAlto, parseHocr } from '../src/lib/conversions/ocr-export';
import { OcrMarkupError } from '../src/lib/conversions/ocr-markup';
import type { OcrLineBlock, OcrPageResult, OcrResult } from '../src/lib/conversions/ocr-pdf-combiner';
import { oracleTest } from './helpers/oracle-test';
import { validateAlto44, xpathAttributes, xpathCount } from './helpers/xml-oracle';

/**
 * Page numbering, the word confidence scale and fail-closed export. Inputs are hand-written and every
 * expectation is worked out from them.
 */

function line(text: string, confidence: number | undefined, top = 10): OcrLineBlock {
  return {
    text,
    bbox: { x: 10, y: top, width: 80, height: 20 },
    words: [{ text, bbox: { x: 10, y: top, width: 80, height: 20 }, confidence }],
  };
}

function page(pageNumber: number, lines: OcrLineBlock[]): OcrPageResult {
  return { pageNumber, width: 100, height: 100, text: lines.map((l) => l.text).join('\n'), confidence: null, lineBlocks: lines };
}

function result(pages: OcrPageResult[]): OcrResult {
  return {
    text: pages.map((p) => p.text).join('\n\n'),
    confidence: null,
    wordCount: pages.length,
    lines: [],
    imageWidth: 100,
    imageHeight: 100,
    pages,
  };
}

const ALTO_TWO_PAGES = (first: string, second: string): string => `<alto xmlns="http://www.loc.gov/standards/alto/ns-v4#">
<Layout>
<Page ID="P1" PHYSICAL_IMG_NR="${first}" WIDTH="100" HEIGHT="100"><PrintSpace><TextBlock><TextLine HPOS="10" VPOS="10" WIDTH="80" HEIGHT="20"><String CONTENT="one" HPOS="10" VPOS="10" WIDTH="80" HEIGHT="20"/></TextLine></TextBlock></PrintSpace></Page>
<Page ID="P2" PHYSICAL_IMG_NR="${second}" WIDTH="100" HEIGHT="100"><PrintSpace><TextBlock><TextLine HPOS="10" VPOS="10" WIDTH="80" HEIGHT="20"><String CONTENT="two" HPOS="10" VPOS="10" WIDTH="80" HEIGHT="20"/></TextLine></TextBlock></PrintSpace></Page>
</Layout>
</alto>`;

describe('page numbers follow document position', () => {
  const duplicated = result([page(7, [line('one', 90)]), page(7, [line('two', 90)])]);

  it('writes hOCR page ids 1-based and ppageno 0-based by position, whatever the source page numbers are', () => {
    const hocr = exportHocr(duplicated, { filename: 'scan.png' });
    expect(hocr.match(/<div class="ocr_page" id="[^"]+" title="[^"]+">/g)).toEqual([
      '<div class="ocr_page" id="page_1" title="image &quot;scan_page_1.png&quot;; bbox 0 0 100 100; ppageno 0">',
      '<div class="ocr_page" id="page_2" title="image &quot;scan_page_2.png&quot;; bbox 0 0 100 100; ppageno 1">',
    ]);
  });

  it('writes unique ALTO page identifiers and 1-based PHYSICAL_IMG_NR by position', () => {
    const alto = exportAlto(result([page(-4, [line('one', 90)]), page(0.5, [line('two', 90)])]));
    expect(alto.match(/<Page ID="[^"]+" PHYSICAL_IMG_NR="\d+"/g)).toEqual([
      '<Page ID="PAGE_1" PHYSICAL_IMG_NR="1"',
      '<Page ID="PAGE_2" PHYSICAL_IMG_NR="2"',
    ]);
  });

  it('numbers a mixed list of single-page results by position as well', () => {
    const hocr = exportHocr([result([page(9, [line('a', 90)])]), result([page(9, [line('b', 90)])])]);
    expect(hocr.match(/ppageno \d+/g)).toEqual(['ppageno 0', 'ppageno 1']);
  });

  oracleTest(
    'ALTO with duplicate page numbers converts to ALTO-valid output and to hOCR with distinct pages',
    ['xmllint'],
    async () => {
      const source = ALTO_TWO_PAGES('1', '1');
      const hocr = (await convertFile(Buffer.from(source), 'alto', 'hocr', {}, 'in.xml')).buffer.toString('utf-8');
      expect(xpathAttributes(hocr, "//*[@class='ocr_page']/@id")).toEqual(['page_1', 'page_2']);
      expect(xpathAttributes(hocr, "//*[@class='ocr_page']/@title").map((t) => /ppageno (\d+)/.exec(t)?.[1])).toEqual(['0', '1']);
      const hocrSource = hocr;
      const alto = (await convertFile(Buffer.from(hocrSource), 'hocr', 'alto', {}, 'in.hocr')).buffer.toString('utf-8');
      expect(validateAlto44(alto).stderr.trim()).toBe('- validates');
      expect(xpathAttributes(alto, "//*[local-name()='Page']/@ID")).toEqual(['PAGE_1', 'PAGE_2']);
    }
  );

  it('rejects ALTO whose PHYSICAL_IMG_NR is not a positive integer, through the conversion API', async () => {
    const invalid = ['-4', '0', '0.5', '1e2', '0x1', 'one', ''];
    await Promise.all(
      invalid.map((bad) =>
        expect(convertFile(Buffer.from(ALTO_TWO_PAGES('1', bad)), 'alto', 'hocr', {}, 'in.xml'), bad).rejects.toThrow(/PHYSICAL_IMG_NR/)
      )
    );
    await expect(convertFile(Buffer.from(ALTO_TWO_PAGES('-4', '1')), 'alto', 'hocr', {}, 'in.xml')).rejects.toBeInstanceOf(OcrMarkupError);
  });

  it('converts hOCR whose ppageno values repeat to ALTO with distinct page identifiers', async () => {
    const hocr = `<html><body>
<div class="ocr_page" title="bbox 0 0 100 100; ppageno 0"><span class="ocr_line" title="bbox 10 10 90 30"><span class="ocrx_word" title="bbox 10 10 90 30">a</span></span></div>
<div class="ocr_page" title="bbox 0 0 100 100; ppageno 0"><span class="ocr_line" title="bbox 10 10 90 30"><span class="ocrx_word" title="bbox 10 10 90 30">b</span></span></div>
</body></html>`;
    const alto = (await convertFile(Buffer.from(hocr), 'hocr', 'alto', {}, 'in.hocr')).buffer.toString('utf-8');
    expect(alto.match(/<Page ID="[^"]+" PHYSICAL_IMG_NR="\d+"/g)).toEqual([
      '<Page ID="PAGE_1" PHYSICAL_IMG_NR="1"',
      '<Page ID="PAGE_2" PHYSICAL_IMG_NR="2"',
    ]);
  });
});

describe('word confidence stays on one 0..100 scale', () => {
  const hocrWith = (wconf: string): string =>
    `<html><body><div class="ocr_page" title="bbox 0 0 100 100"><span class="ocr_line" title="bbox 10 10 90 30"><span class="ocrx_word" title="bbox 10 10 90 30; x_wconf ${wconf}">w</span></span></div></body></html>`;
  const altoWith = (wc: string): string => ALTO_TWO_PAGES('1', '2').replace(/<String CONTENT="one"/, `<String WC="${wc}" CONTENT="one"`);

  it('keeps x_wconf 0, 1, 57 and 100 through hOCR to hOCR', () => {
    for (const value of [0, 1, 57, 100]) {
      const parsed = parseHocr(hocrWith(String(value)));
      expect(parsed.lineBlocks?.[0].words[0].confidence).toBe(value);
      expect(exportHocr(parsed)).toContain(`; x_wconf ${value}">w</span>`);
    }
  });

  it('writes ALTO WC as the 0..100 confidence divided by 100, so x_wconf 1 is 0.01 and 100 is 1.00', () => {
    const expected: Array<[string, string]> = [
      ['0', '0.00'],
      ['1', '0.01'],
      ['57', '0.57'],
      ['100', '1.00'],
    ];
    for (const [wconf, wc] of expected) {
      expect(exportAlto(parseHocr(hocrWith(wconf)))).toContain(`WC="${wc}" />`);
    }
  });

  it('reads ALTO WC back onto the same scale and writes the same x_wconf', () => {
    const expected: Array<[string, number]> = [
      ['0', 0],
      ['0.01', 1],
      ['0.57', 57],
      ['1', 100],
    ];
    for (const [wc, percent] of expected) {
      const parsed = parseAlto(altoWith(wc));
      expect(parsed.lineBlocks?.[0].words[0].confidence).toBe(percent);
      expect(exportHocr(parsed)).toContain(`; x_wconf ${percent}">one</span>`);
    }
  });

  it('leaves confidence out when it is unknown instead of inventing one', () => {
    const unknown = result([page(1, [line('mystery', undefined)])]);
    unknown.confidence = 0.5;
    unknown.pages![0].confidence = 0.5;
    const hocr = exportHocr(unknown);
    expect(hocr).toContain('title="bbox 10 10 90 30">mystery</span>');
    expect(hocr.match(/x_wconf/g)).toBeNull();
    const alto = exportAlto(unknown);
    expect(alto).toContain('<String CONTENT="mystery" HPOS="10" VPOS="10" WIDTH="80" HEIGHT="20" />');
    expect(alto.match(/ WC=/g)).toBeNull();
  });

  oracleTest('ALTO without WC still validates', ['xmllint'], () => {
    const alto = exportAlto(result([page(1, [line('mystery', undefined)])]));
    expect(validateAlto44(alto).stderr.trim()).toBe('- validates');
    expect(xpathCount(alto, "//*[local-name()='String'][@WC]")).toBe(0);
  });

  it('clamps a confidence outside 0..100 into the range', () => {
    const hocr = exportHocr(result([page(1, [line('high', 140), line('low', -3, 40)])]));
    expect(hocr.match(/x_wconf \d+/g)).toEqual(['x_wconf 100', 'x_wconf 0']);
  });
});

describe('export fails closed without word geometry', () => {
  const NEED_GEOMETRY = /need word geometry/;

  it('rejects a result that has text but no line blocks, in both formats', () => {
    const textOnly: OcrResult = { text: 'first\nsecond', confidence: 0.9, wordCount: 2, lines: ['first', 'second'] };
    for (const run of [() => exportHocr(textOnly), () => exportAlto(textOnly), () => exportHocr([textOnly]), () => exportAlto([textOnly])]) {
      expect(run).toThrow(OcrMarkupError);
      expect(run).toThrow(NEED_GEOMETRY);
    }
  });

  it('rejects a page of a multi-page result that has text but no lines, naming the page', () => {
    const mixed = result([page(1, [line('ok', 90)]), { ...page(2, []), text: 'digital text only' }]);
    expect(() => exportHocr(mixed)).toThrow(/page 2/);
    expect(() => exportAlto(mixed)).toThrow(/page 2/);
  });

  it('rejects a line that has text but no words', () => {
    const wordless = result([page(1, [{ text: 'no words', bbox: { x: 1, y: 1, width: 50, height: 10 }, words: [] }])]);
    expect(() => exportHocr(wordless)).toThrow(NEED_GEOMETRY);
    expect(() => exportAlto(wordless)).toThrow(NEED_GEOMETRY);
  });

  it('writes a blank page (no text, no lines) as an empty page', () => {
    const blank = result([{ ...page(1, []), text: '' }]);
    expect(exportHocr(blank).match(/class="ocr_(page|carea|line)"/g)).toEqual(['class="ocr_page"']);
    expect(exportAlto(blank).match(/<(Page|PrintSpace|TextBlock|TextLine)\b/g)).toEqual(['<Page', '<PrintSpace']);
  });
});

describe('characters XML 1.0 cannot carry', () => {
  afterEach(() => vi.restoreAllMocks());

  it('are dropped from engine output and the number dropped is logged once per export', () => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const dirty = result([page(1, [line('a\u0001b\u0008c', 90), line('d￾e\uD800f', 90, 40)])]);
    const hocr = exportHocr(dirty);
    expect(hocr).toContain('>abc</span>');
    expect(hocr).toContain('>def</span>');
    expect(debug).toHaveBeenCalledTimes(1);
    expect(debug.mock.calls[0][0]).toBe('[ocr-export] dropped 4 characters that XML 1.0 cannot carry');
    exportAlto(dirty);
    expect(debug).toHaveBeenCalledTimes(2);
    expect(debug.mock.calls[1][0]).toBe('[ocr-export] dropped 4 characters that XML 1.0 cannot carry');
  });

  it('are not logged when nothing was dropped', () => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    exportHocr(result([page(1, [line('clean', 90)])]));
    expect(debug).not.toHaveBeenCalled();
  });
});
