import { describe, expect, it } from 'vitest';
import { dispatchConversion } from '../src/lib/conversions/dispatch';
import { writeTransientWorkbook } from '../src/lib/conversions/data';
import { generateOdsFromData } from '../src/lib/conversions/office';
import { gridOf } from '../src/lib/conversions/office/sheet-bounds';
import { encodeParquet } from '../src/lib/conversions/parquet-writer';
import { writeXlsx, writeXlsxWorkbook } from '../src/lib/conversions/xlsx-writer';
import { PayloadLimitError, SheetLimitError } from '../src/lib/types';

/**
 * What a table holds in each target format is stated once (`gridOf`) and every place that refuses a table past it reads it there: the
 * table of records of the data engine, the XLSX writer, the ODS writer, the .xls check and the Parquet writer. The limits are those of
 * the formats (Excel specifications and limits, [MS-XLS], LibreOffice Calc `MAXCOLCOUNT` and `MAXROWCOUNT`, the Parquet writer), so
 * the values are stated here as numbers and not read back from the code that holds them.
 */

describe('the grid of each target format', () => {
  it.each([
    ['xls', 'an .xls worksheet', 256, 65_536, 20_000_000],
    ['xlsx', 'a worksheet', 16_384, 1_048_576, 20_000_000],
    ['ods', 'a worksheet', 16_384, 1_048_576, 1_000_000],
    ['pdf', null, 16_384, Infinity, 1_000_000],
    ['parquet', null, 4096, 10_000_000, 20_000_000],
    ['csv', null, Infinity, Infinity, 20_000_000],
    ['no-such-format', null, Infinity, Infinity, 20_000_000],
    ['constructor', null, Infinity, Infinity, 20_000_000],
  ])('%s holds %s: %d columns, %d rows, %d cells', (format, sheet, columns, rows, cells) => {
    expect(gridOf(format)).toEqual({ sheet, columns, rows, cells });
  });
});

async function refusal(work: () => Promise<unknown> | unknown): Promise<unknown> {
  try {
    await work();
  } catch (error) {
    return error;
  }
  return null;
}

describe('every writer refuses a table past the grid it is given with that grid', () => {
  const columnsMessage = (count: number, limit: number, sheet: string): string => `The table has ${count} columns, and ${sheet} holds at most ${limit}; nothing was cut.`;
  const oneRowOf = (count: number): string[] => Array.from({ length: count }, (_, index) => `c${index}`);
  const oneKeyLines = (count: number): Buffer => Buffer.from(Array.from({ length: count }, (_, index) => `{"k${index}":1}`).join('\n'));

  it('the XLSX writer past the last column', async () => {
    const { columns, sheet } = gridOf('xlsx');
    const failure = await refusal(() => writeXlsx([oneRowOf(columns + 1)], 'verbatim'));
    expect(failure).toBeInstanceOf(SheetLimitError);
    expect((failure as Error).message).toBe(columnsMessage(columns + 1, columns, sheet));
  });

  it('the ODS writer past the last column', async () => {
    const { columns, sheet } = gridOf('ods');
    const failure = await refusal(() => generateOdsFromData([oneRowOf(columns + 1)], 'wide'));
    expect(failure).toBeInstanceOf(SheetLimitError);
    expect((failure as Error).message).toBe(columnsMessage(columns + 1, columns, sheet));
  });

  it('the table of records for .xlsx and for .xls', async () => {
    for (const format of ['xlsx', 'xls'] as const) {
      const { columns, sheet } = gridOf(format);
      const failure = await refusal(() => (format === 'xls' ? writeTransientWorkbook(oneKeyLines(columns + 1), 'ndjson', {}) : dispatchConversion(oneKeyLines(columns + 1), 'ndjson', format, {}, 'wide.ndjson')));
      expect(failure).toBeInstanceOf(SheetLimitError);
      expect((failure as Error).message).toBe(columnsMessage(columns + 1, columns, sheet));
    }
  });

  it('the XLSX and ODS writers past the sheets of a workbook, with one message', async () => {
    const sheets = Array.from({ length: 10_001 }, (_, index) => ({ name: `s${index}`, rows: [] as string[][] }));
    const message = 'The workbook has 10001 sheets, and a workbook holds at most 10000; nothing was cut.';
    for (const write of [() => writeXlsxWorkbook(sheets, 'verbatim'), () => generateOdsFromData(sheets, 'many')]) {
      const failure = await refusal(write);
      expect(failure).toBeInstanceOf(SheetLimitError);
      expect((failure as Error).message).toBe(message);
    }
  });

  it('the Parquet writer past its columns, with the payload family of errors and not the sheet family', async () => {
    const { columns } = gridOf('parquet');
    const record = Object.fromEntries(oneRowOf(columns + 1).map((name) => [name, 1]));
    const failure = await refusal(() => encodeParquet([record]));
    expect((failure as Error).message).toBe(`Cannot write Parquet: more than ${columns} columns.`);
    const table = await refusal(() => dispatchConversion(oneKeyLines(columns + 1), 'ndjson', 'parquet', {}, 'wide.ndjson'));
    expect(table).toBeInstanceOf(PayloadLimitError);
    expect(table).not.toBeInstanceOf(SheetLimitError);
  });
});
