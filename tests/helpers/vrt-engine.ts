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
    // Standard RGB perceptual luminance weights: 0.299 R + 0.587 G + 0.114 B
    const lumA = (bufA[idx] * 0.299 + bufA[idx + 1] * 0.587 + bufA[idx + 2] * 0.114) * (bufA[idx + 3] / 255);
    const lumB = (bufB[idx] * 0.299 + bufB[idx + 1] * 0.587 + bufB[idx + 2] * 0.114) * (bufB[idx + 3] / 255);
    sumA += lumA;
    sumB += lumB;
  }

  const meanA = sumA / n;
  const meanB = sumB / n;

  let varA = 0;
  let varB = 0;
  let covAB = 0;

  for (let i = 0; i < n; i++) {
    const idx = i * channels;
    const lumA = (bufA[idx] * 0.299 + bufA[idx + 1] * 0.587 + bufA[idx + 2] * 0.114) * (bufA[idx + 3] / 255);
    const lumB = (bufB[idx] * 0.299 + bufB[idx + 1] * 0.587 + bufB[idx + 2] * 0.114) * (bufB[idx + 3] / 255);

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
 *
 * Implements:
 * - Direct Sharp decoding to raw RGBA pixel arrays
 * - Perceptual Euclidean color distance with human luminance weighting
 * - Subpixel antialiasing edge tolerance
 * - Exact pixel mismatch tallying and percentage delta ratio
 * - Structural Similarity (SSIM) and Peak Signal-to-Noise Ratio (PSNR) calculation
 * - Visual diff image generation with magenta anomaly highlighting
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

  let mismatchedPixels = 0;
  let sumSquaredError = 0;

  const diffRgba = includeDiff ? Buffer.alloc(totalPixels * 4) : null;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;

      const rA = bufA[idx];
      const gA = bufA[idx + 1];
      const bA = bufA[idx + 2];
      const aA = bufA[idx + 3];

      const rB = bufB[idx];
      const gB = bufB[idx + 1];
      const bB = bufB[idx + 2];
      const aB = bufB[idx + 3];

      const dr = rA - rB;
      const dg = gA - gB;
      const db = bA - bB;
      const da = aA - aB;

      // Color distance weighted by human visual perception
      const distSq = 0.299 * (dr * dr) + 0.587 * (dg * dg) + 0.114 * (db * db) + 0.5 * (da * da);
      const dist = Math.sqrt(distSq) / 255;

      sumSquaredError += (dr * dr + dg * dg + db * db + da * da) / 4;

      let isMismatch = dist > threshold;

      // Anti-aliasing neighborhood check for boundary pixels
      if (isMismatch && antialiasing && dist <= threshold * 2.2) {
        let neighborMatch = false;
        // Check 1-pixel neighboring coordinates
        for (let dy = -1; dy <= 1 && !neighborMatch; dy++) {
          for (let dx = -1; dx <= 1 && !neighborMatch; dx++) {
            if (dx === 0 && dy === 0) continue;
            const nx = x + dx;
            const ny = y + dy;
            if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
              const nIdx = (ny * width + nx) * 4;
              const nDr = rA - bufB[nIdx];
              const nDg = gA - bufB[nIdx + 1];
              const nDb = bA - bufB[nIdx + 2];
              const nDist = Math.sqrt(0.299 * nDr * nDr + 0.587 * nDg * nDg + 0.114 * nDb * nDb) / 255;
              if (nDist <= threshold) {
                neighborMatch = true;
              }
            }
          }
        }
        if (neighborMatch) {
          isMismatch = false;
        }
      }

      if (isMismatch) {
        mismatchedPixels++;
      }

      if (diffRgba) {
        if (isMismatch) {
          // Highlight mismatched pixel in vivid magenta (#FF007F)
          diffRgba[idx] = 255;
          diffRgba[idx + 1] = 0;
          diffRgba[idx + 2] = 127;
          diffRgba[idx + 3] = 255;
        } else {
          // Render dimmed grayscale context for visual clarity
          const lum = Math.round(0.299 * rA + 0.587 * gA + 0.114 * bA);
          const dimmed = Math.round(lum * 0.25 + 190 * 0.75); // soft tinted background
          diffRgba[idx] = dimmed;
          diffRgba[idx + 1] = dimmed;
          diffRgba[idx + 2] = dimmed;
          diffRgba[idx + 3] = 255;
        }
      }
    }
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
