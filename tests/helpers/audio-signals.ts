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
