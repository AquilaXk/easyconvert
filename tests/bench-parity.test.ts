import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PARITY_SCHEMA_VERSION, PARITY_VERDICT_FILE, SCHEMA_VERSION } from '../bench/config';
import { BenchArgumentError, ParityInputError, ReportSchemaError } from '../bench/errors';
import { evaluateParity, failureLines, type ParityRunFile, renderParityMarkdown, renderParityText } from '../bench/parity';
import { describeGap, type GapFile, validateGaps } from '../bench/parity-gaps';
import type { BenchReport, BenchRow } from '../bench/report';
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
  const gaps: GapFile = {
    schemaVersion: PARITY_SCHEMA_VERSION,
    gaps: [
      { id: XZ, issue: 487, ratio: 0.46, note: 'LZMA decode speed' },
      { id: ZST, issue: 497, ratio: 0.5, note: 'zstd level 3 speed' },
      { id: 'image/a.jpg->avif/bd_rate_psnr', issue: 640, ratio: null, note: 'AVIF curve' },
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

  it('passes a tracked slow row that sits at its recorded ratio, and reports it as tracked with its issue', () => {
    const verdict = judged([speed(XZ, { ratioLow: 0.42, ratioHigh: 0.5, ratioMedian: 0.46, ratio: 0.46 })]);
    expect(verdict.verdict).toBe('pass');
    expect(verdict.rows[0]).toMatchObject({ outcome: 'pass', basis: 'tracked-gap' });
    expect(verdict.rows[0].detail).toContain('tracked at 0.46 (issue #487)');
    expect(verdict.summary).toMatchObject({ fail: 0, tracked: 1, nowAtParity: 0 });
  });

  it('passes a tracked row whose upper bound is only just above ratio * (1 - tolerance), and fails one just below it', () => {
    // The floor of the XZ gap is 0.46 * 0.97 = 0.4462.
    expect(judged([speed(XZ, { ratioHigh: 0.447 })]).rows[0]).toMatchObject({ outcome: 'pass', basis: 'tracked-gap' });
    expect(judged([speed(XZ, { ratioHigh: 0.445 })]).rows[0]).toMatchObject({ outcome: 'fail', basis: 'tracked-slower-than-gap' });
  });

  it('fails a tracked row that got slower than its recorded ratio, naming the row and the issue', () => {
    const verdict = judged([speed(XZ, { ratioLow: 0.2, ratioHigh: 0.3, ratioMedian: 0.25, ratio: 0.25 })]);
    expect(verdict.verdict).toBe('fail');
    expect(verdict.rows[0]).toMatchObject({ outcome: 'fail', basis: 'tracked-slower-than-gap' });
    expect(failureLines(verdict)[0]).toMatch(/^BELOW REFERENCE compression\/mixed\.xz->tar\/throughput: .*got slower than its recorded gap.*known gap, issue #487/);
  });

  it('keeps a tracked row that is unstable at the cap but not slower than its gap tracked, not failed', () => {
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

  it('never excuses a quality row: a listed quality gap still fails, with its issue named', () => {
    const bd = row({ id: 'image/a.jpg->avif/bd_rate_psnr', direction: 'lower', kind: 'bdrate', ours: 6, reference: 0, tolerance: { abs: 1.5, rel: 0 } });
    const verdict = judged([bd]);
    expect(verdict.verdict).toBe('fail');
    expect(verdict.rows[0]).toMatchObject({ outcome: 'fail', basis: 'below-reference' });
    expect(failureLines(verdict)[0]).toContain('known gap, issue #640: AVIF curve');
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
    ['a repeated id', { schemaVersion: 1, gaps: [{ id: 'a/b/c', issue: 1, ratio: null, note: 'n' }, { id: 'a/b/c', issue: 2, ratio: null, note: 'n' }] }, /listed twice/],
    ['a null issue', { schemaVersion: 1, gaps: [{ id: 'a/b/throughput', issue: null, ratio: 0.5, note: 'n' }] }, /issue must be a positive integer/],
    ['a missing issue', { schemaVersion: 1, gaps: [{ id: 'a/b/c', ratio: null, note: 'n' }] }, /issue must be a positive integer/],
    ['an issue that is not a positive integer', { schemaVersion: 1, gaps: [{ id: 'a/b/c', issue: 0, ratio: null, note: 'n' }] }, /issue must be a positive integer/],
    ['a speed row without a ratio', { schemaVersion: 1, gaps: [{ id: 'a/b/throughput', issue: 3, ratio: null, note: 'n' }] }, /ratio must be a positive speed ratio/],
    ['a speed row with a non-positive ratio', { schemaVersion: 1, gaps: [{ id: 'a/b/throughput', issue: 3, ratio: 0, note: 'n' }] }, /ratio must be a positive speed ratio/],
    ['a quality row with a ratio', { schemaVersion: 1, gaps: [{ id: 'a/b/ssim', issue: 3, ratio: 0.5, note: 'n' }] }, /ratio must be null for the quality row/],
    ['a missing note', { schemaVersion: 1, gaps: [{ id: 'a/b/c', issue: 3, ratio: null, note: '' }] }, /note/],
  ])('rejects %s', (_name, value, message) => {
    expect(() => validateGaps(value)).toThrow(ReportSchemaError);
    expect(() => validateGaps(value)).toThrow(message);
  });

  it('ships a gap file whose every entry names an issue and a row the baseline records', () => {
    const shipped = validateGaps(JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'bench', 'parity-gaps.json'), 'utf8')));
    const baseline = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'bench', 'baseline.json'), 'utf8')) as { entries: Record<string, unknown> };
    expect(shipped.gaps.length).toBeGreaterThan(20);
    for (const gap of shipped.gaps) {
      expect(Number.isInteger(gap.issue) && gap.issue > 0, gap.id).toBe(true);
      expect(gap.id in baseline.entries, gap.id).toBe(true);
    }
  });

  it('files each gap under the issue of its family, as the rollout assigned them', () => {
    const shipped = validateGaps(JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'bench', 'parity-gaps.json'), 'utf8')));
    const issuesOf = (prefix: string, speedRows: boolean): number[] =>
      [...new Set(shipped.gaps.filter((g) => g.id.startsWith(prefix) && g.id.endsWith('/throughput') === speedRows).map((g) => g.issue))];
    expect(issuesOf('image/', false)).toEqual([640]);
    expect(issuesOf('image/', true)).toEqual([641]);
    expect(issuesOf('audio/', true)).toEqual([642]);
    expect(issuesOf('video/', true)).toEqual([643]);
    expect(issuesOf('ocr/', true)).toEqual([644]);
    const byId = Object.fromEntries(shipped.gaps.map((g) => [g.id, g.issue]));
    expect([byId['compression/mixed.7z->tar/throughput'], byId['compression/mixed.xz->tar/throughput'], byId['compression/mixed.tar->7z/throughput']]).toEqual([487, 487, 487]);
    expect(byId['compression/mixed.tar->zst/throughput']).toBe(497);
  });
});

describe('the rendered verdict', () => {
  const gapsFor: GapFile = {
    schemaVersion: PARITY_SCHEMA_VERSION,
    gaps: [
      { id: 'ocr/scan.png->pdf/throughput', issue: 644, ratio: 0.4, note: 'OCR speed' },
      { id: 'audio/a.wav->opus/throughput', issue: 642, ratio: 0.4, note: 'opus speed' },
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
  async function run(rows: BenchRow[], options: { baseline?: Record<string, Entry>; flags?: string[]; gaps?: unknown[] } = {}): Promise<{ code: number; lines: string[]; verdict: ParityRunFile }> {
    const files = { report: path.join(dir, 'report.json'), baseline: path.join(dir, 'baseline.json'), gaps: path.join(dir, 'gaps.json') };
    fs.writeFileSync(files.report, JSON.stringify(report(rows)));
    fs.writeFileSync(files.baseline, JSON.stringify({ schemaVersion: 1, entries: options.baseline ?? baselineEntries(1.1) }));
    fs.writeFileSync(files.gaps, JSON.stringify({ schemaVersion: 1, gaps: options.gaps ?? [] }));
    const lines: string[] = [];
    const code = await main(['--parity', '--compare-report', files.report, '--baseline', files.baseline, '--gaps', files.gaps, '--out', dir, ...(options.flags ?? [])], (line) => lines.push(line));
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
    const { code, lines, verdict } = await run(rowsWith(-2, 0.96, 'fail'), { baseline: baselineEntries(0.5), gaps: [{ id: SPEED_ID, issue: 487, ratio: 0.5, note: 'LZMA speed' }] });
    expect(code).toBe(0);
    expect(lines.some((line) => line.startsWith('TRACKED ROWS'))).toBe(true);
    expect(lines.some((line) => line.includes('TRACK image/a.jpg->webp/throughput [tracked-gap]') && line.includes('issue #487'))).toBe(true);
    expect(verdict.parity.summary).toMatchObject({ fail: 0, tracked: 1 });
  });

  it('exits 3 when a tracked row got slower than its recorded ratio, and still exits 1 for a baseline regression', async () => {
    const gaps = [{ id: SPEED_ID, issue: 487, ratio: 0.9, note: 'LZMA speed' }];
    const slower = await run(rowsWith(-2, 0.96, 'fail'), { baseline: baselineEntries(0.5), gaps });
    expect(slower.code).toBe(3);
    expect(slower.lines.some((line) => line.startsWith('BELOW REFERENCE') && line.includes('got slower than its recorded gap'))).toBe(true);
    // The baseline gate applies to tracked rows: at 0.5 against a baseline of 1.1 it regressed.
    const regressed = await run(rowsWith(-2, 0.96, 'fail'), { baseline: baselineEntries(1.1), gaps: [{ id: SPEED_ID, issue: 487, ratio: 0.5, note: 'LZMA speed' }] });
    expect(regressed.code).toBe(1);
    expect(regressed.lines.some((line) => line.startsWith(`REGRESSION ${SPEED_ID}`))).toBe(true);
  });

  it('exits 3 for a quality gap, which a gap entry never excuses', async () => {
    const baseline = baselineEntries(1.1);
    baseline[BD_ID] = { ...baseline[BD_ID], ours: 4, delta: 4 };
    const { code, lines } = await run(rowsWith(4, 0.96, 'pass'), { baseline, gaps: [{ id: BD_ID, issue: 640, ratio: null, note: 'curve' }] });
    expect(code).toBe(3);
    expect(lines.some((line) => line.startsWith(`BELOW REFERENCE ${BD_ID}`) && line.includes('known gap, issue #640'))).toBe(true);
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
