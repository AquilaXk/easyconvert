/**
 * Kaiser window design helpers shared by the polyphase and half-band resampler stages.
 * Formulas: J. F. Kaiser, "Nonrecursive digital filter design using the I0-sinh window
 * function" (1974): beta from the stopband attenuation A and the tap-count estimate
 * N ~ (A - 8) / (2.285 x dw) for a transition width of dw rad/sample.
 */

const KAISER_BETA_HIGH_ATTENUATION_DB = 50;
const KAISER_BETA_LOW_ATTENUATION_DB = 21;
const KAISER_BETA_SLOPE = 0.1102;
const KAISER_BETA_OFFSET_DB = 8.7;
const KAISER_BETA_MID_EXPONENT = 0.4;
const KAISER_BETA_MID_COEFFICIENT_A = 0.5842;
const KAISER_BETA_MID_COEFFICIENT_B = 0.07886;
const KAISER_LENGTH_OFFSET_DB = 8;
const KAISER_LENGTH_SLOPE = 2.285;
const BESSEL_MAX_TERMS = 200;
const BESSEL_TOLERANCE = 1e-17;
export const TWO_PI = 2 * Math.PI;

/** Kaiser window shape parameter for a stopband attenuation in dB. */
export function kaiserBeta(attenuationDb: number): number {
  if (attenuationDb > KAISER_BETA_HIGH_ATTENUATION_DB) {
    return KAISER_BETA_SLOPE * (attenuationDb - KAISER_BETA_OFFSET_DB);
  }
  if (attenuationDb >= KAISER_BETA_LOW_ATTENUATION_DB) {
    const d = attenuationDb - KAISER_BETA_LOW_ATTENUATION_DB;
    return KAISER_BETA_MID_COEFFICIENT_A * d ** KAISER_BETA_MID_EXPONENT + KAISER_BETA_MID_COEFFICIENT_B * d;
  }
  return 0;
}

/** Estimated filter length N for a transition width in cycles per sample at the filter's own rate. */
export function kaiserLengthEstimate(attenuationDb: number, transitionCyclesPerSample: number): number {
  return (attenuationDb - KAISER_LENGTH_OFFSET_DB) / (KAISER_LENGTH_SLOPE * TWO_PI * transitionCyclesPerSample);
}

/** Zeroth-order modified Bessel function of the first kind, by its power series. */
export function besselI0(x: number): number {
  const q = (x * x) / 4;
  let term = 1;
  let sum = 1;
  for (let k = 1; k <= BESSEL_MAX_TERMS; k++) {
    term *= q / (k * k);
    sum += term;
    if (term < sum * BESSEL_TOLERANCE) break;
  }
  return sum;
}
