import { describe, expect, it } from 'vitest';
import { readWorksheetStructure } from '../src/lib/conversions/office/xlsx-worksheet-structure';

/**
 * A worksheet is read where the schema puts each part (ECMA-376 Part 1, 18.3.1.99): the column widths before `sheetData`
 * and the rows inside it, as SheetJS splits a worksheet in `parse_ws_xml`. The lists after the cell data are not walked.
 */

const COLS = '<cols><col min="1" max="1" width="10" customWidth="1"/></cols>';
const ROW_1 = '<row r="1"><c r="A1"><v>1</v></c></row>';
const ROW_2 = '<row r="2"><c r="A2"><v>2</v></c></row>';
const sheet = (body: string): string => `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${body}</worksheet>`;
const rowRefs = (xml: string): string[] => readWorksheetStructure(xml, 'Sheet1').rowEls.map((row) => row.attrs.r);

describe('the structure of a worksheet', () => {
  it('takes the widths from before the cell data and the rows from inside it', () => {
    const { columnWidths, rowEls } = readWorksheetStructure(sheet(`${COLS}<sheetData>${ROW_1}${ROW_2}</sheetData>`), 'Sheet1');
    expect(columnWidths[0]).toBe(75);
    expect(rowEls.map((row) => row.attrs.r)).toEqual(['1', '2']);
  });

  it('does not read a row placed after the cell data', () => {
    expect(rowRefs(sheet(`<sheetData>${ROW_1}</sheetData>${ROW_2}`))).toEqual(['1']);
  });

  it('does not read column widths placed after the cell data', () => {
    expect(readWorksheetStructure(sheet(`<sheetData>${ROW_1}</sheetData>${COLS}`), 'Sheet1').columnWidths).toEqual([]);
  });

  it('reads no rows from empty cell data', () => {
    expect(rowRefs(sheet(`${COLS}<sheetData/>${ROW_2}`))).toEqual([]);
  });

  it('reads a sheet with no cell data whole', () => {
    const { columnWidths, rowEls } = readWorksheetStructure(sheet(`${ROW_1}${COLS}`), 'Sheet1');
    expect(columnWidths[0]).toBe(75);
    expect(rowEls.map((row) => row.attrs.r)).toEqual(['1']);
  });

  it('reads prefixed cell data', () => {
    const prefixed = `<x:worksheet xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><x:sheetData><x:row r="1"/></x:sheetData><x:row r="9"/></x:worksheet>`;
    expect(rowRefs(prefixed)).toEqual(['1']);
  });
});
