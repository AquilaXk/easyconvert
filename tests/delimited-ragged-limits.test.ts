import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseDelimitedRecords } from '../src/lib/conversions/delimited-detect';
import { convertPureData } from '../src/lib/edge/pure/pure-data';
import { DataParseError } from '../src/lib/types';

/**
 * A table whose records differ in width is padded to its widest record (see delimited-ragged-rows.test.ts), so one wide record
 * multiplies into every other row. Spreadsheet applications bound a sheet at 16,384 columns (Excel's "Excel specifications and
 * limits"; LibreOffice Calc's MAXCOLCOUNT of 16 * 1024 in sc/inc/address.hxx), and the padding is bounded by the cells the file holds
 * (the expansion rule of the YAML reader): an 80 KB file must be refused quickly instead of taking the worker's heap.
 */

const CHILD = path.resolve(__dirname, 'delimited-ragged-limits-child.ts');
const HEAP_LIMIT_MIB = 128;
const CHILD_TIMEOUT_MS = 60_000;
const REFUSAL_BUDGET_MS = 5_000;

function table(shortRecords: number, shortRecord: string, wideRecord: string, header = 'a,b'): string {
  return `${header}\n${`${shortRecord}\n`.repeat(shortRecords)}${wideRecord}\n`;
}

function refusal(text: string, delimiter = ','): DataParseError {
  try {
    parseDelimitedRecords(text, delimiter, 'csv');
  } catch (error) {
    expect(error).toBeInstanceOf(DataParseError);
    return error as DataParseError;
  }
  throw new Error('the table was parsed');
}

describe('a table is bounded as a sheet of a spreadsheet application is', () => {
  it('refuses 20,000 records padded to one of 20,000 fields in a worker heap of 128 MiB, quickly', () => {
    const output = execFileSync(process.execPath, [`--max-old-space-size=${HEAP_LIMIT_MIB}`, '--import', 'tsx', CHILD], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: CHILD_TIMEOUT_MS,
    });
    const [, ms] = /^refused in (\d+) ms, rss \d+ MiB: DataParseError: .*row 20002/.exec(output) ?? [];
    expect(Number(ms)).toBeLessThan(REFUSAL_BUDGET_MS);
  }, CHILD_TIMEOUT_MS + 5_000);

  it('reads a record of 16,384 fields, the last column of a sheet, and refuses one of 16,385 naming its row', () => {
    const last = parseDelimitedRecords(table(2, 'x,y', ','.repeat(16_383)), ',', 'csv');
    expect(last.fields).toHaveLength(16_384);
    expect(last.fields[16_383]).toBe('Unnamed: 16383');
    const past = refusal(table(2, 'x,y', ','.repeat(16_384)));
    expect(past.message).toBe('Failed to parse CSV: row 4 has 16385 fields; a table is limited to 16384 columns, as a sheet of a spreadsheet application is.');
    expect(past.row).toBe(4);
  });

  it('names the first of several widest records', () => {
    const text = `a,b\n1,2\n${','.repeat(16_400)}\n${','.repeat(16_400)}\n`;
    expect(refusal(text).row).toBe(3);
  });

  it('refuses padding that takes more than 1,000,000 cells and more than four times the cells the file holds', () => {
    const error = refusal(table(2_000, 'x,y', ','.repeat(999)));
    expect(error.message).toBe('Failed to parse CSV: row 2002 has 1000 fields, and padding the other 2001 rows to it would make 2002000 cells from 5002; a ragged table may hold up to 4 times its cells.');
    expect(error.row).toBe(2002);
  });

  it('still pads a table of up to 1,000,000 cells, however much wider its widest record is', () => {
    const { fields, records } = parseDelimitedRecords(table(998, 'x,y', ','.repeat(999)), ',', 'csv');
    expect(fields).toHaveLength(1000);
    expect(records).toHaveLength(999);
    expect(records[0]).toMatchObject({ a: 'x', b: 'y', 'Unnamed: 999': '' });
  });

  it('still pads a table above 1,000,000 cells that grows by less than four times', () => {
    const { fields, records } = parseDelimitedRecords(table(300_000, 'v,w,x,y,z', 'v,w,x,y,z,1', 'a,b,c,d,e'), ',', 'csv');
    expect(fields).toEqual(['a', 'b', 'c', 'd', 'e', 'Unnamed: 5']);
    expect(records).toHaveLength(300_001);
    expect(records[0]['Unnamed: 5']).toBe('');
    expect(records[300_000]['Unnamed: 5']).toBe('1');
  });

  it('reads 1,048,576 records, the rows of a sheet, and refuses the next one naming its row', () => {
    const { records } = parseDelimitedRecords(`a,b\n${'x,y\n'.repeat(1_048_574)}x\n`, ',', 'csv');
    expect(records).toHaveLength(1_048_575);
    const error = refusal(`a,b\n${'x,y\n'.repeat(1_048_574)}x\nx\n`);
    expect(error.message).toBe('Failed to parse CSV: row 1048577 is record 1048577; a table is limited to 1048576 rows, as a sheet of a spreadsheet application is.');
    expect(error.row).toBe(1_048_577);
  });

  it('counts only the lines that are not blank as records', () => {
    const { records } = parseDelimitedRecords(`a,b\n${'\n'.repeat(5)}x\n${'x,y\n'.repeat(1_048_574)}`, ',', 'csv');
    expect(records).toHaveLength(1_048_575);
  });

  it('reads a field of 131,072 characters, the field size limit of Python csv, and refuses one character more naming its row', () => {
    const { records } = parseDelimitedRecords(`a,b\n${'x'.repeat(131_072)}\n`, ',', 'csv');
    expect(records[0].a).toHaveLength(131_072);
    const error = refusal(`a,b\n1,2\n${'x'.repeat(131_073)}\n`);
    expect(error.message).toBe('Failed to parse CSV: row 3 has a field of 131073 characters; a field is limited to 131072 characters.');
    expect(error.row).toBe(3);
  });

  it('finds the long field in a quoted field with line breaks, and in the header record of a ragged table', () => {
    expect(refusal(`a,b\n"${'x\n'.repeat(70_000)}"\n`).message).toMatch(/^Failed to parse CSV: row 2 has a field of 140000 characters/);
    expect(refusal(`${'h'.repeat(131_073)},b\n1\n`).row).toBe(1);
  });

  it('applies to the pure data engine, which reads the same records', () => {
    const error = (() => {
      try {
        convertPureData(table(20_000, 'x,y', ','.repeat(20_000)), 'csv', 'json');
      } catch (thrown) {
        return thrown as DataParseError;
      }
      throw new Error('the table was converted');
    })();
    expect(error).toBeInstanceOf(DataParseError);
    expect(error.row).toBe(20_002);
  });

  it('leaves a table of uniform width with a long field alone, as it was read before records of another width were', () => {
    const { records } = parseDelimitedRecords(`a,b\n${'x'.repeat(200_000)},y\n`, ',', 'csv');
    expect(records[0].a).toHaveLength(200_000);
  });

  it('leaves a table of uniform width alone, wherever its width lies', () => {
    const header = Array.from({ length: 20_000 }, (_, index) => `c${index}`).join(',');
    const { fields } = parseDelimitedRecords(`${header}\n${','.repeat(19_999)}\n`, ',', 'csv');
    expect(fields).toHaveLength(20_000);
  });
});
