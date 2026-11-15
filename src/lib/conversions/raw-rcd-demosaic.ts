import { InvalidRawSensorError, UnsupportedRawCompressionError } from '../types';
import { type BayerSensorData, validateBayerSensorCalibration } from './image';

interface RcdContext {
  width: number;
  height: number;
  pixelCount: number;
  norm: Float32Array;
  mirrorX: Int32Array;
  mirrorYBase: Int32Array;
  greenParity: number;
  redX: number;
  redY: number;
}

function mirrorIndex(v: number, max: number): number {
  if (max <= 1) return 0;
  let cur = v;
  while (cur < 0 || cur >= max) {
    if (cur < 0) cur = -cur;
    else cur = 2 * (max - 1) - cur;
  }
  return cur;
}

function inferMaxPossibleSensorValue(sensor: BayerSensorData): number {
  if (sensor.bitsPerSample) {
    return (1 << sensor.bitsPerSample) - 1;
  }
  if (!(sensor.data instanceof Uint16Array)) {
    return 255;
  }
  let maxVal = 0;
  const len = Math.min(sensor.data.length, 10000);
  for (let i = 0; i < len; i++) {
    if (sensor.data[i] > maxVal) maxVal = sensor.data[i];
  }
  if (maxVal > 4095) return 65535;
  if (maxVal > 1023) return 4095;
  if (maxVal > 255) return 1023;
  return 255;
}

function buildRcdContext(sensor: BayerSensorData): RcdContext {
  const { width, height, pattern, data } = sensor;
  if (width < 2 || height < 2 || (width & 1) !== 0 || (height & 1) !== 0) {
    throw new InvalidRawSensorError(`Invalid sensor dimensions: ${width}x${height}. Minimum 2x2 with even dimensions required.`);
  }
  if (pattern !== 'RGGB' && pattern !== 'BGGR' && pattern !== 'GRBG' && pattern !== 'GBRG') {
    throw new UnsupportedRawCompressionError(
      `Non-Bayer sensor pattern '${pattern}' (such as Fuji X-Trans or Foveon) is not supported.`
    );
  }
  const pixelCount = width * height;
  if (!data || data.length < pixelCount) {
    throw new InvalidRawSensorError(`Bayer sensor buffer underflow: expected at least ${pixelCount} samples.`);
  }

  const maxPossible = inferMaxPossibleSensorValue(sensor);
  const { defaultBLevel, wLevel, hasArrayBlackLevel, blackLevelArr } = validateBayerSensorCalibration(sensor, maxPossible);
  const norm = new Float32Array(pixelCount);

  if (hasArrayBlackLevel && blackLevelArr) {
    const blkLen = blackLevelArr.length;
    const blkRanges = [0, 1, 2, 3].map((blkIdx) => {
      const b = blackLevelArr[blkIdx % blkLen] ?? defaultBLevel;
      return { b, range: Math.max(1, wLevel - b) };
    });
    for (let y = 0; y < height; y++) {
      const rowBase = y * width;
      const yBit = (y & 1) << 1;
      for (let x = 0; x < width; x++) {
        const idx = rowBase + x;
        const entry = blkRanges[yBit | (x & 1)];
        const v = (data[idx] - entry.b) / entry.range;
        norm[idx] = v > 0 ? v : 0;
      }
    }
  } else {
    const range = Math.max(1, wLevel - defaultBLevel);
    for (let idx = 0; idx < pixelCount; idx++) {
      const v = (data[idx] - defaultBLevel) / range;
      norm[idx] = v > 0 ? v : 0;
    }
  }

  const mirrorX = new Int32Array(width + 4);
  for (let x = -2; x <= width + 1; x++) mirrorX[x + 2] = mirrorIndex(x, width);
  const mirrorYBase = new Int32Array(height + 4);
  for (let y = -2; y <= height + 1; y++) mirrorYBase[y + 2] = mirrorIndex(y, height) * width;

  return {
    width,
    height,
    pixelCount,
    norm,
    mirrorX,
    mirrorYBase,
    greenParity: pattern === 'RGGB' || pattern === 'BGGR' ? 1 : 0,
    redX: pattern === 'BGGR' || pattern === 'GRBG' ? 1 : 0,
    redY: pattern === 'BGGR' || pattern === 'GBRG' ? 1 : 0,
  };
}

function interpolateGreenStage(ctx: RcdContext, green: Float32Array, vh: Float32Array, vv: Float32Array): void {
  const { width, height, norm, mirrorX, mirrorYBase, greenParity } = ctx;
  for (let y = 0; y < height; y++) {
    const rowY = mirrorYBase[y + 2];
    const rowYm1 = mirrorYBase[y + 1];
    const rowYp1 = mirrorYBase[y + 3];
    const rowYm2 = mirrorYBase[y];
    const rowYp2 = mirrorYBase[y + 4];
    for (let x = 0; x < width; x++) {
      const idx = rowY + x;
      if (((x ^ y) & 1) === greenParity) {
        green[idx] = norm[idx];
        continue;
      }
      const c = norm[idx];
      const pXm1 = norm[rowY + mirrorX[x + 1]];
      const pXp1 = norm[rowY + mirrorX[x + 3]];
      const pYm1 = norm[rowYm1 + x];
      const pYp1 = norm[rowYp1 + x];
      const lapH = 2.0 * c - norm[rowY + mirrorX[x]] - norm[rowY + mirrorX[x + 4]];
      const lapV = 2.0 * c - norm[rowYm2 + x] - norm[rowYp2 + x];
      const diffH = Math.abs(pXm1 - pXp1) + Math.abs(lapH);
      const diffV = Math.abs(pYm1 - pYp1) + Math.abs(lapV);
      vh[idx] = diffH;
      vv[idx] = diffV;
      green[idx] = diffH < diffV ? 0.5 * (pXm1 + pXp1) + 0.25 * lapH : 0.5 * (pYm1 + pYp1) + 0.25 * lapV;
    }
  }

  for (let y = 0; y < height; y++) {
    const rowYm1 = mirrorYBase[y + 1];
    const rowY = mirrorYBase[y + 2];
    const rowYp1 = mirrorYBase[y + 3];
    const rowYm2 = mirrorYBase[y];
    const rowYp2 = mirrorYBase[y + 4];
    for (let x = 0; x < width; x++) {
      if (((x ^ y) & 1) === greenParity) continue;
      const idx = rowY + x;
      const xm1 = mirrorX[x + 1];
      const xp1 = mirrorX[x + 3];
      const sumH =
        vh[rowYm1 + xm1] + vh[rowYm1 + x] + vh[rowYm1 + xp1] +
        vh[rowY + xm1] + vh[idx] + vh[rowY + xp1] +
        vh[rowYp1 + xm1] + vh[rowYp1 + x] + vh[rowYp1 + xp1];
      const sumV =
        vv[rowYm1 + xm1] + vv[rowYm1 + x] + vv[rowYm1 + xp1] +
        vv[rowY + xm1] + vv[idx] + vv[rowY + xp1] +
        vv[rowYp1 + xm1] + vv[rowYp1 + x] + vv[rowYp1 + xp1];

      const c = norm[idx];
      const gh = 0.5 * (norm[rowY + xm1] + norm[rowY + xp1]) + 0.25 * (2.0 * c - norm[rowY + mirrorX[x]] - norm[rowY + mirrorX[x + 4]]);
      const gv = 0.5 * (norm[rowYm1 + x] + norm[rowYp1 + x]) + 0.25 * (2.0 * c - norm[rowYm2 + x] - norm[rowYp2 + x]);

      if (sumH < 0.65 * sumV) {
        green[idx] = gh;
      } else if (sumV < 0.65 * sumH) {
        green[idx] = gv;
      } else {
        const wH = 1.0 / (sumH * sumH + 1e-5);
        const wV = 1.0 / (sumV * sumV + 1e-5);
        green[idx] = (wH * gh + wV * gv) / (wH + wV);
      }
    }
  }
}

function blendDiagonal(tl: number, br: number, tr: number, bl: number): number {
  const d1 = Math.abs(tl - br);
  const d2 = Math.abs(tr - bl);
  const est1 = 0.5 * (tl + br);
  const est2 = 0.5 * (tr + bl);
  if (d1 < 0.8 * d2) return est1;
  if (d2 < 0.8 * d1) return est2;
  return 0.5 * (est1 + est2);
}

function interpolateRedBlueStage(
  ctx: RcdContext,
  green: Float32Array,
  cdR: Float32Array,
  cdB: Float32Array
): { red: Float32Array; blue: Float32Array } {
  const { width, height, pixelCount, norm, mirrorX, mirrorYBase, greenParity, redX, redY } = ctx;
  const red = new Float32Array(pixelCount);
  const blue = new Float32Array(pixelCount);
  cdR.fill(0);
  cdB.fill(0);

  for (let y = 0; y < height; y++) {
    const rowY = y * width;
    const isRedRow = (y & 1) === redY;
    for (let x = 0; x < width; x++) {
      const idx = rowY + x;
      const g = green[idx];
      if (isRedRow && (x & 1) === redX) {
        red[idx] = norm[idx];
        cdR[idx] = red[idx] - g;
      } else if (((x ^ y) & 1) !== greenParity) {
        blue[idx] = norm[idx];
        cdB[idx] = blue[idx] - g;
      }
    }
  }

  for (let y = 0; y < height; y++) {
    const rowYm1 = mirrorYBase[y + 1];
    const rowY = mirrorYBase[y + 2];
    const rowYp1 = mirrorYBase[y + 3];
    const isRedRow = (y & 1) === redY;
    for (let x = 0; x < width; x++) {
      if (((x ^ y) & 1) === greenParity) continue;
      const idx = rowY + x;
      const xm1 = mirrorX[x + 1];
      const xp1 = mirrorX[x + 3];
      if (!(isRedRow && (x & 1) === redX)) {
        const interp = blendDiagonal(cdR[rowYm1 + xm1], cdR[rowYp1 + xp1], cdR[rowYm1 + xp1], cdR[rowYp1 + xm1]);
        cdR[idx] = interp;
        red[idx] = green[idx] + interp;
      } else {
        const interp = blendDiagonal(cdB[rowYm1 + xm1], cdB[rowYp1 + xp1], cdB[rowYm1 + xp1], cdB[rowYp1 + xm1]);
        cdB[idx] = interp;
        blue[idx] = green[idx] + interp;
      }
    }
  }

  for (let y = 0; y < height; y++) {
    const rowYm1 = mirrorYBase[y + 1];
    const rowY = mirrorYBase[y + 2];
    const rowYp1 = mirrorYBase[y + 3];
    const hasRedH = (y & 1) === redY;
    for (let x = 0; x < width; x++) {
      if (((x ^ y) & 1) !== greenParity) continue;
      const idx = rowY + x;
      const xm1 = mirrorX[x + 1];
      const xp1 = mirrorX[x + 3];
      if (hasRedH) {
        cdR[idx] = 0.5 * (cdR[rowY + xm1] + cdR[rowY + xp1]);
        cdB[idx] = 0.5 * (cdB[rowYm1 + x] + cdB[rowYp1 + x]);
      } else {
        cdR[idx] = 0.5 * (cdR[rowYm1 + x] + cdR[rowYp1 + x]);
        cdB[idx] = 0.5 * (cdB[rowY + xm1] + cdB[rowY + xp1]);
      }
      red[idx] = green[idx] + cdR[idx];
      blue[idx] = green[idx] + cdB[idx];
    }
  }

  return { red, blue };
}

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
  const ctx = buildRcdContext(sensor);
  const { width, height, pixelCount } = ctx;
  const green = new Float32Array(pixelCount);
  const vh = new Float32Array(pixelCount);
  const vv = new Float32Array(pixelCount);
  interpolateGreenStage(ctx, green, vh, vv);

  // Reuse vh and vv as colour-difference planes cdR and cdB (saves 2 * pixelCount * 4 bytes).
  const { red, blue } = interpolateRedBlueStage(ctx, green, vh, vv);

  const floatRgb = new Float32Array(pixelCount * 3);
  const buf8 = Buffer.allocUnsafe(pixelCount * 3);
  for (let i = 0; i < pixelCount; i++) {
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
