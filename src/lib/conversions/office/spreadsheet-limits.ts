import { CONFIG_SCHEMA, ConfigRuleError, parseKind } from '../../config/schema';
import { ConfigurationError } from '../../config';

/**
 * Limits on the memory a spreadsheet conversion may take. They live apart from `office.ts` so that the
 * configuration schema and its tests can state them without loading the converters.
 */

/** Environment variable that sets the most cells of the grid a legacy XLS sheet may expand to (a positive whole number). */
export const XLS_MAX_GRID_CELLS_ENV = 'EASYCONVERT_XLS_MAX_GRID_CELLS';
/** Environment variable that sets the most cells holding text that a legacy XLS sheet may have for a PDF (a positive whole number). */
export const XLS_MAX_PDF_TEXT_CELLS_ENV = 'EASYCONVERT_XLS_MAX_PDF_TEXT_CELLS';
/** Environment variable that sets the most characters the cells of a legacy XLS sheet may expand to (a positive whole number). */
export const XLS_MAX_CELL_TEXT_CHARS_ENV = 'EASYCONVERT_XLS_MAX_CELL_TEXT_CHARS';
/** Environment variable that sets the most characters the cells of an XLSX workbook may expand to (a positive whole number). */
export const XLSX_MAX_CELL_TEXT_CHARS_ENV = 'EASYCONVERT_XLSX_MAX_CELL_TEXT_CHARS';

/**
 * Most cells of a dense grid that is built from the used range of a BIFF8 sheet, for the targets that need the
 * whole grid in memory (HTML, ODS, XLSX). The used range of a sheet reaches 65536 rows by 256 columns (16777216
 * cells) however few cells are filled. CSV, TSV and JSON never build the grid and have no such limit.
 *
 * Peak RSS a conversion of filled numeric cells adds, measured per cell: HTML 330 bytes, ODS 315 bytes, XLSX 424
 * bytes (4 million cells: 1.3 GB, 1.3 GB and 1.7 GB), against the 10 GiB per worker container that
 * docker-compose.yml shares between 3 concurrent jobs, about 3.4 GiB each. The default keeps the heaviest of them
 * at half of a job's share; 10 million cells (the size of the largest workbook common spreadsheet products
 * accept) would take 4.2 GB as XLSX.
 */
export const DEFAULT_XLS_MAX_GRID_CELLS = 4 * 1024 * 1024;

/**
 * Most cells that hold text in a legacy XLS sheet converted to a PDF, which lays every such cell out as a table cell
 * in process: about 3.1 KB per cell on top of 150 MB for the PDF writer (250000 cells: 0.96 GB, 500000: 1.74 GB,
 * 1 million: 3.3 GB), half of a job's share at 500000. Blank cells cost almost nothing there, so the whole 65536 by
 * 256 grid of a sheet with a few cells is still written (1.3 GB, 19 seconds); a PDF of a larger sheet is written
 * by the office suite, which does not hold the grid in this process.
 */
export const DEFAULT_XLS_MAX_PDF_TEXT_CELLS = 500_000;

/**
 * Most characters the cells of an XLSX workbook may expand to, shared strings counted once for every cell that
 * uses them: a 1 MiB string used by 100000 cells is 100 GiB of cell text from a few kilobytes of input.
 */
export const DEFAULT_XLSX_MAX_CELL_TEXT_CHARS = 64 * 1024 * 1024;

/** The same limit for the cells of a legacy XLS sheet, where one shared string can be used by up to 16.7 million cells. */
export const DEFAULT_XLS_MAX_CELL_TEXT_CHARS = 64 * 1024 * 1024;

type Environment = Readonly<Record<string, string | undefined>>;

/**
 * The limit in `env[name]`: its value when set, `fallback` when unset or blank. The value is read by the rule of the
 * schema entry of the same name, so the start-up check and this reader accept the same values; a malformed value is a
 * ConfigurationError that names the variable, never a replacement by the default.
 */
export function limitFromEnvironment(name: string, fallback: number, env: Environment): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const spec = CONFIG_SCHEMA.find((entry) => entry.name === name);
  if (spec === undefined) throw new Error(`${name} has no entry in the configuration schema.`);
  try {
    return parseKind(spec.kind, raw, { production: false }) as number;
  } catch (error) {
    if (!(error instanceof ConfigRuleError)) throw error;
    throw new ConfigurationError([{ variable: name, rule: error.rule }]);
  }
}

export function xlsMaxGridCells(env: Environment = process.env): number {
  return limitFromEnvironment(XLS_MAX_GRID_CELLS_ENV, DEFAULT_XLS_MAX_GRID_CELLS, env);
}

export function xlsMaxPdfTextCells(env: Environment = process.env): number {
  return limitFromEnvironment(XLS_MAX_PDF_TEXT_CELLS_ENV, DEFAULT_XLS_MAX_PDF_TEXT_CELLS, env);
}

export function xlsMaxCellTextChars(env: Environment = process.env): number {
  return limitFromEnvironment(XLS_MAX_CELL_TEXT_CHARS_ENV, DEFAULT_XLS_MAX_CELL_TEXT_CHARS, env);
}

export function xlsxMaxCellTextChars(env: Environment = process.env): number {
  return limitFromEnvironment(XLSX_MAX_CELL_TEXT_CHARS_ENV, DEFAULT_XLSX_MAX_CELL_TEXT_CHARS, env);
}
