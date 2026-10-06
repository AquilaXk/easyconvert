import { describe, it, expect } from 'vitest';
import type { ResampleQuality } from '../src/lib/conversions/audio-resampler';
import { resampleAudioSinc } from '../src/lib/conversions/media';
import {
  aliasedBin,
  amplitudeSpectrum,
  maxSpurDb,
  snapToBin,
  snrDb,
  synthesizeTones,
  toDb,
  type Tone,
} from './helpers/audio-spectrum';
import { ffmpegResample } from './helpers/audio-resample-oracle';
import { oracleTest } from './helpers/oracle-test';

/**
 * Resampler quality, measured with an independent FFT (tests/helpers/audio-spectrum.ts) on
 * analytically synthesized tones, plus ffmpeg as an independent resampling oracle.
 *
 * Design targets (Kaiser-windowed bandlimited interpolation, Smith 2011; Kaiser 1974):
 *   - passband flat to 0.1 dB up to 0.9 x Nyquist of the lower rate,
 *   - everything above the lower Nyquist (aliases and images) at or below -90 dB.
 */

const FFT_SIZE = 16384;
/** Frames trimmed from each end of the output so the zero-padded edge transient is excluded. */
const EDGE_GUARD_FRAMES = 4096;
const STOPBAND_MAX_DB = -90;
/** The `high` preset targets 24-bit and float output. */
const HIGH_STOPBAND_MAX_DB = -130;
const PASSBAND_RIPPLE_MAX_DB = 0.1;
/** Required SNR margin to the oracle for 16-bit output (issue acceptance: within 1 dB). */
const ORACLE_SNR_MARGIN_DB = 1;
/** Sanity floor for the 16-bit pipeline (the oracle itself reads 80-87 dB on these signals). */
const MIN_S16_SNR_DB = 70;
const MIN_FLOAT_SNR_DB = 100;

interface RateCase {
  inRate: number;
  outRate: number;
}

const DOWN_CASES: RateCase[] = [
  { inRate: 48000, outRate: 44100 },
  { inRate: 96000, outRate: 44100 },
  { inRate: 44100, outRate: 22050 },
  { inRate: 48000, outRate: 16000 },
  { inRate: 192000, outRate: 48000 },
];
const UP_CASES: RateCase[] = [
  { inRate: 44100, outRate: 48000 },
  { inRate: 22050, outRate: 44100 },
  { inRate: 44100, outRate: 96000 },
  { inRate: 16000, outRate: 48000 },
  { inRate: 48000, outRate: 96000 },
];
const PASSBAND_FRACTIONS = [0.1, 0.5, 0.8, 0.9];
const TONE_AMPLITUDE = 0.5;

const label = (c: RateCase) => `${c.inRate} -> ${c.outRate}`;

/** Resample one bin-centred tone through the float path and return the analysis window. */
function resampleTone(
  c: RateCase,
  freq: number,
  quality: ResampleQuality = 'standard'
): { spectrum: Float64Array; toneBin: number } {
  const snapped = snapToBin(freq, c.outRate, FFT_SIZE);
  const outFrames = FFT_SIZE + 2 * EDGE_GUARD_FRAMES;
  const inFrames = Math.ceil((outFrames * c.inRate) / c.outRate) + 64;
  const tone: Tone = { freq: snapped.freq, amp: TONE_AMPLITUDE, phase: 0.3 };
  const input = Float32Array.from(synthesizeTones([tone], c.inRate, inFrames));
  const [out] = resampleAudioSinc([input], c.inRate, c.outRate, { quality });
  expect(out.length).toBeGreaterThanOrEqual(FFT_SIZE + 2 * EDGE_GUARD_FRAMES - 1);
  return {
    spectrum: amplitudeSpectrum(out, EDGE_GUARD_FRAMES, FFT_SIZE),
    toneBin: aliasedBin(snapped.freq, c.outRate, FFT_SIZE),
  };
}

describe('audio resampler quality (independent FFT)', () => {
  describe.each([...DOWN_CASES, ...UP_CASES])('passband $inRate -> $outRate', (c) => {
    const nyquistLow = Math.min(c.inRate, c.outRate) / 2;
    it.each(PASSBAND_FRACTIONS)('is flat within 0.1 dB with no spurs above -90 dB at %f x Nyquist', (fraction) => {
      const { spectrum, toneBin } = resampleTone(c, fraction * nyquistLow);
      const gainDb = toDb(spectrum[toneBin] / TONE_AMPLITUDE);
      expect(Math.abs(gainDb), `${label(c)} gain at ${fraction} x Nyquist: ${gainDb.toFixed(3)} dB`).toBeLessThanOrEqual(
        PASSBAND_RIPPLE_MAX_DB
      );
      const spurDb = maxSpurDb(spectrum, [toneBin], 1) - toDb(TONE_AMPLITUDE);
      expect(spurDb, `${label(c)} spur/image at ${fraction} x Nyquist: ${spurDb.toFixed(1)} dB`).toBeLessThanOrEqual(
        STOPBAND_MAX_DB
      );
    });
  });

  describe.each(DOWN_CASES)('stopband $inRate -> $outRate', (c) => {
    const nyquistLow = c.outRate / 2;
    const nyquistIn = c.inRate / 2;
    const stopTones = [
      1.01 * nyquistLow,
      (nyquistLow + nyquistIn) / 2,
      nyquistLow + 0.99 * (nyquistIn - nyquistLow),
    ];
    it.each(stopTones)('leaves no alias above -90 dB for the %f Hz input tone', (freq) => {
      const { spectrum } = resampleTone(c, freq);
      const aliasDb = maxSpurDb(spectrum, [], 0) - toDb(TONE_AMPLITUDE);
      expect(aliasDb, `${label(c)} alias of ${freq.toFixed(0)} Hz: ${aliasDb.toFixed(1)} dB`).toBeLessThanOrEqual(
        STOPBAND_MAX_DB
      );
    });
  });

  describe.each([...DOWN_CASES, ...UP_CASES])('high preset $inRate -> $outRate', (c) => {
    const nyquistLow = Math.min(c.inRate, c.outRate) / 2;
    it('keeps the passband flat and every alias, image and spur below -130 dB', () => {
      const passband = resampleTone(c, 0.9 * nyquistLow, 'high');
      const gainDb = toDb(passband.spectrum[passband.toneBin] / TONE_AMPLITUDE);
      expect(Math.abs(gainDb), `${label(c)} high gain at 0.9 x Nyquist: ${gainDb.toFixed(4)} dB`).toBeLessThanOrEqual(
        PASSBAND_RIPPLE_MAX_DB
      );
      const spurDb = maxSpurDb(passband.spectrum, [passband.toneBin], 1) - toDb(TONE_AMPLITUDE);
      expect(spurDb, `${label(c)} high spur/image: ${spurDb.toFixed(1)} dB`).toBeLessThanOrEqual(HIGH_STOPBAND_MAX_DB);
      if (c.inRate > c.outRate) {
        const alias = resampleTone(c, 1.01 * nyquistLow, 'high');
        const aliasDb = maxSpurDb(alias.spectrum, [], 0) - toDb(TONE_AMPLITUDE);
        expect(aliasDb, `${label(c)} high alias at 1.01 x Nyquist: ${aliasDb.toFixed(1)} dB`).toBeLessThanOrEqual(
          HIGH_STOPBAND_MAX_DB
        );
      }
    });
  });
});

// ---------------------------------------------------------------------------------------------
// SNR against the oracle on tones and a multi-tone signal
// ---------------------------------------------------------------------------------------------

const SNR_DURATION_SECONDS = 1;
const SNR_EDGE_GUARD_FRAMES = 4096;
const INT16_FULL_SCALE = 32767;
const SNR_CASES: RateCase[] = [
  { inRate: 44100, outRate: 48000 },
  { inRate: 48000, outRate: 44100 },
  { inRate: 96000, outRate: 44100 },
  { inRate: 44100, outRate: 22050 },
  { inRate: 192000, outRate: 48000 },
  { inRate: 44100, outRate: 96000 },
  { inRate: 16000, outRate: 48000 },
];
const SINGLE_TONE: Tone[] = [{ freq: 1000, amp: 0.5, phase: 0.2 }];
/** Multi-tone frequencies as fractions of the lower Nyquist, so every tone is in the passband. */
const MULTI_TONE_FRACTIONS = [0.03, 0.17, 0.35, 0.6, 0.85];
const MULTI_TONE_AMPLITUDE = 0.12;
const MULTI_TONE_PHASES = [0.1, 1.1, 2.3, 0.7, 4.0];
const SINGLE_TONE_RIGHT: Tone = { freq: 2500, amp: 0.4, phase: 1.0 };

function multiTone(nyquistLow: number, reverse: boolean): Tone[] {
  const tones = MULTI_TONE_FRACTIONS.map((fraction, i) => ({
    freq: Math.round(fraction * nyquistLow),
    amp: MULTI_TONE_AMPLITUDE,
    phase: MULTI_TONE_PHASES[i],
  }));
  return reverse ? tones.reverse() : tones;
}

function signalsFor(c: RateCase): Array<{ name: string; left: Tone[]; right: Tone[] }> {
  const nyquistLow = Math.min(c.inRate, c.outRate) / 2;
  return [
    { name: 'single tone', left: SINGLE_TONE, right: [SINGLE_TONE_RIGHT] },
    { name: 'multi-tone', left: multiTone(nyquistLow, false), right: multiTone(nyquistLow, true) },
  ];
}

function deinterleave(samples: ArrayLike<number>, channels: number, channel: number): Float64Array {
  const frames = Math.floor(samples.length / channels);
  const out = new Float64Array(frames);
  for (let i = 0; i < frames; i++) out[i] = samples[i * channels + channel];
  return out;
}

describe('audio resampler SNR versus the reference resampler', () => {
  describe.each(SNR_CASES)('$inRate -> $outRate', (c) => {
    describe.each(signalsFor(c))('$name', (signal) => {
      const inFrames = Math.round(c.inRate * SNR_DURATION_SECONDS);
      const idealFrames = Math.floor((inFrames * c.outRate) / c.inRate);
      const idealLeft = synthesizeTones(signal.left, c.outRate, idealFrames);
      const idealRight = synthesizeTones(signal.right, c.outRate, idealFrames);
      const trimmed = idealFrames - 2 * SNR_EDGE_GUARD_FRAMES;

      const inLeft = synthesizeTones(signal.left, c.inRate, inFrames);
      const inRight = synthesizeTones(signal.right, c.inRate, inFrames);

      oracleTest(
        'matches the oracle SNR within 1 dB for 16-bit stereo output',
        ['ffmpeg'],
        () => {
          const pcm = new Int16Array(inFrames * 2);
          for (let i = 0; i < inFrames; i++) {
            pcm[2 * i] = Math.round(inLeft[i] * INT16_FULL_SCALE);
            pcm[2 * i + 1] = Math.round(inRight[i] * INT16_FULL_SCALE);
          }
          const ours = resampleAudioSinc(pcm, c.inRate, c.outRate, 2);
          const oracleBytes = ffmpegResample({
            inRate: c.inRate,
            outRate: c.outRate,
            channels: 2,
            input: Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength),
            inFormat: 's16le',
            outFormat: 's16le',
            dither: true,
          });
          const theirs = new Int16Array(oracleBytes.buffer, oracleBytes.byteOffset, oracleBytes.byteLength / 2);

          const scaleIdeal = (ideal: Float64Array) => ideal.map((v) => v * INT16_FULL_SCALE);
          for (const [channel, ideal] of [
            [0, scaleIdeal(idealLeft)],
            [1, scaleIdeal(idealRight)],
          ] as const) {
            const oursSnr = snrDb(ideal, deinterleave(ours, 2, channel), SNR_EDGE_GUARD_FRAMES, trimmed);
            const theirsSnr = snrDb(ideal, deinterleave(theirs, 2, channel), SNR_EDGE_GUARD_FRAMES, trimmed);
            const context = `${label(c)} ${signal.name} ch${channel}: ours ${oursSnr.toFixed(2)} dB, oracle ${theirsSnr.toFixed(2)} dB`;
            expect(oursSnr, context).toBeGreaterThanOrEqual(MIN_S16_SNR_DB);
            expect(oursSnr, context).toBeGreaterThanOrEqual(theirsSnr - ORACLE_SNR_MARGIN_DB);
          }
        }
      );

      oracleTest('keeps the float-path SNR above 100 dB against the analytic signal', ['ffmpeg'], () => {
        const left = Float32Array.from(inLeft);
        const right = Float32Array.from(inRight);
        const [outL, outR] = resampleAudioSinc([left, right], c.inRate, c.outRate);
        const interleaved = new Float32Array(inFrames * 2);
        for (let i = 0; i < inFrames; i++) {
          interleaved[2 * i] = left[i];
          interleaved[2 * i + 1] = right[i];
        }
        const oracleBytes = ffmpegResample({
          inRate: c.inRate,
          outRate: c.outRate,
          channels: 2,
          input: Buffer.from(interleaved.buffer),
          inFormat: 'f32le',
          outFormat: 'f32le',
        });
        const theirs = new Float32Array(oracleBytes.buffer, oracleBytes.byteOffset, oracleBytes.byteLength / 4);
        const pairs: Array<[number, Float64Array, Float32Array]> = [
          [0, idealLeft, outL],
          [1, idealRight, outR],
        ];
        for (const [channel, ideal, out] of pairs) {
          const oursSnr = snrDb(ideal, out, SNR_EDGE_GUARD_FRAMES, trimmed);
          const theirsSnr = snrDb(ideal, deinterleave(theirs, 2, channel), SNR_EDGE_GUARD_FRAMES, trimmed);
          expect(
            oursSnr,
            `${label(c)} ${signal.name} ch${channel}: ours ${oursSnr.toFixed(1)} dB, oracle ${theirsSnr.toFixed(1)} dB`
          ).toBeGreaterThanOrEqual(MIN_FLOAT_SNR_DB);
        }
      });
    });
  });
});

// ---------------------------------------------------------------------------------------------
// Throughput regression floor
// ---------------------------------------------------------------------------------------------

const THROUGHPUT_CHANNELS = 2;
const THROUGHPUT_SECONDS = 3;
const THROUGHPUT_WARMUP_PASSES = 2;
const THROUGHPUT_TIMED_PASSES = 3;
const MS_PER_SECOND = 1000;
const THROUGHPUT_LCG_MULTIPLIER = 1664525;
const THROUGHPUT_LCG_INCREMENT = 1013904223;
const UINT32_RANGE = 4294967296;
const SIGNAL_SPAN = 16000;

interface ThroughputCase extends RateCase {
  /** Regression floor in output samples (frames x channels) per second. */
  floor: number;
  /** Median on the development VM in M output samples/s, previous single-stage design in brackets. */
  measured: string;
}

/**
 * Stereo 16-bit input with the default (96 dB) filter. The issue target is 20 M samples/s; the
 * development VM tops out near 1.0 GMAC/s of scalar JavaScript multiply-accumulate, which puts the
 * single-stage 44.1 <-> 48 kHz case (about 124 taps per output sample) at roughly 7 to 8 M
 * samples/s. The floor is about 70% of the measured value for that case (about 55% for the other
 * paths, which tier up later) and applies to the best of several passes, so shared CI runners and
 * parallel test files do not trip it, while a return to per-tap sin/cos, per-sample allocation or an
 * inliner-dependent hot loop (which cost a third) still does.
 */
const THROUGHPUT_CASES: ThroughputCase[] = [
  { inRate: 44100, outRate: 48000, floor: 5_000_000, measured: '7.3 (5.8)' },
  { inRate: 48000, outRate: 44100, floor: 5_000_000, measured: '7.4 (5.7)' },
  { inRate: 96000, outRate: 44100, floor: 2_400_000, measured: '4.3 (3.1) half-band + polyphase' },
  { inRate: 44100, outRate: 22050, floor: 2_400_000, measured: '4.3 (3.4) folded 2:1 rows' },
  { inRate: 48000, outRate: 16000, floor: 2_300_000, measured: '4.3 (2.2) half-band + folded rows' },
  { inRate: 16000, outRate: 48000, floor: 6_000_000, measured: '11.9 (4.2) polyphase + half-band' },
  { inRate: 192000, outRate: 48000, floor: 2_000_000, measured: '3.6 (1.8) half-band + folded rows' },
];

describe('audio resampler throughput', () => {
  it.each(THROUGHPUT_CASES)(
    'sustains the regression-floor throughput on stereo $inRate -> $outRate (measured $measured M samples/s)',
    ({ inRate, outRate, floor }) => {
      const frames = inRate * THROUGHPUT_SECONDS;
      const pcm = new Int16Array(frames * THROUGHPUT_CHANNELS);
      let state = 1;
      for (let i = 0; i < pcm.length; i++) {
        state = (Math.imul(state, THROUGHPUT_LCG_MULTIPLIER) + THROUGHPUT_LCG_INCREMENT) >>> 0;
        pcm[i] = Math.round((state / UINT32_RANGE - 0.5) * SIGNAL_SPAN);
      }
      // Warm up the JIT (every kernel the case uses) and the cached coefficient tables.
      for (let pass = 0; pass < THROUGHPUT_WARMUP_PASSES; pass++) {
        resampleAudioSinc(pcm, inRate, outRate, THROUGHPUT_CHANNELS);
      }

      let samplesPerSecond = 0;
      let outLength = 0;
      for (let pass = 0; pass < THROUGHPUT_TIMED_PASSES; pass++) {
        const start = performance.now();
        const out = resampleAudioSinc(pcm, inRate, outRate, THROUGHPUT_CHANNELS);
        const seconds = (performance.now() - start) / MS_PER_SECOND;
        samplesPerSecond = Math.max(samplesPerSecond, out.length / seconds);
        outLength = out.length;
      }
      expect(outLength).toBe(Math.floor((frames * outRate) / inRate) * THROUGHPUT_CHANNELS);
      expect(samplesPerSecond, `measured ${(samplesPerSecond / 1e6).toFixed(2)} M output samples/s`).toBeGreaterThanOrEqual(
        floor
      );
    }
  );
});
