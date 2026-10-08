import { type Metadata, type Sharp } from 'sharp';
import { ConversionFailedError } from '../types';
import {
  CICP_TRANSFER_BT709,
  CICP_TRANSFER_LINEAR,
  CICP_TRANSFER_SRGB,
  type Cicp,
  ColourTagError,
  primariesOfCicp,
} from './cicp';
import { BT709_PRIMARIES, type Matrix3, IDENTITY_MATRIX, primariesToPrimaries } from './colour-primaries';
import { type ToneCurve, curveTable, iccToLinearBt709, readIccProfile } from './icc-reader';
import { HDR_TONE_MAP_PIXEL_BUDGET, assertPixelBudget } from './image-input-limits';

/**
 * Linear Rec. 709 light from an SDR picture, for the float targets (EXR, Ultra HDR). The picture's own colour
 * description is applied: a matrix/TRC ICC profile or CICP primaries and transfer when present, otherwise sRGB.
 * A well-formed profile of another kind (LUT based) is converted to sRGB by the image library's colour engine.
 */

const RGB_CHANNELS = 3;
const RGB_COLOUR_SPACE = 'RGB ';
const BYTE_LEVELS = 256;
const SIXTEEN_BIT_LEVELS = 65_536;
const SHARP_SIXTEEN_BIT_DEPTH = 'ushort';
const SRGB_TOE = 0.04045;
const SRGB_SLOPE = 12.92;
const SRGB_OFFSET = 0.055;
const SRGB_SCALE = 1.055;
const SRGB_GAMMA = 2.4;
const BT709_TOE = 0.081;
const BT709_SLOPE = 4.5;
const BT709_OFFSET = 0.099;
const BT709_SCALE = 1.099;
const BT709_GAMMA = 1 / 0.45;
/** H.273 transfer characteristics that share the BT.709 curve (BT.601, BT.2020 10 and 12 bit). */
const BT709_FAMILY: ReadonlySet<number> = new Set([CICP_TRANSFER_BT709, 6, 14, 15]);

export type ColourSource = 'srgb' | 'icc' | 'icc-engine' | 'cicp';

export interface LinearRaster {
  /** Interleaved linear Rec. 709 RGB; values outside [0, 1] are kept (wide-gamut colours go negative). */
  readonly rgb: Float32Array;
  readonly width: number;
  readonly height: number;
  readonly source: ColourSource;
}

const srgbToLinear: ToneCurve = (v) => (v <= SRGB_TOE ? v / SRGB_SLOPE : Math.pow((v + SRGB_OFFSET) / SRGB_SCALE, SRGB_GAMMA));
const bt709ToLinear: ToneCurve = (v) => (v < BT709_TOE ? v / BT709_SLOPE : Math.pow((v + BT709_OFFSET) / BT709_SCALE, BT709_GAMMA));
const identityCurve: ToneCurve = (v) => v;

function curveForTransfer(transfer: number): ToneCurve {
  if (transfer === CICP_TRANSFER_SRGB) return srgbToLinear;
  if (transfer === CICP_TRANSFER_LINEAR) return identityCurve;
  if (BT709_FAMILY.has(transfer)) return bt709ToLinear;
  throw new ColourTagError(`Unsupported transfer characteristics ${transfer} in the picture's colour tag`);
}

interface Decoding {
  readonly curves: readonly [ToneCurve, ToneCurve, ToneCurve];
  readonly matrix: Matrix3;
  readonly source: ColourSource;
  /** Pixels must go through the colour engine to sRGB first. */
  readonly viaEngine: boolean;
}

function decodingFor(meta: Metadata, cicp: Cicp | null): Decoding {
  const srgb: Decoding = { curves: [srgbToLinear, srgbToLinear, srgbToLinear], matrix: IDENTITY_MATRIX, source: 'srgb', viaEngine: false };
  // A cICP tag outranks an embedded profile (PNG Third Edition, 11.3.2.5).
  if (cicp !== null) {
    const primaries = primariesOfCicp(cicp.primaries);
    if (primaries === null) throw new ColourTagError(`Unsupported colour primaries ${cicp.primaries} in the picture's colour tag`);
    const curve = curveForTransfer(cicp.transfer);
    return { curves: [curve, curve, curve], matrix: primariesToPrimaries(primaries, BT709_PRIMARIES), source: 'cicp', viaEngine: false };
  }
  if (meta.icc === undefined) return srgb;
  const profile = readIccProfile(meta.icc);
  if (profile.kind === 'matrix-trc') {
    return { curves: profile.curves, matrix: iccToLinearBt709(profile), source: 'icc', viaEngine: false };
  }
  // A lookup-table RGB profile goes through the colour engine; grey and CMYK profiles are applied by the decoder.
  if (profile.colourSpace === RGB_COLOUR_SPACE) return { ...srgb, source: 'icc-engine', viaEngine: true };
  return srgb;
}

/**
 * Decodes the pipeline's picture (already oriented, resized and flattened) to linear Rec. 709 floats. The caller
 * has checked the output size against its float budget; this checks the decoded size against the HDR budget.
 */
export async function decodeLinearBt709(pipeline: Sharp, meta: Metadata, cicp: Cicp | null): Promise<LinearRaster> {
  const decoding = decodingFor(meta, cicp);
  const deep = meta.depth === SHARP_SIXTEEN_BIT_DEPTH;
  let prepared = pipeline;
  if (decoding.viaEngine) prepared = prepared.withIccProfile('srgb', { attach: false });
  // The image library converts a tagged picture to sRGB on the way out unless told to keep the profile; the
  // conversion here works from the unconverted samples, which also keeps colours outside the sRGB gamut.
  else if (decoding.source === 'icc' || decoding.source === 'cicp') prepared = prepared.keepIccProfile();
  if (deep) prepared = prepared.toColourspace('rgb16');
  const { data, info } = await prepared.raw({ depth: deep ? SHARP_SIXTEEN_BIT_DEPTH : 'uchar' }).toBuffer({ resolveWithObject: true });
  assertPixelBudget(info.width, info.height, HDR_TONE_MAP_PIXEL_BUDGET);
  if (info.channels !== RGB_CHANNELS) {
    throw new ConversionFailedError(`Expected 3 colour channels per pixel but the decoded image has ${info.channels}`);
  }
  const levels = deep ? SIXTEEN_BIT_LEVELS : BYTE_LEVELS;
  const tables = decoding.curves.map((curve) => curveTable(curve, levels));
  const [m0, m1, m2, m3, m4, m5, m6, m7, m8] = decoding.matrix;
  const samples = info.width * info.height * RGB_CHANNELS;
  const rgb = new Float32Array(samples);
  const wide = deep ? new Uint16Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.length)) : null;
  const read = (i: number): number => (wide ? wide[i] : data[i]);
  for (let i = 0; i < samples; i += RGB_CHANNELS) {
    const r = tables[0][read(i)];
    const g = tables[1][read(i + 1)];
    const b = tables[2][read(i + 2)];
    rgb[i] = m0 * r + m1 * g + m2 * b;
    rgb[i + 1] = m3 * r + m4 * g + m5 * b;
    rgb[i + 2] = m6 * r + m7 * g + m8 * b;
  }
  return { rgb, width: info.width, height: info.height, source: decoding.source };
}
