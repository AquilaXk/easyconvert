/**
 * Shared output stage of the in-process camera RAW decoders: a 3x3 colour matrix on linear 16-bit
 * RGB followed by the IEC 61966-2-1 sRGB transfer curve, producing the 16-bit gamma-encoded RGB
 * the image pipeline encodes to every target.
 */

export type Matrix3x3 = readonly [number, number, number, number, number, number, number, number, number];

export const RGB_CHANNELS = 3;
export const MAX_SAMPLE_16 = 65535;
const LINEAR_LEVELS = MAX_SAMPLE_16 + 1;
const SRGB_LINEAR_THRESHOLD = 0.0031308;
const SRGB_LINEAR_SLOPE = 12.92;
const SRGB_SCALE = 1.055;
const SRGB_OFFSET = 0.055;
const SRGB_EXPONENT = 1 / 2.4;

let srgbEncodeTable: Uint16Array | null = null;

/** 65536-entry table mapping a linear 16-bit level to its sRGB-encoded 16-bit level. */
function getSrgbEncodeTable(): Uint16Array {
  if (srgbEncodeTable) return srgbEncodeTable;
  const table = new Uint16Array(LINEAR_LEVELS);
  for (let level = 0; level < LINEAR_LEVELS; level += 1) {
    const linear = level / MAX_SAMPLE_16;
    const encoded =
      linear <= SRGB_LINEAR_THRESHOLD
        ? SRGB_LINEAR_SLOPE * linear
        : SRGB_SCALE * Math.pow(linear, SRGB_EXPONENT) - SRGB_OFFSET;
    table[level] = Math.round(encoded * MAX_SAMPLE_16);
  }
  srgbEncodeTable = table;
  return table;
}

/** Matrix product a * b of two row-major 3x3 matrices. */
export function multiply3x3(a: Matrix3x3, b: Matrix3x3): Matrix3x3 {
  const out: number[] = [];
  for (let row = 0; row < RGB_CHANNELS; row += 1) {
    for (let column = 0; column < RGB_CHANNELS; column += 1) {
      let sum = 0;
      for (let k = 0; k < RGB_CHANNELS; k += 1) sum += a[row * RGB_CHANNELS + k] * b[k * RGB_CHANNELS + column];
      out.push(sum);
    }
  }
  return out as unknown as Matrix3x3;
}

/**
 * Converts interleaved linear 16-bit RGB in place: applies the matrix (sensor RGB to linear sRGB),
 * clamps to the 16-bit range and encodes with the sRGB transfer curve.
 */
export function applyMatrixAndSrgbEncode(rgb: Uint16Array, matrix: Matrix3x3): void {
  const table = getSrgbEncodeTable();
  const [m0, m1, m2, m3, m4, m5, m6, m7, m8] = matrix;
  for (let i = 0; i + 2 < rgb.length; i += RGB_CHANNELS) {
    const r = rgb[i];
    const g = rgb[i + 1];
    const b = rgb[i + 2];
    rgb[i] = table[clamp16(m0 * r + m1 * g + m2 * b)];
    rgb[i + 1] = table[clamp16(m3 * r + m4 * g + m5 * b)];
    rgb[i + 2] = table[clamp16(m6 * r + m7 * g + m8 * b)];
  }
}

/** Clamps a number to the 16-bit sample range. */
export function clamp16(value: number): number {
  if (value <= 0) return 0;
  if (value >= MAX_SAMPLE_16) return MAX_SAMPLE_16;
  return Math.round(value);
}

/** Linear level a mid-grey (18%) scene average is rendered at. */
const MID_GREY = 0.18;
/** Share of samples allowed above full scale when the exposure is raised. */
const HIGHLIGHT_PERCENTILE = 0.995;
const EXPOSURE_MAX_FACTOR = 64;

/**
 * Exposure multiplier for linear samples (1.0 = full scale): brings the scene average to mid-grey,
 * but never so far that more than 0.5% of the samples would clip. Returns 1 for an empty or black scene.
 */
export function exposureScale(samples: Float32Array): number {
  if (samples.length === 0) return 1;
  let sum = 0;
  for (let i = 0; i < samples.length; i += 1) sum += samples[i];
  const mean = sum / samples.length;
  const sorted = Float32Array.from(samples).sort();
  const highlight = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * HIGHLIGHT_PERCENTILE))];
  if (!(mean > 0) || !(highlight > 0)) return 1;
  const scale = Math.min(MID_GREY / mean, 1 / highlight);
  return Math.min(EXPOSURE_MAX_FACTOR, Math.max(1 / EXPOSURE_MAX_FACTOR, scale));
}
