import { describe, expect, it } from 'vitest';
import { type RdPoint, tryBdRate } from '../bench/bd-rate';
import { type Baseline, evaluateGate } from '../bench/gate';
import { evaluateParity } from '../bench/parity';
import { type BenchReport, type BenchRow } from '../bench/report';
import { measuredRow, SPEC, undeterminedBdRows } from '../bench/rows';

/**
 * A BD-rate is not stated for a curve that states no trade-off. When the reference's curve is the broken one (the SNR of a perceptual
 * audio codec) the case is not evaluated; when the reference's curve is sound and ours falls or stays flat as the rate grows, that is
 * our regression, and neither the verdict nor the gate may take it for a skip.
 */

const sound: RdPoint[] = [
  { rate: 100, quality: 30 },
  { rate: 200, quality: 34 },
  { rate: 400, quality: 38 },
  { rate: 800, quality: 42 },
];
const falling: RdPoint[] = [
  { rate: 100, quality: 30 },
  { rate: 200, quality: 34 },
  { rate: 400, quality: 33 },
  { rate: 800, quality: 31 },
];
const flat: RdPoint[] = sound.map((point) => ({ rate: point.rate, quality: 36 + point.rate / 100000 }));

const report = (rows: BenchRow[]): BenchReport => ({
  schemaVersion: 1,
  generatedAt: '2026-10-11T02:00:00.000Z',
  strictMode: true,
  families: ['image'],
  host: { platform: 'linux', arch: 'x64', node: 'v20.0.0', cpus: 4 },
  tools: {},
  settings: { runs: 5, injectedRegression: null },
  rows,
});

const baseline: Baseline = {
  schemaVersion: 1,
  entries: { 'image/photo-a.jpg->webp/bd_rate_psnr': { direction: 'lower', tolerance: { abs: 1.5, rel: 0 }, ours: -2, delta: -2, ratio: null } },
};

describe('whose curve is the broken one', () => {
  it('blames the reference when its curve states no trade-off, even if ours is broken too', () => {
    expect(tryBdRate(flat, sound)).toMatchObject({ fault: 'reference' });
    expect(tryBdRate(flat, falling)).toMatchObject({ fault: 'reference' });
  });

  it('blames ours when the reference is sound and ours falls or stays flat as the rate grows', () => {
    expect(tryBdRate(sound, falling)).toEqual({ fault: 'ours', reason: 'the our curve does not gain quality with its rate' });
    expect(tryBdRate(sound, flat)).toMatchObject({ fault: 'ours' });
  });

  it('blames neither when both curves are sound but share no quality', () => {
    const apart = sound.map((point) => ({ rate: point.rate, quality: point.quality + 20 }));
    expect(tryBdRate(sound, apart)).toMatchObject({ fault: 'curves' });
  });
});

describe('the rows of a case whose BD-rate is not stated', () => {
  const rowsFor = (fault: 'reference' | 'ours' | 'curves'): BenchRow[] => undeterminedBdRows('image', 'photo-a.jpg->webp', [SPEC.bdRatePsnr], 'cwebp', { fault, reason: 'a reason' });

  it('adds a failing row for a curve of ours that falls, and only for that', () => {
    const ours = rowsFor('ours');
    expect(ours.map((row) => [row.metric, row.status])).toEqual([
      ['bd_rate_psnr', 'skipped'],
      ['rd_curve_psnr', 'measured'],
    ]);
    expect(rowsFor('reference').map((row) => row.status)).toEqual(['skipped']);
    expect(rowsFor('curves').map((row) => row.status)).toEqual(['skipped']);
  });

  it('fails the parity verdict when our curve falls with the rate, and does not when the reference is the broken curve', () => {
    const verdict = (fault: 'reference' | 'ours'): { outcome: string; basis: string }[] =>
      evaluateParity(report(rowsFor(fault)), { schemaVersion: 1, gaps: [] }).rows.filter((row) => row.outcome !== 'not-evaluated').map((row) => ({ outcome: row.outcome, basis: row.basis }));
    expect(verdict('ours')).toEqual([{ outcome: 'fail', basis: 'below-reference' }]);
    expect(verdict('reference')).toEqual([]);
  });

  it('fails the baseline gate: a baselined BD-rate row that is no longer produced is a regression, whatever the reason it is skipped for', () => {
    const gated = evaluateGate(report(rowsFor('ours')), baseline, { families: new Set(['image']) });
    expect(gated.regressions.map((regression) => regression.message)).toEqual(['image/photo-a.jpg->webp/bd_rate_psnr: baseline metric is no longer produced (skipped as unsupported: no BD-rate: a reason)']);
    const stillMeasured = evaluateGate(report([measuredRow('image', 'photo-a.jpg->webp', SPEC.bdRatePsnr, -2, 0, 'cwebp')]), baseline, { families: new Set(['image']) });
    expect(stillMeasured.regressions).toEqual([]);
  });

  it('keeps a row skipped for a missing tool a skip: a laptop without the tool is not a regression', () => {
    const missing: BenchRow = { ...rowsFor('ours')[0], skipKind: 'missing-tool', skipReason: 'tool not installed: cwebp' };
    expect(evaluateGate(report([missing]), baseline, { families: new Set(['image']) })).toMatchObject({ regressions: [], skipped: ['image/photo-a.jpg->webp/bd_rate_psnr'] });
  });
});
