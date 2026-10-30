import fs from 'node:fs';
import path from 'node:path';
import JSZip from 'jszip';
import { afterAll, describe, expect, it } from 'vitest';
import { convertFile } from '../src/lib/conversions';
import { dispatchConversion } from '../src/lib/conversions/dispatch';
import { shutdownOcrWorkerPool } from '../src/lib/conversions/ocr';
import { parseAllXlsxWorksheets, type OfficeWorksheet } from '../src/lib/conversions/office';
import { WORKBOOK_MAX_SHEETS } from '../src/lib/conversions/office/sheet-bounds';
import { detectPdfTables, pdfTextRows } from '../src/lib/conversions/pdf-layout';
import { sheetsOfPdfContent } from '../src/lib/conversions/pdf-sheets';
import { readPdfDocument } from '../src/lib/conversions/pdf-text-document';
import type { PdfContentFont, PdfContentItem, PdfContentRule, PdfPageContent } from '../src/lib/conversions/pdf-text-types';
import { writeXlsxWorkbook } from '../src/lib/conversions/xlsx-writer';
import { SheetLimitError } from '../src/lib/types';
import { readXlsCells } from './helpers/biff8-records';
import { oracleTest } from './helpers/oracle-test';
import { sofficeConvert } from './helpers/soffice-office';

/**
 * PDF to a workbook: one sheet for each table of the pages, named `Page N Table M`, its cells typed as those of CSV are. The PDFs are
 * the structure corpus (LibreOffice 24.2 output with the truth of what each was written from in `*.truth.json`), a long table and a scan
 * written by this project's own PDF and image writers, and pages written out by hand for the layout rules.
 */

const STRUCTURE = path.join(__dirname, 'fixtures', 'pdf-structure');
const CORPUS = path.join(__dirname, '..', 'bench', 'corpus');
const LONG_TIMEOUT_MS = 180_000;
const CFB_SIGNATURE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);

const read = (name: string): Buffer => fs.readFileSync(path.join(STRUCTURE, name));

async function workbookOf(pdf: Buffer): Promise<Buffer> {
  return (await convertFile(pdf, 'pdf', 'xlsx', {}, 'tables.pdf')).buffer;
}

async function sheetsOf(pdf: Buffer): Promise<OfficeWorksheet[]> {
  return parseAllXlsxWorksheets(await workbookOf(pdf));
}

/** What each cell of the nth sheet is, by its XML (ECMA-376 18.3.1.4): `s` for a shared string, `n` for a number, row by row. */
async function cellKinds(xlsx: Buffer, sheetNumber = 1): Promise<string[][]> {
  const xml = await (await JSZip.loadAsync(xlsx)).file(`xl/worksheets/sheet${sheetNumber}.xml`)!.async('text');
  return [...xml.matchAll(/<row [^>]*>(.*?)<\/row>/g)].map((row) =>
    [...row[1].matchAll(/<c r="[A-Z]+\d+"([^>]*)>/g)].map((cell) => (/\bt="s"/.test(cell[1]) ? 's' : /\bt="/.test(cell[1]) ? 'other' : 'n'))
  );
}

describe('a ruled table of a PDF page converted to xlsx', () => {
  it('is one sheet whose cells are the table, numbers as numbers', async () => {
    const xlsx = await workbookOf(read('doc-03.pdf'));
    const sheets = await parseAllXlsxWorksheets(xlsx);
    expect(sheets.map((sheet) => sheet.name)).toEqual(['Page 1 Table 1']);
    expect(sheets[0].rows).toEqual([
      ['Status', 'Region'],
      ['gamma 6', '6283'],
      ['beta 9', '5338'],
      ['delta 7', '4053'],
      ['alpha 7', '5529'],
    ]);
    expect(await cellKinds(xlsx)).toEqual([
      ['s', 's'],
      ['s', 'n'],
      ['s', 'n'],
      ['s', 'n'],
      ['s', 'n'],
    ]);
  });

  it('merges the cells that span columns or rows and keeps the value in the first cell', async () => {
    const [sheet] = await sheetsOf(read('merged-table.pdf'));
    expect(sheet.rows).toEqual([
      ['Region', '', 'Total'],
      ['North', 'Q1', '10'],
      ['', 'Q2', '20'],
      ['South', 'Q1', '30'],
    ]);
    expect(sheet.mergedRanges).toEqual([
      { startRow: 0, endRow: 0, startCol: 0, endCol: 1 },
      { startRow: 1, endRow: 2, startCol: 0, endCol: 0 },
    ]);
  });
});

describe('a table of aligned text without ruling lines converted to xlsx', () => {
  it('is one sheet whose numbers are numbers', async () => {
    const xlsx = await workbookOf(read('doc-01.pdf'));
    const sheets = await parseAllXlsxWorksheets(xlsx);
    expect(sheets.map((sheet) => sheet.name)).toEqual(['Page 1 Table 1']);
    expect(sheets[0].rows).toEqual([
      ['Grade', 'Status', 'Owner', 'Period'],
      ['alpha 2', '884', '8982', '165'],
      ['minor 8', '7193', '6341', '1840'],
      ['beta 6', '8942', '8412', '2923'],
    ]);
    expect(await cellKinds(xlsx)).toEqual([
      ['s', 's', 's', 's'],
      ['s', 'n', 'n', 'n'],
      ['s', 'n', 'n', 'n'],
      ['s', 'n', 'n', 'n'],
    ]);
  });
});

describe('a table that runs over several pages', () => {
  const PRICE_ROWS = 90;

  async function longTablePdf(): Promise<Buffer> {
    const rows = Array.from({ length: PRICE_ROWS }, (_, i) => `| item ${i + 1} | ${i * 3 + 1} | ${(i * 1.25).toFixed(2)} |`);
    const markdown = `# Inventory\n\n| Name | Count | Price |\n|---|---|---|\n${rows.join('\n')}\n`;
    return (await convertFile(Buffer.from(markdown), 'md', 'pdf', {}, 'inventory.md')).buffer;
  }

  it('stays one sheet with every row once, in order, the header written once', async () => {
    const pdf = await longTablePdf();
    expect((await readPdfDocument(pdf)).extracted.pages.length).toBeGreaterThan(1);
    const xlsx = await workbookOf(pdf);
    const sheets = await parseAllXlsxWorksheets(xlsx);
    expect(sheets.map((sheet) => sheet.name)).toEqual(['Page 1 Table 1']);
    const [header, ...body] = sheets[0].rows;
    expect(header).toEqual(['Name', 'Count', 'Price']);
    expect(body).toHaveLength(PRICE_ROWS);
    expect(body.map((row) => row[0])).toEqual(Array.from({ length: PRICE_ROWS }, (_, i) => `item ${i + 1}`));
    expect(body[89]).toEqual(['item 90', '268', '111.25']);
    expect((await cellKinds(xlsx)).slice(1).every((row) => row.join('') === 'snn')).toBe(true);
  });
});

describe('a PDF with no table', () => {
  it('is a sheet for each page with a line of text for a row', async () => {
    const sheets = await sheetsOf(fs.readFileSync(path.join(__dirname, 'fixtures', 'sample.pdf')));
    expect(sheets.map((sheet) => sheet.name)).toEqual(['Page 1']);
    expect(sheets[0].rows).toEqual([['EasyConvert Golden PDF Document'], ['Deterministic regression oracle fixture text stream.']]);
  });

  it('has a sheet Page N for every page of a longer document', async () => {
    const sheets = await sheetsOf(read('doc-04.pdf'));
    expect(sheets.map((sheet) => sheet.name)).toEqual(['Page 1', 'Page 2']);
    expect(sheets[0].rows[0]).toEqual(['Amber station careful']);
    expect(sheets.every((sheet) => sheet.rows.every((row) => row.length === 1 && row[0] !== ''))).toBe(true);
  });

  describe('scanned, with no text layer', () => {
    afterAll(async () => {
      await shutdownOcrWorkerPool();
    });

    oracleTest('is read by the recognition that a document conversion uses, a line for a row', ['tesseract'], async () => {
      const scan = (await convertFile(fs.readFileSync(path.join(CORPUS, 'scan.png')), 'png', 'pdf', {}, 'scan.png')).buffer;
      const truth = fs.readFileSync(path.join(CORPUS, 'scan.gt.txt'), 'utf8').split('\n').filter((line) => line.trim() !== '');
      const sheets = await sheetsOf(scan);
      expect(sheets.map((sheet) => sheet.name)).toEqual(['Page 1']);
      expect(sheets[0].rows.map((row) => row[0])).toEqual(truth);
    }, LONG_TIMEOUT_MS);
  });
});

const REGULAR: PdfContentFont = { name: 'Body', bold: false, italic: false, monospace: false, serif: false };
const FONTS = [REGULAR];

function item(text: string, x: number, baseline: number): PdfContentItem {
  return { text, x, baseline, width: text.length * 6, size: 12, font: 0, rtl: false, angled: false, vertical: false };
}

function page(pageNumber: number, items: PdfContentItem[], rules: PdfContentRule[] = []): PdfPageContent {
  return { pageNumber, width: 600, height: 800, items, rules, images: [], unmappedGlyphs: 0, operatorsSkipped: false, rulesTruncated: false };
}

/** The ruling lines of a table of two columns and the given number of rows, from the top y. */
function twoColumnRules(top: number, rows: number): PdfContentRule[] {
  const bottom = top + rows * 30;
  const horizontal = Array.from({ length: rows + 1 }, (_, i): PdfContentRule => ({ x0: 50, y0: top + i * 30, x1: 250, y1: top + i * 30, thickness: 0.5 }));
  const vertical = [50, 150, 250].map((x): PdfContentRule => ({ x0: x, y0: top, x1: x, y1: bottom, thickness: 0.5 }));
  return [...horizontal, ...vertical];
}

describe('the tables of pages written out by hand', () => {
  it('joins a table that goes on after a running header on the next page, without the header', () => {
    const first = page(
      1,
      [item('Quarterly report 1', 50, 40), item('Item', 60, 120), item('Qty', 160, 120), item('pens', 60, 150), item('4', 160, 150)],
      twoColumnRules(100, 2)
    );
    const second = page(
      2,
      [item('Quarterly report 2', 50, 40), item('ink', 60, 120), item('9', 160, 120), item('pads', 60, 150), item('12', 160, 150)],
      twoColumnRules(100, 2)
    );
    const tables = detectPdfTables([first, second], FONTS);
    expect(tables).toHaveLength(1);
    expect(tables[0].pageNumber).toBe(1);
    expect(tables[0].rows.map((row) => row.map((cell) => cell.paragraphs.map((paragraph) => paragraph.text).join('')))).toEqual([
      ['Item', 'Qty'],
      ['pens', '4'],
      ['ink', '9'],
      ['pads', '12'],
    ]);
  });

  it('keeps two tables of one page apart and numbers them in the page', async () => {
    const items = [item('a', 60, 120), item('1', 160, 120), item('b', 60, 330), item('2', 160, 330)];
    const rules = [...twoColumnRules(100, 1), ...twoColumnRules(300, 1)];
    const content = { kind: 'layout' as const, extracted: { model: undefined as never, text: '', unmappedPages: [], pages: [page(3, items, rules)], fonts: FONTS } };
    expect(sheetsOfPdfContent(content).map((sheet) => [sheet.name, sheet.rows])).toEqual([
      ['Page 3 Table 1', [['a', '1']]],
      ['Page 3 Table 2', [['b', '2']]],
    ]);
  });

  it('reads the pieces of a line that sit apart as the columns of its row', () => {
    const rows = pdfTextRows(page(1, [item('Total', 50, 100), item('42', 300, 100), item('A closing remark', 50, 130)]), FONTS);
    expect(rows).toEqual([['Total', '42'], ['A closing remark']]);
  });
});

describe('the sheets of one workbook', () => {
  it('shares one string table, escapes the tab names and writes the merged ranges after the cells', async () => {
    const xlsx = await writeXlsxWorkbook(
      [
        { name: 'R&D "A"', rows: [['x', 'y'], ['x', 5]], merges: [{ row: 0, column: 0, rowSpan: 2, columnSpan: 1 }, { row: 1, column: 0, rowSpan: 1, columnSpan: 1 }] },
        { name: 'Second', rows: [['x']] },
      ],
      'detect'
    );
    const zip = await JSZip.loadAsync(xlsx);
    const workbook = await zip.file('xl/workbook.xml')!.async('text');
    expect(workbook).toContain('<sheet name="R&amp;D &quot;A&quot;" sheetId="1" r:id="rId1"/><sheet name="Second" sheetId="2" r:id="rId2"/>');
    const sheet1 = await zip.file('xl/worksheets/sheet1.xml')!.async('text');
    expect(sheet1).toMatch(/<\/sheetData><mergeCells count="1"><mergeCell ref="A1:A2"\/><\/mergeCells><\/worksheet>$/);
    expect(await zip.file('xl/worksheets/sheet2.xml')!.async('text')).not.toContain('mergeCell');
    const strings = await zip.file('xl/sharedStrings.xml')!.async('text');
    expect(strings).toContain('count="4" uniqueCount="2"');
    const read = await parseAllXlsxWorksheets(xlsx);
    expect(read.map((sheet) => sheet.name)).toEqual(['R&D "A"', 'Second']);
    expect(read[0].mergedRanges).toEqual([{ startRow: 0, endRow: 1, startCol: 0, endCol: 0 }]);
  });

  it('refuses a merged range past the last row or column of a worksheet with a 413', async () => {
    const failure = await writeXlsxWorkbook([{ name: 'A', rows: [['x']], merges: [{ row: 0, column: 16_383, rowSpan: 1, columnSpan: 2 }] }], 'detect').catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(SheetLimitError);
    expect((failure as SheetLimitError).status).toBe(413);
  });

  it('refuses more sheets than a workbook holds, never cutting them', () => {
    const pages = Array.from({ length: WORKBOOK_MAX_SHEETS + 1 }, (_, i) => ({ pageNumber: i + 1, text: 'line' }));
    expect(() => sheetsOfPdfContent({ kind: 'text', pages: pages.slice(0, WORKBOOK_MAX_SHEETS) })).not.toThrow();
    const failure = (() => {
      try {
        return sheetsOfPdfContent({ kind: 'text', pages });
      } catch (err) {
        return err;
      }
    })();
    expect(failure).toBeInstanceOf(SheetLimitError);
    expect((failure as SheetLimitError).status).toBe(413);
  });
});

describe('a PDF converted to .xls', () => {
  oracleTest('is a BIFF8 workbook with a sheet for each table, read back by an office suite', ['soffice'], async () => {
    const converted = await dispatchConversion(read('merged-table.pdf'), 'pdf', 'xls', {}, 'merged-table.pdf');
    expect(converted.filename).toBe('merged-table.xls');
    expect(converted.buffer.subarray(0, CFB_SIGNATURE.length)).toEqual(CFB_SIGNATURE);
    const cells = readXlsCells(converted.buffer);
    expect(cells.get('0,0')).toMatchObject({ kind: 'string', value: 'Region' });
    expect(cells.get('1,2')).toMatchObject({ kind: 'number', value: 10 });
    expect(cells.get('3,2')).toMatchObject({ kind: 'number', value: 30 });
    const [sheet] = await parseAllXlsxWorksheets(sofficeConvert(converted.buffer, 'xls', 'xlsx', 'xlsx'));
    expect(sheet.name).toBe('Page 1 Table 1');
    expect(sheet.mergedRanges).toEqual([
      { startRow: 0, endRow: 0, startCol: 0, endCol: 1 },
      { startRow: 1, endRow: 2, startCol: 0, endCol: 0 },
    ]);
  }, LONG_TIMEOUT_MS);

  oracleTest('keeps a sheet for each page of a document with no table', ['soffice'], async () => {
    const converted = await dispatchConversion(read('doc-04.pdf'), 'pdf', 'xls', {}, 'doc-04.pdf');
    const sheets = await parseAllXlsxWorksheets(sofficeConvert(converted.buffer, 'xls', 'xlsx', 'xlsx'));
    expect(sheets.map((sheet) => sheet.name)).toEqual(['Page 1', 'Page 2']);
    expect(sheets[0].rows[0]).toEqual(['Amber station careful']);
  }, LONG_TIMEOUT_MS);
});
