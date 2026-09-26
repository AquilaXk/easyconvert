/**
 * Pure Isomorphic Canvas 2D Image Transcoder (Level 0 Fast-Path)
 *
 * Implements client-side in-browser image transcoding (PNG, JPEG, WebP, BMP)
 * using createImageBitmap, OffscreenCanvas, and a pure TypedArray BMP encoder.
 */

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

/**
 * Encodes RGBA image pixel data to Windows Bitmap (BMP) using pure TypedArray.
 */
export function encodeBmpFromImageData(imageData: {
  width: number;
  height: number;
  data: Uint8ClampedArray | Uint8Array;
}): Uint8Array {
  const { width, height, data } = imageData;
  if (!data || width <= 0 || height <= 0) {
    throw new Error('Invalid image dimensions or pixel data for BMP encoding.');
  }
  // Each row is padded to a 4-byte boundary
  const rowSize = Math.floor((24 * width + 31) / 32) * 4;
  const pixelArraySize = rowSize * height;
  const fileHeaderSize = 14;
  const infoHeaderSize = 40;
  const totalFileSize = fileHeaderSize + infoHeaderSize + pixelArraySize;

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
    throw new Error(`Pure canvas engine does not support conversion from '${src}' to '${tgt}'.`);
  }

  if (!isCanvasSupported() || typeof createImageBitmap === 'undefined') {
    throw new Error('Canvas 2D image transcoding is only available in browser environments.');
  }

  const srcMime = CANVAS_MIME_MAP[src] || 'application/octet-stream';
  const blob = input instanceof Blob ? input : new Blob([input as any], { type: srcMime });

  const bitmap = await createImageBitmap(blob);
  const srcW = bitmap.width;
  const srcH = bitmap.height;

  let canvasW = srcW;
  let canvasH = srcH;
  let drawX = 0;
  let drawY = 0;
  let drawW = srcW;
  let drawH = srcH;

  const fit = options.fit || 'contain';

  if (options.width && !options.height) {
    canvasW = Math.max(1, Math.round(options.width));
    canvasH = Math.max(1, Math.round((srcH * canvasW) / srcW));
    drawW = canvasW;
    drawH = canvasH;
  } else if (!options.width && options.height) {
    canvasH = Math.max(1, Math.round(options.height));
    canvasW = Math.max(1, Math.round((srcW * canvasH) / srcH));
    drawW = canvasW;
    drawH = canvasH;
  } else if (options.width && options.height) {
    canvasW = Math.max(1, Math.round(options.width));
    canvasH = Math.max(1, Math.round(options.height));

    if (fit === 'fill') {
      drawW = canvasW;
      drawH = canvasH;
    } else if (fit === 'cover') {
      const scale = Math.max(canvasW / srcW, canvasH / srcH);
      drawW = Math.round(srcW * scale);
      drawH = Math.round(srcH * scale);
      drawX = Math.round((canvasW - drawW) / 2);
      drawY = Math.round((canvasH - drawH) / 2);
    } else {
      // 'contain' or 'inside'
      const scale = Math.min(canvasW / srcW, canvasH / srcH);
      drawW = Math.round(srcW * scale);
      drawH = Math.round(srcH * scale);
      drawX = Math.round((canvasW - drawW) / 2);
      drawY = Math.round((canvasH - drawH) / 2);
    }
  }

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
    throw new Error('Failed to acquire 2D canvas context.');
  }

  try {
    // Fill white background for JPEG/BMP to handle alpha transparency cleanly
    if (tgt === 'jpg' || tgt === 'jpeg' || tgt === 'bmp') {
      ctx.fillStyle = '#FFFFFF';
      ctx.fillRect(0, 0, canvasW, canvasH);
    }

    ctx.drawImage(bitmap, drawX, drawY, drawW, drawH);
  } finally {
    bitmap.close();
  }

  const quality = (options.quality ?? 85) / 100;
  const normalizedTgt = tgt === 'jpg' ? 'jpeg' : tgt;
  const mimeType = CANVAS_MIME_MAP[normalizedTgt] || 'application/octet-stream';

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

  let outBlob: Blob;
  if ('convertToBlob' in canvas && typeof canvas.convertToBlob === 'function') {
    outBlob = await canvas.convertToBlob({ type: mimeType, quality });
  } else if ('toBlob' in canvas && typeof canvas.toBlob === 'function') {
    outBlob = await new Promise<Blob>((resolve, reject) => {
      (canvas as HTMLCanvasElement).toBlob(
        (b) => (b ? resolve(b) : reject(new Error('Canvas export to blob failed'))),
        mimeType,
        quality
      );
    });
  } else {
    throw new Error('Canvas blob export not supported in this environment.');
  }

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
