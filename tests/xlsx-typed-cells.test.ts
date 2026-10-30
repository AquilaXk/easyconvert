import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { convertFile } from '../src/lib/conversions';
import { classifyJobFailure } from '../src/lib/queue/job-failure';
import { DataLimitExceededError, DataParseError } from '../src/lib/types';
import { oracleTest } from './helpers/oracle-test';
import { cellKindsViaLibreOffice, sheetRowsViaLibreOffice } from './helpers/sheet-rows';

/**
 * A workbook written from a table keeps what each cell is (ECMA-376 Part 1, 18.3.1.4): numbers are numbers, booleans are booleans,
 * dates are serial numbers under a date format and text is shared strings. A value that only looks like a number (a ZIP code, an
 * identifier with leading zeros, a figure with more digits than a double keeps, exponent notation) stays text, so no cell changes.
 */

async function sheetOf(xlsx: Buffer): Promise<string> {
  return (await JSZip.loadAsync(xlsx)).file('xl/worksheets/sheet1.xml')!.async('text');
}

async function partOf(xlsx: Buffer, path: string): Promise<string> {
  return (await JSZip.loadAsync(xlsx)).file(path)!.async('text');
}

async function csvToXlsx(csv: string): Promise<Buffer> {
  return (await convertFile(Buffer.from(csv, 'utf-8'), 'csv', 'xlsx', {}, 'table.csv')).buffer;
}

function cellOf(sheetXml: string, reference: string): string {
  const match = new RegExp(`<c r="${reference}"[^>]*?(?:/>|>.*?</c>)`).exec(sheetXml);
  if (!match) throw new Error(`no cell ${reference} in the sheet`);
  return match[0];
}

describe('typed cells of a workbook written from CSV', () => {
  it('writes a number as a number, with no text type', async () => {
    const sheet = await sheetOf(await csvToXlsx('label,amount\nitem,1.5\n'));
    const cell = cellOf(sheet, 'B2');
    expect(cell).not.toContain('inlineStr');
    expect(cell).not.toMatch(/\bt="(?:s|str|inlineStr)"/);
    expect(cell).toContain('<v>1.5</v>');
  });

  it('writes text through the shared strings part, once for a repeated value', async () => {
    const xlsx = await csvToXlsx('city\nOsaka\nOsaka\nSeoul\n');
    const sheet = await sheetOf(xlsx);
    expect(sheet).not.toContain('inlineStr');
    const shared = await partOf(xlsx, 'xl/sharedStrings.xml');
    expect(shared.match(/<si>/g)).toHaveLength(3);
    expect(cellOf(sheet, 'A2')).toBe(cellOf(sheet, 'A3').replace('A3', 'A2'));
    expect(cellOf(sheet, 'A2')).toMatch(/t="s"/);
  });

  it.each([
    ['a leading zero', '00004'],
    ['exponent notation', '1e4'],
    ['a trailing zero after the point', '1.50'],
    ['a plus sign', '+5'],
    ['a thousands separator', '1,250'],
    ['sixteen digits, which a double does not keep', '1234567890123456'],
    ['a negative zero', '-0'],
    ['a value that is not a number', 'K-255'],
  ])('keeps %s as text', async (_name, value) => {
    const csv = `value\n"${value}"\n`;
    const cell = cellOf(await sheetOf(await csvToXlsx(csv)), 'A2');
    expect(cell).toMatch(/t="s"/);
  });

  it.each([
    ['an integer', '7506060', '7506060'],
    ['a negative decimal', '-153.375', '-153.375'],
    ['zero point five', '0.5', '0.5'],
    ['fifteen digits, which a double keeps', '123456789012345', '123456789012345'],
  ])('writes %s as a number', async (_name, value, stored) => {
    const cell = cellOf(await sheetOf(await csvToXlsx(`value\n${value}\n`)), 'A2');
    expect(cell).not.toMatch(/\bt="/);
    expect(cell).toContain(`<v>${stored}</v>`);
  });

  it('writes an ISO date as a serial number under a date format', async () => {
    const xlsx = await csvToXlsx('when\n2024-03-05\n');
    const cell = cellOf(await sheetOf(xlsx), 'A2');
    // 2024-03-05 is 45356 days after 1899-12-30, the day zero of the 1900 date system.
    expect(cell).toContain('<v>45356</v>');
    expect(cell).toMatch(/\bs="1"/);
    const styles = await partOf(xlsx, 'xl/styles.xml');
    expect(styles).toMatch(/<numFmt numFmtId="164" formatCode="yyyy\\-mm\\-dd"\/>/);
    expect(styles).toMatch(/<xf numFmtId="164"[^>]*applyNumberFormat="1"/);
  });

  it('keeps a date-looking value that is not a calendar day as text', async () => {
    const sheet = await sheetOf(await csvToXlsx('when\n2024-02-30\n1899-12-31\n'));
    expect(cellOf(sheet, 'A2')).toMatch(/t="s"/);
    expect(cellOf(sheet, 'A3')).toMatch(/t="s"/);
  });

  it('escapes the control characters and the leading whitespace of a string as the format requires', async () => {
    const xlsx = await csvToXlsx('text\n"  padded\u0001 _x0041_ "\n');
    const shared = await partOf(xlsx, 'xl/sharedStrings.xml');
    expect([...shared.matchAll(/<si>.*?<\/si>/g)].map((item) => item[0])).toEqual([
      '<si><t>text</t></si>',
      '<si><t xml:space="preserve">  padded_x0001_ _x005F_x0041_ </t></si>',
    ]);
  });
});

describe('a workbook the office suite reads once', () => {
  it('can be written uncompressed, with the same cells and larger parts', async () => {
    const csv = `a,b\n${'row,2024-03-05\n'.repeat(500)}`;
    const deflated = (await convertFile(Buffer.from(csv), 'csv', 'xlsx', {}, 't.csv')).buffer;
    const stored = (await convertFile(Buffer.from(csv), 'csv', 'xlsx', { uncompressedWorkbook: true }, 't.csv')).buffer;
    expect(stored.length).toBeGreaterThan(deflated.length * 2);
    expect(await sheetOf(stored)).toBe(await sheetOf(deflated));
  });
});

describe('typed cells of a workbook written from JSON', () => {
  it('writes numbers as numbers, booleans as booleans and strings as shared strings', async () => {
    const json = JSON.stringify([{ id: 7, price: 1.5, active: true, label: '007' }]);
    const xlsx = (await convertFile(Buffer.from(json), 'json', 'xlsx', {}, 'records.json')).buffer;
    const sheet = await sheetOf(xlsx);
    expect(cellOf(sheet, 'A2')).toBe('<c r="A2"><v>7</v></c>');
    expect(cellOf(sheet, 'B2')).toBe('<c r="B2"><v>1.5</v></c>');
    expect(cellOf(sheet, 'C2')).toBe('<c r="C2" t="b"><v>1</v></c>');
    expect(cellOf(sheet, 'D2')).toMatch(/t="s"/);
  });

  it('writes a false boolean and an empty cell for null', async () => {
    const json = JSON.stringify([{ a: false, b: null, c: 'x' }]);
    const sheet = await sheetOf((await convertFile(Buffer.from(json), 'json', 'xlsx', {}, 'records.json')).buffer);
    expect(cellOf(sheet, 'A2')).toBe('<c r="A2" t="b"><v>0</v></c>');
    expect(sheet).not.toContain('r="B2"');
  });
});

describe('a table that is not well formed is refused, not turned into a sheet', () => {
  it.each([
    ['an unterminated quote', 'a,b\n1,"two\n3,4\n'],
    ['a quote that closes before the end of the field', 'a,b\n1,"two"x\n'],
  ])('refuses CSV with %s as a 400', async (_name, csv) => {
    const failure = await convertFile(Buffer.from(csv), 'csv', 'xlsx', {}, 'broken.csv').catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(DataParseError);
    expect(classifyJobFailure(failure)).toMatchObject({ code: 'DataParseError', status: 400 });
  });

  it('refuses a JSON document that stops in the middle as a 400', async () => {
    const failure = await convertFile(Buffer.from('{"a":'), 'json', 'xlsx', {}, 'broken.json').catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(DataParseError);
    expect(classifyJobFailure(failure)).toMatchObject({ code: 'DataParseError', status: 400 });
  });
});

describe('the limits of a worksheet', () => {
  it('refuses a table of more than 1,048,576 rows as a 413 instead of cutting it', async () => {
    const csv = `a\n${'x\n'.repeat(1_048_576)}`;
    const failure = await convertFile(Buffer.from(csv), 'csv', 'xlsx', {}, 'tall.csv').catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(DataLimitExceededError);
    expect((failure as DataLimitExceededError).status).toBe(413);
  }, 120_000);

  it('refuses a table of more than 16,384 columns as a 413 instead of cutting it', async () => {
    const csv = `${Array.from({ length: 16_385 }, (_, i) => `c${i}`).join(',')}\n`;
    const failure = await convertFile(Buffer.from(csv), 'csv', 'xlsx', {}, 'wide.csv').catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(DataLimitExceededError);
    expect((failure as DataLimitExceededError).status).toBe(413);
  });

  it('refuses a cell of more than 32,767 characters as a 413 instead of cutting it', async () => {
    const failure = await convertFile(Buffer.from(`a\n${'x'.repeat(32_768)}\n`), 'csv', 'xlsx', {}, 'long.csv').catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(DataLimitExceededError);
    expect((failure as Error).message).toBe('The table has 32768 characters in one cell, and a worksheet holds at most 32767; nothing was cut.');
  });
});

describe('what an office suite reads from the workbook', () => {
  oracleTest('gives back every cell of the table, dates, decimals and quoted commas included', ['soffice', 'python3'], async () => {
    const csv = [
      'name,amount,when,code,flag',
      'widget,1.5,2024-03-05,00004,"a,b"',
      'gadget,-153.375,1999-12-31,K-255,"say ""hi"""',
      'gizmo,123456789012345,2000-01-01,1e4,',
    ].join('\n');
    const rows = sheetRowsViaLibreOffice(await csvToXlsx(csv), 'xlsx');
    expect(rows).toEqual([
      ['name', 'amount', 'when', 'code', 'flag'],
      ['widget', '1.5', '2024-03-05', '00004', 'a,b'],
      ['gadget', '-153.375', '1999-12-31', 'K-255', 'say "hi"'],
      ['gizmo', '123456789012345', '2000-01-01', '1e4', ''],
    ]);
  });

  oracleTest('reads a JSON boolean back as a boolean, a number as a float and a date as a date', ['soffice'], async () => {
    const json = JSON.stringify([{ ok: true, no: false, n: 1.5, text: 'x' }]);
    const xlsx = (await convertFile(Buffer.from(json), 'json', 'xlsx', {}, 'flags.json')).buffer;
    expect(await cellKindsViaLibreOffice(xlsx, 'xlsx')).toEqual([
      ['string:', 'string:', 'string:', 'string:'],
      ['boolean:true', 'boolean:false', 'float:1.5', 'string:'],
    ]);
    const dated = await csvToXlsx('when\n2024-03-05\n');
    expect((await cellKindsViaLibreOffice(dated, 'xlsx'))[1]).toEqual(['date:2024-03-05']);
  });
});
