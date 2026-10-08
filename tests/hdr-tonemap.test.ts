import { describe, expect, it } from 'vitest';
import { BT2020_PRIMARIES, BT709_PRIMARIES, primariesToPrimaries } from '../src/lib/conversions/colour-primaries';
import {
  PQ_PEAK_NITS,
  SDR_PEAK_NITS,
  createBt2390Eetf,
  hlgPixelToNits,
  nitsToPqSignal,
  pqSignalToNits,
  toneMapToSdr,
} from '../src/lib/conversions/hdr-tonemap';
import { HAS_ZSCALE, runFloatFilter, tagRgb } from './helpers/zimg-oracle';
import { skipUnless } from './helpers/strict-skip';

/**
 * Independent oracles: the BT.2390 formula is re-written here from ITU-R BT.2390-10 section 5.4 with the full
 * black-level terms and decimal ST 2084 constants; PQ, HLG and the whole tone-mapping chain are checked against
 * FFmpeg's zscale (zimg) and lutrgb, which share no code with the project.
 */

const M1 = 0.1593017578125;
const M2 = 78.84375;
const C1 = 0.8359375;
const C2 = 18.8515625;
const C3 = 18.6875;
const pq = (nits: number): number => ((C1 + C2 * (nits / 10000) ** M1) / (1 + C3 * (nits / 10000) ** M1)) ** M2;

/** ITU-R BT.2390-10 section 5.4, written out with source black Lb, source white Lw and target Lmin, Lmax in nits. */
function referenceEetf(signal: number, lb: number, lw: number, lmin: number, lmax: number): number {
  const lbPq = pq(lb);
  const lwPq = pq(lw);
  const e1 = (signal - lbPq) / (lwPq - lbPq);
  const minLum = (pq(lmin) - lbPq) / (lwPq - lbPq);
  const maxLum = (pq(lmax) - lbPq) / (lwPq - lbPq);
  const ks = 1.5 * maxLum - 0.5;
  let e2 = e1;
  if (e1 >= ks) {
    const t = (e1 - ks) / (1 - ks);
    e2 = (2 * t ** 3 - 3 * t ** 2 + 1) * ks + (t ** 3 - 2 * t ** 2 + t) * (1 - ks) + (-2 * t ** 3 + 3 * t ** 2) * maxLum;
  }
  const e3 = e2 + minLum * (1 - e2) ** 4;
  return e3 * (lwPq - lbPq) + lbPq;
}

const RAMP_SAMPLES = 1000;
const FULL_SCALE_16 = 65_535;

describe('BT.2390 EETF', () => {
  it.each([1000, 4000, 10_000])('matches the published formula on a %i-sample PQ ramp for a %i nit source', (sourcePeak) => {
    const eetf = createBt2390Eetf({ sourcePeakNits: sourcePeak, targetPeakNits: SDR_PEAK_NITS });
    const sourcePq = pq(sourcePeak);
    let worst = 0;
    for (let i = 0; i < RAMP_SAMPLES; i += 1) {
      const signal = (i / (RAMP_SAMPLES - 1)) * sourcePq;
      worst = Math.max(worst, Math.abs(eetf(signal) - referenceEetf(signal, 0, sourcePeak, 0, SDR_PEAK_NITS)));
    }
    expect(worst).toBeLessThanOrEqual(1e-4);
  });

  it('maps the source peak to the target peak and leaves values below the knee untouched', () => {
    const eetf = createBt2390Eetf({ sourcePeakNits: 1000, targetPeakNits: 100 });
    expect(pqSignalToNits(eetf(nitsToPqSignal(1000)))).toBeCloseTo(100, 3);
    const belowKnee = nitsToPqSignal(10);
    expect(eetf(belowKnee)).toBe(belowKnee);
    // the spline is monotonic and continuous at the knee
    let previous = -1;
    for (let i = 0; i <= RAMP_SAMPLES; i += 1) {
      const out = eetf((i / RAMP_SAMPLES) * nitsToPqSignal(1000));
      expect(out).toBeGreaterThanOrEqual(previous);
      previous = out;
    }
  });

  it('rejects non-positive peaks with a RangeError', () => {
    expect(() => createBt2390Eetf({ sourcePeakNits: 0, targetPeakNits: 100 })).toThrow(RangeError);
    expect(() => createBt2390Eetf({ sourcePeakNits: 1000, targetPeakNits: -1 })).toThrow(/positive/);
  });
});

describe('ST 2084 reference points', () => {
  it('hits the values the standard publishes', () => {
    // ST 2084 / BT.2100 table: 10000 nits is signal 1.0, 100 nits is 0.5081, 1000 nits is 0.7518.
    expect(nitsToPqSignal(PQ_PEAK_NITS)).toBeCloseTo(1, 12);
    expect(nitsToPqSignal(100)).toBeCloseTo(0.508078, 5);
    expect(nitsToPqSignal(1000)).toBeCloseTo(0.751827, 5);
    expect(pqSignalToNits(nitsToPqSignal(37.5))).toBeCloseTo(37.5, 8);
  });
});

describe.skipIf(skipUnless('ffmpeg with zscale and lutrgb', HAS_ZSCALE))('against zimg', () => {
  const SAMPLES = 1000;

  it('PQ decoding matches zscale on 1000 signal values', () => {
    const rgb = new Float32Array(SAMPLES * 3);
    for (let i = 0; i < SAMPLES; i += 1) rgb.fill(i / (SAMPLES - 1), i * 3, i * 3 + 3);
    const linear = runFloatFilter(rgb, SAMPLES, 1, `${tagRgb('bt2020', 'smpte2084')},zscale=t=linear:npl=${PQ_PEAK_NITS}`);
    for (let i = 0; i < SAMPLES; i += 1) {
      const expected = pqSignalToNits(rgb[i * 3]);
      expect(Math.abs(linear[i * 3] * PQ_PEAK_NITS - expected)).toBeLessThanOrEqual(1e-3 + expected * 2e-4);
    }
  });

  it('the HLG system (inverse OETF plus 1000 nit OOTF) matches zscale on a grey ramp', () => {
    const rgb = new Float32Array(SAMPLES * 3);
    for (let i = 0; i < SAMPLES; i += 1) rgb.fill(i / (SAMPLES - 1), i * 3, i * 3 + 3);
    const oracle = runFloatFilter(rgb, SAMPLES, 1, `${tagRgb('bt2020', 'arib-std-b67')},zscale=t=linear:npl=1000`);
    const ours = new Float32Array(3);
    let worst = 0;
    for (let i = 0; i < SAMPLES; i += 1) {
      hlgPixelToNits(rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2], 1000, ours, 0);
      for (let c = 0; c < 3; c += 1) worst = Math.max(worst, Math.abs(ours[c] / 1000 - oracle[i * 3 + c]));
    }
    expect(worst).toBeLessThanOrEqual(2e-4);
  });

  it('HLG colours follow BT.2100 table 5 (luminance-based OOTF)', () => {
    // zscale applies the OOTF per component, so saturated colours are checked against BT.2100 values worked out
    // separately (Python: scene = inverse OETF, Ys = 0.2627 R + 0.6780 G + 0.0593 B, F = 1000 Ys^0.2 scene).
    const golden: Array<[number[], number[]]> = [
      [[0.8, 0.2, 0.1], [215.972689, 8.400733, 2.100183]],
      [[0.2, 0.8, 0.1], [9.989892, 256.828037, 2.497473]],
      [[0.1, 0.2, 0.9], [1.7881, 7.1524, 312.115127]],
      [[1, 0, 0], [765.406291, 0, 0]],
    ];
    const out = new Float32Array(3);
    for (const [signal, nits] of golden) {
      hlgPixelToNits(signal[0], signal[1], signal[2], 1000, out, 0);
      for (let c = 0; c < 3; c += 1) expect(out[c]).toBeCloseTo(nits[c], 3);
    }
  });

  /** BT.2390 as a lutrgb expression (16-bit PQ code values), built from the test-side constants above. */
  function eetfExpression(sourcePeak: number, targetPeak: number): string {
    const sp = pq(sourcePeak);
    const maxLum = pq(targetPeak) / sp;
    const ks = 1.5 * maxLum - 0.5;
    // lutrgb's own `maxval` is not the 16-bit full scale for this pixel format, so the code range is spelled out.
    const e1 = `min(val/${FULL_SCALE_16}/${sp},1)`;
    const t = `((${e1}-${ks})/${1 - ks})`;
    const spline = `((2*pow(${t},3)-3*pow(${t},2)+1)*${ks}+(pow(${t},3)-2*pow(${t},2)+${t})*${1 - ks}+(-2*pow(${t},3)+3*pow(${t},2))*${maxLum})`;
    return `clip(${FULL_SCALE_16}*${sp}*if(lt(${e1},${ks}),${e1},${spline}),0,${FULL_SCALE_16})`;
  }

  it('the whole chain (EETF per component, BT.2020 to BT.709, clip) matches zscale plus lutrgb within 3e-3', () => {
    const peak = 1000;
    // colours across the gamut and the range, in linear BT.2020 nits
    const rgb: number[] = [];
    const levels = [0, 5, 30, 100, 250, 600, 1000, 1500];
    for (const r of levels) for (const g of [0, 40, 400, 1000]) for (const b of [0, 90, 800]) rgb.push(r, g, b);
    const nits = Float32Array.from(rgb);
    const width = nits.length / 3;
    const expression = eetfExpression(peak, SDR_PEAK_NITS);
    // The input is clamped to the source peak by the expression (min(.., 1)), like the production table.
    const oracle = runFloatFilter(
      nits.map((value) => value / PQ_PEAK_NITS),
      width,
      1,
      [
        tagRgb('bt2020', 'linear'),
        `zscale=t=smpte2084:npl=${PQ_PEAK_NITS}`,
        'format=gbrp16le',
        `lutrgb=r='${expression}':g='${expression}':b='${expression}'`,
        'setparams=colorspace=gbr:range=pc',
        `zscale=t=linear:npl=${SDR_PEAK_NITS}:p=bt709`,
      ].join(','),
    );
    const ours = toneMapToSdr(nits, {
      sourcePeakNits: peak,
      targetPeakNits: SDR_PEAK_NITS,
      toBt709: primariesToPrimaries(BT2020_PRIMARIES, BT709_PRIMARIES),
    });
    let worst = 0;
    for (let i = 0; i < ours.length; i += 1) worst = Math.max(worst, Math.abs(ours[i] - Math.min(1, Math.max(0, oracle[i]))));
    expect(worst).toBeLessThanOrEqual(3e-3);
  });
});

describe('toneMapToSdr', () => {
  it('only clips when the source peak does not exceed the target peak', () => {
    const out = toneMapToSdr(Float32Array.from([50, 100, 250, 0, -3, 99]), { sourcePeakNits: 100, targetPeakNits: 100 });
    expect(Array.from(out)).toEqual([0.5, 1, 1, 0, 0, 0.99].map((v) => Math.fround(v)));
  });

  it('keeps neutral greys neutral and compresses everything above the knee', () => {
    const out = toneMapToSdr(Float32Array.from([1000, 1000, 1000, 5000, 5000, 5000]), { sourcePeakNits: 1000, targetPeakNits: 100 });
    expect(Array.from(out.slice(0, 3))).toEqual([1, 1, 1]);
    // the table clamps to the source peak, so a brighter pixel lands on the target peak too
    expect(Array.from(out.slice(3))).toEqual([1, 1, 1]);
  });

  it('the lookup table stays within 1e-4 of the exact EETF', () => {
    const eetf = createBt2390Eetf({ sourcePeakNits: 4000, targetPeakNits: 100 });
    const values = new Float32Array(3 * 2000);
    for (let i = 0; i < values.length; i += 1) values[i] = (i / values.length) ** 2 * 4000;
    const out = toneMapToSdr(values, { sourcePeakNits: 4000, targetPeakNits: 100 });
    let worst = 0;
    for (let i = 0; i < values.length; i += 1) {
      const exact = pqSignalToNits(eetf(nitsToPqSignal(values[i]))) / 100;
      worst = Math.max(worst, Math.abs(out[i] - Math.min(1, exact)));
    }
    expect(worst).toBeLessThanOrEqual(1e-4);
  });

  it('refuses samples that are not RGB triples', () => {
    expect(() => toneMapToSdr(new Float32Array(4), { sourcePeakNits: 1000, targetPeakNits: 100 })).toThrow(RangeError);
  });
});
