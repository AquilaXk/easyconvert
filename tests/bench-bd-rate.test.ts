import { describe, expect, it } from 'vitest';
import { bdPsnr, bdRate, type RdPoint } from '../bench/bd-rate';
import { BdRateInputError } from '../bench/errors';

/**
 * Worked example: the two four-point rate-distortion curves ("Sample 1") that ship with the public Bjontegaard
 * metric reference implementations of VCEG-M33 (G. Bjontegaard, "Calculation of average PSNR differences between
 * RD-curves", ITU-T SG16/Q6 VCEG-M33, 2001): rates in kbit/s, quality in dB PSNR.
 *
 * The expected values below are hand-entered. The published inputs carry no printed result, so the values come from
 * an independent evaluation of the VCEG-M33 formulas (numpy.polyfit / numpy.polyint, cubic fit of ln(rate) against
 * PSNR, integrated over the overlapping PSNR interval), not from the module under test.
 */
const ANCHOR: RdPoint[] = [
  { rate: 686.76, quality: 40.28 },
  { rate: 309.58, quality: 37.18 },
  { rate: 157.11, quality: 34.24 },
  { rate: 85.95, quality: 31.42 },
];
const TEST: RdPoint[] = [
  { rate: 893.34, quality: 40.39 },
  { rate: 407.8, quality: 37.21 },
  { rate: 204.93, quality: 34.17 },
  { rate: 112.75, quality: 31.24 },
];
const EXPECTED_SAMPLE_1_BD_RATE_PERCENT = 31.397374054908013;

/** Second published curve pair (high bit-rate "Test 1" of the FAU-LMS bjontegaard package, BSD-3-Clause). */
const ANCHOR_2: RdPoint[] = [
  { rate: 9487.76, quality: 40.037 },
  { rate: 4593.6, quality: 38.615 },
  { rate: 2486.44, quality: 36.845 },
  { rate: 1358.24, quality: 34.851 },
];
const TEST_2: RdPoint[] = [
  { rate: 9787.8, quality: 40.121 },
  { rate: 4469.0, quality: 38.651 },
  { rate: 2451.52, quality: 36.97 },
  { rate: 1356.24, quality: 34.987 },
];
const EXPECTED_TEST_1_BD_RATE_PERCENT = -4.420462706090111;

describe('Bjontegaard delta rate (VCEG-M33)', () => {
  it('matches the independently evaluated worked example', () => {
    expect(bdRate(ANCHOR, TEST)).toBeCloseTo(EXPECTED_SAMPLE_1_BD_RATE_PERCENT, 6);
  });

  it('matches the second published curve pair, where the test curve saves bits', () => {
    expect(bdRate(ANCHOR_2, TEST_2)).toBeCloseTo(EXPECTED_TEST_1_BD_RATE_PERCENT, 6);
  });

  it('is exactly the rate scale for a curve that costs 25 percent more at every quality', () => {
    const scaled = ANCHOR.map((point) => ({ rate: point.rate * 1.25, quality: point.quality }));
    expect(bdRate(ANCHOR, scaled)).toBeCloseTo(25, 9);
  });

  it('is exactly zero for identical curves and changes sign when the curves swap', () => {
    expect(bdRate(ANCHOR, ANCHOR)).toBeCloseTo(0, 9);
    const forward = bdRate(ANCHOR_2, TEST_2);
    const backward = bdRate(TEST_2, ANCHOR_2);
    expect(Math.sign(forward)).toBe(-1);
    expect(Math.sign(backward)).toBe(1);
  });

  it('gives the quality gain in dB for a curve shifted up by 0.5 dB', () => {
    const shifted = ANCHOR.map((point) => ({ rate: point.rate, quality: point.quality + 0.5 }));
    expect(bdPsnr(ANCHOR, shifted)).toBeCloseTo(0.5, 9);
  });

  it('rejects fewer than four points, non-finite values and curves with no quality overlap', () => {
    expect(() => bdRate(ANCHOR.slice(0, 3), TEST)).toThrow(BdRateInputError);
    expect(() => bdRate(ANCHOR, [...TEST.slice(0, 3), { rate: Number.NaN, quality: 30 }])).toThrow(BdRateInputError);
    expect(() => bdRate(ANCHOR, [...TEST.slice(0, 3), { rate: -5, quality: 30 }])).toThrow(BdRateInputError);
    const farAway = TEST.map((point) => ({ rate: point.rate, quality: point.quality + 40 }));
    expect(() => bdRate(ANCHOR, farAway)).toThrow(/overlap/);
    const duplicated = ANCHOR.map((point) => ({ rate: point.rate, quality: 35 }));
    expect(() => bdRate(duplicated, TEST)).toThrow(BdRateInputError);
  });

  it('bounds the number of points', () => {
    const many = Array.from({ length: 17 }, (_, i) => ({ rate: 100 + i, quality: 30 + i }));
    expect(() => bdRate(many, many)).toThrow(/at most 16/);
  });
});
