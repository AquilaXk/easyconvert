import { type Metadata, type Sharp } from 'sharp';
import sharp from 'sharp';
import { type ConversionOptions, UnsupportedOptionError } from '../types';
import {
  CICP_PRIMARIES_BT2020,
  CICP_TRANSFER_HLG,
  CICP_TRANSFER_PQ,
  type Cicp,
  ColourTagError,
  primariesOfCicp,
} from './cicp';
import { BT2020_PRIMARIES, BT709_PRIMARIES, type Chromaticities, type Matrix3, primariesToPrimaries } from './colour-primaries';
import {
  DEFAULT_TONE_MAP,
  HLG_REFERENCE_PEAK_NITS,
  PQ_PEAK_NITS,
  SDR_PEAK_NITS,
  TONE_MAP_MODES,
  type ToneMapMode,
  encodeSrgb,
  hlgPixelToNits,
  nitsToPqSignal,
  pqSignalToNits,
  toneMapToSdr,
} from './hdr-tonemap';
import { HDR_TONE_MAP_PIXEL_BUDGET, assertPixelBudget } from './image-input-limits';
import type { DecodedOpenExr } from './openexr-decode';

/**
 * HDR sources of still images: OpenEXR radiance and PQ or HLG tagged PNG and AVIF. They are rendered for SDR
 * targets with the chosen tone mapping (see hdr-tonemap.ts), or kept as HDR for the targets that can carry it.
 */

const RGB_CHANNELS = 3;
const RGBA_CHANNELS = 4;
const BYTE_MAX = 255;
const BYTE_BITS = 8;
const U16_MAX = 65_535;
const U16_STATES = 65_536;
const SIXTEEN_BITS = 16;
const SHARP_SIXTEEN_BIT_DEPTH = 'ushort';
/** Code values per channel of the AVIF written for HDR output. */
const HDR_AVIF_BITS = 10;
/** EXR `whiteLuminance` is stated in nits for RGB (1, 1, 1); without it 1.0 is SDR reference white. */
export const DEFAULT_EXR_WHITE_NITS = SDR_PEAK_NITS;
const EXR_CHROMATICITIES_FLOATS = 8;
const FLOAT_BYTES = 4;

/** The tone mapping a request asks for: its `toneMap` option, or bt2390 when it names none. */
export function resolveToneMap(options: Pick<ConversionOptions, 'toneMap'>): ToneMapMode {
  const requested = options.toneMap ?? DEFAULT_TONE_MAP;
  if (!(TONE_MAP_MODES as readonly string[]).includes(requested)) {
    throw new UnsupportedOptionError(`toneMap "${String(requested)}" is not supported; use one of ${TONE_MAP_MODES.join(', ')}`);
  }
  return requested;
}

/** Targets that store PQ in BT.2020 and carry the tag for it: AVIF (sequence header) and PNG (cICP). */
export const PQ_OUTPUT_TARGETS: ReadonlySet<string> = new Set(['avif', 'png']);
/** Targets that can hold HDR values whatever the tone mapping: float EXR and Ultra HDR carry radiance. */
const RADIANCE_TARGETS: ReadonlySet<string> = new Set(['exr', 'ultrahdr']);

/** True when `toneMap: "none"` is meaningful for the target: it keeps HDR instead of rendering it for SDR. */
export function holdsHdr(target: string, options: Pick<ConversionOptions, 'gainMap'>): boolean {
  return PQ_OUTPUT_TARGETS.has(target) || RADIANCE_TARGETS.has(target) || ((target === 'jpg' || target === 'jpeg') && options.gainMap === true);
}

export const NO_TONE_MAP_MESSAGE =
  'toneMap "none" keeps HDR, which this target cannot hold; use "bt2390" or "clip", or a target that holds HDR (AVIF, PNG, EXR, Ultra HDR)';

/** What a rendering did, reported to the caller in the conversion result. */
export interface ToneMapReport {
  readonly mode: 'clip' | 'bt2390';
  /** Peak luminance the curve was built for, in cd/m2. */
  readonly sourcePeakNits: number;
  /** `content` is the brightest sample of the image; `hlg-reference` is the 1000 cd/m2 BT.2100 reference display. */
  readonly sourcePeakOrigin: 'content' | 'hlg-reference';
  readonly targetPeakNits: number;
  /** False when the image fits the SDR range and was only clipped. */
  readonly compressed: boolean;
}

export interface SdrRendition {
  /** Interleaved sRGB-encoded 8-bit RGB. */
  readonly rgb: Buffer;
  /** Interleaved sRGB-encoded 16-bit RGB. */
  readonly rgb16: Uint16Array;
  readonly report: ToneMapReport;
}

function measurePeakNits(nits: Float32Array): number {
  let peak = 0;
  for (let i = 0; i < nits.length; i += 1) {
    const v = nits[i];
    if (v > peak && Number.isFinite(v)) peak = v;
  }
  return peak;
}

/** Renders linear RGB (cd/m2, the given primaries) as sRGB for an SDR display. */
export function renderNitsAsSdr(
  nits: Float32Array,
  primaries: Chromaticities,
  mode: 'clip' | 'bt2390',
  nominalPeakNits?: number,
): SdrRendition {
  const measured = nominalPeakNits ?? measurePeakNits(nits);
  const sourcePeakNits = mode === 'clip' ? SDR_PEAK_NITS : Math.min(PQ_PEAK_NITS, Math.max(SDR_PEAK_NITS, measured));
  const linear = toneMapToSdr(nits, {
    sourcePeakNits,
    targetPeakNits: SDR_PEAK_NITS,
    toBt709: primariesToPrimaries(primaries, BT709_PRIMARIES),
  });
  const rgb = Buffer.allocUnsafe(linear.length);
  const rgb16 = new Uint16Array(linear.length);
  for (let i = 0; i < linear.length; i += 1) {
    const encoded = encodeSrgb(linear[i]);
    rgb[i] = Math.round(encoded * BYTE_MAX);
    rgb16[i] = Math.round(encoded * U16_MAX);
  }
  return {
    rgb,
    rgb16,
    report: {
      mode,
      sourcePeakNits,
      sourcePeakOrigin: nominalPeakNits === undefined ? 'content' : 'hlg-reference',
      targetPeakNits: SDR_PEAK_NITS,
      compressed: sourcePeakNits > SDR_PEAK_NITS,
    },
  };
}

function floatAttribute(attrs: DecodedOpenExr['attrs'], name: string): number | undefined {
  const attribute = attrs[name];
  if (!attribute || attribute.val.length < FLOAT_BYTES) return undefined;
  return attribute.val.readFloatLE(0);
}

/** Luminance in nits of RGB (1, 1, 1) from the `whiteLuminance` attribute, or the SDR reference white. */
export function exrWhiteNits(attrs: DecodedOpenExr['attrs']): number {
  const stated = floatAttribute(attrs, 'whiteLuminance');
  if (stated === undefined) return DEFAULT_EXR_WHITE_NITS;
  if (!Number.isFinite(stated) || stated <= 0 || stated > PQ_PEAK_NITS) {
    throw new ColourTagError(`Invalid OpenEXR: whiteLuminance ${stated} is outside (0, ${PQ_PEAK_NITS}] cd/m2`);
  }
  return stated;
}

/** Primaries from the `chromaticities` attribute; Rec. 709 when it is absent (OpenEXR specification default). */
export function exrPrimaries(attrs: DecodedOpenExr['attrs']): Chromaticities {
  const attribute = attrs.chromaticities;
  if (!attribute) return BT709_PRIMARIES;
  if (attribute.val.length < EXR_CHROMATICITIES_FLOATS * FLOAT_BYTES) {
    throw new ColourTagError('Invalid OpenEXR: the chromaticities attribute is truncated');
  }
  const f = Array.from({ length: EXR_CHROMATICITIES_FLOATS }, (_, i) => attribute.val.readFloatLE(i * FLOAT_BYTES));
  const points = [
    { x: f[0], y: f[1] },
    { x: f[2], y: f[3] },
    { x: f[4], y: f[5] },
    { x: f[6], y: f[7] },
  ];
  for (const p of points) {
    if (!(p.x > 0 && p.y > 0 && p.x + p.y < 1)) throw new ColourTagError('Invalid OpenEXR: the chromaticities attribute is out of range');
  }
  return { red: points[0], green: points[1], blue: points[2], white: points[3] };
}

/** Scene-linear EXR samples as cd/m2. Clipping keeps the value 1.0 = white convention whatever the attribute says. */
export function exrNits(decoded: DecodedOpenExr, mode: 'clip' | 'bt2390'): Float32Array {
  const white = mode === 'clip' ? DEFAULT_EXR_WHITE_NITS : exrWhiteNits(decoded.attrs);
  const nits = new Float32Array(decoded.rgb.length);
  for (let i = 0; i < nits.length; i += 1) nits[i] = decoded.rgb[i] * white;
  return nits;
}

/** HDR PQ in BT.2020 for an HDR AVIF: `bits` code values per channel placed in the top bits of 16. */
export function encodePq2020(nits: Float32Array, primaries: Chromaticities, bits: number = HDR_AVIF_BITS): Uint16Array {
  const matrix: Matrix3 = primariesToPrimaries(primaries, BT2020_PRIMARIES);
  const maxCode = 2 ** bits - 1;
  const shift = SIXTEEN_BITS - bits;
  const out = new Uint16Array(nits.length);
  const [m0, m1, m2, m3, m4, m5, m6, m7, m8] = matrix;
  for (let i = 0; i < nits.length; i += RGB_CHANNELS) {
    const r = nits[i];
    const g = nits[i + 1];
    const b = nits[i + 2];
    out[i] = Math.round(nitsToPqSignal(m0 * r + m1 * g + m2 * b) * maxCode) * 2 ** shift;
    out[i + 1] = Math.round(nitsToPqSignal(m3 * r + m4 * g + m5 * b) * maxCode) * 2 ** shift;
    out[i + 2] = Math.round(nitsToPqSignal(m6 * r + m7 * g + m8 * b) * maxCode) * 2 ** shift;
  }
  return out;
}

/** Whether the tagged still is HDR and which transfer function it uses. */
export function hdrTransferOf(cicp: Cicp | null): typeof CICP_TRANSFER_PQ | typeof CICP_TRANSFER_HLG | null {
  if (cicp?.transfer === CICP_TRANSFER_PQ) return CICP_TRANSFER_PQ;
  if (cicp?.transfer === CICP_TRANSFER_HLG) return CICP_TRANSFER_HLG;
  return null;
}

export type HdrStillTarget = 'sdr' | 'hdr-pq' | 'radiance';

export interface HdrStill {
  /** The picture to encode, already upright. Radiance targets leave it as the SDR rendition and use `radiance`. */
  readonly pipeline: Sharp;
  readonly report?: ToneMapReport;
  /** For `hdr-avif`: the AVIF must be tagged BT.2020 / PQ after encoding. */
  readonly tagsPq: boolean;
  /** For `radiance`: linear Rec. 709 floats with 1.0 = 100 cd/m2 (the EXR convention), interleaved RGB. */
  readonly radiance?: Float32Array;
  readonly width: number;
  readonly height: number;
}

/** Largest shifted code of a decoded sample: libvips places 10 and 12 bit samples in the top bits of 16. */
function maxCodeOf(meta: Metadata): number {
  const bits = meta.bitsPerSample;
  if (meta.depth === SHARP_SIXTEEN_BIT_DEPTH && bits !== undefined && bits > BYTE_BITS && bits < SIXTEEN_BITS) {
    return (2 ** bits - 1) * 2 ** (SIXTEEN_BITS - bits);
  }
  return U16_MAX;
}

function copyU16(data: Buffer): Uint16Array {
  return new Uint16Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.length));
}

/**
 * Decodes a PQ or HLG tagged still to luminance and renders it for the target. `mode` is the request's toneMap.
 * `none` is only valid for targets that hold HDR (`hdr-avif`, `radiance`); an SDR target with `none` is a 400.
 */
export async function renderHdrStill(
  pipeline: Sharp,
  cicp: Cicp,
  mode: ToneMapMode,
  target: HdrStillTarget,
  pqBits: number = HDR_AVIF_BITS,
): Promise<HdrStill> {
  if (mode === 'none' && target === 'sdr') {
    throw new UnsupportedOptionError(NO_TONE_MAP_MESSAGE);
  }
  const primaries = primariesOfCicp(cicp.primaries);
  if (primaries === null) throw new ColourTagError(`Unsupported colour primaries ${cicp.primaries} in the HDR picture's colour tag`);
  const transfer = hdrTransferOf(cicp);
  if (transfer === null) throw new ColourTagError(`Transfer ${cicp.transfer} is not PQ or HLG`);

  const meta = await pipeline.metadata();
  if (meta.width === undefined || meta.height === undefined) throw new ColourTagError('The HDR picture has no readable size');
  assertPixelBudget(meta.width, meta.height, HDR_TONE_MAP_PIXEL_BUDGET);
  const maxCode = maxCodeOf(meta);
  const { data, info } = await pipeline
    .rotate()
    .toColourspace('rgb16')
    .raw({ depth: SHARP_SIXTEEN_BIT_DEPTH })
    .toBuffer({ resolveWithObject: true });
  const channels = info.channels;
  if (channels !== RGB_CHANNELS && channels !== RGBA_CHANNELS) {
    throw new ColourTagError(`The HDR picture decoded to ${channels} channels; RGB or RGBA is needed`);
  }
  const samples = copyU16(data);
  const pixels = info.width * info.height;

  // Luminance of every pixel in cd/m2 (R, G, B in the tagged primaries).
  const nits = new Float32Array(pixels * RGB_CHANNELS);
  if (transfer === CICP_TRANSFER_PQ) {
    const table = new Float32Array(U16_STATES);
    for (let v = 0; v <= maxCode; v += 1) table[v] = pqSignalToNits(v / maxCode);
    for (let p = 0; p < pixels; p += 1) {
      nits[p * 3] = table[Math.min(samples[p * channels], maxCode)];
      nits[p * 3 + 1] = table[Math.min(samples[p * channels + 1], maxCode)];
      nits[p * 3 + 2] = table[Math.min(samples[p * channels + 2], maxCode)];
    }
  } else {
    for (let p = 0; p < pixels; p += 1) {
      hlgPixelToNits(
        samples[p * channels] / maxCode,
        samples[p * channels + 1] / maxCode,
        samples[p * channels + 2] / maxCode,
        HLG_REFERENCE_PEAK_NITS,
        nits,
        p * 3,
      );
    }
  }

  if (target === 'radiance') {
    const toBt709 = primariesToPrimaries(primaries, BT709_PRIMARIES);
    const radiance = new Float32Array(nits.length);
    for (let i = 0; i < nits.length; i += RGB_CHANNELS) {
      radiance[i] = (toBt709[0] * nits[i] + toBt709[1] * nits[i + 1] + toBt709[2] * nits[i + 2]) / SDR_PEAK_NITS;
      radiance[i + 1] = (toBt709[3] * nits[i] + toBt709[4] * nits[i + 1] + toBt709[5] * nits[i + 2]) / SDR_PEAK_NITS;
      radiance[i + 2] = (toBt709[6] * nits[i] + toBt709[7] * nits[i + 1] + toBt709[8] * nits[i + 2]) / SDR_PEAK_NITS;
    }
    return { pipeline, tagsPq: false, radiance, width: info.width, height: info.height };
  }

  if (target === 'hdr-pq') {
    const alreadyPq2020 = transfer === CICP_TRANSFER_PQ && cicp.primaries === CICP_PRIMARIES_BT2020;
    const coded = alreadyPq2020 ? null : encodePq2020(nits, primaries, pqBits);
    const out = new Uint16Array(pixels * channels);
    for (let p = 0; p < pixels; p += 1) {
      for (let c = 0; c < RGB_CHANNELS; c += 1) out[p * channels + c] = coded ? coded[p * 3 + c] : samples[p * channels + c];
      if (channels === RGBA_CHANNELS) out[p * channels + 3] = samples[p * channels + 3];
    }
    return {
      pipeline: sharp(out, { raw: { width: info.width, height: info.height, channels } }),
      tagsPq: true,
      width: info.width,
      height: info.height,
    };
  }

  const rendition = renderNitsAsSdr(nits, primaries, mode as 'clip' | 'bt2390', transfer === CICP_TRANSFER_HLG ? HLG_REFERENCE_PEAK_NITS : undefined);
  const out = Buffer.allocUnsafe(pixels * channels);
  for (let p = 0; p < pixels; p += 1) {
    out[p * channels] = rendition.rgb[p * 3];
    out[p * channels + 1] = rendition.rgb[p * 3 + 1];
    out[p * channels + 2] = rendition.rgb[p * 3 + 2];
    if (channels === RGBA_CHANNELS) out[p * channels + 3] = Math.round((samples[p * channels + 3] / maxCode) * BYTE_MAX);
  }
  return {
    pipeline: sharp(out, { raw: { width: info.width, height: info.height, channels } }),
    report: rendition.report,
    tagsPq: false,
    width: info.width,
    height: info.height,
  };
}
