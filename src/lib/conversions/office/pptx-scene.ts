import JSZip from 'jszip';
import { PptxMedia } from './pptx-media';
import { safeDecodeXmlEntities, safeExtractXmlElements } from '../safe-xml-scanner';
import { resolveZipPath } from './zip-path';
import { readZipEntryText } from '../zip-entry-reader';
import sharp from 'sharp';
import { openLimitedSharp, rethrowInputPixelLimit } from '../image-input-limits';
import { type OpenXmlChartData } from './types';
import { type Matrix2D, computeTransformedElementBounds, multiplyMatrix, parseGroupTransform, transformPoint } from './affine';
import { safeExtractFirstXmlElement, safeFindColor } from './xml-helpers';
import { parseOpenXmlChart } from './chart-parse';
import { renderChartToSvg } from './chart-svg';

/**
 * PPTX Source Parser & Converter
 */
export interface VisualSlideShape {
  x: number;
  y: number;
  width: number;
  height: number;
  shapeType?: 'rect' | 'roundRect' | 'ellipse' | 'triangle' | 'diamond' | 'star5' | 'line' | 'picture' | 'table' | 'chart' | string;
  geometryPath?: string;
  fillColor?: string;
  strokeColor?: string;
  strokeWidth?: number;
  text?: string;
  fontSize?: number;
  fontColor?: string;
  bold?: boolean;
  imageData?: Buffer;
  imageMimeType?: string;
  chartData?: OpenXmlChartData;
  chartSvg?: string;
  tableData?: {
    rows: Array<Array<{ text: string; fillColor?: string; fontColor?: string; bold?: boolean }>>;
    colWidths?: number[];
  };
  rotation?: number;
  flipH?: boolean;
  flipV?: boolean;
  transformMatrix?: Matrix2D;
}

export interface VisualSlide {
  number: number;
  texts: string[];
  shapes: VisualSlideShape[];
  width: number;
  height: number;
  backgroundColor?: string;
}

/**
 * Recursively parses DrawingML 2D scene graph for a PPTX slide, accumulating
 * affine transform matrices (M_world = M_parent * M_local) for nested <p:grpSp>,
 * resolving <dgm:relIds> SmartArt diagrams, pictures (<p:pic>), tables, charts, and shapes.
 */
export async function parsePptxSlideSceneGraph(
  xml: string,
  parentMatrix: Matrix2D,
  slideWidth: number,
  slideHeight: number,
  relsMap: Map<string, string>,
  zip: JSZip,
  texts: string[],
  media: PptxMedia = new PptxMedia()
): Promise<VisualSlideShape[]> {
  const shapes: VisualSlideShape[] = [];

  const groupElements = safeExtractXmlElements(xml, 'p:grpSp');
  const gfElements = safeExtractXmlElements(xml, 'p:graphicFrame');
  const picElements = safeExtractXmlElements(xml, 'p:pic');
  const spElements = safeExtractXmlElements(xml, 'p:sp');

  // Compute boundaries of group shapes so child shapes are processed in group recursion
  const grpRanges: Array<[number, number]> = [];
  for (const grpEl of groupElements) {
    grpRanges.push([grpEl.startIndex, grpEl.endIndex]);
  }

  // 1. Group shapes (<p:grpSp>) - recursive scene graph traversal
  for (const grpEl of groupElements) {
    // Only process immediate top-level groups at this container depth
    const isChildGroup = grpRanges.some(
      ([s, e]) => grpEl.startIndex > s && grpEl.endIndex < e
    );
    if (isChildGroup) continue;

    const grpXml = grpEl.content;
    const { matrix: mGrp } = parseGroupTransform(grpXml, slideWidth, slideHeight);
    const mAccum = multiplyMatrix(parentMatrix, mGrp);

    const childShapes = await parsePptxSlideSceneGraph(
      grpXml,
      mAccum,
      slideWidth,
      slideHeight,
      relsMap,
      zip,
      texts,
      media
    );
    shapes.push(...childShapes);
  }

  // 2. Graphic frames (<p:graphicFrame>) - tables, charts, SmartArt (<dgm:relIds>)
  for (const gfEl of gfElements) {
    const isInsideGroup = grpRanges.some(
      ([s, e]) => gfEl.startIndex >= s && gfEl.endIndex <= e
    );
    if (isInsideGroup) continue;

    const gfXml = gfEl.content;
    const offEl = safeExtractFirstXmlElement(gfXml, 'a:off');
    const extEl = safeExtractFirstXmlElement(gfXml, 'a:ext');
    if (offEl?.attrs.x && offEl?.attrs.y && extEl?.attrs.cx && extEl?.attrs.cy) {
      const rawX = Math.round(parseInt(offEl.attrs.x, 10) / 12700);
      const rawY = Math.round(parseInt(offEl.attrs.y, 10) / 12700);
      const rawW = Math.round(parseInt(extEl.attrs.cx, 10) / 12700);
      const rawH = Math.round(parseInt(extEl.attrs.cy, 10) / 12700);

      const pt = transformPoint(parentMatrix, rawX, rawY);
      const x = Math.round(pt.x);
      const y = Math.round(pt.y);
      const w = Math.round(Math.sqrt(parentMatrix[0] * parentMatrix[0] + parentMatrix[1] * parentMatrix[1]) * rawW);
      const h = Math.round(Math.sqrt(parentMatrix[2] * parentMatrix[2] + parentMatrix[3] * parentMatrix[3]) * rawH);

      const tblEl = safeExtractFirstXmlElement(gfXml, 'a:tbl');
      if (tblEl) {
        const tblXml = tblEl.content;
        const colWidths: number[] = [];
        for (const gcEl of safeExtractXmlElements(tblXml, 'a:gridCol')) {
          if (gcEl.attrs.w) {
            colWidths.push(Math.round(parseInt(gcEl.attrs.w, 10) / 12700));
          }
        }

        const tblRows: Array<Array<{ text: string; fillColor?: string; fontColor?: string; bold?: boolean }>> = [];
        for (const trEl of safeExtractXmlElements(tblXml, 'a:tr')) {
          const trXml = trEl.content;
          const rowCells: Array<{ text: string; fillColor?: string; fontColor?: string; bold?: boolean }> = [];
          for (const tcEl of safeExtractXmlElements(trXml, 'a:tc')) {
            const tcXml = tcEl.content;
            const cellTexts: string[] = [];
            for (const tEl of safeExtractXmlElements(tcXml, 'a:t')) {
              const clean = safeDecodeXmlEntities(tEl.content).trim();
              if (clean) cellTexts.push(clean);
            }
            const cellText = cellTexts.join(' ');
            if (cellText && !texts.includes(cellText)) {
              texts.push(cellText);
            }

            const tcPrEl = safeExtractFirstXmlElement(tcXml, 'a:tcPr');
            let cellFill: string | undefined;
            if (tcPrEl) {
              cellFill = safeFindColor(tcPrEl.content);
            }

            let cellBold = false;
            if (tcXml.includes('b="1"')) cellBold = true;
            const rPrEl = safeExtractFirstXmlElement(tcXml, 'a:rPr');
            let cellFontColor: string | undefined;
            if (rPrEl) {
              cellFontColor = safeFindColor(rPrEl.content);
              if (rPrEl.attrs.b === '1' || rPrEl.attrs.b === 'true') {
                cellBold = true;
              }
            }

            rowCells.push({
              text: cellText,
              fillColor: cellFill,
              fontColor: cellFontColor,
              bold: cellBold,
            });
          }
          tblRows.push(rowCells);
        }

        shapes.push({
          x,
          y,
          width: w,
          height: h,
          shapeType: 'table',
          tableData: {
            rows: tblRows,
            colWidths: colWidths.length > 0 ? colWidths : undefined,
          },
          transformMatrix: parentMatrix,
        });
      } else if (
        gfXml.includes('uri="http://schemas.openxmlformats.org/drawingml/2006/diagram"') ||
        gfXml.includes('<dgm:relIds') ||
        gfXml.includes('dgm:relIds')
      ) {
        // SmartArt diagram processing
        const dgmRelEl = safeExtractFirstXmlElement(gfXml, 'dgm:relIds');
        const dmId = dgmRelEl ? (dgmRelEl.attrs['r:dm'] || dgmRelEl.attrs.dm) : undefined;
        let resolvedDiagram = false;

        if (dmId && relsMap.has(dmId)) {
          const target = relsMap.get(dmId)!;
          const dataPath = resolveZipPath('ppt/slides', target);
          const dataFile = zip.file(dataPath) || zip.file(`ppt/${target}`);
          if (dataFile) {
            const dataXml = await readZipEntryText(dataFile, { budget: media.xmlBudget });
            const ptEls = safeExtractXmlElements(dataXml, 'dgm:pt');
            const nodeTexts: string[] = [];
            for (const pt of ptEls) {
              const ptType = pt.attrs.type || 'node';
              if (ptType === 'node' || ptType === 'asst') {
                const tEls = safeExtractXmlElements(pt.content, 'a:t');
                const t = tEls.map((el) => safeDecodeXmlEntities(el.content).trim()).filter(Boolean).join(' ');
                if (t) {
                  nodeTexts.push(t);
                  if (!texts.includes(t)) texts.push(t);
                }
              }
            }

            if (nodeTexts.length > 0) {
              resolvedDiagram = true;
              const N = nodeTexts.length;
              const isLandscape = w >= h;
              const isSquareGrid = N === 4 && w / h >= 0.7 && w / h <= 1.5;

              if (isSquareGrid) {
                // 2x2 Matrix / Quadrant SmartArt layout
                const gap = 12;
                const nodeW = Math.max(30, Math.floor((w - gap) / 2));
                const nodeH = Math.max(24, Math.floor((h - gap) / 2));
                for (let nIdx = 0; nIdx < 4; nIdx++) {
                  const col = nIdx % 2;
                  const row = Math.floor(nIdx / 2);
                  const nodeX = x + col * (nodeW + gap);
                  const nodeY = y + row * (nodeH + gap);
                  shapes.push({
                    x: nodeX,
                    y: nodeY,
                    width: nodeW,
                    height: nodeH,
                    shapeType: 'roundrect',
                    fillColor: nIdx % 2 === 0 ? '#3F51B5' : '#5C6BC0',
                    strokeColor: '#303F9F',
                    strokeWidth: 1.5,
                    text: nodeTexts[nIdx],
                    fontColor: '#FFFFFF',
                    bold: true,
                    transformMatrix: parentMatrix,
                  });
                }
              } else if (isLandscape) {
                const gap = 16;
                const nodeW = Math.max(30, Math.floor((w - (N - 1) * gap) / N));
                const nodeH = Math.max(24, Math.floor(h * 0.7));
                const nodeY = y + Math.floor((h - nodeH) / 2);

                for (let nIdx = 0; nIdx < N; nIdx++) {
                  const nodeX = x + nIdx * (nodeW + gap);
                  shapes.push({
                    x: nodeX,
                    y: nodeY,
                    width: nodeW,
                    height: nodeH,
                    shapeType: 'roundrect',
                    fillColor: '#5C6BC0',
                    strokeColor: '#3F51B5',
                    strokeWidth: 1.5,
                    text: nodeTexts[nIdx],
                    fontColor: '#FFFFFF',
                    bold: true,
                    transformMatrix: parentMatrix,
                  });

                  if (nIdx < N - 1) {
                    const arrowW = gap - 4;
                    const arrowX = nodeX + nodeW + 2;
                    const arrowY = nodeY + Math.floor(nodeH / 2) - 6;
                    shapes.push({
                      x: arrowX,
                      y: arrowY,
                      width: arrowW,
                      height: 12,
                      shapeType: 'rightarrow',
                      fillColor: '#9FA8DA',
                      strokeColor: '#7986CB',
                      strokeWidth: 1,
                      transformMatrix: parentMatrix,
                    });
                  }
                }
              } else {
                const gap = 12;
                const nodeH = Math.max(24, Math.floor((h - (N - 1) * gap) / N));
                const nodeW = Math.max(40, Math.floor(w * 0.85));
                const nodeX = x + Math.floor((w - nodeW) / 2);

                for (let nIdx = 0; nIdx < N; nIdx++) {
                  const nodeY = y + nIdx * (nodeH + gap);
                  shapes.push({
                    x: nodeX,
                    y: nodeY,
                    width: nodeW,
                    height: nodeH,
                    shapeType: 'roundrect',
                    fillColor: '#5C6BC0',
                    strokeColor: '#3F51B5',
                    strokeWidth: 1.5,
                    text: nodeTexts[nIdx],
                    fontColor: '#FFFFFF',
                    bold: true,
                    transformMatrix: parentMatrix,
                  });
                }
              }
            }
          }
        }

        if (!resolvedDiagram) {
          shapes.push({
            x,
            y,
            width: w,
            height: h,
            shapeType: 'roundrect',
            fillColor: '#F0F2FE',
            strokeColor: '#5C6BC0',
            strokeWidth: 1.5,
            text: 'SmartArt Diagram',
            fontColor: '#1F2340',
            bold: true,
            transformMatrix: parentMatrix,
          });
        }
      } else {
        // Check if graphicFrame contains or references an OpenXML chart
        const chartEl = safeExtractFirstXmlElement(gfXml, 'c:chart');
        const rId = chartEl ? (chartEl.attrs['r:id'] || chartEl.attrs.id) : undefined;
        let chartData: OpenXmlChartData | null = null;
        if (rId && relsMap.has(rId)) {
          const target = relsMap.get(rId)!;
          const chartPath = resolveZipPath('ppt/slides', target);
          const chartFile = zip.file(chartPath) || zip.file(`ppt/${target}`);
          if (chartFile) {
            const chartXml = await readZipEntryText(chartFile, { budget: media.xmlBudget });
            chartData = parseOpenXmlChart(chartXml);
          }
        } else if (
          gfXml.includes('<c:chart') ||
          gfXml.includes('<c:plotArea') ||
          gfXml.includes('<c:chartSpace>')
        ) {
          chartData = parseOpenXmlChart(gfXml);
        }

        if (chartData) {
          const chartSvg = renderChartToSvg(chartData, w, h);
          shapes.push({
            x,
            y,
            width: w,
            height: h,
            shapeType: 'chart',
            chartData,
            chartSvg,
            text: chartData.title || `${chartData.type} chart`,
            transformMatrix: parentMatrix,
          });
        } else {
          const chartTexts: string[] = [];
          for (const tEl of safeExtractXmlElements(gfXml, 'a:t')) {
            const clean = safeDecodeXmlEntities(tEl.content).trim();
            if (clean) chartTexts.push(clean);
          }
          shapes.push({
            x,
            y,
            width: w,
            height: h,
            shapeType: 'rect',
            fillColor: '#F8F9FE',
            strokeColor: '#CCD2FC',
            strokeWidth: 1,
            text: chartTexts.join(' ') || undefined,
            transformMatrix: parentMatrix,
          });
        }
      }
    }
  }

  // 3. Pictures (<p:pic>)
  for (const picEl of picElements) {
    const isInsideGroup = grpRanges.some(
      ([s, e]) => picEl.startIndex >= s && picEl.endIndex <= e
    );
    if (isInsideGroup) continue;

    const picXml = picEl.content;
    const bounds = computeTransformedElementBounds(picXml, parentMatrix);
    if (!bounds) continue;
    const { x, y, w: worldW, h: worldH, rot: worldRot, flipH, flipV, matrix: worldMatrix } = bounds;

    const blipEl = safeExtractFirstXmlElement(picXml, 'a:blip');
    const rId = blipEl ? (blipEl.attrs['r:embed'] || blipEl.attrs.embed) : undefined;
    if (rId) {
      const target = relsMap.get(rId);
      if (target) {
        const mediaPath = resolveZipPath('ppt/slides', target);
        const picture = await media.picture(zip, mediaPath);
        if (picture) {
          let imgBuffer = picture.buffer;
          const mimeType = picture.mimeType;

          // DrawingML <a:srcRect> image cropping (ISO/IEC 29500-1 §20.1.8.56)
          const srcRectEl = safeExtractFirstXmlElement(picXml, 'a:srcRect');
          if (srcRectEl) {
            const l = parseInt(srcRectEl.attrs.l || '0', 10);
            const t = parseInt(srcRectEl.attrs.t || '0', 10);
            const r = parseInt(srcRectEl.attrs.r || '0', 10);
            const b = parseInt(srcRectEl.attrs.b || '0', 10);
            if (l > 0 || t > 0 || r > 0 || b > 0) {
              let cropped: Buffer | undefined;
              try {
                const meta = await sharp(imgBuffer).metadata();
                if (meta.width && meta.height) {
                  const cropLeft = Math.max(0, Math.min(meta.width - 1, Math.round((meta.width * l) / 100000)));
                  const cropTop = Math.max(0, Math.min(meta.height - 1, Math.round((meta.height * t) / 100000)));
                  const cropRight = Math.max(0, Math.min(meta.width - cropLeft - 1, Math.round((meta.width * r) / 100000)));
                  const cropBottom = Math.max(0, Math.min(meta.height - cropTop - 1, Math.round((meta.height * b) / 100000)));
                  const extractW = Math.max(1, meta.width - cropLeft - cropRight);
                  const extractH = Math.max(1, meta.height - cropTop - cropBottom);
                  cropped = await openLimitedSharp(imgBuffer) // NOSONAR S9382: sequential to bound memory
                    .extract({ left: cropLeft, top: cropTop, width: extractW, height: extractH })
                    .toBuffer();
                }
              } catch (err) {
                rethrowInputPixelLimit(err);
              }
              // Outside the try: rethrowInputPixelLimit passes every other error on, which would swallow the budget's 413.
              if (cropped) {
                media.chargeDerived(cropped.length, mediaPath);
                imgBuffer = cropped;
              }
            }
          }
          shapes.push({
            x,
            y,
            width: worldW,
            height: worldH,
            shapeType: 'picture',
            imageData: imgBuffer,
            imageMimeType: mimeType,
            rotation: worldRot || undefined,
            flipH: flipH || undefined,
            flipV: flipV || undefined,
            transformMatrix: worldMatrix,
          });
        }
      }
    }
  }

  // 4. Standalone DrawingML shapes (<p:sp>)
  const standaloneSpElements = spElements.filter(
    (sp) => !grpRanges.some(([start, end]) => sp.startIndex >= start && sp.endIndex <= end)
  );

  for (const spEl of standaloneSpElements) {
    const spXml = spEl.content;
    const bounds = computeTransformedElementBounds(spXml, parentMatrix);
    if (!bounds) continue;
    const { x, y, w: worldW, h: worldH, rot: worldRot, flipH, flipV, matrix: worldMatrix } = bounds;

    let fillColor: string | undefined;
    const spPrEl = safeExtractFirstXmlElement(spXml, 'p:spPr');
    if (spPrEl) {
      fillColor = safeFindColor(spPrEl.content);
    }

    let strokeColor: string | undefined;
    let strokeWidth: number | undefined;
    const lnEl = safeExtractFirstXmlElement(spXml, 'a:ln');
    if (lnEl) {
      if (lnEl.attrs.w) {
        strokeWidth = Math.max(1, Math.round(Number.parseInt(lnEl.attrs.w, 10) / 12700));
      }
      strokeColor = safeFindColor(lnEl.content);
    }

    if (spPrEl && (spPrEl.content.includes('<a:sp3d') || spPrEl.content.includes('<a:bevelT') || spPrEl.content.includes('bevelT'))) {
      if (!strokeWidth) strokeWidth = 2;
      if (!strokeColor && fillColor) {
        strokeColor = '#1A237E';
      }
    }

      let shapeText = '';
      let fontSize: number | undefined;
      let fontColor: string | undefined;
      let bold = false;

      const txEl = safeExtractFirstXmlElement(spXml, 'p:txBody');
      if (txEl) {
        const txBody = txEl.content;
        const textMatches: string[] = [];
        const runElements = safeExtractXmlElements(txBody, 'a:r');

        for (const rEl of runElements) {
          const runXml = rEl.content;
          const tEl = safeExtractFirstXmlElement(runXml, 'a:t');
          if (tEl) {
            const clean = safeDecodeXmlEntities(tEl.content).trim();
            if (clean) textMatches.push(clean);
          }

          const rPrEl = safeExtractFirstXmlElement(runXml, 'a:rPr');
          if (rPrEl) {
            if (!fontSize && rPrEl.attrs.sz) {
              fontSize = Math.round(parseInt(rPrEl.attrs.sz, 10) / 100);
            }
            if (!fontColor) {
              fontColor = safeFindColor(rPrEl.content);
            }
            if (rPrEl.attrs.b === '1' || rPrEl.attrs.b === 'true') {
              bold = true;
            }
          }
        }

        if (textMatches.length > 0) {
          shapeText = textMatches.join(' ');
          for (const tm of textMatches) {
            if (!texts.includes(tm)) texts.push(tm);
          }
        }
      }

      let shapeType = 'rect';
      const prstEl = safeExtractFirstXmlElement(spXml, 'a:prstGeom');
      if (prstEl?.attrs.prst) {
        shapeType = prstEl.attrs.prst;
      }
      let geometryPath: string | undefined;
      const custGeomEl = safeExtractFirstXmlElement(spXml, 'a:custGeom');
      if (custGeomEl) {
        shapeType = 'custom';
        const pathEl = safeExtractFirstXmlElement(custGeomEl.content, 'a:path');
        if (pathEl) {
          geometryPath = pathEl.content;
        }
      }

      shapes.push({
        x,
        y,
        width: worldW,
        height: worldH,
        shapeType,
        geometryPath,
        fillColor,
        strokeColor,
        strokeWidth,
        text: shapeText || undefined,
        fontSize,
        fontColor,
        bold,
        rotation: worldRot || undefined,
        flipH: flipH || undefined,
        flipV: flipV || undefined,
        transformMatrix: worldMatrix,
      });
    }

  return shapes;
}
