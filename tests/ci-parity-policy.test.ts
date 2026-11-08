import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyParityVerdict, decide, ParityPolicyError, parseRunFile, readRunFile } from '../scripts/ci-parity-policy.mjs';

/**
 * The verdict policy of the parity job, on hand-written verdict files: a row below the reference, a regression, a
 * non-strict run or a failed benchmark fails the job, and nothing excuses it.
 */

type Row = { id: string; family: string; case: string; metric: string; outcome: string; basis: string; detail: string; worsening: null; allowance: null; gap: { id: string; issue: number | null; note: string } | null };

const failing = (id: string, issue: number | null = null): Row => {
  const [family, caseName, metric] = id.split('/');
  return { id, family, case: caseName, metric, outcome: 'fail', basis: 'speed-below-reference', detail: `${metric} is below the reference`, worsening: null, allowance: null, gap: issue === null ? null : { id, issue, note: 'known' } };
};
const passing = (id: string): Row => ({ ...failing(id), outcome: 'pass', basis: 'speed-pass', detail: 'ok' });

function runFile(rows: Row[], over: Record<string, unknown> = {}): Record<string, unknown> {
  const below = rows.some((row) => row.outcome === 'fail');
  return {
    schemaVersion: 1,
    generatedAt: '2026-01-01T00:00:00.000Z',
    families: ['compression'],
    quick: false,
    scope: 'speed',
    strictMode: true,
    injectedRegression: null,
    exitCode: below ? 3 : 0,
    baseline: { compared: 4, regressions: [] },
    parity: { schemaVersion: 1, verdict: below ? 'fail' : 'pass', summary: {}, rows },
    ...over,
  };
}

const XZ = 'compression/mixed.xz->tar/throughput';
const SEVEN = 'compression/mixed.7z->tar/throughput';
const WEBP = 'image/photo-a.jpg->webp/bd_rate_psnr';

describe('the verdict file', () => {
  it('accepts what a parity run writes', () => {
    expect(parseRunFile(runFile([failing(XZ, 487), passing(SEVEN)])).exitCode).toBe(3);
  });

  it.each<[string, (file: Record<string, unknown>) => void, RegExp]>([
    ['another schema version', (f) => { f.schemaVersion = 2; }, /schemaVersion/],
    ['an exit code outside 0 to 3', (f) => { f.exitCode = 7; }, /exitCode/],
    ['a missing strict flag', (f) => { delete f.strictMode; }, /strictMode/],
    ['regressions that are not strings', (f) => { (f.baseline as { regressions: unknown[] }).regressions = [1]; }, /regressions/],
    ['a verdict other than pass or fail', (f) => { (f.parity as { verdict: string }).verdict = 'maybe'; }, /verdict/],
    ['a verdict that disagrees with its rows', (f) => { (f.parity as { verdict: string }).verdict = 'pass'; }, /disagrees/],
    ['a row of an unknown outcome', (f) => { ((f.parity as { rows: Row[] }).rows[0] as { outcome: string }).outcome = 'meh'; }, /unknown outcome/],
    ['a row without an id', (f) => { delete ((f.parity as { rows: Row[] }).rows[0] as Partial<Row>).id; }, /id, a family and a detail/],
    ['a malformed gap', (f) => { ((f.parity as { rows: Row[] }).rows[0] as { gap: unknown }).gap = { issue: 'x' }; }, /malformed gap/],
  ])('rejects %s', (_name, damage, message) => {
    const file = runFile([failing(XZ)]);
    damage(file);
    expect(() => parseRunFile(file)).toThrow(ParityPolicyError);
    expect(() => parseRunFile(file)).toThrow(message);
  });

  it('refuses a file over the size limit and one that is not JSON', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'parity-policy-'));
    try {
      const big = path.join(dir, 'big.json');
      fs.writeFileSync(big, ' '.repeat(8 * 1024 * 1024 + 1));
      expect(() => readRunFile(big, fs)).toThrow(/byte limit/);
      const bad = path.join(dir, 'bad.json');
      fs.writeFileSync(bad, 'nope');
      expect(() => readRunFile(bad, fs)).toThrow(SyntaxError);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the decision', () => {
  const options = (over: Partial<{ requireStrict: boolean }> = {}) => ({ requireStrict: true, ...over });
  const below = parseRunFile(runFile([failing(XZ, 487), failing(WEBP), passing(SEVEN)]));

  it('passes a verdict with nothing below the reference', () => {
    expect(decide(parseRunFile(runFile([passing(SEVEN)])), options()).outcome).toBe('pass');
  });

  it('fails a verdict with rows below the reference', () => {
    const decision = decide(below, options());
    expect(decision.outcome).toBe('fail');
    expect(decision.reasons[0]).toContain('2 rows are below the reference tool');
  });

  it('fails a regression against our own baseline, also when the parity verdict itself is clean', () => {
    const regressed = parseRunFile(runFile([failing(XZ)], { exitCode: 1, baseline: { compared: 4, regressions: ['image/a.jpg->webp/ssim: our value 0.9 is worse than baseline 0.96'] } }));
    const decision = decide(regressed, options());
    expect(decision.outcome).toBe('fail');
    expect(decision.reasons.join('\n')).toContain('REGRESSION image/a.jpg->webp/ssim');
    const cleanButRegressed = parseRunFile(runFile([passing(SEVEN)], { exitCode: 1, baseline: { compared: 4, regressions: ['x'] } }));
    expect(decide(cleanButRegressed, options()).outcome).toBe('fail');
  });

  it('fails a run made without strict mode, since a missing tool could have skipped rows', () => {
    const lenient = parseRunFile(runFile([passing(SEVEN)], { strictMode: false }));
    expect(decide(lenient, options()).outcome).toBe('fail');
    expect(decide(lenient, options({ requireStrict: false })).outcome).toBe('pass');
  });

  it('fails a run whose exit code says the benchmark itself failed', () => {
    const crashed = parseRunFile(runFile([passing(SEVEN)], { exitCode: 2 }));
    expect(decide(crashed, options()).outcome).toBe('fail');
  });
});

describe('applying the verdict in the workflow step', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'parity-apply-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function setup(rows: Row[], over: Record<string, unknown> = {}) {
    const file = path.join(dir, 'parity-verdict.json');
    fs.writeFileSync(file, JSON.stringify(runFile(rows, over)));
    const messages: Array<[string, string]> = [];
    const core = {
      info: (m: string) => messages.push(['info', m]),
      setFailed: (m: string) => messages.push(['failed', m]),
    };
    return { file, core, messages };
  }
  const apply = (s: ReturnType<typeof setup>) => applyParityVerdict({ core: s.core, fs, runFilePath: s.file });

  it('passes silently when nothing is below the reference', () => {
    const s = setup([passing(SEVEN)]);
    expect(apply(s)).toBe('pass');
    expect(s.messages.filter(([kind]) => kind === 'failed')).toEqual([]);
  });

  it('fails the step when rows are below the reference', () => {
    const s = setup([failing(XZ, 487)]);
    expect(apply(s)).toBe('fail');
    expect(s.messages.find(([kind]) => kind === 'failed')?.[1]).toContain('1 row is below the reference tool');
  });

  it('fails the step when the verdict file is missing or unreadable', () => {
    const s = setup([passing(SEVEN)]);
    fs.rmSync(s.file);
    expect(apply(s)).toBe('fail');
    expect(s.messages[0][1]).toContain('no usable parity verdict');
  });
});
