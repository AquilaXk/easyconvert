import { amplitudeSpectrum, toDb } from './audio-spectrum';

/** Deterministic test signals. Nothing here imports the code under test. */

/** Small seeded PRNG so every run sees the same signals. */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Uniform noise in [-amplitude, amplitude]. */
export function uniformNoise(seed: number, count: number, amplitude: number): Int16Array {
  const next = mulberry32(seed);
  const out = new Int16Array(count);
  for (let i = 0; i < count; i++) out[i] = Math.round((next() * 2 - 1) * amplitude);
  return out;
}

/** Sawtooth-like integer ramp, identical shape per channel with a small per-channel offset. */
export function ramp(frames: number, channels: number): Int16Array {
  const out = new Int16Array(frames * channels);
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channels; c++) {
      out[i * channels + c] = ((i * 37 + c * 11) % 2001) - 1000;
    }
  }
  return out;
}

/**
 * FFT view of a sine that was reduced to 16 bits with or without dither. The tone sits exactly on an FFT bin
 * (frequency = bin * rate / n) so a rectangular window leaks nothing, and every other bin is quantisation noise
 * or distortion. Nothing here imports the code under test.
 */
export interface QuantisationReport {
  /** Level of the tone bin in dB re full scale (16-bit: 32768 LSB). */
  toneDbfs: number;
  /** Power of everything outside the tone (+-2 bins), in LSB squared. */
  noisePowerLsb2: number;
  /** Largest non-tone bin over the mean non-tone bin, in dB: about 10 for white noise, far more for discrete spurs. */
  peakToMeanDb: number;
  /** Noise power in the upper half of the spectrum over the lower half, in dB: 0 for flat noise, positive when high-pass shaped. */
  highOverLowDb: number;
}

const TONE_GUARD_BINS = 2;
const FULL_SCALE_16_BIT = 32768;

export function quantisationReport(samples: ArrayLike<number>, start: number, n: number, toneBin: number): QuantisationReport {
  const spectrum = amplitudeSpectrum(samples, start, n);
  let noise = 0;
  let high = 0;
  let low = 0;
  let peak = 0;
  let bins = 0;
  for (let k = 1; k < spectrum.length - 1; k++) {
    if (Math.abs(k - toneBin) <= TONE_GUARD_BINS) continue;
    const power = (spectrum[k] * spectrum[k]) / 2;
    noise += power;
    if (k < spectrum.length / 2) low += power;
    else high += power;
    peak = Math.max(peak, power);
    bins++;
  }
  return {
    toneDbfs: toDb(spectrum[toneBin] / FULL_SCALE_16_BIT),
    noisePowerLsb2: noise,
    peakToMeanDb: 10 * Math.log10(peak / (noise / bins)),
    highOverLowDb: 10 * Math.log10(high / low),
  };
}
