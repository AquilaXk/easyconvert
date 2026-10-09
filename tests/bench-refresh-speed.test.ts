import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PARITY_VERDICT_FILE, SCHEMA_VERSION } from '../bench/config';
import { BenchArgumentError } from '../bench/errors';
import type { Baseline } from '../bench/gate';
import type { GapFile } from '../bench/parity-gaps';
import { main, planSpeedRefresh, SpeedRefreshError } from '../bench/refresh-speed';
import type { BenchReport, BenchRow } from '../bench/report';

/**
 * Refreshing the recorded speed ratios from the reports of a CI run. Every report, baseline and gap entry is typed in;
 * the expected numbers are the ones those inputs imply (a ratio rounded down to two decimals, a note rewritten only
 * when the refresh wrote it).
 */

const SLOW = 'compression/mixed.xz->tar/throughput';
const FAST = 'document/report.docx->pdf/throughput';
const NEAR = 'compression/mixed.zst->tar/throughput';
const NEW_ROW = 'compression/mixed.7z->tar/throughput';
const SSIM = 'image/photo-a.jpg->webp/ssim';

function speedRow(id: string, over: Partial<BenchRow>): BenchRow {
  const [family, caseName, metric] = id.split('/');
  return {
    id,
    family: family as BenchRow['family'],
    case: caseName,
    metric,
    unit: 'MB/s',
    direction: 'higher',
    kind: 'throughput',
    status: 'measured',
    ours: 10,
    reference: 20,
    delta: -10,
    ratio: 0.5,
    referenceTool: 'tool',
    tolerance: { abs: 0, rel: 0.35 },
    runs: 9,
    ratioLow: 0.4,
    ratioHigh: 0.6,
    ratioMedian: 0.5,
    speedVerdict: 'fail',
    unstableAtCap: false,
    ...over,
  };
}

function report(rows: BenchRow[], over: Partial<BenchReport> = {}): BenchReport {
  return {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: '2026-01-01T00:00:00.000Z',
    strictMode: true,
    families: ['compression', 'document'],
    host: { platform: 'linux', arch: 'x64', node: 'v20.0.0', cpus: 4 },
    tools: {},
    settings: { runs: 5, injectedRegression: null },
    rows,
    ...over,
  };
}

const baseline = (): Baseline => ({
  schemaVersion: SCHEMA_VERSION,
  entries: {
    [SLOW]: { direction: 'higher', tolerance: { abs: 0, rel: 0.35 }, ours: null, delta: null, ratio: 0.46 },
    [FAST]: { direction: 'higher', tolerance: { abs: 0, rel: 0.5 }, ours: null, delta: null, ratio: 20.84 },
    [SSIM]: { direction: 'higher', tolerance: { abs: 0.003, rel: 0 }, ours: 0.96, delta: 0.01, ratio: null },
  },
});
const gaps = (): GapFile => ({
  schemaVersion: 1,
  gaps: [
    { id: SLOW, issue: 487, ratio: 0.46, note: 'speed ratio 0.46 or below when recorded (baseline 0.46, measured 0.46): ours is slower than the reference tool' },
    { id: NEAR, issue: 497, ratio: 0.92, note: 'TODO(lead): file a dedicated issue' },
    { id: 'image/photo-a.jpg->webp/bd_rate_psnr', issue: 640, ratio: null, note: 'quality gap' },
  ],
});

describe('planning a speed refresh', () => {
  it('rewrites the ratios of the measured speed rows and nothing else', () => {
    const plan = planSpeedRefresh(
      [{ label: 'speed.json', report: report([speedRow(SLOW, { ratio: 0.5, ratioMedian: 0.5278 }), speedRow(FAST, { ratio: 31.2, ratioMedian: 31.4, speedVerdict: 'pass' })]) }],
      baseline(),
      gaps()
    );
    expect(plan.baseline.entries[SLOW]).toEqual({ direction: 'higher', tolerance: { abs: 0, rel: 0.35 }, ours: null, delta: null, ratio: 0.5 });
    expect(plan.baseline.entries[FAST]).toMatchObject({ ratio: 31.2, tolerance: { abs: 0, rel: 0.5 } });
    expect(plan.baseline.entries[SSIM]).toEqual(baseline().entries[SSIM]);
    expect(plan.baselineChanges).toEqual([
      { id: SLOW, before: 0.46, after: 0.5 },
      { id: FAST, before: 20.84, after: 31.2 },
    ]);
  });

  it('records a tracked gap as the interval median rounded down, and rewrites only a note it generated', () => {
    const plan = planSpeedRefresh([{ label: 'speed.json', report: report([speedRow(SLOW, { ratioMedian: 0.5278 }), speedRow(NEAR, { ratio: 0.8, ratioMedian: 0.8049 })]) }], baseline(), gaps());
    expect(plan.gaps.gaps).toEqual([
      { id: SLOW, issue: 487, ratio: 0.52, note: 'speed ratio 0.52 or below when recorded on the CI runner (previous record 0.46): ours is slower than the reference tool' },
      { id: NEAR, issue: 497, ratio: 0.8, note: 'TODO(lead): file a dedicated issue' },
      gaps().gaps[2],
    ]);
    expect(plan.gapChanges).toEqual([
      { id: SLOW, before: 0.46, after: 0.52 },
      { id: NEAR, before: 0.92, after: 0.8 },
    ]);
  });

  it('lists a tracked row that now passes instead of editing or removing its entry', () => {
    const plan = planSpeedRefresh([{ label: 'speed.json', report: report([speedRow(SLOW, { ratioMedian: 1.2, ratio: 1.2, speedVerdict: 'pass', ratioLow: 1.1, ratioHigh: 1.3 })]) }], baseline(), gaps());
    expect(plan.nowAtParity).toEqual([SLOW]);
    expect(plan.gaps.gaps[0]).toEqual(gaps().gaps[0]);
    expect(plan.baseline.entries[SLOW].ratio).toBe(1.2);
  });

  it('leaves a row alone whose interval was undecided at the cap, and reports tracked rows the reports lack', () => {
    const plan = planSpeedRefresh([{ label: 'speed.json', report: report([speedRow(SLOW, { ratioMedian: 0.97, ratio: 0.97, unstableAtCap: true })]) }], baseline(), gaps());
    expect(plan.leftUnstable).toEqual([SLOW]);
    expect(plan.notInReports).toEqual([NEAR]);
    expect(plan.baseline.entries[SLOW].ratio).toBe(0.46);
    expect(plan.gaps.gaps[0]).toEqual(gaps().gaps[0]);
  });

  it('adds a baseline entry for a speed row that had none', () => {
    const plan = planSpeedRefresh([{ label: 'speed.json', report: report([speedRow(NEW_ROW, { ratio: 0.61, ratioMedian: 0.61 })]) }], baseline(), gaps());
    expect(plan.baseline.entries[NEW_ROW]).toEqual({ direction: 'higher', tolerance: { abs: 0, rel: 0.35 }, ours: null, delta: null, ratio: 0.61 });
    expect(plan.baselineChanges).toEqual([{ id: NEW_ROW, before: null, after: 0.61 }]);
  });

  it('merges several reports and refuses a row measured twice', () => {
    const one = { label: 'a.json', report: report([speedRow(SLOW, {})]) };
    const two = { label: 'b.json', report: report([speedRow(FAST, { ratio: 25, ratioMedian: 25 })]) };
    expect(planSpeedRefresh([one, two], baseline(), gaps()).baselineChanges.map((change) => change.id)).toEqual([SLOW, FAST]);
    expect(() => planSpeedRefresh([one, { label: 'c.json', report: report([speedRow(SLOW, {})]) }], baseline(), gaps())).toThrow('also in an earlier report');
  });

  it.each<[string, Partial<BenchReport>, RegExp]>([
    ['a report measured on a laptop', { host: { platform: 'darwin', arch: 'arm64', node: 'v20.0.0', cpus: 10 } }, /speed ratios must come from the CI runner/],
    ['a report measured without strict mode', { strictMode: false }, /ORACLE_STRICT_MODE=1/],
    ['a report with an injected regression', { settings: { runs: 5, injectedRegression: 'slow-ours' } }, /injected regression slow-ours/],
  ])('refuses %s', (_name, over, message) => {
    const input = [{ label: 'speed.json', report: report([speedRow(SLOW, {})], over) }];
    expect(() => planSpeedRefresh(input, baseline(), gaps())).toThrow(SpeedRefreshError);
    expect(() => planSpeedRefresh(input, baseline(), gaps())).toThrow(message);
  });

  it('refuses a report without speed decisions and one without any speed row', () => {
    const plain = speedRow(SLOW, {});
    delete plain.speedVerdict;
    delete plain.ratioMedian;
    expect(() => planSpeedRefresh([{ label: 'old.json', report: report([plain]) }], baseline(), gaps())).toThrow('carries no speed decision');
    expect(() => planSpeedRefresh([{ label: 'q.json', report: report([]) }], baseline(), gaps())).toThrow('no measured speed row');
    expect(() => planSpeedRefresh([], baseline(), gaps())).toThrow('no report');
  });
});

describe('the command', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-refresh-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function files(): { artifact: string; baseline: string; gaps: string } {
    const artifact = path.join(dir, 'artifact');
    fs.mkdirSync(artifact);
    fs.writeFileSync(path.join(artifact, '2026-01-01-parity-speed.json'), JSON.stringify(report([speedRow(SLOW, { ratio: 0.5, ratioMedian: 0.5278 })])));
    fs.writeFileSync(path.join(artifact, '2026-01-01-parity-speed.md'), 'not read');
    fs.writeFileSync(path.join(artifact, PARITY_VERDICT_FILE), '{"not":"a report"}');
    fs.writeFileSync(path.join(dir, 'baseline.json'), JSON.stringify(baseline(), null, 2) + '\n');
    fs.writeFileSync(path.join(dir, 'gaps.json'), JSON.stringify(gaps(), null, 2) + '\n');
    return { artifact, baseline: path.join(dir, 'baseline.json'), gaps: path.join(dir, 'gaps.json') };
  }

  it('prints the changes and writes nothing without --write', () => {
    const f = files();
    const before = [fs.readFileSync(f.baseline, 'utf8'), fs.readFileSync(f.gaps, 'utf8')];
    const lines: string[] = [];
    expect(main(['--baseline', f.baseline, '--gaps', f.gaps, f.artifact], (line) => lines.push(line))).toBe(0);
    expect(lines).toContain('baseline speed ratios changed: 1');
    expect(lines).toContain(`  ${SLOW}: 0.46 -> 0.5`);
    expect(lines).toContain(`  ${SLOW}: 0.46 -> 0.52`);
    expect(lines).toContain(`left unchanged, not in the reports: ${NEAR}`);
    expect([fs.readFileSync(f.baseline, 'utf8'), fs.readFileSync(f.gaps, 'utf8')]).toEqual(before);
  });

  it('rewrites both files with --write, reading the report of an artifact directory and skipping its verdict file', () => {
    const f = files();
    main(['--write', '--baseline', f.baseline, '--gaps', f.gaps, f.artifact], () => undefined);
    const writtenBaseline = JSON.parse(fs.readFileSync(f.baseline, 'utf8')) as Baseline;
    const writtenGaps = JSON.parse(fs.readFileSync(f.gaps, 'utf8')) as GapFile;
    expect(writtenBaseline.entries[SLOW].ratio).toBe(0.5);
    expect(writtenGaps.gaps[0]).toMatchObject({ id: SLOW, ratio: 0.52 });
    expect(fs.readFileSync(f.baseline, 'utf8').endsWith('}\n')).toBe(true);
  });

  it('rejects missing inputs and unknown flags', () => {
    expect(() => main([], () => undefined)).toThrow(BenchArgumentError);
    expect(() => main(['--bogus', 'x'], () => undefined)).toThrow('unknown argument --bogus');
    expect(() => main(['--gaps'], () => undefined)).toThrow('--gaps needs a value');
  });
});

describe('the files in the repository', () => {
  it('are written the way the command writes them, so a refresh changes only its numbers', () => {
    for (const name of ['baseline.json', 'parity-gaps.json']) {
      const text = fs.readFileSync(path.join(__dirname, '..', 'bench', name), 'utf8');
      expect(`${JSON.stringify(JSON.parse(text), null, 2)}\n`, name).toBe(text);
    }
  });
});
