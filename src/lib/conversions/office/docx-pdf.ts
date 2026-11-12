import { ConversionOptions } from '../../types';
import PDFDocument from 'pdfkit';
import { type DocxBlockElement, type DocxParagraph, type DocxTable, type DocxTableCell } from './types';
import { configurePdfKitFontFallback, measurePdfTextHeight, renderSafePdfText } from './pdf-text';
import { renderPdfChart } from './pdf-chart';
import { renderPdfDrawingShapes } from './pdf-shapes';

/** The tables nested in a cell: the list when it has one, else the single table when it has rows. */
function nestedTablesOf(cell: DocxTableCell): DocxTable[] {
  if (cell.nestedTables && cell.nestedTables.length > 0) return cell.nestedTables;
  return cell.nestedTable && cell.nestedTable.rows.length > 0 ? [cell.nestedTable] : [];
}

function pdfAlignmentOf(alignment: DocxParagraph['alignment']): 'center' | 'right' | 'left' {
  if (alignment === 'center') return 'center';
  return alignment === 'right' ? 'right' : 'left';
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
      margin: 50,
      info: { Title: title, Creator: 'EasyConvert Office Engine' },
    });

    const chunks: Buffer[] = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', (err) => reject(err));

    const { hasUnicodeFont } = configurePdfKitFontFallback(doc);

    const renderTable = (tbl: DocxTable) => {
      if (tbl.rows.length === 0) return;
      doc.moveDown(0.8);
      const colCount = Math.max(1, tbl.colCount || (tbl.colWidths ? tbl.colWidths.length : tbl.rows[0].length));
      const availableWidth = doc.page.width - 100;

      // Compute base grid column widths from w:gridCol or fallback evenly
      const gridColWidths: number[] = [];
      if (tbl.colWidths && tbl.colWidths.length > 0) {
        const totalGridW = tbl.colWidths.reduce((sum, w) => sum + w, 0);
        if (totalGridW > 0) {
          for (let i = 0; i < colCount; i++) {
            const rawW = tbl.colWidths[i] ?? (totalGridW / tbl.colWidths.length);
            gridColWidths.push((rawW / totalGridW) * availableWidth);
          }
        }
      }
      if (gridColWidths.length === 0) {
        const defaultW = availableWidth / colCount;
        for (let i = 0; i < colCount; i++) {
          gridColWidths.push(defaultW);
        }
      }

      if (tbl.structuredRows && tbl.structuredRows.length > 0) {
        tbl.structuredRows.forEach((sRow, rIdx) => {
          // 1. Calculate cell widths and starting X positions using gridSpan / colSpan
          const cellWidths: number[] = [];
          const cellXPositions: number[] = [];
          let currentGridIdx = 0;

          sRow.forEach((cell) => {
            const span = Math.max(1, cell.colSpan || 1);
            let cellW = 0;
            for (let s = 0; s < span; s++) {
              const gIdx = Math.min(currentGridIdx + s, gridColWidths.length - 1);
              cellW += gridColWidths[gIdx] ?? (availableWidth / colCount);
            }
            let startX = 50;
            for (let k = 0; k < currentGridIdx; k++) {
              const gIdx = Math.min(k, gridColWidths.length - 1);
              startX += gridColWidths[gIdx] ?? (availableWidth / colCount);
            }
            cellWidths.push(cellW);
            cellXPositions.push(startX);
            currentGridIdx += span;
          });

          // 2. Compute dynamic row height based on wrapped text height across all cells
          let maxCellHeight = 20;
          sRow.forEach((cell, cIdx) => {
            if (cell.rowSpan === 0) return;
            const cWidth = cellWidths[cIdx];
            const textWidth = Math.max(10, cWidth - 10);
            const fontSize = cell.isHeader || rIdx === 0 ? 9 : 8.5;
            doc.fontSize(fontSize);
            const cellText = cell.text || '';
            const textHeight = cellText.trim().length > 0 ? measurePdfTextHeight(doc, cellText, { width: textWidth }) : 0;
            let requiredHeight = Math.ceil(textHeight + 10);

            const tablesToRender = nestedTablesOf(cell);

            if (tablesToRender.length > 0) {
              for (const nTbl of tablesToRender) {
                const nRows =
                  nTbl.structuredRows && nTbl.structuredRows.length > 0
                    ? nTbl.structuredRows
                    : nTbl.rows;
                const nColCount = Math.max(
                  1,
                  nTbl.colCount || nTbl.colWidths?.length || (nRows[0]?.length || 1)
                );
                const nColW = Math.max(10, (cWidth - 8) / nColCount);
                doc.fontSize(7.5);
                for (const rowItem of nRows) {
                  let maxSubH = 16;
                  if (Array.isArray(rowItem)) {
                    for (const subCell of rowItem) {
                      const subText = typeof subCell === 'string' ? subCell : (subCell?.text || '');
                      const subTh = measurePdfTextHeight(doc, subText || ' ', { width: Math.max(5, nColW - 6) });
                      if (subTh + 6 > maxSubH) maxSubH = Math.ceil(subTh + 6);
                    }
                  }
                  requiredHeight += maxSubH;
                }
                requiredHeight += 4;
              }
            } else if (cell.fullCellText && cell.fullCellText !== cell.text) {
              const fullH = measurePdfTextHeight(doc, cell.fullCellText, { width: textWidth });
              requiredHeight = Math.max(requiredHeight, Math.ceil(fullH + 10));
            }
            if (requiredHeight > maxCellHeight) {
              maxCellHeight = requiredHeight;
            }
          });

          const rowHeight = maxCellHeight;

          // Check page overflow
          if (doc.y + rowHeight > doc.page.height - 60) {
            doc.addPage();
          }
          const y = doc.y;

          // 3. Render each cell
          sRow.forEach((cell, cIdx) => {
            if (cell.rowSpan === 0) return;
            const x = cellXPositions[cIdx];
            const colWidth = cellWidths[cIdx];

            if (cell.shading && cell.shading !== 'auto') {
              doc.rect(x, y, colWidth, rowHeight).fill('#' + cell.shading);
            } else if (cell.isHeader || rIdx === 0) {
              doc.rect(x, y, colWidth, rowHeight).fill('#F0F2FE');
            }

            const topBorder = cell.borders?.top || tbl.tblBorders?.top;
            const bottomBorder = cell.borders?.bottom || tbl.tblBorders?.bottom;
            const leftBorder = cell.borders?.left || tbl.tblBorders?.left;
            const rightBorder = cell.borders?.right || tbl.tblBorders?.right;

            if (cell.borders || tbl.tblBorders) {
              if (topBorder && topBorder.style !== 'none') {
                doc
                  .moveTo(x, y)
                  .lineTo(x + colWidth, y)
                  .lineWidth(topBorder.size || 0.5)
                  .strokeColor(topBorder.color || '#CCD2FC')
                  .stroke();
              }
              if (bottomBorder && bottomBorder.style !== 'none') {
                doc
                  .moveTo(x, y + rowHeight)
                  .lineTo(x + colWidth, y + rowHeight)
                  .lineWidth(bottomBorder.size || 0.5)
                  .strokeColor(bottomBorder.color || '#CCD2FC')
                  .stroke();
              }
              if (leftBorder && leftBorder.style !== 'none') {
                doc
                  .moveTo(x, y)
                  .lineTo(x, y + rowHeight)
                  .lineWidth(leftBorder.size || 0.5)
                  .strokeColor(leftBorder.color || '#CCD2FC')
                  .stroke();
              }
              if (rightBorder && rightBorder.style !== 'none') {
                doc
                  .moveTo(x + colWidth, y)
                  .lineTo(x + colWidth, y + rowHeight)
                  .lineWidth(rightBorder.size || 0.5)
                  .strokeColor(rightBorder.color || '#CCD2FC')
                  .stroke();
              }
            } else {
              doc.rect(x, y, colWidth, rowHeight).strokeColor('#CCD2FC').lineWidth(0.5).stroke();
            }

            const textCol = cell.isHeader || rIdx === 0 ? '#1F2340' : '#4D536B';
            doc.fillColor(textCol).fontSize(cell.isHeader || rIdx === 0 ? 9 : 8.5);
            const align = cell.alignment || (cell.isHeader || rIdx === 0 ? 'center' : 'left');
            let textOffsetY = y + 5;
            if (cell.text && cell.text.trim().length > 0) {
              renderSafePdfText(
                doc,
                cell.text,
                hasUnicodeFont,
                { width: colWidth - 10, lineBreak: true, align },
                x + 5,
                textOffsetY
              );
              const tH = measurePdfTextHeight(doc, cell.text, { width: colWidth - 10 });
              textOffsetY += Math.ceil(tH + 4);
            }

            const tablesToRender = nestedTablesOf(cell);

            if (tablesToRender.length > 0) {
              for (const nTbl of tablesToRender) {
                const nX = x + 4;
                const nY = textOffsetY;
                const nW = colWidth - 8;
                const nRows =
                  nTbl.structuredRows && nTbl.structuredRows.length > 0
                    ? nTbl.structuredRows
                    : nTbl.rows.map((r) => r.map((c) => ({ text: c } as DocxTableCell)));
                const nColCount = Math.max(
                  1,
                  nTbl.colCount || (nTbl.colWidths ? nTbl.colWidths.length : (nRows[0]?.length || 1))
                );
                const nColW = nW / nColCount;

                let curNY = nY;
                nRows.forEach((nRow, nrIdx) => {
                  let nRowH = 16;
                  doc.fontSize(7.5);
                  nRow.forEach((nCell) => {
                    const nText = nCell.text || '';
                    const nTh = measurePdfTextHeight(doc, nText || ' ', { width: Math.max(5, nColW - 6) });
                    if (nTh + 6 > nRowH) nRowH = Math.ceil(nTh + 6);
                  });

                  nRow.forEach((nCell, ncIdx) => {
                    const cellSubX = nX + ncIdx * nColW;
                    if (nCell.shading && nCell.shading !== 'auto') {
                      doc.rect(cellSubX, curNY, nColW, nRowH).fill('#' + nCell.shading);
                    } else if (nCell.isHeader || nrIdx === 0) {
                      doc.rect(cellSubX, curNY, nColW, nRowH).fill('#E8EAF6');
                    }
                    doc.rect(cellSubX, curNY, nColW, nRowH).strokeColor('#B0B8E8').lineWidth(0.5).stroke();

                    doc.fillColor('#2C304E').fontSize(7.5);
                    renderSafePdfText(
                      doc,
                      nCell.text || '',
                      hasUnicodeFont,
                      { width: nColW - 6, lineBreak: true, align: nCell.alignment || 'left' },
                      cellSubX + 3,
                      curNY + 3
                    );
                  });
                  curNY += nRowH;
                });
                textOffsetY = curNY + 4;
              }
            } else if (!cell.text && cell.fullCellText) {
              renderSafePdfText(
                doc,
                cell.fullCellText,
                hasUnicodeFont,
                { width: colWidth - 10, lineBreak: true, align },
                x + 5,
                y + 5
              );
            }
          });

          doc.y = y + rowHeight;
        });
      } else {
        // Fallback for simple rows with dynamic text wrapping
        tbl.rows.forEach((row, rIdx) => {
          let maxCellHeight = 20;
          const colWidth = availableWidth / Math.max(1, row.length);
          const fontSize = rIdx === 0 ? 9 : 8.5;
          doc.fontSize(fontSize);
          row.forEach((cellText) => {
            const textHeight = measurePdfTextHeight(doc, cellText || ' ', { width: Math.max(10, colWidth - 10) });
            const reqH = Math.ceil(textHeight + 10);
            if (reqH > maxCellHeight) maxCellHeight = reqH;
          });
          const rowHeight = maxCellHeight;

          if (doc.y + rowHeight > doc.page.height - 60) {
            doc.addPage();
          }
          const y = doc.y;
          const isHdr = rIdx === 0;
          doc.rect(50, y, availableWidth, rowHeight).strokeColor('#CCD2FC').lineWidth(0.5);
          if (isHdr) {
            doc.rect(50, y, availableWidth, rowHeight).fill('#F0F2FE');
            doc.fillColor('#1F2340').fontSize(9);
          } else {
            doc.fillColor('#4D536B').fontSize(8.5);
          }

          row.forEach((cell, cIdx) => {
            renderSafePdfText(
              doc,
              cell,
              hasUnicodeFont,
              { width: colWidth - 10, lineBreak: true, align: isHdr ? 'center' : 'left' },
              50 + cIdx * colWidth + 5,
              y + 5
            );
          });
          doc.y = y + rowHeight;
        });
      }
      doc.moveDown(0.4);
    };

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
        else if (el.type === 'table') renderTable(el.table);
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
      for (const tbl of tables) renderTable(tbl);
    }

    doc.end();
  });
}
