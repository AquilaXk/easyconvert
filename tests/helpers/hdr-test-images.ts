import { buildUltraHdrJpeg, type UltraHdrGainMapMetadata } from './ultrahdr-builder';
import { writeRgbOpenExr, type ExrSampleType } from './openexr-writer';

/**
 * Deterministic HDR test images made of flat colour patches in a 4x2 grid. Every patch is 16x16
 * pixels, so JPEG 8x8 blocks and 16x16 chroma MCUs never straddle two patches and a patch centre
 * decodes to its flat colour within codec noise.
 */

export const PATCH_SIZE = 16;
export const GRID_COLUMNS = 4;
export const GRID_ROWS = 2;
export const HDR_IMAGE_WIDTH = GRID_COLUMNS * PATCH_SIZE;
export const HDR_IMAGE_HEIGHT = GRID_ROWS * PATCH_SIZE;
const PATCH_CENTRE_MARGIN = 5;

export type Rgb = readonly [number, number, number];

export interface Patch {
  name: string;
  /** Scene-linear radiance carried by the EXR source. */
  linear: Rgb;
}

export const PATCHES: readonly Patch[] = [
  { name: 'red', linear: [0.8, 0.05, 0.05] },
  { name: 'green', linear: [0.05, 0.8, 0.05] },
  { name: 'blue', linear: [0.05, 0.05, 0.8] },
  { name: 'near-black', linear: [0.02, 0.02, 0.02] },
  { name: 'mid-grey', linear: [0.18, 0.18, 0.18] },
  { name: 'white', linear: [1, 1, 1] },
  { name: 'super-white', linear: [4, 4, 4] },
  { name: 'orange', linear: [1, 0.4, 0.05] },
];

const SRGB_LINEAR_SEGMENT_LIMIT = 0.0031308;
const SRGB_LINEAR_SLOPE = 12.92;
const SRGB_ENCODE_SCALE = 1.055;
const SRGB_ENCODE_OFFSET = 0.055;
const SRGB_GAMMA = 2.4;
const SRGB_DECODE_LIMIT = 0.04045;
const BYTE_MAX = 255;

/** IEC 61966-2-1 encoding, written from the standard's formula. */
export function srgbEncode(linear: number): number {
  const clamped = Math.min(1, Math.max(0, linear));
  if (clamped <= SRGB_LINEAR_SEGMENT_LIMIT) return clamped * SRGB_LINEAR_SLOPE;
  return SRGB_ENCODE_SCALE * clamped ** (1 / SRGB_GAMMA) - SRGB_ENCODE_OFFSET;
}

/** IEC 61966-2-1 decoding (display value in 0..1 to linear light). */
export function srgbDecode(encoded: number): number {
  if (encoded <= SRGB_DECODE_LIMIT) return encoded / SRGB_LINEAR_SLOPE;
  return ((encoded + SRGB_ENCODE_OFFSET) / SRGB_ENCODE_SCALE) ** SRGB_GAMMA;
}

export function srgbEncode8(linear: number): number {
  return Math.round(srgbEncode(linear) * BYTE_MAX);
}

export function patchIndexAt(x: number, y: number): number {
  return Math.floor(y / PATCH_SIZE) * GRID_COLUMNS + Math.floor(x / PATCH_SIZE);
}

/** Mean RGB over the central area of a patch from a tightly packed interleaved buffer. */
export function patchCentreMean(
  data: Uint8Array | Float32Array,
  channels: number,
  imageWidth: number,
  patchIndex: number
): number[] {
  const originX = (patchIndex % GRID_COLUMNS) * PATCH_SIZE;
  const originY = Math.floor(patchIndex / GRID_COLUMNS) * PATCH_SIZE;
  const sums = [0, 0, 0];
  let count = 0;
  for (let y = originY + PATCH_CENTRE_MARGIN; y < originY + PATCH_SIZE - PATCH_CENTRE_MARGIN; y++) {
    for (let x = originX + PATCH_CENTRE_MARGIN; x < originX + PATCH_SIZE - PATCH_CENTRE_MARGIN; x++) {
      const at = (y * imageWidth + x) * channels;
      sums[0] += data[at];
      sums[1] += data[at + 1];
      sums[2] += data[at + 2];
      count++;
    }
  }
  return sums.map((sum) => sum / count);
}

function fillPatches(valueOf: (patch: number) => number[], channels: number): Float32Array {
  const out = new Float32Array(HDR_IMAGE_WIDTH * HDR_IMAGE_HEIGHT * channels);
  for (let y = 0; y < HDR_IMAGE_HEIGHT; y++) {
    for (let x = 0; x < HDR_IMAGE_WIDTH; x++) {
      const values = valueOf(patchIndexAt(x, y));
      for (let c = 0; c < channels; c++) out[(y * HDR_IMAGE_WIDTH + x) * channels + c] = values[c];
    }
  }
  return out;
}

/** The patch image as an OpenEXR file written by the independent writer. */
export function buildPatchExr(sampleType: ExrSampleType = 'half'): Buffer {
  const rgb = fillPatches((patch) => [...PATCHES[patch].linear], 3);
  return writeRgbOpenExr(rgb, HDR_IMAGE_WIDTH, HDR_IMAGE_HEIGHT, sampleType);
}

/** Gain map metadata used by the Ultra HDR input: 2 stops of headroom, spec default offsets. */
export const ULTRA_HDR_METADATA: UltraHdrGainMapMetadata = {
  gainMapMin: 0,
  gainMapMax: 2,
  gamma: 1,
  offsetSdr: 1 / 64,
  offsetHdr: 1 / 64,
};

/** One 8-bit gain map value per patch (0 means no boost, 255 the full gainMapMax stops). */
export const ULTRA_HDR_GAIN_BYTES: readonly number[] = [0, 0, 0, 0, 64, 128, 255, 191];

export function ultraHdrSdrPatch(patch: number): number[] {
  return PATCHES[patch].linear.map(srgbEncode8);
}

/**
 * Linear HDR value the gain map formula assigns to a patch channel:
 * (sdr + offsetSDR) * 2^(min + gain^(1/gamma) * (max - min)) - offsetHDR.
 */
export function ultraHdrExpectedLinear(
  patch: number,
  channel: number,
  meta: UltraHdrGainMapMetadata = ULTRA_HDR_METADATA
): number {
  const base = srgbDecode(ultraHdrSdrPatch(patch)[channel] / BYTE_MAX);
  const recovery = (ULTRA_HDR_GAIN_BYTES[patch] / BYTE_MAX) ** (1 / meta.gamma);
  const stops = meta.gainMapMin + recovery * (meta.gainMapMax - meta.gainMapMin);
  return (base + meta.offsetSdr) * 2 ** stops - meta.offsetHdr;
}

/** The patch image as an Ultra HDR JPEG built by the independent builder. */
export async function buildPatchUltraHdr(
  mirrorGainMapMaxInPrimary = false,
  metadata: UltraHdrGainMapMetadata = ULTRA_HDR_METADATA,
  editGainMapXmp?: (xmp: string) => string
): Promise<Buffer> {
  const sdr = Buffer.alloc(HDR_IMAGE_WIDTH * HDR_IMAGE_HEIGHT * 3);
  const gain = Buffer.alloc(HDR_IMAGE_WIDTH * HDR_IMAGE_HEIGHT);
  for (let y = 0; y < HDR_IMAGE_HEIGHT; y++) {
    for (let x = 0; x < HDR_IMAGE_WIDTH; x++) {
      const patch = patchIndexAt(x, y);
      const at = y * HDR_IMAGE_WIDTH + x;
      const colour = ultraHdrSdrPatch(patch);
      sdr[at * 3] = colour[0];
      sdr[at * 3 + 1] = colour[1];
      sdr[at * 3 + 2] = colour[2];
      gain[at] = ULTRA_HDR_GAIN_BYTES[patch];
    }
  }
  const built = await buildUltraHdrJpeg({
    width: HDR_IMAGE_WIDTH,
    height: HDR_IMAGE_HEIGHT,
    sdrRgb: sdr,
    gainMap: gain,
    metadata,
    mirrorGainMapMaxInPrimary,
    editGainMapXmp,
  });
  return built.file;
}
