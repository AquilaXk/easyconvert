import type { BayerPattern, BayerSensorData } from '../../src/lib/conversions/image';

/**
 * Deterministic Bayer mosaics for the AHD / AMaZE equivalence goldens. Every sample comes from the
 * closed-form scene below plus a seeded PRNG, so a case is reproducible byte for byte on any machine.
 */

export type SampleContainer = 'u8' | 'u16' | 'f32' | 'buf16le';
export type DemosaicName = 'ahd' | 'amaze';

export interface SyntheticCase {
  id: string;
  methods: readonly DemosaicName[];
  width: number;
  height: number;
  pattern: BayerPattern;
  container: SampleContainer;
  bitsPerSample: number;
  /** Extra sensor fields (calibration, white balance, matrices, flags) passed through verbatim. */
  extra: Partial<BayerSensorData>;
  /** Scene flavour: how the closed-form scene is shaped. */
  scene: 'edges' | 'flat' | 'white' | 'black' | 'noise';
  seed: number;
}

const PRNG_INCREMENT = 0x6d2b79f5;
const U32_SCALE = 4294967296;
const SCENE_EDGE_X = 0.37;
const SCENE_PLATE_SCALE = 0.0035;
const SCENE_NOISE_AMPLITUDE = 0.015;
const FLAT_LEVEL = 0.4;

/** mulberry32: a 32-bit PRNG with a published reference sequence (no dependency on Math.random). */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + PRNG_INCREMENT) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / U32_SCALE;
  };
}

function channelAt(pattern: BayerPattern, x: number, y: number): 0 | 1 | 2 {
  const cell = pattern[((y & 1) << 1) | (x & 1)];
  if (cell === 'R') return 0;
  if (cell === 'B') return 2;
  return 1;
}

/** Scene radiance in [0, 1] for one colour channel at (x, y). */
function sceneValue(kind: SyntheticCase['scene'], channel: number, x: number, y: number, width: number, height: number, noise: number): number {
  if (kind === 'flat') return FLAT_LEVEL;
  if (kind === 'white') return 1;
  if (kind === 'black') return 0;
  const u = x / width;
  const v = y / height;
  const plate = 0.5 + 0.45 * Math.sin((x * x + y * y) * SCENE_PLATE_SCALE * (1 + channel * 0.25));
  const diagonal = u + v * 0.6 > 0.9 ? 0.85 : 0.1;
  const verticalEdge = u > SCENE_EDGE_X && u < SCENE_EDGE_X + 0.12 ? 1 : 0;
  const ramp = v;
  const base = [plate, 0.5 * ramp + 0.3 * diagonal, 0.7 * (1 - ramp) + 0.25 * verticalEdge][channel];
  const saturated = channel === 0 && u > 0.82 && v < 0.2 ? 1.4 : 0;
  const value = kind === 'noise' ? base + (noise - 0.5) * 0.4 : base + (noise - 0.5) * SCENE_NOISE_AMPLITUDE;
  return Math.max(0, value + saturated);
}

export function buildSensor(c: SyntheticCase): BayerSensorData {
  const { width, height, pattern, container, bitsPerSample } = c;
  const maxCode = 2 ** bitsPerSample - 1;
  const rand = mulberry32(c.seed);
  const codes = new Uint32Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const radiance = sceneValue(c.scene, channelAt(pattern, x, y), x, y, width, height, rand());
      codes[y * width + x] = Math.max(0, Math.min(maxCode, Math.round(radiance * maxCode)));
    }
  }
  let data: BayerSensorData['data'];
  if (container === 'u8') {
    data = Uint8Array.from(codes);
  } else if (container === 'u16') {
    data = Uint16Array.from(codes);
  } else if (container === 'f32') {
    data = Float32Array.from(codes, (code) => code + 0.25);
  } else {
    const buf = Buffer.alloc(width * height * 2);
    codes.forEach((code, i) => buf.writeUInt16LE(code, i * 2));
    data = buf;
  }
  return { width, height, pattern, data, bitsPerSample, ...c.extra };
}

const CAMERA_TO_SRGB: BayerSensorData['colorMatrix'] = [1.6, -0.4, -0.2, -0.3, 1.5, -0.2, -0.05, -0.45, 1.5];

export const SYNTHETIC_CASES: readonly SyntheticCase[] = [
  { id: 's8-rggb-64x48', methods: ['ahd', 'amaze'], width: 64, height: 48, pattern: 'RGGB', container: 'u8', bitsPerSample: 8, extra: {}, scene: 'edges', seed: 11 },
  {
    id: 's12-bggr-96x64-cal',
    methods: ['ahd', 'amaze'],
    width: 96,
    height: 64,
    pattern: 'BGGR',
    container: 'u16',
    bitsPerSample: 12,
    extra: { blackLevel: [64, 66, 63, 65], whiteLevel: 4000, whiteBalance: [2.0, 1.0, 1.5], colorMatrix: CAMERA_TO_SRGB, applySrgbGamma: true },
    scene: 'edges',
    seed: 12,
  },
  {
    id: 's14-grbg-80x60-fcs',
    methods: ['ahd', 'amaze'],
    width: 80,
    height: 60,
    pattern: 'GRBG',
    container: 'u16',
    bitsPerSample: 14,
    extra: { blackLevel: 512, whiteLevel: 15000, falseColorSuppression: 2, applySrgbGamma: false },
    scene: 'noise',
    seed: 13,
  },
  {
    id: 's16-gbrg-72x56-buffer',
    methods: ['ahd'],
    width: 72,
    height: 56,
    pattern: 'GBRG',
    container: 'buf16le',
    bitsPerSample: 16,
    extra: { blackLevel: 256, applySrgbGamma: true },
    scene: 'edges',
    seed: 14,
  },
  {
    // The reference AHD reads a non-Uint16Array wider than 8 bits as a Buffer and throws on a Float32Array.
    id: 's10-rggb-64x64-float',
    methods: ['amaze'],
    width: 64,
    height: 64,
    pattern: 'RGGB',
    container: 'f32',
    bitsPerSample: 10,
    extra: { blackLevel: [16], whiteLevel: 1000, whiteBalance: [1.8, 1.0, 1.3] },
    scene: 'edges',
    seed: 15,
  },
  { id: 's12-rggb-61x45-odd', methods: ['ahd'], width: 61, height: 45, pattern: 'RGGB', container: 'u16', bitsPerSample: 12, extra: {}, scene: 'edges', seed: 16 },
  { id: 's12-bggr-160x132-seams', methods: ['ahd', 'amaze'], width: 160, height: 132, pattern: 'BGGR', container: 'u16', bitsPerSample: 12, extra: { blackLevel: 128 }, scene: 'edges', seed: 17 },
  { id: 's12-grbg-4x4-tiny', methods: ['ahd', 'amaze'], width: 4, height: 4, pattern: 'GRBG', container: 'u16', bitsPerSample: 12, extra: {}, scene: 'noise', seed: 18 },
  { id: 's12-rggb-6x2-strip', methods: ['amaze'], width: 6, height: 2, pattern: 'RGGB', container: 'u16', bitsPerSample: 12, extra: {}, scene: 'noise', seed: 19 },
  { id: 's12-gbrg-32x32-flat', methods: ['ahd', 'amaze'], width: 32, height: 32, pattern: 'GBRG', container: 'u16', bitsPerSample: 12, extra: {}, scene: 'flat', seed: 20 },
  { id: 's12-rggb-32x32-white', methods: ['ahd', 'amaze'], width: 32, height: 32, pattern: 'RGGB', container: 'u16', bitsPerSample: 12, extra: {}, scene: 'white', seed: 21 },
  { id: 's12-rggb-32x32-black', methods: ['ahd', 'amaze'], width: 32, height: 32, pattern: 'RGGB', container: 'u16', bitsPerSample: 12, extra: { blackLevel: 100 }, scene: 'black', seed: 22 },
];

/** Real-sensor crop case: a window of the Raspberry Pi imx477 frame (RAW12), cut on even coordinates. */
export interface RealCropCase {
  id: string;
  sample: string;
  left: number;
  top: number;
  width: number;
  height: number;
  methods: readonly DemosaicName[];
}

export const REAL_CROP_CASES: readonly RealCropCase[] = [
  { id: 'real-imx477-192x144', sample: 'raw-imx477.raw', left: 1600, top: 1200, width: 192, height: 144, methods: ['ahd', 'amaze'] },
];

export const IMX477_BLACK_LEVEL = 256;
export const IMX477_WHITE_LEVEL = 4095;
export const IMX477_BITS = 12;

export function cropSensor(
  plane: Uint16Array,
  planeWidth: number,
  bayer: BayerPattern,
  crop: RealCropCase
): BayerSensorData {
  const out = new Uint16Array(crop.width * crop.height);
  for (let y = 0; y < crop.height; y += 1) {
    const from = (crop.top + y) * planeWidth + crop.left;
    out.set(plane.subarray(from, from + crop.width), y * crop.width);
  }
  return {
    width: crop.width,
    height: crop.height,
    pattern: bayer,
    data: out,
    bitsPerSample: IMX477_BITS,
    blackLevel: IMX477_BLACK_LEVEL,
    whiteLevel: IMX477_WHITE_LEVEL,
    whiteBalance: [2.0, 1.0, 1.6],
    colorMatrix: CAMERA_TO_SRGB,
    applySrgbGamma: true,
  };
}
