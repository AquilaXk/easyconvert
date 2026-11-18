/**
 * Pure Isomorphic Canvas 2D Image Transcoder (Level 0 Fast-Path)
 *
 * Implements client-side in-browser image transcoding (PNG, JPEG, WebP, BMP)
 * using createImageBitmap, OffscreenCanvas, and a pure TypedArray BMP encoder.
 */

import { canvasToBlob } from '../pipelines/canvas-blob';
import { assertEncodedBlob, canvasMimeType } from '../canvas-encoding';
import { EdgeUnsupportedError } from '../workers/worker-errors';
import { assertCanvasInputSupported, HEX_BACKGROUND_PATTERN } from './canvas-header-guard';

export interface PureCanvasResult {
  data: Uint8Array;
  blob?: Blob;
  mimeType: string;
  extension: string;
  width: number;
  height: number;
}

export interface PureCanvasOptions {
  width?: number;
  height?: number;
  quality?: number; // 1 - 100
  fit?: 'cover' | 'contain' | 'fill' | 'inside' | 'outside';
  background?: string;
  stripMetadata?: boolean;
}

const SUPPORTED_CANVAS_SOURCES = new Set(['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif', 'svg']);
const SUPPORTED_CANVAS_TARGETS = new Set(['png', 'jpg', 'jpeg', 'webp', 'bmp']);

const CANVAS_MIME_MAP: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  bmp: 'image/bmp',
  gif: 'image/gif',
  svg: 'image/svg+xml',
};

/**
 * Checks whether the environment supports Canvas 2D rasterization.
 */
export function isCanvasSupported(): boolean {
  return (
    typeof OffscreenCanvas !== 'undefined' ||
    (typeof document !== 'undefined' && typeof document.createElement === 'function')
  );
}

/**
 * Checks whether the formats are supported by the pure canvas engine.
 */
export function isPureCanvasConvertible(sourceFormat: string, targetFormat: string): boolean {
  const src = sourceFormat.toLowerCase();
  const tgt = targetFormat.toLowerCase();
  return SUPPORTED_CANVAS_SOURCES.has(src) && SUPPORTED_CANVAS_TARGETS.has(tgt);
}

const MAX_BMP_SIDE = 32_768;
const MAX_BMP_FILE_BYTES = 512 * 1024 * 1024;

interface CanvasDrawGeometry {
  canvasW: number;
  canvasH: number;
  drawX: number;
  drawY: number;
  drawW: number;
  drawH: number;
}

function computeCanvasDrawGeometry(
  srcW: number,
  srcH: number,
  options: PureCanvasOptions
): CanvasDrawGeometry {
  if (options.width && !options.height) {
    const canvasW = Math.max(1, Math.round(options.width));
    const canvasH = Math.max(1, Math.round((srcH * canvasW) / srcW));
    return { canvasW, canvasH, drawX: 0, drawY: 0, drawW: canvasW, drawH: canvasH };
  }
  if (!options.width && options.height) {
    const canvasH = Math.max(1, Math.round(options.height));
    const canvasW = Math.max(1, Math.round((srcW * canvasH) / srcH));
    return { canvasW, canvasH, drawX: 0, drawY: 0, drawW: canvasW, drawH: canvasH };
  }
  if (!options.width || !options.height) {
    return { canvasW: srcW, canvasH: srcH, drawX: 0, drawY: 0, drawW: srcW, drawH: srcH };
  }

  const boxW = Math.max(1, Math.round(options.width));
  const boxH = Math.max(1, Math.round(options.height));
  const fit = options.fit || 'contain';

  if (fit === 'fill') {
    return { canvasW: boxW, canvasH: boxH, drawX: 0, drawY: 0, drawW: boxW, drawH: boxH };
  }
  if (fit === 'outside' || fit === 'inside') {
    const scale = fit === 'outside' ? Math.max(boxW / srcW, boxH / srcH) : Math.min(boxW / srcW, boxH / srcH);
    const canvasW = Math.max(1, Math.round(srcW * scale));
    const canvasH = Math.max(1, Math.round(srcH * scale));
    return { canvasW, canvasH, drawX: 0, drawY: 0, drawW: canvasW, drawH: canvasH };
  }

  const scale = fit === 'cover' ? Math.max(boxW / srcW, boxH / srcH) : Math.min(boxW / srcW, boxH / srcH);
  const drawW = Math.round(srcW * scale);
  const drawH = Math.round(srcH * scale);
  const drawX = Math.round((boxW - drawW) / 2);
  const drawY = Math.round((boxH - drawH) / 2);
  return { canvasW: boxW, canvasH: boxH, drawX, drawY, drawW, drawH };
}

/**
 * Encodes RGBA image pixel data to Windows Bitmap (BMP) using pure TypedArray.
 */
export function encodeBmpFromImageData(imageData: {
  width: number;
  height: number;
  data: Uint8ClampedArray | Uint8Array;
}): Uint8Array {
  const { width, height, data } = imageData;
  if (
    !data ||
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width <= 0 ||
    height <= 0 ||
    width > MAX_BMP_SIDE ||
    height > MAX_BMP_SIDE ||
    data.length < width * height * 4
  ) {
    throw new Error('Invalid image dimensions or pixel data for BMP encoding.');
  }
  // Each row is padded to a 4-byte boundary
  const rowSize = Math.floor((24 * width + 31) / 32) * 4;
  const pixelArraySize = rowSize * height;
  const fileHeaderSize = 14;
  const infoHeaderSize = 40;
  const totalFileSize = fileHeaderSize + infoHeaderSize + pixelArraySize;
  if (!Number.isSafeInteger(totalFileSize) || totalFileSize > MAX_BMP_FILE_BYTES) {
    throw new Error('Invalid image dimensions or BMP output exceeds maximum byte budget.');
  }

  const out = new Uint8Array(totalFileSize);
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);

  // 1. BITMAPFILEHEADER (14 bytes)
  view.setUint8(0, 0x42); // 'B'
  view.setUint8(1, 0x4d); // 'M'
  view.setUint32(2, totalFileSize, true);
  view.setUint16(6, 0, true); // reserved1
  view.setUint16(8, 0, true); // reserved2
  view.setUint32(10, fileHeaderSize + infoHeaderSize, true); // pixel data offset

  // 2. BITMAPINFOHEADER (40 bytes)
  view.setUint32(14, infoHeaderSize, true);
  view.setInt32(18, width, true);
  view.setInt32(22, height, true); // positive = bottom-up
  view.setUint16(26, 1, true); // color planes
  view.setUint16(28, 24, true); // bits per pixel (24-bit RGB)
  view.setUint32(30, 0, true); // BI_RGB (uncompressed)
  view.setUint32(34, pixelArraySize, true);
  view.setInt32(38, 2835, true); // ~72 DPI horizontal (pixels/meter)
  view.setInt32(42, 2835, true); // ~72 DPI vertical (pixels/meter)
  view.setUint32(46, 0, true); // colors in color table
  view.setUint32(50, 0, true); // important color count

  // 3. Pixel Array (Bottom-up BGR)
  let dstOffset = fileHeaderSize + infoHeaderSize;
  for (let y = height - 1; y >= 0; y--) {
    let rowStart = dstOffset;
    for (let x = 0; x < width; x++) {
      const srcIdx = (y * width + x) * 4;
      const r = data[srcIdx];
      const g = data[srcIdx + 1];
      const b = data[srcIdx + 2];

      out[dstOffset++] = b;
      out[dstOffset++] = g;
      out[dstOffset++] = r;
    }
    // Pad row to multiple of 4 bytes
    while ((dstOffset - rowStart) % 4 !== 0) {
      out[dstOffset++] = 0;
    }
  }

  return out;
}

/**
 * Transcodes raster image in browser memory using createImageBitmap and OffscreenCanvas.
 */
export async function convertPureCanvas(
  input: Blob | Uint8Array,
  sourceFormat: string,
  targetFormat: string,
  options: PureCanvasOptions = {}
): Promise<PureCanvasResult> {
  const src = sourceFormat.toLowerCase();
  const tgt = targetFormat.toLowerCase();

  if (!isPureCanvasConvertible(src, tgt)) {
    throw new EdgeUnsupportedError(`Pure canvas engine does not support conversion from '${src}' to '${tgt}'.`);
  }

  if (!isCanvasSupported() || typeof createImageBitmap === 'undefined') {
    throw new EdgeUnsupportedError('Canvas 2D image transcoding is only available in browser environments.');
  }

  let customBackground: string | undefined;
  if (options.background !== undefined) {
    const trimmed = options.background.trim();
    if (!HEX_BACKGROUND_PATTERN.test(trimmed)) {
      throw new EdgeUnsupportedError('Non-hex background colour requires the server image engine.');
    }
    customBackground = trimmed;
  }

  await assertCanvasInputSupported(input, src, options.stripMetadata === true);

  const srcMime = CANVAS_MIME_MAP[src] || 'application/octet-stream';
  const blob = input instanceof Blob ? input : new Blob([input as any], { type: srcMime });

  const bitmap = await createImageBitmap(blob);
  const { canvasW, canvasH, drawX, drawY, drawW, drawH } = computeCanvasDrawGeometry(
    bitmap.width,
    bitmap.height,
    options
  );

  let canvas: HTMLCanvasElement | OffscreenCanvas;
  let ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null = null;

  if (typeof OffscreenCanvas !== 'undefined') {
    canvas = new OffscreenCanvas(canvasW, canvasH);
    ctx = canvas.getContext('2d');
  } else {
    canvas = document.createElement('canvas');
    canvas.width = canvasW;
    canvas.height = canvasH;
    ctx = canvas.getContext('2d');
  }

  if (!ctx) {
    bitmap.close();
    throw new EdgeUnsupportedError('Failed to acquire 2D canvas context.');
  }

  try {
    // Fill background for opaque targets (JPEG/BMP) or when an explicit background colour is requested
    const isOpaqueTarget = tgt === 'jpg' || tgt === 'jpeg' || tgt === 'bmp';
    if (isOpaqueTarget || customBackground !== undefined) {
      ctx.fillStyle = customBackground ?? '#FFFFFF';
      ctx.fillRect(0, 0, canvasW, canvasH);
    }

    // Shrinking with the default (low) filter skips source pixels; the high-quality filter averages them.
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, drawX, drawY, drawW, drawH);
  } finally {
    bitmap.close();
  }

  const normalizedTgt = tgt === 'jpg' ? 'jpeg' : tgt;
  const defaultQuality = normalizedTgt === 'webp' ? 80 : 85;
  const quality = (options.quality ?? defaultQuality) / 100;

  if (normalizedTgt === 'bmp') {
    const imgData = ctx.getImageData(0, 0, canvasW, canvasH);
    const bmpBytes = encodeBmpFromImageData(imgData);
    const outBlob = new Blob([bmpBytes as any], { type: 'image/bmp' });

    return {
      data: bmpBytes,
      blob: outBlob,
      mimeType: 'image/bmp',
      extension: 'bmp',
      width: canvasW,
      height: canvasH,
    };
  }

  // The browser may answer a request for a type it does not encode with a PNG, or with nothing: both are refused
  // (EdgeUnsupportedError, the server converts the file), and the result carries the type of the blob it holds.
  const outBlob = await canvasToBlob(canvas, canvasMimeType(normalizedTgt), quality);
  await assertEncodedBlob(outBlob, normalizedTgt);
  const mimeType = outBlob.type || canvasMimeType(normalizedTgt);

  const arrayBuf = await outBlob.arrayBuffer();
  return {
    data: new Uint8Array(arrayBuf),
    blob: outBlob,
    mimeType,
    extension: normalizedTgt,
    width: canvasW,
    height: canvasH,
  };
}
