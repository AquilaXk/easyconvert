import { type DrawingMlShape } from './types';
import { getGuideValue, getShapeAdjustRatio } from './drawingml-shapes';
import { adjustHexBrightness } from './chart-svg';
import { renderSafePdfText } from './pdf-text';
import { renderPdfChart } from './pdf-chart';

export function renderSinglePdfShape(
  doc: PDFKit.PDFDocument,
  s: DrawingMlShape,
  hasUnicodeFont: boolean,
  posX: number,
  posY: number,
  sw: number,
  sh: number
): void {
  doc.save();
  const cx = posX + sw / 2;
  const cy = posY + sh / 2;
  doc.translate(cx, cy);
  if (s.rotation) doc.rotate(s.rotation);
  if (s.flipH || s.flipV) doc.scale(s.flipH ? -1 : 1, s.flipV ? -1 : 1);
  doc.translate(-cx, -cy);

  const geom = (s.presetGeom || 'rect').toLowerCase();
  const hasFill = s.fillColor && s.fillColor !== 'none';
  const strokeColor = s.strokeColor || '#1F2340';
  const strokeWidth = s.strokeWidth ?? 1;
  const hasStroke = strokeWidth > 0 && strokeColor !== 'none';

  if (s.geomType === 'custom' && s.svgPath) {
    try {
      doc.path(s.svgPath);
    } catch {
      doc.rect(posX, posY, sw, sh);
    }
  } else {
    switch (geom) {
      case 'ellipse':
      case 'circle':
        doc.ellipse(posX + sw / 2, posY + sh / 2, sw / 2, sh / 2);
        break;
      case 'roundrect': {
        const hasGuides = s.guides?.rx !== undefined || s.guides?.r !== undefined || s.adjustValues?.adj !== undefined;
        const defaultRadius = hasGuides ? Math.min(sw, sh) * getShapeAdjustRatio(s, 'adj', 0.15) : Math.min(8, sw * 0.15);
        const rx = getGuideValue(s, 'rx', getGuideValue(s, 'r', defaultRadius));
        doc.roundedRect(posX, posY, sw, sh, rx);
        break;
      }
      case 'triangle':
        doc.polygon([posX + sw / 2, posY], [posX + sw, posY + sh], [posX, posY + sh]);
        break;
      case 'diamond':
      case 'flowchartdecision':
        doc.polygon(
          [posX + sw / 2, posY],
          [posX + sw, posY + sh / 2],
          [posX + sw / 2, posY + sh],
          [posX, posY + sh / 2]
        );
        break;
      case 'line':
        doc.moveTo(posX, posY).lineTo(posX + sw, posY + sh);
        break;
      case 'rightarrow': {
        const headRatio = getShapeAdjustRatio(s, 'adj1', 0.4);
        const shaftThick = getShapeAdjustRatio(s, 'adj2', 0.5);
        const shaftX = posX + sw * (1 - headRatio);
        const yTop = posY + (sh * (1 - shaftThick)) / 2;
        const yBottom = posY + sh - (sh * (1 - shaftThick)) / 2;
        doc.polygon(
          [posX, yTop],
          [shaftX, yTop],
          [shaftX, posY],
          [posX + sw, posY + sh * 0.5],
          [shaftX, posY + sh],
          [shaftX, yBottom],
          [posX, yBottom]
        );
        break;
      }
      case 'leftrightarrow': {
        const headRatio = getShapeAdjustRatio(s, 'adj1', 0.25);
        const shaftThick = getShapeAdjustRatio(s, 'adj2', 0.5);
        const leftHead = posX + sw * headRatio;
        const rightHead = posX + sw * (1 - headRatio);
        const yTop = posY + (sh * (1 - shaftThick)) / 2;
        const yBottom = posY + sh - (sh * (1 - shaftThick)) / 2;
        doc.polygon(
          [posX, posY + sh * 0.5],
          [leftHead, posY],
          [leftHead, yTop],
          [rightHead, yTop],
          [rightHead, posY],
          [posX + sw, posY + sh * 0.5],
          [rightHead, posY + sh],
          [rightHead, yBottom],
          [leftHead, yBottom],
          [leftHead, posY + sh]
        );
        break;
      }
      case 'chevron': {
        const depthRatio = getShapeAdjustRatio(s, 'adj', 0.25);
        const dX = sw * depthRatio;
        doc.polygon(
          [posX, posY],
          [posX + sw - dX, posY],
          [posX + sw, posY + sh * 0.5],
          [posX + sw - dX, posY + sh],
          [posX, posY + sh],
          [posX + dX, posY + sh * 0.5]
        );
        break;
      }
      case 'cube': {
        const cd = Math.min(sw, sh) * getShapeAdjustRatio(s, 'adj', 0.2);
        const fill = s.fillColor || '#5C6BC0';
        const topFill = adjustHexBrightness(fill, 1.2);
        const rightFill = adjustHexBrightness(fill, 0.8);

        // Top face
        doc.polygon(
          [posX, posY + cd],
          [posX + cd, posY],
          [posX + sw, posY],
          [posX + sw - cd, posY + cd]
        );
        if (topFill && topFill !== 'none') doc.fill(topFill);
        if (hasStroke) doc.lineWidth(strokeWidth).stroke(strokeColor);

        // Right face
        doc.polygon(
          [posX + sw - cd, posY + cd],
          [posX + sw, posY],
          [posX + sw, posY + sh - cd],
          [posX + sw - cd, posY + sh]
        );
        if (rightFill && rightFill !== 'none') doc.fill(rightFill);
        if (hasStroke) doc.lineWidth(strokeWidth).stroke(strokeColor);

        // Front face
        doc.rect(posX, posY + cd, sw - cd, sh - cd);
        if (fill && fill !== 'none') doc.fill(fill);
        if (hasStroke) doc.lineWidth(strokeWidth).stroke(strokeColor);
        break;
      }
      case 'wedgerectcallout': {
        const tailX = posX + sw * getShapeAdjustRatio(s, 'adj1', 0.3);
        const tailY = posY + sh * getShapeAdjustRatio(s, 'adj2', 1.0);
        doc.polygon(
          [posX, posY],
          [posX + sw, posY],
          [posX + sw, posY + sh * 0.75],
          [posX + sw * 0.55, posY + sh * 0.75],
          [tailX, tailY],
          [posX + sw * 0.38, posY + sh * 0.75],
          [posX, posY + sh * 0.75]
        );
        break;
      }
      case 'star5': {
        const rOuter = Math.min(sw, sh) / 2;
        const rInner = rOuter * 0.4;
        const pts: Array<[number, number]> = [];
        for (let i = 0; i < 10; i++) {
          const angle = (i * Math.PI) / 5 - Math.PI / 2;
          const r = i % 2 === 0 ? rOuter : rInner;
          pts.push([cx + r * Math.cos(angle), cy + r * Math.sin(angle)]);
        }
        if (pts.length > 0) doc.polygon(...pts);
        break;
      }
      case 'flowchartprocess':
      case 'rect':
      default:
        doc.rect(posX, posY, sw, sh);
        break;
    }
  }

  if (geom !== 'cube') {
    if (hasFill && hasStroke) {
      doc.lineWidth(strokeWidth).fillAndStroke(s.fillColor!, strokeColor);
    } else if (hasFill) {
      doc.fill(s.fillColor!);
    } else if (hasStroke) {
      doc.lineWidth(strokeWidth).stroke(strokeColor);
    }
  }
  doc.restore();

  if (s.text) {
    const textFill =
      s.fillColor === '#5C6BC0' || s.fillColor === '#1F2340' ? '#FFFFFF' : '#1F2340';
    doc.fillColor(textFill).fontSize(Math.max(8, Math.min(12, sh * 0.3)));
    renderSafePdfText(
      doc,
      s.text,
      hasUnicodeFont,
      { width: Math.max(10, sw - 8), align: 'center' },
      posX + 4,
      posY + sh / 2 - 6
    );
  }
}

export function renderPdfDrawingShapes(
  doc: PDFKit.PDFDocument,
  shapes: DrawingMlShape[],
  hasUnicodeFont: boolean
): void {
  if (shapes.length === 0) return;
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  shapes.forEach((s) => {
    minX = Math.min(minX, s.x);
    minY = Math.min(minY, s.y);
    maxX = Math.max(maxX, s.x + s.width);
    maxY = Math.max(maxY, s.y + s.height);
  });

  const drawWidth = Math.max(20, maxX - minX);
  const drawHeight = Math.max(20, maxY - minY);

  if (doc.y + drawHeight > doc.page.height - 60) {
    doc.addPage();
  }
  const baseY = doc.y;
  const startX = 50;
  const maxW = doc.page.width - 100;
  const scale = drawWidth > maxW ? maxW / drawWidth : 1;

  for (const s of shapes) {
    if (s.chart) {
      renderPdfChart(
        doc,
        s.chart,
        hasUnicodeFont,
        startX + (s.x - minX) * scale,
        baseY + (s.y - minY) * scale,
        s.width * scale,
        s.height * scale
      );
      continue;
    }

    const posX = startX + (s.x - minX) * scale;
    const posY = baseY + (s.y - minY) * scale;
    const sw = s.width * scale;
    const sh = s.height * scale;
    renderSinglePdfShape(doc, s, hasUnicodeFont, posX, posY, sw, sh);
  }

  doc.y = baseY + drawHeight * scale + 15;
}
