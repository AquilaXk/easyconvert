import sharp, { type Metadata, type Sharp } from 'sharp';
import { srgb16LutsFromProfile } from './icc-srgb';
import { EIGHT_BIT_ONLY_TARGETS, SHARP_SIXTEEN_BIT_DEPTH } from './image-depth';

const RGB_CHANNEL_COUNT = 3;
const EIGHT_BIT_MAX = 255;
const SIXTEEN_BIT_MAX = 65535;

type LevelTables = readonly [Uint8Array, Uint8Array, Uint8Array];

/** The 8-bit level nearest to each 16-bit value of a lookup table: the level `roundedToEightBits` (image-depth.ts) gives the value. */
function nearestLevels(lut: Uint16Array): Uint8Array {
  const levels = new Uint8Array(lut.length);
  for (let value = 0; value < lut.length; value += 1) levels[value] = Math.floor((lut[value] * EIGHT_BIT_MAX) / SIXTEEN_BIT_MAX + 0.5);
  return levels;
}

/** The tables of the last development curve: a camera RAW decoder writes the same profile for every picture, and building them costs 5 ms of a 12 ms conversion of a small one. */
let lastCurve: { icc: Buffer; levels: LevelTables } | undefined;

function levelTablesOf(icc: Buffer): LevelTables | null {
  if (lastCurve?.icc.equals(icc)) return lastCurve.levels;
  const luts = srgb16LutsFromProfile(icc);
  if (luts === null) return null;
  const levels: LevelTables = [nearestLevels(luts[0]), nearestLevels(luts[1]), nearestLevels(luts[2])];
  lastCurve = { icc: Buffer.from(icc), levels };
  return levels;
}

/** What the picture keeps of its source besides the pixels, and what the target tags. */
export interface DevelopmentCurveOutput {
  /** Density (pixels per inch) every viewer assumes: a picture with this one gets no density of its own. */
  defaultDensity: number;
  /** The target carries an explicit sRGB profile tag. */
  tagsSrgb: boolean;
}

/**
 * Applies an embedded matrix/TRC profile with sRGB primaries and a non-sRGB tone curve (such as `dcraw_emu -o 1`'s gamma
 * 2.222 development curve) directly to 16-bit RGB/RGBA samples in place. Calling `.withIccProfile('srgb').toColourspace('rgb16')`
 * on a 16-bit image in sharp runs two `vips_icc_transform` passes (first to Display P3 for `rgb16`, leaving the source
 * profile attached, then from the source profile to sRGB a second time), which lifts shadow zeros and shifts colours.
 *
 * A JPEG or WebP takes the same exact lookup and gets the nearest 8-bit level of it (policy decision 176): the native transform to 8-bit
 * sRGB lands one level off the exact value on a third of the samples of a developed camera picture, 0.3 of a level below it in the shadows.
 * That path is for pictures of three bands (the camera decoder writes no alpha plane); the others keep the native transform.
 *
 * Returns null when the picture is left as it is.
 */
export async function applyDevelopmentCurve(pipeline: Sharp, meta: Metadata, target: string, output: DevelopmentCurveOutput): Promise<Sharp | null> {
  if (meta.depth !== SHARP_SIXTEEN_BIT_DEPTH || meta.icc === undefined || (meta.channels ?? 0) < RGB_CHANNEL_COUNT) return null;
  const eightBit = EIGHT_BIT_ONLY_TARGETS.has(target);
  if (eightBit && meta.channels !== RGB_CHANNEL_COUNT) return null;
  const levelTables = eightBit ? levelTablesOf(meta.icc) : null;
  const luts = eightBit ? null : srgb16LutsFromProfile(meta.icc);
  if (levelTables === null && luts === null) return null;
  const { data, info } = await pipeline.clone().keepIccProfile().toColourspace('rgb16').raw({ depth: 'ushort' }).toBuffer({ resolveWithObject: true });
  const samples = new Uint16Array(data.buffer, data.byteOffset, data.byteLength >> 1);
  const channels = info.channels;
  let out: Sharp;
  if (levelTables !== null) {
    const [levelR, levelG, levelB] = levelTables;
    const levels = new Uint8Array(samples.length);
    for (let i = 0; i < samples.length; i += RGB_CHANNEL_COUNT) {
      levels[i] = levelR[samples[i]];
      levels[i + 1] = levelG[samples[i + 1]];
      levels[i + 2] = levelB[samples[i + 2]];
    }
    out = sharp(levels, { raw: { width: info.width, height: info.height, channels } });
  } else {
    const [lutR, lutG, lutB] = luts as NonNullable<typeof luts>;
    for (let i = 0; i < samples.length; i += channels) {
      samples[i] = lutR[samples[i]];
      samples[i + 1] = lutG[samples[i + 1]];
      samples[i + 2] = lutB[samples[i + 2]];
    }
    out = sharp(samples, { raw: { width: info.width, height: info.height, channels } }).toColourspace('rgb16');
  }
  if (meta.xmp !== undefined) out = out.withXmp(meta.xmp.toString('utf8'));
  if (meta.density !== undefined && meta.density !== output.defaultDensity) out = out.withDensity(meta.density);
  if (output.tagsSrgb) out = out.withIccProfile('srgb', { attach: true });
  return out;
}
