import { ConversionFailedError } from '../../types';
import { safeExtractXmlElements, type SafeXmlElement } from '../safe-xml-scanner';
import { XLSX_LAST_COLUMN_NAME, XLSX_MAX_COLUMNS, XLSX_MAX_ROWS } from './sheet-bounds';

export function worksheetBoundError(sheetName: string, problem: string): ConversionFailedError {
  return new ConversionFailedError(`Invalid XLSX worksheet '${sheetName}': ${problem}.`);
}

/**
 * A worksheet split at its cell data (ECMA-376 Part 1, 18.3.1.99: `cols` comes before `sheetData`, the merged ranges and links after it).
 * The column definitions are looked for before the cell data and the rows inside it, so that neither scan walks the lists that follow,
 * which a hostile sheet fills with millions of elements. SheetJS splits a worksheet the same way (xlsx 0.18.5, `parse_ws_xml`,
 * xlsx.js lines 14527 to 14532, with `cols` read from the part before the cell data at lines 14552 to 14556). A sheet with no
 * `sheetData` is scanned whole.
 */
function splitWorksheetAtCells(sheetXml: string): { beforeCells: string; cells: string } {
  const [sheetData] = safeExtractXmlElements(sheetXml, 'sheetData', { maxElements: 1 });
  if (!sheetData) return { beforeCells: sheetXml, cells: sheetXml };
  return { beforeCells: sheetXml.slice(0, sheetData.startIndex), cells: sheetData.content };
}

/** The widths in points of the columns a worksheet sets, by zero-based column: `<cols><col min="1" max="1" width="15" customWidth="1"/></cols>`. */
function readColumnWidths(sheetXml: string, sheetName: string): number[] {
  const columnWidths: number[] = [];
  const [colsEl] = safeExtractXmlElements(sheetXml, 'cols', { maxElements: 1 });
  if (!colsEl) return columnWidths;
  for (const cl of safeExtractXmlElements(colsEl.content, 'col')) {
    if (cl.attrs.min && cl.attrs.max && cl.attrs.width) {
      const min = parseInt(cl.attrs.min, 10) - 1;
      const max = parseInt(cl.attrs.max, 10) - 1;
      const ptWidth = Math.round(parseFloat(cl.attrs.width) * 7.5);
      if (max >= XLSX_MAX_COLUMNS) throw worksheetBoundError(sheetName, `column ${max + 1} is past the last column of a worksheet (${XLSX_LAST_COLUMN_NAME})`);
      for (let c = min; c <= max; c++) {
        columnWidths[c] = ptWidth;
      }
    }
  }
  return columnWidths;
}

/** Every row element of a worksheet, up to the most a worksheet holds; one more is past the last row of any worksheet. */
function worksheetRowElements(sheetXml: string, sheetName: string): SafeXmlElement[] {
  const rows = safeExtractXmlElements(sheetXml, 'row', { maxElements: XLSX_MAX_ROWS + 1 });
  if (rows.length > XLSX_MAX_ROWS) throw worksheetBoundError(sheetName, `it has more than ${XLSX_MAX_ROWS} rows, the last row of a worksheet`);
  return rows;
}

/** The column widths of a worksheet and its row elements, each looked for only where the schema puts it. */
export function readWorksheetStructure(sheetXml: string, sheetName: string): { columnWidths: number[]; rowEls: SafeXmlElement[] } {
  const { beforeCells, cells } = splitWorksheetAtCells(sheetXml);
  return { columnWidths: readColumnWidths(beforeCells, sheetName), rowEls: worksheetRowElements(cells, sheetName) };
}
