import { describe, expect, it } from 'vitest';
import { readBiffCharts } from '../src/lib/conversions/office/biff-chart';

/**
 * The chart substream of a BIFF8 workbook, written by hand from [MS-XLS]: BOF (2.4.21), BOUNDSHEET (2.4.28), EXTERNSHEET (2.4.106),
 * SERIES (2.4.250), AI (2.4.5), SERIESTEXT (2.4.254), TEXT (2.4.324), OBJECTLINK (2.4.181), BEGIN and END (2.4.14, 2.4.103) and
 * the 3-D area reference of a formula (PtgArea3d, 2.5.198.28). The cells a series refers to come from a map the test fills.
 */

const BOF = 0x0809;
const EOF = 0x000a;
const BOUNDSHEET = 0x0085;
const EXTERNSHEET = 0x0017;
const SERIES = 0x1003;
const AI = 0x1051;
const SERIESTEXT = 0x100d;
const TEXT = 0x1025;
const OBJECTLINK = 0x1027;
const BEGIN = 0x1033;
const END = 0x1034;
const CHART = 0x1002;
const BAR = 0x1017;
const PIE = 0x1019;
const BIFF8 = 0x0600;
const GLOBALS = 0x0005;
const CHART_SUBSTREAM = 0x0020;
const WORKSHEET = 0x0010;
const PTG_AREA3D = 0x3b;

const record = (id: number, data: Buffer = Buffer.alloc(0)): Buffer => {
  const header = Buffer.alloc(4);
  header.writeUInt16LE(id, 0);
  header.writeUInt16LE(data.length, 2);
  return Buffer.concat([header, data]);
};

const u16 = (...values: number[]): Buffer => {
  const out = Buffer.alloc(values.length * 2);
  values.forEach((value, i) => out.writeUInt16LE(value, i * 2));
  return out;
};

const bof = (type: number): Buffer => record(BOF, u16(BIFF8, type, 0, 0, 0, 0, 0, 0));
const boundSheet = (type: number, name: string): Buffer => record(BOUNDSHEET, Buffer.concat([Buffer.alloc(4), Buffer.from([0, type, name.length, 0]), Buffer.from(name, 'latin1')]));
const seriesText = (text: string): Buffer => record(SERIESTEXT, Buffer.concat([u16(0), Buffer.from([text.length, 1]), Buffer.from(text, 'utf16le')]));

/** An AI record: id (0 name, 1 values, 2 categories), then a literal (rt 1) or a reference to cells (rt 2) with its formula. */
const aiLiteral = (id: number): Buffer => record(AI, Buffer.concat([Buffer.from([id, 1]), u16(0, 0, 0)]));
const aiArea = (id: number, firstRow: number, lastRow: number, column: number): Buffer => {
  const formula = Buffer.concat([Buffer.from([PTG_AREA3D]), u16(0, firstRow, lastRow, column, column)]);
  return record(AI, Buffer.concat([Buffer.from([id, 2]), u16(0, 0, formula.length), formula]));
};

const seriesGroup = (name: string | null, values: Buffer | null, categories: Buffer | null): Buffer =>
  Buffer.concat([
    record(SERIES, Buffer.alloc(12)),
    record(BEGIN),
    ...(name === null ? [aiLiteral(0)] : [aiLiteral(0), seriesText(name)]),
    values ?? aiLiteral(1),
    categories ?? aiLiteral(2),
    record(END),
  ]);

/** A TEXT group: the text element, its string, and what it belongs to (1 chart title, 2 value axis, 3 category axis). */
const textGroup = (text: string, link: number): Buffer =>
  Buffer.concat([record(TEXT, Buffer.alloc(32)), record(BEGIN), aiLiteral(0), seriesText(text), record(OBJECTLINK, u16(link, 0, 0)), record(END)]);

/** Workbook sheets: [0] a chart sheet, [1] a worksheet; the chart refers to the worksheet through the one XTI entry. */
function workbook(chartBody: Buffer): Buffer {
  const externSheet = record(EXTERNSHEET, Buffer.concat([u16(1), u16(0, 1, 1)]));
  const globals = Buffer.concat([bof(GLOBALS), boundSheet(2, 'Chart1'), boundSheet(0, 'Data'), externSheet, record(EOF)]);
  const chart = Buffer.concat([bof(CHART_SUBSTREAM), record(CHART, Buffer.alloc(16)), record(BEGIN), chartBody, record(END), record(EOF)]);
  return Buffer.concat([globals, chart]);
}

const CELLS = new Map<string, string>([
  ['0,0,0', 'North'],
  ['0,1,0', 'South'],
  ['0,0,1', '10'],
  ['0,1,1', '20'],
  ['0,0,2', '4'],
  ['0,1,2', '5'],
]);
const cell = (worksheet: number, row: number, column: number): string | undefined => CELLS.get(`${worksheet},${row},${column}`);

describe('charts of a BIFF8 workbook', () => {
  it('reads the type, titles, series names and values, and the categories from the cells they refer to', () => {
    const body = Buffer.concat([
      seriesGroup('Sales', aiArea(1, 0, 1, 1), aiArea(2, 0, 1, 0)),
      seriesGroup('Costs', aiArea(1, 0, 1, 2), aiArea(2, 0, 1, 0)),
      textGroup('Revenue', 1),
      textGroup('Units', 2),
      textGroup('Region', 3),
      record(BAR, Buffer.alloc(6)),
    ]);
    expect(readBiffCharts(workbook(body), cell)).toEqual([
      {
        type: 'bar',
        title: 'Revenue',
        valueAxisTitle: 'Units',
        categoryAxisTitle: 'Region',
        categories: ['North', 'South'],
        series: [
          { name: 'Sales', values: [10, 20] },
          { name: 'Costs', values: [4, 5] },
        ],
      },
    ]);
  });

  it('takes the name of a series from the cell it refers to, and drops a series that has no values', () => {
    const body = Buffer.concat([seriesGroup(null, aiArea(1, 0, 1, 1), aiArea(2, 0, 1, 0)), seriesGroup('Empty', null, null), record(PIE, Buffer.alloc(6))]);
    const [chart] = readBiffCharts(workbook(body), (worksheet, row, column) => (row === 0 && column === 3 ? 'unused' : cell(worksheet, row, column)));
    expect(chart.type).toBe('pie');
    expect(chart.series).toEqual([{ name: 'Series 1', values: [10, 20] }]);
    expect(chart.categories).toEqual(['North', 'South']);
  });

  it('gives a chart that names no categories one unnamed place for each value', () => {
    const [chart] = readBiffCharts(workbook(seriesGroup('Only', aiArea(1, 0, 1, 1), null)), cell);
    expect(chart.categories).toEqual(['', '']);
  });

  it('finds no chart in a workbook that has none', () => {
    expect(readBiffCharts(Buffer.concat([bof(GLOBALS), record(EOF), bof(WORKSHEET), record(EOF)]), cell)).toEqual([]);
  });
});
