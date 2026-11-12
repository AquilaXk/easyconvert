import { type OpenXmlChartData } from './types';
import { escapeHtml } from './markup-escape';

export const CHART_PALETTE = [
  '#5C6BC0',
  '#26A69A',
  '#FFA726',
  '#EF5350',
  '#AB47BC',
  '#42A5F5',
  '#8D6E63',
  '#78909C',
];

export function adjustHexBrightness(hex: string | undefined, factor: number): string {
  if (!hex || hex === 'none' || !/^#[0-9A-Fa-f]{6}$/.test(hex)) {
    return hex || 'none';
  }
  const r = Math.min(255, Math.max(0, Math.round(parseInt(hex.slice(1, 3), 16) * factor)));
  const g = Math.min(255, Math.max(0, Math.round(parseInt(hex.slice(3, 5), 16) * factor)));
  const b = Math.min(255, Math.max(0, Math.round(parseInt(hex.slice(5, 7), 16) * factor)));
  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
}

/**
 * Renders an OpenXML chart specification into an authentic SVG vector chart element.
 */
export function renderChartToSvg(
  chart: OpenXmlChartData,
  width: number = 500,
  height: number = 300
): string {
  const w = Math.max(200, width);
  const h = Math.max(150, height);
  const titleH = chart.title ? 36 : 16;
  const plotLeft = 60;
  const plotRight = w - 30;
  const plotTop = titleH + 10;
  const plotBottom = h - 45;
  const pw = Math.max(10, plotRight - plotLeft);
  const ph = Math.max(10, plotBottom - plotTop);

  const allVals = chart.series.flatMap((s) => s.values);
  const maxVal = Math.max(1, ...allVals);

  let elements = '';

  // Background and border
  elements += `<rect width="${w}" height="${h}" rx="8" fill="#F8F9FE" stroke="#CCD2FC" stroke-width="1"/>\n`;

  // Title
  if (chart.title) {
    elements += `<text x="${w / 2}" y="24" text-anchor="middle" font-family="-apple-system,BlinkMacSystemFont,sans-serif" font-size="14" font-weight="600" fill="#1F2340">${escapeHtml(
      chart.title
    )}</text>\n`;
  }

  // Gridlines & Y-axis labels
  const gridSteps = 4;
  for (let i = 0; i <= gridSteps; i++) {
    const gy = plotBottom - (i / gridSteps) * ph;
    const gVal = Math.round((i / gridSteps) * maxVal);
    elements += `<line x1="${plotLeft}" y1="${gy}" x2="${plotRight}" y2="${gy}" stroke="#E1E4EE" stroke-width="0.8"/>\n`;
    elements += `<text x="${plotLeft - 8}" y="${
      gy + 4
    }" text-anchor="end" font-family="-apple-system,BlinkMacSystemFont,sans-serif" font-size="9" fill="#78909C">${gVal}</text>\n`;
  }

  // X & Y Axes
  elements += `<line x1="${plotLeft}" y1="${plotTop}" x2="${plotLeft}" y2="${plotBottom}" stroke="#CCD2FC" stroke-width="1.2"/>\n`;
  elements += `<line x1="${plotLeft}" y1="${plotBottom}" x2="${plotRight}" y2="${plotBottom}" stroke="#CCD2FC" stroke-width="1.2"/>\n`;

  // Draw chart type
  if (chart.type === 'bar') {
    const numCats = Math.max(1, chart.categories.length);
    const catWidth = pw / numCats;
    const numSeries = Math.max(1, chart.series.length);
    const barWidth = Math.max(3, (catWidth * 0.7) / numSeries);

    chart.categories.forEach((cat, cIdx) => {
      chart.series.forEach((s, sIdx) => {
        const val = s.values[cIdx] || 0;
        const bHeight = Math.max(0, (val / maxVal) * ph);
        const bx = plotLeft + cIdx * catWidth + catWidth * 0.15 + sIdx * barWidth;
        const by = plotBottom - bHeight;
        const color = CHART_PALETTE[sIdx % CHART_PALETTE.length];
        elements += `<rect x="${bx}" y="${by}" width="${Math.max(
          1,
          barWidth - 2
        )}" height="${bHeight}" rx="2" fill="${color}"/>\n`;
      });
      elements += `<text x="${plotLeft + cIdx * catWidth + catWidth / 2}" y="${
        plotBottom + 16
      }" text-anchor="middle" font-family="-apple-system,BlinkMacSystemFont,sans-serif" font-size="10" fill="#4D536B">${escapeHtml(
        cat
      )}</text>\n`;
    });
  } else if (chart.type === 'line' || chart.type === 'scatter') {
    const numCats = Math.max(1, chart.categories.length);
    const catStep = pw / Math.max(1, numCats - 1);

    chart.series.forEach((s, sIdx) => {
      const color = CHART_PALETTE[sIdx % CHART_PALETTE.length];
      const pts: string[] = [];
      s.values.forEach((val, vIdx) => {
        const px = plotLeft + vIdx * catStep;
        const py = plotBottom - Math.max(0, (val / maxVal) * ph);
        pts.push(`${px},${py}`);
        elements += `<circle cx="${px}" cy="${py}" r="3.5" fill="${color}" stroke="#FFFFFF" stroke-width="1.5"/>\n`;
      });
      if (pts.length > 1) {
        elements += `<polyline points="${pts.join(
          ' '
        )}" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>\n`;
      }
    });

    chart.categories.forEach((cat, cIdx) => {
      elements += `<text x="${plotLeft + cIdx * catStep}" y="${
        plotBottom + 16
      }" text-anchor="middle" font-family="-apple-system,BlinkMacSystemFont,sans-serif" font-size="10" fill="#4D536B">${escapeHtml(
        cat
      )}</text>\n`;
    });
  } else if (chart.type === 'pie' || chart.type === 'doughnut') {
    const cx = plotLeft + pw / 2;
    const cy = plotTop + ph / 2;
    const rOuter = (Math.min(pw, ph) / 2) * 0.85;
    const rInner = chart.type === 'doughnut' ? rOuter * 0.55 : 0;
    const total = allVals.reduce((a, b) => a + b, 0) || 1;
    let startAngle = -Math.PI / 2;

    allVals.forEach((val, vIdx) => {
      const sliceAngle = (val / total) * 2 * Math.PI;
      const endAngle = startAngle + sliceAngle;
      const color = CHART_PALETTE[vIdx % CHART_PALETTE.length];

      if (sliceAngle >= 2 * Math.PI - 0.001) {
        if (rInner > 0) {
          const dRing = `M ${cx} ${cy - rOuter} A ${rOuter} ${rOuter} 0 1 1 ${cx} ${cy + rOuter} A ${rOuter} ${rOuter} 0 1 1 ${cx} ${cy - rOuter} M ${cx} ${cy - rInner} A ${rInner} ${rInner} 0 1 0 ${cx} ${cy + rInner} A ${rInner} ${rInner} 0 1 0 ${cx} ${cy - rInner} Z`;
          elements += `<path d="${dRing}" fill="${color}" stroke="#FFFFFF" stroke-width="1.5" fill-rule="evenodd"/>\n`;
        } else {
          elements += `<circle cx="${cx}" cy="${cy}" r="${rOuter}" fill="${color}" stroke="#FFFFFF" stroke-width="1.5"/>\n`;
        }
        return;
      }

      const x1 = cx + rOuter * Math.cos(startAngle);
      const y1 = cy + rOuter * Math.sin(startAngle);
      const x2 = cx + rOuter * Math.cos(endAngle);
      const y2 = cy + rOuter * Math.sin(endAngle);
      const largeArc = sliceAngle > Math.PI ? 1 : 0;

      let d = '';
      if (rInner > 0) {
        const x3 = cx + rInner * Math.cos(endAngle);
        const y3 = cy + rInner * Math.sin(endAngle);
        const x4 = cx + rInner * Math.cos(startAngle);
        const y4 = cy + rInner * Math.sin(startAngle);
        d = `M ${x1} ${y1} A ${rOuter} ${rOuter} 0 ${largeArc} 1 ${x2} ${y2} L ${x3} ${y3} A ${rInner} ${rInner} 0 ${largeArc} 0 ${x4} ${y4} Z`;
      } else {
        d = `M ${cx} ${cy} L ${x1} ${y1} A ${rOuter} ${rOuter} 0 ${largeArc} 1 ${x2} ${y2} Z`;
      }

      elements += `<path d="${d}" fill="${color}" stroke="#FFFFFF" stroke-width="1.5"/>\n`;
      startAngle = endAngle;
    });
  } else if (chart.type === 'area') {
    const numCats = Math.max(1, chart.categories.length);
    const catStep = pw / Math.max(1, numCats - 1);

    chart.series.forEach((s, sIdx) => {
      const color = CHART_PALETTE[sIdx % CHART_PALETTE.length];
      const pts: string[] = [];
      s.values.forEach((val, vIdx) => {
        const px = plotLeft + vIdx * catStep;
        const py = plotBottom - Math.max(0, (val / maxVal) * ph);
        pts.push(`${px},${py}`);
      });
      if (pts.length > 1) {
        const areaPath = `M ${plotLeft} ${plotBottom} L ${pts.join(' L ')} L ${
          plotLeft + (s.values.length - 1) * catStep
        } ${plotBottom} Z`;
        elements += `<path d="${areaPath}" fill="${color}" fill-opacity="0.3" stroke="${color}" stroke-width="2"/>\n`;
      }
    });

    chart.categories.forEach((cat, cIdx) => {
      elements += `<text x="${plotLeft + cIdx * catStep}" y="${
        plotBottom + 16
      }" text-anchor="middle" font-family="-apple-system,BlinkMacSystemFont,sans-serif" font-size="10" fill="#4D536B">${escapeHtml(
        cat
      )}</text>\n`;
    });
  }

  // Legend if multiple series or pie/doughnut slices
  if (chart.series.length > 1) {
    let lx = plotLeft;
    const ly = h - 12;
    chart.series.forEach((s, sIdx) => {
      const color = CHART_PALETTE[sIdx % CHART_PALETTE.length];
      elements += `<rect x="${lx}" y="${ly - 7}" width="8" height="8" rx="2" fill="${color}"/>\n`;
      elements += `<text x="${lx + 12}" y="${ly}" font-family="-apple-system,BlinkMacSystemFont,sans-serif" font-size="9" fill="#4D536B">${escapeHtml(
        s.name
      )}</text>\n`;
      lx += s.name.length * 6 + 28;
    });
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">\n${elements}</svg>`;
}
