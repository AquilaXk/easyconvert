import { type OpenXmlChartData } from './types';
import { measurePdfTextHeight, renderSafePdfText } from './pdf-text';
import { CHART_PALETTE } from './chart-svg';

/** Tick values 0, step, 2 step ... up to the first multiple of a rounded step (1, 2 or 5 times a power of ten) that covers `max`, about five steps. */
function niceAxisTicks(max: number): number[] {
  const rough = max / 5;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const fraction = rough / magnitude;
  const multiple = [1, 2, 5].find((candidate) => fraction <= candidate) ?? 10;
  const step = multiple * magnitude;
  const count = Math.ceil(max / step - 1e-9);
  return Array.from({ length: count + 1 }, (_, i) => Number((i * step).toPrecision(12)));
}

function formatAxisTick(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Number(value.toPrecision(6)));
}

/** Share of a pie chart's width the list of its slice names takes, on the right. */
const PIE_LEGEND_SHARE = 0.45;

const PIE_LEGEND_FONT_SIZE = 7.5;

export function renderPdfChart(
  doc: PDFKit.PDFDocument,
  chart: OpenXmlChartData,
  hasUnicodeFont: boolean,
  x?: number,
  y?: number,
  width?: number,
  height?: number
): void {
  const startX = x !== undefined ? x : 50;
  const chartWidth = width !== undefined ? width : doc.page.width - 100;
  const circularChart = chart.type === 'pie' || chart.type === 'doughnut';
  const legendLabels = circularChart ? chart.categories : [];
  const legendWidth = chartWidth * PIE_LEGEND_SHARE - 16;
  doc.fontSize(PIE_LEGEND_FONT_SIZE);
  const legendHeights = legendLabels.map((label) => Math.max(PIE_LEGEND_FONT_SIZE + 4, measurePdfTextHeight(doc, label, { width: legendWidth }) + 4));
  const legendHeight = legendHeights.reduce((sum, h) => sum + h, 0);
  // A chart whose size the caller did not give grows to hold the names of all its slices.
  const chartHeight = height !== undefined ? height : Math.max(220, legendHeight + (chart.title ? 40 : 26));

  if (y === undefined && doc.y + chartHeight > doc.page.height - 60) {
    doc.addPage();
  }
  const startY = y !== undefined ? y : doc.y;

  // Chart container background & border
  doc.rect(startX, startY, chartWidth, chartHeight).fillAndStroke('#F8F9FE', '#CCD2FC');

  // Title
  if (chart.title) {
    doc.fillColor('#1F2340').fontSize(11);
    renderSafePdfText(
      doc,
      chart.title,
      hasUnicodeFont,
      { width: chartWidth - 20, align: 'center' },
      startX + 10,
      startY + 8
    );
  }

  // Plot dimensions
  const titleH = chart.title ? 26 : 12;
  const plotLeft = startX + 45;
  const plotRight = startX + chartWidth - 25;
  const plotTop = startY + titleH;
  const plotBottom = startY + chartHeight - (chart.categoryAxisTitle ? 47 : 35);
  const pw = Math.max(10, plotRight - plotLeft);
  const ph = Math.max(10, plotBottom - plotTop);

  const allVals = chart.series.flatMap((s) => s.values);
  const dataMax = Math.max(1, ...allVals);
  const circular = chart.type === 'pie' || chart.type === 'doughnut';
  // Charts with axes scale to a rounded top value and label it, as every chart with a value axis does.
  const ticks = circular ? [] : niceAxisTicks(dataMax);
  const maxVal = ticks.length > 0 ? ticks[ticks.length - 1] : dataMax;

  // Axes
  doc
    .moveTo(plotLeft, plotTop)
    .lineTo(plotLeft, plotBottom)
    .lineTo(plotRight, plotBottom)
    .lineWidth(1)
    .strokeColor('#CCD2FC')
    .stroke();

  // Gridlines and the value axis labels
  const gridSteps = ticks.length > 1 ? ticks.length - 1 : 3;
  for (let i = 0; i <= gridSteps; i++) {
    const gy = plotBottom - (i / gridSteps) * ph;
    doc.moveTo(plotLeft, gy).lineTo(plotRight, gy).lineWidth(0.5).strokeColor('#E1E4EE').stroke();
    if (ticks.length > 0) {
      doc.fillColor('#4D536B').fontSize(7);
      renderSafePdfText(doc, formatAxisTick(ticks[i]), hasUnicodeFont, { width: 36, align: 'right', lineBreak: false }, plotLeft - 40, gy - 4);
    }
  }

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
        doc.rect(bx, by, Math.max(1, barWidth - 1), bHeight).fill(color);
      });
      doc.fillColor('#4D536B').fontSize(7.5);
      renderSafePdfText(
        doc,
        cat,
        hasUnicodeFont,
        { width: catWidth, align: 'center', lineBreak: false },
        plotLeft + cIdx * catWidth,
        plotBottom + 6
      );
    });
  } else if (chart.type === 'line' || chart.type === 'scatter') {
    const numCats = Math.max(1, chart.categories.length);
    const catStep = pw / Math.max(1, numCats - 1);

    chart.series.forEach((s, sIdx) => {
      const color = CHART_PALETTE[sIdx % CHART_PALETTE.length];
      const pts: Array<{ x: number; y: number }> = [];
      s.values.forEach((val, vIdx) => {
        const px = plotLeft + vIdx * catStep;
        const py = plotBottom - Math.max(0, (val / maxVal) * ph);
        pts.push({ x: px, y: py });
      });
      if (pts.length > 1) {
        doc.moveTo(pts[0].x, pts[0].y);
        for (let i = 1; i < pts.length; i++) {
          doc.lineTo(pts[i].x, pts[i].y);
        }
        doc.lineWidth(1.8).strokeColor(color).stroke();
      }
      pts.forEach((p) => {
        doc.circle(p.x, p.y, 2.5).fill(color);
      });
    });

    chart.categories.forEach((cat, cIdx) => {
      doc.fillColor('#4D536B').fontSize(7.5);
      renderSafePdfText(
        doc,
        cat,
        hasUnicodeFont,
        { width: catStep, align: 'center', lineBreak: false },
        plotLeft + cIdx * catStep - catStep / 2,
        plotBottom + 6
      );
    });
  } else if (chart.type === 'area') {
    const numCats = Math.max(1, chart.categories.length);
    const catStep = pw / Math.max(1, numCats - 1);

    chart.series.forEach((s, sIdx) => {
      const color = CHART_PALETTE[sIdx % CHART_PALETTE.length];
      const pts: Array<{ x: number; y: number }> = [];
      s.values.forEach((val, vIdx) => {
        const px = plotLeft + vIdx * catStep;
        const py = plotBottom - Math.max(0, (val / maxVal) * ph);
        pts.push({ x: px, y: py });
      });
      if (pts.length > 1) {
        doc.save();
        doc.moveTo(plotLeft, plotBottom);
        pts.forEach((p) => doc.lineTo(p.x, p.y));
        doc.lineTo(plotLeft + (s.values.length - 1) * catStep, plotBottom);
        doc.closePath();
        doc.fillColor(color).fillOpacity(0.3).fill();
        doc.restore();

        doc.moveTo(pts[0].x, pts[0].y);
        for (let i = 1; i < pts.length; i++) {
          doc.lineTo(pts[i].x, pts[i].y);
        }
        doc.lineWidth(1.8).strokeColor(color).stroke();
      }
    });

    chart.categories.forEach((cat, cIdx) => {
      doc.fillColor('#4D536B').fontSize(7.5);
      renderSafePdfText(
        doc,
        cat,
        hasUnicodeFont,
        { width: catStep, align: 'center', lineBreak: false },
        plotLeft + cIdx * catStep - catStep / 2,
        plotBottom + 6
      );
    });
  } else if (chart.type === 'pie' || chart.type === 'doughnut') {
    const pieWidth = pw * (1 - PIE_LEGEND_SHARE);
    const cx = plotLeft + pieWidth / 2;
    const cy = plotTop + ph / 2;
    const radius = (Math.min(pieWidth, ph) / 2) * 0.8;
    const rInner = chart.type === 'doughnut' ? radius * 0.55 : 0;
    const total = allVals.reduce((a, b) => a + b, 0) || 1;
    let startAngle = -Math.PI / 2;

    allVals.forEach((val, vIdx) => {
      const sliceAngle = (val / total) * 2 * Math.PI;
      const endAngle = startAngle + sliceAngle;
      const color = CHART_PALETTE[vIdx % CHART_PALETTE.length];

      doc.save();
      if (sliceAngle >= 2 * Math.PI - 0.001) {
        if (rInner > 0) {
          doc.circle(cx, cy, radius).fill(color);
          doc.circle(cx, cy, rInner).fill('#F8F9FE');
        } else {
          doc.circle(cx, cy, radius).fill(color);
        }
      } else {
        const steps = Math.max(8, Math.ceil(sliceAngle / 0.1));
        if (rInner > 0) {
          doc.moveTo(cx + radius * Math.cos(startAngle), cy + radius * Math.sin(startAngle));
          for (let step = 0; step <= steps; step++) {
            const theta = startAngle + (step / steps) * sliceAngle;
            doc.lineTo(cx + radius * Math.cos(theta), cy + radius * Math.sin(theta));
          }
          for (let step = steps; step >= 0; step--) {
            const theta = startAngle + (step / steps) * sliceAngle;
            doc.lineTo(cx + rInner * Math.cos(theta), cy + rInner * Math.sin(theta));
          }
          doc.closePath();
          doc.fillColor(color).fill();
        } else {
          doc.moveTo(cx, cy);
          for (let step = 0; step <= steps; step++) {
            const theta = startAngle + (step / steps) * sliceAngle;
            doc.lineTo(cx + radius * Math.cos(theta), cy + radius * Math.sin(theta));
          }
          doc.closePath();
          doc.fillColor(color).fill();
        }
      }
      doc.restore();
      startAngle = endAngle;
    });

    // The name of each slice, beside the swatch of its colour.
    let legendY = plotTop;
    const legendX = startX + chartWidth * (1 - PIE_LEGEND_SHARE);
    legendLabels.forEach((label, index) => {
      doc.rect(legendX, legendY + 1, 8, 8).fill(CHART_PALETTE[index % CHART_PALETTE.length]);
      doc.fillColor('#4D536B').fontSize(PIE_LEGEND_FONT_SIZE);
      renderSafePdfText(doc, label, hasUnicodeFont, { width: legendWidth }, legendX + 12, legendY);
      legendY += legendHeights[index];
    });
  }

  // The titles of the axes: the value axis above its labels, the category axis below the category labels.
  if (chart.valueAxisTitle) {
    doc.fillColor('#4D536B').fontSize(7.5);
    renderSafePdfText(doc, chart.valueAxisTitle, hasUnicodeFont, { width: chartWidth - 20, lineBreak: false }, startX + 10, plotTop - 11);
  }
  if (chart.categoryAxisTitle) {
    doc.fillColor('#4D536B').fontSize(7.5);
    renderSafePdfText(doc, chart.categoryAxisTitle, hasUnicodeFont, { width: pw, align: 'center', lineBreak: false }, plotLeft, plotBottom + 17);
  }

  // Draw legend if multiple series
  if (chart.series.length > 1) {
    let lx = plotLeft;
    const ly = startY + chartHeight - 8;
    chart.series.forEach((s, sIdx) => {
      const color = CHART_PALETTE[sIdx % CHART_PALETTE.length];
      doc.rect(lx, ly - 6, 8, 8).fill(color);
      doc.fillColor('#4D536B').fontSize(7.5);
      renderSafePdfText(doc, s.name, hasUnicodeFont, undefined, lx + 11, ly - 6);
      lx += s.name.length * 5 + 24;
    });
  }

  if (y === undefined) {
    doc.y = startY + chartHeight + 14;
  }
}
