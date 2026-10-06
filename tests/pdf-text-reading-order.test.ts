import { describe, expect } from 'vitest';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { oracleTest } from './helpers/oracle-test';
import { characterErrorRatePercent } from './helpers/ocr-cer';
import { convertWithNativePoppler } from '../src/worker/engines';
import { UnsupportedOptionError } from '../src/lib/types';

/**
 * pdf -> txt in the worker reads text in reading order by default: a two-column page is read
 * column after column, not line by line across both columns. `layout: true` opts back into
 * physical layout so table rows stay on one line. The expected texts are written by hand below;
 * nothing is taken from the converter's own output.
 */

const PAGE_SIZE: [number, number] = [612, 792];
const FONT_SIZE = 11;
const LINE_HEIGHT = 16;
const TOP_Y = 720;
const LEFT_X = 50;
const RIGHT_X = 330;
const TABLE_COLUMN_X = [50, 200, 350] as const;

const LEFT_COLUMN = [
  'Alpha opens the left column',
  'with a short first sentence.',
  'Bravo continues on the next line',
  'and finishes the first paragraph.',
  'Charlie starts the second paragraph',
  'which keeps going down the page',
  'until the column is full of text.',
];
const RIGHT_COLUMN = [
  'Delta opens the right column',
  'after the left one has ended.',
  'Echo follows on the next line',
  'and closes the first paragraph.',
  'Foxtrot begins the second paragraph',
  'which also runs down the page',
  'until the right column is full.',
];

const SINGLE_COLUMN = [
  'Quarterly Budget Review',
  'The committee met on Monday to review spending.',
  'Revenue grew while costs stayed flat.',
  'The next review is scheduled for spring.',
];

const TABLE_HEADER = ['Item', 'Quantity', 'Price'];
const TABLE_ROWS = [
  ['Widget', '12', '3.50'],
  ['Gadget', '7', '11.25'],
  ['Sprocket', '150', '0.40'],
];

/** Draws each string array as one column, top to bottom, in the order the columns are given. */
async function buildPdf(columns: { x: number; lines: readonly string[] }[]): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage(PAGE_SIZE);
  for (const column of columns) {
    column.lines.forEach((line, index) => {
      page.drawText(line, { x: column.x, y: TOP_Y - index * LINE_HEIGHT, size: FONT_SIZE, font });
    });
  }
  return Buffer.from(await doc.save());
}

async function pdfToText(pdf: Buffer, options: Record<string, unknown> = {}): Promise<string> {
  const result = await convertWithNativePoppler(pdf, 'pdf', 'txt', { throwOnUnavailable: true, ...options }, 'in.pdf');
  if (!result) throw new Error('pdftotext route returned no result');
  return result.buffer.toString('utf-8');
}

function nonEmptyLines(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

describe('worker pdf -> txt reading order (#557)', () => {
  oracleTest('reads a two-column page column after column with zero character errors', ['pdftotext'], async () => {
    const pdf = await buildPdf([
      { x: LEFT_X, lines: LEFT_COLUMN },
      { x: RIGHT_X, lines: RIGHT_COLUMN },
    ]);
    const text = await pdfToText(pdf);
    const expected = [...LEFT_COLUMN, ...RIGHT_COLUMN].join('\n');

    expect(characterErrorRatePercent(expected, text)).toBe(0);
    expect(nonEmptyLines(text)).toEqual([...LEFT_COLUMN, ...RIGHT_COLUMN]);
  });

  oracleTest('keeps single-column output identical to the source lines', ['pdftotext'], async () => {
    const pdf = await buildPdf([{ x: LEFT_X, lines: SINGLE_COLUMN }]);

    expect(nonEmptyLines(await pdfToText(pdf))).toEqual(SINGLE_COLUMN);
    expect(nonEmptyLines(await pdfToText(pdf, { layout: true }))).toEqual(SINGLE_COLUMN);
  });

  oracleTest('keeps table rows on one line with layout: true', ['pdftotext'], async () => {
    // Cells are drawn column by column, the order many generators use, so only physical layout
    // can put a row back together.
    const table = [TABLE_HEADER, ...TABLE_ROWS];
    const pdf = await buildPdf(
      TABLE_COLUMN_X.map((x, columnIndex) => ({ x, lines: table.map((row) => row[columnIndex]) }))
    );
    const lines = nonEmptyLines(await pdfToText(pdf, { layout: true }));

    expect(lines.map((line) => line.split(/\s+/))).toEqual(table);
  });

  oracleTest('rejects a layout option that is not a boolean', ['pdftotext'], async () => {
    const pdf = await buildPdf([{ x: LEFT_X, lines: SINGLE_COLUMN }]);

    await expect(pdfToText(pdf, { layout: 'yes' })).rejects.toThrow(UnsupportedOptionError);
  });
});
