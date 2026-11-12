import { safeDecodeXmlEntities, safeExtractXmlElements } from '../safe-xml-scanner';
import { safeExtractFirstXmlElement, safeExtractTagContent } from './xml-helpers';
import { type OpenXmlChartData, type OpenXmlChartSeries } from './types';

function extractValuesFromPtXml(containerXml: string): string[] {
  const ptEls = safeExtractXmlElements(containerXml, 'c:pt');
  const results: Array<{ idx: number; val: string }> = [];
  let fallbackIdx = 0;
  for (const pt of ptEls) {
    const idx = pt.attrs.idx !== undefined ? parseInt(pt.attrs.idx, 10) : fallbackIdx++;
    const vContent = safeExtractTagContent(pt.content, 'c:v');
    if (vContent !== null) {
      results.push({ idx, val: safeDecodeXmlEntities(vContent.replace(/<[^>]+>/g, '')).trim() });
    }
  }
  if (results.length > 0) {
    results.sort((a, b) => a.idx - b.idx);
    return results.map((r) => r.val);
  }
  const vEls = safeExtractXmlElements(containerXml, 'c:v');
  return vEls.map((v) => safeDecodeXmlEntities(v.content.replace(/<[^>]+>/g, '')).trim());
}

/**
 * Parses embedded OpenXML <c:chart> XML parts into structured chart model.
 */
export function parseOpenXmlChart(chartXml: string): OpenXmlChartData | null {
  if (
    !chartXml ||
    (!chartXml.includes('<c:chart') &&
      !chartXml.includes('<c:plotArea') &&
      !chartXml.includes('<c:chartSpace>'))
  ) {
    return null;
  }

  // 1. Chart title
  let title: string | undefined;
  const titleEl = safeExtractFirstXmlElement(chartXml, 'c:title');
  if (titleEl) {
    const tEls = [
      ...safeExtractXmlElements(titleEl.content, 'a:t'),
      ...safeExtractXmlElements(titleEl.content, 'c:v'),
    ];
    const joined = tEls
      .map((t) => safeDecodeXmlEntities(t.content.replace(/<[^>]+>/g, '')).trim())
      .filter(Boolean)
      .join(' ');
    if (joined) title = joined;
  }

  // 2. Chart type
  let type: OpenXmlChartData['type'] = 'bar';
  if (/<c:pie(?:3D)?Chart\b/i.test(chartXml)) type = 'pie';
  else if (/<c:line(?:3D)?Chart\b/i.test(chartXml)) type = 'line';
  else if (/<c:area(?:3D)?Chart\b/i.test(chartXml)) type = 'area';
  else if (/<c:doughnutChart\b/i.test(chartXml)) type = 'doughnut';
  else if (/<c:scatterChart\b/i.test(chartXml)) type = 'scatter';
  else if (/<c:bar(?:3D)?Chart\b/i.test(chartXml)) type = 'bar';

  // 3. Series
  const serEls = safeExtractXmlElements(chartXml, 'c:ser');
  const series: OpenXmlChartSeries[] = [];
  let sharedCategories: string[] = [];
  let serIndex = 1;

  for (const serEl of serEls) {
    const serXml = serEl.content;

    // Series name
    let name = `Series ${serIndex++}`;
    const txEl = safeExtractFirstXmlElement(serXml, 'c:tx');
    if (txEl) {
      const vContent = safeExtractTagContent(txEl.content, 'c:v') ?? safeExtractTagContent(txEl.content, 'a:t');
      if (vContent) {
        const decoded = safeDecodeXmlEntities(vContent.replace(/<[^>]+>/g, '')).trim();
        if (decoded) name = decoded;
      }
    }

    // Categories
    const catEl = safeExtractFirstXmlElement(serXml, 'c:cat');
    const categories = catEl ? extractValuesFromPtXml(catEl.raw) : [];
    if (categories.length > 0 && sharedCategories.length === 0) {
      sharedCategories = categories;
    }

    // Values
    const valEl = safeExtractFirstXmlElement(serXml, ['c:val', 'c:yVal']);
    const numStrings = valEl ? extractValuesFromPtXml(valEl.raw) : [];
    const values = numStrings.map((v) => parseFloat(v)).filter((v) => !isNaN(v));

    series.push({
      name,
      values,
      categories: categories.length > 0 ? categories : undefined,
    });
  }

  // Fallback categories if not in series
  if (sharedCategories.length === 0) {
    const axCatEl = safeExtractFirstXmlElement(chartXml, 'c:cat');
    if (axCatEl) {
      sharedCategories = extractValuesFromPtXml(axCatEl.raw);
    }
  }

  if (sharedCategories.length === 0 && series.length > 0) {
    const maxVals = Math.max(0, ...series.map((s) => s.values.length));
    sharedCategories = Array.from({ length: maxVals }, (_, i) => `Item ${i + 1}`);
  }

  return {
    type,
    title,
    ...axisTitlesOf(chartXml),
    categories: sharedCategories,
    series,
  };
}

/** The titles the value axis and the category axis carry (`c:title` inside `c:valAx` and `c:catAx`/`c:dateAx`). */
function axisTitlesOf(chartXml: string): { valueAxisTitle?: string; categoryAxisTitle?: string } {
  const titleOf = (axis: string | string[]): string | undefined => {
    const axisEl = safeExtractFirstXmlElement(chartXml, axis);
    const titleEl = axisEl ? safeExtractFirstXmlElement(axisEl.content, 'c:title') : null;
    if (!titleEl) return undefined;
    const text = safeExtractXmlElements(titleEl.content, 'a:t')
      .map((t) => safeDecodeXmlEntities(t.content.replace(/<[^>]+>/g, '')).trim())
      .filter(Boolean)
      .join(' ');
    return text === '' ? undefined : text;
  };
  const valueAxisTitle = titleOf('c:valAx');
  const categoryAxisTitle = titleOf(['c:catAx', 'c:dateAx']);
  return { ...(valueAxisTitle ? { valueAxisTitle } : {}), ...(categoryAxisTitle ? { categoryAxisTitle } : {}) };
}
