import { describe, expect, it } from 'vitest';
import { exportAlto, exportHocr, parseAlto, parseHocr } from '../src/lib/conversions/ocr-export';
import { parseTesseractTsv } from '../src/lib/conversions/ocr-cli';
import { parseTesseractBlocks, type OcrLayoutGroup, type OcrLineBlock, type OcrResult } from '../src/lib/conversions/ocr-pdf-combiner';
import { OcrMarkupError } from '../src/lib/conversions/ocr-markup';
import { oracleTest } from './helpers/oracle-test';
import { validateAlto44, xmlWellFormed, xpathAttributes, xpathCount, xpathString } from './helpers/xml-oracle';

/**
 * Hand-written documents and expected values for the hOCR / ALTO reading and writing code. Every
 * expected number below is computed by hand from the document, not read back from the code under test.
 */

const HOCR = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="en" lang="en">
 <head><title></title><meta name='ocr-system' content='reference' /></head>
 <body>
  <div class='ocr_page' id='page_1' title='image "scan;1.png"; bbox 0 0 1000 800; ppageno 0'>
   <div class='ocr_carea' id='block_1_1' title="bbox 100 100 500 300">
    <p class='ocr_par' id='par_1_1' lang='eng' title="bbox 100 100 500 200">
     <span class='ocr_line' id='line_1_1' title="bbox 100 100 500 150; baseline 0.01 -5; x_size 42.5; x_descenders 10; x_ascenders 11">
      <span class='ocrx_word' id='word_1_1' title='bbox 100 100 200 145; x_wconf 96'>Tom</span>
      <span class='ocrx_word' id='word_1_2' title='bbox 210 100 300 145; x_wconf 80'>&amp; <strong>Jerry</strong></span>
     </span>
     <span class='ocr_header' id='line_1_2' title="bbox 100 160 400 200; baseline 0 -8">
      <span class='ocrx_word' id='word_1_3' title='bbox 100 160 400 195; x_wconf 70'>Title</span>
     </span>
    </p>
    <p class='ocr_par' id='par_1_2' lang='eng' title="bbox 100 220 500 300">
     <span class='ocr_line' id='line_1_3' title="bbox 100 220 500 260">
      <span class='ocrx_word' id='word_1_4' title='bbox 100 220 500 255'>second</span>
     </span>
    </p>
   </div>
   <div class='ocr_carea' id='block_1_2' title="bbox 600 100 900 150">
    <p class='ocr_par' id='par_1_3' title="bbox 600 100 900 150">
     <span class='ocr_line' id='line_1_4' title="bbox 600 100 900 150; baseline 0 0">
      <span class='ocrx_word' id='word_1_5' title='bbox 600 100 900 150; x_wconf 99'>right</span>
     </span>
    </p>
   </div>
  </div>
 </body>
</html>`;

const ALTO = `<?xml version="1.0" encoding="UTF-8"?>
<alto xmlns="http://www.loc.gov/standards/alto/ns-v4#">
  <Description><MeasurementUnit>pixel</MeasurementUnit></Description>
  <Layout>
    <Page ID="P1" PHYSICAL_IMG_NR="3" WIDTH="1000" HEIGHT="800">
      <PrintSpace HPOS="0" VPOS="0" WIDTH="1000" HEIGHT="800">
        <ComposedBlock ID="CB1" HPOS="100" VPOS="100" WIDTH="400" HEIGHT="200">
          <TextBlock ID="TB1" HPOS="100" VPOS="100" WIDTH="400" HEIGHT="100" LANG="en">
            <TextLine ID="TL1" HPOS="100" VPOS="100" WIDTH="400" HEIGHT="50" BASELINE="100,145 500,149">
              <String CONTENT="Tom" HPOS="100" VPOS="100" WIDTH="100" HEIGHT="45" WC="0.96"/>
              <SP HPOS="200" VPOS="100" WIDTH="10"/>
              <String CONTENT="&amp;Jerry" HPOS="210" VPOS="100" WIDTH="90" HEIGHT="45" WC="0.8"/>
            </TextLine>
          </TextBlock>
          <TextBlock ID="TB2" HPOS="100" VPOS="220" WIDTH="400" HEIGHT="40">
            <TextLine ID="TL2" HPOS="100" VPOS="220" WIDTH="400" HEIGHT="40" BASELINE="255">
              <String CONTENT="second" HPOS="100" VPOS="220" WIDTH="400" HEIGHT="35"/>
            </TextLine>
          </TextBlock>
        </ComposedBlock>
        <TextBlock ID="TB3" HPOS="600" VPOS="100" WIDTH="300" HEIGHT="50">
          <TextLine ID="TL3" HPOS="600" VPOS="100" WIDTH="300" HEIGHT="50">
            <String CONTENT="right" HPOS="600" VPOS="100" WIDTH="300" HEIGHT="50" WC="0.99"/>
          </TextLine>
        </TextBlock>
      </PrintSpace>
    </Page>
  </Layout>
</alto>`;

function groupsOf(lines: OcrLineBlock[], pick: 'block' | 'paragraph'): Set<OcrLayoutGroup | undefined> {
  return new Set(lines.map((line) => line[pick]));
}

describe('parseHocr', () => {
  const parsed = parseHocr(HOCR);
  const lines = parsed.lineBlocks ?? [];

  it('reads page geometry, language and text', () => {
    expect(parsed.pages).toHaveLength(1);
    expect([parsed.pages![0].width, parsed.pages![0].height, parsed.pages![0].pageNumber]).toEqual([1000, 800, 1]);
    expect(parsed.language).toBe('en');
    expect(parsed.text).toBe('Tom & Jerry\nTitle\nsecond\nright');
    expect(parsed.wordCount).toBe(5);
  });

  it('keeps blocks and paragraphs as groups shared by their lines', () => {
    expect(lines.map((line) => line.text)).toEqual(['Tom & Jerry', 'Title', 'second', 'right']);
    expect(groupsOf(lines, 'block').size).toBe(2);
    expect(groupsOf(lines, 'paragraph').size).toBe(3);
    expect(lines[0].block).toBe(lines[1].block);
    expect(lines[0].block).toBe(lines[2].block);
    expect(lines[0].block).not.toBe(lines[3].block);
    expect(lines[0].paragraph).toBe(lines[1].paragraph);
    expect(lines[0].paragraph).not.toBe(lines[2].paragraph);
    expect(lines[0].block?.bbox).toEqual({ x: 100, y: 100, width: 400, height: 200 });
    expect(lines[0].paragraph).toMatchObject({ language: 'eng', bbox: { x: 100, y: 100, width: 400, height: 100 } });
    expect(lines[3].paragraph?.language).toBeUndefined();
  });

  it('turns baseline slope and offset into absolute points and keeps the row metrics', () => {
    // Line box bottom is y=150: the baseline starts at 150-5=145 and, with slope 0.01 over 400 px, ends at 149.
    expect(lines[0].baseline).toEqual({ x0: 100, y0: 145, x1: 500, y1: 149 });
    expect([lines[0].rowHeight, lines[0].descenders, lines[0].ascenders]).toEqual([42.5, 10, 11]);
    expect(lines[1].baseline).toEqual({ x0: 100, y0: 192, x1: 400, y1: 192 });
    expect(lines[2].baseline).toBeUndefined();
    expect(lines[2].rowHeight).toBeUndefined();
  });

  it('reads words with nested markup, entities and confidence; a word without x_wconf has none', () => {
    expect(lines[0].words.map((w) => [w.text, w.confidence, w.bbox.x, w.bbox.width])).toEqual([
      ['Tom', 96, 100, 100],
      ['& Jerry', 80, 210, 90],
    ]);
    expect(lines[2].words[0].confidence).toBeUndefined();
  });

  it('rejects documents without the geometry the structure needs, or that are not XML', () => {
    expect(() => parseHocr('')).toThrow(OcrMarkupError);
    expect(() => parseHocr('<html><body><p>no page</p></body></html>')).toThrow(/no ocr_page/);
    expect(() => parseHocr("<div class='ocr_page'/>")).toThrow(/ocr_page has no bbox/);
    expect(() =>
      parseHocr(
        "<div class='ocr_page' title='bbox 0 0 10 10'><span class='ocr_line' title='bbox 0 0 5 5'><span class='ocrx_word'>x</span></span></div>"
      )
    ).toThrow(/word 'x' has no bbox/);
    expect(() => parseHocr("<div class='ocr_page' title='bbox 0 0 10 10; ppageno 0'><span class='ocr_line'>text</span></div>")).toThrow(
      /line with text has no bbox/
    );
    expect(() => parseHocr("<div class='ocr_page' title='bbox 0 0 10'/>")).toThrow(/bbox needs four numbers/);
    expect(() => parseHocr("<div class='ocr_page' title='bbox 10 0 0 10'/>")).toThrow(/negative size/);
    expect(() => parseHocr('<html><body class="ocr_page" title="bbox 0 0 1 1"><p></body></html>')).toThrow(/does not match/);
    expect(() => parseHocr('<html>&bogus;</html>')).toThrow(/unknown or malformed character reference/);
  });
});

describe('parseAlto', () => {
  const parsed = parseAlto(ALTO);
  const lines = parsed.lineBlocks ?? [];

  it('reads pages, text and word confidence on a 0..100 scale', () => {
    expect(parsed.pages).toHaveLength(1);
    expect([parsed.pages![0].pageNumber, parsed.pages![0].width, parsed.pages![0].height]).toEqual([3, 1000, 800]);
    expect(parsed.text).toBe('Tom &Jerry\nsecond\nright');
    expect(lines[0].words.map((w) => [w.text, w.confidence])).toEqual([
      ['Tom', 96],
      ['&Jerry', 80],
    ]);
    expect(lines[1].words[0].confidence).toBeUndefined();
    expect(lines[2].words[0].confidence).toBe(99);
  });

  it('maps ComposedBlock to a block and TextBlock to a paragraph', () => {
    expect(lines[0].block).toBe(lines[1].block);
    expect(lines[0].block).toBeDefined();
    expect(lines[0].paragraph).not.toBe(lines[1].paragraph);
    expect(lines[0].paragraph?.language).toBe('en');
    expect(lines[2].block).toBeUndefined();
    expect(lines[2].paragraph?.bbox).toEqual({ x: 600, y: 100, width: 300, height: 50 });
  });

  it('reads a BASELINE polyline and the single-value form of older schema versions', () => {
    expect(lines[0].baseline).toEqual({ x0: 100, y0: 145, x1: 500, y1: 149 });
    // BASELINE="255" on a line spanning x 100..500 is a horizontal baseline at y=255.
    expect(lines[1].baseline).toEqual({ x0: 100, y0: 255, x1: 500, y1: 255 });
    expect(lines[2].baseline).toBeUndefined();
  });

  it('rejects documents that are not ALTO or lack geometry', () => {
    expect(() => parseAlto('')).toThrow(OcrMarkupError);
    expect(() => parseAlto('<alto><Layout/></alto>')).toThrow(/no Page/);
    expect(() => parseAlto('<alto><Layout><Page ID="p"/></Layout></alto>')).toThrow(/no WIDTH and HEIGHT/);
    expect(() =>
      parseAlto(
        '<alto><Layout><Page WIDTH="10" HEIGHT="10"><TextLine><String CONTENT="x"/></TextLine></Page></Layout></alto>'
      )
    ).toThrow(/String 'x' has no HPOS/);
    expect(() =>
      parseAlto('<alto><Layout><Page WIDTH="10" HEIGHT="ten"/></Layout></alto>')
    ).toThrow(/HEIGHT 'ten' is not a decimal number/);
    expect(() =>
      parseAlto(
        '<alto><Layout><Page WIDTH="10" HEIGHT="10"><TextLine BASELINE="1,2 3"><String CONTENT="x" HPOS="0" VPOS="0" WIDTH="1" HEIGHT="1"/></TextLine></Page></Layout></alto>'
      )
    ).toThrow(/BASELINE needs coordinate pairs/);
    expect(() => parseAlto('<alto><Layout><Page WIDTH="10" HEIGHT="10"></Layout></alto>')).toThrow(/does not match/);
  });
});

/** Two blocks, three paragraphs, four lines, given out of order so grouping must follow the groups. */
function groupedResult(): OcrResult {
  const left: OcrLayoutGroup = { bbox: { x: 100, y: 100, width: 400, height: 200 } };
  const leftFirst: OcrLayoutGroup = { language: 'eng' };
  const leftSecond: OcrLayoutGroup = { language: 'eng' };
  const right: OcrLayoutGroup = {};
  const word = (text: string, x: number, y: number, width: number, confidence: number) => ({
    text,
    bbox: { x, y, width, height: 40 },
    confidence,
  });
  const lineBlocks: OcrLineBlock[] = [
    {
      text: 'one two',
      bbox: { x: 100, y: 100, width: 400, height: 50 },
      words: [word('one', 100, 100, 100, 90), word('two', 210, 100, 90, 95)],
      block: left,
      paragraph: leftFirst,
      baseline: { x0: 100, y0: 146, x1: 500, y1: 148 },
      rowHeight: 42,
      ascenders: 11,
      descenders: 10,
    },
    {
      text: 'right',
      bbox: { x: 600, y: 100, width: 300, height: 50 },
      words: [word('right', 600, 100, 300, 70)],
      block: right,
      paragraph: right,
    },
    {
      text: 'three',
      bbox: { x: 100, y: 220, width: 400, height: 40 },
      words: [word('three', 100, 220, 400, 60)],
      block: left,
      paragraph: leftSecond,
    },
    {
      text: 'four',
      bbox: { x: 100, y: 160, width: 400, height: 40 },
      words: [word('four', 100, 160, 400, 80)],
      block: left,
      paragraph: leftFirst,
    },
  ];
  return {
    text: 'one two\nright\nthree\nfour',
    confidence: 0.8,
    wordCount: 5,
    lines: lineBlocks.map((l) => l.text),
    lineBlocks,
    imageWidth: 1000,
    imageHeight: 800,
    language: 'eng',
  };
}

/** A single recognized line, for whole-document goldens. */
function oneLineResult(): OcrResult {
  const word = (text: string, x: number, confidence: number) => ({
    text,
    bbox: { x, y: 100, width: 90, height: 40 },
    confidence,
  });
  return {
    text: 'one two',
    confidence: 0.9,
    wordCount: 2,
    lines: ['one two'],
    imageWidth: 1000,
    imageHeight: 800,
    language: 'eng',
    lineBlocks: [
      {
        text: 'one two',
        bbox: { x: 100, y: 100, width: 400, height: 50 },
        words: [word('one', 100, 90), word('two', 210, 95)],
        block: { bbox: { x: 100, y: 100, width: 400, height: 200 } },
        paragraph: { language: 'eng' },
        baseline: { x0: 100, y0: 146, x1: 500, y1: 148 },
        rowHeight: 42,
        ascenders: 11,
        descenders: 10,
      },
    ],
  };
}

/** Hand-written to the hOCR 1.2 element and property names; baseline slope is (148 - 146) / 400 and the offset 146 - 150. */
const ONE_LINE_HOCR = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">',
  '<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="en" lang="en">',
  '<head>',
  '  <title>scan.png</title>',
  '  <meta http-equiv="Content-Type" content="text/html;charset=utf-8" />',
  '  <meta name="ocr-system" content="easyconvert-ocr" />',
  '  <meta name="ocr-capabilities" content="ocr_page ocr_carea ocr_par ocr_line ocrx_word ocrp_wconf" />',
  '  <meta name="ocr-number-of-pages" content="1" />',
  '  <meta name="ocr-langs" content="en" />',
  '</head>',
  '<body>',
  '  <div class="ocr_page" id="page_1" title="image &quot;scan.png&quot;; bbox 0 0 1000 800; ppageno 0">',
  '    <div class="ocr_carea" id="block_1_1" title="bbox 100 100 500 300">',
  '      <p class="ocr_par" id="par_1_1" lang="en" title="bbox 100 100 500 150">',
  '        <span class="ocr_line" id="line_1_1" title="bbox 100 100 500 150; baseline 0.005 -4; x_size 42; x_descenders 10; x_ascenders 11">',
  '          <span class="ocrx_word" id="word_1_1_1" title="bbox 100 100 190 140; x_wconf 90">one</span>',
  '          <span class="ocrx_word" id="word_1_1_2" title="bbox 210 100 300 140; x_wconf 95">two</span>',
  '        </span>',
  '      </p>',
  '    </div>',
  '  </div>',
  '</body>',
  '</html>',
  '',
].join('\n');

/** Hand-written to the ALTO 4.4 element and attribute names (Processing replaces the deprecated OCRProcessing). */
const ONE_LINE_ALTO = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<alto xmlns="http://www.loc.gov/standards/alto/ns-v4#"',
  '      xmlns:xlink="http://www.w3.org/1999/xlink"',
  '      xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"',
  '      xsi:schemaLocation="http://www.loc.gov/standards/alto/ns-v4# http://www.loc.gov/standards/alto/v4/alto-4-4.xsd"',
  '      SCHEMAVERSION="4.4">',
  '  <Description>',
  '    <MeasurementUnit>pixel</MeasurementUnit>',
  '    <sourceImageInformation>',
  '      <fileName>scan.png</fileName>',
  '    </sourceImageInformation>',
  '    <Processing ID="PROC_1">',
  '      <processingCategory>contentGeneration</processingCategory>',
  '      <processingSoftware>',
  '        <softwareName>EasyConvert OCR</softwareName>',
  '      </processingSoftware>',
  '    </Processing>',
  '  </Description>',
  '  <Layout>',
  '    <Page ID="PAGE_1" PHYSICAL_IMG_NR="1" WIDTH="1000" HEIGHT="800">',
  '      <PrintSpace HPOS="0" VPOS="0" WIDTH="1000" HEIGHT="800">',
  '        <ComposedBlock ID="CB_1_1" HPOS="100" VPOS="100" WIDTH="400" HEIGHT="200">',
  '          <TextBlock ID="TB_1_1" HPOS="100" VPOS="100" WIDTH="400" HEIGHT="50" LANG="en">',
  '            <TextLine ID="TL_1_1" HPOS="100" VPOS="100" WIDTH="400" HEIGHT="50" BASELINE="100,146 500,148">',
  '              <String CONTENT="one" HPOS="100" VPOS="100" WIDTH="90" HEIGHT="40" WC="0.90" />',
  '              <SP HPOS="190" VPOS="100" WIDTH="20" />',
  '              <String CONTENT="two" HPOS="210" VPOS="100" WIDTH="90" HEIGHT="40" WC="0.95" />',
  '            </TextLine>',
  '          </TextBlock>',
  '        </ComposedBlock>',
  '      </PrintSpace>',
  '    </Page>',
  '  </Layout>',
  '</alto>',
  '',
].join('\n');

describe('exportHocr structure', () => {
  const hocr = exportHocr(groupedResult(), { filename: 'scan.png' });

  it('writes one carea per block and one par per paragraph in order of first appearance', () => {
    const careas = hocr.match(/<div class="ocr_carea" id="[^"]+" title="[^"]+">/g);
    expect(careas).toEqual([
      '<div class="ocr_carea" id="block_1_1" title="bbox 100 100 500 300">',
      '<div class="ocr_carea" id="block_1_2" title="bbox 600 100 900 150">',
    ]);
    const pars = hocr.match(/<p class="ocr_par" id="[^"]+"[^>]*>/g);
    expect(pars).toEqual([
      '<p class="ocr_par" id="par_1_1" lang="en" title="bbox 100 100 500 200">',
      '<p class="ocr_par" id="par_1_2" lang="en" title="bbox 100 220 500 260">',
      '<p class="ocr_par" id="par_1_3" lang="en" title="bbox 600 100 900 150">',
    ]);
  });

  it('writes the baseline as slope and offset from the bottom of the line box, with the row metrics', () => {
    // Baseline (100,146)-(500,148): slope 2/400 = 0.005; at the left edge y=146, box bottom 150: offset -4.
    expect(hocr).toContain('title="bbox 100 100 500 150; baseline 0.005 -4; x_size 42; x_descenders 10; x_ascenders 11"');
    // Lines without a baseline carry none: no placeholder values.
    expect(hocr).toContain('title="bbox 100 160 500 200"');
    expect(hocr.match(/baseline/g)).toHaveLength(1);
  });

  it('writes a complete hOCR document: head metadata, page image, language and one line with its words', () => {
    expect(exportHocr(oneLineResult(), { filename: 'scan.png' })).toBe(ONE_LINE_HOCR);
  });

  it('gives lines without any layout information their own block and paragraph', () => {
    const flat = exportHocr(
      {
        text: 'a\nb',
        confidence: 0.9,
        wordCount: 2,
        lines: ['a', 'b'],
        imageWidth: 100,
        imageHeight: 100,
        lineBlocks: [
          { text: 'a', bbox: { x: 1, y: 1, width: 20, height: 10 }, words: [{ text: 'a', bbox: { x: 1, y: 1, width: 20, height: 10 }, confidence: 90 }] },
          { text: 'b', bbox: { x: 1, y: 30, width: 20, height: 10 }, words: [{ text: 'b', bbox: { x: 1, y: 30, width: 20, height: 10 }, confidence: 90 }] },
        ],
      },
      {}
    );
    expect(flat.match(/class="ocr_carea"/g)).toHaveLength(2);
    expect(flat.match(/class="ocr_par"/g)).toHaveLength(2);
    expect(flat).toContain('<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="und" lang="und">');
    expect(flat).not.toContain('ocr-langs');
  });

  it('numbers pages from zero in ppageno across a multi-page input', () => {
    const page = groupedResult();
    const multi = exportHocr([page, page], { filename: 'doc.pdf' });
    expect(multi.match(/<div class="ocr_page"[^>]*>/g)).toEqual([
      '<div class="ocr_page" id="page_1" title="image &quot;doc_page_1.png&quot;; bbox 0 0 1000 800; ppageno 0">',
      '<div class="ocr_page" id="page_2" title="image &quot;doc_page_2.png&quot;; bbox 0 0 1000 800; ppageno 1">',
    ]);
    expect(multi.match(/<div class="ocr_carea" id="[^"]+"/g)).toEqual([
      '<div class="ocr_carea" id="block_1_1"',
      '<div class="ocr_carea" id="block_1_2"',
      '<div class="ocr_carea" id="block_2_1"',
      '<div class="ocr_carea" id="block_2_2"',
    ]);
  });
});

describe('exportAlto structure', () => {
  const alto = exportAlto(groupedResult(), { filename: 'scan.png' });

  it('writes ComposedBlock, TextBlock and TextLine with BASELINE and LANG', () => {
    expect(alto).toContain('<ComposedBlock ID="CB_1_1" HPOS="100" VPOS="100" WIDTH="400" HEIGHT="200">');
    expect(alto).toContain('<ComposedBlock ID="CB_1_2" HPOS="600" VPOS="100" WIDTH="300" HEIGHT="50">');
    expect(alto).toContain('<TextBlock ID="TB_1_1" HPOS="100" VPOS="100" WIDTH="400" HEIGHT="100" LANG="en">');
    expect(alto).toContain('<TextBlock ID="TB_1_2" HPOS="100" VPOS="220" WIDTH="400" HEIGHT="40" LANG="en">');
    expect(alto).toContain('<TextLine ID="TL_1_1" HPOS="100" VPOS="100" WIDTH="400" HEIGHT="50" BASELINE="100,146 500,148">');
    expect(alto.match(/BASELINE=/g)).toHaveLength(1);
  });

  it('writes a complete ALTO document: description, source image, processing software and one line', () => {
    expect(exportAlto(oneLineResult(), { filename: 'scan.png' })).toBe(ONE_LINE_ALTO);
  });

  it('leaves out the source image when no file name is known', () => {
    const withoutName = ONE_LINE_ALTO.replace(
      '    <sourceImageInformation>\n      <fileName>scan.png</fileName>\n    </sourceImageInformation>\n',
      ''
    );
    expect(withoutName).not.toBe(ONE_LINE_ALTO);
    expect(exportAlto(oneLineResult())).toBe(withoutName);
  });

  it('only writes pixel coordinates', () => {
    expect(() => exportAlto(groupedResult(), { measurementUnit: 'mm10' })).toThrow(/measurement unit 'mm10'/);
  });
});

describe('export fails closed on coordinates it cannot write', () => {
  const broken = (patch: (result: OcrResult) => void): OcrResult => {
    const result = groupedResult();
    patch(result);
    return result;
  };

  it('rejects non-finite boxes, baselines and metrics in both formats', () => {
    const cases: Array<(result: OcrResult) => void> = [
      (r) => {
        r.lineBlocks![0].bbox.x = Number.NaN;
      },
      (r) => {
        r.lineBlocks![0].words[0].bbox.width = Number.POSITIVE_INFINITY;
      },
      (r) => {
        r.lineBlocks![0].baseline = { x0: 0, y0: Number.NaN, x1: 10, y1: 10 };
      },
      (r) => {
        r.lineBlocks![0].rowHeight = Number.NaN;
      },
    ];
    for (const patch of cases) {
      expect(() => exportHocr(broken(patch))).toThrow(OcrMarkupError);
    }
    expect(() => exportAlto(broken(cases[0]))).toThrow(OcrMarkupError);
    expect(() => exportAlto(broken(cases[1]))).toThrow(OcrMarkupError);
    expect(() => exportAlto(broken(cases[2]))).toThrow(OcrMarkupError);
  });

  it('rejects an empty page area', () => {
    const result = groupedResult();
    result.imageWidth = 0.2;
    expect(() => exportHocr(result)).toThrow(/page of 0x800 pixels/);
  });
});

describe('layout carried from the recognizer output', () => {
  it('parseTesseractBlocks attaches block, paragraph, baseline and row metrics to each line', () => {
    const box = (x0: number, y0: number, x1: number, y1: number) => ({ x0, y0, x1, y1 });
    const word = (text: string, b: ReturnType<typeof box>) => ({ text, confidence: 90, bbox: b });
    const blocks = [
      {
        bbox: box(10, 10, 210, 90),
        paragraphs: [
          {
            bbox: box(10, 10, 210, 50),
            lines: [
              {
                text: 'a b',
                bbox: box(10, 10, 210, 50),
                baseline: { x0: 10, y0: 40, x1: 210, y1: 42 },
                rowAttributes: { rowHeight: 30, ascenders: 8, descenders: 6 },
                words: [word('a', box(10, 10, 50, 40)), word('b', box(60, 10, 100, 40))],
              },
              {
                text: 'c',
                bbox: box(10, 55, 110, 90),
                baseline: { x0: 0, y0: 0, x1: 0, y1: 0 },
                words: [word('c', box(10, 55, 50, 85))],
              },
            ],
          },
        ],
      },
      {
        bbox: box(0, 0, 0, 0),
        paragraphs: [{ lines: [{ text: 'd', bbox: box(300, 10, 340, 50), words: [word('d', box(300, 10, 340, 40))] }] }],
      },
    ];
    const { lineBlocks } = parseTesseractBlocks(blocks, 400, 200, 'eng');
    const byText = new Map(lineBlocks.map((line) => [line.text, line]));
    const ab = byText.get('a b')!;
    const c = byText.get('c')!;
    const d = byText.get('d')!;
    expect(ab.block).toBe(c.block);
    expect(ab.paragraph).toBe(c.paragraph);
    expect(ab.block).not.toBe(d.block);
    expect(ab.block?.bbox).toEqual({ x: 10, y: 10, width: 200, height: 80 });
    expect(ab.paragraph).toMatchObject({ language: 'eng', bbox: { x: 10, y: 10, width: 200, height: 40 } });
    expect(ab.baseline).toEqual({ x0: 10, y0: 40, x1: 210, y1: 42 });
    expect([ab.rowHeight, ab.ascenders, ab.descenders]).toEqual([30, 8, 6]);
    // A zero-length baseline is the engine's "none", and an empty block box is unusable.
    expect(c.baseline).toBeUndefined();
    expect(d.block?.bbox).toBeUndefined();
    expect(d.rowHeight).toBeUndefined();
  });

  it('parseTesseractTsv groups lines by block and paragraph and takes their boxes from levels 2 and 3', () => {
    const header = 'level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext';
    const tsv = [
      header,
      '1\t1\t0\t0\t0\t0\t0\t0\t1000\t800\t-1\t',
      '2\t1\t1\t0\t0\t0\t100\t100\t300\t120\t-1\t',
      '3\t1\t1\t1\t0\t0\t100\t100\t300\t40\t-1\t',
      '4\t1\t1\t1\t1\t0\t100\t100\t300\t40\t-1\t',
      '5\t1\t1\t1\t1\t1\t100\t100\t120\t40\t90\tone',
      '3\t1\t1\t2\t0\t0\t100\t180\t300\t40\t-1\t',
      '4\t1\t1\t2\t1\t0\t100\t180\t300\t40\t-1\t',
      '5\t1\t1\t2\t1\t1\t100\t180\t120\t40\t90\ttwo',
      '2\t1\t2\t0\t0\t0\t600\t100\t200\t40\t-1\t',
      '3\t1\t2\t1\t0\t0\t600\t100\t200\t40\t-1\t',
      '4\t1\t2\t1\t1\t0\t600\t100\t200\t40\t-1\t',
      '5\t1\t2\t1\t1\t1\t600\t100\t200\t40\t90\tthree',
      '',
    ].join('\n');
    const { lineBlocks, language } = parseTesseractTsv(tsv, 'eng');
    expect(language).toBe('eng');
    const byText = new Map((lineBlocks ?? []).map((line) => [line.text, line]));
    const one = byText.get('one')!;
    const two = byText.get('two')!;
    const three = byText.get('three')!;
    expect(one.block).toBe(two.block);
    expect(one.paragraph).not.toBe(two.paragraph);
    expect(one.block).not.toBe(three.block);
    expect(one.block?.bbox).toEqual({ x: 100, y: 100, width: 300, height: 120 });
    expect(two.paragraph?.bbox).toEqual({ x: 100, y: 180, width: 300, height: 40 });
    expect(three.paragraph).toMatchObject({ language: 'eng', bbox: { x: 600, y: 100, width: 200, height: 40 } });
    // TSV rows carry no baseline or row metrics, so none are invented.
    expect(one.baseline).toBeUndefined();
    expect(one.rowHeight).toBeUndefined();
  });
});

describe('exporter output read by the reference XML tools', () => {
  oracleTest(
    'escapes markup, quotes and unrepresentable characters in one pass; text round-trips through xmllint',
    ['xmllint'],
    () => {
      const tricky = 'a&b<c>"d\'e';
      const result = groupedResult();
      result.lineBlocks![0].words[0].text = tricky;
      result.lineBlocks![0].words[1].text = 'ok\u0001\u0008￾\uD800x\u{1F600}y';
      const hocr = exportHocr(result, { filename: 'we"ird\nname&.png', documentTitle: 'T<&>' });
      expect(xmlWellFormed(hocr).ok).toBe(true);
      expect(xpathString(hocr, "string((//*[@class='ocrx_word'])[1])")).toBe(tricky);
      // Control characters, U+FFFE and the unpaired surrogate are dropped; the emoji survives.
      expect(xpathString(hocr, "string((//*[@class='ocrx_word'])[2])")).toBe('okx\u{1F600}y');
      expect(xpathString(hocr, 'string(//*[local-name()="title"])')).toBe('T<&>');
      expect(xpathAttributes(hocr, "//*[@class='ocr_page']/@title")[0]).toBe(
        'image "we"ird\nname&.png"; bbox 0 0 1000 800; ppageno 0'
      );

      const alto = exportAlto(result, { filename: 'we"ird\nname&.png' });
      expect(validateAlto44(alto).ok).toBe(true);
      expect(xpathAttributes(alto, "(//*[local-name()='String'])[1]/@CONTENT")).toEqual([tricky]);
      expect(xpathAttributes(alto, "(//*[local-name()='String'])[2]/@CONTENT")).toEqual(['okx\u{1F600}y']);
      expect(xpathString(alto, "string(//*[local-name()='fileName'])")).toBe('we"ird\nname&.png');
    }
  );

  oracleTest(
    'an hOCR document read and written as ALTO validates against the ALTO 4.4 schema and keeps its structure',
    ['xmllint'],
    () => {
      const alto = exportAlto(parseHocr(HOCR), { filename: 'scan.png' });
      const checked = validateAlto44(alto);
      expect(checked.stderr.trim()).toBe('- validates');
      expect(xpathCount(alto, "//*[local-name()='ComposedBlock']")).toBe(2);
      expect(xpathCount(alto, "//*[local-name()='TextBlock']")).toBe(3);
      expect(xpathCount(alto, "//*[local-name()='TextLine']")).toBe(4);
      expect(xpathCount(alto, "//*[local-name()='String']")).toBe(5);
      expect(xpathAttributes(alto, "//*[local-name()='TextLine']/@BASELINE")).toEqual([
        '100,145 500,149',
        '100,192 400,192',
        '600,150 900,150',
      ]);
      // Paragraphs tagged `eng` become `en`; the third has no tag of its own and takes the document's `en`.
      expect(xpathAttributes(alto, "//*[local-name()='TextBlock']/@LANG")).toEqual(['en', 'en', 'en']);
    }
  );

  oracleTest(
    'an ALTO document read and written as hOCR is well-formed and keeps blocks, paragraphs and baselines',
    ['xmllint'],
    () => {
      const hocr = exportHocr(parseAlto(ALTO), { filename: 'scan.png' });
      expect(xmlWellFormed(hocr).ok).toBe(true);
      expect(xpathCount(hocr, "//*[@class='ocr_carea']")).toBe(2);
      expect(xpathCount(hocr, "//*[@class='ocr_par']")).toBe(3);
      expect(xpathCount(hocr, "//*[@class='ocr_line']")).toBe(3);
      // First line: baseline (100,145)-(500,149), box bottom 150 -> slope 0.01, offset -5.
      expect(xpathAttributes(hocr, "(//*[@class='ocr_line'])[1]/@title")).toEqual(['bbox 100 100 500 150; baseline 0.01 -5']);
      // Second line: horizontal baseline at y=255, box bottom 260 -> offset -5.
      expect(xpathAttributes(hocr, "(//*[@class='ocr_line'])[2]/@title")).toEqual(['bbox 100 220 500 260; baseline 0 -5']);
      expect(xpathAttributes(hocr, "//*[@class='ocr_par']/@lang")[0]).toBe('en');
    }
  );

  oracleTest(
    'multi-page input validates; lines without layout information each become a TextBlock directly under PrintSpace',
    ['xmllint'],
    () => {
      const flat = {
        text: 'first\nsecond',
        confidence: 0.9,
        wordCount: 2,
        lines: ['first', 'second'],
        imageWidth: 100,
        imageHeight: 100,
        lineBlocks: [
          { text: 'first', bbox: { x: 1, y: 1, width: 40, height: 10 }, words: [{ text: 'first', bbox: { x: 1, y: 1, width: 40, height: 10 }, confidence: 90 }] },
          { text: 'second', bbox: { x: 1, y: 30, width: 40, height: 10 }, words: [{ text: 'second', bbox: { x: 1, y: 30, width: 40, height: 10 }, confidence: 80 }] },
        ],
      };
      const alto = exportAlto([flat, groupedResult()], { filename: 'mixed.pdf' });
      expect(validateAlto44(alto).stderr.trim()).toBe('- validates');
      // Page 1 is the two unstructured lines; page 2 has two blocks.
      expect(xpathCount(alto, "//*[local-name()='Page'][1]//*[local-name()='TextBlock']")).toBe(2);
      expect(xpathCount(alto, "//*[local-name()='Page'][1]//*[local-name()='ComposedBlock']")).toBe(0);
      expect(xpathCount(alto, "//*[local-name()='Page'][2]//*[local-name()='ComposedBlock']")).toBe(2);
      const hocr = exportHocr([flat, groupedResult()], { filename: 'mixed.pdf' });
      expect(xmlWellFormed(hocr).ok).toBe(true);
      expect(xpathCount(hocr, "//*[@class='ocr_page'][1]//*[@class='ocr_carea']")).toBe(2);
      expect(xpathCount(hocr, "//*[@class='ocr_page'][2]//*[@class='ocr_carea']")).toBe(2);
    }
  );

  oracleTest(
    'language codes the pipeline accepts become valid BCP 47 tags in ALTO LANG, and unknown codes are left out',
    ['xmllint'],
    () => {
      const expected: Array<[string, string | null]> = [
        ['eng', 'en'],
        ['kor', 'ko'],
        ['jpn_vert', 'ja'],
        ['chi_sim', 'zh-Hans'],
        ['chi_tra_vert', 'zh-Hant'],
        ['zh-Hant-TW', 'zh-Hant-TW'],
        ['not_a_tag', null],
        ['toolongsubtag-x', null],
      ];
      for (const [code, tag] of expected) {
        const result = groupedResult();
        result.language = code;
        for (const line of result.lineBlocks ?? []) {
          if (line.paragraph) line.paragraph.language = undefined;
        }
        const alto = exportAlto(result);
        expect(validateAlto44(alto).ok, code).toBe(true);
        expect(xpathCount(alto, "//*[local-name()='TextBlock']/@LANG"), code).toBe(tag === null ? 0 : 3);
        if (tag !== null) expect(new Set(xpathAttributes(alto, "//*[local-name()='TextBlock']/@LANG")), code).toEqual(new Set([tag]));
        const hocr = exportHocr(result);
        expect(xmlWellFormed(hocr).ok, code).toBe(true);
        expect(xpathAttributes(hocr, '/*/@lang'), code).toEqual([tag ?? 'und']);
      }
    }
  );
});
