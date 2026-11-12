import { type OfficeWorksheet, type OfficeWorksheetCell, type OfficeWorksheetPrintArea } from './types';

/**
 * Parses an Excel A1 reference or range string into 0-based boundary coordinates.
 * Supports: 'Sheet1!$B$2:$C$3', ''Sheet 1'!$B$2:$C$3', '$B$2:$C$3', 'B2:C3', '$B$2'.
 */
export function parseA1Range(rangeStr: string): {
  sheetName?: string;
  startRow: number;
  endRow: number;
  startCol: number;
  endCol: number;
} | null {
  if (!rangeStr || typeof rangeStr !== 'string') return null;
  const trimmed = rangeStr.trim();
  if (trimmed === '') return null;

  let sheetName: string | undefined;
  let cellRange = trimmed;

  const bangIdx = trimmed.indexOf('!');
  if (bangIdx !== -1) {
    let rawSheet = trimmed.slice(0, bangIdx).trim();
    if ((rawSheet.startsWith("'") && rawSheet.endsWith("'")) || (rawSheet.startsWith('"') && rawSheet.endsWith('"'))) {
      rawSheet = rawSheet.slice(1, -1);
    }
    sheetName = rawSheet;
    cellRange = trimmed.slice(bangIdx + 1).trim();
  }

  // Range may have multiple comma-separated areas; take the first area
  const firstArea = cellRange.split(',')[0].trim();
  const parts = firstArea.split(':');

  const parseCellCoord = (cell: string): { col: number; row: number } | null => {
    const clean = cell.replace(/\$/g, '').trim().toUpperCase();
    const match = clean.match(/^([A-Z]+)(\d+)$/);
    if (!match) return null;
    return {
      col: getExcelColumnIndex(match[1]),
      row: parseInt(match[2], 10) - 1,
    };
  };

  const startCoord = parseCellCoord(parts[0]);
  if (!startCoord) return null;

  const endCoord = parts.length > 1 ? parseCellCoord(parts[1]) : startCoord;
  if (!endCoord) return null;

  return {
    sheetName,
    startRow: Math.min(startCoord.row, endCoord.row),
    endRow: Math.max(startCoord.row, endCoord.row),
    startCol: Math.min(startCoord.col, endCoord.col),
    endCol: Math.max(startCoord.col, endCoord.col),
  };
}

/**
 * Slices worksheet rows and columns down to specified print area rectangular bounds.
 */
export function sliceWorksheetToRange(
  sheet: OfficeWorksheet,
  range: OfficeWorksheetPrintArea
): OfficeWorksheet {
  const { startRow, endRow, startCol, endCol } = range;
  const slicedRows: string[][] = [];
  const slicedStructuredRows: OfficeWorksheetCell[][] = [];

  for (let r = startRow; r <= endRow; r++) {
    const origRow = sheet.rows[r] || [];
    const newRow: string[] = [];
    for (let c = startCol; c <= endCol; c++) {
      newRow.push(origRow[c] ?? '');
    }
    slicedRows.push(newRow);

    if (sheet.structuredRows) {
      const origStructRow = sheet.structuredRows[r] || [];
      const newStructRow: OfficeWorksheetCell[] = [];
      for (let c = startCol; c <= endCol; c++) {
        newStructRow.push(origStructRow[c] ?? { value: '' });
      }
      slicedStructuredRows.push(newStructRow);
    }
  }

  let slicedWidths: number[] | undefined;
  if (sheet.columnWidths) {
    slicedWidths = sheet.columnWidths.slice(startCol, endCol + 1);
  }

  return {
    name: sheet.name,
    rows: slicedRows,
    structuredRows: sheet.structuredRows ? slicedStructuredRows : undefined,
    columnWidths: slicedWidths,
    printArea: sheet.printArea,
  };
}

/**
 * Sanitizes worksheet name for safe filesystem and archive entry usage.
 */
export function sanitizeSheetName(name: string): string {
  const sanitized = name.replace(/[/\\:*?"<>|\x00-\x1f]/g, '_').trim();
  return sanitized.length > 0 ? sanitized : 'sheet';
}

/**
 * Formats a CSV cell conforming to RFC 4180 Section 2.6 (quotes cells with delimiter, quotes, CR, or LF).
 */
export function formatCsvCell(cell: string, delimiter: string): string {
  if (cell.includes(delimiter) || cell.includes('"') || cell.includes('\n') || cell.includes('\r')) {
    return `"${cell.replace(/"/g, '""')}"`;
  }
  return cell;
}

/**
 * Inverse Bijective Base-26 column index calculation ('A' -> 0, 'Z' -> 25, 'AA' -> 26, 'C' -> 2, etc.)
 */
export function getExcelColumnIndex(colLetters: string): number {
  let idx = 0;
  const upper = colLetters.toUpperCase();
  for (let i = 0; i < upper.length; i++) {
    const code = upper.charCodeAt(i);
    if (code >= 65 && code <= 90) {
      idx = idx * 26 + (code - 64);
    }
  }
  return Math.max(0, idx - 1);
}
