import { HTML_MAX_EMBEDDED_BASE64_CHARS, base64Length } from './pptx-media';
import { PayloadLimitError } from '../../types';
import PDFDocument from 'pdfkit';
import { type VisualSlideShape } from './pptx-scene';
import { escapeMarkupAttribute } from '../../text/escape';
import { renderSingleShapeSvg } from './drawingml-shapes';
import { type OpenXmlChartData } from './types';
import { configurePdfKitFontFallback, renderSafePdfText } from './pdf-text';
import { renderPdfChart } from './pdf-chart';
import { renderSinglePdfShape } from './pdf-shapes';

export function generateHtmlFromSlides(
  slides: Array<{
    number: number;
    texts: string[];
    shapes?: VisualSlideShape[];
    width?: number;
    height?: number;
    backgroundColor?: string;
  }>,
  title: string
): string {
  let slidesHtml = '';
  // Every picture is written in full where it is drawn, so a part used by several pictures counts once per picture.
  let embeddedBase64Chars = 0;
  slides.forEach((slide) => {
    const sWidth = slide.width || 960;
    const sHeight = slide.height || 540;
    const bg = slide.backgroundColor || '#FFFFFF';

    let visualSvg = '';
    if (slide.shapes && slide.shapes.length > 0) {
      let svgElements = '';
      slide.shapes.forEach((s) => {
        const type = s.shapeType || 'rect';
        const fill = s.fillColor || 'none';
        const stroke = s.strokeColor || 'none';
        const strokeW = s.strokeWidth || 1;

        if (type === 'chart' && s.chartSvg) {
          svgElements += `        <g transform="translate(${s.x}, ${s.y})">\n${s.chartSvg}\n        </g>\n`;
        } else if (type === 'picture' && s.imageData) {
          const mime = s.imageMimeType || 'image/png';
          const cx = s.x + s.width / 2;
          const cy = s.y + s.height / 2;
          const transforms: string[] = [];
          if (s.rotation) transforms.push(`rotate(${s.rotation} ${cx} ${cy})`);
          if (s.flipH || s.flipV) {
            const sx = s.flipH ? -1 : 1;
            const sy = s.flipV ? -1 : 1;
            transforms.push(`translate(${cx} ${cy}) scale(${sx} ${sy}) translate(${-cx} ${-cy})`);
          }
          const trAttr = transforms.length > 0 ? ` transform="${transforms.join(' ')}"` : '';
          embeddedBase64Chars += base64Length(s.imageData.length);
          if (embeddedBase64Chars > HTML_MAX_EMBEDDED_BASE64_CHARS) {
            throw new PayloadLimitError(
              `The pictures of this deck would embed more than ${HTML_MAX_EMBEDDED_BASE64_CHARS} base64 characters, more than an HTML page can hold.`
            );
          }
          svgElements += `        <image href="data:${mime};base64,${s.imageData.toString('base64')}" x="${s.x}" y="${s.y}" width="${s.width}" height="${s.height}" preserveAspectRatio="none"${trAttr}/>\n`;
        } else if (type === 'table' && s.tableData) {
          const rowCount = Math.max(1, s.tableData.rows.length);
          const rowH = Math.max(18, Math.round(s.height / rowCount));
          const defaultColW = Math.round(s.width / Math.max(1, s.tableData.rows[0]?.length || 1));
          s.tableData.rows.forEach((r, rIdx) => {
            let curX = s.x;
            const curY = s.y + rIdx * rowH;
            r.forEach((c, cIdx) => {
              const colW = s.tableData?.colWidths?.[cIdx] || defaultColW;
              const fill = c.fillColor || (rIdx === 0 ? '#F0F2FE' : '#FFFFFF');
              svgElements += `        <rect x="${curX}" y="${curY}" width="${colW}" height="${rowH}" fill="${fill}" stroke="#CCD2FC" stroke-width="0.5"/>\n`;
              if (c.text) {
                svgElements += `        <text x="${curX + 4}" y="${curY + 12}" font-size="9" fill="${c.fontColor || '#1F2340'}" font-weight="${c.bold || rIdx === 0 ? 'bold' : 'normal'}" font-family="sans-serif">${escapeMarkupAttribute(c.text)}</text>\n`;
              }
              curX += colW;
            });
          });
        } else {
          svgElements += `        ${renderSingleShapeSvg({
            geomType: s.shapeType === 'custom' ? 'custom' : 'preset',
            presetGeom: s.shapeType || 'rect',
            svgPath: s.geometryPath,
            x: s.x,
            y: s.y,
            width: s.width,
            height: s.height,
            fillColor: s.fillColor,
            strokeColor: s.strokeColor,
            strokeWidth: s.strokeWidth,
            text: s.text,
            rotation: s.rotation,
            flipH: s.flipH,
            flipV: s.flipV,
          })}\n`;
        }
      });

      visualSvg = `
      <div style="margin-bottom:16px;border:1px solid #E1E4EE;border-radius:8px;overflow:hidden;background:${bg};">
        <svg viewBox="0 0 ${sWidth} ${sHeight}" style="width:100%;height:auto;display:block;">
${svgElements}        </svg>
      </div>`;
    }

    slidesHtml += `
    <div style="border:1px solid #CCD2FC;border-radius:12px;padding:24px;margin-bottom:20px;background:#FAFAFE;box-shadow:0 1px 3px rgba(0,0,0,0.05);">
      <div style="font-size:11px;font-weight:700;color:#5C6BC0;text-transform:uppercase;margin-bottom:8px;">Slide ${slide.number}</div>
      <h2 style="font-size:18px;color:#1F2340;margin-top:0;margin-bottom:16px;">${slide.texts[0] ? escapeMarkupAttribute(slide.texts[0]) : `Slide ${slide.number}`}</h2>
      ${visualSvg}
      <ul style="color:#4D536B;font-size:14px;line-height:1.6;margin:0;padding-left:20px;">
        ${slide.texts.slice(1).map((t) => `<li>${escapeMarkupAttribute(t)}</li>`).join('\n')}
      </ul>
    </div>`;
  });

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${escapeMarkupAttribute(
    title
  )}</title><style>body{font-family:system-ui,-apple-system,sans-serif;max-width:850px;margin:2rem auto;padding:0 1rem;background:#F8F9FE;color:#1F2340;}h1{color:#5C6BC0;text-align:center;margin-bottom:2rem;}</style></head><body><h1>${escapeMarkupAttribute(
    title
  )}</h1>${slidesHtml}</body></html>`;
}

/** Margin of the pages that hold slide text, in points. */
const SLIDE_TEXT_MARGIN = 40;

export async function generatePdfFromSlides(
  slides: Array<{
    number: number;
    texts: string[];
    /** Charts drawn below the text of a slide that has no shapes of its own. */
    charts?: OpenXmlChartData[];
    shapes?: VisualSlideShape[];
    width?: number;
    height?: number;
    backgroundColor?: string;
  }>,
  title: string
): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const firstSlide = slides[0];
    const width = firstSlide?.width || 960;
    const height = firstSlide?.height || 540;

    const doc = new PDFDocument({ size: [width, height], margin: SLIDE_TEXT_MARGIN, info: { Title: title } });
    const chunks: Buffer[] = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', (err) => reject(err));

    const { hasUnicodeFont } = configurePdfKitFontFallback(doc);

    slides.forEach((slide, idx) => {
      const sWidth = slide.width || width;
      const sHeight = slide.height || height;
      if (idx > 0) doc.addPage({ size: [sWidth, sHeight], margin: SLIDE_TEXT_MARGIN });

      // 1. Draw slide background
      if (slide.backgroundColor) {
        doc.rect(0, 0, sWidth, sHeight).fill(slide.backgroundColor);
      } else {
        doc.rect(0, 0, sWidth, sHeight).fill('#FAFAFC');
      }

      // 2. Draw visual shapes if present
      if (slide.shapes && slide.shapes.length > 0) {
        slide.shapes.forEach((shape) => {
          if (shape.width > 0 && shape.height > 0) {
            const type = shape.shapeType || 'rect';

            if (type === 'chart' && shape.chartData) {
              renderPdfChart(
                doc,
                shape.chartData,
                hasUnicodeFont,
                shape.x,
                shape.y,
                shape.width,
                shape.height
              );
            } else if (type === 'picture' && shape.imageData) {
              try {
                if (shape.rotation || shape.flipH || shape.flipV) {
                  doc.save();
                  const cx = shape.x + shape.width / 2;
                  const cy = shape.y + shape.height / 2;
                  doc.translate(cx, cy);
                  if (shape.rotation) doc.rotate(shape.rotation);
                  if (shape.flipH || shape.flipV) doc.scale(shape.flipH ? -1 : 1, shape.flipV ? -1 : 1);
                  doc.translate(-cx, -cy);
                  doc.image(shape.imageData, shape.x, shape.y, {
                    width: shape.width,
                    height: shape.height,
                  });
                  doc.restore();
                } else {
                  doc.image(shape.imageData, shape.x, shape.y, {
                    width: shape.width,
                    height: shape.height,
                  });
                }
              } catch {
                doc.rect(shape.x, shape.y, shape.width, shape.height).strokeColor('#CCD2FC').lineWidth(1).stroke();
              }
            } else if (type === 'table' && shape.tableData) {
              const tbl = shape.tableData;
              const rowCount = Math.max(1, tbl.rows.length);
              const rowHeight = Math.max(18, Math.round(shape.height / rowCount));
              const defaultColWidth = Math.round(shape.width / Math.max(1, tbl.rows[0]?.length || 1));

              tbl.rows.forEach((row, rIdx) => {
                const curY = shape.y + rIdx * rowHeight;
                let curX = shape.x;
                row.forEach((cell, cIdx) => {
                  const colW = tbl.colWidths?.[cIdx] || defaultColWidth;
                  const isHeader = rIdx === 0;
                  const fill = cell.fillColor || (isHeader ? '#F0F2FE' : '#FFFFFF');
                  doc.rect(curX, curY, colW, rowHeight).fill(fill);
                  doc.rect(curX, curY, colW, rowHeight).strokeColor('#CCD2FC').lineWidth(0.5).stroke();
                  if (cell.text) {
                    doc.fillColor(cell.fontColor || (isHeader ? '#1F2340' : '#4D536B'));
                    doc.fontSize(cell.bold || isHeader ? 9 : 8.5);
                    renderSafePdfText(
                      doc,
                      cell.text,
                      hasUnicodeFont,
                      { width: Math.max(10, colW - 8) },
                      curX + 4,
                      curY + 4
                    );
                  }
                  curX += colW;
                });
              });
            } else {
              renderSinglePdfShape(
                doc,
                {
                  geomType: shape.shapeType === 'custom' ? 'custom' : 'preset',
                  presetGeom: shape.shapeType || 'rect',
                  svgPath: shape.geometryPath,
                  x: shape.x,
                  y: shape.y,
                  width: shape.width,
                  height: shape.height,
                  fillColor: shape.fillColor,
                  strokeColor: shape.strokeColor,
                  strokeWidth: shape.strokeWidth,
                  text: shape.text,
                  fontSize: shape.fontSize,
                  fontColor: shape.fontColor,
                  rotation: shape.rotation,
                  flipH: shape.flipH,
                  flipV: shape.flipV,
                },
                hasUnicodeFont,
                shape.x,
                shape.y,
                shape.width,
                shape.height
              );
            }
          }
        });
      } else {
        // Text-only slide: the text itself, top to bottom, continuing on further pages when it is long.
        doc.x = SLIDE_TEXT_MARGIN;
        doc.y = SLIDE_TEXT_MARGIN;
        slide.texts.forEach((line) => {
          doc.fillColor('#1F2340').fontSize(14).lineGap(6);
          renderSafePdfText(doc, line, hasUnicodeFont, { width: sWidth - 2 * SLIDE_TEXT_MARGIN }, SLIDE_TEXT_MARGIN, doc.y);
          doc.moveDown(0.5);
        });
        for (const chart of slide.charts ?? []) {
          doc.x = SLIDE_TEXT_MARGIN;
          renderPdfChart(doc, chart, hasUnicodeFont, SLIDE_TEXT_MARGIN, undefined, sWidth - 2 * SLIDE_TEXT_MARGIN);
        }
      }
    });

    doc.end();
  });
}
