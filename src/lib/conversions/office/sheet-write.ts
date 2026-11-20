import type { ConversionOptions } from '../../types';
import { convertOnDataThread } from '../data-task';
import { generateOdsFromData } from './odf-writers';
import { extractRowsForOffice } from './sheet-extract';
import { officeSheetWorkbook } from './xlsx-convert';

/**
 * The spreadsheet writers for the text sources the office engine reads as a sheet (CSV, TSV and JSON). Reading such a text builds every
 * cell as a JavaScript value, so a text of `DATA_POOL_MIN_BYTES` or more is read and written on a CPU pool thread (data-task.ts), as the
 * data converters are, and the event loop of the caller keeps turning. The limits of the sources (`DATA_SOURCE_LIMITS`) are checked by
 * the readers, on whichever thread runs them.
 */
export const SHEET_TEXT_SOURCES: ReadonlySet<string> = new Set(['csv', 'tsv', 'tab', 'json']);

export type SheetTarget = 'xlsx' | 'ods';

/** The workbook of a source on the calling thread; the pool thread runs this for `xlsx` and `ods`. */
export async function writeSheetInline(input: Buffer, src: string, tgt: SheetTarget, options: ConversionOptions, baseName: string): Promise<Buffer> {
  if (tgt === 'ods') return generateOdsFromData(await extractRowsForOffice(input, src, options), baseName);
  return officeSheetWorkbook(input, src, options);
}

/** The workbook of a source, written on a pool thread when the source is a text sheet of 128 KiB or more. */
export async function writeSheet(input: Buffer, src: string, tgt: SheetTarget, options: ConversionOptions, baseName: string): Promise<Buffer> {
  const onThread = SHEET_TEXT_SOURCES.has(src) ? await convertOnDataThread('workbook', input, src, tgt, options, baseName) : null;
  return onThread ?? writeSheetInline(input, src, tgt, options, baseName);
}
