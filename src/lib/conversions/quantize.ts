/**
 * Palette quantization for the 8-bit BMP writer
 *
 * 1. NeuQuant Neural-Network Quantization Algorithm (Anthony Dekker, 1994)
 *    Self-Organizing Map (SOM) competitive learning network that clusters RGB colors
 *    with smooth topological ordering, ideal for high-fidelity photographic images.
 *
 * 2. Floyd-Steinberg Error Diffusion Dithering (Floyd & Steinberg, 1976)
 *    Distributes quantization spatial error to adjacent unquantized pixels:
 *    (x+1, y)   * 7/16
 *    (x-1, y+1) * 3/16
 *    (x, y+1)   * 5/16
 *    (x+1, y+1) * 1/16
 *
 * 3. Nearest palette colour in OKLab (Björn Ottosson, 2020).
 *
 * 4. 8-Bit Paletted BMP Encoder.
 *
 * The GIF and PNG palettes come from color-quantizer.ts.
 */

import { QUANTIZER_PIXEL_BUDGET, assertPixelBudget } from './image-input-limits';

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
// 1. NeuQuant Neural-Network Quantization Algorithm (Dekker 1994)
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
  assertPixelBudget(width, height, QUANTIZER_PIXEL_BUDGET);
  // Initialize neural network weights [r, g, b] uniformly distributed
  const network: number[][] = [];
  for (let i = 0; i < NEU_NETSIZE; i++) {
    const val = Math.floor((i << 8) / NEU_NETSIZE);
    network.push([val, val, val]);
  }

  const length = width * height;
  const MAX_NEUQUANT_SAMPLES = 100_000;
  const effectiveSampleFactor = Math.max(1, sampleFactor, Math.ceil(length / MAX_NEUQUANT_SAMPLES));
  const samplePixels = Math.floor(length / effectiveSampleFactor);
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
      const decaySampleFactor = Math.min(30, effectiveSampleFactor);
      alpha -= Math.floor(alpha / (30 + (decaySampleFactor - 1) / 3));
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
// 2. Floyd-Steinberg Dithering Engine
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
// 3. Perceptual Color Space (OKLab)
// ============================================================================

export interface OklabColor {
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

function createPaletteLookup(
  computeIndex: (c: RgbColor) => number
): (c: RgbColor) => number {
  const cacheKeys = new Int32Array(65536).fill(-1);
  const cacheValues = new Uint16Array(65536);
  return (c: RgbColor): number => {
    const rgb24 = (c.r << 16) | (c.g << 8) | c.b;
    const slot = ((rgb24 * 2654435761) >>> 16) & 0xffff;
    if (cacheKeys[slot] === rgb24) return cacheValues[slot];
    const found = computeIndex(c);
    cacheKeys[slot] = rgb24;
    cacheValues[slot] = found;
    return found;
  };
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
  assertPixelBudget(width, height, QUANTIZER_PIXEL_BUDGET);
  const indexed = new Uint8Array(width * height);
  const precomputedOklab = useOklab ? palette.map((p) => srgbToOklab(p.r, p.g, p.b)) : undefined;

  const getClosest = createPaletteLookup((c: RgbColor) =>
    useOklab
      ? findClosestPaletteIndexOklab(c, palette, precomputedOklab)
      : findClosestPaletteIndex(c, palette)
  );

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
