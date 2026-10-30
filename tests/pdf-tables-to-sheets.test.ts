import fs from 'node:fs';
import path from 'node:path';
import JSZip from 'jszip';
import { PDFDocument } from 'pdf-lib';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { convertFile } from '../src/lib/conversions';
import { dispatchConversion } from '../src/lib/conversions/dispatch';
import * as ocr from '../src/lib/conversions/ocr';
import { shutdownOcrWorkerPool } from '../src/lib/conversions/ocr';
import { extractAllSheetsForOffice, parseAllXlsxWorksheets, type OfficeWorksheet } from '../src/lib/conversions/office';
import { WORKBOOK_MAX_SHEETS } from '../src/lib/conversions/office/sheet-bounds';
import { layoutPdf } from '../src/lib/conversions/pdf-layout';
import { sheetsOfPdf } from '../src/lib/conversions/pdf-sheets';
import { readPdfDocument } from '../src/lib/conversions/pdf-text-document';
import type { PdfContentFont, PdfContentItem, PdfContentRule, PdfPageContent } from '../src/lib/conversions/pdf-text-types';
import { writeXlsxWorkbook, type WorkbookSheet } from '../src/lib/conversions/xlsx-writer';
import { SheetLimitError, UnsupportedTargetError } from '../src/lib/types';
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

const budgetsCreated = vi.hoisted(() => ({ count: 0 }));

vi.mock('../src/lib/conversions/pdf-layout/limits', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/lib/conversions/pdf-layout/limits')>();
  return {
    ...original,
    LayoutBudget: class extends original.LayoutBudget {
      constructor(pageNumber: number) {
        super(pageNumber);
        budgetsCreated.count++;
      }
    },
  };
});

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

describe('the text sheets of a PDF with vertical writing', () => {
  it('keeps both sentences of a page of vertical Japanese', async () => {
    const truth = fs.readFileSync(path.join(__dirname, 'fixtures', 'pdf-text', 'vertical.truth.txt'), 'utf8').split('\n').filter((line) => line.trim() !== '');
    const sheets = await sheetsOf(fs.readFileSync(path.join(__dirname, 'fixtures', 'pdf-text', 'vertical.pdf')));
    expect(sheets.map((sheet) => sheet.name)).toEqual(['Page 1']);
    expect(sheets[0].rows.map((row) => row[0])).toEqual(truth);
  });
});

describe('the layout pass of a PDF converted to a workbook', () => {
  it('runs once for each page, as for a document, whether the pages hold a table or not', async () => {
    for (const [name, pages] of [['doc-04.pdf', 2], ['doc-03.pdf', 1]] as const) {
      budgetsCreated.count = 0;
      await workbookOf(read(name));
      expect(budgetsCreated.count, name).toBe(pages);
    }
  });
});

describe('the text of pages beside the tables of a PDF', () => {
  it('is left out, with a warning that names the pages', async () => {
    const result = await convertFile(read('doc-02.pdf'), 'pdf', 'xlsx', {}, 'doc-02.pdf');
    expect((await parseAllXlsxWorksheets(result.buffer)).map((sheet) => sheet.name)).toEqual(['Page 1 Table 1']);
    expect(result.metadata?.warnings).toEqual(['Left out the text outside the tables of pages 1, 2: a workbook of a PDF that has tables holds the tables.']);
  });

  it('leaves no warning for a document of tables only', async () => {
    const pdf = (await convertFile(Buffer.from('| Name | Count |\n|---|---|\n| pens | 4 |\n| ink | 9 |\n'), 'md', 'pdf', {}, 'table.md')).buffer;
    const result = await convertFile(pdf, 'pdf', 'xlsx', {}, 'table.pdf');
    expect((await parseAllXlsxWorksheets(result.buffer)).map((sheet) => sheet.rows)).toEqual([[['Name', 'Count'], ['pens', '4'], ['ink', '9']]]);
    expect(result.metadata?.warnings).toBeUndefined();
  });
});

describe('the running header and footer of the pages of a PDF', () => {
  const tablePage = (number: number, band: string, baseline = 770): PdfPageContent =>
    page(number, [item('Item', 60, 120), item('Qty', 160, 120), item(String(number), 60, 150), item('4', 160, 150), item(band, 280, baseline)], twoColumnRules(100, 2));

  async function withFooter(base: PDFDocument): Promise<Buffer> {
    base.getPages().forEach((sheet, index) => sheet.drawText(`Page ${index + 1}`, { x: 280, y: 30, size: 10 }));
    return Buffer.from(await base.save());
  }

  async function pdfWithFooter(text: (number: number) => string): Promise<Buffer> {
    const document = await PDFDocument.create();
    for (const number of [1, 2, 3]) document.addPage([600, 800]).drawText(text(number), { x: 60, y: 700, size: 12 });
    return withFooter(document);
  }

  it('give a document of tables only no warning, the footer neither counted as left-out text nor written as a row', async () => {
    const rows = Array.from({ length: 90 }, (_, i) => `| item ${i + 1} | ${i * 3 + 1} |`);
    const table = (await convertFile(Buffer.from(`| Name | Count |\n|---|---|\n${rows.join('\n')}\n`), 'md', 'pdf', {}, 'inventory.md')).buffer;
    const document = await PDFDocument.load(table);
    expect(document.getPageCount()).toBeGreaterThan(1);
    const result = await convertFile(await withFooter(document), 'pdf', 'xlsx', {}, 'footer.pdf');
    const sheets = await parseAllXlsxWorksheets(result.buffer);
    expect(sheets.map((sheet) => sheet.name)).toEqual(['Page 1 Table 1']);
    expect(sheets[0].rows).toHaveLength(91);
    expect(result.metadata?.warnings).toBeUndefined();
  });

  it('are out of the text sheets of a PDF with no table', async () => {
    const pdf = await pdfWithFooter((number) => `Chapter ${number} text`);
    const sheets = await parseAllXlsxWorksheets((await convertFile(pdf, 'pdf', 'xlsx', {}, 'footer.pdf')).buffer);
    expect(sheets.map((sheet) => [sheet.name, sheet.rows])).toEqual([
      ['Page 1', [['Chapter 1 text']]],
      ['Page 2', [['Chapter 2 text']]],
      ['Page 3', [['Chapter 3 text']]],
    ]);
  });

  it('leave no warning for a document of tables with only the page number as a footer', () => {
    const { tables, pageText } = layoutPdf([1, 2, 3].map((number) => tablePage(number, `Page ${number}`)), FONTS);
    expect(sheetsOfPdf({ layout: { tables, pageText }, recognized: new Map() }).leftOut).toEqual([]);
  });

  it('warn for every page whose per-page header beside a table is not in the workbook', () => {
    const { tables, pageText } = layoutPdf([1, 2, 3].map((number) => tablePage(number, `Invoice No. ${1000 + number}`, 770)), FONTS);
    const { sheets, leftOut } = sheetsOfPdf({ layout: { tables, pageText }, recognized: new Map() });
    expect(sheets.map((sheet) => sheet.name)).toEqual(['Page 1 Table 1']);
    expect(leftOut).toEqual([1, 2, 3]);
  });

  describe('keep every line that is not the number of the page it is on', () => {
    const textPage = (number: number, furniture: string): PdfPageContent => page(number, [item(`Body of page ${number}`, 60, 300), item(furniture, 280, 770)]);
    const rowsOf = (pages: PdfPageContent[]) => sheetsOfPages(pages).map((sheet) => sheet.rows.map((row) => row[0]));

    it.each(['© 2026', '2024', '12%', '$5', '第3章 概要', '価格 1000円'])('a recurring %s footer stays a row on every page', (footer) => {
      expect(rowsOf([1, 2, 3].map((number) => textPage(number, footer)))).toEqual([1, 2, 3].map((number) => [`Body of page ${number}`, footer]));
    });

    it.each([
      ['Page N', (n: number) => `Page ${n}`],
      ['N', (n: number) => String(n)],
      ['PAGE N', (n: number) => `PAGE ${n}`],
      ['N of 9', (n: number) => `${n} of 9`],
      ['N / 9', (n: number) => `${n} / 9`],
      ['Page N of 9', (n: number) => `Page ${n} of 9`],
    ])('the footer %s is dropped from every page', (_name, footer) => {
      expect(rowsOf([1, 2, 3].map((number) => textPage(number, footer(number))))).toEqual([['Body of page 1'], ['Body of page 2'], ['Body of page 3']]);
    });

    it('keeps Page 5 printed on page 3', () => {
      const rows = rowsOf([1, 2, 3].map((number) => textPage(number, `Page ${number + 2}`)));
      expect(rows.map((page) => page[1])).toEqual(['Page 3', 'Page 4', 'Page 5']);
    });
  });

  it('keep the first and last line of a one-page letter as rows', async () => {
    const document = await PDFDocument.create();
    const letter = document.addPage([600, 800]);
    letter.drawText('Dear Customer, your order ships Monday', { x: 60, y: 760, size: 12 });
    for (let i = 0; i < 6; i++) letter.drawText(`Body line ${i + 1} of the letter`, { x: 60, y: 600 - i * 20, size: 12 });
    letter.drawText('Contact: support at example dot com', { x: 60, y: 770 - 740, size: 12 });
    const sheets = await parseAllXlsxWorksheets((await convertFile(Buffer.from(await document.save()), 'pdf', 'xlsx', {}, 'letter.pdf')).buffer);
    const rows = sheets[0].rows.map((row) => row[0]);
    expect(rows[0]).toBe('Dear Customer, your order ships Monday');
    expect(rows).toContain('Contact: support at example dot com');
  });

  it('keep the value that differs on each page of a header, in the sheet of its page', async () => {
    const document = await PDFDocument.create();
    for (const number of [1001, 1002, 1003]) {
      const sheet = document.addPage([600, 800]);
      sheet.drawText(`Invoice No. ${number}`, { x: 60, y: 760, size: 12 });
      sheet.drawText('Amount due on receipt', { x: 60, y: 600, size: 12 });
    }
    const sheets = await parseAllXlsxWorksheets((await convertFile(Buffer.from(await document.save()), 'pdf', 'xlsx', {}, 'invoices.pdf')).buffer);
    expect(sheets.map((sheet) => sheet.rows.map((row) => row[0]))).toEqual([
      ['Invoice No. 1001', 'Amount due on receipt'],
      ['Invoice No. 1002', 'Amount due on receipt'],
      ['Invoice No. 1003', 'Amount due on receipt'],
    ]);
  });

  it('convert a PDF whose only text is one line at the top of each page', async () => {
    const document = await PDFDocument.create();
    for (const number of [1, 2]) document.addPage([600, 800]).drawText(`Annual report ${number}`, { x: 60, y: 770, size: 12 });
    const sheets = await parseAllXlsxWorksheets((await convertFile(Buffer.from(await document.save()), 'pdf', 'xlsx', {}, 'header-only.pdf')).buffer);
    expect(sheets.map((sheet) => sheet.rows)).toEqual([[['Annual report 1']], [['Annual report 2']]]);
  });
});

describe('a PDF with a table and a scanned page, converted with OCR on', () => {
  const OCR_TEXT = 'Scanned heading\nScanned body line';

  async function tableAndScan(): Promise<Buffer> {
    const scan = (await convertFile(fs.readFileSync(path.join(CORPUS, 'scan.png')), 'png', 'pdf', {}, 'scan.png')).buffer;
    const merged = await PDFDocument.create();
    for (const bytes of [read('merged-table.pdf'), scan]) {
      const [copied] = await merged.copyPages(await PDFDocument.load(bytes), [0]);
      merged.addPage(copied);
    }
    return Buffer.from(await merged.save());
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await shutdownOcrWorkerPool();
  });

  it('keeps the table of the page with a text layer and writes the recognized text of the scan as a page sheet', async () => {
    const recognize = vi.spyOn(ocr, 'recognizeRenderedPdfPages').mockResolvedValue(new Map([[2, { text: OCR_TEXT, confidence: null, wordCount: 5, lines: [] }]]));
    const pdf = await tableAndScan();
    const sheets = await parseAllXlsxWorksheets((await convertFile(pdf, 'pdf', 'xlsx', { ocrEnabled: true }, 'mixed.pdf')).buffer);
    expect(recognize).toHaveBeenCalledOnce();
    expect([...recognize.mock.calls[0][1]!]).toEqual([2]);
    expect(sheets.map((sheet) => sheet.name)).toEqual(['Page 1 Table 1', 'Page 2']);
    expect(sheets[0].rows[0]).toEqual(['Region', '', 'Total']);
    expect(sheets[1].rows).toEqual([['Scanned heading'], ['Scanned body line']]);
  }, LONG_TIMEOUT_MS);

  it.each(['force', 'redo'] as const)('keeps the table of a page OCR read as empty text, with ocrMode %s', async (ocrMode) => {
    vi.spyOn(ocr, 'recognizeRenderedPdfPages').mockResolvedValue(
      new Map([
        [1, { text: '', confidence: null, wordCount: 0, lines: [] }],
        [2, { text: OCR_TEXT, confidence: null, wordCount: 5, lines: [] }],
      ])
    );
    const result = await convertFile(await tableAndScan(), 'pdf', 'xlsx', { ocrEnabled: true, ocrMode }, 'mixed.pdf');
    const sheets = await parseAllXlsxWorksheets(result.buffer);
    expect(sheets.map((sheet) => sheet.name)).toEqual(['Page 1 Table 1', 'Page 2']);
    expect(sheets[0].rows[0]).toEqual(['Region', '', 'Total']);
    expect(sheets[1].rows).toEqual([['Scanned heading'], ['Scanned body line']]);
    expect(result.metadata?.warnings).toEqual(['Left out the text outside the tables of page 1: a workbook of a PDF that has tables holds the tables.']);
  }, LONG_TIMEOUT_MS);

  it('reads every page by OCR with ocrMode force, so a page that OCR read has no table', async () => {
    vi.spyOn(ocr, 'recognizeRenderedPdfPages').mockResolvedValue(
      new Map([
        [1, { text: 'Region Total', confidence: null, wordCount: 2, lines: [] }],
        [2, { text: OCR_TEXT, confidence: null, wordCount: 5, lines: [] }],
      ])
    );
    const sheets = await parseAllXlsxWorksheets((await convertFile(await tableAndScan(), 'pdf', 'xlsx', { ocrEnabled: true, ocrMode: 'force' }, 'mixed.pdf')).buffer);
    expect(sheets.map((sheet) => sheet.name)).toEqual(['Page 1', 'Page 2']);
  }, LONG_TIMEOUT_MS);

  oracleTest('reads the scan with the recognition of a document conversion', ['tesseract'], async () => {
    const truth = fs.readFileSync(path.join(CORPUS, 'scan.gt.txt'), 'utf8').split('\n').filter((line) => line.trim() !== '');
    const sheets = await parseAllXlsxWorksheets((await convertFile(await tableAndScan(), 'pdf', 'xlsx', { ocrEnabled: true }, 'mixed.pdf')).buffer);
    expect(sheets.map((sheet) => sheet.name)).toEqual(['Page 1 Table 1', 'Page 2']);
    expect(sheets[1].rows.map((row) => row[0])).toEqual(truth);
  }, LONG_TIMEOUT_MS);
});

describe('a PDF read for rows of delimited text', () => {
  it('is refused, never read as the text its bytes spell', async () => {
    const failure = await extractAllSheetsForOffice(read('doc-03.pdf'), 'pdf').catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(UnsupportedTargetError);
    expect((failure as Error).message).toBe('A PDF is read for a workbook by its tables and pages (readPdfSheets), never as rows of delimited text.');
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

const sheetsOfPages = (pages: PdfPageContent[]): WorkbookSheet[] => sheetsOfPdf({ layout: layoutPdf(pages, FONTS), recognized: new Map() }).sheets;

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
    const { tables } = layoutPdf([first, second], FONTS);
    expect(tables).toHaveLength(1);
    expect(tables[0].pageNumber).toBe(1);
    expect(tables[0].rows.map((row) => row.map((cell) => cell.paragraphs.map((paragraph) => paragraph.text).join('')))).toEqual([
      ['Item', 'Qty'],
      ['pens', '4'],
      ['ink', '9'],
      ['pads', '12'],
    ]);
  });

  it('keeps two tables of one page apart and numbers them in the page', () => {
    const items = [item('a', 60, 120), item('1', 160, 120), item('b', 60, 330), item('2', 160, 330)];
    const rules = [...twoColumnRules(100, 1), ...twoColumnRules(300, 1)];
    expect(sheetsOfPages([page(3, items, rules)]).map((sheet) => [sheet.name, sheet.rows])).toEqual([
      ['Page 3 Table 1', [['a', '1']]],
      ['Page 3 Table 2', [['b', '2']]],
    ]);
  });

  it('joins the lines of a wrapped paragraph of a cell with a space and its paragraphs with a line break', () => {
    const rules = [
      ...[100, 200].map((y): PdfContentRule => ({ x0: 50, y0: y, x1: 350, y1: y, thickness: 0.5 })),
      ...[50, 200, 350].map((x): PdfContentRule => ({ x0: x, y0: 100, x1: x, y1: 200, thickness: 0.5 })),
    ];
    const items = [
      item('Wrapped over', 60, 120),
      item('two lines', 60, 134),
      item('First paragraph', 210, 120),
      item('Second paragraph', 210, 170),
    ];
    const [sheet] = sheetsOfPages([page(1, items, rules)]);
    expect(sheet.rows).toEqual([['Wrapped over two lines', 'First paragraph\nSecond paragraph']]);
  });

  it('gives a text sheet a row for each line of a page, the pieces that sit apart on a line as one', () => {
    const sheets = sheetsOfPages([page(1, [item('Total', 50, 100), item('42', 300, 100), item('A closing remark', 50, 130)])]);
    expect(sheets.map((sheet) => [sheet.name, sheet.rows])).toEqual([['Page 1', [['Total 42'], ['A closing remark']]]]);
  });

  it('gives the text of a page of angled text only', () => {
    const sheets = sheetsOfPages([page(1, [{ ...item('Rotated note', 100, 300), angled: true }])]);
    expect(sheets.map((sheet) => [sheet.name, sheet.rows])).toEqual([['Page 1', [['Rotated note']]]]);
  });

  it('writes no sheet for a page without text, in the layout and in the text OCR read', () => {
    expect(sheetsOfPages([page(1, [item('Only page text', 50, 100)]), page(2, []), page(3, [item('Third', 50, 100)])]).map((sheet) => sheet.name)).toEqual(['Page 1', 'Page 3']);
    const { sheets } = sheetsOfPdf({ layout: null, recognized: new Map([[1, 'Read by OCR\n\n'], [2, '  \n']]) });
    expect(sheets.map((sheet) => [sheet.name, sheet.rows])).toEqual([['Page 1', [['Read by OCR']]]]);
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

  it('refuses a workbook of no sheet, which a package does not allow', async () => {
    await expect(writeXlsxWorkbook([], 'detect')).rejects.toThrow(/at least one sheet/);
  });

  it('refuses more sheets than a workbook holds with a 413, never cutting them', async () => {
    const sheetsOf = (count: number): WorkbookSheet[] => Array.from({ length: count }, (_, i) => ({ name: `S${i + 1}`, rows: [['x']] }));
    const failure = await writeXlsxWorkbook(sheetsOf(WORKBOOK_MAX_SHEETS + 1), 'detect').catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(SheetLimitError);
    expect((failure as SheetLimitError).status).toBe(413);
    const workbook = await JSZip.loadAsync(await writeXlsxWorkbook(sheetsOf(WORKBOOK_MAX_SHEETS), 'detect', 'STORE'));
    expect(Object.keys(workbook.files).filter((entry) => /^xl\/worksheets\/sheet\d+\.xml$/.test(entry))).toHaveLength(WORKBOOK_MAX_SHEETS);
  }, LONG_TIMEOUT_MS);

  it.each([
    ['an empty name', ''],
    ['a name of 32 characters', 'a'.repeat(32)],
    ...Array.from('[]:*?/\\', (character): [string, string] => [`a name with ${character}`, `Q${character}1`]),
  ])('refuses %s', async (_what, name) => {
    await expect(writeXlsxWorkbook([{ name, rows: [['x']] }], 'detect')).rejects.toThrow(/sheet name/);
  });

  it('refuses a name another sheet has, without regard to case, and takes one of 31 characters', async () => {
    await expect(writeXlsxWorkbook([{ name: 'Page 1', rows: [['x']] }, { name: 'PAGE 1', rows: [['y']] }], 'detect')).rejects.toThrow(/once/);
    const sheets = await parseAllXlsxWorksheets(await writeXlsxWorkbook([{ name: 'a'.repeat(31), rows: [['x']] }], 'detect'));
    expect(sheets.map((sheet) => sheet.name)).toEqual(['a'.repeat(31)]);
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
