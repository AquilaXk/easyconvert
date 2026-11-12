import JSZip from 'jszip';
import { newRelationshipAllowance, readPartRelationships, streamFirstElements, type OpcReadOptions } from './opc-parts';
import { readZipEntryText } from '../zip-entry-reader';
import { InflateBudget } from '../bounded-inflate';
import { XLSX_LAST_COLUMN_NAME, XLSX_MAX_COLUMNS, XLSX_MAX_MATERIALISED_CELLS, XLSX_MAX_ROWS } from './sheet-bounds';
import { safeDecodeXmlEntities, safeExtractXmlElements } from '../safe-xml-scanner';
import { withoutElements } from './xml-without';
import { ConversionFailedError, PayloadLimitError } from '../../types';
import { openOpcPackage } from '../package-access';
import { XLSX_MAX_RANGES_PER_WORKBOOK, XLSX_NO_WORKSHEETS_MESSAGE, discoverXlsxSheets } from './xlsx-sheets';
import { XLSX_MAX_CELL_TEXT_CHARS_ENV, xlsxMaxCellTextChars } from './spreadsheet-limits';
import { assertWellFormedXml } from '../xml-wellformed';
import { readWorksheetStructure, worksheetBoundError } from './xlsx-worksheet-structure';
import { type OfficeCellRange, type OfficeWorksheet, type OfficeWorksheetCell, type OfficeWorksheetHyperlink, type OfficeWorksheetPrintArea, type OpenXmlChartData } from './types';
import { parseOpenXmlChart } from './chart-parse';
import { DATE_SYSTEM_1900, DATE_SYSTEM_1904, type SpreadsheetDateSystem, formatSpreadsheetCellValue } from './spreadsheet-format';
import { safeExtractAllText, safeExtractFirstXmlElement, safeExtractTagContent } from './xml-helpers';
import { getExcelColumnIndex, parseA1Range } from './spreadsheet-ranges';
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

/**
 * What follows the cell data of a worksheet and what its relationships part holds for the sheet: the merged ranges and the cell
 * hyperlinks, how many elements of both the scan took, and the parts of the drawings the sheet shows. The workbook holds at most
 * `allowance` more ranges and links together (`XLSX_MAX_RANGES_PER_WORKBOOK` less what the sheets before it used): past it the lists
 * stop growing and the conversion goes on without the rest, since a target that shows none would be refused for them. The relationships
 * part is read once, under the workbook budget, for the ids that the links name and for the drawings, so the map follows the links.
 */
async function readSheetAnnotations(
  zip: JSZip,
  sheetPath: string,
  sheetXml: string,
  allowance: number,
  options: OpcReadOptions
): Promise<Pick<OfficeWorksheet, 'mergedRanges' | 'hyperlinks'> & { used: number; drawingParts: string[] }> {
  // Both lists follow `sheetData` (ECMA-376 Part 1, 18.3.1.99), so the cell data is not scanned again.
  const afterCells = sheetXml.slice(Math.max(0, sheetXml.lastIndexOf('</sheetData>')));
  const mergedRanges: OfficeCellRange[] = [];
  let used = streamFirstElements(afterCells, 'mergeCell', allowance, (merge) => {
    const range = parseA1Range(merge.attrs.ref ?? '');
    if (range) mergedRanges.push({ startRow: range.startRow, endRow: range.endRow, startCol: range.startCol, endCol: range.endCol });
  });
  const links: Array<{ row: number; col: number; id: string | undefined; location: string | undefined }> = [];
  const wantedIds = new Set<string>();
  if (afterCells.includes('hyperlink')) {
    used += streamFirstElements(afterCells, 'hyperlink', allowance - used, (link) => {
      const cell = parseA1Range(link.attrs.ref ?? '');
      const { 'r:id': id, location } = link.attrs;
      if (!cell || (id === undefined && location === undefined)) return;
      if (id !== undefined) wantedIds.add(id);
      links.push({ row: cell.startRow, col: cell.startCol, id, location });
    });
  }
  const related = await readPartRelationships(zip, sheetPath, options, (id, type, external) => (external ? wantedIds.has(id) : type.endsWith('/drawing')));
  const hyperlinks: OfficeWorksheetHyperlink[] = [];
  for (const { row, col, id, location } of links) {
    const linked = id === undefined ? undefined : related.get(id);
    const target = (linked?.external ? linked.target : undefined) ?? (location === undefined ? undefined : `#${location}`);
    if (target !== undefined) hyperlinks.push({ row, col, target });
  }
  const drawingParts = [...related.values()].filter((relationship) => !relationship.external).map((relationship) => relationship.target);
  return { ...(mergedRanges.length > 0 ? { mergedRanges } : {}), ...(hyperlinks.length > 0 ? { hyperlinks } : {}), used, drawingParts };
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

/**
 * Parses all worksheets from an XLSX JSZip instance, discovering sheets from workbook.xml
 * and workbook.xml.rels, resolving shared strings, NumberFormats, and formulas.
 */
export async function parseAllXlsxWorksheets(zipOrBuffer: JSZip | Buffer | Uint8Array): Promise<OfficeWorksheet[]> {
  const zip = (zipOrBuffer && typeof (zipOrBuffer as JSZip).file === 'function')
    ? (zipOrBuffer as JSZip)
    : await openOpcPackage(zipOrBuffer as Buffer | Uint8Array, 'XLSX');

  const partOptions = { budget: new InflateBudget(), relationships: newRelationshipAllowance() };

  // 1. Parse shared strings
  const sharedStrings = await readSharedStrings(zip, partOptions.budget);

  // 2. Parse NumberFormats, Fonts, Fills, Borders, and Cell Styles from xl/styles.xml
  const styleNumFmtMap = new Map<number, number>();
  const customNumFmtMap = new Map<number, string>();

  interface ParsedCellStyle {
    numFmtId?: number;
    font?: { bold?: boolean; italic?: boolean; size?: number; color?: string };
    fillColor?: string;
    hasBorder?: boolean;
    align?: 'left' | 'center' | 'right';
  }
  const cellStylesMap = new Map<number, ParsedCellStyle>();

  const stylesFile = zip.file('xl/styles.xml');
  if (stylesFile) {
    const stylesXml = await readZipEntryText(stylesFile, { budget: partOptions.budget });

    // Parse custom <numFmt numFmtId="..." formatCode="..."/>
    const numFmtRegex = /<numFmt\s+[^>]*?numFmtId="(\d+)"[^>]*?formatCode="([^"]*)"/gi;
    let nfMatch: RegExpExecArray | null;
    while ((nfMatch = numFmtRegex.exec(stylesXml)) !== null) {
      customNumFmtMap.set(parseInt(nfMatch[1], 10), nfMatch[2]);
    }

    // Parse fonts: <fonts><font>...<b/>...<sz val="11"/>...<color rgb="FF0000"/></font></fonts>
    const parsedFonts: Array<{ bold?: boolean; italic?: boolean; size?: number; color?: string }> = [];
    const fontsEl = safeExtractFirstXmlElement(stylesXml, 'fonts');
    if (fontsEl) {
      const fontEls = safeExtractXmlElements(fontsEl.content, 'font');
      for (const fontEl of fontEls) {
        const fBody = fontEl.content;
        const isBold = /<b\b/i.test(fBody);
        const isItalic = /<i\b/i.test(fBody);
        const szEl = safeExtractFirstXmlElement(fBody, 'sz');
        const sz = szEl && szEl.attrs.val ? parseFloat(szEl.attrs.val) : undefined;
        const clrEl = safeExtractFirstXmlElement(fBody, 'color');
        let color: string | undefined;
        if (clrEl && clrEl.attrs.rgb) {
          const rawClr = clrEl.attrs.rgb;
          color = '#' + (rawClr.length === 8 ? rawClr.slice(2) : rawClr);
        }
        parsedFonts.push({ bold: isBold, italic: isItalic, size: sz, color });
      }
    }

    // Parse fills: <fills><fill><patternFill ...><fgColor rgb="FFF0F2FE"/></patternFill></fill></fills>
    const parsedFills: Array<{ fillColor?: string }> = [];
    const fillsEl = safeExtractFirstXmlElement(stylesXml, 'fills');
    if (fillsEl) {
      const fillEls = safeExtractXmlElements(fillsEl.content, 'fill');
      for (const fillEl of fillEls) {
        const fgEl = safeExtractFirstXmlElement(fillEl.content, 'fgColor');
        let fillColor: string | undefined;
        if (fgEl && fgEl.attrs.rgb) {
          const rawClr = fgEl.attrs.rgb;
          fillColor = '#' + (rawClr.length === 8 ? rawClr.slice(2) : rawClr);
        }
        parsedFills.push({ fillColor });
      }
    }

    // Parse borders: <borders><border><left style="thin">...
    const parsedBorders: Array<{ hasBorder?: boolean }> = [];
    const bordersEl = safeExtractFirstXmlElement(stylesXml, 'borders');
    if (bordersEl) {
      const borderEls = safeExtractXmlElements(bordersEl.content, 'border');
      for (const borderEl of borderEls) {
        const bBody = borderEl.content;
        const hasBorder = /<(left|right|top|bottom)\s+style="(?!none)[^"]+"/i.test(bBody);
        parsedBorders.push({ hasBorder });
      }
    }

    // Parse <cellXfs><xf numFmtId="..." .../>
    const cellXfsEl = safeExtractFirstXmlElement(stylesXml, 'cellXfs');
    if (cellXfsEl) {
      const xfEls = safeExtractXmlElements(cellXfsEl.content, 'xf');
      let xfIdx = 0;
      for (const xfEl of xfEls) {
        const xfAttrs = xfEl.attrs;
        const xfBody = xfEl.content || '';

        const nfId = xfAttrs.numFmtId;
        const fontId = xfAttrs.fontId;
        const fillId = xfAttrs.fillId;
        const borderId = xfAttrs.borderId;

        const alignEl = safeExtractFirstXmlElement(xfBody || xfEl.raw, 'alignment');
        let align: 'left' | 'center' | 'right' | undefined;
        if (alignEl && alignEl.attrs.horizontal) {
          const hAlign = alignEl.attrs.horizontal.toLowerCase();
          if (hAlign === 'left' || hAlign === 'center' || hAlign === 'right') {
            align = hAlign;
          }
        }

        const numFmtVal = nfId ? parseInt(nfId, 10) : undefined;
        if (numFmtVal !== undefined) {
          styleNumFmtMap.set(xfIdx, numFmtVal);
        }

        const font = fontId ? parsedFonts[parseInt(fontId, 10)] : undefined;
        const fill = fillId ? parsedFills[parseInt(fillId, 10)] : undefined;
        const border = borderId ? parsedBorders[parseInt(borderId, 10)] : undefined;

        cellStylesMap.set(xfIdx, {
          numFmtId: numFmtVal,
          font,
          fillColor: fill?.fillColor,
          hasBorder: border?.hasBorder,
          align,
        });

        xfIdx++;
      }
    }
  }

  // 3. Discover all worksheets from workbook.xml and workbook.xml.rels
  const { workbookXml: wbXml, sheets: sheetEntries } = await discoverXlsxSheets(zip, partOptions);
  if (sheetEntries.length === 0) throw new ConversionFailedError(XLSX_NO_WORKSHEETS_MESSAGE);
  const printAreaBySheetIndex = new Map<number, OfficeWorksheetPrintArea>();
  const printAreaBySheetName = new Map<string, OfficeWorksheetPrintArea>();
  let dateSystem = DATE_SYSTEM_1900;

  if (wbXml !== undefined) {
    dateSystem = readDateSystem(wbXml);

    // Parse <definedNames><definedName name="_xlnm.Print_Area" localSheetId="0">Sheet1!$B$2:$C$3</definedName></definedNames>
    for (const dnEl of safeExtractXmlElements(wbXml, 'definedName')) {
      if (dnEl.attrs.name === '_xlnm.Print_Area') {
        const parsed = parseA1Range(dnEl.content);
        if (parsed) {
          const area: OfficeWorksheetPrintArea = {
            startRow: parsed.startRow,
            endRow: parsed.endRow,
            startCol: parsed.startCol,
            endCol: parsed.endCol,
          };
          if (dnEl.attrs.localSheetId !== undefined) {
            const sid = parseInt(dnEl.attrs.localSheetId, 10);
            if (!isNaN(sid)) {
              printAreaBySheetIndex.set(sid, area);
            }
          }
          if (parsed.sheetName) {
            printAreaBySheetName.set(parsed.sheetName.toLowerCase(), area);
          }
        }
      }
    }
  }

  // 4. Parse all discovered worksheets
  const allSheets: OfficeWorksheet[] = [];
  let expandedTextChars = 0;
  const maxCellTextChars = xlsxMaxCellTextChars();
  // The cells and rows the reader builds for all sheets, the empty ones that pad a cell out to its column and a row out to its
  // row number included: a few bytes of XML ('<c r="XFD1"/>' on each of 1300 rows) otherwise ask for millions of them.
  let materialisedCells = 0;
  const chargeCells = (count: number): void => {
    if (count <= 0) return;
    materialisedCells += count;
    if (materialisedCells > XLSX_MAX_MATERIALISED_CELLS) {
      throw new PayloadLimitError(`The XLSX sheets hold more than ${XLSX_MAX_MATERIALISED_CELLS} cells, the empty cells and rows that pad a sparse sheet included.`);
    }
  };

  // The merged ranges and hyperlinks held for all sheets, which no byte or cell budget keeps small: a `mergeCell` is 25 bytes of XML.
  let rangesHeld = 0;

  for (let entryIdx = 0; entryIdx < sheetEntries.length; entryIdx++) {
    const entry = sheetEntries[entryIdx];
    const printArea = printAreaBySheetIndex.get(entryIdx) || printAreaBySheetName.get(entry.name.toLowerCase());
    const sFile = zip.file(entry.path);
    if (!sFile) continue;

    const sheetXml = await readZipEntryText(sFile, { budget: partOptions.budget, maxBytes: partOptions.budget.limit });
    const { used, drawingParts, ...annotations } = await readSheetAnnotations(zip, entry.path, sheetXml, XLSX_MAX_RANGES_PER_WORKBOOK - rangesHeld, partOptions);
    rangesHeld += used;
    assertWellFormedXml(entry.path, sheetXml, 'XLSX');
    const rows: string[][] = [];
    const structuredRows: OfficeWorksheetCell[][] = [];
    const cellMap: Record<string, any> = {};
    const formulaCells: Array<{ ref: string; formula: string; rowIdx: number; colIdx: number }> = [];

    const { columnWidths, rowEls } = readWorksheetStructure(sheetXml, entry.name);

    for (const rowEl of rowEls) {
      const rowAttrs = rowEl.attrs;
      if (rowAttrs.r) {
        const targetRowIdx = parseInt(rowAttrs.r, 10) - 1;
        if (targetRowIdx >= XLSX_MAX_ROWS) throw worksheetBoundError(entry.name, `row ${targetRowIdx + 1} is past the last row of a worksheet (${XLSX_MAX_ROWS})`);
        chargeCells(targetRowIdx - rows.length);
        while (rows.length < targetRowIdx) {
          rows.push(XLSX_EMPTY_ROW);
          structuredRows.push(XLSX_EMPTY_STRUCTURED_ROW);
        }
      }
      chargeCells(1);
      const cells: string[] = [];
      const structuredCells: OfficeWorksheetCell[] = [];
      const cellEls = safeExtractXmlElements(rowEl.content, 'c');
      const rowIdx = rows.length;
      let nextColIdx = 0;

      for (const cellEl of cellEls) {
        const attrs = cellEl.attrs;
        const body = cellEl.content;
        const isString = attrs.t === 's';
        const isInline = attrs.t === 'inlineStr';
        const isBool = attrs.t === 'b';
        const vContent = safeExtractTagContent(body, 'v');
        const tContent = safeExtractTagContent(body, 't');
        const fContent = safeExtractTagContent(body, 'f');
        const ref = (attrs.r || '').toUpperCase();
        const rRefMatch = ref.match(/^([A-Za-z]+)(\d+)/);

        // Extract style index for NumberFormat
        const styleIdx = attrs.s !== undefined ? parseInt(attrs.s, 10) : undefined;
        const numFmtId = styleIdx !== undefined ? styleNumFmtMap.get(styleIdx) : undefined;
        const customFmt = numFmtId !== undefined ? customNumFmtMap.get(numFmtId) : undefined;

        let colIdx = nextColIdx;
        if (rRefMatch && rRefMatch[1]) {
          colIdx = getExcelColumnIndex(rRefMatch[1]);
          if (colIdx >= XLSX_MAX_COLUMNS) throw worksheetBoundError(entry.name, `column ${rRefMatch[1]} is past the last column of a worksheet (${XLSX_LAST_COLUMN_NAME})`);
        }

        chargeCells(colIdx + 1 - cells.length);
        while (cells.length < colIdx) {
          cells.push('');
          structuredCells.push({ value: '' });
        }

        let cellValue = '';
        if (isInline) {
          const isEl = safeExtractFirstXmlElement(body, 'is');
          if (isEl) {
            const inlineText = withoutElements(isEl.content, PHONETIC_RUN);
            cellValue = safeExtractAllText(inlineText, 't') || safeExtractAllText(inlineText);
          } else if (tContent !== null) {
            cellValue = safeDecodeXmlEntities(tContent);
          }
        } else if (isBool && vContent !== null) {
          cellValue = vContent === '1' ? 'TRUE' : 'FALSE';
        } else if (vContent !== null) {
          if (isString) {
            const strIdx = Number.parseInt(vContent, 10);
            cellValue = sharedStrings[strIdx] ?? '';
          } else {
            // Apply NumberFormat formatting
            cellValue = formatSpreadsheetCellValue(vContent, numFmtId, customFmt, dateSystem);
          }
        } else if (tContent !== null) {
          cellValue = safeDecodeXmlEntities(tContent);
        }

        expandedTextChars += cellValue.length;
        if (expandedTextChars > maxCellTextChars) {
          throw new PayloadLimitError(`The XLSX cells expand to more than ${maxCellTextChars} characters (${XLSX_MAX_CELL_TEXT_CHARS_ENV}).`);
        }

        if (ref) {
          cellMap[ref] = cellValue;
        }

        if (fContent !== null && (!cellValue || cellValue.trim() === '')) {
          formulaCells.push({ ref, formula: fContent, rowIdx, colIdx });
        }

        cells[colIdx] = cellValue;

        const style = styleIdx !== undefined ? cellStylesMap.get(styleIdx) : undefined;
        const isNum = !isNaN(Number(cellValue)) && cellValue.trim() !== '';
        const cellAlign = style?.align || (isNum ? 'right' : 'left');

        structuredCells[colIdx] = {
          value: cellValue,
          bold: style?.font?.bold,
          italic: style?.font?.italic,
          fontSize: style?.font?.size,
          fontColor: style?.font?.color,
          fillColor: style?.fillColor,
          borderColor: style?.hasBorder ? '#CBD5E1' : undefined,
          align: cellAlign,
        };

        nextColIdx = colIdx + 1;
      }
      rows.push(cells);
      structuredRows.push(structuredCells);
    }

    // Evaluate dynamic formulas with DAG dependency sorter & cycle detection
    if (formulaCells.length > 0) {
      const dagEngine = new SpreadsheetDagEngine(cellMap);
      dagEngine.evaluateWithDag(formulaCells, rows);
      for (const fc of formulaCells) {
        if (structuredRows[fc.rowIdx] && structuredRows[fc.rowIdx][fc.colIdx]) {
          structuredRows[fc.rowIdx][fc.colIdx].value = rows[fc.rowIdx][fc.colIdx] || '';
        }
      }
    }

    const charts = await readWorksheetCharts(zip, drawingParts, partOptions);
    allSheets.push({
      name: entry.name,
      rows,
      structuredRows,
      ...annotations,
      columnWidths: columnWidths.length > 0 ? columnWidths : undefined,
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
