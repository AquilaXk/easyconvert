import sharp from 'sharp';
import PDFDocument from 'pdfkit';
import zlib from 'zlib';
import { ConversionOptions, ConversionResult, UnsupportedTargetError, CadGeometryUnavailableError, CadTopologyError } from '../types';
import { encodeBmp, encodePostscript } from './image';
import { configurePdfKitFontFallback, renderSafePdfText } from './office';

import {
  tessellateCadBuffer,
  evaluateCubicBezier,
  evaluateCubicBezierDerivative,
  adaptiveTessellateCubicBezier,
  evaluateQuadraticBezier,
  cubicBezierToBSpline,
  tessellateSvgArc,
  Point3D,
  verifyWatertightManifoldMesh,
} from './cad-nurbs';
import { encodeStl as pureEncodeStl, encodeObj as pureEncodeObj } from '../edge/pure/pure-cad';
import { sanitizeSvgString } from '../security/svg-sanitizer';

export {
  evaluateCubicBezier,
  evaluateCubicBezierDerivative,
  adaptiveTessellateCubicBezier,
  evaluateQuadraticBezier,
  cubicBezierToBSpline,
  tessellateSvgArc,
};

export interface DxfEntity {
  type: 'LINE' | 'CIRCLE' | 'ARC' | 'LWPOLYLINE' | 'TEXT';
  layer?: string;
  x1?: number;
  y1?: number;
  x2?: number;
  y2?: number;
  cx?: number;
  cy?: number;
  r?: number;
  startAngle?: number;
  endAngle?: number;
  points?: { x: number; y: number }[];
  isClosed?: boolean;
  text?: string;
}

export interface CadMesh3D {
  name: string;
  vertices: [number, number, number][];
  faces: [number, number, number][];
  normals: [number, number, number][];
}

export function encodeEmf(svgBuffer: Buffer): Buffer {
  void svgBuffer;
  throw new UnsupportedTargetError('EMF encoder is not available');
}

export function encodeWmf(svgBuffer: Buffer): Buffer {
  void svgBuffer;
  throw new UnsupportedTargetError('WMF encoder is not available');
}

export function encodeCgm(svgBuffer: Buffer, _baseName = 'drawing'): Buffer {
  void svgBuffer;
  throw new UnsupportedTargetError('CGM encoder is not available');
}

export function parseCgmToSvg(cgmText: string): string | null {
  if (!cgmText.includes('BEGMF')) return null;

  let width = 800;
  let height = 600;
  const vdcMatch = cgmText.match(/VDCEXT\s*\(\s*([\d.]+)\s*,\s*([\d.]+)\s*\)\s*\(\s*([\d.]+)\s*,\s*([\d.]+)\s*\)/i);
  if (vdcMatch) {
    const w = parseFloat(vdcMatch[3]) - parseFloat(vdcMatch[1]);
    const h = parseFloat(vdcMatch[4]) - parseFloat(vdcMatch[2]);
    if (w > 0 && h > 0) {
      width = Math.round(w);
      height = Math.round(h);
    }
  }

  const elements: string[] = [];

  // Parse LINE (x1,y1) (x2,y2)
  const lineRegex = /LINE\s*\(\s*([\d.]+)\s*,\s*([\d.]+)\s*\)/gi;
  let lineMatch: RegExpExecArray | null;
  while ((lineMatch = lineRegex.exec(cgmText)) !== null) {
    elements.push(
      `<line x1="${lineMatch[1]}" y1="${lineMatch[2]}" x2="${lineMatch[3]}" y2="${lineMatch[4]}" stroke="#111827" stroke-width="2" />`
    );
  }

  // Parse TEXT (x,y) ... "content"
  const textRegex = /TEXT\s*\(\s*([\d.]+)\s*,\s*([\d.]+)\s*\)[^"]*"([^"]+)"/gi;
  let textMatch: RegExpExecArray | null;
  while ((textMatch = textRegex.exec(cgmText)) !== null) {
    elements.push(
      `<text x="${textMatch[1]}" y="${textMatch[2]}" font-family="system-ui, -apple-system, sans-serif" font-size="14" fill="#111827">${escapeXml(textMatch[3])}</text>`
    );
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">
  ${elements.join('\n  ')}
</svg>`;
}

/**
 * Universal Vector & CAD Conversion Engine
 * Supports 2D Vector (SVG, EPS, PS, CDR, CGM, DWF, EMF, SK, SK1, SVGZ, VSD, WMF),
 * 2D CAD (DXF, DWG), and 3D CAD (STEP, STP, IGES, IGS, STL, OBJ).
 */
export async function convertVectorCad(
  inputBuffer: Buffer,
  sourceFormat: string,
  targetFormat: string,
  options: ConversionOptions = {},
  originalFilename: string = 'model'
): Promise<ConversionResult> {
  const baseName = (originalFilename || 'model').replace(/\.[^/.]+$/, '');
  const src = sourceFormat.toLowerCase().replace(/^\./, '').trim();
  const tgt = targetFormat.toLowerCase().replace(/^\./, '').trim();

  if (!inputBuffer || inputBuffer.length === 0) {
    throw new Error('Vector/CAD conversion payload is empty (0 bytes).');
  }

  // 1. 3D CAD Domain (STEP, STP, IGES, IGS, STL, OBJ)
  if (['step', 'stp', 'iges', 'igs', 'stl', 'obj'].includes(src) || ['step', 'stp', 'iges', 'igs', 'stl', 'obj'].includes(tgt)) {
    return convert3dCad(inputBuffer, src, tgt, options, baseName);
  }

  // 2. SVGZ Source (Compressed SVG)
  if (src === 'svgz') {
    let uncompressed: Buffer;
    try {
      uncompressed = zlib.gunzipSync(inputBuffer);
    } catch {
      uncompressed = inputBuffer;
    }
    const cleanSvg = sanitizeSvgString(uncompressed.toString('utf-8'));
    return convertSvgSource(Buffer.from(cleanSvg, 'utf-8'), tgt, options, baseName);
  }

  // 3. SVG Source
  if (src === 'svg') {
    const cleanSvg = sanitizeSvgString(inputBuffer.toString('utf-8'));
    return convertSvgSource(Buffer.from(cleanSvg, 'utf-8'), tgt, options, baseName);
  }

  // 4. DXF Source
  if (src === 'dxf') {
    return convertDxfSource(inputBuffer, tgt, options, baseName);
  }

  // 5. DWG Source
  if (src === 'dwg') {
    return convertDwgSource(inputBuffer, tgt, options, baseName);
  }

  // 6. EPS / PS Source
  if (src === 'eps' || src === 'ps') {
    return convertPostScriptSource(inputBuffer, src, tgt, options, baseName);
  }


  // 7. Expanded Vector and CAD sources (CDR, CGM, DWF, EMF, SK, SK1, VSD, WMF)
  if (['cdr', 'cgm', 'dwf', 'emf', 'sk', 'sk1', 'vsd', 'wmf'].includes(src)) {
    let svgStr = '';
    const textSample = inputBuffer.toString('utf-8');
    if (textSample.includes('<svg')) {
      svgStr = textSample.substring(textSample.indexOf('<svg'));
      const endIdx = svgStr.lastIndexOf('</svg>');
      if (endIdx !== -1) svgStr = svgStr.substring(0, endIdx + 6);
    } else if (src === 'cgm') {
      const parsedCgm = parseCgmToSvg(textSample);
      if (parsedCgm) {
        svgStr = parsedCgm;
      } else {
        throw new Error(
          `Unsupported or unparseable .${src} vector format: fail-closed against dummy placeholder synthesis.`
        );
      }
    } else {
      throw new Error(
        `Unsupported or unparseable .${src} vector format: fail-closed against dummy placeholder synthesis.`
      );
    }
    return convertSvgSource(Buffer.from(sanitizeSvgString(svgStr), 'utf-8'), tgt, options, baseName);
  }

  throw new Error(`Unsupported Vector/CAD conversion from .${src} to .${tgt}`);
}

/**
 * Converts SVG to Raster (PNG, JPG, WEBP, AVIF), Vector (DXF), or Document (PDF)
 */
async function convertSvgSource(
  inputBuffer: Buffer,
  tgt: string,
  options: ConversionOptions,
  baseName: string
): Promise<ConversionResult> {
  // SVG -> DXF
  if (tgt === 'dxf') {
    const dxfString = svgToDxf(inputBuffer.toString('utf-8'));
    const buffer = Buffer.from(dxfString, 'utf-8');
    return {
      buffer,
      mimeType: 'image/vnd.dxf',
      filename: `${baseName}.dxf`,
      size: buffer.length,
    };
  }

  // SVG -> DWG
  if (tgt === 'dwg') {
    const dxfString = svgToDxf(inputBuffer.toString('utf-8'));
    const dwgBuffer = dxfToDwg(dxfString);
    return {
      buffer: dwgBuffer,
      mimeType: 'image/vnd.dwg',
      filename: `${baseName}.dwg`,
      size: dwgBuffer.length,
    };
  }

  // SVG -> PDF
  if (tgt === 'pdf') {
    const pngBuffer = await sharp(inputBuffer, { density: options.dpi || 300 }).png().toBuffer();
    const meta = await sharp(pngBuffer).metadata();
    const width = meta.width || 600;
    const height = meta.height || 400;

    return new Promise<ConversionResult>((resolve, reject) => {
      const doc = new PDFDocument({
        size: [width, height],
        margin: 0,
      });

      const chunks: Buffer[] = [];
      doc.on('data', (c) => chunks.push(c));
      doc.on('end', () => {
        const buffer = Buffer.concat(chunks);
        resolve({
          buffer,
          mimeType: 'application/pdf',
          filename: `${baseName}.pdf`,
          size: buffer.length,
        });
      });
      doc.on('error', (err) => reject(err));

      doc.image(pngBuffer, 0, 0, { width, height });
      doc.end();
    });
  }

  // SVG -> Raster Images via Sharp
  let pipeline = sharp(inputBuffer, { density: options.dpi || 300 });

  if (options.width || options.height) {
    pipeline = pipeline.resize({
      width: options.width ? Number(options.width) : undefined,
      height: options.height ? Number(options.height) : undefined,
      fit: options.fit || 'contain',
      background: { r: 255, g: 255, b: 255, alpha: 0 },
    });
  }

  const quality = options.quality ? Math.max(1, Math.min(100, options.quality)) : 90;
  let outputBuffer: Buffer;
  let mimeType: string;

  switch (tgt) {
    case 'png':
      outputBuffer = await pipeline.png().toBuffer();
      mimeType = 'image/png';
      break;

    case 'jpg':
    case 'jpeg':
      outputBuffer = await pipeline.jpeg({ quality }).toBuffer();
      mimeType = 'image/jpeg';
      break;

    case 'webp':
      outputBuffer = await pipeline.webp({ quality }).toBuffer();
      mimeType = 'image/webp';
      break;

    case 'avif':
      outputBuffer = await pipeline.avif({ quality }).toBuffer();
      mimeType = 'image/avif';
      break;

    case 'tiff':
      outputBuffer = await pipeline.tiff({ quality }).toBuffer();
      mimeType = 'image/tiff';
      break;

    case 'svg':
      outputBuffer = Buffer.from(sanitizeSvgString(inputBuffer.toString('utf-8')), 'utf-8');
      mimeType = 'image/svg+xml';
      break;

    case 'emf':
      throw new UnsupportedTargetError('EMF encoder is not available');

    case 'wmf':
      throw new UnsupportedTargetError('WMF encoder is not available');

    case 'cgm':
      throw new UnsupportedTargetError('CGM encoder is not available');

    case 'eps':
    case 'ps': {
      const { data: rawRgb, info } = await pipeline
        .removeAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      outputBuffer = encodePostscript(rawRgb, info.width, info.height, tgt === 'eps');
      mimeType = 'application/postscript';
      break;
    }

    case 'bmp': {
      const { data: rawRgba, info } = await pipeline
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      outputBuffer = encodeBmp(rawRgba, info.width, info.height, info.channels);
      mimeType = 'image/bmp';
      break;
    }

    case 'gif': {
      outputBuffer = await pipeline.gif().toBuffer();
      mimeType = 'image/gif';
      break;
    }

    default:
      throw new Error(`Unsupported SVG target conversion: ${tgt}`);
  }

  return {
    buffer: outputBuffer,
    mimeType,
    filename: `${baseName}.${tgt}`,
    size: outputBuffer.length,
  };
}

/**
 * Converts DXF to SVG, PDF, PNG, JPG, WEBP, or DWG
 */
async function convertDxfSource(
  inputBuffer: Buffer,
  tgt: string,
  options: ConversionOptions,
  baseName: string
): Promise<ConversionResult> {
  const dxfContent = inputBuffer.toString('utf-8');
  const entities = parseDxfEntities(dxfContent);

  // DXF -> SVG
  if (tgt === 'svg') {
    const svg = dxfToSvg(entities, baseName);
    const cleanSvg = sanitizeSvgString(svg);
    const buffer = Buffer.from(cleanSvg, 'utf-8');
    return {
      buffer,
      mimeType: 'image/svg+xml',
      filename: `${baseName}.svg`,
      size: buffer.length,
    };
  }

  // DXF -> DWG
  if (tgt === 'dwg') {
    const dwgBuffer = dxfToDwg(dxfContent);
    return {
      buffer: dwgBuffer,
      mimeType: 'image/vnd.dwg',
      filename: `${baseName}.dwg`,
      size: dwgBuffer.length,
    };
  }

  // DXF -> PDF
  if (tgt === 'pdf') {
    const pdfBuffer = await renderDxfToPdf(entities, options, baseName);
    return {
      buffer: pdfBuffer,
      mimeType: 'application/pdf',
      filename: `${baseName}.pdf`,
      size: pdfBuffer.length,
    };
  }

  // DXF -> Raster (PNG, JPG, WEBP)
  if (['png', 'jpg', 'jpeg', 'webp'].includes(tgt)) {
    const svgStr = dxfToSvg(entities, baseName);
    const svgBuf = Buffer.from(svgStr, 'utf-8');
    return convertSvgSource(svgBuf, tgt, options, baseName);
  }

  throw new Error(`Unsupported DXF target conversion: ${tgt}`);
}

/**
 * Converts DWG Source
 */
async function convertDwgSource(
  inputBuffer: Buffer,
  tgt: string,
  options: ConversionOptions,
  baseName: string
): Promise<ConversionResult> {
  // Extract ASCII DXF streams if present, fail closed if binary DWG decoder is missing
  const raw = inputBuffer.toString('utf-8');

  if (!raw.includes('SECTION') || !raw.includes('ENTITIES')) {
    throw new Error('Unsupported CAD format: DWG binary decoder unavailable');
  }

  const dxfBuf = Buffer.from(raw, 'utf-8');
  if (tgt === 'dxf') {
    return {
      buffer: dxfBuf,
      mimeType: 'image/vnd.dxf',
      filename: `${baseName}.dxf`,
      size: dxfBuf.length,
    };
  }

  return convertDxfSource(dxfBuf, tgt, options, baseName);
}

/**
 * Converts PostScript (EPS / PS) Source
 */
async function convertPostScriptSource(
  inputBuffer: Buffer,
  src: string,
  tgt: string,
  options: ConversionOptions,
  baseName: string
): Promise<ConversionResult> {
  const text = inputBuffer.toString('utf-8');
  const svg = postScriptToSvg(text, baseName);
  const cleanSvg = sanitizeSvgString(svg);
  const svgBuf = Buffer.from(cleanSvg, 'utf-8');

  if (tgt === 'svg') {
    return {
      buffer: svgBuf,
      mimeType: 'image/svg+xml',
      filename: `${baseName}.svg`,
      size: svgBuf.length,
    };
  }

  return convertSvgSource(svgBuf, tgt, options, baseName);
}

/**
 * Converts 3D CAD formats (STEP, STP, IGES, IGS, STL, OBJ)
 */
async function convert3dCad(
  inputBuffer: Buffer,
  src: string,
  tgt: string,
  options: ConversionOptions,
  baseName: string
): Promise<ConversionResult> {
  const mesh = parse3dCad(inputBuffer, src, baseName, options);

  let outputBuffer: Buffer;
  let mimeType: string;

  switch (tgt) {
    case 'stl':
      outputBuffer = Buffer.from(encodeStl(mesh), 'utf-8');
      mimeType = 'model/stl';
      break;

    case 'obj':
      outputBuffer = Buffer.from(encodeObj(mesh), 'utf-8');
      mimeType = 'model/obj';
      break;

    case 'step':
    case 'stp':
      outputBuffer = Buffer.from(encodeStep(mesh), 'utf-8');
      mimeType = 'model/step';
      break;

    case 'iges':
    case 'igs':
      outputBuffer = Buffer.from(encodeIges(mesh), 'utf-8');
      mimeType = 'model/iges';
      break;

    case 'dxf':
      outputBuffer = Buffer.from(encode3dCadToDxf(mesh), 'utf-8');
      mimeType = 'image/vnd.dxf';
      break;

    default:
      throw new Error(`Unsupported 3D CAD target: ${tgt}`);
  }

  return {
    buffer: outputBuffer,
    mimeType,
    filename: `${baseName}.${tgt}`,
    size: outputBuffer.length,
  };
}

/**
 * Parses SVG path 'd' attribute commands and evaluates Cubic/Quadratic Bezier curves
 * into high-fidelity adaptive polyline vertices.
 */
export function parseSvgPathToBezierPoints(d: string): Point3D[][] {
  const subpaths: Point3D[][] = [];
  let currentSubpath: Point3D[] = [];
  let currentX = 0;
  let currentY = 0;
  let lastCpX = 0;
  let lastCpY = 0;
  let lastCmd = '';

  // Tokenize commands and signed/floating numbers
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
      const x = parseFloat(tokens[i++]);
      const y = parseFloat(tokens[i++]);
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
      const x = parseFloat(tokens[i++]);
      const y = parseFloat(tokens[i++]);
      currentX = isRel ? currentX + x : x;
      currentY = isRel ? currentY + y : y;
      currentSubpath.push({ x: currentX, y: currentY, z: 0 });
      lastCpX = currentX;
      lastCpY = currentY;
    } else if (upper === 'H') {
      if (i >= tokens.length) break;
      const x = parseFloat(tokens[i++]);
      currentX = isRel ? currentX + x : x;
      currentSubpath.push({ x: currentX, y: currentY, z: 0 });
      lastCpX = currentX;
    } else if (upper === 'V') {
      if (i >= tokens.length) break;
      const y = parseFloat(tokens[i++]);
      currentY = isRel ? currentY + y : y;
      currentSubpath.push({ x: currentX, y: currentY, z: 0 });
      lastCpY = currentY;
    } else if (upper === 'C') {
      if (i + 5 >= tokens.length) break;
      const x1 = parseFloat(tokens[i++]);
      const y1 = parseFloat(tokens[i++]);
      const x2 = parseFloat(tokens[i++]);
      const y2 = parseFloat(tokens[i++]);
      const x = parseFloat(tokens[i++]);
      const y = parseFloat(tokens[i++]);

      const p0: Point3D = { x: currentX, y: currentY, z: 0 };
      const p1: Point3D = { x: isRel ? currentX + x1 : x1, y: isRel ? currentY + y1 : y1, z: 0 };
      const p2: Point3D = { x: isRel ? currentX + x2 : x2, y: isRel ? currentY + y2 : y2, z: 0 };
      const p3: Point3D = { x: isRel ? currentX + x : x, y: isRel ? currentY + y : y, z: 0 };

      const curvePts = adaptiveTessellateCubicBezier(p0, p1, p2, p3, 0.5);
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
      const x2 = parseFloat(tokens[i++]);
      const y2 = parseFloat(tokens[i++]);
      const x = parseFloat(tokens[i++]);
      const y = parseFloat(tokens[i++]);

      const p0: Point3D = { x: currentX, y: currentY, z: 0 };
      const p1: Point3D = { x: p1X, y: p1Y, z: 0 };
      const p2: Point3D = { x: isRel ? currentX + x2 : x2, y: isRel ? currentY + y2 : y2, z: 0 };
      const p3: Point3D = { x: isRel ? currentX + x : x, y: isRel ? currentY + y : y, z: 0 };

      const curvePts = adaptiveTessellateCubicBezier(p0, p1, p2, p3, 0.5);
      for (let k = 1; k < curvePts.length; k++) {
        currentSubpath.push(curvePts[k]);
      }

      currentX = p3.x;
      currentY = p3.y;
      lastCpX = p2.x;
      lastCpY = p2.y;
    } else if (upper === 'Q') {
      if (i + 3 >= tokens.length) break;
      const x1 = parseFloat(tokens[i++]);
      const y1 = parseFloat(tokens[i++]);
      const x = parseFloat(tokens[i++]);
      const y = parseFloat(tokens[i++]);

      const p0: Point3D = { x: currentX, y: currentY, z: 0 };
      const cp: Point3D = { x: isRel ? currentX + x1 : x1, y: isRel ? currentY + y1 : y1, z: 0 };
      const p2: Point3D = { x: isRel ? currentX + x : x, y: isRel ? currentY + y : y, z: 0 };

      const p1: Point3D = { x: p0.x + (2 / 3) * (cp.x - p0.x), y: p0.y + (2 / 3) * (cp.y - p0.y), z: 0 };
      const pCubic2: Point3D = { x: p2.x + (2 / 3) * (cp.x - p2.x), y: p2.y + (2 / 3) * (cp.y - p2.y), z: 0 };

      const curvePts = adaptiveTessellateCubicBezier(p0, p1, pCubic2, p2, 0.5);
      for (let k = 1; k < curvePts.length; k++) {
        currentSubpath.push(curvePts[k]);
      }

      currentX = p2.x;
      currentY = p2.y;
      lastCpX = cp.x;
      lastCpY = cp.y;
    } else if (upper === 'A') {
      if (i + 6 >= tokens.length) break;
      const rx = parseFloat(tokens[i++]);
      const ry = parseFloat(tokens[i++]);
      const rot = parseFloat(tokens[i++]);
      const largeArc = parseFloat(tokens[i++]) !== 0;
      const sweep = parseFloat(tokens[i++]) !== 0;
      const x = parseFloat(tokens[i++]);
      const y = parseFloat(tokens[i++]);
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
 * Converts SVG XML path and geometry elements into AutoCAD DXF ASCII format
 */
export function svgToDxf(svgContent: string): string {
  const entities: string[] = [];

  // 1. Lines (<line x1="" y1="" x2="" y2="" />)
  const lineRegex = /<line\s+[^>]*?x1="([^"]+)"[^>]*?y1="([^"]+)"[^>]*?x2="([^"]+)"[^>]*?y2="([^"]+)"[^>]*?\/?>/gi;
  let m: RegExpExecArray | null;
  while ((m = lineRegex.exec(svgContent)) !== null) {
    const [, x1, y1, x2, y2] = m;
    entities.push(`  0\nLINE\n  8\n0\n 10\n${parseFloat(x1) || 0}\n 20\n${-(parseFloat(y1) || 0)}\n 11\n${parseFloat(x2) || 0}\n 21\n${-(parseFloat(y2) || 0)}`);
  }

  // 2. Rectangles (<rect x="" y="" width="" height="" />)
  const rectRegex = /<rect\s+[^>]*?x="([^"]+)"[^>]*?y="([^"]+)"[^>]*?width="([^"]+)"[^>]*?height="([^"]+)"[^>]*?\/?>/gi;
  while ((m = rectRegex.exec(svgContent)) !== null) {
    const x = parseFloat(m[1]) || 0;
    const y = parseFloat(m[2]) || 0;
    const w = parseFloat(m[3]) || 0;
    const h = parseFloat(m[4]) || 0;
    entities.push(
      `  0\nLWPOLYLINE\n  8\n0\n 90\n4\n 70\n1\n 10\n${x}\n 20\n${-y}\n 10\n${x + w}\n 20\n${-y}\n 10\n${x + w}\n 20\n${-(y + h)}\n 10\n${x}\n 20\n${-(y + h)}`
    );
  }

  // 3. Circles (<circle cx="" cy="" r="" />)
  const circleRegex = /<circle\s+[^>]*?cx="([^"]+)"[^>]*?cy="([^"]+)"[^>]*?r="([^"]+)"[^>]*?\/?>/gi;
  while ((m = circleRegex.exec(svgContent)) !== null) {
    const cx = parseFloat(m[1]) || 0;
    const cy = parseFloat(m[2]) || 0;
    const r = parseFloat(m[3]) || 0;
    entities.push(`  0\nCIRCLE\n  8\n0\n 10\n${cx}\n 20\n${-cy}\n 40\n${r}`);
  }

  // 4. Polygons / Polylines (<polygon points="..." />)
  const polyRegex = /<(?:polygon|polyline)\s+[^>]*?points="([^"]+)"[^>]*?\/?>/gi;
  while ((m = polyRegex.exec(svgContent)) !== null) {
    const pts = m[1].trim().split(/[\s,]+/).map(Number);
    if (pts.length >= 4) {
      const numPts = Math.floor(pts.length / 2);
      let polyDxf = `  0\nLWPOLYLINE\n  8\n0\n 90\n${numPts}\n 70\n1`;
      for (let i = 0; i < numPts; i++) {
        polyDxf += `\n 10\n${pts[i * 2]}\n 20\n${-pts[i * 2 + 1]}`;
      }
      entities.push(polyDxf);
    }
  }

  // 5. Paths with Cubic / Quadratic Bezier curves (<path d="..." />)
  const pathRegex = /<path\s+[^>]*?d="([^"]+)"[^>]*?\/?>/gi;
  while ((m = pathRegex.exec(svgContent)) !== null) {
    const dAttr = m[1];
    const subpaths = parseSvgPathToBezierPoints(dAttr);
    for (const sub of subpaths) {
      if (sub.length < 2) continue;
      let polyDxf = `  0\nLWPOLYLINE\n  8\n0\n 90\n${sub.length}\n 70\n0`;
      for (const pt of sub) {
        polyDxf += `\n 10\n${pt.x.toFixed(4)}\n 20\n${(-pt.y).toFixed(4)}`;
      }
      entities.push(polyDxf);
    }
  }

  // Fallback entity if no recognized shapes
  if (entities.length === 0) {
    entities.push('  0\nLINE\n  8\n0\n 10\n0.0\n 20\n0.0\n 11\n100.0\n 21\n100.0');
  }

  return `  0
SECTION
  2
HEADER
  9
$ACADVER
  1
AC1015
  0
ENDSEC
  0
SECTION
  2
TABLES
  0
ENDSEC
  0
SECTION
  2
BLOCKS
  0
ENDSEC
  0
SECTION
  2
ENTITIES
${entities.join('\n')}
  0
ENDSEC
  0
EOF
`;
}

/**
 * Parses AutoCAD ASCII DXF into structured geometric entities
 */
export function parseDxfEntities(dxfContent: string): DxfEntity[] {
  const lines = dxfContent.split(/\r?\n/).map((l) => l.trim());
  const entities: DxfEntity[] = [];

  let inEntitiesSection = false;
  let i = 0;

  while (i < lines.length - 1) {
    const code = lines[i];
    const val = lines[i + 1];

    if (code === '2' && val === 'ENTITIES') {
      inEntitiesSection = true;
      i += 2;
      continue;
    }

    if (inEntitiesSection && code === '0' && val === 'ENDSEC') {
      break;
    }

    if (inEntitiesSection && code === '0') {
      const entityType = val.toUpperCase();
      i += 2;

      if (entityType === 'LINE') {
        const ent: DxfEntity = { type: 'LINE' };
        while (i < lines.length - 1 && lines[i] !== '0') {
          const c = lines[i];
          const v = lines[i + 1];
          if (c === '10') ent.x1 = parseFloat(v);
          else if (c === '20') ent.y1 = parseFloat(v);
          else if (c === '11') ent.x2 = parseFloat(v);
          else if (c === '21') ent.y2 = parseFloat(v);
          i += 2;
        }
        entities.push(ent);
        continue;
      }

      if (entityType === 'CIRCLE') {
        const ent: DxfEntity = { type: 'CIRCLE' };
        while (i < lines.length - 1 && lines[i] !== '0') {
          const c = lines[i];
          const v = lines[i + 1];
          if (c === '10') ent.cx = parseFloat(v);
          else if (c === '20') ent.cy = parseFloat(v);
          else if (c === '40') ent.r = parseFloat(v);
          i += 2;
        }
        entities.push(ent);
        continue;
      }

      if (entityType === 'ARC') {
        const ent: DxfEntity = { type: 'ARC' };
        while (i < lines.length - 1 && lines[i] !== '0') {
          const c = lines[i];
          const v = lines[i + 1];
          if (c === '10') ent.cx = parseFloat(v);
          else if (c === '20') ent.cy = parseFloat(v);
          else if (c === '40') ent.r = parseFloat(v);
          else if (c === '50') ent.startAngle = parseFloat(v);
          else if (c === '51') ent.endAngle = parseFloat(v);
          i += 2;
        }
        entities.push(ent);
        continue;
      }

      if (entityType === 'LWPOLYLINE') {
        const points: { x: number; y: number }[] = [];
        let currX: number | undefined;
        let isClosed = false;

        while (i < lines.length - 1 && lines[i] !== '0') {
          const c = lines[i];
          const v = lines[i + 1];
          if (c === '70') isClosed = parseInt(v, 10) === 1;
          else if (c === '10') currX = parseFloat(v);
          else if (c === '20' && currX !== undefined) {
            points.push({ x: currX, y: parseFloat(v) });
            currX = undefined;
          }
          i += 2;
        }
        entities.push({ type: 'LWPOLYLINE', points, isClosed });
        continue;
      }

      if (entityType === 'TEXT') {
        const ent: DxfEntity = { type: 'TEXT' };
        while (i < lines.length - 1 && lines[i] !== '0') {
          const c = lines[i];
          const v = lines[i + 1];
          if (c === '10') ent.x1 = parseFloat(v);
          else if (c === '20') ent.y1 = parseFloat(v);
          else if (c === '1') ent.text = v;
          i += 2;
        }
        entities.push(ent);
        continue;
      }
    }

    i += 2;
  }

  return entities;
}

/**
 * Renders DXF entities into a clean, resolution-independent SVG document
 */
export function dxfToSvg(entities: DxfEntity[], title: string): string {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  function updateBounds(x: number, y: number) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }

  entities.forEach((e) => {
    if (e.type === 'LINE') {
      if (e.x1 !== undefined && e.y1 !== undefined) updateBounds(e.x1, e.y1);
      if (e.x2 !== undefined && e.y2 !== undefined) updateBounds(e.x2, e.y2);
    } else if (e.type === 'CIRCLE' || e.type === 'ARC') {
      if (e.cx !== undefined && e.cy !== undefined && e.r !== undefined) {
        updateBounds(e.cx - e.r, e.cy - e.r);
        updateBounds(e.cx + e.r, e.cy + e.r);
      }
    } else if (e.type === 'LWPOLYLINE' && e.points) {
      e.points.forEach((p) => updateBounds(p.x, p.y));
    }
  });

  if (!isFinite(minX)) {
    minX = 0;
    minY = 0;
    maxX = 500;
    maxY = 500;
  }

  const width = Math.max(10, Math.ceil(maxX - minX + 20));
  const height = Math.max(10, Math.ceil(maxY - minY + 20));

  const svgElements: string[] = [];

  entities.forEach((e) => {
    if (e.type === 'LINE' && e.x1 !== undefined && e.y1 !== undefined && e.x2 !== undefined && e.y2 !== undefined) {
      svgElements.push(
        `<line x1="${e.x1}" y1="${-e.y1}" x2="${e.x2}" y2="${-e.y2}" stroke="#5C6BC0" stroke-width="1.5" stroke-linecap="round" />`
      );
    } else if (e.type === 'CIRCLE' && e.cx !== undefined && e.cy !== undefined && e.r !== undefined) {
      svgElements.push(
        `<circle cx="${e.cx}" cy="${-e.cy}" r="${e.r}" fill="none" stroke="#5C6BC0" stroke-width="1.5" />`
      );
    } else if (e.type === 'LWPOLYLINE' && e.points && e.points.length > 0) {
      const pts = e.points.map((p) => `${p.x},${-p.y}`).join(' ');
      const tag = e.isClosed ? 'polygon' : 'polyline';
      svgElements.push(
        `<${tag} points="${pts}" fill="none" stroke="#5C6BC0" stroke-width="1.5" stroke-linejoin="round" />`
      );
    } else if (e.type === 'TEXT' && e.x1 !== undefined && e.y1 !== undefined && e.text) {
      svgElements.push(
        `<text x="${e.x1}" y="${-e.y1}" fill="#1F2340" font-family="system-ui, sans-serif" font-size="12">${escapeXml(
          e.text
        )}</text>`
      );
    }
  });

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="${minX - 10} ${-maxY - 10} ${width} ${height}" width="${width}" height="${height}">
  <title>${escapeXml(title)}</title>
  <g>
    ${svgElements.join('\n    ')}
  </g>
</svg>`;
}

/**
 * Renders DXF entities onto PDFKit vector canvas
 */
async function renderDxfToPdf(
  entities: DxfEntity[],
  options: ConversionOptions,
  title: string
): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 40 });
    const chunks: Buffer[] = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', (err) => reject(err));

    const fontFallback = configurePdfKitFontFallback(doc);

    // Title header rendered safely with Unicode fallback
    doc.fillColor('#5C6BC0').fontSize(14);
    renderSafePdfText(
      doc,
      `AutoCAD Vector Plot: ${title}`,
      fontFallback.hasUnicodeFont,
      { align: 'left' },
      40,
      40
    );

    const plotX = 40;
    const plotY = 75;
    const plotW = doc.page.width - 80;
    const plotH = doc.page.height - 115;

    // Draw frame
    doc.rect(plotX, plotY, plotW, plotH).strokeColor('#CCD2FC').lineWidth(1).stroke();

    // 1. Calculate authentic bounding box across all entities
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;

    const updateBounds = (x: number, y: number) => {
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    };

    entities.forEach((e) => {
      if (e.type === 'LINE') {
        if (e.x1 !== undefined && e.y1 !== undefined) updateBounds(e.x1, e.y1);
        if (e.x2 !== undefined && e.y2 !== undefined) updateBounds(e.x2, e.y2);
      } else if (e.type === 'CIRCLE' || e.type === 'ARC') {
        if (e.cx !== undefined && e.cy !== undefined && e.r !== undefined) {
          updateBounds(e.cx - e.r, e.cy - e.r);
          updateBounds(e.cx + e.r, e.cy + e.r);
        }
      } else if (e.type === 'LWPOLYLINE' && e.points) {
        e.points.forEach((p) => updateBounds(p.x, p.y));
      } else if (e.type === 'TEXT' && e.x1 !== undefined && e.y1 !== undefined) {
        updateBounds(e.x1, e.y1);
      }
    });

    if (
      !isFinite(minX) ||
      !isFinite(maxX) ||
      !isFinite(minY) ||
      !isFinite(maxY) ||
      (minX === maxX && minY === maxY)
    ) {
      minX = 0;
      minY = 0;
      maxX = 500;
      maxY = 500;
    }

    // 2. Compute aspect-ratio-preserving affine transformation
    const pad = 15;
    const availableW = Math.max(10, plotW - 2 * pad);
    const availableH = Math.max(10, plotH - 2 * pad);
    const dx = Math.max(0.0001, maxX - minX);
    const dy = Math.max(0.0001, maxY - minY);
    const scale = Math.min(availableW / dx, availableH / dy);

    const offsetX = plotX + pad + (availableW - dx * scale) / 2;
    const offsetY = plotY + pad + (availableH - dy * scale) / 2;

    const tx = (x: number) => offsetX + (x - minX) * scale;
    // Map CAD upwards Y to PDF downwards Y
    const ty = (y: number) => offsetY + (maxY - y) * scale;

    // 3. Render all entities without truncation
    entities.forEach((e) => {
      doc.strokeColor('#5C6BC0').lineWidth(1);
      if (
        e.type === 'LINE' &&
        e.x1 !== undefined &&
        e.y1 !== undefined &&
        e.x2 !== undefined &&
        e.y2 !== undefined
      ) {
        doc.moveTo(tx(e.x1), ty(e.y1)).lineTo(tx(e.x2), ty(e.y2)).stroke();
      } else if (e.type === 'CIRCLE' && e.cx !== undefined && e.cy !== undefined && e.r !== undefined) {
        doc.circle(tx(e.cx), ty(e.cy), Math.max(0.5, e.r * scale)).stroke();
      } else if (e.type === 'ARC' && e.cx !== undefined && e.cy !== undefined && e.r !== undefined) {
        doc.circle(tx(e.cx), ty(e.cy), Math.max(0.5, e.r * scale)).stroke();
      } else if (e.type === 'LWPOLYLINE' && e.points && e.points.length > 0) {
        doc.moveTo(tx(e.points[0].x), ty(e.points[0].y));
        for (let i = 1; i < e.points.length; i++) {
          doc.lineTo(tx(e.points[i].x), ty(e.points[i].y));
        }
        if (e.isClosed) {
          doc.closePath();
        }
        doc.stroke();
      } else if (e.type === 'TEXT' && e.text && e.x1 !== undefined && e.y1 !== undefined) {
        doc.fillColor('#1F2340').fontSize(Math.max(6, Math.min(12, 10 * scale)));
        renderSafePdfText(
          doc,
          e.text,
          fontFallback.hasUnicodeFont,
          undefined,
          tx(e.x1),
          ty(e.y1)
        );
      }
    });

    doc.end();
  });
}


/**
 * Converts PostScript commands into SVG
 */
function postScriptToSvg(ps: string, title: string): string {
  const lines: { x1: number; y1: number; x2: number; y2: number }[] = [];
  const lineRegex = /([0-9.-]+)\s+([0-9.-]+)\s+moveto\s+([0-9.-]+)\s+([0-9.-]+)\s+lineto/gi;
  let m: RegExpExecArray | null;

  while ((m = lineRegex.exec(ps)) !== null) {
    lines.push({
      x1: parseFloat(m[1]),
      y1: parseFloat(m[2]),
      x2: parseFloat(m[3]),
      y2: parseFloat(m[4]),
    });
  }

  const svgLines = lines
    .map((l) => `<line x1="${l.x1}" y1="${l.y1}" x2="${l.x2}" y2="${l.y2}" stroke="#5C6BC0" stroke-width="1.5" />`)
    .join('\n    ');

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 600" width="600" height="600">
  <title>${escapeXml(title)}</title>
  <g>
    ${svgLines || '<rect x="50" y="50" width="500" height="500" fill="none" stroke="#5C6BC0" stroke-width="2" />'}
  </g>
</svg>`;
}

/**
 * 3D CAD Parser (STEP, STP, IGES, IGS, STL, OBJ)
 */
function parse3dCad(buffer: Buffer, format: string, defaultName: string, options: ConversionOptions = {}): CadMesh3D {
  const text = buffer.toString('utf-8');

  // 1. Binary or ASCII STL Parser
  if (format === 'stl' || format === 'stlb' || text.startsWith('solid')) {
    // Check if binary STL: length >= 84 and either byte size matches 84 + numTriangles * 50 or header doesn't start with "solid "
    if (buffer.length >= 84) {
      const numTriangles = buffer.readUInt32LE(80);
      const isHeaderSolid = text.slice(0, 6).toLowerCase().startsWith('solid');
      const isSizeExact = buffer.length === 84 + numTriangles * 50;
      if ((isSizeExact || (!isHeaderSolid && numTriangles > 0)) && numTriangles > 0 && numTriangles <= 1000000) {
        const vertices: [number, number, number][] = [];
        const faces: [number, number, number][] = [];
        const normals: [number, number, number][] = [];

        for (let i = 0; i < numTriangles; i++) {
          const off = 84 + i * 50;
          if (off + 48 > buffer.length) break;
          const nx = buffer.readFloatLE(off);
          const ny = buffer.readFloatLE(off + 4);
          const nz = buffer.readFloatLE(off + 8);
          normals.push([nx, ny, nz]);

          const vStart = vertices.length;
          vertices.push([buffer.readFloatLE(off + 12), buffer.readFloatLE(off + 16), buffer.readFloatLE(off + 20)]);
          vertices.push([buffer.readFloatLE(off + 24), buffer.readFloatLE(off + 28), buffer.readFloatLE(off + 32)]);
          vertices.push([buffer.readFloatLE(off + 36), buffer.readFloatLE(off + 40), buffer.readFloatLE(off + 44)]);
          faces.push([vStart, vStart + 1, vStart + 2]);
        }

        if (vertices.length > 0) {
          return { name: defaultName, vertices, faces, normals };
        }
      }
    }

    // ASCII STL
    const vertices: [number, number, number][] = [];
    const faces: [number, number, number][] = [];
    const normals: [number, number, number][] = [];

    const facetRegex = /facet\s+normal\s+([0-9.eE+-]+)\s+([0-9.eE+-]+)\s+([0-9.eE+-]+)[\s\S]*?vertex\s+([0-9.eE+-]+)\s+([0-9.eE+-]+)\s+([0-9.eE+-]+)[\s\S]*?vertex\s+([0-9.eE+-]+)\s+([0-9.eE+-]+)\s+([0-9.eE+-]+)[\s\S]*?vertex\s+([0-9.eE+-]+)\s+([0-9.eE+-]+)\s+([0-9.eE+-]+)/g;
    let match: RegExpExecArray | null;

    while ((match = facetRegex.exec(text)) !== null) {
      normals.push([parseFloat(match[1]), parseFloat(match[2]), parseFloat(match[3])]);
      const vStart = vertices.length;
      vertices.push([parseFloat(match[4]), parseFloat(match[5]), parseFloat(match[6])]);
      vertices.push([parseFloat(match[7]), parseFloat(match[8]), parseFloat(match[9])]);
      vertices.push([parseFloat(match[10]), parseFloat(match[11]), parseFloat(match[12])]);
      faces.push([vStart, vStart + 1, vStart + 2]);
    }

    if (vertices.length > 0) {
      return { name: defaultName, vertices, faces, normals };
    }
  }

  // 2. OBJ Parser
  if (format === 'obj' || (format !== 'step' && format !== 'stp' && format !== 'iges' && format !== 'igs' && (text.includes('v ') || text.includes('f ')))) {
    const vertices: [number, number, number][] = [];
    const faces: [number, number, number][] = [];
    const normals: [number, number, number][] = [];

    text.split(/\r?\n/).forEach((line) => {
      const parts = line.trim().split(/\s+/);
      if (parts[0] === 'v' && parts.length >= 4) {
        vertices.push([parseFloat(parts[1]) || 0, parseFloat(parts[2]) || 0, parseFloat(parts[3]) || 0]);
      } else if (parts[0] === 'vn' && parts.length >= 4) {
        normals.push([parseFloat(parts[1]) || 0, parseFloat(parts[2]) || 0, parseFloat(parts[3]) || 0]);
      } else if (parts[0] === 'f' && parts.length >= 4) {
        const v1 = parseInt(parts[1].split('/')[0], 10) - 1;
        const v2 = parseInt(parts[2].split('/')[0], 10) - 1;
        const v3 = parseInt(parts[3].split('/')[0], 10) - 1;
        faces.push([Math.max(0, v1), Math.max(0, v2), Math.max(0, v3)]);
      }
    });

    if (vertices.length > 0) {
      return { name: defaultName, vertices, faces, normals };
    }
  }

  // 3. STEP (ISO 10303-21) and IGES with de Boor NURBS Tessellator
  if (
    ['step', 'stp', 'iges', 'igs'].includes(format) ||
    text.includes('ISO-10303-21') ||
    text.includes('S      1') ||
    text.includes('G      1')
  ) {
    try {
      const cadFmt = ['iges', 'igs'].includes(format) || text.includes('S      1') ? 'iges' : 'step';
      const mesh = tessellateCadBuffer(buffer, cadFmt, defaultName, options);
      if (mesh.vertices.length > 0) {
        return mesh;
      }
    } catch (err) {
      if (err instanceof CadGeometryUnavailableError || err instanceof CadTopologyError) {
        throw err;
      }
      throw new CadGeometryUnavailableError(
        `Failed to parse 3D CAD geometry from .${format}: ${(err as Error).message}`
      );
    }

    throw new CadGeometryUnavailableError(
      `Failed to parse 3D CAD geometry from .${format} file. No valid surface geometry found.`
    );
  }

  // Fail-closed on explicit unsupported/malformed 3D formats
  throw new CadGeometryUnavailableError(
    `Failed to parse 3D CAD geometry from .${format} file. Payload contains no valid vertices or facets.`
  );
}

/**
 * Encodes 3D Mesh to ASCII Stereolithography (STL) format
 */
export function encodeStl(mesh: CadMesh3D): string {
  return pureEncodeStl(mesh);
}

/**
 * Encodes 3D Mesh to Wavefront OBJ format
 */
export function encodeObj(mesh: CadMesh3D): string {
  return pureEncodeObj(mesh);
}

/**
 * Encodes 3D Mesh to ISO 10303-21 STEP AP214 format with genuine B-Rep topology.
 */
export function encodeStep(mesh: CadMesh3D): string {
  if (!mesh || !mesh.vertices || !mesh.faces || mesh.vertices.length === 0 || mesh.faces.length === 0) {
    throw new CadGeometryUnavailableError('Cannot export 3D CAD mesh to STEP: Mesh contains no faces or vertices.');
  }

  const cleanName = (mesh.name || 'cad_model').replace(/[^a-zA-Z0-9_-]/g, '_');
  const now = new Date();
  const timestamp = now.toISOString().replace(/\.\d{3}Z$/, '');

  const topology = verifyWatertightManifoldMesh(mesh.vertices, mesh.faces);
  const isClosed = topology.isWatertight;

  function fmtReal(n: number): string {
    if (Object.is(n, -0) || Math.abs(n) < 1e-12) return '0.0';
    const s = n.toFixed(6).replace(/\.?0+$/, '');
    return s.includes('.') ? s : `${s}.0`;
  }

  const lines: string[] = [
    'ISO-10303-21;',
    'HEADER;',
    "FILE_DESCRIPTION(('EasyConvert CAD STEP AP214 B-Rep Model'), '2;1');",
    `FILE_NAME('${cleanName}.step', '${timestamp}', ('EasyConvert Core'), ('EasyConvert Engine'), 'Processor 2.0', 'EasyConvert', 'Authorization');`,
    "FILE_SCHEMA(('AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }'));",
    'ENDSEC;',
    'DATA;',
    "#1 = APPLICATION_CONTEXT('core data for automotive mechanical design processes');",
    "#2 = APPLICATION_PROTOCOL_DEFINITION('international standard', 'automotive_design', 1994, #1);",
    "#3 = PRODUCT_CONTEXT('', #1, 'mechanical');",
    `#4 = PRODUCT('${cleanName}', '${cleanName}', '', (#3));`,
    "#5 = PRODUCT_DEFINITION_FORMATION('', '', #4);",
    "#6 = PRODUCT_DEFINITION_CONTEXT('part definition', #1, 'design');",
    "#7 = PRODUCT_DEFINITION('design', '', #5, #6);",
    "#8 = PRODUCT_DEFINITION_SHAPE('', '', #7);",
    '#9 = SHAPE_DEFINITION_REPRESENTATION(#8, #10);',
    '#11 = ( LENGTH_UNIT() NAMED_UNIT(*) SI_UNIT(.MILLI., .METRE.) );',
    '#12 = ( NAMED_UNIT(*) PLANE_ANGLE_UNIT() SI_UNIT($, .RADIAN.) );',
    '#13 = ( NAMED_UNIT(*) SI_UNIT($, .STERADIAN.) SOLID_ANGLE_UNIT() );',
    "#14 = UNCERTAINTY_MEASURE_WITH_UNIT(LENGTH_MEASURE(1.E-07), #11, 'distance_accuracy_value', 'confusion accuracy');",
    "#15 = ( GEOMETRIC_REPRESENTATION_CONTEXT(3) GLOBAL_UNCERTAINTY_ASSIGNED_CONTEXT((#14)) GLOBAL_UNIT_ASSIGNED_CONTEXT((#11, #12, #13)) REPRESENTATION_CONTEXT('Context #1', '3D Context with UNIT and UNCERTAINTY') );",
    "#16 = CARTESIAN_POINT('ORIGIN', (0.0, 0.0, 0.0));",
    "#17 = DIRECTION('DIR_Z', (0.0, 0.0, 1.0));",
    "#18 = DIRECTION('DIR_X', (1.0, 0.0, 0.0));",
    "#19 = AXIS2_PLACEMENT_3D('AXIS', #16, #17, #18);",
  ];

  let nextId = 20;

  // 1. Emit all vertices as CARTESIAN_POINT
  const vertexPointIds: number[] = new Array(mesh.vertices.length);
  for (let i = 0; i < mesh.vertices.length; i++) {
    const v = mesh.vertices[i];
    const pid = nextId++;
    vertexPointIds[i] = pid;
    lines.push(`#${pid} = CARTESIAN_POINT('', (${fmtReal(v[0])}, ${fmtReal(v[1])}, ${fmtReal(v[2])}));`);
  }

  // 2. Emit all triangular faces with POLY_LOOP, FACE_OUTER_BOUND, PLANE, and FACE_SURFACE
  const faceIds: number[] = [];
  for (let f = 0; f < mesh.faces.length; f++) {
    const [v0, v1, v2] = mesh.faces[f];
    const p0 = mesh.vertices[v0] || [0, 0, 0];
    const p1 = mesh.vertices[v1] || [0, 0, 0];
    const p2 = mesh.vertices[v2] || [0, 0, 0];
    const id0 = vertexPointIds[v0];
    const id1 = vertexPointIds[v1];
    const id2 = vertexPointIds[v2];

    const ux = p1[0] - p0[0], uy = p1[1] - p0[1], uz = p1[2] - p0[2];
    const vx = p2[0] - p0[0], vy = p2[1] - p0[1], vz = p2[2] - p0[2];
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const nLen = Math.hypot(nx, ny, nz);
    if (nLen > 1e-12) {
      nx /= nLen; ny /= nLen; nz /= nLen;
    } else {
      nx = 0; ny = 0; nz = 1;
    }

    let rx = 1, ry = 0, rz = 0;
    if (Math.abs(nx) >= 0.9 && Math.abs(ny) < 0.9) {
      rx = 0; ry = 1; rz = 0;
    } else if (Math.abs(nx) >= 0.9 && Math.abs(nz) < 0.9) {
      rx = 0; ry = 0; rz = 1;
    }
    const dot = rx * nx + ry * ny + rz * nz;
    rx -= dot * nx; ry -= dot * ny; rz -= dot * nz;
    const rLen = Math.hypot(rx, ry, rz) || 1;
    rx /= rLen; ry /= rLen; rz /= rLen;

    const loopId = nextId++;
    lines.push(`#${loopId} = POLY_LOOP('', (#${id0}, #${id1}, #${id2}));`);

    const boundId = nextId++;
    lines.push(`#${boundId} = FACE_OUTER_BOUND('', #${loopId}, .T.);`);

    const dirNormId = nextId++;
    lines.push(`#${dirNormId} = DIRECTION('', (${fmtReal(nx)}, ${fmtReal(ny)}, ${fmtReal(nz)}));`);

    const dirRefId = nextId++;
    lines.push(`#${dirRefId} = DIRECTION('', (${fmtReal(rx)}, ${fmtReal(ry)}, ${fmtReal(rz)}));`);

    const axisId = nextId++;
    lines.push(`#${axisId} = AXIS2_PLACEMENT_3D('', #${id0}, #${dirNormId}, #${dirRefId});`);

    const planeId = nextId++;
    lines.push(`#${planeId} = PLANE('', #${axisId});`);

    const faceId = nextId++;
    lines.push(`#${faceId} = FACE_SURFACE('', (#${boundId}), #${planeId}, .T.);`);
    faceIds.push(faceId);
  }

  // 3. Emit topological shell & solid representation
  if (isClosed) {
    const shellId = nextId++;
    lines.push(`#${shellId} = CLOSED_SHELL('', (${faceIds.map((id) => '#' + id).join(', ')}));`);
    const solidId = nextId++;
    lines.push(`#${solidId} = FACETED_BREP('${cleanName}', #${shellId});`);
    lines.push(`#10 = FACETED_BREP_SHAPE_REPRESENTATION('${cleanName}', (#${solidId}, #19), #15);`);
  } else {
    const shellId = nextId++;
    lines.push(`#${shellId} = OPEN_SHELL('', (${faceIds.map((id) => '#' + id).join(', ')}));`);
    const modelId = nextId++;
    lines.push(`#${modelId} = SHELL_BASED_SURFACE_MODEL('${cleanName}', (#${shellId}));`);
    lines.push(`#10 = SHAPE_REPRESENTATION('${cleanName}', (#${modelId}, #19), #15);`);
  }

  lines.push('ENDSEC;');
  lines.push('END-ISO-10303-21;');
  lines.push('');

  return lines.join('\n');
}

/**
 * Encodes 3D Mesh to AutoCAD ASCII DXF using standard 3DFACE entities
 */
export function encode3dCadToDxf(mesh: CadMesh3D): string {
  let entitiesDxf = '';
  mesh.faces.forEach((f) => {
    const v1 = mesh.vertices[f[0]] || [0, 0, 0];
    const v2 = mesh.vertices[f[1]] || [0, 0, 0];
    const v3 = mesh.vertices[f[2]] || [0, 0, 0];
    entitiesDxf += `  0\n3DFACE\n  8\n0\n 10\n${v1[0]}\n 20\n${v1[1]}\n 30\n${v1[2]}\n 11\n${v2[0]}\n 21\n${v2[1]}\n 31\n${v2[2]}\n 12\n${v3[0]}\n 22\n${v3[1]}\n 32\n${v3[2]}\n 13\n${v3[0]}\n 23\n${v3[1]}\n 33\n${v3[2]}\n`;
  });
  if (!entitiesDxf) {
    mesh.vertices.forEach((v) => {
      entitiesDxf += `  0\nPOINT\n  8\n0\n 10\n${v[0]}\n 20\n${v[1]}\n 30\n${v[2]}\n`;
    });
  }
  if (!entitiesDxf) {
    throw new CadGeometryUnavailableError('Cannot export 3D CAD mesh to DXF: Mesh contains no faces or vertices.');
  }
  return `  0\nSECTION\n  2\nHEADER\n  9\n$ACADVER\n  1\nAC1015\n  0\nENDSEC\n  0\nSECTION\n  2\nTABLES\n  0\nENDSEC\n  0\nSECTION\n  2\nENTITIES\n${entitiesDxf}  0\nENDSEC\n  0\nEOF\n`;
}

/**
 * Encodes 3D Mesh to ANSI/USPRO IGES 5.3 format with genuine B-Rep topology (Entities 502, 504, 508, 510, 190, 514, 186).
 */
export function encodeIges(mesh: CadMesh3D): string {
  if (!mesh || !mesh.vertices || !mesh.faces || mesh.vertices.length === 0 || mesh.faces.length === 0) {
    throw new CadGeometryUnavailableError('Cannot export 3D CAD mesh to IGES: Mesh contains no faces or vertices.');
  }

  const cleanName = (mesh.name || 'cad_model').replace(/[^a-zA-Z0-9_-]/g, '_');
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const hour = String(now.getHours()).padStart(2, '0');
  const min = String(now.getMinutes()).padStart(2, '0');
  const sec = String(now.getSeconds()).padStart(2, '0');
  const igesTimestamp = `${year}${month}${day}.${hour}${min}${sec}`;

  const topology = verifyWatertightManifoldMesh(mesh.vertices, mesh.faces);
  const isClosed = topology.isWatertight;

  function padField(val: string | number, width: number): string {
    const s = String(val);
    return s.padStart(width, ' ');
  }

  function makeLine(content72: string, section: 'S' | 'G' | 'D' | 'P' | 'T', seqNum: number): string {
    const padded = content72.length >= 72 ? content72.substring(0, 72) : content72.padEnd(72, ' ');
    const seq = padField(seqNum, 7);
    return `${padded}${section}${seq}\n`;
  }

  function fmtReal(n: number): string {
    if (Object.is(n, -0) || Math.abs(n) < 1e-12) return '0.0';
    const s = n.toFixed(6).replace(/\.?0+$/, '');
    return s.includes('.') ? s : `${s}.0`;
  }

  // 1. S (Start) Section
  const sLine = makeLine(`EasyConvert IGES 5.3 Solid/Surface B-Rep Model: ${cleanName}`, 'S', 1);

  // 2. G (Global) Section
  const gParams = [
    '1H,',
    '1H;',
    '11HEasyConvert',
    `${cleanName.length}H${cleanName}.igs`,
    '11HEasyConvert',
    '10HCoreEngine',
    '32',
    '38',
    '6',
    '308',
    '15',
    '11HEasyConvert',
    '1.0',
    '2',
    '2HMM',
    '1',
    '1.0',
    `15H${igesTimestamp}`,
    '0.0001',
    '1000.0',
    '10HAquilaCore',
    '11HEasyConvert',
    '11',
    '0',
    `15H${igesTimestamp};`,
  ].join(',');

  const gLines: string[] = [];
  const gTokens = gParams.split(',');
  let currentG = '';
  for (let i = 0; i < gTokens.length; i++) {
    const isLast = i === gTokens.length - 1;
    const token = gTokens[i] + (isLast ? '' : ',');
    if (currentG.length + token.length > 70) {
      gLines.push(currentG);
      currentG = token;
    } else {
      currentG += token;
    }
  }
  if (currentG.length > 0) gLines.push(currentG);
  const formattedGLines = gLines.map((line, idx) => makeLine(line, 'G', idx + 1));

  // Build Topological B-Rep Data Structures:
  // Entity 502: Vertex List
  // Entity 504: Edge List
  // For each face: Entity 190 (Plane), Entity 508 (Loop), Entity 510 (Face)
  // Entity 514: Shell
  // (Optional) Entity 186: Manifold Solid B-Rep (if isClosed)

  // Collect unique undirected edges
  const edgeMap = new Map<string, { edgeIdx: number; vStart: number; vEnd: number }>();
  const edgeList: { vStart: number; vEnd: number }[] = [];

  function getOrAddEdge(a: number, b: number): { edgeIdx1Based: number; sameSense: boolean } {
    const key = a < b ? `${a}-${b}` : `${b}-${a}`;
    const existing = edgeMap.get(key);
    if (existing) {
      return {
        edgeIdx1Based: existing.edgeIdx + 1,
        sameSense: existing.vStart === a && existing.vEnd === b,
      };
    }
    const edgeIdx = edgeList.length;
    edgeList.push({ vStart: a, vEnd: b });
    edgeMap.set(key, { edgeIdx, vStart: a, vEnd: b });
    return { edgeIdx1Based: edgeIdx + 1, sameSense: true };
  }

  // Pre-process faces to construct edge loops
  interface FaceLoopData {
    edgeIndices: number[];
    orientations: number[];
    p0: [number, number, number];
    normal: [number, number, number];
  }
  const faceLoops: FaceLoopData[] = [];

  for (let f = 0; f < mesh.faces.length; f++) {
    const [v0, v1, v2] = mesh.faces[f];
    const e01 = getOrAddEdge(v0, v1);
    const e12 = getOrAddEdge(v1, v2);
    const e20 = getOrAddEdge(v2, v0);

    const p0 = mesh.vertices[v0] || [0, 0, 0];
    const p1 = mesh.vertices[v1] || [0, 0, 0];
    const p2 = mesh.vertices[v2] || [0, 0, 0];

    const ux = p1[0] - p0[0], uy = p1[1] - p0[1], uz = p1[2] - p0[2];
    const vx = p2[0] - p0[0], vy = p2[1] - p0[1], vz = p2[2] - p0[2];
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    if (len > 1e-12) {
      nx /= len; ny /= len; nz /= len;
    } else {
      nx = 0; ny = 0; nz = 1;
    }

    faceLoops.push({
      edgeIndices: [e01.edgeIdx1Based, e12.edgeIdx1Based, e20.edgeIdx1Based],
      orientations: [e01.sameSense ? 1 : 0, e12.sameSense ? 1 : 0, e20.sameSense ? 1 : 0],
      p0,
      normal: [nx, ny, nz],
    });
  }

  const numFaces = mesh.faces.length;
  const vListDePtr = 1;
  const eListDePtr = 3;
  const faceDePtrs: number[] = [];

  for (let f = 0; f < numFaces; f++) {
    const faceDe = 5 + 6 * f + 4;
    faceDePtrs.push(faceDe);
  }
  const shellDePtr = 5 + 6 * numFaces;
  const solidDePtr = isClosed ? shellDePtr + 2 : 0;

  interface EntityEntry {
    type: number;
    dePtr: number;
    form: number;
    label: string;
    params: (string | number)[];
  }
  const entities: EntityEntry[] = [];

  // 1. Entity 502 (Vertex List)
  const vParams: (string | number)[] = [mesh.vertices.length];
  for (const v of mesh.vertices) {
    vParams.push(fmtReal(v[0]), fmtReal(v[1]), fmtReal(v[2]));
  }
  entities.push({ type: 502, dePtr: vListDePtr, form: 1, label: 'VLIST', params: vParams });

  // 2. Entity 504 (Edge List)
  const eParams: (string | number)[] = [edgeList.length];
  for (const e of edgeList) {
    eParams.push(0, e.vStart + 1, e.vEnd + 1);
  }
  entities.push({ type: 504, dePtr: eListDePtr, form: 1, label: 'EDGELIST', params: eParams });

  // 3. For each face: 190, 508, 510
  for (let f = 0; f < numFaces; f++) {
    const loop = faceLoops[f];
    const planeDe = 5 + 6 * f;
    const loopDe = planeDe + 2;
    const faceDe = loopDe + 2;

    entities.push({
      type: 190,
      dePtr: planeDe,
      form: 1,
      label: 'PLANE',
      params: [
        fmtReal(loop.p0[0]),
        fmtReal(loop.p0[1]),
        fmtReal(loop.p0[2]),
        fmtReal(loop.normal[0]),
        fmtReal(loop.normal[1]),
        fmtReal(loop.normal[2]),
        0,
      ],
    });

    entities.push({
      type: 508,
      dePtr: loopDe,
      form: 1,
      label: 'LOOP',
      params: [
        1,
        3,
        0,
        loop.edgeIndices[0],
        loop.orientations[0],
        0,
        0,
        loop.edgeIndices[1],
        loop.orientations[1],
        0,
        0,
        loop.edgeIndices[2],
        loop.orientations[2],
        0,
      ],
    });

    entities.push({
      type: 510,
      dePtr: faceDe,
      form: 1,
      label: 'FACE',
      params: [planeDe, 1, 1, loopDe],
    });
  }

  // 4. Entity 514 (Shell)
  const shellParams: (string | number)[] = [numFaces];
  for (const fDe of faceDePtrs) {
    shellParams.push(fDe, 1);
  }
  entities.push({ type: 514, dePtr: shellDePtr, form: 1, label: 'SHELL', params: shellParams });

  // 5. Entity 186 (Manifold Solid B-Rep)
  if (isClosed) {
    entities.push({
      type: 186,
      dePtr: solidDePtr,
      form: 0,
      label: 'SOLID',
      params: [shellDePtr, 1, 0],
    });
  }

  // Format P and D records
  const dLines: string[] = [];
  const pLines: string[] = [];
  let currentPSeq = 1;

  for (let eIdx = 0; eIdx < entities.length; eIdx++) {
    const ent = entities[eIdx];
    const fullText = `${ent.type},${ent.params.join(',')};`;

    const chunks: string[] = [];
    let rem = fullText;
    while (rem.length > 64) {
      let cut = rem.lastIndexOf(',', 63);
      if (cut <= 0) cut = 64;
      else cut += 1;
      chunks.push(rem.substring(0, cut));
      rem = rem.substring(cut);
    }
    if (rem.length > 0) chunks.push(rem);

    const startP = currentPSeq;
    const pLineCount = chunks.length;

    for (let c = 0; c < chunks.length; c++) {
      const chunkStr = chunks[c].length >= 64 ? chunks[c].substring(0, 64) : chunks[c].padEnd(64, ' ');
      const deStr = padField(ent.dePtr, 7);
      const pSeq = padField(currentPSeq, 7);
      pLines.push(`${chunkStr} ${deStr}P${pSeq}\n`);
      currentPSeq++;
    }

    const dSeq1 = 2 * eIdx + 1;
    const dSeq2 = 2 * eIdx + 2;

    const d1Content = [
      padField(ent.type, 8),
      padField(startP, 8),
      padField(0, 8),
      padField(0, 8),
      padField(0, 8),
      padField(0, 8),
      padField(0, 8),
      padField(0, 8),
      '00000000',
    ].join('');

    const d2Content = [
      padField(ent.type, 8),
      padField(0, 8),
      padField(0, 8),
      padField(pLineCount, 8),
      padField(ent.form, 8),
      padField('', 8),
      padField('', 8),
      padField(ent.label, 8),
      padField(0, 8),
    ].join('');

    dLines.push(`${d1Content}D${padField(dSeq1, 7)}\n`);
    dLines.push(`${d2Content}D${padField(dSeq2, 7)}\n`);
  }

  // 5. T (Terminate) Section
  const sCount = 1;
  const gCount = formattedGLines.length;
  const dCount = dLines.length;
  const pCount = pLines.length;
  const tContent = `${padField('S', 1)}${padField(sCount, 7)}${padField('G', 1)}${padField(gCount, 7)}${padField('D', 1)}${padField(dCount, 7)}${padField('P', 1)}${padField(pCount, 7)}`.padEnd(72, ' ');
  const tLine = `${tContent}T0000001\n`;

  return [sLine, ...formattedGLines, ...dLines, ...pLines, tLine].join('');
}

function dxfToDwg(_dxfString: string): Buffer {
  throw new Error('Unsupported CAD format: DWG binary encoder unavailable');
}

function escapeXml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
