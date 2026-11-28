import sharp, { type ResizeOptions, type Sharp } from 'sharp';
import PDFDocument from 'pdfkit';
import zlib from 'node:zlib';
import { ConversionOptions, ConversionResult, ConversionFailedError, CadGeometryUnavailableError, EngineUnavailableError, PayloadLimitError, UnsupportedTargetError } from '../types';
import { assertOutputPixels, outputSideOf } from './image-limits';
import { AVIF_EFFORT, AVIF_TUNE, convertImage, encodeBmp, encodePostscript } from './image';
import { buildTiffOptions } from './image-tiff-options';
import { assertInputPixels, openInputImage, openLimitedSharp, resizedDimensions } from './image-input-limits';
import { loadFontCoverageIndex } from './pdf-fonts';

import {
  evaluateCubicBezier,
  evaluateCubicBezierDerivative,
  adaptiveTessellateCubicBezier,
  evaluateQuadraticBezier,
  cubicBezierToBSpline,
  tessellateSvgArc,
} from './cad-nurbs';
import {
  type CadMesh3D,
  MAX_MESH_TRIANGLES,
  MAX_MESH_VERTICES,
  MAX_TEXT_MESH_BYTES,
  MAX_OBJ_LINES,
  MAX_OBJ_FACE_CORNERS,
  MAX_ASCII_STL_WORDS,
  MAX_STEP_MESH_TRIANGLES,
  MAX_STEP_MESH_VERTICES,
  parse3dCad,
  encodeStep,
  encode3dCadToDxf,
} from './cad-mesh-step';
import { convertCadWithOcct, convertMeshToIgesWithOcct, isOcctSource } from './cad-occt';
import { encodeStl as pureEncodeStl, encodeObj as pureEncodeObj } from '../edge/pure/pure-cad';
import { MAX_SVG_INPUT_CHARS } from './svg-geometry';
import { normalizeSvgBufferForRendering } from './svg-render-normalize';
import { hasSvgText, outlineSvgText } from './svg-text-outlines';
import { dxfDrawingToSvg, dxfSvgDeclaredSize, parseDxfDrawing, renderDxfDrawingToPdf } from './cad-dxf';
import { decodeDxfBytes } from './cad-dxf-text';
import { convertDwgToDxf } from './cad-dwg';
import { convertDwgToDwg, convertDxfToDwg } from './cad-dwg-writer';
import { vectorizeRaster } from './raster-vectorize';
import { isVectorizePair } from './raster-vectorize-options';
import { encodeSvgPageToDxf } from './vector-dxf';
import { isSvg, sanitizeSvgDocument } from '../security/svg-sanitizer';
import { assertReadableInProcess } from './office/office-suite-sources';

export {
  evaluateCubicBezier,
  evaluateCubicBezierDerivative,
  adaptiveTessellateCubicBezier,
  evaluateQuadraticBezier,
  cubicBezierToBSpline,
  tessellateSvgArc,
  type CadMesh3D,
  MAX_MESH_TRIANGLES,
  MAX_MESH_VERTICES,
  MAX_TEXT_MESH_BYTES,
  MAX_OBJ_LINES,
  MAX_OBJ_FACE_CORNERS,
  MAX_ASCII_STL_WORDS,
  MAX_STEP_MESH_TRIANGLES,
  MAX_STEP_MESH_VERTICES,
  parse3dCad,
  encodeStep,
  encode3dCadToDxf,
};

import {
  encodeEmf,
  encodeWmf,
  encodeCgm,
  parseSvgGeometries,
  parseCssColor,
  type SvgGeometryElement,
  type ParsedSvgVectorDocument,
  parseSvgPathToPoints as parseSvgPathToBezierPoints,
} from './vector-metafile';
import { escapeMarkupAttribute } from '../text/escape';

export {
  encodeEmf,
  encodeWmf,
  encodeCgm,
  parseSvgGeometries,
  parseCssColor,
  type SvgGeometryElement,
  type ParsedSvgVectorDocument,
  parseSvgPathToBezierPoints,
};

export const MAX_CGM_INPUT_CHARS = 16 * 1024 * 1024;
export const MAX_CGM_VDC_EXTENT = 1_000_000;
export const MAX_CGM_ELEMENTS = 100_000;
export const MAX_CGM_POINTS = 500_000;
export const MAX_CGM_TEXT_CHARS = 1_000_000;

interface CgmBudget {
  elements: number;
  points: number;
  textChars: number;
}

const CGM_FLOAT = '([-+]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:[eE][-+]?\\d+)?)';
const CGM_VDCEXT_PATTERN = new RegExp(
  `VDCEXT\\s*\\(\\s*${CGM_FLOAT}\\s*,\\s*${CGM_FLOAT}\\s*\\)\\s*\\(\\s*${CGM_FLOAT}\\s*,\\s*${CGM_FLOAT}\\s*\\)`,
  'i'
);

function chargeCgmElement(budget: CgmBudget): void {
  if (++budget.elements > MAX_CGM_ELEMENTS) {
    throw new PayloadLimitError(`CGM drawing exceeds the ${MAX_CGM_ELEMENTS.toLocaleString('en-US')}-element limit.`);
  }
}

function chargeCgmPoint(budget: CgmBudget): void {
  if (++budget.points > MAX_CGM_POINTS) {
    throw new PayloadLimitError(`CGM drawing exceeds the ${MAX_CGM_POINTS.toLocaleString('en-US')}-point limit.`);
  }
}

function chargeCgmTextChars(budget: CgmBudget, count: number): void {
  budget.textChars += count;
  if (budget.textChars > MAX_CGM_TEXT_CHARS) {
    throw new PayloadLimitError(`CGM drawing exceeds the ${MAX_CGM_TEXT_CHARS.toLocaleString('en-US')}-character text limit.`);
  }
}

/**
 * The canvas size of a CGM is its VDC extent. A drawing that states none, or an empty one, has no size to
 * read, so it is refused instead of being drawn on a canvas of an invented size.
 */
function parseCgmDimensions(cgmText: string): { width: number; height: number } {
  const vdcMatch = CGM_VDCEXT_PATTERN.exec(cgmText);
  if (!vdcMatch) {
    throw new ConversionFailedError('The CGM states no VDC extent (VDCEXT), so its size cannot be read.');
  }
  const x1 = Number(vdcMatch[1]);
  const y1 = Number(vdcMatch[2]);
  const x2 = Number(vdcMatch[3]);
  const y2 = Number(vdcMatch[4]);
  const w = Math.abs(x2 - x1);
  const h = Math.abs(y2 - y1);
  if (
    !Number.isFinite(x1) ||
    !Number.isFinite(y1) ||
    !Number.isFinite(x2) ||
    !Number.isFinite(y2) ||
    !Number.isFinite(w) ||
    !Number.isFinite(h)
  ) {
    throw new ConversionFailedError('The CGM has a non-finite VDC extent, so its size cannot be read.');
  }
  // Either corner order is legal; a reversed y extent only flips the VDC axis.
  const width = Math.round(w);
  const height = Math.round(h);
  if (!(width > 0 && height > 0)) {
    throw new ConversionFailedError('The CGM has an empty VDC extent, so its size cannot be read.');
  }
  if (width > MAX_CGM_VDC_EXTENT || height > MAX_CGM_VDC_EXTENT) {
    throw new PayloadLimitError(`CGM VDC extent (${width}x${height}) exceeds the ${MAX_CGM_VDC_EXTENT.toLocaleString('en-US')} limit.`);
  }
  return { width, height };
}

function parseCgmLines(cgmText: string, budget: CgmBudget, elements: string[]): void {
  const lineRegex = /(?<![A-Z])LINE\s*\(\s*([\d.]+)\s*,\s*([\d.]+)\s*\)\s*\(\s*([\d.]+)\s*,\s*([\d.]+)\s*\)/gi;
  for (const lineMatch of cgmText.matchAll(lineRegex)) {
    chargeCgmElement(budget);
    chargeCgmPoint(budget);
    chargeCgmPoint(budget);
    elements.push(
      `<line x1="${lineMatch[1]}" y1="${lineMatch[2]}" x2="${lineMatch[3]}" y2="${lineMatch[4]}" stroke="#111827" stroke-width="2" />`
    );
  }
}

const CGM_TEXT_HEAD_PATTERN = /TEXT\s*\(\s*([\d.]+)\s*,\s*([\d.]+)\s*\)/gi;

/**
 * Reads TEXT (x, y) ... "string" elements. The quoted string is located with
 * indexOf from the end of the head, so a missing quote ends the scan instead of
 * being re-scanned from every later TEXT keyword.
 */
function parseCgmTextElements(cgmText: string, budget: CgmBudget, elements: string[]): void {
  CGM_TEXT_HEAD_PATTERN.lastIndex = 0;
  let head = CGM_TEXT_HEAD_PATTERN.exec(cgmText);
  while (head) {
    const open = cgmText.indexOf('"', CGM_TEXT_HEAD_PATTERN.lastIndex);
    if (open < 0) break;
    const close = cgmText.indexOf('"', open + 1);
    if (close < 0) break;
    if (close > open + 1) {
      chargeCgmElement(budget);
      chargeCgmTextChars(budget, close - open - 1);
      elements.push(
        `<text x="${head[1]}" y="${head[2]}" font-family="system-ui, -apple-system, sans-serif" font-size="14" fill="#111827">${escapeMarkupAttribute(cgmText.substring(open + 1, close))}</text>`
      );
      CGM_TEXT_HEAD_PATTERN.lastIndex = close + 1;
    }
    head = CGM_TEXT_HEAD_PATTERN.exec(cgmText);
  }
}

const CGM_POLYGON_KEYWORD = /POLYGON\s/gi;
const CGM_POLYLINE_KEYWORD = /POLYLINE\s/gi;
const CGM_STATEMENT_END = /[;\r\n]/g;
const LEADING_WHITESPACE = /\s*/y;

/**
 * Visits the argument text of each `KEYWORD args;` statement (arguments stay on one line).
 * The statement end is cached between keywords so a run of keywords without a
 * terminator costs one scan, not one per keyword.
 */
function forEachCgmStatement(cgmText: string, keyword: RegExp, onStatement: (args: string) => void): void {
  keyword.lastIndex = 0;
  CGM_STATEMENT_END.lastIndex = 0;
  let endIndex = -1;
  let consumedUpTo = 0;
  for (let m = keyword.exec(cgmText); m; m = keyword.exec(cgmText)) {
    if (m.index < consumedUpTo) continue;
    LEADING_WHITESPACE.lastIndex = m.index + m[0].length;
    LEADING_WHITESPACE.exec(cgmText);
    const argsStart = LEADING_WHITESPACE.lastIndex;
    if (endIndex < argsStart) {
      CGM_STATEMENT_END.lastIndex = argsStart;
      const end = CGM_STATEMENT_END.exec(cgmText);
      if (!end) break;
      endIndex = end.index;
    }
    if (cgmText.charAt(endIndex) !== ';' || endIndex === argsStart) continue;
    onStatement(cgmText.substring(argsStart, endIndex));
    consumedUpTo = endIndex + 1;
  }
}

function parseCgmPolyElements(cgmText: string, isPolygon: boolean, budget: CgmBudget, elements: string[]): void {
  const ptRegex = /\(\s*([-+]?[\d.]+)\s*,\s*([-+]?[\d.]+)\s*\)/g;
  const minCount = isPolygon ? 2 : 1;
  forEachCgmStatement(cgmText, isPolygon ? CGM_POLYGON_KEYWORD : CGM_POLYLINE_KEYWORD, (args) => {
    const pts: string[] = [];
    for (const pm of args.matchAll(ptRegex)) {
      chargeCgmPoint(budget);
      pts.push(`${pm[1]},${pm[2]}`);
    }
    if (pts.length > minCount) {
      chargeCgmElement(budget);
      if (isPolygon) {
        elements.push(`<polygon points="${pts.join(' ')}" fill="#111827" stroke="#111827" stroke-width="2" />`);
      } else {
        elements.push(`<polyline points="${pts.join(' ')}" fill="none" stroke="#111827" stroke-width="2" />`);
      }
    }
  });
}

export function parseCgmToSvg(cgmText: string): string | null {
  if (cgmText.length > MAX_CGM_INPUT_CHARS) {
    throw new PayloadLimitError(`CGM payload exceeds the ${MAX_CGM_INPUT_CHARS}-character limit.`);
  }
  if (!cgmText.includes('BEGMF')) return null;

  const { width, height } = parseCgmDimensions(cgmText);
  const budget: CgmBudget = { elements: 0, points: 0, textChars: 0 };
  const elements: string[] = [];
  parseCgmLines(cgmText, budget, elements);
  parseCgmTextElements(cgmText, budget, elements);
  parseCgmPolyElements(cgmText, false, budget, elements);
  parseCgmPolyElements(cgmText, true, budget, elements);

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">
  ${elements.join('\n  ')}
</svg>`;
}

/**
 * Universal Vector & CAD Conversion Engine
 * Supports 2D Vector (SVG, EPS, PS, CDR, CGM, DWF, EMF, SK, SK1, SVGZ, VSD, WMF),
 * 2D CAD (DXF, DWG), and 3D CAD (STEP, STP, IGES, IGS, STL, OBJ).
 */
/** Inflates an SVGZ payload; corrupt gzip and oversized output fail closed instead of falling back to raw bytes. */
function gunzipSvgz(payload: Buffer): Buffer {
  try {
    return zlib.gunzipSync(payload, { maxOutputLength: MAX_SVG_INPUT_CHARS });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ERR_BUFFER_TOO_LARGE') {
      throw new CadGeometryUnavailableError(`SVGZ expands beyond the ${MAX_SVG_INPUT_CHARS}-byte limit.`);
    }
    throw new CadGeometryUnavailableError(`SVGZ payload is not valid gzip data (${(error as Error).message}).`);
  }
}

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
  if (tgt === 'pdf') await loadFontCoverageIndex();

  if (!inputBuffer || inputBuffer.length === 0) {
    throw new ConversionFailedError('Vector/CAD conversion payload is empty (0 bytes).');
  }

  // 0. Raster pictures traced to SVG, ahead of the routes below, which draw every other SVG target.
  if (isVectorizePair(src, tgt)) {
    return vectorizeRaster(inputBuffer, src, options, originalFilename);
  }

  // 1. 3D CAD Domain (STEP, STP, IGES, IGS, STL, OBJ)
  if (['step', 'stp', 'iges', 'igs', 'stl', 'obj'].includes(src) || ['step', 'stp', 'iges', 'igs', 'stl', 'obj'].includes(tgt)) {
    return convert3dCad(inputBuffer, src, tgt, options, baseName);
  }

  // 2. SVGZ Source (Compressed SVG)
  if (src === 'svgz') {
    const uncompressed = gunzipSvgz(inputBuffer);
    // The signature check sees only the gzip header; what the stream holds is judged here, where it is inflated.
    if (!isSvg(uncompressed)) throw new ConversionFailedError('Invalid image: the SVGZ payload is not an SVG document');
    const cleanSvg = sanitizeSvgDocument(uncompressed.toString('utf-8'));
    return convertSvgSource(Buffer.from(cleanSvg, 'utf-8'), tgt, options, baseName);
  }

  // 3. SVG Source
  if (src === 'svg') {
    const cleanSvg = sanitizeSvgDocument(inputBuffer.toString('utf-8'));
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
    return convertPostScriptSource(inputBuffer, src, tgt);
  }


  // 7. Visio, CorelDRAW and the metafiles are imported by the office suite's Draw and Impress applications, which have the
  // import filters of those formats; the in-process engine has no reader for them (a clear-text CGM excepted).
  assertReadableInProcess(src, inputBuffer);

  // 8. Formats no reader exists for: refused with the reason, never drawn from a placeholder.
  if (Object.hasOwn(NO_READER_REFUSALS, src)) {
    throw new CadGeometryUnavailableError(NO_READER_REFUSALS[src]);
  }

  // 9. Clear-text CGM
  if (src === 'cgm') {
    if (inputBuffer.length > MAX_CGM_INPUT_CHARS) {
      throw new PayloadLimitError(`CGM payload exceeds the ${MAX_CGM_INPUT_CHARS}-byte limit.`);
    }
    const svgStr = parseCgmToSvg(inputBuffer.toString('utf-8'));
    if (svgStr === null) {
      throw new CadGeometryUnavailableError('Unsupported or unparseable .cgm vector format: fail-closed against dummy placeholder synthesis.');
    }
    return convertSvgSource(Buffer.from(sanitizeSvgDocument(svgStr), 'utf-8'), tgt, options, baseName);
  }

  throw new UnsupportedTargetError(`Unsupported Vector/CAD conversion from .${src} to .${tgt}`);
}

/** The answer for a format that no reader exists for, by source: refused, never drawn from a placeholder. */
const NO_READER_REFUSALS: Readonly<Record<string, string>> = {
  dwf: 'DWF files cannot be converted: no reader of DWF 6 (W2D) or DWFx files is included in the worker, so the file is refused instead of drawn from a placeholder.',
  sk: 'Sketch and Skencil (.sk) files cannot be converted: no reader for them is included in the worker (the office suite does not import the format), so the file is refused instead of drawn from a placeholder.',
  sk1: 'sK1 (.sk1) files cannot be converted: no reader for them is included in the worker (the office suite does not import the format), so the file is refused instead of drawn from a placeholder.',
};

/** Resolution an SVG is rendered at when the request names none. */
const DEFAULT_SVG_RENDER_DPI = 300;
/** The resolution at which one user unit of an SVG is one pixel. */
const SVG_USER_UNIT_DPI = 72;
/**
 * Deflate level of a PNG rendered from a DXF drawing: a plate with curves has many anti-aliased pixels, and level 3 writes it
 * in 60 percent of the time of the default level for 6 percent more bytes.
 */
const DXF_PNG_COMPRESSION_LEVEL = 3;

/** SVG to SVG, EMF, WMF or CGM straight from the vector geometry; null for any other target. */
function svgToVectorTarget(inputBuffer: Buffer, tgt: string, baseName: string): ConversionResult | null {
  let buffer: Buffer;
  let mimeType: string;
  switch (tgt) {
    case 'svg':
      buffer = Buffer.from(sanitizeSvgDocument(inputBuffer.toString('utf-8')), 'utf-8');
      mimeType = 'image/svg+xml';
      break;
    case 'emf':
      buffer = encodeEmf(inputBuffer);
      mimeType = 'image/emf';
      break;
    case 'wmf':
      buffer = encodeWmf(inputBuffer);
      mimeType = 'image/wmf';
      break;
    case 'cgm':
      buffer = encodeCgm(inputBuffer, baseName);
      mimeType = 'image/cgm';
      break;
    default:
      return null;
  }
  return { buffer, mimeType, filename: `${baseName}.${tgt}`, size: buffer.length };
}

/** Raster targets the shared image writer encodes from the PNG a drawing renders to. */
const SVG_ENCODED_RASTER_TARGETS: ReadonlySet<string> = new Set(['ico', 'odd', 'psd']);
/** The targets a DXF drawing is written to through the SVG it draws: the raster pictures and PostScript. */
const DXF_SVG_TARGETS: ReadonlySet<string> = new Set(['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif', 'tiff', 'eps']);

/** Targets the SVG converter writes without rendering pixels, so the output size options do not apply. */
const SVG_NON_RASTER_TARGETS = new Set(['svg', 'emf', 'wmf', 'cgm']);

/**
 * Size the drawing renders at for `density`, read from the SVG header without rendering it. A drawing that
 * would render over the output pixel limit is refused before any pixel is allocated.
 */
async function assertSvgRenderSize(svg: Buffer, density: number): Promise<{ width: number; height: number }> {
  let width: number | undefined;
  let height: number | undefined;
  try {
    ({ width, height } = await sharp(svg, { density }).metadata());
  } catch (error) {
    throw new ConversionFailedError(`The SVG drawing cannot be rendered at ${density} dpi: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!width || !height) throw new ConversionFailedError('The SVG drawing declares no size');
  assertOutputPixels(width, height);
  return { width, height };
}

/**
 * Resize parameters for the requested width and height, or null when the request does not resize. The sides
 * are validated like raster images and the resized box is checked against the output pixel limit before the
 * drawing is rendered.
 */
async function svgResizeOf(svg: Buffer, density: number, options: ConversionOptions, known?: { width: number; height: number }): Promise<ResizeOptions | null> {
  const width = outputSideOf(options.width, 'width');
  const height = outputSideOf(options.height, 'height');
  if (known) assertOutputPixels(known.width, known.height);
  const rendered = known ?? (await assertSvgRenderSize(svg, density));
  if (width === undefined && height === undefined) return null;
  const resize = { width, height, fit: options.fit || 'contain' };
  const resized = resizedDimensions(rendered.width, rendered.height, resize);
  assertOutputPixels(resized.width, resized.height);
  return { ...resize, background: { r: 255, g: 255, b: 255, alpha: 0 } };
}

/**
 * Converts SVG to Raster (PNG, JPG, WEBP, AVIF), Vector (DXF), or Document (PDF)
 */
/** What the caller that wrote the SVG knows about it, so that the converter does not parse the header again to learn it. */
interface WrittenSvg {
  /** Declared size in user units (pixels at 72 dpi). */
  width: number;
  height: number;
  /** Deflate level of a PNG output, for a drawing whose size the caller prefers to keep small in time over bytes. */
  pngCompressionLevel?: number;
}

async function convertSvgSource(
  inputBuffer: Buffer,
  tgt: string,
  options: ConversionOptions,
  baseName: string,
  written?: WrittenSvg
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
    dxfToDwg(svgToDxf(inputBuffer.toString('utf-8')));
  }

  // Vector targets are written from the SVG geometry and never rasterize it. EMF and WMF carry no text, so the text of the drawing is outlines first.
  const needsOutlines = (tgt === 'emf' || tgt === 'wmf') && hasSvgText(inputBuffer.toString('utf-8'));
  const geometry = needsOutlines ? await outlineSvgText(normalizeSvgBufferForRendering(inputBuffer), options.signal) : inputBuffer;
  const vectorOutput = svgToVectorTarget(geometry, tgt, baseName);
  if (vectorOutput) return vectorOutput;

  // The encoded rasters (icon, Photoshop, drawing package) are written by the shared image writer from the PNG this drawing renders to.
  if (SVG_ENCODED_RASTER_TARGETS.has(tgt)) {
    const picture = await convertSvgSource(inputBuffer, 'png', options, baseName, written);
    return convertImage(picture.buffer, tgt, options, `${baseName}.png`, 'png');
  }

  const density = options.dpi || DEFAULT_SVG_RENDER_DPI;
  const renderBuffer = written ? inputBuffer : normalizeSvgBufferForRendering(inputBuffer);

  // SVG -> PDF
  if (tgt === 'pdf') {
    // The render size follows the requested dpi, so the declared canvas is checked at that density first.
    const renderer = await openInputImage(renderBuffer, { density });
    await assertSvgRenderSize(renderBuffer, density);
    const pngBuffer = await renderer.png().toBuffer();
    const meta = await sharp(pngBuffer).metadata();
    const { width, height } = meta;
    if (!width || !height) throw new ConversionFailedError('The rendered SVG drawing has no size.');

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
  const rendered = written ? { width: Math.round((written.width * density) / SVG_USER_UNIT_DPI), height: Math.round((written.height * density) / SVG_USER_UNIT_DPI) } : undefined;
  let pipeline: Sharp;
  if (rendered) {
    // The writer states the size it wrote: the limits are checked against it and the native decoder keeps its own pixel limit.
    assertInputPixels(rendered.width, rendered.height);
    pipeline = openLimitedSharp(renderBuffer, { density });
  } else {
    pipeline = await openInputImage(renderBuffer, { density });
  }

  if (!SVG_NON_RASTER_TARGETS.has(tgt)) {
    const resize = await svgResizeOf(renderBuffer, density, options, rendered);
    if (resize) pipeline = pipeline.resize(resize);
  }

  const quality = options.quality ? Math.max(1, Math.min(100, options.quality)) : 90;
  let outputBuffer: Buffer;
  let mimeType: string;

  switch (tgt) {
    case 'png':
      outputBuffer = await pipeline.png(written?.pngCompressionLevel === undefined ? undefined : { compressionLevel: written.pngCompressionLevel }).toBuffer();
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
      outputBuffer = await pipeline.avif({ quality, tune: AVIF_TUNE, effort: AVIF_EFFORT }).toBuffer();
      mimeType = 'image/avif';
      break;

    case 'tiff':
      outputBuffer = await pipeline.tiff(buildTiffOptions(options)).toBuffer();
      mimeType = 'image/tiff';
      break;

    case 'eps':
    case 'ps': {
      const { data: rawRgb, info } = await pipeline
        .removeAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      outputBuffer = await encodePostscript(rawRgb, info.width, info.height, tgt === 'eps');
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
      throw new UnsupportedTargetError(`Unsupported SVG target conversion: ${tgt}`);
  }

  return {
    buffer: outputBuffer,
    mimeType,
    filename: `${baseName}.${tgt}`,
    size: outputBuffer.length,
  };
}

/**
 * Converts DXF to SVG, PDF, the raster pictures, PostScript, or DWG
 */
async function convertDxfSource(
  inputBuffer: Buffer,
  tgt: string,
  options: ConversionOptions,
  baseName: string
): Promise<ConversionResult> {
  // DXF -> DWG
  if (tgt === 'dwg') return dwgResult(await convertDxfToDwg(inputBuffer, options), baseName);

  const drawing = parseDxfDrawing(decodeDxfBytes(inputBuffer));

  // DXF -> SVG
  if (tgt === 'svg') {
    // The writer's output is safe by construction (see dxfDrawingToSvg) and needs no pass through the general sanitizer.
    const buffer = Buffer.from(dxfDrawingToSvg(drawing, baseName), 'utf-8');
    return {
      buffer,
      mimeType: 'image/svg+xml',
      filename: `${baseName}.svg`,
      size: buffer.length,
    };
  }

  // DXF -> PDF
  if (tgt === 'pdf') {
    const pdfBuffer = await renderDxfDrawingToPdf(drawing);
    return {
      buffer: pdfBuffer,
      mimeType: 'application/pdf',
      filename: `${baseName}.pdf`,
      size: pdfBuffer.length,
    };
  }

  // DXF -> Raster pictures and PostScript
  if (DXF_SVG_TARGETS.has(tgt)) {
    const svgStr = dxfDrawingToSvg(drawing, baseName);
    const svgBuf = Buffer.from(svgStr, 'utf-8');
    return convertSvgSource(svgBuf, tgt, options, baseName, { ...dxfSvgDeclaredSize(drawing), pngCompressionLevel: DXF_PNG_COMPRESSION_LEVEL });
  }

  throw new UnsupportedTargetError(`Unsupported DXF target conversion: ${tgt}`);
}

function dwgResult(buffer: Buffer, baseName: string): ConversionResult {
  return { buffer, mimeType: 'image/vnd.dwg', filename: `${baseName}.dwg`, size: buffer.length };
}

/**
 * Converts a DWG: the pinned reader (an unmodified separate program, see cad-dwg.ts) writes a DXF, and the DXF path draws it.
 * A DWG is written as an AutoCAD 2000 DWG by the pinned writer from the DXF of the reader (see cad-dwg-writer.ts).
 */
async function convertDwgSource(
  inputBuffer: Buffer,
  tgt: string,
  options: ConversionOptions,
  baseName: string
): Promise<ConversionResult> {
  if (tgt === 'dwg') return dwgResult(await convertDwgToDwg(inputBuffer, options), baseName);
  const dxfBuf = await convertDwgToDxf(inputBuffer, options);
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
 * Converts PostScript (EPS / PS) Source. Interpreting PostScript needs a PostScript interpreter, which the
 * in-process engine does not have: the worker renders it with ps2pdf and Poppler, and without them this
 * fails with a typed 503 error rather than drawing a guess at the page.
 */
async function convertPostScriptSource(inputBuffer: Buffer, src: string, tgt: string): Promise<ConversionResult> {
  throw new EngineUnavailableError('ps2pdf', `Rendering .${src} to ${tgt} needs a PostScript interpreter (ps2pdf) and Poppler; the in-process engine cannot interpret PostScript.`);
}

/**
 * Converts a STEP or IGES model with the Open CASCADE program (see cad-occt.ts). STEP, IGES, STL and OBJ are its own outputs;
 * a DXF is drawn from the mesh it writes, as 3DFACE entities.
 */
async function convertOcctSource(inputBuffer: Buffer, src: string, tgt: string, options: ConversionOptions, baseName: string): Promise<ConversionResult> {
  if (tgt === 'dxf') {
    const stl = await convertCadWithOcct(inputBuffer, src, 'stl', options);
    const buffer = Buffer.from(encode3dCadToDxf(parse3dCad(stl.buffer, 'stl', baseName)), 'utf-8');
    return { buffer, mimeType: 'image/vnd.dxf', filename: `${baseName}.dxf`, size: buffer.length };
  }
  const output = await convertCadWithOcct(inputBuffer, src, tgt, { ...options, outputName: baseName });
  return { buffer: output.buffer, mimeType: output.mimeType, filename: `${baseName}.${output.archive ? 'zip' : tgt}`, size: output.buffer.length };
}

/** Writes an STL or OBJ mesh as IGES through the Open CASCADE program (see cad-occt.ts); a mesh with nothing to write is refused. */
async function convertMeshToIges(mesh: CadMesh3D, tgt: string, options: ConversionOptions, baseName: string): Promise<ConversionResult> {
  if (mesh.vertices.length === 0 || mesh.faces.length === 0) {
    throw new CadGeometryUnavailableError('Cannot export 3D CAD mesh to IGES: Mesh contains no faces or vertices.');
  }
  const output = await convertMeshToIgesWithOcct(mesh, options);
  return { buffer: output.buffer, mimeType: output.mimeType, filename: `${baseName}.${tgt}`, size: output.buffer.length };
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
  if (isOcctSource(src)) return convertOcctSource(inputBuffer, src, tgt, options, baseName);
  const mesh = parse3dCad(inputBuffer, src, baseName);
  if (tgt === 'iges' || tgt === 'igs') return convertMeshToIges(mesh, tgt, options, baseName);

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
      outputBuffer = Buffer.from(encodeStep(mesh, options.outputUnit), 'utf-8');
      mimeType = 'model/step';
      break;

    case 'dxf':
      outputBuffer = Buffer.from(encode3dCadToDxf(mesh), 'utf-8');
      mimeType = 'image/vnd.dxf';
      break;

    default:
      throw new UnsupportedTargetError(`Unsupported 3D CAD target: ${tgt}`);
  }

  return {
    buffer: outputBuffer,
    mimeType,
    filename: `${baseName}.${tgt}`,
    size: outputBuffer.length,
  };
}



/**
 * Converts an SVG drawing into AutoCAD DXF ASCII text: the same geometry the page draws (transforms applied,
 * curves flattened, Y pointing up) written by the R12 writer in vector-dxf.ts. A drawing without any outline
 * is refused with a ConversionFailedError instead of being answered with a made-up line.
 */
export function svgToDxf(svgContent: string): string {
  return encodeSvgPageToDxf(Buffer.from(svgContent, 'utf-8')).toString('utf-8');
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

function dxfToDwg(_dxfString: string): never {
  throw new CadGeometryUnavailableError('Unsupported CAD format: DWG binary encoder unavailable');
}

