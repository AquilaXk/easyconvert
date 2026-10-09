import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_BRANCH, PARITY_SCHEMA_VERSION, SCHEMA_VERSION, SPEED_GAP_FLOOR, SPEED_HISTORY_MIN_LOG_SPREAD, SPEED_STEP_FACTOR } from '../bench/config';
import type { Baseline } from '../bench/gate';
import { evaluateParity } from '../bench/parity';
import { type GapFile, validateGaps } from '../bench/parity-gaps';
import { main, planSpeedRefresh, reseedGapHistories, SpeedRefreshError } from '../bench/refresh-speed';
import { type BenchReport, type BenchRow, reportSource, validateReport } from '../bench/report';
import { appendSpeedHistory, isStepUp, predictionLowerBound, sinceLastStep, speedGapThreshold } from '../bench/speed-history';

/**
 * The tracked-gap rules added after the first review of the gate: a history restarts at a step (a speed-up that
 * landed), a tracked row never falls below a fixed share of its latest recorded median whatever the history's spread,
 * and a history only takes runs of the default branch (or one named branch). Every expected number below is worked out
 * from the constants named in the test, not read back from the code under test.
 */

const at = (day: number): string => `2026-10-${String(day).padStart(2, '0')}T02:00:00.000Z`;
const points = (...ratios: number[]): { ratio: number; at: string }[] => ratios.map((ratio, index) => ({ ratio, at: at(index + 1) }));

describe('the policy constants', () => {
  it('floor a tracked row at 85 percent of its latest median and call a 40 percent jump a step', () => {
    expect(SPEED_GAP_FLOOR).toBe(0.85);
    expect(SPEED_STEP_FACTOR).toBe(1.4);
    expect(SPEED_HISTORY_MIN_LOG_SPREAD).toBe(0.07);
    expect(DEFAULT_BRANCH).toBe('main');
  });
});

describe('recognising a step in a speed history', () => {
  it('does not call a run a step when there is no history to step from', () => {
    expect(isStepUp([], 0.9)).toBe(false);
  });

  it('calls a jump of 1.4 times the geometric mean a step, with one or two points as well', () => {
    expect(isStepUp([0.5], 0.69)).toBe(false);
    expect(isStepUp([0.5], 0.71)).toBe(true);
    // geometric mean of 0.4 and 0.9 is 0.6; 1.4 * 0.6 = 0.84
    expect(isStepUp([0.4, 0.9], 0.83)).toBe(false);
    expect(isStepUp([0.4, 0.9], 0.85)).toBe(true);
    // a drop is never a step: it is the regression the gate is there to catch
    expect(isStepUp([0.5, 0.5], 0.05)).toBe(false);
  });

  it('calls a run above the prediction interval of a full history a step even under 1.4 times its mean', () => {
    // Flat history of ten at 0.5: the spread is lifted to 0.07, t(0.99, 9) = 2.821438, factor sqrt(1.1):
    // upper edge = 0.5 * exp(2.821438 * 0.07 * 1.048809) = 0.5 * 1.23 = 0.615
    const flat = Array<number>(10).fill(0.5);
    expect(isStepUp(flat, 0.61)).toBe(false);
    expect(isStepUp(flat, 0.62)).toBe(true);
  });

  it('keeps a history of nearly equal points from calling every small rise a step', () => {
    // [0.2937, 0.2937, 0.3102, 0.3716] came from real runs: the log spread of three equal points is zero, the floor lifts it
    expect(isStepUp([0.2937, 0.2937, 0.3102], 0.3716)).toBe(false);
  });
});

describe('keeping the points since the last step', () => {
  it('drops everything before a speed-up that landed, using the recorded histories of the first review', () => {
    expect(sinceLastStep(points(0.0513, 0.0553, 0.0722, 0.8028))).toEqual([{ ratio: 0.8028, at: at(4) }]);
    expect(sinceLastStep(points(0.5454, 0.4558, 0.8332, 0.843))).toEqual([
      { ratio: 0.8332, at: at(3) },
      { ratio: 0.843, at: at(4) },
    ]);
  });

  it('keeps a history that only drifts, and starts a new one at each step', () => {
    const drift = points(0.8241, 0.8417, 0.864, 0.8088);
    expect(sinceLastStep(drift)).toEqual(drift);
    expect(sinceLastStep(points(0.2, 0.2, 0.4, 0.4, 0.8))).toEqual([{ ratio: 0.8, at: at(5) }]);
  });

  it('orders the points by run time before it looks for a step', () => {
    const shuffled = [points(0.5)[0], { ratio: 0.9, at: at(3) }, { ratio: 0.5, at: at(2) }];
    expect(sinceLastStep(shuffled)).toEqual([{ ratio: 0.9, at: at(3) }]);
  });

  it('is what appending a run does: a run far above the history restarts it', () => {
    const history = points(0.05, 0.05, 0.05);
    expect(appendSpeedHistory(history, 0.8, at(4), 'abc1234')).toEqual([{ ratio: 0.8, at: at(4), commit: 'abc1234' }]);
    expect(appendSpeedHistory(history, 0.052, at(4), 'abc1234')).toEqual([...history, { ratio: 0.052, at: at(4), commit: 'abc1234' }]);
  });

  it('records no commit when the report names none', () => {
    expect(appendSpeedHistory([], 0.5, at(1))).toEqual([{ ratio: 0.5, at: at(1) }]);
  });
});

describe('the lowest median a tracked row may have', () => {
  it('is the floor alone while the history is too short for a bound, taken from the recorded ratio when there are no points', () => {
    const none = speedGapThreshold([], 1.48);
    expect(none.latest).toBe(1.48);
    expect(none.bound).toBeNull();
    expect(none.lower).toBeCloseTo(0.85 * 1.48, 12);
    const two = speedGapThreshold([0.9, 0.5], 0.5);
    expect(two.latest).toBe(0.5);
    expect(two.lower).toBeCloseTo(0.425, 12);
  });

  it('is the prediction bound when the history is quiet enough that the bound is above the floor', () => {
    const quiet = [0.8, 0.81, 0.82, 0.83];
    const bound = predictionLowerBound(quiet);
    expect(bound).not.toBeNull();
    const threshold = speedGapThreshold(quiet, 0.83);
    expect(threshold.lower).toBeCloseTo(bound?.lower as number, 12);
    expect(threshold.lower).toBeGreaterThan(0.85 * 0.83);
  });

  it('is the floor when the history is so noisy that its bound would admit a large slowdown', () => {
    const noisy = [0.3, 0.5, 0.4, 0.6];
    // the 99 percent bound of this history is about 0.096, a slowdown of more than 80 percent from the latest 0.6
    expect(predictionLowerBound(noisy)?.lower).toBeCloseTo(0.0957, 3);
    expect(speedGapThreshold(noisy, 0.6).lower).toBeCloseTo(0.51, 12);
  });

  it('never lets any of the bounds of the shipped gap file fall under 85 percent of the latest recorded median', () => {
    const shipped = validateGaps(JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'bench', 'parity-gaps.json'), 'utf8')));
    for (const gap of shipped.gaps) {
      if (gap.ratio === null) continue;
      const history = (gap.history ?? []).map((point) => point.ratio);
      const threshold = speedGapThreshold(history, gap.ratio);
      expect(threshold.lower, gap.id).toBeGreaterThanOrEqual(0.85 * threshold.latest - 1e-12);
    }
  });

  it('holds no history in the shipped gap file that still spans a step', () => {
    const shipped = validateGaps(JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'bench', 'parity-gaps.json'), 'utf8')));
    for (const gap of shipped.gaps) {
      const history = gap.history ?? [];
      expect(sinceLastStep(history), gap.id).toEqual(history);
    }
  });
});

describe('judging a tracked row by its median', () => {
  const XZ = 'compression/mixed.xz->tar/throughput';
  const gapsWith = (history: number[], ratio: number): GapFile => ({
    schemaVersion: PARITY_SCHEMA_VERSION,
    gaps: [{ id: XZ, issue: 685, ratio, note: 'archive decode speed', ...(history.length > 0 ? { history: points(...history) } : {}) }],
  });
  const speed = (over: Partial<BenchRow>): BenchRow => ({
    id: XZ,
    family: 'compression',
    case: 'mixed.xz->tar',
    metric: 'throughput',
    unit: 'MB/s',
    direction: 'higher',
    kind: 'throughput',
    status: 'measured',
    ours: 1,
    reference: 2,
    delta: -1,
    ratio: 0.5,
    referenceTool: 'xz',
    tolerance: { abs: 0, rel: 0.35 },
    runs: 7,
    speedVerdict: 'fail',
    ratioLow: 0.4,
    ratioHigh: 0.9,
    ratioMedian: 0.5,
    unstableAtCap: false,
    ...over,
  });
  const report = (rows: BenchRow[]): BenchReport => ({
    schemaVersion: SCHEMA_VERSION,
    generatedAt: at(20),
    strictMode: true,
    families: ['compression'],
    host: { platform: 'linux', arch: 'x64', node: 'v20.0.0', cpus: 4 },
    tools: {},
    settings: { runs: 3, injectedRegression: null },
    rows,
  });
  const verdictOf = (row: BenchRow, gaps: GapFile): { outcome: string; basis: string; detail: string } => {
    const found = evaluateParity(report([row]), gaps).rows[0];
    return { outcome: found.outcome, basis: found.basis, detail: found.detail };
  };

  it('fails a median under the bound even when the lucky end of the interval is above it', () => {
    // a flat history of four at 0.46 puts the bound at 0.46; the floor 0.391 is lower
    const gaps = gapsWith([0.46, 0.46, 0.46, 0.46], 0.46);
    expect(verdictOf(speed({ ratioMedian: 0.45, ratioHigh: 0.95 }), gaps)).toMatchObject({ outcome: 'fail', basis: 'tracked-slower-than-gap' });
    expect(verdictOf(speed({ ratioMedian: 0.4601, ratioHigh: 0.47 }), gaps)).toMatchObject({ outcome: 'pass', basis: 'tracked-gap' });
    expect(verdictOf(speed({ ratioMedian: 0.4599, ratioHigh: 0.95 }), gaps)).toMatchObject({ outcome: 'fail', basis: 'tracked-slower-than-gap' });
  });

  it('names the median and the limit it was held to in the verdict', () => {
    const slow = verdictOf(speed({ ratioMedian: 0.3 }), gapsWith([0.46, 0.46, 0.46, 0.46], 0.46));
    expect(slow.detail).toBe(
      'speed ratio 0.3 [0.4, 0.9] over 7 pairs; tracked (issue #685), but its median 0.3 is below the 99% one-sided prediction bound 0.46 over the last 4 CI runs (geometric mean 0.46): it got slower than its history'
    );
  });

  it('holds a noisy history to 85 percent of its latest median', () => {
    // the 99 percent bound of this history is 0.286; the floor 0.85 * 0.47 = 0.3995 is what binds
    const gaps = gapsWith([0.38, 0.46, 0.5, 0.42, 0.47], 0.47);
    expect(verdictOf(speed({ ratioMedian: 0.4 }), gaps)).toMatchObject({ outcome: 'pass', basis: 'tracked-gap' });
    expect(verdictOf(speed({ ratioMedian: 0.39 }), gaps)).toMatchObject({ outcome: 'fail', basis: 'tracked-slower-than-gap' });
    expect(verdictOf(speed({ ratioMedian: 0.39 }), gaps).detail).toMatch(/^speed ratio 0\.39 \[0\.4, 0\.9\] over 7 pairs; tracked \(issue #685\), but its median 0\.39 is below 85% of the latest recorded median 0\.47 \(0\.3995\), which is above the 99% one-sided prediction bound 0\.2\d* over the last 5 CI runs: it got slower than its history$/);
  });

  it.each([[[]], [[0.46]], [[0.46, 0.46]]])('judges a row with the history %j by the floor instead of letting any slowdown pass', (history) => {
    const gaps = gapsWith(history, 0.46);
    expect(verdictOf(speed({ ratioMedian: 0.07, ratioHigh: 0.1 }), gaps)).toMatchObject({ outcome: 'fail', basis: 'tracked-slower-than-gap' });
    // 0.85 * 0.46 = 0.391
    expect(verdictOf(speed({ ratioMedian: 0.4 }), gaps)).toMatchObject({ outcome: 'pass', basis: 'tracked-short-history' });
    expect(verdictOf(speed({ ratioMedian: 0.39 }), gaps)).toMatchObject({ outcome: 'fail', basis: 'tracked-slower-than-gap' });
  });

  it('counts the median of a run that was unstable at the cap against the floor', () => {
    const gaps = gapsWith([], 1.48);
    expect(verdictOf(speed({ unstableAtCap: true, ratioMedian: 1.5, ratioLow: 0.8, ratioHigh: 1.7 }), gaps)).toMatchObject({ outcome: 'pass' });
    expect(verdictOf(speed({ unstableAtCap: true, ratioMedian: 1.2, ratioLow: 0.5, ratioHigh: 1.7 }), gaps)).toMatchObject({ outcome: 'fail', basis: 'tracked-slower-than-gap' });
  });

  it('still reports a tracked row that now passes the normal rule as at parity', () => {
    expect(verdictOf(speed({ speedVerdict: 'pass', ratioMedian: 1.1, ratioLow: 1.02, ratioHigh: 1.3 }), gapsWith([], 0.46))).toMatchObject({ outcome: 'pass', basis: 'tracked-now-at-parity' });
  });
});

describe('where a speed report may come from', () => {
  const SLOW = 'compression/mixed.xz->tar/throughput';
  const speedRow = (over: Partial<BenchRow> = {}): BenchRow => ({
    id: SLOW,
    family: 'compression',
    case: 'mixed.xz->tar',
    metric: 'throughput',
    unit: 'MB/s',
    direction: 'higher',
    kind: 'throughput',
    status: 'measured',
    ours: 10,
    reference: 20,
    delta: -10,
    ratio: 0.5,
    referenceTool: 'xz',
    tolerance: { abs: 0, rel: 0.35 },
    runs: 9,
    ratioLow: 0.4,
    ratioHigh: 0.6,
    ratioMedian: 0.5,
    speedVerdict: 'fail',
    unstableAtCap: false,
    ...over,
  });
  const reportFrom = (source: BenchReport['source'], generatedAt = at(10)): BenchReport => ({
    schemaVersion: SCHEMA_VERSION,
    generatedAt,
    strictMode: true,
    families: ['compression'],
    host: { platform: 'linux', arch: 'x64', node: 'v20.0.0', cpus: 4 },
    tools: {},
    settings: { runs: 5, injectedRegression: null },
    rows: [speedRow()],
    ...(source ? { source } : {}),
  });
  const baseline = (): Baseline => ({
    schemaVersion: SCHEMA_VERSION,
    entries: { [SLOW]: { direction: 'higher', tolerance: { abs: 0, rel: 0.35 }, ours: null, delta: null, ratio: 0.46 } },
  });
  const gaps = (): GapFile => ({ schemaVersion: PARITY_SCHEMA_VERSION, gaps: [{ id: SLOW, issue: 685, ratio: 0.46, note: 'archive decode speed' }] });
  const plan = (report: BenchReport, options?: { allowBranch?: string }) => planSpeedRefresh([{ label: 'speed.json', report }], baseline(), gaps(), options);

  it.each([
    ['schedule', 'main'],
    ['workflow_dispatch', 'main'],
    ['push', 'main'],
  ])('takes a %s run of the default branch and records its commit in the history', (event, branch) => {
    const result = plan(reportFrom({ commit: 'a'.repeat(40), branch, event }));
    expect(result.gaps.gaps[0].history).toEqual([{ ratio: 0.5, at: at(10), commit: 'a'.repeat(40) }]);
  });

  it.each([
    ['pull_request', 'feature/regressed'],
    ['workflow_dispatch', 'feature/regressed'],
    ['schedule', 'feature/regressed'],
    ['pull_request', 'main'],
  ])('refuses a %s run of %s', (event, branch) => {
    expect(() => plan(reportFrom({ commit: 'b'.repeat(40), branch, event }))).toThrow(SpeedRefreshError);
    expect(() => plan(reportFrom({ commit: 'b'.repeat(40), branch, event }))).toThrow('not a run of main');
  });

  it('refuses a report that records no source, however it was measured', () => {
    expect(() => plan(reportFrom(undefined))).toThrow('records no commit, branch or event');
  });

  it('takes any run of the one branch that --allow-branch names, and no other branch', () => {
    const own = reportFrom({ commit: 'c'.repeat(40), branch: 'ci/reference-parity-gate', event: 'workflow_dispatch' });
    expect(plan(own, { allowBranch: 'ci/reference-parity-gate' }).gaps.gaps[0].history).toHaveLength(1);
    expect(() => plan(own, { allowBranch: 'ci/other' })).toThrow('not a run of main');
    expect(() => plan(own)).toThrow('not a run of main');
  });

  it('restarts a history at a run far above it and keeps the point of that run only', () => {
    const stepped: GapFile = { schemaVersion: PARITY_SCHEMA_VERSION, gaps: [{ ...gaps().gaps[0], ratio: 0.4, history: points(0.4, 0.41, 0.4) }] };
    const result = planSpeedRefresh([{ label: 'a.json', report: { ...reportFrom({ commit: 'd'.repeat(40), branch: 'main', event: 'schedule' }, at(10)), rows: [speedRow({ ratioMedian: 0.8 })] } }], baseline(), stepped);
    expect(result.gaps.gaps[0].history).toEqual([{ ratio: 0.8, at: at(10), commit: 'd'.repeat(40) }]);
    expect(result.gaps.gaps[0].ratio).toBe(0.8);
    expect(result.historyChanges).toEqual([{ id: SLOW, points: 1 }]);
  });

  it('puts the run, not only a pull request label, behind the accepted branch: the gap file keeps the commit it came from', () => {
    const parsed = validateGaps({ schemaVersion: PARITY_SCHEMA_VERSION, gaps: [{ ...gaps().gaps[0], history: [{ ratio: 0.5, at: at(1), commit: 'e'.repeat(40) }] }] });
    expect(parsed.gaps[0].history).toEqual([{ ratio: 0.5, at: at(1), commit: 'e'.repeat(40) }]);
    expect(() => validateGaps({ schemaVersion: PARITY_SCHEMA_VERSION, gaps: [{ ...gaps().gaps[0], history: [{ ratio: 0.5, at: at(1), commit: 'not a sha' }] }] })).toThrow('commit');
  });
});

describe('what a report records about its run', () => {
  it('reads the commit, branch and event from the environment of a workflow run', () => {
    expect(reportSource({ GITHUB_SHA: 'f'.repeat(40), GITHUB_REF_NAME: 'main', GITHUB_EVENT_NAME: 'schedule' })).toEqual({ commit: 'f'.repeat(40), branch: 'main', event: 'schedule' });
  });

  it('takes the head branch of a pull request, not its merge ref', () => {
    expect(reportSource({ GITHUB_SHA: 'f'.repeat(40), GITHUB_REF_NAME: '639/merge', GITHUB_HEAD_REF: 'ci/reference-parity-gate', GITHUB_EVENT_NAME: 'pull_request' })).toEqual({
      commit: 'f'.repeat(40),
      branch: 'ci/reference-parity-gate',
      event: 'pull_request',
    });
  });

  it('records nothing for a run outside a workflow, so a laptop report carries no source', () => {
    expect(reportSource({})).toBeUndefined();
    expect(reportSource({ GITHUB_SHA: 'f'.repeat(40) })).toBeUndefined();
  });

  it('round-trips through the report schema and rejects a malformed source', () => {
    const base = {
      schemaVersion: SCHEMA_VERSION,
      generatedAt: at(1),
      strictMode: true,
      families: ['compression'],
      host: { platform: 'linux', arch: 'x64', node: 'v20.0.0', cpus: 4 },
      tools: {},
      settings: { runs: 5, injectedRegression: null },
      rows: [],
    };
    const source = { commit: 'f'.repeat(40), branch: 'main', event: 'schedule' };
    expect(validateReport({ ...base, source }).source).toEqual(source);
    expect(validateReport(base).source).toBeUndefined();
    expect(() => validateReport({ ...base, source: { ...source, commit: 7 } })).toThrow('source.commit');
    expect(() => validateReport({ ...base, source: 'main' })).toThrow('source');
  });
});

describe('re-seeding the histories that are on file', () => {
  const gapsFile = (): GapFile => ({
    schemaVersion: PARITY_SCHEMA_VERSION,
    gaps: [
      { id: 'image/lineart.png->avif/throughput', issue: 641, ratio: 0.8, note: 'n', history: points(0.0513, 0.0553, 0.0722, 0.8028) },
      { id: 'image/photo-a.jpg->avif/throughput', issue: 641, ratio: 0.8, note: 'n', history: points(0.8241, 0.8417, 0.864, 0.8088) },
      { id: 'image/a.jpg->avif/bd_rate_psnr', issue: 640, ratio: null, note: 'quality' },
    ],
  });

  it('keeps only the points since the last step of each history, and lists what it dropped', () => {
    const result = reseedGapHistories(gapsFile());
    expect(result.gaps.gaps[0].history).toEqual([{ ratio: 0.8028, at: at(4) }]);
    expect(result.gaps.gaps[1].history).toEqual(gapsFile().gaps[1].history);
    expect(result.gaps.gaps[2]).toEqual(gapsFile().gaps[2]);
    expect(result.restarted).toEqual([{ id: 'image/lineart.png->avif/throughput', dropped: 3, points: 1 }]);
  });

  describe('through the command', () => {
    let dir: string;
    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-reseed-'));
    });
    afterEach(() => {
      fs.rmSync(dir, { recursive: true, force: true });
    });

    it('prints what it would do without --write, and rewrites only the gap file with it', () => {
      const file = path.join(dir, 'gaps.json');
      fs.writeFileSync(file, `${JSON.stringify(gapsFile(), null, 2)}\n`);
      const before = fs.readFileSync(file, 'utf8');
      const lines: string[] = [];
      expect(main(['--reseed', '--gaps', file], (line) => lines.push(line))).toBe(0);
      expect(lines).toContain('histories restarted at their last step: 1');
      expect(lines).toContain('  image/lineart.png->avif/throughput: dropped 3 points, 1 kept');
      expect(fs.readFileSync(file, 'utf8')).toBe(before);
      main(['--reseed', '--write', '--gaps', file], () => undefined);
      const written = JSON.parse(fs.readFileSync(file, 'utf8')) as GapFile;
      expect(written.gaps[0].history).toEqual([{ ratio: 0.8028, at: at(4) }]);
    });

    it('takes --allow-branch and refuses it without a value', () => {
      expect(() => main(['--allow-branch'], () => undefined)).toThrow('--allow-branch needs a value');
    });
  });
});
