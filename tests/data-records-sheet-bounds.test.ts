import { describe, expect, it } from 'vitest';
import { dispatchConversion } from '../src/lib/conversions/dispatch';
import { writeTransientWorkbook } from '../src/lib/conversions/data';
import { generateOdsFromData } from '../src/lib/conversions/office';
import { WORKBOOK_MAX_SHEETS, XLS_MAX_COLUMNS, XLS_MAX_ROWS, XLSX_MAX_COLUMNS, XLSX_MAX_ROWS } from '../src/lib/conversions/office/sheet-bounds';
import { PayloadLimitError, SheetLimitError } from '../src/lib/types';

/**
 * A table of records is built as records x columns before a writer sees it, and every record that names a key of its own adds a column:
 * R lines of one key each are R columns and R x R cells from R lines of input. The bounds are checked before that matrix exists, with the
 * grid of the target for a spreadsheet and the cells a table is built with for any other target.
 */

const MEBIBYTE = 1024 * 1024;
const HEAP_GROWTH_CEILING = 256 * MEBIBYTE;

const oneKeyLines = (count: number): Buffer => Buffer.from(Array.from({ length: count }, (_, index) => `{"k${index}":1}`).join('\n'));
const sameKeyLines = (count: number): Buffer => Buffer.from(Array.from({ length: count }, (_, index) => `{"id":${index}}`).join('\n'));

async function failureOf(work: () => Promise<unknown>): Promise<unknown> {
  try {
    await work();
  } catch (error) {
    return error;
  }
  return null;
}

describe('records with a key of their own each, written to a sheet', () => {
  const HOSTILE_LINES = XLSX_MAX_COLUMNS;

  it.each(['xlsx', 'ods'])('refuses %s with the typed limit error before the matrix is built', async (target) => {
    const before = process.memoryUsage().heapUsed;
    const failure = await failureOf(() => dispatchConversion(oneKeyLines(HOSTILE_LINES), 'ndjson', target, {}, 'hostile.ndjson'));
    expect(failure).toBeInstanceOf(SheetLimitError);
    expect(process.memoryUsage().heapUsed - before).toBeLessThan(HEAP_GROWTH_CEILING);
  });

  it('refuses xls with the typed limit error before the matrix is built', async () => {
    const before = process.memoryUsage().heapUsed;
    const failure = await failureOf(() => writeTransientWorkbook(oneKeyLines(HOSTILE_LINES), 'ndjson', {}));
    expect(failure).toBeInstanceOf(SheetLimitError);
    expect(process.memoryUsage().heapUsed - before).toBeLessThan(HEAP_GROWTH_CEILING);
  });

  it('refuses a table past the columns of the worksheet, naming the grid', async () => {
    const failure = await failureOf(() => dispatchConversion(oneKeyLines(XLSX_MAX_COLUMNS + 1), 'ndjson', 'xlsx', {}, 'wide.ndjson'));
    expect(failure).toBeInstanceOf(SheetLimitError);
    expect((failure as Error).message).toBe(`The table has ${XLSX_MAX_COLUMNS + 1} columns, and a worksheet holds at most ${XLSX_MAX_COLUMNS}; nothing was cut.`);
  });

  it('refuses xls past 256 columns and past 65,536 rows, as the BIFF8 worksheet holds', async () => {
    const wide = await failureOf(() => writeTransientWorkbook(oneKeyLines(XLS_MAX_COLUMNS + 1), 'ndjson', {}));
    expect(wide).toBeInstanceOf(SheetLimitError);
    expect((wide as Error).message).toContain(`${XLS_MAX_COLUMNS + 1} columns, and an .xls worksheet holds at most ${XLS_MAX_COLUMNS}`);
    const long = await failureOf(() => writeTransientWorkbook(sameKeyLines(XLS_MAX_ROWS), 'ndjson', {}));
    expect(long).toBeInstanceOf(SheetLimitError);
    expect((long as Error).message).toContain(`${XLS_MAX_ROWS + 1} rows, and an .xls worksheet holds at most ${XLS_MAX_ROWS}`);
  });

  it('writes the tables that fit: 256 one-key records, and 65,535 records of one column', async () => {
    const fitting = await dispatchConversion(oneKeyLines(XLS_MAX_COLUMNS), 'ndjson', 'xlsx', {}, 'fits.ndjson');
    expect(fitting.size).toBeGreaterThan(0);
    expect((await writeTransientWorkbook(oneKeyLines(XLS_MAX_COLUMNS), 'ndjson', {})).subarray(0, 2).toString('latin1')).toBe('PK');
    expect((await writeTransientWorkbook(sameKeyLines(XLS_MAX_ROWS - 1), 'ndjson', {})).subarray(0, 2).toString('latin1')).toBe('PK');
  });

  it('refuses a table of 5,000 records by 5,000 columns as the cells a workbook is read with', async () => {
    const failure = await failureOf(() => dispatchConversion(oneKeyLines(5000), 'ndjson', 'xlsx', {}, 'dense.ndjson'));
    expect(failure).toBeInstanceOf(SheetLimitError);
    expect((failure as Error).message).toBe(
      'The table has 25000000 cells (records times columns), and a workbook this engine reads holds at most 20000000; nothing was cut.'
    );
  });
});

describe('records with a key of their own each, written to a table that is not a sheet', () => {
  const asJsonArray = (lines: Buffer): Buffer => Buffer.from(`[${lines.toString('utf-8').split('\n').join(',')}]`);

  it.each([
    ['csv', 'jsonl', oneKeyLines(XLSX_MAX_COLUMNS)],
    ['tsv', 'ndjson', oneKeyLines(XLSX_MAX_COLUMNS)],
    ['parquet', 'jsonl', oneKeyLines(XLSX_MAX_COLUMNS)],
    ['pdf', 'json', asJsonArray(oneKeyLines(XLSX_MAX_COLUMNS))],
  ])('refuses %s from %s with the payload limit and not the sheet limit', async (target, source, input) => {
    const before = process.memoryUsage().heapUsed;
    const failure = await failureOf(() => dispatchConversion(input, source, target, {}, `hostile.${source}`));
    expect(failure).toBeInstanceOf(PayloadLimitError);
    expect(failure).not.toBeInstanceOf(SheetLimitError);
    expect(process.memoryUsage().heapUsed - before).toBeLessThan(HEAP_GROWTH_CEILING);
  });
});

describe('an ODS table is bound as an XLSX worksheet is', () => {
  it('refuses a row past the last column', async () => {
    const failure = await failureOf(() => generateOdsFromData([new Array<string>(XLSX_MAX_COLUMNS + 1).fill('')], 'wide'));
    expect(failure).toBeInstanceOf(SheetLimitError);
    expect((failure as Error).message).toBe(`The table has ${XLSX_MAX_COLUMNS + 1} columns, and a worksheet holds at most ${XLSX_MAX_COLUMNS}; nothing was cut.`);
  });

  it('refuses a table past the last row', async () => {
    const failure = await failureOf(() => generateOdsFromData(new Array<string[]>(XLSX_MAX_ROWS + 1).fill([]), 'long'));
    expect(failure).toBeInstanceOf(SheetLimitError);
    expect((failure as Error).message).toBe(`The table has ${XLSX_MAX_ROWS + 1} rows, and a worksheet holds at most ${XLSX_MAX_ROWS}; nothing was cut.`);
  });

  it('refuses a workbook past the sheets the office suite holds', async () => {
    const sheets = Array.from({ length: WORKBOOK_MAX_SHEETS + 1 }, (_, index) => ({ name: `s${index}`, rows: [] as string[][] }));
    const failure = await failureOf(() => generateOdsFromData(sheets, 'many'));
    expect(failure).toBeInstanceOf(SheetLimitError);
    expect((failure as Error).message).toBe(`The workbook has ${WORKBOOK_MAX_SHEETS + 1} sheets, and a workbook holds at most ${WORKBOOK_MAX_SHEETS}; nothing was cut.`);
  });

  it('writes a table of the widest row', async () => {
    const ods = await generateOdsFromData([new Array<string>(XLSX_MAX_COLUMNS).fill('')], 'widest');
    expect(ods.subarray(0, 2).toString('latin1')).toBe('PK');
  });
});
