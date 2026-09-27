/**
 * State-of-the-Art OKLab Color Space Quantization & Riemersma Space-Filling Curve Dithering
 *
 * Implements:
 * 1. Ottosson's OKLab perceptual color space transform and Delta E_OK color difference metric.
 * 2. High-precision color palette quantization in OKLab space minimizing perceptual error.
 * 3. Hilbert space-filling curve 2D pixel trajectory generator.
 * 4. Riemersma error-diffusion dithering with a 16-element exponential decay error queue.
 */

export interface RgbColor {
  r: number;
  g: number;
  b: number;
  a?: number;
}

export interface OklabColor {
  L: number;
  a: number;
  b: number;
  alpha?: number;
}

/**
 * Converts an sRGB component (0..255) to linear light RGB (0..1).
 */
export function srgbToLinear(c: number): number {
  const norm = Math.max(0, Math.min(255, c)) / 255;
  return norm <= 0.04045 ? norm / 12.92 : Math.pow((norm + 0.055) / 1.055, 2.4);
}

/**
 * Converts a linear light RGB component (0..1) to sRGB (0..255).
 */
export function linearToSrgb(c: number): number {
  const clamped = Math.max(0, Math.min(1, c));
  const srgb =
    clamped <= 0.0031308
      ? clamped * 12.92
      : 1.055 * Math.pow(clamped, 1.0 / 2.4) - 0.055;
  return Math.round(Math.max(0, Math.min(255, srgb * 255)));
}

/**
 * Converts 24-bit sRGB color into Ottosson's OKLab perceptual color space.
 */
export function rgbToOklab(rgb: RgbColor): OklabColor {
  const rLin = srgbToLinear(rgb.r);
  const gLin = srgbToLinear(rgb.g);
  const bLin = srgbToLinear(rgb.b);

  // Convert linear sRGB to LMS cone responses
  const l = 0.4122214708 * rLin + 0.5363325363 * gLin + 0.0514459929 * bLin;
  const m = 0.2119034982 * rLin + 0.6806995451 * gLin + 0.1073969566 * bLin;
  const s = 0.0883024619 * rLin + 0.2817188376 * gLin + 0.6299787005 * bLin;

  // Non-linear cubic root compression (preserving sign)
  const l_ = Math.cbrt(l);
  const m_ = Math.cbrt(m);
  const s_ = Math.cbrt(s);

  // Convert LMS to OKLab (L, a, b)
  const L = 0.2104542553 * l_ + 0.793617785 * m_ - 0.0040720468 * s_;
  const a = 1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_;
  const b = 0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_;

  return {
    L,
    a,
    b,
    alpha: rgb.a !== undefined ? rgb.a : 255,
  };
}

/**
 * Converts OKLab color back to 24-bit sRGB space.
 */
export function oklabToRgb(oklab: OklabColor): RgbColor {
  const { L, a, b, alpha } = oklab;

  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;

  const l = l_ * l_ * l_;
  const m = m_ * m_ * m_;
  const s = s_ * s_ * s_;

  const rLin = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  const gLin = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  const bLin = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s;

  return {
    r: linearToSrgb(rLin),
    g: linearToSrgb(gLin),
    b: linearToSrgb(bLin),
    a: alpha !== undefined ? alpha : 255,
  };
}

/**
 * Calculates perceptual Euclidean distance Delta E_OK between two OKLab colors.
 */
export function deltaEOk(c1: OklabColor, c2: OklabColor): number {
  const dL = c1.L - c2.L;
  const da = c1.a - c2.a;
  const db = c1.b - c2.b;
  return Math.sqrt(dL * dL + da * da + db * db);
}

/**
 * Calculates perceptual Delta E_OK directly between two RGB colors.
 */
export function deltaEOkRgb(rgb1: RgbColor, rgb2: RgbColor): number {
  return deltaEOk(rgbToOklab(rgb1), rgbToOklab(rgb2));
}

/**
 * Finds the index of the nearest color in an OKLab palette to a given OKLab target.
 */
export function findNearestColorIndexOklab(
  target: OklabColor,
  paletteOklab: OklabColor[]
): number {
  let bestIdx = 0;
  let bestDist = Infinity;

  for (let i = 0; i < paletteOklab.length; i++) {
    const dist = deltaEOk(target, paletteOklab[i]);
    if (dist < bestDist) {
      bestDist = dist;
      bestIdx = i;
      if (dist === 0) break;
    }
  }

  return bestIdx;
}

/**
 * Generates Hilbert space-filling curve 2D coordinates for an arbitrary width x height image.
 */
export function generateHilbertCurveOrder(
  width: number,
  height: number
): { x: number; y: number }[] {
  if (width <= 0 || height <= 0) return [];

  // Find nearest power of 2 bounding dimension
  const maxDim = Math.max(width, height);
  let n = 1;
  while (n < maxDim) {
    n <<= 1;
  }

  const result: { x: number; y: number }[] = [];

  function d2xy(order: number, d: number): { x: number; y: number } {
    let t = d;
    let x = 0;
    let y = 0;
    for (let s = 1; s < order; s <<= 1) {
      const rx = 1 & (t / 2);
      const ry = 1 & (t ^ rx);
      if (ry === 0) {
        if (rx === 1) {
          x = s - 1 - x;
          y = s - 1 - y;
        }
        const temp = x;
        x = y;
        y = temp;
      }
      x += s * rx;
      y += s * ry;
      t = Math.floor(t / 4);
    }
    return { x, y };
  }

  const totalPoints = n * n;
  for (let d = 0; d < totalPoints; d++) {
    const pt = d2xy(n, d);
    if (pt.x < width && pt.y < height) {
      result.push(pt);
    }
  }

  return result;
}

/**
 * Quantizes image colors into an optimal palette of maxColors using OKLab K-Means clustering.
 */
export function quantizePaletteOklab(
  pixels: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
  maxColors: number = 256
): RgbColor[] {
  const pixelCount = width * height;
  if (pixelCount === 0) return [{ r: 0, g: 0, b: 0, a: 255 }];

  // 1. Sample pixels to keep clustering runtime fast and deterministic
  const maxSamples = Math.min(pixelCount, 2048);
  const step = Math.max(1, Math.floor(pixelCount / maxSamples));
  const sampledOklab: OklabColor[] = [];

  for (let i = 0; i < pixelCount; i += step) {
    const idx = i * 4;
    sampledOklab.push(
      rgbToOklab({
        r: pixels[idx],
        g: pixels[idx + 1],
        b: pixels[idx + 2],
      })
    );
  }

  // 2. Initialize cluster centroids using k-means++ seeding
  const k = Math.min(maxColors, sampledOklab.length);
  const centroids: OklabColor[] = [sampledOklab[0]];

  while (centroids.length < k) {
    let maxDist = -1;
    let bestCand = sampledOklab[0];

    for (const pt of sampledOklab) {
      let minDistToCentroid = Infinity;
      for (const c of centroids) {
        const d = deltaEOk(pt, c);
        if (d < minDistToCentroid) {
          minDistToCentroid = d;
        }
      }
      if (minDistToCentroid > maxDist) {
        maxDist = minDistToCentroid;
        bestCand = pt;
      }
    }
    centroids.push({ ...bestCand });
  }

  // 3. Run 5 iterations of K-Means in OKLab space
  for (let iter = 0; iter < 5; iter++) {
    const clusterSums = centroids.map(() => ({ L: 0, a: 0, b: 0, count: 0 }));

    for (const pt of sampledOklab) {
      const bestIdx = findNearestColorIndexOklab(pt, centroids);
      const c = clusterSums[bestIdx];
      c.L += pt.L;
      c.a += pt.a;
      c.b += pt.b;
      c.count++;
    }

    for (let i = 0; i < k; i++) {
      if (clusterSums[i].count > 0) {
        centroids[i] = {
          L: clusterSums[i].L / clusterSums[i].count,
          a: clusterSums[i].a / clusterSums[i].count,
          b: clusterSums[i].b / clusterSums[i].count,
        };
      }
    }
  }

  // 4. Convert OKLab centroids back to sRGB colors
  return centroids.map((c) => oklabToRgb(c));
}

// Pre-computed Riemersma 16-element exponential decay weights: r = 16^(-1/15)
const RIEMERSMA_QUEUE_SIZE = 16;
const RIEMERSMA_WEIGHTS = (() => {
  const r = Math.pow(16, -1 / (RIEMERSMA_QUEUE_SIZE - 1));
  const weights: number[] = [];
  let sum = 0;
  for (let i = 0; i < RIEMERSMA_QUEUE_SIZE; i++) {
    const w = Math.pow(r, i);
    weights.push(w);
    sum += w;
  }
  return weights.map((w) => w / sum);
})();

/**
 * Performs Riemersma space-filling curve error-diffusion dithering in OKLab space.
 * Returns an indexed 8-bit palette buffer and the matched RGB quantized pixel array.
 */
export function riemersmaDither(
  pixels: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
  palette: RgbColor[]
): { indexed: Uint8Array; rgba: Uint8ClampedArray } {
  const pixelCount = width * height;
  const indexed = new Uint8Array(pixelCount);
  const rgba = new Uint8ClampedArray(pixelCount * 4);

  if (palette.length === 0 || pixelCount === 0) {
    return { indexed, rgba };
  }

  const paletteOklab = palette.map((c) => rgbToOklab(c));

  // Initialize Riemersma error queue (size 16) with 0 errors
  const errorQueue: { dL: number; da: number; db: number }[] = [];
  for (let i = 0; i < RIEMERSMA_QUEUE_SIZE; i++) {
    errorQueue.push({ dL: 0, da: 0, db: 0 });
  }

  // Generate Hilbert curve traversal order
  const curve = generateHilbertCurveOrder(width, height);

  for (const { x, y } of curve) {
    const pixelIdx = (y * width + x) * 4;
    const r = pixels[pixelIdx];
    const g = pixels[pixelIdx + 1];
    const b = pixels[pixelIdx + 2];
    const a = pixels[pixelIdx + 3] !== undefined ? pixels[pixelIdx + 3] : 255;

    // 1. Convert current pixel to OKLab
    const currentOklab = rgbToOklab({ r, g, b, a });

    // 2. Compute diffused error from weighted history queue
    let errorL = 0;
    let errorA = 0;
    let errorB = 0;
    for (let i = 0; i < RIEMERSMA_QUEUE_SIZE; i++) {
      const w = RIEMERSMA_WEIGHTS[i];
      errorL += w * errorQueue[i].dL;
      errorA += w * errorQueue[i].da;
      errorB += w * errorQueue[i].db;
    }

    // 3. Add diffused error to current pixel
    const perturbedOklab: OklabColor = {
      L: Math.max(0, Math.min(1, currentOklab.L + errorL)),
      a: currentOklab.a + errorA,
      b: currentOklab.b + errorB,
    };

    // 4. Find closest palette color using Delta E_OK
    const bestIdx = findNearestColorIndexOklab(perturbedOklab, paletteOklab);
    const chosenOklab = paletteOklab[bestIdx];
    const chosenRgb = palette[bestIdx];

    // 5. Compute quantization error
    const errL = perturbedOklab.L - chosenOklab.L;
    const errA = perturbedOklab.a - chosenOklab.a;
    const errB = perturbedOklab.b - chosenOklab.b;

    // 6. Push error to queue (FIFO)
    errorQueue.pop();
    errorQueue.unshift({ dL: errL, da: errA, db: errB });

    // 7. Write outputs
    const outOffset = y * width + x;
    indexed[outOffset] = bestIdx;

    const rgbaOffset = outOffset * 4;
    rgba[rgbaOffset] = chosenRgb.r;
    rgba[rgbaOffset + 1] = chosenRgb.g;
    rgba[rgbaOffset + 2] = chosenRgb.b;
    rgba[rgbaOffset + 3] = a;
  }

  return { indexed, rgba };
}

/**
 * Unified high-level API for OKLab quantization and Riemersma dithering.
 */
export function applyOklabQuantizationAndDither(
  imageData: { data: Uint8ClampedArray | Uint8Array; width: number; height: number },
  maxColors: number = 256,
  dither: boolean = true
): {
  palette: RgbColor[];
  indexed: Uint8Array;
  rgba: Uint8ClampedArray;
} {
  const { data, width, height } = imageData;
  const palette = quantizePaletteOklab(data, width, height, maxColors);

  if (dither) {
    const { indexed, rgba } = riemersmaDither(data, width, height, palette);
    return { palette, indexed, rgba };
  }

  // Fast nearest-neighbor quantization without dithering
  const pixelCount = width * height;
  const indexed = new Uint8Array(pixelCount);
  const rgba = new Uint8ClampedArray(pixelCount * 4);
  const paletteOklab = palette.map((c) => rgbToOklab(c));

  for (let i = 0; i < pixelCount; i++) {
    const idx = i * 4;
    const targetOklab = rgbToOklab({
      r: data[idx],
      g: data[idx + 1],
      b: data[idx + 2],
    });
    const bestIdx = findNearestColorIndexOklab(targetOklab, paletteOklab);
    indexed[i] = bestIdx;
    const chosen = palette[bestIdx];
    rgba[idx] = chosen.r;
    rgba[idx + 1] = chosen.g;
    rgba[idx + 2] = chosen.b;
    rgba[idx + 3] = data[idx + 3] !== undefined ? data[idx + 3] : 255;
  }

  return { palette, indexed, rgba };
}
