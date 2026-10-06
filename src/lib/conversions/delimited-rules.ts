/**
 * Output rules for delimited text (CSV / TSV), shared by the server data engine and the browser
 * streaming path. Dependency-free so the edge worker bundle can import it.
 */

/**
 * Cells a spreadsheet evaluates as a formula: a leading = + - @ TAB or CR. Plain numeric literals
 * (-5, +1.5e3) are values, not formulas, so they are left alone.
 */
export const FORMULA_TRIGGER = /^(?![+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$)[=+\-@\t\r]/;

export const UTF8_BOM_CHAR = '﻿';

/** Record separator written between records (none after the last one). */
export const DELIMITED_RECORD_SEPARATOR = '\r\n';

/**
 * A UTF-8 BOM is on by default for CSV, the format spreadsheet applications open directly and
 * decode as UTF-8 only when the BOM is present; it is off by default for TSV, which mostly feeds
 * data tooling where a BOM would corrupt the first header.
 */
export function writesBomByDefault(target: string): boolean {
  return target === 'csv';
}
