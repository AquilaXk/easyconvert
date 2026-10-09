import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MAX_SHARDS, ShardPlanError, listShardedTests, loadDurations, mergeReports, planShards } from '../scripts/ci-test-shards.mjs';

/**
 * The shard planner decides which CI job runs which test file, so a file it drops is a file CI never runs. Its
 * output is checked against the file system and against the longest-processing-time bound of list scheduling
 * (Graham 1969): the heaviest shard is at most the mean plus the largest item, which holds for any correct packing
 * that always fills the lightest shard.
 */

const ROOT = path.resolve(__dirname, '..');
const PLANNER = path.join(ROOT, 'scripts', 'ci-test-shards.mjs');
const CI_SHARDS = 6;
const FILES = listShardedTests();
const DURATIONS = loadDurations();
const ci = readFileSync(path.join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf-8');

const load = (shard: { load: number }): number => shard.load;

describe('which files the sharded job runs', () => {
  it('lists the test files of tests/ without the timing suites and the conformance gate', () => {
    expect(FILES.length).toBeGreaterThan(400);
    expect(FILES.every((file) => file.startsWith('tests/') && file.endsWith('.test.ts'))).toBe(true);
    expect(FILES.filter((file) => file.endsWith('.perf.test.ts'))).toEqual([]);
    expect(FILES).not.toContain('tests/registry-engine-conformance.test.ts');
    expect(FILES).toContain('tests/ci-test-shards.test.ts');
    expect([...FILES].sort()).toEqual(FILES);
  });

  it('matches what vitest would collect, minus the two exclusions', () => {
    const collected = spawnSync('npx', ['--no-install', 'vitest', 'list', '--filesOnly'], { cwd: ROOT, encoding: 'utf-8' });
    expect(collected.status, collected.stderr).toBe(0);
    const all = collected.stdout
      .split('\n')
      .map((line) => path.relative(ROOT, line.trim()).split(path.sep).join('/'))
      .filter((file) => file.endsWith('.test.ts'));
    const expected = all.filter((file) => !file.endsWith('.perf.test.ts') && file !== 'tests/registry-engine-conformance.test.ts').sort();
    expect(FILES).toEqual(expected);
  }, 120_000);
});

describe.each([1, 2, 3, 4, 5, 6, 7, 8, 12])('a plan of %i shards', (count) => {
  const shards = planShards(FILES, DURATIONS, count);

  it('runs every file exactly once', () => {
    expect(shards).toHaveLength(count);
    const planned = shards.flatMap((shard) => shard.files).sort();
    expect(planned).toEqual(FILES);
  });

  it('keeps the heaviest shard within the list-scheduling bound of the mean', () => {
    const weightOf = (file: string): number => DURATIONS[file] ?? 0;
    const total = shards.map(load).reduce((sum, value) => sum + value, 0);
    const largest = Math.max(...FILES.map(weightOf));
    const bound = total / count + largest * (1 - 1 / count);
    expect(Math.max(...shards.map(load))).toBeLessThanOrEqual(bound + 1e-6);
  });

  it('is the same plan every time', () => {
    expect(planShards(FILES, DURATIONS, count)).toEqual(shards);
  });
});

describe('the plan of the CI shards', () => {
  const shards = planShards(FILES, DURATIONS, CI_SHARDS);

  it('uses the shard count of the tests job', () => {
    expect(ci).toMatch(/shard: \[1, 2, 3, 4, 5, 6\]/);
    expect(shards).toHaveLength(CI_SHARDS);
  });

  it('keeps every shard within 5% of the mean planned duration', () => {
    const mean = shards.map(load).reduce((sum, value) => sum + value, 0) / CI_SHARDS;
    for (const shard of shards) expect(Math.abs(shard.load - mean) / mean).toBeLessThan(0.05);
  });

  it('keeps the heaviest single file below half of a shard, so no file sets the wall time alone', () => {
    const mean = shards.map(load).reduce((sum, value) => sum + value, 0) / CI_SHARDS;
    expect(Math.max(...Object.values(DURATIONS))).toBeLessThan(mean / 2);
  });
});

describe('files without a recorded duration', () => {
  it('are planned with the median of the recorded ones, and still run exactly once', () => {
    const known = { 'tests/a.test.ts': 10, 'tests/b.test.ts': 30, 'tests/c.test.ts': 20 };
    const files = ['tests/a.test.ts', 'tests/b.test.ts', 'tests/c.test.ts', 'tests/new.test.ts'];
    const shards = planShards(files, known, 2);
    // The new file weighs 20, the median of 10, 20 and 30; packing the longest first gives 30 + 10 | 20 + 20.
    expect(shards.map((shard) => shard.load).sort((a, b) => a - b)).toEqual([40, 40]);
    expect(shards.flatMap((shard) => shard.files).sort()).toEqual([...files].sort());
  });

  it('weigh one second each when nothing is recorded at all', () => {
    const shards = planShards(['tests/a.test.ts', 'tests/b.test.ts', 'tests/c.test.ts'], {}, 3);
    expect(shards.map((shard) => shard.load)).toEqual([1, 1, 1]);
  });
});

describe('invalid input', () => {
  it.each([0, -1, 1.5, Number.NaN, MAX_SHARDS + 1])('refuses a shard count of %s with a typed error', (count) => {
    expect(() => planShards(FILES, DURATIONS, count)).toThrow(ShardPlanError);
  });

  it('refuses a shard index outside the count on the command line', () => {
    for (const args of [['0', '6'], ['7', '6'], ['x', '6'], ['1']]) {
      const result = spawnSync('node', [PLANNER, ...args], { encoding: 'utf-8' });
      expect(result.status, args.join(' ')).toBe(1);
      expect(result.stderr).toMatch(/usage: ci-test-shards\.mjs <index> <count>/);
    }
  });

  it('prints one path per line for a valid shard', () => {
    const result = spawnSync('node', [PLANNER, '2', String(CI_SHARDS)], { encoding: 'utf-8' });
    expect(result.status).toBe(0);
    expect(result.stdout.trim().split('\n')).toEqual(planShards(FILES, DURATIONS, CI_SHARDS)[1].files);
  });
});

describe('the duration table', () => {
  it('holds a non-negative number of seconds for each entry', () => {
    for (const [file, seconds] of Object.entries(DURATIONS)) {
      expect(file.startsWith('tests/'), file).toBe(true);
      expect(Number.isFinite(seconds) && seconds >= 0, file).toBe(true);
    }
  });

  it('merges vitest JSON reports by file, in seconds, and keeps the entries a report does not mention', () => {
    const report = {
      testResults: [
        { name: path.join(ROOT, 'tests', 'x.test.ts'), startTime: 1_000, endTime: 3_450 },
        { name: path.join(ROOT, 'src', 'not-a-test.ts'), startTime: 0, endTime: 10_000 },
        { name: path.join(ROOT, 'tests', 'unfinished.test.ts') },
      ],
    };
    const merged = mergeReports({ 'tests/kept.test.ts': 4, 'tests/x.test.ts': 99 }, [report]);
    expect(merged).toEqual({ 'tests/kept.test.ts': 4, 'tests/x.test.ts': 2.5 });
  });
});
