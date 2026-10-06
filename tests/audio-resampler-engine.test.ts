import { describe, it, expect } from 'vitest';
import {
  AudioResampleError,
  MAX_RESAMPLE_CHANNELS,
  MAX_RESAMPLE_RATIO,
  describeResamplerPlan,
  resamplePlanarFloat,
  resampleInterleavedInt16,
  resamplerPlanCacheSize,
  MAX_RESAMPLER_PLAN_CACHE_ENTRIES,
} from '../src/lib/conversions/audio-resampler';
import { convertFile } from '../src/lib/conversions/index';
import {
  aliasedBin,
  amplitudeSpectrum,
  maxSpurDb,
  snapToBin,
  synthesizeTones,
  toDb,
} from './helpers/audio-spectrum';

/**
 * Engine behaviour of the polyphase resampler: design formulas, exact rational stepping,
 * TPDF dither, fail-closed validation and the WAV pipeline integration. Expected values come
 * from closed-form signals and the Kaiser design equations, never from the module itself.
 */

const INT16_LSB = 1;
const SAMPLE_RATE_44K = 44100;
const SAMPLE_RATE_48K = 48000;

function tone(freq: number, rate: number, frames: number, amp = 0.5, phase = 0.4): Float32Array {
  return Float32Array.from(synthesizeTones([{ freq, amp, phase }], rate, frames));
}

describe('filter design (Kaiser 1974 formulas)', () => {
  // standard preset: A = 96 dB, transition 0.1 x lower Nyquist = 0.05 cycles/sample at ratio >= 1
  const attenuationDb = 96;
  const kaiserBeta = 0.1102 * (attenuationDb - 8.7);
  const kaiserTaps = (ratio: number) =>
    (attenuationDb - 8) / (2.285 * 2 * Math.PI * 0.05 * Math.min(1, ratio));
  const TAP_ROUNDING_MARGIN = 8;

  it('reduces 44.1 kHz -> 48 kHz to the exact rational 160/147 and sizes taps from the Kaiser formula', () => {
    const plan = describeResamplerPlan(SAMPLE_RATE_44K, SAMPLE_RATE_48K);
    expect(plan.upFactor).toBe(160);
    expect(plan.downFactor).toBe(147);
    expect(plan.mode).toBe('exact');
    expect(plan.phaseRows).toBe(160);
    expect(plan.tableEntries).toBe(160 * plan.taps);
    expect(plan.beta).toBeCloseTo(kaiserBeta, 6);
    expect(plan.taps % 4).toBe(0);
    expect(plan.taps).toBeGreaterThanOrEqual(kaiserTaps(1));
    expect(plan.taps).toBeLessThanOrEqual(kaiserTaps(1) + TAP_ROUNDING_MARGIN);
  });

  it('scales the filter length with 1 / cutoff when decimating', () => {
    // 44.1 kHz -> 22.05 kHz is an exact 2:1 ratio, which is not cascaded (see the half-band tests).
    const up = describeResamplerPlan(SAMPLE_RATE_44K, SAMPLE_RATE_48K);
    const down = describeResamplerPlan(SAMPLE_RATE_44K, 22050);
    expect(down.halfBandStages).toBe(0);
    expect(down.upFactor).toBe(1);
    expect(down.downFactor).toBe(2);
    expect(down.taps).toBeGreaterThanOrEqual(kaiserTaps(0.5));
    expect(down.taps).toBeLessThanOrEqual(kaiserTaps(0.5) + TAP_ROUNDING_MARGIN);
    expect(down.taps / up.taps).toBeGreaterThan(2 * 0.95);
  });

  describe('half-band cascades', () => {
    // A half-band stage is used while its transition band stays clear of the lower Nyquist, so
    // the polyphase stage keeps the remaining ratio in (1, 2] and the cascade never aliases.
    it.each([
      { src: 96000, tgt: 44100, stages: 1, polyUp: 147, polyDown: 160 },
      { src: 192000, tgt: 48000, stages: 1, polyUp: 1, polyDown: 2 },
      { src: 48000, tgt: 16000, stages: 1, polyUp: 2, polyDown: 3 },
      { src: 44100, tgt: 96000, stages: 1, polyUp: 160, polyDown: 147 },
      { src: 16000, tgt: 48000, stages: 1, polyUp: 3, polyDown: 2 },
    ])('plans $stages half-band stage for $src -> $tgt with a $polyUp/$polyDown polyphase remainder', (c) => {
      const plan = describeResamplerPlan(c.src, c.tgt);
      expect(plan.halfBandStages).toBe(c.stages);
      expect(plan.halfBandPairs).toHaveLength(c.stages);
      expect(plan.upFactor).toBe(c.polyUp);
      expect(plan.downFactor).toBe(c.polyDown);
      // The Kaiser estimate for a transition of 0.5 - lowerRate / stageRate cycles per sample
      // (A + 1 dB) is a lower bound: the planner grows the filter until its measured stopband
      // meets -A (tests/audio-resampler-halfband.test.ts checks the responses themselves).
      const stageRate = c.src > c.tgt ? c.src : c.tgt;
      const transition = 0.5 - Math.min(c.src, c.tgt) / stageRate;
      const length = (attenuationDb + 1 - 8) / (2.285 * 2 * Math.PI * transition);
      const pairs = plan.halfBandPairs[0];
      expect(pairs % 4).toBe(0);
      expect(pairs).toBeGreaterThanOrEqual((length + 1) / 4);
    });

    it('does not cascade where a half-band transition would have no width or cost more', () => {
      expect(describeResamplerPlan(44100, 22050).halfBandStages).toBe(0); // exactly 2:1
      expect(describeResamplerPlan(48000, 24000).halfBandStages).toBe(0);
      expect(describeResamplerPlan(44100, 48000).halfBandStages).toBe(0); // ratio below 2
      expect(describeResamplerPlan(22050, 44100).halfBandStages).toBe(0);
      expect(describeResamplerPlan(48000, 96000).halfBandStages).toBe(0);
    });

    it('chains several stages for large factors', () => {
      const plan = describeResamplerPlan(192000, 16000); // 12:1 -> 3 stages then 1.5:1
      expect(plan.halfBandStages).toBe(3);
      expect(plan.upFactor).toBe(2);
      expect(plan.downFactor).toBe(3);
    });
  });

  it('uses oversampled rows with linear interpolation for ratios with huge reduced denominators', () => {
    const plan = describeResamplerPlan(44101, SAMPLE_RATE_48K);
    expect(plan.upFactor).toBe(48000);
    expect(plan.downFactor).toBe(44101);
    expect(plan.mode).toBe('interpolated');
    expect(plan.tableEntries).toBe((plan.phaseRows + 1) * plan.taps);
    expect(plan.tableEntries).toBeLessThanOrEqual(2 ** 18 + plan.taps);
  });

  it('gives the high preset a longer, steeper filter than standard', () => {
    const standard = describeResamplerPlan(SAMPLE_RATE_44K, SAMPLE_RATE_48K, 'standard');
    const high = describeResamplerPlan(SAMPLE_RATE_44K, SAMPLE_RATE_48K, 'high');
    expect(high.beta).toBeCloseTo(0.1102 * (130 - 8.7), 6);
    expect(high.taps).toBeGreaterThan(standard.taps);
  });

  it('keeps the coefficient-table cache bounded', () => {
    const rates = [8000, 11025, 16000, 22050, 24000, 32000, 44100, 48000, 88200, 96000, 176400, 192000];
    for (const rate of rates) {
      if (rate !== SAMPLE_RATE_44K) describeResamplerPlan(SAMPLE_RATE_44K, rate);
    }
    expect(resamplerPlanCacheSize()).toBeLessThanOrEqual(MAX_RESAMPLER_PLAN_CACHE_ENTRIES);
  });
});

describe('exact rational stepping', () => {
  it.each([
    { name: 'exact 160/147 table', inRate: SAMPLE_RATE_44K, outRate: SAMPLE_RATE_48K },
    { name: 'oversampled 48000/44101 table', inRate: 44101, outRate: SAMPLE_RATE_48K },
    { name: 'decimating cascade 96 kHz -> 44.1 kHz', inRate: 96000, outRate: SAMPLE_RATE_44K },
    { name: 'interpolating cascade 44.1 kHz -> 96 kHz', inRate: SAMPLE_RATE_44K, outRate: 96000 },
    { name: 'folded 2:1 rows 44.1 kHz -> 22.05 kHz', inRate: SAMPLE_RATE_44K, outRate: 22050 },
    { name: 'folded 1:2 rows 22.05 kHz -> 44.1 kHz', inRate: 22050, outRate: SAMPLE_RATE_44K },
    { name: 'three-stage cascade 192 kHz -> 16 kHz', inRate: 192000, outRate: 16000 },
  ])('tracks the analytic tone over a long signal and across block seams: $name', ({ inRate, outRate }) => {
    const inFrames = inRate * 8;
    const freq = 1000;
    const input = tone(freq, inRate, inFrames);
    const [out] = resamplePlanarFloat([input], inRate, outRate);
    expect(out.length).toBe(Math.floor((inFrames * outRate) / inRate));
    const guard = 4096;
    const ideal = synthesizeTones([{ freq, amp: 0.5, phase: 0.4 }], outRate, out.length);
    let worst = 0;
    for (let i = guard; i < out.length - guard; i++) worst = Math.max(worst, Math.abs(out[i] - ideal[i]));
    // Float32 input rounding (~6e-8) plus a -100 dB-class filter leaves well under 1e-5 of peak.
    expect(worst, `max deviation ${worst.toExponential(2)}`).toBeLessThan(1e-5);
  });

  it.each([
    { inRate: SAMPLE_RATE_44K, outRate: SAMPLE_RATE_48K },
    { inRate: 96000, outRate: SAMPLE_RATE_44K },
    { inRate: SAMPLE_RATE_44K, outRate: 96000 },
    { inRate: SAMPLE_RATE_44K, outRate: 22050 },
    { inRate: 22050, outRate: SAMPLE_RATE_44K },
    { inRate: 16000, outRate: SAMPLE_RATE_48K },
  ])('produces identical channels in the mono, stereo and multichannel kernels: $inRate -> $outRate', ({ inRate, outRate }) => {
    const frames = 20000;
    const channelsIn = [
      tone(1000, inRate, frames),
      tone(3100, inRate, frames, 0.3, 1.1),
      tone(7000, inRate, frames, 0.2, 2.0),
    ];
    const [mono0, mono1, mono2] = channelsIn.map((c) => resamplePlanarFloat([c], inRate, outRate)[0]);
    const stereo = resamplePlanarFloat(channelsIn.slice(0, 2), inRate, outRate);
    const triple = resamplePlanarFloat(channelsIn, inRate, outRate);
    const KERNEL_ORDER_TOLERANCE = 1e-6;
    expect(mono0.length).toBe(Math.floor((frames * outRate) / inRate));
    for (let i = 0; i < mono0.length; i++) {
      expect(Math.abs(stereo[0][i] - mono0[i])).toBeLessThan(KERNEL_ORDER_TOLERANCE);
      expect(Math.abs(stereo[1][i] - mono1[i])).toBeLessThan(KERNEL_ORDER_TOLERANCE);
      expect(Math.abs(triple[2][i] - mono2[i])).toBeLessThan(KERNEL_ORDER_TOLERANCE);
    }
  });

  it('returns the input unchanged for equal rates and an empty result for empty input', () => {
    const pcm = Int16Array.from([1, -2, 3, -4]);
    expect(resampleInterleavedInt16(pcm, SAMPLE_RATE_44K, SAMPLE_RATE_44K, 2)).toBe(pcm);
    expect(resampleInterleavedInt16(new Int16Array(0), SAMPLE_RATE_44K, SAMPLE_RATE_48K, 2).length).toBe(0);
    expect(resamplePlanarFloat([new Float32Array(0)], SAMPLE_RATE_44K, SAMPLE_RATE_48K)[0].length).toBe(0);
  });
});

describe('TPDF dither', () => {
  const DC_LEVEL = 1000;
  const FRAMES = 60000;
  const TOLERANCE = 0.01;

  function dcInt16(channels: number): Int16Array {
    return new Int16Array(FRAMES * channels).fill(DC_LEVEL);
  }

  it('is deterministic for a seed and changes with the seed', () => {
    const pcm = Int16Array.from({ length: 4000 }, (_, i) => Math.round(Math.sin(i / 7) * 9000));
    const a = resampleInterleavedInt16(pcm, SAMPLE_RATE_44K, SAMPLE_RATE_48K, 2, { ditherSeed: 7 });
    const b = resampleInterleavedInt16(pcm, SAMPLE_RATE_44K, SAMPLE_RATE_48K, 2, { ditherSeed: 7 });
    const c = resampleInterleavedInt16(pcm, SAMPLE_RATE_44K, SAMPLE_RATE_48K, 2, { ditherSeed: 8 });
    expect(Array.from(a)).toEqual(Array.from(b));
    expect(Array.from(a)).not.toEqual(Array.from(c));
  });

  it('adds triangular noise of 1/4 LSB^2 variance with probability 1/8 of each +-1 step on an integer DC input', () => {
    const out = resampleInterleavedInt16(dcInt16(1), SAMPLE_RATE_44K, SAMPLE_RATE_48K, 1);
    const trim = out.subarray(2000, out.length - 2000);
    let plus = 0;
    let minus = 0;
    let sum = 0;
    let sumSq = 0;
    for (const v of trim) {
      const e = (v - DC_LEVEL) / INT16_LSB;
      expect(Math.abs(e)).toBeLessThanOrEqual(1);
      if (e === 1) plus++;
      if (e === -1) minus++;
      sum += e;
      sumSq += e * e;
    }
    const n = trim.length;
    // P(|d| > 1/2) = 1/4 for the triangular density, split evenly over the two signs.
    expect(plus / n).toBeGreaterThan(0.125 - TOLERANCE);
    expect(plus / n).toBeLessThan(0.125 + TOLERANCE);
    expect(minus / n).toBeGreaterThan(0.125 - TOLERANCE);
    expect(minus / n).toBeLessThan(0.125 + TOLERANCE);
    expect(Math.abs(sum / n)).toBeLessThan(TOLERANCE);
    expect(sumSq / n).toBeGreaterThan(0.25 - TOLERANCE);
    expect(sumSq / n).toBeLessThan(0.25 + TOLERANCE);
  });

  it('keeps the error variance at 1/4 LSB^2 and the mean unbiased for sub-LSB float levels', () => {
    const lsb = 2 / 2 ** 16;
    for (const level of [0, 0.5 * lsb, 0.25 * lsb]) {
      const input = new Float32Array(FRAMES).fill(level);
      const [out] = resamplePlanarFloat([input], SAMPLE_RATE_44K, SAMPLE_RATE_48K, { outputBitDepth: 16 });
      const trim = out.subarray(2000, out.length - 2000);
      let sum = 0;
      let sumSq = 0;
      for (const v of trim) {
        expect(Math.abs(Math.round(v / lsb) - v / lsb)).toBeLessThan(1e-3); // on the 16-bit grid
        const e = (v - level) / lsb;
        sum += e;
        sumSq += e * e;
      }
      const n = trim.length;
      expect(Math.abs(sum / n), `mean error at ${level / lsb} LSB`).toBeLessThan(TOLERANCE);
      expect(sumSq / n, `variance at ${level / lsb} LSB`).toBeGreaterThan(0.25 - TOLERANCE);
      expect(sumSq / n, `variance at ${level / lsb} LSB`).toBeLessThan(0.25 + TOLERANCE);
    }
  });

  it('draws independent noise for every channel', () => {
    const out = resampleInterleavedInt16(dcInt16(2), SAMPLE_RATE_44K, SAMPLE_RATE_48K, 2);
    let cross = 0;
    let left = 0;
    let right = 0;
    for (let i = 4000; i < out.length - 4000; i += 2) {
      const l = out[i] - DC_LEVEL;
      const r = out[i + 1] - DC_LEVEL;
      cross += l * r;
      left += l * l;
      right += r * r;
    }
    expect(Math.abs(cross / Math.sqrt(left * right))).toBeLessThan(0.02);
  });

  it('quantises 8-bit output to the 8-bit grid and never exceeds the 8-bit range', () => {
    const eightBitStep = 256;
    const pcm = Int16Array.from({ length: 6000 }, (_, i) => Math.round(Math.sin(i / 5) * 32767));
    const out = resampleInterleavedInt16(pcm, SAMPLE_RATE_44K, SAMPLE_RATE_48K, 1, { outputBitDepth: 8 });
    for (const v of out) {
      expect(Math.abs(v % eightBitStep)).toBe(0);
      expect(v).toBeGreaterThanOrEqual(-32768);
      expect(v).toBeLessThanOrEqual(127 * eightBitStep);
    }
  });

  it('never wraps around at full scale', () => {
    const pcm = new Int16Array(8000).fill(32767);
    const out = resampleInterleavedInt16(pcm, SAMPLE_RATE_44K, SAMPLE_RATE_48K, 1);
    for (let i = 600; i < out.length - 600; i++) expect(out[i]).toBeGreaterThanOrEqual(32766);
  });

  it.each([24, 32, 'float'] as const)('leaves %s output undithered and independent of the seed', (depth) => {
    const input = tone(1000, SAMPLE_RATE_44K, 8000);
    const a = resamplePlanarFloat([input], SAMPLE_RATE_44K, SAMPLE_RATE_48K, { outputBitDepth: depth, ditherSeed: 1 })[0];
    const b = resamplePlanarFloat([input], SAMPLE_RATE_44K, SAMPLE_RATE_48K, { outputBitDepth: depth, ditherSeed: 2 })[0];
    expect(Array.from(a)).toEqual(Array.from(b));
    // Not on any coarse grid: a 16-bit quantiser would put every value on a multiple of 2^-15.
    const lsb16 = 2 ** -15;
    let offGrid = 0;
    for (const v of a) if (Math.abs(Math.round(v / lsb16) - v / lsb16) > 0.01) offGrid++;
    expect(offGrid).toBeGreaterThan(a.length * 0.9);
  });
});

describe('fail-closed validation', () => {
  const pcm = new Int16Array(64);
  const plane = new Float32Array(64);

  it.each([
    ['zero source rate', 0, SAMPLE_RATE_48K],
    ['fractional target rate', SAMPLE_RATE_44K, 48000.5],
    ['NaN rate', Number.NaN, SAMPLE_RATE_48K],
    ['rate below the minimum', 999, 8000],
    ['rate above the maximum', SAMPLE_RATE_44K, 768001],
    ['ratio beyond the limit', 192000, 2500],
  ])('rejects %s with a typed error', (_name, src, tgt) => {
    expect(() => resampleInterleavedInt16(pcm, src, tgt, 1)).toThrow(AudioResampleError);
    expect(() => resamplePlanarFloat([plane], src, tgt)).toThrow(AudioResampleError);
  });

  it('accepts the largest allowed ratio', () => {
    const out = resampleInterleavedInt16(new Int16Array(MAX_RESAMPLE_RATIO * 100), 64000, 1000, 1);
    expect(out.length).toBe(100);
  });

  it.each([0, 1.5, Number.NaN, MAX_RESAMPLE_CHANNELS + 1])('rejects channel count %s', (channels) => {
    expect(() => resampleInterleavedInt16(pcm, SAMPLE_RATE_44K, SAMPLE_RATE_48K, channels)).toThrow(AudioResampleError);
  });

  it('rejects interleaved data that is not a whole number of frames', () => {
    expect(() => resampleInterleavedInt16(new Int16Array(7), SAMPLE_RATE_44K, SAMPLE_RATE_48K, 2)).toThrow(
      /not a multiple of the channel count 2/
    );
  });

  it('rejects empty, ragged and non-finite planar input', () => {
    expect(() => resamplePlanarFloat([], SAMPLE_RATE_44K, SAMPLE_RATE_48K)).toThrow(/At least one audio channel/);
    expect(() => resamplePlanarFloat([plane, new Float32Array(10)], SAMPLE_RATE_44K, SAMPLE_RATE_48K)).toThrow(
      /same length/
    );
    const bad = new Float32Array(64);
    bad[20] = Number.NaN;
    expect(() => resamplePlanarFloat([bad], SAMPLE_RATE_44K, SAMPLE_RATE_48K)).toThrow(/Non-finite audio sample at frame 20/);
  });

  it('rejects unknown quality, unsupported Int16 depths and non-integer seeds', () => {
    expect(() =>
      resampleInterleavedInt16(pcm, SAMPLE_RATE_44K, SAMPLE_RATE_48K, 1, { quality: 'ultra' as never })
    ).toThrow(/Unknown resample quality/);
    expect(() =>
      resampleInterleavedInt16(pcm, SAMPLE_RATE_44K, SAMPLE_RATE_48K, 1, { outputBitDepth: 24 })
    ).toThrow(/supports 8 or 16 bit output/);
    expect(() =>
      resamplePlanarFloat([plane], SAMPLE_RATE_44K, SAMPLE_RATE_48K, { outputBitDepth: 12 as never })
    ).toThrow(/Unsupported output bit depth/);
    expect(() =>
      resampleInterleavedInt16(pcm, SAMPLE_RATE_44K, SAMPLE_RATE_48K, 1, { ditherSeed: 1.5 })
    ).toThrow(/seed must be an integer/);
  });
});

describe('WAV pipeline integration (pure engine)', () => {
  const FFT_SIZE = 16384;
  const GUARD = 4096;

  function wavFrom(samples: Int16Array, rate: number, channels: number): Buffer {
    const dataSize = samples.length * 2;
    const buffer = Buffer.alloc(44 + dataSize);
    buffer.write('RIFF', 0, 'ascii');
    buffer.writeUInt32LE(36 + dataSize, 4);
    buffer.write('WAVEfmt ', 8, 'ascii');
    buffer.writeUInt32LE(16, 16);
    buffer.writeUInt16LE(1, 20);
    buffer.writeUInt16LE(channels, 22);
    buffer.writeUInt32LE(rate, 24);
    buffer.writeUInt32LE(rate * channels * 2, 28);
    buffer.writeUInt16LE(channels * 2, 32);
    buffer.writeUInt16LE(16, 34);
    buffer.write('data', 36, 'ascii');
    buffer.writeUInt32LE(dataSize, 40);
    for (let i = 0; i < samples.length; i++) buffer.writeInt16LE(samples[i], 44 + i * 2);
    return buffer;
  }

  it('converts 96 kHz stereo WAV to 44.1 kHz with a flat tone and no alias or image above -90 dB', async () => {
    const inRate = 96000;
    const outRate = SAMPLE_RATE_44K;
    const inFrames = Math.ceil(((FFT_SIZE + 2 * GUARD) * inRate) / outRate) + 64;
    const left = snapToBin(5000, outRate, FFT_SIZE);
    const right = snapToBin(30000, outRate, FFT_SIZE); // above the 22.05 kHz target Nyquist
    const amp = 0.5;
    const toneL = synthesizeTones([{ freq: left.freq, amp, phase: 0.2 }], inRate, inFrames);
    const toneR = synthesizeTones([{ freq: right.freq, amp, phase: 1.3 }], inRate, inFrames);
    const pcm = new Int16Array(inFrames * 2);
    for (let i = 0; i < inFrames; i++) {
      pcm[2 * i] = Math.round(toneL[i] * 32767);
      pcm[2 * i + 1] = Math.round(toneR[i] * 32767);
    }

    const result = await convertFile(
      wavFrom(pcm, inRate, 2),
      'wav',
      'wav',
      { audioSampleRate: outRate, disableNativeEngine: true },
      'tones.wav'
    );

    expect(result.buffer.readUInt32LE(24)).toBe(outRate);
    expect(result.buffer.readUInt16LE(22)).toBe(2);
    const outFrames = (result.buffer.length - 44) / 4;
    expect(outFrames).toBe(Math.floor((inFrames * outRate) / inRate));
    const outLeft = new Float64Array(outFrames);
    const outRight = new Float64Array(outFrames);
    for (let i = 0; i < outFrames; i++) {
      outLeft[i] = result.buffer.readInt16LE(44 + i * 4) / 32767;
      outRight[i] = result.buffer.readInt16LE(44 + i * 4 + 2) / 32767;
    }
    const specL = amplitudeSpectrum(outLeft, GUARD, FFT_SIZE);
    const specR = amplitudeSpectrum(outRight, GUARD, FFT_SIZE);
    const binL = aliasedBin(left.freq, outRate, FFT_SIZE);
    expect(Math.abs(toDb(specL[binL] / amp))).toBeLessThan(0.1);
    // 16-bit TPDF noise is about -132 dB per bin here; everything else must stay below -90 dB.
    expect(maxSpurDb(specL, [binL], 1) - toDb(amp)).toBeLessThan(-90);
    expect(maxSpurDb(specR, [], 0) - toDb(amp)).toBeLessThan(-90);
  });
});
