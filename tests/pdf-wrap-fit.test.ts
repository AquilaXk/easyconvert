import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { PDFDocument, StandardFonts, type PDFFont } from 'pdf-lib';
import { blankDocument } from '../src/lib/conversions/document-model/build';
import { documentToDocx } from '../src/lib/conversions/document-model/docx';
import type { DocumentModel } from '../src/lib/conversions/document-model/model';
import type { PdfContentFont, PdfContentItem, PdfPageContent } from '../src/lib/conversions/pdf-text-types';
import { faceWidthPercents, setFaceWidths } from '../src/lib/conversions/pdf-layout/face-width';
import { PageFlow, type PageSetup } from '../src/lib/conversions/pdf-layout/page-flow';
import type { Box, LayoutLine, Paragraph } from '../src/lib/conversions/pdf-layout/types';
import { WrapMetrics, wrappingIndent } from '../src/lib/conversions/pdf-layout/wrap-fit';

/**
 * Where a paragraph of a kept page wraps. The widths the checks compare against come from pdf-lib's own measure of Times-Roman
 * (`widthOfTextAtSize`), not from the table the code under test reads, so a line that fits or does not is judged independently.
 */

const SIZE = 12;
const AREA = 468;
const LEFT = 72;
const TEXT =
  'The appellants were allegedly members of a group, comprised of more than fifteen individuals, that carried out home invasions and robberies to obtain money, drugs, and other valuable items from persons believed to be drug traffickers. Such robberies are generally known as rip-offs.';

async function timesRoman(): Promise<PDFFont> {
  return (await PDFDocument.create()).embedFont(StandardFonts.TimesRoman);
}

/** The lines a greedy wrap of `text` makes at `width` points in Times-Roman. */
function wrapped(font: PDFFont, text: string, width: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(' ')) {
    const trial = line === '' ? word : `${line} ${word}`;
    if (line !== '' && font.widthOfTextAtSize(trial, SIZE) > width) {
      lines.push(line);
      line = word;
    } else {
      line = trial;
    }
  }
  return [...lines, line];
}

function lineOf(text: string, x1: number, baseline: number): LayoutLine {
  const run = { text, bold: false, italic: false, monospace: false };
  return { runs: [run], text, box: { x0: LEFT, y0: baseline - SIZE, x1, y1: baseline + 3 }, baseline, size: SIZE, bold: false, italic: false, monospace: false, rtl: false, fontKey: 'Times', vertical: false };
}

function paragraphOf(lines: LayoutLine[]): Paragraph {
  const box: Box = { x0: LEFT, y0: lines[0].box.y0, x1: Math.max(...lines.map((line) => line.box.x1)), y1: lines[lines.length - 1].box.y1 };
  return {
    runs: [{ text: lines.map((line) => line.text).join(' '), bold: false, italic: false, monospace: false }],
    text: lines.map((line) => line.text).join(' '),
    lines,
    box,
    size: SIZE,
    bold: false,
    italic: false,
    monospace: false,
    rtl: false,
    fontKey: 'Times',
    firstLineX: LEFT,
    leftX: LEFT,
    flow: 1,
    pageNumber: 1,
    full: false,
  };
}

/** A justified paragraph as the page sets it: every line but the last as wide as the text it wrapped at. */
function justified(lines: string[], width: number): Paragraph {
  return paragraphOf(lines.map((text, index) => lineOf(text, LEFT + (index === lines.length - 1 ? 200 : width), 100 + index * 14)));
}

const metrics = new WrapMetrics('serif');
const baseOf = (): number => AREA;

describe('the right indent that makes the writer wrap a paragraph where the page did', () => {
  it('lets each line of the page stand on one line and keeps the first word of the next off it', async () => {
    const font = await timesRoman();
    const lines = wrapped(font, TEXT, 300);
    expect(lines.length).toBeGreaterThan(3);
    // The page's right edge is where the lines were justified to: 300 points of text in a text area of 468.
    const indent = wrappingIndent(justified(lines, 300), SIZE, metrics, baseOf, AREA - 300) as number;
    const room = AREA - indent;
    lines.forEach((line, index) => {
      expect(font.widthOfTextAtSize(line, SIZE)).toBeLessThanOrEqual(room);
      if (index + 1 < lines.length) expect(font.widthOfTextAtSize(`${line} ${lines[index + 1].split(' ')[0]}`, SIZE)).toBeGreaterThan(room);
    });
    // The wrap of the writer at that indent is the page's.
    expect(wrapped(font, TEXT, room)).toEqual(lines);
  });

  it('puts a justified line at the page edge when the breaks hold there, and brings it to the breaks when they do not', async () => {
    const font = await timesRoman();
    // A page that wrapped at 306 points and stretched its lines to that edge keeps its edge.
    const wide = wrapped(font, TEXT, 306);
    const kept = wrappingIndent(justified(wide, 306), SIZE, metrics, baseOf, AREA - 306) as number;
    expect(wrapped(font, TEXT, AREA - kept)).toEqual(wide);
    expect(Math.abs(AREA - kept - 306)).toBeLessThanOrEqual(1.5);
    // Lines that wrapped at 300 and were stretched to 360 (a page edge far from the breaks) are brought to where the breaks are.
    const lines = wrapped(font, TEXT, 300);
    const far = wrappingIndent(justified(lines, 360), SIZE, metrics, baseOf, AREA - 360) as number;
    expect(wrapped(font, TEXT, AREA - far)).toEqual(lines);
  });

  it('breaks a paragraph whose words the page cut with a hyphen into about as many lines as the page had', async () => {
    const font = await timesRoman();
    // The page filled each line to 300 points, and cut a word where the line ended.
    const cut: string[] = [];
    let line = '';
    for (const word of TEXT.split(' ')) {
      const trial = line === '' ? word : `${line} ${word}`;
      if (font.widthOfTextAtSize(trial, SIZE) <= 300) {
        line = trial;
        continue;
      }
      let head = Math.max(2, word.length - 3);
      while (head > 2 && font.widthOfTextAtSize(`${line} ${word.slice(0, head)}-`, SIZE) > 300) head--;
      cut.push(`${line} ${word.slice(0, head)}-`);
      line = word.slice(head);
    }
    cut.push(line);
    // The paragraph's text joins the pieces of a cut word without the hyphen and the others with a space.
    const text = cut.reduce((all, piece, index) => all + (index > 0 && !cut[index - 1].endsWith('-') ? ' ' : '') + piece.replace(/-$/, ''), '');
    const paragraph = paragraphOf(cut.map((piece, index) => lineOf(piece, LEFT + 300, 100 + index * 14)));
    paragraph.runs = [{ text, bold: false, italic: false, monospace: false }];
    paragraph.text = text;
    const indent = wrappingIndent(paragraph, SIZE, metrics, baseOf, AREA - 300) as number;
    expect(Math.abs(wrapped(font, text, AREA - indent).length - cut.length)).toBeLessThanOrEqual(1);
  });

  it('leaves the choice to the caller for text in a character the faces have no glyph for', () => {
    const paragraph = justified(['Привет мир это строка', 'и вторая строка текста'], 200);
    expect(wrappingIndent(paragraph, SIZE, metrics, baseOf, 0)).toBeUndefined();
  });

  it('sets a run at its width percent: narrower glyphs leave more room to the right of the same lines', async () => {
    const font = await timesRoman();
    const lines = wrapped(font, TEXT, 300);
    const natural = justified(lines, 300);
    const narrow = justified(lines, 300);
    narrow.runs = narrow.runs.map((run) => ({ ...run, widthPercent: 80 }));
    const at = (paragraph: Paragraph): number => wrappingIndent(paragraph, SIZE, metrics, baseOf, AREA - 300) as number;
    expect(at(narrow)).toBeGreaterThan(at(natural));
  });
});

describe('the paragraphs a flow sets to wrap where the page did', () => {
  const SETUP: PageSetup = { margins: { top: 72, right: 72, bottom: 0, left: 72 }, pageWidth: 612, pageTops: new Map([[1, 72]]), wrap: { metrics, bodySize: SIZE } };

  it('gives a justified paragraph an indent at which its lines wrap where the page broke them, past the margin where the text needs it', async () => {
    const font = await timesRoman();
    const lines = wrapped(font, TEXT, AREA);
    const paragraph = justified(lines, AREA);
    const format = new PageFlow(SETUP).paragraph(paragraph, 1);
    expect(format?.align).toBe('justify');
    expect(wrapped(font, TEXT, AREA - (format?.rightPt ?? 0))).toEqual(lines);
  });

  it('keeps the slack of a paragraph the faces cannot measure', () => {
    const format = new PageFlow(SETUP).paragraph(justified(['Привет мир это строка', 'и вторая строка текста'], AREA), 1);
    expect(format?.rightPt).toBe(0);
  });

  it('narrows the cells of a table wider than the text area as the writer does', () => {
    const flow = new PageFlow(SETUP);
    expect(flow.tableScale(400)).toBe(1);
    expect(flow.tableScale(936)).toBeCloseTo(0.5, 5);
  });
});

describe('the width of the glyphs of a face against the writer\'s', () => {
  const fonts: PdfContentFont[] = [
    { name: 'Condensed', bold: false, italic: false, monospace: false, serif: true },
    { name: 'Matched', bold: false, italic: false, monospace: false, serif: true },
  ];
  const itemOf = (font: number, text: string, width: number): PdfContentItem => ({ text, x: 0, baseline: 0, width, size: SIZE, font, rtl: false, angled: false, vertical: false });

  it('reads the percent from a low quantile of the runs, so that justified lines do not widen it, and leaves a face within three percent alone', async () => {
    const font = await timesRoman();
    const texts = Array.from({ length: 20 }, (_, index) => `running text of line number ${index} in a page`);
    const natural = (text: string): number => font.widthOfTextAtSize(text, SIZE);
    const items = [
      // Eleven runs at 0.8 of the writer's widths, nine justified wider.
      ...texts.slice(0, 11).map((text) => itemOf(0, text, natural(text) * 0.8)),
      ...texts.slice(11).map((text, index) => itemOf(0, text, natural(text) * (0.85 + index * 0.01))),
      ...texts.map((text) => itemOf(1, text, natural(text) * 1.01)),
    ];
    const percents = faceWidthPercents([{ items } as unknown as PdfPageContent], fonts, metrics);
    expect(percents.get('Condensed')).toBe(80);
    expect(percents.has('Matched')).toBe(false);
  });

  it('needs several runs of a face to read it', () => {
    const items = [itemOf(0, 'a short but long enough line', 10), itemOf(0, 'another long enough line', 9)];
    expect(faceWidthPercents([{ items } as unknown as PdfPageContent], fonts, metrics).size).toBe(0);
  });

  it('sets the percent on the runs of the paragraphs in that face only', () => {
    const condensed = justified(['a line of the page'], 100);
    const matched = justified(['another line'], 100);
    matched.fontKey = 'Matched';
    setFaceWidths([condensed, matched], new Map([['Times', 85]]));
    expect(condensed.runs[0].widthPercent).toBe(85);
    setFaceWidths([matched], new Map([['Condensed', 70]]));
    expect(matched.runs[0].widthPercent).toBeUndefined();
  });
});

describe('the DOCX writes the width percent of a run', () => {
  it('sets w:w after the colour and before the size, as the schema orders a run\'s properties', async () => {
    const model: DocumentModel = {
      ...blankDocument([{ columns: 1, blocks: [{ type: 'paragraph', runs: [{ text: 'narrow', bold: false, italic: false, monospace: false, color: 'FF0000', widthPercent: 85 }, { text: 'plain', bold: false, italic: false, monospace: false }], rtl: false, align: 'left' }] }]),
    };
    const zip = await JSZip.loadAsync(await documentToDocx(model));
    const xml = await (zip.file('word/document.xml') as JSZip.JSZipObject).async('string');
    expect(xml).toContain('<w:color w:val="FF0000"/><w:w w:val="85"/>');
    expect(xml.match(/<w:w /g)).toHaveLength(1);
  });
});
