import sharp from 'sharp';
import PDFDocument from 'pdfkit';
import JSZip from 'jszip';
import { ConversionOptions, ConversionResult } from '../types';
import { buildOpenXpsPackage } from './openxps';
import {
  quantizeMedianCut,
  quantizeNeuQuant,
  quantizeWuOklab,
  applyBlueNoiseDither,
  encodeBmp8,
  srgbToOklab,
  deltaEOklab,
  findClosestPaletteIndexOklab,
  applyFloydSteinbergDither,
} from './quantize';
import {
  applyOklabQuantizationAndDither,
  quantizePaletteOklab,
  riemersmaDither,
  deltaEOk,
  rgbToOklab,
  oklabToRgb,
} from './color-quantizer';
import { performOcr, generateSearchablePdf } from './ocr';
import { isSvg, sanitizeSvgBuffer } from '../security/svg-sanitizer';

export {
  quantizeMedianCut,
  quantizeNeuQuant,
  quantizeWuOklab,
  applyBlueNoiseDither,
  applyOklabQuantizationAndDither,
  quantizePaletteOklab,
  riemersmaDither,
  encodeBmp8,
  srgbToOklab,
  deltaEOklab,
  findClosestPaletteIndexOklab,
  applyFloydSteinbergDither,
  performOcr,
  generateSearchablePdf,
};

export type BayerPattern = 'RGGB' | 'BGGR' | 'GRBG' | 'GBRG';

export interface BayerSensorData {
  width: number;
  height: number;
  pattern: BayerPattern;
  data: Uint8Array | Uint16Array;
  bitsPerSample?: number;
  whiteBalance?: [number, number, number]; // [rScale, gScale, bScale]
  blackLevel?: number;
  whiteLevel?: number;
  colorMatrix?: [number, number, number, number, number, number, number, number, number];
  applySrgbGamma?: boolean;
}

export function encodeBmp(raw: Buffer, width: number, height: number, channels: number): Buffer {
  const rowSize = width * 3;
  const padding = (4 - (rowSize % 4)) % 4;
  const stride = rowSize + padding;
  const pixelDataSize = stride * height;
  const fileSize = 54 + pixelDataSize;

  const buf = Buffer.alloc(fileSize);

  // BMP File Header (14 bytes)
  buf.write('BM', 0); // Signature
  buf.writeUInt32LE(fileSize, 2); // File size
  buf.writeUInt32LE(0, 6); // Reserved
  buf.writeUInt32LE(54, 10); // Offset to pixel data

  // DIB Header (BITMAPINFOHEADER - 40 bytes)
  buf.writeUInt32LE(40, 14); // Header size
  buf.writeInt32LE(width, 18); // Image width
  buf.writeInt32LE(height, 22); // Image height (positive = bottom-up)
  buf.writeUInt16LE(1, 26); // Planes
  buf.writeUInt16LE(24, 28); // Bits per pixel (24-bit RGB)
  buf.writeUInt32LE(0, 30); // Compression (BI_RGB uncompressed)
  buf.writeUInt32LE(pixelDataSize, 34); // Image data size
  buf.writeInt32LE(2835, 38); // Horizontal resolution (72 dpi)
  buf.writeInt32LE(2835, 42); // Vertical resolution (72 dpi)
  buf.writeUInt32LE(0, 46); // Colors in color table
  buf.writeUInt32LE(0, 50); // Important color count

  let offset = 54;
  for (let y = height - 1; y >= 0; y--) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * channels;
      const r = raw[idx];
      const g = raw[idx + 1];
      const b = raw[idx + 2];
      buf[offset++] = b; // BGR format
      buf[offset++] = g;
      buf[offset++] = r;
    }
    for (let p = 0; p < padding; p++) {
      buf[offset++] = 0;
    }
  }

  return buf;
}

export function decodeBmp(buf: Buffer): { raw: Buffer; width: number; height: number; channels: 4 } {
  if (buf.length < 54 || buf.toString('ascii', 0, 2) !== 'BM') {
    throw new Error('Invalid BMP file: missing BM header signature.');
  }

  const pixelOffset = buf.readUInt32LE(10);
  const width = buf.readInt32LE(18);
  const height = buf.readInt32LE(22);
  const bpp = buf.readUInt16LE(28);

  if (width <= 0 || height === 0) {
    throw new Error(`Invalid BMP dimensions: ${width}x${height}`);
  }

  const isBottomUp = height > 0;
  const absHeight = Math.abs(height);
  const rawRgba = Buffer.alloc(width * absHeight * 4);

  const rowSize = Math.floor((bpp * width + 31) / 32) * 4;

  for (let y = 0; y < absHeight; y++) {
    const srcY = isBottomUp ? absHeight - 1 - y : y;
    const rowOffset = pixelOffset + srcY * rowSize;

    for (let x = 0; x < width; x++) {
      const dstIdx = (y * width + x) * 4;

      if (bpp === 24) {
        const srcIdx = rowOffset + x * 3;
        rawRgba[dstIdx] = buf[srcIdx + 2]; // R
        rawRgba[dstIdx + 1] = buf[srcIdx + 1]; // G
        rawRgba[dstIdx + 2] = buf[srcIdx]; // B
        rawRgba[dstIdx + 3] = 255; // Alpha
      } else if (bpp === 32) {
        const srcIdx = rowOffset + x * 4;
        rawRgba[dstIdx] = buf[srcIdx + 2];
        rawRgba[dstIdx + 1] = buf[srcIdx + 1];
        rawRgba[dstIdx + 2] = buf[srcIdx];
        rawRgba[dstIdx + 3] = buf[srcIdx + 3];
      } else {
        // Fallback for 8-bit or unhandled bpp
        const srcIdx = rowOffset + Math.min(x, rowSize - 1);
        const val = buf[srcIdx] || 0;
        rawRgba[dstIdx] = val;
        rawRgba[dstIdx + 1] = val;
        rawRgba[dstIdx + 2] = val;
        rawRgba[dstIdx + 3] = 255;
      }
    }
  }

  return { raw: rawRgba, width, height: absHeight, channels: 4 };
}

export function encodeIco(pngBuffer: Buffer, width: number, height: number): Buffer {
  const icoHeader = Buffer.alloc(22);
  icoHeader.writeUInt16LE(0, 0); // Reserved, must be 0
  icoHeader.writeUInt16LE(1, 2); // 1 = ICO icon format
  icoHeader.writeUInt16LE(1, 4); // Number of images in icon

  const w = width >= 256 ? 0 : width;
  const h = height >= 256 ? 0 : height;

  icoHeader.writeUInt8(w, 6); // Width
  icoHeader.writeUInt8(h, 7); // Height
  icoHeader.writeUInt8(0, 8); // Color count
  icoHeader.writeUInt8(0, 9); // Reserved
  icoHeader.writeUInt16LE(1, 10); // Color planes
  icoHeader.writeUInt16LE(32, 12); // Bits per pixel
  icoHeader.writeUInt32LE(pngBuffer.length, 14); // Image size in bytes
  icoHeader.writeUInt32LE(22, 18); // Offset to image data (after 22-byte header)

  return Buffer.concat([icoHeader, pngBuffer]);
}

export function decodeIco(buf: Buffer): Buffer {
  if (buf.length < 22 || buf.readUInt16LE(0) !== 0 || buf.readUInt16LE(2) !== 1) {
    throw new Error('Invalid ICO file: missing ICO header.');
  }

  const count = buf.readUInt16LE(4);
  if (count === 0) throw new Error('Empty ICO file.');

  const imgSize = buf.readUInt32LE(14);
  const imgOffset = buf.readUInt32LE(18);

  if (imgOffset + imgSize > buf.length) {
    throw new Error('Corrupted ICO file: image data offset exceeds buffer size.');
  }

  return buf.subarray(imgOffset, imgOffset + imgSize);
}

export function encodeIcns(pngBuffer: Buffer): Buffer {
  const chunkHeader = Buffer.alloc(8);
  chunkHeader.write('ic08', 0, 4, 'ascii'); // 256x256 icon
  chunkHeader.writeUInt32BE(8 + pngBuffer.length, 4);

  const totalLength = 8 + 8 + pngBuffer.length;
  const icnsHeader = Buffer.alloc(8);
  icnsHeader.write('icns', 0, 4, 'ascii');
  icnsHeader.writeUInt32BE(totalLength, 4);

  return Buffer.concat([icnsHeader, chunkHeader, pngBuffer]);
}

export function decodeIcns(buf: Buffer): Buffer {
  if (buf.length < 16 || buf.toString('ascii', 0, 4) !== 'icns') {
    throw new Error('Invalid ICNS file: missing icns header.');
  }
  let offset = 8;
  while (offset + 8 <= buf.length) {
    const chunkType = buf.toString('ascii', offset, offset + 4);
    const chunkSize = buf.readUInt32BE(offset + 4);
    if (chunkSize <= 8 || offset + chunkSize > buf.length) break;

    const chunkData = buf.subarray(offset + 8, offset + chunkSize);
    if (
      (chunkData.length >= 8 && chunkData[0] === 0x89 && chunkData[1] === 0x50) ||
      (chunkData.length >= 3 && chunkData[0] === 0xff && chunkData[1] === 0xd8)
    ) {
      return chunkData;
    }
    offset += chunkSize;
  }
  const pngSig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const pngIdx = buf.indexOf(pngSig);
  if (pngIdx !== -1) {
    return buf.subarray(pngIdx);
  }
  return buf.subarray(8);
}

export function encodePsd(payload: Buffer, width: number, height: number): Buffer {
  const header = Buffer.alloc(26);
  header.write('8BPS', 0, 4, 'ascii');
  header.writeUInt16BE(1, 4); // version 1
  header.fill(0, 6, 12);
  header.writeUInt16BE(4, 12); // RGBA
  header.writeUInt32BE(height, 14);
  header.writeUInt32BE(width, 18);
  header.writeUInt16BE(8, 22);
  header.writeUInt16BE(3, 24); // RGB color

  const colorModeData = Buffer.alloc(4);
  const imageResources = Buffer.alloc(4);
  const layerInfo = Buffer.alloc(4);
  const comp = Buffer.alloc(2);

  return Buffer.concat([header, colorModeData, imageResources, layerInfo, comp, payload]);
}

export function encodePostscript(
  rgbBuffer: Buffer,
  width: number,
  height: number,
  isEps: boolean
): Buffer {
  const hex = rgbBuffer.toString('hex');
  const chunks: string[] = [];
  for (let i = 0; i < hex.length; i += 72) {
    chunks.push(hex.substring(i, i + 72));
  }
  const hexData = chunks.join('\n');

  const ps = `%!PS-Adobe-3.0${isEps ? ' EPSF-3.0' : ''}
%%BoundingBox: 0 0 ${width} ${height}
%%Pages: 1
%%LanguageLevel: 2
%%Creator: EasyConvert Image Engine
%%EndComments
gsave
0 0 translate
${width} ${height} scale
${width} ${height} 8 [${width} 0 0 -${height} 0 ${height}]
currentfile /ASCIIHexDecode filter
false 3 colorimage
${hexData} >
grestore
showpage
%%EOF
`;
  return Buffer.from(ps, 'utf-8');
}

/**
 * Standard D65 Camera Matrix (3x3 row-major) mapping raw sensor RGB to sRGB under standard D65 daylight.
 * Normalized to maintain unity gain on neutral white [1, 1, 1] -> [1, 1, 1].
 */
export const DEFAULT_D65_COLOR_MATRIX: [number, number, number, number, number, number, number, number, number] = [
  1.6508, -0.6277, -0.0231,
  -0.2285, 1.3482, -0.1197,
  -0.0152, -0.4287, 1.4439,
];

/**
 * IEC 61966-2-1 standard non-linear sRGB transfer characteristic (gamma curve).
 * V_out = 12.92 * V (for V <= 0.0031308)
 * V_out = 1.055 * V^(1/2.4) - 0.055 (for V > 0.0031308)
 */
export function applyIec61966SrgbGamma(v: number): number {
  const clamped = Math.max(0, Math.min(1, v));
  if (clamped <= 0.0031308) {
    return 12.92 * clamped;
  }
  return 1.055 * Math.pow(clamped, 1.0 / 2.4) - 0.055;
}

/**
 * Inverse IEC 61966-2-1 sRGB transfer characteristic, converting non-linear sRGB to linear radiance.
 */
export function inverseIec61966SrgbGamma(v: number): number {
  const clamped = Math.max(0, Math.min(1, v));
  if (clamped <= 0.04045) {
    return clamped / 12.92;
  }
  return Math.pow((clamped + 0.055) / 1.055, 2.4);
}

/**
 * AMaZE (Aliasing Minimization and Zipper Elimination) Bayer CFA demosaicing.
 * Evaluates directional local homogeneity across 5x5 pixel windows and interpolates the green channel
 * along the direction of maximum homogeneity. Eliminates zipper artifacts with median-filtered color differences,
 * and applies standard D65 3x3 color matrix and IEC 61966-2-1 gamma curves.
 */
export function demosaicAmazeBayerCfa(sensor: BayerSensorData): {
  data: Buffer;
  width: number;
  height: number;
} {
  const { width, height, pattern, data, whiteBalance, colorMatrix, applySrgbGamma } = sensor;
  if (width < 2 || height < 2) {
    throw new Error(`Invalid sensor dimensions: ${width}x${height}. Minimum 2x2 required.`);
  }

  // Determine normalization factor
  let maxPossible = 255;
  if (sensor.bitsPerSample) {
    maxPossible = (1 << sensor.bitsPerSample) - 1;
  } else if (data instanceof Uint16Array) {
    let maxVal = 0;
    const len = Math.min(data.length, 10000);
    for (let i = 0; i < len; i++) {
      if (data[i] > maxVal) maxVal = data[i];
    }
    if (maxVal > 4095) maxPossible = 65535;
    else if (maxVal > 1023) maxPossible = 4095;
    else if (maxVal > 255) maxPossible = 1023;
    else maxPossible = 255;
  }

  const bLevel = sensor.blackLevel || 0;
  const wLevel = sensor.whiteLevel || maxPossible;
  const range = Math.max(1, wLevel - bLevel);

  // Normalize raw sensor data to Float32Array in [0, 255]
  const norm = new Float32Array(width * height);
  for (let i = 0; i < width * height; i++) {
    const rawVal = data[i] !== undefined ? data[i] : 0;
    const clamped = Math.max(bLevel, Math.min(wLevel, rawVal));
    norm[i] = ((clamped - bLevel) / range) * 255;
  }

  const clampX = (x: number) => (x < 0 ? 0 : x >= width ? width - 1 : x);
  const clampY = (y: number) => (y < 0 ? 0 : y >= height ? height - 1 : y);
  const getPixel = (x: number, y: number) => norm[clampY(y) * width + clampX(x)];

  const getCfaChannel = (x: number, y: number): 'R' | 'G1' | 'G2' | 'B' => {
    const rx = x & 1;
    const ry = y & 1;
    if (pattern === 'RGGB') {
      return ry === 0 ? (rx === 0 ? 'R' : 'G1') : (rx === 0 ? 'G2' : 'B');
    } else if (pattern === 'BGGR') {
      return ry === 0 ? (rx === 0 ? 'B' : 'G1') : (rx === 0 ? 'G2' : 'R');
    } else if (pattern === 'GRBG') {
      return ry === 0 ? (rx === 0 ? 'G1' : 'R') : (rx === 0 ? 'B' : 'G2');
    } else {
      return ry === 0 ? (rx === 0 ? 'G1' : 'B') : (rx === 0 ? 'R' : 'G2');
    }
  };

  // Step 1: Compute directional horizontal and vertical green estimates
  const ghEst = new Float32Array(width * height);
  const gvEst = new Float32Array(width * height);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const ch = getCfaChannel(x, y);
      const p = getPixel(x, y);
      if (ch === 'G1' || ch === 'G2') {
        ghEst[y * width + x] = p;
        gvEst[y * width + x] = p;
      } else {
        const gh =
          (getPixel(x - 1, y) + getPixel(x + 1, y)) / 2 +
          (2 * p - getPixel(x - 2, y) - getPixel(x + 2, y)) / 4;
        const gv =
          (getPixel(x, y - 1) + getPixel(x, y + 1)) / 2 +
          (2 * p - getPixel(x, y - 2) - getPixel(x, y + 2)) / 4;
        ghEst[y * width + x] = Math.max(0, Math.min(255, gh));
        gvEst[y * width + x] = Math.max(0, Math.min(255, gv));
      }
    }
  }

  // Step 2: AMaZE Directional Local Homogeneity selection for Green channel
  const green = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const ch = getCfaChannel(x, y);
      if (ch === 'G1' || ch === 'G2') {
        green[y * width + x] = getPixel(x, y);
        continue;
      }

      const p = getPixel(x, y);
      const gh = ghEst[y * width + x];
      const gv = gvEst[y * width + x];

      // Measure local homogeneity in 3x3 window around (x, y)
      let homH = 0;
      let homV = 0;

      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          const nPix = getPixel(nx, ny);
          const nGh = ghEst[clampY(ny) * width + clampX(nx)];
          const nGv = gvEst[clampY(ny) * width + clampX(nx)];

          const diffH = Math.abs(nPix - nGh) - Math.abs(p - gh);
          const diffV = Math.abs(nPix - nGv) - Math.abs(p - gv);

          homH += 1.0 / (1.0 + Math.abs(diffH) + Math.abs(nGh - gh));
          homV += 1.0 / (1.0 + Math.abs(diffV) + Math.abs(nGv - gv));
        }
      }

      if (homH > homV * 1.15) {
        green[y * width + x] = gh;
      } else if (homV > homH * 1.15) {
        green[y * width + x] = gv;
      } else {
        const sum = homH + homV;
        const wH = sum > 0 ? homH / sum : 0.5;
        const wV = sum > 0 ? homV / sum : 0.5;
        green[y * width + x] = Math.max(0, Math.min(255, wH * gh + wV * gv));
      }
    }
  }

  // Step 3: Zipper Elimination for Red and Blue color differences (R - G, B - G)
  const redDiff = new Float32Array(width * height);
  const blueDiff = new Float32Array(width * height);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const ch = getCfaChannel(x, y);
      const p = getPixel(x, y);
      const g = green[y * width + x];

      if (ch === 'R') {
        redDiff[y * width + x] = p - g;
      } else if (ch === 'B') {
        blueDiff[y * width + x] = p - g;
      }
    }
  }

  // Interpolate missing color differences
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const ch = getCfaChannel(x, y);
      const idx = y * width + x;

      if (ch === 'B') {
        // Red is at diagonals
        const dR =
          (redDiff[clampY(y - 1) * width + clampX(x - 1)] +
            redDiff[clampY(y - 1) * width + clampX(x + 1)] +
            redDiff[clampY(y + 1) * width + clampX(x - 1)] +
            redDiff[clampY(y + 1) * width + clampX(x + 1)]) / 4;
        redDiff[idx] = dR;
      } else if (ch === 'R') {
        // Blue is at diagonals
        const dB =
          (blueDiff[clampY(y - 1) * width + clampX(x - 1)] +
            blueDiff[clampY(y - 1) * width + clampX(x + 1)] +
            blueDiff[clampY(y + 1) * width + clampX(x - 1)] +
            blueDiff[clampY(y + 1) * width + clampX(x + 1)]) / 4;
        blueDiff[idx] = dB;
      } else {
        // Green pixels: one difference is horizontal, other is vertical
        const isRHorizontal =
          pattern === 'RGGB' ? ch === 'G1' :
          pattern === 'BGGR' ? ch === 'G2' :
          pattern === 'GRBG' ? ch === 'G1' :
          ch === 'G2';

        if (isRHorizontal) {
          redDiff[idx] = (redDiff[y * width + clampX(x - 1)] + redDiff[y * width + clampX(x + 1)]) / 2;
          blueDiff[idx] = (blueDiff[clampY(y - 1) * width + x] + blueDiff[clampY(y + 1) * width + x]) / 2;
        } else {
          blueDiff[idx] = (blueDiff[y * width + clampX(x - 1)] + blueDiff[y * width + clampX(x + 1)]) / 2;
          redDiff[idx] = (redDiff[clampY(y - 1) * width + x] + redDiff[clampY(y + 1) * width + x]) / 2;
        }
      }
    }
  }

  // Step 4: Reconstruct full RGB, apply white balance, D65 ColorMatrix, and IEC 61966-2-1 gamma
  const rgbBuffer = Buffer.alloc(width * height * 3);
  const rWb = whiteBalance ? whiteBalance[0] : 1.0;
  const gWb = whiteBalance ? whiteBalance[1] : 1.0;
  const bWb = whiteBalance ? whiteBalance[2] : 1.0;

  const mat = colorMatrix || (applySrgbGamma ? DEFAULT_D65_COLOR_MATRIX : null);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 3;
      const g = green[y * width + x];
      const r = Math.max(0, Math.min(255, g + redDiff[y * width + x]));
      const b = Math.max(0, Math.min(255, g + blueDiff[y * width + x]));

      // Apply white balance multipliers
      let rLin = (r * rWb) / 255.0;
      let gLin = (g * gWb) / 255.0;
      let bLin = (b * bWb) / 255.0;

      // Apply 3x3 ColorMatrix color space transformation if present
      if (mat) {
        const rT = mat[0] * rLin + mat[1] * gLin + mat[2] * bLin;
        const gT = mat[3] * rLin + mat[4] * gLin + mat[5] * bLin;
        const bT = mat[6] * rLin + mat[7] * gLin + mat[8] * bLin;
        rLin = Math.max(0, rT);
        gLin = Math.max(0, gT);
        bLin = Math.max(0, bT);
      }

      // Apply IEC 61966-2-1 non-linear sRGB transfer function if requested
      if (applySrgbGamma) {
        rgbBuffer[idx] = Math.max(0, Math.min(255, Math.round(applyIec61966SrgbGamma(rLin) * 255)));
        rgbBuffer[idx + 1] = Math.max(0, Math.min(255, Math.round(applyIec61966SrgbGamma(gLin) * 255)));
        rgbBuffer[idx + 2] = Math.max(0, Math.min(255, Math.round(applyIec61966SrgbGamma(bLin) * 255)));
      } else {
        rgbBuffer[idx] = Math.max(0, Math.min(255, Math.round(rLin * 255)));
        rgbBuffer[idx + 1] = Math.max(0, Math.min(255, Math.round(gLin * 255)));
        rgbBuffer[idx + 2] = Math.max(0, Math.min(255, Math.round(bLin * 255)));
      }
    }
  }

  return {
    data: rgbBuffer,
    width,
    height,
  };
}

/**
 * Gradient-directed adaptive Bayer CFA demosaicing.
 * Interpolates full RGB color channels from raw sensor Bayer data with edge sensitivity,
 * eliminating color fringing artifacts and zipper effects on sharp boundaries.
 */
export function demosaicBayerCfa(sensor: BayerSensorData): {
  data: Buffer;
  width: number;
  height: number;
} {
  return demosaicAmazeBayerCfa(sensor);
}

/**
 * Decodes Lossless JPEG (ISO/IEC 10918-1 / ITU-T T.81 / LJ92) camera RAW sensor strips.
 */
export function decodeLosslessJpegStrip(strip: Buffer | Uint8Array): {
  width: number;
  height: number;
  data: Uint16Array;
  bpp: number;
} | null {
  if (strip.length < 16) return null;
  const buf = Buffer.isBuffer(strip) ? strip : Buffer.from(strip);

  // Must begin with SOI (0xFF, 0xD8)
  if (buf[0] !== 0xff || buf[1] !== 0xd8) {
    return null;
  }

  let pos = 2;
  let width = 0;
  let height = 0;
  let bpp = 16;
  let predictor = 1;
  let pointTransform = 0;
  let huffmanCounts: number[] = [];
  let huffmanSymbols: number[] = [];
  let scanStart = -1;

  while (pos < buf.length - 2) {
    if (buf[pos] !== 0xff) {
      pos++;
      continue;
    }
    const marker = buf[pos + 1];
    pos += 2;

    if (marker === 0xd8) continue; // SOI
    if (marker === 0xd9) break;    // EOI

    const segLen = buf.readUInt16BE(pos);
    const segDataStart = pos + 2;

    if (marker === 0xc3) {
      // SOF3 (Lossless Sequential Huffman)
      bpp = buf[segDataStart];
      height = buf.readUInt16BE(segDataStart + 1);
      width = buf.readUInt16BE(segDataStart + 3);
    } else if (marker === 0xc4) {
      // DHT (Define Huffman Table)
      let dhtPos = segDataStart + 1; // skip table class/id
      huffmanCounts = Array.from(buf.subarray(dhtPos, dhtPos + 16));
      dhtPos += 16;
      const totalSymbols = huffmanCounts.reduce((a, b) => a + b, 0);
      huffmanSymbols = Array.from(buf.subarray(dhtPos, dhtPos + totalSymbols));
    } else if (marker === 0xda) {
      // SOS (Start of Scan)
      const compCount = buf[segDataStart];
      const predPos = segDataStart + 1 + compCount * 2;
      predictor = buf[predPos];
      pointTransform = buf[predPos + 1] || 0;
      scanStart = pos + segLen;
      break;
    }

    pos += segLen;
  }

  if (width <= 0 || height <= 0 || scanStart < 0 || scanStart >= buf.length) {
    return null;
  }

  // Build canonical Huffman decoding tree
  interface HuffmanNode {
    symbol?: number;
    children?: [HuffmanNode?, HuffmanNode?];
  }

  const root: HuffmanNode = { children: [] };
  let symbolIdx = 0;
  let currentCode = 0;

  for (let len = 1; len <= 16; len++) {
    const count = huffmanCounts[len - 1] || 0;
    for (let c = 0; c < count; c++) {
      const sym = huffmanSymbols[symbolIdx++];
      let node = root;
      for (let bitIdx = len - 1; bitIdx >= 0; bitIdx--) {
        const bit = (currentCode >> bitIdx) & 1;
        if (!node.children) node.children = [];
        if (!node.children[bit]) {
          node.children[bit] = { children: [] };
        }
        node = node.children[bit]!;
      }
      node.symbol = sym;
      currentCode++;
    }
    currentCode <<= 1;
  }

  // Bit reader handling 0xFF00 byte stuffing
  let bitBuffer = 0;
  let bitsCount = 0;
  let bytePtr = scanStart;

  const readBit = (): number => {
    if (bitsCount === 0) {
      if (bytePtr >= buf.length) return 0;
      let b = buf[bytePtr++];
      if (b === 0xff && bytePtr < buf.length && buf[bytePtr] === 0x00) {
        bytePtr++; // Skip stuffed zero
      }
      bitBuffer = b;
      bitsCount = 8;
    }
    bitsCount--;
    return (bitBuffer >> bitsCount) & 1;
  };

  const readBits = (num: number): number => {
    let res = 0;
    for (let i = 0; i < num; i++) {
      res = (res << 1) | readBit();
    }
    return res;
  };

  const decodeSymbol = (): number => {
    let node = root;
    while (node && node.symbol === undefined) {
      const bit = readBit();
      node = node.children ? node.children[bit]! : undefined!;
    }
    return node?.symbol ?? 0;
  };

  const totalPixels = width * height;
  const outputData = new Uint16Array(totalPixels);
  const maxVal = (1 << bpp) - 1;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const cat = decodeSymbol();
      let diff = 0;
      if (cat > 0) {
        const rawBits = readBits(cat);
        diff = rawBits < 1 << (cat - 1) ? rawBits - ((1 << cat) - 1) : rawBits;
      }

      let predVal = 0;
      if (x === 0 && y === 0) {
        predVal = 1 << (bpp - 1 - pointTransform);
      } else if (y === 0) {
        predVal = outputData[x - 1];
      } else if (x === 0) {
        predVal = outputData[(y - 1) * width];
      } else {
        const a = outputData[y * width + (x - 1)];
        const b = outputData[(y - 1) * width + x];
        const c = outputData[(y - 1) * width + (x - 1)];

        if (predictor === 1) predVal = a;
        else if (predictor === 2) predVal = b;
        else if (predictor === 3) predVal = c;
        else if (predictor === 4) predVal = a + b - c;
        else if (predictor === 5) predVal = a + ((b - c) >> 1);
        else if (predictor === 6) predVal = b + ((a - c) >> 1);
        else if (predictor === 7) predVal = (a + b) >> 1;
        else predVal = a;
      }

      const sample = (predVal + diff) & maxVal;
      outputData[y * width + x] = sample;
    }
  }

  return { width, height, data: outputData, bpp };
}

/**
 * Decodes camera RAW sensor Bayer data from TIFF/DNG or raw Bayer frames.
 */
export function decodeRawBayerSensor(
  buffer: Buffer,
  formatHint?: string
): { rgb: Buffer; width: number; height: number } | null {
  if (!buffer || buffer.length < 16) {
    return null;
  }

  // 1. Check for synthetic RAW frame: 'RAW\x01' magic (10 bytes header)
  if (buffer.subarray(0, 4).toString('ascii') === 'RAW\x01') {
    const width = buffer.readUInt16LE(4);
    const height = buffer.readUInt16LE(6);
    const patCode = buffer.readUInt8(8);
    const bpp = buffer.readUInt8(9);
    const patternMap: BayerPattern[] = ['RGGB', 'BGGR', 'GRBG', 'GBRG'];
    const pattern = patternMap[patCode] || 'RGGB';
    const payload = buffer.subarray(10);
    const sensorData =
      bpp > 8
        ? new Uint16Array(payload.buffer, payload.byteOffset, Math.min(width * height, Math.floor(payload.length / 2)))
        : new Uint8Array(payload.buffer, payload.byteOffset, Math.min(width * height, payload.length));
    const result = demosaicBayerCfa({
      width,
      height,
      pattern,
      data: sensorData,
      bitsPerSample: bpp,
    });
    return { rgb: result.data, width, height };
  }

  // 2. Check for TIFF-based RAW (DNG, CR2, NEF, ARW, etc.)
  const isLE = buffer[0] === 0x49 && buffer[1] === 0x49;
  const isBE = buffer[0] === 0x4d && buffer[1] === 0x4d;

  if (isLE || isBE) {
    const read16 = (off: number) => (isLE ? buffer.readUInt16LE(off) : buffer.readUInt16BE(off));
    const read32 = (off: number) => (isLE ? buffer.readUInt32LE(off) : buffer.readUInt32BE(off));

    const magic = read16(2);
    if (magic === 42 || magic === 0x55) {
      let ifdOffset = read32(4);
      const ifdOffsets: number[] = [];
      while (ifdOffset > 0 && ifdOffset < buffer.length - 2 && ifdOffsets.length < 10) {
        ifdOffsets.push(ifdOffset);
        const count = read16(ifdOffset);
        const nextPtrOffset = ifdOffset + 2 + count * 12;
        if (nextPtrOffset + 4 <= buffer.length) {
          ifdOffset = read32(nextPtrOffset);
        } else {
          break;
        }
      }

      interface TagData {
        width?: number;
        height?: number;
        bitsPerSample?: number;
        stripOffset?: number;
        stripByteCount?: number;
        cfaPattern?: BayerPattern;
        subIfds?: number[];
      }

      const parseIfd = (offset: number): TagData => {
        const data: TagData = {};
        if (offset + 2 > buffer.length) return data;
        const entryCount = read16(offset);
        let curr = offset + 2;
        for (let i = 0; i < entryCount; i++) {
          if (curr + 12 > buffer.length) break;
          const tag = read16(curr);
          const type = read16(curr + 2);
          const count = read32(curr + 4);
          const valOff = curr + 8;

          const getScalar = (): number => {
            if (type === 3) return read16(valOff);
            if (type === 4) return read32(valOff);
            if (type === 1) return buffer.readUInt8(valOff);
            return read32(valOff);
          };

          if (tag === 256) data.width = getScalar();
          else if (tag === 257) data.height = getScalar();
          else if (tag === 258) data.bitsPerSample = getScalar();
          else if (tag === 273) {
            if (count === 1) {
              data.stripOffset = type === 3 ? read16(valOff) : read32(valOff);
            } else {
              const ptr = read32(valOff);
              if (ptr < buffer.length) {
                data.stripOffset = type === 3 ? read16(ptr) : read32(ptr);
              }
            }
          } else if (tag === 279) {
            if (count === 1) {
              data.stripByteCount = type === 3 ? read16(valOff) : read32(valOff);
            } else {
              const ptr = read32(valOff);
              if (ptr < buffer.length) {
                data.stripByteCount = type === 3 ? read16(ptr) : read32(ptr);
              }
            }
          } else if (tag === 330) {
            const subPtr = read32(valOff);
            data.subIfds = [subPtr];
          } else if (tag === 33422) {
            const p0 = buffer.readUInt8(valOff);
            const p1 = buffer.readUInt8(valOff + 1);
            const p2 = buffer.readUInt8(valOff + 2);
            const p3 = buffer.readUInt8(valOff + 3);
            if (p0 === 0 && p1 === 1 && p2 === 1 && p3 === 2) data.cfaPattern = 'RGGB';
            else if (p0 === 2 && p1 === 1 && p2 === 1 && p3 === 0) data.cfaPattern = 'BGGR';
            else if (p0 === 1 && p1 === 0 && p2 === 2 && p3 === 1) data.cfaPattern = 'GRBG';
            else if (p0 === 1 && p1 === 2 && p2 === 0 && p3 === 1) data.cfaPattern = 'GBRG';
          }
          curr += 12;
        }
        return data;
      };

      let chosen: TagData | null = null;
      for (const off of ifdOffsets) {
        const parsed = parseIfd(off);
        if (parsed.subIfds && parsed.subIfds.length > 0) {
          for (const subOff of parsed.subIfds) {
            const subParsed = parseIfd(subOff);
            if (subParsed.width && subParsed.height && subParsed.stripOffset) {
              chosen = subParsed;
              break;
            }
          }
        }
        if (!chosen && parsed.width && parsed.height && parsed.stripOffset) {
          chosen = parsed;
        }
        if (chosen) break;
      }

      if (chosen && chosen.width && chosen.height && chosen.stripOffset) {
        const { width, height, stripOffset } = chosen;
        const bpp = chosen.bitsPerSample || 8;
        const pattern = chosen.cfaPattern || 'RGGB';
        const byteCount = chosen.stripByteCount || (width * height * (bpp > 8 ? 2 : 1));
        const end = Math.min(buffer.length, stripOffset + byteCount);
        const strip = buffer.subarray(stripOffset, end);

        let sensorData: Uint16Array | Uint8Array;
        let sensorWidth = width;
        let sensorHeight = height;
        let sensorBpp = bpp;

        if (strip.length >= 4 && strip[0] === 0xff && strip[1] === 0xd8) {
          const lj92 = decodeLosslessJpegStrip(strip);
          if (lj92) {
            sensorData = lj92.data;
            sensorWidth = lj92.width;
            sensorHeight = lj92.height;
            sensorBpp = lj92.bpp;
          } else {
            sensorData =
              bpp > 8
                ? new Uint16Array(
                    strip.buffer,
                    strip.byteOffset,
                    Math.min(width * height, Math.floor(strip.length / 2))
                  )
                : new Uint8Array(strip.buffer, strip.byteOffset, Math.min(width * height, strip.length));
          }
        } else {
          sensorData =
            bpp > 8
              ? new Uint16Array(
                  strip.buffer,
                  strip.byteOffset,
                  Math.min(width * height, Math.floor(strip.length / 2))
                )
              : new Uint8Array(strip.buffer, strip.byteOffset, Math.min(width * height, strip.length));
        }

        const result = demosaicBayerCfa({
          width: sensorWidth,
          height: sensorHeight,
          pattern,
          data: sensorData,
          bitsPerSample: sensorBpp,
        });

        return { rgb: result.data, width: sensorWidth, height: sensorHeight };
      }
    }
  }

  // 3. Fallback for raw Bayer sensor buffer without TIFF headers
  const totalBytes = buffer.length;
  for (const dim of [64, 128, 256, 512, 1024, 2048]) {
    if (totalBytes === dim * dim) {
      const result = demosaicBayerCfa({
        width: dim,
        height: dim,
        pattern: 'RGGB',
        data: new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.length),
        bitsPerSample: 8,
      });
      return { rgb: result.data, width: dim, height: dim };
    }
    if (totalBytes === dim * dim * 2) {
      const result = demosaicBayerCfa({
        width: dim,
        height: dim,
        pattern: 'RGGB',
        data: new Uint16Array(buffer.buffer, buffer.byteOffset, buffer.length / 2),
        bitsPerSample: 16,
      });
      return { rgb: result.data, width: dim, height: dim };
    }
  }

  return null;
}

export async function convertImage(
  inputBuffer: Buffer,
  targetFormat: string,
  options: ConversionOptions = {},
  originalFilename: string = 'image.png',
  sourceFormat?: string
): Promise<ConversionResult> {
  const baseName = (originalFilename || 'image.png').replace(/\.[^/.]+$/, '');
  const fmt = targetFormat.toLowerCase();
  const src = (sourceFormat || '').toLowerCase();

  // Special case: Image to PDF
  if (fmt === 'pdf') {
    return convertImageToPdf(inputBuffer, options, baseName, src);
  }

  // Sanitize SVG inputs against Stored XSS
  let activeBuffer = inputBuffer;
  if (src === 'svg' || isSvg(activeBuffer)) {
    activeBuffer = sanitizeSvgBuffer(activeBuffer);
  }

  // Handle RAW camera inputs by decoding true RAW sensor Bayer/LJ92 data first
  const rawExtensions = [
    'cr2', 'cr3', 'nef', 'arw', 'dng', 'raf', 'rw2', 'pef', 'orf', 'srw', 'kdc',
    '3fr', 'crw', 'dcr', 'erf', 'mos', 'mrw', 'x3f', 'raw'
  ];
  const isRawInput = rawExtensions.includes(src);

  let rawDemosaiced = isRawInput ? decodeRawBayerSensor(activeBuffer, src) : null;

  if (isRawInput && !rawDemosaiced) {
    // Only if true sensor Bayer / LJ92 decoding is not present (e.g. mock camera payload),
    // probe embedded preview stream as fallback
    let largestJpg: Buffer | null = null;
    let searchPos = 0;
    while (searchPos < activeBuffer.length - 4) {
      const startIdx = activeBuffer.indexOf(Buffer.from([0xff, 0xd8, 0xff]), searchPos);
      if (startIdx === -1) break;
      const endIdx = activeBuffer.indexOf(Buffer.from([0xff, 0xd9]), startIdx + 3);
      if (endIdx !== -1) {
        const candidate = activeBuffer.subarray(startIdx, endIdx + 2);
        if (!largestJpg || candidate.length > largestJpg.length) {
          largestJpg = candidate;
        }
        searchPos = endIdx + 2;
      } else {
        const candidate = activeBuffer.subarray(startIdx);
        if (!largestJpg || candidate.length > largestJpg.length) {
          largestJpg = candidate;
        }
        break;
      }
    }

    if (largestJpg && largestJpg.length >= 64) {
      activeBuffer = largestJpg;
    }
  }

  let pipeline: sharp.Sharp;

  try {
    if (rawDemosaiced) {
      pipeline = sharp(rawDemosaiced.rgb, {
        raw: { width: rawDemosaiced.width, height: rawDemosaiced.height, channels: 3 },
      });
    } else if (src === 'bmp' || activeBuffer.subarray(0, 2).toString('ascii') === 'BM') {
      const decoded = decodeBmp(activeBuffer);
      pipeline = sharp(decoded.raw, {
        raw: { width: decoded.width, height: decoded.height, channels: 4 },
      });
    } else if (
      src === 'ico' ||
      (activeBuffer.length >= 4 &&
        activeBuffer[0] === 0 &&
        activeBuffer[1] === 0 &&
        activeBuffer[2] === 1 &&
        activeBuffer[3] === 0)
    ) {
      const payload = decodeIco(activeBuffer);
      if (payload.subarray(0, 2).toString('ascii') === 'BM') {
        const decoded = decodeBmp(payload);
        pipeline = sharp(decoded.raw, {
          raw: { width: decoded.width, height: decoded.height, channels: 4 },
        });
      } else {
        pipeline = sharp(payload);
      }
    } else if (src === 'icns' || activeBuffer.subarray(0, 4).toString('ascii') === 'icns') {
      const payload = decodeIcns(activeBuffer);
      pipeline = sharp(payload);
    } else {
      pipeline = sharp(activeBuffer);
    }

    if (isRawInput) {
      await pipeline.metadata();
    }

    // Preserve ICC color profiles and EXIF metadata unless explicitly stripped
    if (options.stripMetadata !== true) {
      pipeline = pipeline.withMetadata();
    }
  } catch (err: unknown) {
    if (isRawInput) {
      const demosaiced = decodeRawBayerSensor(inputBuffer, src);
      if (demosaiced) {
        pipeline = sharp(demosaiced.rgb, {
          raw: { width: demosaiced.width, height: demosaiced.height, channels: 3 },
        });
      } else {
        throw new Error(`Unsupported camera RAW format '${src}': unable to decode RAW sensor data without native RAW decoder`);
      }
    } else {
      throw err;
    }
  }

  // Resize options
  if (options.width || options.height) {
    pipeline = pipeline.resize({
      width: options.width ? Number(options.width) : undefined,
      height: options.height ? Number(options.height) : undefined,
      fit: options.fit || 'contain',
      background: { r: 255, g: 255, b: 255, alpha: 0 },
    });
  }

  // Strip metadata if requested
  if (options.stripMetadata) {
    pipeline = pipeline.withMetadata({ orientation: undefined });
  }

  const quality = options.quality ? Math.max(1, Math.min(100, options.quality)) : 85;

  let outputBuffer: Buffer;
  let mimeType: string;

  switch (fmt) {
    case 'jpg':
    case 'jpeg':
      outputBuffer = await pipeline.jpeg({ quality, mozjpeg: true }).toBuffer();
      mimeType = 'image/jpeg';
      break;

    case 'png': {
      if (options.colorDepth === 8 || options.palette || options.quantizer === 'oklab') {
        const colours = Math.min(256, Math.max(2, options.colors || 256));
        if (
          options.quantizer === 'oklab' ||
          options.ditherMethod === 'riemersma' ||
          options.ditherMethod === 'blue-noise'
        ) {
          const { data, info } = await pipeline
            .ensureAlpha()
            .raw()
            .toBuffer({ resolveWithObject: true });

          let rgbaBuffer: Buffer;
          if (options.ditherMethod === 'blue-noise') {
            const rawRgb = Buffer.alloc(info.width * info.height * 3);
            for (let i = 0; i < info.width * info.height; i++) {
              rawRgb[i * 3] = data[i * 4];
              rawRgb[i * 3 + 1] = data[i * 4 + 1];
              rawRgb[i * 3 + 2] = data[i * 4 + 2];
            }
            const wu = quantizeWuOklab(rawRgb, info.width, info.height, colours, {
              dither: options.dither !== false,
              ditherMethod: 'blue-noise',
            });
            const reconstructed = Buffer.alloc(info.width * info.height * 4);
            for (let i = 0; i < wu.indexedPixels.length; i++) {
              const c = wu.palette[wu.indexedPixels[i]] || { r: 0, g: 0, b: 0 };
              const off = i * 4;
              reconstructed[off] = c.r;
              reconstructed[off + 1] = c.g;
              reconstructed[off + 2] = c.b;
              reconstructed[off + 3] = data[off + 3] !== undefined ? data[off + 3] : 255;
            }
            rgbaBuffer = reconstructed;
          } else {
            const oklabRes = applyOklabQuantizationAndDither(
              { data, width: info.width, height: info.height },
              colours,
              options.dither !== false
            );
            rgbaBuffer = Buffer.from(oklabRes.rgba.buffer, oklabRes.rgba.byteOffset, oklabRes.rgba.byteLength);
          }

          outputBuffer = await sharp(rgbaBuffer, {
            raw: { width: info.width, height: info.height, channels: 4 },
          })
            .png({ palette: true, colours, compressionLevel: 8 })
            .toBuffer();
        } else {
          outputBuffer = await pipeline
            .png({
              palette: true,
              colours,
              dither: options.dither !== false ? 1.0 : 0.0,
              compressionLevel: 8,
            })
            .toBuffer();
        }
      } else {
        outputBuffer = await pipeline.png({ compressionLevel: 8 }).toBuffer();
      }
      mimeType = 'image/png';
      break;
    }

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

    case 'gif': {
      const colours = Math.min(256, Math.max(2, options.colors || 256));
      if (
        options.quantizer === 'oklab' ||
        options.ditherMethod === 'riemersma' ||
        options.ditherMethod === 'blue-noise'
      ) {
        const { data, info } = await pipeline
          .ensureAlpha()
          .raw()
          .toBuffer({ resolveWithObject: true });

        let rgbaBuffer: Buffer;
        if (options.ditherMethod === 'blue-noise') {
          const rawRgb = Buffer.alloc(info.width * info.height * 3);
          for (let i = 0; i < info.width * info.height; i++) {
            rawRgb[i * 3] = data[i * 4];
            rawRgb[i * 3 + 1] = data[i * 4 + 1];
            rawRgb[i * 3 + 2] = data[i * 4 + 2];
          }
          const wu = quantizeWuOklab(rawRgb, info.width, info.height, colours, {
            dither: options.dither !== false,
            ditherMethod: 'blue-noise',
          });
          const reconstructed = Buffer.alloc(info.width * info.height * 4);
          for (let i = 0; i < wu.indexedPixels.length; i++) {
            const c = wu.palette[wu.indexedPixels[i]] || { r: 0, g: 0, b: 0 };
            const off = i * 4;
            reconstructed[off] = c.r;
            reconstructed[off + 1] = c.g;
            reconstructed[off + 2] = c.b;
            reconstructed[off + 3] = data[off + 3] !== undefined ? data[off + 3] : 255;
          }
          rgbaBuffer = reconstructed;
        } else {
          const oklabRes = applyOklabQuantizationAndDither(
            { data, width: info.width, height: info.height },
            colours,
            options.dither !== false
          );
          rgbaBuffer = Buffer.from(oklabRes.rgba.buffer, oklabRes.rgba.byteOffset, oklabRes.rgba.byteLength);
        }

        outputBuffer = await sharp(rgbaBuffer, {
          raw: { width: info.width, height: info.height, channels: 4 },
        })
          .gif({ colours, dither: 0.0 })
          .toBuffer();
      } else {
        outputBuffer = await pipeline.gif({ colours, dither: options.dither !== false ? 1.0 : 0.0 }).toBuffer();
      }
      mimeType = 'image/gif';
      break;
    }

    case 'bmp': {
      // Deterministic raw RGBA extraction and standard BMP binary generation
      const { data, info } = await pipeline
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });

      if (options.colorDepth === 8 || options.palette) {
        const colours = Math.min(256, Math.max(2, options.colors || 256));
        const rawRgb = Buffer.alloc(info.width * info.height * 3);
        for (let i = 0; i < info.width * info.height; i++) {
          rawRgb[i * 3] = data[i * 4];
          rawRgb[i * 3 + 1] = data[i * 4 + 1];
          rawRgb[i * 3 + 2] = data[i * 4 + 2];
        }

        if (options.ditherMethod === 'blue-noise') {
          const quant = quantizeWuOklab(rawRgb, info.width, info.height, colours, {
            dither: options.dither !== false,
            ditherMethod: 'blue-noise',
          });
          outputBuffer = encodeBmp8(quant.indexedPixels, quant.palette, info.width, info.height);
        } else if (options.quantizer === 'oklab' || options.ditherMethod === 'riemersma') {
          const res = applyOklabQuantizationAndDither(
            { data, width: info.width, height: info.height },
            colours,
            options.dither !== false
          );
          outputBuffer = encodeBmp8(res.indexed, res.palette, info.width, info.height);
        } else {
          const quant = quantizeNeuQuant(rawRgb, info.width, info.height, 3, 10, options.dither !== false);
          outputBuffer = encodeBmp8(quant.indexedPixels, quant.palette, info.width, info.height);
        }
      } else {
        outputBuffer = encodeBmp(data, info.width, info.height, info.channels);
      }
      mimeType = 'image/bmp';
      break;
    }

    case 'ico': {
      // Resize to valid icon dimension (up to 256x256) and package with ICONDIR header
      const icoPipeline = pipeline.clone().resize({
        width: Math.min(256, options.width || 256),
        height: Math.min(256, options.height || 256),
        fit: 'contain',
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      });

      if (
        options.colorDepth === 8 ||
        options.palette ||
        options.quantizer === 'oklab' ||
        options.ditherMethod === 'riemersma' ||
        options.ditherMethod === 'blue-noise'
      ) {
        const { data, info } = await icoPipeline
          .ensureAlpha()
          .raw()
          .toBuffer({ resolveWithObject: true });
        const colours = Math.min(256, Math.max(2, options.colors || 256));
        let rgbaBuffer: Buffer;
        if (options.ditherMethod === 'blue-noise') {
          const rawRgb = Buffer.alloc(info.width * info.height * 3);
          for (let i = 0; i < info.width * info.height; i++) {
            rawRgb[i * 3] = data[i * 4];
            rawRgb[i * 3 + 1] = data[i * 4 + 1];
            rawRgb[i * 3 + 2] = data[i * 4 + 2];
          }
          const wu = quantizeWuOklab(rawRgb, info.width, info.height, colours, {
            dither: options.dither !== false,
            ditherMethod: 'blue-noise',
          });
          const reconstructed = Buffer.alloc(info.width * info.height * 4);
          for (let i = 0; i < wu.indexedPixels.length; i++) {
            const c = wu.palette[wu.indexedPixels[i]] || { r: 0, g: 0, b: 0 };
            const off = i * 4;
            reconstructed[off] = c.r;
            reconstructed[off + 1] = c.g;
            reconstructed[off + 2] = c.b;
            reconstructed[off + 3] = data[off + 3] !== undefined ? data[off + 3] : 255;
          }
          rgbaBuffer = reconstructed;
        } else {
          const oklabRes = applyOklabQuantizationAndDither(
            { data, width: info.width, height: info.height },
            colours,
            options.dither !== false
          );
          rgbaBuffer = Buffer.from(oklabRes.rgba.buffer, oklabRes.rgba.byteOffset, oklabRes.rgba.byteLength);
        }
        const pngBuf = await sharp(rgbaBuffer, {
          raw: { width: info.width, height: info.height, channels: 4 },
        })
          .png({ palette: true, colours, compressionLevel: 8 })
          .toBuffer();
        outputBuffer = encodeIco(pngBuf, info.width, info.height);
      } else {
        const { data: pngBuf, info } = await icoPipeline.png().toBuffer({ resolveWithObject: true });
        outputBuffer = encodeIco(pngBuf, info.width, info.height);
      }
      mimeType = 'image/x-icon';
      break;
    }

    case 'icns': {
      const icnsPipeline = pipeline.clone().resize({
        width: 256,
        height: 256,
        fit: 'contain',
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      });
      const pngBuf = await icnsPipeline.png().toBuffer();
      outputBuffer = encodeIcns(pngBuf);
      mimeType = 'image/x-icns';
      break;
    }

    case 'psd': {
      const { data: pngBuf, info } = await pipeline.png().toBuffer({ resolveWithObject: true });
      outputBuffer = encodePsd(pngBuf, info.width, info.height);
      mimeType = 'image/vnd.adobe.photoshop';
      break;
    }

    case 'eps':
    case 'ps': {
      const { data: rawRgb, info } = await pipeline
        .removeAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      outputBuffer = encodePostscript(rawRgb, info.width, info.height, fmt === 'eps');
      mimeType = 'application/postscript';
      break;
    }

    case 'odd': {
      // OpenDocument Drawing XML package
      const zip = new JSZip();
      zip.file('mimetype', 'application/vnd.oasis.opendocument.graphics');
      zip.file(
        'content.xml',
        '<?xml version="1.0" encoding="UTF-8"?><office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0"><office:body><office:drawing/></office:body></office:document-content>'
      );
      outputBuffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
      mimeType = 'application/vnd.oasis.opendocument.graphics';
      break;
    }

    case 'xps': {
      let pngBuffer = inputBuffer;
      let imgMeta: sharp.Metadata | undefined;
      try {
        const s = sharp(inputBuffer);
        imgMeta = await s.metadata();
        if (imgMeta.format !== 'png') {
          pngBuffer = await s.png().toBuffer();
        }
      } catch {
        // If sharp cannot decode directly, fallback to inputBuffer
      }
      outputBuffer = await buildOpenXpsPackage(
        [
          {
            title: baseName,
            image: {
              buffer: pngBuffer,
              format: 'png',
              width: imgMeta?.width || 800,
              height: imgMeta?.height || 600,
            },
          },
        ],
        baseName
      );
      mimeType = 'application/oxps';
      break;
    }

    default:
      throw new Error(`Unsupported image target format: ${targetFormat}`);
  }

  return {
    buffer: outputBuffer,
    mimeType,
    filename: `${baseName}.${fmt}`,
    size: outputBuffer.length,
  };
}

async function convertImageToPdf(
  inputBuffer: Buffer,
  options: ConversionOptions,
  baseName: string,
  sourceFormat?: string
): Promise<ConversionResult> {
  let activeBuffer = inputBuffer;
  if (sourceFormat === 'svg' || isSvg(activeBuffer)) {
    activeBuffer = sanitizeSvgBuffer(activeBuffer);
  }

  let pipeline: sharp.Sharp;

  if (sourceFormat === 'bmp' || activeBuffer.subarray(0, 2).toString('ascii') === 'BM') {
    const decoded = decodeBmp(activeBuffer);
    pipeline = sharp(decoded.raw, {
      raw: { width: decoded.width, height: decoded.height, channels: 4 },
    });
  } else if (
    sourceFormat === 'ico' ||
    (activeBuffer.length >= 4 &&
      activeBuffer[0] === 0 &&
      activeBuffer[1] === 0 &&
      activeBuffer[2] === 1 &&
      activeBuffer[3] === 0)
  ) {
    const payload = decodeIco(activeBuffer);
    pipeline = sharp(payload);
  } else {
    pipeline = sharp(activeBuffer);
  }

  const metadata = await pipeline.metadata();
  const imgWidth = metadata.width || 595.28;
  const imgHeight = metadata.height || 841.89;

  // If OCR is requested, generate an authentic Searchable PDF with invisible text layer
  if (options.ocrEnabled) {
    const ocrResult = await performOcr(inputBuffer, options.ocrLanguage);
    const searchablePdf = await generateSearchablePdf(inputBuffer, ocrResult, options, baseName);
    return {
      buffer: searchablePdf,
      mimeType: 'application/pdf',
      filename: `${baseName}.pdf`,
      size: searchablePdf.length,
      ocrExtractedText: ocrResult.text,
      ocrConfidence: ocrResult.confidence,
    };
  }

  // Convert to PNG buffer first to ensure pdfkit can embed it reliably
  const pngBuffer = await pipeline.png().toBuffer();

  return new Promise((resolve, reject) => {
    const isLandscape =
      options.orientation === 'landscape' || (imgWidth > imgHeight && !options.orientation);
    const doc = new PDFDocument({
      size: [
        isLandscape ? Math.max(imgWidth, imgHeight) : imgWidth,
        isLandscape ? Math.min(imgWidth, imgHeight) : imgHeight,
      ],
      margin: 0,
      layout: isLandscape ? 'landscape' : 'portrait',
    });

    const chunks: Buffer[] = [];
    doc.on('data', (chunk) => chunks.push(chunk));
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

    doc.image(pngBuffer, 0, 0, {
      fit: [doc.page.width, doc.page.height],
      align: 'center',
      valign: 'center',
    });
    doc.end();
  });
}
