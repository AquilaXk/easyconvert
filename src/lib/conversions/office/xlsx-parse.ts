import JSZip from 'jszip';
import { SaxesParser } from 'saxes';
import { newRelationshipAllowance, readPartRelationships, type OpcReadOptions } from './opc-parts';
import { readZipEntryText } from '../zip-entry-reader';
import { InflateBudget } from '../bounded-inflate';
import { XLSX_LAST_COLUMN_NAME, XLSX_MAX_COLUMNS, XLSX_MAX_MATERIALISED_CELLS, XLSX_MAX_ROWS } from './sheet-bounds';
import { safeDecodeXmlEntities, safeExtractXmlElements } from '../safe-xml-scanner';
import { withoutElements } from './xml-without';
import { ConversionFailedError, DataParseError, PayloadLimitError } from '../../types';
import { openOpcPackage } from '../package-access';
import { XLSX_MAX_RANGES_PER_WORKBOOK, XLSX_NO_WORKSHEETS_MESSAGE, discoverXlsxSheets } from './xlsx-sheets';
import { XLSX_MAX_CELL_TEXT_CHARS_ENV, xlsxMaxCellTextChars } from './spreadsheet-limits';
import { XML_TREE_MAX_DEPTH } from '../xml-tree';
import { worksheetBoundError } from './xlsx-worksheet-structure';
import { type OfficeCellRange, type OfficeWorksheet, type OfficeWorksheetCell, type OfficeWorksheetHyperlink, type OfficeWorksheetPrintArea, type OpenXmlChartData } from './types';
import { parseOpenXmlChart } from './chart-parse';
import { DATE_SYSTEM_1900, DATE_SYSTEM_1904, type SpreadsheetDateSystem, formatSpreadsheetCellValue } from './spreadsheet-format';
import { safeExtractAllText, safeExtractFirstXmlElement } from './xml-helpers';
import { parseA1Range } from './spreadsheet-ranges';
import { SpreadsheetDagEngine } from './spreadsheet-formula';

/** The charts of the drawings a worksheet shows (worksheet to drawing to chart parts), in the order each drawing places them. */
async function readWorksheetCharts(zip: JSZip, drawingParts: readonly string[], options: OpcReadOptions): Promise<OpenXmlChartData[]> {
  const charts: OpenXmlChartData[] = [];
  for (const drawingPart of drawingParts) {
    const drawingFile = zip.file(drawingPart);
    if (!drawingFile) continue;
    const drawingXml = await readZipEntryText(drawingFile, { budget: options.budget });
    const chartIds = [...drawingXml.matchAll(/<(?:\w+:)?chart\b[^>]*?\br:id="([^"]+)"/g)].map((match) => match[1]);
    if (chartIds.length === 0) continue;
    const wanted = new Set(chartIds);
    const references = await readPartRelationships(zip, drawingPart, options, (id, _type, external) => !external && wanted.has(id));
    for (const chartId of chartIds) {
      const chartFile = zip.file(references.get(chartId)?.target ?? '');
      const chart = chartFile ? parseOpenXmlChart(await readZipEntryText(chartFile, { budget: options.budget })) : null;
      if (chart) charts.push(chart);
    }
  }
  return charts;
}

/**
 * The phonetic guides (`rPh` runs, ECMA-376 Part 1, 18.4.6) of a rich-text string are readings written beside the text and not part of it:
 * openpyxl's `Text.content` joins `t` and the runs' `t` only (openpyxl 3.1.5, cell/text.py lines 173 to 184), and SheetJS drops every `rPh`
 * with one global replace (xlsx 0.18.5, `parse_si`, xlsx.js line 9470).
 */
const PHONETIC_RUN = 'rPh';

/** The date system of a workbook: 1904 when `workbookPr` says `date1904` (an ST_Boolean: "1" or "true"), else 1900. */
function readDateSystem(workbookXml: string): SpreadsheetDateSystem {
  const date1904 = safeExtractFirstXmlElement(workbookXml, 'workbookPr')?.attrs.date1904;
  return date1904 === '1' || date1904 === 'true' ? DATE_SYSTEM_1904 : DATE_SYSTEM_1900;
}

interface RawSheetLink {
  row: number;
  col: number;
  id: string | undefined;
  location: string | undefined;
}

interface ParsedCellStyle {
  numFmtId?: number;
  font?: { bold?: boolean; italic?: boolean; size?: number; color?: string };
  fillColor?: string;
  hasBorder?: boolean;
  align?: 'left' | 'center' | 'right';
}

interface WorkbookStyleContext {
  sharedStrings: readonly string[];
  styleNumFmtMap: ReadonlyMap<number, number>;
  customNumFmtMap: ReadonlyMap<number, string>;
  cellStylesMap: ReadonlyMap<number, ParsedCellStyle>;
  dateSystem: SpreadsheetDateSystem;
}

interface WorkbookBudgets {
  maxCellTextChars: number;
  expandedTextChars: number;
  materialisedCells: number;
  rangesHeld: number;
}

interface ParsedWorksheetResult {
  rows: string[][];
  structuredRows: OfficeWorksheetCell[][];
  columnWidths: number[];
  mergedRanges: OfficeCellRange[];
  rawLinks: RawSheetLink[];
  wantedIds: Set<string>;
}

const SHEET_DATA_TAG_RE = /<(?:\w+:)?sheetData[\s/>]/;

function localXmlName(name: string): string {
  const colon = name.indexOf(':');
  return colon === -1 ? name : name.slice(colon + 1);
}

function normalizeUpperCellRef(rawRef: string | undefined): string {
  if (!rawRef) return '';
  for (let i = 0; i < rawRef.length; i++) {
    const ch = rawRef.charCodeAt(i);
    if (ch >= 97 && ch <= 122) return rawRef.toUpperCase();
  }
  return rawRef;
}

function parseCellColumnIndex(ref: string, fallbackCol: number, sheetName: string): number {
  if (ref.length < 2) return fallbackCol;
  let i = 0;
  let acc = 0;
  while (i < ref.length) {
    const ch = ref.charCodeAt(i);
    if (ch < 65 || ch > 90) break;
    acc = acc * 26 + (ch - 64);
    i++;
  }
  if (i === 0 || i >= ref.length) return fallbackCol;
  const digit = ref.charCodeAt(i);
  if (digit < 48 || digit > 57) return fallbackCol;
  const colIdx = acc - 1;
  if (colIdx >= XLSX_MAX_COLUMNS) {
    throw worksheetBoundError(
      sheetName,
      `column ${ref.slice(0, i)} is past the last column of a worksheet (${XLSX_LAST_COLUMN_NAME})`
    );
  }
  return colIdx;
}

function chargeMaterialisedCells(budgets: WorkbookBudgets, count: number): void {
  if (count <= 0) return;
  budgets.materialisedCells += count;
  if (budgets.materialisedCells > XLSX_MAX_MATERIALISED_CELLS) {
    throw new PayloadLimitError(
      `The XLSX sheets hold more than ${XLSX_MAX_MATERIALISED_CELLS} cells, the empty cells and rows that pad a sparse sheet included.`
    );
  }
}

function applyColElement(attrs: Record<string, string>, columnWidths: number[], sheetName: string): void {
  if (!attrs.min || !attrs.max || !attrs.width) return;
  const min = Number.parseInt(attrs.min, 10) - 1;
  const max = Number.parseInt(attrs.max, 10) - 1;
  const ptWidth = Math.round(Number.parseFloat(attrs.width) * 7.5);
  if (max >= XLSX_MAX_COLUMNS) {
    throw worksheetBoundError(sheetName, `column ${max + 1} is past the last column of a worksheet (${XLSX_LAST_COLUMN_NAME})`);
  }
  for (let c = min; c <= max; c++) columnWidths[c] = ptWidth;
}

function recordSheetAnnotation(
  local: string,
  attrs: Record<string, string>,
  mergedRanges: OfficeCellRange[],
  rawLinks: RawSheetLink[],
  wantedIds: Set<string>
): void {
  if (local === 'mergeCell') {
    const range = parseA1Range(attrs.ref ?? '');
    if (range) {
      mergedRanges.push({
        startRow: range.startRow,
        endRow: range.endRow,
        startCol: range.startCol,
        endCol: range.endCol,
      });
    }
    return;
  }
  const cell = parseA1Range(attrs.ref ?? '');
  const id = attrs['r:id'];
  const location = attrs.location;
  if (!cell || (id === undefined && location === undefined)) return;
  if (id !== undefined) wantedIds.add(id);
  rawLinks.push({ row: cell.startRow, col: cell.startCol, id, location });
}

interface ActiveCellState {
  active: boolean;
  type: string;
  ref: string;
  styleIdx: number | undefined;
  colIdx: number;
  inV: boolean;
  hasV: boolean;
  vText: string;
  inF: boolean;
  hasF: boolean;
  fText: string;
  inIs: boolean;
  hasIs: boolean;
  isTTally: number;
  isTText: string;
  isFallbackText: string;
  inT: boolean;
  hasDirectT: boolean;
  directTText: string;
  rPhDepth: number;
}

function createEmptyCellState(): ActiveCellState {
  return {
    active: false,
    type: '',
    ref: '',
    styleIdx: undefined,
    colIdx: 0,
    inV: false,
    hasV: false,
    vText: '',
    inF: false,
    hasF: false,
    fText: '',
    inIs: false,
    hasIs: false,
    isTTally: 0,
    isTText: '',
    isFallbackText: '',
    inT: false,
    hasDirectT: false,
    directTText: '',
    rPhDepth: 0,
  };
}

function resetCellState(
  cell: ActiveCellState,
  attrs: Record<string, string>,
  nextColIdx: number,
  sheetName: string
): void {
  const ref = normalizeUpperCellRef(attrs.r);
  cell.active = true;
  cell.type = attrs.t ?? '';
  cell.ref = ref;
  cell.styleIdx = attrs.s !== undefined ? Number.parseInt(attrs.s, 10) : undefined;
  cell.colIdx = parseCellColumnIndex(ref, nextColIdx, sheetName);
  cell.inV = false;
  cell.hasV = false;
  cell.vText = '';
  cell.inF = false;
  cell.hasF = false;
  cell.fText = '';
  cell.inIs = false;
  cell.hasIs = false;
  cell.isTTally = 0;
  cell.isTText = '';
  cell.isFallbackText = '';
  cell.inT = false;
  cell.hasDirectT = false;
  cell.directTText = '';
  cell.rPhDepth = 0;
}

function resolveCellTextValue(cell: ActiveCellState, ctx: WorkbookStyleContext): string {
  if (cell.type === 'inlineStr') {
    if (cell.hasIs) return cell.isTTally > 0 ? cell.isTText : cell.isFallbackText;
    return cell.hasDirectT ? cell.directTText : '';
  }
  if (cell.type === 'b' && cell.hasV) {
    return cell.vText === '1' ? 'TRUE' : 'FALSE';
  }
  if (cell.hasV) {
    if (cell.type === 's') {
      const strIdx = Number.parseInt(cell.vText, 10);
      return ctx.sharedStrings[strIdx] ?? '';
    }
    const numFmtId = cell.styleIdx !== undefined ? ctx.styleNumFmtMap.get(cell.styleIdx) : undefined;
    const customFmt = numFmtId !== undefined ? ctx.customNumFmtMap.get(numFmtId) : undefined;
    return formatSpreadsheetCellValue(cell.vText, numFmtId, customFmt, ctx.dateSystem);
  }
  return cell.hasDirectT ? cell.directTText : '';
}

function buildStructuredCell(cellValue: string, style: ParsedCellStyle | undefined): OfficeWorksheetCell {
  const isNum = !Number.isNaN(Number(cellValue)) && cellValue.trim() !== '';
  const align = style?.align || (isNum ? 'right' : 'left');
  return {
    value: cellValue,
    bold: style?.font?.bold,
    italic: style?.font?.italic,
    fontSize: style?.font?.size,
    fontColor: style?.font?.color,
    fillColor: style?.fillColor,
    borderColor: style?.hasBorder ? '#CBD5E1' : undefined,
    align,
  };
}

function handleCellChildOpen(cell: ActiveCellState, local: string): void {
  if (local === PHONETIC_RUN) {
    cell.rPhDepth += 1;
  } else if (cell.rPhDepth > 0) {
    return;
  } else if (local === 'v' && !cell.hasV) {
    cell.inV = true;
    cell.hasV = true;
  } else if (local === 'f' && !cell.hasF) {
    cell.inF = true;
    cell.hasF = true;
  } else if (local === 'is' && !cell.hasIs) {
    cell.inIs = true;
    cell.hasIs = true;
  } else if (local === 't') {
    cell.inT = true;
    if (cell.inIs) cell.isTTally += 1;
    else if (!cell.hasDirectT) cell.hasDirectT = true;
  }
}

function handleCellChildClose(cell: ActiveCellState, local: string): void {
  if (local === PHONETIC_RUN && cell.rPhDepth > 0) {
    cell.rPhDepth -= 1;
  } else if (local === 'v') {
    cell.inV = false;
  } else if (local === 'f') {
    cell.inF = false;
  } else if (local === 'is') {
    cell.inIs = false;
  } else if (local === 't') {
    cell.inT = false;
  }
}

function handleCellText(cell: ActiveCellState, text: string): void {
  if (cell.rPhDepth > 0) return;
  if (cell.inV) {
    cell.vText += text;
  } else if (cell.inF) {
    cell.fText += text;
  } else if (cell.inIs) {
    if (cell.inT) cell.isTText += text;
    cell.isFallbackText += text;
  } else if (cell.inT) {
    cell.directTText += text;
  }
}

/**
 * Single-pass event-driven worksheet XML parser using `saxes`. Validates XML 1.0 well-formedness,
 * nesting depth, row/column/materialised-cell/expanded-text bounds, column widths, inline/shared/formatted
 * cells, formulas, merged ranges, and hyperlinks in one scan without intermediate DOM or substring slicing.
 */
function parseWorksheetXml(
  sheetXml: string,
  partPath: string,
  sheetName: string,
  ctx: WorkbookStyleContext,
  budgets: WorkbookBudgets
): ParsedWorksheetResult {
  const parser = new SaxesParser({ xmlns: false, position: true, defaultXMLVersion: '1.0', forceXMLVersion: true });
  const hasSheetData = SHEET_DATA_TAG_RE.test(sheetXml);
  const rows: string[][] = [];
  const structuredRows: OfficeWorksheetCell[][] = [];
  const columnWidths: number[] = [];
  const mergedRanges: OfficeCellRange[] = [];
  const rawLinks: RawSheetLink[] = [];
  const wantedIds = new Set<string>();
  const cellMap: Record<string, string | number> = {};
  const formulaCells: Array<{ ref: string; formula: string; rowIdx: number; colIdx: number }> = [];
  const allowance = XLSX_MAX_RANGES_PER_WORKBOOK - budgets.rangesHeld;

  let depth = 0;
  let seenSheetData = false;
  let sheetDataDepth = 0;
  let afterSheetData = false;
  let colsBlocksSeen = 0;
  let inFirstCols = false;
  let rowElementsSeen = 0;
  let inRow = false;
  let currentRowCells: string[] = [];
  let currentRowStructured: OfficeWorksheetCell[] = [];
  let currentRowIdx = 0;
  let nextColIdx = 0;
  let annotationsUsed = 0;
  const cell = createEmptyCellState();

  const openRow = (attrs: Record<string, string>): void => {
    rowElementsSeen += 1;
    if (rowElementsSeen > XLSX_MAX_ROWS) {
      throw worksheetBoundError(sheetName, `it has more than ${XLSX_MAX_ROWS} rows, the last row of a worksheet`);
    }
    if (attrs.r) {
      const targetRowIdx = Number.parseInt(attrs.r, 10) - 1;
      if (targetRowIdx >= XLSX_MAX_ROWS) {
        throw worksheetBoundError(sheetName, `row ${targetRowIdx + 1} is past the last row of a worksheet (${XLSX_MAX_ROWS})`);
      }
      chargeMaterialisedCells(budgets, targetRowIdx - rows.length);
      while (rows.length < targetRowIdx) {
        rows.push(XLSX_EMPTY_ROW);
        structuredRows.push(XLSX_EMPTY_STRUCTURED_ROW);
      }
    }
    chargeMaterialisedCells(budgets, 1);
    inRow = true;
    currentRowCells = [];
    currentRowStructured = [];
    currentRowIdx = rows.length;
    nextColIdx = 0;
  };

  const closeCell = (): void => {
    cell.active = false;
    chargeMaterialisedCells(budgets, cell.colIdx + 1 - currentRowCells.length);
    while (currentRowCells.length < cell.colIdx) {
      currentRowCells.push('');
      currentRowStructured.push({ value: '' });
    }
    const cellValue = resolveCellTextValue(cell, ctx);
    budgets.expandedTextChars += cellValue.length;
    if (budgets.expandedTextChars > budgets.maxCellTextChars) {
      throw new PayloadLimitError(
        `The XLSX cells expand to more than ${budgets.maxCellTextChars} characters (${XLSX_MAX_CELL_TEXT_CHARS_ENV}).`
      );
    }
    if (cell.ref) cellMap[cell.ref] = cellValue;
    if (cell.hasF && (!cellValue || cellValue.trim() === '')) {
      formulaCells.push({ ref: cell.ref, formula: cell.fText, rowIdx: currentRowIdx, colIdx: cell.colIdx });
    }
    currentRowCells[cell.colIdx] = cellValue;
    const style = cell.styleIdx !== undefined ? ctx.cellStylesMap.get(cell.styleIdx) : undefined;
    currentRowStructured[cell.colIdx] = buildStructuredCell(cellValue, style);
    nextColIdx = cell.colIdx + 1;
  };

  parser.on('error', (err) => {
    throw new DataParseError(`Invalid XLSX package: ${partPath} is not well-formed XML (${err.message}).`, {
      line: parser.line,
      column: parser.column + 1,
    });
  });

  parser.on('opentag', (tag) => {
    depth += 1;
    if (depth > XML_TREE_MAX_DEPTH) {
      throw new PayloadLimitError(`${partPath} nests elements deeper than ${XML_TREE_MAX_DEPTH} levels.`);
    }
    const local = localXmlName(tag.name);
    const attrs = tag.attributes as Record<string, string>;

    if (cell.active) {
      handleCellChildOpen(cell, local);
    } else if (inRow) {
      if (local === 'c') resetCellState(cell, attrs, nextColIdx, sheetName);
    } else if (local === 'sheetData') {
      seenSheetData = true;
      sheetDataDepth += 1;
    } else if (local === 'row' && (!hasSheetData || sheetDataDepth === 1)) {
      openRow(attrs);
    } else if (local === 'cols' && (!hasSheetData || !seenSheetData)) {
      colsBlocksSeen += 1;
      if (colsBlocksSeen === 1) inFirstCols = true;
    } else if (inFirstCols && local === 'col') {
      applyColElement(attrs, columnWidths, sheetName);
    } else if ((local === 'mergeCell' || local === 'hyperlink') && (!hasSheetData || afterSheetData)) {
      if (annotationsUsed < allowance) {
        annotationsUsed += 1;
        recordSheetAnnotation(local, attrs, mergedRanges, rawLinks, wantedIds);
      }
    }
  });

  parser.on('closetag', (tag) => {
    depth -= 1;
    const local = localXmlName(tag.name);
    if (cell.active) {
      if (local === 'c' && cell.rPhDepth === 0 && !cell.inIs) closeCell();
      else handleCellChildClose(cell, local);
    } else if (inRow && local === 'row') {
      inRow = false;
      rows.push(currentRowCells);
      structuredRows.push(currentRowStructured);
    } else if (local === 'sheetData' && sheetDataDepth > 0) {
      sheetDataDepth -= 1;
      if (sheetDataDepth === 0) afterSheetData = true;
    } else if (inFirstCols && local === 'cols') {
      inFirstCols = false;
    }
  });

  const onCharData = (text: string): void => {
    if (cell.active) handleCellText(cell, text);
  };
  parser.on('text', onCharData);
  parser.on('cdata', onCharData);

  parser.write(sheetXml).close();
  budgets.rangesHeld += annotationsUsed;

  if (formulaCells.length > 0) {
    const dagEngine = new SpreadsheetDagEngine(cellMap);
    dagEngine.evaluateWithDag(formulaCells, rows);
    for (const fc of formulaCells) {
      if (structuredRows[fc.rowIdx] && structuredRows[fc.rowIdx][fc.colIdx]) {
        structuredRows[fc.rowIdx][fc.colIdx].value = rows[fc.rowIdx][fc.colIdx] || '';
      }
    }
  }

  return { rows, structuredRows, columnWidths, mergedRanges, rawLinks, wantedIds };
}

async function resolveSheetRelationships(
  zip: JSZip,
  sheetPath: string,
  wantedIds: ReadonlySet<string>,
  rawLinks: readonly RawSheetLink[],
  options: OpcReadOptions
): Promise<{ hyperlinks: OfficeWorksheetHyperlink[]; drawingParts: string[] }> {
  const related = await readPartRelationships(
    zip,
    sheetPath,
    options,
    (id, type, external) => (external ? wantedIds.has(id) : type.endsWith('/drawing'))
  );
  const hyperlinks: OfficeWorksheetHyperlink[] = [];
  for (const { row, col, id, location } of rawLinks) {
    const linked = id === undefined ? undefined : related.get(id);
    const target = (linked?.external ? linked.target : undefined) ?? (location === undefined ? undefined : `#${location}`);
    if (target !== undefined) hyperlinks.push({ row, col, target });
  }
  const drawingParts: string[] = [];
  for (const relationship of related.values()) {
    if (!relationship.external) drawingParts.push(relationship.target);
  }
  return { hyperlinks, drawingParts };
}

/**
 * The strings of `xl/sharedStrings.xml` in index order; a rich-text string is its runs joined, without phonetic guides. SheetJS
 * (`parse_sst_xml`, xlsx.js lines 9482 to 9496) and openpyxl (`read_string_table`, reader/strings.py lines 10 to 24) read every
 * item; here the items count against the cells the reader builds for a workbook, since no sheet can show more strings than it has
 * cells, and a table past that is refused (413) rather than cut. The items are handed to the list one at a time as the scanner finds
 * them; the list itself is held whole, bounded by that count and not by bytes.
 */
async function readSharedStrings(zip: JSZip, budget?: InflateBudget): Promise<string[]> {
  const sstFile = zip.file('xl/sharedStrings.xml');
  if (!sstFile) return [];
  const sstXml = await readZipEntryText(sstFile, { budget });
  const strings: string[] = [];
  const limit = { maxElements: XLSX_MAX_MATERIALISED_CELLS + 1 };
  safeExtractXmlElements(sstXml, 'si', { ...limit, onElement: (si) => strings.push(safeExtractAllText(withoutElements(si.content, PHONETIC_RUN), 't')) });
  if (strings.length === 0) safeExtractXmlElements(sstXml, 't', { ...limit, onElement: (t) => strings.push(safeDecodeXmlEntities(t.content)) });
  if (strings.length > XLSX_MAX_MATERIALISED_CELLS) {
    throw new PayloadLimitError(`The XLSX shared string table holds more than ${XLSX_MAX_MATERIALISED_CELLS} strings, more than the cells a workbook is read with.`);
  }
  return strings;
}

function extractCustomNumFmts(stylesXml: string, customNumFmtMap: Map<number, string>): void {
  const numFmtsEl = safeExtractFirstXmlElement(stylesXml, 'numFmts');
  const numFmtEls = safeExtractXmlElements(numFmtsEl ? numFmtsEl.content : stylesXml, 'numFmt');
  for (const nfEl of numFmtEls) {
    const rawId = nfEl.attrs.numFmtId;
    const rawCode = nfEl.attrs.formatCode;
    if (rawId !== undefined && rawCode !== undefined) {
      const parsedId = Number.parseInt(rawId, 10);
      if (!Number.isNaN(parsedId)) customNumFmtMap.set(parsedId, rawCode);
    }
  }
}

function parseStylesPart(
  stylesXml: string,
  styleNumFmtMap: Map<number, number>,
  customNumFmtMap: Map<number, string>,
  cellStylesMap: Map<number, ParsedCellStyle>
): void {
  extractCustomNumFmts(stylesXml, customNumFmtMap);

  const parsedFonts: Array<{ bold?: boolean; italic?: boolean; size?: number; color?: string }> = [];
  const fontsEl = safeExtractFirstXmlElement(stylesXml, 'fonts');
  if (fontsEl) {
    for (const fontEl of safeExtractXmlElements(fontsEl.content, 'font')) {
      const fBody = fontEl.content;
      const isBold = /<b\b/i.test(fBody);
      const isItalic = /<i\b/i.test(fBody);
      const szEl = safeExtractFirstXmlElement(fBody, 'sz');
      const sz = szEl?.attrs.val ? Number.parseFloat(szEl.attrs.val) : undefined;
      const clrEl = safeExtractFirstXmlElement(fBody, 'color');
      const rawClr = clrEl?.attrs.rgb;
      const color = rawClr ? '#' + (rawClr.length === 8 ? rawClr.slice(2) : rawClr) : undefined;
      parsedFonts.push({ bold: isBold, italic: isItalic, size: sz, color });
    }
  }

  const parsedFills: Array<{ fillColor?: string }> = [];
  const fillsEl = safeExtractFirstXmlElement(stylesXml, 'fills');
  if (fillsEl) {
    for (const fillEl of safeExtractXmlElements(fillsEl.content, 'fill')) {
      const rawClr = safeExtractFirstXmlElement(fillEl.content, 'fgColor')?.attrs.rgb;
      const fillColor = rawClr ? '#' + (rawClr.length === 8 ? rawClr.slice(2) : rawClr) : undefined;
      parsedFills.push({ fillColor });
    }
  }

  const parsedBorders: Array<{ hasBorder?: boolean }> = [];
  const bordersEl = safeExtractFirstXmlElement(stylesXml, 'borders');
  if (bordersEl) {
    for (const borderEl of safeExtractXmlElements(bordersEl.content, 'border')) {
      const hasBorder = /<(left|right|top|bottom)\s+style="(?!none)[^"]+"/i.test(borderEl.content);
      parsedBorders.push({ hasBorder });
    }
  }

  const cellXfsEl = safeExtractFirstXmlElement(stylesXml, 'cellXfs');
  if (!cellXfsEl) return;
  let xfIdx = 0;
  for (const xfEl of safeExtractXmlElements(cellXfsEl.content, 'xf')) {
    const xfAttrs = xfEl.attrs;
    const alignEl = safeExtractFirstXmlElement(xfEl.content || xfEl.raw, 'alignment');
    const hAlign = alignEl?.attrs.horizontal?.toLowerCase();
    const align = hAlign === 'left' || hAlign === 'center' || hAlign === 'right' ? hAlign : undefined;
    const numFmtVal = xfAttrs.numFmtId ? Number.parseInt(xfAttrs.numFmtId, 10) : undefined;
    if (numFmtVal !== undefined) styleNumFmtMap.set(xfIdx, numFmtVal);
    cellStylesMap.set(xfIdx, {
      numFmtId: numFmtVal,
      font: xfAttrs.fontId ? parsedFonts[Number.parseInt(xfAttrs.fontId, 10)] : undefined,
      fillColor: xfAttrs.fillId ? parsedFills[Number.parseInt(xfAttrs.fillId, 10)]?.fillColor : undefined,
      hasBorder: xfAttrs.borderId ? parsedBorders[Number.parseInt(xfAttrs.borderId, 10)]?.hasBorder : undefined,
      align,
    });
    xfIdx++;
  }
}

function readWorkbookPrintAreas(
  wbXml: string,
  byIndex: Map<number, OfficeWorksheetPrintArea>,
  byName: Map<string, OfficeWorksheetPrintArea>
): void {
  for (const dnEl of safeExtractXmlElements(wbXml, 'definedName')) {
    if (dnEl.attrs.name !== '_xlnm.Print_Area') continue;
    const parsed = parseA1Range(dnEl.content);
    if (!parsed) continue;
    const area: OfficeWorksheetPrintArea = {
      startRow: parsed.startRow,
      endRow: parsed.endRow,
      startCol: parsed.startCol,
      endCol: parsed.endCol,
    };
    if (dnEl.attrs.localSheetId !== undefined) {
      const sid = Number.parseInt(dnEl.attrs.localSheetId, 10);
      if (!Number.isNaN(sid)) byIndex.set(sid, area);
    }
    if (parsed.sheetName) byName.set(parsed.sheetName.toLowerCase(), area);
  }
}

/**
 * Parses all worksheets from an XLSX JSZip instance, discovering sheets from workbook.xml
 * and workbook.xml.rels, resolving shared strings, NumberFormats, and formulas.
 */
export async function parseAllXlsxWorksheets(zipOrBuffer: JSZip | Buffer | Uint8Array): Promise<OfficeWorksheet[]> {
  const zip =
    zipOrBuffer && typeof (zipOrBuffer as JSZip).file === 'function'
      ? (zipOrBuffer as JSZip)
      : await openOpcPackage(zipOrBuffer as Buffer | Uint8Array, 'XLSX');

  const partOptions = { budget: new InflateBudget(), relationships: newRelationshipAllowance() };
  const sharedStrings = await readSharedStrings(zip, partOptions.budget);

  const styleNumFmtMap = new Map<number, number>();
  const customNumFmtMap = new Map<number, string>();
  const cellStylesMap = new Map<number, ParsedCellStyle>();
  const stylesFile = zip.file('xl/styles.xml');
  if (stylesFile) {
    const stylesXml = await readZipEntryText(stylesFile, { budget: partOptions.budget });
    parseStylesPart(stylesXml, styleNumFmtMap, customNumFmtMap, cellStylesMap);
  }

  const { workbookXml: wbXml, sheets: sheetEntries } = await discoverXlsxSheets(zip, partOptions);
  if (sheetEntries.length === 0) throw new ConversionFailedError(XLSX_NO_WORKSHEETS_MESSAGE);

  const printAreaBySheetIndex = new Map<number, OfficeWorksheetPrintArea>();
  const printAreaBySheetName = new Map<string, OfficeWorksheetPrintArea>();
  let dateSystem = DATE_SYSTEM_1900;
  if (wbXml !== undefined) {
    dateSystem = readDateSystem(wbXml);
    readWorkbookPrintAreas(wbXml, printAreaBySheetIndex, printAreaBySheetName);
  }

  const styleCtx: WorkbookStyleContext = {
    sharedStrings,
    styleNumFmtMap,
    customNumFmtMap,
    cellStylesMap,
    dateSystem,
  };
  const budgets: WorkbookBudgets = {
    maxCellTextChars: xlsxMaxCellTextChars(),
    expandedTextChars: 0,
    materialisedCells: 0,
    rangesHeld: 0,
  };

  const allSheets: OfficeWorksheet[] = [];
  for (let entryIdx = 0; entryIdx < sheetEntries.length; entryIdx++) {
    const entry = sheetEntries[entryIdx];
    const printArea = printAreaBySheetIndex.get(entryIdx) || printAreaBySheetName.get(entry.name.toLowerCase());
    const sFile = zip.file(entry.path);
    if (!sFile) continue;

    const sheetXml = await readZipEntryText(sFile, { budget: partOptions.budget, maxBytes: partOptions.budget.limit });
    const parsed = parseWorksheetXml(sheetXml, entry.path, entry.name, styleCtx, budgets);
    const { hyperlinks, drawingParts } = await resolveSheetRelationships(
      zip,
      entry.path,
      parsed.wantedIds,
      parsed.rawLinks,
      partOptions
    );
    const charts = await readWorksheetCharts(zip, drawingParts, partOptions);

    allSheets.push({
      name: entry.name,
      rows: parsed.rows,
      structuredRows: parsed.structuredRows,
      ...(parsed.mergedRanges.length > 0 ? { mergedRanges: parsed.mergedRanges } : {}),
      ...(hyperlinks.length > 0 ? { hyperlinks } : {}),
      columnWidths: parsed.columnWidths.length > 0 ? parsed.columnWidths : undefined,
      printArea,
      ...(charts.length > 0 ? { charts } : {}),
    });
  }

  return allSheets;
}

/**
 * The row that pads a sheet out to the number of its next row. Every padded row shares this frozen array, so a sheet whose cells sit
 * on its last row costs one reference per empty row and not two arrays; a reader that tried to write into it would throw.
 */
const XLSX_EMPTY_ROW: string[] = Object.freeze([]) as unknown as string[];

const XLSX_EMPTY_STRUCTURED_ROW: OfficeWorksheetCell[] = Object.freeze([]) as unknown as OfficeWorksheetCell[];
