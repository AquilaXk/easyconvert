import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { documentToDocx } from '../src/lib/conversions/document-model/docx';
import { blankDocument } from '../src/lib/conversions/document-model/build';
import type { Block, DocumentModel, ParagraphBlock, ParagraphFormat } from '../src/lib/conversions/document-model/model';
import { absorbFigureSpacers, irregularColumnPages, PageFlow, pageSections, type PageSetup } from '../src/lib/conversions/pdf-layout/page-flow';
import type { Box, DetectedTable, LayoutLine, Paragraph } from '../src/lib/conversions/pdf-layout/types';

/**
 * The part of PDF to DOCX that keeps the pages: what `PageFlow` makes of the lines of a page (gap, line height, indents, alignment,
 * frames, column breaks), how `pageSections` cuts a document into pages, and how the DOCX writer says it. The lines are written by
 * hand with the geometry the checks are about; the real files are in tests/pdf-to-docx-pages.test.ts.
 */

const PAGE_WIDTH = 612;
const SETUP: PageSetup = { margins: { top: 72, right: 72, bottom: 0, left: 72 }, pageWidth: PAGE_WIDTH, pageTops: new Map([[1, 72], [2, 72]]) };

function lineOf(text: string, x0: number, x1: number, baseline: number, size = 12): LayoutLine {
  const run = { text, bold: false, italic: false, monospace: false };
  return { runs: [run], text, box: { x0, y0: baseline - size, x1, y1: baseline + 3 }, baseline, size, bold: false, italic: false, monospace: false, rtl: false, fontKey: 'f', vertical: false };
}

function paragraphOf(lines: LayoutLine[], pageNumber = 1, flow = 1): Paragraph {
  const box: Box = { x0: Math.min(...lines.map((l) => l.box.x0)), y0: Math.min(...lines.map((l) => l.box.y0)), x1: Math.max(...lines.map((l) => l.box.x1)), y1: Math.max(...lines.map((l) => l.box.y1)) };
  return {
    runs: lines.flatMap((l) => l.runs),
    text: lines.map((l) => l.text).join(' '),
    lines,
    box,
    size: lines[0].size,
    bold: false,
    italic: false,
    monospace: false,
    rtl: false,
    fontKey: 'f',
    firstLineX: lines[0].box.x0,
    leftX: lines.length > 1 ? lines[1].box.x0 : lines[0].box.x0,
    flow,
    pageNumber,
    full: false,
  };
}

const format = (flow: PageFlow, paragraph: Paragraph, columns = 1): ParagraphFormat => flow.paragraph(paragraph, columns) as ParagraphFormat;

describe('the gap and the line height of a paragraph', () => {
  it('sets the first paragraph below the top of its page and the next one the page distance below it', () => {
    const flow = new PageFlow(SETUP);
    const first = format(flow, paragraphOf([lineOf('First', 72, 120, 100), lineOf('line two', 72, 130, 114)]));
    expect(first.lineHeightPt).toBeCloseTo(14, 1);
    // The line box starts at baseline - (line height - descent); the page's top is 72.
    expect(first.beforePt).toBeCloseTo(100 - (14 - 0.23 * 12) - 72, 1);
    const second = format(flow, paragraphOf([lineOf('Second', 72, 140, 142)]));
    // The first paragraph ends at 100 - 11.24 + 2 * 14 = 116.76; the second box starts at 142 - (13.8 - 2.76) = 130.96.
    expect(second.beforePt).toBeCloseTo(130.96 - 116.76, 1);
  });

  it('gives a line the distance from the baseline above when it has no pitch of its own', () => {
    const flow = new PageFlow(SETUP);
    format(flow, paragraphOf([lineOf('One', 72, 100, 100)]));
    const next = format(flow, paragraphOf([lineOf('Two', 72, 100, 112.6)]));
    expect(next.lineHeightPt).toBeCloseTo(12.6, 1);
    expect(next.beforePt).toBe(0);
  });

  it('starts every page at its own top', () => {
    const flow = new PageFlow({ ...SETUP, pageTops: new Map([[1, 72], [2, 40]]) });
    format(flow, paragraphOf([lineOf('Page one', 72, 120, 400)], 1));
    const onTwo = format(flow, paragraphOf([lineOf('Page two', 72, 120, 80)], 2));
    expect(onTwo.beforePt).toBeCloseTo(80 - (13.8 - 2.76) - 40, 1);
  });
});

describe('indents and alignment', () => {
  it('indents the first line and the rest from the left margin, and wraps where the longest line ended', () => {
    const flow = new PageFlow(SETUP);
    const lines = [lineOf('Indented first line of a paragraph', 108, 538, 100), lineOf('second line goes the whole way over', 72, 540, 114), lineOf('last', 72, 100, 128)];
    const result = format(flow, paragraphOf(lines));
    expect(result.leftPt).toBe(0);
    expect(result.firstLinePt).toBe(36);
    // The text area ends at 540; the longest line ends at 540, so only the slack is left.
    expect(result.rightPt).toBe(0);
    expect(result.align).toBe('justify');
  });

  it('centres a title between the margins and keeps a centred line off a margin when the margins are not symmetric', () => {
    const flow = new PageFlow({ ...SETUP, margins: { ...SETUP.margins, right: 40 } });
    // The text area is 72 to 572; its middle is 322. The title is centred on the page's 306.
    const result = format(flow, paragraphOf([lineOf('A Title', 276, 336, 100, 14)]));
    expect(result.align).toBe('center');
    expect(result.leftPt).toBe(0);
    expect(result.rightPt).toBeCloseTo(32, 0);
  });

  it('does not take a line that fills the page for a centred one', () => {
    const flow = new PageFlow(SETUP);
    const result = format(flow, paragraphOf([lineOf('A full line of text that fills the page from side to side of the area', 74, 538, 100)]));
    expect(result.align).toBe('left');
    // A line that fits stands a little past the margin rather than wrap.
    expect(result.rightPt).toBeLessThan(0);
  });

  it('hangs the marker of a list item, and opens a first line with it when the other lines start left of it', () => {
    const flow = new PageFlow(SETUP);
    const hanging = paragraphOf([lineOf('1. Text of the item', 90, 300, 100), lineOf('continued under the text', 110, 300, 114)]);
    hanging.lines[0].textX0 = 110;
    const item = flow.paragraph(hanging, 1, true) as ParagraphFormat;
    expect(item.leftPt).toBe(38);
    expect(item.firstLinePt).toBe(-20);
    const indented = paragraphOf([lineOf('2. Indented paragraph', 108, 300, 142), lineOf('flush left again', 72, 300, 156)]);
    const open = flow.paragraph(indented, 1, true) as ParagraphFormat;
    expect(open.leftPt).toBe(0);
    expect(open.firstLinePt).toBe(36);
  });
});

describe('what stands beside the text', () => {
  it('sets a paragraph that rises beside what the flow holds as a frame at its place and moves nothing', () => {
    const flow = new PageFlow(SETUP);
    format(flow, paragraphOf([lineOf('Left text', 72, 200, 100), lineOf('more left text', 72, 200, 114), lineOf('and more', 72, 200, 128)]));
    const beside = format(flow, paragraphOf([lineOf('-', 346, 350, 107)]));
    expect(beside.frame).toBeDefined();
    expect(beside.frame?.xPt).toBe(346);
    expect(beside.frame?.yPt).toBeCloseTo(107 - (13.8 - 2.76), 1);
    const after = format(flow, paragraphOf([lineOf('Next line', 72, 200, 142)]));
    expect(after.frame).toBeUndefined();
    expect(after.beforePt).toBeCloseTo(0, 0);
  });

  it('starts a new column when a flow of several columns returns to the top of its page', () => {
    const flow = new PageFlow(SETUP);
    format(flow, paragraphOf([lineOf('Column one', 72, 280, 100), lineOf('goes down', 72, 280, 114), lineOf('the page', 72, 280, 128), lineOf('to the end', 72, 280, 400)]), 2);
    const top = format(flow, paragraphOf([lineOf('Column two starts', 300, 540, 100)]), 2);
    expect(top.columnBreakBefore).toBe(true);
    expect(top.beforePt).toBeCloseTo(100 - 11.04 - 72, 1);
  });

  it('keeps the text of a table cell inside the row and at the place of its column', () => {
    const flow = new PageFlow(SETUP);
    const cell = flow.cell({ y0: 100, y1: 118, x0: 200, x1: 300 });
    const inCell = cell.paragraph(paragraphOf([lineOf('Two lines', 210, 260, 112), lineOf('in a row', 210, 255, 125)]), 1) as ParagraphFormat;
    expect(inCell.leftPt).toBe(10);
    expect(inCell.align).toBe('left');
    // The two lines hold 28 points and the row 18, so the lines take what the row has, down to nine tenths of the text size.
    expect(inCell.lineHeightPt).toBeGreaterThanOrEqual(10.8);
    expect(inCell.lineHeightPt).toBeLessThan(14);
    expect(cell.end).toBeGreaterThan(100);
  });

  it('places a table with the heights of the rows the page drew', () => {
    const flow = new PageFlow(SETUP);
    const table: DetectedTable = { rows: [[], []], columnWidths: [100], box: { x0: 80, y0: 110, x1: 180, y1: 150 }, pageNumber: 1, kind: 'lattice', rowEdges: [110, 125, 150] };
    const placed = flow.table(table);
    expect(placed.rowHeights).toEqual([15, 25]);
    expect(placed.indentPt).toBe(8);
    expect(placed.beforePt).toBe(110 - 72);
  });
});

describe('pages as sections', () => {
  const paragraph = (text: string): Block => ({ type: 'paragraph', runs: [{ text, bold: false, italic: false, monospace: false }], rtl: false, align: 'left' });

  it('starts a section on a new page for every page, and holds a page with no block open with an empty paragraph', () => {
    const blocks = [paragraph('one'), paragraph('three-a'), paragraph('three-b')];
    const sections = pageSections(blocks, [1, 1, 1], [1, 3, 3], [1, 2, 3], { headerPages: new Set(), footerPages: new Set() }, new Map([[1, 60], [3, 80]]));
    expect(sections.map((section) => section.breakType)).toEqual([undefined, 'nextPage', 'nextPage']);
    expect(sections[1].blocks).toHaveLength(1);
    expect((sections[1].blocks[0] as ParagraphBlock).runs).toEqual([]);
    expect(sections[2].blocks).toHaveLength(2);
    expect(sections.map((section) => section.marginTopPt)).toEqual([60, undefined, 80]);
  });

  it('splits a page where the columns change and marks the pages that lack the running header the others have', () => {
    const blocks = [paragraph('title'), paragraph('left'), paragraph('right'), paragraph('second page')];
    const sections = pageSections(blocks, [1, 2, 2, 1], [1, 1, 1, 2], [1, 2], { headerPages: new Set([2]), footerPages: new Set([1, 2]) }, new Map());
    expect(sections.map((section) => [section.columns, section.breakType])).toEqual([[1, undefined], [2, undefined], [1, 'nextPage']]);
    expect(sections[0].omitsHeader).toBe(true);
    expect(sections[0].omitsFooter).toBeUndefined();
    expect(sections[2].omitsHeader).toBeUndefined();
  });

  it('takes the height of a figure out of the gap above what follows it', () => {
    const spacer: ParagraphBlock = { type: 'paragraph', runs: [], rtl: false, align: 'left', spacerPt: 40 };
    const next: ParagraphBlock = { type: 'paragraph', runs: [], rtl: false, align: 'left', format: { beforePt: 55, lineHeightPt: 14, leftPt: 0, firstLinePt: 0, rightPt: 0 } };
    absorbFigureSpacers([spacer, next]);
    expect(next.format?.beforePt).toBe(15);
  });
});

describe('columns of a page', () => {
  const columned = (page: number, ...starts: number[]) => ({ pageNumber: page, columns: starts.length, boxes: starts.map((x0) => ({ x0, y0: 0, x1: x0 + 100, y1: 10 })) });

  it('takes equal columns for columns and unequal ones (a narrow column beside wide ones) for a page to set by frames', () => {
    const regular = irregularColumnPages([columned(1, 57, 312), columned(2, 40, 220, 400, 580)]);
    expect([...regular]).toEqual([]);
    const irregular = irregularColumnPages([columned(1, 57, 312), columned(2, 30, 90, 330, 480)]);
    expect([...irregular]).toEqual([2]);
  });

  it('finds a missing column too: a page that says two columns and shows one left edge', () => {
    expect([...irregularColumnPages([{ pageNumber: 4, columns: 2, boxes: [{ x0: 57, y0: 0, x1: 500, y1: 10 }] }])]).toEqual([4]);
  });
});

describe('the DOCX the pages are written as', () => {
  const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==', 'base64');
  const run = (text: string) => ({ text, bold: false, italic: false, monospace: false });
  const formatted = (text: string, extra: Partial<ParagraphFormat> = {}): ParagraphBlock => ({
    type: 'paragraph',
    runs: [run(text)],
    rtl: false,
    align: 'left',
    format: { beforePt: 10, lineHeightPt: 14, leftPt: 36, firstLinePt: -18, rightPt: 5, ...extra },
  });

  async function documentXml(blocks: Block[], tweak: (model: DocumentModel) => void = () => undefined): Promise<{ xml: string; zip: JSZip }> {
    const model: DocumentModel = {
      ...blankDocument([{ columns: 1, blocks }]),
      pageFlow: true,
      pageWidthPt: PAGE_WIDTH,
      pageHeightPt: 792,
      margins: { top: 72, right: 72, bottom: 0, left: 72 },
      images: [{ id: 1, format: 'png', data: PNG, pixelWidth: 1, pixelHeight: 1 }],
    };
    tweak(model);
    const zip = await JSZip.loadAsync(await documentToDocx(model));
    return { xml: await (zip.file('word/document.xml') as JSZip.JSZipObject).async('string'), zip };
  }

  it('sets spacing, an exact line height, indents and alignment from the format, and no space the style would add', async () => {
    const heading: Block = { type: 'heading', level: 1, runs: [run('Title')], rtl: false, format: { beforePt: 6, lineHeightPt: 20, leftPt: 0, firstLinePt: 0, rightPt: 0, align: 'center' } };
    const { xml, zip } = await documentXml([heading, formatted('body')]);
    // The properties of the two paragraphs, in the order the schema fixes: style, keepNext, spacing, indents, alignment.
    const properties = [...xml.matchAll(/<w:pPr>(.*?)<\/w:pPr>/g)].map((match) => match[1]);
    expect(properties).toEqual([
      '<w:pStyle w:val="Heading1"/><w:keepNext w:val="0"/><w:spacing w:before="120" w:after="0" w:line="400" w:lineRule="exact"/><w:ind w:left="0" w:right="0"/><w:jc w:val="center"/>',
      '<w:spacing w:before="200" w:after="0" w:line="280" w:lineRule="exact"/><w:ind w:left="720" w:right="100" w:hanging="360"/>',
    ]);
    expect(await (zip.file('word/styles.xml') as JSZip.JSZipObject).async('string')).toContain('<w:pPrDefault><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/>');
  });

  it('sets a frame at its place on the page, a column break in a paragraph of its own, and a picture at its place that takes no line', async () => {
    const { xml } = await documentXml([
      formatted('beside', { frame: { xPt: 346, yPt: 200, widthPt: 20 } }),
      formatted('column', { columnBreakBefore: true }),
      { type: 'image', imageId: 1, widthPt: 50, heightPt: 40, position: { x: 100, y: 300 } },
    ]);
    expect(xml).toContain('<w:framePr w:w="400" w:hSpace="0" w:vSpace="0" w:wrap="through" w:vAnchor="page" w:hAnchor="page" w:x="6920" w:y="4000"/>');
    expect(xml).toMatch(/<w:p><w:pPr><w:spacing w:before="0" w:after="0" w:line="20" w:lineRule="exact"\/><\/w:pPr><w:r><w:br w:type="column"\/><\/w:r><\/w:p><w:p><w:pPr>/);
    expect(xml).toContain('<wp:positionH relativeFrom="page"><wp:posOffset>1270000</wp:posOffset></wp:positionH><wp:positionV relativeFrom="page"><wp:posOffset>3810000</wp:posOffset></wp:positionV>');
    expect(xml).toContain('<wp:wrapNone/>');
    expect(xml).not.toContain('<wp:inline');
  });

  it('gives a table no cell padding, its indent and the least height of each row, and a section break a paragraph of one point', async () => {
    const cell = { paragraphs: [formatted('cell', { leftPt: 4 })], colSpan: 1, rowSpan: 1, continuation: false, header: false };
    const table: Block = { type: 'table', rows: [[cell], [cell]], columnWidths: [200], bordered: true, indentPt: -3, beforePt: 12, rowHeights: [20, 30] };
    const { xml } = await documentXml([table], (model) => {
      model.sections.push({ columns: 1, blocks: [formatted('second page')], breakType: 'nextPage', marginTopPt: 40 });
    });
    expect(xml).toContain('<w:tblInd w:w="-60" w:type="dxa"/>');
    expect(xml).toContain('<w:tblCellMar><w:left w:w="0" w:type="dxa"/><w:right w:w="0" w:type="dxa"/></w:tblCellMar>');
    expect(xml).toContain('<w:trHeight w:val="400" w:hRule="atLeast"/>');
    expect(xml).toContain('<w:trHeight w:val="600" w:hRule="atLeast"/>');
    // The 12 points above the table are a paragraph of that height; the section break after the table stands in a one-point paragraph.
    expect(xml).toContain('<w:spacing w:before="0" w:after="0" w:line="240" w:lineRule="exact"/></w:pPr></w:p><w:tbl>');
    expect(xml).toMatch(/<\/w:tbl><w:p><w:pPr><w:spacing w:before="0" w:after="0" w:line="20" w:lineRule="exact"\/><w:sectPr>/);
    expect(xml).toContain('<w:type w:val="nextPage"/>');
    expect(xml).toContain('w:top="800"');
  });

  it('points the first page of a section that omits the running header at an empty part, and keeps the footer', async () => {
    const { xml, zip } = await documentXml([formatted('first page')], (model) => {
      model.pageHeader = [[run('Header')]];
      model.pageFooter = [[run('Footer')]];
      model.headerDistancePt = 30;
      model.footerDistancePt = 20;
      model.sections[0].omitsHeader = true;
      model.sections.push({ columns: 1, blocks: [formatted('second page')], breakType: 'nextPage' });
    });
    const references = [...xml.matchAll(/<w:sectPr>(.*?)<\/w:sectPr>/g)].map((section) => [...section[1].matchAll(/<w:(header|footer)Reference w:type="(\w+)" r:id="(\w+)"\/>/g)].map((match) => match.slice(1)));
    // The first section omits the header, so its first page takes the empty part and the footer of the document; the last keeps both.
    expect(references).toEqual([
      [['header', 'default', 'rIdHeader1'], ['header', 'first', 'rIdHeader2'], ['footer', 'default', 'rIdFooter1'], ['footer', 'first', 'rIdFooter1']],
      [['header', 'default', 'rIdHeader1'], ['footer', 'default', 'rIdFooter1']],
    ]);
    expect(xml).toContain('<w:titlePg/>');
    expect(xml).toContain('w:header="600" w:footer="400"');
    expect(await (zip.file('word/header2.xml') as JSZip.JSZipObject).async('string')).not.toContain('Header');
    expect(await (zip.file('word/footer1.xml') as JSZip.JSZipObject).async('string')).toContain('Footer');
    expect(await (zip.file('[Content_Types].xml') as JSZip.JSZipObject).async('string')).toContain('/word/header2.xml');
  });
});
