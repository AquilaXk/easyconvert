import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CORPUS_TIER_ENV, PARITY_SCHEMA_VERSION, PARITY_VERDICT_FILE, SCHEMA_VERSION } from '../bench/config';
import { BenchArgumentError, ParityInputError, ReportSchemaError } from '../bench/errors';
import { evaluateParity, failureLines, type ParityRunFile, renderParityMarkdown, renderParityText } from '../bench/parity';
import type { Baseline } from '../bench/gate';
import { describeGap, type GapFile, validateGaps } from '../bench/parity-gaps';
import { FAMILIES, type BenchReport, type BenchRow } from '../bench/report';
import { parseArgs, main } from '../bench/run';

/**
 * The parity rules on hand-written rows. Every number is typed in from the rule it exercises: ours must be at or above
 * the reference on each metric, the row's tolerance is the measurement allowance and nothing more, and a point of a
 * rate-distortion curve is judged with the case's BD-rate when the sizes differ.
 */

const NO_GAPS: GapFile = { schemaVersion: PARITY_SCHEMA_VERSION, gaps: [] };

function row(partial: Partial<BenchRow> & Pick<BenchRow, 'id' | 'direction' | 'ours' | 'reference'>): BenchRow {
  const [family, caseName, metric] = partial.id.split('/');
  return {
    family: family as BenchRow['family'],
    case: caseName,
    metric,
    unit: 'unit',
    kind: 'quality',
    status: 'measured',
    delta: (partial.ours as number) - (partial.reference as number),
    ratio: null,
    referenceTool: 'reference tool',
    tolerance: { abs: 0.01, rel: 0 },
    ...partial,
  };
}

function report(rows: BenchRow[], families: BenchReport['families'] = ['image']): BenchReport {
  return {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: '2026-01-01T00:00:00.000Z',
    strictMode: true,
    families,
    host: { platform: 'linux', arch: 'x64', node: 'v20.0.0', cpus: 4 },
    tools: {},
    settings: { runs: 3, injectedRegression: null },
    rows,
  };
}

const outcomeOf = (rows: BenchRow[], id: string, gaps: GapFile = NO_GAPS): { outcome: string; basis: string } => {
  const found = evaluateParity(report(rows), gaps).rows.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`no verdict for ${id}`);
  return { outcome: found.outcome, basis: found.basis };
};

describe('rows judged on their own metric', () => {
  const bd = (ours: number): BenchRow =>
    row({ id: 'image/a.jpg->webp/bd_rate_psnr', direction: 'lower', kind: 'bdrate', ours, reference: 0, tolerance: { abs: 1.5, rel: 0 } });

  it('passes a BD-rate at or below zero and fails one above the measurement allowance', () => {
    expect(outcomeOf([bd(-4)], bd(0).id)).toEqual({ outcome: 'pass', basis: 'at-or-above' });
    expect(outcomeOf([bd(0)], bd(0).id)).toEqual({ outcome: 'pass', basis: 'at-or-above' });
    expect(outcomeOf([bd(1.4)], bd(0).id)).toEqual({ outcome: 'pass', basis: 'within-allowance' });
    expect(outcomeOf([bd(1.6)], bd(0).id)).toEqual({ outcome: 'fail', basis: 'below-reference' });
  });

  const cer = (ours: number): BenchRow => row({ id: 'ocr/scan.png->pdf/cer', direction: 'lower', ours, reference: 2.5, tolerance: { abs: 0.75, rel: 0 } });
  const f1 = (ours: number): BenchRow => row({ id: 'ocr/scan.png->pdf/word_f1', direction: 'higher', ours, reference: 1, tolerance: { abs: 0.02, rel: 0 } });

  it('applies the direction: a lower CER passes, a higher one fails beyond the allowance', () => {
    expect(outcomeOf([cer(2.0)], cer(0).id).outcome).toBe('pass');
    expect(outcomeOf([cer(3.2)], cer(0).id)).toEqual({ outcome: 'pass', basis: 'within-allowance' });
    expect(outcomeOf([cer(3.3)], cer(0).id)).toEqual({ outcome: 'fail', basis: 'below-reference' });
  });

  it('applies the direction: a lower word F1 fails beyond the allowance', () => {
    expect(outcomeOf([f1(1)], f1(0).id)).toEqual({ outcome: 'pass', basis: 'at-or-above' });
    expect(outcomeOf([f1(0.985)], f1(0).id)).toEqual({ outcome: 'pass', basis: 'within-allowance' });
    expect(outcomeOf([f1(0.95)], f1(0).id)).toEqual({ outcome: 'fail', basis: 'below-reference' });
  });

  it('scales a relative allowance by the reference value (size ratio, one percent)', () => {
    const ratio = (ours: number): BenchRow =>
      row({ id: 'compression/mixed.tar->zst/compression_ratio', direction: 'lower', kind: 'size', ours, reference: 0.38, tolerance: { abs: 0, rel: 0.01 } });
    expect(outcomeOf([ratio(0.3835)], ratio(0).id).outcome).toBe('pass');
    expect(outcomeOf([ratio(0.385)], ratio(0).id).outcome).toBe('fail');
    expect(outcomeOf([ratio(0.30)], ratio(0).id).basis).toBe('at-or-above');
  });

  it('requires a lossless result to be exact', () => {
    const exact = (ours: number): BenchRow => row({ id: 'audio/music.wav->flac/lossless_exact', direction: 'higher', kind: 'exact', ours, reference: 1, tolerance: { abs: 0, rel: 0 } });
    expect(outcomeOf([exact(1)], exact(1).id).outcome).toBe('pass');
    expect(outcomeOf([exact(0)], exact(1).id).outcome).toBe('fail');
  });

  it('judges a size on its own where no BD-rate covers the case (lossless output)', () => {
    const bytes = (ours: number): BenchRow =>
      row({ id: 'audio/music.wav->flac/bytes', direction: 'lower', kind: 'size', ours, reference: 100_000, tolerance: { abs: 0, rel: 0.03 } });
    expect(outcomeOf([bytes(102_000)], bytes(0).id).outcome).toBe('pass');
    expect(outcomeOf([bytes(104_000)], bytes(0).id).outcome).toBe('fail');
  });
});

describe('points of a rate-distortion curve', () => {
  const CASE = 'image/a.jpg->webp';
  function curve(over: { ssim: number; psnr: number; bytes: number; bd: number }): BenchRow[] {
    return [
      row({ id: `${CASE}/ssim`, direction: 'higher', ours: over.ssim, reference: 0.95, tolerance: { abs: 0.003, rel: 0 } }),
      row({ id: `${CASE}/psnr`, direction: 'higher', ours: over.psnr, reference: 36, tolerance: { abs: 0.3, rel: 0 } }),
      row({ id: `${CASE}/bytes`, direction: 'lower', kind: 'size', ours: over.bytes, reference: 10_000, tolerance: { abs: 0, rel: 0.03 } }),
      row({ id: `${CASE}/bd_rate_psnr`, direction: 'lower', kind: 'bdrate', ours: over.bd, reference: 0, tolerance: { abs: 1.5, rel: 0 } }),
    ];
  }
  const verdictOf = (rows: BenchRow[]): Record<string, { outcome: string; basis: string }> =>
    Object.fromEntries(evaluateParity(report(rows), NO_GAPS).rows.map((r) => [r.metric, { outcome: r.outcome, basis: r.basis }]));

  it('passes SSIM and PSNR that are not lower at a size that is not larger', () => {
    const verdict = verdictOf(curve({ ssim: 0.96, psnr: 37, bytes: 9_500, bd: -3 }));
    expect(verdict.ssim).toEqual({ outcome: 'pass', basis: 'at-or-above' });
    expect(verdict.psnr).toEqual({ outcome: 'pass', basis: 'at-or-above' });
    expect(verdict.bytes).toEqual({ outcome: 'pass', basis: 'at-or-above' });
  });

  it('defers a point at a larger size to the BD-rate, which here is ahead of the reference', () => {
    const verdict = verdictOf(curve({ ssim: 0.97, psnr: 38, bytes: 11_000, bd: -2 }));
    expect(verdict.bytes).toEqual({ outcome: 'pass', basis: 'defers-to-bd-rate' });
    expect(verdict.ssim).toEqual({ outcome: 'pass', basis: 'defers-to-bd-rate' });
    expect(verdict.bd_rate_psnr.outcome).toBe('pass');
  });

  it('defers a lower point at a smaller size too: equal size is the only place two points compare directly', () => {
    const verdict = verdictOf(curve({ ssim: 0.9, psnr: 33, bytes: 8_000, bd: -1 }));
    expect(verdict.ssim).toEqual({ outcome: 'pass', basis: 'defers-to-bd-rate' });
    expect(verdict.psnr).toEqual({ outcome: 'pass', basis: 'defers-to-bd-rate' });
    expect(verdict.bytes).toEqual({ outcome: 'pass', basis: 'at-or-above' });
  });

  it('fails every deferred point together with a BD-rate above the allowance', () => {
    const verdict = verdictOf(curve({ ssim: 0.9, psnr: 33, bytes: 8_000, bd: 6 }));
    expect(verdict.bd_rate_psnr).toEqual({ outcome: 'fail', basis: 'below-reference' });
    expect(verdict.ssim).toEqual({ outcome: 'fail', basis: 'below-reference' });
    expect(verdict.psnr).toEqual({ outcome: 'fail', basis: 'below-reference' });
    expect(verdict.bytes.outcome).toBe('pass');
  });

  it('keeps a point that is at or above the reference at a smaller size even when the BD-rate is behind', () => {
    const verdict = verdictOf(curve({ ssim: 0.96, psnr: 37, bytes: 9_500, bd: 6 }));
    expect(verdict.ssim.outcome).toBe('pass');
    expect(verdict.bd_rate_psnr.outcome).toBe('fail');
  });
});

describe('speed rows', () => {
  const speed = (extra: Partial<BenchRow>): BenchRow =>
    row({ id: 'compression/mixed.tar->zst/throughput', direction: 'higher', kind: 'throughput', ours: 20, reference: 37, ratio: 0.54, tolerance: { abs: 0, rel: 0.35 }, runs: 9, ...extra });

  it('passes on the speed decision of the run and names the interval', () => {
    const verdict = evaluateParity(report([speed({ speedVerdict: 'pass', ratioLow: 1.02, ratioHigh: 1.3, ratioMedian: 1.1 })]), NO_GAPS).rows[0];
    expect(verdict).toMatchObject({ outcome: 'pass', basis: 'speed-pass' });
    expect(verdict.detail).toContain('[1.02, 1.3]');
    expect(verdict.detail).toContain('9 pairs');
  });

  it('fails a row that is slower, and one that stayed unstable at the cap', () => {
    const slower = evaluateParity(report([speed({ speedVerdict: 'fail', ratioLow: 0.5, ratioHigh: 0.6, ratioMedian: 0.54 })]), NO_GAPS).rows[0];
    expect(slower).toMatchObject({ outcome: 'fail', basis: 'speed-below-reference' });
    const unstable = evaluateParity(report([speed({ speedVerdict: 'fail', unstableAtCap: true, ratioLow: 0.9, ratioHigh: 1.1, ratioMedian: 1 })]), NO_GAPS).rows[0];
    expect(unstable).toMatchObject({ outcome: 'fail', basis: 'speed-unstable-at-cap' });
    expect(unstable.detail).toContain('cap');
  });

  it('fails a row still undecided at its last cap when it has no base to be compared with', () => {
    const undecided = evaluateParity(report([speed({ speedVerdict: 'fail', unstableAtCap: true, ratioLow: 0.9, ratioHigh: 1.1, ratioMedian: 1, runs: 50 })]), NO_GAPS).rows[0];
    expect(undecided).toMatchObject({ outcome: 'fail', basis: 'speed-unstable-at-cap' });
  });

  describe('a row measured against the base of the change in the same pairs', () => {
    const ID = 'image/photo-a.jpg->webp/throughput';
    const flat = (ratio: number): { ratio: number; at: string }[] => [1, 2, 3, 4].map((day) => ({ ratio, at: `2026-10-0${day}T02:00:00.000Z` }));
    const measured = (ab: Partial<BenchRow>, verdict: 'pass' | 'fail' = 'fail'): BenchRow =>
      speed({ id: ID, speedVerdict: verdict, ratioLow: 0.7, ratioHigh: 0.8, ratioMedian: 0.75, runs: 24, abPairs: 24, abMedian: 1, abUpper: 1.05, abHeadVsReferenceUpper: 0.8, abBaseVsReferenceMedian: 0.75, ...ab });
    const verdictOf = (row: BenchRow, gaps: GapFile = NO_GAPS): { outcome: string; basis: string; detail: string } => {
      const found = evaluateParity(report([row]), gaps).rows.find((candidate) => candidate.id === ID);
      if (!found) throw new Error('no verdict');
      return { outcome: found.outcome, basis: found.basis, detail: found.detail };
    };

    it('fails when the head is credibly more than 10 percent slower than the base: the upper bound is below 1 / 1.1', () => {
      const slower = verdictOf(measured({ abMedian: 0.85, abUpper: 0.9 }));
      expect(slower).toMatchObject({ outcome: 'fail', basis: 'speed-slower-than-base' });
      expect(slower.detail).toContain('more than 10% slower than its base');
      expect(verdictOf(measured({ abMedian: 0.85, abUpper: 0.909 })).basis).toBe('speed-slower-than-base');
    });

    it('does not fail on a first set the second set of pairs did not confirm', () => {
      expect(verdictOf(measured({ abMedian: 0.7, abUpper: 0.75, abSlowerConfirmed: false })).outcome).toBe('pass');
      expect(verdictOf(measured({ abMedian: 0.7, abUpper: 0.75, abSlowerConfirmed: true })).basis).toBe('speed-slower-than-base');
      expect(verdictOf(measured({ abBaseVsReferenceMedian: 1.02, abHeadVsReferenceUpper: 0.9, abLostConfirmed: false })).outcome).toBe('pass');
      expect(verdictOf(measured({ abBaseVsReferenceMedian: 1.02, abHeadVsReferenceUpper: 0.9, abLostConfirmed: true })).basis).toBe('speed-lost-parity');
    });

    it('passes a head that is not credibly slower by that much, however low the reference ratio sits', () => {
      expect(verdictOf(measured({ abMedian: 0.9, abUpper: 0.9092 })).outcome).toBe('pass');
      expect(verdictOf(measured({ abMedian: 0.94, abUpper: 0.96 })).outcome).toBe('pass');
      expect(verdictOf(measured({ abMedian: 1, abUpper: undefined })).outcome).toBe('pass');
    });

    it('takes the threshold of the row: a row with its own threshold is judged by it', () => {
      const found = evaluateParity(report([measured({ abMedian: 0.93, abUpper: 0.94 })]), NO_GAPS, { regression: { [ID]: { delta: 0.05 } } }).rows[0];
      expect(found).toMatchObject({ outcome: 'fail', basis: 'speed-slower-than-base' });
      expect(found.detail).toContain('more than 5% slower');
      expect(verdictOf(measured({ abMedian: 0.93, abUpper: 0.94 })).outcome).toBe('pass');
    });

    it('does not judge a nightly-only row on a pull request, whatever the pairs show, and judges it by the reference alone without a base', () => {
      const nightly = { nightlyOnly: { [ID]: { needs: 0.8, reason: 'noise 0.200, run 1' } } };
      const slow = evaluateParity(report([measured({ abMedian: 0.4, abUpper: 0.45 })]), NO_GAPS, nightly).rows[0];
      expect(slow).toMatchObject({ outcome: 'pass', basis: 'speed-nightly-only' });
      expect(slow.detail).toContain('noise 0.200');
      const lost = evaluateParity(report([measured({ abBaseVsReferenceMedian: 1.02, abHeadVsReferenceUpper: 0.5 })]), NO_GAPS, nightly).rows[0];
      expect(lost.basis).toBe('speed-nightly-only');
      const fallback = evaluateParity(report([measured({ abPairs: undefined, abFallback: 'the base cannot run it', speedVerdict: 'fail', ratio: 0.5, ratioMedian: 0.5, ratioLow: 0.4, ratioHigh: 0.6 })]), NO_GAPS, nightly).rows[0];
      expect(fallback.basis).toBe('speed-nightly-only');
      const absolute = evaluateParity(report([measured({ abPairs: undefined, speedVerdict: 'fail', ratio: 0.5, ratioMedian: 0.5, ratioLow: 0.4, ratioHigh: 0.6 })]), NO_GAPS, nightly).rows[0];
      expect(absolute.outcome).toBe('fail');
    });

    it('fails when the base was at the reference and the head is credibly below it, and passes a base that was already below', () => {
      expect(verdictOf(measured({ abBaseVsReferenceMedian: 1.02, abHeadVsReferenceUpper: 0.95 }))).toMatchObject({ outcome: 'fail', basis: 'speed-lost-parity' });
      expect(verdictOf(measured({ abBaseVsReferenceMedian: 1.02, abHeadVsReferenceUpper: 0.98 })).outcome).toBe('pass');
      expect(verdictOf(measured({ abBaseVsReferenceMedian: 0.9, abHeadVsReferenceUpper: 0.95 }))).toMatchObject({ outcome: 'pass', basis: 'speed-unchanged-below-reference' });
    });

    it('passes a row at the reference', () => {
      const atReference = measured({ abBaseVsReferenceMedian: 1.1, abHeadVsReferenceUpper: 1.2, ratioLow: 1.05, ratioHigh: 1.2, ratioMedian: 1.1 }, 'pass');
      expect(verdictOf(atReference)).toMatchObject({ outcome: 'pass', basis: 'speed-pass' });
    });

    describe('a tracked gap: its history applies to what the change did to the row', () => {
      const tracked = (level: number): GapFile => ({ schemaVersion: PARITY_SCHEMA_VERSION, gaps: [{ id: ID, issue: 695, ratio: level, note: 'n', history: flat(level) }] });

      it('names the entry that has no reason to be there once its history level times the head-to-base ratio is at the reference', () => {
        const found = verdictOf(measured({ abMedian: 1.02 }), tracked(1.1));
        expect(found).toMatchObject({ outcome: 'pass', basis: 'tracked-now-at-parity' });
        expect(found.detail).toContain('history level 1.1 times the head-to-base ratio 1.02');
      });

      it('passes a row below the reference that the change left as it was, tracked', () => {
        expect(verdictOf(measured({ abMedian: 1 }), tracked(0.9))).toMatchObject({ outcome: 'pass', basis: 'tracked-gap' });
        // The ratio the child measured against the reference does not enter: only the head-to-base ratio does.
        expect(verdictOf(measured({ abMedian: 1, ratioMedian: 0.3, ratioLow: 0.2, ratioHigh: 0.4 }), tracked(0.9)).outcome).toBe('pass');
      });

      it('fails a change that walks a tracked gap under its history, though it is not credibly slower than the base', () => {
        // A noisy row: its median fell to 0.6 of the base, yet its upper bound (1.05) does not show a slowdown beyond 10 percent.
        const walked = verdictOf(measured({ abMedian: 0.6, abUpper: 1.05 }), tracked(0.9));
        expect(walked).toMatchObject({ outcome: 'fail', basis: 'tracked-slower-than-gap' });
        expect(verdictOf(measured({ abMedian: 0.95, abUpper: 1.05 }), tracked(0.9)).outcome).toBe('fail');
      });
    });

    it('reports the rows that fell back to the reference alone, with the reason', () => {
      const fallback = evaluateParity(report([speed({ id: ID, speedVerdict: 'pass', ratioLow: 1.1, ratioHigh: 1.2, ratioMedian: 1.15, abFallback: 'this version cannot run the row' })]), NO_GAPS).rows[0];
      expect(fallback).toMatchObject({ outcome: 'pass', basis: 'speed-pass' });
    });
  });

  it('refuses a throughput row that carries no speed decision', () => {
    expect(() => evaluateParity(report([speed({})]), NO_GAPS)).toThrow(ParityInputError);
    expect(() => evaluateParity(report([speed({})]), NO_GAPS)).toThrow(/compression\/mixed\.tar->zst\/throughput/);
  });
});

describe('skipped rows', () => {
  const skipped = (skipKind: 'unsupported' | 'missing-tool' | 'optional-tool'): BenchRow =>
    row({ id: 'compression/mixed.tar->xz/compression_ratio', direction: 'lower', kind: 'size', status: 'skipped', ours: null, reference: null, delta: null, skipKind, skipReason: 'why' });

  it('lists them as not evaluated, never as passed', () => {
    for (const [kind, basis] of [['unsupported', 'unsupported'], ['missing-tool', 'skipped'], ['optional-tool', 'skipped']] as const) {
      const verdict = evaluateParity(report([skipped(kind)]), NO_GAPS);
      expect(verdict.rows[0]).toMatchObject({ outcome: 'not-evaluated', basis, detail: 'why' });
      expect(verdict.summary).toEqual({ evaluated: 0, pass: 0, withinAllowance: 0, fail: 0, tracked: 0, nowAtParity: 0, notEvaluated: 1 });
    }
  });
});

describe('the known gaps', () => {
  const XZ = 'compression/mixed.xz->tar/throughput';
  const ZST = 'compression/mixed.tar->zst/throughput';
  const SEVEN = 'compression/mixed.7z->tar/throughput';
  const run = (day: number): string => `2026-10-${String(day).padStart(2, '0')}T02:00:00.000Z`;
  const history = (...ratios: number[]): { ratio: number; at: string }[] => ratios.map((ratio, index) => ({ ratio, at: run(index + 1) }));
  const gaps: GapFile = {
    schemaVersion: PARITY_SCHEMA_VERSION,
    gaps: [
      // A flat history of four runs puts the lower edge of the prediction bound at exactly 0.46.
      { id: XZ, issue: 487, ratio: 0.46, note: 'LZMA decode speed', history: history(0.46, 0.46, 0.46, 0.46) },
      // [1, 2, 2, 2, 4] scaled by 0.25: geometric mean 0.5, lower edge 0.25 * 0.26750 = 0.066875.
      { id: ZST, issue: 497, ratio: 0.5, note: 'zstd level 3 speed', history: history(0.25, 0.5, 0.5, 0.5, 1) },
    ],
  };
  const speed = (id: string, over: Partial<BenchRow>): BenchRow =>
    row({ id, direction: 'higher', kind: 'throughput', ours: 1, reference: 2, ratio: 0.5, runs: 7, speedVerdict: 'fail', ratioLow: 0.4, ratioHigh: 0.6, ratioMedian: 0.5, ...over });
  const judged = (rows: BenchRow[]): ReturnType<typeof evaluateParity> => evaluateParity(report(rows), gaps);

  it('fails a slow speed row that is not tracked, and says it is not a known gap', () => {
    const verdict = judged([speed(SEVEN, {})]);
    expect(verdict.verdict).toBe('fail');
    expect(verdict.rows[0]).toMatchObject({ outcome: 'fail', basis: 'speed-below-reference', gap: null });
    expect(failureLines(verdict)[0]).toContain('not a known gap: bring it to parity');
  });

  it('passes a tracked slow row that sits inside its history, and reports it as tracked with its issue', () => {
    const verdict = judged([speed(XZ, { ratioLow: 0.42, ratioHigh: 0.5, ratioMedian: 0.47, ratio: 0.47 })]);
    expect(verdict.verdict).toBe('pass');
    expect(verdict.rows[0]).toMatchObject({ outcome: 'pass', basis: 'tracked-gap' });
    expect(verdict.rows[0].detail).toContain('tracked (issue #487)');
    expect(verdict.rows[0].detail).toContain('99% one-sided prediction bound 0.46 over the last 4 CI runs');
    expect(verdict.summary).toMatchObject({ fail: 0, tracked: 1, nowAtParity: 0 });
  });

  it('passes a tracked row whose median is only just above the prediction bound, and fails one just below it, whatever its interval', () => {
    // The flat history of the XZ gap puts the bound at 0.46; the row is judged by its median, which is what the history stores.
    expect(judged([speed(XZ, { ratioMedian: 0.4601, ratioHigh: 0.47 })]).rows[0]).toMatchObject({ outcome: 'pass', basis: 'tracked-gap' });
    expect(judged([speed(XZ, { ratioMedian: 0.4599, ratioHigh: 0.95 })]).rows[0]).toMatchObject({ outcome: 'fail', basis: 'tracked-slower-than-gap' });
  });

  it('does not fail a tracked row for a drop inside the run-to-run noise that a fixed percentage would have caught', () => {
    // 0.41 is 11 percent under the 0.46 the fixed rule recorded, yet inside the spread of a noisy history and above 65 percent of its median 0.46.
    const noisy: GapFile = { schemaVersion: PARITY_SCHEMA_VERSION, gaps: [{ id: XZ, issue: 487, ratio: 0.47, note: 'LZMA decode speed', history: history(0.38, 0.46, 0.5, 0.42, 0.47) }] };
    const verdict = evaluateParity(report([speed(XZ, { ratioLow: 0.38, ratioHigh: 0.5, ratioMedian: 0.41 })]), noisy);
    expect(verdict.rows[0]).toMatchObject({ outcome: 'pass', basis: 'tracked-gap' });
  });

  it('fails a tracked row that got slower than its history predicts, naming the row and the issue', () => {
    const verdict = judged([speed(XZ, { ratioLow: 0.2, ratioHigh: 0.3, ratioMedian: 0.25, ratio: 0.25 })]);
    expect(verdict.verdict).toBe('fail');
    expect(verdict.rows[0]).toMatchObject({ outcome: 'fail', basis: 'tracked-slower-than-gap' });
    expect(failureLines(verdict)[0]).toMatch(/^BELOW REFERENCE compression\/mixed\.xz->tar\/throughput: .*got slower than its history.*known gap, issue #487/);
  });

  it('holds a tracked row whose history has fewer than three runs to 65 percent of its median', () => {
    for (const points of [[], [0.46], [0.46, 0.46]]) {
      const short: GapFile = { schemaVersion: PARITY_SCHEMA_VERSION, gaps: [{ id: XZ, issue: 487, ratio: 0.46, note: 'LZMA decode speed', history: history(...points) }] };
      const slow = evaluateParity(report([speed(XZ, { ratioLow: 0.05, ratioHigh: 0.1, ratioMedian: 0.07 })]), short);
      expect(slow.verdict).toBe('fail');
      expect(slow.rows[0]).toMatchObject({ outcome: 'fail', basis: 'tracked-slower-than-gap' });
      const near = evaluateParity(report([speed(XZ, { ratioLow: 0.3, ratioHigh: 0.5, ratioMedian: 0.31 })]), short);
      expect(near.verdict).toBe('pass');
      expect(near.rows[0]).toMatchObject({ outcome: 'pass', basis: 'tracked-short-history' });
      const basis = points.length === 0 ? 'its recorded ratio 0.46' : `the median 0.46 of its last ${points.length} CI runs`;
      expect(near.rows[0].detail).toContain(`${points.length} of the 3 CI-measured runs a bound needs: judged by 65% of ${basis} (0.299)`);
      expect(near.summary).toMatchObject({ fail: 0, tracked: 1 });
    }
    const noHistory: GapFile = { schemaVersion: PARITY_SCHEMA_VERSION, gaps: [{ id: XZ, issue: 487, ratio: 0.46, note: 'LZMA decode speed' }] };
    expect(evaluateParity(report([speed(XZ, { ratioMedian: 0.1 })]), noHistory).rows[0]).toMatchObject({ outcome: 'fail', basis: 'tracked-slower-than-gap' });
  });

  it('keeps a tracked row that is unstable at the cap but not under its prediction bound tracked, not failed', () => {
    const verdict = judged([speed(ZST, { unstableAtCap: true, ratioLow: 0.9, ratioHigh: 1.1, ratioMedian: 1 })]);
    expect(verdict.rows[0]).toMatchObject({ outcome: 'pass', basis: 'tracked-gap' });
  });

  it('reports a tracked row that now passes the parity rule, so its entry can be removed', () => {
    const verdict = judged([speed(ZST, { speedVerdict: 'pass', ratioLow: 1.02, ratioHigh: 1.3, ratioMedian: 1.1, ratio: 1.1 })]);
    expect(verdict.verdict).toBe('pass');
    expect(verdict.rows[0]).toMatchObject({ outcome: 'pass', basis: 'tracked-now-at-parity' });
    expect(verdict.rows[0].detail).toContain(`now at parity: remove ${ZST} from bench/parity-gaps.json (issue #497)`);
    expect(verdict.summary).toMatchObject({ tracked: 0, nowAtParity: 1 });
  });

  it('fails a quality row that is not listed, and says it is not a known gap', () => {
    const bd = row({ id: 'image/a.jpg->avif/bd_rate_psnr', direction: 'lower', kind: 'bdrate', ours: 6, reference: 0, tolerance: { abs: 1.5, rel: 0 } });
    const verdict = judged([bd]);
    expect(verdict.verdict).toBe('fail');
    expect(verdict.rows[0]).toMatchObject({ outcome: 'fail', basis: 'below-reference', gap: null });
    expect(failureLines(verdict)[0]).toContain('not a known gap: bring it to parity');
  });

  it('describes a gap by its issue or by its absence', () => {
    expect(describeGap(gaps.gaps[0])).toBe('known gap, issue #487: LZMA decode speed');
    expect(describeGap(undefined)).toContain('file a gap issue');
  });

  it.each<[string, unknown, RegExp]>([
    ['a non-object', [], /must be an object/],
    ['another schema version', { schemaVersion: 2, gaps: [] }, /schemaVersion/],
    ['gaps that are not a list', { schemaVersion: 1, gaps: {} }, /gaps must be an array/],
    ['an id that is not a row id', { schemaVersion: 1, gaps: [{ id: 'nonsense', issue: 1, ratio: null, note: 'n' }] }, /<family>\/<case>\/<metric>/],
    ['a repeated id', { schemaVersion: 1, gaps: [{ id: 'a/b/c', issue: 1, ratio: null, note: 'n', recorded: 1, reference: 0 }, { id: 'a/b/c', issue: 2, ratio: null, note: 'n', recorded: 1, reference: 0 }] }, /listed twice/],
    ['a null issue', { schemaVersion: 1, gaps: [{ id: 'a/b/throughput', issue: null, ratio: 0.5, note: 'n' }] }, /issue must be a positive integer/],
    ['a missing issue', { schemaVersion: 1, gaps: [{ id: 'a/b/c', ratio: null, note: 'n' }] }, /issue must be a positive integer/],
    ['an issue that is not a positive integer', { schemaVersion: 1, gaps: [{ id: 'a/b/c', issue: 0, ratio: null, note: 'n' }] }, /issue must be a positive integer/],
    ['a speed row without a ratio', { schemaVersion: 1, gaps: [{ id: 'a/b/throughput', issue: 3, ratio: null, note: 'n' }] }, /ratio must be a positive speed ratio/],
    ['a speed row with a non-positive ratio', { schemaVersion: 1, gaps: [{ id: 'a/b/throughput', issue: 3, ratio: 0, note: 'n' }] }, /ratio must be a positive speed ratio/],
    ['a quality row with a ratio', { schemaVersion: 1, gaps: [{ id: 'a/b/ssim', issue: 3, ratio: 0.5, note: 'n', recorded: 0.9, reference: 0.95 }] }, /ratio must be null for the quality row/],
    ['a missing note', { schemaVersion: 1, gaps: [{ id: 'a/b/c', issue: 3, ratio: null, note: '', recorded: 1, reference: 0 }] }, /note/],
    ['a history on a quality row', { schemaVersion: 1, gaps: [{ id: 'a/b/ssim', issue: 3, ratio: null, note: 'n', recorded: 0.9, reference: 0.95, history: [] }] }, /history is only for speed rows/],
    ['a history that is not a list', { schemaVersion: 1, gaps: [{ id: 'a/b/throughput', issue: 3, ratio: 0.5, note: 'n', history: {} }] }, /history must be an array/],
    ['a history point without a positive ratio', { schemaVersion: 1, gaps: [{ id: 'a/b/throughput', issue: 3, ratio: 0.5, note: 'n', history: [{ ratio: 0, at: '2026-10-01T02:00:00.000Z' }] }] }, /history\[0\]\.ratio/],
    ['a history point without a run time', { schemaVersion: 1, gaps: [{ id: 'a/b/throughput', issue: 3, ratio: 0.5, note: 'n', history: [{ ratio: 0.5, at: 'yesterday' }] }] }, /history\[0\]\.at/],
    ['a history out of order', { schemaVersion: 1, gaps: [{ id: 'a/b/throughput', issue: 3, ratio: 0.5, note: 'n', history: [{ ratio: 0.5, at: '2026-10-02T02:00:00.000Z' }, { ratio: 0.5, at: '2026-10-01T02:00:00.000Z' }] }] }, /ordered by run time/],
    ['a history of the same run twice', { schemaVersion: 1, gaps: [{ id: 'a/b/throughput', issue: 3, ratio: 0.5, note: 'n', history: [{ ratio: 0.5, at: '2026-10-01T02:00:00.000Z' }, { ratio: 0.6, at: '2026-10-01T02:00:00.000Z' }] }] }, /one point per run/],
    ['a history over the cap', { schemaVersion: 1, gaps: [{ id: 'a/b/throughput', issue: 3, ratio: 0.5, note: 'n', history: Array.from({ length: 11 }, (_v, i) => ({ ratio: 0.5, at: `2026-10-${String(i + 1).padStart(2, '0')}T02:00:00.000Z` })) }] }, /at most 10 points/],
  ])('rejects %s', (_name, value, message) => {
    expect(() => validateGaps(value)).toThrow(ReportSchemaError);
    expect(() => validateGaps(value)).toThrow(message);
  });

  // The families whose quality rows may be tracked as known gaps, with the issue that holds each: a new family or issue is a decision to take here.
  const QUALITY_GAP_ISSUE_BY_FAMILY: Readonly<Record<string, number>> = { image: 641, 'pdf-ops': 783, raw: 686 };

  it('ships a gap file whose every entry names an issue, and whose speed entries name a row the baseline records', () => {
    const shipped = validateGaps(JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'bench', 'parity-gaps.json'), 'utf8')));
    const baseline = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'bench', 'baseline.json'), 'utf8')) as { entries: Record<string, unknown> };
    expect(shipped.gaps.length).toBeGreaterThan(10);
    for (const gap of shipped.gaps) {
      expect(Number.isInteger(gap.issue) && gap.issue > 0, gap.id).toBe(true);
      // A quality row may be new and not baselined yet; the run refuses an entry whose row it did not produce (gap-row-missing).
      if (gap.ratio !== null) expect(gap.id in baseline.entries, gap.id).toBe(true);
    }
  });

  describe('the AVIF curve of the CLIC photograph the nightly run measured just past the allowance', () => {
    // Values of nightly runs 39012667333, 39107567130, 39220124206 and 39316523318 (x86-64 CI runner): identical to the last digit in all four.
    const CASE = 'image/clic-sergey-zolkin-21232.png->avif';
    const CI_VALUES: Readonly<Record<string, number>> = { bd_rate_psnr: 1.5011455240068639, bd_rate_ssim: 1.6045206591174255 };
    const curveRows = (scale = 1): BenchRow[] =>
      Object.entries(CI_VALUES).map(([metric, value]) =>
        row({ id: `${CASE}/${metric}`, direction: 'lower', kind: 'bdrate', ours: value * scale, reference: 0, tolerance: { abs: 1.5, rel: 0 } })
      );
    const shipped = (): GapFile => validateGaps(JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'bench', 'parity-gaps.json'), 'utf8')));
    const outcomes = (rows: BenchRow[], gaps: GapFile): Array<{ outcome: string; basis: string }> => rows.map((candidate) => outcomeOf(rows, candidate.id, gaps));

    it('fails as a row below the reference when no entry tracks it', () => {
      expect(outcomes(curveRows(), NO_GAPS)).toEqual([
        { outcome: 'fail', basis: 'below-reference' },
        { outcome: 'fail', basis: 'below-reference' },
      ]);
    });

    it('is tracked at the value the CI runner measures, and fails once it gets worse than that by more than the allowance', () => {
      expect(outcomes(curveRows(), shipped())).toEqual([
        { outcome: 'pass', basis: 'tracked-quality-gap' },
        { outcome: 'pass', basis: 'tracked-quality-gap' },
      ]);
      expect(outcomes(curveRows(2.1), shipped())).toEqual([
        { outcome: 'fail', basis: 'tracked-worse-than-recorded' },
        { outcome: 'fail', basis: 'tracked-worse-than-recorded' },
      ]);
    });
  });

  it('holds quality entries only for the families and issues the rollout allows, each with a record', () => {
    const shipped = validateGaps(JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'bench', 'parity-gaps.json'), 'utf8')));
    for (const gap of shipped.gaps.filter((candidate) => !candidate.id.endsWith('/throughput'))) {
      const family = gap.id.split('/')[0];
      expect(FAMILIES, gap.id).toContain(family);
      expect(gap.issue, gap.id).toBe(QUALITY_GAP_ISSUE_BY_FAMILY[family]);
      expect(typeof gap.recorded, gap.id).toBe('number');
      expect(typeof gap.reference, gap.id).toBe('number');
    }
  });

  it('files each gap under the issue of its family, as the rollout assigned them', () => {
    const shipped = validateGaps(JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'bench', 'parity-gaps.json'), 'utf8')));
    const byIdOf = (id: string): number | undefined => shipped.gaps.find((g) => g.id === id)?.issue;
    const issuesOf = (prefix: string, speedRows: boolean): number[] =>
      [...new Set(shipped.gaps.filter((g) => g.id.startsWith(prefix) && g.id.endsWith('/throughput') === speedRows).map((g) => g.issue))];
    // The one image quality gap is the AVIF curve of a photograph whose bytes depend on the encoder thread count (641, entry 1 of the policy record).
    expect(issuesOf('image/', false)).toEqual([641]);
    expect(issuesOf('image/', true)).toEqual([641]);
    // The HEVC encode row and the zstd encode row (497) reached parity on the CI runner with room to spare, so they are no longer known gaps.
    // The H.264 row of the clip and the Opus row of the music file reached parity in the nightly run of 2026-10-24; the VP9 row of the clip stays tracked.
    expect(issuesOf('audio/', true)).toEqual([]);
    expect(issuesOf('video/', true)).toEqual([643]);
    expect(byIdOf('video/clip.mp4->h264/throughput')).toBeUndefined();
    expect(issuesOf('ocr/', true)).toEqual([644]);
    // The document gaps are gone: the PDF text reader reached parity (672), as the slide and sheet pages to PNG did (735).
    expect(issuesOf('document/', true)).toEqual([]);
    // The RAW to GIF rows reached parity on the CI runner (686).
    expect(issuesOf('raw/', true)).toEqual([]);
    expect([byIdOf('raw/dng->gif/throughput'), byIdOf('raw/arw->gif/throughput')]).toEqual([undefined, undefined]);
    // The SVG to PDF and EPS to PNG rows reached parity in the nightly run of 2026-10-24 (735).
    expect(issuesOf('vector/', true)).toEqual([]);
    expect(issuesOf('cad/', true)).toEqual([]);
    // The quality rows below the reference are tracked at a recorded value: the RAW files the product refuses or develops past the allowance (686).
    expect(issuesOf('raw/', false)).toEqual([686]);
    for (const family of ['vector/', 'cad/']) expect(issuesOf(family, false)).toEqual([]);
    const byId = Object.fromEntries(shipped.gaps.map((g) => [g.id, g.issue]));
    // Every compression row that is a known gap reached parity in the nightly run of 2026-10-24, but the xz decode of the most compressible Silesia file, a row of a public sample that the nightly run times (685).
    expect(issuesOf('compression/', true)).toEqual([685]);
    expect(Object.keys(byId).filter((id) => id.startsWith('compression/'))).toEqual(['compression/silesia-xml.xz->tar/throughput']);
    expect(byId['image/wm-deep-dart.png->avif/throughput']).toBe(641);
    expect(byId['video/clip.mp4->hevc/throughput']).toBeUndefined();
    // The PostScript to PDF, Illustrator to PNG, slide and sheet page rows reached parity on the CI runner (735).
    for (const id of [
      'vector/shapes.eps->pdf/throughput',
      'vector/shapes.ai->png/throughput',
      'vector/shapes.svg->pdf/throughput',
      'vector/shapes.eps->png/throughput',
      'document/drawingml-shapes-presentation.pptx->png/throughput',
      'document/workbook.xlsx->png/throughput',
    ]) expect(byId[id]).toBeUndefined();
    // The PDF operation rows reached parity in the nightly run of 2026-10-24 (695, 783), and no PDF operation quality row is a known gap.
    expect(issuesOf('pdf-ops/', true)).toEqual([]);
    expect(issuesOf('pdf-ops/', false)).toEqual([]);
  });

  it('accepts a family name with a hyphen in a row id', () => {
    const gaps = validateGaps({ schemaVersion: 1, gaps: [{ id: 'pdf-ops/watermark.pdf->pdf/throughput', issue: 695, ratio: 0.83, note: 'n' }] });
    expect(gaps.gaps.map((gap) => gap.id)).toEqual(['pdf-ops/watermark.pdf->pdf/throughput']);
  });
});

describe('the quality gaps', () => {
  // Hand-built rows with the numbers of the rows these entries exist for; every verdict below is worked out on paper.
  const CHECKS = 'pdf-ops/pdf-qpdf-pages-loop.pdf->compress/pdf_check_failures';
  const BYTES = 'pdf-ops/pdf-qpdf-form-errors.pdf->delete/bytes';
  const CONVERTS = 'raw/raw-samsung-s23.dng->jpg/converts';
  const CURVE = 'raw/raw-canon-r5-raw.cr3->jpg/bd_rate_psnr';
  const checks = (ours: number): BenchRow => row({ id: CHECKS, direction: 'lower', kind: 'exact', ours, reference: 0, tolerance: { abs: 0, rel: 0 } });
  // 3 percent of 25,870 bytes is 776.1: the allowance of the size row.
  const bytes = (ours: number): BenchRow => row({ id: BYTES, direction: 'lower', kind: 'size', ours, reference: 25870, tolerance: { abs: 0, rel: 0.03 } });
  const converts = (ours: number): BenchRow => row({ id: CONVERTS, direction: 'higher', kind: 'exact', ours, reference: 1, tolerance: { abs: 0, rel: 0 } });
  const curve = (ours: number): BenchRow => row({ id: CURVE, direction: 'lower', kind: 'bdrate', ours, reference: 0, tolerance: { abs: 1.5, rel: 0 } });
  const entry = (id: string, recorded: number, reference: number, issue = 783): GapFile['gaps'][number] => ({ id, issue, ratio: null, note: 'known gap', recorded, reference });
  const gaps = (...entries: GapFile['gaps']): GapFile => ({ schemaVersion: PARITY_SCHEMA_VERSION, gaps: entries });
  const verdictOf = (rows: BenchRow[], file: GapFile, id: string): ReturnType<typeof evaluateParity>['rows'][number] => {
    const found = evaluateParity(report(rows, ['pdf-ops', 'raw']), file).rows.find((candidate) => candidate.id === id);
    if (!found) throw new Error(`no verdict for ${id}`);
    return found;
  };

  it('tracks a row that has exactly the recorded value, with its issue and both values', () => {
    const tracked = verdictOf([checks(1)], gaps(entry(CHECKS, 1, 0)), CHECKS);
    expect(tracked).toMatchObject({ outcome: 'pass', basis: 'tracked-quality-gap' });
    expect(tracked.detail).toContain('issue #783');
    expect(tracked.detail).toContain('recorded 1');
    expect(tracked.detail).toContain('the reference was 0 then, 0 now');
  });

  it('fails a row that got worse than the recorded value by more than its allowance, and tracks one inside it', () => {
    expect(verdictOf([checks(2)], gaps(entry(CHECKS, 1, 0)), CHECKS)).toMatchObject({ outcome: 'fail', basis: 'tracked-worse-than-recorded' });
    // Higher is better for converts: 0 recorded against 1, and the metric cannot fall below 0, so only the value above counts.
    expect(verdictOf([converts(0)], gaps(entry(CONVERTS, 0, 1, 686)), CONVERTS)).toMatchObject({ outcome: 'pass', basis: 'tracked-quality-gap' });
    // Allowance 776.1 bytes: 776 more than the recorded 26,830 is inside it, 777 is not.
    expect(verdictOf([bytes(27606)], gaps(entry(BYTES, 26830, 25870)), BYTES)).toMatchObject({ outcome: 'pass', basis: 'tracked-quality-gap' });
    const worse = verdictOf([bytes(27607)], gaps(entry(BYTES, 26830, 25870)), BYTES);
    expect(worse).toMatchObject({ outcome: 'fail', basis: 'tracked-worse-than-recorded', gap: { issue: 783 } });
    expect(worse.detail).toContain('ours is worse than the recorded value by 777');
  });

  it('judges the direction of the metric: a lower value of a higher-is-better row is worse than the record', () => {
    const higherBetter = row({ id: 'raw/raw-samsung-s23.dng->jpg/ssim', direction: 'higher', ours: 0.80, reference: 0.95, tolerance: { abs: 0.01, rel: 0 } });
    const file = gaps(entry(higherBetter.id, 0.85, 0.95, 686));
    expect(verdictOf([{ ...higherBetter, ours: 0.84, delta: -0.11 }], file, higherBetter.id)).toMatchObject({ outcome: 'pass', basis: 'tracked-quality-gap' });
    expect(verdictOf([{ ...higherBetter, ours: 0.83, delta: -0.12 }], file, higherBetter.id)).toMatchObject({ outcome: 'fail', basis: 'tracked-worse-than-recorded' });
    expect(verdictOf([{ ...higherBetter, ours: 0.86, delta: -0.09 }], file, higherBetter.id)).toMatchObject({ outcome: 'pass', basis: 'tracked-quality-gap' });
  });

  it('fails a row that is better than the record by more than its allowance yet still below the reference, so a lenient record cannot stay', () => {
    // Recorded +4.0 against 0; allowance 1.5. +2.5 is 1.5 better (inside), +2.4 is 1.6 better (stale entry), and both are still above the allowance of the reference.
    expect(verdictOf([curve(2.5)], gaps(entry(CURVE, 4, 0, 686)), CURVE)).toMatchObject({ outcome: 'pass', basis: 'tracked-quality-gap' });
    const stale = verdictOf([curve(2.4)], gaps(entry(CURVE, 4, 0, 686)), CURVE);
    expect(stale).toMatchObject({ outcome: 'fail', basis: 'tracked-better-than-recorded' });
    expect(stale.detail).toContain('update recorded to 2.4');
  });

  it('reports a row that passes the normal rule as now at parity, so the entry gets removed', () => {
    const done = verdictOf([checks(0)], gaps(entry(CHECKS, 1, 0)), CHECKS);
    expect(done).toMatchObject({ outcome: 'pass', basis: 'tracked-now-at-parity' });
    expect(done.detail).toContain(`now at parity: remove ${CHECKS} from bench/parity-gaps.json (issue #783)`);
    // Within the allowance of the reference counts as parity, as it does for a row without an entry: 25,870 + 776 bytes.
    expect(verdictOf([bytes(26646)], gaps(entry(BYTES, 26830, 25870)), BYTES)).toMatchObject({ outcome: 'pass', basis: 'tracked-now-at-parity' });
    expect(verdictOf([converts(1)], gaps(entry(CONVERTS, 0, 1, 686)), CONVERTS)).toMatchObject({ outcome: 'pass', basis: 'tracked-now-at-parity' });
  });

  it('counts tracked and now-at-parity quality rows in the summary and shows them in the sections', () => {
    const verdict = evaluateParity(report([checks(1), bytes(25870), curve(1.93)], ['pdf-ops', 'raw']), gaps(entry(CHECKS, 1, 0), entry(BYTES, 26830, 25870), entry(CURVE, 1.93, 0, 686)));
    expect(verdict.verdict).toBe('pass');
    expect(verdict.summary).toMatchObject({ evaluated: 3, fail: 0, tracked: 2, nowAtParity: 1 });
    const text = renderParityText(verdict);
    expect(text).toEqual(expect.arrayContaining([expect.stringContaining(`TRACK ${CHECKS} [tracked-quality-gap]`)]));
    expect(text).toEqual(expect.arrayContaining([expect.stringContaining(`DONE ${BYTES} [tracked-now-at-parity]`)]));
    expect(renderParityMarkdown(verdict)).toContain(`| ${CURVE} | tracked-quality-gap |`);
  });

  it('excuses nothing but its own row: a regression of any other row still fails the verdict', () => {
    const other = row({ id: 'pdf-ops/other.pdf->compress/pdf_check_failures', direction: 'lower', kind: 'exact', ours: 1, reference: 0, tolerance: { abs: 0, rel: 0 } });
    const verdict = evaluateParity(report([checks(1), other], ['pdf-ops']), gaps(entry(CHECKS, 1, 0)));
    expect(verdict.verdict).toBe('fail');
    expect(verdict.rows.map((candidate) => [candidate.id, candidate.outcome])).toEqual([[CHECKS, 'pass'], [other.id, 'fail']]);
    expect(failureLines(verdict)).toEqual([expect.stringContaining('not a known gap')]);
  });

  it('judges a point of a rate-distortion curve that defers to the BD-rate by its final outcome', () => {
    const id = 'raw/raw-canon-r5-raw.cr3->jpg/ssim';
    const point = row({ id, direction: 'higher', ours: 0.9, reference: 0.95, tolerance: { abs: 0.003, rel: 0 } });
    const rows = [point, row({ id: 'raw/raw-canon-r5-raw.cr3->jpg/bytes', direction: 'lower', kind: 'size', ours: 120, reference: 100, tolerance: { abs: 0, rel: 0.01 } }), curve(-3)].map((candidate) => ({ ...candidate, case: 'raw-canon-r5-raw.cr3->jpg' }));
    const done = evaluateParity(report(rows, ['raw']), gaps(entry(id, 0.88, 0.95, 686))).rows.find((candidate) => candidate.id === id);
    // The BD-rate is ahead, so the point passes by the curve and its entry is stale.
    expect(done).toMatchObject({ outcome: 'pass', basis: 'tracked-now-at-parity' });
  });

  describe('a row the entry names that the run did not produce', () => {
    const expected = (id: string): boolean => id.startsWith('pdf-ops/');
    const lost = (options: Parameters<typeof evaluateParity>[2]): ReturnType<typeof evaluateParity> => evaluateParity(report([curve(1.93)], ['pdf-ops', 'raw']), gaps(entry(CHECKS, 1, 0)), options);

    it('fails when the run is about that row, rather than letting a vanished row carry a gap', () => {
      const verdict = lost({ expectedRows: expected });
      expect(verdict.verdict).toBe('fail');
      expect(verdict.rows.find((candidate) => candidate.id === CHECKS)).toMatchObject({ outcome: 'fail', basis: 'gap-row-missing', family: 'pdf-ops', case: 'pdf-qpdf-pages-loop.pdf->compress', metric: 'pdf_check_failures' });
      expect(failureLines(verdict).filter((line) => line.includes(CHECKS))).toEqual([expect.stringContaining('did not produce')]);
    });

    it('leaves it alone when the run is not about that row, or does not say which rows it is about', () => {
      expect(lost({ expectedRows: () => false }).rows.map((candidate) => candidate.id)).toEqual([CURVE]);
      expect(lost({}).rows.map((candidate) => candidate.id)).toEqual([CURVE]);
    });

    it('lists a skipped row as not evaluated, as any skipped row, and does not fail it', () => {
      const skipped = row({ id: CHECKS, direction: 'lower', kind: 'exact', status: 'skipped', ours: null, reference: null, delta: null, skipKind: 'missing-tool', skipReason: 'qpdf is not installed' });
      const verdict = evaluateParity(report([skipped], ['pdf-ops']), gaps(entry(CHECKS, 1, 0)), { expectedRows: expected });
      expect(verdict.rows).toHaveLength(1);
      expect(verdict.rows[0]).toMatchObject({ outcome: 'not-evaluated', basis: 'skipped' });
    });

    it('does not ask a speed entry for a quality run, which the speed backing handles', () => {
      const speedEntry = { id: 'pdf-ops/watermark.pdf->pdf/throughput', issue: 695, ratio: 0.8, note: 'n' };
      const verdict = evaluateParity(report([curve(0)], ['pdf-ops', 'raw']), { schemaVersion: PARITY_SCHEMA_VERSION, gaps: [speedEntry] }, { expectedRows: expected });
      expect(verdict.rows.map((candidate) => candidate.id)).toEqual([CURVE]);
    });
  });

  describe('an entry the change adds or edits, against the baseline of the base branch', () => {
    // The base's baseline holds the curve at +0.5 with a tolerance of 1.5 and the converts row at 1 with none: the most an entry may excuse.
    const baseBaseline: Baseline = {
      schemaVersion: 1,
      entries: {
        [CURVE]: { direction: 'lower', tolerance: { abs: 1.5, rel: 0 }, ours: 0.5, delta: 0.5, ratio: null },
        [CONVERTS]: { direction: 'higher', tolerance: { abs: 0, rel: 0 }, ours: 1, delta: 0, ratio: null },
      },
    };
    const judgedWith = (rows: BenchRow[], head: GapFile, base: GapFile, baseline: Baseline = baseBaseline, families?: BenchReport['families']): ReturnType<typeof evaluateParity> =>
      evaluateParity(report(rows, ['pdf-ops', 'raw']), head, { qualityBase: { gaps: base, baseline }, families });
    const rowOf = (verdict: ReturnType<typeof evaluateParity>, id: string): ReturnType<typeof evaluateParity>['rows'][number] => verdict.rows.find((candidate) => candidate.id === id) as ReturnType<typeof evaluateParity>['rows'][number];

    it('allows a new entry for a row the base has no baseline entry for, which is new', () => {
      const verdict = judgedWith([checks(1)], gaps(entry(CHECKS, 1, 0)), gaps());
      expect(rowOf(verdict, CHECKS)).toMatchObject({ outcome: 'pass', basis: 'tracked-quality-gap' });
    });

    it('refuses a new entry whose record is worse than the base baseline by more than its tolerance, though the row has that value', () => {
      // 0.5 + 1.5 is the most the baseline gate would have let the row reach; 2.01 is past it.
      const bad = judgedWith([curve(2.01)], gaps(entry(CURVE, 2.01, 0, 686)), gaps());
      expect(bad.verdict).toBe('fail');
      expect(rowOf(bad, CURVE)).toMatchObject({ outcome: 'fail', basis: 'gap-not-backed', gap: { issue: 686 } });
      expect(rowOf(bad, CURVE).detail).toContain('the recorded value 2.01 is worse than the baseline of the base branch 0.5');
      expect(rowOf(judgedWith([curve(2)], gaps(entry(CURVE, 2, 0, 686)), gaps()), CURVE)).toMatchObject({ outcome: 'pass', basis: 'tracked-quality-gap' });
    });

    it('judges the direction of the baseline entry: a lower record of a higher-is-better row is the worse one', () => {
      expect(rowOf(judgedWith([converts(0)], gaps(entry(CONVERTS, 0, 1, 686)), gaps()), CONVERTS)).toMatchObject({ outcome: 'fail', basis: 'gap-not-backed' });
      const zero: Baseline = { schemaVersion: 1, entries: { [CONVERTS]: { ...baseBaseline.entries[CONVERTS], ours: 0 } } };
      expect(rowOf(judgedWith([converts(0)], gaps(entry(CONVERTS, 0, 1, 686)), gaps(), zero), CONVERTS)).toMatchObject({ outcome: 'pass', basis: 'tracked-quality-gap' });
    });

    it('allows a new entry whose record is equal to or better than the base baseline', () => {
      // The base accepted the curve at +4 (a tolerance of 1.5 around it is what the gate holds); +2 is still above the allowance of the reference.
      const four: Baseline = { schemaVersion: 1, entries: { [CURVE]: { ...baseBaseline.entries[CURVE], ours: 4, delta: 4 } } };
      expect(rowOf(judgedWith([curve(4)], gaps(entry(CURVE, 4, 0, 686)), gaps(), four), CURVE)).toMatchObject({ outcome: 'pass', basis: 'tracked-quality-gap' });
      expect(rowOf(judgedWith([curve(2)], gaps(entry(CURVE, 2, 0, 686)), gaps(), four), CURVE)).toMatchObject({ outcome: 'pass', basis: 'tracked-quality-gap' });
    });

    it('leaves an entry the base already has as it is, whatever its record', () => {
      const same = gaps(entry(CURVE, 2.5, 0, 686));
      expect(rowOf(judgedWith([curve(2.5)], same, same), CURVE)).toMatchObject({ outcome: 'pass', basis: 'tracked-quality-gap' });
    });

    it('checks an entry the change edited, and an edit of anything the verdict reads', () => {
      const edited = judgedWith([curve(2.5)], gaps(entry(CURVE, 2.5, 0, 686)), gaps(entry(CURVE, 1.5, 0, 686)));
      expect(rowOf(edited, CURVE)).toMatchObject({ outcome: 'fail', basis: 'gap-not-backed' });
      const referenceEdited = judgedWith([curve(2.5)], gaps(entry(CURVE, 2.5, 0.1, 686)), gaps(entry(CURVE, 2.5, 0, 686)));
      expect(rowOf(referenceEdited, CURVE)).toMatchObject({ outcome: 'fail', basis: 'gap-not-backed' });
    });

    it('checks the families of its own shard only, and every family without a list', () => {
      const head = gaps(entry(CURVE, 2.5, 0, 686));
      expect(rowOf(judgedWith([curve(2.5)], head, gaps(), baseBaseline, ['pdf-ops']), CURVE).basis).toBe('tracked-quality-gap');
      expect(rowOf(judgedWith([curve(2.5)], head, gaps(), baseBaseline, ['raw']), CURVE).basis).toBe('gap-not-backed');
      expect(rowOf(judgedWith([curve(2.5)], head, gaps(), baseBaseline, []), CURVE).basis).toBe('gap-not-backed');
    });

    it('fails closed on a baseline entry that holds no value, and reports the refusal of an entry whose row is absent', () => {
      const noValue: Baseline = { schemaVersion: 1, entries: { [CURVE]: { ...baseBaseline.entries[CURVE], ours: null } } };
      expect(rowOf(judgedWith([curve(2.5)], gaps(entry(CURVE, 2.5, 0, 686)), gaps(), noValue), CURVE)).toMatchObject({ outcome: 'fail', basis: 'gap-not-backed' });
      const absent = judgedWith([], gaps(entry(CURVE, 2.5, 0, 686)), gaps());
      expect(absent.rows).toEqual([expect.objectContaining({ id: CURVE, family: 'raw', case: 'raw-canon-r5-raw.cr3->jpg', metric: 'bd_rate_psnr', outcome: 'fail', basis: 'gap-not-backed' })]);
    });

    it('does not look at a speed entry, which the speed backing handles', () => {
      const speedEntry = { id: 'pdf-ops/watermark.pdf->pdf/throughput', issue: 695, ratio: 0.8, note: 'n' };
      const verdict = evaluateParity(report([curve(0)], ['raw']), { schemaVersion: PARITY_SCHEMA_VERSION, gaps: [speedEntry] }, { qualityBase: { gaps: gaps(), baseline: baseBaseline } });
      expect(verdict.rows.map((candidate) => candidate.id)).toEqual([CURVE]);
    });
  });

  describe('the gap file', () => {
    const valid = { id: CHECKS, issue: 783, ratio: null, note: 'n', recorded: 1, reference: 0 };
    it('accepts a quality entry that records its value and the reference then', () => {
      expect(validateGaps({ schemaVersion: 1, gaps: [valid] }).gaps[0]).toEqual(valid);
      expect(validateGaps({ schemaVersion: 1, gaps: [{ ...valid, recorded: -0.5, reference: 0 }] }).gaps[0].recorded).toBe(-0.5);
    });

    it.each<[string, Record<string, unknown>, RegExp]>([
      ['no recorded value', { recorded: undefined }, /recorded must be a finite number/],
      ['a recorded value that is not a number', { recorded: '1' }, /recorded must be a finite number/],
      ['a recorded value that is not finite', { recorded: Number.POSITIVE_INFINITY }, /recorded must be a finite number/],
      ['no reference value', { reference: undefined }, /reference must be a finite number/],
      ['a reference that is not a number', { reference: null }, /reference must be a finite number/],
    ])('rejects a quality entry with %s', (_name, over, message) => {
      expect(() => validateGaps({ schemaVersion: 1, gaps: [{ ...valid, ...over }] })).toThrow(message);
    });

    it('rejects a record on a speed entry, which is judged by its speed history', () => {
      const speedEntry = { id: 'pdf-ops/watermark.pdf->pdf/throughput', issue: 695, ratio: 0.8, note: 'n' };
      expect(() => validateGaps({ schemaVersion: 1, gaps: [{ ...speedEntry, recorded: 1 }] })).toThrow(/recorded is only for quality rows/);
      expect(() => validateGaps({ schemaVersion: 1, gaps: [{ ...speedEntry, reference: 1 }] })).toThrow(/reference is only for quality rows/);
    });

    it('describes a quality gap by its issue and note', () => {
      expect(describeGap(valid)).toBe('known gap, issue #783: n');
    });
  });
});

/** Three runs at the same ratio: the lower edge of the prediction bound is that ratio. */
const FLAT_HISTORY = (ratio: number): { ratio: number; at: string }[] => [1, 2, 3].map((day) => ({ ratio, at: `2026-10-0${day}T02:00:00.000Z` }));

describe('the rendered verdict', () => {
  const gapsFor: GapFile = {
    schemaVersion: PARITY_SCHEMA_VERSION,
    gaps: [
      { id: 'ocr/scan.png->pdf/throughput', issue: 644, ratio: 0.4, note: 'OCR speed', history: FLAT_HISTORY(0.4) },
      { id: 'audio/a.wav->opus/throughput', issue: 642, ratio: 0.4, note: 'opus speed', history: FLAT_HISTORY(0.4) },
    ],
  };
  const speed = (id: string, over: Partial<BenchRow>): BenchRow =>
    row({ id, direction: 'higher', kind: 'throughput', ours: 1, reference: 2, ratio: 0.45, runs: 9, speedVerdict: 'fail', ratioLow: 0.4, ratioHigh: 0.5, ratioMedian: 0.45, ...over });

  it('separates the failing rows, the tracked rows and the rows now at parity', () => {
    const rows = [
      row({ id: 'ocr/scan.png->pdf/cer', direction: 'lower', ours: 9, reference: 2.5, tolerance: { abs: 0.75, rel: 0 } }),
      row({ id: 'ocr/scan.png->pdf/word_f1', direction: 'higher', ours: 1, reference: 1, tolerance: { abs: 0.02, rel: 0 } }),
      speed('ocr/scan.png->pdf/throughput', {}),
      speed('audio/a.wav->opus/throughput', { speedVerdict: 'pass', ratioLow: 1.0, ratioHigh: 1.2, ratioMedian: 1.1, ratio: 1.1 }),
    ];
    const verdict = evaluateParity(report(rows, ['ocr', 'audio']), gapsFor);
    const text = renderParityText(verdict);
    expect(text[0]).toBe(
      'parity: FAIL (4 rows evaluated: 1 failing, 1 tracked below the reference, 1 tracked and now at parity, 1 at or above the reference of which 0 within the measurement allowance; 0 not evaluated)'
    );
    const at = (title: string): number => text.findIndex((line) => line.startsWith(title));
    expect(at('FAILING ROWS (1)')).toBeGreaterThan(0);
    expect(at('TRACKED ROWS')).toBeGreaterThan(at('FAILING ROWS'));
    expect(at('NOW AT PARITY')).toBeGreaterThan(at('TRACKED ROWS'));
    expect(at('AT OR ABOVE THE REFERENCE')).toBeGreaterThan(at('NOW AT PARITY'));
    expect(text[at('FAILING ROWS') + 1]).toMatch(/^ {2}FAIL ocr\/scan\.png->pdf\/cer /);
    expect(text[at('TRACKED ROWS') + 1]).toContain('TRACK ocr/scan.png->pdf/throughput [tracked-gap]');
    expect(text[at('TRACKED ROWS') + 1]).toContain('issue #644');
    expect(text[at('TRACKED ROWS') + 1]).toContain('[0.4, 0.5]');
    expect(text[at('NOW AT PARITY') + 1]).toContain('DONE audio/a.wav->opus/throughput');
    const markdown = renderParityMarkdown(verdict);
    expect(markdown).toContain('**Reference parity: FAIL**');
    expect(markdown).toContain('#### Failing rows (1)');
    expect(markdown).toContain('#### Tracked rows: below the reference, listed in bench/parity-gaps.json (1)');
    expect(markdown).toContain('#### Now at parity: remove from bench/parity-gaps.json (1)');
    expect(markdown).toContain('| ocr/scan.png->pdf/cer | below-reference |');
  });

  it('omits the sections that have no rows', () => {
    const verdict = evaluateParity(report([row({ id: 'ocr/scan.png->pdf/word_f1', direction: 'higher', ours: 1, reference: 1, tolerance: { abs: 0.02, rel: 0 } })], ['ocr']), NO_GAPS);
    const headings = renderParityText(verdict).filter((line) => /^[A-Z]/.test(line) && !line.startsWith('parity:'));
    expect(headings).toEqual(['AT OR ABOVE THE REFERENCE (1)']);
  });
});

describe('the command line', () => {
  it('accepts the parity flags only together with --parity, and not the contradictory ones', () => {
    expect(parseArgs(['--parity', '--quality-only', '--quick', '--family', 'document'])).toMatchObject({ parity: true, qualityOnly: true, quick: true, speedOnly: false, families: ['document'] });
    expect(parseArgs(['--parity', '--speed-only'])).toMatchObject({ parity: true, speedOnly: true });
    expect(() => parseArgs(['--quick'])).toThrow(/--quick needs --parity/);
    expect(() => parseArgs(['--quality-only'])).toThrow(/--quality-only needs --parity/);
    expect(() => parseArgs(['--base-baseline', 'base.json'])).toThrow(/--base-baseline needs --parity/);
    expect(() => parseArgs(['--speed-only'])).toThrow(/--speed-only needs --parity/);
    expect(() => parseArgs(['--parity', '--quality-only', '--speed-only'])).toThrow(/exclude each other/);
    expect(() => parseArgs(['--parity', '--update-baseline'])).toThrow(BenchArgumentError);
    expect(() => parseArgs(['--parity', '--no-gate'])).toThrow(/--no-gate/);
  });
});

describe('a parity run on a saved report', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-parity-'));
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const BD_ID = 'image/a.jpg->webp/bd_rate_psnr';
  const SSIM_ID = 'image/a.jpg->webp/ssim';
  const SPEED_ID = 'image/a.jpg->webp/throughput';
  type Entry = { direction: string; tolerance: { abs: number; rel: number }; ours: number | null; delta: number | null; ratio: number | null };
  /** Hand-written baseline in the on-disk shape: each metric at the value the passing report below has. */
  const baselineEntries = (speedRatio: number): Record<string, Entry> => ({
    [BD_ID]: { direction: 'lower', tolerance: { abs: 1.5, rel: 0 }, ours: -2, delta: -2, ratio: null },
    [SSIM_ID]: { direction: 'higher', tolerance: { abs: 0.003, rel: 0 }, ours: 0.96, delta: 0.01, ratio: null },
    [SPEED_ID]: { direction: 'higher', tolerance: { abs: 0, rel: 0.35 }, ours: null, delta: null, ratio: speedRatio },
  });
  const rowsWith = (bd: number, ssim: number, speed: 'pass' | 'fail'): BenchRow[] => [
    row({ id: BD_ID, direction: 'lower', kind: 'bdrate', ours: bd, reference: 0, tolerance: { abs: 1.5, rel: 0 } }),
    row({ id: SSIM_ID, direction: 'higher', ours: ssim, reference: 0.95, tolerance: { abs: 0.003, rel: 0 } }),
    speed === 'pass'
      ? row({ id: SPEED_ID, direction: 'higher', kind: 'throughput', ours: 22, reference: 20, ratio: 1.1, runs: 9, speedVerdict: 'pass', ratioLow: 1.0, ratioHigh: 1.2, ratioMedian: 1.1, tolerance: { abs: 0, rel: 0.35 } })
      : row({ id: SPEED_ID, direction: 'higher', kind: 'throughput', ours: 10, reference: 20, ratio: 0.5, runs: 9, speedVerdict: 'fail', ratioLow: 0.4, ratioHigh: 0.6, ratioMedian: 0.5, tolerance: { abs: 0, rel: 0.35 } }),
  ];

  /** Writes the report, baseline and gaps files, runs the command and returns the printed lines and the verdict file. */
  async function run(rows: BenchRow[], options: { baseline?: Record<string, Entry>; baseBaseline?: Record<string, Entry> | null; flags?: string[]; gaps?: unknown[]; baseGaps?: unknown[]; families?: BenchReport['families']; shard?: string } = {}): Promise<{ code: number; lines: string[]; verdict: ParityRunFile }> {
    const files = { report: path.join(dir, 'report.json'), baseline: path.join(dir, 'baseline.json'), gaps: path.join(dir, 'gaps.json'), baseGaps: path.join(dir, 'base-gaps.json'), baseBaseline: path.join(dir, 'base-baseline.json') };
    fs.writeFileSync(files.report, JSON.stringify(report(rows, options.families)));
    fs.writeFileSync(files.baseline, JSON.stringify({ schemaVersion: 1, entries: options.baseline ?? baselineEntries(1.1) }));
    fs.writeFileSync(files.gaps, JSON.stringify({ schemaVersion: 1, gaps: options.gaps ?? [] }));
    if (options.baseGaps) fs.writeFileSync(files.baseGaps, JSON.stringify({ schemaVersion: 1, gaps: options.baseGaps }));
    // The base's baseline travels with its gap file, as in the workflow; unless a test says otherwise it is the one the run uses.
    const baseBaseline = options.baseBaseline === null ? undefined : (options.baseBaseline ?? (options.baseGaps ? baselineEntries(1.1) : undefined));
    if (baseBaseline) fs.writeFileSync(files.baseBaseline, JSON.stringify({ schemaVersion: 1, entries: baseBaseline }));
    const lines: string[] = [];
    const code = await main(['--parity', '--compare-report', files.report, '--baseline', files.baseline, '--gaps', files.gaps, ...(options.baseGaps ? ['--base-gaps', files.baseGaps] : []), ...(baseBaseline ? ['--base-baseline', files.baseBaseline] : []), '--family', options.shard ?? 'image', '--out', dir, ...(options.flags ?? [])], (line) => lines.push(line));
    return { code, lines, verdict: JSON.parse(fs.readFileSync(path.join(dir, PARITY_VERDICT_FILE), 'utf8')) as ParityRunFile };
  }

  it('exits 0 and writes a passing verdict when every row is at or above the reference and at its baseline', async () => {
    const { code, lines, verdict } = await run(rowsWith(-2, 0.96, 'pass'));
    expect(code).toBe(0);
    expect(lines.some((line) => line.startsWith('parity: PASS'))).toBe(true);
    expect(verdict).toMatchObject({ exitCode: 0, quick: false, scope: 'both', baseline: { regressions: [] }, parity: { verdict: 'pass' } });
    expect(fs.existsSync(path.join(dir, 'parity-verdict.md'))).toBe(true);
  });

  it('exits 3 and names an untracked slow row as not a known gap', async () => {
    const { code, lines, verdict } = await run(rowsWith(-2, 0.96, 'fail'), { baseline: baselineEntries(0.5) });
    expect(code).toBe(3);
    expect(lines).toContain(
      `BELOW REFERENCE ${SPEED_ID}: speed ratio 0.5 [0.4, 0.6] over 9 pairs; the upper bound is below 0.97, so ours is slower than the reference [not a known gap: bring it to parity, or file a gap issue and list the row in bench/parity-gaps.json]`
    );
    expect(verdict).toMatchObject({ exitCode: 3, baseline: { regressions: [] }, parity: { verdict: 'fail', summary: { fail: 1 } } });
  });

  it('exits 0 for the same slow row once it is tracked at its ratio, and lists it in the tracked section', async () => {
    const { code, lines, verdict } = await run(rowsWith(-2, 0.96, 'fail'), { baseline: baselineEntries(0.5), gaps: [{ id: SPEED_ID, issue: 487, ratio: 0.5, note: 'LZMA speed', history: FLAT_HISTORY(0.5) }] });
    expect(code).toBe(0);
    expect(lines.some((line) => line.startsWith('TRACKED ROWS'))).toBe(true);
    expect(lines.some((line) => line.includes('TRACK image/a.jpg->webp/throughput [tracked-gap]') && line.includes('issue #487'))).toBe(true);
    expect(verdict.parity.summary).toMatchObject({ fail: 0, tracked: 1 });
  });

  describe('a gap entry the change adds or edits', () => {
    // The slow row measures 0.5 [0.4, 0.6]. An honest entry is near that; a made-up one is far from it.
    const entry = (ratio: number, extra: Record<string, unknown> = {}): Record<string, unknown> => ({ id: SPEED_ID, issue: 641, ratio, note: 'AVIF speed', history: FLAT_HISTORY(ratio).map((point) => ({ ...point, commit: 'b'.repeat(40) })), ...extra });
    const slow = (): BenchRow[] => rowsWith(-2, 0.96, 'fail');

    it('exits 3 for the bypass: a new image gap recorded at 0.1, far below what this run measured', async () => {
      const { code, lines, verdict } = await run(slow(), { baseline: baselineEntries(0.5), gaps: [entry(0.1)], baseGaps: [] });
      expect(code).toBe(3);
      expect(lines.some((line) => line.startsWith(`BELOW REFERENCE ${SPEED_ID}: known-gap entry not backed by this run: the recorded ratio 0.1 is outside [`))).toBe(true);
      expect(verdict.parity.rows.find((candidate) => candidate.id === SPEED_ID)).toMatchObject({ outcome: 'fail', basis: 'gap-not-backed' });
    });

    it('exits 0 for the same entry at a ratio this run measures, and when the run does not measure speed', async () => {
      expect((await run(slow(), { baseline: baselineEntries(0.5), gaps: [entry(0.45)], baseGaps: [] })).code).toBe(0);
      // The quality job cannot back an entry; the speed job of the same change does (the changed family is mapped to it).
      expect((await run(slow(), { baseline: baselineEntries(0.5), gaps: [entry(0.1)], baseGaps: [], flags: ['--quality-only'] })).code).toBe(0);
    });

    it('checks only the entries of the family the shard measures: a shard of another family leaves them to its own shard', async () => {
      const pdf = { id: 'pdf-ops/split.pdf->pdf/throughput', issue: 695, ratio: 0.3, note: 'PDF speed', history: FLAT_HISTORY(0.3).map((point) => ({ ...point, commit: 'b'.repeat(40) })) };
      // The image shard does not measure pdf-ops, so the new pdf-ops entry is not its to back; its own entry is.
      expect((await run(slow(), { baseline: baselineEntries(0.5), gaps: [entry(0.45), pdf], baseGaps: [entry(0.45)] })).code).toBe(0);
      // The bypass stays closed in the shard that measures the family, even with another family's entry present.
      const bypass = await run(slow(), { baseline: baselineEntries(0.5), gaps: [entry(0.1), pdf], baseGaps: [] });
      expect(bypass.code).toBe(3);
      expect(bypass.verdict.parity.rows.filter((candidate) => candidate.basis === 'gap-not-backed').map((candidate) => candidate.id)).toEqual([SPEED_ID]);
      // The pdf-ops shard, which does not measure the entry, still refuses it.
      const pdfRow = row({ id: 'pdf-ops/extract.pdf->pdf/throughput', direction: 'higher', kind: 'throughput', ours: 10, reference: 20, ratio: 0.5, runs: 9, speedVerdict: 'fail', ratioLow: 0.4, ratioHigh: 0.6, ratioMedian: 0.5, tolerance: { abs: 0, rel: 0.35 } });
      const measuredElsewhere = await run([pdfRow], { baseline: baselineEntries(0.5), gaps: [pdf], baseGaps: [], shard: 'pdf-ops' });
      expect(measuredElsewhere.code).toBe(3);
      expect(measuredElsewhere.lines.some((line) => line.includes('this run did not measure pdf-ops/split.pdf->pdf/throughput'))).toBe(true);
    });

    it('takes the shard from the --family argument, which the change cannot write, not from the report it produced', async () => {
      // A family whose runner emitted no rows is still the shard's family: its fake entry is refused, not skipped.
      const bypass = await run([], { baseline: {}, gaps: [entry(0.1)], baseGaps: [] });
      expect(bypass.code).toBe(3);
      expect(bypass.lines.some((line) => line.includes(`this run did not measure ${SPEED_ID}`))).toBe(true);
      // report.families says nothing: [] with image rows still checks the image entry, and pdf-ops rows do not move the shard.
      expect((await run(slow(), { baseline: baselineEntries(0.5), gaps: [entry(0.1)], baseGaps: [], families: [] })).code).toBe(3);
      const rowsOfOtherFamily = await run([...slow(), row({ id: 'pdf-ops/extract.pdf->pdf/throughput', direction: 'higher', kind: 'throughput', ours: 22, reference: 20, ratio: 1.1, runs: 9, speedVerdict: 'pass', ratioLow: 1.0, ratioHigh: 1.2, ratioMedian: 1.1, tolerance: { abs: 0, rel: 0.35 } })], {
        baseline: baselineEntries(0.5),
        gaps: [entry(0.45)],
        baseGaps: [entry(0.45)],
      });
      expect(rowsOfOtherFamily.code).toBe(0);
    });

    it('treats an empty families list like an absent one: every changed entry is checked, none is skipped', () => {
      const gaps: GapFile = { schemaVersion: PARITY_SCHEMA_VERSION, gaps: [entry(0.1) as unknown as GapFile['gaps'][number]] };
      const baseGaps: GapFile = { schemaVersion: PARITY_SCHEMA_VERSION, gaps: [] };
      const bypassed = (families: BenchReport['families'] | undefined): string[] =>
        evaluateParity(report(slow()), gaps, { baseGaps, families }).rows.filter((candidate) => candidate.basis === 'gap-not-backed').map((candidate) => candidate.id);
      expect(bypassed(undefined)).toEqual([SPEED_ID]);
      expect(bypassed([])).toEqual([SPEED_ID]);
      // A non-empty list still narrows the check to its families.
      expect(bypassed(['pdf-ops'])).toEqual([]);
    });

    it('checks an edit of a ratio, and leaves an entry the base already has as it is recorded', async () => {
      expect((await run(slow(), { baseline: baselineEntries(0.5), gaps: [entry(0.1)], baseGaps: [entry(0.5)] })).code).toBe(3);
      expect((await run(slow(), { baseline: baselineEntries(0.5), gaps: [entry(0.45)], baseGaps: [entry(0.45)] })).code).toBe(0);
    });

    it('refuses an entry for a row this run did not measure, and a made-up history point', async () => {
      const other = { id: 'image/b.jpg->webp/throughput', issue: 641, ratio: 0.5, note: 'AVIF speed', history: FLAT_HISTORY(0.5).map((point) => ({ ...point, commit: 'b'.repeat(40) })) };
      const unmeasured = await run(slow(), { baseline: baselineEntries(0.5), gaps: [entry(0.45), other], baseGaps: [entry(0.45)] });
      expect(unmeasured.code).toBe(3);
      expect(unmeasured.lines.some((line) => line.includes('this run did not measure image/b.jpg->webp/throughput'))).toBe(true);
      const withoutCommit = await run(slow(), { baseline: baselineEntries(0.5), gaps: [entry(0.45, { history: [...(entry(0.45).history as unknown[]), { ratio: 0.45, at: '2026-10-09T02:00:00.000Z' }] })], baseGaps: [entry(0.45)] });
      expect(withoutCommit.code).toBe(3);
      expect(withoutCommit.lines.some((line) => line.includes('is new and has no commit'))).toBe(true);
      const recorded = await run(slow(), {
        baseline: baselineEntries(0.5),
        gaps: [entry(0.45, { history: [...(entry(0.45).history as unknown[]), { ratio: 0.46, at: '2026-10-09T02:00:00.000Z', commit: 'a'.repeat(40) }] })],
        baseGaps: [entry(0.45)],
      });
      expect(recorded.code).toBe(0);
    });
  });

  describe('a speed row of a public sample', () => {
    // wm-deep-dart.png is a sample of the remote manifest: the nightly run times it, and a pull request's speed job (BENCH_CORPUS_TIER=pr) does not.
    const PUBLIC_ID = 'image/wm-deep-dart.png->avif/throughput';
    const publicRow = (median: number): BenchRow[] => [
      row({ id: PUBLIC_ID, direction: 'higher', kind: 'throughput', ours: 10 * median, reference: 10, ratio: median, runs: 9, speedVerdict: 'fail', ratioLow: median - 0.1, ratioHigh: median + 0.1, ratioMedian: median, tolerance: { abs: 0, rel: 0.35 } }),
    ];
    const entry = (ratio: number, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
      id: PUBLIC_ID,
      issue: 641,
      ratio,
      note: 'AVIF speed',
      history: FLAT_HISTORY(ratio).map((point) => ({ ...point, commit: 'b'.repeat(40) })),
      ...extra,
    });
    const baseline = { [PUBLIC_ID]: { direction: 'higher', tolerance: { abs: 0, rel: 0.35 }, ours: null, delta: null, ratio: 0.5 } };

    it('passes inside the bound of its history in the nightly run, which times it, and fails below the bound', async () => {
      vi.stubEnv(CORPUS_TIER_ENV, 'full');
      const inside = await run(publicRow(0.5), { baseline, gaps: [entry(0.5)] });
      expect(inside.code).toBe(0);
      expect(inside.verdict.parity.rows.find((candidate) => candidate.id === PUBLIC_ID)).toMatchObject({ outcome: 'pass', basis: 'tracked-gap' });
      const below = await run(publicRow(0.3), { baseline, gaps: [entry(0.5)] });
      expect(below.code).toBe(3);
      expect(below.lines.some((line) => line.startsWith('BELOW REFERENCE') && line.includes(PUBLIC_ID) && line.includes('got slower than its history'))).toBe(true);
      const untracked = await run(publicRow(0.5), { baseline });
      expect(untracked.verdict.parity.rows.find((candidate) => candidate.id === PUBLIC_ID)).toMatchObject({ outcome: 'fail', basis: 'speed-below-reference' });
    });

    it('is a new entry of a pull request that does not time the row: its form is checked, and the nightly run holds the numbers', async () => {
      vi.stubEnv(CORPUS_TIER_ENV, 'pr');
      const generated = rowsWith(-2, 0.96, 'pass');
      expect((await run(generated, { baseline: baselineEntries(1.1), gaps: [entry(0.5)], baseGaps: [] })).code).toBe(0);
      const withoutCommit = await run(generated, { baseline: baselineEntries(1.1), gaps: [entry(0.5, { history: FLAT_HISTORY(0.5) })], baseGaps: [] });
      expect(withoutCommit.code).toBe(3);
      expect(withoutCommit.lines.some((line) => line.includes('is new and has no commit'))).toBe(true);
    });

    it('still has to be backed by the run when the run times it', async () => {
      vi.stubEnv(CORPUS_TIER_ENV, 'full');
      const bypass = await run(publicRow(0.5), { baseline, gaps: [entry(0.1)], baseGaps: [] });
      expect(bypass.code).toBe(3);
      expect(bypass.lines.some((line) => line.includes('the recorded ratio 0.1 is outside'))).toBe(true);
      expect((await run(publicRow(0.5), { baseline, gaps: [entry(0.45)], baseGaps: [] })).code).toBe(0);
    });
  });

  it('exits 3 when a tracked row got slower than its history predicts', async () => {
    const gaps = [{ id: SPEED_ID, issue: 487, ratio: 0.9, note: 'LZMA speed', history: FLAT_HISTORY(0.9) }];
    const slower = await run(rowsWith(-2, 0.96, 'fail'), { baseline: baselineEntries(0.5), gaps });
    expect(slower.code).toBe(3);
    expect(slower.lines.some((line) => line.startsWith('BELOW REFERENCE') && line.includes('got slower than its history'))).toBe(true);
  });

  it('never fails the baseline gate on a speed ratio, which is printed as a note, while a quality regression still exits 1', async () => {
    const gaps = [{ id: SPEED_ID, issue: 487, ratio: 0.5, note: 'LZMA speed', history: FLAT_HISTORY(0.5) }];
    const noisy = await run(rowsWith(-2, 0.96, 'fail'), { baseline: baselineEntries(1.1), gaps });
    expect(noisy.code).toBe(0);
    expect(noisy.verdict.baseline.regressions).toEqual([]);
    expect(noisy.lines.some((line) => line.startsWith(`note ${SPEED_ID}: speed ratio to the reference tool 0.5 is under baseline 1.1`))).toBe(true);
    const regressed = await run(rowsWith(-2, 0.9, 'fail'), { baseline: baselineEntries(1.1), gaps });
    expect(regressed.code).toBe(1);
    expect(regressed.lines.some((line) => line.startsWith(`REGRESSION ${SSIM_ID}`))).toBe(true);
  });

  describe('a quality gap in a run', () => {
    const gapAt = (recorded: number): Record<string, unknown> => ({ id: BD_ID, issue: 640, ratio: null, note: 'curve', recorded, reference: 0 });
    const baselineAt4 = (): Record<string, Entry> => ({ ...baselineEntries(1.1), [BD_ID]: { ...baselineEntries(1.1)[BD_ID], ours: 4, delta: 4 } });

    it('exits 3 for a BD-rate behind the reference that no entry lists', async () => {
      const { code, lines } = await run(rowsWith(4, 0.96, 'pass'), { baseline: baselineAt4() });
      expect(code).toBe(3);
      expect(lines.some((line) => line.startsWith(`BELOW REFERENCE ${BD_ID}`) && line.includes('not a known gap'))).toBe(true);
    });

    it('exits 0 and lists the row as tracked once an entry records the value it has', async () => {
      const { code, lines, verdict } = await run(rowsWith(4, 0.96, 'pass'), { baseline: baselineAt4(), gaps: [gapAt(4)] });
      expect(code).toBe(0);
      expect(lines.some((line) => line.includes(`TRACK ${BD_ID} [tracked-quality-gap]`) && line.includes('issue #640'))).toBe(true);
      expect(verdict.parity.summary).toMatchObject({ fail: 0, tracked: 1 });
    });

    it('exits 3 when the row is worse than the value the entry records', async () => {
      const { code, lines } = await run(rowsWith(4, 0.96, 'pass'), { baseline: baselineAt4(), gaps: [gapAt(2)] });
      expect(code).toBe(3);
      expect(lines.some((line) => line.startsWith(`BELOW REFERENCE ${BD_ID}`) && line.includes('known gap, issue #640'))).toBe(true);
    });

    it('still exits 1 for a metric worse than our own baseline, which an entry does not excuse', async () => {
      const baseline = { ...baselineEntries(1.1), [BD_ID]: { ...baselineEntries(1.1)[BD_ID], ours: 1, delta: 1 } };
      expect((await run(rowsWith(4, 0.96, 'pass'), { baseline, gaps: [gapAt(4)] })).code).toBe(1);
    });

    it('exits 3 for a new entry worse than the baseline of the base branch, and 0 once the base holds the entry', async () => {
      // The base's baseline has the curve at -2 with a tolerance of 1.5: +4 is past anything it let the row reach.
      const rows = rowsWith(4, 0.96, 'pass');
      const refused = await run(rows, { baseline: baselineAt4(), gaps: [gapAt(4)], baseGaps: [] });
      expect(refused.code).toBe(3);
      expect(refused.lines.some((line) => line.startsWith(`BELOW REFERENCE ${BD_ID}: known-gap entry not backed by this run`))).toBe(true);
      expect(refused.verdict.parity.rows.find((candidate) => candidate.id === BD_ID)).toMatchObject({ outcome: 'fail', basis: 'gap-not-backed' });
      expect((await run(rows, { baseline: baselineAt4(), gaps: [gapAt(4)], baseGaps: [gapAt(4)] })).code).toBe(0);
      // A new row (the base's baseline does not know it) is allowed; the run holds its record against the measured value.
      const { [BD_ID]: _curve, ...withoutCurve } = baselineEntries(1.1);
      expect((await run(rows, { baseline: baselineAt4(), gaps: [gapAt(4)], baseGaps: [], baseBaseline: withoutCurve })).code).toBe(0);
    });

    it('needs the baseline of the base wherever it judges quality rows against the base gap file', async () => {
      await expect(run(rowsWith(4, 0.96, 'pass'), { baseline: baselineAt4(), gaps: [gapAt(4)], baseGaps: [], baseBaseline: null })).rejects.toThrow(/--base-baseline/);
      await expect(run(rowsWith(4, 0.96, 'pass'), { baseline: baselineAt4(), gaps: [gapAt(4)], baseGaps: [], baseBaseline: null, flags: ['--quality-only'] })).rejects.toThrow(/--base-baseline/);
      // A speed run backs speed entries only and has no use for it.
      expect((await run(rowsWith(4, 0.96, 'pass'), { baseline: baselineAt4(), gaps: [gapAt(4)], baseGaps: [], baseBaseline: null, flags: ['--speed-only'] })).code).toBe(0);
    });

    it('exits 3 for an entry whose row this run should have produced, and leaves it alone when the run is not about quality rows', async () => {
      const lost = [...rowsWith(-2, 0.96, 'pass')].filter((candidate) => candidate.id !== BD_ID);
      const baseline = baselineEntries(1.1);
      delete baseline[BD_ID];
      const missing = await run(lost, { baseline, gaps: [gapAt(4)] });
      expect(missing.code).toBe(3);
      expect(missing.lines.some((line) => line.startsWith(`BELOW REFERENCE ${BD_ID}`) && line.includes('did not produce'))).toBe(true);
      expect((await run(lost, { baseline, gaps: [gapAt(4)], flags: ['--speed-only'] })).code).toBe(0);
      expect((await run(lost, { baseline, gaps: [{ ...gapAt(4), id: 'pdf-ops/a.pdf->compress/pdf_check_failures' }] })).code).toBe(0);
    });
  });

  it('exits 3 for a BD-rate behind the reference and names that row', async () => {
    const baseline = baselineEntries(1.1);
    baseline[BD_ID] = { ...baseline[BD_ID], ours: 4, delta: 4 };
    const { code, lines } = await run(rowsWith(4, 0.96, 'pass'), { baseline });
    expect(code).toBe(3);
    expect(lines.filter((line) => line.startsWith('BELOW REFERENCE'))).toEqual([expect.stringContaining(BD_ID)]);
  });

  it('exits 1 when a metric is worse than our own baseline, even though the verdict is also below the reference', async () => {
    const { code, lines, verdict } = await run(rowsWith(-2, 0.9, 'fail'));
    expect(code).toBe(1);
    expect(lines.some((line) => line.startsWith(`REGRESSION ${SSIM_ID}`))).toBe(true);
    expect(verdict.exitCode).toBe(1);
    expect(verdict.baseline.regressions.length).toBeGreaterThan(0);
    expect(verdict.parity.verdict).toBe('fail');
  });

  it('checks only the quality entries of the baseline under --quality-only, and only the quick cases under --quick', async () => {
    const baseline = {
      ...baselineEntries(1.1),
      'image/photo-b.png->webp/ssim': { direction: 'higher', tolerance: { abs: 0.003, rel: 0 }, ours: 0.9, delta: 0, ratio: null },
    };
    // Only the quality rows of one case: the speed entry and the photo-b entry are not in the report.
    const rows = rowsWith(-2, 0.96, 'pass').slice(0, 2);
    const missing = async (flags: string[]): Promise<string[]> => {
      const { lines } = await run(rows, { baseline, flags });
      return lines.filter((line) => line.startsWith('REGRESSION')).map((line) => line.split(':')[0].replace('REGRESSION ', ''));
    };
    expect(await missing([])).toEqual([SPEED_ID, 'image/photo-b.png->webp/ssim']);
    expect(await missing(['--quality-only'])).toEqual(['image/photo-b.png->webp/ssim']);
    expect(await missing(['--quality-only', '--quick'])).toEqual([]);
    expect(await missing(['--speed-only'])).toEqual([SPEED_ID]);
  });
});
