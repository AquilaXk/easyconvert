import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { parseAllXlsxWorksheets } from '../src/lib/conversions/office';
import { ConversionFailedError } from '../src/lib/types';

/**
 * A worksheet cannot hold more than 1048576 rows or 16384 columns (ECMA-376 and every spreadsheet application). A row number
 * or a cell reference past them is a damaged part, and it must not make the reader build billions of empty rows: a fuzzer
 * test case of the real-world corpus (`r="231999999999940"`) took the converter to its heap limit.
 */

const WORKBOOK =
  '<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Data" sheetId="1" r:id="rId1"/></sheets></workbook>';
const RELS = '<Relationships><Relationship Id="rId1" Type="worksheet" Target="worksheets/sheet1.xml"/></Relationships>';
const MAX_ROW = 1_048_576;

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
});
