import { crc32 } from 'node:zlib';
import { type Matrix3 } from './colour-primaries';
import { type IccMatrixTrcProfile, readIccProfile } from './icc-reader';

/**
 * Whether an ICC profile describes sRGB: the same primaries (as colorants relative to the D50 connection space) and the same tone
 * curve, to within about one 8-bit level. Such a profile says nothing a viewer does not assume for a picture without one, so
 * carrying it only costs bytes (3 kB for the usual profile of cameras and editors, a fifth of a small file). It is judged by what
 * the profile does, not by its name or its size, so every profile of the family counts: the long-standing 3 kB one, the compact
 * ones of image editors and the parametric ones of ICC version 4.
 */

/** sRGB colorants adapted to D50 (IEC 61966-2-1 with the Bradford adaptation, as ICC.1 Annex D lists them), row-major. */
const SRGB_RGB_TO_XYZ_D50: Matrix3 = [0.4360747, 0.3850649, 0.1430804, 0.2225045, 0.7168786, 0.0606169, 0.0139322, 0.0971045, 0.7141733];
const COLORANT_TOLERANCE = 0.003;
const CURVE_TOLERANCE = 0.003;
const CURVE_PROBES = 64;
const SRGB_TOE = 0.04045;
const SRGB_TOE_SLOPE = 12.92;
const SRGB_OFFSET = 0.055;
const SRGB_GAMMA = 2.4;

const SRGB_LINEAR_TOE = SRGB_TOE / SRGB_TOE_SLOPE;
const SIXTEEN_BIT_MAX = 65535;

/** The sRGB tone curve (IEC 61966-2-1) from encoded to linear. */
function srgbToLinear(encoded: number): number {
  return encoded <= SRGB_TOE ? encoded / SRGB_TOE_SLOPE : ((encoded + SRGB_OFFSET) / (1 + SRGB_OFFSET)) ** SRGB_GAMMA;
}

/** The inverse sRGB tone curve (IEC 61966-2-1) from linear light to encoded sample in [0, 1]. */
function linearToSrgb(linear: number): number {
  if (linear <= 0) return 0;
  if (linear >= 1) return 1;
  return linear <= SRGB_LINEAR_TOE ? linear * SRGB_TOE_SLOPE : (1 + SRGB_OFFSET) * linear ** (1 / SRGB_GAMMA) - SRGB_OFFSET;
}

function hasSrgbColorants(profile: IccMatrixTrcProfile): boolean {
  return profile.rgbToXyzD50.every((value, index) => Math.abs(value - SRGB_RGB_TO_XYZ_D50[index]) <= COLORANT_TOLERANCE);
}

function describesSrgb(profile: IccMatrixTrcProfile): boolean {
  if (!hasSrgbColorants(profile)) return false;
  for (let probe = 0; probe <= CURVE_PROBES; probe += 1) {
    const encoded = probe / CURVE_PROBES;
    if (profile.curves.some((curve) => Math.abs(curve(encoded) - srgbToLinear(encoded)) > CURVE_TOLERANCE)) return false;
  }
  return true;
}

/**
 * True when `icc` is a matrix/TRC profile with sRGB colorants (whether its tone curve is IEC 61966-2-1 sRGB or a development
 * curve such as gamma 2.222 over sRGB primaries); false for wider-gamut or other profiles, and for bytes that are not a profile.
 */
export function hasSrgbPrimaries(icc: Buffer): boolean {
  try {
    const profile = readIccProfile(icc);
    return profile.kind === 'matrix-trc' && hasSrgbColorants(profile);
  } catch {
    return false;
  }
}

/** True when `icc` is a matrix/TRC profile of sRGB; false for any other profile, and for bytes that are not a profile. */
export function isSrgbProfile(icc: Buffer): boolean {
  try {
    const profile = readIccProfile(icc);
    return profile.kind === 'matrix-trc' && describesSrgb(profile);
  } catch {
    return false;
  }
}

/**
 * Returns per-channel 16-bit lookup tables mapping a matrix/TRC profile with sRGB colorants (whose tone curve differs from
 * IEC 61966-2-1 sRGB, such as a camera RAW decoder's gamma 2.222 curve) to 16-bit IEC 61966-2-1 sRGB samples, or null when
 * the profile is not a non-sRGB tone curve over sRGB primaries.
 */
export function srgb16LutsFromProfile(icc: Buffer): readonly [Uint16Array, Uint16Array, Uint16Array] | null {
  try {
    const profile = readIccProfile(icc);
    if (profile.kind !== 'matrix-trc' || !hasSrgbColorants(profile) || describesSrgb(profile)) return null;
    const buildChannelLut = (curve: (encoded: number) => number): Uint16Array => {
      const lut = new Uint16Array(SIXTEEN_BIT_MAX + 1);
      for (let sample = 0; sample <= SIXTEEN_BIT_MAX; sample += 1) {
        lut[sample] = Math.round(linearToSrgb(curve(sample / SIXTEEN_BIT_MAX)) * SIXTEEN_BIT_MAX);
      }
      return lut;
    };
    return [
      buildChannelLut(profile.curves[0]),
      buildChannelLut(profile.curves[1]),
      buildChannelLut(profile.curves[2]),
    ];
  } catch {
    return null;
  }
}


/**
 * The sRGB profiles the reference engine's PNG reader recognises by length and CRC-32 and does not attach to the picture it reads
 * (it keeps the rendering intent only), so its writers produce no profile for a PNG that holds one of them (ImageMagick 6.9.12-98,
 * `coders/png.c`, the table `sRGB_info` at lines 140 to 171 and the check at lines 2725 to 2783; libpng 1.6.43 `png.c` lines 2236 to
 * 2290 lists the same profiles and reports the two HP ones as incorrect). Every other profile of a PNG, an sRGB one included
 * (`sRGB2014`, the compact profiles of editors), is attached, and so is every profile of a source that is not a PNG.
 */
const PNG_READER_SRGB_PROFILES: ReadonlyArray<{ length: number; crc: number }> = [
  { length: 3048, crc: 0x3b8772b9 }, // sRGB_IEC61966-2-1_black_scaled, ICC v2 perceptual
  { length: 3052, crc: 0x427ebb21 }, // sRGB_IEC61966-2-1_no_black_scaling, ICC v2 relative
  { length: 60988, crc: 0x306fd8ae }, // sRGB_v4_ICC_preference_displayclass
  { length: 60960, crc: 0xbbef7812 }, // sRGB_v4_ICC_preference
  { length: 3024, crc: 0x5d5129ce }, // sRGB_IEC61966-2-1_noBPC
  { length: 3144, crc: 0x182ea552 }, // HP-Microsoft sRGB v2 perceptual
  { length: 3144, crc: 0xf29e526d }, // HP-Microsoft sRGB v2 media-relative
  { length: 524, crc: 0xd4938c39 }, // TINYsRGB
  { length: 3212, crc: 0x034af5a1 }, // Argyll_sRGB
];

/** True when `icc` is one of the profiles the reference engine's PNG reader drops (see `PNG_READER_SRGB_PROFILES`). */
export function isProfileDroppedByPngReader(icc: Buffer): boolean {
  const checksum = PNG_READER_SRGB_PROFILES.some((known) => known.length === icc.length) ? crc32(icc) : null;
  return checksum !== null && PNG_READER_SRGB_PROFILES.some((known) => known.length === icc.length && known.crc === checksum);
}
