import { describe, expect, it } from 'vitest';
import { buildBaseline, evaluateGate, validateBaseline, type Baseline } from '../bench/gate';
import { SCHEMA_VERSION } from '../bench/config';
import { ReportSchemaError } from '../bench/errors';
import type { BenchReport, BenchRow } from '../bench/report';

/**
 * Gate behaviour on hand-written reports: every number below is typed in, nothing is produced by a conversion or
 * by the module under test, so the gate is checked against the rule it documents (worse than baseline by more than
 * the tolerance fails; equal or within tolerance passes; direction decides what worse means).
 */

function row(partial: Partial<BenchRow> & Pick<BenchRow, 'id' | 'metric' | 'direction' | 'ours' | 'reference'>): BenchRow {
  const [family, caseName] = partial.id.split('/');
  return {
    family: family as BenchRow['family'],
    case: caseName,
    unit: 'unit',
    kind: 'quality',
    status: 'measured',
    delta: partial.ours === null || partial.reference === null ? null : partial.ours - partial.reference,
    ratio: null,
    referenceTool: 'reference tool',
    tolerance: { abs: 0.01, rel: 0 },
    ...partial,
  };
}

function report(rows: BenchRow[]): BenchReport {
  return {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: '2026-01-01T00:00:00.000Z',
    strictMode: false,
    families: ['image'],
    host: { platform: 'linux', arch: 'x64', node: 'v20.0.0', cpus: 4 },
    tools: {},
    settings: { runs: 3, injectedRegression: null },
    rows,
  };
}

const SSIM_ID = 'image/photo.jpg->webp/ssim';
const BYTES_ID = 'image/photo.jpg->webp/bytes';
const SPEED_ID = 'image/photo.jpg->webp/throughput';

function baselineRows(): BenchRow[] {
  return [
    row({ id: SSIM_ID, metric: 'ssim', direction: 'higher', ours: 0.95, reference: 0.96 }),
    row({ id: BYTES_ID, metric: 'bytes', direction: 'lower', ours: 10_000, reference: 9_800, tolerance: { abs: 0, rel: 0.03 }, kind: 'size' }),
    row({ id: SPEED_ID, metric: 'throughput', direction: 'higher', ours: 2.0, reference: 4.0, ratio: 0.5, kind: 'throughput', tolerance: { abs: 0, rel: 0.35 } }),
  ];
}

const BASELINE: Baseline = buildBaseline(report(baselineRows()), null);

function withRow(id: string, change: Partial<BenchRow>): BenchReport {
  return report(baselineRows().map((r) => (r.id === id ? { ...r, ...change } : r)));
}

describe('regression gate', () => {
  it('passes a report equal to the baseline', () => {
    const result = evaluateGate(report(baselineRows()), BASELINE);
    expect(result.regressions).toEqual([]);
    expect(result.compared).toBe(3);
  });

  it('fails an injected worse value and names the metric', () => {
    const worse = withRow(SSIM_ID, { ours: 0.9, delta: 0.9 - 0.96 });
    const result = evaluateGate(worse, BASELINE);
    expect(result.regressions.map((r) => r.id)).toEqual([SSIM_ID, SSIM_ID]);
    expect(result.regressions.map((r) => r.check).sort()).toEqual(['baseline', 'reference-delta']);
    expect(result.regressions[0].message).toContain(SSIM_ID);
    expect(result.regressions[0].message).toContain('0.9');
  });

  it('applies the direction: a larger size fails, a smaller size passes', () => {
    const larger = withRow(BYTES_ID, { ours: 10_500, delta: 10_500 - 9_800 });
    expect(evaluateGate(larger, BASELINE).regressions.map((r) => r.id)).toContain(BYTES_ID);
    const smaller = withRow(BYTES_ID, { ours: 9_000, delta: 9_000 - 9_800 });
    const result = evaluateGate(smaller, BASELINE);
    expect(result.regressions).toEqual([]);
    expect(result.improvements).toEqual([BYTES_ID]);
  });

  it('tolerates a change inside the tolerance and fails the first value past it', () => {
    const inside = withRow(SSIM_ID, { ours: 0.941, delta: 0.941 - 0.96 });
    expect(evaluateGate(inside, BASELINE).regressions).toEqual([]);
    const outside = withRow(SSIM_ID, { ours: 0.9399, delta: 0.9399 - 0.96 });
    expect(evaluateGate(outside, BASELINE).regressions.length).toBeGreaterThan(0);
    const relativeEdge = withRow(BYTES_ID, { ours: 10_300, delta: 10_300 - 9_800 });
    expect(evaluateGate(relativeEdge, BASELINE).regressions).toEqual([]);
  });

  it('fails when the reference got better even though our own value is unchanged', () => {
    const referenceImproved = withRow(SSIM_ID, { reference: 0.99, delta: 0.95 - 0.99 });
    const result = evaluateGate(referenceImproved, BASELINE);
    expect(result.regressions.map((r) => r.check)).toEqual(['reference-delta']);
    expect(result.regressions[0].id).toBe(SSIM_ID);
  });

  it('never fails a throughput row: absolute speed and a drifting speed ratio are only reported', () => {
    // A faster or slower machine moves the absolute numbers; the ratio to the reference drifts with the runner's load.
    const fasterMachine = withRow(SPEED_ID, { ours: 20, reference: 40, delta: -20, ratio: 0.5 });
    const faster = evaluateGate(fasterMachine, BASELINE);
    expect(faster.regressions).toEqual([]);
    expect(faster.speedNotes).toEqual([]);
    const slowerThanReference = withRow(SPEED_ID, { ours: 1.0, reference: 4.0, delta: -3, ratio: 0.25 });
    const result = evaluateGate(slowerThanReference, BASELINE);
    expect(result.regressions).toEqual([]);
    expect(result.compared).toBe(3);
    expect(result.speedNotes).toEqual([`${SPEED_ID}: speed ratio to the reference tool 0.25 is under baseline 0.5 by more than 0.175 (informational, speed is judged by the parity speed jobs)`]);
  });

  it('keeps the speed ratio informational at the tolerance edge, and still requires the row to be produced', () => {
    // Tolerance is 0.35 * 0.5 = 0.175: a ratio of 0.33 is inside it, 0.32 is outside.
    expect(evaluateGate(withRow(SPEED_ID, { ratio: 0.33 }), BASELINE).speedNotes).toEqual([]);
    expect(evaluateGate(withRow(SPEED_ID, { ratio: 0.32 }), BASELINE).speedNotes).toHaveLength(1);
    const without = report(baselineRows().filter((r) => r.id !== SPEED_ID));
    expect(evaluateGate(without, BASELINE).regressions.map((r) => [r.id, r.check])).toEqual([[SPEED_ID, 'missing']]);
  });

  it('names every regressed metric, not only the first', () => {
    const worse: Record<string, Partial<BenchRow>> = {
      [SSIM_ID]: { ours: 0.8, delta: 0.8 - 0.96 },
      [BYTES_ID]: { ours: 20_000, delta: 20_000 - 9_800 },
    };
    const rows = baselineRows().map((r) => ({ ...r, ...worse[r.id] }));
    const ids = new Set(evaluateGate(report(rows), BASELINE).regressions.map((r) => r.id));
    expect(ids).toEqual(new Set([SSIM_ID, BYTES_ID]));
  });

  it('flags a baseline metric that disappeared, but not one that was skipped, and lists new metrics', () => {
    const without = report(baselineRows().filter((r) => r.id !== SSIM_ID));
    expect(evaluateGate(without, BASELINE).regressions.map((r) => [r.id, r.check])).toEqual([[SSIM_ID, 'missing']]);
    const skipped = withRow(SSIM_ID, { status: 'skipped', ours: null, reference: null, delta: null, skipKind: 'missing-tool', skipReason: 'tool not installed: cwebp' });
    const result = evaluateGate(skipped, BASELINE);
    expect(result.regressions).toEqual([]);
    expect(result.skipped).toEqual([SSIM_ID]);
    const extra = report([...baselineRows(), row({ id: 'image/photo.jpg->webp/psnr', metric: 'psnr', direction: 'higher', ours: 40, reference: 41 })]);
    expect(evaluateGate(extra, BASELINE).unbaselined).toEqual(['image/photo.jpg->webp/psnr']);
  });

  it('only requires baseline entries of the families that were run', () => {
    const other = buildBaseline(report([row({ id: 'audio/a.wav->opus/snr', metric: 'snr', direction: 'higher', ours: 25, reference: 25 })]), BASELINE);
    expect(evaluateGate(report(baselineRows()), other).regressions.map((r) => r.check)).toEqual(['missing']);
    expect(evaluateGate(report(baselineRows()), other, { families: new Set(['image']) }).regressions).toEqual([]);
  });
});

describe('a run that measured only part of the rows', () => {
  it('requires and compares only the baseline entries the predicate accepts', () => {
    const qualityOnly = (_id: string, entry: { ratio: number | null }): boolean => entry.ratio === null;
    const rows = baselineRows().filter((r) => r.kind !== 'throughput');
    const without = evaluateGate(report(rows), BASELINE);
    expect(without.regressions.map((r) => [r.id, r.check])).toEqual([[SPEED_ID, 'missing']]);
    const scoped = evaluateGate(report(rows), BASELINE, { include: qualityOnly });
    expect(scoped.regressions).toEqual([]);
    expect(scoped.compared).toBe(2);
  });

  it('still fails a worse value among the accepted entries, and ignores a worse value among the others', () => {
    const onlySpeed = (_id: string, entry: { ratio: number | null }): boolean => entry.ratio !== null;
    const worseQuality = withRow(SSIM_ID, { ours: 0.8, delta: 0.8 - 0.96 });
    expect(evaluateGate(worseQuality, BASELINE, { include: onlySpeed }).regressions).toEqual([]);
    expect(evaluateGate(worseQuality, BASELINE, { include: (id) => id === SSIM_ID }).regressions.map((r) => r.id)).toContain(SSIM_ID);
  });
});

describe('baseline file', () => {
  it('keeps hand-tuned tolerances and entries of rows not measured this time when updating', () => {
    const tuned: Baseline = { schemaVersion: SCHEMA_VERSION, entries: { ...BASELINE.entries, [SSIM_ID]: { ...BASELINE.entries[SSIM_ID], tolerance: { abs: 0.5, rel: 0 } } } };
    const skippedNow = withRow(BYTES_ID, { status: 'skipped', ours: null, reference: null, delta: null, skipKind: 'missing-tool', skipReason: 'tool not installed: cwebp' });
    const rewritten = buildBaseline(report(skippedNow.rows.map((r) => (r.id === SSIM_ID ? { ...r, ours: 0.97, delta: 0.97 - 0.96 } : r))), tuned);
    expect(rewritten.entries[SSIM_ID].tolerance).toEqual({ abs: 0.5, rel: 0 });
    expect(rewritten.entries[SSIM_ID].ours).toBe(0.97);
    expect(rewritten.entries[BYTES_ID]).toEqual(BASELINE.entries[BYTES_ID]);
    expect(rewritten.entries[SPEED_ID].ours).toBeNull();
    expect(rewritten.entries[SPEED_ID].ratio).toBe(0.5);
  });

  it('rejects malformed baselines with a typed error', () => {
    expect(() => validateBaseline({ schemaVersion: 99, entries: {} })).toThrow(ReportSchemaError);
    expect(() => validateBaseline({ schemaVersion: SCHEMA_VERSION, entries: { a: { direction: 'sideways', tolerance: { abs: 0, rel: 0 }, ours: 1, delta: 0, ratio: null } } })).toThrow(/direction/);
    expect(() => validateBaseline({ schemaVersion: SCHEMA_VERSION, entries: { a: { direction: 'higher', tolerance: { abs: -1, rel: 0 }, ours: 1, delta: 0, ratio: null } } })).toThrow(/non-negative/);
    expect(() => validateBaseline({ schemaVersion: SCHEMA_VERSION, entries: { a: { direction: 'higher', tolerance: { abs: 0, rel: 0 }, ours: null, delta: null, ratio: null } } })).toThrow(/gates nothing/);
    expect(validateBaseline(JSON.parse(JSON.stringify(BASELINE))).entries[SSIM_ID].ours).toBe(0.95);
  });
});
