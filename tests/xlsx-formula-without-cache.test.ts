import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { convertFile } from '../src/lib/conversions';
import { PayloadLimitError } from '../src/lib/types';

/**
 * A formula cell with no cached value (a workbook written by a script, not saved by a spreadsheet application) is computed
 * when the sheet is read. These tests build such workbooks by hand and read them back through the converter.
 */

type Cell = string | number | boolean | { f: string };

async function workbook(rows: Cell[][]): Promise<Buffer> {
  const colName = (i: number): string => String.fromCharCode(65 + i);
  const sheetRows = rows
    .map((row, r) => {
      const cells = row
        .map((cell, c) => {
          const ref = `${colName(c)}${r + 1}`;
          if (typeof cell === 'number') return `<c r="${ref}"><v>${cell}</v></c>`;
          if (typeof cell === 'boolean') return `<c r="${ref}" t="b"><v>${cell ? 1 : 0}</v></c>`;
          if (typeof cell === 'string') return `<c r="${ref}" t="inlineStr"><is><t>${cell}</t></is></c>`;
          return `<c r="${ref}"><f>${cell.f.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</f></c>`;
        })
        .join('');
      return `<row r="${r + 1}">${cells}</row>`;
    })
    .join('');
  const zip = new JSZip();
  zip.file(
    '[Content_Types].xml',
    '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
  );
  zip.file(
    '_rels/.rels',
    '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
  );
  zip.file(
    'xl/workbook.xml',
    '<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
      'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>',
  );
  zip.file(
    'xl/_rels/workbook.xml.rels',
    '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
  );
  zip.file(
    'xl/worksheets/sheet1.xml',
    `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheetRows}</sheetData></worksheet>`,
  );
  return zip.generateAsync({ type: 'nodebuffer' });
}

async function csvOf(rows: Cell[][]): Promise<string[][]> {
  const result = await convertFile(await workbook(rows), 'xlsx', 'csv', {}, 'book.xlsx');
  return result.buffer
    .toString('utf8')
    .trim()
    .split(/\r?\n/)
    .map((line) => line.split(','));
}

describe('formula cells without a cached value', () => {
  it('computes functions the reader did not know before', async () => {
    const out = await csvOf([
      [3, 'apple', { f: 'MAX(A1:A3)' }, { f: 'UPPER(B1)' }, { f: 'COUNTA(A1:B3)' }],
      [9, 'Banana', { f: 'MEDIAN(A1:A3)' }, { f: 'SUMIFS(A1:A3,A1:A3,">3")' }, { f: '_xlfn.XLOOKUP("banana",B1:B3,A1:A3)' }],
      [5, 'cherry', { f: 'STDEV(A1:A3)' }, { f: 'MATCH(5,A1:A3,0)' }, { f: 'IF(A1>2,"big","small")' }],
    ]);
    expect(out[0]!.slice(2)).toEqual(['9', 'APPLE', '6']);
    expect(out[1]!.slice(2)).toEqual(['5', '14', '9']);
    expect(Number(out[2]![2])).toBeCloseTo(3.0551, 3);
    expect(out[2]!.slice(3)).toEqual(['3', 'big']);
  });

  it('reads a number kept as a date as its serial number and writes a DATE result as a date', async () => {
    const out = await csvOf([[43831, { f: 'A1+1' }, { f: 'DATE(2020,5,17)' }, { f: 'YEAR(DATE(2021,12,31))' }]]);
    expect(out[0]).toEqual(['43831', '43832', '2020-05-17', '2021']);
  });

  it('shows the error code of a formula it cannot compute', async () => {
    const out = await csvOf([[1, { f: 'NOSUCHFUNCTION(A1)' }, { f: '1/0' }, { f: 'Sheet2!A1' }, { f: 'SUM(A:A)' }, { f: 'INDIRECT("A1")' }]]);
    expect(out[0]).toEqual(['1', '#NAME?', '#DIV/0!', '#REF!', '#REF!', '#NAME?']);
  });

  it('leaves a cycle as #CYCLE! and orders the rest by dependency', async () => {
    const out = await csvOf([[{ f: 'B1+1' }, { f: 'A1+1' }, { f: 'D1*2' }, { f: '5' }]]);
    expect(out[0]).toEqual(['#CYCLE!', '#CYCLE!', '10', '5']);
  });

  it('refuses a range past the limit even inside IFERROR', async () => {
    const grid = await csvOf([[1, { f: 'IFERROR(SUM(A1:XFD1048576),0)' }]]).catch((err: unknown) => err);
    expect(grid).toBeInstanceOf(PayloadLimitError);
    expect((grid as Error).message).toBe('Spreadsheet formula range A1:XFD1048576 spans 17179869184 cells, exceeding limit of 100000.');
    const wide = await csvOf([[1, { f: 'SUM(A1:Z5000)' }]]).catch((err: unknown) => err);
    expect(wide).toBeInstanceOf(PayloadLimitError);
    expect((wide as Error).message).toBe('Spreadsheet formula range A1:Z5000 spans 130000 cells, exceeding limit of 100000.');
  });
});
