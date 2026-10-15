import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { convertFile } from '../src/lib/conversions';
import { ConversionFailedError, DataParseError } from '../src/lib/types';
import { oracleTest } from './helpers/oracle-test';
import { parseCsvWithPython, sheetRowsViaLibreOffice } from './helpers/sheet-rows';
import { sofficeConvert } from './helpers/soffice-office';

/**
 * Spreadsheet sources are read as what they are. JSON that does not parse is refused rather than turned into a
 * one-cell sheet holding its own text, and a Kingsoft .et workbook (an OOXML package or a binary CFBF workbook) is
 * read as a workbook, not decoded as CSV text.
 */

const CFBF_SIGNATURE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const ET_TEXT_ROWS = [
  ['Name', 'Value'],
  ['ItemA', '100'],
  ['Item "B", quoted', '200'],
];
/** The same rows as RFC 4180 CSV text, the form the office suite imports them from. */
const ET_CSV = 'Name,Value\nItemA,100\n"Item ""B"", quoted",200\n';

describe('JSON spreadsheet sources', () => {
  it.each(['xlsx', 'ods', 'xls'])('json that does not parse is refused for the .%s target, not wrapped into one cell', async (target) => {
    const failure = await convertFile(Buffer.from('{"a": 1,'), 'json', target, {}, 'broken.json').catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(DataParseError);
    expect((failure as Error).message).toMatch(/^Invalid JSON: /);
  });

  it.each(['xlsx', 'ods', 'xls'])('json that is neither an array of records nor of values is refused for the .%s target', async (target) => {
    const failure = await convertFile(Buffer.from('{"a": 1}'), 'json', target, {}, 'object.json').catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(DataParseError);
    expect((failure as Error).message).toBe('Invalid JSON table: expected an array of objects or an array of values.');
  });

  oracleTest('an array of objects becomes a sheet an office suite reads back cell for cell', ['soffice', 'python3'], async () => {
    const json = JSON.stringify([
      { id: '1', label: 'alpha' },
      { id: '2', label: 'with, comma' },
    ]);
    const converted = await convertFile(Buffer.from(json), 'json', 'xlsx', {}, 'records.json');
    expect(sheetRowsViaLibreOffice(converted.buffer, 'xlsx')).toEqual([
      ['id', 'label'],
      ['1', 'alpha'],
      ['2', 'with, comma'],
    ]);
  });
});

describe('Kingsoft .et workbooks', () => {
  oracleTest('an OOXML .et workbook is read as a workbook, cell for cell', ['soffice', 'python3'], async () => {
    const workbook = sofficeConvert(Buffer.from(ET_CSV), 'csv', 'xlsx', 'xlsx');
    expect(workbook.subarray(0, 2).toString('latin1')).toBe('PK');

    const converted = await convertFile(workbook, 'et', 'csv', {}, 'table.et');
    expect(parseCsvWithPython(converted.buffer.toString('utf-8'))).toEqual(ET_TEXT_ROWS);

    const asXlsx = await convertFile(workbook, 'et', 'xlsx', {}, 'table.et');
    expect(sheetRowsViaLibreOffice(asXlsx.buffer, 'xlsx')).toEqual(ET_TEXT_ROWS);
  });

  it('a ZIP that is not a workbook is refused as an invalid XLSX workbook', async () => {
    const notAWorkbook = await new JSZip().file('readme.txt', 'no workbook here').generateAsync({ type: 'nodebuffer' });
    const failure = await convertFile(notAWorkbook, 'et', 'csv', {}, 'table.et').catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(ConversionFailedError);
    expect((failure as Error).message).toMatch(/^Invalid XLSX workbook: no worksheets/);
  });

  oracleTest('a binary (BIFF8) .et workbook is read as a workbook, cell for cell', ['soffice', 'python3'], async () => {
    const workbook = sofficeConvert(Buffer.from(ET_CSV), 'csv', 'xls', 'xls');
    expect(workbook.subarray(0, CFBF_SIGNATURE.length)).toEqual(CFBF_SIGNATURE);

    const converted = await convertFile(workbook, 'et', 'csv', {}, 'table.et');
    expect(parseCsvWithPython(converted.buffer.toString('utf-8'))).toEqual(ET_TEXT_ROWS);
  });

  it.each(['csv', 'xlsx', 'png'])('a CFBF container without a workbook stream is refused for the .%s target, not decoded as CSV text', async (target) => {
    const emptyContainer = Buffer.concat([CFBF_SIGNATURE, Buffer.alloc(504, 0)]);
    const failure = await convertFile(emptyContainer, 'et', target, {}, 'table.et').catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(ConversionFailedError);
    expect((failure as Error).message).toMatch(/^(Corrupt|Invalid) /);
  });

  it('delimited text under an .et name is still read as a table', async () => {
    const converted = await convertFile(Buffer.from('Name,Value\nItemA,100\n'), 'et', 'csv', {}, 'table.et');
    expect(parseCsvWithPython(converted.buffer.toString('utf-8'))).toEqual([['Name', 'Value'], ['ItemA', '100']]);
  });
});
