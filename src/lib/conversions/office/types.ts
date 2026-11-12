import { type Matrix2D } from './affine';

export interface DocxRun {
  text: string;
  isBold: boolean;
  isItalic: boolean;
  isUnderline: boolean;
  isStrike: boolean;
  color?: string;
  fontSize?: number;
}

export interface DocxParagraph {
  text: string;
  runs?: DocxRun[];
  isHeading?: boolean;
  headingLevel?: number;
  isBold?: boolean;
  isItalic?: boolean;
  alignment?: 'left' | 'center' | 'right' | 'both';
  isBullet?: boolean;
}

export interface TableBorder {
  style?: string; // solid, dashed, dotted, double, none
  size?: number; // in pt
  color?: string; // hex color e.g. #CCD2FC
}

export interface DocxTableCell {
  text: string;
  fullCellText?: string;
  shading?: string;
  isHeader?: boolean;
  colSpan?: number;
  rowSpan?: number;
  alignment?: 'left' | 'center' | 'right';
  borders?: {
    top?: TableBorder;
    bottom?: TableBorder;
    left?: TableBorder;
    right?: TableBorder;
  };
  nestedTable?: DocxTable;
  nestedTables?: DocxTable[];
}

/**
 * Returns complete text representation of a cell including nested tables.
 */
export function getFullDocxCellText(cell: DocxTableCell): string {
  if (cell.fullCellText && cell.fullCellText.trim().length > 0) {
    return cell.fullCellText;
  }
  if (cell.nestedTables && cell.nestedTables.length > 0) {
    const nestedRowsText = cell.nestedTables.flatMap((t) => t.rows.map((r) => r.join(' | '))).join('\n');
    return cell.text ? `${cell.text}\n${nestedRowsText}` : nestedRowsText;
  }
  if (cell.nestedTable && cell.nestedTable.rows.length > 0) {
    const nestedRowsText = cell.nestedTable.rows.map((r) => r.join(' | ')).join('\n');
    return cell.text ? `${cell.text}\n${nestedRowsText}` : nestedRowsText;
  }
  return cell.text || '';
}

export interface DocxTable {
  rowCount?: number;
  colCount?: number;
  colWidths?: number[];
  rows: string[][];
  structuredRows?: DocxTableCell[][];
  tblBorders?: {
    top?: TableBorder;
    bottom?: TableBorder;
    left?: TableBorder;
    right?: TableBorder;
    insideH?: TableBorder;
    insideV?: TableBorder;
  };
}

export interface OpenXmlChartSeries {
  name: string;
  values: number[];
  categories?: string[];
  color?: string;
}

export interface OpenXmlChartData {
  type: 'bar' | 'line' | 'pie' | 'area' | 'doughnut' | 'scatter';
  title?: string;
  /** Titles of the value axis and of the category axis, where the chart has them. */
  valueAxisTitle?: string;
  categoryAxisTitle?: string;
  categories: string[];
  series: OpenXmlChartSeries[];
}

export interface DrawingMlShape {
  id?: string;
  name?: string;
  type?: string;
  geomType: 'preset' | 'custom';
  presetGeom?: string;
  customPath?: string;
  svgPath?: string;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation?: number;
  flipH?: boolean;
  flipV?: boolean;
  fillColor?: string;
  strokeColor?: string;
  strokeWidth?: number;
  text?: string;
  fontSize?: number;
  fontColor?: string;
  bold?: boolean;
  adjustValues?: Record<string, number>;
  guides?: Record<string, number>;
  chart?: OpenXmlChartData;
  chartSvg?: string;
  transformMatrix?: Matrix2D;
}

export type DocxBlockElement =
  | { type: 'paragraph'; paragraph: DocxParagraph }
  | { type: 'table'; table: DocxTable }
  | { type: 'drawing'; svg: string; shapes?: DrawingMlShape[]; chart?: OpenXmlChartData };

export interface OfficeWorksheetCell {
  value: string;
  formattedValue?: string;
  type?: string;
  isHeader?: boolean;
  bold?: boolean;
  italic?: boolean;
  fontSize?: number;
  fontColor?: string;
  fillColor?: string;
  borderColor?: string;
  align?: 'left' | 'center' | 'right';
}

/** A rectangle of cells, its first and last rows and columns counted from zero. */
export interface OfficeCellRange {
  startRow: number;
  endRow: number;
  startCol: number;
  endCol: number;
}

export type OfficeWorksheetPrintArea = OfficeCellRange;

/** A hyperlink of a cell: the URL it opens, or `#` and the location in the workbook it jumps to. Rows and columns count from zero. */
export interface OfficeWorksheetHyperlink {
  row: number;
  col: number;
  target: string;
}

export interface OfficeWorksheet {
  name: string;
  rows: string[][];
  /** The merged ranges of the sheet, absent when it has none. The value of a merged range is in its first cell. */
  mergedRanges?: OfficeCellRange[];
  /** The hyperlinks of the sheet's cells, absent when it has none. */
  hyperlinks?: OfficeWorksheetHyperlink[];
  /** The charts the sheet's drawing holds, in the order the drawing places them. */
  charts?: OpenXmlChartData[];
  structuredRows?: OfficeWorksheetCell[][];
  columnWidths?: number[];
  printArea?: OfficeWorksheetPrintArea;
}
