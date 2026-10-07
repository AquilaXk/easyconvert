/**
 * Codec level selection for the encoder requests of the edge worker: the lowest levels whose limits admit the
 * picture size and frame rate, written from the level tables of the codec specifications.
 *
 * - H.264: ITU-T H.264 Table A-1 (MaxMBPS, MaxFS), and the picture-size limit of A.3.1 item (i)/(j):
 *   width and height in macroblocks are at most Sqrt(MaxFS * 8).
 * - HEVC: ITU-T H.265 Table A.8 (MaxLumaPs, MaxLumaSr) and A.4.1: width and height at most Sqrt(MaxLumaPs * 8).
 * - VP9: VP9 bitstream specification Annex A (maximum luma sample rate and picture size); width and height at
 *   most Sqrt(MaxLumaPictureSize * 8).
 *
 * The bit rate limits of the tables are not applied: they bound the stream a decoder must accept, and the
 * encoder, not this module, decides the rate it writes.
 */

import { EdgeUnsupportedError } from '../workers/worker-errors';
import type { ChromaFormat, VideoColour } from './media-types';

export type LevelFamily = 'h264' | 'hevc' | 'vp9';

export interface LevelDemand {
  width: number;
  height: number;
  framerate: number;
}

interface LevelRow {
  /** The number the codec string carries: level_idc (H.264), 30 x level (HEVC), 10 x level (VP9). */
  code: number;
  /** Largest picture: macroblocks (H.264) or luma samples (HEVC, VP9). */
  maxPicture: number;
  /** Largest rate: macroblocks per second (H.264) or luma samples per second (HEVC, VP9). */
  maxRate: number;
}

/** H.264 Table A-1, levels 1 to 6.2 (level 1b has no level_idc of its own and is not requested). */
const H264_LEVELS: readonly LevelRow[] = [
  { code: 10, maxPicture: 99, maxRate: 1_485 },
  { code: 11, maxPicture: 396, maxRate: 3_000 },
  { code: 12, maxPicture: 396, maxRate: 6_000 },
  { code: 13, maxPicture: 396, maxRate: 11_880 },
  { code: 20, maxPicture: 396, maxRate: 11_880 },
  { code: 21, maxPicture: 792, maxRate: 19_800 },
  { code: 22, maxPicture: 1_620, maxRate: 20_250 },
  { code: 30, maxPicture: 1_620, maxRate: 40_500 },
  { code: 31, maxPicture: 3_600, maxRate: 108_000 },
  { code: 32, maxPicture: 5_120, maxRate: 216_000 },
  { code: 40, maxPicture: 8_192, maxRate: 245_760 },
  { code: 41, maxPicture: 8_192, maxRate: 245_760 },
  { code: 42, maxPicture: 8_704, maxRate: 522_240 },
  { code: 50, maxPicture: 22_080, maxRate: 589_824 },
  { code: 51, maxPicture: 36_864, maxRate: 983_040 },
  { code: 52, maxPicture: 36_864, maxRate: 2_073_600 },
  { code: 60, maxPicture: 139_264, maxRate: 4_177_920 },
  { code: 61, maxPicture: 139_264, maxRate: 8_355_840 },
  { code: 62, maxPicture: 139_264, maxRate: 16_711_680 },
];

/** H.265 Table A.8, levels 1 to 6.2; general_level_idc is 30 times the level. */
const HEVC_LEVELS: readonly LevelRow[] = [
  { code: 30, maxPicture: 36_864, maxRate: 552_960 },
  { code: 60, maxPicture: 122_880, maxRate: 3_686_400 },
  { code: 63, maxPicture: 245_760, maxRate: 7_372_800 },
  { code: 90, maxPicture: 552_960, maxRate: 16_588_800 },
  { code: 93, maxPicture: 983_040, maxRate: 33_177_600 },
  { code: 120, maxPicture: 2_228_224, maxRate: 66_846_720 },
  { code: 123, maxPicture: 2_228_224, maxRate: 133_693_440 },
  { code: 150, maxPicture: 8_912_896, maxRate: 267_386_880 },
  { code: 153, maxPicture: 8_912_896, maxRate: 534_773_760 },
  { code: 156, maxPicture: 8_912_896, maxRate: 1_069_547_520 },
  { code: 180, maxPicture: 35_651_584, maxRate: 1_069_547_520 },
  { code: 183, maxPicture: 35_651_584, maxRate: 2_139_095_040 },
  { code: 186, maxPicture: 35_651_584, maxRate: 4_278_190_080 },
];

/** VP9 Annex A, levels 1 to 6.2; the level in a codec string is ten times the level. */
const VP9_LEVELS: readonly LevelRow[] = [
  { code: 10, maxPicture: 36_864, maxRate: 829_440 },
  { code: 11, maxPicture: 73_728, maxRate: 2_764_800 },
  { code: 20, maxPicture: 122_880, maxRate: 4_608_000 },
  { code: 21, maxPicture: 245_760, maxRate: 9_216_000 },
  { code: 30, maxPicture: 552_960, maxRate: 20_736_000 },
  { code: 31, maxPicture: 983_040, maxRate: 36_864_000 },
  { code: 40, maxPicture: 2_228_224, maxRate: 83_558_400 },
  { code: 41, maxPicture: 2_228_224, maxRate: 160_432_128 },
  { code: 50, maxPicture: 8_912_896, maxRate: 311_951_360 },
  { code: 51, maxPicture: 8_912_896, maxRate: 588_251_136 },
  { code: 52, maxPicture: 8_912_896, maxRate: 1_176_502_272 },
  { code: 60, maxPicture: 35_651_584, maxRate: 1_176_502_272 },
  { code: 61, maxPicture: 35_651_584, maxRate: 2_353_004_544 },
  { code: 62, maxPicture: 35_651_584, maxRate: 4_706_009_088 },
];

const LEVELS_BY_FAMILY: Readonly<Record<LevelFamily, readonly LevelRow[]>> = {
  h264: H264_LEVELS,
  hevc: HEVC_LEVELS,
  vp9: VP9_LEVELS,
};

const FAMILY_LABEL: Readonly<Record<LevelFamily, string>> = { h264: 'H.264', hevc: 'HEVC', vp9: 'VP9' };

export function levelFamilyLabel(family: LevelFamily): string {
  return FAMILY_LABEL[family];
}

/** A width or height may be at most this many times the square root of the picture limit (the "* 8" of the specs). */
const DIMENSION_SQUARE_FACTOR = 8;
const H264_MACROBLOCK_SIZE = 16;
/** Constraint and profile bytes of the H.264 codec string: Main profile, no constraint flags. */
const H264_MAIN_PROFILE_AND_CONSTRAINTS = '4d00';
const HEX_RADIX = 16;
const BYTE_HEX_DIGITS = 2;

function unitsOf(family: LevelFamily, size: number): number {
  return family === 'h264' ? Math.ceil(size / H264_MACROBLOCK_SIZE) : size;
}

function admits(family: LevelFamily, row: LevelRow, demand: LevelDemand): boolean {
  const width = unitsOf(family, demand.width);
  const height = unitsOf(family, demand.height);
  const dimensionLimit = Math.sqrt(row.maxPicture * DIMENSION_SQUARE_FACTOR);
  return (
    width * height <= row.maxPicture &&
    width * height * demand.framerate <= row.maxRate &&
    width <= dimensionLimit &&
    height <= dimensionLimit
  );
}

function assertDemand(demand: LevelDemand): void {
  const { width, height, framerate } = demand;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new EdgeUnsupportedError('The video frame size is not a positive whole number, so no codec level can be chosen for it.');
  }
  if (!Number.isFinite(framerate) || framerate <= 0) {
    throw new EdgeUnsupportedError('The video frame rate is not a positive number, so no codec level can be chosen for it.');
  }
}

/**
 * The level codes of `family` whose limits admit the picture size and frame rate, lowest first. A picture
 * that no level admits throws, so no request is made for a level the stream would break.
 */
export function admittingLevels(family: LevelFamily, demand: LevelDemand): number[] {
  assertDemand(demand);
  const codes = LEVELS_BY_FAMILY[family].filter((row) => admits(family, row, demand)).map((row) => row.code);
  if (codes.length === 0) {
    throw new EdgeUnsupportedError(
      `No ${FAMILY_LABEL[family]} level admits ${demand.width}x${demand.height} at ${demand.framerate} frames per second; the server engine converts it.`
    );
  }
  return codes;
}

/**
 * Whether the VP9 level `code` admits a picture of this size (the frame rate is the encoder's, not the muxer's).
 * A code that is not a VP9 level is not admitting anything.
 */
export function vp9LevelAdmitsPicture(code: number, width: number, height: number): boolean {
  const row = VP9_LEVELS.find((candidate) => candidate.code === code);
  if (!row) return false;
  const dimensionLimit = Math.sqrt(row.maxPicture * DIMENSION_SQUARE_FACTOR);
  return width * height <= row.maxPicture && width <= dimensionLimit && height <= dimensionLimit;
}

/** What the source file says about its pictures; the VP9 profile and colour fields follow from it. */
export interface VideoSourceFacts {
  bitDepth?: number;
  chroma?: ChromaFormat;
  colour?: VideoColour;
}

const VP9_BIT_DEPTHS: ReadonlySet<number> = new Set([8, 10, 12]);
/** vpcC chromaSubsampling 1: 4:2:0 with the chroma samples co-located with luma (the sample position of most files). */
const VP9_CHROMA_420_COLOCATED = 1;
const VP9_CHROMA_422 = 2;
const VP9_CHROMA_444 = 3;
const VP9_COLOUR_UNSPECIFIED = 2;
const VP9_BIT_DEPTH_8 = 8;
const VP9_PROFILE_8_BIT_420 = 0;
const VP9_PROFILE_8_BIT_OTHER = 1;
const VP9_PROFILE_HIGH_420 = 2;
const VP9_PROFILE_HIGH_OTHER = 3;

function two(value: number): string {
  return String(value).padStart(BYTE_HEX_DIGITS, '0');
}

/**
 * `vp09.PP.LL.DD.CC.cp.tc.mc.FF` for a stream of the source's kind at `level`. The profile follows from bit depth
 * and chroma (VP9 bitstream specification, profile table); a source that does not state them, or has a chroma
 * layout vpcC cannot name (monochrome, 4:4:0), throws instead of being assumed 8-bit 4:2:0.
 */
export function vp9CodecString(level: number, facts: VideoSourceFacts): string {
  const { bitDepth, chroma } = facts;
  if (bitDepth === undefined || chroma === undefined) {
    throw new EdgeUnsupportedError(
      'The source does not state the bit depth and chroma layout of its pictures, which a VP9 profile needs; the server engine converts it.'
    );
  }
  if (!VP9_BIT_DEPTHS.has(bitDepth)) {
    throw new EdgeUnsupportedError(`VP9 has no ${bitDepth}-bit profile; the server engine converts this file.`);
  }
  let chromaCode: number;
  if (chroma === 'yuv420') chromaCode = VP9_CHROMA_420_COLOCATED;
  else if (chroma === 'yuv422') chromaCode = VP9_CHROMA_422;
  else if (chroma === 'yuv444') chromaCode = VP9_CHROMA_444;
  else throw new EdgeUnsupportedError(`VP9 output cannot state ${chroma} pictures; the server engine converts this file.`);

  const eightBit = bitDepth === VP9_BIT_DEPTH_8;
  let profile: number;
  if (chroma === 'yuv420') profile = eightBit ? VP9_PROFILE_8_BIT_420 : VP9_PROFILE_HIGH_420;
  else profile = eightBit ? VP9_PROFILE_8_BIT_OTHER : VP9_PROFILE_HIGH_OTHER;

  const colour = facts.colour ?? {
    primaries: VP9_COLOUR_UNSPECIFIED,
    transfer: VP9_COLOUR_UNSPECIFIED,
    matrix: VP9_COLOUR_UNSPECIFIED,
    fullRange: false,
  };
  return [
    'vp09', two(profile), two(level), two(bitDepth), two(chromaCode),
    two(colour.primaries), two(colour.transfer), two(colour.matrix), colour.fullRange ? '01' : '00',
  ].join('.');
}

/**
 * Encoder codec strings to try for a derived request, lowest level first. H.264 asks for Main profile and HEVC
 * for Main profile, main tier; VP9 takes its profile from the source.
 */
export function levelCodecStrings(family: LevelFamily, demand: LevelDemand, facts: VideoSourceFacts): string[] {
  const codes = admittingLevels(family, demand);
  if (family === 'h264') return codes.map((code) => `avc1.${H264_MAIN_PROFILE_AND_CONSTRAINTS}${code.toString(HEX_RADIX).padStart(BYTE_HEX_DIGITS, '0')}`);
  if (family === 'hevc') return codes.map((code) => `hvc1.1.6.L${code}.B0`);
  return codes.map((code) => vp9CodecString(code, facts));
}
