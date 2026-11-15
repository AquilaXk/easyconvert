import JSZip from 'jszip';
import { PptxMedia } from './pptx-media';
import { type SafeXmlElement, safeDecodeXmlEntities, safeExtractXmlElements } from '../safe-xml-scanner';
import { resolveZipPath } from './zip-path';
import { readZipEntryText } from '../zip-entry-reader';
import sharp from 'sharp';
import { openLimitedSharp, rethrowInputPixelLimit } from '../image-input-limits';
import { type OpenXmlChartData } from './types';
import { type Matrix2D, computeTransformedElementBounds, identityMatrix, multiplyMatrix, parseGroupTransform, transformPoint } from './affine';
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

const SEEN_SLIDE_TEXTS = new WeakMap<string[], Set<string>>();

function seenSlideTexts(texts: string[]): Set<string> {
  let seen = SEEN_SLIDE_TEXTS.get(texts);
  if (!seen) {
    seen = new Set(texts);
    SEEN_SLIDE_TEXTS.set(texts, seen);
  }
  return seen;
}

function pushUniqueSlideText(texts: string[], seen: Set<string>, value: string): void {
  if (!value || seen.has(value)) return;
  seen.add(value);
  texts.push(value);
}

export interface PptxSceneContext {
  parentMatrix?: Matrix2D;
  slideWidth: number;
  slideHeight: number;
  relsMap: Map<string, string>;
  zip: JSZip;
  texts: string[];
  media?: PptxMedia;
}

interface InternalSceneContext {
  parentMatrix: Matrix2D;
  slideWidth: number;
  slideHeight: number;
  relsMap: Map<string, string>;
  zip: JSZip;
  texts: string[];
  seenTexts: Set<string>;
  media: PptxMedia;
}

async function parsePptxGroups(
  groupElements: SafeXmlElement[],
  grpRanges: Array<[number, number]>,
  ctx: InternalSceneContext
): Promise<VisualSlideShape[]> {
  const shapes: VisualSlideShape[] = [];
  for (const grpEl of groupElements) {
    const isChildGroup = grpRanges.some(([s, e]) => grpEl.startIndex > s && grpEl.endIndex < e);
    if (isChildGroup) continue;

    const grpXml = grpEl.content;
    const { matrix: mGrp } = parseGroupTransform(grpXml, ctx.slideWidth, ctx.slideHeight);
    const mAccum = multiplyMatrix(ctx.parentMatrix, mGrp);

    const childShapes = await parsePptxSlideSceneGraph(grpXml, {
      ...ctx,
      parentMatrix: mAccum,
    });
    shapes.push(...childShapes);
  }
  return shapes;
}

interface FrameBounds {
  x: number;
  y: number;
  w: number;
  h: number;
}

function extractSmartArtNodeTexts(dataXml: string, ctx: InternalSceneContext): string[] {
  const ptEls = safeExtractXmlElements(dataXml, 'dgm:pt');
  const nodeTexts: string[] = [];
  for (const pt of ptEls) {
    const ptType = pt.attrs.type || 'node';
    if (ptType !== 'node' && ptType !== 'asst') continue;
    const tEls = safeExtractXmlElements(pt.content, 'a:t');
    const t = tEls
      .map((el) => safeDecodeXmlEntities(el.content).trim())
      .filter(Boolean)
      .join(' ');
    if (t) {
      nodeTexts.push(t);
      pushUniqueSlideText(ctx.texts, ctx.seenTexts, t);
    }
  }
  return nodeTexts;
}

function pushSmartArtFallback(shapes: VisualSlideShape[], b: FrameBounds, ctx: InternalSceneContext): void {
  shapes.push({
    x: b.x,
    y: b.y,
    width: b.w,
    height: b.h,
    shapeType: 'roundrect',
    fillColor: '#F0F2FE',
    strokeColor: '#5C6BC0',
    strokeWidth: 1.5,
    text: 'SmartArt Diagram',
    fontColor: '#1F2340',
    bold: true,
    transformMatrix: ctx.parentMatrix,
  });
}

function renderSmartArtNodes(shapes: VisualSlideShape[], b: FrameBounds, nodeTexts: string[], ctx: InternalSceneContext): void {
  const N = nodeTexts.length;
  const { x, y, w, h } = b;
  const isLandscape = w >= h;
  const isSquareGrid = N === 4 && w / h >= 0.7 && w / h <= 1.5;

  if (isSquareGrid) {
    const gap = 12;
    const nodeW = Math.max(30, Math.floor((w - gap) / 2));
    const nodeH = Math.max(24, Math.floor((h - gap) / 2));
    for (let nIdx = 0; nIdx < 4; nIdx++) {
      const col = nIdx % 2;
      const row = Math.floor(nIdx / 2);
      shapes.push({
        x: x + col * (nodeW + gap),
        y: y + row * (nodeH + gap),
        width: nodeW,
        height: nodeH,
        shapeType: 'roundrect',
        fillColor: nIdx % 2 === 0 ? '#3F51B5' : '#5C6BC0',
        strokeColor: '#303F9F',
        strokeWidth: 1.5,
        text: nodeTexts[nIdx],
        fontColor: '#FFFFFF',
        bold: true,
        transformMatrix: ctx.parentMatrix,
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
        transformMatrix: ctx.parentMatrix,
      });

      if (nIdx < N - 1) {
        shapes.push({
          x: nodeX + nodeW + 2,
          y: nodeY + Math.floor(nodeH / 2) - 6,
          width: gap - 4,
          height: 12,
          shapeType: 'rightarrow',
          fillColor: '#9FA8DA',
          strokeColor: '#7986CB',
          strokeWidth: 1,
          transformMatrix: ctx.parentMatrix,
        });
      }
    }
  } else {
    const gap = 12;
    const nodeH = Math.max(24, Math.floor((h - (N - 1) * gap) / N));
    const nodeW = Math.max(40, Math.floor(w * 0.85));
    const nodeX = x + Math.floor((w - nodeW) / 2);

    for (let nIdx = 0; nIdx < N; nIdx++) {
      shapes.push({
        x: nodeX,
        y: y + nIdx * (nodeH + gap),
        width: nodeW,
        height: nodeH,
        shapeType: 'roundrect',
        fillColor: '#5C6BC0',
        strokeColor: '#3F51B5',
        strokeWidth: 1.5,
        text: nodeTexts[nIdx],
        fontColor: '#FFFFFF',
        bold: true,
        transformMatrix: ctx.parentMatrix,
      });
    }
  }
}

async function parseSmartArtDiagram(
  gfXml: string,
  b: FrameBounds,
  shapes: VisualSlideShape[],
  ctx: InternalSceneContext
): Promise<void> {
  const dgmRelEl = safeExtractFirstXmlElement(gfXml, 'dgm:relIds');
  const dmId = dgmRelEl ? dgmRelEl.attrs['r:dm'] || dgmRelEl.attrs.dm : undefined;
  if (!dmId || !ctx.relsMap.has(dmId)) {
    pushSmartArtFallback(shapes, b, ctx);
    return;
  }
  const target = ctx.relsMap.get(dmId)!;
  const dataPath = resolveZipPath('ppt/slides', target);
  const dataFile = ctx.zip.file(dataPath) || ctx.zip.file(`ppt/${target}`);
  if (!dataFile) {
    pushSmartArtFallback(shapes, b, ctx);
    return;
  }
  const dataXml = await readZipEntryText(dataFile, { budget: ctx.media.xmlBudget });
  const nodeTexts = extractSmartArtNodeTexts(dataXml, ctx);
  if (nodeTexts.length === 0) {
    pushSmartArtFallback(shapes, b, ctx);
    return;
  }
  renderSmartArtNodes(shapes, b, nodeTexts, ctx);
}

async function parseChartOrGenericFrame(
  gfXml: string,
  b: FrameBounds,
  shapes: VisualSlideShape[],
  ctx: InternalSceneContext
): Promise<void> {
  const chartEl = safeExtractFirstXmlElement(gfXml, 'c:chart');
  const rId = chartEl ? chartEl.attrs['r:id'] || chartEl.attrs.id : undefined;
  let chartData: OpenXmlChartData | null = null;

  if (rId && ctx.relsMap.has(rId)) {
    const target = ctx.relsMap.get(rId)!;
    const chartPath = resolveZipPath('ppt/slides', target);
    const chartFile = ctx.zip.file(chartPath) || ctx.zip.file(`ppt/${target}`);
    if (chartFile) {
      const chartXml = await readZipEntryText(chartFile, { budget: ctx.media.xmlBudget });
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
    const chartSvg = renderChartToSvg(chartData, b.w, b.h);
    shapes.push({
      x: b.x,
      y: b.y,
      width: b.w,
      height: b.h,
      shapeType: 'chart',
      chartData,
      chartSvg,
      text: chartData.title || `${chartData.type} chart`,
      transformMatrix: ctx.parentMatrix,
    });
  } else {
    const chartTexts: string[] = [];
    for (const tEl of safeExtractXmlElements(gfXml, 'a:t')) {
      const clean = safeDecodeXmlEntities(tEl.content).trim();
      if (clean) chartTexts.push(clean);
    }
    shapes.push({
      x: b.x,
      y: b.y,
      width: b.w,
      height: b.h,
      shapeType: 'rect',
      fillColor: '#F8F9FE',
      strokeColor: '#CCD2FC',
      strokeWidth: 1,
      text: chartTexts.join(' ') || undefined,
      transformMatrix: ctx.parentMatrix,
    });
  }
}

function parseGraphicFrameTable(
  tblXml: string,
  b: FrameBounds,
  ctx: InternalSceneContext
): VisualSlideShape {
  const colWidths: number[] = [];
  for (const gcEl of safeExtractXmlElements(tblXml, 'a:gridCol')) {
    if (gcEl.attrs.w) {
      colWidths.push(Math.round(parseInt(gcEl.attrs.w, 10) / 12700));
    }
  }

  const tblRows: Array<Array<{ text: string; fillColor?: string; fontColor?: string; bold?: boolean }>> = [];
  for (const trEl of safeExtractXmlElements(tblXml, 'a:tr')) {
    const rowCells: Array<{ text: string; fillColor?: string; fontColor?: string; bold?: boolean }> = [];
    for (const tcEl of safeExtractXmlElements(trEl.content, 'a:tc')) {
      const tcXml = tcEl.content;
      const cellTexts: string[] = [];
      for (const tEl of safeExtractXmlElements(tcXml, 'a:t')) {
        const clean = safeDecodeXmlEntities(tEl.content).trim();
        if (clean) cellTexts.push(clean);
      }
      const cellText = cellTexts.join(' ');
      pushUniqueSlideText(ctx.texts, ctx.seenTexts, cellText);

      const tcPrEl = safeExtractFirstXmlElement(tcXml, 'a:tcPr');
      const cellFill = tcPrEl ? safeFindColor(tcPrEl.content) : undefined;

      let cellBold = tcXml.includes('b="1"');
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

  return {
    x: b.x,
    y: b.y,
    width: b.w,
    height: b.h,
    shapeType: 'table',
    tableData: {
      rows: tblRows,
      colWidths: colWidths.length > 0 ? colWidths : undefined,
    },
    transformMatrix: ctx.parentMatrix,
  };
}

async function parsePptxGraphicFrames(
  gfElements: SafeXmlElement[],
  grpRanges: Array<[number, number]>,
  ctx: InternalSceneContext
): Promise<VisualSlideShape[]> {
  const shapes: VisualSlideShape[] = [];
  for (const gfEl of gfElements) {
    const isInsideGroup = grpRanges.some(([s, e]) => gfEl.startIndex >= s && gfEl.endIndex <= e);
    if (isInsideGroup) continue;

    const gfXml = gfEl.content;
    const offEl = safeExtractFirstXmlElement(gfXml, 'a:off');
    const extEl = safeExtractFirstXmlElement(gfXml, 'a:ext');
    if (!offEl?.attrs.x || !offEl?.attrs.y || !extEl?.attrs.cx || !extEl?.attrs.cy) continue;

    const rawX = Math.round(parseInt(offEl.attrs.x, 10) / 12700);
    const rawY = Math.round(parseInt(offEl.attrs.y, 10) / 12700);
    const rawW = Math.round(parseInt(extEl.attrs.cx, 10) / 12700);
    const rawH = Math.round(parseInt(extEl.attrs.cy, 10) / 12700);

    const pt = transformPoint(ctx.parentMatrix, rawX, rawY);
    const x = Math.round(pt.x);
    const y = Math.round(pt.y);
    const w = Math.round(Math.sqrt(ctx.parentMatrix[0] * ctx.parentMatrix[0] + ctx.parentMatrix[1] * ctx.parentMatrix[1]) * rawW);
    const h = Math.round(Math.sqrt(ctx.parentMatrix[2] * ctx.parentMatrix[2] + ctx.parentMatrix[3] * ctx.parentMatrix[3]) * rawH);
    const bounds: FrameBounds = { x, y, w, h };

    const tblEl = safeExtractFirstXmlElement(gfXml, 'a:tbl');
    if (tblEl) {
      shapes.push(parseGraphicFrameTable(tblEl.content, bounds, ctx));
    } else if (
      gfXml.includes('uri="http://schemas.openxmlformats.org/drawingml/2006/diagram"') ||
      gfXml.includes('<dgm:relIds') ||
      gfXml.includes('dgm:relIds')
    ) {
      await parseSmartArtDiagram(gfXml, bounds, shapes, ctx);
    } else {
      await parseChartOrGenericFrame(gfXml, bounds, shapes, ctx);
    }
  }
  return shapes;
}

async function cropPictureBuffer(
  imgBuffer: Buffer,
  srcRectEl: SafeXmlElement,
  mediaPath: string,
  media: PptxMedia
): Promise<Buffer> {
  const l = parseInt(srcRectEl.attrs.l || '0', 10);
  const t = parseInt(srcRectEl.attrs.t || '0', 10);
  const r = parseInt(srcRectEl.attrs.r || '0', 10);
  const b = parseInt(srcRectEl.attrs.b || '0', 10);
  if (l <= 0 && t <= 0 && r <= 0 && b <= 0) return imgBuffer;

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
      cropped = await openLimitedSharp(imgBuffer)
        .extract({ left: cropLeft, top: cropTop, width: extractW, height: extractH })
        .toBuffer();
    }
  } catch (err) {
    rethrowInputPixelLimit(err);
  }
  if (cropped) {
    media.chargeDerived(cropped.length, mediaPath);
    return cropped;
  }
  return imgBuffer;
}

async function parsePptxPictures(
  picElements: SafeXmlElement[],
  grpRanges: Array<[number, number]>,
  ctx: InternalSceneContext
): Promise<VisualSlideShape[]> {
  const shapes: VisualSlideShape[] = [];
  for (const picEl of picElements) {
    const isInsideGroup = grpRanges.some(([s, e]) => picEl.startIndex >= s && picEl.endIndex <= e);
    if (isInsideGroup) continue;

    const picXml = picEl.content;
    const bounds = computeTransformedElementBounds(picXml, ctx.parentMatrix);
    if (!bounds) continue;
    const { x, y, w: worldW, h: worldH, rot: worldRot, flipH, flipV, matrix: worldMatrix } = bounds;

    const blipEl = safeExtractFirstXmlElement(picXml, 'a:blip');
    const rId = blipEl ? blipEl.attrs['r:embed'] || blipEl.attrs.embed : undefined;
    if (!rId) continue;
    const target = ctx.relsMap.get(rId);
    if (!target) continue;

    const mediaPath = resolveZipPath('ppt/slides', target);
    const picture = await ctx.media.picture(ctx.zip, mediaPath);
    if (!picture) continue;

    let imgBuffer = picture.buffer;
    const srcRectEl = safeExtractFirstXmlElement(picXml, 'a:srcRect');
    if (srcRectEl) {
      imgBuffer = await cropPictureBuffer(imgBuffer, srcRectEl, mediaPath, ctx.media);
    }
    shapes.push({
      x,
      y,
      width: worldW,
      height: worldH,
      shapeType: 'picture',
      imageData: imgBuffer,
      imageMimeType: picture.mimeType,
      rotation: worldRot || undefined,
      flipH: flipH || undefined,
      flipV: flipV || undefined,
      transformMatrix: worldMatrix,
    });
  }
  return shapes;
}

function parseShapeTextBody(
  txBody: string,
  ctx: InternalSceneContext
): { shapeText: string; fontSize?: number; fontColor?: string; bold: boolean } {
  let fontSize: number | undefined;
  let fontColor: string | undefined;
  let bold = false;
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

  const shapeText = textMatches.join(' ');
  for (const tm of textMatches) {
    pushUniqueSlideText(ctx.texts, ctx.seenTexts, tm);
  }
  return { shapeText, fontSize, fontColor, bold };
}

function parsePptxShapes(
  spElements: SafeXmlElement[],
  grpRanges: Array<[number, number]>,
  ctx: InternalSceneContext
): VisualSlideShape[] {
  const shapes: VisualSlideShape[] = [];
  const standaloneSpElements = spElements.filter(
    (sp) => !grpRanges.some(([start, end]) => sp.startIndex >= start && sp.endIndex <= end)
  );

  for (const spEl of standaloneSpElements) {
    const spXml = spEl.content;
    const bounds = computeTransformedElementBounds(spXml, ctx.parentMatrix);
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
      const textInfo = parseShapeTextBody(txEl.content, ctx);
      shapeText = textInfo.shapeText;
      fontSize = textInfo.fontSize;
      fontColor = textInfo.fontColor;
      bold = textInfo.bold;
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

/**
 * Recursively parses DrawingML 2D scene graph for a PPTX slide, accumulating
 * affine transform matrices (M_world = M_parent * M_local) for nested <p:grpSp>,
 * resolving <dgm:relIds> SmartArt diagrams, pictures (<p:pic>), tables, charts, and shapes.
 */
export async function parsePptxSlideSceneGraph(
  xml: string,
  context: PptxSceneContext
): Promise<VisualSlideShape[]>;
export async function parsePptxSlideSceneGraph(
  xml: string,
  parentMatrix: Matrix2D,
  slideWidth: number,
  slideHeight: number,
  relsMap: Map<string, string>,
  zip: JSZip,
  texts: string[],
  media?: PptxMedia
): Promise<VisualSlideShape[]>;
export async function parsePptxSlideSceneGraph(
  ...args: [
    string,
    (Matrix2D | PptxSceneContext)?,
    number?,
    number?,
    Map<string, string>?,
    JSZip?,
    string[]?,
    PptxMedia?,
  ]
): Promise<VisualSlideShape[]> {
  const [
    xml,
    parentMatrixOrContext,
    legacySlideWidth,
    legacySlideHeight,
    legacyRelsMap,
    legacyZip,
    legacyTexts,
    legacyMedia,
  ] = args;

  let parentMatrix: Matrix2D;
  let slideWidth: number;
  let slideHeight: number;
  let relsMap: Map<string, string>;
  let zip: JSZip;
  let texts: string[];
  let media: PptxMedia;

  if (parentMatrixOrContext && !Array.isArray(parentMatrixOrContext)) {
    const ctx = parentMatrixOrContext as PptxSceneContext;
    parentMatrix = ctx.parentMatrix ?? identityMatrix();
    slideWidth = ctx.slideWidth;
    slideHeight = ctx.slideHeight;
    relsMap = ctx.relsMap;
    zip = ctx.zip;
    texts = ctx.texts;
    media = ctx.media ?? new PptxMedia();
  } else {
    parentMatrix = (parentMatrixOrContext as Matrix2D) ?? identityMatrix();
    slideWidth = legacySlideWidth ?? 960;
    slideHeight = legacySlideHeight ?? 540;
    relsMap = legacyRelsMap ?? new Map();
    zip = legacyZip!;
    texts = legacyTexts ?? [];
    media = legacyMedia ?? new PptxMedia();
  }

  const seenTexts = seenSlideTexts(texts);
  const internalCtx: InternalSceneContext = {
    parentMatrix,
    slideWidth,
    slideHeight,
    relsMap,
    zip,
    texts,
    seenTexts,
    media,
  };

  const groupElements = safeExtractXmlElements(xml, 'p:grpSp');
  const gfElements = safeExtractXmlElements(xml, 'p:graphicFrame');
  const picElements = safeExtractXmlElements(xml, 'p:pic');
  const spElements = safeExtractXmlElements(xml, 'p:sp');

  const grpRanges: Array<[number, number]> = groupElements.map((grpEl) => [grpEl.startIndex, grpEl.endIndex]);

  const groupShapes = await parsePptxGroups(groupElements, grpRanges, internalCtx);
  const gfShapes = await parsePptxGraphicFrames(gfElements, grpRanges, internalCtx);
  const picShapes = await parsePptxPictures(picElements, grpRanges, internalCtx);
  const spShapes = parsePptxShapes(spElements, grpRanges, internalCtx);

  return [...groupShapes, ...gfShapes, ...picShapes, ...spShapes];
}
