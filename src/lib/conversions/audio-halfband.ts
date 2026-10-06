/**
 * Half-band FIR stages for 2:1 decimation and 1:2 interpolation (Crochiere and Rabiner,
 * "Multirate Digital Signal Processing", ch. 5).
 *
 * A half-band low-pass has its -6 dB point at a quarter of the sample rate, a transition band
 * symmetric about it, h[0] = 1/2 and h[n] = 0 for every even n != 0. With the taps also
 * symmetric, an output needs one multiply per PAIR of odd taps: about a quarter of the
 * multiplies of a direct FIR of the same length.
 *
 * Decimation:    y[i] = x[2i] / 2 + sum_p h(2p+1) (x[2i-2p-1] + x[2i+2p+1])
 * Interpolation: y[2m] = x[m];  y[2m+1] = 2 sum_p h(2p+1) (x[m-p] + x[m+1+p])
 */
import { besselI0, kaiserBeta, kaiserLengthEstimate } from './audio-kaiser';

/** Odd-tap pairs are processed in groups of this many (unrolled accumulators). */
export const HALF_BAND_PAIR_UNROLL = 4;
export const HALF_BAND_CENTER_TAP = 0.5;
const STEREO = 2;

export interface HalfBandFilter {
  /** Farthest tap offset: taps sit at +-1, +-3, ..., +-reach. Odd. */
  reach: number;
  /** Number of odd-tap pairs, (reach + 1) / 2; a multiple of HALF_BAND_PAIR_UNROLL. */
  pairs: number;
  /** h(2p + 1), the coefficient of the pair at offsets +-(2p + 1). */
  odd: Float64Array;
  /** 2 h(2p + 1), the interpolation gain compensated coefficients. */
  oddDoubled: Float64Array;
}

/** Pairs added per growth step while verifying a design (keeps the pair count unroll-aligned). */
export const HALF_BAND_GROWTH_STEP = HALF_BAND_PAIR_UNROLL;
/** Growth steps tried after the Kaiser estimate before a design is declared infeasible. */
export const HALF_BAND_MAX_GROWTH_STEPS = 64;
/** Largest half-band stage considered; a longer one never beats the direct polyphase filter. */
export const HALF_BAND_MAX_PAIRS = 1024;
/** Grid points per tap-length unit used when scanning the stopband for its largest peak. */
const VERIFY_POINTS_PER_TAP = 8;
const VERIFY_MIN_POINTS = 512;
const VERIFY_MAX_POINTS = 16384;
const DECIBELS_PER_DECADE = 20;

/** Starting pair count from the Kaiser estimate, rounded up to the unroll size. */
export function halfBandPairsFor(attenuationDb: number, transitionCyclesPerSample: number): number {
  const length = kaiserLengthEstimate(attenuationDb, transitionCyclesPerSample);
  // 2 x reach + 1 ~ length, with reach = 2 x pairs - 1.
  const pairs = Math.ceil((length + 1) / 4);
  return Math.ceil(pairs / HALF_BAND_PAIR_UNROLL) * HALF_BAND_PAIR_UNROLL;
}

/** Kaiser-windowed half-band with a given pair count; the window spans the full reach. */
export function buildHalfBand(attenuationDb: number, pairs: number): HalfBandFilter {
  const reach = 2 * pairs - 1;
  const beta = kaiserBeta(attenuationDb);
  const windowNorm = 1 / besselI0(beta);
  const odd = new Float64Array(pairs);
  const oddDoubled = new Float64Array(pairs);
  for (let p = 0; p < pairs; p++) {
    const k = 2 * p + 1;
    const ideal = (p % 2 === 0 ? 1 : -1) / (Math.PI * k); // sin(pi k / 2) / (pi k) for odd k
    const x = k / reach;
    const window = besselI0(beta * Math.sqrt(Math.max(0, 1 - x * x))) * windowNorm;
    odd[p] = ideal * window;
    oddDoubled[p] = 2 * odd[p];
  }
  return { reach, pairs, odd, oddDoubled };
}

/**
 * Largest |H(f)| over the stopband [0.5 - passEdge, 0.5] (f in cycles per sample), with
 * H(f) = 1/2 + 2 sum_p h(2p + 1) cos(2 pi f (2p + 1)). Because the centre tap is exactly 1/2 and
 * the even taps are zero, H(f) + H(1/2 - f) = 1: the passband deviation 1 - H(f) on
 * [0, passEdge] is the mirror image of this value, so one scan bounds both.
 */
export function halfBandStopbandPeak(filter: HalfBandFilter, passEdge: number): number {
  const points = Math.min(
    VERIFY_MAX_POINTS,
    Math.max(VERIFY_MIN_POINTS, VERIFY_POINTS_PER_TAP * (2 * filter.reach + 1))
  );
  const { odd, pairs } = filter;
  let peak = 0;
  for (let i = 0; i <= points; i++) {
    const f = 0.5 - passEdge + (passEdge * i) / points;
    // cos((2p + 1) theta) by rotation: c' = c cos(2 theta) - s sin(2 theta), s' = s cos(2 theta) + c sin(2 theta).
    const theta = 2 * Math.PI * f;
    const rotC = Math.cos(2 * theta);
    const rotS = Math.sin(2 * theta);
    let c = Math.cos(theta);
    let s = Math.sin(theta);
    let sum = HALF_BAND_CENTER_TAP;
    for (let p = 0; p < pairs; p++) {
      sum += 2 * odd[p] * c;
      const next = c * rotC - s * rotS;
      s = s * rotC + c * rotS;
      c = next;
    }
    peak = Math.max(peak, Math.abs(sum));
  }
  return peak;
}

/**
 * Smallest half-band (in steps of HALF_BAND_GROWTH_STEP pairs, starting from the Kaiser estimate)
 * whose measured stopband peak is at most -attenuationDb. The estimate is optimistic for wide
 * transition bands, hence the verification. `null` when no filter within the pair limit works.
 * `passEdge` is the passband edge in cycles per sample (the transition spans passEdge .. 0.5 - passEdge).
 */
export function designVerifiedHalfBand(attenuationDb: number, passEdge: number): HalfBandFilter | null {
  const limit = 10 ** (-attenuationDb / DECIBELS_PER_DECADE);
  const transition = 0.5 - 2 * passEdge;
  if (transition <= 0) return null;
  let pairs = halfBandPairsFor(attenuationDb, transition);
  for (let step = 0; step <= HALF_BAND_MAX_GROWTH_STEPS && pairs <= HALF_BAND_MAX_PAIRS; step++) {
    const filter = buildHalfBand(attenuationDb, pairs);
    if (halfBandStopbandPeak(filter, passEdge) <= limit) return filter;
    pairs += HALF_BAND_GROWTH_STEP;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Block kernels. The mono and stereo loops are written out in full; the JIT inliner is not
// relied on for the hot path.
// ---------------------------------------------------------------------------------------------

/** Output frame `i` of the block uses input frame `2 i + reach` of channel-interleaved x as centre. */
export function halfBandDecimateBlock(
  filter: HalfBandFilter,
  x: Float64Array,
  channels: number,
  count: number,
  out: Float64Array
): void {
  const { odd, pairs, reach } = filter;
  if (channels === 1) {
    for (let i = 0; i < count; i++) {
      const centre = (2 * i + reach) | 0;
      let a0 = 0;
      let a1 = 0;
      let a2 = 0;
      let a3 = 0;
      for (let p = 0; p < pairs; p += HALF_BAND_PAIR_UNROLL) {
        const lo = (centre - 2 * p) | 0;
        const hi = (centre + 2 * p) | 0;
        a0 += odd[p] * (x[lo - 1] + x[hi + 1]);
        a1 += odd[p + 1] * (x[lo - 3] + x[hi + 3]);
        a2 += odd[p + 2] * (x[lo - 5] + x[hi + 5]);
        a3 += odd[p + 3] * (x[lo - 7] + x[hi + 7]);
      }
      out[i] = HALF_BAND_CENTER_TAP * x[centre] + (a0 + a1) + (a2 + a3);
    }
  } else if (channels === STEREO) {
    for (let i = 0; i < count; i++) {
      const c = ((2 * i + reach) * STEREO) | 0;
      let l0 = 0;
      let l1 = 0;
      let r0 = 0;
      let r1 = 0;
      for (let p = 0; p < pairs; p += 2) {
        const lo = (c - 4 * p) | 0;
        const hi = (c + 4 * p) | 0;
        const h0 = odd[p];
        const h1 = odd[p + 1];
        l0 += h0 * (x[lo - 2] + x[hi + 2]);
        r0 += h0 * (x[lo - 1] + x[hi + 3]);
        l1 += h1 * (x[lo - 6] + x[hi + 6]);
        r1 += h1 * (x[lo - 5] + x[hi + 7]);
      }
      out[i * STEREO] = HALF_BAND_CENTER_TAP * x[c] + (l0 + l1);
      out[i * STEREO + 1] = HALF_BAND_CENTER_TAP * x[c + 1] + (r0 + r1);
    }
  } else {
    for (let i = 0; i < count; i++) {
      const c = (2 * i + reach) * channels;
      for (let ch = 0; ch < channels; ch++) {
        let sum = HALF_BAND_CENTER_TAP * x[c + ch];
        for (let p = 0; p < pairs; p++) {
          const d = (2 * p + 1) * channels;
          sum += odd[p] * (x[c - d + ch] + x[c + d + ch]);
        }
        out[i * channels + ch] = sum;
      }
    }
  }
}

/**
 * Output frames [first, first + count) of the 1:2 interpolator. x frame 0 holds input index
 * `floor(first / 2) - pairs + 1`; even outputs copy their input, odd outputs run the folded FIR.
 */
export function halfBandInterpolateBlock(
  filter: HalfBandFilter,
  x: Float64Array,
  channels: number,
  first: number,
  count: number,
  out: Float64Array
): void {
  const { oddDoubled, pairs } = filter;
  const firstInput = Math.floor(first / 2);
  for (let i = 0; i < count; i++) {
    const n = first + i;
    const m = ((n >> 1) - firstInput + pairs - 1) | 0;
    if ((n & 1) === 0) {
      for (let ch = 0; ch < channels; ch++) out[i * channels + ch] = x[m * channels + ch];
    } else if (channels === 1) {
      let a0 = 0;
      let a1 = 0;
      let a2 = 0;
      let a3 = 0;
      for (let p = 0; p < pairs; p += HALF_BAND_PAIR_UNROLL) {
        a0 += oddDoubled[p] * (x[m - p] + x[m + 1 + p]);
        a1 += oddDoubled[p + 1] * (x[m - p - 1] + x[m + 2 + p]);
        a2 += oddDoubled[p + 2] * (x[m - p - 2] + x[m + 3 + p]);
        a3 += oddDoubled[p + 3] * (x[m - p - 3] + x[m + 4 + p]);
      }
      out[i] = a0 + a1 + (a2 + a3);
    } else if (channels === STEREO) {
      let l0 = 0;
      let l1 = 0;
      let r0 = 0;
      let r1 = 0;
      for (let p = 0; p < pairs; p += 2) {
        const lo = ((m - p) * STEREO) | 0;
        const hi = ((m + 1 + p) * STEREO) | 0;
        const h0 = oddDoubled[p];
        const h1 = oddDoubled[p + 1];
        l0 += h0 * (x[lo] + x[hi]);
        r0 += h0 * (x[lo + 1] + x[hi + 1]);
        l1 += h1 * (x[lo - STEREO] + x[hi + STEREO]);
        r1 += h1 * (x[lo - STEREO + 1] + x[hi + STEREO + 1]);
      }
      out[i * STEREO] = l0 + l1;
      out[i * STEREO + 1] = r0 + r1;
    } else {
      for (let ch = 0; ch < channels; ch++) {
        let sum = 0;
        for (let p = 0; p < pairs; p++) {
          sum += oddDoubled[p] * (x[(m - p) * channels + ch] + x[(m + 1 + p) * channels + ch]);
        }
        out[i * channels + ch] = sum;
      }
    }
  }
}

/** Input frames the decimator needs for `count` outputs. */
export function halfBandDecimateSpan(filter: HalfBandFilter, count: number): number {
  return 2 * (count - 1) + 2 * filter.reach + 1;
}

/** Input frames the interpolator needs for outputs [first, first + count). */
export function halfBandInterpolateSpan(filter: HalfBandFilter, first: number, count: number): number {
  const lo = Math.floor(first / 2) - filter.pairs + 1;
  const hi = Math.floor((first + count - 1) / 2) + filter.pairs;
  return hi - lo + 1;
}

/** Upper bound of halfBandInterpolateSpan over every start position. */
export function halfBandInterpolateMaxSpan(filter: HalfBandFilter, count: number): number {
  return Math.ceil(count / 2) + 2 * filter.pairs + 1;
}
