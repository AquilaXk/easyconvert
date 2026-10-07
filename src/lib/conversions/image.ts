import zlib from 'node:zlib';
import sharp, { type Metadata, type OutputInfo, type ResizeOptions, type Sharp } from 'sharp';
import PDFDocument from 'pdfkit';
import { ConversionOptions, ConversionResult, ConversionFailedError, UnsupportedOptionError, UnsupportedTargetError, UnsupportedRawCompressionError, InvalidRawSensorError, RawEngineRequiredError } from '../types';
import { selectFrames, type FrameSelection, type PageResize } from './image-frames';
import { encodeDecodedAnimation, joinPageTiffs, zipPageImages } from './image-frame-output';
import { assertAnimationBudget, assertOutputPixels, outputSideOf } from './image-limits';
import { flattenColour, letterboxColour, OPAQUE_IMAGE_TARGETS, parseBackground } from './image-background';
import { buildOpenXpsPackage, withPngDensity96 } from './openxps';
import { HDR_FLOAT_PIXEL_BUDGET, InputPixelLimitError, QUANTIZER_PIXEL_BUDGET, RAW_SENSOR_PIXEL_BUDGET, assertEncodedImageWithinLimit, assertInputPixels, assertPixelBudget, asInputPixelLimitError, openInputImage, openLimitedSharp, resizedDimensions, rethrowInputPixelLimit } from './image-input-limits';
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
import { performOcr, generateSearchablePdf, exportHocr, exportAlto } from './ocr';
import { isSvg, sanitizeSvgBuffer } from '../security/svg-sanitizer';
import { buildOdgPackage } from './odg';
import { RAW_CAMERA_FORMATS } from './raw-formats';
import {
  demosaicRcdBayerCfa,
  processFloat32LinearPipeline,
  applyHighlightReconstruction,
  calculatePlanckianWhiteBalance,
  kelvinAndTintToXy,
  applyRec2020Oetf,
  BRADFORD_D50_TO_D65_MATRIX,
  XYZ_D65_TO_SRGB_MATRIX,
  XYZ_D65_TO_DISPLAY_P3_MATRIX,
  XYZ_D65_TO_REC2020_MATRIX,
  encodeOpenExr,
  decodeOpenExr,
  encodeUltraHdrJpeg,
  decodeUltraHdrJpeg,
  reconstructUltraHdr,
  encode16BitTiff,
  encode16BitPng,
  createMinimalRgbIcc,
  DISPLAY_P3_ICC,
  REC2020_ICC,
  unpackRawSensorBits,
  float32ToFloat16,
  float16ToFloat32,
} from './raw-hdr';

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
  UnsupportedRawCompressionError,
  demosaicRcdBayerCfa,
  processFloat32LinearPipeline,
  applyHighlightReconstruction,
  calculatePlanckianWhiteBalance,
  kelvinAndTintToXy,
  applyRec2020Oetf,
  BRADFORD_D50_TO_D65_MATRIX,
  XYZ_D65_TO_SRGB_MATRIX,
  XYZ_D65_TO_DISPLAY_P3_MATRIX,
  XYZ_D65_TO_REC2020_MATRIX,
  encodeOpenExr,
  decodeOpenExr,
  encodeUltraHdrJpeg,
  decodeUltraHdrJpeg,
  encode16BitTiff,
  encode16BitPng,
  createMinimalRgbIcc,
  DISPLAY_P3_ICC,
  REC2020_ICC,
  unpackRawSensorBits,
  float32ToFloat16,
  float16ToFloat32,
};

export type BayerPattern = 'RGGB' | 'BGGR' | 'GRBG' | 'GBRG';

export interface BayerSensorData {
  width: number;
  height: number;
  pattern: BayerPattern;
  data: Uint8Array | Uint16Array | Float32Array;
  bitsPerSample?: number;
  whiteBalance?: [number, number, number]; // [rScale, gScale, bScale]
  asShotNeutral?: [number, number, number];
  blackLevel?: number | number[];
  whiteLevel?: number;
  colorMatrix?: [number, number, number, number, number, number, number, number, number];
  colorMatrix1?: [number, number, number, number, number, number, number, number, number]; // Standard Illuminant A (Tungsten, 2856K)
  colorMatrix2?: [number, number, number, number, number, number, number, number, number]; // Standard Illuminant D65 (Daylight, 6504K)
  forwardMatrix1?: [number, number, number, number, number, number, number, number, number]; // Camera neutral to XYZ D50 under Illuminant A
  forwardMatrix2?: [number, number, number, number, number, number, number, number, number]; // Camera neutral to XYZ D50 under Illuminant D65
  activeArea?: [number, number, number, number]; // [top, left, bottom, right]
  defaultCropOrigin?: [number, number]; // [x, y]
  defaultCropSize?: [number, number]; // [width, height]
  cctKelvin?: number; // Scene correlated color temperature in Kelvin
  tint?: number;
  applySrgbGamma?: boolean;
  falseColorSuppression?: boolean | number;
  demosaicMethod?: 'amaze' | 'rcd' | 'ahd';
  highlightReconstruction?: boolean | 'clip' | 'blend' | 'reconstruct';
  targetColorSpace?: 'sRGB' | 'display-p3' | 'rec2020' | 'linear';
  outputDepth?: 8 | 16 | 32;
  gainMap?: boolean;
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

/** Bit depths a BMP can declare (Microsoft BITMAPINFOHEADER). */
const BMP_BITS_PER_PIXEL = new Set([1, 4, 8, 16, 24, 32]);

export function decodeBmp(buf: Buffer): { raw: Buffer; width: number; height: number; channels: 4 } {
  if (buf.length < 54 || buf.toString('ascii', 0, 2) !== 'BM') {
    throw new ConversionFailedError('Invalid BMP file: missing BM header signature.');
  }

  const pixelOffset = buf.readUInt32LE(10);
  const width = buf.readInt32LE(18);
  const height = buf.readInt32LE(22);
  const bpp = buf.readUInt16LE(28);

  if (width <= 0 || height === 0) {
    throw new ConversionFailedError(`Invalid BMP dimensions: ${width}x${height}`);
  }
  if (!BMP_BITS_PER_PIXEL.has(bpp)) {
    throw new ConversionFailedError(`Invalid BMP: ${bpp} bits per pixel is not a BMP bit depth.`);
  }

  const isBottomUp = height > 0;
  const absHeight = Math.abs(height);
  assertInputPixels(width, absHeight);

  const rowSize = Math.floor((bpp * width + 31) / 32) * 4;
  // The declared canvas must be backed by the file: a header cannot make the decoder allocate it for nothing.
  if (pixelOffset + rowSize * absHeight > buf.length) {
    throw new ConversionFailedError(
      `Invalid BMP: the header declares ${width}x${absHeight} pixels at ${bpp} bits (${rowSize * absHeight} bytes of pixel data from offset ${pixelOffset}), but the file ends at byte ${buf.length}.`
    );
  }
  const rawRgba = Buffer.alloc(width * absHeight * 4);

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

/** Adobe Photoshop File Format: version 1 files hold at most 30000 pixels on a side. */
const PSD_MAX_SIDE = 30_000;
const PSD_CHANNELS = 4;
const PSD_HEADER_BYTES = 26;
const PSD_COLOR_MODE_RGB = 3;
const PSD_COMPRESSION_RLE = 1;
const PACKBITS_MAX_RUN = 128;

/** Run-length encodes one scanline in the PackBits form the PSD format uses (PSD file format, "Image Data"). */
function packBitsRow(row: Uint8Array): Buffer {
  const out: number[] = [];
  let i = 0;
  while (i < row.length) {
    let run = 1;
    while (i + run < row.length && row[i + run] === row[i] && run < PACKBITS_MAX_RUN) run += 1;
    if (run >= 2) {
      // A repeat of `run` bytes is the count byte 257 - run (that is, 1 - run as a signed byte), then the byte.
      out.push(257 - run, row[i]);
      i += run;
      continue;
    }
    const start = i;
    i += 1;
    while (i < row.length && i - start < PACKBITS_MAX_RUN && row[i] !== row[i + 1]) i += 1;
    out.push(i - start - 1);
    for (let k = start; k < i; k += 1) out.push(row[k]);
  }
  return Buffer.from(out);
}

/**
 * Writes an RGBA picture as a Photoshop (PSD, version 1) file: 8-bit RGB with a fourth alpha channel, one
 * merged image, planar channels, PackBits compressed. `rgba` is interleaved, row-major, top row first.
 */
export function encodePsd(rgba: Buffer, width: number, height: number): Buffer {
  if (width < 1 || height < 1 || width > PSD_MAX_SIDE || height > PSD_MAX_SIDE) {
    throw new ConversionFailedError(`A PSD file holds 1 to ${PSD_MAX_SIDE} pixels on a side; the picture is ${width} x ${height}.`);
  }
  if (rgba.length !== width * height * PSD_CHANNELS) {
    throw new ConversionFailedError(`PSD encoding needs ${width * height * PSD_CHANNELS} bytes of RGBA pixels, got ${rgba.length}.`);
  }
  const header = Buffer.alloc(PSD_HEADER_BYTES);
  header.write('8BPS', 0, 4, 'ascii');
  header.writeUInt16BE(1, 4); // version 1
  header.writeUInt16BE(PSD_CHANNELS, 12);
  header.writeUInt32BE(height, 14);
  header.writeUInt32BE(width, 18);
  header.writeUInt16BE(8, 22); // bits per channel
  header.writeUInt16BE(PSD_COLOR_MODE_RGB, 24);

  // Color mode data, image resources and layer and mask information are empty sections (a 4-byte length of 0 each).
  const emptySections = Buffer.alloc(3 * 4);
  const compression = Buffer.alloc(2);
  compression.writeUInt16BE(PSD_COMPRESSION_RLE, 0);

  const rowCounts = Buffer.alloc(PSD_CHANNELS * height * 2);
  const rows: Buffer[] = [];
  const plane = new Uint8Array(width);
  for (let channel = 0; channel < PSD_CHANNELS; channel += 1) {
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) plane[x] = rgba[(y * width + x) * PSD_CHANNELS + channel];
      const packed = packBitsRow(plane);
      rowCounts.writeUInt16BE(packed.length, (channel * height + y) * 2);
      rows.push(packed);
    }
  }
  return Buffer.concat([header, emptySections, compression, rowCounts, ...rows]);
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
 * Standard Illuminant A Correlated Color Temperature (Tungsten, 2856K)
 */
export const STANDARD_ILLUMINANT_A_CCT = 2856;

/**
 * Standard Illuminant D65 Correlated Color Temperature (Daylight, 6504K)
 */
export const STANDARD_ILLUMINANT_D65_CCT = 6504;

/**
 * Standard Illuminant A (Tungsten, 2856K) Camera Calibration Matrix (3x3 row-major).
 * Calibrated for incandescent illumination with high red and low blue sensor sensitivity.
 */
export const STANDARD_ILLUMINANT_A_COLOR_MATRIX: [number, number, number, number, number, number, number, number, number] = [
  1.2500, -0.3200, 0.0700,
  -0.1800, 1.2200, -0.0400,
  0.0400, -0.5800, 1.5400,
];

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
 * Standard Bradford-adapted CIE XYZ D50 to sRGB (D65) transformation matrix.
 * Used in Adobe DNG Specification 1.7.1.0 to map XYZ coordinates to standard sRGB.
 */
export const XYZ_D50_TO_SRGB_MATRIX: [number, number, number, number, number, number, number, number, number] = [
  3.1338561, -1.6168667, -0.4906146,
  -0.9787684, 1.9161415, 0.0334540,
  0.0719453, -0.2289914, 1.4052427,
];

/**
 * Multiplies two 3x3 matrices in row-major order: C = A * B.
 */
export function multiply3x3(
  a: readonly number[],
  b: readonly number[]
): [number, number, number, number, number, number, number, number, number] {
  const res = new Array(9);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      res[r * 3 + c] =
        a[r * 3 + 0] * b[0 * 3 + c] +
        a[r * 3 + 1] * b[1 * 3 + c] +
        a[r * 3 + 2] * b[2 * 3 + c];
    }
  }
  return res as [number, number, number, number, number, number, number, number, number];
}

/**
 * Computes exact 3x3 matrix inverse using Gauss-Jordan elimination with partial row pivoting.
 * Returns null if the matrix is singular or non-invertible.
 */
export function invert3x3(
  matrix: readonly number[]
): [number, number, number, number, number, number, number, number, number] | null {
  if (!matrix || matrix.length !== 9 || matrix.some((v) => !Number.isFinite(v))) return null;
  const a: number[][] = [
    [matrix[0], matrix[1], matrix[2], 1, 0, 0],
    [matrix[3], matrix[4], matrix[5], 0, 1, 0],
    [matrix[6], matrix[7], matrix[8], 0, 0, 1],
  ];

  for (let i = 0; i < 3; i++) {
    let maxRow = i;
    let maxVal = Math.abs(a[i][i]);
    for (let r = i + 1; r < 3; r++) {
      const val = Math.abs(a[r][i]);
      if (val > maxVal) {
        maxVal = val;
        maxRow = r;
      }
    }
    if (maxVal < 1e-12 || !Number.isFinite(maxVal)) {
      return null;
    }
    if (maxRow !== i) {
      const tmp = a[i];
      a[i] = a[maxRow];
      a[maxRow] = tmp;
    }

    const pivot = a[i][i];
    for (let c = 0; c < 6; c++) {
      a[i][c] /= pivot;
    }

    for (let r = 0; r < 3; r++) {
      if (r === i) continue;
      const factor = a[r][i];
      for (let c = 0; c < 6; c++) {
        a[r][c] -= factor * a[i][c];
      }
    }
  }

  return [
    a[0][3], a[0][4], a[0][5],
    a[1][3], a[1][4], a[1][5],
    a[2][3], a[2][4], a[2][5],
  ];
}

/**
 * Validates Bayer sensor calibration parameters (whiteLevel, blackLevel) fail-closed.
 * Guarantees whiteLevel > maxBLevel and valid non-negative finite calibrations.
 */
export function validateBayerSensorCalibration(
  sensor: BayerSensorData,
  defaultWhiteLevel: number
): {
  defaultBLevel: number;
  maxBLevel: number;
  wLevel: number;
  hasArrayBlackLevel: boolean;
  blackLevelArr?: number[];
} {
  if (sensor.whiteLevel !== undefined) {
    if (!Number.isFinite(sensor.whiteLevel) || sensor.whiteLevel <= 0) {
      throw new Error(`Invalid Bayer calibration: whiteLevel (${sensor.whiteLevel}) must be a positive finite number.`);
    }
  }

  if (typeof sensor.blackLevel === 'number') {
    if (!Number.isFinite(sensor.blackLevel) || sensor.blackLevel < 0) {
      throw new Error(`Invalid Bayer calibration: blackLevel (${sensor.blackLevel}) must be a non-negative finite number.`);
    }
  } else if (Array.isArray(sensor.blackLevel)) {
    if (sensor.blackLevel.length !== 1 && sensor.blackLevel.length !== 4) {
      throw new Error(`Invalid Bayer calibration: blackLevel array length (${sensor.blackLevel.length}) must be 1 or 4 matching 2x2 CFA pattern.`);
    }
    for (const b of sensor.blackLevel) {
      if (!Number.isFinite(b) || b < 0) {
        throw new Error(`Invalid Bayer calibration: blackLevel elements must be non-negative finite numbers, got ${b}.`);
      }
    }
  }

  const blackLevelArr = Array.isArray(sensor.blackLevel) ? sensor.blackLevel : undefined;
  const hasArrayBlackLevel = blackLevelArr !== undefined && blackLevelArr.length > 0;
  const defaultBLevel =
    typeof sensor.blackLevel === 'number'
      ? sensor.blackLevel
      : blackLevelArr && blackLevelArr.length === 1
      ? blackLevelArr[0]
      : 0;
  const maxBLevel = blackLevelArr && blackLevelArr.length > 0 ? Math.max(...blackLevelArr) : defaultBLevel;
  const wLevel = sensor.whiteLevel !== undefined ? sensor.whiteLevel : defaultWhiteLevel;

  if (wLevel <= maxBLevel) {
    throw new Error(
      `Invalid Bayer calibration: whiteLevel (${wLevel}) must be strictly greater than blackLevel (${maxBLevel}).`
    );
  }

  return { defaultBLevel, maxBLevel, wLevel, hasArrayBlackLevel, blackLevelArr };
}

/**
 * Interpolates between dual illuminant color calibration matrices (Illuminant A and Illuminant D65)
 * using reciprocal color temperature (Mired) weighting per ISO 12234-2 / DNG specifications.
 */
export function interpolateDualIlluminantColorMatrix(
  cctKelvin: number,
  matrixA?: [number, number, number, number, number, number, number, number, number],
  matrixD65?: [number, number, number, number, number, number, number, number, number]
): [number, number, number, number, number, number, number, number, number] {
  if (matrixA && !matrixD65) {
    return [...matrixA];
  }
  const matA = matrixA ?? STANDARD_ILLUMINANT_A_COLOR_MATRIX;
  const matD65 = matrixD65 ?? DEFAULT_D65_COLOR_MATRIX;

  const safeCct = typeof cctKelvin === 'number' && Number.isFinite(cctKelvin) && cctKelvin > 0 ? cctKelvin : STANDARD_ILLUMINANT_D65_CCT;
  const clampedCct = Math.max(1000, Math.min(25000, safeCct));
  const miredTarget = 1000000 / clampedCct;
  const miredA = 1000000 / STANDARD_ILLUMINANT_A_CCT;     // ~350.14 Mired
  const miredD65 = 1000000 / STANDARD_ILLUMINANT_D65_CCT; // ~153.75 Mired

  let weightA: number;
  if (miredTarget >= miredA) {
    weightA = 1.0;
  } else if (miredTarget <= miredD65) {
    weightA = 0.0;
  } else {
    const denom = miredA - miredD65;
    weightA = Math.abs(denom) > 1e-6 ? (miredTarget - miredD65) / denom : 0.5;
  }
  const weightD65 = 1.0 - weightA;

  return [
    weightA * matA[0] + weightD65 * matD65[0],
    weightA * matA[1] + weightD65 * matD65[1],
    weightA * matA[2] + weightD65 * matD65[2],
    weightA * matA[3] + weightD65 * matD65[3],
    weightA * matA[4] + weightD65 * matD65[4],
    weightA * matA[5] + weightD65 * matD65[5],
    weightA * matA[6] + weightD65 * matD65[6],
    weightA * matA[7] + weightD65 * matD65[7],
    weightA * matA[8] + weightD65 * matD65[8],
  ];
}

/**
 * Estimates Correlated Color Temperature (CCT in Kelvin) from raw sensor white balance gains
 * [rGain, gGain, bGain] using reciprocal temperature (Mired) gain mapping.
 */
export function estimateCctFromWhiteBalance(wb: [number, number, number]): number {
  if (!Array.isArray(wb) || wb.length < 3) {
    return 5500;
  }
  const [rGain, gGain, bGain] = wb;
  const r = typeof rGain === 'number' && !isNaN(rGain) && rGain > 0 ? rGain : 1.0;
  const g = typeof gGain === 'number' && !isNaN(gGain) && gGain > 0 ? gGain : 1.0;
  const b = typeof bGain === 'number' && !isNaN(bGain) && bGain > 0 ? bGain : 1.0;

  const ratio = (b / g) / (r / g);
  const mired = 350.14 - ((ratio - 2.0) / (0.7 - 2.0)) * (350.14 - 153.75);
  const cct = 1000000 / Math.max(80, Math.min(500, mired));
  return Math.round(Math.max(2000, Math.min(12000, cct)));
}

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
 * Resolves 3x3 color matrix mapping sensor radiance to sRGB for Bayer demosaicing engines.
 * Handles explicit colorMatrix, forward matrices, dual illuminant CCT interpolation,
 * single matrix fallback, or default D65 daylight matrix.
 */
export function resolveBayerColorMatrix(
  sensor: BayerSensorData
): [number, number, number, number, number, number, number, number, number] | null {
  const {
    colorMatrix,
    forwardMatrix1,
    forwardMatrix2,
    colorMatrix1,
    colorMatrix2,
    cctKelvin,
    whiteBalance,
    applySrgbGamma,
  } = sensor;

  if (colorMatrix) {
    return colorMatrix;
  }

  if (forwardMatrix1 || forwardMatrix2) {
    let fMat: [number, number, number, number, number, number, number, number, number] | undefined;
    if (forwardMatrix1 && forwardMatrix2) {
      let cct = cctKelvin;
      if (typeof cct !== 'number' || isNaN(cct) || cct <= 0) {
        cct = whiteBalance ? estimateCctFromWhiteBalance(whiteBalance) : 5500;
      }
      fMat = interpolateDualIlluminantColorMatrix(cct, forwardMatrix1, forwardMatrix2);
    } else if (forwardMatrix1) {
      fMat = forwardMatrix1;
    } else if (forwardMatrix2) {
      fMat = forwardMatrix2;
    }
    if (fMat) {
      return multiply3x3(XYZ_D50_TO_SRGB_MATRIX, fMat);
    }
  }

  if (colorMatrix1 || colorMatrix2) {
    let cm: [number, number, number, number, number, number, number, number, number] | undefined;
    if (colorMatrix1 && colorMatrix2) {
      let cct = cctKelvin;
      if (typeof cct !== 'number' || isNaN(cct) || cct <= 0) {
        cct = whiteBalance ? estimateCctFromWhiteBalance(whiteBalance) : 5500;
      }
      cm = interpolateDualIlluminantColorMatrix(cct, colorMatrix1, colorMatrix2);
    } else if (colorMatrix1) {
      cm = colorMatrix1;
    } else if (colorMatrix2) {
      cm = colorMatrix2;
    }

    if (cm) {
      const isDiagonal =
        cm[1] === 0 &&
        cm[2] === 0 &&
        cm[3] === 0 &&
        cm[5] === 0 &&
        cm[6] === 0 &&
        cm[7] === 0;
      if (!isDiagonal) {
        const inv = invert3x3(cm);
        if (inv) {
          return multiply3x3(XYZ_D50_TO_SRGB_MATRIX, inv);
        }
      }
      return cm;
    }
  }

  if (typeof cctKelvin === 'number' && !isNaN(cctKelvin) && cctKelvin > 0) {
    return interpolateDualIlluminantColorMatrix(cctKelvin);
  }

  if (applySrgbGamma) {
    return DEFAULT_D65_COLOR_MATRIX;
  }

  return null;
}

/**
 * Parity-preserving symmetric reflection for Bayer grid coordinates:
 * for even dimensions, (mirrorBayerCoord(c, max) & 1) === (c & 1)
 */
export function mirrorBayerCoord(v: number, max: number): number {
  if (max <= 1) return 0;
  while (v < 0 || v >= max) {
    if (v < 0) {
      v = -v;
    } else if (v >= max) {
      v = 2 * (max - 1) - v;
    }
  }
  return v;
}

/**
 * Applies 5x5 adaptive median filtering on chrominance difference planes (R - G and B - G)
 * to suppress false color artifacts, chromatic moiré, and high-ISO zipper overshoots
 * while strictly preserving luminance edge transitions.
 */
export function applyFalseColorSuppression(
  redDiff: Float32Array,
  blueDiff: Float32Array,
  width: number,
  height: number,
  passes: number = 1
): { filteredRedDiff: Float32Array; filteredBlueDiff: Float32Array } {
  let currR = redDiff;
  let currB = blueDiff;
  const numPasses = Math.max(1, Math.min(5, Math.round(passes)));

  const winR = new Float32Array(25);
  const winB = new Float32Array(25);

  for (let p = 0; p < numPasses; p++) {
    const nextR = new Float32Array(width * height);
    const nextB = new Float32Array(width * height);

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        let count = 0;
        for (let dy = -2; dy <= 2; dy++) {
          const ny = mirrorBayerCoord(y + dy, height);
          for (let dx = -2; dx <= 2; dx++) {
            const nx = mirrorBayerCoord(x + dx, width);
            const nIdx = ny * width + nx;
            winR[count] = currR[nIdx];
            winB[count] = currB[nIdx];
            count++;
          }
        }
        winR.sort();
        winB.sort();
        // 25 elements: index 12 is the exact median
        nextR[y * width + x] = winR[12];
        nextB[y * width + x] = winB[12];
      }
    }
    currR = nextR;
    currB = nextB;
  }

  return { filteredRedDiff: currR, filteredBlueDiff: currB };
}

/**
 * AMaZE (Aliasing Minimization and Zipper Elimination) Bayer CFA demosaicing.
 * Evaluates directional local homogeneity across 5x5 pixel windows with gradient filtering
 * and interpolates the green channel along the direction of maximum homogeneity.
 * Eliminates zipper artifacts with median-filtered color differences, and applies dual illuminant
 * CCT weighted color matrix interpolation and IEC 61966-2-1 gamma curves.
 */
export function demosaicAmazeBayerCfa(sensor: BayerSensorData): {
  data: Buffer;
  floatData?: Float32Array;
  width: number;
  height: number;
} {
  const { width, height, pattern, data, whiteBalance, colorMatrix, applySrgbGamma } = sensor;
  if (width < 2 || height < 2 || (width & 1) !== 0 || (height & 1) !== 0) {
    throw new InvalidRawSensorError(`Invalid sensor dimensions: ${width}x${height}. Minimum 2x2 with even dimensions required.`);
  }
  if (!['RGGB', 'BGGR', 'GRBG', 'GBRG'].includes(pattern)) {
    throw new Error(`Unsupported Bayer CFA pattern: '${pattern}'. Expected RGGB, BGGR, GRBG, or GBRG.`);
  }
  if (!data || data.length < width * height) {
    throw new InvalidRawSensorError(`Bayer sensor buffer underflow: expected at least ${width * height} samples, got ${data ? data.length : 0}.`);
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

  const { defaultBLevel, wLevel, hasArrayBlackLevel, blackLevelArr } = validateBayerSensorCalibration(
    sensor,
    maxPossible
  );

  // Normalize raw sensor data to Float32Array in [0, 255]
  const norm = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const rawVal = data[i] !== undefined ? data[i] : 0;
      let bLevel = defaultBLevel;
      if (hasArrayBlackLevel && blackLevelArr) {
        const blkIdx = ((y & 1) << 1) | (x & 1);
        bLevel = blackLevelArr[blkIdx % blackLevelArr.length] ?? defaultBLevel;
      }
      const range = Math.max(1, wLevel - bLevel);
      const clamped = Math.max(bLevel, rawVal);
      norm[i] = ((clamped - bLevel) / range) * 255;
    }
  }

  // Parity-preserving symmetric reflection: for even dimensions, (mirrorCoord(c, max) & 1) === (c & 1)
  const mirrorCoord = (v: number, max: number): number => {
    if (max <= 1) return 0;
    while (v < 0 || v >= max) {
      if (v < 0) {
        v = -v;
      } else if (v >= max) {
        v = 2 * (max - 1) - v;
      }
    }
    return v;
  };
  const getPixel = (x: number, y: number) => norm[mirrorCoord(y, height) * width + mirrorCoord(x, width)];

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

  // Step 1: Compute directional horizontal and vertical green estimates with curvature compensation
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
        ghEst[y * width + x] = Math.max(0, gh);
        gvEst[y * width + x] = Math.max(0, gv);
      }
    }
  }

  // Step 2: AMaZE Directional Local Homogeneity selection for Green channel (5x5 window)
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

      // Measure local directional homogeneity and gradient in 5x5 window around (x, y)
      let homH = 0;
      let homV = 0;

      for (let dy = -2; dy <= 2; dy++) {
        const ny = mirrorCoord(y + dy, height);
        for (let dx = -2; dx <= 2; dx++) {
          const nx = mirrorCoord(x + dx, width);
          const nPix = getPixel(nx, ny);
          const nGh = ghEst[ny * width + nx];
          const nGv = gvEst[ny * width + nx];

          const diffH = Math.abs(nPix - nGh) - Math.abs(p - gh);
          const diffV = Math.abs(nPix - nGv) - Math.abs(p - gv);

          // Spatial weight (closer pixels have higher influence)
          const spatialWeight = 1.0 / (1.0 + Math.hypot(dx, dy));

          homH += spatialWeight / (1.0 + Math.abs(diffH) + Math.abs(nGh - gh));
          homV += spatialWeight / (1.0 + Math.abs(diffV) + Math.abs(nGv - gv));
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
        green[y * width + x] = Math.max(0, wH * gh + wV * gv);
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

  // Interpolate missing color differences without in-place clobbering
  const interpRedDiff = new Float32Array(redDiff);
  const interpBlueDiff = new Float32Array(blueDiff);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const ch = getCfaChannel(x, y);
      const idx = y * width + x;

      if (ch === 'B') {
        // Red is at diagonals
        const dR =
          (redDiff[mirrorCoord(y - 1, height) * width + mirrorCoord(x - 1, width)] +
            redDiff[mirrorCoord(y - 1, height) * width + mirrorCoord(x + 1, width)] +
            redDiff[mirrorCoord(y + 1, height) * width + mirrorCoord(x - 1, width)] +
            redDiff[mirrorCoord(y + 1, height) * width + mirrorCoord(x + 1, width)]) / 4;
        interpRedDiff[idx] = dR;
      } else if (ch === 'R') {
        // Blue is at diagonals
        const dB =
          (blueDiff[mirrorCoord(y - 1, height) * width + mirrorCoord(x - 1, width)] +
            blueDiff[mirrorCoord(y - 1, height) * width + mirrorCoord(x + 1, width)] +
            blueDiff[mirrorCoord(y + 1, height) * width + mirrorCoord(x - 1, width)] +
            blueDiff[mirrorCoord(y + 1, height) * width + mirrorCoord(x + 1, width)]) / 4;
        interpBlueDiff[idx] = dB;
      } else {
        // Green pixels: one difference is horizontal, other is vertical
        const isRHorizontal =
          pattern === 'RGGB' ? ch === 'G1' :
          pattern === 'BGGR' ? ch === 'G2' :
          pattern === 'GRBG' ? ch === 'G1' :
          ch === 'G2';

        if (isRHorizontal) {
          interpRedDiff[idx] =
            (redDiff[y * width + mirrorCoord(x - 1, width)] + redDiff[y * width + mirrorCoord(x + 1, width)]) / 2;
          interpBlueDiff[idx] =
            (blueDiff[mirrorCoord(y - 1, height) * width + x] + blueDiff[mirrorCoord(y + 1, height) * width + x]) / 2;
        } else {
          interpBlueDiff[idx] =
            (blueDiff[y * width + mirrorCoord(x - 1, width)] + blueDiff[y * width + mirrorCoord(x + 1, width)]) / 2;
          interpRedDiff[idx] =
            (redDiff[mirrorCoord(y - 1, height) * width + x] + redDiff[mirrorCoord(y + 1, height) * width + x]) / 2;
        }
      }
    }
  }

  // Median filter on color differences (3x3 window) to eliminate zipper artifacts
  const redFiltered = new Float32Array(width * height);
  const blueFiltered = new Float32Array(width * height);
  const winR = new Float32Array(9);
  const winB = new Float32Array(9);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let count = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = mirrorCoord(y + dy, height);
        for (let dx = -1; dx <= 1; dx++) {
          const nx = mirrorCoord(x + dx, width);
          const nIdx = ny * width + nx;
          winR[count] = interpRedDiff[nIdx];
          winB[count] = interpBlueDiff[nIdx];
          count++;
        }
      }
      winR.sort();
      winB.sort();
      redFiltered[y * width + x] = winR[4];
      blueFiltered[y * width + x] = winB[4];
    }
  }

  let finalRedDiff: Float32Array<ArrayBufferLike> = redFiltered;
  let finalBlueDiff: Float32Array<ArrayBufferLike> = blueFiltered;
  if (sensor.falseColorSuppression) {
    const passes = typeof sensor.falseColorSuppression === 'number' ? sensor.falseColorSuppression : 1;
    const fcs = applyFalseColorSuppression(redFiltered, blueFiltered, width, height, passes);
    finalRedDiff = fcs.filteredRedDiff;
    finalBlueDiff = fcs.filteredBlueDiff;
  }

  // Step 4: Reconstruct full RGB, resolve dual illuminant ColorMatrix, and apply white balance & gamma
  const rgbBuffer = Buffer.alloc(width * height * 3);
  const floatData = new Float32Array(width * height * 3);
  const rWb = whiteBalance ? whiteBalance[0] : 1.0;
  const gWb = whiteBalance ? whiteBalance[1] : 1.0;
  const bWb = whiteBalance ? whiteBalance[2] : 1.0;

  // Resolve 3x3 color matrix: explicit, forward matrix, dual illuminant CCT interpolation, single matrix fallback, or default D65
  const mat = colorMatrix || resolveBayerColorMatrix(sensor);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 3;
      const g = green[y * width + x];
      const r = Math.max(0, g + finalRedDiff[y * width + x]);
      const b = Math.max(0, g + finalBlueDiff[y * width + x]);

      // Store normalized linear demosaiced Float32 values [0.0, 1.0] before color transforms
      floatData[idx] = r / 255.0;
      floatData[idx + 1] = g / 255.0;
      floatData[idx + 2] = b / 255.0;

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
    floatData,
    width,
    height,
  };
}

/**
 * Adaptive Homogeneity-Directed (AHD) Bayer CFA demosaicing (Hirakawa & Parks, 2005).
 * Builds two complete directional color field estimates (Horizontal and Vertical),
 * projects them into perceptual CIELAB (L*, a*, b*) color space, and computes directional
 * homogeneity maps to choose the optimal orientation per pixel, followed by artifact suppression.
 */
export function demosaicAhdBayerCfa(sensor: BayerSensorData): {
  data: Buffer;
  floatData?: Float32Array;
  width: number;
  height: number;
} {
  const { width, height, pattern } = sensor;
  const rawInput = sensor.data ?? (sensor as any).rawData;
  if (!rawInput || rawInput.length === 0) {
    throw new Error('Bayer sensor buffer empty or undefined.');
  }

  const bitDepth = sensor.bitsPerSample ?? (sensor as any).bitDepth ?? (rawInput instanceof Uint16Array ? 16 : 8);
  const maxVal = (1 << bitDepth) - 1;

  const { defaultBLevel, maxBLevel, wLevel, hasArrayBlackLevel, blackLevelArr } = validateBayerSensorCalibration(
    sensor,
    maxVal
  );

  const mirrorCoord = (c: number, max: number): number => {
    if (c < 0) return -c;
    if (c >= max) return 2 * max - c - 2;
    return c;
  };

  const isUint16Array = rawInput instanceof Uint16Array;
  const is16BitBuffer = !isUint16Array && bitDepth > 8;

  const getPixel = (x: number, y: number): number => {
    const mx = mirrorCoord(x, width);
    const my = mirrorCoord(y, height);
    const offset = my * width + mx;

    let rawVal = 0;
    if (isUint16Array) {
      rawVal = rawInput[offset];
    } else if (is16BitBuffer) {
      rawVal = (rawInput as Buffer).readUInt16LE(offset * 2);
    } else {
      rawVal = rawInput[offset];
    }

    let bLevel = defaultBLevel;
    if (hasArrayBlackLevel && (sensor.blackLevel as number[]).length === 4) {
      const blkArr = sensor.blackLevel as number[];
      const blkIdx = ((my & 1) << 1) | (mx & 1);
      bLevel = blkArr[blkIdx];
    }
    const range = wLevel - bLevel;
    const clamped = Math.max(bLevel, rawVal);
    return ((clamped - bLevel) / range) * 255.0;
  };

  // Determine CFA channel layout
  const pUpper = pattern.toUpperCase();
  const getCfaChannel = (x: number, y: number): 'R' | 'G1' | 'G2' | 'B' => {
    const row = y % 2;
    const col = x % 2;
    if (pUpper === 'RGGB') {
      if (row === 0) return col === 0 ? 'R' : 'G1';
      return col === 0 ? 'G2' : 'B';
    } else if (pUpper === 'BGGR') {
      if (row === 0) return col === 0 ? 'B' : 'G1';
      return col === 0 ? 'G2' : 'R';
    } else if (pUpper === 'GRBG') {
      if (row === 0) return col === 0 ? 'G1' : 'R';
      return col === 0 ? 'B' : 'G2';
    } else if (pUpper === 'GBRG') {
      if (row === 0) return col === 0 ? 'G1' : 'B';
      return col === 0 ? 'R' : 'G2';
    }
    return 'G1';
  };

  const totalPixels = width * height;

  // Step 1: Directional Green Interpolation with Laplacian second-derivative correction
  const gH = new Float32Array(totalPixels);
  const gV = new Float32Array(totalPixels);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      const ch = getCfaChannel(x, y);
      const p = getPixel(x, y);

      if (ch === 'G1' || ch === 'G2') {
        gH[idx] = p;
        gV[idx] = p;
      } else {
        // Pixel is R or B
        // Horizontal interpolation: G_H = (G(x-1) + G(x+1))/2 + (2*p(x) - p(x-2) - p(x+2))/4
        const gL = getPixel(x - 1, y);
        const gR = getPixel(x + 1, y);
        const pLL = getPixel(x - 2, y);
        const pRR = getPixel(x + 2, y);
        const interpGH = (gL + gR) * 0.5 + (2.0 * p - pLL - pRR) * 0.25;
        gH[idx] = Math.max(0, interpGH);

        // Vertical interpolation: G_V = (G(y-1) + G(y+1))/2 + (2*p(y) - p(y-2) - p(y+2))/4
        const gT = getPixel(x, y - 1);
        const gB = getPixel(x, y + 1);
        const pTT = getPixel(x, y - 2);
        const pBB = getPixel(x, y + 2);
        const interpGV = (gT + gB) * 0.5 + (2.0 * p - pTT - pBB) * 0.25;
        gV[idx] = Math.max(0, interpGV);
      }
    }
  }

  // Step 2: Complete Red and Blue interpolation for both H and V fields via color difference
  const rH = new Float32Array(totalPixels);
  const bH = new Float32Array(totalPixels);
  const rV = new Float32Array(totalPixels);
  const bV = new Float32Array(totalPixels);

  const krH = new Float32Array(totalPixels);
  const kbH = new Float32Array(totalPixels);
  const krV = new Float32Array(totalPixels);
  const kbV = new Float32Array(totalPixels);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      const ch = getCfaChannel(x, y);
      const p = getPixel(x, y);
      if (ch === 'R') {
        krH[idx] = p - gH[idx];
        krV[idx] = p - gV[idx];
      } else if (ch === 'B') {
        kbH[idx] = p - gH[idx];
        kbV[idx] = p - gV[idx];
      }
    }
  }

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      const ch = getCfaChannel(x, y);
      const p = getPixel(x, y);

      // Interpolate R
      if (ch === 'R') {
        rH[idx] = p;
        rV[idx] = p;
      } else {
        let diffRH = 0;
        let diffRV = 0;
        const nL = krH[y * width + mirrorCoord(x - 1, width)];
        const nR = krH[y * width + mirrorCoord(x + 1, width)];
        const nT = krH[mirrorCoord(y - 1, height) * width + x];
        const nB = krH[mirrorCoord(y + 1, height) * width + x];

        const nTL = krH[mirrorCoord(y - 1, height) * width + mirrorCoord(x - 1, width)];
        const nTR = krH[mirrorCoord(y - 1, height) * width + mirrorCoord(x + 1, width)];
        const nBL = krH[mirrorCoord(y + 1, height) * width + mirrorCoord(x - 1, width)];
        const nBR = krH[mirrorCoord(y + 1, height) * width + mirrorCoord(x + 1, width)];

        const vTL = krV[mirrorCoord(y - 1, height) * width + mirrorCoord(x - 1, width)];
        const vTR = krV[mirrorCoord(y - 1, height) * width + mirrorCoord(x + 1, width)];
        const vBL = krV[mirrorCoord(y + 1, height) * width + mirrorCoord(x - 1, width)];
        const vBR = krV[mirrorCoord(y + 1, height) * width + mirrorCoord(x + 1, width)];

        const vL = krV[y * width + mirrorCoord(x - 1, width)];
        const vR = krV[y * width + mirrorCoord(x + 1, width)];
        const vT = krV[mirrorCoord(y - 1, height) * width + x];
        const vB = krV[mirrorCoord(y + 1, height) * width + x];

        if (ch === 'B') {
          diffRH = (nTL + nTR + nBL + nBR) * 0.25;
          diffRV = (vTL + vTR + vBL + vBR) * 0.25;
        } else {
          const isRHoriz = getCfaChannel(mirrorCoord(x - 1, width), y) === 'R';
          if (isRHoriz) {
            diffRH = (nL + nR) * 0.5;
            diffRV = (vL + vR) * 0.5;
          } else {
            diffRH = (nT + nB) * 0.5;
            diffRV = (vT + vB) * 0.5;
          }
        }
        rH[idx] = Math.max(0, gH[idx] + diffRH);
        rV[idx] = Math.max(0, gV[idx] + diffRV);
      }

      // Interpolate B
      if (ch === 'B') {
        bH[idx] = p;
        bV[idx] = p;
      } else {
        let diffBH = 0;
        let diffBV = 0;
        const nL = kbH[y * width + mirrorCoord(x - 1, width)];
        const nR = kbH[y * width + mirrorCoord(x + 1, width)];
        const nT = kbH[mirrorCoord(y - 1, height) * width + x];
        const nB = kbH[mirrorCoord(y + 1, height) * width + x];

        const nTL = kbH[mirrorCoord(y - 1, height) * width + mirrorCoord(x - 1, width)];
        const nTR = kbH[mirrorCoord(y - 1, height) * width + mirrorCoord(x + 1, width)];
        const nBL = kbH[mirrorCoord(y + 1, height) * width + mirrorCoord(x - 1, width)];
        const nBR = kbH[mirrorCoord(y + 1, height) * width + mirrorCoord(x + 1, width)];

        const vTL = kbV[mirrorCoord(y - 1, height) * width + mirrorCoord(x - 1, width)];
        const vTR = kbV[mirrorCoord(y - 1, height) * width + mirrorCoord(x + 1, width)];
        const vBL = kbV[mirrorCoord(y + 1, height) * width + mirrorCoord(x - 1, width)];
        const vBR = kbV[mirrorCoord(y + 1, height) * width + mirrorCoord(x + 1, width)];

        const vL = kbV[y * width + mirrorCoord(x - 1, width)];
        const vR = kbV[y * width + mirrorCoord(x + 1, width)];
        const vT = kbV[mirrorCoord(y - 1, height) * width + x];
        const vB = kbV[mirrorCoord(y + 1, height) * width + x];

        if (ch === 'R') {
          diffBH = (nTL + nTR + nBL + nBR) * 0.25;
          diffBV = (vTL + vTR + vBL + vBR) * 0.25;
        } else {
          const isBHoriz = getCfaChannel(mirrorCoord(x - 1, width), y) === 'B';
          if (isBHoriz) {
            diffBH = (nL + nR) * 0.5;
            diffBV = (vL + vR) * 0.5;
          } else {
            diffBH = (nT + nB) * 0.5;
            diffBV = (vT + vB) * 0.5;
          }
        }
        bH[idx] = Math.max(0, gH[idx] + diffBH);
        bV[idx] = Math.max(0, gV[idx] + diffBV);
      }
    }
  }

  // Step 3: CIELAB (L*, a*, b*) Conversion for H and V field estimates
  const labH_L = new Float32Array(totalPixels);
  const labH_A = new Float32Array(totalPixels);
  const labH_B = new Float32Array(totalPixels);

  const labV_L = new Float32Array(totalPixels);
  const labV_A = new Float32Array(totalPixels);
  const labV_B = new Float32Array(totalPixels);

  const rgb2lab = (rByte: number, gByte: number, bByte: number) => {
    const toLinear = (c: number) => {
      const v = c / 255.0;
      return v > 0.04045 ? Math.pow((v + 0.055) / 1.055, 2.4) : v / 12.92;
    };
    const rL = toLinear(rByte);
    const gL = toLinear(gByte);
    const bL = toLinear(bByte);

    const X = (0.4124564 * rL + 0.3575761 * gL + 0.1804375 * bL) / 0.95047;
    const Y = (0.2126729 * rL + 0.7151522 * gL + 0.0721750 * bL) / 1.0;
    const Z = (0.0193339 * rL + 0.1191920 * gL + 0.9503041 * bL) / 1.08883;

    const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16.0 / 116.0);
    const fx = f(X);
    const fy = f(Y);
    const fz = f(Z);

    const L = 116.0 * fy - 16.0;
    const a = 500.0 * (fx - fy);
    const b = 200.0 * (fy - fz);
    return [L, a, b];
  };

  for (let i = 0; i < totalPixels; i++) {
    const [lH, aH, bHVal] = rgb2lab(rH[i], gH[i], bH[i]);
    labH_L[i] = lH;
    labH_A[i] = aH;
    labH_B[i] = bHVal;

    const [lV, aV, bVVal] = rgb2lab(rV[i], gV[i], bV[i]);
    labV_L[i] = lV;
    labV_A[i] = aV;
    labV_B[i] = bVVal;
  }

  // Step 4: Directional Homogeneity Metric in CIELAB Color Space
  const finalR = new Float32Array(totalPixels);
  const finalG = new Float32Array(totalPixels);
  const finalB = new Float32Array(totalPixels);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;

      let homH = 0;
      let homV = 0;

      const cHL = labH_L[idx];
      const cHA = labH_A[idx];
      const cHB = labH_B[idx];

      const cVL = labV_L[idx];
      const cVA = labV_A[idx];
      const cVB = labV_B[idx];

      for (let dy = -2; dy <= 2; dy++) {
        const ny = mirrorCoord(y + dy, height);
        for (let dx = -2; dx <= 2; dx++) {
          const nx = mirrorCoord(x + dx, width);
          const nIdx = ny * width + nx;

          const distSq = dx * dx + dy * dy;
          const spatialWeight = 1.0 / (1.0 + distSq * 0.25);

          const dEL_H = labH_L[nIdx] - cHL;
          const dEA_H = labH_A[nIdx] - cHA;
          const dEB_H = labH_B[nIdx] - cHB;
          const deltaE_H = Math.hypot(dEL_H, dEA_H, dEB_H);

          const dEL_V = labV_L[nIdx] - cVL;
          const dEA_V = labV_A[nIdx] - cVA;
          const dEB_V = labV_B[nIdx] - cVB;
          const deltaE_V = Math.hypot(dEL_V, dEA_V, dEB_V);

          homH += spatialWeight / (1.0 + deltaE_H);
          homV += spatialWeight / (1.0 + deltaE_V);
        }
      }

      if (homH >= homV) {
        finalR[idx] = rH[idx];
        finalG[idx] = gH[idx];
        finalB[idx] = bH[idx];
      } else {
        finalR[idx] = rV[idx];
        finalG[idx] = gV[idx];
        finalB[idx] = bV[idx];
      }
    }
  }

  // Step 5: Artifact Removal Filter via 3x3 Median Filter on Color Differences (R - G, B - G)
  const diffR = new Float32Array(totalPixels);
  const diffB = new Float32Array(totalPixels);
  for (let i = 0; i < totalPixels; i++) {
    diffR[i] = finalR[i] - finalG[i];
    diffB[i] = finalB[i] - finalG[i];
  }

  const filteredR = new Float32Array(totalPixels);
  const filteredB = new Float32Array(totalPixels);

  const window9R = new Float32Array(9);
  const window9B = new Float32Array(9);

  const medDiffR = new Float32Array(width * height);
  const medDiffB = new Float32Array(width * height);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      let wIdx = 0;

      for (let dy = -1; dy <= 1; dy++) {
        const ny = mirrorCoord(y + dy, height);
        for (let dx = -1; dx <= 1; dx++) {
          const nx = mirrorCoord(x + dx, width);
          const nIdx = ny * width + nx;
          window9R[wIdx] = diffR[nIdx];
          window9B[wIdx] = diffB[nIdx];
          wIdx++;
        }
      }

      window9R.sort();
      window9B.sort();
      medDiffR[idx] = window9R[4];
      medDiffB[idx] = window9B[4];
    }
  }

  let finalDiffR: Float32Array<ArrayBufferLike> = medDiffR;
  let finalDiffB: Float32Array<ArrayBufferLike> = medDiffB;
  if (sensor.falseColorSuppression) {
    const passes = typeof sensor.falseColorSuppression === 'number' ? sensor.falseColorSuppression : 1;
    const fcs = applyFalseColorSuppression(medDiffR, medDiffB, width, height, passes);
    finalDiffR = fcs.filteredRedDiff;
    finalDiffB = fcs.filteredBlueDiff;
  }

  for (let i = 0; i < width * height; i++) {
    filteredR[i] = Math.max(0, finalG[i] + finalDiffR[i]);
    filteredB[i] = Math.max(0, finalG[i] + finalDiffB[i]);
  }

  // Step 6: White Balance, Color Matrix, and sRGB Gamma Transfer Function
  const {
    whiteBalance = [1.0, 1.0, 1.0],
    colorMatrix,
    applySrgbGamma = true,
  } = sensor;
  const [rWb, gWb, bWb] = whiteBalance;
  const mat = colorMatrix || resolveBayerColorMatrix(sensor);

  const rgbBuffer = Buffer.alloc(width * height * 3);
  const floatData = new Float32Array(width * height * 3);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      const bufIdx = idx * 3;

      // Store normalized linear demosaiced Float32 values [0.0, 1.0] before color transforms
      floatData[bufIdx] = filteredR[idx] / 255.0;
      floatData[bufIdx + 1] = finalG[idx] / 255.0;
      floatData[bufIdx + 2] = filteredB[idx] / 255.0;

      let rLin = (filteredR[idx] * rWb) / 255.0;
      let gLin = (finalG[idx] * gWb) / 255.0;
      let bLin = (filteredB[idx] * bWb) / 255.0;

      if (mat) {
        const rT = mat[0] * rLin + mat[1] * gLin + mat[2] * bLin;
        const gT = mat[3] * rLin + mat[4] * gLin + mat[5] * bLin;
        const bT = mat[6] * rLin + mat[7] * gLin + mat[8] * bLin;
        rLin = Math.max(0, rT);
        gLin = Math.max(0, gT);
        bLin = Math.max(0, bT);
      }

      if (applySrgbGamma) {
        rgbBuffer[bufIdx] = Math.max(0, Math.min(255, Math.round(applyIec61966SrgbGamma(rLin) * 255)));
        rgbBuffer[bufIdx + 1] = Math.max(0, Math.min(255, Math.round(applyIec61966SrgbGamma(gLin) * 255)));
        rgbBuffer[bufIdx + 2] = Math.max(0, Math.min(255, Math.round(applyIec61966SrgbGamma(bLin) * 255)));
      } else {
        rgbBuffer[bufIdx] = Math.max(0, Math.min(255, Math.round(rLin * 255)));
        rgbBuffer[bufIdx + 1] = Math.max(0, Math.min(255, Math.round(gLin * 255)));
        rgbBuffer[bufIdx + 2] = Math.max(0, Math.min(255, Math.round(bLin * 255)));
      }
    }
  }

  return {
    data: rgbBuffer,
    floatData,
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
  floatData?: Float32Array;
  width: number;
  height: number;
} {
  if (sensor.demosaicMethod === 'ahd') {
    return demosaicAhdBayerCfa(sensor);
  }
  if (sensor.demosaicMethod === 'rcd') {
    return demosaicRcdBayerCfa(sensor);
  }
  return demosaicAmazeBayerCfa(sensor);
}

/**
 * Decodes Lossless JPEG (ISO/IEC 10918-1 / ITU-T T.81 / LJ92) camera RAW sensor strips.
 */
/** Refuses a lossless JPEG frame over the input limit, the RAW sensor budget, or the strip or tile that holds it. */
function assertLosslessFrameFits(width: number, height: number, expected?: { width: number; height: number }): void {
  assertInputPixels(width, height);
  assertPixelBudget(width, height, RAW_SENSOR_PIXEL_BUDGET);
  if (expected && (width > expected.width || height > expected.height)) {
    throw new InvalidRawSensorError(
      `Lossless JPEG frame of ${width}x${height} pixels is larger than the ${expected.width}x${expected.height} strip it is stored in.`
    );
  }
}

/**
 * Decodes a single-component lossless JPEG (ITU-T T.81 SOF3) sensor strip. The frame header is untrusted: its
 * size is checked against the input limit and the RAW sensor budget, and, when the container says how large the
 * strip or tile is (`expected`), against that size, before any sample is allocated.
 */
export function decodeLosslessJpegStrip(
  strip: Buffer | Uint8Array,
  expected?: { width: number; height: number }
): {
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
  assertLosslessFrameFits(width, height, expected);

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

/** Slack, in bytes, allowed above the sensor size when a deflate strip is inflated (predictor rows, padding). */
const SENSOR_INFLATE_SLACK_BYTES = 1024 * 1024;

/** Inflates a deflate-compressed sensor strip, refusing one that expands to much more than `expectedBytes`. */
function inflateSensorChunk(chunk: Buffer, expectedBytes: number): Buffer {
  try {
    return zlib.inflateSync(chunk, { maxOutputLength: expectedBytes + SENSOR_INFLATE_SLACK_BYTES });
  } catch (err) {
    if (err instanceof RangeError) {
      throw new InvalidRawSensorError(`Deflate sensor strip inflates to more than the ${expectedBytes} bytes its dimensions allow.`);
    }
    throw err;
  }
}

/**
 * Decodes camera RAW sensor Bayer data from TIFF/DNG or raw Bayer frames.
 */
export function decodeRawBayerSensor(
  buffer: Buffer,
  formatHint?: string,
  options?: ConversionOptions
): { rgb: Buffer; rgbFloat?: Float32Array; rgb16?: Uint16Array; width: number; height: number } | null {
  if (!buffer || buffer.length < 16) {
    return null;
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
        compression?: number;
        stripOffsets?: number[];
        stripByteCounts?: number[];
        rowsPerStrip?: number;
        tileWidth?: number;
        tileLength?: number;
        tileOffsets?: number[];
        tileByteCounts?: number[];
        cfaPattern?: BayerPattern;
        subIfds?: number[];
        blackLevel?: number | number[];
        whiteLevel?: number;
        asShotNeutral?: [number, number, number];
        colorMatrix1?: [number, number, number, number, number, number, number, number, number];
        colorMatrix2?: [number, number, number, number, number, number, number, number, number];
        forwardMatrix1?: [number, number, number, number, number, number, number, number, number];
        forwardMatrix2?: [number, number, number, number, number, number, number, number, number];
        activeArea?: [number, number, number, number];
        defaultCropOrigin?: [number, number];
        defaultCropSize?: [number, number];
        calibrationIlluminant1?: number;
        calibrationIlluminant2?: number;
        cctKelvin?: number;
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

          const getNumberArray = (tagType: number, tagCount: number, offsetVal: number): number[] => {
            const arr: number[] = [];
            if (tagCount <= 0) return arr;
            const itemSize = tagType === 3 ? 2 : tagType === 4 ? 4 : tagType === 1 ? 1 : 4;
            const dataOffset = tagCount * itemSize > 4 ? read32(offsetVal) : offsetVal;
            for (let idx = 0; idx < tagCount; idx++) {
              const itemPos = dataOffset + idx * itemSize;
              if (itemPos + itemSize > buffer.length) break;
              if (tagType === 3) {
                arr.push(read16(itemPos));
              } else if (tagType === 4) {
                arr.push(read32(itemPos));
              } else if (tagType === 1) {
                arr.push(buffer.readUInt8(itemPos));
              } else {
                arr.push(read32(itemPos));
              }
            }
            return arr;
          };

          const getRationalArray = (tagType: number, tagCount: number, offsetVal: number): number[] => {
            const arr: number[] = [];
            if (tagCount <= 0) return arr;
            const itemSize = 8;
            const dataOffset = tagCount * itemSize > 4 ? read32(offsetVal) : offsetVal;
            for (let idx = 0; idx < tagCount; idx++) {
              const itemPos = dataOffset + idx * itemSize;
              if (itemPos + itemSize > buffer.length) break;
              let num: number;
              let den: number;
              if (tagType === 10) {
                num = isLE ? buffer.readInt32LE(itemPos) : buffer.readInt32BE(itemPos);
                den = isLE ? buffer.readInt32LE(itemPos + 4) : buffer.readInt32BE(itemPos + 4);
              } else {
                num = isLE ? buffer.readUInt32LE(itemPos) : buffer.readUInt32BE(itemPos);
                den = isLE ? buffer.readUInt32LE(itemPos + 4) : buffer.readUInt32BE(itemPos + 4);
              }
              arr.push(den !== 0 ? num / den : num);
            }
            return arr;
          };

          switch (tag) {
            case 256: data.width = getScalar(); break;
            case 257: data.height = getScalar(); break;
            case 258: data.bitsPerSample = getScalar(); break;
            case 259: data.compression = getScalar(); break;
            case 273: data.stripOffsets = getNumberArray(type, count, valOff); break;
            case 278: data.rowsPerStrip = getScalar(); break;
            case 279: data.stripByteCounts = getNumberArray(type, count, valOff); break;
            case 322: data.tileWidth = getScalar(); break;
            case 323: data.tileLength = getScalar(); break;
            case 324: data.tileOffsets = getNumberArray(type, count, valOff); break;
            case 325: data.tileByteCounts = getNumberArray(type, count, valOff); break;
            case 330: data.subIfds = getNumberArray(type, count, valOff); break;
            case 33422: {
              let p = buffer.subarray(valOff, valOff + 4);
              const isBayer = (b: Uint8Array) =>
                (b[0] === 0 && b[1] === 1 && b[2] === 1 && b[3] === 2) ||
                (b[0] === 2 && b[1] === 1 && b[2] === 1 && b[3] === 0) ||
                (b[0] === 1 && b[1] === 0 && b[2] === 2 && b[3] === 1) ||
                (b[0] === 1 && b[1] === 2 && b[2] === 0 && b[3] === 1);
              if (!isBayer(p)) {
                const ptr = read32(valOff);
                if (ptr > 0 && ptr + 4 <= buffer.length) {
                  p = buffer.subarray(ptr, ptr + 4);
                }
              }
              if (p[0] === 0 && p[1] === 1 && p[2] === 1 && p[3] === 2) data.cfaPattern = 'RGGB';
              else if (p[0] === 2 && p[1] === 1 && p[2] === 1 && p[3] === 0) data.cfaPattern = 'BGGR';
              else if (p[0] === 1 && p[1] === 0 && p[2] === 2 && p[3] === 1) data.cfaPattern = 'GRBG';
              else if (p[0] === 1 && p[1] === 2 && p[2] === 0 && p[3] === 1) data.cfaPattern = 'GBRG';
              else data.cfaPattern = 'UNKNOWN' as any;
              break;
            }
            case 50710: { // DNG ActiveArea [top, left, bottom, right]
              const nums = getNumberArray(type, count, valOff);
              if (nums.length >= 4) {
                data.activeArea = [nums[0], nums[1], nums[2], nums[3]];
              }
              break;
            }
            case 50714: { // DNG BlackLevel
              if (type === 5 || type === 10) {
                const rationals = getRationalArray(type, count, valOff);
                if (rationals.length === 1) data.blackLevel = rationals[0];
                else if (rationals.length > 1) data.blackLevel = rationals;
              } else {
                const nums = getNumberArray(type, count, valOff);
                if (nums.length === 1) data.blackLevel = nums[0];
                else if (nums.length > 1) data.blackLevel = nums;
              }
              break;
            }
            case 50717: { // DNG WhiteLevel
              data.whiteLevel = getScalar();
              break;
            }
            case 50719: { // DNG DefaultCropOrigin [x, y]
              if (type === 5 || type === 10) {
                const r = getRationalArray(type, count, valOff);
                if (r.length >= 2) data.defaultCropOrigin = [Math.round(r[0]), Math.round(r[1])];
              } else {
                const nums = getNumberArray(type, count, valOff);
                if (nums.length >= 2) data.defaultCropOrigin = [nums[0], nums[1]];
              }
              break;
            }
            case 50720: { // DNG DefaultCropSize [width, height]
              if (type === 5 || type === 10) {
                const r = getRationalArray(type, count, valOff);
                if (r.length >= 2) data.defaultCropSize = [Math.round(r[0]), Math.round(r[1])];
              } else {
                const nums = getNumberArray(type, count, valOff);
                if (nums.length >= 2) data.defaultCropSize = [nums[0], nums[1]];
              }
              break;
            }
            case 50721: { // DNG ColorMatrix1
              const rationals = getRationalArray(type, count, valOff);
              if (rationals.length >= 9) {
                data.colorMatrix1 = rationals.slice(0, 9) as [number, number, number, number, number, number, number, number, number];
              }
              break;
            }
            case 50722: { // DNG ColorMatrix2
              const rationals = getRationalArray(type, count, valOff);
              if (rationals.length >= 9) {
                data.colorMatrix2 = rationals.slice(0, 9) as [number, number, number, number, number, number, number, number, number];
              }
              break;
            }
            case 50728: { // DNG AsShotNeutral
              const rationals = getRationalArray(type, count, valOff);
              if (rationals.length >= 3) {
                data.asShotNeutral = [rationals[0], rationals[1], rationals[2]];
              }
              break;
            }
            case 50738: { // DNG ForwardMatrix1 (maps camera coordinates to XYZ D50)
              const rationals = getRationalArray(type, count, valOff);
              if (rationals.length >= 9) {
                data.forwardMatrix1 = rationals.slice(0, 9) as [number, number, number, number, number, number, number, number, number];
              }
              break;
            }
            case 50739: { // DNG ForwardMatrix2 (maps camera coordinates to XYZ D50)
              const rationals = getRationalArray(type, count, valOff);
              if (rationals.length >= 9) {
                data.forwardMatrix2 = rationals.slice(0, 9) as [number, number, number, number, number, number, number, number, number];
              }
              break;
            }
            case 50778: data.calibrationIlluminant1 = getScalar(); break;
            case 50779: data.calibrationIlluminant2 = getScalar(); break;
          }
          curr += 12;
        }
        return data;
      };

      const hasPayload = (d: TagData): boolean =>
        Boolean(
          d.width &&
            d.height &&
            ((d.stripOffsets && d.stripOffsets.length > 0) || (d.tileOffsets && d.tileOffsets.length > 0))
        );

      let chosen: TagData | null = null;
      let rootParsed: TagData | null = null;
      for (const off of ifdOffsets) {
        const parsed = parseIfd(off);
        if (!rootParsed) rootParsed = parsed;
        if (parsed.subIfds && parsed.subIfds.length > 0) {
          for (const subOff of parsed.subIfds) {
            const subParsed = parseIfd(subOff);
            if (hasPayload(subParsed)) {
              chosen = subParsed;
              break;
            }
          }
        }
        if (!chosen && hasPayload(parsed)) {
          chosen = parsed;
        }
        if (chosen) break;
      }

      if (chosen && rootParsed && chosen !== rootParsed) {
        chosen.blackLevel = chosen.blackLevel ?? rootParsed.blackLevel;
        chosen.whiteLevel = chosen.whiteLevel ?? rootParsed.whiteLevel;
        chosen.asShotNeutral = chosen.asShotNeutral ?? rootParsed.asShotNeutral;
        chosen.colorMatrix1 = chosen.colorMatrix1 ?? rootParsed.colorMatrix1;
        chosen.colorMatrix2 = chosen.colorMatrix2 ?? rootParsed.colorMatrix2;
        chosen.forwardMatrix1 = chosen.forwardMatrix1 ?? rootParsed.forwardMatrix1;
        chosen.forwardMatrix2 = chosen.forwardMatrix2 ?? rootParsed.forwardMatrix2;
        chosen.activeArea = chosen.activeArea ?? rootParsed.activeArea;
        chosen.defaultCropOrigin = chosen.defaultCropOrigin ?? rootParsed.defaultCropOrigin;
        chosen.defaultCropSize = chosen.defaultCropSize ?? rootParsed.defaultCropSize;
        chosen.calibrationIlluminant1 = chosen.calibrationIlluminant1 ?? rootParsed.calibrationIlluminant1;
        chosen.calibrationIlluminant2 = chosen.calibrationIlluminant2 ?? rootParsed.calibrationIlluminant2;
        chosen.cfaPattern = chosen.cfaPattern ?? rootParsed.cfaPattern;
      }

      if (chosen && chosen.width && chosen.height) {
        if (
          chosen.compression !== undefined &&
          chosen.compression !== 1 &&
          chosen.compression !== 7 &&
          chosen.compression !== 8 &&
          chosen.compression !== 34892
        ) {
          throw new UnsupportedRawCompressionError(
            `Unsupported RAW/DNG compression format (tag 259 = ${chosen.compression}). Only uncompressed (1), JPEG (7), Deflate (8), and Lossless JPEG (34892) are supported.`
          );
        }
        if (chosen.cfaPattern && !['RGGB', 'BGGR', 'GRBG', 'GBRG'].includes(chosen.cfaPattern)) {
          throw new UnsupportedRawCompressionError(
            `Unsupported sensor pattern '${chosen.cfaPattern}': non-Bayer sensors (such as Fuji X-Trans or Foveon) are not supported.`
          );
        }
        const { width, height } = chosen;
        assertInputPixels(width, height);
        assertPixelBudget(width, height, RAW_SENSOR_PIXEL_BUDGET);
        const bpp = chosen.bitsPerSample || 8;
        const pattern = chosen.cfaPattern || 'RGGB';
        const bytesPerPixel = bpp > 8 ? 2 : 1;

        const decodeSensorChunk = (chunk: Buffer, expW?: number, expH?: number) => {
          let activeChunk = chunk;
          if (chosen.compression === 8) {
            activeChunk = inflateSensorChunk(chunk, (expW || width) * (expH || height) * Math.ceil(bpp / 8));
          } else if (activeChunk.length >= 4 && activeChunk[0] === 0xff && activeChunk[1] === 0xd8) {
            const lj92 = decodeLosslessJpegStrip(activeChunk, { width: expW || width, height: expH || height });
            if (lj92) {
              return { data: lj92.data, width: lj92.width, height: lj92.height, bpp: lj92.bpp };
            }
          }

          const targetW = expW || width;
          const targetH = expH || height;

          if (bpp > 8 && [10, 12, 14].includes(bpp) && activeChunk.length < targetW * targetH * 2) {
            const unpacked = unpackRawSensorBits(activeChunk, targetW, targetH, bpp, isLE);
            return { data: unpacked, width: targetW, height: targetH, bpp };
          }

          const maxPixels = expW && expH ? expW * expH : Math.floor(activeChunk.length / bytesPerPixel);
          const data =
            bpp > 8
              ? new Uint16Array(
                  activeChunk.buffer,
                  activeChunk.byteOffset,
                  Math.min(maxPixels, Math.floor(activeChunk.length / 2))
                )
              : new Uint8Array(activeChunk.buffer, activeChunk.byteOffset, Math.min(maxPixels, activeChunk.length));
          return { data, width: expW, height: expH, bpp };
        };

        let sensorData: Uint16Array | Uint8Array;
        let sensorWidth = width;
        let sensorHeight = height;
        let sensorBpp = bpp;

        if (chosen.tileOffsets && chosen.tileOffsets.length > 0) {
          // Tiled DNG / TIFF sensor decoding
          const tw = chosen.tileWidth || width;
          const th = chosen.tileLength || height;
          const tilesAcross = Math.ceil(width / tw);
          const tilesDown = Math.ceil(height / th);
          const assembled = bpp > 8 ? new Uint16Array(width * height) : new Uint8Array(width * height);

          for (let ty = 0; ty < tilesDown; ty++) {
            for (let tx = 0; tx < tilesAcross; tx++) {
              const tileIdx = ty * tilesAcross + tx;
              if (tileIdx >= chosen.tileOffsets.length) continue;
              const tileOff = chosen.tileOffsets[tileIdx];
              const tileLen =
                (chosen.tileByteCounts && chosen.tileByteCounts[tileIdx]) || tw * th * bytesPerPixel;
              const end = Math.min(buffer.length, tileOff + tileLen);
              if (tileOff >= end) continue;

              const tileDecoded = decodeSensorChunk(buffer.subarray(tileOff, end), tw, th);
              const actualTw = tileDecoded.width || tw;
              const actualTh = tileDecoded.height || th;
              sensorBpp = tileDecoded.bpp;

              const rowCount = Math.min(actualTh, height - ty * th);
              const colCount = Math.min(actualTw, width - tx * tw);
              for (let r = 0; r < rowCount; r++) {
                const srcStart = r * actualTw;
                const dstStart = (ty * th + r) * width + tx * tw;
                for (let c = 0; c < colCount; c++) {
                  assembled[dstStart + c] = tileDecoded.data[srcStart + c];
                }
              }
            }
          }
          sensorData = assembled;
        } else if (chosen.stripOffsets && chosen.stripOffsets.length > 0) {
          const stripCount = chosen.stripOffsets.length;
          const rowsPerStrip = chosen.rowsPerStrip || Math.ceil(height / stripCount);

          if (stripCount === 1) {
            const stripOffset = chosen.stripOffsets[0];
            const byteCount =
              (chosen.stripByteCounts && chosen.stripByteCounts[0]) || width * height * bytesPerPixel;
            const end = Math.min(buffer.length, stripOffset + byteCount);
            const decoded = decodeSensorChunk(buffer.subarray(stripOffset, end), width, height);
            sensorData = decoded.data;
            sensorWidth = decoded.width || width;
            sensorHeight = decoded.height || height;
            sensorBpp = decoded.bpp;
          } else {
            // Multi-strip sensor assembly
            const assembled = bpp > 8 ? new Uint16Array(width * height) : new Uint8Array(width * height);
            let currentRow = 0;

            for (let sIdx = 0; sIdx < stripCount; sIdx++) {
              if (currentRow >= height) break;
              const sOff = chosen.stripOffsets[sIdx];
              const sBytes =
                (chosen.stripByteCounts && chosen.stripByteCounts[sIdx]) ||
                width * rowsPerStrip * bytesPerPixel;
              const end = Math.min(buffer.length, sOff + sBytes);
              if (sOff >= end) continue;

              const stripRows = Math.min(rowsPerStrip, height - currentRow);
              const decoded = decodeSensorChunk(buffer.subarray(sOff, end), width, stripRows);
              const actualRows = decoded.height || stripRows;
              sensorBpp = decoded.bpp;

              const copyPixels = Math.min(actualRows * width, (height - currentRow) * width, decoded.data.length);
              assembled.set(decoded.data.subarray(0, copyPixels), currentRow * width);
              currentRow += actualRows;
            }
            sensorData = assembled;
          }
        } else {
          return null;
        }

        let whiteBalance: [number, number, number] | undefined;
        if (chosen.asShotNeutral && chosen.asShotNeutral.length >= 3) {
          const [nR, nG, nB] = chosen.asShotNeutral;
          if (nR > 0 && nG > 0 && nB > 0) {
            whiteBalance = [1 / nR, 1 / nG, 1 / nB];
          }
        }

        // In Adobe DNG 1.7.1.0:
        // ForwardMatrix maps Camera -> XYZ_D50, so M = M_XYZ_to_sRGB * ForwardMatrix
        // ColorMatrix maps XYZ_D50 -> Camera, so M = M_XYZ_to_sRGB * ColorMatrix^-1
        let resolvedColorMatrix: [number, number, number, number, number, number, number, number, number] | undefined;
        if (chosen.forwardMatrix1) {
          let fwd = chosen.forwardMatrix1;
          if (chosen.forwardMatrix2) {
            let cct = chosen.cctKelvin;
            if (typeof cct !== 'number' || isNaN(cct) || cct <= 0) {
              cct = whiteBalance ? estimateCctFromWhiteBalance(whiteBalance) : 5500;
            }
            fwd = interpolateDualIlluminantColorMatrix(cct, chosen.forwardMatrix1, chosen.forwardMatrix2);
          }
          resolvedColorMatrix = multiply3x3(XYZ_D50_TO_SRGB_MATRIX, fwd);
        } else if (chosen.colorMatrix1) {
          let cm = chosen.colorMatrix1;
          if (chosen.colorMatrix2) {
            let cct = chosen.cctKelvin;
            if (typeof cct !== 'number' || isNaN(cct) || cct <= 0) {
              cct = whiteBalance ? estimateCctFromWhiteBalance(whiteBalance) : 5500;
            }
            cm = interpolateDualIlluminantColorMatrix(cct, chosen.colorMatrix1, chosen.colorMatrix2);
          }
          const inv = invert3x3(cm);
          if (!inv) {
            throw new Error('Invalid DNG ColorMatrix: matrix is singular or non-invertible.');
          }
          resolvedColorMatrix = multiply3x3(XYZ_D50_TO_SRGB_MATRIX, inv);
        }

        const linearRes = processFloat32LinearPipeline(
          {
            width: sensorWidth,
            height: sensorHeight,
            pattern,
            data: sensorData,
            bitsPerSample: sensorBpp,
            blackLevel: chosen.blackLevel,
            whiteLevel: chosen.whiteLevel,
            asShotNeutral: chosen.asShotNeutral,
            whiteBalance,
            colorMatrix: resolvedColorMatrix,
            colorMatrix1: chosen.colorMatrix1,
            colorMatrix2: chosen.colorMatrix2,
            forwardMatrix1: chosen.forwardMatrix1,
            forwardMatrix2: chosen.forwardMatrix2,
            activeArea: chosen.activeArea,
            defaultCropOrigin: chosen.defaultCropOrigin,
            defaultCropSize: chosen.defaultCropSize,
            cctKelvin: options?.kelvin || chosen.cctKelvin,
            tint: options?.tint,
            applySrgbGamma: options?.targetColorSpace !== 'linear',
            falseColorSuppression: options?.falseColorSuppression,
            demosaicMethod: options?.demosaicMethod,
            highlightReconstruction: options?.highlightReconstruction,
            targetColorSpace: options?.targetColorSpace,
          },
          options
        );

        let outRgb = linearRes.rgb8;
        let outFloat = linearRes.rgbFloat;
        let out16 = linearRes.rgb16;
        let outW = sensorWidth;
        let outH = sensorHeight;

        // Apply ActiveArea / DefaultCrop cropping if specified in DNG tags
        let cropX = 0;
        let cropY = 0;
        let cropW = outW;
        let cropH = outH;

        if (chosen.defaultCropOrigin && chosen.defaultCropSize) {
          cropX = Math.max(0, Math.min(outW - 1, chosen.defaultCropOrigin[0]));
          cropY = Math.max(0, Math.min(outH - 1, chosen.defaultCropOrigin[1]));
          cropW = Math.max(1, Math.min(outW - cropX, chosen.defaultCropSize[0]));
          cropH = Math.max(1, Math.min(outH - cropY, chosen.defaultCropSize[1]));
        } else if (chosen.activeArea && chosen.activeArea.length >= 4) {
          const [top, left, bottom, right] = chosen.activeArea;
          cropY = Math.max(0, Math.min(outH - 1, top));
          cropX = Math.max(0, Math.min(outW - 1, left));
          cropH = Math.max(1, Math.min(outH - cropY, bottom - top));
          cropW = Math.max(1, Math.min(outW - cropX, right - left));
        }

        if (cropX > 0 || cropY > 0 || cropW < outW || cropH < outH) {
          const croppedBuffer = Buffer.alloc(cropW * cropH * 3);
          const croppedFloat = new Float32Array(cropW * cropH * 3);
          const cropped16 = new Uint16Array(cropW * cropH * 3);
          for (let row = 0; row < cropH; row++) {
            const srcOff = ((cropY + row) * outW + cropX) * 3;
            const dstOff = row * cropW * 3;
            outRgb.copy(croppedBuffer, dstOff, srcOff, srcOff + cropW * 3);
            for (let c = 0; c < cropW * 3; c++) {
              croppedFloat[dstOff + c] = outFloat[srcOff + c];
              cropped16[dstOff + c] = out16[srcOff + c];
            }
          }
          outRgb = croppedBuffer;
          outFloat = croppedFloat;
          out16 = cropped16;
          outW = cropW;
          outH = cropH;
        }

        return { rgb: outRgb, rgbFloat: outFloat, rgb16: out16, width: outW, height: outH };
      }
    }
  }


  return null;
}

const JPEG_SOI_MARKER = Buffer.from([0xff, 0xd8, 0xff]);
const JPEG_MARKER_PREFIX = 0xff;
const JPEG_EOI = 0xd9;
const JPEG_SOS = 0xda;
const JPEG_TEM = 0x01;
const JPEG_RST_FIRST = 0xd0;
const JPEG_RST_LAST = 0xd7;
const JPEG_SOI = 0xd8;
const JPEG_MARKER_BYTES = 2;

/**
 * Walks the segments of the JPEG stream that starts at `start` and returns the offset just past its
 * EOI marker, or -1 when the stream is truncated. Walking segments (instead of searching for the
 * first EOI bytes) keeps an Exif thumbnail nested inside an APPn segment from ending the stream early.
 */
function findJpegEnd(buffer: Buffer, start: number): number {
  let pos = start + JPEG_MARKER_BYTES;
  while (pos + 1 < buffer.length) {
    if (buffer[pos] !== JPEG_MARKER_PREFIX) return -1;
    const marker = buffer[pos + 1];
    if (marker === JPEG_MARKER_PREFIX) {
      pos += 1;
      continue;
    }
    if (marker === JPEG_EOI) return pos + JPEG_MARKER_BYTES;
    const hasNoPayload = marker === JPEG_TEM || marker === JPEG_SOI || (marker >= JPEG_RST_FIRST && marker <= JPEG_RST_LAST);
    if (hasNoPayload) {
      pos += JPEG_MARKER_BYTES;
      continue;
    }
    if (pos + 3 >= buffer.length) return -1;
    pos += JPEG_MARKER_BYTES + buffer.readUInt16BE(pos + JPEG_MARKER_BYTES);
    if (marker === JPEG_SOS) {
      // Entropy-coded data runs until the next marker that is neither a stuffed 0xFF00 nor a restart.
      while (pos + 1 < buffer.length) {
        const next = buffer[pos + 1];
        const isMarker = buffer[pos] === JPEG_MARKER_PREFIX && next !== 0 && !(next >= JPEG_RST_FIRST && next <= JPEG_RST_LAST);
        if (isMarker) break;
        pos += 1;
      }
    }
  }
  return -1;
}

/** Sample depth that sharp reports for 8-bit images. */
const SHARP_EIGHT_BIT_DEPTH = 'uchar';

/**
 * Quality metric the AVIF encoder optimises for. sharp 0.35 defaults to a perceptual (SSIMULACRA2-based)
 * metric that spends roughly 5 dB less PSNR than the encoder tuning of earlier releases at the same
 * `quality`; pinning PSNR keeps a given `quality` value producing the same pixel fidelity.
 */
export const AVIF_TUNE = 'psnr';

/**
 * Encoder effort for AVIF. The bundled libaom 3.15 searches several times longer from the default effort 4
 * upward (a 39-megapixel RAW took about 3 minutes against about 50 seconds with sharp 0.33), while effort 3
 * encodes the same picture in a tenth of that time with the same PSNR (41.8 dB against 41.9 dB at quality 80).
 */
export const AVIF_EFFORT = 3;

/**
 * Keeps ICC profile and EXIF metadata on the output. Samples deeper than 8 bit that carry no profile are
 * the exception: with the profile kept, sharp renders such 16-bit RGB through a wide-gamut working
 * profile and tags the result sRGB, which shifts every colour (red drops, saturation rises). Those images
 * keep only their EXIF block and reach the encoder as plain device RGB, so the high byte of each sample
 * is what reaches an 8-bit output. The pipeline has already been auto-oriented, which removes the
 * Orientation tag from the kept EXIF block.
 */
async function preserveMetadata(pipeline: Sharp): Promise<Sharp> {
  const meta = await pipeline.metadata();
  const isDeepWithoutProfile = meta.depth !== SHARP_EIGHT_BIT_DEPTH && !meta.hasProfile;
  return isDeepWithoutProfile ? pipeline.keepExif() : pipeline.withMetadata();
}

/** Keeps typed conversion errors; wraps any other decoder failure in a ConversionFailedError (HTTP 400). */
function toImageDecodeError(err: unknown): ConversionFailedError {
  const pixelLimit = asInputPixelLimitError(err);
  if (pixelLimit instanceof ConversionFailedError) return pixelLimit;
  if (err instanceof ConversionFailedError) return err;
  const detail = err instanceof Error ? err.message : String(err);
  const failure = new ConversionFailedError(`Invalid image: it could not be decoded (${detail})`);
  failure.cause = err;
  return failure;
}

/** libvips and sharp report a source they cannot read this way (loaders, `*2vips`, corrupt or short input). */
const DECODE_FAILURE_PATTERN =
  /Input (buffer|file)|\b\w*load\w*:|\w+2vips:|corrupt|premature end|end of stream|truncated|unsupported image format|\bread error\b/i;

/**
 * Names a sharp/libvips failure after what failed: a source that cannot be read is a decode error, anything
 * else met while writing the output is an encode error. Typed conversion errors and non-library failures
 * (type errors, exhausted memory) pass through unchanged.
 */
function toImageFailure(err: unknown, target: string): unknown {
  const pixelLimit = asInputPixelLimitError(err);
  if (pixelLimit instanceof ConversionFailedError) return pixelLimit;
  if (err instanceof ConversionFailedError) return err;
  const isLibraryError = err instanceof Error && err.constructor === Error;
  if (!isLibraryError) return err;
  if (DECODE_FAILURE_PATTERN.test(err.message)) return toImageDecodeError(err);
  const failure = new ConversionFailedError(`Cannot encode the image as .${target} (${err.message})`);
  failure.cause = err;
  return failure;
}

const RGB_CHANNEL_COUNT = 3;
const DEFAULT_QUALITY = 85;
/** First EXIF orientation that turns the picture a quarter turn (width and height swap). */
const FIRST_QUARTER_TURN_ORIENTATION = 5;
const MIN_PALETTE_COLOURS = 2;
const MAX_PALETTE_COLOURS = 256;
const FULL_DITHER = 1.0;
const NO_DITHER = 0.0;
const QUALITY_RANGE = { min: 1, max: 100 } as const;

/** The validated width, height and fit the request asks for, or null when it does not resize. */
function requestedResizeOf(options: ConversionOptions): PageResize | null {
  const width = outputSideOf(options.width, 'width');
  const height = outputSideOf(options.height, 'height');
  if (width === undefined && height === undefined) return null;
  return { width, height, fit: options.fit || 'contain' };
}

/**
 * Resize parameters for the requested width/height, or null when the request does not resize. The sides are
 * validated here, before sharp sees them, and a box over the output pixel limit is refused.
 */
function resizeOptionsOf(
  options: ConversionOptions,
  background: ReturnType<typeof parseBackground>,
  isOpaqueTarget: boolean
): ResizeOptions | null {
  const requested = requestedResizeOf(options);
  if (!requested) return null;
  if (requested.width !== undefined && requested.height !== undefined) assertOutputPixels(requested.width, requested.height);
  return {
    width: requested.width,
    height: requested.height,
    fit: requested.fit,
    background: letterboxColour(background, isOpaqueTarget),
  };
}

/** File extension of a target format's output (Ultra HDR is a JPEG). */
function outputExtensionOf(fmt: string): string {
  return fmt === 'ultrahdr' ? 'jpg' : fmt;
}

/** The custom quantizers work on a single frame; applying them to a stacked animation would merge its frames. */
function assertAnimatableOptions(options: ConversionOptions): void {
  if (options.quantizer === 'oklab' || options.ditherMethod === 'riemersma' || options.ditherMethod === 'blue-noise') {
    throw new UnsupportedOptionError(
      'The oklab quantizer, riemersma and blue-noise dithering work on one frame and cannot be applied to an animated GIF; remove them or select a single frame with the "page" option'
    );
  }
}

/** The EPS, EXR and Ultra HDR encoders read three bytes per pixel; any other layout would shear the picture. */
function assertRgbSamples(info: OutputInfo, target: string): void {
  if (info.channels !== RGB_CHANNEL_COUNT) {
    throw new ConversionFailedError(
      `Cannot encode .${target}: expected 3 colour channels per pixel but the decoded image has ${info.channels}`
    );
  }
}

/**
 * The float arrays of EXR and Ultra HDR output are width x height x 3 values: refuse a picture over the HDR
 * budget from its header, with the resize that will be applied, before the raster is decoded.
 */
async function assertFloatBudgetBeforeDecode(pipeline: Sharp, options: ConversionOptions): Promise<void> {
  const { width, height, orientation } = await pipeline.metadata();
  if (width === undefined || height === undefined) return;
  // The picture is turned upright before it is resized, so a quarter-turn orientation swaps the sides.
  const quarterTurn = (orientation ?? 1) >= FIRST_QUARTER_TURN_ORIENTATION;
  const upright = quarterTurn ? { width: height, height: width } : { width, height };
  const target = resizedDimensions(upright.width, upright.height, options);
  assertPixelBudget(target.width, target.height, HDR_FLOAT_PIXEL_BUDGET);
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
  // Checked before any early-return target (PDF, hOCR, ALTO) does work.
  const background = parseBackground(options.background);

  // Special case: Image to PDF
  if (fmt === 'pdf') {
    if (RAW_CAMERA_FORMATS.has(src)) {
      // Camera files are not readable as a picture: decode to PNG first, then place that on the page.
      const decoded = await convertImage(inputBuffer, 'png', options, originalFilename, src);
      return convertImageToPdf(decoded.buffer, options, baseName, 'png');
    }
    return convertImageToPdf(inputBuffer, options, baseName, src);
  }

  // Special case: Image to hOCR 1.2 XHTML or ALTO 4.x XML
  if (fmt === 'hocr' || fmt === 'alto') {
    await assertEncodedImageWithinLimit(inputBuffer);
    const ocrResult = await performOcr(inputBuffer, options.ocrLanguage, undefined, options.ocrDetectOrientation);
    const isHocr = fmt === 'hocr';
    const xml = isHocr
      ? exportHocr(ocrResult, { documentTitle: baseName, filename: originalFilename })
      : exportAlto(ocrResult, { filename: originalFilename });
    const buffer = Buffer.from(xml, 'utf-8');
    return {
      buffer,
      mimeType: isHocr ? 'application/xhtml+xml' : 'application/xml',
      filename: `${baseName}.${isHocr ? 'hocr' : 'xml'}`,
      size: buffer.length,
      ocrExtractedText: ocrResult.text,
      ocrConfidence: ocrResult.confidence,
    };
  }

  const isOpaqueTarget = OPAQUE_IMAGE_TARGETS.has(fmt);

  // Sanitize SVG inputs against Stored XSS
  let activeBuffer = inputBuffer;
  if (src === 'svg' || isSvg(activeBuffer)) {
    activeBuffer = sanitizeSvgBuffer(activeBuffer);
  }

  // Handle RAW camera inputs by decoding true RAW sensor Bayer/LJ92 data first
  const isRawInput = RAW_CAMERA_FORMATS.has(src);

  let isEmbeddedPreview = false;
  let rawDemosaiced = isRawInput ? decodeRawBayerSensor(activeBuffer, src, options) : null;

  if (isRawInput && !rawDemosaiced) {
    if (!options.allowEmbeddedPreview) {
      throw new RawEngineRequiredError(
        `Unable to decode RAW camera sensor data for .${src} without external raw engine. To extract the embedded preview JPEG instead, enable allowEmbeddedPreview.`
      );
    }
    // Only if true sensor Bayer / LJ92 decoding is not present (e.g. mock camera payload),
    // probe embedded preview stream as fallback
    let largestJpg: Buffer | null = null;
    let searchPos = 0;
    while (searchPos < activeBuffer.length - 4) {
      const startIdx = activeBuffer.indexOf(JPEG_SOI_MARKER, searchPos);
      if (startIdx === -1) break;
      const endIdx = findJpegEnd(activeBuffer, startIdx);
      const candidate = activeBuffer.subarray(startIdx, endIdx === -1 ? undefined : endIdx);
      if (!largestJpg || candidate.length > largestJpg.length) {
        largestJpg = candidate;
      }
      if (endIdx === -1) break;
      searchPos = endIdx;
    }

    if (largestJpg && largestJpg.length >= 64) {
      activeBuffer = largestJpg;
      isEmbeddedPreview = true;
    } else {
      throw new ConversionFailedError(
        `No valid embedded preview found in RAW image .${src}.`
      );
    }
  }

  let pipeline: Sharp;
  let frameSelection: FrameSelection | undefined;

  /** Package outputs that are not one image of the pipeline: assembled animations and per-page ZIPs. */
  const packageMultiFrameSource = async (selection: FrameSelection): Promise<ConversionResult | null> => {
    const frameFields = { sourceFrameCount: selection.sourceFrameCount, frameUsed: selection.frameUsed };
    if (selection.animation) {
      assertAnimatableOptions(options);
      const animated = await encodeDecodedAnimation(
        selection.animation,
        fmt as 'gif' | 'webp',
        resizeOptionsOf(options, background, false),
        {
          quality: options.quality ? Math.max(QUALITY_RANGE.min, Math.min(QUALITY_RANGE.max, options.quality)) : DEFAULT_QUALITY,
          colours: Math.min(MAX_PALETTE_COLOURS, Math.max(MIN_PALETTE_COLOURS, options.colors || MAX_PALETTE_COLOURS)),
          dither: options.dither !== false ? FULL_DITHER : NO_DITHER,
        }
      );
      return {
        buffer: animated,
        mimeType: fmt === 'gif' ? 'image/gif' : 'image/webp',
        filename: `${baseName}.${fmt}`,
        size: animated.length,
        ...frameFields,
      };
    }
    const convertPage = (page: number) =>
      convertImage(
        inputBuffer,
        targetFormat,
        { ...options, page, pages: undefined, multiPageOutput: undefined },
        originalFilename,
        sourceFormat
      );
    if (selection.tiffPages) {
      const joined = await joinPageTiffs(selection.tiffPages, convertPage);
      return {
        buffer: joined,
        mimeType: 'image/tiff',
        filename: `${baseName}.${outputExtensionOf(fmt)}`,
        size: joined.length,
        ...frameFields,
      };
    }
    if (selection.zipPages) {
      const zipped = await zipPageImages(selection.zipPages, convertPage, baseName, outputExtensionOf(fmt));
      return {
        buffer: zipped,
        mimeType: 'application/zip',
        filename: `${baseName}.zip`,
        size: zipped.length,
        ...frameFields,
      };
    }
    return null;
  };

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
        pipeline = await openInputImage(payload);
      }
    } else if (src === 'icns' || activeBuffer.subarray(0, 4).toString('ascii') === 'icns') {
      const payload = decodeIcns(activeBuffer);
      pipeline = await openInputImage(payload);
    } else if (
      src === 'exr' ||
      (activeBuffer.length >= 4 &&
        activeBuffer[0] === 0x76 &&
        activeBuffer[1] === 0x2f &&
        activeBuffer[2] === 0x31 &&
        activeBuffer[3] === 0x01)
    ) {
      const exrDecoded = decodeOpenExr(activeBuffer);
      const sdrRgb = Buffer.alloc(exrDecoded.width * exrDecoded.height * 3);
      const rgb16 = new Uint16Array(exrDecoded.width * exrDecoded.height * 3);
      for (let i = 0; i < exrDecoded.width * exrDecoded.height * 3; i++) {
        const linVal = exrDecoded.rgb[i];
        const srgbVal = applyIec61966SrgbGamma(linVal);
        sdrRgb[i] = Math.max(0, Math.min(255, Math.round(srgbVal * 255.0)));
        rgb16[i] = Math.max(0, Math.min(65535, Math.round(srgbVal * 65535.0)));
      }
      rawDemosaiced = {
        rgb: sdrRgb,
        rgbFloat: exrDecoded.rgb,
        rgb16,
        width: exrDecoded.width,
        height: exrDecoded.height,
      };
      pipeline = sharp(sdrRgb, {
        raw: { width: exrDecoded.width, height: exrDecoded.height, channels: 3 },
      });
    } else if (src === 'ultrahdr') {
      const uHdr = await reconstructUltraHdr(activeBuffer);
      const rgb16 = new Uint16Array(uHdr.width * uHdr.height * 3);
      for (let i = 0; i < uHdr.width * uHdr.height * 3; i++) {
        rgb16[i] = Math.max(0, Math.min(65535, Math.round(applyIec61966SrgbGamma(uHdr.rgbFloat[i]) * 65535.0)));
      }
      rawDemosaiced = {
        rgb: uHdr.sdrRgb,
        rgbFloat: uHdr.rgbFloat,
        rgb16,
        width: uHdr.width,
        height: uHdr.height,
      };
      pipeline = sharp(uHdr.sdrRgb, {
        raw: { width: uHdr.width, height: uHdr.height, channels: 3 },
      });
    } else {
      // Multi-frame sources: animated targets keep every frame, still targets take frame 1 (or `page`),
      // multi-page documents become one image per page.
      // The declared canvas is checked from the header before any frame or page is decoded.
      await assertEncodedImageWithinLimit(activeBuffer);
      frameSelection = await selectFrames(activeBuffer, fmt, options, requestedResizeOf(options));
      const packaged = await packageMultiFrameSource(frameSelection);
      if (packaged) return packaged;
      pipeline = openLimitedSharp(frameSelection.source, frameSelection.input);
    }

    if (isRawInput) {
      await pipeline.metadata();
    }

    // Apply the EXIF Orientation (1-8) to the pixels before any resize, so sizes follow the upright image,
    // and drop the tag so metadata kept on the output never makes a viewer rotate the image a second time.
    pipeline = pipeline.rotate();

    // Preserve ICC color profiles and EXIF metadata unless explicitly stripped
    if (options.stripMetadata !== true) {
      pipeline = await preserveMetadata(pipeline);
    }
  } catch (err: unknown) {
    if (err instanceof InputPixelLimitError) throw err;
    if (isRawInput) {
      const demosaiced = decodeRawBayerSensor(inputBuffer, src, options);
      if (demosaiced) {
        pipeline = sharp(demosaiced.rgb, {
          raw: { width: demosaiced.width, height: demosaiced.height, channels: 3 },
        });
      } else {
        throw new RawEngineRequiredError(`Unsupported camera RAW format '${src}': unable to decode RAW sensor data without native RAW decoder`);
      }
    } else {
      throw toImageDecodeError(err);
    }
  }

  // libvips uses only the first component of a background colour for 1 and 2 band (gray) images; work in
  // sRGB whenever a background colour is applied so flatten and letterbox bars get the whole colour.
  if (background !== undefined || isOpaqueTarget) {
    pipeline = pipeline.pipelineColourspace('srgb');
  }

  // Resize options
  const resizeOptions = resizeOptionsOf(options, background, isOpaqueTarget);
  if (resizeOptions) {
    const canvas = frameSelection?.keepsAnimation ? frameSelection.canvas : undefined;
    if (canvas) {
      const resized = resizedDimensions(canvas.width, canvas.height, resizeOptions);
      assertAnimationBudget(resized.width, resized.height, canvas.frames, 'The resized animation');
    } else {
      const source = await pipeline.metadata();
      const swapsSides = (source.orientation ?? 1) >= FIRST_QUARTER_TURN_ORIENTATION;
      const sourceWidth = (swapsSides ? source.height : source.width) ?? 0;
      const sourceHeight = (swapsSides ? source.width : source.height) ?? 0;
      if (sourceWidth > 0 && sourceHeight > 0) {
        const resized = resizedDimensions(sourceWidth, sourceHeight, resizeOptions);
        assertOutputPixels(resized.width, resized.height);
      }
    }
    pipeline = pipeline.resize(resizeOptions);
  }

  // Targets without an alpha channel would turn transparent pixels black: flatten them onto the background.
  if (isOpaqueTarget) {
    pipeline = pipeline.flatten({ background: flattenColour(background) });
  }


  const quality = options.quality ? Math.max(1, Math.min(100, options.quality)) : DEFAULT_QUALITY;

  let outputBuffer: Buffer;
  let mimeType: string;

  try {
    switch (fmt) {
      case 'jpg':
      case 'jpeg':
        if (options.gainMap && rawDemosaiced && rawDemosaiced.rgbFloat) {
          outputBuffer = await encodeUltraHdrJpeg(
            rawDemosaiced.rgb,
            rawDemosaiced.rgbFloat,
            rawDemosaiced.width,
            rawDemosaiced.height,
            { quality }
          );
        } else {
          outputBuffer = await pipeline.jpeg({ quality, mozjpeg: true }).toBuffer();
        }
        mimeType = 'image/jpeg';
        break;

      case 'png': {
        if (
          (options.outputDepth === 16 || options.colorDepth === 16) &&
          rawDemosaiced &&
          rawDemosaiced.rgb16
        ) {
          const icc =
            options.targetColorSpace === 'display-p3'
              ? DISPLAY_P3_ICC
              : options.targetColorSpace === 'rec2020'
              ? REC2020_ICC
              : undefined;
          outputBuffer = encode16BitPng(
            rawDemosaiced.width,
            rawDemosaiced.height,
            rawDemosaiced.rgb16,
            icc
          );
          mimeType = 'image/png';
          break;
        }
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
              assertPixelBudget(info.width, info.height, QUANTIZER_PIXEL_BUDGET);
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
        outputBuffer = await pipeline.avif({ quality, tune: AVIF_TUNE, effort: AVIF_EFFORT }).toBuffer();
        mimeType = 'image/avif';
        break;

      case 'tiff': {
        if (
          (options.outputDepth === 16 || options.colorDepth === 16) &&
          rawDemosaiced &&
          rawDemosaiced.rgb16
        ) {
          const icc =
            options.targetColorSpace === 'display-p3'
              ? DISPLAY_P3_ICC
              : options.targetColorSpace === 'rec2020'
              ? REC2020_ICC
              : undefined;
          outputBuffer = encode16BitTiff(
            rawDemosaiced.width,
            rawDemosaiced.height,
            rawDemosaiced.rgb16,
            icc
          );
        } else {
          outputBuffer = await pipeline.tiff({ quality }).toBuffer();
        }
        mimeType = 'image/tiff';
        break;
      }

      case 'exr': {
        if (rawDemosaiced && rawDemosaiced.rgbFloat) {
          outputBuffer = encodeOpenExr(
            rawDemosaiced.rgbFloat,
            rawDemosaiced.width,
            rawDemosaiced.height,
            options.outputDepth !== 32
          );
        } else {
          let hdrFloat: Float32Array | null = null;
          let imgW = 0;
          let imgH = 0;
          if (src === 'ultrahdr') {
            const uHdr = await reconstructUltraHdr(activeBuffer);
            hdrFloat = uHdr.rgbFloat;
            imgW = uHdr.width;
            imgH = uHdr.height;
          } else {
            try {
              const uHdr = await reconstructUltraHdr(activeBuffer);
              hdrFloat = uHdr.rgbFloat;
              imgW = uHdr.width;
              imgH = uHdr.height;
            } catch (err) {
              // Standard non-UltraHDR image; an image over the pixel limit is never tolerated.
              rethrowInputPixelLimit(err);
            }
          }

          if (hdrFloat && imgW > 0 && imgH > 0) {
            outputBuffer = encodeOpenExr(hdrFloat, imgW, imgH, options.outputDepth !== 32);
          } else {
            await assertFloatBudgetBeforeDecode(pipeline, options);
            const { data, info } = await pipeline
              .raw()
              .toBuffer({ resolveWithObject: true });
            assertPixelBudget(info.width, info.height, HDR_FLOAT_PIXEL_BUDGET);
            assertRgbSamples(info, fmt);
            const floatPix = new Float32Array(info.width * info.height * 3);
            for (let i = 0; i < data.length; i++) {
              floatPix[i] = inverseIec61966SrgbGamma(data[i] / 255.0);
            }
            outputBuffer = encodeOpenExr(floatPix, info.width, info.height, options.outputDepth !== 32);
          }
        }
        mimeType = 'image/x-exr';
        break;
      }

      case 'ultrahdr': {
        if (rawDemosaiced && rawDemosaiced.rgbFloat) {
          outputBuffer = await encodeUltraHdrJpeg(
            rawDemosaiced.rgb,
            rawDemosaiced.rgbFloat,
            rawDemosaiced.width,
            rawDemosaiced.height,
            { quality }
          );
        } else {
          await assertFloatBudgetBeforeDecode(pipeline, options);
          const { data, info } = await pipeline
            .raw()
            .toBuffer({ resolveWithObject: true });
          assertPixelBudget(info.width, info.height, HDR_FLOAT_PIXEL_BUDGET);
          assertRgbSamples(info, fmt);
          const floatPix = new Float32Array(info.width * info.height * 3);
          for (let i = 0; i < data.length; i++) {
            floatPix[i] = inverseIec61966SrgbGamma(data[i] / 255.0);
          }
          outputBuffer = await encodeUltraHdrJpeg(data, floatPix, info.width, info.height, { quality });
        }
        mimeType = 'image/jpeg';
        break;
      }

      case 'gif': {
        const colours = Math.min(256, Math.max(2, options.colors || 256));
        if (
          options.quantizer === 'oklab' ||
          options.ditherMethod === 'riemersma' ||
          options.ditherMethod === 'blue-noise'
        ) {
          if (frameSelection?.keepsAnimation) {
            assertAnimatableOptions(options);
          }
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
            assertPixelBudget(info.width, info.height, QUANTIZER_PIXEL_BUDGET);
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
          assertPixelBudget(info.width, info.height, QUANTIZER_PIXEL_BUDGET);
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
            assertPixelBudget(info.width, info.height, QUANTIZER_PIXEL_BUDGET);
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
        const { data: rgbaPixels, info } = await pipeline.toColourspace('srgb').ensureAlpha().raw().toBuffer({ resolveWithObject: true });
        if (info.channels !== PSD_CHANNELS) {
          throw new ConversionFailedError(`PSD encoding needs RGBA pixels; the picture decoded to ${info.channels} channels.`);
        }
        outputBuffer = encodePsd(rgbaPixels, info.width, info.height);
        mimeType = 'image/vnd.adobe.photoshop';
        break;
      }

      case 'eps':
      case 'ps': {
        const { data: rawRgb, info } = await pipeline
          .raw()
          .toBuffer({ resolveWithObject: true });
        assertRgbSamples(info, fmt);
        outputBuffer = encodePostscript(rawRgb, info.width, info.height, fmt === 'eps');
        mimeType = 'application/postscript';
        break;
      }

      case 'odd': {
        // OpenDocument Drawing package embedding the picture as a full-page frame
        const { data: pngPicture, info } = await pipeline.png().toBuffer({ resolveWithObject: true });
        outputBuffer = await buildOdgPackage(pngPicture, info.width, info.height);
        mimeType = 'application/vnd.oasis.opendocument.graphics';
        break;
      }

      case 'xps': {
        // Embed the decoded, oriented and resized picture; undecodable input is an error, never a stand-in.
        const picture = await pipeline.png().toBuffer({ resolveWithObject: true });
        outputBuffer = await buildOpenXpsPackage(
          [
            {
              title: baseName,
              image: {
                buffer: withPngDensity96(picture.data),
                format: 'png',
                width: picture.info.width,
                height: picture.info.height,
              },
            },
          ],
          baseName
        );
        mimeType = 'application/oxps';
        break;
      }

      default:
        throw new UnsupportedTargetError(`Unsupported image target format: ${targetFormat}`);
    }
  } catch (err: unknown) {
    throw toImageFailure(err, fmt);
  }

  const outExt = outputExtensionOf(fmt);
  return {
    buffer: outputBuffer,
    mimeType,
    filename: `${baseName}.${outExt}`,
    size: outputBuffer.length,
    isEmbeddedPreview: isEmbeddedPreview || undefined,
    ...(frameSelection?.sourceFrameCount === undefined
      ? {}
      : { sourceFrameCount: frameSelection.sourceFrameCount, frameUsed: frameSelection.frameUsed }),
  };
}

/** One PDF page: the oriented picture as PNG plus its pixel size. */
interface PdfPageImage {
  png: Buffer;
  width: number;
  height: number;
}

/** Decodes the pages a PDF is built from: BMP/ICO payloads directly, anything else through the frame rules. */
async function decodePdfPages(
  activeBuffer: Buffer,
  options: ConversionOptions,
  sourceFormat: string | undefined
): Promise<{ pages: PdfPageImage[]; sourceFrameCount?: number; frameUsed?: number }> {
  const toPage = async (pipeline: Sharp): Promise<PdfPageImage> => {
    const { data, info } = await pipeline.rotate().png().toBuffer({ resolveWithObject: true });
    return { png: data, width: info.width, height: info.height };
  };

  if (sourceFormat === 'bmp' || activeBuffer.subarray(0, 2).toString('ascii') === 'BM') {
    const decoded = decodeBmp(activeBuffer);
    return { pages: [await toPage(sharp(decoded.raw, { raw: { width: decoded.width, height: decoded.height, channels: 4 } }))] };
  }
  if (
    sourceFormat === 'ico' ||
    (activeBuffer.length >= 4 && activeBuffer[0] === 0 && activeBuffer[1] === 0 && activeBuffer[2] === 1 && activeBuffer[3] === 0)
  ) {
    return { pages: [await toPage(await openInputImage(decodeIco(activeBuffer)))] };
  }

  // A PDF holds several pages, so a multi-page source keeps all of them here (pdf is not a tiff target).
  // Every page is checked from its own header before it is decoded: page 1's header says nothing of the rest.
  await assertEncodedImageWithinLimit(activeBuffer);
  const selection = await selectFrames(activeBuffer, 'pdf', options);
  const frameFields = { sourceFrameCount: selection.sourceFrameCount, frameUsed: selection.frameUsed };
  if (selection.zipPages) {
    const pages: PdfPageImage[] = [];
    for (const page of selection.zipPages) {
      const pageInput = { page: page - 1 };
      await assertEncodedImageWithinLimit(activeBuffer, undefined, pageInput);
      pages.push(await toPage(openLimitedSharp(activeBuffer, pageInput)));
    }
    return { pages, ...frameFields };
  }
  await assertEncodedImageWithinLimit(selection.source, undefined, selection.input);
  return { pages: [await toPage(openLimitedSharp(selection.source, selection.input))], ...frameFields };
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

  let decodedPages: Awaited<ReturnType<typeof decodePdfPages>>;
  try {
    decodedPages = await decodePdfPages(activeBuffer, options, sourceFormat);
  } catch (err: unknown) {
    throw toImageFailure(err, 'pdf');
  }
  const { pages, sourceFrameCount, frameUsed } = decodedPages;
  const frameFields = sourceFrameCount === undefined ? {} : { sourceFrameCount, frameUsed };

  // If OCR is requested, generate an authentic Searchable PDF with invisible text layer
  if (options.ocrEnabled) {
    if (pages.length !== 1) {
      throw new ConversionFailedError(
        `OCR reads one page at a time but this image has ${pages.length} pages: select one with the "page" option`
      );
    }
    const ocrResult = await performOcr(pages[0].png, options.ocrLanguage, undefined, options.ocrDetectOrientation);
    const searchablePdf = await generateSearchablePdf(pages[0].png, ocrResult, options, baseName);
    return {
      buffer: searchablePdf,
      mimeType: 'application/pdf',
      filename: `${baseName}.pdf`,
      size: searchablePdf.length,
      ocrExtractedText: ocrResult.text,
      ocrConfidence: ocrResult.confidence,
      ...frameFields,
    };
  }

  return new Promise((resolve, reject) => {
    const pageSize = (page: PdfPageImage): [number, number] => {
      const isLandscape = options.orientation === 'landscape' || (page.width > page.height && !options.orientation);
      // The size is already [width, height] in the final orientation, so no layout swap is applied.
      return isLandscape ? [Math.max(page.width, page.height), Math.min(page.width, page.height)] : [page.width, page.height];
    };
    const doc = new PDFDocument({ size: pageSize(pages[0]), margin: 0 });

    const chunks: Buffer[] = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => {
      const buffer = Buffer.concat(chunks);
      resolve({
        buffer,
        mimeType: 'application/pdf',
        filename: `${baseName}.pdf`,
        size: buffer.length,
        ...frameFields,
      });
    });
    doc.on('error', (err) => reject(err));

    pages.forEach((page, index) => {
      if (index > 0) doc.addPage({ size: pageSize(page), margin: 0 });
      doc.image(page.png, 0, 0, {
        fit: [doc.page.width, doc.page.height],
        align: 'center',
        valign: 'center',
      });
    });
    doc.end();
  });
}
