import zlib from 'node:zlib';
import sharp, { type Metadata, type OutputInfo, type ResizeOptions, type Sharp } from 'sharp';
import PDFDocument from 'pdfkit';
import { ConversionOptions, ConversionResult, ConversionFailedError, UnsupportedOptionError, UnsupportedTargetError, UnsupportedRawCompressionError, InvalidRawSensorError, RawEngineRequiredError } from '../types';
import { selectFrames, type FrameSelection, type PageResize } from './image-frames';
import { encodeDecodedAnimation, joinPageTiffs, zipPageImages } from './image-frame-output';
import { assertAnimationBudget, assertOutputPixels, outputSideOf } from './image-limits';
import { flattenColour, letterboxColour, OPAQUE_IMAGE_TARGETS, parseBackground } from './image-background';
import { buildTiffOptions } from './image-tiff-options';
import { encodePsd, PSD_MAX_SIDE, type PsdChannels } from './psd-writer';
import { decodeBmp } from './bmp';
import { buildJpegPdf, planJpegPassthrough } from './pdf-jpeg-passthrough';
import { classifyContent, withoutOpaqueAlpha, type ContentClass } from './image-content';
import {
  AVIF_EFFORT,
  AVIF_TUNE,
  FALLBACK_QUALITY,
  avifBitdepthFor,
  avifOptionsFor,
  clampQuality,
  jpegOptionsFor,
  webpOptionsFor,
} from './image-encoder-defaults';
import {
  LINEAR_PIPELINE_SPACE,
  colourspaceAfterLinearResize,
  needsLinearLight,
  resolveKernel,
} from './image-resample';
import { decodeIco, decodeIcns } from './ico';
import { setAvifColour } from './avif-colour';
import { CICP_MATRIX_IDENTITY, CICP_PRIMARIES_BT2020, CICP_TRANSFER_PQ, type Cicp, writePngCicp } from './cicp';
import { BT709_PRIMARIES, samePrimaries, primariesToPrimaries } from './colour-primaries';
import { type HdrStillTarget, type ToneMapReport, NO_TONE_MAP_MESSAGE, PQ_OUTPUT_TARGETS, encodePq2020, exrNits, exrPrimaries, hdrTransferOf, holdsHdr, renderHdrStill, renderNitsAsSdr, resolveToneMap } from './hdr-image';
import { encodeSrgb } from './hdr-tonemap';
import { decodeLinearBt709 } from './sdr-linear';
import { readStillCicp } from './still-cicp';
import { pipelineFromBitmap, pipelineFromIcon } from './bitmap-pipeline';
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
  quantizeImage,
  quantizePaletteOklab,
  riemersmaDither,
  deltaEOk,
  rgbToOklab,
  oklabToRgb,
  type DitherKind,
} from './color-quantizer';
import { encodeGif } from './gif-writer';
import { performOcr, generateSearchablePdf, exportHocr, exportAlto } from './ocr';
import { isSvg, sanitizeSvgBuffer } from '../security/svg-sanitizer';
import { buildOdgPackage } from './odg';
import { RAW_CAMERA_FORMATS } from './raw-formats';
import { demosaicAhdBayerCfa, demosaicAmazeBayerCfa } from './raw-demosaic';
import { encode16BitPngAsync } from './png16';
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
  encodeOpenExrAsync,
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
  decodeBmp,
  decodeIco,
  decodeIcns,
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

/** The flat-plane tile engines of raw-demosaic.ts, under the names this module has always exported. */
export { demosaicAhdBayerCfa, demosaicAmazeBayerCfa };

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

export { AVIF_EFFORT, AVIF_TUNE };

/**
 * Targets whose output carries an explicit sRGB profile tag. Every other raster target is read as sRGB when it
 * has no profile (the nclx primaries of an AVIF, the default of PNG, JPEG and WebP), so a 480-byte tag there only
 * costs size: 7% of a small AVIF or WebP. An archival TIFF is read by tools that do not assume sRGB.
 */
const SRGB_TAGGED_TARGETS: ReadonlySet<string> = new Set(['tiff', 'tif']);

/** Density (pixels per inch) every viewer assumes for an image that does not state one; it is not worth a metadata block. */
const DEFAULT_DENSITY_PPI = 72;

/**
 * Keeps EXIF, XMP and IPTC metadata on the output and converts the pixels to sRGB through the input's ICC
 * profile. The sRGB profile is attached only for the targets in `SRGB_TAGGED_TARGETS`. An input with no metadata
 * block and the default density keeps nothing: asking the encoder to keep metadata makes it write an EXIF block
 * synthesised from the density (186 bytes, 3.5% of a small AVIF). Samples deeper than 8 bit that carry no
 * profile are another exception: with the profile kept, sharp renders such 16-bit RGB through a wide-gamut
 * working profile and tags the result sRGB, which shifts every colour (red drops, saturation rises). Those
 * images keep only their EXIF block and reach the encoder as plain device RGB, so the high byte of each sample
 * is what reaches an 8-bit output. The pipeline has already been auto-oriented, which removes the Orientation
 * tag from the kept EXIF block.
 */
async function preserveMetadata(pipeline: Sharp, target: string): Promise<Sharp> {
  // Float targets apply the input's own colour description to the samples (see sdr-linear.ts) and write no metadata.
  if (FLOAT_TARGETS.has(target)) return pipeline;
  const meta = await pipeline.metadata();
  const hasMetadataBlock = meta.exif !== undefined || meta.xmp !== undefined || meta.iptc !== undefined;
  const hasCustomDensity = meta.density !== undefined && meta.density !== DEFAULT_DENSITY_PPI;
  const isDeepWithoutProfile = meta.depth !== SHARP_EIGHT_BIT_DEPTH && !meta.hasProfile;
  const tagsSrgb = SRGB_TAGGED_TARGETS.has(target);
  if (isDeepWithoutProfile) return hasMetadataBlock || hasCustomDensity ? pipeline.keepExif() : pipeline;
  if (!hasMetadataBlock && !hasCustomDensity && !meta.hasProfile && !tagsSrgb) return pipeline;
  return pipeline.keepMetadata().withIccProfile('srgb', { attach: tagsSrgb });
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
/** First EXIF orientation that turns the picture a quarter turn (width and height swap). */
const FIRST_QUARTER_TURN_ORIENTATION = 5;
const MIN_PALETTE_COLOURS = 2;
const MAX_PALETTE_COLOURS = 256;
const FULL_DITHER = 1.0;
const NO_DITHER = 0.0;

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
    kernel: resolveKernel(options),
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

/** The dither the request names for the Oklab palette quantizer; error diffusion in linear light by default. */
function ditherKindOf(options: ConversionOptions): DitherKind {
  if (options.dither === false) return 'none';
  if (options.ditherMethod === 'blue-noise') return 'blue-noise';
  if (options.ditherMethod === 'riemersma') return 'riemersma';
  return 'floyd-steinberg';
}

/**
 * Palette and indices of an RGBA raster by the Oklab quantizer, with the raster rebuilt from them (each pixel
 * keeps its own alpha). The raster is refused from its size, before the per-pixel work, when it is over the
 * quantizer budget.
 */
function oklabPaletteRaster(data: Buffer, width: number, height: number, colours: number, options: ConversionOptions) {
  assertPixelBudget(width, height, QUANTIZER_PIXEL_BUDGET);
  const kind = ditherKindOf(options);
  const result = applyOklabQuantizationAndDither({ data, width, height }, colours, kind !== 'none', kind === 'none' ? 'floyd-steinberg' : kind);
  return { palette: result.palette, indexed: result.indexed, rgba: Buffer.from(result.rgba.buffer, result.rgba.byteOffset, result.rgba.byteLength) };
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

/** True for an ICO or CUR file: named by its extension or recognised by the icon directory header (type 1 or 2). */
function isIconContainer(buffer: Buffer, sourceFormat: string): boolean {
  if (sourceFormat === 'ico' || sourceFormat === 'cur') return true;
  const hasDirectoryHeader = buffer.length >= ICON_DIRECTORY_SIGNATURE_BYTES && buffer[0] === 0 && buffer[1] === 0 && buffer[3] === 0;
  return hasDirectoryHeader && (buffer[2] === 1 || buffer[2] === 2);
}

/** Bytes of the icon directory header that identify the container: reserved 0, type 1 or 2, high byte 0. */
const ICON_DIRECTORY_SIGNATURE_BYTES = 4;

const BYTE_MAX_VALUE = 255;
/** Code bits of PQ output: a PNG keeps all 16, an AVIF is written at 10. */
const pqBitsFor = (target: string): number => (target === 'png' ? 16 : 10);

/** Targets written from linear float light, whose colour description is read from the input. */
const FLOAT_TARGETS: ReadonlySet<string> = new Set(['exr', 'ultrahdr']);

/** Targets that can store more than 8 bits per sample, and whose output depth follows the input's. */
const DEPTH_AWARE_TARGETS: ReadonlySet<string> = new Set(['jpg', 'jpeg', 'png', 'tiff']);

/**
 * The 16-bit colourspace a PNG or TIFF is written in when the input has 16 bits per sample (grey stays grey), or
 * undefined for 8-bit inputs and when the request asks for 8 bits. Without it the library reduces the picture to
 * 8 bits on its way out.
 */
function deepColourspaceOf(meta: Metadata | undefined, options: ConversionOptions): 'rgb16' | 'grey16' | undefined {
  if (meta?.depth !== SHARP_SIXTEEN_BIT_DEPTH || options.colorDepth === 8) return undefined;
  return meta.space === 'b-w' || meta.space === 'grey16' ? 'grey16' : 'rgb16';
}

/** True when the colour has no hue (or is absent, which flattens onto white): a grey picture stays grey on it. */
function isNeutralColour(colour: { r: number; g: number; b: number } | undefined): boolean {
  return colour === undefined || (colour.r === colour.g && colour.g === colour.b);
}

/** Targets whose encoder choices (chroma, effort, smart subsampling) follow the content of the picture. */
const LOSSY_CONTENT_TARGETS: ReadonlySet<string> = new Set(['jpg', 'jpeg', 'webp', 'avif']);

/**
 * AVIF from the pipeline: pictures with more than 8 bits per sample are encoded at 10 or 12 bits (the 8-bit path
 * would cap the result near 51 dB PSNR whatever the quality; HDR output stays at 10), and an alpha channel that is fully opaque is
 * dropped instead of encoded as a second plane.
 */
async function encodeAvifFromPipeline(pipeline: Sharp, options: ConversionOptions, content: ContentClass, hdr: boolean): Promise<Buffer> {
  const source = await pipeline.metadata();
  const deep = source.depth === SHARP_SIXTEEN_BIT_DEPTH;
  const opaque = await withoutOpaqueAlpha(pipeline);
  // The metadata describes the input; the encoder sees the upright, resized picture.
  const swapsSides = (source.orientation ?? 1) >= FIRST_QUARTER_TURN_ORIENTATION;
  const upright = swapsSides ? { width: source.height ?? 0, height: source.width ?? 0 } : { width: source.width ?? 0, height: source.height ?? 0 };
  const target = resizedDimensions(upright.width, upright.height, options);
  const grey = source.space === 'b-w' || source.space === 'grey16';
  const prepared = deep ? opaque.toColourspace(grey ? 'grey16' : 'rgb16') : opaque;
  return prepared.avif(avifOptionsFor(options.quality, content, target.width * target.height, avifBitdepthFor(deep, grey, hdr))).toBuffer();
}

/** Sample depth of the 16-bit integer images libvips reports as `ushort`. */
const SHARP_SIXTEEN_BIT_DEPTH = 'ushort';
/** Colourspaces whose pixels an embedded RGB ICC profile describes unchanged. */
const PROFILE_PRESERVING_SPACES: ReadonlySet<string> = new Set(['srgb', 'rgb16']);

/**
 * Renders the pipeline as a flat PSD: 16-bit sources stay 16-bit, alpha stays alpha, an RGB source's ICC profile
 * and density are written as image resources unless metadata is stripped. The size limit is checked from the
 * header (after the requested resize) before the picture is decoded.
 */
async function encodePsdFromPipeline(pipeline: Sharp, options: ConversionOptions): Promise<Buffer> {
  const source = await pipeline.metadata();
  if (source.width !== undefined && source.height !== undefined) {
    const swapsSides = (source.orientation ?? 1) >= FIRST_QUARTER_TURN_ORIENTATION;
    const upright = swapsSides ? { width: source.height, height: source.width } : { width: source.width, height: source.height };
    const target = resizedDimensions(upright.width, upright.height, options);
    if (Math.max(target.width, target.height) > PSD_MAX_SIDE) {
      throw new UnsupportedOptionError(
        `A PSD file holds at most ${PSD_MAX_SIDE} pixels on a side; the picture would be ${target.width} x ${target.height}. Use a smaller size; PSB output is not supported.`
      );
    }
  }
  const sixteenBit = source.depth === SHARP_SIXTEEN_BIT_DEPTH;
  const { data, info } = await pipeline
    .toColourspace(sixteenBit ? 'rgb16' : 'srgb')
    .raw({ depth: sixteenBit ? 'ushort' : 'uchar' })
    .toBuffer({ resolveWithObject: true });
  if (info.channels !== RGB_CHANNEL_COUNT && info.channels !== RGB_CHANNEL_COUNT + 1) {
    throw new ConversionFailedError(`PSD encoding needs RGB or RGBA pixels; the picture decoded to ${info.channels} channels.`);
  }
  const keepsProfile = options.stripMetadata !== true && source.icc !== undefined && PROFILE_PRESERVING_SPACES.has(source.space ?? '');
  return encodePsd({
    width: info.width,
    height: info.height,
    channels: info.channels as PsdChannels,
    depth: sixteenBit ? 16 : 8,
    samples: data,
    icc: keepsProfile ? source.icc : undefined,
    densityPpi: options.stripMetadata === true ? undefined : source.density,
  });
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
  // Validated up front so a typo is never ignored, whatever the source turns out to be.
  const toneMap = resolveToneMap(options);

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
  // HDR handling: what the tone mapping did, whether the output must be tagged BT.2020 / PQ, the colour tag of the
  // input, and radiance already decoded for a float target.
  let toneMapReport: ToneMapReport | undefined;
  let tagsPq = false;
  let inputCicp: Cicp | null = null;
  let hdrRadiance: { rgb: Float32Array; width: number; height: number } | undefined;

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
          quality: clampQuality(options.quality, FALLBACK_QUALITY),
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
      pipeline = await pipelineFromBitmap(decodeBmp(activeBuffer));
    } else if (isIconContainer(activeBuffer, src)) {
      pipeline = await pipelineFromIcon(decodeIco(activeBuffer, requestedResizeOf(options) ?? undefined));
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
      if (toneMap === 'none' && !holdsHdr(fmt, options)) {
        throw new UnsupportedOptionError(NO_TONE_MAP_MESSAGE);
      }
      const renderMode = toneMap === 'none' ? 'bt2390' : toneMap;
      const exrColour = exrPrimaries(exrDecoded.attrs);
      const nits = exrNits(exrDecoded, renderMode);
      const rendition = renderNitsAsSdr(nits, exrColour, renderMode);
      toneMapReport = toneMap === 'none' ? undefined : rendition.report;
      // Float output keeps the radiance, in Rec. 709 primaries (the EXR default) whatever the source declared.
      let radiance = exrDecoded.rgb;
      if (!samePrimaries(exrColour, BT709_PRIMARIES)) {
        const toBt709 = primariesToPrimaries(exrColour, BT709_PRIMARIES);
        radiance = new Float32Array(exrDecoded.rgb.length);
        for (let i = 0; i < radiance.length; i += RGB_CHANNEL_COUNT) {
          const [r, g, b] = [exrDecoded.rgb[i], exrDecoded.rgb[i + 1], exrDecoded.rgb[i + 2]];
          radiance[i] = toBt709[0] * r + toBt709[1] * g + toBt709[2] * b;
          radiance[i + 1] = toBt709[3] * r + toBt709[4] * g + toBt709[5] * b;
          radiance[i + 2] = toBt709[6] * r + toBt709[7] * g + toBt709[8] * b;
        }
      }
      rawDemosaiced = {
        rgb: rendition.rgb,
        rgbFloat: radiance,
        rgb16: rendition.rgb16,
        width: exrDecoded.width,
        height: exrDecoded.height,
      };
      if (toneMap === 'none' && PQ_OUTPUT_TARGETS.has(fmt)) {
        // HDR output: 10-bit PQ in BT.2020, tagged after encoding.
        pipeline = sharp(encodePq2020(nits, exrColour, pqBitsFor(fmt)), { raw: { width: exrDecoded.width, height: exrDecoded.height, channels: RGB_CHANNEL_COUNT } });
        tagsPq = true;
      } else {
        pipeline = sharp(rendition.rgb, {
          raw: { width: exrDecoded.width, height: exrDecoded.height, channels: 3 },
        });
      }
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
      inputCicp = readStillCicp(activeBuffer);
      const hdrTransfer = hdrTransferOf(inputCicp);
      if (inputCicp !== null && hdrTransfer !== null) {
        if (toneMap === 'none' && !holdsHdr(fmt, options)) throw new UnsupportedOptionError(NO_TONE_MAP_MESSAGE);
        let hdrTarget: HdrStillTarget = 'sdr';
        if (fmt === 'exr') hdrTarget = 'radiance';
        else if (toneMap === 'none' && PQ_OUTPUT_TARGETS.has(fmt)) hdrTarget = 'hdr-pq';
        if (hdrTarget === 'radiance' && requestedResizeOf(options) !== null) {
          throw new UnsupportedOptionError('width and height are not applied to HDR radiance output; convert at full size or choose another target');
        }
        const hdr = await renderHdrStill(pipeline, inputCicp, toneMap, hdrTarget, pqBitsFor(fmt));
        pipeline = hdr.pipeline;
        toneMapReport = hdr.report;
        tagsPq = hdr.tagsPq;
        if (hdr.radiance) hdrRadiance = { rgb: hdr.radiance, width: hdr.width, height: hdr.height };
        // The pipeline now holds the rendition (sRGB, or PQ for HDR output): the input's tag no longer describes it.
        inputCicp = null;
      }
    }

    if (isRawInput) {
      await pipeline.metadata();
    }

    // Apply the EXIF Orientation (1-8) to the pixels before any resize, so sizes follow the upright image,
    // and drop the tag so metadata kept on the output never makes a viewer rotate the image a second time.
    pipeline = pipeline.rotate();

    // Preserve ICC color profiles and EXIF metadata unless explicitly stripped
    if (options.stripMetadata !== true) {
      pipeline = await preserveMetadata(pipeline, fmt);
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

  // The kernel is checked even when the request does not resize, so a typo is never silently ignored.
  resolveKernel(options);

  // What the input is, before any resize: a grey source stays a one-component picture in JPEG (three components
  // that always agree only cost bytes), and a source with 16 bits per sample keeps them in PNG and TIFF.
  const inputMeta = DEPTH_AWARE_TARGETS.has(fmt) || FLOAT_TARGETS.has(fmt) ? await pipeline.metadata() : undefined;
  const inputSpace = inputMeta?.space;
  const deepColourspace = deepColourspaceOf(inputMeta, options);

  // Content analysis reads a thumbnail of the picture before any resize is attached to the pipeline.
  const content: ContentClass = LOSSY_CONTENT_TARGETS.has(fmt) && !frameSelection?.keepsAnimation ? await classifyContent(pipeline) : 'photo';

  // Resize options
  const resizeOptions = resizeOptionsOf(options, background, isOpaqueTarget);
  if (resizeOptions) {
    const canvas = frameSelection?.keepsAnimation ? frameSelection.canvas : undefined;
    let linearLight: string | undefined;
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
        if (needsLinearLight(sourceWidth, sourceHeight, resized.width, resized.height)) linearLight = source.space;
      }
    }
    pipeline = pipeline.resize(resizeOptions);
    if (linearLight !== undefined) {
      pipeline = pipeline.pipelineColourspace(LINEAR_PIPELINE_SPACE).toColourspace(colourspaceAfterLinearResize(linearLight));
    }
  }

  // Targets without an alpha channel would turn transparent pixels black: flatten them onto the background.
  if (isOpaqueTarget) {
    pipeline = pipeline.flatten({ background: flattenColour(background) });
  }


  const quality = clampQuality(options.quality, FALLBACK_QUALITY);

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
          const keepsGrey = (inputSpace === 'b-w' || inputSpace === 'grey16') && isNeutralColour(background);
          outputBuffer = await (keepsGrey ? pipeline.toColourspace('b-w') : pipeline).jpeg(jpegOptionsFor(options.quality, content)).toBuffer();
        }
        mimeType = 'image/jpeg';
        break;

      case 'png': {
        if (
          (options.outputDepth === 16 || options.colorDepth === 16) &&
          rawDemosaiced &&
          rawDemosaiced.rgb16 &&
          !tagsPq
        ) {
          const icc =
            options.targetColorSpace === 'display-p3'
              ? DISPLAY_P3_ICC
              : options.targetColorSpace === 'rec2020'
              ? REC2020_ICC
              : undefined;
          outputBuffer = await encode16BitPngAsync(
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

            const rgbaBuffer = oklabPaletteRaster(data, info.width, info.height, colours, options).rgba;

            // The raster already holds only the palette's colours: the encoder must not dither or re-quantize it.
            outputBuffer = await sharp(rgbaBuffer, {
              raw: { width: info.width, height: info.height, channels: 4 },
            })
              .png({ palette: true, colours, dither: 0, compressionLevel: 8 })
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
          outputBuffer = await (deepColourspace ? pipeline.toColourspace(deepColourspace) : pipeline).png({ compressionLevel: 8 }).toBuffer();
        }
        if (tagsPq) outputBuffer = writePngCicp(outputBuffer, { primaries: CICP_PRIMARIES_BT2020, transfer: CICP_TRANSFER_PQ, matrix: CICP_MATRIX_IDENTITY, fullRange: true });
        mimeType = 'image/png';
        break;
      }

      case 'webp':
        outputBuffer = await (await withoutOpaqueAlpha(pipeline)).webp(webpOptionsFor(options.quality, content)).toBuffer();
        mimeType = 'image/webp';
        break;

      case 'avif':
        outputBuffer = await encodeAvifFromPipeline(pipeline, options, content, tagsPq);
        if (tagsPq) outputBuffer = setAvifColour(outputBuffer, CICP_PRIMARIES_BT2020, CICP_TRANSFER_PQ);
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
          outputBuffer = await (deepColourspace ? pipeline.toColourspace(deepColourspace) : pipeline).tiff(buildTiffOptions(options)).toBuffer();
        }
        mimeType = 'image/tiff';
        break;
      }

      case 'exr': {
        if (rawDemosaiced && rawDemosaiced.rgbFloat) {
          outputBuffer = await encodeOpenExrAsync(
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

          if (hdrRadiance) {
            outputBuffer = await encodeOpenExrAsync(hdrRadiance.rgb, hdrRadiance.width, hdrRadiance.height, options.outputDepth !== 32);
          } else if (hdrFloat && imgW > 0 && imgH > 0) {
            outputBuffer = await encodeOpenExrAsync(hdrFloat, imgW, imgH, options.outputDepth !== 32);
          } else {
            await assertFloatBudgetBeforeDecode(pipeline, options);
            // The picture's own colour description (ICC profile or CICP tag) is applied; untagged means sRGB.
            const linear = await decodeLinearBt709(pipeline, inputMeta ?? (await pipeline.metadata()), inputCicp);
            assertPixelBudget(linear.width, linear.height, HDR_FLOAT_PIXEL_BUDGET);
            outputBuffer = await encodeOpenExrAsync(linear.rgb, linear.width, linear.height, options.outputDepth !== 32);
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
          const linear = await decodeLinearBt709(pipeline, inputMeta ?? (await pipeline.metadata()), inputCicp);
          assertPixelBudget(linear.width, linear.height, HDR_FLOAT_PIXEL_BUDGET);
          // The SDR base is the sRGB rendition of the same light, so a wide-gamut or 16-bit source needs no second guess.
          const base = Buffer.allocUnsafe(linear.rgb.length);
          const floatPix = new Float32Array(linear.rgb.length);
          for (let i = 0; i < base.length; i++) {
            base[i] = Math.round(encodeSrgb(linear.rgb[i]) * BYTE_MAX_VALUE);
            floatPix[i] = Math.max(0, linear.rgb[i]);
          }
          outputBuffer = await encodeUltraHdrJpeg(base, floatPix, linear.width, linear.height, { quality });
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
          assertPixelBudget(info.width, info.height, QUANTIZER_PIXEL_BUDGET);
          // The quantizer's palette goes into the GIF as it is: the image library is not asked to quantize again.
          const indexed = quantizeImage(data, info.width, info.height, colours, {
            dither: ditherKindOf(options),
            transparency: 'threshold',
          });
          outputBuffer = encodeGif({ width: info.width, height: info.height, ...indexed });
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

          if (options.quantizer === 'oklab' || options.ditherMethod === 'riemersma' || options.ditherMethod === 'blue-noise') {
            const res = oklabPaletteRaster(data, info.width, info.height, colours, options);
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
          const rgbaBuffer = oklabPaletteRaster(data, info.width, info.height, colours, options).rgba;
          const pngBuf = await sharp(rgbaBuffer, {
            raw: { width: info.width, height: info.height, channels: 4 },
          })
            .png({ palette: true, colours, dither: 0, compressionLevel: 8 })
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
        outputBuffer = await encodePsdFromPipeline(pipeline, options);
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
    ...(toneMapReport === undefined ? {} : { metadata: { toneMap: toneMapReport } }),
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
    return { pages: [await toPage(await pipelineFromBitmap(decodeBmp(activeBuffer)))] };
  }
  if (isIconContainer(activeBuffer, sourceFormat ?? '')) {
    return { pages: [await toPage(await pipelineFromIcon(decodeIco(activeBuffer, requestedResizeOf(options) ?? undefined)))] };
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

/** True when the file starts with the JPEG start-of-image marker and a following marker. */
function looksLikeJpeg(buffer: Buffer): boolean {
  return buffer.length >= JPEG_SOI_MARKER.length && buffer.subarray(0, JPEG_SOI_MARKER.length).equals(JPEG_SOI_MARKER);
}

/**
 * The PDF of a JPEG that goes in unchanged, or null when it must be decoded instead: not a JPEG, a coding the PDF
 * filter does not read (arithmetic, lossless, 12-bit), a header that cannot be read, or a file the image library
 * cannot decode (a truncated scan: the decoding path then answers the typed error). The declared size is checked
 * against the input pixel limit first (HTTP 413).
 */
async function jpegPassthroughPdf(
  buffer: Buffer,
  options: ConversionOptions,
  baseName: string,
  sourceFormat?: string
): Promise<ConversionResult | null> {
  if (sourceFormat !== undefined && sourceFormat !== '' && !JPEG_SOURCE_FORMATS.has(sourceFormat.toLowerCase())) return null;
  if (!looksLikeJpeg(buffer)) return null;
  const plan = planJpegPassthrough(buffer);
  if (plan === null) return null;
  assertInputPixels(plan.width, plan.height);
  try {
    await openLimitedSharp(buffer).stats();
  } catch (err) {
    rethrowInputPixelLimit(err);
    return null;
  }
  const pdf = await buildJpegPdf(buffer, plan, { orientation: options.orientation });
  return { buffer: pdf, mimeType: 'application/pdf', filename: `${baseName}.pdf`, size: pdf.length };
}

const JPEG_SOURCE_FORMATS: ReadonlySet<string> = new Set(['jpg', 'jpeg', 'jpe', 'jfif']);

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

  // A JPEG that a PDF can carry as it is goes in byte for byte (OCR needs pixels, so it takes the decoding path).
  if (!options.ocrEnabled) {
    const passthrough = await jpegPassthroughPdf(activeBuffer, options, baseName, sourceFormat);
    if (passthrough) return passthrough;
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
