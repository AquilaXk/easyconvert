import { type Matrix3, IDENTITY_MATRIX } from './colour-primaries';

/**
 * HDR to SDR tone mapping on linear light measured in cd/m2 ("nits").
 *
 * - SMPTE ST 2084 (PQ) and ARIB STD-B67 / ITU-R BT.2100 (HLG) transfer functions.
 * - The ITU-R BT.2390-10 section 5.4 EETF: a Hermite spline knee applied to PQ-encoded values. It is applied to
 *   each of R, G and B (the per-component form BT.2390 allows); for neutral colours it equals the luminance form.
 * - Gamut: the EETF runs in the source primaries, then linear light is converted to BT.709 and clipped there.
 */

/** Tone mapping choices of a request. `none` keeps HDR for targets that can carry it. */
export const TONE_MAP_MODES = ['none', 'clip', 'bt2390'] as const;
export type ToneMapMode = (typeof TONE_MAP_MODES)[number];
export const DEFAULT_TONE_MAP: ToneMapMode = 'bt2390';

/** Peak luminance PQ can represent (ST 2084). */
export const PQ_PEAK_NITS = 10_000;
/** Peak luminance of the SDR target (BT.2390 reference display for the SDR rendition, BT.2408 reference white). */
export const SDR_PEAK_NITS = 100;
/** Source peak assumed when the stream or file states none (BT.2408 and common HDR10 mastering). */
export const DEFAULT_HDR_PEAK_NITS = 1000;
/** Peak of the BT.2100 HLG reference display. */
export const HLG_REFERENCE_PEAK_NITS = 1000;

// ST 2084 constants (exact rationals).
const PQ_M1 = 2610 / 16384;
const PQ_M2 = (2523 / 4096) * 128;
const PQ_C1 = 3424 / 4096;
const PQ_C2 = (2413 / 4096) * 32;
const PQ_C3 = (2392 / 4096) * 32;

// BT.2100 HLG constants.
const HLG_A = 0.17883277;
const HLG_B = 0.28466892;
const HLG_C = 0.55991073;
const HLG_KNEE = 0.5;
const HLG_SCENE_SQUARE_DIVISOR = 3;
const HLG_SCENE_EXP_DIVISOR = 12;
/** BT.2020 luminance coefficients (BT.2100 table 5 uses the same for HLG). */
const LUMA_R = 0.2627;
const LUMA_G = 0.678;
const LUMA_B = 0.0593;
/** BT.2100 note 5g: system gamma for a nominal peak Lw is 1.2 + 0.42 log10(Lw / 1000). */
const HLG_GAMMA_BASE = 1.2;
const HLG_GAMMA_SLOPE = 0.42;
const HLG_GAMMA_REFERENCE_NITS = 1000;

/** ST 2084 EOTF: normalised signal [0, 1] to luminance in nits. */
export function pqSignalToNits(signal: number): number {
  const s = Math.min(1, Math.max(0, signal));
  const p = Math.pow(s, 1 / PQ_M2);
  const numerator = Math.max(p - PQ_C1, 0);
  const denominator = PQ_C2 - PQ_C3 * p;
  return PQ_PEAK_NITS * Math.pow(numerator / denominator, 1 / PQ_M1);
}

/** ST 2084 inverse EOTF: luminance in nits to normalised signal [0, 1]. */
export function nitsToPqSignal(nits: number): number {
  const y = Math.min(1, Math.max(0, nits / PQ_PEAK_NITS));
  const p = Math.pow(y, PQ_M1);
  return Math.pow((PQ_C1 + PQ_C2 * p) / (1 + PQ_C3 * p), PQ_M2);
}

/** BT.2100 HLG inverse OETF: signal [0, 1] to normalised scene light [0, 1]. */
export function hlgSignalToScene(signal: number): number {
  const s = Math.min(1, Math.max(0, signal));
  if (s <= HLG_KNEE) return (s * s) / HLG_SCENE_SQUARE_DIVISOR;
  return (Math.exp((s - HLG_C) / HLG_A) + HLG_B) / HLG_SCENE_EXP_DIVISOR;
}

/** System gamma of the HLG OOTF for a display of the given nominal peak. */
export function hlgSystemGamma(peakNits: number): number {
  return HLG_GAMMA_BASE + HLG_GAMMA_SLOPE * Math.log10(peakNits / HLG_GAMMA_REFERENCE_NITS);
}

/**
 * HLG display light of one pixel (BT.2100 table 5 OOTF with zero black level): F_D = Lw * Ys^(gamma-1) * E_s per
 * component, with Ys the luminance of the scene light. Writes nits for R, G and B to `out` at `offset`.
 */
export function hlgPixelToNits(r: number, g: number, b: number, peakNits: number, out: Float32Array, offset: number): void {
  const sr = hlgSignalToScene(r);
  const sg = hlgSignalToScene(g);
  const sb = hlgSignalToScene(b);
  const luminance = LUMA_R * sr + LUMA_G * sg + LUMA_B * sb;
  const gain = luminance > 0 ? peakNits * Math.pow(luminance, hlgSystemGamma(peakNits) - 1) : 0;
  out[offset] = gain * sr;
  out[offset + 1] = gain * sg;
  out[offset + 2] = gain * sb;
}

export interface Bt2390Parameters {
  readonly sourcePeakNits: number;
  readonly targetPeakNits: number;
}

/**
 * The BT.2390-10 section 5.4 EETF as a function of the PQ signal. Source and target black are 0 cd/m2, so the
 * black-level lift term b(1 - E2)^4 vanishes (its minLum is 0). The returned function maps a PQ signal of the
 * source to a PQ signal whose peak is the target peak.
 */
export function createBt2390Eetf(parameters: Bt2390Parameters): (signal: number) => number {
  const { sourcePeakNits, targetPeakNits } = parameters;
  if (!(sourcePeakNits > 0) || !(targetPeakNits > 0)) {
    throw new RangeError('BT.2390 peaks must be positive');
  }
  const sourcePq = nitsToPqSignal(sourcePeakNits);
  const targetPq = nitsToPqSignal(targetPeakNits);
  const maxLum = targetPq / sourcePq;
  const knee = 1.5 * maxLum - 0.5;
  return (signal: number): number => {
    const e1 = Math.min(1, Math.max(0, signal / sourcePq));
    if (maxLum >= 1 || e1 < knee) return e1 * sourcePq;
    const t = (e1 - knee) / (1 - knee);
    const t2 = t * t;
    const t3 = t2 * t;
    const e2 = (2 * t3 - 3 * t2 + 1) * knee + (t3 - 2 * t2 + t) * (1 - knee) + (-2 * t3 + 3 * t2) * maxLum;
    return e2 * sourcePq;
  };
}

/** Entries of the per-component lookup table; the table is indexed by sqrt(nits / source peak). */
const MAP_TABLE_SIZE = 8192;

export interface ToneMapOptions {
  readonly sourcePeakNits: number;
  readonly targetPeakNits: number;
  /** Linear RGB of the source primaries to linear BT.709; identity when the source is BT.709. */
  readonly toBt709?: Matrix3;
}

/** Output nits for input nits under the BT.2390 EETF (exact; the table in toneMapToSdr samples this). */
export function bt2390Nits(nits: number, parameters: Bt2390Parameters): number {
  return pqSignalToNits(createBt2390Eetf(parameters)(nitsToPqSignal(nits)));
}

/**
 * Tone maps interleaved linear RGB (nits, source primaries) to display-referred linear BT.709 with 1.0 at the
 * target peak, clipped to [0, 1]. A source whose peak does not exceed the target peak is only clipped.
 */
export function toneMapToSdr(rgbNits: Float32Array, options: ToneMapOptions): Float32Array {
  if (rgbNits.length % 3 !== 0) throw new RangeError('RGB samples must come in triples');
  const { sourcePeakNits, targetPeakNits } = options;
  const matrix = options.toBt709 ?? IDENTITY_MATRIX;
  const compress = sourcePeakNits > targetPeakNits;
  const eetf = compress ? createBt2390Eetf({ sourcePeakNits, targetPeakNits }) : null;

  // One table for all three components: output nits as a function of input nits.
  const table = new Float32Array(MAP_TABLE_SIZE + 1);
  const root = Math.sqrt(sourcePeakNits);
  for (let i = 0; i <= MAP_TABLE_SIZE; i += 1) {
    const nits = ((i / MAP_TABLE_SIZE) * root) ** 2;
    table[i] = eetf ? pqSignalToNits(eetf(nitsToPqSignal(nits))) : Math.min(nits, targetPeakNits);
  }
  const mapNits = (nits: number): number => {
    if (!(nits > 0)) return 0;
    if (nits >= sourcePeakNits) return table[MAP_TABLE_SIZE];
    const position = (Math.sqrt(nits) / root) * MAP_TABLE_SIZE;
    const index = Math.floor(position);
    const fraction = position - index;
    return table[index] + (table[index + 1] - table[index]) * fraction;
  };

  const out = new Float32Array(rgbNits.length);
  const [m0, m1, m2, m3, m4, m5, m6, m7, m8] = matrix;
  const inverseTarget = 1 / targetPeakNits;
  for (let i = 0; i < rgbNits.length; i += 3) {
    const r = mapNits(rgbNits[i]) * inverseTarget;
    const g = mapNits(rgbNits[i + 1]) * inverseTarget;
    const b = mapNits(rgbNits[i + 2]) * inverseTarget;
    out[i] = Math.min(1, Math.max(0, m0 * r + m1 * g + m2 * b));
    out[i + 1] = Math.min(1, Math.max(0, m3 * r + m4 * g + m5 * b));
    out[i + 2] = Math.min(1, Math.max(0, m6 * r + m7 * g + m8 * b));
  }
  return out;
}
