import { describe, it, expect } from 'vitest';
import { describeResamplerPlan, type ResampleQuality } from '../src/lib/conversions/audio-resampler';

/**
 * Every half-band stage the planner returns is checked against its own design goal with a
 * frequency response computed here from the returned coefficients (not by the module's own
 * verification): |H| <= -A dB over the stopband and 1 +- 10^(-A/20) over the passband.
 *
 * Half-band response (centre tap 1/2, even taps zero, taps symmetric):
 *   H(f) = 1/2 + 2 sum_p h(2p + 1) cos(2 pi f (2p + 1)),  f in cycles per sample of the stage rate.
 */

const ATTENUATION_DB: Record<ResampleQuality, number> = { standard: 96, high: 130 };
const GRID_POINTS = 8192;
const CENTER_TAP = 0.5;
const RATES = [8000, 11025, 16000, 22050, 32000, 44100, 48000, 88200, 96000, 176400, 192000];
const MAX_RATIO = 64;

function response(taps: Float64Array, f: number): number {
  let sum = CENTER_TAP;
  for (let p = 0; p < taps.length; p++) sum += 2 * taps[p] * Math.cos(2 * Math.PI * f * (2 * p + 1));
  return sum;
}

interface StageSpec {
  stageRate: number;
  lowerRate: number;
}

/** Rate each half-band stage runs at (its higher rate) for the plan of src -> tgt. */
function stageSpecs(src: number, tgt: number, stages: number): StageSpec[] {
  const lowerRate = Math.min(src, tgt);
  const specs: StageSpec[] = [];
  for (let j = 0; j < stages; j++) {
    const stageRate = src > tgt ? src / 2 ** j : tgt / 2 ** (stages - 1 - j);
    specs.push({ stageRate, lowerRate });
  }
  return specs;
}

function worstStopband(taps: Float64Array, spec: StageSpec): number {
  const passEdge = spec.lowerRate / (2 * spec.stageRate);
  let worst = 0;
  for (let i = 0; i <= GRID_POINTS; i++) {
    const f = 0.5 - passEdge + (passEdge * i) / GRID_POINTS;
    worst = Math.max(worst, Math.abs(response(taps, f)));
  }
  return worst;
}

function worstPassbandDeviation(taps: Float64Array, spec: StageSpec): number {
  const passEdge = spec.lowerRate / (2 * spec.stageRate);
  let worst = 0;
  for (let i = 0; i <= GRID_POINTS; i++) {
    worst = Math.max(worst, Math.abs(response(taps, (passEdge * i) / GRID_POINTS) - 1));
  }
  return worst;
}

describe('half-band stage responses', () => {
  it.each([
    // The cases the Kaiser length estimate alone got wrong (wide transition bands).
    { src: 192000, tgt: 16000, quality: 'standard' as const },
    { src: 96000, tgt: 8000, quality: 'standard' as const },
    { src: 48000, tgt: 4000, quality: 'standard' as const },
    { src: 16000, tgt: 192000, quality: 'standard' as const },
    { src: 8000, tgt: 96000, quality: 'standard' as const },
    { src: 8000, tgt: 44100, quality: 'high' as const },
    { src: 44100, tgt: 16000, quality: 'high' as const },
  ])('meets -A over the stopband for $src -> $tgt ($quality)', ({ src, tgt, quality }) => {
    const plan = describeResamplerPlan(src, tgt, quality);
    expect(plan.halfBandStages).toBeGreaterThan(0);
    const limit = 10 ** (-ATTENUATION_DB[quality] / 20);
    stageSpecs(src, tgt, plan.halfBandStages).forEach((spec, j) => {
      const worst = worstStopband(plan.halfBandTaps[j], spec);
      expect(worst, `stage ${j} at ${spec.stageRate} Hz: ${(20 * Math.log10(worst)).toFixed(1)} dB`).toBeLessThanOrEqual(
        limit
      );
    });
  });

  it.each(['standard', 'high'] as const)(
    'holds for every planned stage over a rate grid (%s): stopband <= -A, passband within 10^(-A/20)',
    (quality) => {
      const limit = 10 ** (-ATTENUATION_DB[quality] / 20);
      let stagesChecked = 0;
      for (const src of RATES) {
        for (const tgt of RATES) {
          const ratio = Math.max(src / tgt, tgt / src);
          if (src === tgt || ratio > MAX_RATIO) continue;
          const plan = describeResamplerPlan(src, tgt, quality);
          stageSpecs(src, tgt, plan.halfBandStages).forEach((spec, j) => {
            const taps = plan.halfBandTaps[j];
            const stop = worstStopband(taps, spec);
            const pass = worstPassbandDeviation(taps, spec);
            const where = `${src} -> ${tgt} stage ${j}`;
            expect(stop, `${where} stopband ${(20 * Math.log10(stop)).toFixed(1)} dB`).toBeLessThanOrEqual(limit);
            expect(pass, `${where} passband deviation ${pass.toExponential(2)}`).toBeLessThanOrEqual(limit);
            stagesChecked++;
          });
        }
      }
      expect(stagesChecked).toBeGreaterThan(20);
    },
    120_000
  );
});
