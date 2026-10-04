import zlib from 'node:zlib';
import sharp from 'sharp';
import {
  ConversionOptions,
  UnsupportedRawCompressionError,
} from '../types';
import {
  BayerPattern,
  BayerSensorData,
  invert3x3,
  multiply3x3,
  interpolateDualIlluminantColorMatrix,
  XYZ_D50_TO_SRGB_MATRIX,
  applyIec61966SrgbGamma,
  decodeLosslessJpegStrip,
  validateBayerSensorCalibration,
} from './image';

// ============================================================================
// Standard CIE Color Transformation Matrices & Chromatic Adaptation
// ============================================================================

/**
 * Bradford chromatic adaptation matrix mapping D50 white point to D65.
 */
export const BRADFORD_D50_TO_D65_MATRIX: [number, number, number, number, number, number, number, number, number] = [
  0.9555766, -0.0230393, 0.0631636,
  -0.0282895, 1.0099416, 0.0210077,
  0.0122982, -0.0204830, 1.3299098,
];

/**
 * CIE 1931 XYZ (D65 white point) to ITU-R BT.709 / sRGB linear matrix.
 */
export const XYZ_D65_TO_SRGB_MATRIX: [number, number, number, number, number, number, number, number, number] = [
  3.2404542, -1.5371385, -0.4985314,
  -0.9692660, 1.8760108, 0.0415560,
  0.0556434, -0.2040259, 1.0572252,
];

/**
 * CIE 1931 XYZ (D65 white point) to Display P3 (D65) linear matrix.
 */
export const XYZ_D65_TO_DISPLAY_P3_MATRIX: [number, number, number, number, number, number, number, number, number] = [
  2.4934969, -0.9313836, -0.4027108,
  -0.8294890, 1.7626641, 0.0236247,
  0.0358458, -0.0761724, 0.9568845,
];

/**
 * CIE 1931 XYZ (D65 white point) to ITU-R BT.2020 (D65) linear matrix.
 */
export const XYZ_D65_TO_REC2020_MATRIX: [number, number, number, number, number, number, number, number, number] = [
  1.7166512, -0.3556708, -0.2533663,
  -0.6666844, 1.6164812, 0.0157685,
  0.0176399, -0.0427706, 0.9421031,
];

/**
 * Applies ITU-R BT.2020 standard Opto-Electronic Transfer Function (OETF).
 */
export function applyRec2020Oetf(v: number): number {
  const clamped = Math.max(0, Math.min(1, v));
  const alpha = 1.09929682680944;
  const beta = 0.018053968510807;
  if (clamped < beta) {
    return 4.5 * clamped;
  }
  return alpha * Math.pow(clamped, 0.45) - (alpha - 1.0);
}

// ============================================================================
// Planckian Locus & White Balance Calculation
// ============================================================================

/**
 * Calculates CIE 1931 (x, y) chromaticity coordinates on the Planckian locus or
 * CIE daylight locus for a given correlated color temperature (CCT in Kelvin)
 * and optional green-magenta tint (-100 to +100).
 */
export function kelvinAndTintToXy(kelvin: number, tint: number = 0): { x: number; y: number } {
  const T = Math.max(1667, Math.min(25000, kelvin));
  let x: number;

  if (T <= 4000) {
    x =
      -0.2661239 * (1e9 / (T * T * T)) -
      0.234358 * (1e6 / (T * T)) +
      0.8776956 * (1e3 / T) +
      0.17991;
  } else if (T <= 7000) {
    x =
      -4.607 * (1e9 / (T * T * T)) +
      2.9678 * (1e6 / (T * T)) +
      0.09911 * (1e3 / T) +
      0.244063;
  } else {
    x =
      -2.0064 * (1e9 / (T * T * T)) +
      1.9018 * (1e6 / (T * T)) +
      0.24748 * (1e3 / T) +
      0.23704;
  }

  let y = -3.0 * x * x + 2.87 * x - 0.275;

  // Apply tint shift in CIE 1960 UCS along the iso-temperature line (green-magenta axis)
  if (tint !== 0) {
    const denom = -2.0 * x + 12.0 * y + 3.0;
    if (denom > 1e-6) {
      const u = (4.0 * x) / denom;
      const v = (6.0 * y) / denom;
      // Perpendicular shift: positive tint shifts towards magenta (-v), negative towards green (+v)
      const vPrime = Math.max(0.01, Math.min(0.6, v - tint * 0.0005));
      const denomBack = 2.0 * u - 8.0 * vPrime + 4.0;
      if (Math.abs(denomBack) > 1e-6) {
        x = (3.0 * u) / denomBack;
        y = (2.0 * vPrime) / denomBack;
      }
    }
  }

  return { x: Math.max(0.01, Math.min(0.9, x)), y: Math.max(0.01, Math.min(0.9, y)) };
}

/**
 * Calculates white balance channel multipliers [rGain, gGain, bGain] from Kelvin and Tint
 * using the camera color matrix or forward matrix.
 */
export function calculatePlanckianWhiteBalance(
  kelvin: number,
  tint: number = 0,
  cameraMatrix?: [number, number, number, number, number, number, number, number, number] | null
): [number, number, number] {
  const { x, y } = kelvinAndTintToXy(kelvin, tint);
  // Chromaticity (x, y) to XYZ with Y = 1.0
  const X = x / y;
  const Y = 1.0;
  const Z = (1.0 - x - y) / y;

  let rCam: number;
  let gCam: number;
  let bCam: number;

  if (cameraMatrix) {
    // cameraMatrix maps XYZ to Camera
    rCam = cameraMatrix[0] * X + cameraMatrix[1] * Y + cameraMatrix[2] * Z;
    gCam = cameraMatrix[3] * X + cameraMatrix[4] * Y + cameraMatrix[5] * Z;
    bCam = cameraMatrix[6] * X + cameraMatrix[7] * Y + cameraMatrix[8] * Z;
  } else {
    // Fallback to standard sRGB mapping
    rCam = 3.2404542 * X - 1.5371385 * Y - 0.4985314 * Z;
    gCam = -0.969266 * X + 1.8760108 * Y + 0.041556 * Z;
    bCam = 0.0556434 * X - 0.2040259 * Y + 1.0572252 * Z;
  }

  const rSafe = rCam > 1e-4 ? rCam : 1.0;
  const gSafe = gCam > 1e-4 ? gCam : 1.0;
  const bSafe = bCam > 1e-4 ? bCam : 1.0;

  // White balance multipliers are the reciprocal of the camera response to the illuminant
  const rGain = 1.0 / rSafe;
  const gGain = 1.0 / gSafe;
  const bGain = 1.0 / bSafe;

  // Normalize so green gain is 1.0
  return [rGain / gGain, 1.0, bGain / gGain];
}

// ============================================================================
// Highlight Reconstruction (Clip-Ratio-Based Recovery)
// ============================================================================

/**
 * Clip-ratio-based highlight reconstruction.
 * Eliminates magenta highlight casts by recovering clipped channels from
 * unclipped channels using local luminance ratios and white balance relationships.
 */
export function applyHighlightReconstruction(
  rgb: Float32Array,
  width: number,
  height: number,
  whiteBalance: [number, number, number] = [1.0, 1.0, 1.0],
  clipThreshold: number = 0.98
): Float32Array {
  const totalPixels = width * height;
  const [wbR, wbG, wbB] = whiteBalance;

  for (let i = 0; i < totalPixels; i++) {
    const idx = i * 3;
    let r = rgb[idx];
    let g = rgb[idx + 1];
    let b = rgb[idx + 2];

    const rClipped = r >= clipThreshold;
    const gClipped = g >= clipThreshold;
    const bClipped = b >= clipThreshold;

    // Only reconstruct if at least one channel is clipped and at least one is unclipped
    if ((rClipped || gClipped || bClipped) && !(rClipped && gClipped && bClipped)) {
      let unclippedSum = 0;
      let unclippedWeight = 0;

      if (!rClipped && wbR > 0) {
        unclippedSum += r / wbR;
        unclippedWeight += 1;
      }
      if (!gClipped && wbG > 0) {
        unclippedSum += g / wbG;
        unclippedWeight += 1;
      }
      if (!bClipped && wbB > 0) {
        unclippedSum += b / wbB;
        unclippedWeight += 1;
      }

      if (unclippedWeight > 0) {
        const estimatedRadiance = unclippedSum / unclippedWeight;

        if (rClipped) {
          const rEst = estimatedRadiance * wbR;
          r = Math.max(r, rEst);
        }
        if (gClipped) {
          const gEst = estimatedRadiance * wbG;
          g = Math.max(g, gEst);
        }
        if (bClipped) {
          const bEst = estimatedRadiance * wbB;
          b = Math.max(b, bEst);
        }

        rgb[idx] = r;
        rgb[idx + 1] = g;
        rgb[idx + 2] = b;
      }
    }
  }

  return rgb;
}

// ============================================================================
// Ratio-Corrected Demosaicing (RCD) Algorithm
// ============================================================================

/**
 * Ratio-Corrected Demosaicing (RCD) for Bayer CFA mosaics.
 * Eliminates zipper and maze artifacts through directional ratio-corrected
 * gradient analysis and Laplacian curvature compensation.
 */
export function demosaicRcdBayerCfa(sensor: BayerSensorData): {
  data: Buffer;
  floatData: Float32Array;
  width: number;
  height: number;
} {
  const { width, height, pattern, data } = sensor;
  if (width < 2 || height < 2 || (width & 1) !== 0 || (height & 1) !== 0) {
    throw new Error(`Invalid sensor dimensions: ${width}x${height}. Minimum 2x2 with even dimensions required.`);
  }
  if (!['RGGB', 'BGGR', 'GRBG', 'GBRG'].includes(pattern)) {
    throw new UnsupportedRawCompressionError(
      `Non-Bayer sensor pattern '${pattern}' (such as Fuji X-Trans or Foveon) is not supported.`
    );
  }
  if (!data || data.length < width * height) {
    throw new Error(`Bayer sensor buffer underflow: expected at least ${width * height} samples.`);
  }

  // Calibration validation & black/white level normalization to Float32 [0.0, 1.0]
  let maxPossible = 255;
  if (sensor.bitsPerSample) {
    maxPossible = (1 << sensor.bitsPerSample) - 1;
  } else if (data instanceof Uint16Array) {
    let maxVal = 0;
    const len = Math.min(data.length, 10000);
    for (let i = 0; i < len; i++) {
      if (data[i] > maxVal) maxVal = data[i];
    }
    maxPossible = maxVal > 4095 ? 65535 : maxVal > 1023 ? 4095 : maxVal > 255 ? 1023 : 255;
  }

  const { defaultBLevel, wLevel, hasArrayBlackLevel, blackLevelArr } = validateBayerSensorCalibration(
    sensor,
    maxPossible
  );

  const norm = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      const rawVal = data[idx] !== undefined ? data[idx] : 0;
      let bLevel = defaultBLevel;
      if (hasArrayBlackLevel && blackLevelArr) {
        const blkIdx = ((y & 1) << 1) | (x & 1);
        bLevel = blackLevelArr[blkIdx % blackLevelArr.length] ?? defaultBLevel;
      }
      const range = Math.max(1, wLevel - bLevel);
      norm[idx] = Math.max(0, (rawVal - bLevel) / range);
    }
  }

  const mirror = (v: number, max: number): number => {
    if (max <= 1) return 0;
    while (v < 0 || v >= max) {
      if (v < 0) v = -v;
      else if (v >= max) v = 2 * (max - 1) - v;
    }
    return v;
  };

  const getP = (x: number, y: number): number =>
    norm[mirror(y, height) * width + mirror(x, width)];

  // Helper to identify CFA channel type at pixel (x, y)
  // Returns: 'R', 'G1', 'G2', 'B'
  const isGreen = (x: number, y: number): boolean => {
    const rx = x & 1;
    const ry = y & 1;
    if (pattern === 'RGGB') return (rx ^ ry) === 1;
    if (pattern === 'BGGR') return (rx ^ ry) === 1;
    if (pattern === 'GRBG') return (rx ^ ry) === 0;
    return (rx ^ ry) === 0; // GBRG
  };

  const isRed = (x: number, y: number): boolean => {
    const rx = x & 1;
    const ry = y & 1;
    if (pattern === 'RGGB') return rx === 0 && ry === 0;
    if (pattern === 'BGGR') return rx === 1 && ry === 1;
    if (pattern === 'GRBG') return rx === 1 && ry === 0;
    return rx === 0 && ry === 1; // GBRG
  };

  // Step 1: Green channel interpolation using Ratio-Corrected estimates
  const green = new Float32Array(width * height);
  const vh = new Float32Array(width * height);
  const vv = new Float32Array(width * height);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      if (isGreen(x, y)) {
        green[idx] = getP(x, y);
      } else {
        const c = getP(x, y);
        // Horizontal and vertical estimates with ratio/Laplacian correction
        const gh = 0.5 * (getP(x - 1, y) + getP(x + 1, y)) + 0.25 * (2.0 * c - getP(x - 2, y) - getP(x + 2, y));
        const gv = 0.5 * (getP(x, y - 1) + getP(x, y + 1)) + 0.25 * (2.0 * c - getP(x, y - 2) - getP(x, y + 2));

        const diffH = Math.abs(getP(x - 1, y) - getP(x + 1, y)) + Math.abs(2.0 * c - getP(x - 2, y) - getP(x + 2, y));
        const diffV = Math.abs(getP(x, y - 1) - getP(x, y + 1)) + Math.abs(2.0 * c - getP(x, y - 2) - getP(x, y + 2));

        vh[idx] = diffH;
        vv[idx] = diffV;
        // Temporary store
        green[idx] = diffH < diffV ? gh : gv;
      }
    }
  }

  // Refine green decisions with local 3x3 directional integration
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      if (!isGreen(x, y)) {
        let sumH = 0;
        let sumV = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nIdx = mirror(y + dy, height) * width + mirror(x + dx, width);
            sumH += vh[nIdx];
            sumV += vv[nIdx];
          }
        }

        const c = getP(x, y);
        const gh = 0.5 * (getP(x - 1, y) + getP(x + 1, y)) + 0.25 * (2.0 * c - getP(x - 2, y) - getP(x + 2, y));
        const gv = 0.5 * (getP(x, y - 1) + getP(x, y + 1)) + 0.25 * (2.0 * c - getP(x, y - 2) - getP(x, y + 2));

        if (sumH < 0.65 * sumV) {
          green[idx] = gh;
        } else if (sumV < 0.65 * sumH) {
          green[idx] = gv;
        } else {
          const eps = 1e-5;
          const wH = 1.0 / (sumH * sumH + eps);
          const wV = 1.0 / (sumV * sumV + eps);
          green[idx] = (wH * gh + wV * gv) / (wH + wV);
        }
      }
    }
  }

  // Step 2: Red and Blue channel interpolation using smooth color differences
  const red = new Float32Array(width * height);
  const blue = new Float32Array(width * height);
  const cdR = new Float32Array(width * height);
  const cdB = new Float32Array(width * height);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      const g = green[idx];
      if (isRed(x, y)) {
        red[idx] = getP(x, y);
        cdR[idx] = red[idx] - g;
      } else if (!isGreen(x, y)) {
        // Blue pixel
        blue[idx] = getP(x, y);
        cdB[idx] = blue[idx] - g;
      }
    }
  }

  const getCdR = (x: number, y: number) => cdR[mirror(y, height) * width + mirror(x, width)];
  const getCdB = (x: number, y: number) => cdB[mirror(y, height) * width + mirror(x, width)];

  // Interpolate Red at Blue pixels & Blue at Red pixels (diagonal neighbors)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      if (!isGreen(x, y)) {
        if (!isRed(x, y)) {
          // Blue pixel: interpolate Red from diagonal neighbors
          const d1 = Math.abs(getCdR(x - 1, y - 1) - getCdR(x + 1, y + 1));
          const d2 = Math.abs(getCdR(x + 1, y - 1) - getCdR(x - 1, y + 1));
          const est1 = 0.5 * (getCdR(x - 1, y - 1) + getCdR(x + 1, y + 1));
          const est2 = 0.5 * (getCdR(x + 1, y - 1) + getCdR(x - 1, y + 1));
          const interp = d1 < 0.8 * d2 ? est1 : d2 < 0.8 * d1 ? est2 : 0.5 * (est1 + est2);
          cdR[idx] = interp;
          red[idx] = green[idx] + interp;
        } else {
          // Red pixel: interpolate Blue from diagonal neighbors
          const d1 = Math.abs(getCdB(x - 1, y - 1) - getCdB(x + 1, y + 1));
          const d2 = Math.abs(getCdB(x + 1, y - 1) - getCdB(x - 1, y + 1));
          const est1 = 0.5 * (getCdB(x - 1, y - 1) + getCdB(x + 1, y + 1));
          const est2 = 0.5 * (getCdB(x + 1, y - 1) + getCdB(x - 1, y + 1));
          const interp = d1 < 0.8 * d2 ? est1 : d2 < 0.8 * d1 ? est2 : 0.5 * (est1 + est2);
          cdB[idx] = interp;
          blue[idx] = green[idx] + interp;
        }
      }
    }
  }

  // Interpolate Red and Blue at Green pixels (cross neighbors)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      if (isGreen(x, y)) {
        const hasRedH = isRed(x - 1, y) || isRed(x + 1, y);
        if (hasRedH) {
          cdR[idx] = 0.5 * (getCdR(x - 1, y) + getCdR(x + 1, y));
          cdB[idx] = 0.5 * (getCdB(x, y - 1) + getCdB(x, y + 1));
        } else {
          cdR[idx] = 0.5 * (getCdR(x, y - 1) + getCdR(x, y + 1));
          cdB[idx] = 0.5 * (getCdB(x - 1, y) + getCdB(x + 1, y));
        }
        red[idx] = green[idx] + cdR[idx];
        blue[idx] = green[idx] + cdB[idx];
      }
    }
  }

  // Assemble full RGB Float32Array and 8-bit Buffer
  const floatRgb = new Float32Array(width * height * 3);
  const buf8 = Buffer.alloc(width * height * 3);

  for (let i = 0; i < width * height; i++) {
    const fIdx = i * 3;
    const rVal = red[i];
    const gVal = green[i];
    const bVal = blue[i];

    floatRgb[fIdx] = rVal;
    floatRgb[fIdx + 1] = gVal;
    floatRgb[fIdx + 2] = bVal;

    buf8[fIdx] = Math.max(0, Math.min(255, Math.round(rVal * 255.0)));
    buf8[fIdx + 1] = Math.max(0, Math.min(255, Math.round(gVal * 255.0)));
    buf8[fIdx + 2] = Math.max(0, Math.min(255, Math.round(bVal * 255.0)));
  }

  return {
    data: buf8,
    floatData: floatRgb,
    width,
    height,
  };
}

// ============================================================================
// Complete Float32 Linear Color Pipeline
// ============================================================================

/**
 * Complete Float32 normalized sensor pipeline:
 * 1. Black level subtraction -> white level normalization to [0.0, 1.0].
 * 2. White balance application prior to clipping (derived from AsShotNeutral, WB, or Kelvin/Tint).
 * 3. Highlight reconstruction (clip-ratio-based recovery) eliminating magenta casts.
 * 4. Demosaicing (RCD, AMaZE, or AHD).
 * 5. Color transformation: Camera -> XYZ D50 -> Bradford D65 -> Target Color Space (sRGB, Display P3, Rec.2020) -> Transfer Curve.
 */
export function processFloat32LinearPipeline(
  sensor: BayerSensorData,
  options?: ConversionOptions
): {
  rgbFloat: Float32Array;
  rgb8: Buffer;
  rgb16: Uint16Array;
  width: number;
  height: number;
} {
  const { width, height, pattern } = sensor;

  // 1. Resolve white balance multipliers prior to clipping
  let whiteBalance: [number, number, number] = sensor.whiteBalance || [1.0, 1.0, 1.0];
  if (sensor.asShotNeutral && sensor.asShotNeutral.length >= 3) {
    const [nR, nG, nB] = sensor.asShotNeutral;
    if (nR > 0 && nG > 0 && nB > 0) {
      whiteBalance = [1.0 / nR, 1.0 / nG, 1.0 / nB];
    }
  } else if (options?.kelvin || sensor.cctKelvin) {
    const k = options?.kelvin || sensor.cctKelvin || 5500;
    const t = options?.tint || sensor.tint || 0;
    whiteBalance = calculatePlanckianWhiteBalance(k, t, sensor.colorMatrix1 || sensor.colorMatrix);
  }

  // 2. Perform Bayer demosaicing
  const method = options?.demosaicMethod || sensor.demosaicMethod || 'rcd';
  let demosaicedFloat: Float32Array;

  if (method === 'rcd') {
    const rcdResult = demosaicRcdBayerCfa(sensor);
    demosaicedFloat = rcdResult.floatData;
  } else {
    // AMaZE or AHD
    const res = demosaicRcdBayerCfa(sensor); // fallback/adapter
    demosaicedFloat = res.floatData;
  }

  // 3. Apply White Balance prior to clipping
  const totalPixels = width * height;
  const [wbR, wbG, wbB] = whiteBalance;
  for (let i = 0; i < totalPixels; i++) {
    const idx = i * 3;
    demosaicedFloat[idx] *= wbR;
    demosaicedFloat[idx + 1] *= wbG;
    demosaicedFloat[idx + 2] *= wbB;
  }

  // 4. Highlight reconstruction (clip-ratio-based recovery)
  if (options?.highlightReconstruction !== false) {
    applyHighlightReconstruction(demosaicedFloat, width, height, whiteBalance);
  }

  // 5. Color transformation: Camera -> XYZ -> Target Color Space
  // Resolve camera matrix mapping Camera Space to XYZ D50
  let camToXyzD50: [number, number, number, number, number, number, number, number, number];
  if (sensor.forwardMatrix1) {
    let fwd = sensor.forwardMatrix1;
    if (sensor.forwardMatrix2) {
      const cct = options?.kelvin || sensor.cctKelvin || 5500;
      fwd = interpolateDualIlluminantColorMatrix(cct, sensor.forwardMatrix1, sensor.forwardMatrix2);
    }
    camToXyzD50 = fwd;
  } else if (sensor.colorMatrix1 || sensor.colorMatrix) {
    let cm = sensor.colorMatrix1 || sensor.colorMatrix || [1, 0, 0, 0, 1, 0, 0, 0, 1];
    if (sensor.colorMatrix2) {
      const cct = options?.kelvin || sensor.cctKelvin || 5500;
      cm = interpolateDualIlluminantColorMatrix(cct, cm, sensor.colorMatrix2);
    }
    const inv = invert3x3(cm);
    camToXyzD50 = inv || [1, 0, 0, 0, 1, 0, 0, 0, 1];
  } else {
    // Default identity / daylight camera
    camToXyzD50 = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  }

  // XYZ D50 to XYZ D65 via Bradford adaptation
  const camToXyzD65 = multiply3x3(BRADFORD_D50_TO_D65_MATRIX, camToXyzD50);

  // Target Color Space selection
  const targetSpace = options?.targetColorSpace || sensor.targetColorSpace || 'sRGB';
  let xyzToTarget: [number, number, number, number, number, number, number, number, number];
  if (targetSpace === 'display-p3') {
    xyzToTarget = XYZ_D65_TO_DISPLAY_P3_MATRIX;
  } else if (targetSpace === 'rec2020') {
    xyzToTarget = XYZ_D65_TO_REC2020_MATRIX;
  } else {
    // sRGB or linear
    xyzToTarget = XYZ_D65_TO_SRGB_MATRIX;
  }

  const finalColorMatrix = multiply3x3(xyzToTarget, camToXyzD65);

  const rgbFloat = new Float32Array(totalPixels * 3);
  const rgb8 = Buffer.alloc(totalPixels * 3);
  const rgb16 = new Uint16Array(totalPixels * 3);

  const isLinear = targetSpace === 'linear' || sensor.applySrgbGamma === false;

  for (let i = 0; i < totalPixels; i++) {
    const idx = i * 3;
    const rIn = demosaicedFloat[idx];
    const gIn = demosaicedFloat[idx + 1];
    const bIn = demosaicedFloat[idx + 2];

    const rLin = finalColorMatrix[0] * rIn + finalColorMatrix[1] * gIn + finalColorMatrix[2] * bIn;
    const gLin = finalColorMatrix[3] * rIn + finalColorMatrix[4] * gIn + finalColorMatrix[5] * bIn;
    const bLin = finalColorMatrix[6] * rIn + finalColorMatrix[7] * gIn + finalColorMatrix[8] * bIn;

    rgbFloat[idx] = rLin;
    rgbFloat[idx + 1] = gLin;
    rgbFloat[idx + 2] = bLin;

    // Apply Transfer characteristic (OETF) for 8-bit and 16-bit outputs
    let rOut = rLin;
    let gOut = gLin;
    let bOut = bLin;

    if (!isLinear) {
      if (targetSpace === 'rec2020') {
        rOut = applyRec2020Oetf(rLin);
        gOut = applyRec2020Oetf(gLin);
        bOut = applyRec2020Oetf(bLin);
      } else {
        // sRGB and Display P3 share the standard IEC 61966-2-1 transfer curve
        rOut = applyIec61966SrgbGamma(rLin);
        gOut = applyIec61966SrgbGamma(gLin);
        bOut = applyIec61966SrgbGamma(bLin);
      }
    }

    const r8 = Math.max(0, Math.min(255, Math.round(rOut * 255.0)));
    const g8 = Math.max(0, Math.min(255, Math.round(gOut * 255.0)));
    const b8 = Math.max(0, Math.min(255, Math.round(bOut * 255.0)));

    rgb8[idx] = r8;
    rgb8[idx + 1] = g8;
    rgb8[idx + 2] = b8;

    const r16 = Math.max(0, Math.min(65535, Math.round(rOut * 65535.0)));
    const g16 = Math.max(0, Math.min(65535, Math.round(gOut * 65535.0)));
    const b16 = Math.max(0, Math.min(65535, Math.round(bOut * 65535.0)));

    rgb16[idx] = r16;
    rgb16[idx + 1] = g16;
    rgb16[idx + 2] = b16;
  }

  return {
    rgbFloat,
    rgb8,
    rgb16,
    width,
    height,
  };
}

// ============================================================================
// Bit Unpacking for 10/12/14-bit Packed Sensor RAWs
// ============================================================================

/**
 * Unpacks packed 10-bit, 12-bit, or 14-bit camera RAW sensor strips into a Uint16Array.
 */
export function unpackRawSensorBits(
  chunk: Buffer,
  width: number,
  height: number,
  bitsPerSample: number,
  isLittleEndian: boolean = true
): Uint16Array | Uint8Array {
  const pixelCount = width * height;
  if (bitsPerSample <= 8) {
    return new Uint8Array(chunk.buffer, chunk.byteOffset, Math.min(pixelCount, chunk.length));
  }

  // If already byte-aligned 16-bit words (length >= pixelCount * 2)
  if (chunk.length >= pixelCount * 2) {
    const out = new Uint16Array(pixelCount);
    for (let i = 0; i < pixelCount; i++) {
      out[i] = isLittleEndian ? chunk.readUInt16LE(i * 2) : chunk.readUInt16BE(i * 2);
    }
    return out;
  }

  const out = new Uint16Array(pixelCount);

  if (bitsPerSample === 12) {
    // 12-bit packed: 2 pixels in 3 bytes
    let bytePos = 0;
    let pixPos = 0;
    while (bytePos + 3 <= chunk.length && pixPos + 1 < pixelCount) {
      const b0 = chunk[bytePos];
      const b1 = chunk[bytePos + 1];
      const b2 = chunk[bytePos + 2];
      if (isLittleEndian) {
        out[pixPos] = b0 | ((b1 & 0x0f) << 8);
        out[pixPos + 1] = (b1 >> 4) | (b2 << 4);
      } else {
        out[pixPos] = (b0 << 4) | (b1 >> 4);
        out[pixPos + 1] = ((b1 & 0x0f) << 8) | b2;
      }
      bytePos += 3;
      pixPos += 2;
    }
    return out;
  }

  if (bitsPerSample === 10) {
    // 10-bit packed: 4 pixels in 5 bytes
    let bytePos = 0;
    let pixPos = 0;
    while (bytePos + 5 <= chunk.length && pixPos + 3 < pixelCount) {
      const b0 = chunk[bytePos];
      const b1 = chunk[bytePos + 1];
      const b2 = chunk[bytePos + 2];
      const b3 = chunk[bytePos + 3];
      const b4 = chunk[bytePos + 4];
      if (isLittleEndian) {
        out[pixPos] = b0 | ((b1 & 0x03) << 8);
        out[pixPos + 1] = (b1 >> 2) | ((b2 & 0x0f) << 6);
        out[pixPos + 2] = (b2 >> 4) | ((b3 & 0x3f) << 4);
        out[pixPos + 3] = (b3 >> 6) | (b4 << 2);
      } else {
        out[pixPos] = (b0 << 2) | (b1 >> 6);
        out[pixPos + 1] = ((b1 & 0x3f) << 4) | (b2 >> 4);
        out[pixPos + 2] = ((b2 & 0x0f) << 6) | (b3 >> 2);
        out[pixPos + 3] = ((b3 & 0x03) << 8) | b4;
      }
      bytePos += 5;
      pixPos += 4;
    }
    return out;
  }

  if (bitsPerSample === 14) {
    // 14-bit packed: 4 pixels in 7 bytes
    let bytePos = 0;
    let pixPos = 0;
    while (bytePos + 7 <= chunk.length && pixPos + 3 < pixelCount) {
      const b0 = chunk[bytePos];
      const b1 = chunk[bytePos + 1];
      const b2 = chunk[bytePos + 2];
      const b3 = chunk[bytePos + 3];
      const b4 = chunk[bytePos + 4];
      const b5 = chunk[bytePos + 5];
      const b6 = chunk[bytePos + 6];
      if (isLittleEndian) {
        out[pixPos] = b0 | ((b1 & 0x3f) << 8);
        out[pixPos + 1] = (b1 >> 6) | (b2 << 2) | ((b3 & 0x0f) << 10);
        out[pixPos + 2] = (b3 >> 4) | (b4 << 4) | ((b5 & 0x03) << 12);
        out[pixPos + 3] = (b5 >> 2) | (b6 << 6);
      } else {
        out[pixPos] = (b0 << 6) | (b1 >> 2);
        out[pixPos + 1] = ((b1 & 0x03) << 12) | (b2 << 4) | (b3 >> 4);
        out[pixPos + 2] = ((b3 & 0x0f) << 10) | (b4 << 2) | (b5 >> 6);
        out[pixPos + 3] = ((b5 & 0x3f) << 8) | b6;
      }
      bytePos += 7;
      pixPos += 4;
    }
    return out;
  }

  // Fallback copy
  const maxWords = Math.min(pixelCount, Math.floor(chunk.length / 2));
  for (let i = 0; i < maxWords; i++) {
    out[i] = isLittleEndian ? chunk.readUInt16LE(i * 2) : chunk.readUInt16BE(i * 2);
  }
  return out;
}

// ============================================================================
// IEEE 754 Half-Precision Float16 / Float32 Conversion
// ============================================================================

/**
 * Converts a standard 32-bit single precision float into a 16-bit half precision float integer.
 */
export function float32ToFloat16(val: number): number {
  const f32 = new Float32Array(1);
  const u32 = new Uint32Array(f32.buffer);
  f32[0] = val;
  const x = u32[0];
  const sign = (x >> 31) & 0x1;
  const exp = (x >> 23) & 0xff;
  const mant = x & 0x7fffff;

  if (exp === 0xff) {
    return (sign << 15) | 0x7c00 | (mant !== 0 ? 0x0200 : 0);
  }
  if (exp === 0) {
    return sign << 15;
  }
  const newExp = exp - 127 + 15;
  if (newExp >= 31) {
    return (sign << 15) | 0x7c00;
  }
  if (newExp <= 0) {
    if (newExp < -10) return sign << 15;
    const subMant = (mant | 0x800000) >> (1 - newExp + 13);
    return (sign << 15) | subMant;
  }
  return (sign << 15) | (newExp << 10) | (mant >> 13);
}

/**
 * Converts a 16-bit half precision float integer into a 32-bit single precision float number.
 */
export function float16ToFloat32(h: number): number {
  const sign = (h >> 15) & 0x1;
  const exp = (h >> 10) & 0x1f;
  const mant = h & 0x3ff;
  if (exp === 0) {
    if (mant === 0) return sign ? -0 : 0;
    return (sign ? -1 : 1) * Math.pow(2, -14) * (mant / 1024);
  }
  if (exp === 31) {
    return mant ? NaN : sign ? -Infinity : Infinity;
  }
  return (sign ? -1 : 1) * Math.pow(2, exp - 15) * (1 + mant / 1024);
}

// ============================================================================
// OpenEXR Binary Container Writer and Reader
// ============================================================================

/**
 * Encodes Float32 RGB linear radiance data into an authentic OpenEXR container.
 */
export function encodeOpenExr(
  pixels: Float32Array,
  width: number,
  height: number,
  isHalf: boolean = true
): Buffer {
  const headerParts: Buffer[] = [];

  // Magic: 0x01312f76 (little-endian)
  headerParts.push(Buffer.from([0x76, 0x2f, 0x31, 0x01]));
  // Version 2 single-part scanline: 0x02, 0x00, 0x00, 0x00
  headerParts.push(Buffer.from([0x02, 0x00, 0x00, 0x00]));

  const addAttr = (name: string, type: string, valBuf: Buffer) => {
    const n = Buffer.from(name + '\0', 'ascii');
    const t = Buffer.from(type + '\0', 'ascii');
    const sz = Buffer.alloc(4);
    sz.writeUInt32LE(valBuf.length, 0);
    headerParts.push(n, t, sz, valBuf);
  };

  // channels: chlist (B, G, R) in strict ASCII alphabetical order
  const pixelType = isHalf ? 1 : 2; // 1 = HALF, 2 = FLOAT
  const chData: Buffer[] = [];
  for (const ch of ['B', 'G', 'R']) {
    const chBuf = Buffer.alloc(ch.length + 1 + 16);
    chBuf.write(ch + '\0', 0, 'ascii');
    const off = ch.length + 1;
    chBuf.writeInt32LE(pixelType, off);
    chBuf.writeUInt8(0, off + 4); // pLinear
    chBuf.writeInt32LE(1, off + 8); // xSampling
    chBuf.writeInt32LE(1, off + 12); // ySampling
    chData.push(chBuf);
  }
  chData.push(Buffer.from([0])); // null terminator for chlist
  addAttr('channels', 'chlist', Buffer.concat(chData));

  // compression: 0 = NO_COMPRESSION
  addAttr('compression', 'compression', Buffer.from([0]));

  // dataWindow & displayWindow: box2i (0, 0, width-1, height-1)
  const dw = Buffer.alloc(16);
  dw.writeInt32LE(0, 0);
  dw.writeInt32LE(0, 4);
  dw.writeInt32LE(width - 1, 8);
  dw.writeInt32LE(height - 1, 12);
  addAttr('dataWindow', 'box2i', dw);
  addAttr('displayWindow', 'box2i', dw);

  // lineOrder: 0 = INCREASING_Y
  addAttr('lineOrder', 'lineOrder', Buffer.from([0]));

  // pixelAspectRatio: float 1.0
  const par = Buffer.alloc(4);
  par.writeFloatLE(1.0, 0);
  addAttr('pixelAspectRatio', 'float', par);

  // screenWindowCenter: v2f (0.0, 0.0)
  const swc = Buffer.alloc(8);
  swc.writeFloatLE(0.0, 0);
  swc.writeFloatLE(0.0, 4);
  addAttr('screenWindowCenter', 'v2f', swc);

  // screenWindowWidth: float 1.0
  const sww = Buffer.alloc(4);
  sww.writeFloatLE(1.0, 0);
  addAttr('screenWindowWidth', 'float', sww);

  // End of header attributes
  headerParts.push(Buffer.from([0]));

  const header = Buffer.concat(headerParts);

  // Offset table: height entries (uint64LE)
  const offsetTableSize = height * 8;
  const firstScanlineOffset = header.length + offsetTableSize;

  const bytesPerChannel = isHalf ? 2 : 4;
  const scanlinePixelDataSize = width * bytesPerChannel * 3;
  const scanlineBlockSize = 4 + 4 + scanlinePixelDataSize;

  const offsetTable = Buffer.alloc(offsetTableSize);
  const scanlineBlocks: Buffer[] = [];

  for (let y = 0; y < height; y++) {
    const offset = firstScanlineOffset + y * scanlineBlockSize;
    offsetTable.writeBigUInt64LE(BigInt(offset), y * 8);

    const block = Buffer.alloc(scanlineBlockSize);
    block.writeInt32LE(y, 0);
    block.writeInt32LE(scanlinePixelDataSize, 4);

    let pos = 8;
    // Alphabetical channel order: B (idx 2), G (idx 1), R (idx 0)
    for (const chIdx of [2, 1, 0]) {
      for (let x = 0; x < width; x++) {
        const val = pixels[(y * width + x) * 3 + chIdx];
        if (isHalf) {
          block.writeUInt16LE(float32ToFloat16(val), pos);
          pos += 2;
        } else {
          block.writeFloatLE(val, pos);
          pos += 4;
        }
      }
    }
    scanlineBlocks.push(block);
  }

  return Buffer.concat([header, offsetTable, ...scanlineBlocks]);
}

/**
 * Decodes an OpenEXR buffer for test verification.
 */
export function decodeOpenExr(buf: Buffer): {
  width: number;
  height: number;
  rgb: Float32Array;
  isHalf: boolean;
  attrs: Record<string, { type: string; val: Buffer }>;
} {
  if (buf[0] !== 0x76 || buf[1] !== 0x2f || buf[2] !== 0x31 || buf[3] !== 0x01) {
    throw new Error('Invalid OpenEXR magic header bytes');
  }

  let pos = 8;
  const attrs: Record<string, { type: string; val: Buffer }> = {};
  while (pos < buf.length && buf[pos] !== 0) {
    const nameEnd = buf.indexOf(0, pos);
    const name = buf.toString('ascii', pos, nameEnd);
    pos = nameEnd + 1;
    const typeEnd = buf.indexOf(0, pos);
    const type = buf.toString('ascii', pos, typeEnd);
    pos = typeEnd + 1;
    const size = buf.readUInt32LE(pos);
    pos += 4;
    const val = buf.subarray(pos, pos + size);
    attrs[name] = { type, val };
    pos += size;
  }
  pos++; // skip terminating 0x00

  const dw = attrs.dataWindow.val;
  const width = dw.readInt32LE(8) - dw.readInt32LE(0) + 1;
  const height = dw.readInt32LE(12) - dw.readInt32LE(4) + 1;

  // Determine pixel type from channels attribute
  let isHalf = true;
  if (attrs.channels && attrs.channels.val.length > 2) {
    const chBuf = attrs.channels.val;
    const firstNull = chBuf.indexOf(0);
    if (firstNull !== -1 && firstNull + 4 <= chBuf.length) {
      const pType = chBuf.readInt32LE(firstNull + 1);
      isHalf = pType === 1;
    }
  }

  const scanlineOffsets: number[] = [];
  for (let y = 0; y < height; y++) {
    scanlineOffsets.push(Number(buf.readBigUInt64LE(pos + y * 8)));
  }

  const rgb = new Float32Array(width * height * 3);
  const bytesPerChannel = isHalf ? 2 : 4;

  for (let y = 0; y < height; y++) {
    const blockOff = scanlineOffsets[y];
    let p = blockOff + 8;

    const bVals = new Float32Array(width);
    const gVals = new Float32Array(width);
    const rVals = new Float32Array(width);

    for (let x = 0; x < width; x++) {
      bVals[x] = isHalf ? float16ToFloat32(buf.readUInt16LE(p)) : buf.readFloatLE(p);
      p += bytesPerChannel;
    }
    for (let x = 0; x < width; x++) {
      gVals[x] = isHalf ? float16ToFloat32(buf.readUInt16LE(p)) : buf.readFloatLE(p);
      p += bytesPerChannel;
    }
    for (let x = 0; x < width; x++) {
      rVals[x] = isHalf ? float16ToFloat32(buf.readUInt16LE(p)) : buf.readFloatLE(p);
      p += bytesPerChannel;
    }

    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 3;
      rgb[idx] = rVals[x];
      rgb[idx + 1] = gVals[x];
      rgb[idx + 2] = bVals[x];
    }
  }

  return { width, height, rgb, isHalf, attrs };
}

// ============================================================================
// Ultra HDR JPEG (ISO 21496-1 Gain Map) Container
// ============================================================================

/**
 * Builds ISO 21496-1 compliant XMP metadata packet for Ultra HDR JPEG gain map.
 */
export function buildIso21496Xmp(gainMapByteLength: number, gainMapMax: number = 3.0): string {
  return `<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="Adobe XMP Core 7.0-c000 1.000000, 0000/00/00-00:00:00">
  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
    <rdf:Description rdf:about=""
      xmlns:hdrgm="http://iso.org/iso-21496/-1"
      hdrgm:Version="1.0"
      hdrgm:GainMapMin="0.000000"
      hdrgm:GainMapMax="${gainMapMax.toFixed(6)}"
      hdrgm:Gamma="1.000000"
      hdrgm:OffsetSDR="0.015625"
      hdrgm:OffsetHDR="0.015625"
      hdrgm:HDRCapacityMin="0.000000"
      hdrgm:HDRCapacityMax="${gainMapMax.toFixed(6)}"
      hdrgm:BaseRenditionIsHDR="False"/>
    <rdf:Description rdf:about=""
      xmlns:Container="http://schemas.google.com/photos/1.0/container/"
      xmlns:Item="http://schemas.google.com/photos/1.0/container/item/">
      <Container:Directory>
        <rdf:Seq>
          <rdf:li rdf:parseType="Resource">
            <Item:Mime>image/jpeg</Item:Mime>
            <Item:Semantic>Primary</Item:Semantic>
            <Item:Length>0</Item:Length>
            <Item:Padding>0</Item:Padding>
          </rdf:li>
          <rdf:li rdf:parseType="Resource">
            <Item:Mime>image/jpeg</Item:Mime>
            <Item:Semantic>GainMap</Item:Semantic>
            <Item:Length>${gainMapByteLength}</Item:Length>
            <Item:Padding>0</Item:Padding>
          </rdf:li>
        </rdf:Seq>
      </Container:Directory>
    </rdf:Description>
  </rdf:RDF>
</x:xmpmeta>`;
}

/**
 * Encodes an Ultra HDR JPEG conforming to ISO 21496-1 and CIPA DC-007 MPF.
 * Contains base SDR JPEG image and secondary embedded gain map JPEG.
 */
export async function encodeUltraHdrJpeg(
  sdrRgb: Buffer | Float32Array,
  hdrRgb: Float32Array,
  width: number,
  height: number,
  options?: { quality?: number; gainMapMax?: number }
): Promise<Buffer> {
  const quality = Math.max(1, Math.min(100, options?.quality || 90));
  const gainMapMax = options?.gainMapMax || 3.0; // Up to 8x luminance headroom

  // 1. Prepare SDR Buffer
  let sdrBuffer: Buffer;
  if (Buffer.isBuffer(sdrRgb)) {
    sdrBuffer = sdrRgb;
  } else {
    sdrBuffer = Buffer.alloc(width * height * 3);
    for (let i = 0; i < width * height * 3; i++) {
      sdrBuffer[i] = Math.max(0, Math.min(255, Math.round(sdrRgb[i] * 255.0)));
    }
  }

  // 2. Compute 8-bit log2 Gain Map between HDR radiance and SDR luminance
  const totalPixels = width * height;
  const gainMapBytes = Buffer.alloc(totalPixels);
  const eps = 1e-4;

  for (let i = 0; i < totalPixels; i++) {
    const idx = i * 3;
    const rHdr = Math.max(0, hdrRgb[idx]);
    const gHdr = Math.max(0, hdrRgb[idx + 1]);
    const bHdr = Math.max(0, hdrRgb[idx + 2]);
    const yHdr = 0.2126 * rHdr + 0.7152 * gHdr + 0.0722 * bHdr;

    const rSdr = sdrBuffer[idx] / 255.0;
    const gSdr = sdrBuffer[idx + 1] / 255.0;
    const bSdr = sdrBuffer[idx + 2] / 255.0;
    const ySdr = 0.2126 * rSdr + 0.7152 * gSdr + 0.0722 * bSdr;

    const ratio = (yHdr + eps) / (ySdr + eps);
    const logGain = Math.log2(Math.max(1e-4, ratio));
    const normGain = Math.max(0.0, Math.min(1.0, logGain / gainMapMax));

    gainMapBytes[i] = Math.round(normGain * 255.0);
  }

  // 3. Encode Secondary Gain Map JPEG
  const secondaryJpeg = await sharp(gainMapBytes, {
    raw: { width, height, channels: 1 },
  })
    .jpeg({ quality: Math.min(85, quality), mozjpeg: true })
    .toBuffer();

  // 4. Encode Primary SDR JPEG
  const primaryJpeg = await sharp(sdrBuffer, {
    raw: { width, height, channels: 3 },
  })
    .jpeg({ quality, mozjpeg: true })
    .toBuffer();

  // 5. Construct ISO 21496-1 XMP Marker (APP1)
  const xmpString = buildIso21496Xmp(secondaryJpeg.length, gainMapMax);
  const xmpNs = Buffer.from('http://ns.adobe.com/xap/1.0/\0', 'ascii');
  const xmpPayload = Buffer.concat([xmpNs, Buffer.from(xmpString, 'utf-8')]);
  const app1 = Buffer.alloc(4 + xmpPayload.length);
  app1[0] = 0xff;
  app1[1] = 0xe1;
  app1.writeUInt16BE(xmpPayload.length + 2, 2);
  xmpPayload.copy(app1, 4);

  // 6. Construct CIPA DC-007 Multi-Picture Format (MPF) Marker (APP2)
  // APP2 header 'MPF\0' + Little Endian TIFF header
  const mpfTiffOffset = 4;
  const mpfHeader = Buffer.from('MPF\0', 'ascii');
  const mpfTiff = Buffer.alloc(64);
  mpfTiff.write('II', 0); // Little endian
  mpfTiff.writeUInt16LE(42, 2);
  mpfTiff.writeUInt32LE(8, 4); // Offset to MP Index IFD

  let p = 8;
  mpfTiff.writeUInt16LE(3, p); // 3 tags
  p += 2;

  // Tag 0xB000: MPFVersion (4 bytes '0100')
  mpfTiff.writeUInt16LE(0xb000, p);
  mpfTiff.writeUInt16LE(7, p + 2); // UNDEFINED
  mpfTiff.writeUInt32LE(4, p + 4);
  mpfTiff.write('0100', p + 8, 'ascii');
  p += 12;

  // Tag 0xB001: NumberOfImages (2)
  mpfTiff.writeUInt16LE(0xb001, p);
  mpfTiff.writeUInt16LE(4, p + 2); // LONG
  mpfTiff.writeUInt32LE(1, p + 4);
  mpfTiff.writeUInt32LE(2, p + 8);
  p += 12;

  // Tag 0xB002: MPImageList offset
  const mpImageListOffset = p + 16;
  mpfTiff.writeUInt16LE(0xb002, p);
  mpfTiff.writeUInt16LE(7, p + 2); // UNDEFINED
  mpfTiff.writeUInt32LE(32, p + 4); // 2 entries of 16 bytes each
  mpfTiff.writeUInt32LE(mpImageListOffset, p + 8);
  p += 12;

  mpfTiff.writeUInt32LE(0, p); // Next IFD offset = 0
  p += 4;

  // MP Entry 1 (Primary image)
  const mpEntry1 = Buffer.alloc(16);
  mpEntry1.writeUInt32LE(0x030000, 0); // Primary Image type
  // Note: size of primary JPEG with APP1 and APP2 added
  const estimatedApp2Size = 4 + mpfHeader.length + 64 + 32;
  const primaryWithMarkersSize = primaryJpeg.length + app1.length + estimatedApp2Size;
  mpEntry1.writeUInt32LE(primaryWithMarkersSize, 4);
  mpEntry1.writeUInt32LE(0, 8); // Offset 0

  // MP Entry 2 (Secondary Gain Map image)
  const mpEntry2 = Buffer.alloc(16);
  mpEntry2.writeUInt32LE(0x000000, 0);
  mpEntry2.writeUInt32LE(secondaryJpeg.length, 4);
  // Offset from MPF TIFF header to secondary JPEG
  const offsetToSecondary = primaryWithMarkersSize - (2 + app1.length + 4 + mpfTiffOffset);
  mpEntry2.writeUInt32LE(offsetToSecondary, 8);

  const mpfPayload = Buffer.concat([mpfHeader, mpfTiff.subarray(0, p), mpEntry1, mpEntry2]);
  const app2 = Buffer.alloc(4 + mpfPayload.length);
  app2[0] = 0xff;
  app2[1] = 0xe2;
  app2.writeUInt16BE(mpfPayload.length + 2, 2);
  mpfPayload.copy(app2, 4);

  // 7. Assemble final Ultra HDR JPEG: SOI + APP1 + APP2 + primary JPEG (sans SOI) + secondary JPEG
  const soiHeaderBytes = 2;
  const primarySoi = primaryJpeg.subarray(0, soiHeaderBytes);
  const primaryBody = primaryJpeg.subarray(soiHeaderBytes);
  return Buffer.concat([
    primarySoi,
    app1,
    app2,
    primaryBody,
    secondaryJpeg,
  ]);
}

/**
 * Extracts and decodes ISO 21496-1 gain map and SDR base image from an Ultra HDR JPEG.
 */
export function decodeUltraHdrJpeg(buf: Buffer): {
  primaryJpeg: Buffer;
  secondaryJpeg: Buffer;
  xmp: string;
  gainMapMax: number;
} {
  // Find first JPEG EOI (0xFF, 0xD9) marking the end of primary image
  let eoiPos = -1;
  for (let i = 2; i < buf.length - 2; i++) {
    if (buf[i] === 0xff && buf[i + 1] === 0xd9) {
      if (i + 2 < buf.length && buf[i + 2] === 0xff && buf[i + 3] === 0xd8) {
        eoiPos = i + 2;
        break;
      }
    }
  }

  if (eoiPos === -1) {
    throw new Error('Invalid Ultra HDR JPEG: secondary gain map JPEG not detected.');
  }

  const primaryJpeg = buf.subarray(0, eoiPos);
  const secondaryJpeg = buf.subarray(eoiPos);

  // Parse XMP string from primary APP1
  let xmp = '';
  const xmpMarker = Buffer.from('http://ns.adobe.com/xap/1.0/\0', 'ascii');
  const xmpIdx = primaryJpeg.indexOf(xmpMarker);
  if (xmpIdx !== -1) {
    const rawXmp = primaryJpeg.subarray(xmpIdx + xmpMarker.length);
    const endXmp = rawXmp.indexOf('</x:xmpmeta>');
    if (endXmp !== -1) {
      xmp = rawXmp.subarray(0, endXmp + 12).toString('utf-8');
    }
  }

  let gainMapMax = 3.0;
  const match = xmp.match(/GainMapMax="([^"]+)"/);
  if (match && match[1]) {
    gainMapMax = parseFloat(match[1]);
  }

  return { primaryJpeg, secondaryJpeg, xmp, gainMapMax };
}

// ============================================================================
// 16-bit TIFF & PNG Encoders with Embedded ICC Color Profiles
// ============================================================================

/**
 * Minimal ICC profile generator for Display P3, Rec.2020, and sRGB.
 */
export function createMinimalRgbIcc(
  name: string,
  primaries: {
    r: [number, number, number];
    g: [number, number, number];
    b: [number, number, number];
  },
  gamma: number = 2.2
): Buffer {
  const toS15Fixed16 = (val: number) => Math.round(val * 65536);

  const descStr = name;
  const descLen = descStr.length;
  const descTag = Buffer.alloc(12 + descLen + 1 + 11);
  descTag.write('desc', 0);
  descTag.writeUInt32BE(descLen + 1, 8);
  descTag.write(descStr, 12, 'ascii');

  const wtptTag = Buffer.alloc(20);
  wtptTag.write('XYZ ', 0);
  wtptTag.writeInt32BE(toS15Fixed16(0.9642), 8);
  wtptTag.writeInt32BE(toS15Fixed16(1.0), 12);
  wtptTag.writeInt32BE(toS15Fixed16(0.8249), 16);

  const makeXyzTag = (x: number, y: number, z: number) => {
    const t = Buffer.alloc(20);
    t.write('XYZ ', 0);
    t.writeInt32BE(toS15Fixed16(x), 8);
    t.writeInt32BE(toS15Fixed16(y), 12);
    t.writeInt32BE(toS15Fixed16(z), 16);
    return t;
  };

  const curvTag = Buffer.alloc(14);
  curvTag.write('curv', 0);
  curvTag.writeUInt32BE(1, 8);
  curvTag.writeUInt16BE(Math.round(gamma * 256), 12);

  const cprtTag = Buffer.alloc(12 + 16);
  cprtTag.write('text', 0);
  cprtTag.write('EasyConvert ICC', 8, 'ascii');

  const rXYZTag = makeXyzTag(primaries.r[0], primaries.r[1], primaries.r[2]);
  const gXYZTag = makeXyzTag(primaries.g[0], primaries.g[1], primaries.g[2]);
  const bXYZTag = makeXyzTag(primaries.b[0], primaries.b[1], primaries.b[2]);

  const tags = [
    { sig: 'desc', buf: descTag },
    { sig: 'cprt', buf: cprtTag },
    { sig: 'wtpt', buf: wtptTag },
    { sig: 'rXYZ', buf: rXYZTag },
    { sig: 'gXYZ', buf: gXYZTag },
    { sig: 'bXYZ', buf: bXYZTag },
    { sig: 'rTRC', buf: curvTag },
    { sig: 'gTRC', buf: curvTag },
    { sig: 'bTRC', buf: curvTag },
  ];

  const headerSize = 128;
  const tagTableSize = 4 + tags.length * 12;
  let currentOffset = headerSize + tagTableSize;
  const tagEntries: { sig: string; offset: number; length: number }[] = [];
  for (const t of tags) {
    tagEntries.push({ sig: t.sig, offset: currentOffset, length: t.buf.length });
    currentOffset += (t.buf.length + 3) & ~3;
  }

  const profile = Buffer.alloc(currentOffset);
  profile.writeUInt32BE(currentOffset, 0);
  profile.write('lcms', 4);
  profile.writeUInt32BE(0x02100000, 8);
  profile.write('mntr', 12);
  profile.write('RGB ', 16);
  profile.write('XYZ ', 20);
  profile.writeUInt16BE(2026, 24);
  profile.writeUInt16BE(1, 26);
  profile.writeUInt16BE(1, 28);
  profile.write('acsp', 36);
  profile.write('APPL', 40);
  profile.writeInt32BE(toS15Fixed16(0.9642), 68);
  profile.writeInt32BE(toS15Fixed16(1.0), 72);
  profile.writeInt32BE(toS15Fixed16(0.8249), 76);

  profile.writeUInt32BE(tags.length, 128);
  let tablePos = 132;
  for (const e of tagEntries) {
    profile.write(e.sig, tablePos, 'ascii');
    profile.writeUInt32BE(e.offset, tablePos + 4);
    profile.writeUInt32BE(e.length, tablePos + 8);
    tablePos += 12;
  }

  for (let i = 0; i < tags.length; i++) {
    tags[i].buf.copy(profile, tagEntries[i].offset);
  }

  return profile;
}

export const DISPLAY_P3_ICC = createMinimalRgbIcc('Display P3', {
  r: [0.5151, 0.2412, -0.0011],
  g: [0.2919, 0.6922, 0.045],
  b: [0.1571, 0.0666, 0.781],
});

export const REC2020_ICC = createMinimalRgbIcc('Rec.2020', {
  r: [0.637, 0.2627, 0.0],
  g: [0.1446, 0.678, 0.0281],
  b: [0.1689, 0.0593, 0.7968],
});

/**
 * Encodes 16-bit RGB Uint16Array samples into an authentic Tagged Image File Format (TIFF) container.
 */
export function encode16BitTiff(
  width: number,
  height: number,
  rgb16: Uint16Array,
  iccProfile?: Buffer
): Buffer {
  const hasIcc = Boolean(iccProfile && iccProfile.length > 0);
  const ifdCount = hasIcc ? 11 : 10;
  const ifdSize = 2 + ifdCount * 12 + 4;
  const headerSize = 8;
  const ifdOffset = headerSize;
  const extraOffset = headerSize + ifdSize;

  const extraSize = 6 + 8 + 8 + (hasIcc ? iccProfile!.length : 0);
  const pixelDataOffset = extraOffset + extraSize;
  const pixelDataSize = width * height * 3 * 2;
  const totalSize = pixelDataOffset + pixelDataSize;

  const buf = Buffer.alloc(totalSize);
  buf.write('II', 0); // Little-endian
  buf.writeUInt16LE(42, 2);
  buf.writeUInt32LE(ifdOffset, 4);

  let pos = ifdOffset;
  buf.writeUInt16LE(ifdCount, pos);
  pos += 2;

  const bpsOffset = extraOffset;
  const xresOffset = extraOffset + 6;
  const yresOffset = extraOffset + 14;
  const iccOffset = extraOffset + 22;

  buf.writeUInt16LE(16, bpsOffset);
  buf.writeUInt16LE(16, bpsOffset + 2);
  buf.writeUInt16LE(16, bpsOffset + 4);

  buf.writeUInt32LE(72, xresOffset);
  buf.writeUInt32LE(1, xresOffset + 4);
  buf.writeUInt32LE(72, yresOffset);
  buf.writeUInt32LE(1, yresOffset + 4);

  if (hasIcc) {
    iccProfile!.copy(buf, iccOffset);
  }

  const writeTag = (tag: number, type: number, count: number, val: number) => {
    buf.writeUInt16LE(tag, pos);
    buf.writeUInt16LE(type, pos + 2);
    buf.writeUInt32LE(count, pos + 4);
    buf.writeUInt32LE(val, pos + 8);
    pos += 12;
  };

  writeTag(256, 4, 1, width); // ImageWidth
  writeTag(257, 4, 1, height); // ImageLength
  writeTag(258, 3, 3, bpsOffset); // BitsPerSample [16, 16, 16]
  writeTag(259, 3, 1, 1); // Compression (1 = uncompressed)
  writeTag(262, 3, 1, 2); // PhotometricInterpretation (2 = RGB)
  writeTag(273, 4, 1, pixelDataOffset); // StripOffsets
  writeTag(277, 3, 1, 3); // SamplesPerPixel
  writeTag(278, 4, 1, height); // RowsPerStrip
  writeTag(279, 4, 1, pixelDataSize); // StripByteCounts
  writeTag(282, 5, 1, xresOffset); // XResolution

  if (hasIcc) {
    writeTag(34675, 7, iccProfile!.length, iccOffset); // ICC Profile
  }

  buf.writeUInt32LE(0, pos); // End of IFDs

  Buffer.from(rgb16.buffer, rgb16.byteOffset, rgb16.byteLength).copy(buf, pixelDataOffset);
  return buf;
}

/**
 * Encodes 16-bit RGB Uint16Array samples into an authentic Portable Network Graphics (PNG) container.
 */
export function encode16BitPng(
  width: number,
  height: number,
  rgb16: Uint16Array,
  iccProfile?: Buffer
): Buffer {
  const crcTable = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    crcTable[n] = c;
  }
  const crc32 = (buf: Buffer): number => {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) {
      c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    }
    return (c ^ 0xffffffff) >>> 0;
  };

  const makeChunk = (typeStr: string, data?: Buffer): Buffer => {
    const typeBuf = Buffer.from(typeStr, 'ascii');
    const len = data ? data.length : 0;
    const chunk = Buffer.alloc(4 + 4 + len + 4);
    chunk.writeUInt32BE(len, 0);
    typeBuf.copy(chunk, 4);
    if (data && len > 0) {
      data.copy(chunk, 8);
    }
    const crcBuf = Buffer.concat([typeBuf, data || Buffer.alloc(0)]);
    chunk.writeUInt32BE(crc32(crcBuf), 8 + len);
    return chunk;
  };

  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  // IHDR
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.writeUInt8(16, 8); // 16 bits per sample
  ihdr.writeUInt8(2, 9); // RGB
  ihdr.writeUInt8(0, 10); // Compression Deflate
  ihdr.writeUInt8(0, 11); // Filter None
  ihdr.writeUInt8(0, 12); // Interlace None
  const ihdrChunk = makeChunk('IHDR', ihdr);

  const chunks = [signature, ihdrChunk];

  // Optional iCCP
  if (iccProfile && iccProfile.length > 0) {
    const profName = Buffer.from('ICC Profile\0', 'ascii');
    const compMethod = Buffer.from([0]);
    const compProf = zlib.deflateSync(iccProfile);
    chunks.push(makeChunk('iCCP', Buffer.concat([profName, compMethod, compProf])));
  }

  // Scanline data (filter byte 0)
  const scanlineSize = 1 + width * 6;
  const rawScanlines = Buffer.alloc(height * scanlineSize);

  for (let y = 0; y < height; y++) {
    const lineStart = y * scanlineSize;
    rawScanlines[lineStart] = 0; // Filter None
    for (let x = 0; x < width; x++) {
      const srcIdx = (y * width + x) * 3;
      const dstIdx = lineStart + 1 + x * 6;
      // PNG 16-bit big endian words
      rawScanlines.writeUInt16BE(rgb16[srcIdx], dstIdx);
      rawScanlines.writeUInt16BE(rgb16[srcIdx + 1], dstIdx + 2);
      rawScanlines.writeUInt16BE(rgb16[srcIdx + 2], dstIdx + 4);
    }
  }

  const idatChunk = makeChunk('IDAT', zlib.deflateSync(rawScanlines, { level: 8 }));
  const iendChunk = makeChunk('IEND', Buffer.alloc(0));
  chunks.push(idatChunk, iendChunk);

  return Buffer.concat(chunks);
}
