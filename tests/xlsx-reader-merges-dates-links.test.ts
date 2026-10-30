import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { convertFile } from '../src/lib/conversions';
import { parseAllXlsxWorksheets } from '../src/lib/conversions/office';
import { oracleTest } from './helpers/oracle-test';
import { sofficeConvert } from './helpers/soffice-office';

/**
 * What the XLSX reader returns beyond the text of the cells: the ranges that are merged, the base of the date serials, the targets
 * of hyperlinks, and the text of a rich-text string without its phonetic guide. The merged ranges, the 1904 date system and the
 * hyperlinks come from workbooks LibreOffice wrote from flat OpenDocument text; the phonetic runs, which LibreOffice never writes,
 * and a second 1904 workbook are written by hand from ECMA-376 Part 1.
 */

const FODS_NAMESPACES = [
  'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"',
  'xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0"',
  'xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"',
  'xmlns:xlink="http://www.w3.org/1999/xlink"',
  'xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0"',
  'xmlns:number="urn:oasis:names:tc:opendocument:xmlns:datastyle:1.0"',
].join(' ');

const ISO_DATE_STYLES =
  '<office:automatic-styles><number:date-style style:name="N37"><number:year number:style="long"/><number:text>-</number:text>' +
  '<number:month number:style="long"/><number:text>-</number:text><number:day number:style="long"/></number:date-style>' +
  '<style:style style:name="ce1" style:family="table-cell" style:data-style-name="N37"/></office:automatic-styles>';

function flatSheet(rows: string, nullDate?: string): Buffer {
  const settings = nullDate ? `<table:calculation-settings><table:null-date table:date-value="${nullDate}"/></table:calculation-settings>` : '';
  return Buffer.from(
    `<?xml version="1.0" encoding="UTF-8"?><office:document ${FODS_NAMESPACES} office:version="1.2" office:mimetype="application/vnd.oasis.opendocument.spreadsheet">` +
      `${ISO_DATE_STYLES}<office:body><office:spreadsheet>${settings}<table:table table:name="Data">${rows}</table:table></office:spreadsheet></office:body></office:document>`,
    'utf-8'
  );
}

const textCell = (text: string): string => `<table:table-cell office:value-type="string"><text:p>${text}</text:p></table:table-cell>`;
const dateCell = (iso: string): string => `<table:table-cell table:style-name="ce1" office:value-type="date" office:date-value="${iso}"><text:p>${iso}</text:p></table:table-cell>`;

const SPREADSHEET_XMLNS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"';
const RELATIONSHIPS_XMLNS = 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';

/** A workbook package written by hand: one sheet, the given shared strings XML, sheet data and workbook properties. */
async function handWrittenWorkbook(parts: { workbookPr?: string; sharedStrings?: string; sheetData: string }): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(
    '[Content_Types].xml',
    '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
      '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
      '<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/></Types>'
  );
  zip.file(
    '_rels/.rels',
    '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'
  );
  zip.file(
    'xl/workbook.xml',
    `<?xml version="1.0" encoding="UTF-8"?><workbook ${SPREADSHEET_XMLNS} ${RELATIONSHIPS_XMLNS}>${parts.workbookPr ?? ''}<sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>`
  );
  zip.file(
    'xl/_rels/workbook.xml.rels',
    '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
      '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
      '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>'
  );
  zip.file(
    'xl/styles.xml',
    `<?xml version="1.0" encoding="UTF-8"?><styleSheet ${SPREADSHEET_XMLNS}><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="14" applyNumberFormat="1"/></cellXfs></styleSheet>`
  );
  zip.file('xl/sharedStrings.xml', `<?xml version="1.0" encoding="UTF-8"?><sst ${SPREADSHEET_XMLNS}>${parts.sharedStrings ?? ''}</sst>`);
  zip.file('xl/worksheets/sheet1.xml', `<?xml version="1.0" encoding="UTF-8"?><worksheet ${SPREADSHEET_XMLNS}><sheetData>${parts.sheetData}</sheetData></worksheet>`);
  return zip.generateAsync({ type: 'nodebuffer' });
}

describe('merged ranges and hyperlinks of a workbook LibreOffice wrote', () => {
  oracleTest('are returned with the sheet, in zero-based rows and columns', ['soffice'], async () => {
    const rows =
      `<table:table-row><table:table-cell table:number-columns-spanned="2" table:number-rows-spanned="2" office:value-type="string"><text:p>merged</text:p></table:table-cell><table:covered-table-cell/>${textCell('C1')}</table:table-row>` +
      `<table:table-row><table:covered-table-cell/><table:covered-table-cell/><table:table-cell office:value-type="string"><text:p><text:a xlink:href="https://example.com/a?b=1&amp;c=2">link text</text:a></text:p></table:table-cell></table:table-row>` +
      `<table:table-row>${textCell('plain')}<table:table-cell table:number-columns-spanned="3" office:value-type="string"><text:p>wide</text:p></table:table-cell></table:table-row>`;
    const workbook = sofficeConvert(flatSheet(rows), 'fods', 'xlsx', 'xlsx');
    const [sheet] = await parseAllXlsxWorksheets(workbook);

    expect(sheet.mergedRanges).toEqual([
      { startRow: 0, endRow: 1, startCol: 0, endCol: 1 },
      { startRow: 2, endRow: 2, startCol: 1, endCol: 3 },
    ]);
    expect(sheet.hyperlinks).toEqual([{ row: 1, col: 2, target: 'https://example.com/a?b=1&c=2' }]);
    expect(sheet.rows[0]).toEqual(['merged', '', 'C1']);
    expect(sheet.rows[1][2]).toBe('link text');
  });

  oracleTest('are absent from a sheet that has none', ['soffice'], async () => {
    const workbook = sofficeConvert(flatSheet(`<table:table-row>${textCell('a')}${textCell('b')}</table:table-row>`), 'fods', 'xlsx', 'xlsx');
    const [sheet] = await parseAllXlsxWorksheets(workbook);
    expect(sheet.mergedRanges).toBeUndefined();
    expect(sheet.hyperlinks).toBeUndefined();
  });
});

describe('the date system of a workbook', () => {
  oracleTest('1904 serials count from 1904-01-01 when LibreOffice wrote the workbook with that null date', ['soffice'], async () => {
    const workbook = sofficeConvert(
      flatSheet(`<table:table-row>${dateCell('1904-01-05')}${dateCell('2024-03-05')}</table:table-row>`, '1904-01-01'),
      'fods',
      'xlsx',
      'xlsx'
    );
    const [sheet] = await parseAllXlsxWorksheets(workbook);
    expect(sheet.rows[0]).toEqual(['1904-01-05', '2024-03-05']);
  });

  it('1900 serials stay on the 1900 system when the workbook says nothing', async () => {
    const workbook = await handWrittenWorkbook({ sheetData: '<row r="1"><c r="A1" s="1"><v>45356</v></c></row>' });
    const [sheet] = await parseAllXlsxWorksheets(workbook);
    expect(sheet.rows[0]).toEqual(['2024-03-05']);
  });

  it.each(['1', 'true'])('1904 serials count from 1904-01-01 when date1904="%s"', async (flag) => {
    const workbook = await handWrittenWorkbook({
      workbookPr: `<workbookPr date1904="${flag}"/>`,
      sheetData: '<row r="1"><c r="A1" s="1"><v>0</v></c><c r="B1" s="1"><v>43894</v></c></row>',
    });
    const [sheet] = await parseAllXlsxWorksheets(workbook);
    // 1904 serial 0 is 1904-01-01; 43894 days later is 2024-03-05 (the 1900 system's serial 45356 is 1462 days larger).
    expect(sheet.rows[0]).toEqual(['1904-01-01', '2024-03-05']);
  });

  it('keeps the 1900 system when date1904 is "0" or "false"', async () => {
    const workbook = await handWrittenWorkbook({ workbookPr: '<workbookPr date1904="false"/>', sheetData: '<row r="1"><c r="A1" s="1"><v>45356</v></c></row>' });
    const [sheet] = await parseAllXlsxWorksheets(workbook);
    expect(sheet.rows[0]).toEqual(['2024-03-05']);
  });

  it('reaches the CSV of a workbook in the 1904 system', async () => {
    const workbook = await handWrittenWorkbook({ workbookPr: '<workbookPr date1904="1"/>', sheetData: '<row r="1"><c r="A1" s="1"><v>43894</v></c></row>' });
    const csv = await convertFile(workbook, 'xlsx', 'csv', {}, 'book.xlsx');
    expect(csv.buffer.toString('utf-8')).toBe('2024-03-05');
  });
});

describe('rich text with phonetic guides', () => {
  it('joins the runs of a shared string and leaves the phonetic text out', async () => {
    const workbook = await handWrittenWorkbook({
      sharedStrings:
        '<si><r><t>Hel</t></r><r><rPr><b/></rPr><t>lo</t></r><rPh sb="0" eb="2"><t>ハロー</t></rPh><phoneticPr fontId="1"/></si>' +
        '<si><t>漢字</t><rPh sb="0" eb="1"><t>カン</t></rPh><rPh sb="1" eb="2"><t>ジ</t></rPh></si>',
      sheetData: '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>',
    });
    const [sheet] = await parseAllXlsxWorksheets(workbook);
    expect(sheet.rows[0]).toEqual(['Hello', '漢字']);
  });

  it('does the same for an inline string', async () => {
    const workbook = await handWrittenWorkbook({
      sheetData: '<row r="1"><c r="A1" t="inlineStr"><is><r><t>日</t></r><r><t>本</t></r><rPh sb="0" eb="2"><t>ニホン</t></rPh></is></c></row>',
    });
    const [sheet] = await parseAllXlsxWorksheets(workbook);
    expect(sheet.rows[0]).toEqual(['日本']);
  });
});
