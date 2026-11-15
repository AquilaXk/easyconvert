import { ConversionOptions } from '../../types';
import PDFDocument from 'pdfkit';
import { type DocxBlockElement, type DocxParagraph, type DocxTable, type DocxTableCell } from './types';
import { configurePdfKitFontFallback, measurePdfTextHeight, renderSafePdfText } from './pdf-text';
import { renderPdfChart } from './pdf-chart';
import { renderPdfDrawingShapes } from './pdf-shapes';

const PAGE_MARGIN_X = 50;
const PAGE_BOTTOM_RESERVE = 60;
const MIN_ROW_HEIGHT = 20;
const MIN_NESTED_ROW_HEIGHT = 16;

interface NestedTablePlan {
  rows: DocxTableCell[][];
  colWidth: number;
  rowHeights: number[];
}

interface CellLayoutPlan {
  x: number;
  width: number;
  textHeight: number;
  requiredHeight: number;
  nestedPlans: NestedTablePlan[];
}

/** The tables nested in a cell: the list when it has one, else the single table when it has rows. */
function nestedTablesOf(cell: DocxTableCell): DocxTable[] {
  if (cell.nestedTables && cell.nestedTables.length > 0) return cell.nestedTables;
  return cell.nestedTable && cell.nestedTable.rows.length > 0 ? [cell.nestedTable] : [];
}

function pdfAlignmentOf(alignment: DocxParagraph['alignment']): 'center' | 'right' | 'left' {
  if (alignment === 'center') return 'center';
  return alignment === 'right' ? 'right' : 'left';
}

function computeGridColWidths(tbl: DocxTable, colCount: number, availableWidth: number): number[] {
  const widths: number[] = [];
  if (tbl.colWidths && tbl.colWidths.length > 0) {
    let totalGridW = 0;
    for (let i = 0; i < tbl.colWidths.length; i++) totalGridW += tbl.colWidths[i];
    if (totalGridW > 0) {
      const fallbackRaw = totalGridW / tbl.colWidths.length;
      for (let i = 0; i < colCount; i++) {
        const rawW = tbl.colWidths[i] ?? fallbackRaw;
        widths.push((rawW / totalGridW) * availableWidth);
      }
      return widths;
    }
  }
  const defaultW = availableWidth / colCount;
  for (let i = 0; i < colCount; i++) widths.push(defaultW);
  return widths;
}

function buildColOffsets(gridColWidths: readonly number[]): Float64Array {
  const offsets = new Float64Array(gridColWidths.length + 1);
  offsets[0] = PAGE_MARGIN_X;
  for (let i = 0; i < gridColWidths.length; i++) {
    offsets[i + 1] = offsets[i] + gridColWidths[i];
  }
  return offsets;
}

function resolveSpanBox(
  colOffsets: Float64Array,
  gridColWidths: readonly number[],
  gridIdx: number,
  span: number
): { x: number; width: number } {
  const nCols = gridColWidths.length;
  const lastW = gridColWidths[nCols - 1];
  const clampedStart = Math.min(gridIdx, nCols);
  const overflowBefore = Math.max(0, gridIdx - nCols);
  const startX = colOffsets[clampedStart] + overflowBefore * lastW;
  const endGrid = gridIdx + span;
  const clampedEnd = Math.min(endGrid, nCols);
  const overflowEnd = Math.max(0, endGrid - nCols);
  const endX = colOffsets[clampedEnd] + overflowEnd * lastW;
  return { x: startX, width: endX - startX };
}

function normalizeNestedRows(nTbl: DocxTable): DocxTableCell[][] {
  if (nTbl.structuredRows && nTbl.structuredRows.length > 0) return nTbl.structuredRows;
  return nTbl.rows.map((r) => r.map((c) => ({ text: c })));
}

function measureNestedTables(doc: PDFKit.PDFDocument, tables: readonly DocxTable[], cellWidth: number): { plans: NestedTablePlan[]; totalHeight: number } {
  const plans: NestedTablePlan[] = [];
  let totalHeight = 0;
  doc.fontSize(7.5);
  for (let t = 0; t < tables.length; t++) {
    const nTbl = tables[t];
    const rows = normalizeNestedRows(nTbl);
    const nColCount = Math.max(1, nTbl.colCount || nTbl.colWidths?.length || rows[0]?.length || 1);
    const colWidth = Math.max(10, (cellWidth - 8) / nColCount);
    const measureW = Math.max(5, colWidth - 6);
    const rowHeights: number[] = [];
    for (let r = 0; r < rows.length; r++) {
      const nRow = rows[r];
      let maxSubH = MIN_NESTED_ROW_HEIGHT;
      for (let c = 0; c < nRow.length; c++) {
        const subText = nRow[c]?.text || ' ';
        const subTh = measurePdfTextHeight(doc, subText, { width: measureW });
        if (subTh + 6 > maxSubH) maxSubH = Math.ceil(subTh + 6);
      }
      rowHeights.push(maxSubH);
      totalHeight += maxSubH;
    }
    totalHeight += 4;
    plans.push({ rows, colWidth, rowHeights });
  }
  return { plans, totalHeight };
}

function measureStructuredTable(
  doc: PDFKit.PDFDocument,
  sRows: readonly DocxTableCell[][],
  gridColWidths: readonly number[],
  colOffsets: Float64Array
): { plans: CellLayoutPlan[][]; rowHeights: number[] } {
  const plans: CellLayoutPlan[][] = [];
  const rowHeights = new Array<number>(sRows.length).fill(MIN_ROW_HEIGHT);

  for (let rIdx = 0; rIdx < sRows.length; rIdx++) {
    const sRow = sRows[rIdx];
    const rowPlans: CellLayoutPlan[] = [];
    let currentGridIdx = 0;

    for (let cIdx = 0; cIdx < sRow.length; cIdx++) {
      const cell = sRow[cIdx];
      const span = Math.max(1, cell.colSpan || 1);
      const { x, width } = resolveSpanBox(colOffsets, gridColWidths, currentGridIdx, span);
      currentGridIdx += span;

      if (cell.rowSpan === 0) {
        rowPlans.push({ x, width, textHeight: 0, requiredHeight: 0, nestedPlans: [] });
        continue;
      }

      const textWidth = Math.max(10, width - 10);
      doc.fontSize(cell.isHeader || rIdx === 0 ? 9 : 8.5);
      const cellText = cell.text || '';
      const textHeight = cellText.trim().length > 0 ? measurePdfTextHeight(doc, cellText, { width: textWidth }) : 0;
      let requiredHeight = Math.ceil(textHeight + 10);

      const nested = nestedTablesOf(cell);
      let nestedPlans: NestedTablePlan[] = [];
      if (nested.length > 0) {
        const measured = measureNestedTables(doc, nested, width);
        nestedPlans = measured.plans;
        requiredHeight += measured.totalHeight;
      } else if (cell.fullCellText && cell.fullCellText !== cell.text) {
        const fullH = measurePdfTextHeight(doc, cell.fullCellText, { width: textWidth });
        requiredHeight = Math.max(requiredHeight, Math.ceil(fullH + 10));
      }

      if ((cell.rowSpan ?? 1) <= 1 && requiredHeight > rowHeights[rIdx]) {
        rowHeights[rIdx] = requiredHeight;
      }
      rowPlans.push({ x, width, textHeight, requiredHeight, nestedPlans });
    }
    plans.push(rowPlans);
  }

  // Distribute multi-row spanned cell height deficits across their spanned rows.
  for (let rIdx = 0; rIdx < sRows.length; rIdx++) {
    const sRow = sRows[rIdx];
    const rowPlans = plans[rIdx];
    for (let cIdx = 0; cIdx < sRow.length; cIdx++) {
      const rSpan = sRow[cIdx].rowSpan ?? 1;
      if (rSpan <= 1) continue;
      const endRow = Math.min(sRows.length - 1, rIdx + rSpan - 1);
      let spannedHeight = 0;
      for (let k = rIdx; k <= endRow; k++) spannedHeight += rowHeights[k];
      if (rowPlans[cIdx].requiredHeight > spannedHeight) {
        rowHeights[endRow] += rowPlans[cIdx].requiredHeight - spannedHeight;
      }
    }
  }

  return { plans, rowHeights };
}

function drawCellBordersAndBackground(
  doc: PDFKit.PDFDocument,
  tbl: DocxTable,
  cell: DocxTableCell,
  rIdx: number,
  box: { x: number; y: number; width: number; height: number }
): void {
  const { x, y, width, height } = box;
  if (cell.shading && cell.shading !== 'auto') {
    doc.rect(x, y, width, height).fill('#' + cell.shading);
  } else if (cell.isHeader || rIdx === 0) {
    doc.rect(x, y, width, height).fill('#F0F2FE');
  }

  if (!cell.borders && !tbl.tblBorders) {
    doc.rect(x, y, width, height).strokeColor('#CCD2FC').lineWidth(0.5).stroke();
    return;
  }

  const top = cell.borders?.top || tbl.tblBorders?.top;
  const bottom = cell.borders?.bottom || tbl.tblBorders?.bottom;
  const left = cell.borders?.left || tbl.tblBorders?.left;
  const right = cell.borders?.right || tbl.tblBorders?.right;
  if (top && top.style !== 'none') {
    doc.moveTo(x, y).lineTo(x + width, y).lineWidth(top.size || 0.5).strokeColor(top.color || '#CCD2FC').stroke();
  }
  if (bottom && bottom.style !== 'none') {
    doc.moveTo(x, y + height).lineTo(x + width, y + height).lineWidth(bottom.size || 0.5).strokeColor(bottom.color || '#CCD2FC').stroke();
  }
  if (left && left.style !== 'none') {
    doc.moveTo(x, y).lineTo(x, y + height).lineWidth(left.size || 0.5).strokeColor(left.color || '#CCD2FC').stroke();
  }
  if (right && right.style !== 'none') {
    doc.moveTo(x + width, y).lineTo(x + width, y + height).lineWidth(right.size || 0.5).strokeColor(right.color || '#CCD2FC').stroke();
  }
}

function drawNestedTablePlans(
  doc: PDFKit.PDFDocument,
  nestedPlans: readonly NestedTablePlan[],
  hasUnicodeFont: boolean,
  x: number,
  startY: number
): number {
  let curY = startY;
  for (let p = 0; p < nestedPlans.length; p++) {
    const plan = nestedPlans[p];
    const nX = x + 4;
    const nColW = plan.colWidth;
    for (let nrIdx = 0; nrIdx < plan.rows.length; nrIdx++) {
      const nRow = plan.rows[nrIdx];
      const nRowH = plan.rowHeights[nrIdx];
      for (let ncIdx = 0; ncIdx < nRow.length; ncIdx++) {
        const nCell = nRow[ncIdx];
        const cellSubX = nX + ncIdx * nColW;
        if (nCell.shading && nCell.shading !== 'auto') {
          doc.rect(cellSubX, curY, nColW, nRowH).fill('#' + nCell.shading);
        } else if (nCell.isHeader || nrIdx === 0) {
          doc.rect(cellSubX, curY, nColW, nRowH).fill('#E8EAF6');
        }
        doc.rect(cellSubX, curY, nColW, nRowH).strokeColor('#B0B8E8').lineWidth(0.5).stroke();
        doc.fillColor('#2C304E').fontSize(7.5);
        renderSafePdfText(
          doc,
          nCell.text || '',
          hasUnicodeFont,
          { width: nColW - 6, lineBreak: true, align: nCell.alignment || 'left' },
          cellSubX + 3,
          curY + 3
        );
      }
      curY += nRowH;
    }
    curY += 4;
  }
  return curY;
}

function computeSpannedDrawHeight(
  doc: PDFKit.PDFDocument,
  rowHeights: readonly number[],
  rIdx: number,
  rowSpan: number | undefined,
  y: number
): number {
  const baseH = rowHeights[rIdx];
  const span = Math.max(1, rowSpan || 1);
  if (span <= 1) return baseH;
  const endRow = Math.min(rowHeights.length - 1, rIdx + span - 1);
  let total = 0;
  for (let k = rIdx; k <= endRow; k++) total += rowHeights[k];
  const maxOnPage = doc.page.height - PAGE_BOTTOM_RESERVE - y;
  return total <= maxOnPage ? total : Math.max(baseH, maxOnPage);
}

function renderSimpleRows(doc: PDFKit.PDFDocument, rows: readonly string[][], availableWidth: number, hasUnicodeFont: boolean): void {
  const measuredHeights = new Float64Array(rows.length > 0 ? Math.max(...rows.map((r) => r.length), 1) : 1);
  for (let rIdx = 0; rIdx < rows.length; rIdx++) {
    const row = rows[rIdx];
    const isHdr = rIdx === 0;
    const colWidth = availableWidth / Math.max(1, row.length);
    const textWidth = Math.max(10, colWidth - 10);
    doc.fontSize(isHdr ? 9 : 8.5);
    let rowHeight = MIN_ROW_HEIGHT;
    for (let cIdx = 0; cIdx < row.length; cIdx++) {
      const th = measurePdfTextHeight(doc, row[cIdx] || ' ', { width: textWidth });
      measuredHeights[cIdx] = th;
      const reqH = Math.ceil(th + 10);
      if (reqH > rowHeight) rowHeight = reqH;
    }

    if (doc.y + rowHeight > doc.page.height - PAGE_BOTTOM_RESERVE) doc.addPage();
    const y = doc.y;
    doc.rect(PAGE_MARGIN_X, y, availableWidth, rowHeight).strokeColor('#CCD2FC').lineWidth(0.5);
    if (isHdr) {
      doc.rect(PAGE_MARGIN_X, y, availableWidth, rowHeight).fill('#F0F2FE');
      doc.fillColor('#1F2340').fontSize(9);
    } else {
      doc.fillColor('#4D536B').fontSize(8.5);
    }

    const align = isHdr ? 'center' : 'left';
    for (let cIdx = 0; cIdx < row.length; cIdx++) {
      renderSafePdfText(
        doc,
        row[cIdx],
        hasUnicodeFont,
        { width: colWidth - 10, lineBreak: true, align },
        PAGE_MARGIN_X + cIdx * colWidth + 5,
        y + 5
      );
    }
    doc.y = y + rowHeight;
  }
}

function renderDocxTable(doc: PDFKit.PDFDocument, tbl: DocxTable, hasUnicodeFont: boolean): void {
  if (tbl.rows.length === 0) return;
  doc.moveDown(0.8);
  const colCount = Math.max(1, tbl.colCount || (tbl.colWidths ? tbl.colWidths.length : tbl.rows[0].length));
  const availableWidth = doc.page.width - PAGE_MARGIN_X * 2;
  const gridColWidths = computeGridColWidths(tbl, colCount, availableWidth);
  const colOffsets = buildColOffsets(gridColWidths);

  if (tbl.structuredRows && tbl.structuredRows.length > 0) {
    const sRows = tbl.structuredRows;
    const { plans, rowHeights } = measureStructuredTable(doc, sRows, gridColWidths, colOffsets);

    for (let rIdx = 0; rIdx < sRows.length; rIdx++) {
      const sRow = sRows[rIdx];
      const rowPlans = plans[rIdx];
      const rowHeight = rowHeights[rIdx];

      if (doc.y + rowHeight > doc.page.height - PAGE_BOTTOM_RESERVE) doc.addPage();
      const y = doc.y;

      for (let cIdx = 0; cIdx < sRow.length; cIdx++) {
        const cell = sRow[cIdx];
        if (cell.rowSpan === 0) continue;
        const plan = rowPlans[cIdx];
        const drawHeight = computeSpannedDrawHeight(doc, rowHeights, rIdx, cell.rowSpan, y);

        drawCellBordersAndBackground(doc, tbl, cell, rIdx, {
          x: plan.x,
          y,
          width: plan.width,
          height: drawHeight,
        });

        const isHdr = Boolean(cell.isHeader || rIdx === 0);
        doc.fillColor(isHdr ? '#1F2340' : '#4D536B').fontSize(isHdr ? 9 : 8.5);
        const align = cell.alignment || (isHdr ? 'center' : 'left');
        let textOffsetY = y + 5;
        if (cell.text && cell.text.trim().length > 0) {
          renderSafePdfText(
            doc,
            cell.text,
            hasUnicodeFont,
            { width: plan.width - 10, lineBreak: true, align },
            plan.x + 5,
            textOffsetY
          );
          textOffsetY += Math.ceil(plan.textHeight + 4);
        }

        if (plan.nestedPlans.length > 0) {
          drawNestedTablePlans(doc, plan.nestedPlans, hasUnicodeFont, plan.x, textOffsetY);
        } else if (!cell.text && cell.fullCellText) {
          renderSafePdfText(
            doc,
            cell.fullCellText,
            hasUnicodeFont,
            { width: plan.width - 10, lineBreak: true, align },
            plan.x + 5,
            y + 5
          );
        }
      }

      doc.y = y + rowHeight;
    }
  } else {
    renderSimpleRows(doc, tbl.rows, availableWidth, hasUnicodeFont);
  }
  doc.moveDown(0.4);
}

export async function generatePdfFromDocx(
  paragraphs: DocxParagraph[],
  tables: DocxTable[],
  options: ConversionOptions,
  title: string,
  elements?: DocxBlockElement[]
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const isLandscape = options.orientation === 'landscape';
    const doc = new PDFDocument({
      size: 'A4',
      layout: isLandscape ? 'landscape' : 'portrait',
      margin: PAGE_MARGIN_X,
      info: { Title: title, Creator: 'EasyConvert Office Engine' },
    });

    const chunks: Buffer[] = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', (err) => reject(err));

    const { hasUnicodeFont } = configurePdfKitFontFallback(doc);

    const renderParagraph = (p: DocxParagraph) => {
      // Cells, shapes and charts are drawn at absolute positions and leave doc.x at the last one; a paragraph starts at the margin.
      doc.x = doc.page.margins.left;
      if (p.isHeading) {
        doc.moveDown(0.5);
        doc.fillColor('#5C6BC0').fontSize(p.headingLevel === 1 ? 16 : 14);
        renderSafePdfText(doc, p.text, hasUnicodeFont);
        doc.moveDown(0.25);
      } else {
        doc.fillColor(p.isBold ? '#1F2340' : '#4D536B').fontSize(10.5).lineGap(3);
        renderSafePdfText(doc, p.text, hasUnicodeFont, {
          align: pdfAlignmentOf(p.alignment),
        });
        doc.moveDown(0.4);
      }
    };

    if (elements && elements.length > 0) {
      for (const el of elements) {
        if (el.type === 'paragraph') renderParagraph(el.paragraph);
        else if (el.type === 'table') renderDocxTable(doc, el.table, hasUnicodeFont);
        else if (el.type === 'drawing') {
          if (el.chart) {
            renderPdfChart(doc, el.chart, hasUnicodeFont);
          } else if (el.shapes && el.shapes.length > 0) {
            renderPdfDrawingShapes(doc, el.shapes, hasUnicodeFont);
          }
        }
      }
    } else {
      for (const p of paragraphs) renderParagraph(p);
      for (const tbl of tables) renderDocxTable(doc, tbl, hasUnicodeFont);
    }

    doc.end();
  });
}
