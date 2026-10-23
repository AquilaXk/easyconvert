import os from 'node:os';
import { describe, expect, it } from 'vitest';
import { dispatchConversion } from '../src/lib/conversions/dispatch';
import { buildCompoundFile } from './helpers/cfb-craft';
import { outputProblem } from '../bench/realworld/output-check';
import { readTestSampleFiles } from '../bench/realworld/test-samples';
import { requireRealworldSample } from './helpers/realworld-sample';

/**
 * Three gaps of the in-process XLS reader that the nightly corpus run listed as "Corrupt XLS: No spreadsheet cell records
 * found in BIFF stream" (issue #783, 33 files of the Apache POI test corpus), each pinned on the real files:
 *
 * - 31 are valid workbooks whose sheets hold no cell value. xlrd 2.0.2 reads every sheet of them as 0 rows by 0 columns
 *   (57456 holds 1,046 MULBLANK records and trips an xlrd bug on one of them; LibreOffice reads it as empty), and
 *   LibreOffice writes a CSV of one line feed. A workbook of the XLSX source without cells converts to the empty output of
 *   each text target (CSV and TSV empty, JSON `[]`, an HTML table without rows), so these do too.
 * - `office-spreadsheet-stringformulas.xls` holds one formula whose cached result is the string XYZ, kept in the STRING
 *   record after the FORMULA record (xlrd `sheet.py` 929-978). The reader stored the text without counting the cell.
 * - `office-spreadsheet-64130.xls` is a BIFF5 `Book` stream whose BOFs carry version 0x0580 and a worksheet BOF of type
 *   0x8000, with BIFF2 NUMBER (0x0003) and LABEL (0x0004) records. xlrd refuses it ("Can't determine file's BIFF version");
 *   LibreOffice reads the cells (`sc/source/filter/excel/read.cxx` Z_Biff5T, `impop.cxx` ReadNumber and ReadLabel,
 *   `Bof5` for a sub type it does not know).
 */

const EMPTY_WORKBOOKS = [
  'office-spreadsheet-24207.xls',
  'office-spreadsheet-29675.xls',
  'office-spreadsheet-37376.xls',
  'office-spreadsheet-37684-1.xls',
  'office-spreadsheet-39234.xls',
  'office-spreadsheet-39512.xls',
  'office-spreadsheet-42844.xls',
  'office-spreadsheet-44643.xls',
  'office-spreadsheet-45565.xls',
  'office-spreadsheet-47034.xls',
  'office-spreadsheet-49237.xls',
  'office-spreadsheet-51675.xls',
  'office-spreadsheet-53972.xls',
  'office-spreadsheet-54500.xls',
  'office-spreadsheet-55341_cellstyleborder.xls',
  'office-spreadsheet-55668.xls',
  'office-spreadsheet-57456.xls',
  'office-spreadsheet-60273.xls',
  'office-spreadsheet-blankworkbook.xls',
  'office-spreadsheet-colwidth.xls',
  'office-spreadsheet-dbcsheader.xls',
  'office-spreadsheet-dg-text.xls',
  'office-spreadsheet-drawingcontinue.xls',
  'office-spreadsheet-drawings.xls',
  'office-spreadsheet-empty.xls',
  'office-spreadsheet-ex42564-21503.xls',
  'office-spreadsheet-noheaderfooter47244.xls',
  'office-spreadsheet-sheetwithdrawing.xls',
  'office-spreadsheet-simplewithimages-mac.xls',
  'office-spreadsheet-simplewithimages.xls',
  'office-spreadsheet-solvercontainerafterspgr.xls',
] as const;

const STRING_FORMULA_WORKBOOK = 'office-spreadsheet-stringformulas.xls';
const BIFF2_RECORDS_IN_BIFF5_SHEET = 'office-spreadsheet-64130.xls';

const convertText = async (bytes: Buffer, target: string, name: string): Promise<string> =>
  (await dispatchConversion(bytes, 'xls', target, {}, name)).buffer.toString('utf-8');

describe('real workbooks whose sheets hold no cell value', () => {
  for (const id of EMPTY_WORKBOOKS) {
    describe(id, () => {
      it('converts to an empty CSV and an empty TSV', async (ctx) => {
        const { bytes } = await requireRealworldSample(ctx, id);
        expect(await convertText(bytes, 'csv', id)).toBe('');
        expect(await convertText(bytes, 'tsv', id)).toBe('');
      });

      it('is marked in the corpus manifest as holding no content, so the real-world gate accepts the empty CSV and TSV', async (ctx) => {
        const { bytes } = await requireRealworldSample(ctx, id);
        const marked = readTestSampleFiles().find((file) => file.id === id)?.emptyInput === true;
        for (const target of ['csv', 'tsv']) {
          const output = (await dispatchConversion(bytes, 'xls', target, {}, id)).buffer;
          expect(await outputProblem(output, target, os.tmpdir(), { pdfinfo: '', identify: '', emptyInput: marked })).toBeNull();
        }
      });

      it('converts to an empty JSON list', async (ctx) => {
        const { bytes } = await requireRealworldSample(ctx, id);
        expect(JSON.parse(await convertText(bytes, 'json', id))).toEqual([]);
      });

      it('converts to an HTML page whose table has no row', async (ctx) => {
        const { bytes } = await requireRealworldSample(ctx, id);
        const html = await convertText(bytes, 'html', id);
        expect(html).toMatch(/<table[^>]*>\s*<\/table>/);
        expect(html).not.toContain('<tr');
      });
    });
  }
});

describe('a formula whose cached result is a string', () => {
  it('is read from the STRING record that follows it (xlrd reads the one cell XYZ)', async (ctx) => {
    const { bytes } = await requireRealworldSample(ctx, STRING_FORMULA_WORKBOOK);
    expect(await convertText(bytes, 'csv', STRING_FORMULA_WORKBOOK)).toBe('XYZ');
    expect(JSON.parse(await convertText(bytes, 'json', STRING_FORMULA_WORKBOOK))).toEqual([['XYZ']]);
  });
});

describe('a BIFF5 workbook that stores BIFF2 cell records', () => {
  it('is read as LibreOffice reads it (two rows, the labels and the numbers)', async (ctx) => {
    const { bytes } = await requireRealworldSample(ctx, BIFF2_RECORDS_IN_BIFF5_SHEET);
    expect(await convertText(bytes, 'csv', BIFF2_RECORDS_IN_BIFF5_SHEET)).toBe(',Dawn,Daylight,Dusk,Dark\nPercent,0.5,80.5,2.3,16.4');
    expect(JSON.parse(await convertText(bytes, 'json', BIFF2_RECORDS_IN_BIFF5_SHEET))).toEqual([
      ['', 'Dawn', 'Daylight', 'Dusk', 'Dark'],
      ['Percent', '0.5', '80.5', '2.3', '16.4'],
    ]);
  });
});

/** Records written from the record layouts of [MS-XLS] (BIFF8) and the Excel file format notes (BIFF2 cell records). */
const BOF = 0x0809;
const EOF = 0x000a;
const BIFF2_NUMBER = 0x0003;
const BIFF2_LABEL = 0x0004;
const BIFF5_VERSION = 0x0500;
const BIFF8_VERSION = 0x0600;
const GLOBALS = 0x0005;
const WORKSHEET = 0x0010;
const NOT_A_SUBSTREAM_TYPE = 0x8000;

function record(id: number, data: Buffer = Buffer.alloc(0)): Buffer {
  const header = Buffer.alloc(4);
  header.writeUInt16LE(id, 0);
  header.writeUInt16LE(data.length, 2);
  return Buffer.concat([header, data]);
}

function bof(substream: number, version: number): Buffer {
  const data = Buffer.alloc(16);
  data.writeUInt16LE(version, 0);
  data.writeUInt16LE(substream, 2);
  return record(BOF, data);
}

/** Row, column and the three attribute bytes of a BIFF2 cell record, then its value. */
function biff2Cell(id: number, row: number, col: number, value: Buffer): Buffer {
  const head = Buffer.alloc(7);
  head.writeUInt16LE(row, 0);
  head.writeUInt16LE(col, 2);
  return record(id, Buffer.concat([head, value]));
}

const biff2Number = (row: number, col: number, value: number): Buffer => {
  const double = Buffer.alloc(8);
  double.writeDoubleLE(value, 0);
  return biff2Cell(BIFF2_NUMBER, row, col, double);
};

const biff2Label = (row: number, col: number, text: string): Buffer => biff2Cell(BIFF2_LABEL, row, col, Buffer.concat([Buffer.from([text.length]), Buffer.from(text, 'latin1')]));

const compoundWorkbook = (stream: Buffer, name = 'Workbook'): Buffer => buildCompoundFile([{ name, data: stream }]);

const closed = (...parts: Buffer[]): Buffer => Buffer.concat([...parts, record(EOF)]);

describe('BIFF2 cell records in a BIFF5 worksheet', () => {
  const stream = (sheetType: number): Buffer =>
    Buffer.concat([
      closed(bof(GLOBALS, BIFF5_VERSION)),
      closed(bof(sheetType, BIFF5_VERSION), biff2Label(0, 1, 'Dawn'), biff2Number(1, 0, 0.5), biff2Label(1, 1, 'ab')),
    ]);

  it.each([
    ['a worksheet', WORKSHEET],
    ['a substream of a type no BOF names', NOT_A_SUBSTREAM_TYPE],
  ])('are cells of %s', async (_name, sheetType) => {
    const csv = await convertText(compoundWorkbook(stream(sheetType), 'Book'), 'csv', 'biff2.xls');
    expect(csv).toBe(',Dawn\n0.5,ab');
  });
});

describe('a stream that is not a whole workbook is still refused', () => {
  const corrupt = 'Corrupt XLS';
  const wholeButEmpty = Buffer.concat([closed(bof(GLOBALS, BIFF8_VERSION)), closed(bof(WORKSHEET, BIFF8_VERSION))]);

  it('converts a whole workbook without cells to the empty output (the contrast for the cases below)', async () => {
    expect(await convertText(compoundWorkbook(wholeButEmpty), 'csv', 'whole.xls')).toBe('');
  });

  it('refuses a stream whose first record is not a BOF', async () => {
    const noBof = Buffer.concat([record(0x0042, Buffer.alloc(2)), wholeButEmpty]);
    await expect(convertText(compoundWorkbook(noBof), 'csv', 'no-bof.xls')).rejects.toThrow(corrupt);
  });

  it('refuses a stream cut off before the EOF of its worksheet', async () => {
    const noSheetEof = Buffer.concat([closed(bof(GLOBALS, BIFF8_VERSION)), bof(WORKSHEET, BIFF8_VERSION)]);
    await expect(convertText(compoundWorkbook(noSheetEof), 'csv', 'no-eof.xls')).rejects.toThrow(corrupt);
  });

  it('refuses a stream cut off in the middle of a record', async () => {
    const cut = wholeButEmpty.subarray(0, wholeButEmpty.length - 2);
    await expect(convertText(compoundWorkbook(cut), 'csv', 'cut.xls')).rejects.toThrow(corrupt);
  });

  it('converts a raw BIFF stream without cells to the empty output', async () => {
    expect(await convertText(wholeButEmpty, 'csv', 'raw-empty.xls')).toBe('');
  });
});
