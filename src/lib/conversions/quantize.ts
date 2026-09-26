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
      if (diff === 0) break;
    }
  }

  return bestIdx;
}

export function applyFloydSteinbergDither(
  rgbBuffer: Buffer,
  width: number,
  height: number,
  channels: number,
  palette: RgbColor[],
  dither: boolean
): Uint8Array {
  const indexed = new Uint8Array(width * height);
  if (!dither) {
    for (let i = 0; i < width * height; i++) {
      const idx = i * channels;
      const c = { r: rgbBuffer[idx], g: rgbBuffer[idx + 1], b: rgbBuffer[idx + 2] };
      indexed[i] = findClosestPaletteIndex(c, palette);
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

      const palIdx = findClosestPaletteIndex({ r, g, b }, palette);
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
