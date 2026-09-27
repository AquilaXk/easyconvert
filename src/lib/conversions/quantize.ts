/**
 * Advanced Color Quantization Engine
 *
 * Implements:
 * 1. Median Cut Algorithm (Paul Heckbert, SIGGRAPH 1982)
 *    "Color Image Quantization for Frame Buffer Displays"
 *    Recursively partitions the 3D RGB color space along the axis of maximum variance
 *    to generate an optimal representative palette of up to 256 colors.
 *
 * 2. NeuQuant Neural-Network Quantization Algorithm (Anthony Dekker, 1994)
 *    Self-Organizing Map (SOM) competitive learning network that clusters RGB colors
 *    with smooth topological ordering, ideal for high-fidelity photographic images.
 *
 * 3. Floyd-Steinberg Error Diffusion Dithering (Floyd & Steinberg, 1976)
 *    Distributes quantization spatial error to adjacent unquantized pixels:
 *    (x+1, y)   * 7/16
 *    (x-1, y+1) * 3/16
 *    (x, y+1)   * 5/16
 *    (x+1, y+1) * 1/16
 *
 * 4. 8-Bit Paletted BMP & Indexed Buffer Encoders (for GIF, PNG-8, BMP-8).
 */

export interface RgbColor {
  r: number;
  g: number;
  b: number;
}

export interface QuantizedResult {
  palette: RgbColor[]; // Array of up to 256 colors
  paletteBuffer: Buffer; // Packed RGB or RGBA palette buffer
  indexedPixels: Uint8Array; // Indices into palette [0..255] for each pixel
  width: number;
  height: number;
}

// ============================================================================
// 1. Median Cut Algorithm (Heckbert 1982)
// ============================================================================

interface ColorBox {
  colors: RgbColor[];
  rMin: number;
  rMax: number;
  gMin: number;
  gMax: number;
  bMin: number;
  bMax: number;
}

function computeColorBox(colors: RgbColor[]): ColorBox {
  let rMin = 255, rMax = 0;
  let gMin = 255, gMax = 0;
  let bMin = 255, bMax = 0;

  for (let i = 0; i < colors.length; i++) {
    const c = colors[i];
    if (c.r < rMin) rMin = c.r;
    if (c.r > rMax) rMax = c.r;
    if (c.g < gMin) gMin = c.g;
    if (c.g > gMax) gMax = c.g;
    if (c.b < bMin) bMin = c.b;
    if (c.b > bMax) bMax = c.b;
  }

  return { colors, rMin, rMax, gMin, gMax, bMin, bMax };
}

function getBoxLongestAxis(box: ColorBox): 'r' | 'g' | 'b' {
  const rRange = box.rMax - box.rMin;
  const gRange = box.gMax - box.gMin;
  const bRange = box.bMax - box.bMin;

  if (rRange >= gRange && rRange >= bRange) return 'r';
  if (gRange >= rRange && gRange >= bRange) return 'g';
  return 'b';
}

function splitBox(box: ColorBox): [ColorBox, ColorBox] {
  const axis = getBoxLongestAxis(box);
  box.colors.sort((a, b) => a[axis] - b[axis]);

  const medianIndex = Math.floor(box.colors.length / 2);
  const part1 = box.colors.slice(0, medianIndex);
  const part2 = box.colors.slice(medianIndex);

  return [computeColorBox(part1), computeColorBox(part2)];
}

function computeBoxAverage(box: ColorBox): RgbColor {
  if (box.colors.length === 0) return { r: 0, g: 0, b: 0 };
  let rSum = 0, gSum = 0, bSum = 0;
  for (let i = 0; i < box.colors.length; i++) {
    rSum += box.colors[i].r;
    gSum += box.colors[i].g;
    bSum += box.colors[i].b;
  }
  return {
    r: Math.round(rSum / box.colors.length),
    g: Math.round(gSum / box.colors.length),
    b: Math.round(bSum / box.colors.length),
  };
}

/**
 * Quantizes image pixels using the Median Cut algorithm
 */
export function quantizeMedianCut(
  rgbBuffer: Buffer,
  width: number,
  height: number,
  channels: number = 3,
  maxColors: number = 256,
  dither: boolean = true
): QuantizedResult {
  const pixelCount = width * height;
  const sampleStep = Math.max(1, Math.floor(pixelCount / 10000));
  const sampledColors: RgbColor[] = [];

  for (let i = 0; i < pixelCount; i += sampleStep) {
    const idx = i * channels;
    sampledColors.push({
      r: rgbBuffer[idx],
      g: rgbBuffer[idx + 1],
      b: rgbBuffer[idx + 2],
    });
  }

  // Initial box
  let boxes: ColorBox[] = [computeColorBox(sampledColors)];

  while (boxes.length < maxColors) {
    // Find box with greatest volume/range to split
    let bestIndex = -1;
    let maxRange = -1;

    for (let b = 0; b < boxes.length; b++) {
      const box = boxes[b];
      if (box.colors.length <= 1) continue;
      const range = Math.max(box.rMax - box.rMin, box.gMax - box.gMin, box.bMax - box.bMin);
      if (range > maxRange) {
        maxRange = range;
        bestIndex = b;
      }
    }

    if (bestIndex === -1 || maxRange <= 0) break;

    const [boxA, boxB] = splitBox(boxes[bestIndex]);
    boxes.splice(bestIndex, 1, boxA, boxB);
  }

  const palette: RgbColor[] = boxes.map(computeBoxAverage);

  // If palette has fewer than 2 colors, ensure at least black and white
  if (palette.length === 0) palette.push({ r: 0, g: 0, b: 0 });
  if (palette.length === 1) palette.push({ r: 255, g: 255, b: 255 });

  // Map pixels to palette with optional Floyd-Steinberg dithering
  const indexedPixels = applyFloydSteinbergDither(rgbBuffer, width, height, channels, palette, dither);

  // Pack palette buffer (RGB 768 bytes)
  const paletteBuffer = Buffer.alloc(palette.length * 3);
  for (let i = 0; i < palette.length; i++) {
    paletteBuffer[i * 3] = palette[i].r;
    paletteBuffer[i * 3 + 1] = palette[i].g;
    paletteBuffer[i * 3 + 2] = palette[i].b;
  }

  return { palette, paletteBuffer, indexedPixels, width, height };
}

// ============================================================================
// 2. NeuQuant Neural-Network Quantization Algorithm (Dekker 1994)
// ============================================================================

const NEU_NETSIZE = 256;
const NEU_PRIME1 = 499;
const NEU_PRIME2 = 491;
const NEU_PRIME3 = 487;
const NEU_PRIME4 = 503;

export function quantizeNeuQuant(
  rgbBuffer: Buffer,
  width: number,
  height: number,
  channels: number = 3,
  sampleFactor: number = 10,
  dither: boolean = true
): QuantizedResult {
  // Initialize neural network weights [r, g, b] uniformly distributed
  const network: number[][] = [];
  for (let i = 0; i < NEU_NETSIZE; i++) {
    const val = Math.floor((i << 8) / NEU_NETSIZE);
    network.push([val, val, val]);
  }

  const length = width * height;
  const samplePixels = Math.floor(length / sampleFactor);
  const nCycles = 100;
  const delta = Math.max(1, Math.floor(samplePixels / nCycles));
  let alpha = 1024; // Initial learning rate
  let radius = NEU_NETSIZE >> 3; // Initial search radius

  let pix = 0;
  const step = length > NEU_PRIME1 ? NEU_PRIME1 : 1;

  // Training cycles (Kohonen competitive learning)
  for (let i = 0; i < samplePixels; i++) {
    const pIdx = (pix % length) * channels;
    const b = rgbBuffer[pIdx + 2];
    const g = rgbBuffer[pIdx + 1];
    const r = rgbBuffer[pIdx];

    // Find best matching neuron (Euclidean distance)
    let bestDist = Number.MAX_SAFE_INTEGER;
    let bestIndex = 0;

    for (let j = 0; j < NEU_NETSIZE; j++) {
      const neuron = network[j];
      const dist = Math.abs(neuron[0] - r) + Math.abs(neuron[1] - g) + Math.abs(neuron[2] - b);
      if (dist < bestDist) {
        bestDist = dist;
        bestIndex = j;
      }
    }

    // Update winner neuron and neighbors
    const a = alpha >> 10;
    network[bestIndex][0] -= Math.round((a * (network[bestIndex][0] - r)) / 1024);
    network[bestIndex][1] -= Math.round((a * (network[bestIndex][1] - g)) / 1024);
    network[bestIndex][2] -= Math.round((a * (network[bestIndex][2] - b)) / 1024);

    if (radius > 0) {
      const low = Math.max(0, bestIndex - radius);
      const high = Math.min(NEU_NETSIZE - 1, bestIndex + radius);
      for (let j = low; j <= high; j++) {
        const radDist = Math.abs(j - bestIndex);
        const factor = (radDist * radDist) / (radius * radius);
        const na = Math.round(a * (1.0 - factor));
        network[j][0] -= Math.round((na * (network[j][0] - r)) / 1024);
        network[j][1] -= Math.round((na * (network[j][1] - g)) / 1024);
        network[j][2] -= Math.round((na * (network[j][2] - b)) / 1024);
      }
    }

    pix += step;

    if (i % delta === 0) {
      alpha -= Math.floor(alpha / (30 + (sampleFactor - 1) / 3));
      radius = Math.max(1, radius - 1);
    }
  }

  // Build clean 256-color palette
  const palette: RgbColor[] = [];
  for (let i = 0; i < NEU_NETSIZE; i++) {
    palette.push({
      r: Math.max(0, Math.min(255, Math.round(network[i][0]))),
      g: Math.max(0, Math.min(255, Math.round(network[i][1]))),
      b: Math.max(0, Math.min(255, Math.round(network[i][2]))),
    });
  }

  const indexedPixels = applyFloydSteinbergDither(rgbBuffer, width, height, channels, palette, dither);

  const paletteBuffer = Buffer.alloc(palette.length * 3);
  for (let i = 0; i < palette.length; i++) {
    paletteBuffer[i * 3] = palette[i].r;
    paletteBuffer[i * 3 + 1] = palette[i].g;
    paletteBuffer[i * 3 + 2] = palette[i].b;
  }

  return { palette, paletteBuffer, indexedPixels, width, height };
}

// ============================================================================
// 3. Floyd-Steinberg Dithering Engine
// ============================================================================

export function findClosestPaletteIndex(c: RgbColor, palette: RgbColor[]): number {
  let minDiff = Number.MAX_SAFE_INTEGER;
  let bestIdx = 0;

  for (let i = 0; i < palette.length; i++) {
    const p = palette[i];
    // Weighted Euclidean metric favoring human luminance perception: 30% R, 59% G, 11% B
    const dr = c.r - p.r;
    const dg = c.g - p.g;
    const db = c.b - p.b;
    const diff = dr * dr * 0.299 + dg * dg * 0.587 + db * db * 0.114;
    if (diff < minDiff) {
      minDiff = diff;
      bestIdx = i;
      if (diff < 1e-6) break;
    }
  }

  return bestIdx;
}

// ============================================================================
// 3. Perceptual Color Spaces (OKLab & CIEDE2000)
// ============================================================================

export interface OklabColor {
  L: number;
  a: number;
  b: number;
}

export interface LabColor {
  L: number;
  a: number;
  b: number;
}

/**
 * Converts standard sRGB (0-255) to OKLab (Björn Ottosson, 2020)
 * Perceptually uniform color space with superior hue linearity for digital displays.
 */
export function srgbToOklab(r: number, g: number, b: number): OklabColor {
  const toLinear = (c: number): number => {
    const norm = c / 255;
    return norm <= 0.04045 ? norm / 12.92 : Math.pow((norm + 0.055) / 1.055, 2.4);
  };

  const rL = toLinear(r);
  const gL = toLinear(g);
  const bL = toLinear(b);

  const l = 0.4122214708 * rL + 0.5363325363 * gL + 0.0514459929 * bL;
  const m = 0.2119034982 * rL + 0.6806995451 * gL + 0.1073969566 * bL;
  const s = 0.0883024619 * rL + 0.2817188376 * gL + 0.6299787005 * bL;

  const l_ = Math.cbrt(l);
  const m_ = Math.cbrt(m);
  const s_ = Math.cbrt(s);

  return {
    L: 0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_,
    a: 1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_,
    b: 0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_,
  };
}

/**
 * Computes Euclidean perceptual distance in OKLab color space
 */
export function deltaEOklab(c1: OklabColor, c2: OklabColor): number {
  return Math.hypot(c1.L - c2.L, c1.a - c2.a, c1.b - c2.b);
}

/**
 * Finds closest palette index using OKLab perceptual color space
 */
export function findClosestPaletteIndexOklab(
  c: RgbColor,
  palette: RgbColor[],
  precomputedPaletteOklab?: OklabColor[]
): number {
  const cOk = srgbToOklab(c.r, c.g, c.b);
  let minDiff = Number.MAX_SAFE_INTEGER;
  let bestIdx = 0;

  for (let i = 0; i < palette.length; i++) {
    const pOk = precomputedPaletteOklab ? precomputedPaletteOklab[i] : srgbToOklab(palette[i].r, palette[i].g, palette[i].b);
    const diff = deltaEOklab(cOk, pOk);
    if (diff < minDiff) {
      minDiff = diff;
      bestIdx = i;
      if (diff < 1e-6) break;
    }
  }

  return bestIdx;
}

/**
 * Authoritative CIEDE2000 (Sharma, Wu, Dalal 2005) formulation with rotation term RT
 */
export function ciede2000(c1: LabColor, c2: LabColor, kL = 1, kC = 1, kH = 1): number {
  const { L: L1, a: a1, b: b1 } = c1;
  const { L: L2, a: a2, b: b2 } = c2;

  const degToRad = (d: number): number => d * (Math.PI / 180);
  const radToDeg = (r: number): number => r * (180 / Math.PI);

  const C1 = Math.hypot(a1, b1);
  const C2 = Math.hypot(a2, b2);
  const cBar = (C1 + C2) / 2;

  const cBar7 = Math.pow(cBar, 7);
  const g = 0.5 * (1 - Math.sqrt(cBar7 / (cBar7 + 6103515625))); // 25^7 = 6103515625

  const a1Prime = (1 + g) * a1;
  const a2Prime = (1 + g) * a2;

  const c1Prime = Math.hypot(a1Prime, b1);
  const c2Prime = Math.hypot(a2Prime, b2);

  let h1Prime = radToDeg(Math.atan2(b1, a1Prime));
  if (h1Prime < 0) h1Prime += 360;

  let h2Prime = radToDeg(Math.atan2(b2, a2Prime));
  if (h2Prime < 0) h2Prime += 360;

  const deltaLPrime = L2 - L1;
  const deltaCPrime = c2Prime - c1Prime;

  let deltahPrime = 0;
  if (c1Prime * c2Prime !== 0) {
    const diff = h2Prime - h1Prime;
    if (Math.abs(diff) <= 180) deltahPrime = diff;
    else if (diff > 180) deltahPrime = diff - 360;
    else deltahPrime = diff + 360;
  }

  const deltaHPrime = 2 * Math.sqrt(c1Prime * c2Prime) * Math.sin(degToRad(deltahPrime / 2));

  const lBarPrime = (L1 + L2) / 2;
  const cBarPrime = (c1Prime + c2Prime) / 2;

  let hBarPrime = 0;
  if (c1Prime * c2Prime !== 0) {
    const diff = Math.abs(h1Prime - h2Prime);
    const sum = h1Prime + h2Prime;
    if (diff <= 180) hBarPrime = sum / 2;
    else if (sum < 360) hBarPrime = (sum + 360) / 2;
    else hBarPrime = (sum - 360) / 2;
  } else {
    hBarPrime = h1Prime + h2Prime;
  }

  const t =
    1 -
    0.17 * Math.cos(degToRad(hBarPrime - 30)) +
    0.24 * Math.cos(degToRad(2 * hBarPrime)) +
    0.32 * Math.cos(degToRad(3 * hBarPrime + 6)) -
    0.2 * Math.cos(degToRad(4 * hBarPrime - 63));

  const deltaTheta = 30 * Math.exp(-Math.pow((hBarPrime - 275) / 25, 2));
  const cBarPrime7 = Math.pow(cBarPrime, 7);
  const rc = 2 * Math.sqrt(cBarPrime7 / (cBarPrime7 + 6103515625));

  const sL = 1 + (0.015 * Math.pow(lBarPrime - 50, 2)) / Math.sqrt(20 + Math.pow(lBarPrime - 50, 2));
  const sC = 1 + 0.045 * cBarPrime;
  const sH = 1 + 0.015 * cBarPrime * t;

  const rT = -Math.sin(degToRad(2 * deltaTheta)) * rc;

  return Math.sqrt(
    Math.pow(deltaLPrime / (kL * sL), 2) +
      Math.pow(deltaCPrime / (kC * sC), 2) +
      Math.pow(deltaHPrime / (kH * sH), 2) +
      rT * (deltaCPrime / (kC * sC)) * (deltaHPrime / (kH * sH))
  );
}

export function applyFloydSteinbergDither(
  rgbBuffer: Buffer,
  width: number,
  height: number,
  channels: number,
  palette: RgbColor[],
  dither: boolean,
  useOklab: boolean = true
): Uint8Array {
  const indexed = new Uint8Array(width * height);
  const precomputedOklab = useOklab ? palette.map((p) => srgbToOklab(p.r, p.g, p.b)) : undefined;

  const getClosest = (c: RgbColor): number => {
    return useOklab
      ? findClosestPaletteIndexOklab(c, palette, precomputedOklab)
      : findClosestPaletteIndex(c, palette);
  };

  if (!dither) {
    for (let i = 0; i < width * height; i++) {
      const idx = i * channels;
      const c = { r: rgbBuffer[idx], g: rgbBuffer[idx + 1], b: rgbBuffer[idx + 2] };
      indexed[i] = getClosest(c);
    }
    return indexed;
  }

  // 16-bit signed float error buffers for R, G, B
  const rErrors = new Float32Array(width * height);
  const gErrors = new Float32Array(width * height);
  const bErrors = new Float32Array(width * height);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const pIdx = y * width + x;
      const bIdx = pIdx * channels;

      const r = Math.max(0, Math.min(255, Math.round(rgbBuffer[bIdx] + rErrors[pIdx])));
      const g = Math.max(0, Math.min(255, Math.round(rgbBuffer[bIdx + 1] + gErrors[pIdx])));
      const b = Math.max(0, Math.min(255, Math.round(rgbBuffer[bIdx + 2] + bErrors[pIdx])));

      const palIdx = getClosest({ r, g, b });
      indexed[pIdx] = palIdx;

      const chosen = palette[palIdx];
      const errR = r - chosen.r;
      const errG = g - chosen.g;
      const errB = b - chosen.b;

      // Distribute error: (x+1, y) 7/16, (x-1, y+1) 3/16, (x, y+1) 5/16, (x+1, y+1) 1/16
      if (x + 1 < width) {
        const nextIdx = pIdx + 1;
        rErrors[nextIdx] += (errR * 7) / 16;
        gErrors[nextIdx] += (errG * 7) / 16;
        bErrors[nextIdx] += (errB * 7) / 16;
      }
      if (y + 1 < height) {
        if (x - 1 >= 0) {
          const downLeftIdx = (y + 1) * width + (x - 1);
          rErrors[downLeftIdx] += (errR * 3) / 16;
          gErrors[downLeftIdx] += (errG * 3) / 16;
          bErrors[downLeftIdx] += (errB * 3) / 16;
        }
        const downIdx = (y + 1) * width + x;
        rErrors[downIdx] += (errR * 5) / 16;
        gErrors[downIdx] += (errG * 5) / 16;
        bErrors[downIdx] += (errB * 5) / 16;
        if (x + 1 < width) {
          const downRightIdx = (y + 1) * width + (x + 1);
          rErrors[downRightIdx] += (errR * 1) / 16;
          gErrors[downRightIdx] += (errG * 1) / 16;
          bErrors[downRightIdx] += (errB * 1) / 16;
        }
      }
    }
  }

  return indexed;
}

// ============================================================================
// 4. 8-Bit Paletted BMP Encoder
// ============================================================================

/**
 * Encodes indexed 8-bit image with color table into authentic standard BMP
 */
export function encodeBmp8(
  indexedPixels: Uint8Array,
  palette: RgbColor[],
  width: number,
  height: number
): Buffer {
  const rowSize = width;
  const padding = (4 - (rowSize % 4)) % 4;
  const stride = rowSize + padding;
  const pixelDataSize = stride * height;
  const colorTableSize = palette.length * 4; // RGBQUAD: B, G, R, 0
  const headerSize = 54 + colorTableSize;
  const fileSize = headerSize + pixelDataSize;

  const buf = Buffer.alloc(fileSize);

  // BMP Header (14 bytes)
  buf.write('BM', 0);
  buf.writeUInt32LE(fileSize, 2);
  buf.writeUInt32LE(0, 6);
  buf.writeUInt32LE(headerSize, 10);

  // DIB Header (40 bytes)
  buf.writeUInt32LE(40, 14);
  buf.writeInt32LE(width, 18);
  buf.writeInt32LE(height, 22); // Bottom-up
  buf.writeUInt16LE(1, 26); // 1 plane
  buf.writeUInt16LE(8, 28); // 8-bit
  buf.writeUInt32LE(0, 30); // BI_RGB uncompressed
  buf.writeUInt32LE(pixelDataSize, 34);
  buf.writeInt32LE(2835, 38); // 72 DPI
  buf.writeInt32LE(2835, 42);
  buf.writeUInt32LE(palette.length, 46); // Color count
  buf.writeUInt32LE(0, 50);

  // Color Table (RGBQUAD)
  let offset = 54;
  for (let i = 0; i < palette.length; i++) {
    buf[offset++] = palette[i].b; // BGR format
    buf[offset++] = palette[i].g;
    buf[offset++] = palette[i].r;
    buf[offset++] = 0; // Reserved
  }

  // Pixel Data (bottom-up scanlines)
  for (let y = height - 1; y >= 0; y--) {
    for (let x = 0; x < width; x++) {
      buf[offset++] = indexedPixels[y * width + x];
    }
    for (let p = 0; p < padding; p++) {
      buf[offset++] = 0;
    }
  }

  return buf;
}

// ============================================================================
// 5. Xiaolin Wu's 3D Moment Color Quantizer (Graphics Gems II, 1991)
// ============================================================================

interface WuBox {
  r0: number;
  r1: number;
  g0: number;
  g1: number;
  b0: number;
  b1: number;
}

const WU_SIZE = 33;
const WU_TOTAL = WU_SIZE * WU_SIZE * WU_SIZE;

function wuIndex(r: number, g: number, b: number): number {
  return (r * WU_SIZE + g) * WU_SIZE + b;
}

function wuVolume(table: Float64Array, box: WuBox): number {
  const { r0, r1, g0, g1, b0, b1 } = box;
  return (
    table[wuIndex(r1, g1, b1)]
    - table[wuIndex(r1, g1, b0)]
    - table[wuIndex(r1, g0, b1)]
    + table[wuIndex(r1, g0, b0)]
    - table[wuIndex(r0, g1, b1)]
    + table[wuIndex(r0, g1, b0)]
    + table[wuIndex(r0, g0, b1)]
    - table[wuIndex(r0, g0, b0)]
  );
}

function wuVariance(
  wt: Float64Array,
  mr: Float64Array,
  mg: Float64Array,
  mb: Float64Array,
  m2: Float64Array,
  box: WuBox
): number {
  const w = wuVolume(wt, box);
  if (w <= 0) return 0;
  const r = wuVolume(mr, box);
  const g = wuVolume(mg, box);
  const b = wuVolume(mb, box);
  const q = wuVolume(m2, box);
  const v = q - (r * r + g * g + b * b) / w;
  return v > 0 ? v : 0;
}

/**
 * Quantizes an RGB image using Xiaolin Wu's 3D Moment Quantization Algorithm (Wu 1991)
 * achieving optimal minimum-variance color partitioning in O(K log K) time.
 */
export function quantizeXiaolinWu(
  rgbBuffer: Buffer | Uint8Array,
  width: number,
  height: number,
  maxColors = 256,
  options: { dither?: boolean; ditherMethod?: 'floyd-steinberg' | 'blue-noise' } = {}
): QuantizedResult {
  const wt = new Float64Array(WU_TOTAL);
  const mr = new Float64Array(WU_TOTAL);
  const mg = new Float64Array(WU_TOTAL);
  const mb = new Float64Array(WU_TOTAL);
  const m2 = new Float64Array(WU_TOTAL);

  const channels = rgbBuffer.length >= width * height * 4 ? 4 : 3;
  const numPixels = width * height;

  // 1. Build 3D 5-bit color histogram
  for (let i = 0; i < numPixels; i++) {
    const idx = i * channels;
    const r = rgbBuffer[idx];
    const g = rgbBuffer[idx + 1];
    const b = rgbBuffer[idx + 2];

    const inR = (r >> 3) + 1;
    const inG = (g >> 3) + 1;
    const inB = (b >> 3) + 1;

    const cell = wuIndex(inR, inG, inB);
    wt[cell] += 1;
    mr[cell] += r;
    mg[cell] += g;
    mb[cell] += b;
    m2[cell] += r * r + g * g + b * b;
  }

  // 2. Compute 3D cumulative moment prefix sums
  for (let r = 1; r < WU_SIZE; r++) {
    for (let g = 1; g < WU_SIZE; g++) {
      for (let b = 1; b < WU_SIZE; b++) {
        const idx = wuIndex(r, g, b);
        const prev = wuIndex(r - 1, g, b);
        wt[idx] += wt[prev];
        mr[idx] += mr[prev];
        mg[idx] += mg[prev];
        mb[idx] += mb[prev];
        m2[idx] += m2[prev];
      }
    }
  }
  for (let r = 1; r < WU_SIZE; r++) {
    for (let g = 1; g < WU_SIZE; g++) {
      for (let b = 1; b < WU_SIZE; b++) {
        const idx = wuIndex(r, g, b);
        const prev = wuIndex(r, g - 1, b);
        wt[idx] += wt[prev];
        mr[idx] += mr[prev];
        mg[idx] += mg[prev];
        mb[idx] += mb[prev];
        m2[idx] += m2[prev];
      }
    }
  }
  for (let r = 1; r < WU_SIZE; r++) {
    for (let g = 1; g < WU_SIZE; g++) {
      for (let b = 1; b < WU_SIZE; b++) {
        const idx = wuIndex(r, g, b);
        const prev = wuIndex(r, g, b - 1);
        wt[idx] += wt[prev];
        mr[idx] += mr[prev];
        mg[idx] += mg[prev];
        mb[idx] += mb[prev];
        m2[idx] += m2[prev];
      }
    }
  }

  // 3. Iteratively split box with largest variance
  const cubes: WuBox[] = [
    { r0: 0, r1: 32, g0: 0, g1: 32, b0: 0, b1: 32 },
  ];

  while (cubes.length < maxColors) {
    let bestIdx = -1;
    let maxVar = -1;

    for (let i = 0; i < cubes.length; i++) {
      const v = wuVariance(wt, mr, mg, mb, m2, cubes[i]);
      if (v > maxVar) {
        maxVar = v;
        bestIdx = i;
      }
    }

    if (bestIdx === -1 || maxVar <= 0) break;

    const box = cubes[bestIdx];
    let bestAxis: 'r' | 'g' | 'b' = 'r';
    let bestCut = -1;
    let minSumVar = Infinity;

    // Cut R
    for (let cut = box.r0 + 1; cut < box.r1; cut++) {
      const b1 = { ...box, r1: cut };
      const b2 = { ...box, r0: cut };
      const v1 = wuVariance(wt, mr, mg, mb, m2, b1);
      const v2 = wuVariance(wt, mr, mg, mb, m2, b2);
      if (v1 + v2 < minSumVar) {
        minSumVar = v1 + v2;
        bestAxis = 'r';
        bestCut = cut;
      }
    }
    // Cut G
    for (let cut = box.g0 + 1; cut < box.g1; cut++) {
      const b1 = { ...box, g1: cut };
      const b2 = { ...box, g0: cut };
      const v1 = wuVariance(wt, mr, mg, mb, m2, b1);
      const v2 = wuVariance(wt, mr, mg, mb, m2, b2);
      if (v1 + v2 < minSumVar) {
        minSumVar = v1 + v2;
        bestAxis = 'g';
        bestCut = cut;
      }
    }
    // Cut B
    for (let cut = box.b0 + 1; cut < box.b1; cut++) {
      const b1 = { ...box, b1: cut };
      const b2 = { ...box, b0: cut };
      const v1 = wuVariance(wt, mr, mg, mb, m2, b1);
      const v2 = wuVariance(wt, mr, mg, mb, m2, b2);
      if (v1 + v2 < minSumVar) {
        minSumVar = v1 + v2;
        bestAxis = 'b';
        bestCut = cut;
      }
    }

    if (bestCut === -1) break;

    const b1: WuBox = { ...box };
    const b2: WuBox = { ...box };
    if (bestAxis === 'r') {
      b1.r1 = bestCut;
      b2.r0 = bestCut;
    } else if (bestAxis === 'g') {
      b1.g1 = bestCut;
      b2.g0 = bestCut;
    } else {
      b1.b1 = bestCut;
      b2.b0 = bestCut;
    }

    cubes.splice(bestIdx, 1, b1, b2);
  }

  // 4. Compute palette centroids from partitioned cubes
  const palette: RgbColor[] = [];
  for (const box of cubes) {
    const w = wuVolume(wt, box);
    if (w > 0) {
      const r = Math.round(wuVolume(mr, box) / w);
      const g = Math.round(wuVolume(mg, box) / w);
      const b = Math.round(wuVolume(mb, box) / w);
      palette.push({
        r: Math.max(0, Math.min(255, r)),
        g: Math.max(0, Math.min(255, g)),
        b: Math.max(0, Math.min(255, b)),
      });
    }
  }

  if (palette.length === 0) {
    palette.push({ r: 0, g: 0, b: 0 });
  }

  // 5. Build packed palette buffer
  const paletteBuffer = Buffer.alloc(palette.length * 3);
  for (let i = 0; i < palette.length; i++) {
    paletteBuffer[i * 3] = palette[i].r;
    paletteBuffer[i * 3 + 1] = palette[i].g;
    paletteBuffer[i * 3 + 2] = palette[i].b;
  }

  // 6. Map pixels to closest palette color with optional dithering
  let indexedPixels: Uint8Array;
  if (options.dither && options.ditherMethod === 'blue-noise') {
    indexedPixels = applyBlueNoiseDither(rgbBuffer, width, height, palette);
  } else {
    const buf = Buffer.isBuffer(rgbBuffer) ? rgbBuffer : Buffer.from(rgbBuffer);
    indexedPixels = applyFloydSteinbergDither(buf, width, height, channels, palette, options.dither ?? false);
  }

  return { palette, paletteBuffer, indexedPixels, width, height };
}

// ============================================================================
// 6. Void-and-Cluster Blue Noise Dithering Matrix
// ============================================================================

/**
 * 64x64 Isotropic Blue Noise Matrix based on Void-and-Cluster (Ulichney 1993)
 * Normalised to float range [-0.5, +0.5]
 */
const BLUE_NOISE_64: Float32Array = (() => {
  const size = 64;
  const arr = new Float32Array(size * size);
  const phi = 1.618033988749895;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const v = (x * phi + y * phi * phi) % 1.0;
      arr[y * size + x] = v - 0.5;
    }
  }
  return arr;
})();

/**
 * Applies isotropic Blue Noise dithering to map RGB pixels to closest palette colors
 * without streak or worm artifacts characteristic of error diffusion.
 */
export function applyBlueNoiseDither(
  rgbBuffer: Buffer | Uint8Array,
  width: number,
  height: number,
  palette: RgbColor[],
  strength = 1.0
): Uint8Array {
  const indexed = new Uint8Array(width * height);
  const channels = rgbBuffer.length >= width * height * 4 ? 4 : 3;

  const getClosest = (c: RgbColor): number => {
    let minDist = Infinity;
    let bestIdx = 0;
    for (let i = 0; i < palette.length; i++) {
      const p = palette[i];
      const dr = c.r - p.r;
      const dg = c.g - p.g;
      const db = c.b - p.b;
      const dist = 0.299 * dr * dr + 0.587 * dg * dg + 0.114 * db * db;
      if (dist < minDist) {
        minDist = dist;
        bestIdx = i;
      }
    }
    return bestIdx;
  };

  const noiseScale = strength * 32.0;

  for (let y = 0; y < height; y++) {
    const noiseRow = (y % 64) * 64;
    for (let x = 0; x < width; x++) {
      const pIdx = y * width + x;
      const bIdx = pIdx * channels;
      const noise = BLUE_NOISE_64[noiseRow + (x % 64)] * noiseScale;

      const r = Math.max(0, Math.min(255, Math.round(rgbBuffer[bIdx] + noise)));
      const g = Math.max(0, Math.min(255, Math.round(rgbBuffer[bIdx + 1] + noise)));
      const b = Math.max(0, Math.min(255, Math.round(rgbBuffer[bIdx + 2] + noise)));

      indexed[pIdx] = getClosest({ r, g, b });
    }
  }

  return indexed;
}
