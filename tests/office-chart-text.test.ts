import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { convertFile } from '../src/lib/conversions';
import { parseCfbf } from '../src/lib/conversions/hwp';
import { buildCompoundFile } from './helpers/cfb-craft';
import { parseOpenXmlChart } from '../src/lib/conversions/office';
import { requireOracleTool } from './helpers/differential-oracle';
import { oracleTest } from './helpers/oracle-test';
import { chartPart, docxWithChart, pptxWithChart, xlsxWithChart, type TestChart } from './helpers/office-chart-packages';
import { sofficeConvert } from './helpers/soffice-office';

/**
 * The words charts show in a PDF: titles, axis titles, category names (the names of the slices of a pie too), series names and
 * the numbers of the value axis. The expected words are the ones written into each package; the office suite's own PDF of the same
 * file is the second witness: every word it draws that is not a number must be in ours.
 */

const WORD = /[\p{L}\p{N}]+/gu;
const NUMBER = /^\p{N}+$/u;

function pdfText(pdf: Buffer): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chart-text-'));
  try {
    fs.writeFileSync(path.join(dir, 'out.pdf'), pdf);
    return execFileSync(requireOracleTool('pdftotext'), ['-enc', 'UTF-8', path.join(dir, 'out.pdf'), '-'], { encoding: 'utf-8' });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const words = (text: string): string[] => text.toLowerCase().match(WORD) ?? [];
const nonNumbers = (list: readonly string[]): string[] => list.filter((word) => !NUMBER.test(word));

const BAR: TestChart = {
  type: 'bar',
  title: 'Revenue by territory',
  valueAxisTitle: 'Thousands',
  categoryAxisTitle: 'Territory',
  categories: ['Northern', 'Southern', 'Eastern'],
  series: [
    { name: 'Widgets', values: [4, 2, 5] },
    { name: 'Gadgets', values: [1, 3, 2] },
  ],
};
const BAR_WORDS = words([BAR.title, BAR.valueAxisTitle, BAR.categoryAxisTitle, ...BAR.categories, ...BAR.series.map((s) => s.name)].join(' '));

const PIE: TestChart = {
  type: 'pie',
  title: 'Top functions',
  categories: ['Finance - Investment Banking', 'Consulting', 'Finance - Company Finance (Analysis/ Treasury)', 'Marketing', 'All Others'],
  series: [{ name: 'Share', values: [0.22, 0.16, 0.12, 0.1, 0.4] }],
};
const PIE_WORDS = words([PIE.title, ...PIE.categories].join(' '));

describe('chart parts of an OpenXML package', () => {
  it('reads the titles of the value and the category axis', () => {
    const chart = parseOpenXmlChart(chartPart(BAR));
    expect(chart).toMatchObject({ type: 'bar', title: 'Revenue by territory', valueAxisTitle: 'Thousands', categoryAxisTitle: 'Territory', categories: BAR.categories });
    expect(chart?.series.map((s) => s.name)).toEqual(['Widgets', 'Gadgets']);
  });
});

describe('charts in PDF', () => {
  oracleTest('a DOCX chart shows its titles, categories, series names and a labelled value axis', ['pdftotext', 'soffice'], async () => {
    const input = await docxWithChart('Sales figures', BAR);
    const ours = words(pdfText((await convertFile(input, 'docx', 'pdf', {}, 'chart.docx')).buffer));
    for (const word of [...BAR_WORDS, 'sales', 'figures']) expect(ours).toContain(word);
    // The value axis is labelled from zero up to a rounded top that covers the data (5): 0 1 2 3 4 5.
    for (const tick of ['0', '1', '2', '3', '4', '5']) expect(ours).toContain(tick);
    const suite = words(pdfText(sofficeConvert(input, 'docx', 'pdf', 'pdf')));
    for (const word of nonNumbers(suite)) expect(ours).toContain(word);
  }, 180_000);

  oracleTest('an XLSX chart is drawn below its sheet, a pie with the name of every slice', ['pdftotext', 'soffice'], async () => {
    const input = await xlsxWithChart([['Function', 'Share'], ...PIE.categories.map((category, i) => [category, String(PIE.series[0].values[i])])], PIE);
    const ours = words(pdfText((await convertFile(input, 'xlsx', 'pdf', {}, 'pie.xlsx')).buffer));
    for (const word of PIE_WORDS) expect(ours).toContain(word);
    // The office suite draws the same names (its text also runs a category into the number beside it, so its words are not compared one by one).
    const suite = words(pdfText(sofficeConvert(input, 'xlsx', 'pdf', 'pdf')));
    for (const word of PIE_WORDS) expect(suite).toContain(word);
  }, 180_000);

  oracleTest('a chart embedded in a 97-2003 presentation is drawn on its slide', ['pdftotext', 'soffice'], async () => {
    const deck = sofficeConvert(await pptxWithChart('Quarterly review', BAR), 'pptx', 'ppt', 'ppt');
    const result = await convertFile(deck, 'ppt', 'pdf', {}, 'chart.ppt');
    const ours = words(pdfText(result.buffer));
    for (const word of [...BAR_WORDS, 'quarterly', 'review']) expect(ours).toContain(word);
    const suite = words(pdfText(sofficeConvert(deck, 'ppt', 'pdf', 'pdf')));
    for (const word of nonNumbers(suite)) expect(ours).toContain(word);
    // The text targets list what the chart says.
    const text = (await convertFile(deck, 'ppt', 'txt', {}, 'chart.ppt')).buffer.toString('utf-8');
    for (const word of BAR_WORDS) expect(words(text)).toContain(word);
  }, 180_000);
});

describe('a damaged chart in a 97-2003 presentation', () => {
  /** The deck with one byte run of the compressed chart storage flipped, so that the storage no longer inflates. */
  function damaged(deck: Buffer): Buffer {
    const streams = parseCfbf(deck).streams;
    const document = Buffer.from(streams.get('PowerPoint Document') as Buffer);
    // ExOleObjStg ([MS-PPT] 2.10.34): record header with recVer 0, recInstance 1 (compressed) and type 0x1011.
    const header = document.indexOf(Buffer.from([0x10, 0x00, 0x11, 0x10]));
    expect(header).toBeGreaterThanOrEqual(0);
    const body = header + 8 + 4;
    for (let i = body + 40; i < body + 60; i++) document[i] ^= 0xff;
    return buildCompoundFile(['Current User', 'PowerPoint Document', 'Pictures'].map((name) => ({ name, data: name === 'PowerPoint Document' ? document : (streams.get(name) as Buffer) })));
  }

  oracleTest('keeps the text of the slide and says that the chart could not be read', ['soffice'], async () => {
    const deck = sofficeConvert(await pptxWithChart('Quarterly review', BAR), 'pptx', 'ppt', 'ppt');
    const result = await convertFile(damaged(deck), 'ppt', 'txt', {}, 'damaged.ppt');
    expect(result.buffer.toString('utf-8')).toContain('Quarterly review');
    expect(result.metadata?.warnings).toEqual([expect.stringMatching(/^Slide 1: an embedded chart could not be read|^Slide 1: an embedded object could not be read/)]);
  }, 180_000);
});
