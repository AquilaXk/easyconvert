/**
 * The AMaZE and AHD demosaicing functions as they were before the flat-plane tile rewrite (and before the threads): the
 * in-place, whole-frame implementations that lived in image.ts. They are kept here only as a test reference: the
 * recorded goldens were captured from them, and the speed and quality suites compare the current engines with them.
 * Nothing in src/ imports this file.
 */
import {
  applyFalseColorSuppression,
  applyIec61966SrgbGamma,
  mirrorBayerCoord,
  resolveBayerColorMatrix,
  validateBayerSensorCalibration,
  type BayerSensorData,
} from '../../src/lib/conversions/image';
import { InvalidRawSensorError } from '../../src/lib/types';

/**
 * AMaZE (Aliasing Minimization and Zipper Elimination) Bayer CFA demosaicing.
 * Evaluates directional local homogeneity across 5x5 pixel windows with gradient filtering
 * and interpolates the green channel along the direction of maximum homogeneity.
 * Eliminates zipper artifacts with median-filtered color differences, and applies dual illuminant
 * CCT weighted color matrix interpolation and IEC 61966-2-1 gamma curves.
 */
export function legacyDemosaicAmazeBayerCfa(sensor: BayerSensorData): {
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
export function legacyDemosaicAhdBayerCfa(sensor: BayerSensorData): {
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
