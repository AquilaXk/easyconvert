import { InflateBudget } from '../bounded-inflate';
import { openPackage } from '../package-access';
import { readZipEntryText } from '../zip-entry-reader';
import { safeExtractXmlElements } from '../safe-xml-scanner';
import { isCfbfContainer, parseCfbf } from '../cfbf-reader';
import { readBiffCharts } from './biff-chart';
import { type OpenXmlChartData } from './types';
import { safeExtractAllText, safeExtractFirstXmlElement } from './xml-helpers';
import { readBiff8Worksheets, selectWorkbookStream } from './xls-parse';

const ODF_CHART_CLASSES: Readonly<Record<string, OpenXmlChartData['type']>> = {
  'chart:bar': 'bar',
  'chart:line': 'line',
  'chart:area': 'area',
  'chart:circle': 'pie',
  'chart:ring': 'doughnut',
  'chart:scatter': 'scatter',
};

const ODF_CHART_STORAGE_STREAM = 'package_stream';

/** The text inside the first element `tag` of `xml`, or undefined when there is none or it is empty. */
function odfElementText(xml: string, tag: string): string | undefined {
  const element = safeExtractFirstXmlElement(xml, tag);
  const text = element ? safeExtractAllText(element.content).trim() : '';
  return text === '' ? undefined : text;
}

/**
 * The chart in an OpenDocument chart package (the `package_stream` an office suite stores in the compound file of an embedded
 * chart): its type, titles, and the table that holds its data (series names in the header row, categories in the first column).
 */
async function readOdfChartPackage(bytes: Buffer, budget = new InflateBudget()): Promise<OpenXmlChartData | null> {
  const zip = await openPackage(bytes, 'ODF chart');
  const contentFile = zip.file('content.xml');
  if (!contentFile) return null;
  const content = await readZipEntryText(contentFile, { budget });
  const chartEl = safeExtractFirstXmlElement(content, 'chart:chart');
  if (!chartEl) return null;
  const plotStart = chartEl.content.indexOf('<chart:plot-area');
  const title = odfElementText(plotStart < 0 ? chartEl.content : chartEl.content.slice(0, plotStart), 'chart:title');
  const axisTitles = new Map<string, string>();
  for (const axis of safeExtractXmlElements(chartEl.content, 'chart:axis')) {
    const axisTitle = odfElementText(axis.content, 'chart:title');
    if (axisTitle !== undefined && axis.attrs['chart:dimension']) axisTitles.set(axis.attrs['chart:dimension'], axisTitle);
  }
  const table = safeExtractFirstXmlElement(content, 'table:table');
  const rows = table
    ? safeExtractXmlElements(table.content, 'table:table-row').map((row) =>
        safeExtractXmlElements(row.content, ['table:table-cell', 'table:covered-table-cell']).map((cell) => ({
          text: safeExtractAllText(cell.content).trim(),
          value: cell.attrs['office:value'],
        }))
      )
    : [];
  const [header, ...body] = rows;
  const series = (header ?? []).slice(1).map((cell, index) => ({
    name: cell.text || `Series ${index + 1}`,
    values: body.map((row) => Number(row[index + 1]?.value)).filter((value) => !Number.isNaN(value)),
  }));
  const categories = body.map((row) => row[0]?.text ?? '');
  const xTitle = axisTitles.get('x');
  const yTitle = axisTitles.get('y');
  return {
    type: ODF_CHART_CLASSES[chartEl.attrs['chart:class'] ?? ''] ?? 'bar',
    ...(title ? { title } : {}),
    ...(yTitle ? { valueAxisTitle: yTitle } : {}),
    ...(xTitle ? { categoryAxisTitle: xTitle } : {}),
    categories,
    series,
  };
}

/**
 * The charts of the compound files a slide embeds: the chart sheets of an Excel workbook (what PowerPoint stores) and the OpenDocument
 * chart package an office suite stores. An object that is not a chart is left out, and one that cannot be read is reported.
 */
export async function readEmbeddedCharts(objects: readonly Buffer[], slideNumber: number, warnings: string[]): Promise<OpenXmlChartData[]> {
  const charts: OpenXmlChartData[] = [];
  const chartBudget = new InflateBudget();
  for (const object of objects) {
    if (!isCfbfContainer(object)) continue;
    try {
      const container = parseCfbf(object);
      const odfPackage = container.streams.get(ODF_CHART_STORAGE_STREAM);
      if (odfPackage !== undefined) {
        const chart = await readOdfChartPackage(odfPackage, chartBudget);
        if (chart) charts.push(chart);
        continue;
      }
      const stream = selectWorkbookStream(container);
      if (stream === undefined) continue;
      const worksheets = readBiff8Worksheets(stream);
      charts.push(...readBiffCharts(stream, (worksheet, row, column) => worksheets[worksheet]?.cells.get(row)?.get(column)));
    } catch (error) {
      warnings.push(`Slide ${slideNumber}: an embedded chart could not be read (${error instanceof Error ? error.message : 'unreadable data'}).`);
    }
  }
  return charts;
}

/** What a chart says as text: its title, axis titles, category labels and series names. */
export function chartTextLines(chart: OpenXmlChartData): string[] {
  const lines = [chart.title, chart.valueAxisTitle, chart.categoryAxisTitle].filter((line): line is string => Boolean(line));
  if (chart.categories.some(Boolean)) lines.push(chart.categories.filter(Boolean).join(', '));
  if (chart.series.length > 0) lines.push(chart.series.map((series) => series.name).join(', '));
  return lines;
}
