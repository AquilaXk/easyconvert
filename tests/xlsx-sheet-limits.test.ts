import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { parseAllXlsxWorksheets } from '../src/lib/conversions/office';
import { ConversionFailedError, PayloadLimitError } from '../src/lib/types';

/**
 * A worksheet cannot hold more than 1048576 rows or 16384 columns (ECMA-376 and every spreadsheet application). A row number
 * or a cell reference past them is a damaged part, and it must not make the reader build billions of empty rows: a fuzzer
 * test case of the real-world corpus (`r="231999999999940"`) took the converter to its heap limit.
 */

const WORKBOOK =
  '<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Data" sheetId="1" r:id="rId1"/></sheets></workbook>';
const RELS = '<Relationships><Relationship Id="rId1" Type="worksheet" Target="worksheets/sheet1.xml"/></Relationships>';
const MAX_ROW = 1_048_576;
const MAX_COLUMNS = 16_384;
/** The most cells a workbook may materialise, empty padding cells and rows included (the reader of the data formats allows 20 million cells). */
const MAX_MATERIALISED_CELLS = 20_000_000;

async function workbookOf(sheetXml: string): Promise<Buffer> {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<Types/>');
  zip.file('xl/workbook.xml', WORKBOOK);
  zip.file('xl/_rels/workbook.xml.rels', RELS);
  zip.file('xl/sharedStrings.xml', '<sst><si><t>text</t></si></sst>');
  zip.file('xl/worksheets/sheet1.xml', sheetXml);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

const sheet = (body: string, cols = ''): string => `<worksheet>${cols}<sheetData>${body}</sheetData></worksheet>`;

describe('XLSX worksheet bounds', () => {
  it('reads the last row and the last column a worksheet can hold', async () => {
    const [parsed] = await parseAllXlsxWorksheets(await workbookOf(sheet(`<row r="${MAX_ROW}"><c r="XFD${MAX_ROW}" t="s"><v>0</v></c></row>`)));
    expect(parsed.rows).toHaveLength(MAX_ROW);
    expect(parsed.rows[MAX_ROW - 1]).toHaveLength(16_384);
    expect(parsed.rows[MAX_ROW - 1][16_383]).toBe('text');
  });

  it('refuses a row number past the last row, before it builds the rows in between', async () => {
    const failure = await parseAllXlsxWorksheets(await workbookOf(sheet(`<row r="${MAX_ROW + 1}"><c r="A${MAX_ROW + 1}"><v>1</v></c></row>`))).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ConversionFailedError);
    expect((failure as Error).message).toMatch(/row 1048577 is past the last row of a worksheet \(1048576\)/);
  });

  it('refuses a cell reference past the last column', async () => {
    const failure = await parseAllXlsxWorksheets(await workbookOf(sheet('<row r="1"><c r="XFE1"><v>1</v></c></row>'))).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ConversionFailedError);
    expect((failure as Error).message).toMatch(/column XFE is past the last column of a worksheet \(XFD\)/);
  });

  it('refuses a column width range past the last column', async () => {
    const cols = '<cols><col min="1" max="20000000" width="12" customWidth="1"/></cols>';
    const failure = await parseAllXlsxWorksheets(await workbookOf(sheet('<row r="1"><c r="A1"><v>1</v></c></row>', cols))).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ConversionFailedError);
    expect((failure as Error).message).toMatch(/column 20000000 is past the last column of a worksheet \(XFD\)/);
  });

  describe('padding of sparse sheets', () => {
    const sparseRows = (count: number): string => Array.from({ length: count }, (_, i) => `<row r="${i + 1}"><c r="XFD${i + 1}" t="s"><v>0</v></c></row>`).join('');

    it('refuses a sheet whose cells in range pad out to more than the budget of cells, before it builds them', async () => {
      // Every row holds one cell at XFD, so each pads 16383 empty cells before it: 1320 rows are 21.6 million cells from a 9 KB part.
      const rows = Math.floor(MAX_MATERIALISED_CELLS / MAX_COLUMNS) + 100;
      const xlsx = await workbookOf(sheet(sparseRows(rows)));
      expect(xlsx.length).toBeLessThan(20_000);
      const failure = await parseAllXlsxWorksheets(xlsx).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(PayloadLimitError);
      expect((failure as PayloadLimitError).status).toBe(413);
      expect((failure as Error).message).toMatch(/more than 20000000 cells/);
    });

    it('counts the sheets of one workbook together, so twenty sheets that end on the last row cannot add up past the budget of empty rows', async () => {
      const sheetXml = sheet(`<row r="${MAX_ROW}"><c r="A${MAX_ROW}"><v>1</v></c></row>`);
      const zip = new JSZip();
      zip.file('[Content_Types].xml', '<Types/>');
      const count = 20;
      zip.file('xl/workbook.xml', `<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${Array.from({ length: count }, (_, i) => `<sheet name="S${i + 1}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`);
      zip.file('xl/_rels/workbook.xml.rels', `<Relationships>${Array.from({ length: count }, (_, i) => `<Relationship Id="rId${i + 1}" Type="worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}</Relationships>`);
      for (let i = 1; i <= count; i++) zip.file(`xl/worksheets/sheet${i}.xml`, sheetXml);
      const failure = await parseAllXlsxWorksheets(await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })).catch((error: unknown) => error);
      // Each sheet is a million empty rows and the cell of the last row: 20.9 million rows and cells that the workbook would hold together.
      expect(failure).toBeInstanceOf(PayloadLimitError);
      expect((failure as PayloadLimitError).status).toBe(413);
      expect((failure as Error).message).toMatch(/more than 20000000 cells/);
    });

    it('still reads a wide sheet whose cells are all filled, to the last column', async () => {
      const rows = 10;
      const body = Array.from({ length: rows }, (_, r) => `<row r="${r + 1}">${Array.from({ length: MAX_COLUMNS }, (_, c) => `<c r="${columnName(c)}${r + 1}" t="s"><v>0</v></c>`).join('')}</row>`).join('');
      const [parsed] = await parseAllXlsxWorksheets(await workbookOf(sheet(body)));
      expect(parsed.rows).toHaveLength(rows);
      for (const row of parsed.rows) {
        expect(row).toHaveLength(MAX_COLUMNS);
        expect(row.every((value) => value === 'text')).toBe(true);
      }
    });

    it('still reads a sheet with a sparse cell far to the right on a few rows', async () => {
      const [parsed] = await parseAllXlsxWorksheets(await workbookOf(sheet(sparseRows(100))));
      expect(parsed.rows).toHaveLength(100);
      expect(parsed.rows[99]).toHaveLength(MAX_COLUMNS);
      expect(parsed.rows[99][MAX_COLUMNS - 1]).toBe('text');
      expect(parsed.rows[99].slice(0, MAX_COLUMNS - 1).every((value) => value === '')).toBe(true);
    });
  });
});

/** Column letters of a zero-based index by the bijective base-26 rule of the format (0 is A, 25 is Z, 26 is AA), written here and not taken from the reader. */
function columnName(index: number): string {
  let name = '';
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  return name;
}
