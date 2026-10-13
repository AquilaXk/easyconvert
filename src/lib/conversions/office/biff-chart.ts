import type { OpenXmlChartData } from '../office';

/**
 * Text and data of the charts in a BIFF8 workbook stream ([MS-XLS] 2.1.7.20, the chart sheet substream): the chart type, the
 * titles, the names and values of the series and the category labels. A chart is a substream of its own (BOF of type 0x0020)
 * whose series refer to the cells of the worksheets of the same workbook; a PowerPoint 97-2003 slide carries such a workbook
 * for each chart. The words the chart shows come from three places: SERIESTEXT records (a title, an axis title or a name typed
 * into the chart), cells a series refers to (its name, its categories) and the numbers of its values.
 */

const RECORD_BOF = 0x0809;
const RECORD_EOF = 0x000a;
const RECORD_BOUNDSHEET = 0x0085;
const RECORD_EXTERNSHEET = 0x0017;
const RECORD_BEGIN = 0x1033;
const RECORD_END = 0x1034;
const RECORD_SERIES = 0x1003;
const RECORD_AI = 0x1051;
const RECORD_SERIESTEXT = 0x100d;
const RECORD_OBJECTLINK = 0x1027;
const RECORD_TEXT = 0x1025;
const RECORD_BAR = 0x1017;
const RECORD_LINE = 0x1018;
const RECORD_PIE = 0x1019;
const RECORD_AREA = 0x101a;
const RECORD_SCATTER = 0x101b;

const SUBSTREAM_CHART = 0x0020;
const BOF_TYPE_OFFSET = 2;
const SHEET_TYPE_OFFSET = 5;
const SHEET_TYPE_WORKSHEET = 0;

/** AI record ([MS-XLS] 2.4.5): which part of the series it describes, and how its content is given. */
const AI_SERIES_NAME = 0;
const AI_VALUES = 1;
const AI_CATEGORIES = 2;
const AI_LINK_REFERENCE = 2;
const AI_HEADER_BYTES = 8;

/** OBJECTLINK: what a text element belongs to. */
const LINK_CHART_TITLE = 1;
const LINK_VALUE_AXIS = 2;
const LINK_CATEGORY_AXIS = 3;

const PTG_REF3D = new Set([0x3a, 0x5a, 0x7a]);
const PTG_AREA3D = new Set([0x3b, 0x5b, 0x7b]);
const COLUMN_MASK = 0x3fff;
const XTI_BYTES = 6;
const UTF16_FLAG = 0x01;
const MAX_REFERENCED_CELLS = 10_000;

/** The text of a cell of the workbook's worksheets (by their order among the worksheets), or undefined when it holds none. */
export type CellText = (worksheet: number, row: number, column: number) => string | undefined;

/** A chart read from a workbook stream; it has the shape of a chart of an OpenXML package. */
export type BiffChart = OpenXmlChartData;

interface CellRange {
  worksheet: number;
  firstRow: number;
  lastRow: number;
  firstColumn: number;
  lastColumn: number;
}

interface ChartState {
  chart: BiffChart;
  /** The record that opened each group still open (SERIES, TEXT, AXIS ...), outermost first. */
  groups: number[];
  categories: string[];
  seriesNames: string[];
  seriesValues: string[][];
  /** The SERIESTEXT string of the TEXT group being read, which its OBJECTLINK then assigns to the title or an axis. */
  textOfGroup?: string;
  lastAi: number;
  lastRecord: number;
  /** The first chart-type record (BAR, LINE, PIE ...) decides the type; the chart group that holds it follows the series. */
  typeKnown: boolean;
}

/** The characters of a SERIESTEXT record: id, count, option flag, then the characters in one byte or two. */
function seriesText(data: Buffer): string {
  if (data.length < 4) return '';
  const count = data[2];
  const wide = (data[3] & UTF16_FLAG) !== 0;
  return wide ? data.toString('utf16le', 4, Math.min(data.length, 4 + count * 2)) : data.toString('latin1', 4, Math.min(data.length, 4 + count));
}

/** The cell range a chart reference formula names (a 3-D cell or area reference), or null for any other formula. */
function referenceOf(formula: Buffer, sheetOfXti: (index: number) => number | undefined): CellRange | null {
  if (formula.length < 7) return null;
  const token = formula[0];
  const worksheet = sheetOfXti(formula.readUInt16LE(1));
  if (worksheet === undefined) return null;
  if (PTG_REF3D.has(token)) {
    const row = formula.readUInt16LE(3);
    const column = formula.readUInt16LE(5) & COLUMN_MASK;
    return { worksheet, firstRow: row, lastRow: row, firstColumn: column, lastColumn: column };
  }
  if (PTG_AREA3D.has(token) && formula.length >= 11) {
    return {
      worksheet,
      firstRow: formula.readUInt16LE(3),
      lastRow: formula.readUInt16LE(5),
      firstColumn: formula.readUInt16LE(7) & COLUMN_MASK,
      lastColumn: formula.readUInt16LE(9) & COLUMN_MASK,
    };
  }
  return null;
}

/** The cells of a range in row order, then column order, for a range that is a single row or column (the shape of a series). */
function cellsOf(range: CellRange, cell: CellText): string[] {
  const values: string[] = [];
  for (let row = range.firstRow; row <= range.lastRow; row++) {
    for (let column = range.firstColumn; column <= range.lastColumn; column++) {
      values.push(cell(range.worksheet, row, column) ?? '');
      if (values.length > MAX_REFERENCED_CELLS) return values;
    }
  }
  return values;
}

function chartTypeOf(record: number): OpenXmlChartData['type'] | undefined {
  switch (record) {
    case RECORD_BAR:
      return 'bar';
    case RECORD_LINE:
      return 'line';
    case RECORD_PIE:
      return 'pie';
    case RECORD_AREA:
      return 'area';
    case RECORD_SCATTER:
      return 'scatter';
    default:
      return undefined;
  }
}

/** Applies one record of a chart substream to the chart being read. */
function readChartRecord(
  state: ChartState,
  id: number,
  data: Buffer,
  cell: CellText,
  sheetOfXti: (index: number) => number | undefined
): void {
  const seriesIndex = state.seriesNames.length - 1;
  const insideGroup = (record: number): boolean => state.groups.includes(record);
  if (id === RECORD_BEGIN) {
    state.groups.push(state.lastRecord);
    return;
  }
  if (id === RECORD_END) {
    if (state.groups.pop() === RECORD_TEXT) state.textOfGroup = undefined;
    state.lastRecord = -1;
    return;
  }
  state.lastRecord = id;
  const type = chartTypeOf(id);
  if (type !== undefined && !state.typeKnown) {
    state.chart.type = type;
    state.typeKnown = true;
  }
  if (id === RECORD_SERIES) {
    state.seriesNames.push(`Series ${state.seriesNames.length + 1}`);
    state.seriesValues.push([]);
  } else if (id === RECORD_AI && data.length >= AI_HEADER_BYTES) {
    const aiId = data[0];
    state.lastAi = aiId;
    const formulaLength = data.readUInt16LE(6);
    const reference = data[1] === AI_LINK_REFERENCE && formulaLength > 0 ? referenceOf(data.subarray(AI_HEADER_BYTES, AI_HEADER_BYTES + formulaLength), sheetOfXti) : null;
    if (reference === null || seriesIndex < 0 || !insideGroup(RECORD_SERIES)) return;
    const cells = cellsOf(reference, cell);
    if (aiId === AI_SERIES_NAME) state.seriesNames[seriesIndex] = cells.join(' ').trim() || state.seriesNames[seriesIndex];
    else if (aiId === AI_VALUES) state.seriesValues[seriesIndex] = cells;
    else if (aiId === AI_CATEGORIES && state.categories.length === 0) state.categories = cells;
  } else if (id === RECORD_SERIESTEXT) {
    const text = seriesText(data).trim();
    if (text === '') return;
    if (insideGroup(RECORD_TEXT)) state.textOfGroup = text;
    else if (insideGroup(RECORD_SERIES) && state.lastAi === AI_SERIES_NAME && seriesIndex >= 0) state.seriesNames[seriesIndex] = text;
  } else if (id === RECORD_OBJECTLINK && data.length >= 2 && state.textOfGroup !== undefined) {
    const link = data.readUInt16LE(0);
    if (link === LINK_CHART_TITLE) state.chart.title = state.textOfGroup;
    else if (link === LINK_VALUE_AXIS) state.chart.valueAxisTitle = state.textOfGroup;
    else if (link === LINK_CATEGORY_AXIS) state.chart.categoryAxisTitle = state.textOfGroup;
  }
}

/** Reads every chart substream of a workbook stream; a stream with none gives an empty list. */
export function readBiffCharts(stream: Buffer, cell: CellText): BiffChart[] {
  const charts: BiffChart[] = [];
  const sheetIsWorksheet: boolean[] = [];
  const xtiSheets: number[] = [];
  /** Position among the worksheets of each workbook sheet, undefined for a chart sheet. */
  const worksheetOfSheet = (sheet: number): number | undefined => {
    if (!sheetIsWorksheet[sheet]) return undefined;
    return sheetIsWorksheet.slice(0, sheet).filter(Boolean).length;
  };
  const sheetOfXti = (index: number): number | undefined => {
    const sheet = xtiSheets[index];
    return sheet === undefined ? undefined : worksheetOfSheet(sheet);
  };

  let current: ChartState | null = null;
  let substreamDepth = 0;

  const finish = (): void => {
    if (current === null) return;
    const { chart, seriesNames, seriesValues } = current;
    chart.series = seriesNames
      .map((name, index) => ({ name, values: (seriesValues[index] ?? []).map(Number).filter((value) => !Number.isNaN(value)) }))
      .filter((series) => series.values.length > 0);
    // A chart whose series state no categories numbers its points; the drawing then has one unnamed place for each.
    const points = Math.max(0, ...chart.series.map((series) => series.values.length));
    chart.categories = current.categories.length > 0 ? current.categories : Array.from({ length: points }, () => '');
    if (chart.title !== undefined || chart.series.length > 0 || chart.categories.length > 0) charts.push(chart);
    current = null;
  };

  let pos = 0;
  while (pos + 4 <= stream.length) {
    const id = stream.readUInt16LE(pos);
    const length = stream.readUInt16LE(pos + 2);
    pos += 4;
    if (pos + length > stream.length) break;
    const data = stream.subarray(pos, pos + length);
    pos += length;

    if (id === RECORD_BOUNDSHEET && data.length > SHEET_TYPE_OFFSET) {
      sheetIsWorksheet.push(data[SHEET_TYPE_OFFSET] === SHEET_TYPE_WORKSHEET);
    } else if (id === RECORD_EXTERNSHEET && data.length >= 2) {
      const count = data.readUInt16LE(0);
      for (let index = 0; index < count && 2 + (index + 1) * XTI_BYTES <= data.length; index++) {
        xtiSheets.push(data.readUInt16LE(2 + index * XTI_BYTES + 2));
      }
    } else if (id === RECORD_BOF) {
      if (current !== null) {
        substreamDepth++;
      } else if (data.length >= BOF_TYPE_OFFSET + 2 && data.readUInt16LE(BOF_TYPE_OFFSET) === SUBSTREAM_CHART) {
        current = { chart: { type: 'bar', categories: [], series: [] }, groups: [], categories: [], seriesNames: [], seriesValues: [], lastAi: -1, lastRecord: -1, typeKnown: false };
        substreamDepth = 0;
      }
    } else if (id === RECORD_EOF) {
      if (current !== null) {
        if (substreamDepth === 0) finish();
        else substreamDepth--;
      }
    } else if (current !== null) {
      readChartRecord(current, id, data, cell, sheetOfXti);
    }
  }
  finish();
  return charts;
}
