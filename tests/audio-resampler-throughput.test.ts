import { describe, it, expect } from 'vitest';
import { describeResamplerPlan } from '../src/lib/conversions/audio-resampler';
import { resampleAudioSinc } from '../src/lib/conversions/media';

/**
 * Throughput regression checks that do not depend on how busy the runner is.
 *
 * Absolute samples/s varies by 2x or more on shared CI, so the floor is derived in the same
 * process: a fixed scalar multiply-accumulate loop is timed first, and the resampler must reach a
 * fraction K of what that loop predicts for the filter's multiplies per output sample. Load slows
 * the calibration and the resampler alike, so the ratio is stable. A coarse absolute floor and a
 * speed-up over a naive per-tap sin/cos resampler (timed in the same process) back it up.
 *
 * Measured on the development VM (stereo 16-bit, default 96 dB filter), measured / predicted:
 *   44.1 -> 48 kHz 7.8 M samples/s (calibration 0.83 GMAC/s, 124 MAC/sample) 1.16;  48 -> 44.1 1.29;
 *   96 -> 44.1 0.91;  44.1 -> 22.05 1.32;  48 -> 16 1.17;  16 -> 48 1.03;  192 -> 48 1.58.
 * K = 0.5 is about half of the worst measured ratio; all cases also passed with six busy
 * processes competing for four cores (the old absolute 5 M samples/s floor failed there). The naive original design runs at 1.4 M samples/s (about 5x slower).
 */

const CHANNELS = 2;
const SECONDS = 3;
const WARMUP_PASSES = 2;
const TIMED_PASSES = 3;
const MS_PER_SECOND = 1000;
const LCG_MULTIPLIER = 1664525;
const LCG_INCREMENT = 1013904223;
const UINT32_RANGE = 4294967296;
const SIGNAL_SPAN = 16000;

/** Fraction of the calibrated multiply-accumulate rate the resampler must reach. */
const CALIBRATED_FRACTION = 0.5;
/** Coarse absolute floor in output samples per second; fails only on a gross regression. */
const ABSOLUTE_FLOOR_SAMPLES_PER_SECOND = 1_000_000;
/** Required speed-up over the naive per-tap sin/cos resampler on 44.1 -> 48 kHz. */
const MIN_SPEEDUP_OVER_NAIVE = 3;

const CALIBRATION_ARRAY = 2048;
const CALIBRATION_MIN_MS = 40;
const CALIBRATION_TRIALS = 3;

/** Multiply-accumulates per second of a plain 4-accumulator loop over typed arrays. */
function calibrateMacsPerSecond(): number {
  const a = new Float64Array(CALIBRATION_ARRAY).map((_, i) => Math.sin(i));
  const b = new Float64Array(CALIBRATION_ARRAY).map((_, i) => Math.cos(i));
  let best = 0;
  let sink = 0;
  for (let trial = 0; trial < CALIBRATION_TRIALS; trial++) {
    let macs = 0;
    const start = performance.now();
    let elapsed = 0;
    while (elapsed < CALIBRATION_MIN_MS) {
      let s0 = 0;
      let s1 = 0;
      let s2 = 0;
      let s3 = 0;
      for (let i = 0; i < CALIBRATION_ARRAY; i += 4) {
        s0 += a[i] * b[i];
        s1 += a[i + 1] * b[i + 1];
        s2 += a[i + 2] * b[i + 2];
        s3 += a[i + 3] * b[i + 3];
      }
      sink += s0 + s1 + s2 + s3;
      macs += CALIBRATION_ARRAY;
      elapsed = performance.now() - start;
    }
    best = Math.max(best, (macs / elapsed) * MS_PER_SECOND);
  }
  expect(Number.isFinite(sink)).toBe(true);
  return best;
}

/** Multiplies per output sample of the planned pipeline (folding ignored: an upper bound on work). */
function macsPerOutputSample(srcRate: number, tgtRate: number): number {
  const plan = describeResamplerPlan(srcRate, tgtRate);
  const decimating = srcRate > tgtRate;
  const stages = plan.halfBandStages;
  // Polyphase work per output sample, then each half-band stage per sample of the final output.
  let macs = decimating ? plan.taps : plan.taps / 2 ** stages;
  for (let level = 0; level < stages; level++) {
    const pairs = plan.halfBandPairs[decimating ? level : stages - 1 - level];
    const stageRatePerOutput = decimating ? srcRate / 2 ** level / 2 / tgtRate : 1 / 2 ** level;
    macs += (decimating ? pairs + 1 : pairs / 2) * stageRatePerOutput;
  }
  return macs;
}

function makePcm(rate: number): Int16Array {
  const pcm = new Int16Array(rate * SECONDS * CHANNELS);
  let state = 1;
  for (let i = 0; i < pcm.length; i++) {
    state = (Math.imul(state, LCG_MULTIPLIER) + LCG_INCREMENT) >>> 0;
    pcm[i] = Math.round((state / UINT32_RANGE - 0.5) * SIGNAL_SPAN);
  }
  return pcm;
}

function bestSamplesPerSecond(pcm: Int16Array, inRate: number, outRate: number): number {
  for (let pass = 0; pass < WARMUP_PASSES; pass++) resampleAudioSinc(pcm, inRate, outRate, CHANNELS);
  let best = 0;
  for (let pass = 0; pass < TIMED_PASSES; pass++) {
    const start = performance.now();
    const out = resampleAudioSinc(pcm, inRate, outRate, CHANNELS);
    best = Math.max(best, out.length / ((performance.now() - start) / MS_PER_SECOND));
  }
  return best;
}

/** The original per-tap design: radius-8 windowed sinc with sin and cos evaluated for every tap. */
function naiveSincResample(data: Int16Array, srcRate: number, tgtRate: number, channels: number): Int16Array {
  const radius = 8;
  const ratio = tgtRate / srcRate;
  const frames = data.length / channels;
  const outFrames = Math.floor(frames * ratio);
  const out = new Int16Array(outFrames * channels);
  const cutoff = Math.min(1, ratio);
  for (let f = 0; f < outFrames; f++) {
    const pos = f / ratio;
    const center = Math.floor(pos);
    for (let c = 0; c < channels; c++) {
      let sum = 0;
      let weightSum = 0;
      for (let k = Math.max(0, center - radius); k <= Math.min(frames - 1, center + radius); k++) {
        const x = (pos - k) * cutoff;
        const sinc = Math.abs(x) > 1e-7 ? Math.sin(Math.PI * x) / (Math.PI * x) : 1;
        const t = (pos - k) / radius;
        const w = 0.42 + 0.5 * Math.cos(Math.PI * t) + 0.08 * Math.cos(2 * Math.PI * t);
        sum += data[k * channels + c] * sinc * w * cutoff;
        weightSum += sinc * w * cutoff;
      }
      out[f * channels + c] = Math.round(weightSum > 0 ? sum / weightSum : 0);
    }
  }
  return out;
}

interface Case {
  inRate: number;
  outRate: number;
  /** Path through the pipeline, for the failure message. */
  path: string;
}

const CASES: Case[] = [
  { inRate: 44100, outRate: 48000, path: 'polyphase' },
  { inRate: 48000, outRate: 44100, path: 'polyphase' },
  { inRate: 96000, outRate: 44100, path: 'half-band + polyphase' },
  { inRate: 44100, outRate: 22050, path: 'folded 2:1 rows' },
  { inRate: 48000, outRate: 16000, path: 'half-band + folded rows' },
  { inRate: 16000, outRate: 48000, path: 'polyphase + half-band' },
  { inRate: 192000, outRate: 48000, path: 'half-band + folded rows' },
];

describe('audio resampler throughput', () => {
  it.each(CASES)(
    'reaches the calibrated fraction of the multiply-accumulate rate: $inRate -> $outRate ($path)',
    ({ inRate, outRate }) => {
      const calibration = calibrateMacsPerSecond();
      const macs = macsPerOutputSample(inRate, outRate);
      const predicted = calibration / macs;
      const measured = bestSamplesPerSecond(makePcm(inRate), inRate, outRate);
      const context = `measured ${(measured / 1e6).toFixed(2)} M samples/s, calibration ${(calibration / 1e9).toFixed(2)} GMAC/s, ${macs.toFixed(0)} MAC/sample, ratio ${(measured / predicted).toFixed(2)}`;
      expect(measured, context).toBeGreaterThanOrEqual(CALIBRATED_FRACTION * predicted);
      expect(measured, context).toBeGreaterThanOrEqual(ABSOLUTE_FLOOR_SAMPLES_PER_SECOND);
    }
  );

  it('is at least 3x faster than the naive per-tap resampler on 44.1 -> 48 kHz', () => {
    const pcm = makePcm(44100).subarray(0, 44100 * CHANNELS);
    const speed = (fn: () => Int16Array): number => {
      let best = 0;
      for (let pass = 0; pass < TIMED_PASSES; pass++) {
        const start = performance.now();
        const out = fn();
        best = Math.max(best, out.length / ((performance.now() - start) / MS_PER_SECOND));
      }
      return best;
    };
    resampleAudioSinc(pcm, 44100, 48000, CHANNELS);
    const fast = speed(() => resampleAudioSinc(pcm, 44100, 48000, CHANNELS));
    const naive = speed(() => naiveSincResample(pcm, 44100, 48000, CHANNELS));
    expect(fast / naive, `fast ${(fast / 1e6).toFixed(2)} M/s, naive ${(naive / 1e6).toFixed(2)} M/s`).toBeGreaterThanOrEqual(
      MIN_SPEEDUP_OVER_NAIVE
    );
  });
});
