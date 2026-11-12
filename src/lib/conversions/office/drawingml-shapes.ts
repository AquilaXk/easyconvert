import { safeDecodeXmlEntities, safeExtractXmlElements, type SafeXmlElement } from '../safe-xml-scanner';
import { type Matrix2D, computeGroupTransformMatrix, identityMatrix, multiplyMatrix, parseGroupTransform, transformPoint } from './affine';
import { type DrawingMlShape } from './types';
import { safeExtractFirstXmlElement, safeFindColor } from './xml-helpers';
import { parseOpenXmlChart } from './chart-parse';
import { adjustHexBrightness, renderChartToSvg } from './chart-svg';
import { parseDrawingMlGuides } from './drawingml-formulas';
import { escapeMarkupAttribute } from '../../text/escape';

/**
 * OpenXML DrawingML Vector Shape Parser & SVG Renderer
 * Parses <p:spTree>, <w:drawing>, <a:xfrm>, <a:prstGeom>, and <a:custGeom>
 * into clean, standards-compliant SVG vector paths.
 */
const MAX_DRAWINGML_GROUP_DEPTH = 16;

export function parseDrawingMlShapes(
  xml: string,
  parentMatrix: Matrix2D = identityMatrix(),
  depth: number = 0
): DrawingMlShape[] {
  if (depth >= MAX_DRAWINGML_GROUP_DEPTH) return [];
  const shapes: DrawingMlShape[] = [];

  // 1. Discover top-level DrawingML group shapes (<p:grpSp>, <wpg:wgp>)
  const groupElements = safeExtractXmlElements(xml, ['p:grpSp', 'wpg:wgp']);
  const excludedRanges: Array<[number, number]> = [];
  const topGroups: SafeXmlElement[] = [];

  for (const grpEl of groupElements) {
    const isNestedInOther = excludedRanges.some(([s, e]) => grpEl.startIndex > s && grpEl.endIndex < e);
    if (isNestedInOther) continue;
    excludedRanges.push([grpEl.startIndex, grpEl.endIndex]);
    topGroups.push(grpEl);
  }

  // 2. Discover standalone shape tags: <p:sp>, <wps:wsp>, <a:graphicData>, <w:drawing>
  const targetShapeTags = ['p:sp', 'wps:wsp', 'a:graphicData', 'w:drawing'];
  const shapeElements = safeExtractXmlElements(xml, targetShapeTags);
  const topShapes = shapeElements.filter(
    (e) => !excludedRanges.some(([s, end]) => e.startIndex >= s && e.endIndex <= end)
  );

  type TopLevelItem =
    | { kind: 'group'; el: SafeXmlElement; startIndex: number }
    | { kind: 'shape'; xml: string; startIndex: number };

  const items: TopLevelItem[] = [
    ...topGroups.map((g): TopLevelItem => ({ kind: 'group', el: g, startIndex: g.startIndex })),
    ...topShapes.map((s): TopLevelItem => ({ kind: 'shape', xml: s.raw, startIndex: s.startIndex })),
  ];

  if (
    items.length === 0 &&
    (xml.includes('<a:prstGeom') || xml.includes('<a:custGeom') || xml.includes('<a:spPr') || xml.includes('<c:chart') || xml.includes('<c:plotArea'))
  ) {
    items.push({ kind: 'shape', xml, startIndex: 0 });
  }

  items.sort((a, b) => a.startIndex - b.startIndex);

  for (const item of items) {
    if (item.kind === 'group') {
      const grpXml = item.el.content;
      const { matrix: mGrp } = parseGroupTransform(grpXml, 100, 60);
      const mAccum = multiplyMatrix(parentMatrix, mGrp);
      const childShapes = parseDrawingMlShapes(grpXml, mAccum, depth + 1);
      shapes.push(...childShapes);
      continue;
    }

    const spXml = item.xml;
    // 1. Transform: <a:xfrm rot="..." flipH="..." flipV="..."> <a:off x="..." y="..."/> <a:ext cx="..." cy="..."/>
    const xfrmEl = safeExtractFirstXmlElement(spXml, 'a:xfrm');
    let x = 0,
      y = 0,
      width = 100,
      height = 60,
      rotation = 0,
      flipH = false,
      flipV = false;
    if (xfrmEl) {
      const rotVal = xfrmEl.attrs.rot;
      if (rotVal) rotation = Number.parseInt(rotVal, 10) / 60000;
      if (xfrmEl.attrs.flipH === '1' || xfrmEl.attrs.flipH === 'true') flipH = true;
      if (xfrmEl.attrs.flipV === '1' || xfrmEl.attrs.flipV === 'true') flipV = true;

      const offEl = safeExtractFirstXmlElement(xfrmEl.content, 'a:off');
      if (offEl && offEl.attrs.x && offEl.attrs.y) {
        x = Math.round(Number.parseInt(offEl.attrs.x, 10) / 12700);
        y = Math.round(Number.parseInt(offEl.attrs.y, 10) / 12700);
      }
      const extEl = safeExtractFirstXmlElement(xfrmEl.content, 'a:ext');
      if (extEl && extEl.attrs.cx && extEl.attrs.cy) {
        width = Math.max(1, Math.round(Number.parseInt(extEl.attrs.cx, 10) / 12700));
        height = Math.max(1, Math.round(Number.parseInt(extEl.attrs.cy, 10) / 12700));
      }
    }

    const origX = x;
    const origY = y;
    const origW = width;
    const origH = height;

    const localShapeMatrix = computeGroupTransformMatrix(
      { x, y },
      { cx: width, cy: height },
      { x, y },
      { cx: width, cy: height },
      rotation,
      flipH,
      flipV
    );
    const worldMatrix = multiplyMatrix(parentMatrix, localShapeMatrix);

    const isParentTransformed =
      Math.abs(parentMatrix[0] - 1) > 1e-4 ||
      Math.abs(parentMatrix[1]) > 1e-4 ||
      Math.abs(parentMatrix[2]) > 1e-4 ||
      Math.abs(parentMatrix[3] - 1) > 1e-4 ||
      Math.abs(parentMatrix[4]) > 1e-4 ||
      Math.abs(parentMatrix[5]) > 1e-4;

    if (isParentTransformed) {
      const centerWorld = transformPoint(worldMatrix, x + width / 2, y + height / 2);
      const worldW = Math.max(1, Math.round(Math.hypot(worldMatrix[0], worldMatrix[1]) * width));
      const worldH = Math.max(1, Math.round(Math.hypot(worldMatrix[2], worldMatrix[3]) * height));
      const worldRot = Math.round((Math.atan2(worldMatrix[1], worldMatrix[0]) * 180) / Math.PI);
      x = Math.round(centerWorld.x - worldW / 2);
      y = Math.round(centerWorld.y - worldH / 2);
      width = worldW;
      height = worldH;
      rotation = worldRot;
    }

    // Check if shape contains an embedded chart
    if (
      spXml.includes('<c:chart') ||
      spXml.includes('<c:plotArea') ||
      spXml.includes('<c:chartSpace>')
    ) {
      const chartData = parseOpenXmlChart(spXml);
      if (chartData) {
        const chartSvg = renderChartToSvg(chartData, width, height);
        shapes.push({
          type: 'chart',
          geomType: 'preset',
          presetGeom: 'rect',
          x,
          y,
          width,
          height,
          rotation: rotation || undefined,
          flipH: flipH || undefined,
          flipV: flipV || undefined,
          fillColor: 'none',
          strokeColor: 'none',
          strokeWidth: 0,
          text: chartData.title || `${chartData.type} chart`,
          chart: chartData,
          chartSvg,
          transformMatrix: worldMatrix,
        });
        continue;
      }
    }

    // 2. Fills and Lines
    let fillColor = '#5C6BC0';
    let strokeColor = '#1F2340';
    let strokeWidth = 1;

    if (spXml.includes('<a:noFill/>') || spXml.includes('<a:noFill />')) {
      fillColor = 'none';
    } else {
      const solidFillColor = safeFindColor(spXml, ['a:solidFill']);
      if (solidFillColor) fillColor = solidFillColor;
    }

    const lnEl = safeExtractFirstXmlElement(spXml, 'a:ln');
    if (lnEl) {
      if (lnEl.attrs.w) strokeWidth = Math.max(0.5, Math.round(parseInt(lnEl.attrs.w, 10) / 12700));
      const lnClr = safeFindColor(lnEl.content);
      if (lnClr) strokeColor = lnClr;
    }

    // 3. Guides & Adjust Values (<a:avLst>, <a:gdLst>)
    const initialVars: Record<string, number> = {
      w: width,
      h: height,
      l: x,
      t: y,
      r: x + width,
      b: y + height,
      hc: width / 2,
      vc: height / 2,
      ss: Math.min(width, height),
      ls: Math.max(width, height),
    };
    const guides = parseDrawingMlGuides(spXml, initialVars);
    const avEl = safeExtractFirstXmlElement(spXml, 'a:avLst');
    const adjustValues = avEl ? parseDrawingMlGuides(avEl.raw, {}) : undefined;

    // 4. Geometry (Preset vs Custom)
    let geomType: 'preset' | 'custom' = 'preset';
    let presetGeom = 'rect';
    let svgPath = '';

    const prstEl = safeExtractFirstXmlElement(spXml, 'a:prstGeom');
    const custEl = safeExtractFirstXmlElement(spXml, 'a:custGeom');

    if (custEl) {
      geomType = 'custom';
      const pathEl = safeExtractFirstXmlElement(custEl.content, 'a:path');
      if (pathEl) {
        const pw = pathEl.attrs.w ? Number.parseInt(pathEl.attrs.w, 10) : origW;
        const ph = pathEl.attrs.h ? Number.parseInt(pathEl.attrs.h, 10) : origH;
        const sx = origW / (pw || 1);
        const sy = origH / (ph || 1);

        const dParts: string[] = [];
        const cmdTags = ['a:moveTo', 'a:lnTo', 'a:cubicBezTo', 'a:quadBezTo', 'a:arcTo', 'a:close'];
        const cmdEls = safeExtractXmlElements(pathEl.content, cmdTags);
        for (const cmdEl of cmdEls) {
          const cmdName = cmdEl.localName.toLowerCase();
          const mapPt = (rawPx: number, rawPy: number): { x: number; y: number } => {
            if (isParentTransformed) {
              const res = transformPoint(parentMatrix, rawPx, rawPy);
              return { x: Math.round(res.x), y: Math.round(res.y) };
            }
            return { x: Math.round(rawPx), y: Math.round(rawPy) };
          };

          if (cmdName === 'moveto') {
            const ptEl = safeExtractFirstXmlElement(cmdEl.content, 'a:pt');
            if (ptEl && ptEl.attrs.x && ptEl.attrs.y) {
              const rawPx = origX + Number.parseInt(ptEl.attrs.x, 10) * sx;
              const rawPy = origY + Number.parseInt(ptEl.attrs.y, 10) * sy;
              const p = mapPt(rawPx, rawPy);
              dParts.push(`M ${p.x} ${p.y}`);
            }
          } else if (cmdName === 'lnto') {
            const ptEl = safeExtractFirstXmlElement(cmdEl.content, 'a:pt');
            if (ptEl && ptEl.attrs.x && ptEl.attrs.y) {
              const rawPx = origX + Number.parseInt(ptEl.attrs.x, 10) * sx;
              const rawPy = origY + Number.parseInt(ptEl.attrs.y, 10) * sy;
              const p = mapPt(rawPx, rawPy);
              dParts.push(`L ${p.x} ${p.y}`);
            }
          } else if (cmdName === 'cubicbezto') {
            const ptEls = safeExtractXmlElements(cmdEl.content, 'a:pt');
            const pts: string[] = [];
            for (const pt of ptEls) {
              if (pt.attrs.x && pt.attrs.y) {
                const rawPx = origX + Number.parseInt(pt.attrs.x, 10) * sx;
                const rawPy = origY + Number.parseInt(pt.attrs.y, 10) * sy;
                const p = mapPt(rawPx, rawPy);
                pts.push(`${p.x} ${p.y}`);
              }
            }
            if (pts.length >= 3) {
              dParts.push(`C ${pts[0]}, ${pts[1]}, ${pts[2]}`);
            }
          } else if (cmdName === 'quadbezto') {
            const ptEls = safeExtractXmlElements(cmdEl.content, 'a:pt');
            const pts: string[] = [];
            for (const pt of ptEls) {
              if (pt.attrs.x && pt.attrs.y) {
                const rawPx = origX + Number.parseInt(pt.attrs.x, 10) * sx;
                const rawPy = origY + Number.parseInt(pt.attrs.y, 10) * sy;
                const p = mapPt(rawPx, rawPy);
                pts.push(`${p.x} ${p.y}`);
              }
            }
            if (pts.length >= 2) {
              dParts.push(`Q ${pts[0]}, ${pts[1]}`);
            }
          } else if (cmdName === 'close') {
            dParts.push('Z');
          }
        }
        svgPath = dParts.join(' ');
        if (isParentTransformed) {
          rotation = 0;
          flipH = false;
          flipV = false;
        }
      }
    } else if (prstEl && prstEl.attrs.prst) {
      geomType = 'preset';
      presetGeom = prstEl.attrs.prst.toLowerCase();
    }

    // 5. Text inside shape
    const tEls = safeExtractXmlElements(spXml, 'a:t');
    const text = tEls
      .map((t) => safeDecodeXmlEntities(t.content.replace(/<[^>]+>/g, '')).trim())
      .filter(Boolean)
      .join(' ');

    shapes.push({
      type: geomType === 'custom' ? 'custom' : presetGeom,
      geomType,
      presetGeom,
      customPath: svgPath || undefined,
      svgPath,
      x,
      y,
      width,
      height,
      rotation: rotation || undefined,
      flipH: flipH || undefined,
      flipV: flipV || undefined,
      fillColor,
      strokeColor,
      strokeWidth,
      text: text || undefined,
      adjustValues,
      guides:
        Object.keys(guides).length > Object.keys(initialVars).length ? guides : undefined,
      transformMatrix: worldMatrix,
    });
  }

  return shapes;
}

/**
 * Extracts normalized adjust ratio (0..1) from DrawingML adjustValues or guides.
 */
export function getShapeAdjustRatio(s: DrawingMlShape, name: string, defaultRatio: number): number {
  if (s.adjustValues && typeof s.adjustValues[name] === 'number') {
    const v = s.adjustValues[name];
    return v > 1 ? v / 100000 : v;
  }
  if (s.guides && typeof s.guides[name] === 'number') {
    const v = s.guides[name];
    return v > 1 ? v / 100000 : v;
  }
  return defaultRatio;
}

/**
 * Extracts computed guide value or returns default.
 */
export function getGuideValue(s: DrawingMlShape, name: string, defaultValue: number): number {
  if (s.guides && typeof s.guides[name] === 'number') {
    return s.guides[name];
  }
  if (s.adjustValues && typeof s.adjustValues[name] === 'number') {
    return s.adjustValues[name];
  }
  return defaultValue;
}

/**
 * Renders a single DrawingML shape into an SVG element string.
 */
export function renderSingleShapeSvg(s: DrawingMlShape): string {
  if (s.chartSvg) {
    return s.chartSvg;
  }

  const cx = s.x + s.width / 2;
  const cy = s.y + s.height / 2;
  const transforms: string[] = [];
  if (s.rotation) {
    transforms.push(`rotate(${s.rotation} ${cx} ${cy})`);
  }
  if (s.flipH || s.flipV) {
    const sx = s.flipH ? -1 : 1;
    const sy = s.flipV ? -1 : 1;
    transforms.push(`translate(${cx} ${cy}) scale(${sx} ${sy}) translate(${-cx} ${-cy})`);
  }
  const rotAttr = transforms.length > 0 ? ` transform="${transforms.join(' ')}"` : '';

  let elementStr = '';

  if (s.geomType === 'custom' && s.svgPath) {
    elementStr = `<path d="${s.svgPath}" fill="${s.fillColor || '#5C6BC0'}" stroke="${s.strokeColor || '#1F2340'}" stroke-width="${s.strokeWidth ?? 1}"${rotAttr} />`;
  } else {
    const geom = (s.presetGeom || 'rect').toLowerCase();
    switch (geom) {
      case 'ellipse':
      case 'circle':
        elementStr = `<ellipse cx="${cx}" cy="${cy}" rx="${s.width / 2}" ry="${
          s.height / 2
        }" fill="${s.fillColor || '#5C6BC0'}" stroke="${s.strokeColor || '#1F2340'}" stroke-width="${s.strokeWidth ?? 1}"${rotAttr} />`;
        break;
      case 'roundrect': {
        const hasGuides = s.guides?.rx !== undefined || s.guides?.r !== undefined || s.adjustValues?.adj !== undefined;
        const defaultRadius = hasGuides ? Math.min(s.width, s.height) * getShapeAdjustRatio(s, 'adj', 0.15) : 8;
        const rx = getGuideValue(s, 'rx', getGuideValue(s, 'r', defaultRadius));
        const ry = getGuideValue(s, 'ry', rx);
        elementStr = `<rect x="${s.x}" y="${s.y}" width="${s.width}" height="${s.height}" rx="${rx}" ry="${ry}" fill="${s.fillColor || '#5C6BC0'}" stroke="${s.strokeColor || '#1F2340'}" stroke-width="${s.strokeWidth ?? 1}"${rotAttr} />`;
        break;
      }
      case 'triangle': {
        const pts = `${cx},${s.y} ${s.x + s.width},${s.y + s.height} ${s.x},${s.y + s.height}`;
        elementStr = `<polygon points="${pts}" fill="${s.fillColor || '#5C6BC0'}" stroke="${s.strokeColor || '#1F2340'}" stroke-width="${s.strokeWidth ?? 1}"${rotAttr} />`;
        break;
      }
      case 'diamond':
      case 'flowchartdecision': {
        const pts = `${cx},${s.y} ${s.x + s.width},${cy} ${cx},${s.y + s.height} ${s.x},${cy}`;
        elementStr = `<polygon points="${pts}" fill="${s.fillColor || '#5C6BC0'}" stroke="${s.strokeColor || '#1F2340'}" stroke-width="${s.strokeWidth ?? 1}"${rotAttr} />`;
        break;
      }
      case 'rightarrow': {
        const headRatio = getShapeAdjustRatio(s, 'adj1', 0.4);
        const shaftThick = getShapeAdjustRatio(s, 'adj2', 0.5);
        const shaftX = s.x + s.width * (1 - headRatio);
        const yTop = s.y + (s.height * (1 - shaftThick)) / 2;
        const yBottom = s.y + s.height - (s.height * (1 - shaftThick)) / 2;
        const pts = `${s.x},${yTop} ${shaftX},${yTop} ${shaftX},${s.y} ${s.x + s.width},${cy} ${shaftX},${s.y + s.height} ${shaftX},${yBottom} ${s.x},${yBottom}`;
        elementStr = `<polygon points="${pts}" fill="${s.fillColor || '#5C6BC0'}" stroke="${s.strokeColor || '#1F2340'}" stroke-width="${s.strokeWidth ?? 1}"${rotAttr} />`;
        break;
      }
      case 'leftrightarrow': {
        const headRatio = getShapeAdjustRatio(s, 'adj1', 0.25);
        const shaftThick = getShapeAdjustRatio(s, 'adj2', 0.5);
        const leftHead = s.x + s.width * headRatio;
        const rightHead = s.x + s.width * (1 - headRatio);
        const yTop = s.y + (s.height * (1 - shaftThick)) / 2;
        const yBottom = s.y + s.height - (s.height * (1 - shaftThick)) / 2;
        const pts = `${s.x},${cy} ${leftHead},${s.y} ${leftHead},${yTop} ${rightHead},${yTop} ${rightHead},${s.y} ${
          s.x + s.width
        },${cy} ${rightHead},${s.y + s.height} ${rightHead},${yBottom} ${leftHead},${yBottom} ${leftHead},${s.y + s.height}`;
        elementStr = `<polygon points="${pts}" fill="${s.fillColor || '#5C6BC0'}" stroke="${s.strokeColor || '#1F2340'}" stroke-width="${s.strokeWidth ?? 1}"${rotAttr} />`;
        break;
      }
      case 'wedgerectcallout': {
        const tailX = s.x + s.width * getShapeAdjustRatio(s, 'adj1', 0.3);
        const tailY = s.y + s.height * getShapeAdjustRatio(s, 'adj2', 1.0);
        const d = `M ${s.x} ${s.y} L ${s.x + s.width} ${s.y} L ${s.x + s.width} ${
          s.y + s.height * 0.75
        } L ${s.x + s.width * 0.55} ${s.y + s.height * 0.75} L ${tailX} ${
          tailY
        } L ${s.x + s.width * 0.38} ${s.y + s.height * 0.75} L ${s.x} ${s.y + s.height * 0.75} Z`;
        elementStr = `<path d="${d}" fill="${s.fillColor || '#5C6BC0'}" stroke="${s.strokeColor || '#1F2340'}" stroke-width="${s.strokeWidth ?? 1}"${rotAttr} />`;
        break;
      }
      case 'chevron': {
        const depthRatio = getShapeAdjustRatio(s, 'adj', 0.25);
        const dX = s.width * depthRatio;
        const pts = `${s.x},${s.y} ${s.x + s.width - dX},${s.y} ${s.x + s.width},${cy} ${
          s.x + s.width - dX
        },${s.y + s.height} ${s.x},${s.y + s.height} ${s.x + dX},${cy}`;
        elementStr = `<polygon points="${pts}" fill="${s.fillColor || '#5C6BC0'}" stroke="${s.strokeColor || '#1F2340'}" stroke-width="${s.strokeWidth ?? 1}"${rotAttr} />`;
        break;
      }
      case 'cube': {
        const cd = Math.min(s.width, s.height) * getShapeAdjustRatio(s, 'adj', 0.2);
        const fill = s.fillColor || '#5C6BC0';
        elementStr = `<g${rotAttr}><polygon points="${s.x},${s.y + cd} ${s.x + cd},${s.y} ${
          s.x + s.width
        },${s.y} ${s.x + s.width - cd},${s.y + cd}" fill="${adjustHexBrightness(
          fill,
          1.2
        )}" stroke="${s.strokeColor || '#1F2340'}" stroke-width="${s.strokeWidth ?? 1}" /><polygon points="${
          s.x + s.width - cd
        },${s.y + cd} ${s.x + s.width},${s.y} ${s.x + s.width},${s.y + s.height - cd} ${
          s.x + s.width - cd
        },${s.y + s.height}" fill="${adjustHexBrightness(fill, 0.8)}" stroke="${
          s.strokeColor || '#1F2340'
        }" stroke-width="${s.strokeWidth ?? 1}" /><rect x="${s.x}" y="${s.y + cd}" width="${
          s.width - cd
        }" height="${s.height - cd}" fill="${fill}" stroke="${s.strokeColor || '#1F2340'}" stroke-width="${
          s.strokeWidth ?? 1
        }" /></g>`;
        break;
      }
      case 'line':
        elementStr = `<line x1="${s.x}" y1="${s.y}" x2="${s.x + s.width}" y2="${
          s.y + s.height
        }" stroke="${s.strokeColor || '#1F2340'}" stroke-width="${s.strokeWidth ?? 1}"${rotAttr} />`;
        break;
      case 'star5': {
        const rOuter = Math.min(s.width, s.height) / 2;
        const rInner = rOuter * 0.4;
        const pts: string[] = [];
        for (let i = 0; i < 10; i++) {
          const angle = (i * Math.PI) / 5 - Math.PI / 2;
          const r = i % 2 === 0 ? rOuter : rInner;
          pts.push(`${cx + r * Math.cos(angle)},${cy + r * Math.sin(angle)}`);
        }
        elementStr = `<polygon points="${pts.join(' ')}" fill="${s.fillColor || '#5C6BC0'}" stroke="${
          s.strokeColor || '#1F2340'
        }" stroke-width="${s.strokeWidth ?? 1}"${rotAttr} />`;
        break;
      }
      case 'flowchartprocess':
      case 'rect':
      default:
        elementStr = `<rect x="${s.x}" y="${s.y}" width="${s.width}" height="${s.height}" fill="${s.fillColor || '#5C6BC0'}" stroke="${s.strokeColor || '#1F2340'}" stroke-width="${s.strokeWidth ?? 1}"${rotAttr} />`;
        break;
    }
  }

  if (s.text && !elementStr.startsWith('<g')) {
    const textFill =
      s.fillColor === '#5C6BC0' || s.fillColor === '#1F2340' ? '#FFFFFF' : '#1F2340';
    elementStr += `\n  <text x="${cx}" y="${
      cy + 4
    }" text-anchor="middle" font-family="-apple-system,BlinkMacSystemFont,sans-serif" font-size="12" font-weight="500" fill="${textFill}">${escapeMarkupAttribute(
      s.text
    )}</text>`;
  }

  return elementStr;
}

/**
 * Renders OpenXML DrawingML specifications into an SVG vector graphic string.
 */
export function renderDrawingMlToSvg(
  xmlOrShapes: string | DrawingMlShape[],
  options?: { width?: number; height?: number } | number,
  heightOption?: number
): { svg: string; shapes: DrawingMlShape[] } {
  // If input is an XML string containing an embedded chart part
  if (
    typeof xmlOrShapes === 'string' &&
    (xmlOrShapes.includes('<c:chart') ||
      xmlOrShapes.includes('<c:plotArea') ||
      xmlOrShapes.includes('<c:chartSpace>'))
  ) {
    const chartData = parseOpenXmlChart(xmlOrShapes);
    if (chartData) {
      const optW = typeof options === 'number' ? options : options?.width || 500;
      const optH = typeof options === 'number' ? heightOption || 300 : options?.height || 300;
      const svg = renderChartToSvg(chartData, optW, optH);
      return {
        svg,
        shapes: [
          {
            geomType: 'preset',
            presetGeom: 'rect',
            x: 0,
            y: 0,
            width: optW,
            height: optH,
            chart: chartData,
            chartSvg: svg,
            text: chartData.title || `${chartData.type} chart`,
          },
        ],
      };
    }
  }

  const shapes = Array.isArray(xmlOrShapes) ? xmlOrShapes : parseDrawingMlShapes(xmlOrShapes);
  if (shapes.length === 0) {
    return {
      svg: '',
      shapes: [],
    };
  }

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

  const optWidth = typeof options === 'number' ? options : options?.width;
  const optHeight = typeof options === 'number' ? heightOption : options?.height;

  const contentWidth = Math.max(10, maxX - minX + 20);
  const contentHeight = Math.max(10, maxY - minY + 20);
  const totalWidth = optWidth || contentWidth;
  const totalHeight = optHeight || contentHeight;

  let svgElements = '';
  for (const s of shapes) {
    svgElements += `  ${renderSingleShapeSvg(s)}\n`;
  }

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${minX - 10} ${
    minY - 10
  } ${contentWidth} ${contentHeight}" width="${totalWidth}" height="${totalHeight}">\n${svgElements}</svg>`;
  return { svg, shapes };
}
