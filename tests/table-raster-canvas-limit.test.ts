import { describe, expect, it } from 'vitest';
import { convertFile } from '../src/lib/conversions';
import { captureError } from './helpers/capture-error';

/**
 * A table drawn as a picture (a Kingsoft workbook to PNG or JPG) is one canvas of 26 pixels a row and 140 a column, and the image
 * library draws a vector canvas of at most 32,767 pixels a side. A table past that, or past the pixel budget of an input picture, is
 * refused with the 413 of the other size limits before it is drawn, not with an untyped failure of the image library, and a table of
 * a hundred thousand rows is no longer a call with that many arguments.
 */

const HTTP_PAYLOAD_TOO_LARGE = 413;
const ROW_HEIGHT = 26;
const CANVAS_MARGIN = 80;
const MAX_SIDE = 32_767;
/** The most rows whose canvas is no taller than the image library draws. */
const MAX_ROWS = Math.floor((MAX_SIDE - CANVAS_MARGIN) / ROW_HEIGHT);

async function workbook(rows: number, columns: number): Promise<Buffer> {
  const csv = Buffer.from((Array(columns).fill('x').join(',') + '\n').repeat(rows));
  return (await convertFile(csv, 'csv', 'xlsx', {}, 'table.csv')).buffer;
}

describe('a table drawn as a picture', () => {
  it('is drawn when its canvas fits', async () => {
    const out = await convertFile(await workbook(MAX_ROWS, 1), 'et', 'png', {}, 'table.et');
    expect(out.buffer.subarray(1, 4).toString('latin1')).toBe('PNG');
  }, 60_000);

  it.each([
    ['one row past the height the image library draws', MAX_ROWS + 1, 1],
    ['a hundred and fifty thousand rows', 150_000, 1],
    ['more columns than the width the image library draws', 100, 300],
  ])('is refused with the 413 for %s', async (_what, rows, columns) => {
    const xlsx = await workbook(rows, columns);
    const error = await captureError(() => convertFile(xlsx, 'et', 'png', {}, 'table.et'));
    expect(error).toMatchObject({ name: 'PayloadLimitError', status: HTTP_PAYLOAD_TOO_LARGE });
  }, 120_000);
});
