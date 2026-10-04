import { Point3D, adaptiveTessellateCubicBezier, tessellateSvgArc } from './cad-nurbs';

export interface RgbColor {
  r: number;
  g: number;
  b: number;
}

export interface SvgGeometryElement {
  subpaths: { x: number; y: number }[][];
  isClosed: boolean;
  fill: RgbColor | null;
  stroke: RgbColor | null;
  strokeWidth: number;
}

export interface ParsedSvgVectorDocument {
  width: number;
  height: number;
  elements: SvgGeometryElement[];
}

const NAMED_COLORS: Record<string, RgbColor> = {
  black: { r: 0, g: 0, b: 0 },
  white: { r: 255, g: 255, b: 255 },
  red: { r: 255, g: 0, b: 0 },
  green: { r: 0, g: 128, b: 0 },
  lime: { r: 0, g: 255, b: 0 },
  blue: { r: 0, g: 0, b: 255 },
  yellow: { r: 255, g: 255, b: 0 },
  cyan: { r: 0, g: 255, b: 255 },
  aqua: { r: 0, g: 255, b: 255 },
  magenta: { r: 255, g: 0, b: 255 },
  fuchsia: { r: 255, g: 0, b: 255 },
  gray: { r: 128, g: 128, b: 128 },
  grey: { r: 128, g: 128, b: 128 },
  lightgray: { r: 211, g: 211, b: 211 },
  lightgrey: { r: 211, g: 211, b: 211 },
  darkgray: { r: 169, g: 169, b: 169 },
  darkgrey: { r: 169, g: 169, b: 169 },
  orange: { r: 255, g: 165, b: 0 },
  purple: { r: 128, g: 0, b: 128 },
  navy: { r: 0, g: 0, b: 128 },
  teal: { r: 0, g: 128, b: 128 },
  maroon: { r: 128, g: 0, b: 0 },
  silver: { r: 192, g: 192, b: 192 },
};

/**
 * Parses CSS / SVG color values into standard RGB components.
 */
export function parseCssColor(colorStr: string | null | undefined): RgbColor | null {
  if (!colorStr) return null;
  const s = colorStr.trim().toLowerCase();
  if (s === 'none' || s === 'transparent' || s === '') return null;

  if (NAMED_COLORS[s]) {
    return { ...NAMED_COLORS[s] };
  }

  // Hex format: #rgb, #rrggbb, #rgba, #rrggbbaa
  if (s.startsWith('#')) {
    const hex = s.substring(1);
    if (hex.length === 3 || hex.length === 4) {
      const r = Number.parseInt(hex[0] + hex[0], 16);
      const g = Number.parseInt(hex[1] + hex[1], 16);
      const b = Number.parseInt(hex[2] + hex[2], 16);
      return { r, g, b };
    }
    if (hex.length >= 6) {
      const r = Number.parseInt(hex.substring(0, 2), 16);
      const g = Number.parseInt(hex.substring(2, 4), 16);
      const b = Number.parseInt(hex.substring(4, 6), 16);
      return { r, g, b };
    }
  }

  // rgb(r, g, b)
  const rgbMatch = s.match(/rgb\s*\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)/);
  if (rgbMatch) {
    return {
      r: Math.max(0, Math.min(255, Number.parseInt(rgbMatch[1], 10))),
      g: Math.max(0, Math.min(255, Number.parseInt(rgbMatch[2], 10))),
      b: Math.max(0, Math.min(255, Number.parseInt(rgbMatch[3], 10))),
    };
  }

  return { r: 0, g: 0, b: 0 };
}

/**
 * Parses SVG style attributes and direct styling attributes.
 */
function extractStyleMap(tagContent: string): Map<string, string> {
  const map = new Map<string, string>();

  // 1. Parse style attribute
  const styleMatch = tagContent.match(/style="([^"]*)"/i);
  if (styleMatch) {
    const declarations = styleMatch[1].split(';');
    for (const decl of declarations) {
      const colonIdx = decl.indexOf(':');
      if (colonIdx > 0) {
        const key = decl.substring(0, colonIdx).trim().toLowerCase();
        const val = decl.substring(colonIdx + 1).trim();
        if (key && val) map.set(key, val);
      }
    }
  }

  // 2. Direct attributes (override or supplement)
  const attrRegex = /\b(fill|stroke|stroke-width)\s*=\s*"([^"]*)"/gi;
  let m: RegExpExecArray | null;
  while ((m = attrRegex.exec(tagContent)) !== null) {
    map.set(m[1].toLowerCase(), m[2].trim());
  }

  return map;
}

/**
 * Resolves element styling into fill, stroke, and strokeWidth.
 */
function resolveElementStyle(
  tagContent: string,
  isClosedShape: boolean
): { fill: RgbColor | null; stroke: RgbColor | null; strokeWidth: number } {
  const styles = extractStyleMap(tagContent);

  const fillStr = styles.get('fill');
  let fill: RgbColor | null = null;
  if (fillStr !== undefined) {
    fill = parseCssColor(fillStr);
  } else if (isClosedShape) {
    fill = { r: 0, g: 0, b: 0 }; // Default SVG fill for closed shapes is black
  }

  const strokeStr = styles.get('stroke');
  let stroke: RgbColor | null = null;
  if (strokeStr !== undefined) {
    stroke = parseCssColor(strokeStr);
  } else if (!isClosedShape) {
    stroke = { r: 0, g: 0, b: 0 }; // Default stroke for lines/polylines is black
  }

  const swStr = styles.get('stroke-width');
  const strokeWidth = swStr ? Math.max(0.5, Number.parseFloat(swStr) || 1.0) : 1.0;

  return { fill, stroke, strokeWidth };
}

/**
 * Parses SVG dimensions and viewBox.
 */
function parseSvgDimensions(svgContent: string): {
  width: number;
  height: number;
  minX: number;
  minY: number;
  vbWidth: number;
  vbHeight: number;
} {
  let width = 800;
  let height = 600;
  let minX = 0;
  let minY = 0;
  let vbWidth = 800;
  let vbHeight = 600;

  const svgTagMatch = svgContent.match(/<svg\b([^>]*)>/i);
  if (svgTagMatch) {
    const attrs = svgTagMatch[1];
    const vbMatch = attrs.match(/viewBox\s*=\s*"([^"]*)"/i);
    if (vbMatch) {
      const parts = vbMatch[1].trim().split(/[\s,]+/).map((v) => Number.parseFloat(v));
      if (parts.length >= 4 && parts[2] > 0 && parts[3] > 0) {
        minX = parts[0];
        minY = parts[1];
        vbWidth = parts[2];
        vbHeight = parts[3];
        width = vbWidth;
        height = vbHeight;
      }
    }

    const wMatch = attrs.match(/\bwidth\s*=\s*"([^"]*)"/i);
    if (wMatch) {
      const parsedW = Number.parseFloat(wMatch[1]);
      if (parsedW > 0) width = parsedW;
    }

    const hMatch = attrs.match(/\bheight\s*=\s*"([^"]*)"/i);
    if (hMatch) {
      const parsedH = Number.parseFloat(hMatch[1]);
      if (parsedH > 0) height = parsedH;
    }
  }

  return { width, height, minX, minY, vbWidth, vbHeight };
}

/**
 * Transforms point coordinates according to SVG viewBox mapping.
 */
function mapPoint(
  x: number,
  y: number,
  minX: number,
  minY: number,
  vbWidth: number,
  vbHeight: number,
  width: number,
  height: number
): { x: number; y: number } {
  const tx = vbWidth > 0 ? ((x - minX) / vbWidth) * width : x;
  const ty = vbHeight > 0 ? ((y - minY) / vbHeight) * height : y;
  return { x: tx, y: ty };
}

/**
 * Parses SVG path 'd' attribute commands into high-fidelity adaptive polyline vertices.
 * Tolerance is 0.25px as mandated by the CAD metafile specification.
 */
export function parseSvgPathToPoints(d: string, tolerance: number = 0.25): Point3D[][] {
  const subpaths: Point3D[][] = [];
  let currentSubpath: Point3D[] = [];
  let currentX = 0;
  let currentY = 0;
  let lastCpX = 0;
  let lastCpY = 0;
  let lastCmd = '';

  const regex = /([a-df-z])|([-+]?(?:\d*\.\d+|\d+)(?:[eE][-+]?\d+)?)/gi;
  let match: RegExpExecArray | null;
  const tokens: string[] = [];
  while ((match = regex.exec(d)) !== null) {
    tokens.push(match[0]);
  }

  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i];
    if (/^[a-df-z]$/i.test(token)) {
      lastCmd = token;
      i++;
    } else if (!lastCmd) {
      i++;
      continue;
    }

    const cmd = lastCmd;
    const isRel = cmd === cmd.toLowerCase();
    const upper = cmd.toUpperCase();

    if (upper === 'M') {
      if (i + 1 >= tokens.length) break;
      const x = Number.parseFloat(tokens[i++]);
      const y = Number.parseFloat(tokens[i++]);
      currentX = isRel ? currentX + x : x;
      currentY = isRel ? currentY + y : y;
      if (currentSubpath.length > 0) {
        subpaths.push(currentSubpath);
        currentSubpath = [];
      }
      currentSubpath.push({ x: currentX, y: currentY, z: 0 });
      lastCpX = currentX;
      lastCpY = currentY;
      lastCmd = isRel ? 'l' : 'L';
    } else if (upper === 'L') {
      if (i + 1 >= tokens.length) break;
      const x = Number.parseFloat(tokens[i++]);
      const y = Number.parseFloat(tokens[i++]);
      currentX = isRel ? currentX + x : x;
      currentY = isRel ? currentY + y : y;
      currentSubpath.push({ x: currentX, y: currentY, z: 0 });
      lastCpX = currentX;
      lastCpY = currentY;
    } else if (upper === 'H') {
      if (i >= tokens.length) break;
      const x = Number.parseFloat(tokens[i++]);
      currentX = isRel ? currentX + x : x;
      currentSubpath.push({ x: currentX, y: currentY, z: 0 });
      lastCpX = currentX;
    } else if (upper === 'V') {
      if (i >= tokens.length) break;
      const y = Number.parseFloat(tokens[i++]);
      currentY = isRel ? currentY + y : y;
      currentSubpath.push({ x: currentX, y: currentY, z: 0 });
      lastCpY = currentY;
    } else if (upper === 'C') {
      if (i + 5 >= tokens.length) break;
      const x1 = Number.parseFloat(tokens[i++]);
      const y1 = Number.parseFloat(tokens[i++]);
      const x2 = Number.parseFloat(tokens[i++]);
      const y2 = Number.parseFloat(tokens[i++]);
      const x = Number.parseFloat(tokens[i++]);
      const y = Number.parseFloat(tokens[i++]);

      const p0: Point3D = { x: currentX, y: currentY, z: 0 };
      const p1: Point3D = { x: isRel ? currentX + x1 : x1, y: isRel ? currentY + y1 : y1, z: 0 };
      const p2: Point3D = { x: isRel ? currentX + x2 : x2, y: isRel ? currentY + y2 : y2, z: 0 };
      const p3: Point3D = { x: isRel ? currentX + x : x, y: isRel ? currentY + y : y, z: 0 };

      const curvePts = adaptiveTessellateCubicBezier(p0, p1, p2, p3, tolerance);
      for (let k = 1; k < curvePts.length; k++) {
        currentSubpath.push(curvePts[k]);
      }

      currentX = p3.x;
      currentY = p3.y;
      lastCpX = p2.x;
      lastCpY = p2.y;
    } else if (upper === 'S') {
      if (i + 3 >= tokens.length) break;
      const p1X = ['C', 'c', 'S', 's'].includes(cmd) ? 2 * currentX - lastCpX : currentX;
      const p1Y = ['C', 'c', 'S', 's'].includes(cmd) ? 2 * currentY - lastCpY : currentY;
      const x2 = Number.parseFloat(tokens[i++]);
      const y2 = Number.parseFloat(tokens[i++]);
      const x = Number.parseFloat(tokens[i++]);
      const y = Number.parseFloat(tokens[i++]);

      const p0: Point3D = { x: currentX, y: currentY, z: 0 };
      const p1: Point3D = { x: p1X, y: p1Y, z: 0 };
      const p2: Point3D = { x: isRel ? currentX + x2 : x2, y: isRel ? currentY + y2 : y2, z: 0 };
      const p3: Point3D = { x: isRel ? currentX + x : x, y: isRel ? currentY + y : y, z: 0 };

      const curvePts = adaptiveTessellateCubicBezier(p0, p1, p2, p3, tolerance);
      for (let k = 1; k < curvePts.length; k++) {
        currentSubpath.push(curvePts[k]);
      }

      currentX = p3.x;
      currentY = p3.y;
      lastCpX = p2.x;
      lastCpY = p2.y;
    } else if (upper === 'Q') {
      if (i + 3 >= tokens.length) break;
      const x1 = Number.parseFloat(tokens[i++]);
      const y1 = Number.parseFloat(tokens[i++]);
      const x = Number.parseFloat(tokens[i++]);
      const y = Number.parseFloat(tokens[i++]);

      const p0: Point3D = { x: currentX, y: currentY, z: 0 };
      const cp: Point3D = { x: isRel ? currentX + x1 : x1, y: isRel ? currentY + y1 : y1, z: 0 };
      const p2: Point3D = { x: isRel ? currentX + x : x, y: isRel ? currentY + y : y, z: 0 };

      const p1: Point3D = { x: p0.x + (2 / 3) * (cp.x - p0.x), y: p0.y + (2 / 3) * (cp.y - p0.y), z: 0 };
      const pCubic2: Point3D = { x: p2.x + (2 / 3) * (cp.x - p2.x), y: p2.y + (2 / 3) * (cp.y - p2.y), z: 0 };

      const curvePts = adaptiveTessellateCubicBezier(p0, p1, pCubic2, p2, tolerance);
      for (let k = 1; k < curvePts.length; k++) {
        currentSubpath.push(curvePts[k]);
      }

      currentX = p2.x;
      currentY = p2.y;
      lastCpX = cp.x;
      lastCpY = cp.y;
    } else if (upper === 'A') {
      if (i + 6 >= tokens.length) break;
      const rx = Number.parseFloat(tokens[i++]);
      const ry = Number.parseFloat(tokens[i++]);
      const rot = Number.parseFloat(tokens[i++]);
      const largeArc = Number.parseFloat(tokens[i++]) !== 0;
      const sweep = Number.parseFloat(tokens[i++]) !== 0;
      const x = Number.parseFloat(tokens[i++]);
      const y = Number.parseFloat(tokens[i++]);
      const targetX = isRel ? currentX + x : x;
      const targetY = isRel ? currentY + y : y;

      const arcPoints = tessellateSvgArc(
        currentX,
        currentY,
        rx,
        ry,
        rot,
        largeArc,
        sweep,
        targetX,
        targetY
      );

      for (const pt of arcPoints) {
        currentSubpath.push(pt);
      }

      currentX = targetX;
      currentY = targetY;
      lastCpX = currentX;
      lastCpY = currentY;
    } else if (upper === 'Z') {
      if (currentSubpath.length > 1) {
        const first = currentSubpath[0];
        currentSubpath.push({ x: first.x, y: first.y, z: first.z });
        currentX = first.x;
        currentY = first.y;
      }
      subpaths.push(currentSubpath);
      currentSubpath = [];
    } else {
      i++;
    }
  }

  if (currentSubpath.length > 0) {
    subpaths.push(currentSubpath);
  }

  return subpaths;
}

/**
 * Parses SVG XML into an array of geometry elements with flattened polylines.
 */
export function parseSvgGeometries(svgContent: string): ParsedSvgVectorDocument {
  const { width, height, minX, minY, vbWidth, vbHeight } = parseSvgDimensions(svgContent);
  const elements: SvgGeometryElement[] = [];

  // 1. Paths (<path ...>)
  const pathRegex = /<path\b([^>]*?)\/?>/gi;
  let pMatch: RegExpExecArray | null;
  while ((pMatch = pathRegex.exec(svgContent)) !== null) {
    const tag = pMatch[1];
    const dMatch = tag.match(/\bd="([^"]*)"/i);
    if (!dMatch) continue;
    const dAttr = dMatch[1];
    const { fill, stroke, strokeWidth } = resolveElementStyle(tag, true);
    const rawSubpaths = parseSvgPathToPoints(dAttr, 0.25);
    const subpaths: { x: number; y: number }[][] = [];

    for (const sub of rawSubpaths) {
      if (sub.length < 2) continue;
      subpaths.push(
        sub.map((pt) => mapPoint(pt.x, pt.y, minX, minY, vbWidth, vbHeight, width, height))
      );
    }

    if (subpaths.length > 0) {
      const isClosed = /[zZ]/.test(dAttr);
      elements.push({ subpaths, isClosed, fill, stroke, strokeWidth });
    }
  }

  // 2. Rectangles (<rect ...>)
  const rectRegex = /<rect\b([^>]*?)\/?>/gi;
  let rMatch: RegExpExecArray | null;
  while ((rMatch = rectRegex.exec(svgContent)) !== null) {
    const tag = rMatch[1];
    const xMatch = tag.match(/\bx="([^"]*)"/i);
    const yMatch = tag.match(/\by="([^"]*)"/i);
    const wMatch = tag.match(/\bwidth="([^"]*)"/i);
    const hMatch = tag.match(/\bheight="([^"]*)"/i);
    if (!wMatch || !hMatch) continue;

    const x = xMatch ? Number.parseFloat(xMatch[1]) || 0 : 0;
    const y = yMatch ? Number.parseFloat(yMatch[1]) || 0 : 0;
    const w = Number.parseFloat(wMatch[1]) || 0;
    const h = Number.parseFloat(hMatch[1]) || 0;
    if (w <= 0 || h <= 0) continue;

    const { fill, stroke, strokeWidth } = resolveElementStyle(tag, true);
    const corners = [
      mapPoint(x, y, minX, minY, vbWidth, vbHeight, width, height),
      mapPoint(x + w, y, minX, minY, vbWidth, vbHeight, width, height),
      mapPoint(x + w, y + h, minX, minY, vbWidth, vbHeight, width, height),
      mapPoint(x, y + h, minX, minY, vbWidth, vbHeight, width, height),
      mapPoint(x, y, minX, minY, vbWidth, vbHeight, width, height),
    ];

    elements.push({ subpaths: [corners], isClosed: true, fill, stroke, strokeWidth });
  }

  // 3. Circles (<circle ...>)
  const circleRegex = /<circle\b([^>]*?)\/?>/gi;
  let cMatch: RegExpExecArray | null;
  while ((cMatch = circleRegex.exec(svgContent)) !== null) {
    const tag = cMatch[1];
    const cxMatch = tag.match(/\bcx="([^"]*)"/i);
    const cyMatch = tag.match(/\bcy="([^"]*)"/i);
    const rMatch = tag.match(/\br="([^"]*)"/i);
    if (!rMatch) continue;

    const cx = cxMatch ? Number.parseFloat(cxMatch[1]) || 0 : 0;
    const cy = cyMatch ? Number.parseFloat(cyMatch[1]) || 0 : 0;
    const r = Number.parseFloat(rMatch[1]) || 0;
    if (r <= 0) continue;

    const { fill, stroke, strokeWidth } = resolveElementStyle(tag, true);
    const pts: { x: number; y: number }[] = [];
    const steps = 36;
    for (let k = 0; k <= steps; k++) {
      const theta = (k / steps) * 2 * Math.PI;
      const px = cx + r * Math.cos(theta);
      const py = cy + r * Math.sin(theta);
      pts.push(mapPoint(px, py, minX, minY, vbWidth, vbHeight, width, height));
    }

    elements.push({ subpaths: [pts], isClosed: true, fill, stroke, strokeWidth });
  }

  // 4. Ellipses (<ellipse ...>)
  const ellipseRegex = /<ellipse\b([^>]*?)\/?>/gi;
  let eMatch: RegExpExecArray | null;
  while ((eMatch = ellipseRegex.exec(svgContent)) !== null) {
    const tag = eMatch[1];
    const cxMatch = tag.match(/\bcx="([^"]*)"/i);
    const cyMatch = tag.match(/\bcy="([^"]*)"/i);
    const rxMatch = tag.match(/\brx="([^"]*)"/i);
    const ryMatch = tag.match(/\bry="([^"]*)"/i);
    if (!rxMatch || !ryMatch) continue;

    const cx = cxMatch ? Number.parseFloat(cxMatch[1]) || 0 : 0;
    const cy = cyMatch ? Number.parseFloat(cyMatch[1]) || 0 : 0;
    const rx = Number.parseFloat(rxMatch[1]) || 0;
    const ry = Number.parseFloat(ryMatch[1]) || 0;
    if (rx <= 0 || ry <= 0) continue;

    const { fill, stroke, strokeWidth } = resolveElementStyle(tag, true);
    const pts: { x: number; y: number }[] = [];
    const steps = 36;
    for (let k = 0; k <= steps; k++) {
      const theta = (k / steps) * 2 * Math.PI;
      const px = cx + rx * Math.cos(theta);
      const py = cy + ry * Math.sin(theta);
      pts.push(mapPoint(px, py, minX, minY, vbWidth, vbHeight, width, height));
    }

    elements.push({ subpaths: [pts], isClosed: true, fill, stroke, strokeWidth });
  }

  // 5. Lines (<line ...>)
  const lineRegex = /<line\b([^>]*?)\/?>/gi;
  let lMatch: RegExpExecArray | null;
  while ((lMatch = lineRegex.exec(svgContent)) !== null) {
    const tag = lMatch[1];
    const x1Match = tag.match(/\bx1="([^"]*)"/i);
    const y1Match = tag.match(/\by1="([^"]*)"/i);
    const x2Match = tag.match(/\bx2="([^"]*)"/i);
    const y2Match = tag.match(/\by2="([^"]*)"/i);
    if (!x1Match || !y1Match || !x2Match || !y2Match) continue;

    const x1 = Number.parseFloat(x1Match[1]) || 0;
    const y1 = Number.parseFloat(y1Match[1]) || 0;
    const x2 = Number.parseFloat(x2Match[1]) || 0;
    const y2 = Number.parseFloat(y2Match[1]) || 0;

    const { stroke, strokeWidth } = resolveElementStyle(tag, false);
    const p1 = mapPoint(x1, y1, minX, minY, vbWidth, vbHeight, width, height);
    const p2 = mapPoint(x2, y2, minX, minY, vbWidth, vbHeight, width, height);

    elements.push({ subpaths: [[p1, p2]], isClosed: false, fill: null, stroke, strokeWidth });
  }

  // 6. Polylines and Polygons (<polyline ...>, <polygon ...>)
  const polyRegex = /<(polyline|polygon)\b([^>]*?)\/?>/gi;
  let plMatch: RegExpExecArray | null;
  while ((plMatch = polyRegex.exec(svgContent)) !== null) {
    const isPolyClosed = plMatch[1].toLowerCase() === 'polygon';
    const tag = plMatch[2];
    const ptsMatch = tag.match(/\bpoints="([^"]*)"/i);
    if (!ptsMatch) continue;

    const coords = ptsMatch[1].trim().split(/[\s,]+/).map((v) => Number.parseFloat(v));
    const pts: { x: number; y: number }[] = [];
    for (let k = 0; k + 1 < coords.length; k += 2) {
      if (!Number.isNaN(coords[k]) && !Number.isNaN(coords[k + 1])) {
        pts.push(mapPoint(coords[k], coords[k + 1], minX, minY, vbWidth, vbHeight, width, height));
      }
    }
    if (pts.length < 2) continue;

    if (isPolyClosed) {
      pts.push({ x: pts[0].x, y: pts[0].y });
    }

    const { fill, stroke, strokeWidth } = resolveElementStyle(tag, isPolyClosed);
    elements.push({ subpaths: [pts], isClosed: isPolyClosed, fill, stroke, strokeWidth });
  }

  return { width, height, elements };
}

// ============================================================================
// EMF ENCODER (MS-EMF Enhanced Metafile)
// ============================================================================

/**
 * Encodes an SVG document into a genuine Win32 Enhanced Metafile (EMF) binary buffer.
 */
export function encodeEmf(svgBuffer: Buffer): Buffer {
  if (!svgBuffer || svgBuffer.length === 0) {
    throw new Error('SVG buffer is empty.');
  }

  const doc = parseSvgGeometries(svgBuffer.toString('utf-8'));
  const width = Math.max(1, Math.round(doc.width));
  const height = Math.max(1, Math.round(doc.height));

  const records: Buffer[] = [];

  // EMR_SETMAPMODE (12 bytes, MM_TEXT = 1)
  const mapModeRec = Buffer.alloc(12);
  mapModeRec.writeUInt32LE(17, 0); // EMR_SETMAPMODE
  mapModeRec.writeUInt32LE(12, 4);
  mapModeRec.writeUInt32LE(1, 8); // MM_TEXT
  records.push(mapModeRec);

  // EMR_SETBKMODE (12 bytes, TRANSPARENT = 1)
  const bkModeRec = Buffer.alloc(12);
  bkModeRec.writeUInt32LE(18, 0); // EMR_SETBKMODE
  bkModeRec.writeUInt32LE(12, 4);
  bkModeRec.writeUInt32LE(1, 8); // TRANSPARENT
  records.push(bkModeRec);

  // EMR_SETPOLYFILLMODE (12 bytes, WINDING = 2)
  const fillModeRec = Buffer.alloc(12);
  fillModeRec.writeUInt32LE(19, 0); // EMR_SETPOLYFILLMODE
  fillModeRec.writeUInt32LE(12, 4);
  fillModeRec.writeUInt32LE(2, 8); // WINDING
  records.push(fillModeRec);

  // Process elements
  for (const el of doc.elements) {
    for (const subpath of el.subpaths) {
      if (subpath.length < 2) continue;

      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (const pt of subpath) {
        if (pt.x < minX) minX = pt.x;
        if (pt.y < minY) minY = pt.y;
        if (pt.x > maxX) maxX = pt.x;
        if (pt.y > maxY) maxY = pt.y;
      }

      let createdPen = false;
      let createdBrush = false;

      // 1. Pen setup
      if (el.stroke) {
        const penRec = Buffer.alloc(28);
        penRec.writeUInt32LE(38, 0); // EMR_CREATEPEN
        penRec.writeUInt32LE(28, 4);
        penRec.writeUInt32LE(1, 8); // ihPen = 1
        penRec.writeUInt32LE(0, 12); // PS_SOLID
        penRec.writeUInt32LE(Math.max(1, Math.round(el.strokeWidth)), 16);
        penRec.writeUInt32LE(0, 20);
        penRec.writeUInt32LE((el.stroke.b << 16) | (el.stroke.g << 8) | el.stroke.r, 24);
        records.push(penRec);

        const selPenRec = Buffer.alloc(12);
        selPenRec.writeUInt32LE(37, 0); // EMR_SELECTOBJECT
        selPenRec.writeUInt32LE(12, 4);
        selPenRec.writeUInt32LE(1, 8);
        records.push(selPenRec);
        createdPen = true;
      } else {
        const selNullPen = Buffer.alloc(12);
        selNullPen.writeUInt32LE(37, 0);
        selNullPen.writeUInt32LE(12, 4);
        selNullPen.writeUInt32LE(0x80000008, 8); // NULL_PEN stock object
        records.push(selNullPen);
      }

      // 2. Brush setup
      if (el.fill && el.isClosed) {
        const brushRec = Buffer.alloc(24);
        brushRec.writeUInt32LE(39, 0); // EMR_CREATEBRUSHINDIRECT
        brushRec.writeUInt32LE(24, 4);
        brushRec.writeUInt32LE(2, 8); // ihBrush = 2
        brushRec.writeUInt32LE(0, 12); // BS_SOLID
        brushRec.writeUInt32LE((el.fill.b << 16) | (el.fill.g << 8) | el.fill.r, 16);
        brushRec.writeUInt32LE(0, 20); // BrushHatch = 0
        records.push(brushRec);

        const selBrushRec = Buffer.alloc(12);
        selBrushRec.writeUInt32LE(37, 0);
        selBrushRec.writeUInt32LE(12, 4);
        selBrushRec.writeUInt32LE(2, 8);
        records.push(selBrushRec);
        createdBrush = true;
      } else {
        const selNullBrush = Buffer.alloc(12);
        selNullBrush.writeUInt32LE(37, 0);
        selNullBrush.writeUInt32LE(12, 4);
        selNullBrush.writeUInt32LE(0x80000005, 8); // NULL_BRUSH stock object
        records.push(selNullBrush);
      }

      // 3. Draw Polygon16 or Polyline16
      const cpts = subpath.length;
      const recType = el.isClosed ? 86 : 87; // EMR_POLYGON16 (86) or EMR_POLYLINE16 (87)
      const recSize = 28 + 4 * cpts;
      const drawRec = Buffer.alloc(recSize);
      drawRec.writeUInt32LE(recType, 0);
      drawRec.writeUInt32LE(recSize, 4);
      drawRec.writeInt32LE(Math.round(minX), 8);
      drawRec.writeInt32LE(Math.round(minY), 12);
      drawRec.writeInt32LE(Math.round(maxX), 16);
      drawRec.writeInt32LE(Math.round(maxY), 20);
      drawRec.writeUInt32LE(cpts, 24);

      for (let pIdx = 0; pIdx < cpts; pIdx++) {
        const pt = subpath[pIdx];
        drawRec.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(pt.x))), 28 + pIdx * 4);
        drawRec.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(pt.y))), 28 + pIdx * 4 + 2);
      }
      records.push(drawRec);

      // 4. Delete created objects
      if (createdPen) {
        const delPen = Buffer.alloc(12);
        delPen.writeUInt32LE(40, 0); // EMR_DELETEOBJECT
        delPen.writeUInt32LE(12, 4);
        delPen.writeUInt32LE(1, 8);
        records.push(delPen);
      }
      if (createdBrush) {
        const delBrush = Buffer.alloc(12);
        delBrush.writeUInt32LE(40, 0); // EMR_DELETEOBJECT
        delBrush.writeUInt32LE(12, 4);
        delBrush.writeUInt32LE(2, 8);
        records.push(delBrush);
      }
    }
  }

  // EMR_EOF (20 bytes)
  const eofRec = Buffer.alloc(20);
  eofRec.writeUInt32LE(14, 0); // EMR_EOF
  eofRec.writeUInt32LE(20, 4);
  eofRec.writeUInt32LE(0, 8);
  eofRec.writeUInt32LE(0, 12);
  eofRec.writeUInt32LE(20, 16);
  records.push(eofRec);

  // Total records includes EMR_HEADER
  const totalRecordCount = records.length + 1;
  let bodySize = 0;
  for (const r of records) bodySize += r.length;
  const totalFileSize = 88 + bodySize;

  // EMR_HEADER (88 bytes)
  const headerRec = Buffer.alloc(88);
  headerRec.writeUInt32LE(1, 0); // EMR_HEADER
  headerRec.writeUInt32LE(88, 4);
  headerRec.writeInt32LE(0, 8); // rclBounds
  headerRec.writeInt32LE(0, 12);
  headerRec.writeInt32LE(width, 16);
  headerRec.writeInt32LE(height, 20);
  headerRec.writeInt32LE(0, 24); // rclFrame (0.01 mm / HIMETRIC units)
  headerRec.writeInt32LE(0, 28);
  headerRec.writeInt32LE(Math.round(width * 26.458333), 32);
  headerRec.writeInt32LE(Math.round(height * 26.458333), 36);
  headerRec.writeUInt32LE(0x28646d65, 40); // ENHMETA_SIGNATURE (" dme" in LE = "EMF ")
  headerRec.writeUInt32LE(0x00010000, 44); // nVersion 1.0
  headerRec.writeUInt32LE(totalFileSize, 48); // nBytes
  headerRec.writeUInt32LE(totalRecordCount, 52); // nRecords
  headerRec.writeUInt16LE(3, 56); // nHandles
  headerRec.writeUInt16LE(0, 58); // sReserved
  headerRec.writeUInt32LE(0, 60); // nDescription
  headerRec.writeUInt32LE(0, 64); // offDescription
  headerRec.writeUInt32LE(0, 68); // nPalEntries
  headerRec.writeUInt32LE(width, 72); // szlDevice.cx
  headerRec.writeUInt32LE(height, 76); // szlDevice.cy
  headerRec.writeUInt32LE(Math.max(1, Math.round((width * 25.4) / 96)), 80); // szlMillimeters.cx
  headerRec.writeUInt32LE(Math.max(1, Math.round((height * 25.4) / 96)), 84); // szlMillimeters.cy

  return Buffer.concat([headerRec, ...records]);
}

// ============================================================================
// WMF ENCODER (MS-WMF Windows Metafile with Aldus Placeable Header)
// ============================================================================

/**
 * Encodes an SVG document into a genuine Windows Metafile (WMF) binary buffer.
 */
export function encodeWmf(svgBuffer: Buffer): Buffer {
  if (!svgBuffer || svgBuffer.length === 0) {
    throw new Error('SVG buffer is empty.');
  }

  const doc = parseSvgGeometries(svgBuffer.toString('utf-8'));
  const width = Math.max(1, Math.round(doc.width));
  const height = Math.max(1, Math.round(doc.height));

  const records: Buffer[] = [];
  let maxRecordWords = 9; // Minimum header size

  // META_SETWINDOWORG (5 words, 10 bytes)
  const setOrg = Buffer.alloc(10);
  setOrg.writeUInt32LE(5, 0);
  setOrg.writeUInt16LE(0x020b, 4);
  setOrg.writeInt16LE(0, 6); // Y
  setOrg.writeInt16LE(0, 8); // X
  records.push(setOrg);
  if (5 > maxRecordWords) maxRecordWords = 5;

  // META_SETWINDOWEXT (5 words, 10 bytes)
  const setExt = Buffer.alloc(10);
  setExt.writeUInt32LE(5, 0);
  setExt.writeUInt16LE(0x020c, 4);
  setExt.writeInt16LE(Math.max(-32767, Math.min(32767, height)), 6); // Y
  setExt.writeInt16LE(Math.max(-32767, Math.min(32767, width)), 8); // X
  records.push(setExt);

  // Process elements
  for (const el of doc.elements) {
    for (const subpath of el.subpaths) {
      if (subpath.length < 2) continue;

      // 1. Pen Setup (META_CREATEPENINDIRECT, 8 words, 16 bytes)
      const penRec = Buffer.alloc(16);
      penRec.writeUInt32LE(8, 0);
      penRec.writeUInt16LE(0x02fa, 4);
      if (el.stroke) {
        penRec.writeUInt16LE(0, 6); // PS_SOLID
        penRec.writeUInt16LE(Math.max(1, Math.round(el.strokeWidth)), 8);
        penRec.writeUInt16LE(0, 10);
        penRec.writeUInt32LE((el.stroke.b << 16) | (el.stroke.g << 8) | el.stroke.r, 12);
      } else {
        penRec.writeUInt16LE(5, 6); // PS_NULL
        penRec.writeUInt16LE(0, 8);
        penRec.writeUInt16LE(0, 10);
        penRec.writeUInt32LE(0, 12);
      }
      records.push(penRec);
      if (8 > maxRecordWords) maxRecordWords = 8;

      const selPen = Buffer.alloc(8);
      selPen.writeUInt32LE(4, 0);
      selPen.writeUInt16LE(0x012d, 4); // META_SELECTOBJECT
      selPen.writeUInt16LE(0, 6); // Object index 0
      records.push(selPen);

      // 2. Brush Setup (META_CREATEBRUSHINDIRECT, 7 words, 14 bytes)
      const brushRec = Buffer.alloc(14);
      brushRec.writeUInt32LE(7, 0);
      brushRec.writeUInt16LE(0x02fc, 4);
      if (el.fill && el.isClosed) {
        brushRec.writeUInt16LE(0, 6); // BS_SOLID
        brushRec.writeUInt32LE((el.fill.b << 16) | (el.fill.g << 8) | el.fill.r, 8);
        brushRec.writeUInt16LE(0, 12); // Hatch = 0
      } else {
        brushRec.writeUInt16LE(1, 6); // BS_HOLLOW
        brushRec.writeUInt32LE(0, 8);
        brushRec.writeUInt16LE(0, 12);
      }
      records.push(brushRec);
      if (7 > maxRecordWords) maxRecordWords = 7;

      const selBrush = Buffer.alloc(8);
      selBrush.writeUInt32LE(4, 0);
      selBrush.writeUInt16LE(0x012d, 4); // META_SELECTOBJECT
      selBrush.writeUInt16LE(1, 6); // Object index 1
      records.push(selBrush);

      // 3. Draw Polygon or Polyline
      const cpts = subpath.length;
      const fnCode = el.isClosed ? 0x0324 : 0x0325; // META_POLYGON or META_POLYLINE
      const recWords = 4 + cpts * 2;
      const drawRec = Buffer.alloc(recWords * 2);
      drawRec.writeUInt32LE(recWords, 0);
      drawRec.writeUInt16LE(fnCode, 4);
      drawRec.writeInt16LE(cpts, 6);

      for (let pIdx = 0; pIdx < cpts; pIdx++) {
        const pt = subpath[pIdx];
        drawRec.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(pt.x))), 8 + pIdx * 4);
        drawRec.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(pt.y))), 8 + pIdx * 4 + 2);
      }
      records.push(drawRec);
      if (recWords > maxRecordWords) maxRecordWords = recWords;

      // 4. Delete Pen and Brush
      const delPen = Buffer.alloc(8);
      delPen.writeUInt32LE(4, 0);
      delPen.writeUInt16LE(0x01f0, 4); // META_DELETEOBJECT
      delPen.writeUInt16LE(0, 6);
      records.push(delPen);

      const delBrush = Buffer.alloc(8);
      delBrush.writeUInt32LE(4, 0);
      delBrush.writeUInt16LE(0x01f0, 4); // META_DELETEOBJECT
      delBrush.writeUInt16LE(1, 6);
      records.push(delBrush);
    }
  }

  // META_EOF (3 words, 6 bytes)
  const eofRec = Buffer.alloc(6);
  eofRec.writeUInt32LE(3, 0);
  eofRec.writeUInt16LE(0x0000, 4);
  records.push(eofRec);

  // Standard WMF Header (18 bytes = 9 words)
  let standardRecordsByteLen = 0;
  for (const r of records) standardRecordsByteLen += r.length;
  const standardWmfTotalBytes = 18 + standardRecordsByteLen;
  const standardWmfTotalWords = Math.floor(standardWmfTotalBytes / 2);

  const stdHeader = Buffer.alloc(18);
  stdHeader.writeUInt16LE(1, 0); // FileType = 1 (MEMORYMETAFILE)
  stdHeader.writeUInt16LE(9, 2); // HeaderSize = 9 words
  stdHeader.writeUInt16LE(0x0300, 4); // Version 3.0
  stdHeader.writeUInt32LE(standardWmfTotalWords, 6); // FileSize in words
  stdHeader.writeUInt16LE(2, 10); // NumOfObjects = 2
  stdHeader.writeUInt32LE(maxRecordWords, 12); // MaxRecord size in words
  stdHeader.writeUInt16LE(0, 16); // NumOfMembers = 0

  // Aldus Placeable Header (22 bytes)
  const aldusHeader = Buffer.alloc(22);
  aldusHeader.writeUInt32LE(0x9ac6cdd7, 0); // Key
  aldusHeader.writeUInt16LE(0, 4); // Handle
  aldusHeader.writeInt16LE(0, 6); // Left
  aldusHeader.writeInt16LE(0, 8); // Top
  aldusHeader.writeInt16LE(Math.max(-32767, Math.min(32767, width)), 10); // Right
  aldusHeader.writeInt16LE(Math.max(-32767, Math.min(32767, height)), 12); // Bottom
  aldusHeader.writeUInt16LE(96, 14); // Inch
  aldusHeader.writeUInt32LE(0, 16); // Reserved

  // Checksum: XOR of first 10 16-bit words of aldusHeader
  let checksum = 0;
  for (let off = 0; off < 20; off += 2) {
    checksum ^= aldusHeader.readUInt16LE(off);
  }
  aldusHeader.writeUInt16LE(checksum, 20);

  return Buffer.concat([aldusHeader, stdHeader, ...records]);
}

// ============================================================================
// CGM ENCODER (ISO/IEC 8632 Clear-Text Encoding)
// ============================================================================

/**
 * Escapes special characters and quotes for clear-text CGM string literals.
 */
function escapeCgmString(str: string): string {
  return str.replace(/["\\]/g, '\\$&').replace(/[\r\n]+/g, ' ').trim();
}

/**
 * Formats an array of 2D points into standard CGM coordinate pairs: (x,y) (x,y)
 */
function formatCgmPoints(points: { x: number; y: number }[]): string {
  return points.map((p) => `(${Math.round(p.x)},${Math.round(p.y)})`).join(' ');
}

/**
 * Encodes an SVG document into standard ISO 8632 clear-text Computer Graphics Metafile (CGM).
 */
export function encodeCgm(svgBuffer: Buffer, baseName: string = 'drawing'): Buffer {
  if (!svgBuffer || svgBuffer.length === 0) {
    throw new Error('SVG buffer is empty.');
  }

  const doc = parseSvgGeometries(svgBuffer.toString('utf-8'));
  const width = Math.max(1, Math.round(doc.width));
  const height = Math.max(1, Math.round(doc.height));
  const safeName = escapeCgmString(baseName || 'drawing');

  const lines: string[] = [
    `BEGMF "${safeName}";`,
    `MFVERSION 1;`,
    `MFDESC "Generated by EasyConvert Vector Engine";`,
    `MFELEMENTLIST "DRAWINGSET";`,
    `BEGMFDEFAULTS;`,
    `ENDMFDEFAULTS;`,
    `BEGPIC "${safeName}";`,
    `BEGPICBODY;`,
    `VDCEXT (0,0) (${width},${height});`,
    `COLRMODE DIRECT;`,
    `BEGMDL "${safeName}";`,
  ];

  for (const el of doc.elements) {
    if (el.stroke) {
      lines.push(`LINECOLR (${el.stroke.r},${el.stroke.g},${el.stroke.b});`);
      lines.push(`LINEWIDTH ${Math.max(1, Math.round(el.strokeWidth))};`);
    }

    if (el.fill && el.isClosed) {
      lines.push(`FILLCOLR (${el.fill.r},${el.fill.g},${el.fill.b});`);
    }

    for (const sub of el.subpaths) {
      if (sub.length < 2) continue;
      const ptStr = formatCgmPoints(sub);

      if (el.isClosed && el.fill) {
        lines.push(`POLYGON ${ptStr};`);
        if (el.stroke) {
          lines.push(`POLYLINE ${ptStr} (${Math.round(sub[0].x)},${Math.round(sub[0].y)});`);
        }
      } else {
        lines.push(`POLYLINE ${ptStr};`);
      }
    }
  }

  lines.push('ENDMDL;');
  lines.push('ENDPIC;');
  lines.push('ENDMF;');
  lines.push('');

  return Buffer.from(lines.join('\n'), 'utf-8');
}
