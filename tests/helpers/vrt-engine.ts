import sharp from 'sharp';

export interface VrtOptions {
  /** Perceptual color threshold between 0.0 and 1.0 (default: 0.08) */
  threshold?: number;
  /** Maximum acceptable mismatched pixel ratio (default: 0.0005, i.e. 0.05%) */
  maxDeltaRatio?: number;
  /** Whether to generate a rendered visual diff PNG buffer (default: true) */
  includeDiffImage?: boolean;
  /** Whether to consider 1-pixel anti-aliasing neighborhood blending (default: true) */
  antialiasing?: boolean;
}

export interface VrtResult {
  passed: boolean;
  totalPixels: number;
  mismatchedPixels: number;
  deltaRatio: number;
  percentage: number;
  ssim: number;
  psnr: number;
  diffImage?: Buffer;
}

export interface PixelmatchOptions {
  /** Matching threshold (0 to 1); smaller is more sensitive (default: 0.08) */
  threshold?: number;
  /** Whether to skip anti-aliasing detection (default: false) */
  includeAA?: boolean;
  /** Primary diff color in [R, G, B] format (default: [255, 0, 127] magenta) */
  diffColor?: [number, number, number];
  /** Secondary diff color for anti-aliasing pixels (default: [255, 255, 0] yellow) */
  diffColorAlt?: [number, number, number];
  /** Blending opacity for unchanged pixels in diff image (default: 0.25) */
  alpha?: number;
}

/**
 * Pixel-by-pixel perceptual image comparison adhering to standard pixelmatch API.
 */
export function pixelmatch(
  img1: Uint8Array | Buffer,
  img2: Uint8Array | Buffer,
  output: Uint8Array | Buffer | null,
  width: number,
  height: number,
  options: PixelmatchOptions = {}
): number {
  if (img1.length !== width * height * 4 || img2.length !== width * height * 4) {
    throw new Error(
      `Image buffer size mismatch: img1=${img1.length}, img2=${img2.length}, expected=${width * height * 4}`
    );
  }
  if (output && output.length !== width * height * 4) {
    throw new Error(
      `Output buffer size mismatch: output=${output.length}, expected=${width * height * 4}`
    );
  }

  const threshold = options.threshold ?? 0.08;
  const enableAA = !options.includeAA;
  const diffColor = options.diffColor ?? [255, 0, 127];
  const diffColorAlt = options.diffColorAlt ?? [255, 255, 0];
  const alpha = options.alpha ?? 0.25;

  let diffCount = 0;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      const r1 = img1[idx];
      const g1 = img1[idx + 1];
      const b1 = img1[idx + 2];
      const a1 = img1[idx + 3];

      const r2 = img2[idx];
      const g2 = img2[idx + 1];
      const b2 = img2[idx + 2];
      const a2 = img2[idx + 3];

      const dr = r1 - r2;
      const dg = g1 - g2;
      const db = b1 - b2;
      const da = a1 - a2;

      const distSq = 0.299 * (dr * dr) + 0.587 * (dg * dg) + 0.114 * (db * db) + 0.5 * (da * da);
      const dist = Math.sqrt(distSq) / 255;
      let isDiff = dist > threshold;
      let isAA = false;

      // Anti-aliasing neighborhood check for boundary pixels
      if (isDiff && enableAA && dist <= threshold * 2.2) {
        let neighborMatch = false;
        for (let dy = -1; dy <= 1 && !neighborMatch; dy++) {
          for (let dx = -1; dx <= 1 && !neighborMatch; dx++) {
            if (dx === 0 && dy === 0) continue;
            const nx = x + dx;
            const ny = y + dy;
            if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
              const nIdx = (ny * width + nx) * 4;
              // Check neighbor in img2 against pixel in img1
              const nDr2 = r1 - img2[nIdx];
              const nDg2 = g1 - img2[nIdx + 1];
              const nDb2 = b1 - img2[nIdx + 2];
              const nDa2 = a1 - img2[nIdx + 3];
              const nDist2 =
                Math.sqrt(0.299 * nDr2 * nDr2 + 0.587 * nDg2 * nDg2 + 0.114 * nDb2 * nDb2 + 0.5 * nDa2 * nDa2) /
                255;

              // Check neighbor in img1 against pixel in img2
              const nDr1 = img1[nIdx] - r2;
              const nDg1 = img1[nIdx + 1] - g2;
              const nDb1 = img1[nIdx + 2] - b2;
              const nDa1 = img1[nIdx + 3] - a2;
              const nDist1 =
                Math.sqrt(0.299 * nDr1 * nDr1 + 0.587 * nDg1 * nDg1 + 0.114 * nDb1 * nDb1 + 0.5 * nDa1 * nDa1) /
                255;

              if (nDist2 <= threshold || nDist1 <= threshold) {
                neighborMatch = true;
              }
            }
          }
        }
        if (neighborMatch) {
          isDiff = false;
          isAA = true;
        }
      }

      if (isDiff) {
        diffCount++;
      }

      if (output) {
        if (isDiff) {
          output[idx] = diffColor[0];
          output[idx + 1] = diffColor[1];
          output[idx + 2] = diffColor[2];
          output[idx + 3] = 255;
        } else if (isAA) {
          output[idx] = diffColorAlt[0];
          output[idx + 1] = diffColorAlt[1];
          output[idx + 2] = diffColorAlt[2];
          output[idx + 3] = 255;
        } else {
          const lum = Math.round(0.299 * r1 + 0.587 * g1 + 0.114 * b1);
          const dimmed = Math.round(lum * alpha + 190 * (1 - alpha));
          output[idx] = dimmed;
          output[idx + 1] = dimmed;
          output[idx + 2] = dimmed;
          output[idx + 3] = 255;
        }
      }
    }
  }

  return diffCount;
}

/**
 * Extracts perceptual luminance from buffer at given pixel index based on channel count.
 */
function getPerceptualLuminance(buf: Uint8Array | Buffer, idx: number, channels: number): number {
  if (channels === 1) {
    return buf[idx];
  }
  const r = buf[idx];
  const g = buf[idx + 1];
  const b = buf[idx + 2];
  const lum = r * 0.299 + g * 0.587 + b * 0.114;
  if (channels >= 4) {
    return lum * (buf[idx + 3] / 255);
  }
  return lum;
}

/**
 * Computes Structural Similarity Index (SSIM) between two grayscale/color buffers.
 */
export function computeSsim(
  bufA: Uint8Array | Buffer,
  bufB: Uint8Array | Buffer,
  width: number,
  height: number,
  channels: number = 4
): number {
  const n = width * height;
  if (n === 0) return 1.0;

  let sumA = 0;
  let sumB = 0;

  for (let i = 0; i < n; i++) {
    const idx = i * channels;
    sumA += getPerceptualLuminance(bufA, idx, channels);
    sumB += getPerceptualLuminance(bufB, idx, channels);
  }

  const meanA = sumA / n;
  const meanB = sumB / n;

  let varA = 0;
  let varB = 0;
  let covAB = 0;

  for (let i = 0; i < n; i++) {
    const idx = i * channels;
    const lumA = getPerceptualLuminance(bufA, idx, channels);
    const lumB = getPerceptualLuminance(bufB, idx, channels);

    const diffA = lumA - meanA;
    const diffB = lumB - meanB;
    varA += diffA * diffA;
    varB += diffB * diffB;
    covAB += diffA * diffB;
  }

  const denomN = Math.max(1, n - 1);
  varA /= denomN;
  varB /= denomN;
  covAB /= denomN;

  // Constants for 8-bit dynamic range L = 255
  const k1 = 0.01;
  const k2 = 0.03;
  const l = 255;
  const c1 = (k1 * l) ** 2;
  const c2 = (k2 * l) ** 2;

  const numerator = (2 * meanA * meanB + c1) * (2 * covAB + c2);
  const denominator = (meanA * meanA + meanB * meanB + c1) * (varA + varB + c2);

  return denominator === 0 ? 1.0 : Math.max(0, Math.min(1.0, numerator / denominator));
}

/**
 * Enterprise Visual Regression Testing (VRT) Pixel-by-Pixel Diff Engine.
 */
export async function compareImages(
  imgA: Buffer,
  imgB: Buffer,
  options: VrtOptions = {}
): Promise<VrtResult> {
  const threshold = options.threshold ?? 0.08;
  const maxDeltaRatio = options.maxDeltaRatio ?? 0.0005; // 0.05%
  const includeDiff = options.includeDiffImage !== false;
  const antialiasing = options.antialiasing !== false;

  const [rawA, rawB] = await Promise.all([
    sharp(imgA).ensureAlpha().raw().toBuffer({ resolveWithObject: true }),
    sharp(imgB).ensureAlpha().raw().toBuffer({ resolveWithObject: true }),
  ]);

  if (rawA.info.width !== rawB.info.width || rawA.info.height !== rawB.info.height) {
    throw new Error(
      `VRT Dimension Mismatch: Image A is ${rawA.info.width}x${rawA.info.height}, Image B is ${rawB.info.width}x${rawB.info.height}`
    );
  }

  const { width, height } = rawA.info;
  const totalPixels = width * height;
  const bufA = rawA.data;
  const bufB = rawB.data;

  const diffRgba = includeDiff ? Buffer.alloc(totalPixels * 4) : null;
  const mismatchedPixels = pixelmatch(bufA, bufB, diffRgba, width, height, {
    threshold,
    includeAA: !antialiasing,
  });

  let sumSquaredError = 0;
  for (let i = 0; i < totalPixels * 4; i += 4) {
    const dr = bufA[i] - bufB[i];
    const dg = bufA[i + 1] - bufB[i + 1];
    const db = bufA[i + 2] - bufB[i + 2];
    const da = bufA[i + 3] - bufB[i + 3];
    sumSquaredError += (dr * dr + dg * dg + db * db + da * da) / 4;
  }

  const deltaRatio = totalPixels > 0 ? mismatchedPixels / totalPixels : 0;
  const percentage = deltaRatio * 100;
  const mse = totalPixels > 0 ? sumSquaredError / totalPixels : 0;
  const psnr = mse === 0 ? Infinity : 10 * Math.log10((255 * 255) / mse);
  const ssim = computeSsim(bufA, bufB, width, height, 4);

  let diffImage: Buffer | undefined;
  if (diffRgba) {
    diffImage = await sharp(diffRgba, {
      raw: { width, height, channels: 4 },
    })
      .png()
      .toBuffer();
  }

  return {
    passed: deltaRatio <= maxDeltaRatio,
    totalPixels,
    mismatchedPixels,
    deltaRatio,
    percentage,
    ssim,
    psnr,
    diffImage,
  };
}
