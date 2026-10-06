/**
 * Independent spectrum analysis and signal synthesis for audio resampler tests.
 *
 * Nothing here imports production code: the FFT is a textbook iterative radix-2
 * Cooley-Tukey transform and every expected signal is synthesized analytically from
 * its tone list, so the expected spectra never come from the module under test.
 */

export interface Tone {
  /** Frequency in Hz. */
  freq: number;
  /** Peak amplitude (1.0 = full scale). */
  amp: number;
  /** Phase in radians. */
  phase: number;
}

const TWO_PI = 2 * Math.PI;
/** A pure tone reads as `amp` when the magnitude is scaled by 2 / N. */
const PEAK_SCALE = 2;
/** dB floor reported for an exactly empty bin. */
export const SPECTRUM_FLOOR_DB = -400;

export function isPowerOfTwo(n: number): boolean {
  return Number.isInteger(n) && n >= 2 && (n & (n - 1)) === 0;
}

/** In-place iterative radix-2 FFT (forward, unnormalised). */
export function fftInPlace(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  if (!isPowerOfTwo(n) || im.length !== n) {
    throw new RangeError(`fftInPlace needs equal power-of-two lengths, got ${n}/${im.length}`);
  }
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i];
      re[i] = re[j];
      re[j] = tr;
      const ti = im[i];
      im[i] = im[j];
      im[j] = ti;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1;
    const step = -TWO_PI / len;
    for (let start = 0; start < n; start += len) {
      for (let k = 0; k < half; k++) {
        const wr = Math.cos(step * k);
        const wi = Math.sin(step * k);
        const a = start + k;
        const b = a + half;
        const xr = re[b] * wr - im[b] * wi;
        const xi = re[b] * wi + im[b] * wr;
        re[b] = re[a] - xr;
        im[b] = im[a] - xi;
        re[a] += xr;
        im[a] += xi;
      }
    }
  }
}

/**
 * Peak-amplitude spectrum (bins 0..N/2) of `n` samples starting at `start`, rectangular window.
 * Tones whose frequency is an exact bin centre (`k * rate / n`) land in one bin without leakage,
 * which is how every test places its tones.
 */
export function amplitudeSpectrum(x: ArrayLike<number>, start: number, n: number): Float64Array {
  if (start < 0 || start + n > x.length) {
    throw new RangeError(`analysis window ${start}+${n} exceeds signal length ${x.length}`);
  }
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  for (let i = 0; i < n; i++) re[i] = x[start + i];
  fftInPlace(re, im);
  const half = n / 2;
  const out = new Float64Array(half + 1);
  for (let k = 0; k <= half; k++) {
    const scale = k === 0 || k === half ? 1 : PEAK_SCALE;
    out[k] = (scale * Math.hypot(re[k], im[k])) / n;
  }
  return out;
}

export function toDb(amplitude: number): number {
  return amplitude > 0 ? 20 * Math.log10(amplitude) : SPECTRUM_FLOOR_DB;
}

/** Highest bin level (dB re 1.0) outside +-`guardBins` of every bin in `excludeBins`. */
export function maxSpurDb(spectrum: Float64Array, excludeBins: number[], guardBins: number): number {
  let worst = 0;
  for (let k = 0; k < spectrum.length; k++) {
    if (excludeBins.some((e) => Math.abs(e - k) <= guardBins)) continue;
    if (spectrum[k] > worst) worst = spectrum[k];
  }
  return toDb(worst);
}

/** Snap `freq` to the nearest FFT bin centre for an `n`-point analysis at `rate`. */
export function snapToBin(freq: number, rate: number, n: number): { bin: number; freq: number } {
  const bin = Math.round((freq * n) / rate);
  return { bin, freq: (bin * rate) / n };
}

/** Bin an input tone appears in after sampling at `rate` (folded into 0..rate/2). */
export function aliasedBin(freq: number, rate: number, n: number): number {
  const bin = Math.round((freq * n) / rate) % n;
  return bin > n / 2 ? n - bin : bin;
}

/** Analytic tone sum sampled at `rate`; sample i is taken at t = (i + offset) / rate. */
export function synthesizeTones(tones: Tone[], rate: number, frames: number, offset = 0): Float64Array {
  const out = new Float64Array(frames);
  for (const tone of tones) {
    const w = (TWO_PI * tone.freq) / rate;
    for (let i = 0; i < frames; i++) out[i] += tone.amp * Math.sin(w * (i + offset) + tone.phase);
  }
  return out;
}

/** SNR in dB of `actual` against `ideal` over [start, start + n). */
export function snrDb(ideal: ArrayLike<number>, actual: ArrayLike<number>, start: number, n: number): number {
  let signal = 0;
  let noise = 0;
  for (let i = start; i < start + n; i++) {
    const e = actual[i] - ideal[i];
    signal += ideal[i] * ideal[i];
    noise += e * e;
  }
  return noise > 0 ? 10 * Math.log10(signal / noise) : Infinity;
}
